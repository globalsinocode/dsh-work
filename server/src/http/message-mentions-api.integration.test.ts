import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeManifest,
} from '../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresConversationTargetService } from '../modules/workbench/application/postgres-conversation-target-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { PostgresWorkspaceService } from '../modules/workbench/application/postgres-workspace-service.ts'
import { PostgresWorkspaceTimelineService } from '../modules/workbench/application/postgres-workspace-timeline-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { Router } from './router.ts'
import { registerConversationRoutes } from './workbench/conversation-routes.ts'
import { registerConversationTargetRoutes } from './workbench/conversation-target-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './workbench/workspace-agent-member-routes.ts'
import { registerWorkspaceTimelineRoutes } from './workbench/workspace-timeline-routes.ts'
import { LocalObjectStorage } from '../infrastructure/storage/local-object-storage.ts'

// MODE-API-04（e2e/TEST-CATALOG.md，项目空间方案 D38）：群聊与共享讨论中 @ 同事的站内提醒——
// 只为现任成员登记、按“消息 + 接收人”去重；读取时重查成员身份；打开群组或讨论即已读。

const tenantId = 'tenant-dsh-work'
const base = '/api/workbench/v1'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let storageRoot: string
let server: Server
let baseUrl = ''
let agentMembers: PostgresWorkspaceAgentMemberService
let authorization: PostgresAuthorizationService

const workspaceId = 'ws-d38-mentions'
const ownerId = `${workspaceId}-owner`
const memberId = `${workspaceId}-member`
const viewerId = `${workspaceId}-viewer`
const outsiderId = `${workspaceId}-outsider`
let sessionId = ''
let wamId = ''

async function setupWorkspace() {
  await createDirectoryUser(ownerId, '提醒负责人')
  await createDirectoryUser(memberId, '提醒成员')
  await createDirectoryUser(viewerId, '提醒只读')
  await createDirectoryUser(outsiderId, '提醒外部人')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  await createSkill({ id: 'skill-d38', toolRefs: ['read@1.0.0'] })
  const agent = await createPublishedAgent({ id: 'agent-d38', name: '提醒测试助手', skillRefs: ['skill-d38@1.0.0'] })
  const joined = await api('POST', `${base}/workspaces/${workspaceId}/agent-members`, { as: ownerId, body: { agentId: agent.id } })
  assert.equal(joined.status, 201)
  wamId = (joined.body.data as { id: string }).id
  const created = await api('POST', `${base}/sessions`, { as: ownerId, body: { title: '提醒讨论', workspaceId } })
  assert.equal(created.status, 201)
  sessionId = (created.body.data as { id: string }).id
}

async function mentionRows(messageId: string) {
  return database<{ userId: string }[]>`
    select mentioned_user_id as "userId" from message_mentions
     where tenant_id = ${tenantId} and message_id = ${messageId} order by mentioned_user_id
  `
}

async function mentionCount(userId: string) {
  const result = await api('GET', `${base}/me/mentions`, { as: userId })
  assert.equal(result.status, 200)
  return (result.body.data as { items: unknown[] }).items.length
}

async function groupTarget(userId: string) {
  const result = await api('GET', `${base}/me/conversation-targets`, { as: userId })
  assert.equal(result.status, 200)
  return (result.body.data as { items: Array<{ type: string; id: string; mentioned: boolean }> }).items
    .find(item => item.type === 'group' && item.id === workspaceId)
}

test('讨论消息 @ 同事：只为现任成员登记提醒，忽略本人与非成员，幂等重放不重复', async () => {
  const posted = await api('POST', `${base}/sessions/${sessionId}/messages`, {
    as: ownerId,
    body: {
      content: '@提醒成员 @提醒只读 请看一下排期',
      idempotencyKey: 'd38-discussion-1',
      mentionedUserIds: [memberId, viewerId, ownerId, outsiderId, memberId],
    },
  })
  assert.equal(posted.status, 201)
  const messageId = (posted.body.data as { messageId: string }).messageId
  assert.deepEqual((await mentionRows(messageId)).map(row => row.userId), [memberId, viewerId].sort())

  const replay = await api('POST', `${base}/sessions/${sessionId}/messages`, {
    as: ownerId,
    body: { content: '@提醒成员 @提醒只读 请看一下排期', idempotencyKey: 'd38-discussion-1', mentionedUserIds: [memberId, viewerId] },
  })
  assert.equal(replay.status, 201)
  assert.equal((replay.body.data as { created: boolean }).created, false)
  assert.equal((await mentionRows(messageId)).length, 2, '幂等重放不重复登记')

  // 讨论详情与群组时间线的消息带 mentionedUserIds。
  const thread = await api('GET', `${base}/sessions/${sessionId}`, { as: memberId })
  const message = (thread.body.data as { messages: Array<{ id: string; mentionedUserIds?: string[] }> }).messages.find(item => item.id === messageId)
  assert.deepEqual(message?.mentionedUserIds, [memberId, viewerId].sort())
  const timeline = await api('GET', `${base}/workspaces/${workspaceId}/timeline`, { as: memberId })
  assert.equal(timeline.status, 200)
  const item = (timeline.body.data as { items: Array<{ id: string; mentionedUserIds?: string[] }> }).items.find(entry => entry.id === `m:${messageId}`)
  assert.deepEqual(item?.mentionedUserIds, [memberId, viewerId].sort())
})

test('mentionedUserIds 格式不对返回 422', async () => {
  for (const mentionedUserIds of ['U1', [1], [''], Array.from({ length: 51 }, (_, index) => `u-${index}`)]) {
    const result = await api('POST', `${base}/sessions/${sessionId}/messages`, {
      as: ownerId,
      body: { content: '格式错误', idempotencyKey: `d38-bad-${randomUUID()}`, mentionedUserIds },
    })
    assert.equal(result.status, 422, JSON.stringify(mentionedUserIds))
  }
})

test('同一条消息同时 @Agent 与同事：交给 Agent 执行，并为同事登记提醒', async () => {
  const started = await api('POST', `${base}/sessions/${sessionId}/runs`, {
    as: memberId,
    body: {
      prompt: '@提醒测试助手 汇总一下 @提醒负责人',
      workspaceAgentMemberId: wamId,
      idempotencyKey: 'd38-run-1',
      mentionedUserIds: [ownerId, outsiderId],
    },
  })
  assert.equal(started.status, 202, errorMessage(started))
  const runId = (started.body.data as { id: string }).id
  await waitForRun(runId)
  assert.deepEqual((await mentionRows(`message-user-${runId}`)).map(row => row.userId), [ownerId])
})

test('GET /me/mentions 汇总本人未读提醒；对话对象带 mentioned，静音不影响', async () => {
  const summary = await api('GET', `${base}/me/mentions`, { as: memberId })
  assert.equal(summary.status, 200)
  const items = (summary.body.data as { items: Array<{ workspaceId: string; sessionId: string; count: number }> }).items
  assert.deepEqual(items.map(item => [item.workspaceId, item.sessionId, item.count]), [[workspaceId, sessionId, 1]])
  assert.equal(await mentionCount(outsiderId), 0)

  await database`
    insert into workspace_notification_states (tenant_id, workspace_id, user_id, muted_at)
    values (${tenantId}, ${workspaceId}, ${memberId}, now())
    on conflict (tenant_id, workspace_id, user_id) do update set muted_at = now()
  `
  assert.equal((await groupTarget(memberId))?.mentioned, true, '静音的群组仍显示 @ 提醒')
  assert.equal((await groupTarget(ownerId))?.mentioned, true)
})

test('POST /me/mentions/read 只读本人在该讨论的提醒；打开群组同时把提醒标为已读', async () => {
  assert.equal((await api('POST', `${base}/me/mentions/read`, { as: outsiderId, body: { workspaceId } })).status, 404)
  assert.equal((await api('POST', `${base}/me/mentions/read`, { as: memberId, body: {} })).status, 422)

  const read = await api('POST', `${base}/me/mentions/read`, { as: memberId, body: { workspaceId, sessionId } })
  assert.equal(read.status, 200)
  assert.equal((read.body.data as { read: number }).read, 1)
  assert.equal(await mentionCount(memberId), 0)
  assert.equal((await groupTarget(memberId))?.mentioned, false)
  // 只读成员的提醒不受成员读取影响。
  assert.equal(await mentionCount(viewerId), 1)

  const opened = await api('POST', `${base}/me/conversation-targets/group/${workspaceId}/read`, { as: ownerId, body: {} })
  assert.equal(opened.status, 200)
  assert.equal((await groupTarget(ownerId))?.mentioned, false, '打开群组即已读')
})

test('被移出群组后不再返回该群组的提醒', async () => {
  assert.equal(await mentionCount(viewerId), 1)
  await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${viewerId}`
  assert.equal(await mentionCount(viewerId), 0)
  assert.equal(await groupTarget(viewerId), undefined)
  assert.equal((await api('POST', `${base}/me/mentions/read`, { as: viewerId, body: { workspaceId } })).status, 404)
})

async function waitForRun(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [row] = await database<{ status: string }[]>`
      select status from runs where tenant_id = ${tenantId} and id = ${runId}
    `
    if (row && ['succeeded', 'failed', 'cancelled'].includes(row.status)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`等待 Run 终态超时：${runId}`)
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

async function createDirectoryUser(id: string, displayName: string) {
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status,
      identity_provider, business_user
    ) values (
      ${id}, ${tenantId}, ${`directory:${id}`}, ${displayName},
      null, 'active', 'ai-hub', true
    )
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local')
    on conflict do nothing
  `
}

async function createTeamWorkspace(workspaceId: string, members: Array<{ userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>) {
  const ownerId = members[0]?.userId ?? 'U00001'
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'TW-10 共享讨论测试空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

async function createPublishedAgent(input: {
  id: string
  name?: string
  skillRefs?: string[]
}) {
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
      status, active_version_id, allow_workspace_join
    ) values (
      ${input.id}, ${tenantId}, ${input.name ?? 'TW10 测试 Agent'}, 'TW-10 共享讨论集成测试。',
      '', 'U00008', 'U00008', 'published', null, true
    )
  `
  const versionId = `agent-version-${input.id}-1-0-0`
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, max_output_bytes, max_tool_calls,
      timeout_seconds, skill_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${input.id}, '1.0.0', ${input.name ?? 'TW10 测试 Agent'}, 'TW-10 测试。',
      '', ${database.json(['测试'] as string[])}, '你是 TW-10 集成测试 Agent。',
      65536, 20, 300, ${database.json(input.skillRefs ?? [])},
      'published', 'U00008', 'TW-10 测试版本'
    )
  `
  await database`update agents set visible_role_ids = ${database.json(['role-employee'] as string[])} where tenant_id = ${tenantId} and id = ${input.id}`
  await database`
    update agents set active_version_id = ${versionId}
     where tenant_id = ${tenantId} and id = ${input.id}
  `
  // The Agent executes with its own principal, not the triggering member's.
  await database`
    insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
    values (${tenantId}, ${`principal-agent-${input.id}`}, 'role-employee')
  `
  await database`
    insert into agent_principal_scope_grants (tenant_id, principal_id, scope_value)
    values (${tenantId}, ${`principal-agent-${input.id}`}, 'enterprise:authorized')
  `
  return { id: input.id, versionId }
}

async function createSkill(input: { id: string; toolRefs?: string[] }) {
  const versionId = `skill-version-${input.id}-1`
  await database.begin(async transaction => {
    await transaction`
      insert into skills (
        id, tenant_id, key, name, category, description, owner_user_id, created_by,
        status, active_version_id, draft_version_id
      ) values (
        ${input.id}, ${tenantId}, ${input.id}, 'TW10 测试技能', '文件', 'TW-10 测试技能。',
        'U00008', 'U00008', 'published', null, null
      )
    `
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, tool_refs, test_prompt, status, created_by, published_by, published_at,
        change_summary
      ) values (
        ${versionId}, ${tenantId}, ${input.id}, '1.0.0', 'TW10 测试技能', '文件',
        'TW-10 测试技能。', '测试说明。', '{}',
        ${transaction.json(input.toolRefs ?? [])}, '测试问题', 'published', 'U00008', 'U00008',
        now(), 'TW10 测试'
      )
    `
    await transaction`
      update skills set active_version_id = ${versionId}
       where tenant_id = ${tenantId} and id = ${input.id}
    `
  })
  return { id: input.id, versionId }
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
  const body = await response.json().catch(() => null) as {
    data?: unknown
    error?: { code: string; message: string }
  }
  return { status: response.status, body }
}

function errorMessage(result: { body: { error?: { message: string } } }): string {
  return result.body.error?.message ?? ''
}

/**
 * 确定性 Runtime：受理即排队，短暂延迟后产出固定回答并完成——与真实
 * DSH 链路同样的 Run/Attempt/事件结构，但不依赖外部进程。
 */
class CompletingTestRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, {
    manifest: RuntimeManifest
    listeners: Set<(event: RuntimeEvent) => void>
    events: RuntimeEvent[]
  }>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    const now = new Date().toISOString()
    const state = { manifest, listeners: new Set<(event: RuntimeEvent) => void>(), events: [] as RuntimeEvent[] }
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
    const done = new Promise<RuntimeExecutionSnapshot>((resolve) => {
      setTimeout(() => {
        emit('run.started', '已启动')
        emit('assistant.completed', 'TW-10 测试回答')
        emit('run.completed', '已完成')
        resolve({
          runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'completed', acceptedAt: now,
          startedAt: now, endedAt: new Date().toISOString(), manifestSha256: 'test',
          attemptDirectory: '/tmp/test', errorCode: null, errorMessage: null,
        })
      }, 20)
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
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_d38_mentions_test', maxConnections: 8 })
  database = throwaway.client
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-d38-'))

  authorization = new PostgresAuthorizationService(database)
  const agents = new PostgresAgentService(database)
  agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  const content = new PostgresContentService(database, new LocalObjectStorage(storageRoot), authorization)
  const conversations = new PostgresConversationRepository(database)
  const runs = new PostgresRunRepository(database)
  const orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    new CompletingTestRuntime(),
    content,
    undefined,
    agents,
    undefined,
    authorization,
    { agentMembers },
  )
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerWorkspaceAgentMemberRoutes(router, agentMembers, authorization)
  registerConversationRoutes(router, conversations, orchestration, runs, agents, authorization, undefined, undefined, agentMembers)
  registerConversationTargetRoutes(router, new PostgresConversationTargetService(database, agents))
  registerWorkspaceTimelineRoutes(router, new PostgresWorkspaceTimelineService(database, new PostgresWorkspaceService(database)), authorization)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP Server 没有获得端口')
  baseUrl = `http://127.0.0.1:${address.port}`
  await setupWorkspace()
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
  await rm(storageRoot, { recursive: true, force: true })
})
