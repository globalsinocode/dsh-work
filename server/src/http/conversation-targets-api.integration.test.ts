import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { PostgresConversationTargetService } from '../modules/workbench/application/postgres-conversation-target-service.ts'
import { Router } from './router.ts'
import { registerConversationTargetRoutes } from './workbench/conversation-target-routes.ts'

// MODE-API-02（e2e/TEST-CATALOG.md）：协作模式对话对象——单聊按 AI 同事聚合本人的个人会话，
// 群组只含本人所在的活动项目空间；续写判断由服务端给出。

const tenantId = 'tenant-dsh-work'
const employeeA = 's5c-employee-a'
const employeeB = 's5c-employee-b'

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let server: ReturnType<typeof createServer>
let baseUrl = ''
let personalA = ''
let personalB = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_conversation_targets_test', maxConnections: 5 })
  database = throwaway.client
  personalA = await seedUser(employeeA, '林岚')
  personalB = await seedUser(employeeB, '周航')
  await seedFixture()
  const router = new Router({ authenticateApi: headerAuthenticator })
  registerConversationTargetRoutes(router, new PostgresConversationTargetService(database, new PostgresAgentService(database)))
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
})

test('列表按 AI 同事聚合本人的个人会话，并列出本人所在的活动项目空间', async () => {
  const result = await get(employeeA, '/me/conversation-targets')
  assert.equal(result.status, 200)
  const items = result.body.data.items as Array<Record<string, unknown>>
  assert.deepEqual(items.map(item => `${item.type}:${item.id}`), [
    'group:s5c-team-active',
    'agent:s5c-agent-x',
    'agent:s5c-agent-y',
  ])
  const agentX = items.find(item => item.id === 's5c-agent-x')!
  assert.equal(agentX.name, '库存助手')
  assert.equal(agentX.description, '库存分析 v2')
  assert.equal(agentX.available, true)
  assert.deepEqual(agentX.avatarNames, ['库存助手'])
  assert.deepEqual(agentX.lastMessage, {
    role: 'assistant',
    authorName: '库存助手',
    text: '新版本的回答',
    sentAt: '2026-10-20T09:01:00.000Z',
  })
  const group = items.find(item => item.type === 'group')!
  assert.equal(group.name, '新品上市')
  assert.deepEqual(group.avatarNames, ['林岚', '周航'])
  assert.equal((group.lastMessage as { authorName: string }).authorName, '周航')
  // 不可用的 AI 同事历史仍在列表中，但标为不可用。
  assert.equal(items.find(item => item.id === 's5c-agent-y')!.available, false)
})

test('列表不含他人会话、已移除的会话、已归档或非成员的项目空间；搜索与分页', async () => {
  const other = await get(employeeB, '/me/conversation-targets')
  // B 只看到自己的单聊与自己所在的活动项目空间：A 的会话、A 才在的归档空间都不出现。
  assert.deepEqual((other.body.data.items as Array<{ id: string }>).map(item => item.id), ['s5c-team-active', 's5c-agent-x'])
  assert.equal(other.body.data.items[1].lastMessage.text, 'B 的问题')
  const all = (await get(employeeA, '/me/conversation-targets')).body.data.items as Array<{ id: string }>
  assert.ok(!all.some(item => ['s5c-team-archived', 's5c-team-outsider'].includes(item.id)))

  const search = await get(employeeA, '/me/conversation-targets?query=新品')
  assert.deepEqual((search.body.data.items as Array<{ id: string }>).map(item => item.id), ['s5c-team-active'])

  const first = await get(employeeA, '/me/conversation-targets?limit=2')
  assert.equal(first.body.data.items.length, 2)
  assert.ok(first.body.data.nextCursor)
  const second = await get(employeeA, `/me/conversation-targets?limit=2&cursor=${first.body.data.nextCursor}`)
  assert.deepEqual((second.body.data.items as Array<{ id: string }>).map(item => item.id), ['s5c-agent-y'])
  assert.equal(second.body.data.nextCursor, null)

  assert.equal((await get(employeeA, '/me/conversation-targets?limit=0')).status, 422)
  assert.equal((await get(employeeA, '/me/conversation-targets?cursor=bad')).status, 422)
})

test('被移出项目空间后该群组不再返回', async () => {
  await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = 's5c-team-active' and user_id = ${employeeB}`
  try {
    const result = await get(employeeB, '/me/conversation-targets')
    assert.ok(!(result.body.data.items as Array<{ id: string }>).some(item => item.id === 's5c-team-active'))
  } finally {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, 's5c-team-active', ${employeeB}, 'member', ${employeeA})
    `
  }
})

test('单聊分段新到旧、分页；最近一段与当前版本一致才续写', async () => {
  const result = await get(employeeA, '/me/conversation-targets/agent/s5c-agent-x/sessions?limit=1')
  assert.equal(result.status, 200)
  const data = result.body.data
  assert.deepEqual(data.agent, { id: 's5c-agent-x', name: '库存助手', description: '库存分析 v2', version: '2.0.0', available: true })
  assert.deepEqual((data.items as Array<{ sessionId: string }>).map(item => item.sessionId), ['s5c-a-x-new'])
  assert.equal(data.items[0].agentVersion, '2.0.0')
  assert.equal(data.items[0].runCount, 1)
  assert.deepEqual(data.items[0].latestRun, { id: 's5c-run-a-x-new', status: 'succeeded' })
  assert.equal(data.continueSessionId, 's5c-a-x-new')

  const older = await get(employeeA, `/me/conversation-targets/agent/s5c-agent-x/sessions?limit=1&cursor=${data.nextCursor}`)
  assert.deepEqual((older.body.data.items as Array<{ sessionId: string }>).map(item => item.sessionId), ['s5c-a-x-old'])
  assert.equal(older.body.data.items[0].agentVersion, '1.0.0')
  assert.equal(older.body.data.continueSessionId, 's5c-a-x-new', '分页不影响续写对象')
  assert.equal(older.body.data.nextCursor, null)
})

test('最近一段为旧版本或 AI 同事不可用时不续写；无会话且不可用时 404', async () => {
  // 最近一段改为旧版本：发送时应开启新会话。
  await database`update sessions set last_active_at = '2026-10-21T00:00:00Z' where tenant_id = ${tenantId} and id = 's5c-a-x-old'`
  try {
    const result = await get(employeeA, '/me/conversation-targets/agent/s5c-agent-x/sessions')
    assert.equal(result.body.data.items[0].sessionId, 's5c-a-x-old')
    assert.equal(result.body.data.continueSessionId, null)
  } finally {
    await database`update sessions set last_active_at = '2026-10-10T00:00:00Z' where tenant_id = ${tenantId} and id = 's5c-a-x-old'`
  }

  const unavailable = await get(employeeA, '/me/conversation-targets/agent/s5c-agent-y/sessions')
  assert.equal(unavailable.status, 200)
  assert.equal(unavailable.body.data.agent.available, false)
  assert.equal(unavailable.body.data.continueSessionId, null)
  assert.equal(unavailable.body.data.items.length, 1)

  assert.equal((await get(employeeB, '/me/conversation-targets/agent/s5c-agent-y/sessions')).status, 404)
  assert.equal((await get(employeeA, '/me/conversation-targets/agent/missing/sessions')).status, 404)

  // 可用但从未对话：返回 AI 同事与空分段，发送时开启新会话。
  const fresh = await get(employeeB, '/me/conversation-targets/agent/s5c-agent-x/sessions')
  assert.equal(fresh.body.data.items.length, 1)
  await database`update sessions set status = 'archived' where tenant_id = ${tenantId} and id = 's5c-b-x'`
  try {
    const empty = await get(employeeB, '/me/conversation-targets/agent/s5c-agent-x/sessions')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.data.items, [])
    assert.equal(empty.body.data.continueSessionId, null)
    assert.equal(empty.body.data.agent.available, true)
  } finally {
    await database`update sessions set status = 'active' where tenant_id = ${tenantId} and id = 's5c-b-x'`
  }
})

test('解析对话链接：Run ID 与 Session ID；个人会话到 AI 同事，项目空间会话到群组；越权为 404', async () => {
  assert.deepEqual((await get(employeeA, '/me/conversation-targets/resolve?conversation=s5c-run-a-x-new')).body.data,
    { type: 'agent', agentId: 's5c-agent-x', sessionId: 's5c-a-x-new' })
  assert.deepEqual((await get(employeeA, '/me/conversation-targets/resolve?conversation=s5c-a-x-old')).body.data,
    { type: 'agent', agentId: 's5c-agent-x', sessionId: 's5c-a-x-old' })
  assert.deepEqual((await get(employeeB, '/me/conversation-targets/resolve?conversation=s5c-team-session')).body.data,
    { type: 'group', workspaceId: 's5c-team-active', sessionId: 's5c-team-session' })
  assert.equal((await get(employeeB, '/me/conversation-targets/resolve?conversation=s5c-a-x-old')).status, 404)
  assert.equal((await get(employeeA, '/me/conversation-targets/resolve?conversation=s5c-outsider-session')).status, 404)
  assert.equal((await get(employeeA, '/me/conversation-targets/resolve?conversation=nope')).status, 404)
  assert.equal((await get(employeeA, '/me/conversation-targets/resolve')).status, 422)
  assert.equal((await get(undefined, '/me/conversation-targets')).status, 401)
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function seedUser(userId: string, name: string) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values (${userId}, ${tenantId}, ${`local:${userId}`}, ${name}, 'active', 'local', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${userId}, 'role-employee', 'local')
  `
  const [workspace] = await database<{ id: string }[]>`
    select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${userId}
  `
  if (!workspace) throw new Error('个人空间未自动创建')
  return workspace.id
}

async function seedAgent(agentId: string, versions: Array<{ id: string; version: string; description: string }>, visible: boolean) {
  await database`
    insert into agents (id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status, active_version_id)
    values (${agentId}, ${tenantId}, '库存助手', '', '', ${employeeA}, ${employeeA}, 'published', null)
  `
  for (const item of versions) {
    await database`
      insert into agent_versions (id, tenant_id, agent_id, version, name, description, system_prompt, skill_refs, tool_refs, status, created_by)
      values (${item.id}, ${tenantId}, ${agentId}, ${item.version}, ${agentId === 's5c-agent-x' ? '库存助手' : '排产助手'},
              ${item.description}, '测试', '[]', '[]', 'published', ${employeeA})
    `
  }
  await database`
    update agents set active_version_id = ${versions.at(-1)!.id},
           name = ${agentId === 's5c-agent-x' ? '库存助手' : '排产助手'},
           visible_role_ids = ${database.json(visible ? ['role-employee'] : [])}
     where tenant_id = ${tenantId} and id = ${agentId}
  `
}

async function seedSession(id: string, workspaceId: string, createdBy: string, agentVersionId: string | null, lastActiveAt: string) {
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status, last_active_at, created_at)
    values (${id}, ${tenantId}, ${workspaceId}, ${createdBy}, ${agentVersionId}, ${`话题 ${id}`}, 'active', ${lastActiveAt}, ${lastActiveAt})
  `
}

async function seedMessage(id: string, sessionId: string, role: 'user' | 'assistant', content: string, at: string, sender: string | null, runId: string | null = null) {
  await database`
    insert into messages (id, tenant_id, session_id, role, content, created_at, sender_user_id, run_id)
    values (${id}, ${tenantId}, ${sessionId}, ${role}, ${content}, ${at}, ${sender}, ${runId})
  `
}

async function seedTeam(id: string, name: string, status: 'active' | 'archived', members: string[]) {
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status, archived_at, created_at)
    values (${id}, ${tenantId}, ${name}, '', 'team', ${employeeA}, ${status}, ${status === 'archived' ? '2026-10-01T00:00:00Z' : null}, '2026-09-01T00:00:00Z')
  `
  for (const [index, member] of members.entries()) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by, joined_at)
      values (${tenantId}, ${id}, ${member}, ${index === 0 ? 'owner' : 'member'}, ${employeeA}, ${`2026-09-0${index + 1}T00:00:00Z`})
    `
  }
}

async function seedFixture() {
  await seedAgent('s5c-agent-x', [
    { id: 's5c-x-v1', version: '1.0.0', description: '库存分析 v1' },
    { id: 's5c-x-v2', version: '2.0.0', description: '库存分析 v2' },
  ], true)
  await seedAgent('s5c-agent-y', [{ id: 's5c-y-v1', version: '1.0.0', description: '排产' }], false)

  await seedSession('s5c-a-x-old', personalA, employeeA, 's5c-x-v1', '2026-10-10T00:00:00Z')
  await seedMessage('s5c-m1', 's5c-a-x-old', 'user', '旧问题', '2026-10-10T00:00:00Z', employeeA)
  await seedSession('s5c-a-x-new', personalA, employeeA, 's5c-x-v2', '2026-10-20T09:01:00Z')
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, created_at)
    values ('s5c-run-a-x-new', ${tenantId}, 's5c-a-x-new', ${employeeA}, 'k1', 'succeeded', '2026-10-20T09:00:00Z')
  `
  await seedMessage('s5c-m2', 's5c-a-x-new', 'user', '新问题', '2026-10-20T09:00:00Z', employeeA, 's5c-run-a-x-new')
  await seedMessage('s5c-m3', 's5c-a-x-new', 'assistant', '  新版本的回答  ', '2026-10-20T09:01:00Z', null, 's5c-run-a-x-new')
  await seedMessage('s5c-m3-tool', 's5c-a-x-new', 'tool' as 'user', '工具输出不进预览', '2026-10-20T09:02:00Z', null)
  await seedSession('s5c-a-y', personalA, employeeA, 's5c-y-v1', '2026-10-05T00:00:00Z')
  await seedMessage('s5c-m4', 's5c-a-y', 'user', '排产问题', '2026-10-05T00:00:00Z', employeeA)
  // 已移除的会话不计入。
  await seedSession('s5c-a-x-removed', personalA, employeeA, 's5c-x-v2', '2026-10-22T00:00:00Z')
  await database`update sessions set status = 'archived' where tenant_id = ${tenantId} and id = 's5c-a-x-removed'`

  await seedSession('s5c-b-x', personalB, employeeB, 's5c-x-v2', '2026-10-15T00:00:00Z')
  await seedMessage('s5c-m5', 's5c-b-x', 'user', 'B 的问题', '2026-10-15T00:00:00Z', employeeB)

  await seedTeam('s5c-team-active', '新品上市', 'active', [employeeA, employeeB])
  await seedSession('s5c-team-session', 's5c-team-active', employeeA, null, '2026-10-21T08:00:00Z')
  await seedMessage('s5c-m6', 's5c-team-session', 'user', '群里的讨论', '2026-10-21T08:00:00Z', employeeB)
  await seedTeam('s5c-team-archived', '已结束项目', 'archived', [employeeA])
  await seedTeam('s5c-team-outsider', '别人的项目', 'active', ['U00008'])
  await seedSession('s5c-outsider-session', 's5c-team-outsider', 'U00008', null, '2026-10-22T00:00:00Z')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(userId: string | undefined, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/workbench/v1${path}`, {
    headers: userId ? { 'x-test-user-id': userId } : {},
  })
  return { status: response.status, body: await response.json() }
}

function headerAuthenticator(request: IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    return Promise.reject(error)
  }
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `local:${userId}`,
    profile: {
      id: userId,
      name: userId,
      title: '员工',
      department: '测试部门',
      avatarText: '测',
      role: 'employee',
      dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'local-password',
  })
}
