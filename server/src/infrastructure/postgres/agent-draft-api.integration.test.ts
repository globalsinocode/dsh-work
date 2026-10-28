import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import type { ApiAudience, RequestIdentity } from '../../modules/identity/types.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { Router } from '../../http/router.ts'
import { registerAgentRoutes } from '../../http/admin/agent-routes.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const adminUserId = 'U00008'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let server: Server
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_draft_api_test', maxConnections: 4 })
  database = throwaway.client
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerAgentRoutes(router, new PostgresAgentService(database, new PostgresOperationsService(database)))
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

test('minimal create dialog shape omits access fields and persists empty grants', async () => {
  const agentId = `agent-minimal-${randomUUID().slice(0, 8)}`
  const created = await api('POST', '/api/admin/v1/agents', {
    id: agentId,
    name: '最小创建助手',
    description: '用于验证管理端创建弹窗只提交基础字段时仍可创建草稿。',
    owner: '陈默',
    department: '数字化中心',
    welcomeMessage: '你好，我是最小创建助手。',
    examplePrompts: ['请介绍你能提供哪些帮助'],
    systemPrompt: '你是最小创建助手，只能根据当前授权数据回答，并且必须给出简洁、可验证的结论。',
    maxOutputBytes: 65536,
    maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: [],
    changeSummary: '创建 Agent 初始版本',
  })
  assert.equal(created.status, 201)
  const [access] = await database<{ visibleRoleIds: string[] }[]>`
    select visible_role_ids as "visibleRoleIds" from agents where tenant_id = ${tenantId} and id = ${agentId}
  `
  assert.deepEqual(access?.visibleRoleIds ?? [], [])
})

test('creating an Agent returns 201, and a duplicate id is a state conflict with one row', async () => {
  const agentId = `agent-draft-dup-${randomUUID().slice(0, 8)}`
  const body = validDraft(agentId)
  const created = await api('POST', '/api/admin/v1/agents', body)
  assert.equal(created.status, 201)
  assert.equal(created.body.data?.agent.id, agentId)
  assert.equal(typeof created.body.data?.agent.revision, 'string')
  assert.equal(await countAudits(agentId, 'agent.create', 'success'), 1)

  const duplicate = await api('POST', '/api/admin/v1/agents', body)
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.error?.code, 'state_conflict')
  assert.equal(duplicate.body.error?.message, 'Agent 标识已存在，请刷新列表后重新创建')
  assert.equal(await countRows('agents', agentId), 1)
  assert.equal(await countRows('agent_versions', agentId), 1)
  assert.equal(await countAudits(agentId, 'agent.create', 'success'), 1)
})

test('illegal draft updates return 422 and leave revision and version count unchanged', async () => {
  const agentId = `agent-draft-patch-${randomUUID().slice(0, 8)}`
  const created = await api('POST', '/api/admin/v1/agents', validDraft(agentId))
  assert.equal(created.status, 201)
  const revision = created.body.data?.agent.revision
  assert.equal(typeof revision, 'string')
  const versionsBefore = await countRows('agent_versions', agentId)
  assert.equal(versionsBefore, 1)

  const draft = {
    ...validDraft(agentId),
    agentId,
    expectedRevision: revision,
  }
  delete (draft as { id?: string }).id

  for (const field of ['welcomeMessage', 'name', 'description', 'visibility', 'systemPrompt', 'changeSummary'] as const) {
    const body = { ...draft }
    delete body[field]
    const rejected = await api('PATCH', '/api/admin/v1/agents/draft', body)
    assert.equal(rejected.status, 422, field)
    assert.equal(rejected.body.error?.code, 'invalid_request', field)
    assert.equal(await currentRevision(agentId), revision, field)
    assert.equal(await countRows('agent_versions', agentId), versionsBefore, field)
    assert.equal(await countAudits(agentId, 'agent.draft.update', 'success'), 0, field)
  }

  const nonStringItem = await api('PATCH', '/api/admin/v1/agents/draft', {
    ...draft,
    examplePrompts: ['请介绍你的能力', 1],
  })
  assert.equal(nonStringItem.status, 422)
  assert.equal(nonStringItem.body.error?.code, 'invalid_request')
  assert.equal(await currentRevision(agentId), revision)
  assert.equal(await countRows('agent_versions', agentId), versionsBefore)
  assert.equal(await countAudits(agentId, 'agent.draft.update', 'success'), 0)
})

function validDraft(id: string) {
  return {
    id,
    name: '草稿接口测试助手',
    description: '用于验证创建与草稿更新的请求结构校验。',
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized'],
    welcomeMessage: '你好，我是草稿接口测试助手。',
    examplePrompts: ['请介绍你的能力'],
    systemPrompt: '你是草稿接口测试助手，只能根据当前授权数据回答，并且必须给出简洁、可验证的结论。',
    maxOutputBytes: 65536,
    maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    tools: ['tool-runtime-file-read@1.0.0'],
    changeSummary: '创建草稿接口测试 Agent',
  }
}

function testApiAuthenticator(request: IncomingMessage, audience: ApiAudience): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    throw error
  }
  return Promise.resolve({
    audience,
    applicationId: 'test-admin',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId,
      name: userId,
      title: '平台管理员',
      department: '测试部门',
      avatarText: '测',
      role: 'platform_admin',
      dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-platform-admin'],
    permissions: ['admin:*'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}

async function currentRevision(agentId: string) {
  const listed = await api('GET', '/api/admin/v1/agents')
  assert.equal(listed.status, 200)
  const agents = listed.body.data as unknown as Array<{ id: string; revision?: string }>
  return agents.find(agent => agent.id === agentId)?.revision
}

async function countAudits(agentId: string, action: string, result: string) {
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count from audit_events
     where tenant_id = ${tenantId}
       and object_id = ${agentId}
       and action = ${action}
       and result = ${result}
  `
  return row?.count ?? 0
}

async function countRows(table: 'agents' | 'agent_versions', agentId: string) {
  const [row] = table === 'agents'
    ? await database<{ count: number }[]>`
        select count(*)::integer as count from agents
         where tenant_id = ${tenantId} and id = ${agentId}
      `
    : await database<{ count: number }[]>`
        select count(*)::integer as count from agent_versions
         where tenant_id = ${tenantId} and agent_id = ${agentId}
      `
  return row?.count ?? 0
}

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-test-user-id': adminUserId,
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${baseUrl}${path}`, init)
  const payload = await response.json().catch(() => null) as {
    data?: { agent: { id: string; revision?: string } }
    error?: { code: string; message: string }
  } | Array<{ id: string; revision?: string }> | null
  return { status: response.status, body: payload as {
    data?: { agent: { id: string; revision?: string } }
    error?: { code: string; message: string }
  } }
}
