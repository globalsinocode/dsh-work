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
import { PostgresTaskRepository } from '../modules/task/postgres-task-repository.ts'
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
import { PostgresProjectArchiveService } from '../modules/workbench/application/postgres-project-archive-service.ts'
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
let content: PostgresContentService
let orchestration: RunOrchestrationService
let projects: PostgresProjectService

interface TaskView {
  id: string
  status: string
  sessionId: string | null
  latestRunId: string | null
  assignee: { type: string; agentMemberId?: string; userId?: string }
  completionNote: string | null
  allowedActions: string[]
  latestRunStatus?: string | null
  schedule?: { kind: string; timezone: string; timeOfDay?: string; weekdays?: number[] } | null
  scheduleState?: string | null
  scheduleReason?: string | null
  nextRunAt?: string | null
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
  // S3：员工任务创建时就有任务对话，首条消息为任务标题与说明。
  assert.ok(task.sessionId)
  const conversation = await api('GET', `${base}/sessions/${task.sessionId}`, { as: ws.viewer })
  assert.deepEqual((conversation.body.data as { messages: Array<{ content: string }> }).messages.map(message => message.content), ['整理供应商名单\n\n按区域分组'])

  const viewerList = await api('GET', `${base}/workspaces/${ws.id}/project-tasks`, { as: ws.viewer })
  assert.deepEqual((viewerList.body.data as { items: TaskView[] }).items.map(item => item.allowedActions), [[]])

  // 任务详情：现任成员（含只读）可读，动作按本人角色裁剪；非成员拒绝，不存在返回 404。
  const viewerDetail = await api('GET', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.viewer })
  assert.equal(viewerDetail.status, 200)
  assert.equal((viewerDetail.body.data as TaskView).id, task.id)
  assert.deepEqual((viewerDetail.body.data as TaskView).allowedActions, [])
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.outsider })).status, 403)
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/project-tasks/missing-task`, { as: ws.member })).status, 404)

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
  // S3：状态推进与完成写入任务事件，现任成员（含只读）可读。
  const events = await api('GET', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/events`, { as: ws.viewer })
  assert.equal(events.status, 200)
  const eventRows = events.body.data as Array<{ kind: string; actor: { userId: string }; metadata: Record<string, unknown> }>
  assert.deepEqual(eventRows.map(event => event.kind), ['status_changed', 'completed'])
  assert.deepEqual(eventRows[0]!.metadata, { from: 'todo', to: 'in_progress' })
  assert.equal(eventRows[1]!.metadata['note'], '已按华东、华南分组')
  assert.equal(eventRows[1]!.actor.userId, ws.admin)
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/events`, { as: ws.outsider })).status, 403)
  assert.deepEqual((await activityKinds(ws.id)).sort(), ['project_task_completed', 'project_task_created'])

  // 创建人移除；移除后不再出现在列表。
  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.other })).status, 403)
  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.member })).status, 200)
  assert.equal(((await api('GET', `${base}/workspaces/${ws.id}/project-tasks`, { as: ws.member })).body.data as { items: unknown[] }).items.length, 0)
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.member })).status, 404)

  // 归档后任务只读：负责人与创建人看到的任务都不再带任何写动作。
  const kept = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '归档前的任务', assignee: { type: 'employee', id: ws.member } },
  })
  assert.equal(kept.status, 201)
  await archive(ws.id)
  for (const as of [ws.owner, ws.member]) {
    const archivedList = await api('GET', `${base}/workspaces/${ws.id}/project-tasks`, { as })
    assert.deepEqual((archivedList.body.data as { items: TaskView[] }).items.map(item => item.allowedActions), [[]])
  }
  const archivedDetail = await api('GET', `${base}/workspaces/${ws.id}/project-tasks/${(kept.body.data as TaskView).id}`, { as: ws.member })
  assert.equal(archivedDetail.status, 200)
  assert.deepEqual((archivedDetail.body.data as TaskView).allowedActions, [])
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
  assert.ok(task.sessionId, 'S3：Agent 任务创建时就有任务对话')
  // S4：未指定执行规则时默认每天 09:00（平台时区），下一次时间点已排好。
  assert.equal(task.schedule?.kind, 'daily')
  assert.equal(task.schedule?.timeOfDay, '09:00')
  assert.equal(task.scheduleState, 'active')
  assert.ok(task.nextRunAt)
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, { as: ws.member, body: {} })).status, 422)
  // 未开始执行前可以先评论（不触发执行）。
  assert.equal((await api('POST', `${base}/sessions/${task.sessionId}/messages`, {
    as: ws.other, body: { content: '先等华南数据', idempotencyKey: `early-comment-${task.id}` },
  })).status, 201)

  const started = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
    as: ws.member, body: { idempotencyKey: `start-${task.id}` },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const running = started.body.data as TaskView
  assert.equal(running.sessionId, task.sessionId, '在创建时的任务对话中执行')
  assert.ok(running.latestRunId)
  assert.equal(running.status, 'in_progress')
  assert.ok(running.allowedActions.includes('start'), 'S4：立即执行在任何规则下可用，执行中由 409 拒绝')
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
    as: ws.member, body: { idempotencyKey: `start-again-${task.id}` },
  })).status, 409)

  const manifest = await waitForManifest(running.latestRunId!)
  assert.equal(manifest?.input.message, '请开始执行任务“分析缺货原因”。')
  assert.equal(manifest?.project_context?.brief?.content, '目标：本季度缺货率降到 3%')
  assert.equal(manifest?.project_context?.brief?.version_no, 1)

  // 执行中：线程内再回复被拒绝（同一时间只允许一个执行），改派与移除同样被拒。
  const busy = await api('POST', `${base}/sessions/${running.sessionId}/runs`, {
    as: ws.other, body: { prompt: '再补充一点', idempotencyKey: `busy-${task.id}` },
  })
  assert.equal(busy.status, 409)
  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.member })).status, 409)
  // “仅评论”：执行中仍可发表评论，不产生新的执行。
  assert.equal((await api('POST', `${base}/sessions/${running.sessionId}/messages`, {
    as: ws.other, body: { content: '原因二的口径要和上周一致', idempotencyKey: `busy-comment-${task.id}` },
  })).status, 201)

  runtime.releaseAll()
  await waitForRun(running.latestRunId!)
  const afterRun = await taskById(ws, task.id)
  assert.equal(afterRun.status, 'in_progress', 'S4：执行成功不改任务状态，由人标记完成')
  assert.equal(afterRun.latestRunStatus, 'succeeded')

  // 简报更新后，线程内回复（不 @、不带成员关联）交给同一 Agent，并带上新版本简报。
  await api('PUT', `${base}/workspaces/${ws.id}/brief`, { as: ws.owner, body: { content: '目标：缺货率降到 2%' } })
  const reply = await api('POST', `${base}/sessions/${running.sessionId}/runs`, {
    as: ws.other, body: { prompt: '再看看华南', idempotencyKey: `reply-${task.id}` },
  })
  assert.equal(reply.status, 202, JSON.stringify(reply.body))
  const replyRunId = (reply.body.data as { runId?: string; id?: string }).runId ?? (reply.body.data as { id: string }).id
  const replyManifest = await waitForManifest(replyRunId)
  assert.equal(replyManifest?.project_context?.brief?.version_no, 2)
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

test('任务线程：停止执行后标注由谁停止', async () => {
  await drainRuntime()
  const ws = await seedSpace('stop')
  const agentMemberId = await joinAgent(ws, 'stop')
  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '核对到货承诺', assignee: { type: 'agent', id: agentMemberId } },
  })
  const task = created.body.data as TaskView
  const started = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
    as: ws.member, body: { idempotencyKey: `stop-start-${task.id}` },
  })
  const running = started.body.data as TaskView
  await waitForManifest(running.latestRunId!)
  const before = await api('GET', `${base}/runs/${running.latestRunId}`, { as: ws.viewer })
  assert.equal((before.body.data as { stoppedBy?: string | null }).stoppedBy, null, '未停止时不标注')

  // 只读成员不能停止；另一位成员停止后，Run 详情与线程执行记录都标注停止人。
  assert.equal((await api('POST', `${base}/runs/${running.latestRunId}/cancel`, { as: ws.viewer })).status, 403)
  assert.equal((await api('POST', `${base}/runs/${running.latestRunId}/cancel`, { as: ws.other })).status, 202)
  await waitForRun(running.latestRunId!)
  const detail = await api('GET', `${base}/runs/${running.latestRunId}`, { as: ws.viewer })
  assert.equal((detail.body.data as { status: string }).status, 'cancelled')
  assert.equal((detail.body.data as { stoppedBy?: string | null }).stoppedBy, 'stop-other')
  const thread = await api('GET', `${base}/sessions/${running.sessionId}`, { as: ws.viewer })
  const runs = (thread.body.data as { runs: Array<{ runId: string; stoppedByName: string | null }> }).runs
  assert.deepEqual(runs.map(run => [run.runId, run.stoppedByName]), [[running.latestRunId, 'stop-other']])
  const stopped = await taskById(ws, task.id)
  assert.equal(stopped.status, 'in_progress', 'S4：停止只体现在最近执行，任务状态不变')
  assert.equal(stopped.latestRunStatus, 'cancelled')
})

test('讨论线程不能设为任务：任务只由成员明确新建；历史列表只为任务对话标注所属任务', async () => {
  const ws = await seedSpace('mark')
  const agentMemberId = await joinAgent(ws, 'mark')
  const discussion = await api('POST', `${base}/sessions`, { as: ws.member, body: { title: '库存讨论', workspaceId: ws.id } })
  const sessionId = (discussion.body.data as { id: string }).id
  const run = await api('POST', `${base}/sessions/${sessionId}/runs`, {
    as: ws.member, body: { prompt: '@助手 看看库存', idempotencyKey: `mark-${sessionId}`, workspaceAgentMemberId: agentMemberId },
  })
  assert.equal(run.status, 202, JSON.stringify(run.body))
  runtime.releaseAll()

  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/sessions/${sessionId}/project-task`, { as: ws.member, body: {} })).status, 404)
  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '核对库存', assignee: { type: 'employee', id: ws.member } },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const task = created.body.data as TaskView

  const history = await api('GET', `${base}/workspaces/${ws.id}/sessions`, { as: ws.member })
  const rows = (history.body.data as { items: Array<{ sessionId: string; projectTaskId: string | null }> }).items
  assert.equal(rows.find(row => row.sessionId === sessionId)?.projectTaskId, null)
  assert.equal(rows.find(row => row.sessionId === task.sessionId)?.projectTaskId, task.id)
})

test('任务分页：同一毫秒内创建的任务按微秒游标逐页取全；sessionId 精确查找线程任务；limit 越界 422（P2-15）', async () => {
  const ws = await seedSpace('paging')
  const ids: string[] = []
  for (const title of ['分页一', '分页二', '分页三']) {
    const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
      as: ws.member, body: { title, assignee: { type: 'employee', id: ws.member } },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    ids.push((created.body.data as { id: string }).id)
  }
  // 三个任务落在同一毫秒、不同微秒：毫秒精度的游标会把后两条跳过。
  for (const [index, micros] of ['123456', '123300', '123100'].entries()) {
    await database`
      update project_tasks set created_at = ${`2026-10-18T08:00:00.${micros}Z`}::text::timestamptz
       where tenant_id = ${tenantId} and id = ${ids[index]!}
    `
  }
  const seen: string[] = []
  let cursor: string | null = null
  do {
    const query: string = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1'
    const pageResponse = await api('GET', `${base}/workspaces/${ws.id}/project-tasks${query}`, { as: ws.viewer })
    assert.equal(pageResponse.status, 200, JSON.stringify(pageResponse.body))
    const pageData = pageResponse.body.data as { items: Array<{ id: string }>; nextCursor: string | null; total: number }
    assert.equal(pageData.total, 3)
    seen.push(...pageData.items.map(item => item.id))
    cursor = pageData.nextCursor
  } while (cursor && seen.length < 10)
  assert.deepEqual(seen, ids)

  const discussion = await api('POST', `${base}/sessions`, { as: ws.member, body: { title: '分页线程', workspaceId: ws.id } })
  const sessionId = (discussion.body.data as { id: string }).id
  // S3 起两类任务都可以绑定任务对话；这里直接把分页任务三绑定到一条讨论线程。
  await database`
    update project_tasks set session_id = ${sessionId}
     where tenant_id = ${tenantId} and id = ${ids[2]!}
  `
  const bySession = await api('GET', `${base}/workspaces/${ws.id}/project-tasks?limit=1&sessionId=${encodeURIComponent(sessionId)}`, { as: ws.member })
  assert.deepEqual((bySession.body.data as { items: Array<{ id: string }> }).items.map(item => item.id), [ids[2]])

  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/project-tasks?limit=101`, { as: ws.member })).status, 422)
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/project-tasks?cursor=bm90LWEtY3Vyc29y`, { as: ws.member })).status, 422)
})

test('任务线程：并发回复只受理一个执行；启动未能受理时任务可重新启动（P1-1、P1-2）', async () => {
  await drainRuntime()
  const ws = await seedSpace('race')
  const agentMemberId = await joinAgent(ws, 'race')
  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '核对库存差异', assignee: { type: 'agent', id: agentMemberId } },
  })
  const task = created.body.data as TaskView

  // 受理前失败（Runtime 不可用）：不留下已绑定线程却从未执行的任务。
  const assertAvailable = runtime.assertAvailable
  runtime.assertAvailable = async () => { throw new Error('Runtime 暂不可用') }
  try {
    const failed = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
      as: ws.member, body: { idempotencyKey: `race-fail-${task.id}` },
    })
    assert.notEqual(failed.status, 202)
  } finally {
    runtime.assertAvailable = assertAvailable
  }
  // S3：任务对话在创建时已存在，受理前失败不影响它；任务仍未开始，可重新启动。
  const unstarted = await taskById(ws, task.id)
  assert.equal(unstarted.sessionId, task.sessionId)
  assert.equal(unstarted.latestRunId, null)
  assert.ok(unstarted.allowedActions.includes('start'))

  const started = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
    as: ws.member, body: { idempotencyKey: `race-start-${task.id}` },
  })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const running = started.body.data as TaskView
  await waitForManifest(running.latestRunId!)
  runtime.releaseAll()
  await waitForRun(running.latestRunId!)

  const replies = await Promise.all([0, 1, 2].map(index => api('POST', `${base}/sessions/${running.sessionId}/runs`, {
    as: index % 2 ? ws.other : ws.member, body: { prompt: `并发回复 ${index}`, idempotencyKey: `race-reply-${index}-${task.id}` },
  })))
  assert.deepEqual(replies.map(reply => reply.status).sort(), [202, 409, 409], JSON.stringify(replies.map(reply => reply.body)))
  const [active] = await database<{ count: number }[]>`
    select count(*)::integer as count from runs
     where tenant_id = ${tenantId} and session_id = ${running.sessionId}
       and status in ('queued', 'running', 'waiting', 'cancel_requested')
  `
  assert.equal(active?.count, 1)
  await drainRuntime()
})

test('S3 员工任务对话：承接人首次发言自动进行中，不能交给 Agent；同类改派沿用对话，跨类型改派换新对话', async () => {
  await drainRuntime()
  const ws = await seedSpace('conversation')
  const agentMemberId = await joinAgent(ws, 'conversation')
  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.owner, body: { title: '核对交付差异', assignee: { type: 'employee', id: ws.member } },
  })
  const task = created.body.data as TaskView
  const sessionId = task.sessionId!
  assert.ok(sessionId)

  // 任务说明（首条消息）由平台以创建人身份写入，不算承接人发言：自己承接自己创建的任务仍是待办。
  const own = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '自己承接的任务', assignee: { type: 'employee', id: ws.member } },
  })
  assert.equal((own.body.data as TaskView).status, 'todo')

  // 其他成员评论不推进状态；承接人首次发言推进为进行中，并留下自动的状态记录。
  assert.equal((await api('POST', `${base}/sessions/${sessionId}/messages`, {
    as: ws.other, body: { content: '需要周三前完成', idempotencyKey: `conv-other-${task.id}` },
  })).status, 201)
  assert.equal((await taskById(ws, task.id)).status, 'todo')
  assert.equal((await api('POST', `${base}/sessions/${sessionId}/messages`, {
    as: ws.member, body: { content: '已核对前 20 个 SKU', idempotencyKey: `conv-assignee-${task.id}` },
  })).status, 201)
  assert.equal((await taskById(ws, task.id)).status, 'in_progress')
  const autoEvents = (await api('GET', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/events`, { as: ws.member })).body.data as Array<{ kind: string; metadata: Record<string, unknown> }>
  assert.deepEqual(autoEvents.map(event => [event.kind, event.metadata['auto']]), [['status_changed', true]])

  // 员工任务的对话不能 @Agent 发起执行。
  assert.equal((await api('POST', `${base}/sessions/${sessionId}/runs`, {
    as: ws.member, body: { prompt: '@助手 帮忙核对', idempotencyKey: `conv-run-${task.id}`, workspaceAgentMemberId: agentMemberId },
  })).status, 422)

  // 员工换员工：沿用原对话，记一条改派事件。
  const toOther = await api('PATCH', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, {
    as: ws.owner, body: { assignee: { type: 'employee', id: ws.other } },
  })
  assert.equal(toOther.status, 200, JSON.stringify(toOther.body))
  assert.equal((toOther.body.data as TaskView).sessionId, sessionId)
  const reassignEvents = (await api('GET', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/events`, { as: ws.member })).body.data as Array<{ kind: string }>
  assert.equal(reassignEvents.at(-1)?.kind, 'reassigned')

  // 改派给 Agent：从新的任务对话开始，首条消息仍是任务标题。
  const toAgent = await api('PATCH', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, {
    as: ws.owner, body: { assignee: { type: 'agent', id: agentMemberId } },
  })
  assert.equal(toAgent.status, 200, JSON.stringify(toAgent.body))
  const agentSessionId = (toAgent.body.data as TaskView).sessionId
  assert.ok(agentSessionId && agentSessionId !== sessionId)
  const fresh = await api('GET', `${base}/sessions/${agentSessionId}`, { as: ws.member })
  assert.deepEqual((fresh.body.data as { messages: Array<{ content: string }> }).messages.map(message => message.content), ['核对交付差异'])
})

test('S4 执行规则：默认每天、保存并立即执行、由人标记完成，完成后停止定时、重新打开恢复', async () => {
  await drainRuntime()
  const ws = await seedSpace('schedule')
  const agentMemberId = await joinAgent(ws, 'schedule')
  const tasksPath = `${base}/workspaces/${ws.id}/project-tasks`

  // 规则校验：员工任务不能带执行规则；每周必须选星期；手动规则没有下次时间点。
  assert.equal((await api('POST', tasksPath, {
    as: ws.member, body: { title: '员工带规则', assignee: { type: 'employee', id: ws.member }, schedule: { kind: 'daily', timeOfDay: '09:00' } },
  })).status, 422)
  assert.equal((await api('POST', tasksPath, {
    as: ws.member, body: { title: '每周无星期', assignee: { type: 'agent', id: agentMemberId }, schedule: { kind: 'weekly', timeOfDay: '09:00', weekdays: [] } },
  })).status, 422)
  const manual = (await api('POST', tasksPath, {
    as: ws.member, body: { title: '手动任务', assignee: { type: 'agent', id: agentMemberId }, schedule: { kind: 'manual' } },
  })).body.data as TaskView
  assert.equal(manual.schedule?.kind, 'manual')
  assert.equal(manual.nextRunAt, null)
  assert.equal(manual.status, 'todo')

  // 保存并立即执行：任务创建后立刻受理第一次执行，进入进行中。
  const created = await api('POST', tasksPath, {
    as: ws.member, body: {
      title: '每日缺货汇总', assignee: { type: 'agent', id: agentMemberId },
      schedule: { kind: 'weekly', timeOfDay: '18:30', weekdays: [5, 1, 2, 3, 4] }, startNow: true,
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const task = created.body.data as TaskView
  assert.deepEqual(task.schedule?.weekdays, [1, 2, 3, 4, 5])
  assert.equal(task.status, 'in_progress')
  assert.ok(task.latestRunId)
  // 先等 Runtime 收到这次执行再放行；否则 releaseAll 时执行尚未登记，放行落空。
  await waitForManifest(task.latestRunId!)
  runtime.releaseAll()
  await waitForRun(task.latestRunId!)
  assert.equal((await taskById(ws, task.id)).status, 'in_progress')

  // 修改规则：写入系统记录，修改人接管归因。
  const changed = await api('PATCH', `${tasksPath}/${task.id}`, {
    as: ws.admin, body: { schedule: { kind: 'daily', timeOfDay: '07:00' } },
  })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.equal((changed.body.data as TaskView).schedule?.timeOfDay, '07:00')
  const [setter] = await database<{ setBy: string }[]>`
    select schedule_set_by as "setBy" from project_tasks where tenant_id = ${tenantId} and id = ${task.id}
  `
  assert.equal(setter?.setBy, ws.admin)

  // Agent 任务由人标记完成：停止定时、不能再立即执行或在对话中交给 Agent，完成说明登记进档案。
  assert.equal((await api('POST', `${tasksPath}/${task.id}/status`, { as: ws.other, body: { status: 'done' } })).status, 403)
  const done = await api('POST', `${tasksPath}/${task.id}/status`, { as: ws.member, body: { status: 'done', completionNote: '本月汇总完毕' } })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  const doneTask = done.body.data as TaskView
  assert.equal(doneTask.status, 'done')
  assert.equal(doneTask.scheduleState, 'stopped')
  assert.equal(doneTask.scheduleReason, 'completed')
  assert.equal(doneTask.nextRunAt, null)
  assert.equal(doneTask.allowedActions.includes('start'), false)
  assert.equal((await api('POST', `${tasksPath}/${task.id}/start`, { as: ws.member, body: { idempotencyKey: `done-${task.id}` } })).status, 409)
  assert.equal((await api('POST', `${base}/sessions/${task.sessionId}/runs`, {
    as: ws.member, body: { prompt: '再跑一次', idempotencyKey: `done-reply-${task.id}` },
  })).status, 409)
  const [archived] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_archive_inputs where tenant_id = ${tenantId} and project_task_id = ${task.id}
  `
  assert.ok((archived?.count ?? 0) >= 1)
  const events = (await api('GET', `${tasksPath}/${task.id}/events`, { as: ws.viewer })).body.data as Array<{ kind: string }>
  assert.ok(events.some(event => event.kind === 'schedule_changed'))
  assert.ok(events.some(event => event.kind === 'completed'))

  // 重新打开：定时从当前时刻恢复。
  const reopened = (await api('POST', `${tasksPath}/${task.id}/status`, { as: ws.member, body: { status: 'in_progress' } })).body.data as TaskView
  assert.equal(reopened.scheduleState, 'active')
  assert.ok(reopened.nextRunAt)

  // 改派给员工：删除执行规则。
  const reassigned = (await api('PATCH', `${tasksPath}/${task.id}`, {
    as: ws.member, body: { assignee: { type: 'employee', id: ws.other } },
  })).body.data as TaskView
  assert.equal(reassigned.schedule, null)
  assert.equal(reassigned.scheduleState, null)
  await drainRuntime()
})

test('S4 定时执行：到点以 Agent 身份执行、执行中跳过、停机错过不补跑、过截止停止、规则设置人失效暂停', async () => {
  await drainRuntime()
  const ws = await seedSpace('tick')
  const agentMemberId = await joinAgent(ws, 'tick')
  const tasksPath = `${base}/workspaces/${ws.id}/project-tasks`
  const task = (await api('POST', tasksPath, {
    as: ws.member, body: { title: '每日到货跟踪', assignee: { type: 'agent', id: agentMemberId } },
  })).body.data as TaskView
  const timezone = task.schedule!.timezone

  // 把规则设为“两分钟前”的时刻，并把下次时间点拨到该时刻，模拟到点。
  const fireSoon = async () => {
    const slot = new Date(Math.floor((Date.now() - 2 * 60_000) / 60_000) * 60_000)
    await api('PATCH', `${tasksPath}/${task.id}`, { as: ws.member, body: { schedule: { kind: 'daily', timeOfDay: wallClock(slot, timezone) } } })
    await database`update project_tasks set next_slot_utc = ${slot} where tenant_id = ${tenantId} and id = ${task.id}`
    await projects.processDueSchedules(new Date())
  }
  const kinds = async () => ((await api('GET', `${tasksPath}/${task.id}/events`, { as: ws.viewer })).body.data as Array<{ kind: string; metadata: Record<string, unknown> }>)

  await fireSoon()
  const scheduled = (await kinds()).filter(event => event.kind === 'scheduled_run')
  assert.equal(scheduled.length, 1)
  const runId = String(scheduled[0]!.metadata.runId)
  const manifest = await waitForManifest(runId)
  assert.match(manifest.input.message, /没有新进展时以“无变化”开头/)
  assert.equal(manifest.user_context.user_id, ws.member, '规则设置人只作为归因')
  const running = await taskById(ws, task.id)
  assert.equal(running.status, 'in_progress', '第一次执行开始时进入进行中')
  assert.ok(running.nextRunAt && new Date(running.nextRunAt).getTime() > Date.now())

  // 上一执行未结束：本次跳过，不排队。
  await fireSoon()
  assert.ok((await kinds()).some(event => event.kind === 'execution_skipped' && event.metadata.reason === 'busy'))
  runtime.releaseAll()
  await waitForRun(runId)

  // 停机错过的时间点合并为一条“错过”记录，不补跑。
  await database`update project_tasks set next_slot_utc = now() - interval '3 days' where tenant_id = ${tenantId} and id = ${task.id}`
  await projects.processDueSchedules(new Date())
  const missed = (await kinds()).filter(event => event.kind === 'execution_missed')
  assert.equal(missed.length, 1)
  assert.ok(Number(missed[0]!.metadata.count) >= 2)

  // 规则设置人降为只读：暂停，由其他成员恢复后接管。
  await database`update workspace_members set member_role = 'viewer' where tenant_id = ${tenantId} and workspace_id = ${ws.id} and user_id = ${ws.member}`
  const slot = new Date(Math.floor((Date.now() - 60_000) / 60_000) * 60_000)
  await database`
    update project_tasks set schedule = ${database.json({ kind: 'daily', timezone, timeOfDay: wallClock(slot, timezone) })}, next_slot_utc = ${slot}
     where tenant_id = ${tenantId} and id = ${task.id}
  `
  await projects.processDueSchedules(new Date())
  const paused = await taskById(ws, task.id)
  assert.equal(paused.scheduleState, 'paused')
  assert.equal(paused.scheduleReason, 'setter_ineligible')
  assert.equal((await api('POST', `${tasksPath}/${task.id}/schedule/resume`, { as: ws.viewer })).status, 403)
  const resumed = await api('POST', `${tasksPath}/${task.id}/schedule/resume`, { as: ws.owner })
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
  assert.equal((resumed.body.data as TaskView).scheduleState, 'active')

  // 过了截止日期：停止定时，任务保持进行中。
  await database`update project_tasks set due_date = current_date - 2, next_slot_utc = now() - interval '1 minute' where tenant_id = ${tenantId} and id = ${task.id}`
  await projects.processDueSchedules(new Date())
  const overdue = await taskById(ws, task.id)
  assert.equal(overdue.scheduleState, 'stopped')
  assert.equal(overdue.scheduleReason, 'due_passed')
  assert.equal(overdue.status, 'in_progress')
  await drainRuntime()
})

test('S4 连续失败：连续失败 3 次暂停定时执行，成功清零，恢复后继续', async () => {
  await drainRuntime()
  const ws = await seedSpace('failing')
  const agentMemberId = await joinAgent(ws, 'failing')
  const tasksPath = `${base}/workspaces/${ws.id}/project-tasks`
  const task = (await api('POST', tasksPath, {
    as: ws.member, body: { title: '每日对账', assignee: { type: 'agent', id: agentMemberId } },
  })).body.data as TaskView
  const runOnce = async (index: number, outcome: 'fail' | 'succeed', expectedFailures: number) => {
    const started = await api('POST', `${tasksPath}/${task.id}/start`, { as: ws.member, body: { idempotencyKey: `failing-${index}-${task.id}` } })
    assert.equal(started.status, 202, JSON.stringify(started.body))
    const runId = (started.body.data as TaskView).latestRunId!
    await waitForManifest(runId)
    if (outcome === 'fail') runtime.failAll()
    else runtime.releaseAll()
    await waitForRun(runId)
    await waitForCondition(async () => {
      const [row] = await database<{ failures: number }[]>`
        select consecutive_failures as failures from project_tasks where tenant_id = ${tenantId} and id = ${task.id}
      `
      return row?.failures === expectedFailures
    })
  }
  await runOnce(1, 'fail', 1)
  await runOnce(2, 'fail', 2)
  await runOnce(3, 'succeed', 0)
  assert.equal((await taskById(ws, task.id)).scheduleState, 'active', '成功清零')
  await runOnce(4, 'fail', 1)
  await runOnce(5, 'fail', 2)
  await runOnce(6, 'fail', 3)
  await waitForCondition(async () => (await taskById(ws, task.id)).scheduleState === 'paused')
  const paused = await taskById(ws, task.id)
  assert.equal(paused.scheduleReason, 'consecutive_failures')
  assert.equal(paused.status, 'in_progress', '失败不改任务状态')
  assert.equal(paused.latestRunStatus, 'failed')
  assert.ok(paused.allowedActions.includes('resume'))
  assert.ok(paused.allowedActions.includes('start'), '暂停不影响手动执行')
  const events = (await api('GET', `${tasksPath}/${task.id}/events`, { as: ws.viewer })).body.data as Array<{ kind: string }>
  assert.ok(events.some(event => event.kind === 'schedule_paused'))
  const resumed = (await api('POST', `${tasksPath}/${task.id}/schedule/resume`, { as: ws.member })).body.data as TaskView
  assert.equal(resumed.scheduleState, 'active')
  assert.ok(resumed.nextRunAt)
  await drainRuntime()
})

test('任务细节：越界日期 422，停用的 Agent 不能承接，重复完成不重复登记档案成果（P2-5、P2-11、P2-13）', async () => {
  await drainRuntime()
  const ws = await seedSpace('detail')
  const invalid = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '越界日期', assignee: { type: 'employee', id: ws.member }, dueDate: '2026-02-30' },
  })
  assert.equal(invalid.status, 422, JSON.stringify(invalid.body))

  const done = await completeEmployeeTask(ws, '整理到货记录', '已核对')
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${done.id}/status`, {
    as: ws.member, body: { status: 'todo' },
  })).status, 200)
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${done.id}/status`, {
    as: ws.member, body: { status: 'done', completionNote: '已核对' },
  })).status, 200)
  const [inputs] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_archive_inputs where tenant_id = ${tenantId} and project_task_id = ${done.id}
  `
  assert.equal(inputs?.count, 1)

  const agentMemberId = await joinAgent(ws, 'detail')
  await database`update workspace_agent_members set status = 'disabled' where tenant_id = ${tenantId} and id = ${agentMemberId}`
  const disabled = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '核对到货', assignee: { type: 'agent', id: agentMemberId } },
  })
  assert.equal(disabled.status, 409, JSON.stringify(disabled.body))
  await drainRuntime()
})

test('重启恢复：认领后未挂 Run 且过期的整理批次被释放（P2-6）', async () => {
  const ws = await seedSpace('archive-recovery')
  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '恢复测试任务', assignee: { type: 'employee', id: ws.member } },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const task = created.body.data as TaskView
  const updateId = `warchup-${randomUUID()}`
  await database`
    insert into workspace_archivist_state (tenant_id, workspace_id, update_id, run_id, base_version_no, started_at, updated_at)
    values (${tenantId}, ${ws.id}, ${updateId}, null, 0, now() - interval '20 minutes', now())
  `
  await database`
    insert into workspace_archive_inputs (id, tenant_id, workspace_id, project_task_id, title, content, update_id)
    values (${`warchin-${randomUUID()}`}, ${tenantId}, ${ws.id}, ${task.id}, '恢复测试任务', '恢复测试成果', ${updateId})
  `

  const service = new PostgresProjectArchiveService(database)
  const result = await service.recoverInterruptedUpdates()
  assert.ok(result.abandoned >= 1)
  const [state] = await database<{ updateId: string | null }[]>`
    select update_id as "updateId" from workspace_archivist_state where tenant_id = ${tenantId} and workspace_id = ${ws.id}
  `
  assert.equal(state?.updateId, null)
  const [input] = await database<{ updateId: string | null }[]>`
    select update_id as "updateId" from workspace_archive_inputs where tenant_id = ${tenantId} and project_task_id = ${task.id}
  `
  assert.equal(input?.updateId, null)
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
// 项目档案（S2）
// ---------------------------------------------------------------------------

interface ArchiveVersionView {
  versionNo: number
  items: string[]
  sourceKind: string
  sourceTasks: Array<{ id: string; title: string }>
  rollbackFromVersionNo: number | null
  createdBy: { userId: string } | null
}

test('项目档案：非只读成员按版本号编辑与回退，只读成员只读，归档后只读，不写入动态', async () => {
  const ws = await seedSpace('archive')
  const initial = await api('GET', `${base}/workspaces/${ws.id}/project-archive`, { as: ws.viewer })
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.body.data, { current: null, archivistRunning: false })

  const put = (as: string, baseVersionNo: unknown, items: unknown) =>
    api('PUT', `${base}/workspaces/${ws.id}/project-archive`, { as, body: { baseVersionNo, items } })
  assert.equal((await put(ws.viewer, 0, ['只读成员不能写'])).status, 403)
  assert.equal((await put(ws.member, 0, ['同一条', '同一条'])).status, 422)
  assert.equal((await put(ws.member, 0, ['长'.repeat(501)])).status, 422)
  assert.equal((await put(ws.member, 'x', ['版本号无效'])).status, 422)

  const first = await put(ws.member, 0, ['  缺货集中在高周转类目  ', '术语：安全库存'])
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const v1 = first.body.data as ArchiveVersionView
  assert.deepEqual(pick(v1, ['versionNo', 'items', 'sourceKind', 'rollbackFromVersionNo']), {
    versionNo: 1, items: ['缺货集中在高周转类目', '术语：安全库存'], sourceKind: 'manual', rollbackFromVersionNo: null,
  })
  assert.equal(v1.createdBy?.userId, ws.member)
  assert.equal((await put(ws.admin, 0, ['基于旧版本'])).status, 409)

  const v2 = (await put(ws.admin, 1, ['缺货集中在高周转类目', '决策：按类目设置安全库存'])).body.data as ArchiveVersionView
  assert.equal(v2.versionNo, 2)

  const rollback = (as: string, versionNo: unknown, baseVersionNo: unknown) =>
    api('POST', `${base}/workspaces/${ws.id}/project-archive/rollback`, { as, body: { versionNo, baseVersionNo } })
  assert.equal((await rollback(ws.viewer, 1, 2)).status, 403)
  assert.equal((await rollback(ws.other, 2, 2)).status, 422)
  assert.equal((await rollback(ws.other, 9, 2)).status, 422)
  assert.equal((await rollback(ws.other, 1, 1)).status, 409)
  const v3 = (await rollback(ws.other, 1, 2)).body.data as ArchiveVersionView
  assert.deepEqual(pick(v3, ['versionNo', 'items', 'sourceKind', 'rollbackFromVersionNo']), {
    versionNo: 3, items: ['缺货集中在高周转类目', '术语：安全库存'], sourceKind: 'rollback', rollbackFromVersionNo: 1,
  })

  const versions = await api('GET', `${base}/workspaces/${ws.id}/project-archive/versions`, { as: ws.viewer })
  assert.deepEqual((versions.body.data as ArchiveVersionView[]).map(version => [version.versionNo, version.sourceKind]), [
    [3, 'rollback'], [2, 'manual'], [1, 'manual'],
  ])
  assert.deepEqual(await activityKinds(ws.id), [], '档案变更不写入最近动态')

  await archive(ws.id)
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/project-archive`, { as: ws.viewer })).status, 200)
  assert.equal((await put(ws.owner, 3, ['归档后不能改'])).status, 403)
  assert.equal((await rollback(ws.owner, 1, 3)).status, 403)
  assert.equal((await api('GET', `${base}/workspaces/${ws.id}/project-archive`, { as: ws.outsider })).status, 403)
})

test('项目档案员：员工任务完成后整理，整理期间完成的任务并入下一次，人工修改优先', async () => {
  await drainRuntime()
  const ws = await seedSpace('archivist')
  runtime.archiveReply = null
  const first = await completeEmployeeTask(ws, '整理供应商名单', '已按华东、华南分组')

  const [run1] = await waitForArchiveRuns(ws.id, 1)
  const manifest1 = await waitForManifest(run1!)
  assert.equal(manifest1.purpose, 'project-archive')
  assert.equal(manifest1.archive_target?.workspace_id, ws.id)
  assert.equal(manifest1.workspace_id, '')
  assert.equal(manifest1.session_id, null)
  assert.deepEqual([manifest1.tools, manifest1.data_scopes, manifest1.input.file_mounts], [[], [], []])
  assert.match(manifest1.input.message, /整理供应商名单/)
  assert.match(manifest1.input.message, /已按华东、华南分组/)
  assert.equal(((await api('GET', `${base}/workspaces/${ws.id}/project-archive`, { as: ws.viewer })).body.data as { archivistRunning: boolean }).archivistRunning, true)

  // 整理期间：再完成一个任务不会另起整理；成员手动修改档案。
  await completeEmployeeTask(ws, '确认到货承诺', '供应商承诺 5 天内到货')
  assert.equal((await archiveRuns(ws.id)).length, 1, '同一空间同时只有一次整理')
  const manual = await api('PUT', `${base}/workspaces/${ws.id}/project-archive`, { as: ws.member, body: { baseVersionNo: 0, items: ['人工条目'] } })
  assert.equal(manual.status, 200)

  // 第一次整理完成时档案已被修改：输出被丢弃，基于最新版本重新整理（两项成果一起）。
  runtime.archiveReply = () => JSON.stringify({ add: [{ text: '不应写入的旧基线输出', why_new: '旧基线' }], update: [] })
  runtime.releaseAll()
  const [, run2] = await waitForArchiveRuns(ws.id, 2)
  const manifest2 = await waitForManifest(run2!)
  assert.match(manifest2.input.message, /\["人工条目"\]/)
  assert.match(manifest2.input.message, /整理供应商名单/)
  assert.match(manifest2.input.message, /确认到货承诺/)
  assert.equal((await archiveVersions(ws)).length, 1)

  // 档案员只给新增：与现有条目重复的新增被略去，人工条目原样保留在最前。
  runtime.archiveReply = () => '```json\n{"add":[{"text":"供应商名单已按区域分组","why_new":"分组结论"},{"text":"人工条目。","why_new":"重复"},{"text":"到货承诺 5 天","why_new":"承诺时长"}],"update":[]}\n```'
  runtime.releaseAll()
  const versions = await waitForArchiveVersions(ws, 2)
  assert.deepEqual(pick(versions[0], ['versionNo', 'sourceKind', 'items', 'createdBy']), {
    versionNo: 2, sourceKind: 'archivist', items: ['人工条目', '供应商名单已按区域分组', '到货承诺 5 天'], createdBy: null,
  })
  assert.deepEqual(versions[0]!.sourceTasks.map(task => task.title), ['整理供应商名单', '确认到货承诺'])
  assert.equal(versions[0]!.sourceTasks[0]!.id, first.id)
  await waitForArchivistIdle(ws)
  assert.equal((await archiveRuns(ws.id)).length, 2, '没有待整理成果时不再触发')
  assert.deepEqual((await activityKinds(ws.id)).sort(), ['project_task_completed', 'project_task_completed', 'project_task_created', 'project_task_created'])
})

test('项目档案员：无效输出不写入，成果随下一次触发重试', async () => {
  await drainRuntime()
  const ws = await seedSpace('archivist-invalid')
  runtime.archiveReply = () => '好的，我整理了档案。'
  await completeEmployeeTask(ws, '核对促销备货', '促销备货不是主因')
  const [run1] = await waitForArchiveRuns(ws.id, 1)
  await waitForManifest(run1!)
  runtime.releaseAll()
  await waitForRun(run1!)
  await waitForArchivistIdle(ws)
  assert.equal((await archiveVersions(ws)).length, 0)

  runtime.archiveReply = () => JSON.stringify({ add: [{ text: '促销备货不是缺货主因', why_new: '新结论' }], update: [] })
  await completeEmployeeTask(ws, '复核库存口径', '口径一致')
  const [, run2] = await waitForArchiveRuns(ws.id, 2)
  const manifest2 = await waitForManifest(run2!)
  assert.match(manifest2.input.message, /核对促销备货/, '失败批次的成果在下一次整理中重试')
  assert.match(manifest2.input.message, /复核库存口径/)
  runtime.releaseAll()
  const versions = await waitForArchiveVersions(ws, 1)
  assert.deepEqual(versions[0]!.items, ['促销备货不是缺货主因'])
})

test('Agent 任务：执行携带当前档案版本，成功后成果交给档案员整理', async () => {
  await drainRuntime()
  const ws = await seedSpace('archive-agent')
  const agentMemberId = await joinAgent(ws, 'archive-agent')
  runtime.archiveReply = () => JSON.stringify({ add: [{ text: '分析结论已记录', why_new: '新进展' }], update: [] })
  await api('PUT', `${base}/workspaces/${ws.id}/project-archive`, { as: ws.owner, body: { baseVersionNo: 0, items: ['术语：缺货率按周统计'] } })

  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '分析缺货原因', assignee: { type: 'agent', id: agentMemberId } },
  })
  const task = created.body.data as TaskView
  const started = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
    as: ws.member, body: { idempotencyKey: `archive-start-${task.id}` },
  })
  const running = started.body.data as TaskView
  const manifest = await waitForManifest(running.latestRunId!)
  assert.equal(manifest.project_context?.brief, undefined, '没有简报时只携带档案')
  assert.deepEqual(pick(manifest.project_context?.archive, ['version_no', 'items']), { version_no: 1, items: ['术语：缺货率按周统计'] })

  runtime.releaseAll()
  await waitForRun(running.latestRunId!)
  const [archiveRun] = await waitForArchiveRuns(ws.id, 1)
  const archiveManifest = await waitForManifest(archiveRun!)
  assert.match(archiveManifest.input.message, /分析缺货原因/)
  assert.match(archiveManifest.input.message, /项目空间测试回答/)
  runtime.releaseAll()
  const versions = await waitForArchiveVersions(ws, 2)
  assert.equal(versions[0]!.sourceKind, 'archivist')
  assert.deepEqual(versions[0]!.sourceTasks.map(item => item.id), [task.id])
})

test('团队成果：标注所属项目任务、承接 Agent 版本与发起人，任务移除后不再标注', async () => {
  await drainRuntime()
  const ws = await seedSpace('artifact-origin')
  const agentMemberId = await joinAgent(ws, 'artifact-origin')
  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title: '输出缺货分析报告', assignee: { type: 'agent', id: agentMemberId } },
  })
  const task = created.body.data as TaskView
  const started = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/start`, {
    as: ws.member, body: { idempotencyKey: `origin-start-${task.id}` },
  })
  const running = started.body.data as TaskView
  await waitForManifest(running.latestRunId!)
  await seedArtifact({ workspaceId: ws.id, sessionId: running.sessionId!, runId: running.latestRunId!, createdBy: ws.member, label: 'task' })

  // 普通讨论中 @Agent 产生的成果：没有所属任务，但仍标注 Agent 与发起人。
  const discussion = await api('POST', `${base}/sessions`, { as: ws.other, body: { title: '临时讨论', workspaceId: ws.id } })
  const discussionId = (discussion.body.data as { id: string }).id
  const asked = await api('POST', `${base}/sessions/${discussionId}/runs`, {
    as: ws.other, body: { prompt: '@助手 汇总一下', idempotencyKey: `origin-ask-${discussionId}`, workspaceAgentMemberId: agentMemberId },
  })
  const askedRunId = (asked.body.data as { runId?: string; id?: string }).runId ?? (asked.body.data as { id: string }).id
  await waitForManifest(askedRunId)
  await seedArtifact({ workspaceId: ws.id, sessionId: discussionId, runId: askedRunId, createdBy: ws.other, label: 'discussion' })
  runtime.releaseAll()

  const artifacts = await content.listArtifacts(ws.viewer)
  const byName = (name: string) => artifacts.find(artifact => artifact.name === name)
  assert.deepEqual(byName(`${ws.id}-task.txt`)?.origin, {
    projectTask: { id: task.id, title: '输出缺货分析报告' },
    agent: { name: '项目助手', version: '1.0.0' },
    initiatedBy: 'artifact-origin-member',
  })
  assert.deepEqual(byName(`${ws.id}-discussion.txt`)?.origin, {
    projectTask: null,
    agent: { name: '项目助手', version: '1.0.0' },
    initiatedBy: 'artifact-origin-other',
  })

  // 任务被移除后成果保留，但不再标注所属任务。
  await waitForRun(running.latestRunId!)
  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/project-tasks/${task.id}`, { as: ws.member })).status, 200)
  assert.equal((await content.listArtifacts(ws.viewer)).find(artifact => artifact.name === `${ws.id}-task.txt`)?.origin?.projectTask, null)
})

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 规则时区下的墙钟 HH:mm。 */
function wallClock(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant)
}

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('等待条件超时')
}

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
      max_output_bytes, max_tool_calls, timeout_seconds, skill_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${agentId}, '1.0.0', '项目助手', '测试。', '', ${database.json(['测试'] as string[])},
      '你是项目空间集成测试 Agent，负责按任务说明给出简洁的分析结论。', 65536, 20, 300, ${database.json([] as string[])},
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
  const task = (list.body.data as { items: TaskView[] }).items.find(item => item.id === taskId)
  assert.ok(task, `任务不存在：${taskId}`)
  return task
}

/**
 * 受控 Runtime 不会自行结束执行：前面用例触发的档案整理会一直占着全局档案员车道（并发 1）。
 * 档案员用例开始前放行全部执行，直到没有进行中的 Run。
 */
async function drainRuntime(timeoutMs = 10_000) {
  const archiveReply = runtime.archiveReply
  runtime.archiveReply = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    runtime.releaseAll()
    const [row] = await database<{ count: number }[]>`
      select count(*)::integer as count from runs
       where tenant_id = ${tenantId} and status in ('queued', 'running', 'waiting', 'cancel_requested')
    `
    if (row!.count === 0) {
      runtime.archiveReply = archiveReply
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('等待受控 Runtime 清空超时')
}

async function seedArtifact(input: { workspaceId: string; sessionId: string; runId: string; createdBy: string; label: string }) {
  const fileId = `file-${input.workspaceId}-${input.label}`
  const artifactId = `artifact-${input.workspaceId}-${input.label}`
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
      size_bytes, sha256, scan_status, uploaded_by
    ) values (
      ${fileId}, ${tenantId}, ${input.workspaceId}, ${input.sessionId}, ${`storage/${fileId}`}, ${`${input.workspaceId}-${input.label}.txt`},
      'text/plain', 16, ${'a'.repeat(64)}, 'clean', ${input.createdBy}
    )
  `
  await database`
    insert into artifacts (id, tenant_id, workspace_id, session_id, name, artifact_type, created_by)
    values (${artifactId}, ${tenantId}, ${input.workspaceId}, ${input.sessionId}, ${`${input.workspaceId}-${input.label}.txt`}, 'text', ${input.createdBy})
  `
  await database`
    insert into artifact_versions (id, tenant_id, artifact_id, version_no, file_object_id, source_run_id)
    values (${`${artifactId}-v1`}, ${tenantId}, ${artifactId}, 1, ${fileId}, ${input.runId})
  `
}

async function completeEmployeeTask(ws: { id: string; member: string; admin: string }, title: string, note: string): Promise<TaskView> {
  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.member, body: { title, assignee: { type: 'employee', id: ws.admin } },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const task = created.body.data as TaskView
  const done = await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${task.id}/status`, {
    as: ws.admin, body: { status: 'done', completionNote: note },
  })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  return task
}

async function archiveRuns(workspaceId: string): Promise<string[]> {
  const rows = await database<{ runId: string }[]>`
    select r.id as "runId" from runs r
      join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
     where r.tenant_id = ${tenantId} and t.source_ref = ${`project-archive:${workspaceId}`}
     order by r.created_at, r.id
  `
  return rows.map(row => row.runId)
}

async function waitForArchiveRuns(workspaceId: string, count: number, timeoutMs = 10_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const runs = await archiveRuns(workspaceId)
    if (runs.length >= count) return runs
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`等待第 ${count} 次档案整理超时：${workspaceId}`)
}

async function archiveVersions(ws: { id: string; viewer: string }): Promise<ArchiveVersionView[]> {
  const response = await api('GET', `${base}/workspaces/${ws.id}/project-archive/versions`, { as: ws.viewer })
  return response.body.data as ArchiveVersionView[]
}

async function waitForArchiveVersions(ws: { id: string; viewer: string }, count: number, timeoutMs = 10_000): Promise<ArchiveVersionView[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const versions = await archiveVersions(ws)
    if (versions.length >= count) return versions
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`等待档案第 ${count} 版超时：${ws.id}`)
}

async function waitForArchivistIdle(ws: { id: string; viewer: string }, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await api('GET', `${base}/workspaces/${ws.id}/project-archive`, { as: ws.viewer })
    if (!(response.body.data as { archivistRunning: boolean }).archivistRunning) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`等待档案员空闲超时：${ws.id}`)
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
  /** 用例可替换为抛错，模拟受理前 Runtime 不可用。 */
  assertAvailable?: (manifest?: RuntimeManifest) => Promise<void>
  private readonly executions = new Map<string, {
    manifest: RuntimeManifest
    listeners: Set<(event: RuntimeEvent) => void>
    events: RuntimeEvent[]
    finish?: () => void
    cancel?: () => void
    fail?: () => void
  }>()

  /** 档案员运行的回答（JSON 条目列表）；未设置时回答普通文本，平台按无效输出处理。 */
  archiveReply: ((manifest: RuntimeManifest) => string) | null = null

  manifest(runId: string): RuntimeManifest | undefined {
    return this.executions.get(runId)?.manifest
  }

  releaseAll() {
    for (const state of this.executions.values()) state.finish?.()
  }

  /** 让所有进行中的执行失败（S4 连续失败暂停）。 */
  failAll() {
    for (const state of this.executions.values()) state.fail?.()
  }

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    const now = new Date().toISOString()
    const state: { manifest: RuntimeManifest; listeners: Set<(event: RuntimeEvent) => void>; events: RuntimeEvent[]; finish?: () => void; cancel?: () => void; fail?: () => void } = {
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
      state.cancel = () => {
        state.finish = undefined
        state.cancel = undefined
        state.fail = undefined
        emit('run.cancel_requested', '已请求停止')
        emit('run.cancelled', '已停止')
        resolve({
          runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'cancelled', acceptedAt: now,
          startedAt: now, endedAt: new Date().toISOString(), manifestSha256: createHash('sha256').update(manifest.run_id).digest('hex'),
          attemptDirectory: '/tmp/test', errorCode: null, errorMessage: null,
        })
      }
      state.fail = () => {
        state.finish = undefined
        state.cancel = undefined
        state.fail = undefined
        emit('run.failed', '执行失败')
        resolve({
          runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'failed', acceptedAt: now,
          startedAt: now, endedAt: new Date().toISOString(), manifestSha256: createHash('sha256').update(manifest.run_id).digest('hex'),
          attemptDirectory: '/tmp/test', errorCode: 'RUNTIME_EXECUTION_FAILED', errorMessage: '测试失败',
        })
      }
      state.finish = () => {
        state.finish = undefined
        state.cancel = undefined
        state.fail = undefined
        emit('assistant.completed', manifest.purpose === 'project-archive' && this.archiveReply
          ? this.archiveReply(manifest)
          : '项目空间测试回答')
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

  async cancel(runId: string): Promise<{ accepted: boolean }> {
    const state = this.executions.get(runId)
    if (!state?.cancel) return { accepted: false }
    state.cancel()
    return { accepted: true }
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
  const projectArchive = new PostgresProjectArchiveService(database)
  projects = new PostgresProjectService(database, agentMembers, projectArchive)
  content = new PostgresContentService(database, new LocalObjectStorage(storageRoot), authorization)
  const conversations = new PostgresConversationRepository(database)
  const runs = new PostgresRunRepository(database)
  runtime = new ControlledRuntime()
  orchestration = new RunOrchestrationService(
    runs, conversations, new ModelGovernanceService(new PostgresModelGovernanceRepository(database)), runtime,
    content, undefined, agents, undefined, authorization, { agentMembers, projectTasks: projects, projectArchive, tasks: new PostgresTaskRepository(database) },
  )
  projects.attachRunStarter(orchestration)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerWorkspaceAgentMemberRoutes(router, agentMembers, authorization)
  registerConversationRoutes(router, conversations, orchestration, runs, agents, authorization, undefined, undefined, agentMembers)
  registerProjectRoutes(router, projects, authorization, projectArchive)
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
  // 先放行并等待所有 Run 结束（含触发的档案整理），再关闭调度器等待事件写完，最后才关库；
  // 否则排队中的运行事件写入会撞上已关闭的连接（CONNECTION_ENDED）。
  if (runtime) await drainRuntime().catch((error: unknown) => console.error(error))
  if (orchestration) await orchestration.close()
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
  await rm(storageRoot, { recursive: true, force: true })
})
