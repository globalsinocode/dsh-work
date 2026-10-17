import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { ModelGovernanceService } from '../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../modules/run/postgres-run-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeHealth,
  RuntimeManifest,
} from '../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresProjectService } from '../modules/workbench/application/postgres-project-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { LocalObjectStorage } from '../infrastructure/storage/local-object-storage.ts'
import { Router } from './router.ts'
import { registerConversationRoutes } from './workbench/conversation-routes.ts'
import { registerProjectRoutes } from './workbench/project-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './workbench/workspace-agent-member-routes.ts'

const tenantId = 'tenant-dsh-work'
const base = '/api/workbench/v1'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let storageRoot: string
let server: Server
let baseUrl = ''
let runtime: ControlledRuntime

interface TaskView {
  id: string
  status: string
  sessionId: string | null
  latestRunId: string | null
  assignee: { type: string; agentMemberId?: string; userId?: string }
  completionNote: string | null
  allowedActions: string[]
}

// ---------------------------------------------------------------------------
// 项目简报
// ---------------------------------------------------------------------------

test('项目简报：负责人与管理员保存新版本，成员与只读成员只读，归档后只读', async () => {
  const ws = await seedSpace('brief')
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/brief`, { as: ws.viewer })).body.data, null)

  const denied = await api('PUT', `${base}/workspaces/${ws.id}/brief`, { as: ws.member, body: { content: '成员不能改' } })
  assert.equal(denied.status, 403)
  assert.equal((await api('PUT', `${base}/workspaces/${ws.id}/brief`, { as: ws.owner, body: { content: '  ' } })).status, 422)
  assert.equal((await api('PUT', `${base}/workspaces/${ws.id}/brief`, { as: ws.owner, body: { content: '目标', dueDate: '2026/12/31' } })).status, 422)

  const first = await api('PUT', `${base}/workspaces/${ws.id}/brief`, {
    as: ws.owner, body: { content: '目标：华东缺货率降到 3%', dueDate: '2026-12-31' },
  })
  assert.equal(first.status, 200)
  assert.deepEqual(pick(first.body.data, ['versionNo', 'content', 'dueDate']), { versionNo: 1, content: '目标：华东缺货率降到 3%', dueDate: '2026-12-31' })
  const second = await api('PUT', `${base}/workspaces/${ws.id}/brief`, { as: ws.admin, body: { content: '目标：缺货率 2%', dueDate: null } })
  assert.deepEqual(pick(second.body.data, ['versionNo', 'dueDate']), { versionNo: 2, dueDate: null })
  const viewerRead = await api('GET', `${base}/workspaces/${ws.id}/brief`, { as: ws.viewer })
  assert.equal((viewerRead.body.data as { content: string }).content, '目标：缺货率 2%')
  assert.equal((await activityKinds(ws.id)).filter(kind => kind === 'brief_updated').length, 2)

  await archive(ws.id)
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/brief`, { as: ws.viewer })).status, 200)
  assert.equal((await api('PUT', `${base}/workspaces/${ws.id}/brief`, { as: ws.owner, body: { content: '归档后不能改' } })).status, 403)
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/brief`, { as: ws.outsider })).status, 403)
})

// ---------------------------------------------------------------------------
// 员工任务
// ---------------------------------------------------------------------------

test('员工任务：成员创建并指派，承接人推进到完成，只读成员与越权操作被拒', async () => {
  const ws = await seedSpace('employee')
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.viewer, body: { title: '只读成员不能建', assignee: { type: 'employee', id: ws.member } },
  })).status, 403)
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '指派给只读成员', assignee: { type: 'employee', id: ws.viewer } },
  })).status, 422)
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '员工任务不能带输入文件', assignee: { type: 'employee', id: ws.admin }, inputFileIds: ['file-x'] },
  })).status, 422)

  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '整理供应商名单', description: '按区域分组', assignee: { type: 'employee', id: ws.admin } },
  })
  assert.equal(created.status, 201)
  const task = created.body.data as TaskView
  assert.equal(task.status, 'todo')
  assert.deepEqual(task.allowedActions, ['edit', 'remove', 'set_status', 'complete'])

  const viewerList = await api('GET', `${base}/workspaces/${ws.id}/project-tasks`, { as: ws.viewer })
  assert.deepEqual((viewerList.body.data as TaskView[]).map(item => item.allowedActions), [[]])

  // 与任务无关的普通成员不能推进状态、不能编辑他人任务。
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/status`, {
    as: ws.other, body: { status: 'in_progress' },
  })).status, 403)
  assert.equal((await api('PATCH', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, {
    as: ws.other, body: { title: '改名' },
  })).status, 403)

  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/status`, {
    as: ws.admin, body: { status: 'in_progress' },
  })).status, 200)
  const done = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/status`, {
    as: ws.admin, body: { status: 'done', completionNote: '已按华东、华南分组' },
  })
  assert.equal((done.body.data as TaskView).status, 'done')
  assert.equal((done.body.data as TaskView).completionNote, '已按华东、华南分组')
  assert.deepEqual((await activityKinds(ws.id)).sort(), ['project_task_completed', 'project_task_created'])

  // 创建人移除；移除后不再出现在列表。
  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.other })).status, 403)
  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.member })).status, 200)
  assert.equal(((await api('GET', `${base}/workspaces/${ws.id}/project-tasks`, { as: ws.member })).body.data as unknown[]).length, 0)
})

// ---------------------------------------------------------------------------
// Agent 任务：线程即任务
// ---------------------------------------------------------------------------

test('Agent 任务：启动生成任务线程并带上当前简报，线程内回复无需 @，执行中拒绝再回复', async () => {
  const ws = await seedSpace('agent')
  const agentMemberId = await joinAgent(ws, 'agent')
  await api('PUT', `${base}/workspaces/${ws.id}/brief`, { as: ws.owner, body: { content: '目标：本季度缺货率降到 3%' } })

  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '分析缺货原因', description: '列出前三个原因', assignee: { type: 'agent', id: agentMemberId } },
  })
  const task = created.body.data as TaskView
  assert.equal(task.status, 'todo')
  assert.ok(task.allowedActions.includes('start'))
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, { as: ws.member, body: {} })).status, 422)

  const started = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
    as: ws.member, body: { idempotencyKey: `start-${task.id}` },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const running = started.body.data as TaskView
  assert.ok(running.sessionId)
  assert.ok(running.latestRunId)
  assert.equal(running.status, 'in_progress')
  assert.equal(running.allowedActions.includes('start'), false)
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
    as: ws.member, body: { idempotencyKey: `start-again-${task.id}` },
  })).status, 409)

  const manifest = await waitForManifest(running.latestRunId!)
  assert.equal(manifest?.input.message, '任务：分析缺货原因\n\n列出前三个原因')
  assert.equal(manifest?.project_context?.brief.content, '目标：本季度缺货率降到 3%')
  assert.equal(manifest?.project_context?.brief.version_no, 1)

  // 执行中：线程内再回复被拒绝（同一时间只允许一个执行），改派与移除同样被拒。
  const busy = await api('POST', `${base}/sessions/${running.sessionId}/runs`, {
    as: ws.other, body: { prompt: '再补充一点', idempotencyKey: `busy-${task.id}` },
  })
  assert.equal(busy.status, 409)
  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.member })).status, 409)

  runtime.releaseAll()
  await waitForRun(running.latestRunId!)
  const afterRun = await taskById(ws, task.id)
  assert.equal(afterRun.status, 'done')

  // 简报更新后，线程内回复（不 @、不带成员关联）交给同一 Agent，并带上新版本简报。
  await api('PUT', `${base}/workspaces/${ws.id}/brief`, { as: ws.owner, body: { content: '目标：缺货率降到 2%' } })
  const reply = await api('POST', `${base}/sessions/${running.sessionId}/runs`, {
    as: ws.other, body: { prompt: '再看看华南', idempotencyKey: `reply-${task.id}` },
  })
  assert.equal(reply.status, 202, JSON.stringify(reply.body))
  const replyRunId = (reply.body.data as { runId?: string; id?: string }).runId ?? (reply.body.data as { id: string }).id
  const replyManifest = await waitForManifest(replyRunId)
  assert.equal(replyManifest?.project_context?.brief.version_no, 2)
  assert.equal(replyManifest?.user_context.user_id, ws.other, '回复人记为发起人')
  assert.equal((await taskById(ws, task.id)).status, 'in_progress')
  runtime.releaseAll()
  await waitForRun(replyRunId)

  // 任务线程只能交给承接 Agent。
  const otherAgent = await joinAgent(ws, 'agent-other')
  assert.equal((await api('POST', `${base}/sessions/${running.sessionId}/runs`, {
    as: ws.other, body: { prompt: '换个 Agent', idempotencyKey: `wrong-${task.id}`, workspaceAgentMemberId: otherAgent },
  })).status, 422)
})

test('设为任务：@Agent 执行过的讨论线程可设为任务，重复设置与未执行线程被拒', async () => {
  const ws = await seedSpace('mark')
  const agentMemberId = await joinAgent(ws, 'mark')
  const empty = await api('POST', `${base}/sessions`, { as: ws.member, body: { title: '空讨论', workspaceId: ws.id } })
  const emptyId = (empty.body.data as { id: string }).id
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/sessions/${emptyId}/project-task`, { as: ws.member, body: {} })).status, 409)

  const discussion = await api('POST', `${base}/sessions`, { as: ws.member, body: { title: '库存讨论', workspaceId: ws.id } })
  const sessionId = (discussion.body.data as { id: string }).id
  const run = await api('POST', `${base}/sessions/${sessionId}/runs`, {
    as: ws.member, body: { prompt: '@助手 看看库存', idempotencyKey: `mark-${sessionId}`, workspaceAgentMemberId: agentMemberId },
  })
  assert.equal(run.status, 202, JSON.stringify(run.body))
  runtime.releaseAll()

  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/sessions/${sessionId}/project-task`, { as: ws.viewer, body: {} })).status, 403)
  const marked = await api('POST', `${base}/workspaces/${ws.id}/sessions/${sessionId}/project-task`, { as: ws.member, body: {} })
  assert.equal(marked.status, 201, JSON.stringify(marked.body))
  const task = marked.body.data as TaskView & { title: string }
  assert.equal(task.title, '库存讨论')
  assert.equal(task.sessionId, sessionId)
  assert.equal(task.assignee.agentMemberId, agentMemberId)
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/sessions/${sessionId}/project-task`, { as: ws.member, body: {} })).status, 409)
})

test('个人空间不支持简报与任务', async () => {
  const userId = `user-ps-personal-${randomUUID().slice(0, 8)}`
  await createDirectoryUser(userId, '个人空间员工')
  // 用户创建时由数据库自动建立默认个人空间。
  const personal = `ws-personal-${userId}`
  assert.equal((await api('GET', `${base}/workspaces/${personal}/project-tasks`, { as: userId })).status, 422)
  assert.equal((await api('PUT', `${base}/workspaces/${personal}/brief`, { as: userId, body: { content: 'x' } })).status, 422)
})

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function seedSpace(label: string) {
  const id = `ws-ps-${label}-${randomUUID().slice(0, 8)}`
  const users = {
    owner: `${id}-owner`, admin: `${id}-admin`, member: `${id}-member`, other: `${id}-other`,
    viewer: `${id}-viewer`, outsider: `${id}-outsider`,
  }
  for (const [role, userId] of Object.entries(users)) await createDirectoryUser(userId, `${label}-${role}`)
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${id}, ${tenantId}, '项目空间测试', '', 'team', ${users.owner}, 'active')
  `
  for (const [userId, role] of [[users.owner, 'owner'], [users.admin, 'admin'], [users.member, 'member'], [users.other, 'member'], [users.viewer, 'viewer']]) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${id}, ${userId}, ${role}, ${users.owner})
    `
  }
  return { id, ...users }
}

async function joinAgent(ws: { id: string; owner: string }, label: string): Promise<string> {
  const agentId = `agent-ps-${label}-${randomUUID().slice(0, 8)}`
  const versionId = `${agentId}-v1`
  await database`
    insert into agents (id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status, active_version_id, allow_workspace_join)
    values (${agentId}, ${tenantId}, '项目助手', '项目空间集成测试。', '', 'U00008', 'U00008', 'published', null, true)
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message, example_prompts, system_prompt,
      max_output_bytes, max_tool_calls, timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${agentId}, '1.0.0', '项目助手', '测试。', '', ${database.json(['测试'] as string[])},
      '你是项目空间集成测试 Agent，负责按任务说明给出简洁的分析结论。', 65536, 20, 300, ${database.json([] as string[])}, ${database.json([] as string[])},
      'published', 'U00008', '测试版本'
    )
  `
  await database`
    update agents set visible_role_ids = ${database.json(['role-employee'] as string[])}, active_version_id = ${versionId}
     where tenant_id = ${tenantId} and id = ${agentId}
  `
  await database`
    insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
    values (${tenantId}, ${`principal-agent-${agentId}`}, 'role-employee')
  `
  const joined = await api('POST', `${base}/workspaces/${ws.id}/agent-members`, { as: ws.owner, body: { agentId } })
  assert.equal(joined.status, 201, JSON.stringify(joined.body))
  return (joined.body.data as { id: string }).id
}

async function taskById(ws: { id: string; member: string }, taskId: string): Promise<TaskView> {
  const list = await api('GET', `${base}/workspaces/${ws.id}/project-tasks`, { as: ws.member })
  const task = (list.body.data as TaskView[]).find(item => item.id === taskId)
  assert.ok(task, `任务不存在：${taskId}`)
  return task
}

async function activityKinds(workspaceId: string): Promise<string[]> {
  const rows = await database<{ kind: string }[]>`
    select kind from workspace_activity_events where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
  `
  return rows.map(row => row.kind)
}

async function archive(workspaceId: string) {
  await database`update workspaces set status = 'archived', archived_at = now() where tenant_id = ${tenantId} and id = ${workspaceId}`
}

function pick(value: unknown, keys: string[]) {
  const record = value as Record<string, unknown>
  return Object.fromEntries(keys.map(key => [key, record[key]]))
}

/** 调度是异步的：等到 Runtime 实际收到该 Run 的 Manifest。 */
async function waitForManifest(runId: string, timeoutMs = 10_000): Promise<RuntimeManifest> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const manifest = runtime.manifest(runId)
    if (manifest) return manifest
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`等待 Runtime 收到 Manifest 超时：${runId}`)
}

async function waitForRun(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [row] = await database<{ status: string }[]>`select status from runs where tenant_id = ${tenantId} and id = ${runId}`
    if (row && ['succeeded', 'failed', 'cancelled'].includes(row.status)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`等待 Run 终态超时：${runId}`)
}

async function createDirectoryUser(id: string, displayName: string) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
    values (${id}, ${tenantId}, ${`directory:${id}`}, ${displayName}, null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local')
    on conflict do nothing
  `
}

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
    audience: 'workbench', applicationId: 'test-workbench', sessionHash: `test-session-${userId}`, userId,
    subject: `directory:${userId}`,
    profile: { id: userId, name: userId, title: '员工', department: '测试部门', avatarText: '测', role: 'employee', dataScopes: [] },
    roleIds: ['role-employee'], permissions: ['workbench:use'], dataScopes: [], authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
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
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { code: string; message: string } }
  return { status: response.status, body }
}

/** 确定性 Runtime：受理后保持运行，直到测试调用 releaseAll 才完成，便于验证“执行中”状态。 */
class ControlledRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, {
    manifest: RuntimeManifest
    listeners: Set<(event: RuntimeEvent) => void>
    events: RuntimeEvent[]
    finish?: () => void
  }>()

  manifest(runId: string): RuntimeManifest | undefined {
    return this.executions.get(runId)?.manifest
  }

  releaseAll() {
    for (const state of this.executions.values()) state.finish?.()
  }

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    const now = new Date().toISOString()
    const state: { manifest: RuntimeManifest; listeners: Set<(event: RuntimeEvent) => void>; events: RuntimeEvent[]; finish?: () => void } = {
      manifest, listeners: new Set(), events: [],
    }
    this.executions.set(manifest.run_id, state)
    const emit = (eventType: RuntimeEvent['event_type'], display: string) => {
      const event: RuntimeEvent = {
        event_id: randomUUID(), run_id: manifest.run_id, attempt_id: manifest.attempt_id,
        sequence: state.events.length + 1, event_type: eventType, occurred_at: new Date().toISOString(),
        display_message: display, safe_metadata: {}, trace_id: `trace-${manifest.run_id}`,
        parent_event_id: state.events.at(-1)?.event_id ?? null,
      }
      state.events.push(event)
      state.listeners.forEach(listener => listener(event))
    }
    emit('run.queued', '已排队')
    emit('run.started', '已启动')
    const done = new Promise<RuntimeExecutionSnapshot>((resolve) => {
      state.finish = () => {
        state.finish = undefined
        emit('assistant.completed', '项目空间测试回答')
        emit('run.completed', '已完成')
        resolve({
          runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'completed', acceptedAt: now,
          startedAt: now, endedAt: new Date().toISOString(), manifestSha256: createHash('sha256').update(manifest.run_id).digest('hex'),
          attemptDirectory: '/tmp/test', errorCode: null, errorMessage: null,
        })
      }
    })
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: (event: RuntimeEvent) => void) {
    const state = this.executions.get(runId)
    if (!state) return () => undefined
    state.events.forEach(listener)
    state.listeners.add(listener)
    return () => state.listeners.delete(listener)
  }

  async cancel(): Promise<{ accepted: boolean }> {
    return { accepted: false }
  }

  status(): RuntimeExecutionSnapshot | undefined {
    return undefined
  }

  async health(): Promise<RuntimeHealth> {
    return {
      status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio', message: 'test',
    }
  }

  async close() {}
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_project_space_test', maxConnections: 8 })
  database = throwaway.client
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-project-space-'))
  const authorization = new PostgresAuthorizationService(database)
  const agents = new PostgresAgentService(database)
  const agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  const projects = new PostgresProjectService(database, agentMembers)
  const content = new PostgresContentService(database, new LocalObjectStorage(storageRoot), authorization)
  const conversations = new PostgresConversationRepository(database)
  const runs = new PostgresRunRepository(database)
  runtime = new ControlledRuntime()
  const orchestration = new RunOrchestrationService(
    runs, conversations, new ModelGovernanceService(new PostgresModelGovernanceRepository(database)), runtime,
    content, undefined, agents, undefined, authorization, { agentMembers, projectTasks: projects },
  )
  projects.attachRunStarter(orchestration)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerWorkspaceAgentMemberRoutes(router, agentMembers, authorization)
  registerConversationRoutes(router, conversations, orchestration, runs, agents, authorization, undefined, undefined, agentMembers)
  registerProjectRoutes(router, projects, authorization)
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
  runtime?.releaseAll()
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
  await rm(storageRoot, { recursive: true, force: true })
})
