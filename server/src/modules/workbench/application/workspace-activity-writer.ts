import { randomUUID } from 'node:crypto'

import type { DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { requestInvalid } from '../../../domain/authorization-errors.ts'
import type { WorkspaceNotificationRecipientService } from './workspace-notification-recipient-service.ts'

const tenantId = 'tenant-dsh-work'

const FORBIDDEN_METADATA_KEYS = new Set(['content', 'prompt', 'answer', 'filename', 'reasonText'])

/**
 * Team workspace activity kinds (batch 3 / 3-T7 / TW-08). The list is closed on
 * purpose and mirrors the migration CHECK constraint: message bodies and Run
 * execution details are not representable in safe_metadata.
 */
export type WorkspaceActivityKind =
  | 'member_added'
  | 'member_removed'
  | 'member_exit'
  | 'role_changed'
  | 'owner_transferred'
  | 'agent_member_added'
  | 'agent_member_removed'
  | 'file_uploaded'
  | 'file_removed'
  | 'file_version_added'
  | 'workspace_archived'
  | 'workspace_restored'
  | 'brief_updated'
  | 'project_task_created'
  | 'project_task_completed'
  | 'discussion_posted'
  | 'member_mentioned'
  | 'run_completed'
  | 'run_failed'

export type WorkspaceActivityObjectType =
  | 'member'
  | 'agent_member'
  | 'file'
  | 'workspace'
  | 'brief'
  | 'project_task'
  | 'session'
  | 'run'

export type WorkspaceActivityMetadataValue = string | number | boolean | null
export type WorkspaceActivityMetadata = Record<string, WorkspaceActivityMetadataValue>

export interface WorkspaceActivityInput {
  workspaceId: string
  kind: Exclude<WorkspaceActivityKind, 'discussion_posted' | 'member_mentioned' | 'run_completed' | 'run_failed'>
  actorUserId: string
  objectType: Exclude<WorkspaceActivityObjectType, 'session' | 'run'>
  /** Safe object reference: an id only. Names/bodies must never be passed here. */
  objectId: string
  /** Business occurrence identity; the unique key makes a duplicate a no-op. */
  dedupeKey: string
  metadata?: WorkspaceActivityMetadata
}

export type WorkspaceNotifiableEvent =
  | { kind: 'discussion_posted'; workspaceId: string; sessionId: string; messageId: string; actorUserId: string }
  | {
    kind: 'member_mentioned'
    workspaceId: string
    sessionId: string
    messageId: string
    actorUserId: string
    mentionedUserId: string
  }
  | {
    kind: 'run_completed' | 'run_failed'
    workspaceId: string
    sessionId: string
    runId: string
    requestedBy: string
    /** Terminal run event id — idempotency source for the activity row. */
    dedupeKey: string
    agentDisplayName?: string
  }

let recipientService: WorkspaceNotificationRecipientService | null = null

export function bindWorkspaceNotificationRecipients(service: WorkspaceNotificationRecipientService): () => void {
  recipientService = service
  return () => {
    if (recipientService === service) recipientService = null
  }
}

function assertSafeMetadata(metadata: WorkspaceActivityMetadata | undefined) {
  if (!metadata) return
  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      throw requestInvalid(`通知元数据不允许包含字段 ${key}`)
    }
  }
}

async function insertDeliveries(
  transaction: DatabaseTransaction,
  input: { activityId: string; workspaceId: string; sequence: number; recipientUserIds: string[] },
) {
  for (const recipientUserId of input.recipientUserIds) {
    await transaction`
      insert into workspace_notification_deliveries (
        tenant_id, activity_id, recipient_user_id, workspace_id, sequence
      ) values (
        ${tenantId}, ${input.activityId}, ${recipientUserId}, ${input.workspaceId}, ${input.sequence}
      )
      on conflict (tenant_id, activity_id, recipient_user_id) do nothing
    `
  }
}

async function insertActivity(
  transaction: DatabaseTransaction,
  row: {
    workspaceId: string
    kind: WorkspaceActivityKind
    actorUserId: string
    objectType: WorkspaceActivityObjectType
    objectId: string
    dedupeKey: string
    metadata?: WorkspaceActivityMetadata
  },
): Promise<{ activityId: string; sequence: number } | null> {
  assertSafeMetadata(row.metadata)
  const activityId = `wact-${randomUUID()}`
  const [inserted] = await transaction<{ id: string; sequence: string }[]>`
    insert into workspace_activity_events (
      id, tenant_id, workspace_id, kind, actor_user_id, object_type, object_id,
      safe_metadata, dedupe_key
    ) values (
      ${activityId}, ${tenantId}, ${row.workspaceId}, ${row.kind}, ${row.actorUserId},
      ${row.objectType}, ${row.objectId}, ${transaction.json(row.metadata ?? {})}, ${row.dedupeKey}
    )
    on conflict (tenant_id, workspace_id, dedupe_key) do nothing
    returning id, sequence::text
  `
  if (!inserted) return null
  return { activityId: inserted.id, sequence: Number(inserted.sequence) }
}

/**
 * Appends one management activity fact and fan-out deliveries inside the caller transaction.
 */
export async function recordWorkspaceActivity(
  transaction: DatabaseTransaction,
  input: WorkspaceActivityInput,
): Promise<void> {
  const created = await insertActivity(transaction, input)
  if (!created || !recipientService) return
  const recipients = await recipientService.resolve({
    kind: 'workspace_broadcast',
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
  }, transaction)
  await insertDeliveries(transaction, { ...created, workspaceId: input.workspaceId, recipientUserIds: recipients })
}

/** Discussion, mention and Run terminal events — closed input with delivery fan-out. */
export async function writeNotifiableEvent(
  event: WorkspaceNotifiableEvent,
  transaction: DatabaseTransaction,
): Promise<{ activityId: string; sequence: number } | null> {
  if (!recipientService) throw new Error('通知收件人服务未绑定')
  if (event.kind === 'discussion_posted') {
    const created = await insertActivity(transaction, {
      workspaceId: event.workspaceId,
      kind: event.kind,
      actorUserId: event.actorUserId,
      objectType: 'session',
      objectId: event.messageId,
      dedupeKey: `discussion:${event.messageId}`,
      metadata: { sessionId: event.sessionId, messageId: event.messageId },
    })
    if (!created) return null
    const recipients = await recipientService.resolve({
      kind: 'discussion_posted',
      actorUserId: event.actorUserId,
      sessionId: event.sessionId,
    }, transaction)
    await insertDeliveries(transaction, { ...created, workspaceId: event.workspaceId, recipientUserIds: recipients })
    return created
  }
  if (event.kind === 'member_mentioned') {
    const created = await insertActivity(transaction, {
      workspaceId: event.workspaceId,
      kind: event.kind,
      actorUserId: event.actorUserId,
      objectType: 'session',
      objectId: event.messageId,
      dedupeKey: `mention:${event.messageId}:${event.mentionedUserId}`,
      metadata: {
        sessionId: event.sessionId,
        messageId: event.messageId,
        mentionedUserId: event.mentionedUserId,
      },
    })
    if (!created) return null
    const recipients = await recipientService.resolve({
      kind: 'member_mentioned',
      actorUserId: event.actorUserId,
      mentionedUserId: event.mentionedUserId,
      workspaceId: event.workspaceId,
    }, transaction)
    await insertDeliveries(transaction, { ...created, workspaceId: event.workspaceId, recipientUserIds: recipients })
    return created
  }
  const created = await insertActivity(transaction, {
    workspaceId: event.workspaceId,
    kind: event.kind,
    actorUserId: event.requestedBy,
    objectType: 'run',
    objectId: event.runId,
    dedupeKey: event.dedupeKey,
    metadata: {
      actor: 'system',
      sessionId: event.sessionId,
      runId: event.runId,
      ...(event.agentDisplayName ? { agentDisplayName: event.agentDisplayName } : {}),
    },
  })
  if (!created) return null
  const recipients = await recipientService.resolve({
    kind: event.kind,
    actorUserId: 'system',
    requestedBy: event.requestedBy,
  }, transaction)
  await insertDeliveries(transaction, { ...created, workspaceId: event.workspaceId, recipientUserIds: recipients })
  return created
}

export async function activityTransitionToken(transaction: DatabaseTransaction): Promise<string> {
  const [row] = await transaction<{ token: string }[]>`
    select pg_current_xact_id()::text as token
  `
  if (!row) throw new Error('无法取得团队动态事务令牌')
  return row.token
}

export async function currentTeamAuthRevision(
  transaction: DatabaseTransaction,
  workspaceId: string,
): Promise<number> {
  const [row] = await transaction<{ revision: number }[]>`
    select team_auth_revision as revision from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
  return row?.revision ?? 0
}
