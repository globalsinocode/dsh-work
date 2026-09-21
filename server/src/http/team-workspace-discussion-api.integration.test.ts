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
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { Router } from './router.ts'
import { registerConversationRoutes } from './workbench/conversation-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './workbench/workspace-agent-member-routes.ts'

const tenantId = 'tenant-dsh-work'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let storageRoot: string
let server: Server
let baseUrl = ''
let agentMembers: PostgresWorkspaceAgentMemberService
let authorization: PostgresAuthorizationService

// ---------------------------------------------------------------------------
// TW-10 空间共享讨论与 @Agent 触发
// ---------------------------------------------------------------------------

test('团队共享讨论：成员可读他人会话线程、可发不产生 Run 的讨论消息，viewer 与非成员被拒', async () => {
  const workspaceId = 'ws-tw10-discussion'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const viewerId = `${workspaceId}-viewer`
  const outsiderId = `${workspaceId}-outsider`
  await createDirectoryUser(ownerId, '讨论负责人')
  await createDirectoryUser(memberId, '讨论成员')
  await createDirectoryUser(viewerId, '讨论只读')
  await createDirectoryUser(outsiderId, '讨论外部人')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])

  // 会话创建入口同样把非对象/非字符串字段归为 422，而不是 500。
  assert.equal((await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: { title: '坏请求', workspaceId: 123 },
  })).status, 422)
  assert.equal((await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: null,
  })).status, 422)

  // TW-10：不带 Agent 成员关联即可创建讨论会话（agentVersionId = null）。
  const created = await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: { title: '发布排期讨论', workspaceId },
  })
  assert.equal(created.status, 201)
  const session = created.body.data as { id: string; agentVersionId: string | null }
  assert.equal(session.agentVersionId, null, '讨论会话不绑定 Agent')

  // 成员读取负责人发起的会话线程（共享）。
  const memberRead = await api('GET', `/api/workbench/v1/sessions/${session.id}`, { as: memberId })
  assert.equal(memberRead.status, 200, '成员可读他人发起的共享会话')
  const thread = memberRead.body.data as { messages: unknown[]; runs: unknown[]; creatorName: string }
  assert.equal(thread.creatorName, '讨论负责人')
  assert.equal(thread.messages.length, 0)
  assert.equal(thread.runs.length, 0)

  // 会话摘要（历史恢复详情）与会话线程分离：`/summary` 仍按创建者口径，
  // 团队会话的共享读走 `/sessions/:id` 线程契约。
  const ownerSummary = await api('GET', `/api/workbench/v1/sessions/${session.id}/summary`, { as: ownerId })
  assert.equal(ownerSummary.status, 200)
  assert.equal((await api('GET', `/api/workbench/v1/sessions/${session.id}/summary`, { as: memberId })).status, 403)

  // 成员发讨论消息：不产生 Run，带发送者归因。
  const posted = await api('POST', `/api/workbench/v1/sessions/${session.id}/messages`, {
    as: memberId,
    body: { content: '本周发布窗口定在周四吗？', idempotencyKey: 'discussion-retry-1' },
  })
  assert.equal(posted.status, 201)
  const postedData = posted.body.data as { messageId: string; sessionId: string; created: boolean }
  assert.equal(postedData.sessionId, session.id)
  assert.equal(postedData.created, true)

  // 同一幂等键重放：不产生第二条消息（网络重试/双击去重）。
  const replayed = await api('POST', `/api/workbench/v1/sessions/${session.id}/messages`, {
    as: memberId,
    body: { content: '本周发布窗口定在周四吗？', idempotencyKey: 'discussion-retry-1' },
  })
  assert.equal(replayed.status, 201)
  const replayedData = replayed.body.data as { messageId: string; created: boolean }
  assert.equal(replayedData.messageId, postedData.messageId, '幂等重放应命中同一条消息')
  assert.equal(replayedData.created, false)

  // 缺少幂等键：与 /runs 同一口径判 422，防止客户端失去去重保护。
  const noKey = await api('POST', `/api/workbench/v1/sessions/${session.id}/messages`, {
    as: memberId,
    body: { content: '缺键消息' },
  })
  assert.equal(noKey.status, 422, '缺少 idempotencyKey 应拒绝')

  const afterPost = await api('GET', `/api/workbench/v1/sessions/${session.id}`, { as: ownerId })
  const afterThread = afterPost.body.data as {
    messages: Array<{ id: string; role: string; content: string; runId: string | null; senderId: string | null; senderName: string | null }>
    runs: unknown[]
  }
  assert.equal(afterThread.messages.length, 1)
  const discussion = afterThread.messages[0]!
  assert.equal(discussion.role, 'user')
  assert.equal(discussion.content, '本周发布窗口定在周四吗？')
  assert.equal(discussion.runId, null, '讨论消息不关联 Run')
  assert.equal(discussion.senderId, memberId)
  assert.equal(discussion.senderName, '讨论成员')
  assert.equal(afterThread.runs.length, 0, '讨论消息不产生 Run')
  const [runCount] = await database<{ count: number }[]>`
    select count(*)::integer as count from runs where tenant_id = ${tenantId} and session_id = ${session.id}
  `
  assert.equal(runCount?.count, 0, '数据库中同样不得产生 Run')

  // 空消息与 viewer 发言被拒。
  const empty = await api('POST', `/api/workbench/v1/sessions/${session.id}/messages`, {
    as: memberId,
    body: { content: '   ', idempotencyKey: 'discussion-empty' },
  })
  assert.equal(empty.status, 422)
  const malformed = await api('POST', `/api/workbench/v1/sessions/${session.id}/messages`, {
    as: memberId,
    body: { content: 123, idempotencyKey: 'discussion-malformed' },
  })
  assert.equal(malformed.status, 422)
  const viewerPost = await api('POST', `/api/workbench/v1/sessions/${session.id}/messages`, {
    as: viewerId,
    body: { content: '只读成员发言', idempotencyKey: 'discussion-viewer' },
  })
  assert.equal(viewerPost.status, 403, '只读成员不得发讨论消息')
  // viewer 可读。
  assert.equal((await api('GET', `/api/workbench/v1/sessions/${session.id}`, { as: viewerId })).status, 200)

  // 非成员：读与写都拒绝。
  assert.equal((await api('GET', `/api/workbench/v1/sessions/${session.id}`, { as: outsiderId })).status, 403)
  const outsiderPost = await api('POST', `/api/workbench/v1/sessions/${session.id}/messages`, {
    as: outsiderId,
    body: { content: '外部人发言', idempotencyKey: 'discussion-outsider' },
  })
  assert.equal(outsiderPost.status, 403)

  // 个人空间会话不适用讨论消息端点。
  const personalSession = await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: { title: '个人会话', workspaceId: `ws-personal-${ownerId}` },
  })
  assert.equal(personalSession.status, 201)
  const personalPost = await api('POST', `/api/workbench/v1/sessions/${(personalSession.body.data as { id: string }).id}/messages`, {
    as: ownerId,
    body: { content: '个人会话讨论消息', idempotencyKey: 'discussion-personal' },
  })
  assert.equal(personalPost.status, 422)
  assert.match(errorMessage(personalPost), /仅团队空间会话支持讨论消息/)
})

test('评审 M-R2/M-R3：同键异文 409、跨会话键命名空间独立、同毫秒微秒级翻页不漏消息', async () => {
  const workspaceId = 'ws-tw10-idem-page'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await createDirectoryUser(ownerId, '幂等负责人')
  await createDirectoryUser(memberId, '幂等成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const session1 = (await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId, body: { title: '会话一', workspaceId },
  })).body.data as { id: string }
  const session2 = (await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId, body: { title: '会话二', workspaceId },
  })).body.data as { id: string }

  // M-R2：同用户、同会话、同键、不同正文——同一确定性 messageId 落到冲突
  // 分支，必须 409 而不能当作成功重放静默吞掉新内容。
  const first = await api('POST', `/api/workbench/v1/sessions/${session1.id}/messages`, {
    as: memberId, body: { content: '第一版内容', idempotencyKey: 'shared-key' },
  })
  assert.equal(first.status, 201)
  const conflict = await api('POST', `/api/workbench/v1/sessions/${session1.id}/messages`, {
    as: memberId, body: { content: '改过的内容', idempotencyKey: 'shared-key' },
  })
  assert.equal(conflict.status, 409, '同键异文必须判冲突而不是当重放')

  // M-R2：键的命名空间含会话——同键跨会话互不冲突，各自独立成消息。
  const other = await api('POST', `/api/workbench/v1/sessions/${session2.id}/messages`, {
    as: memberId, body: { content: '另一会话的同键消息', idempotencyKey: 'shared-key' },
  })
  assert.equal(other.status, 201)
  assert.notEqual(
    (other.body.data as { messageId: string }).messageId,
    (first.body.data as { messageId: string }).messageId,
    '跨会话同键必须是不同的确定性 messageId',
  )

  // M-R3：同毫秒不同微秒——before 边界比较留在 SQL，毫秒截断不得把
  // 同毫秒的更早消息挤出上一页。
  await database`
    insert into messages (id, tenant_id, session_id, run_id, role, content, sender_user_id, created_at)
    values ('msg-page-a', ${tenantId}, ${session1.id}, null, 'user', '同毫秒更早', ${memberId},
            '2026-09-12 09:00:00.123456+00'),
           ('msg-page-b', ${tenantId}, ${session1.id}, null, 'user', '同毫秒更晚', ${memberId},
            '2026-09-12 09:00:00.123789+00')
  `
  const page = await api('GET', `/api/workbench/v1/sessions/${session1.id}?before=msg-page-b`, { as: memberId })
  assert.equal(page.status, 200)
  const pageData = page.body.data as { messages: Array<{ id: string }> }
  assert.ok(
    pageData.messages.some(m => m.id === 'msg-page-a'),
    '同毫秒不同微秒的更早消息必须进入上一页',
  )
  assert.ok(
    !pageData.messages.some(m => m.id === 'msg-page-b'),
    '游标边界消息本身不进入上一页',
  )
})

test('空间会话活动流：成员实时收到他人讨论消息的 session.updated 推送，非成员建连被拒', async () => {
  const workspaceId = 'ws-tw10-live'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const outsiderId = `${workspaceId}-outsider`
  await createDirectoryUser(ownerId, '推送负责人')
  await createDirectoryUser(memberId, '推送成员')
  await createDirectoryUser(outsiderId, '推送外部人')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])

  const created = await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: { title: '实时讨论', workspaceId },
  })
  assert.equal(created.status, 201)
  const sessionId = (created.body.data as { id: string }).id

  // 非成员建连被拒：与列表/线程读取同一 403 口径，不留无拦截降级路径。
  const denied = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/session-events`, { as: outsiderId })
  assert.equal(denied.status, 403)

  // 成员建连：首轮轮询只建立基线；等待超过一个轮询周期后再发消息，
  // 保证新消息一定落在基线之后、以 diff 形式推送。
  const stream = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/session-events`, {
    headers: { 'x-test-user-id': memberId, Accept: 'text/event-stream' },
  })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const readUntil = async (needle: string, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    while (!received.includes(needle) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
    assert.ok(
      received.includes(needle),
      `session-events 未推送 ${needle}；已收到：${received || '(空)'}`,
    )
  }
  await new Promise(resolve => setTimeout(resolve, 700))

  const posted = await api('POST', `/api/workbench/v1/sessions/${sessionId}/messages`, {
    as: ownerId,
    body: { content: '实时推送验证', idempotencyKey: 'discussion-sse-push' },
  })
  assert.equal(posted.status, 201)
  await readUntil(`"session_id":"${sessionId}"`)
  assert.match(received, /event: session\.updated/)

  await reader.cancel()
})

test('@Agent 触发：成员在共享会话中按成员固定版本发起 Run，回复进共享流并带归因', async () => {
  const workspaceId = 'ws-tw10-mention'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const viewerId = `${workspaceId}-viewer`
  await createDirectoryUser(ownerId, '提及负责人')
  await createDirectoryUser(memberId, '提及成员')
  await createDirectoryUser(viewerId, '提及只读')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  await createTool({ id: 'tool-tw10' })
  await createSkill({ id: 'skill-tw10', toolRefs: ['tool-tw10@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-tw10',
    name: '欠料追踪助手',
    skillRefs: ['skill-tw10@1.0.0'],
    toolRefs: ['tool-tw10@1.0.0'],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  // 负责人创建讨论会话（不绑定 Agent）。
  const created = await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: { title: '欠料跟踪讨论', workspaceId },
  })
  assert.equal(created.status, 201)
  const sessionId = (created.body.data as { id: string }).id

  // 历史/预绑定团队会话也不能绕过显式 @ 成员触发。
  await database`
    update sessions set agent_version_id = ${agent.versionId}
     where tenant_id = ${tenantId} and id = ${sessionId}
  `
  // 缺幂等键同样 422：不再由服务端随机生成，客户端必须显式提供。
  const noIdempotencyKey = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: '缺幂等键', workspaceAgentMemberId: wamId },
  })
  assert.equal(noIdempotencyKey.status, 422)
  assert.match(errorMessage(noIdempotencyKey), /idempotencyKey|Idempotency-Key/)
  const preboundNoMention = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: '尝试沿用会话绑定 Agent', idempotencyKey: `${sessionId}-prebound` },
  })
  assert.equal(preboundNoMention.status, 422)
  const malformedRun = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: 123, idempotencyKey: `${sessionId}-malformed` },
  })
  assert.equal(malformedRun.status, 422)

  const memberThread = await api('GET', `/api/workbench/v1/sessions/${sessionId}`, { as: memberId })
  assert.equal(memberThread.status, 200)

  // 无 @ 成员的续写：讨论会话没有会话级 Agent，拒绝且不产生 Run。
  const noMention = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: '这条没有提及 Agent', idempotencyKey: `${sessionId}-no-mention` },
  })
  assert.equal(noMention.status, 422)
  assert.match(errorMessage(noMention), /通过 @Agent 成员发起执行/)

  // viewer 即使 @ 也不得发起执行。
  const viewerRun = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: viewerId,
    body: { prompt: '@欠料追踪助手 查一下', workspaceAgentMemberId: wamId, idempotencyKey: `${sessionId}-viewer` },
  })
  assert.equal(viewerRun.status, 403, '只读成员不得触发 Agent 执行')

  // 成员在他人发起的会话中 @ 触发：按成员固定版本执行（非平台当前版本）。
  const started = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: '@欠料追踪助手 汇总本周欠料', workspaceAgentMemberId: wamId, idempotencyKey: `${sessionId}-mention` },
  })
  assert.equal(started.status, 202)
  const task = started.body.data as { id: string; owner: string; agentVersion: string }
  assert.equal(task.owner, '提及成员', 'Run 归属触发成员而非会话创建者')

  const [attempt] = await database<{ agentVersionId: string | null; requestedBy: string }[]>`
    select ra.manifest ->> 'agent_version_id' as "agentVersionId", r.requested_by as "requestedBy"
      from runs r
      left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
     where r.tenant_id = ${tenantId} and r.id = ${task.id}
  `
  assert.equal(attempt?.requestedBy, memberId)
  assert.equal(attempt?.agentVersionId, agent.versionId, '执行使用 Agent 成员的固定版本')

  await waitForRun(task.id)

  // 共享线程：触发消息带发送者与 runId，Agent 回复带 Agent 归因。
  const thread = await api('GET', `/api/workbench/v1/sessions/${sessionId}`, { as: ownerId })
  assert.equal(thread.status, 200)
  const detail = thread.body.data as {
    messages: Array<{
      role: string
      content: string
      runId: string | null
      senderId: string | null
      agentName: string | null
      runRequesterName: string | null
    }>
    runs: Array<{ runId: string; status: string; requestedBy: string; requesterName: string }>
  }
  const trigger = detail.messages.find(message => message.role === 'user' && message.runId === task.id)
  assert.ok(trigger, '触发消息应关联到 Run')
  assert.equal(trigger.senderId, memberId)
  const reply = detail.messages.find(message => message.role === 'assistant')
  assert.ok(reply, 'Agent 回复应写入共享流')
  assert.equal(reply.runId, task.id)
  assert.equal(reply.agentName, '欠料追踪助手', '回复应标注执行 Agent')
  assert.equal(reply.runRequesterName, '提及成员', '回复应标注触发人')
  assert.deepEqual(detail.runs.map(run => run.requestedBy), [memberId])

  const runDetail = await api('GET', `/api/workbench/v1/runs/${task.id}`, { as: ownerId })
  assert.equal(runDetail.status, 200)
  const runMessages = (runDetail.body.data as {
    workspaceType: string
    workspaceStatus: string
    messages: Array<{ role: string; runId: string | null }>
  }).messages
  assert.equal((runDetail.body.data as { workspaceType: string }).workspaceType, 'team')
  assert.equal((runDetail.body.data as { workspaceStatus: string }).workspaceStatus, 'active')
  assert.ok(runMessages.every(message => message.runId === task.id), 'Run 详情消息必须带 runId 供共享流归因')
})

test('结果读取区分账号停用、授权故障和团队成员移除', async () => {
  const workspaceId = 'ws-tw10-removed'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const outsiderId = `${workspaceId}-outsider`
  await createDirectoryUser(ownerId, '收权负责人')
  await createDirectoryUser(memberId, '将被移出成员')
  await createDirectoryUser(outsiderId, '从未加入外部人')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const agent = await createPublishedAgent({ id: 'agent-tw10-removed', name: '收权测试助手' })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  const created = await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: { title: '收权验证讨论', workspaceId },
  })
  assert.equal(created.status, 201)
  const sessionId = (created.body.data as { id: string }).id

  const started = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: '@收权测试助手 汇总', workspaceAgentMemberId: wamId, idempotencyKey: `${sessionId}-run` },
  })
  assert.equal(started.status, 202)
  const runId = (started.body.data as { id: string }).id

  // 其他成员与非请求成员可读共享 Run。
  assert.equal((await api('GET', `/api/workbench/v1/runs/${runId}`, { as: ownerId })).status, 200)
  // I-06：结果投影与详情同一授权边界——现任成员可读 task-result/v1 投影。
  const resultRead = await api('GET', `/api/workbench/v1/runs/${runId}/result`, { as: ownerId })
  assert.equal(resultRead.status, 200)
  const result = (resultRead.body.data as { version: string; outcome: string; execution: string })
  assert.equal(result.version, 'task-result/v1')
  assert.ok(['queued', 'running'].includes(result.execution))
  assert.equal(result.outcome, 'pending')

  // 当前账号停用属于显式授权拒绝：已知 Run 也必须返回 403，不能继续读取结果。
  await database`update users set status = 'disabled' where tenant_id = ${tenantId} and id = ${ownerId}`
  const disabledResult = await api('GET', `/api/workbench/v1/runs/${runId}/result`, { as: ownerId })
  assert.equal(disabledResult.status, 403)
  assert.equal(disabledResult.body.error?.code, 'permission_denied')
  await database`update users set status = 'active' where tenant_id = ${tenantId} and id = ${ownerId}`

  // 授权基础设施故障必须走服务错误，不能伪装成对象不存在的 404。
  const authorizeWorkbench = authorization.authorizeWorkbench.bind(authorization)
  authorization.authorizeWorkbench = async () => { throw new Error('synthetic authorization database outage') }
  try {
    const unavailableResult = await api('GET', `/api/workbench/v1/runs/${runId}/result`, { as: ownerId })
    assert.equal(unavailableResult.status, 500)
    assert.equal(unavailableResult.body.error?.code, 'operation_failed')
  } finally {
    authorization.authorizeWorkbench = authorizeWorkbench
  }

  // 从未加入的外部人读不到（正文、来源与成果均不可见）。
  assert.equal((await api('GET', `/api/workbench/v1/runs/${runId}`, { as: outsiderId })).status, 404)
  assert.equal((await api('GET', `/api/workbench/v1/runs/${runId}/result`, { as: outsiderId })).status, 404)

  // 移出成员（删除成员行）：即便是该 Run 的发起人也不得再读。
  await database`
    delete from workspace_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${memberId}
  `
  const removedRead = await api('GET', `/api/workbench/v1/runs/${runId}`, { as: memberId })
  assert.equal(removedRead.status, 404, '被移出成员不得再读已知 Run 详情')
  const removedResult = await api('GET', `/api/workbench/v1/runs/${runId}/result`, { as: memberId })
  assert.equal(removedResult.status, 404, '被移出成员不得再读已知 Run 结果')
})

test('团队会话执行权限沿用成员能力边界：@ 已停用 Agent 成员被拒绝', async () => {
  const workspaceId = 'ws-tw10-disabled'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await createDirectoryUser(ownerId, '停用负责人')
  await createDirectoryUser(memberId, '停用成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const agent = await createPublishedAgent({ id: 'agent-tw10-disabled', name: '将被停用' })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  const created = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '停用前讨论', workspaceId },
  })
  assert.equal(created.status, 201)
  const sessionId = (created.body.data as { id: string }).id

  const disabled = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, {
    as: ownerId,
    body: { action: 'disable' },
  })
  assert.equal(disabled.status, 200)

  const denied = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: '@将被停用 查一下', workspaceAgentMemberId: wamId, idempotencyKey: `${sessionId}-disabled` },
  })
  assert.notEqual(denied.status, 202, '已停用 Agent 成员不得被 @ 触发')
  assert.ok(denied.status >= 400)
})

test('共享会话取消/重试：写轨成员均可操作他人发起的 Run，viewer 与非成员拒绝', async () => {
  const workspaceId = 'ws-tw10-runctl'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const viewerId = `${workspaceId}-viewer`
  const outsiderId = `${workspaceId}-outsider`
  await createDirectoryUser(ownerId, '运行负责人')
  await createDirectoryUser(memberId, '运行成员')
  await createDirectoryUser(viewerId, '运行只读')
  await createDirectoryUser(outsiderId, '运行外部人')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  const agent = await createPublishedAgent({ id: 'agent-tw10-runctl', name: '共享控制助手' })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  const created = await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: { title: '共享运行控制讨论', workspaceId },
  })
  assert.equal(created.status, 201)
  const sessionId = (created.body.data as { id: string }).id

  // member 发起 Run；共享会话的取消/重试不再限发起人本人。
  const started = await api('POST', `/api/workbench/v1/sessions/${sessionId}/runs`, {
    as: memberId,
    body: { prompt: '@共享控制助手 开始', workspaceAgentMemberId: wamId, idempotencyKey: `${sessionId}-ctl` },
  })
  assert.equal(started.status, 202)
  const runId = (started.body.data as { id: string }).id
  await waitForRun(runId)

  // viewer / 非成员：取消与重试都走写轨，一律拒绝。
  for (const actor of [viewerId, outsiderId]) {
    assert.equal(
      (await api('POST', `/api/workbench/v1/runs/${runId}/cancel`, { as: actor })).status,
      403,
      `${actor} 不得取消共享 Run`,
    )
    assert.equal(
      (await api('POST', `/api/workbench/v1/runs/${runId}/retry`, { as: actor })).status,
      403,
      `${actor} 不得重试共享 Run`,
    )
  }

  // owner 取消 member 发起的 Run：把终态翻回 queued，覆盖真实收敛路径。
  await database.begin(async transaction => {
    await transaction`
      update runs set status = 'queued' where tenant_id = ${tenantId} and id = ${runId}
    `
    await transaction`
      update run_attempts set status = 'queued'
       where tenant_id = ${tenantId} and id = (
         select current_attempt_id from runs where tenant_id = ${tenantId} and id = ${runId}
       )
    `
  })
  const cancelled = await api('POST', `/api/workbench/v1/runs/${runId}/cancel`, { as: ownerId })
  assert.equal(cancelled.status, 202, '写轨成员可取消他人发起的共享 Run')
  const cancelledTask = cancelled.body.data as { status: string }
  assert.equal(cancelledTask.status, 'cancelled')

  // owner 重试 member 发起的 Run：跨成员重试不在原 Run 上叠加 Attempt——
  // 执行身份契约要求 requested_by === manifest.user_context.user_id，因此创建
  // 属于操作者的新 Run（评审 H3），沿用原提问与固定 Agent 版本。
  const retried = await api('POST', `/api/workbench/v1/runs/${runId}/retry`, { as: ownerId })
  assert.equal(retried.status, 202, '写轨成员可重试他人发起的共享 Run')
  const retriedRunId = (retried.body.data as { id: string }).id
  assert.notEqual(retriedRunId, runId, '跨成员重试应创建新 Run 而不是复用原 Run')
  const [retriedRun] = await database<{ requestedBy: string; sessionId: string }[]>`
    select requested_by as "requestedBy", session_id as "sessionId"
      from runs where tenant_id = ${tenantId} and id = ${retriedRunId}
  `
  assert.equal(retriedRun?.requestedBy, ownerId, '新 Run 归属本次操作者')
  assert.equal(retriedRun?.sessionId, (await database<{ id: string }[]>`
    select session_id as id from runs where tenant_id = ${tenantId} and id = ${runId}
  `)[0]?.id, '新 Run 留在同一共享会话')
  const [retriedAttempt] = await database<{ agentVersionId: string | null; manifestUserId: string | null }[]>`
    select manifest ->> 'agent_version_id' as "agentVersionId",
           manifest #>> '{user_context,user_id}' as "manifestUserId"
      from run_attempts
     where tenant_id = ${tenantId} and id = (
       select current_attempt_id from runs where tenant_id = ${tenantId} and id = ${retriedRunId}
     )
  `
  assert.equal(retriedAttempt?.agentVersionId, agent.versionId, '重试必须沿用原运行的固定版本')
  assert.equal(retriedAttempt?.manifestUserId, ownerId, 'manifest 用户身份必须是操作者而非原发起人')

  // 等待的是新 Run 而不是原 Run（评审中2）：必须真实收敛到 succeeded，
  // 原 Run 不得被追加任何新 Attempt。
  await waitForRun(retriedRunId)
  const [retriedFinal] = await database<{ status: string }[]>`
    select status from runs where tenant_id = ${tenantId} and id = ${retriedRunId}
  `
  assert.equal(retriedFinal?.status, 'succeeded', '跨成员重试的新 Run 必须真实执行成功')
  const [originAttemptCount] = await database<{ count: number }[]>`
    select count(*)::integer as count from run_attempts
     where tenant_id = ${tenantId} and run_id = ${runId}
  `
  assert.equal(originAttemptCount?.count, 1, '原 Run 不得因跨成员重试叠加新 Attempt')

  // manifest 缺 agent_version_id 的历史数据：团队重试必须 422 而不是回落会话绑定。
  await waitForRun(runId)
  await database.begin(async transaction => {
    await transaction`
      update runs set status = 'failed' where tenant_id = ${tenantId} and id = ${runId}
    `
    await transaction`
      update run_attempts set manifest = manifest - 'agent_version_id'
       where tenant_id = ${tenantId} and id = (
         select current_attempt_id from runs where tenant_id = ${tenantId} and id = ${runId}
       )
    `
  })
  const legacyRetry = await api('POST', `/api/workbench/v1/runs/${runId}/retry`, { as: ownerId })
  assert.equal(legacyRetry.status, 422, 'manifest 缺固定版本的团队 Run 不得重试')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  toolRefs?: string[]
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
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_output_bytes, max_tool_calls,
      timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${input.id}, '1.0.0', ${input.name ?? 'TW10 测试 Agent'}, 'TW-10 测试。',
      '', ${database.json(['测试'] as string[])}, '你是 TW-10 集成测试 Agent。',
      ${database.json(['role-employee'] as string[])}, ${database.json(['enterprise:authorized'] as string[])},
      65536, 20, 300, ${database.json(input.skillRefs ?? [])}, ${database.json(input.toolRefs ?? [])},
      'published', 'U00008', 'TW-10 测试版本'
    )
  `
  await database`
    update agents set active_version_id = ${versionId}
     where tenant_id = ${tenantId} and id = ${input.id}
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

async function createTool(input: { id: string }) {
  const versionId = `tool-version-${input.id}-1`
  await database.begin(async transaction => {
    await transaction`
      insert into tools (
        id, tenant_id, key, name, source, status, connector_id, system, description,
        dsh_tool_name, mode, timeout_seconds, allowed_role_ids, data_scopes,
        approval_policy, last_checked_at
      ) values (
        ${input.id}, ${tenantId}, ${`dsh-${input.id}`}, 'TW10 测试工具', 'platform', 'available',
        'connector-dsh-workspace', 'DSH Runtime', 'TW-10 测试工具。',
        ${input.id}, 'read', 30, ${transaction.json(['role-employee'] as string[])},
        ${transaction.json(['enterprise:authorized'] as string[])}, 'none', now()
      )
    `
    await transaction`
      insert into tool_versions (id, tenant_id, tool_id, version, input_schema, output_schema, risk_level, status)
      values (${versionId}, ${tenantId}, ${input.id}, '1.0.0', '{}', '{}', 'low', 'published')
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
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_tw10_discussion_test', maxConnections: 8 })
  database = throwaway.client
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-tw10-'))

  authorization = new PostgresAuthorizationService(database)
  const agents = new PostgresAgentService(database)
  agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  const content = new PostgresContentService(database, storageRoot, authorization)
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
  await rm(storageRoot, { recursive: true, force: true })
})
