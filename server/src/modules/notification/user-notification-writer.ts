import { randomUUID } from 'node:crypto'

import type { DatabaseTransaction } from '../../infrastructure/postgres/database.ts'

const tenantId = 'tenant-dsh-work'

/** 站内通知的类型；与迁移 0110、0111、0118 的 CHECK 约束一一对应。 */
export type UserNotificationKind =
  | 'mention' | 'task_assigned' | 'task_completed' | 'workspace_member_added'
  | 'task_schedule_stopped' | 'automation_failed' | 'skill_review_result'
  | 'dingtalk_bound_by_admin' | 'dingtalk_binding_revoked' | 'dingtalk_bind_reminder'

export type UserNotificationObjectType = 'message' | 'project_task' | 'workspace' | 'automation' | 'skill_submission' | 'dingtalk_binding'

/** 定时任务一次执行没有成功的方式（NC-S3）：执行失败、被跳过、停机错过、受理后未能开始。 */
export type AutomationOutcome = 'failed' | 'skipped' | 'missed' | 'interrupted'

export interface UserNotificationInput {
  recipientUserId: string
  kind: UserNotificationKind
  workspaceId: string | null
  objectType: UserNotificationObjectType
  /** 跳转目标的安全引用：只传 ID，不传名称或正文。 */
  objectId: string
  actorUserId: string | null
  /** 业务发生的唯一标识；与接收人一起去重。 */
  dedupeKey: string
  /** 只放代码值（如 @ 所在的 sessionId），不放名称、正文或审核原因。 */
  metadata?: Record<string, string | number | boolean | null>
}

/**
 * 在调用方的业务事务中登记一条通知（与 `recordWorkspaceActivity` 同一约定）：业务提交则通知
 * 一并提交，回滚则不留通知；唯一键使重放成为空操作。触发人就是接收人本人时不登记——
 * 自己做的事不提醒自己。
 */
export async function recordUserNotification(
  transaction: DatabaseTransaction,
  input: UserNotificationInput,
): Promise<void> {
  if (input.actorUserId && input.actorUserId === input.recipientUserId) return
  await transaction`
    insert into user_notifications (
      id, tenant_id, recipient_user_id, kind, workspace_id, object_type, object_id,
      actor_user_id, safe_metadata, dedupe_key
    ) values (
      ${`unotif-${randomUUID()}`}, ${tenantId}, ${input.recipientUserId}, ${input.kind}, ${input.workspaceId},
      ${input.objectType}, ${input.objectId}, ${input.actorUserId},
      ${transaction.json(input.metadata ?? {})}, ${input.dedupeKey}
    )
    on conflict (tenant_id, recipient_user_id, dedupe_key) do nothing
  `
}

/**
 * @ 提醒（D38）登记后，为同一条消息的每位接收人补写一条 `mention` 通知。接收人取自
 * `message_mentions`，因此与提醒的“现任成员、不含发送者”口径完全一致。
 */
export async function recordMentionNotifications(
  transaction: DatabaseTransaction,
  messageId: string,
): Promise<void> {
  await transaction`
    insert into user_notifications (
      id, tenant_id, recipient_user_id, kind, workspace_id, object_type, object_id,
      actor_user_id, safe_metadata, dedupe_key
    )
    select 'unotif-' || gen_random_uuid()::text, mm.tenant_id, mm.mentioned_user_id, 'mention', mm.workspace_id,
           'message', mm.message_id, mm.sender_user_id, jsonb_build_object('sessionId', mm.session_id),
           'mention:' || mm.message_id
      from message_mentions mm
     where mm.tenant_id = ${tenantId} and mm.message_id = ${messageId}
    on conflict (tenant_id, recipient_user_id, dedupe_key) do nothing
  `
}

/** 打开群组或讨论把 @ 提醒标为已读时，同步这些消息的 `mention` 通知（方案 NC4）。 */
export async function markMentionNotificationsRead(
  transaction: DatabaseTransaction,
  userId: string,
  messageIds: string[],
): Promise<void> {
  if (!messageIds.length) return
  await transaction`
    update user_notifications set read_at = now()
     where tenant_id = ${tenantId} and recipient_user_id = ${userId} and kind = 'mention'
       and object_id in ${transaction(messageIds)} and read_at is null
  `
}

/**
 * 定时任务的一次执行没有成功（NC-S3）：通知所有者。按执行记录取所有者与所在空间，与执行状态的
 * 写入同一事务；`executionId` 或 `runId` 二选一（Run 失败时只知道 Run）。手动执行没有 Run 就被拒绝时
 * 所有者当场看到，调用方不应调用。
 *
 * 同一定时任务同一结果已有未读通知时不再新增，只把那一条更新为最新一次（移到最前、指向最新的对话）：
 * 长时间重叠、权限失效或待处理数超限会让每个时间点都被跳过，逐条通知会刷屏。所有者读过之后再发生才
 * 另起一条。新增的去重键按“执行 + 结果”，重放不重复。
 */
export async function recordAutomationOutcomeNotification(
  transaction: DatabaseTransaction,
  target: { executionId: string } | { runId: string },
  outcome: AutomationOutcome,
): Promise<void> {
  const match = 'executionId' in target
    ? transaction`e.id = ${target.executionId}`
    : transaction`e.run_id = ${target.runId}`
  const [execution] = await transaction<Array<{
    executionId: string; sessionId: string | null; automationId: string; ownerUserId: string; workspaceId: string
  }>>`
    select e.id as "executionId", e.session_id as "sessionId", a.id as "automationId",
           a.owner_user_id as "ownerUserId", a.workspace_id as "workspaceId"
      from automation_executions e
      join agent_automations a on a.tenant_id = e.tenant_id and a.id = e.automation_id
     where e.tenant_id = ${tenantId} and ${match}
  `
  if (!execution) return
  const metadata = { outcome, executionId: execution.executionId, sessionId: execution.sessionId }
  const bumped = await transaction`
    update user_notifications
       set created_at = now(), safe_metadata = ${transaction.json(metadata)}
     where tenant_id = ${tenantId} and recipient_user_id = ${execution.ownerUserId}
       and kind = 'automation_failed' and object_id = ${execution.automationId}
       and read_at is null and safe_metadata ->> 'outcome' = ${outcome}
  `
  if (bumped.count > 0) return
  await recordUserNotification(transaction, {
    recipientUserId: execution.ownerUserId, kind: 'automation_failed', workspaceId: execution.workspaceId,
    objectType: 'automation', objectId: execution.automationId, actorUserId: null,
    dedupeKey: `automation:${execution.executionId}:${outcome}`, metadata,
  })
}
