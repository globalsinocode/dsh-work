import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import type { ApiAudience, RequestIdentity } from '../modules/identity/types.ts'
import { PostgresOperationsService } from '../modules/admin/application/postgres-operations-service.ts'
import { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { PostgresAgentAccessService } from '../modules/agent/agent-access-service.ts'
import { PostgresToolConnectorService } from '../modules/tool/postgres-tool-connector-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { Router } from './router.ts'
import { registerAgentAccessRoutes } from './admin/agent-access-routes.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const ADMIN = 'U00008'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let server: Server
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_access_api', maxConnections: 4 })
  database = throwaway.client
  const toolService = new PostgresToolConnectorService(database)
  const access = new PostgresAgentAccessService(database, toolService)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerAgentAccessRoutes(router, access)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP Server 没有获得端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway?.dispose()
})

test('GET access returns capability requirements from draft tool refs', async () => {
  const agentId = `agent-access-cap-${randomUUID().slice(0, 8)}`
  const agents = new PostgresAgentService(database, new PostgresOperationsService(database), undefined, new PostgresToolConnectorService(database))
  const created = await agents.createAgent({
    id: agentId,
    name: '能力摘要测试',
    description: '验证岗位权限接口返回能力需求投影。',
    owner: '陈默',
    department: '数字化中心',
    welcomeMessage: '',
    examplePrompts: [],
    systemPrompt: '你是测试 Agent。',
    maxOutputBytes: 65536,
    maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: [],
    tools: ['read@1.0.0'],
    changeSummary: '能力摘要测试',
    actor: ADMIN,
  })
  assert.ok(created.version.id)
  const response = await api('GET', `/api/admin/v1/agents/${agentId}/access`)
  assert.equal(response.status, 200)
  const capabilities = response.body.data?.capabilities as Array<{
    reference: string; missingRole: boolean; missingScopes: string[]
  }>
  assert.ok(Array.isArray(capabilities))
  const read = capabilities.find(item => item.reference.startsWith('read@'))
  assert.ok(read)
  assert.equal(read?.missingRole, true)
  assert.deepEqual(read?.missingScopes, ['workspace:authorized'])

  const patched = await api('PATCH', `/api/admin/v1/agents/${agentId}/access`, {
    expectedRevision: response.body.data.revision,
    visibleRoleIds: ['role-employee'],
    roleIds: ['role-employee'],
    dataScopes: ['workspace:authorized'],
  })
  assert.equal(patched.status, 200)
  const readAfter = (patched.body.data.capabilities as typeof capabilities).find(item => item.reference.startsWith('read@'))
  assert.equal(readAfter?.missingRole, false)
  assert.deepEqual(readAfter?.missingScopes, [])
})

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-test-user-id': ADMIN,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json() as { data?: Record<string, unknown>; error?: { code?: string } }
  return { status: response.status, body: payload }
}

async function testApiAuthenticator(_request: IncomingMessage, audience: ApiAudience): Promise<RequestIdentity> {
  assert.equal(audience, 'admin')
  return {
    audience: 'admin',
    applicationId: 'test-admin',
    sessionHash: 'test',
    userId: ADMIN,
    subject: 'bootstrap:platform-admin',
    profile: { id: ADMIN, name: '陈默', title: '', department: '', avatarText: '陈', role: 'platform_admin', dataScopes: [] },
    roleIds: ['role-platform-admin'],
    permissions: ['admin:*'],
    dataScopes: ['workspace:authorized'],
    authorizationVersion: 1,
    identityProvider: 'prototype-sso',
  }
}
