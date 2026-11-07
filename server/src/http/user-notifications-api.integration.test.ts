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
import { PostgresTaskRepository } from '../modules/task/postgres-task-repository.ts'
import type { AgentRuntimePort } from '../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresConversationTargetService } from '../modules/workbench/application/postgres-conversation-target-service.ts'
import { PostgresProjectArchiveService } from '../modules/workbench/application/postgres-project-archive-service.ts'
import { PostgresProjectService, SCHEDULE_FAILURE_LIMIT } from '../modules/workbench/application/postgres-project-service.ts'
import { PostgresUserNotificationService } from '../modules/workbench/application/postgres-user-notification-service.ts'
import { PostgresWorkspaceActivityService } from '../modules/workbench/application/postgres-workspace-activity-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { PostgresWorkspaceMemberService } from '../modules/workbench/application/postgres-workspace-member-service.ts'
import { PostgresWorkspaceService } from '../modules/workbench/application/postgres-workspace-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { LocalObjectStorage } from '../infrastructure/storage/local-object-storage.ts'
import { Router } from './router.ts'
import { registerConversationRoutes } from './workbench/conversation-routes.ts'
import { registerConversationTargetRoutes } from './workbench/conversation-target-routes.ts'
import { registerProjectRoutes } from './workbench/project-routes.ts'
import { registerUserNotificationRoutes } from './workbench/user-notification-routes.ts'
import { registerWorkspaceActivityRoutes } from './workbench/workspace-activity-routes.ts'
import { registerWorkspaceMemberRoutes } from './workbench/workspace-member-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './workbench/workspace-agent-member-routes.ts'

// NC-01、NC-02（e2e/catalog/notifications.md，站内通知方案 NC-S1）：与本人相关的四类事件各产生一条通知，
// 读取时按当前权限解析名称；未读、已读、静音与打开群组时 @ 通知一并已读。

const tenantId = 'tenant-dsh-work'
const base = '/api/workbench/v1'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let storageRoot: string
let server: Server
let baseUrl = ''
let orchestration: RunOrchestrationService
let projects: PostgresProjectService

interface NotificationView {
  id: string
  kind: string
  read: boolean
  visible: boolean
  actor: { id: string; name: string } | null
  workspace: { id: string; name: string } | null
  objectName: string | null
  detail: Record<string, string> | null
  target: { type: string; id: string; sessionId: string | null } | null
}

async function notifications(userId: string, query = ''): Promise<NotificationView[]> {
  const result = await api('GET', `${base}/me/notifications${query}`, { as: userId })
  assert.equal(result.status, 200)
  return (result.body.data as { items: NotificationView[] }).items
}

async function unread(userId: string): Promise<number> {
  const result = await api('GET', `${base}/me/notifications/unread-count`, { as: userId })
  assert.equal(result.status, 200)
  return (result.body.data as { unread: number }).unread
}

test('NC-01 被加入项目、@ 我、任务指派与完成各产生一条通知，读取时解析名称', async () => {
  const ws = await seedSpace('events')

  // 1. 被加入项目：被加入的人收到，操作人本人不收到。
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/members`, { as: ws.owner, body: { userId: ws.second, role: 'member' } })).status, 201)
  const [joined] = await notifications(ws.second)
  assert.equal(joined?.kind, 'workspace_member_added')
  assert.deepEqual(joined?.actor, { id: ws.owner, name: 'events-负责人' })
  assert.deepEqual(joined?.workspace, { id: ws.id, name: '通知测试项目' })
  assert.deepEqual(joined?.target, { type: 'workspace', id: ws.id, sessionId: null })
  assert.equal((await notifications(ws.owner)).length, 0)

  // 2. 讨论中 @ 成员甲与非成员：只有成员甲收到，幂等重放不重复。
  const session = await api('POST', `${base}/sessions`, { as: ws.owner, body: { title: '排期讨论', workspaceId: ws.id } })
  assert.equal(session.status, 201)
  const sessionId = (session.body.data as { id: string }).id
  const message = { content: '@甲 请看排期', idempotencyKey: `nc-mention-${ws.id}`, mentionedUserIds: [ws.first, ws.outsider, ws.owner] }
  const posted = await api('POST', `${base}/sessions/${sessionId}/messages`, { as: ws.owner, body: message })
  assert.equal(posted.status, 201)
  const messageId = (posted.body.data as { messageId: string }).messageId
  assert.equal((await api('POST', `${base}/sessions/${sessionId}/messages`, { as: ws.owner, body: message })).status, 201)
  const mentions = (await notifications(ws.first)).filter(item => item.kind === 'mention')
  assert.equal(mentions.length, 1)
  assert.deepEqual(mentions[0]?.target, { type: 'message', id: messageId, sessionId })
  assert.equal(await rowCount(ws.outsider), 0)

  // 3. 任务指派与改派：新负责人各收到一条；自己指派给自己不产生通知。
  const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.owner, body: { title: '整理竞品报价', assignee: { type: 'employee', id: ws.first } },
  })
  assert.equal(created.status, 201)
  const taskId = (created.body.data as { id: string }).id
  const assigned = (await notifications(ws.first)).find(item => item.kind === 'task_assigned')
  assert.equal(assigned?.objectName, '整理竞品报价')
  assert.deepEqual(assigned?.target, { type: 'project_task', id: taskId, sessionId: null })
  assert.equal((await api('PATCH', `${base}/workspaces/${ws.id}/project-tasks/${taskId}`, {
    as: ws.owner, body: { assignee: { type: 'employee', id: ws.second } },
  })).status, 200)
  assert.equal((await notifications(ws.second)).filter(item => item.kind === 'task_assigned').length, 1)
  assert.equal((await notifications(ws.first)).filter(item => item.kind === 'task_assigned').length, 1, '改走的人不新增')
  const selfTask = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.owner, body: { title: '自己的任务', assignee: { type: 'employee', id: ws.owner } },
  })
  assert.equal(selfTask.status, 201)
  assert.equal((await notifications(ws.owner)).length, 0)

  // 名称读取时解析：改名后读到新名称。
  assert.equal((await api('PATCH', `${base}/workspaces/${ws.id}/project-tasks/${taskId}`, {
    as: ws.owner, body: { title: '整理竞品报价（第二版）' },
  })).status, 200)
  assert.equal((await notifications(ws.second)).find(item => item.kind === 'task_assigned')?.objectName, '整理竞品报价（第二版）')

  // 4. 负责人以外的人完成任务：创建人收到；创建人自己完成不产生。
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${taskId}/status`, {
    as: ws.second, body: { status: 'done' },
  })).status, 200)
  const completed = (await notifications(ws.owner)).filter(item => item.kind === 'task_completed')
  assert.equal(completed.length, 1)
  assert.deepEqual(completed[0]?.actor, { id: ws.second, name: 'events-成员乙' })
  const selfTaskId = (selfTask.body.data as { id: string }).id
  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks/${selfTaskId}/status`, {
    as: ws.owner, body: { status: 'done' },
  })).status, 200)
  assert.equal((await notifications(ws.owner)).filter(item => item.kind === 'task_completed').length, 1)

  // 别人的通知不可见、不可标记。
  assert.equal((await api('POST', `${base}/me/notifications/${completed[0]!.id}/read`, { as: ws.first })).status, 404)
})

test('NC-01 失权后旧通知不再返回名称：任务被删除、被移出项目', async () => {
  const ws = await seedSpace('revoke')
  for (const title of ['敏感任务', '会被删除的任务']) {
    assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
      as: ws.owner, body: { title, assignee: { type: 'employee', id: ws.first } },
    })).status, 201)
  }
  const tasks = await notifications(ws.first)
  assert.deepEqual(tasks.map(item => item.objectName), ['会被删除的任务', '敏感任务'])
  assert.equal(await unread(ws.first), 2)

  const deletedTaskId = tasks[0]!.target!.id
  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/project-tasks/${deletedTaskId}`, { as: ws.owner })).status, 200)
  const afterDelete = await notifications(ws.first)
  assert.deepEqual(pick(afterDelete[0], ['visible', 'workspace', 'objectName', 'actor', 'target']),
    { visible: false, workspace: null, objectName: null, actor: null, target: null })
  assert.equal(afterDelete[1]?.objectName, '敏感任务')
  assert.equal(await unread(ws.first), 1, '不可见的通知不计未读')
  assert.deepEqual((await notifications(ws.first, '?status=unread')).map(item => item.objectName), ['敏感任务'], '未读筛选与未读数同一口径')

  assert.equal((await api('DELETE', `${base}/workspaces/${ws.id}/members/${ws.first}`, { as: ws.owner })).status, 200)
  const afterRemoval = await notifications(ws.first)
  assert.equal(afterRemoval.length, 2, '通知仍在列表中')
  assert.ok(afterRemoval.every(item => !item.visible && item.workspace === null && item.objectName === null && item.target === null))
  assert.equal(await unread(ws.first), 0)
})

test('NC-02 未读筛选、翻页、单条与全部已读', async () => {
  const ws = await seedSpace('read')
  for (const title of ['一', '二', '三']) {
    assert.equal((await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
      as: ws.owner, body: { title: `任务${title}`, assignee: { type: 'employee', id: ws.first } },
    })).status, 201)
  }
  assert.equal(await unread(ws.first), 3)
  const first = await api('GET', `${base}/me/notifications?limit=2`, { as: ws.first })
  const page = first.body.data as { items: NotificationView[]; nextCursor: string | null }
  assert.deepEqual(page.items.map(item => item.objectName), ['任务三', '任务二'])
  assert.ok(page.nextCursor)
  const second = await api('GET', `${base}/me/notifications?limit=2&cursor=${page.nextCursor}`, { as: ws.first })
  assert.deepEqual((second.body.data as { items: NotificationView[]; nextCursor: string | null }).items.map(item => item.objectName), ['任务一'])
  assert.equal((second.body.data as { nextCursor: string | null }).nextCursor, null)

  assert.equal((await api('POST', `${base}/me/notifications/${page.items[0]!.id}/read`, { as: ws.first })).status, 200)
  assert.equal(await unread(ws.first), 2)
  assert.deepEqual((await notifications(ws.first, '?status=unread')).map(item => item.objectName), ['任务二', '任务一'])

  const all = await api('POST', `${base}/me/notifications/read-all`, { as: ws.first })
  assert.deepEqual(all.body.data, { read: 2 })
  assert.equal(await unread(ws.first), 0)
  assert.equal((await notifications(ws.first, '?status=unread')).length, 0)

  for (const query of ['?status=bad', '?limit=0', '?limit=51', '?cursor=bad']) {
    assert.equal((await api('GET', `${base}/me/notifications${query}`, { as: ws.first })).status, 422, query)
  }
})

test('NC-02 静音项目不计未读但 @ 我仍计；打开群组后该群的 @ 通知已读', async () => {
  const ws = await seedSpace('mute')
  await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
    as: ws.owner, body: { title: '静音任务', assignee: { type: 'employee', id: ws.first } },
  })
  const session = await api('POST', `${base}/sessions`, { as: ws.owner, body: { title: '静音讨论', workspaceId: ws.id } })
  const sessionId = (session.body.data as { id: string }).id
  assert.equal((await api('POST', `${base}/sessions/${sessionId}/messages`, {
    as: ws.owner, body: { content: '@甲 看下', idempotencyKey: `nc-mute-${ws.id}`, mentionedUserIds: [ws.first] },
  })).status, 201)
  assert.equal(await unread(ws.first), 2)

  assert.equal((await api('POST', `${base}/workspaces/${ws.id}/notifications/mute`, { as: ws.first })).status, 200)
  assert.equal(await unread(ws.first), 1, '静音后只剩 @ 我')
  assert.equal((await notifications(ws.first)).length, 2, '静音不隐藏通知')
  assert.deepEqual((await notifications(ws.first, '?status=unread')).map(item => item.kind), ['mention'], '未读页签与未读数同一口径')

  assert.equal((await api('POST', `${base}/me/conversation-targets/group/${ws.id}/read`, { as: ws.first, body: {} })).status, 200)
  const mention = (await notifications(ws.first)).find(item => item.kind === 'mention')
  assert.equal(mention?.read, true)
  assert.equal(await unread(ws.first), 0)
})

test('NC-02 在通知中心读 @ 通知时，群组 @ 提醒一并已读', async () => {
  const ws = await seedSpace('mention-sync')
  const session = await api('POST', `${base}/sessions`, { as: ws.owner, body: { title: '同步讨论', workspaceId: ws.id } })
  const sessionId = (session.body.data as { id: string }).id
  for (const key of ['one', 'two']) {
    assert.equal((await api('POST', `${base}/sessions/${sessionId}/messages`, {
      as: ws.owner, body: { content: '@甲 看下', idempotencyKey: `nc-sync-${key}-${ws.id}`, mentionedUserIds: [ws.first] },
    })).status, 201)
  }
  const mentionsUnread = async () => {
    const [row] = await database<Array<{ count: number }>>`
      select count(*)::integer as count from message_mentions
       where tenant_id = ${tenantId} and mentioned_user_id = ${ws.first} and read_at is null
    `
    return Number(row?.count ?? 0)
  }
  assert.equal(await mentionsUnread(), 2)

  const [latest] = await notifications(ws.first)
  assert.equal((await api('POST', `${base}/me/notifications/${latest!.id}/read`, { as: ws.first })).status, 200)
  assert.equal(await mentionsUnread(), 1, '单条已读只同步这一条 @')

  assert.equal((await api('POST', `${base}/me/notifications/read-all`, { as: ws.first })).status, 200)
  assert.equal(await mentionsUnread(), 0, '全部已读同步全部 @')
})

test('NC-04 项目 Agent 任务的定时执行被暂停或停止时通知规则设置人', async () => {
  const ws = await seedSpace('schedule')
  const agentMemberId = await joinAgent(ws, 'schedule')
  const createTask = async (title: string) => {
    const created = await api('POST', `${base}/workspaces/${ws.id}/project-tasks`, {
      as: ws.owner, body: { title, assignee: { type: 'agent', id: agentMemberId }, schedule: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' } },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    return created.body.data as { id: string; sessionId: string }
  }

  // 连续失败达到上限：定时执行自动暂停。
  const failing = await createTask('每日舆情汇总')
  for (let index = 0; index < SCHEDULE_FAILURE_LIMIT; index++) await projects.noteTaskRunTerminal(failing.sessionId, 'failed')
  const [paused] = (await notifications(ws.owner)).filter(item => item.kind === 'task_schedule_stopped')
  assert.equal(paused?.objectName, '每日舆情汇总')
  assert.deepEqual(paused?.detail, { state: 'paused', reason: 'consecutive_failures' })
  assert.deepEqual(paused?.target, { type: 'project_task', id: failing.id, sessionId: null })
  assert.equal(paused?.actor, null, '系统动作没有触发人')
  // 暂停后再失败不再重复通知。
  await projects.noteTaskRunTerminal(failing.sessionId, 'failed')
  assert.equal((await notifications(ws.owner)).filter(item => item.kind === 'task_schedule_stopped').length, 1)

  const dueNow = (taskId: string) => database`
    update project_tasks set next_slot_utc = now() - interval '1 minute' where tenant_id = ${tenantId} and id = ${taskId}`
  const stoppedReason = async (title: string) =>
    (await notifications(ws.owner)).find(item => item.kind === 'task_schedule_stopped' && item.objectName === title)?.detail

  // 到点时已过截止日期：停止；任务已完成：停止但不另发（创建人已有“任务完成”通知）。
  const overdue = await createTask('季度盘点')
  await database`update project_tasks set due_date = current_date - 2 where tenant_id = ${tenantId} and id = ${overdue.id}`
  const finished = await createTask('已完成的汇总')
  await database`update project_tasks set status = 'done' where tenant_id = ${tenantId} and id = ${finished.id}`
  await dueNow(overdue.id)
  await dueNow(finished.id)
  await projects.processDueSchedules(new Date())
  assert.deepEqual(await stoppedReason('季度盘点'), { state: 'stopped', reason: 'due_passed' })
  assert.equal(await stoppedReason('已完成的汇总'), undefined)
  const [finishedState] = await database<{ state: string; reason: string }[]>`
    select schedule_state as state, schedule_reason as reason from project_tasks where tenant_id = ${tenantId} and id = ${finished.id}`
  assert.deepEqual({ ...finishedState }, { state: 'stopped', reason: 'completed' })

  // 负责的 Agent 已不可用：停止。
  const orphaned = await createTask('每日库存预警')
  await database`update workspace_agent_members set status = 'disabled' where tenant_id = ${tenantId} and id = ${agentMemberId}`
  await dueNow(orphaned.id)
  await projects.processDueSchedules(new Date())
  assert.deepEqual(await stoppedReason('每日库存预警'), { state: 'stopped', reason: 'agent_unavailable' })
  await database`update workspace_agent_members set status = 'available' where tenant_id = ${tenantId} and id = ${agentMemberId}`

  // 到点时项目已归档：停止。
  const archived = await createTask('每周复盘')
  await dueNow(archived.id)
  await database`update workspaces set status = 'archived' where tenant_id = ${tenantId} and id = ${ws.id}`
  await projects.processDueSchedules(new Date())
  assert.deepEqual(await stoppedReason('每周复盘'), { state: 'stopped', reason: 'workspace_archived' })
  assert.equal((await notifications(ws.first)).some(item => item.kind === 'task_schedule_stopped'), false, '只通知规则设置人')
})

test('NC-04 定时任务与 Skill 审核通知读取时解析名称；停用或不再归本人后不可见', async () => {
  const ws = await seedSpace('owned')
  const versionId = await publishedAgentVersion('owned')
  const [personal] = await database<{ id: string }[]>`
    select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${ws.first}`
  const automationId = `auto-nc-${randomUUID().slice(0, 8)}`
  await database`
    insert into agent_automations (id, tenant_id, owner_user_id, name, agent_version_id, workspace_id, schedule, input_template, status)
    values (${automationId}, ${tenantId}, ${ws.first}, '周一销售周报', ${versionId}, ${personal!.id},
            ${database.json({ kind: 'manual', timezone: 'UTC' })}, ${database.json({ prompt: '执行' })}, 'enabled')`
  const submissionId = `subm-nc-${randomUUID().slice(0, 8)}`
  await database`
    insert into skill_submissions (id, tenant_id, submitter_user_id, source, name, status)
    values (${submissionId}, ${tenantId}, ${ws.first}, 'zip', '销售周报整理', 'approved')`
  await database`
    insert into user_notifications (id, tenant_id, recipient_user_id, kind, workspace_id, object_type, object_id, actor_user_id, safe_metadata, dedupe_key)
    values
      (${`n-auto-${automationId}`}, ${tenantId}, ${ws.first}, 'automation_failed', ${personal!.id}, 'automation', ${automationId}, null,
       ${database.json({ outcome: 'skipped', executionId: 'autexec-x', sessionId: null })}, ${`auto:${automationId}`}),
      (${`n-skill-${submissionId}`}, ${tenantId}, ${ws.first}, 'skill_review_result', null, 'skill_submission', ${submissionId}, ${ws.owner},
       ${database.json({ result: 'approved' })}, ${`skill:${submissionId}`})`

  const items = await notifications(ws.first)
  const automation = items.find(item => item.kind === 'automation_failed')
  assert.equal(automation?.objectName, '周一销售周报')
  assert.deepEqual(automation?.detail, { outcome: 'skipped' }, '执行 ID 等内部代码不对外')
  assert.deepEqual(automation?.target, { type: 'automation', id: automationId, sessionId: null })
  const review = items.find(item => item.kind === 'skill_review_result')
  assert.equal(review?.objectName, '销售周报整理')
  assert.deepEqual(review?.detail, { result: 'approved' })
  assert.equal(await unread(ws.first), 2)

  await database`update agent_automations set status = 'disabled' where tenant_id = ${tenantId} and id = ${automationId}`
  await database`update skill_submissions set submitter_user_id = ${ws.second} where tenant_id = ${tenantId} and id = ${submissionId}`
  const hidden = await notifications(ws.first)
  assert.ok(hidden.filter(item => item.kind !== 'mention').every(item => !item.visible && item.objectName === null && item.detail === null && item.target === null))
  assert.equal(await unread(ws.first), 0)
})

test('NC-05 清扫删除所有员工 90 天前的通知，可重复执行，90 天内的保留', async () => {
  const ws = await seedSpace('retention')
  const insert = (recipient: string, label: string, daysAgo: number, read: boolean) => database`
    insert into user_notifications (id, tenant_id, recipient_user_id, kind, workspace_id, object_type, object_id, actor_user_id,
                                    safe_metadata, dedupe_key, created_at, read_at)
    values (${`n-ret-${ws.id}-${label}`}, ${tenantId}, ${recipient}, 'workspace_member_added', ${ws.id}, 'workspace', ${ws.id}, ${ws.owner},
            '{}'::jsonb, ${`retention:${ws.id}:${label}`}, now() - make_interval(days => ${daysAgo}),
            ${read ? database`now()` : null})`
  await insert(ws.first, 'old-unread', 91, false)
  await insert(ws.first, 'old-read', 120, true)
  await insert(ws.second, 'old-other', 95, false)
  await insert(ws.first, 'recent', 89, false)

  // 超过一批（1000 条）的过期通知，验证分批删除能删完。
  await database`
    insert into user_notifications (id, tenant_id, recipient_user_id, kind, workspace_id, object_type, object_id, actor_user_id,
                                    safe_metadata, dedupe_key, created_at)
    select ${`n-ret-${ws.id}-bulk-`} || i, ${tenantId}, ${ws.second}, 'workspace_member_added', ${ws.id}, 'workspace', ${ws.id}, ${ws.owner},
           '{}'::jsonb, ${`retention:${ws.id}:bulk-`} || i, now() - interval '100 days'
      from generate_series(1, 1500) as i`

  // 清扫前读取侧已不列出、不计超过保留期的通知；“全部标为已读”也只标保留期内的。
  assert.deepEqual((await notifications(ws.first)).map(item => item.id), [`n-ret-${ws.id}-recent`])
  assert.equal(await unread(ws.first), 1)
  assert.deepEqual((await api('POST', `${base}/me/notifications/read-all`, { as: ws.first })).body.data, { read: 1 })
  const [expiredUnread] = await database<{ readAt: Date | null }[]>`
    select read_at as "readAt" from user_notifications where id = ${`n-ret-${ws.id}-old-unread`}`
  assert.equal(expiredUnread?.readAt, null, '看不到的过期通知不被标为已读')

  const business = async () => {
    const [row] = await database<{ mentions: number; activity: number }[]>`
      select (select count(*) from message_mentions)::integer as mentions,
             (select count(*) from workspace_activity_events)::integer as activity`
    return { ...row }
  }
  const before = await business()

  const service = new PostgresUserNotificationService(database)
  const [first, second] = await Promise.all([service.purgeExpired(), service.purgeExpired()])
  assert.equal(first.removed + second.removed, 1503, '两个实例同时清扫，各删各的批次，合计删完')
  assert.deepEqual(await service.purgeExpired(), { removed: 0 })
  assert.deepEqual(await business(), before, '只删通知，不动 @ 提醒与项目动态')
  const left = await database<{ id: string }[]>`
    select id from user_notifications where tenant_id = ${tenantId} and dedupe_key like ${`retention:${ws.id}:%`}`
  assert.deepEqual(left.map(row => row.id), [`n-ret-${ws.id}-recent`])
  assert.deepEqual((await notifications(ws.first)).map(item => item.id), [`n-ret-${ws.id}-recent`])
})

async function joinAgent(ws: { id: string; owner: string }, label: string): Promise<string> {
  const agentId = `agent-nc-${label}-${randomUUID().slice(0, 8)}`
  await insertAgent(agentId)
  const joined = await api('POST', `${base}/workspaces/${ws.id}/agent-members`, { as: ws.owner, body: { agentId } })
  assert.equal(joined.status, 201, JSON.stringify(joined.body))
  return (joined.body.data as { id: string }).id
}

async function publishedAgentVersion(label: string): Promise<string> {
  const agentId = `agent-nc-${label}-${randomUUID().slice(0, 8)}`
  await insertAgent(agentId)
  return `${agentId}-v1`
}

async function insertAgent(agentId: string) {
  const versionId = `${agentId}-v1`
  await database`
    insert into agents (id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status, active_version_id, allow_workspace_join)
    values (${agentId}, ${tenantId}, '通知测试助手', '站内通知集成测试。', '', 'U00008', 'U00008', 'published', null, true)
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message, example_prompts, system_prompt,
      max_output_bytes, max_tool_calls, timeout_seconds, skill_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${agentId}, '1.0.0', '通知测试助手', '测试。', '', ${database.json(['测试'] as string[])},
      '你是站内通知集成测试 Agent，不会被实际执行。', 65536, 20, 300, ${database.json([] as string[])},
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
}

// ---------------------------------------------------------------------------

async function seedSpace(label: string) {
  const id = `ws-nc-${label}-${randomUUID().slice(0, 8)}`
  const users = { owner: `${id}-owner`, first: `${id}-first`, second: `${id}-second`, outsider: `${id}-outsider` }
  const names: Record<string, string> = { owner: '负责人', first: '成员甲', second: '成员乙', outsider: '外部人' }
  for (const [role, userId] of Object.entries(users)) await createDirectoryUser(userId, `${label}-${names[role]}`)
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${id}, ${tenantId}, '通知测试项目', '', 'team', ${users.owner}, 'active')
  `
  for (const [userId, role] of [[users.owner, 'owner'], [users.first, 'member']]) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${id}, ${userId}, ${role}, ${users.owner})
    `
  }
  return { id, ...users }
}

async function rowCount(userId: string): Promise<number> {
  const [row] = await database<Array<{ count: number }>>`
    select count(*)::integer as count from user_notifications where tenant_id = ${tenantId} and recipient_user_id = ${userId}
  `
  return Number(row?.count ?? 0)
}

function pick(value: unknown, keys: string[]) {
  const record = value as Record<string, unknown>
  return Object.fromEntries(keys.map(key => [key, record[key]]))
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

/** 本文件只用员工任务与讨论消息，不启动 Agent 执行（项目服务不接档案员）；Runtime 被调用即说明用例写错了。 */
const unusedRuntime = {
  execute: () => Promise.reject(new Error('通知测试不应启动 Agent 执行')),
  subscribe: () => () => undefined,
  cancel: () => Promise.resolve({ accepted: false }),
  status: () => undefined,
  health: () => Promise.reject(new Error('通知测试不检查 Runtime 健康')),
  close: () => Promise.resolve(),
} as unknown as AgentRuntimePort

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_user_notifications_test', maxConnections: 8 })
  database = throwaway.client
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-user-notifications-'))
  const authorization = new PostgresAuthorizationService(database)
  const agents = new PostgresAgentService(database)
  const agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  const projectArchive = new PostgresProjectArchiveService(database)
  projects = new PostgresProjectService(database, agentMembers)
  const content = new PostgresContentService(database, new LocalObjectStorage(storageRoot), authorization)
  const conversations = new PostgresConversationRepository(database)
  const runs = new PostgresRunRepository(database)
  orchestration = new RunOrchestrationService(
    runs, conversations, new ModelGovernanceService(new PostgresModelGovernanceRepository(database)), unusedRuntime,
    content, undefined, agents, undefined, authorization, { agentMembers, projectTasks: projects, projectArchive, tasks: new PostgresTaskRepository(database) },
  )
  projects.attachRunStarter(orchestration)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerConversationRoutes(router, conversations, orchestration, runs, agents, authorization, undefined, undefined, agentMembers)
  registerProjectRoutes(router, projects, authorization, projectArchive)
  registerWorkspaceAgentMemberRoutes(router, agentMembers, authorization)
  registerWorkspaceMemberRoutes(router, new PostgresWorkspaceMemberService(database, authorization), authorization)
  registerWorkspaceActivityRoutes(router, new PostgresWorkspaceActivityService(database, new PostgresWorkspaceService(database)), authorization)
  registerConversationTargetRoutes(router, new PostgresConversationTargetService(database, agents), authorization)
  registerUserNotificationRoutes(router, new PostgresUserNotificationService(database), authorization)
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
  if (orchestration) await orchestration.close()
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
  await rm(storageRoot, { recursive: true, force: true })
})
