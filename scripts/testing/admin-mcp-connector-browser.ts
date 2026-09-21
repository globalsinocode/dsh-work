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
import { envelope, readJsonBody, Router, requireRequestIdentity } from '../../server/src/http/router.ts'

const port = Number(process.env.DSH_WORK_MCP_ADMIN_SERVER_PORT ?? 4392)
const database = await createThrowawayDatabase({ namePrefix: 'dsh_pf03_admin_browser', maxConnections: 4 })
const agents = new PostgresAgentService(database.client)
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
  async inspectMcpConnection() {
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
router.get(`${base}/agents`, async () => envelope('admin', await agents.getAgents(), 'postgres'))
router.get(`${base}/agent-versions`, () => envelope('admin', [], 'postgres'))
router.get(`${base}/agent-release-records`, () => envelope('admin', [], 'postgres'))
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
  const [counts] = await database.client<{ platformToolCount: number; activeGrantCount: number }[]>`
    select
      (select count(*)::int from tools where tenant_id = 'tenant-dsh-work' and connector_id = ${connectorId}) as "platformToolCount",
      (select count(*)::int from agent_mcp_grants where tenant_id = 'tenant-dsh-work' and connector_id = ${connectorId} and status = 'active') as "activeGrantCount"
  `
  assert.ok(counts)
  return envelope('admin', counts, 'postgres')
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
