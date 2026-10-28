import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAgentAccessService } from '../modules/agent/agent-access-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { Router } from './router.ts'
import { registerAgentAccessRoutes } from './admin/agent-access-routes.ts'

// 管理端「岗位权限」页的两个接口：GET/PATCH /api/admin/v1/agents/:agentId/access。
// 客户端一直在调用它们，但合并后没有任何路由注册，管理端只能拿到 404。
const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const adminUserId = 'U00008'
const agentId = 'agent-access-api'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let server: Server
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_access_api', maxConnections: 4 })
  database = throwaway.client
  // 0090 的 Agent 级可见角色、0064 的 Agent 执行身份（触发器自动建 principal）。
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status, active_version_id
    ) values (
      ${agentId}, ${tenantId}, '岗位权限接口 Agent', '岗位权限 HTTP 契约。', '', ${adminUserId}, ${adminUserId},
      'draft', null
    )
  `
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerAgentAccessRoutes(router, new PostgresAgentAccessService(database))
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务未监听端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
})

test('GET 返回岗位权限：修订号、可见角色、岗位角色、数据范围与角色选项', async () => {
  const result = await api('GET', `/api/admin/v1/agents/${agentId}/access`)
  assert.equal(result.status, 200)
  const data = result.body.data as {
    agentId: string; revision: number; principalId: string; principalStatus: string
    visibleRoleIds: string[]; roleIds: string[]; dataScopes: string[]
    roleOptions: Array<{ id: string; name: string; privileged: boolean }>; scopeOptions: string[]
    routines: unknown[]
  }
  assert.equal(data.agentId, agentId)
  assert.equal(data.revision, 1)
  assert.equal(data.principalId, `principal-agent-${agentId}`)
  assert.equal(data.principalStatus, 'active')
  assert.deepEqual([data.visibleRoleIds, data.roleIds, data.dataScopes], [[], [], []])
  assert.ok(data.roleOptions.some(role => role.id === 'role-platform-admin' && role.privileged))
  assert.ok(data.roleOptions.some(role => role.id === 'role-employee'))
  assert.deepEqual(data.routines, [])
})

test('PATCH 整体替换授权并递增修订号；返回体可直接再用于下一次保存', async () => {
  const saved = await api('PATCH', `/api/admin/v1/agents/${agentId}/access`, {
    body: { expectedRevision: 1, visibleRoleIds: ['role-employee'], roleIds: ['role-employee'], dataScopes: ['workspace:authorized'] },
  })
  assert.equal(saved.status, 200)
  const data = saved.body.data as { revision: number; visibleRoleIds: string[]; roleIds: string[]; dataScopes: string[] }
  assert.equal(data.revision, 2)
  assert.deepEqual(data.visibleRoleIds, ['role-employee'])
  assert.deepEqual(data.roleIds, ['role-employee'])
  assert.deepEqual(data.dataScopes, ['workspace:authorized'])

  // 可见角色写进 agents.visible_role_ids（0090 的唯一权威），工作台可见性也读这一列。
  const [row] = await database<{ visibleRoleIds: string[] }[]>`
    select visible_role_ids as "visibleRoleIds" from agents where tenant_id = ${tenantId} and id = ${agentId}
  `
  assert.deepEqual(row?.visibleRoleIds, ['role-employee'])
})

test('修订号过期返回 409，缺字段返回 422，未知 Agent 返回 404', async () => {
  const stale = await api('PATCH', `/api/admin/v1/agents/${agentId}/access`, {
    body: { expectedRevision: 1, visibleRoleIds: [], roleIds: [], dataScopes: [] },
  })
  assert.equal(stale.status, 409)
  assert.equal((stale.body.error as { code: string }).code, 'AGENT_ACCESS_REVISION_CONFLICT')

  const missing = await api('PATCH', `/api/admin/v1/agents/${agentId}/access`, {
    body: { expectedRevision: 2, visibleRoleIds: [], roleIds: [] },
  })
  assert.equal(missing.status, 422)

  const wrongType = await api('PATCH', `/api/admin/v1/agents/${agentId}/access`, {
    body: { expectedRevision: 2, visibleRoleIds: 'role-employee', roleIds: [], dataScopes: [] },
  })
  assert.equal(wrongType.status, 422)

  const unknown = await api('GET', '/api/admin/v1/agents/agent-missing/access')
  assert.equal(unknown.status, 404)
})

test('停用执行身份后该 Agent 不能执行；重新启用恢复', async () => {
  const disabled = await api('PATCH', `/api/admin/v1/agents/${agentId}/access`, {
    body: {
      expectedRevision: 2, visibleRoleIds: ['role-employee'], roleIds: ['role-employee'],
      dataScopes: ['workspace:authorized'], principalStatus: 'disabled',
    },
  })
  assert.equal(disabled.status, 200)
  assert.equal((disabled.body.data as { principalStatus: string }).principalStatus, 'disabled')

  const [principal] = await database<{ status: string }[]>`
    select status from execution_principals
     where tenant_id = ${tenantId} and kind = 'agent' and agent_id = ${agentId}
  `
  assert.equal(principal?.status, 'disabled')
})

async function api(method: 'GET' | 'PATCH', path: string, options: { body?: unknown } = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { code: string; message: string } }
  return { status: response.status, body }
}

function testApiAuthenticator(request: import('node:http').IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = (Array.isArray(header) ? header[0] : header) ?? adminUserId
  return Promise.resolve({
    audience: 'admin',
    applicationId: 'test-admin',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId,
      name: '林岚',
      title: '平台管理员',
      department: '平台',
      avatarText: '林',
      role: 'platform_admin',
      dataScopes: ['workspace:authorized'],
    },
    roleIds: ['role-platform-admin'],
    permissions: ['admin:read', 'admin:write'],
    dataScopes: ['workspace:authorized'],
    authorizationVersion: 1,
    identityProvider: 'local-password',
  })
}
