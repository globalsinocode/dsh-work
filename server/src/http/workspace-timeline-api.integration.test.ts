import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { PostgresWorkspaceService } from '../modules/workbench/application/postgres-workspace-service.ts'
import { PostgresWorkspaceTimelineService } from '../modules/workbench/application/postgres-workspace-timeline-service.ts'
import { Router } from './router.ts'
import { registerWorkspaceTimelineRoutes } from './workbench/workspace-timeline-routes.ts'

// MODE-E2E-09（服务端）：群聊时间线合并讨论消息、执行记录、任务卡片与系统记录；
// 任务对话不进群聊，读取轨（归档可读），被移出的成员不可读。

const tenantId = 'tenant-dsh-work'
const owner = 's5d-owner'
const member = 's5d-member'
const outsider = 's5d-outsider'
const workspaceId = 's5d-team'

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let server: ReturnType<typeof createServer>
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_timeline_test', maxConnections: 5 })
  database = throwaway.client
  await seed()
  const router = new Router({ authenticateApi: headerAuthenticator })
  registerWorkspaceTimelineRoutes(
    router,
    new PostgresWorkspaceTimelineService(database, new PostgresWorkspaceService(database)),
    new PostgresAuthorizationService(database),
  )
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

test('时间线按时间倒序合并讨论、执行记录、任务卡片与系统记录，任务对话不进入', async () => {
  const result = await get(member, `/workspaces/${workspaceId}/timeline`)
  assert.equal(result.status, 200)
  const items = result.body.data.items as Array<Record<string, any>>
  assert.deepEqual(items.map(item => item.id), [
    'td:s5d-event-done',
    'm:s5d-m-d2',
    'tr:s5d-run-task-2',
    'tr:s5d-run-task-1',
    'tc:s5d-task-employee',
    'tc:s5d-task-agent',
    'm:s5d-m-reply',
    // Run 比触发它的发言早创建：执行记录取发言时间，同一时间按 ID 倒序（r: 在 m: 前），即显示在发言之后。
    'r:s5d-run-d1',
    'm:s5d-m-ask',
    'm:s5d-m-d1',
    'a:s5d-activity-member',
    'w:s5d-team',
  ])
  assert.ok(!items.some(item => item.content === '任务对话里的话'), '任务对话不进群聊')
  assert.ok(!items.some(item => item.activityKind === 'file_uploaded'), '文件动态不作为系统记录')

  const ask = items.find(item => item.id === 'm:s5d-m-ask')!
  assert.equal(ask.sessionTitle, '第一段讨论')
  assert.equal(ask.senderName, '林岚')
  assert.equal(ask.runId, 's5d-run-d1')
  const reply = items.find(item => item.id === 'm:s5d-m-reply')!
  assert.equal(reply.role, 'assistant')
  assert.equal(reply.runRequesterName, '林岚')
  const run = items.find(item => item.id === 'r:s5d-run-d1')!
  assert.equal(run.status, 'succeeded')
  assert.equal(run.requesterName, '林岚')
  assert.equal(run.at, ask.at, '执行记录的时间取触发它的发言时间')

  const created = items.find(item => item.id === 'tc:s5d-task-agent')!
  assert.equal(created.event, 'created')
  assert.deepEqual(created.task, {
    id: 's5d-task-agent', title: '库存周报', status: 'in_progress', assigneeType: 'agent',
    assigneeName: '库存助手', schedule: { kind: 'manual', timezone: 'Asia/Shanghai' }, removed: false,
  })
  const manual = items.find(item => item.id === 'tr:s5d-run-task-1')!
  assert.deepEqual(manual.run, { id: 's5d-run-task-1', status: 'succeeded', scheduled: false, quiet: false, summary: '本周库存周转 12 天' })
  const quiet = items.find(item => item.id === 'tr:s5d-run-task-2')!
  assert.equal(quiet.run.scheduled, true)
  assert.equal(quiet.run.quiet, true)
  const done = items.find(item => item.id === 'td:s5d-event-done')!
  assert.equal(done.event, 'completed')
  assert.equal(done.note, '已提交')
  assert.equal(done.task.assigneeName, '周航')

  const system = items.find(item => item.id === 'a:s5d-activity-member')!
  assert.equal(system.activityKind, 'member_added')
  assert.equal(system.actorName, '林岚')
  assert.equal(items.at(-1)!.activityKind, 'workspace_created')
})

test('分页游标不重复不遗漏；参数校验', async () => {
  const first = await get(member, `/workspaces/${workspaceId}/timeline?limit=5`)
  assert.equal(first.body.data.items.length, 5)
  const second = await get(member, `/workspaces/${workspaceId}/timeline?limit=50&before=${first.body.data.nextCursor}`)
  assert.equal(second.body.data.nextCursor, null)
  const ids = [...first.body.data.items, ...second.body.data.items].map((item: { id: string }) => item.id)
  assert.equal(ids.length, 12)
  assert.equal(new Set(ids).size, 12)
  assert.equal((await get(member, `/workspaces/${workspaceId}/timeline?limit=101`)).status, 422)
  assert.equal((await get(member, `/workspaces/${workspaceId}/timeline?before=bad`)).status, 422)
})

test('归档空间可读；非成员、被移出的成员与个人空间不可读', async () => {
  await database`update workspaces set status = 'archived', archived_at = now() where tenant_id = ${tenantId} and id = ${workspaceId}`
  try {
    assert.equal((await get(member, `/workspaces/${workspaceId}/timeline`)).status, 200)
  } finally {
    await database`update workspaces set status = 'active', archived_at = null where tenant_id = ${tenantId} and id = ${workspaceId}`
  }
  assert.equal((await get(outsider, `/workspaces/${workspaceId}/timeline`)).status, 403)
  await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${member}`
  try {
    assert.equal((await get(member, `/workspaces/${workspaceId}/timeline`)).status, 403)
  } finally {
    await database`insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member}, 'member', ${owner})`
  }
  const [personal] = await database<{ id: string }[]>`select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${member}`
  assert.ok([403, 422].includes((await get(member, `/workspaces/${personal!.id}/timeline`)).status))
  assert.equal((await get(undefined, `/workspaces/${workspaceId}/timeline`)).status, 401)
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function seed() {
  for (const [id, name] of [[owner, '林岚'], [member, '周航'], [outsider, '外部']] as const) {
    await database`
      insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
      values (${id}, ${tenantId}, ${`local:${id}`}, ${name}, 'active', 'local', true)
    `
    await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${id}, 'role-employee', 'local')`
  }
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status, created_at)
    values (${workspaceId}, ${tenantId}, '新品上市', '', 'team', ${owner}, 'active', '2026-10-01T00:00:00Z')
  `
  await database`insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by, joined_at)
    values (${tenantId}, ${workspaceId}, ${owner}, 'owner', ${owner}, '2026-10-01T00:00:00Z')`
  await database`insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by, joined_at)
    values (${tenantId}, ${workspaceId}, ${member}, 'member', ${owner}, '2026-10-01T01:00:00Z')`
  await activity('s5d-activity-member', 'member_added', '2026-10-01T01:00:00Z')
  await activity('s5d-activity-file', 'file_uploaded', '2026-10-02T00:00:00Z')

  await database`
    insert into agents (id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status, active_version_id)
    values ('s5d-agent', ${tenantId}, '库存助手', '', '', ${owner}, ${owner}, 'published', null)
  `
  await database`
    insert into agent_versions (id, tenant_id, agent_id, version, name, description, system_prompt, skill_refs, status, created_by)
    values ('s5d-agent-v1', ${tenantId}, 's5d-agent', '1.0.0', '库存助手', '', '测试', '[]', 'published', ${owner})
  `
  await database`update agents set active_version_id = 's5d-agent-v1' where tenant_id = ${tenantId} and id = 's5d-agent'`
  await database`
    insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
    values ('s5d-wam', ${tenantId}, ${workspaceId}, 's5d-agent', 's5d-agent-v1', 'available', ${owner})
  `

  // 第一段讨论：成员发言、@Agent 执行与回复。
  await session('s5d-d1', '第一段讨论', '2026-10-03T00:00:00Z')
  await message('s5d-m-d1', 's5d-d1', 'user', '大家看下库存', '2026-10-03T00:00:00Z', member)
  await run('s5d-run-d1', 's5d-d1', owner, 'succeeded', '2026-10-03T01:00:00Z')
  await message('s5d-m-ask', 's5d-d1', 'user', '@库存助手 分析一下', '2026-10-03T01:00:01Z', owner, 's5d-run-d1')
  await message('s5d-m-reply', 's5d-d1', 'assistant', '分析完成', '2026-10-03T01:02:00Z', null, 's5d-run-d1')

  // Agent 任务（任务对话不进群聊）：一次手动执行、一次定时“无变化”。
  await session('s5d-task-session', '库存周报', '2026-10-04T00:00:00Z')
  await database`
    insert into project_tasks (id, tenant_id, workspace_id, title, created_by, assignee_type, assignee_agent_member_id,
      session_id, status, schedule, schedule_state, schedule_set_by, created_at)
    values ('s5d-task-agent', ${tenantId}, ${workspaceId}, '库存周报', ${owner}, 'agent', 's5d-wam',
      's5d-task-session', 'in_progress', ${database.json({ kind: 'manual', timezone: 'Asia/Shanghai' })}, 'active', ${owner},
      '2026-10-04T00:00:00Z')
  `
  await message('s5d-m-task', 's5d-task-session', 'user', '任务对话里的话', '2026-10-04T00:10:00Z', owner)
  await run('s5d-run-task-1', 's5d-task-session', owner, 'succeeded', '2026-10-05T00:00:00Z')
  await message('s5d-m-task-1', 's5d-task-session', 'assistant', '本周库存周转 12 天', '2026-10-05T00:01:00Z', null, 's5d-run-task-1')
  await run('s5d-run-task-2', 's5d-task-session', owner, 'succeeded', '2026-10-06T00:00:00Z')
  await message('s5d-m-task-2', 's5d-task-session', 'assistant', '  无变化：库存正常', '2026-10-06T00:01:00Z', null, 's5d-run-task-2')
  await database`
    insert into project_task_events (id, tenant_id, task_id, session_id, kind, actor_user_id, metadata, created_at)
    values ('s5d-event-scheduled', ${tenantId}, 's5d-task-agent', 's5d-task-session', 'scheduled_run', ${owner},
      ${database.json({ runId: 's5d-run-task-2' })}, '2026-10-06T00:00:00Z')
  `

  // 员工任务：创建并标记完成。
  await database`
    insert into project_tasks (id, tenant_id, workspace_id, title, created_by, assignee_type, assignee_user_id, status,
      completed_by, completed_at, created_at)
    values ('s5d-task-employee', ${tenantId}, ${workspaceId}, '渠道确认', ${owner}, 'employee', ${member}, 'done',
      ${member}, '2026-10-08T00:00:00Z', '2026-10-04T12:00:00Z')
  `
  await database`
    insert into project_task_events (id, tenant_id, task_id, kind, actor_user_id, metadata, created_at)
    values ('s5d-event-done', ${tenantId}, 's5d-task-employee', 'completed', ${member}, ${database.json({ note: '已提交' })}, '2026-10-08T00:00:00Z')
  `

  // 第二段讨论。
  await session('s5d-d2', '第二段讨论', '2026-10-07T00:00:00Z')
  await message('s5d-m-d2', 's5d-d2', 'user', '新话题', '2026-10-07T00:00:00Z', owner)
  // 运行的 updated_at 决定“执行完成”卡片的时间。
  await database`update runs set updated_at = created_at + interval '2 minutes' where tenant_id = ${tenantId}`
}

async function activity(id: string, kind: string, at: string) {
  await database`
    insert into workspace_activity_events (id, tenant_id, workspace_id, kind, actor_user_id, object_type, object_id, safe_metadata, dedupe_key, occurred_at)
    values (${id}, ${tenantId}, ${workspaceId}, ${kind}, ${owner}, ${kind === 'member_added' ? 'member' : 'file'}, ${member},
      ${database.json({})}, ${id}, ${at})
  `
}

async function session(id: string, title: string, at: string) {
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status, last_active_at, created_at)
    values (${id}, ${tenantId}, ${workspaceId}, ${owner}, null, ${title}, 'active', ${at}, ${at})
  `
}

async function run(id: string, sessionId: string, requestedBy: string, status: string, at: string) {
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, created_at, updated_at)
    values (${id}, ${tenantId}, ${sessionId}, ${requestedBy}, ${id}, ${status}, ${at}, ${at})
  `
}

async function message(id: string, sessionId: string, role: 'user' | 'assistant', content: string, at: string, sender: string | null, runId: string | null = null) {
  await database`
    insert into messages (id, tenant_id, session_id, role, content, created_at, sender_user_id, run_id)
    values (${id}, ${tenantId}, ${sessionId}, ${role}, ${content}, ${at}, ${sender}, ${runId})
  `
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(userId: string | undefined, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/workbench/v1${path}`, { headers: userId ? { 'x-test-user-id': userId } : {} })
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
    profile: { id: userId, name: userId, title: '员工', department: '测试部门', avatarText: '测', role: 'employee', dataScopes: ['enterprise:authorized'] },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'local-password',
  })
}
