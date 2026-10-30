import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import type { WorkspaceNotificationRecipientService } from './workspace-notification-recipient-service.ts'
import {
  buildCollabUnreadPayload,
  buildRunFinishedPayload,
  collabUnreadRecipientIds,
  runFinishedRecipientIds,
  type RunFinishedStatus,
} from './web-push-copy.ts'
import type { WebPushService } from './web-push-service.ts'
import type { ConversationTargetType } from './conversation-targets.ts'

/** 推送只需 Run 的标识字段；避免 workbench → run 类型导入造成模块环。 */
interface RunFinishedPushRun {
  id: string
  sessionId: string | null
  requestedBy: string
}

const tenantId = 'tenant-dsh-work'

let dispatchService: WebPushDispatchService | null = null

export function bindWebPushDispatch(service: WebPushDispatchService | null): () => void {
  dispatchService = service
  return () => {
    if (dispatchService === service) dispatchService = null
  }
}

export function getWebPushDispatch(): WebPushDispatchService | null {
  return dispatchService
}

export class WebPushDispatchService {
  private readonly database: DatabaseClient
  private readonly push: WebPushService
  private readonly recipients: WorkspaceNotificationRecipientService

  constructor(
    database: DatabaseClient,
    push: WebPushService,
    recipients: WorkspaceNotificationRecipientService,
  ) {
    this.database = database
    this.push = push
    this.recipients = recipients
  }

  enqueueMessagePush(messageId: string): void {
    void this.deliverMessagePush(messageId).catch((error: unknown) => {
      console.error('web push message dispatch failed', error)
    })
  }

  enqueueRunFinished(input: {
    run: RunFinishedPushRun
    status: RunFinishedStatus
    eventId: string
  }): void {
    void this.deliverRunFinished(input).catch((error: unknown) => {
      console.error('web push run dispatch failed', error)
    })
  }

  private async deliverMessagePush(messageId: string): Promise<void> {
    const [row] = await this.database<MessageRow[]>`
      select m.id as "messageId", m.role, m.content, m.session_id as "sessionId",
             m.sender_user_id as "senderUserId", r.requested_by as "requestedBy",
             s.title as "sessionTitle", s.workspace_id as "workspaceId",
             w.workspace_type as "workspaceType", w.name as "workspaceName",
             coalesce(ag.name, 'dsh-work') as "agentName",
             av.agent_id as "agentId",
             su.display_name as "senderName"
        from messages m
        join sessions s on s.tenant_id = m.tenant_id and s.id = m.session_id
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join runs r on r.tenant_id = m.tenant_id and r.id = m.run_id
        left join users su on su.tenant_id = m.tenant_id and su.id = coalesce(m.sender_user_id, r.requested_by)
        left join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
        left join agents ag on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
       where m.tenant_id = ${tenantId} and m.id = ${messageId}
    `
    if (!row) return
    if (row.role !== 'user' && row.role !== 'assistant') return

    const targetType: ConversationTargetType = row.workspaceType === 'team' ? 'group' : 'agent'
    const targetId = targetType === 'group' ? row.workspaceId : (row.agentId ?? row.workspaceId)
    const title = targetType === 'group' ? row.workspaceName : row.agentName

    const participantUserIds = row.role === 'user' && row.senderUserId
      ? await this.recipients.resolve({
        kind: 'discussion_posted',
        actorUserId: row.senderUserId,
        sessionId: row.sessionId,
      })
      : await this.recipients.resolve({
        kind: 'discussion_posted',
        actorUserId: row.requestedBy ?? row.senderUserId ?? 'system',
        sessionId: row.sessionId,
      })

    const recipientIds = collabUnreadRecipientIds({
      role: row.role,
      authorUserId: row.senderUserId,
      requestedBy: row.requestedBy,
      participantUserIds,
      muted: false,
    })

    const payload = buildCollabUnreadPayload({
      eventId: `msg:${row.messageId}`,
      targetType,
      targetId,
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      title,
      previewText: row.content,
      senderName: row.senderName ?? '同事',
      agentName: row.agentName,
      role: row.role,
    })

    for (const userId of recipientIds) {
      if (targetType === 'group' && await this.isWorkspaceMuted(userId, row.workspaceId)) continue
      await this.push.deliver(userId, 'collab_unread', payload)
    }
  }

  private async deliverRunFinished(input: {
    run: RunFinishedPushRun
    status: RunFinishedStatus
    eventId: string
  }): Promise<void> {
    if (!input.run.sessionId) return
    const recipientIds = runFinishedRecipientIds({
      requestedBy: input.run.requestedBy,
      runStatus: input.status,
    })
    if (recipientIds.length === 0) return

    const [context] = await this.database<RunContextRow[]>`
      select s.id as "sessionId", s.title as "sessionTitle", s.workspace_id as "workspaceId",
             w.workspace_type as "workspaceType", av.agent_id as "agentId"
        from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
       where s.tenant_id = ${tenantId} and s.id = ${input.run.sessionId}
    `
    if (!context) return

    const targetType: ConversationTargetType = context.workspaceType === 'team' ? 'group' : 'agent'
    const targetId = targetType === 'group' ? context.workspaceId : (context.agentId ?? context.workspaceId)

    const payload = buildRunFinishedPayload({
      eventId: input.eventId,
      runId: input.run.id,
      runStatus: input.status,
      sessionId: context.sessionId,
      sessionTitle: context.sessionTitle,
      targetType,
      targetId,
      workspaceId: context.workspaceId,
    })

    for (const userId of recipientIds) {
      await this.push.deliver(userId, 'run_finished', payload)
    }
  }

  private async isWorkspaceMuted(userId: string, workspaceId: string): Promise<boolean> {
    const [row] = await this.database<{ muted: boolean }[]>`
      select ns.muted_at is not null as muted
        from workspace_notification_states ns
       where ns.tenant_id = ${tenantId}
         and ns.workspace_id = ${workspaceId}
         and ns.user_id = ${userId}
    `
    return row?.muted ?? false
  }
}

interface MessageRow {
  messageId: string
  role: 'user' | 'assistant'
  content: string
  sessionId: string
  senderUserId: string | null
  requestedBy: string | null
  sessionTitle: string
  workspaceId: string
  workspaceType: string
  workspaceName: string
  agentName: string
  agentId: string | null
  senderName: string | null
}

interface RunContextRow {
  sessionId: string
  sessionTitle: string
  workspaceId: string
  workspaceType: string
  agentId: string | null
}
