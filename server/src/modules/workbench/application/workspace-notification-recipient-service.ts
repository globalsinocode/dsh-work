import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'

const tenantId = 'tenant-dsh-work'

type Db = DatabaseClient | DatabaseTransaction

export type WorkspaceNotificationResolveInput =
  | { kind: 'discussion_posted'; actorUserId: string; sessionId: string }
  | { kind: 'member_mentioned'; actorUserId: string; mentionedUserId: string; workspaceId: string }
  | { kind: 'run_completed' | 'run_failed'; actorUserId: 'system'; requestedBy: string }
  | { kind: 'workspace_broadcast'; workspaceId: string; actorUserId: string }

export interface WorkspaceNotificationParticipantPort {
  listSessionParticipants(sessionId: string, transaction?: DatabaseTransaction): Promise<string[]>
}

export interface WorkspaceNotificationMemberPort {
  isCurrentMember(workspaceId: string, userId: string, transaction?: DatabaseTransaction): Promise<boolean>
  listAuthorizedMemberUserIds(workspaceId: string, transaction?: DatabaseTransaction): Promise<string[]>
}

export class WorkspaceNotificationRecipientService {
  private readonly participants: WorkspaceNotificationParticipantPort
  private readonly members: WorkspaceNotificationMemberPort

  constructor(
    _database: DatabaseClient,
    participants: WorkspaceNotificationParticipantPort,
    members: WorkspaceNotificationMemberPort,
  ) {
    this.participants = participants
    this.members = members
  }

  async resolve(
    input: WorkspaceNotificationResolveInput,
    transaction?: DatabaseTransaction,
  ): Promise<string[]> {
    if (input.kind === 'discussion_posted') {
      const participants = await this.participants.listSessionParticipants(input.sessionId, transaction)
      return dedupeExceptActor(participants, input.actorUserId)
    }
    if (input.kind === 'member_mentioned') {
      if (!(await this.members.isCurrentMember(input.workspaceId, input.mentionedUserId, transaction))) {
        return []
      }
      return [input.mentionedUserId]
    }
    if (input.kind === 'run_completed' || input.kind === 'run_failed') {
      return input.requestedBy ? [input.requestedBy] : []
    }
    if (input.kind !== 'workspace_broadcast') return []
    const members = await this.members.listAuthorizedMemberUserIds(input.workspaceId, transaction)
    return dedupeExceptActor(members, input.actorUserId)
  }
}

export function createPostgresNotificationRecipientPorts(database: DatabaseClient): {
  participants: WorkspaceNotificationParticipantPort
  members: WorkspaceNotificationMemberPort
} {
  return {
    participants: {
      async listSessionParticipants(sessionId, transaction) {
        const db: Db = transaction ?? database
        const rows = await db<{ userId: string }[]>`
          select distinct user_id as "userId"
            from (
              select s.created_by as user_id
                from sessions s
               where s.tenant_id = ${tenantId} and s.id = ${sessionId}
              union all
              select m.sender_user_id
                from messages m
               where m.tenant_id = ${tenantId} and m.session_id = ${sessionId}
                 and m.sender_user_id is not null
              union all
              select r.requested_by
                from runs r
               where r.tenant_id = ${tenantId} and r.session_id = ${sessionId}
            ) participants
           where user_id is not null
        `
        return rows.map(row => row.userId)
      },
    },
    members: {
      async isCurrentMember(workspaceId, userId, transaction) {
        const db: Db = transaction ?? database
        const [row] = await db<{ exists: boolean }[]>`
          select exists (
            select 1
              from workspace_members wm
              join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id and u.status = 'active'
             where wm.tenant_id = ${tenantId}
               and wm.workspace_id = ${workspaceId}
               and wm.user_id = ${userId}
          ) as exists
        `
        return row?.exists ?? false
      },
      async listAuthorizedMemberUserIds(workspaceId, transaction) {
        const db: Db = transaction ?? database
        const rows = await db<{ userId: string }[]>`
          select wm.user_id as "userId"
            from workspace_members wm
            join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id and u.status = 'active'
           where wm.tenant_id = ${tenantId} and wm.workspace_id = ${workspaceId}
        `
        return rows.map(row => row.userId)
      },
    },
  }
}

function dedupeExceptActor(userIds: string[], actorUserId: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const userId of userIds) {
    if (!userId || userId === actorUserId || seen.has(userId)) continue
    seen.add(userId)
    result.push(userId)
  }
  return result
}
