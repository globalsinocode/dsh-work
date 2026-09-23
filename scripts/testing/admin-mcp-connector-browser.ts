/**
 * PF-03 P1 browser harness.
 *
 * This process creates a disposable PostgreSQL database and exposes the real
 * Connector governance service behind the admin routes. Capability discovery
 * is deterministic and synthetic; it does not contact an enterprise MCP
 * service, OIDC, a model, or production DSH.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createThrowawayDatabase } from '../../server/src/infrastructure/postgres/test-database.ts'
import { prototypeApiAuthenticator } from '../../server/src/modules/identity/prototype-authenticator.ts'
import { PostgresAgentService } from '../../server/src/modules/agent/postgres-agent-service.ts'
import { PostgresToolConnectorService } from '../../server/src/modules/tool/postgres-tool-connector-service.ts'
import { PostgresEncryptedCredentialStore } from '../../server/src/modules/tool/postgres-encrypted-credential-store.ts'
import type { AgentRuntimePort, McpInspectionResult } from '../../server/src/modules/runtime/runtime-types.ts'
import { registerToolRoutes } from '../../server/src/http/admin/tool-routes.ts'
import { registerAgentRoutes } from '../../server/src/http/admin/agent-routes.ts'
import { PostgresAuthorizationService } from '../../server/src/modules/authorization/postgres-authorization-service.ts'
import { envelope, readJsonBody, Router, requireRequestIdentity } from '../../server/src/http/router.ts'

const port = Number(process.env.DSH_WORK_MCP_ADMIN_SERVER_PORT ?? 4392)
const database = await createThrowawayDatabase({ namePrefix: 'dsh_pf03_admin_browser', maxConnections: 4 })
const agents = new PostgresAgentService(database.client)
const authorization = new PostgresAuthorizationService(database.client)
let capabilities: McpInspectionResult['capabilities'] = [
  { name: 'customer_get', description: '读取一个客户', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'customer_search', description: '搜索客户', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
]

const runtime: AgentRuntimePort = {
  async execute() { throw new Error('PF-03 浏览器夹具不执行 Agent Loop') },
  subscribe() { return () => undefined },
  async cancel() { return { accepted: false } },
  status() { return undefined },
  async health() {
    return {
      status: 'healthy', runtimeId: 'runtime-pf03-browser', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/synthetic/pf03-browser',
      transport: 'acp-stdio', message: 'PF-03 deterministic inspection Runtime',
    }
  },
  async inspectMcpConnection(connection) {
    if (connection.snapshot.endpoint.includes('auth-required')) {
      throw Object.assign(new Error('MCP 认证失败：该服务要求 Bearer Token，请选择 Bearer Token 认证并填写有效 Token'), {
        status: 422,
        code: 'MCP_AUTHENTICATION_REQUIRED',
      })
    }
    return { latencyMs: 5, capabilities: structuredClone(capabilities) }
  },
  async close() {},
}

const credentialSecrets = new PostgresEncryptedCredentialStore(database.client, {
  masterKeyBase64: Buffer.alloc(32, 9).toString('base64'),
  keyId: 'p1-browser-v1',
})
const connectorService = new PostgresToolConnectorService(database.client, runtime, undefined, credentialSecrets)
const router = new Router({ authenticateApi: prototypeApiAuthenticator })
const base = '/api/admin/v1'

router.get(`${base}/session`, (_request, context) => {
  const identity = requireRequestIdentity(context, 'admin')
  return envelope('admin', {
    user: identity.profile,
    identityProvider: identity.identityProvider,
    apiAudience: 'admin',
    permissions: ['admin:read', 'admin:write'],
  }, 'postgres')
})
router.get(`${base}/tasks`, () => envelope('admin', [], 'postgres'))
router.get(`${base}/runtimes`, () => envelope('admin', [], 'postgres'))
router.get(`${base}/workspaces`, () => envelope('admin', [], 'postgres'))
registerAgentRoutes(router, agents)
router.get(`${base}/identity/roles`, async () => envelope('admin', await database.client`
  select id, code, name, description, status, permissions,
    '[]'::jsonb as "dataScopes", 0 as "userCount", false as system, now() as "updatedAt"
    from roles where tenant_id = 'tenant-dsh-work' order by name
`, 'postgres'))
router.get(`${base}/skills`, () => envelope('admin', [], 'postgres'))
router.get(`${base}/skill-versions`, () => envelope('admin', [], 'postgres'))
router.get(`${base}/skill-release-records`, () => envelope('admin', [], 'postgres'))
router.get(`${base}/health`, () => envelope('admin', [], 'postgres'))
router.get(`${base}/usage`, () => envelope('admin', [], 'postgres'))
router.get(`${base}/platform-status`, () => envelope('admin', {
  mode: 'test', identity: 'prototype', persistence: 'postgres', runtime: 'synthetic',
}, 'postgres'))
router.get(`${base}/assistant/sessions`, () => envelope('admin', [], 'postgres'))
registerToolRoutes(router, connectorService)

router.get(`${base}/test/agent-principal/evidence`, async (_request, context) => {
  const agentVersionId = context.url.searchParams.get('agent_version_id') ?? ''
  try {
    const decision = await authorization.authorizeRuntime({
      userId: 'U00001', agentVersionId,
    })
    return envelope('admin', { allowed: true, executorPrincipalId: decision.executorPrincipalId,
      dataScopes: decision.dataScopes }, 'postgres')
  } catch {
    return envelope('admin', { allowed: false }, 'postgres')
  }
})

router.post(`${base}/test/mcp/capabilities`, async (request) => {
  const input = await readJsonBody<{ changed?: boolean }>(request)
  capabilities = input.changed
    ? [...capabilities.filter(item => item.name !== 'customer_export'), {
        name: 'customer_export', description: '导出客户', inputSchema: { type: 'object', properties: {} },
      }]
    : capabilities.filter(item => item.name !== 'customer_export')
  return envelope('admin', { capabilities }, 'postgres')
})
router.get(`${base}/test/mcp/evidence`, async (_request, context) => {
  const connectorId = context.url.searchParams.get('connector_id') ?? ''
  const connections = await connectorService.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1')
  const [counts] = await database.client<{ platformToolCount: number }[]>`
    select count(*)::int as "platformToolCount"
      from tools
     where tenant_id = 'tenant-dsh-work' and connector_id = ${connectorId}
  `
  assert.ok(counts)
  return envelope('admin', {
    ...counts,
    resolvedConnectionCount: connections.filter(connection => connection.connector_id === connectorId).length,
  }, 'postgres')
})
router.get(`${base}/test/mcp/deletion-evidence`, async (_request, context) => {
  const connectorId = context.url.searchParams.get('connector_id') ?? ''
  const [evidence] = await database.client<{
    deleted: boolean; credentialDetached: boolean; profileCount: number
  }[]>`
    select c.deleted_at is not null as deleted,
           c.credential_ref_id is null as "credentialDetached",
           (select count(*)::int from mcp_connector_profiles p
             where p.tenant_id = c.tenant_id and p.connector_id = c.id) as "profileCount"
      from connectors c
     where c.tenant_id = 'tenant-dsh-work' and c.id = ${connectorId}
  `
  assert.ok(evidence)
  const connections = await connectorService.resolveMcpConnectionsForAgentVersion('agent-version-dsh-work-assistant-1')
  return envelope('admin', {
    ...evidence,
    resolvedConnectionCount: connections.filter(connection => connection.connector_id === connectorId).length,
  }, 'postgres')
})
router.get('/health', () => ({ status: 'ok', testOnly: true, runtime: 'synthetic-mcp-inspection' }))

const server = createServer((request, response) => void router.handle(request, response))
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
console.log('PF-03 admin browser ready; throwaway PostgreSQL and synthetic MCP inspection, no enterprise MCP/OIDC/DSH/model.')

let closing = false
async function close() {
  if (closing) return
  closing = true
  await new Promise<void>(resolve => server.close(() => resolve()))
  await database.dispose()
  process.exit(0)
}
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
