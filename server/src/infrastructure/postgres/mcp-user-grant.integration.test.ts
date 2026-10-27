import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { McpUserCredentialStore } from '../../modules/tool/mcp-user-credential-store.ts'
import { McpUserGrantService } from '../../modules/tool/mcp-user-grant-service.ts'
import { PostgresEncryptedCredentialStore } from '../../modules/tool/postgres-encrypted-credential-store.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import type { AgentRuntimePort, McpInspectionResult, McpRuntimeConnection } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const masterKey = Buffer.alloc(32, 9).toString('base64')

let database: DatabaseClient
let throwaway: ThrowawayDatabase | undefined
let grantService: McpUserGrantService
let toolService: PostgresToolConnectorService
let discovered: McpInspectionResult['capabilities'] = []
const tokenResponses = new Map<string, { access_token: string; refresh_token?: string; expires_in?: number }>()

const runtime: AgentRuntimePort = {
  async execute() { throw new Error('不执行 Agent Loop') },
  subscribe() { return () => undefined },
  async cancel() { return { accepted: false } },
  status() { return undefined },
  async health() {
    return {
      status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/test', transport: 'acp-stdio', message: 'ok',
    }
  },
  async inspectMcpConnection(connection: McpRuntimeConnection) {
    assert.ok(connection.headers.Authorization?.startsWith('Bearer '))
    return { latencyMs: 3, capabilities: structuredClone(discovered) }
  },
  async close() {},
}

async function mockFetch(_url: string, init?: RequestInit) {
  const body = new URLSearchParams(String(init?.body ?? ''))
  const code = body.get('code')
  const key = code ?? 'default'
  const payload = tokenResponses.get(key) ?? {
    access_token: `access-${key}`,
    refresh_token: `refresh-${key}`,
    expires_in: 3600,
  }
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_mcp_user_grant', maxConnections: 3 })
  database = throwaway.client
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values ('U00002', 'tenant-dsh-work', 'directory:mcp-user-grant-U00002', '周衡', 'active', 'ai-hub', true)
    on conflict (id) do nothing
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values ('tenant-dsh-work', 'U00002', 'role-employee', 'local')
    on conflict do nothing
  `
  const connectorCredentials = new PostgresEncryptedCredentialStore(database, { masterKeyBase64: masterKey, keyId: 'integration-v1' })
  const userCredentials = new McpUserCredentialStore(masterKey, 'integration-v1')
  grantService = new McpUserGrantService(database, userCredentials, connectorCredentials, mockFetch as typeof fetch)
  toolService = new PostgresToolConnectorService(database, runtime, undefined, connectorCredentials, grantService)
  discovered = [{
    name: 'user_tool', description: 'user oauth tool',
    inputSchema: { type: 'object', properties: {} },
  }]
})

after(async () => {
  await throwaway?.dispose()
})

test('两名员工各自授权后令牌隔离，解除只影响本人', async () => {
  const suffix = randomUUID().slice(0, 8)
  const connectorId = `connector-mcp-oauth-${suffix}`
  tokenResponses.set('code-a', { access_token: `token-a-${suffix}`, refresh_token: `refresh-a` })
  tokenResponses.set('code-b', { access_token: `token-b-${suffix}`, refresh_token: `refresh-b` })

  await database`
    insert into connectors (
      id, tenant_id, key, name, connector_type, status, created_by,
      system, protocol, endpoint, auth_type, scope_description, updated_at
    ) values (
      ${connectorId}, 'tenant-dsh-work', ${`srv-${suffix}`}, ${`OAuth MCP ${suffix}`}, 'mcp', 'healthy', 'U00008',
      'MCP', 'mcp', ${`https://oauth-mcp-${suffix}.example.test/rpc`}, 'user_oauth', '员工各自授权', now()
    )
  `
  await database`
    insert into mcp_connector_profiles (
      tenant_id, connector_id, server_name, approval_status,
      capability_digest, approved_digest, capability_snapshot, updated_at
    ) values (
      'tenant-dsh-work', ${connectorId}, ${`srv-${suffix}`}, 'approved',
      ${'a'.repeat(64)}, ${'a'.repeat(64)}, ${database.json(JSON.parse(JSON.stringify(discovered)))}, now()
    )
  `
  await database`
    insert into mcp_connector_oauth (
      tenant_id, connector_id, authorization_endpoint, token_endpoint, client_id, scopes, resource
    ) values (
      'tenant-dsh-work', ${connectorId},
      ${`https://oauth-mcp-${suffix}.example.test/authorize`},
      ${`https://oauth-mcp-${suffix}.example.test/token`},
      'client-id', ${['mcp.read']}, ${`https://oauth-mcp-${suffix}.example.test/rpc`}
    )
  `

  const beginA = await grantService.beginAuthorization({
    connectorId, userId: 'U00001', portalOrigin: 'http://localhost:4174',
  })
  assert.ok(beginA.authorizationUrl.includes('client-id'))
  const stateA = new URL(beginA.authorizationUrl).searchParams.get('state')!
  await grantService.completeAuthorization({ code: 'code-a', state: stateA, userId: 'U00001' })

  const beginB = await grantService.beginAuthorization({
    connectorId, userId: 'U00002', portalOrigin: 'http://localhost:4174',
  })
  const stateB = new URL(beginB.authorizationUrl).searchParams.get('state')!
  await grantService.completeAuthorization({ code: 'code-b', state: stateB, userId: 'U00002' })

  const pinsA = (await toolService.applyUserGrants([{
    connector_id: connectorId,
    server_name: `srv-${suffix}`,
    transport: 'streamable-http',
    endpoint: `https://oauth-mcp-${suffix}.example.test/rpc`,
    auth_type: 'user_oauth',
    capability_digest: 'a'.repeat(64),
  }], 'selected', 'U00001')).pins
  assert.match(await grantService.resolveAccessTokenForPin(pinsA[0]!), /token-a/)

  const pinsB = (await toolService.applyUserGrants([{
    connector_id: connectorId,
    server_name: `srv-${suffix}`,
    transport: 'streamable-http',
    endpoint: `https://oauth-mcp-${suffix}.example.test/rpc`,
    auth_type: 'user_oauth',
    capability_digest: 'a'.repeat(64),
  }], 'selected', 'U00002')).pins
  assert.match(await grantService.resolveAccessTokenForPin(pinsB[0]!), /token-b/)

  await grantService.revoke('U00001', connectorId)
  const afterRevoke = await grantService.listForUser('U00001')
  assert.equal(afterRevoke.list.find(item => item.connectorId === connectorId)?.status, 'unauthorized')
  const stillB = await grantService.listForUser('U00002')
  assert.equal(stillB.list.find(item => item.connectorId === connectorId)?.status, 'active')

  await assert.rejects(
    grantService.completeAuthorization({ code: 'code-a', state: stateA, userId: 'U00001' }),
    /已被使用|无效/,
  )
})

test('user_oauth 登记体携带 bearerToken 被拒绝', async () => {
  await assert.rejects(toolService.testMcpConnection({
    name: 'bad',
    endpoint: 'https://bad.example.test/rpc',
    authType: 'user_oauth',
    bearerToken: 'secret',
    authorizationEndpoint: 'https://bad.example.test/authorize',
    tokenEndpoint: 'https://bad.example.test/token',
    clientId: 'client',
    scopes: ['mcp.read'],
    actor: 'U00008',
  }), /不能提交 Bearer Token/)
})
