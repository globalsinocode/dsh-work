import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresConversationRepository } from '../modules/workbench/application/postgres-conversation-repository.ts'
import { Router } from './router.ts'
import { registerConversationRoutes } from './workbench/conversation-routes.ts'

const tenantId = 'tenant-dsh-work'
const versionId = 'agent-version-dsh-work-assistant-1'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let conversations: PostgresConversationRepository
let server: Server
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_sessions_api_test', maxConnections: 8 })
  database = throwaway.client
  conversations = new PostgresConversationRepository(database)
  const authorization = new PostgresAuthorizationService(database)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerConversationRoutes(
    router,
    conversations,
    undefined as never,
    undefined as never,
    undefined as never,
    authorization,
  )
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
  await throwaway.dispose()
})

// ---------------------------------------------------------------------------
// 团队 Session 分页（1B-T1）
// ---------------------------------------------------------------------------

test('团队 Session 列表按 Session 去重、游标稳定排序且不返回正文', async () => {
  const workspaceId = `ws-sessions-page`
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '会话负责人')
  await seedUser(memberId, '会话成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])

  // 同一会话 3 个 Run：列表必须只出现一次，并带 Run 计数与最新状态。
  const multi = await createSession(`${workspaceId}-multi`, workspaceId, ownerId, '季度复盘')
  await createRun(`${multi}-run-1`, multi, ownerId, 'succeeded', '2026-09-01T00:00:00.000Z')
  await createRun(`${multi}-run-2`, multi, ownerId, 'failed', '2026-09-02T00:00:00.000Z')
  const latest = await createRun(`${multi}-run-3`, multi, ownerId, 'running', '2026-09-03T00:00:00.000Z')

  const single = await createSession(`${workspaceId}-single`, workspaceId, ownerId, '库存异常排查')
  await createRun(`${single}-run-1`, single, ownerId, 'succeeded', '2026-09-04T00:00:00.000Z')
  await touchSession(single, '2026-09-04T00:00:00.000Z')
  await touchSession(multi, '2026-09-03T00:00:00.000Z')

  const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: ownerId })
  assert.equal(result.status, 200)
  const page = result.body.data as {
    items: Array<Record<string, unknown>>
    nextCursor: string | null
  }
  assert.deepEqual(page.items.map(item => item.sessionId), [single, multi], '按最近活动倒序，且同一会话只出现一次')
  const multiItem = page.items.find(item => item.sessionId === multi)
  assert.equal(multiItem?.runCount, 3)
  assert.equal((multiItem?.latestRun as { id: string }).id, latest, '取该会话最近的 Run 作为指针')
  assert.equal((multiItem?.latestRun as { status: string }).status, 'running')
  assert.equal(multiItem?.creatorName, '会话负责人')
  assert.equal(multiItem?.title, '季度复盘')
  // 摘要不得携带对话正文。
  assert.equal(JSON.stringify(page.items).includes('季度复盘内容'), false)
})

test('团队 Session 列表按标题搜索并支持游标翻页到末尾', async () => {
  const workspaceId = 'ws-sessions-cursor'
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '分页负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  for (const index of [1, 2, 3]) {
    const sessionId = `${workspaceId}-s${index}`
    await createSession(sessionId, workspaceId, ownerId, `巡检记录 ${index}`)
    await createRun(`${sessionId}-run`, sessionId, ownerId, 'succeeded', `2026-09-0${index}T00:00:00.000Z`)
    await touchSession(sessionId, `2026-09-0${index}T00:00:00.000Z`)
  }
  const other = `${workspaceId}-other`
  await createSession(other, workspaceId, ownerId, '无关标题')
  await createRun(`${other}-run`, other, ownerId, 'succeeded', '2026-09-05T00:00:00.000Z')
  await touchSession(other, '2026-09-05T00:00:00.000Z')

  const filtered = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions?query=${encodeURIComponent('巡检记录')}`, { as: ownerId })
  assert.equal(filtered.status, 200)
  assert.deepEqual(
    (filtered.body.data as { items: Array<{ sessionId: string }> }).items.map(item => item.sessionId),
    [`${workspaceId}-s3`, `${workspaceId}-s2`, `${workspaceId}-s1`],
  )

  const first = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions?limit=2`, { as: ownerId })
  const firstPage = first.body.data as { items: Array<{ sessionId: string }>; nextCursor: string | null }
  assert.equal(firstPage.items.length, 2)
  assert.ok(firstPage.nextCursor, '还有更多时应返回游标')

  const second = await api(
    'GET',
    `/api/workbench/v1/workspaces/${workspaceId}/sessions?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    { as: ownerId },
  )
  const secondPage = second.body.data as { items: Array<{ sessionId: string }>; nextCursor: string | null }
  assert.equal(secondPage.items.length, 2)
  assert.equal(secondPage.nextCursor, null, '翻到末尾时不再返回游标')

  const seen = [...firstPage.items, ...secondPage.items].map(item => item.sessionId)
  assert.equal(new Set(seen).size, 4, '两页合起来覆盖全部 4 个会话且不重复')
})

test('团队 Session 分页游标保留 PostgreSQL 微秒精度，同毫秒记录不丢失（评审 M3）', async () => {
  const workspaceId = 'ws-sessions-cursor-us'
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '微秒分页负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  // 两个会话落在同一毫秒、不同微秒：旧实现用 toISOString() 编码游标会截断
  // 微秒，把两条记录视作同一时间点，导致第二页漏掉边界上的另一条。
  const later = `${workspaceId}-later`
  const earlier = `${workspaceId}-earlier`
  await createSession(later, workspaceId, ownerId, '微秒边界后')
  await createSession(earlier, workspaceId, ownerId, '微秒边界前')
  await touchSession(later, '2026-09-01T00:00:00.123789Z')
  await touchSession(earlier, '2026-09-01T00:00:00.123456Z')

  const first = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions?limit=1`, { as: ownerId })
  const firstPage = first.body.data as { items: Array<{ sessionId: string }>; nextCursor: string | null }
  assert.deepEqual(firstPage.items.map(item => item.sessionId), [later])
  assert.ok(firstPage.nextCursor, '仍有下一页时必须给出游标')

  const second = await api(
    'GET',
    `/api/workbench/v1/workspaces/${workspaceId}/sessions?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    { as: ownerId },
  )
  const secondPage = second.body.data as { items: Array<{ sessionId: string }>; nextCursor: string | null }
  assert.deepEqual(secondPage.items.map(item => item.sessionId), [earlier], '同毫秒不同微秒的记录不得被游标漏掉')
})

test('团队 Session 列表对所有成员可读，非成员被拒绝，个人空间被拒绝', async () => {
  const workspaceId = 'ws-sessions-access'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const viewerId = `${workspaceId}-viewer`
  const outsiderId = `${workspaceId}-outsider`
  await seedUser(ownerId, '访问负责人')
  await seedUser(memberId, '访问成员')
  await seedUser(viewerId, '访问只读')
  await seedUser(outsiderId, '访问外部人')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  const sessionId = `${workspaceId}-session`
  await createSession(sessionId, workspaceId, ownerId, '只读可见性')
  await createRun(`${sessionId}-run`, sessionId, ownerId, 'succeeded', '2026-09-06T00:00:00.000Z')

  for (const userId of [ownerId, memberId, viewerId]) {
    const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: userId })
    assert.equal(result.status, 200, `${userId} 应可读取团队会话列表`)
  }

  // TW-10 共享讨论：团队会话全员可见，成员也能看到负责人发起的会话。
  const asMember = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: memberId })
  assert.deepEqual(
    (asMember.body.data as { items: Array<{ sessionId: string }> }).items.map(item => item.sessionId),
    [sessionId],
    '成员可读负责人发起的共享会话',
  )
  // 只读成员同样可读。
  const asViewer = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: viewerId })
  assert.deepEqual(
    (asViewer.body.data as { items: Array<{ sessionId: string }> }).items.map(item => item.sessionId),
    [sessionId],
    '只读成员可读共享会话',
  )

  const outsider = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: outsiderId })
  assert.equal(outsider.status, 403, '非成员不得读取团队会话列表')

  // 0013 触发器在插入 users 时已自动创建个人空间，直接用它，不要重复插入。
  const personalUserId = 'user-sessions-personal'
  await seedUser(personalUserId, '个人空间用户')
  const personal = await api('GET', `/api/workbench/v1/workspaces/ws-personal-${personalUserId}/sessions`, {
    as: personalUserId,
  })
  // 个人空间不是团队资源：与「空间不存在/非成员」同状态码 403（此前为 422，
  // 3-T1 为消除存在性枚举差异统一口径；个人空间行为在功能上未变——仍不提供团队分页）。
  assert.equal(personal.status, 403, '个人空间不提供团队会话分页')
})

test('归档团队空间的历史会话仍对现任成员可读，非成员仍被拒绝（3-T1 读取轨）', async () => {
  const workspaceId = 'ws-sessions-archived'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const outsiderId = `${workspaceId}-outsider`
  await seedUser(ownerId, '归档会话负责人')
  await seedUser(memberId, '归档会话成员')
  await seedUser(outsiderId, '归档会话外部人')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = `${workspaceId}-session`
  await createSession(sessionId, workspaceId, ownerId, '归档前会话')
  await createRun(`${sessionId}-run`, sessionId, ownerId, 'succeeded', '2026-09-06T00:00:00.000Z')

  await database`
    update workspaces set status = 'archived', archived_at = now()
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `

  // 归档=只读保留：现任成员（含负责人）仍可读取历史会话列表。
  for (const userId of [ownerId, memberId]) {
    const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: userId })
    assert.equal(result.status, 200, `${userId} 应可在归档空间读取团队会话列表`)
  }
  const asOwner = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: ownerId })
  assert.deepEqual(
    (asOwner.body.data as { items: Array<{ sessionId: string }> }).items.map(item => item.sessionId),
    [sessionId],
  )

  // 非成员与不存在空间仍拒绝，且保持与既有实现一致的非可枚举文案。
  const outsider = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: outsiderId })
  assert.equal(outsider.status, 403)
  assert.match(outsider.body.error?.message ?? '', /不是成员/)

  // 不存在空间必须与非成员同状态码：此前抛「仅支持团队工作空间查询历史会话」被归为
  // 422，而存在空间是 403，同一调用者可据此判断空间 id 是否存在（符合性评审 P1-3）。
  const missing = await api('GET', `/api/workbench/v1/workspaces/ws-sessions-archived-missing/sessions`, { as: ownerId })
  assert.equal(missing.status, outsider.status, '不存在空间与非成员必须同状态码，不得暴露 id 是否存在')
  assert.equal(missing.body.error?.message, outsider.body.error?.message, '两者拒绝文案也必须一致')
})

test('执行轨：归档团队空间拒绝删除自己的会话（只读保留）', async () => {
  const workspaceId = 'ws-sessions-archived-delete'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '归档删除负责人')
  await seedUser(memberId, '归档删除成员')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  const sessionId = `${workspaceId}-session-1`
  await createSession(sessionId, workspaceId, memberId, '归档前会话')
  await createRun(`${sessionId}-run`, sessionId, memberId, 'succeeded', '2026-09-06T00:00:00.000Z')

  // 归档前：作者可删除自己的会话。
  const activeDelete = await api('DELETE', `/api/workbench/v1/sessions/${sessionId}`, { as: memberId })
  assert.equal(activeDelete.status, 200, '归档前作者可删除自己的会话')

  const secondSessionId = `${workspaceId}-session-2`
  await createSession(secondSessionId, workspaceId, memberId, '归档后待删会话')
  await createRun(`${secondSessionId}-run`, secondSessionId, memberId, 'succeeded', '2026-09-07T00:00:00.000Z')
  await database`
    update workspaces set status = 'archived', archived_at = now()
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
  // 归档后：删除会销毁只读保留的历史内容，必须拒绝。
  const archivedDelete = await api('DELETE', `/api/workbench/v1/sessions/${secondSessionId}`, { as: memberId })
  assert.equal(archivedDelete.status, 403, '归档空间不得删除会话')
})

test('viewer 不得归档共享会话：创建者被降级为只读后删除被拒（评审 H2）', async () => {
  const workspaceId = 'ws-sessions-viewer-delete'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '降级负责人')
  await seedUser(memberId, '降级成员')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  const sessionId = `${workspaceId}-session`
  await createSession(sessionId, workspaceId, memberId, '降级前会话')
  await createRun(`${sessionId}-run`, sessionId, memberId, 'succeeded', '2026-09-06T00:00:00.000Z')

  // 创建者仍是 member 时可删除自己的会话（基线）。
  const baselineDelete = await api('DELETE', `/api/workbench/v1/sessions/${sessionId}`, { as: memberId })
  assert.equal(baselineDelete.status, 200)

  // 第二会话：先降级为 viewer，再尝试删除——创建者身份不豁免只读约束。
  const secondSessionId = `${workspaceId}-session-2`
  await createSession(secondSessionId, workspaceId, memberId, '降级后待删会话')
  await database`
    update workspace_members set member_role = 'viewer'
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${memberId}
  `
  const viewerDelete = await api('DELETE', `/api/workbench/v1/sessions/${secondSessionId}`, { as: memberId })
  assert.equal(viewerDelete.status, 403, 'viewer 创建者不得归档共享会话')

  // 会话保持活动状态，未被部分修改。
  const [row] = await database<{ status: string }[]>`
    select status from sessions where tenant_id = ${tenantId} and id = ${secondSessionId}
  `
  assert.equal(row?.status, 'active')
})

test('执行轨：归档团队空间拒绝新对话、续写与重试（3-T1 执行轨）', async () => {
  const workspaceId = 'ws-sessions-archived-exec'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '归档执行负责人')
  await seedUser(memberId, '归档执行成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  // 归档前存在一个活动会话与一个已失败 Run（重试前置条件）。
  const sessionId = `${workspaceId}-session`
  await createSession(sessionId, workspaceId, memberId, '归档前会话')
  const failedRunId = `${workspaceId}-failed-run`
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${failedRunId}, ${tenantId}, ${sessionId}, ${memberId}, ${`idem-${failedRunId}`}, 'failed')
  `

  await database`
    update workspaces set status = 'archived', archived_at = now()
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `

  // 新对话：团队分支要求活跃空间 + 现任成员 + 平台授权。本套件不装配 Agent 成员
  // 服务，因此这里断言的是「归档 + 执行轨」的拒绝边界（非 201 且不低于 403）。
  const newSession = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '归档后新对话', workspaceId },
  })
  assert.ok(newSession.status >= 403, `归档空间不得新开团队对话，实际 ${newSession.status}`)
  assert.notEqual(newSession.status, 201)

  // 续写：在既有活动会话上创建 Run 必须被拒绝（执行轨）。
  const startRun = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: '归档后续写', idempotencyKey: `${sessionId}-archived-write` },
  })
  assert.notEqual(startRun.status, 202, '归档空间不得续写团队会话')
  assert.ok(startRun.status >= 400)

  // 重试：已失败 Run 的重试同样属执行轨。
  const retry = await api('POST', `/api/workbench/v1/runs/${failedRunId}/retry`, { as: memberId })
  assert.notEqual(retry.status, 202, '归档空间不得重试团队运行')
  assert.ok(retry.status >= 400)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testApiAuthenticator(request: import('node:http').IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    throw error
  }
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId, name: userId, title: '员工', department: '测试部门', avatarText: '测',
      role: 'employee', dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}

async function seedUser(id: string, displayName: string) {
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user
    ) values (${id}, ${tenantId}, ${`directory:${id}`}, ${displayName}, null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local') on conflict do nothing
  `
}

async function seedTeamWorkspace(
  workspaceId: string,
  members: Array<{ userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>,
) {
  const ownerId = members[0]?.userId ?? 'U00001'
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '1B 会话分页测试空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

async function createSession(sessionId: string, workspaceId: string, userId: string, title: string) {
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, ${workspaceId}, ${userId}, ${versionId}, ${title}, 'active')
  `
  return sessionId
}

async function createRun(runId: string, sessionId: string, userId: string, status: string, createdAt: string) {
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, created_at, updated_at)
    values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${`idem-${runId}`}, ${status}, ${createdAt}, ${createdAt})
  `
  return runId
}

async function touchSession(sessionId: string, at: string) {
  await database`update sessions set last_active_at = ${at} where tenant_id = ${tenantId} and id = ${sessionId}`
}

async function api(method: string, path: string, options: { as?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.as) headers['x-test-user-id'] = options.as
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { message: string } }
  return { status: response.status, body }
}
