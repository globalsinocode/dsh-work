import { randomUUID } from 'node:crypto'

import type { DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'

const tenantId = 'tenant-dsh-work'

/**
 * Team workspace activity kinds (batch 3 / 3-T7 / TW-08). The list is closed on
 * purpose and mirrors the migration 0026 CHECK constraint: messages, unshared
 * conversation activity and Run execution details are not representable.
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

export type WorkspaceActivityObjectType = 'member' | 'agent_member' | 'file' | 'workspace' | 'brief' | 'project_task'

export type WorkspaceActivityMetadataValue = string | number | boolean | null
export type WorkspaceActivityMetadata = Record<string, WorkspaceActivityMetadataValue>

export interface WorkspaceActivityInput {
  workspaceId: string
  kind: WorkspaceActivityKind
  actorUserId: string
  objectType: WorkspaceActivityObjectType
  /** Safe object reference: an id only. Names/bodies must never be passed here. */
  objectId: string
  /** Business occurrence identity; the unique key makes a duplicate a no-op. */
  dedupeKey: string
  /**
   * Minimal member-visible extras. Callers must keep this to ids, roles and
   * version numbers — never private conversation text or attachment names.
   */
  metadata?: WorkspaceActivityMetadata
}

/**
 * Appends one activity fact inside the caller's business transaction.
 *
 * Same-transaction is the whole contract (TW-08「业务成功后通过持久化事件生成
 * 通知」): the activity row commits exactly when the business change commits, so
 *
 *   * a successful business change always has its activity row, and
 *   * a rolled-back change leaves no activity behind, and
 *   * there is no window in which a committed change is later reported as a
 *     failure because the projection write failed — the two are atomic, so a
 *     projection failure aborts the change instead of faking a failure for an
 *     already-committed one.
 *
 * `on conflict do nothing` plus the `(tenant_id, workspace_id, dedupe_key)`
 * unique key makes a duplicate write a silent no-op, never an error: a retried
 * or racing occurrence cannot add a second row (AC-15), and it cannot abort the
 * business transaction either.
 */
export async function recordWorkspaceActivity(
  transaction: DatabaseTransaction,
  input: WorkspaceActivityInput,
): Promise<void> {
  await transaction`
    insert into workspace_activity_events (
      id, tenant_id, workspace_id, kind, actor_user_id, object_type, object_id,
      safe_metadata, dedupe_key
    ) values (
      ${`wact-${randomUUID()}`}, ${tenantId}, ${input.workspaceId}, ${input.kind},
      ${input.actorUserId}, ${input.objectType}, ${input.objectId},
      ${transaction.json(input.metadata ?? {})}, ${input.dedupeKey}
    )
    on conflict (tenant_id, workspace_id, dedupe_key) do nothing
  `
}

/**
 * Transition token for occurrences whose RESULTING state can repeat without any
 * other observable difference: member role A->B->A->B, a workspace
 * archive->restore->archive, an agent re-added after removal.
 *
 * A purely state-derived dedupe key would collapse the later occurrences (the
 * unique key would silently drop a real change), while the ordinary retry case
 * is already excluded by the per-kind "did this write actually change anything"
 * guard every caller performs. `pg_current_xact_id()` gives a token that is
 * unique across business transactions (xid8, no practical wraparound) and
 * identical for every statement inside one, so each committed real change gets
 * its own key and a duplicate insert inside one transaction still collides.
 */
export async function activityTransitionToken(transaction: DatabaseTransaction): Promise<string> {
  const [row] = await transaction<{ token: string }[]>`
    select pg_current_xact_id()::text as token
  `
  if (!row) throw new Error('无法取得团队动态事务令牌')
  return row.token
}

/**
 * Current `workspaces.team_auth_revision`, read inside the transaction that just
 * bumped it. Membership/agent mutations bump it exactly once per real change, so
 * it is a semantic, per-workspace monotonic transition token for those kinds.
 */
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
