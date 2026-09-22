import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { redactSensitiveText } from '../../../security/safe-observability.ts'
import { authorizationDenied } from '../../authorization/authorization-errors.ts'
import {
  activityTransitionToken,
  recordWorkspaceActivity,
} from './workspace-activity-writer.ts'
import { workspaceStateConflict } from './workspace-state-conflict-error.ts'

const tenantId = 'tenant-dsh-work'

export type WorkspaceLifecycleStatus = 'active' | 'archived'

export interface WorkspaceLifecycleResult {
  id: string
  status: WorkspaceLifecycleStatus
  archivedAt: string | null
}

/**
 * Team-workspace archive / restore (batch 3 / 3-T2, 归档 = 只读保留).
 *
 * Owner-only, transactional, and serialized with run creation through the
 * workspace row lock:
 *
 *   lock order: workspaces -> runs (via sessions)
 *
 * `PostgresRunRepository.createRun` / `createAttempt` / `claimAttempt` take the
 * same `workspaces` row lock as their first statement, before any
 * session/run/run_attempt row, so a run can never start against a workspace
 * that commits as archived, and an archive can never commit while a run is
 * being created or claimed. The member-management paths use the same lock, so
 * there is exactly one workspace lock and one order in the codebase.
 *
 * Restoring never widens authorization: it only flips `status` back to
 * `active` and clears `archived_at`. Removed members stay removed; the
 * membership table is never touched here. Governance exceptions established by
 * 3-T1 (emergency access revocation and owner transfer) live in
 * `PostgresWorkspaceMemberService` and keep working on an archived workspace
 * because this service never blocks those paths.
 */
export class PostgresWorkspaceLifecycleService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  archiveWorkspace(workspaceId: string, actorUserId: string): Promise<WorkspaceLifecycleResult> {
    return this.changeStatus(workspaceId, actorUserId, 'archived')
  }

  restoreWorkspace(workspaceId: string, actorUserId: string): Promise<WorkspaceLifecycleResult> {
    return this.changeStatus(workspaceId, actorUserId, 'active')
  }

  private async changeStatus(
    workspaceId: string,
    actorUserId: string,
    target: WorkspaceLifecycleStatus,
  ): Promise<WorkspaceLifecycleResult> {
    return this.database.begin(async transaction => {
      // The workspace row lock is the batch-3 serialization point. Everything
      // that can start or claim a run takes this exact lock first.
      const [workspace] = await transaction<{
        type: 'personal' | 'team'
        status: WorkspaceLifecycleStatus
        archivedAt: Date | null
      }[]>`
        select workspace_type as type, status, archived_at as "archivedAt"
          from workspaces
         where tenant_id = ${tenantId} and id = ${workspaceId}
         for update
      `
      if (!workspace) throw authorizationDenied('工作空间不存在或不可访问')
      // AC-23: personal workspaces are never archivable. `0013` enforces
      // `personal => status = 'active'`; reject before touching the row rather
      // than fighting the CHECK constraint.
      if (workspace.type !== 'team') throw new Error('仅支持团队工作空间进行归档或恢复')

      // Owner is re-read inside the lock: a concurrent owner transfer must not
      // let the previous owner archive/restore after the transfer commits.
      await assertCurrentOwner(transaction, workspaceId, actorUserId)

      // Idempotent: repeating archive/restore is a read of the current state,
      // not a second state change, so it writes no second audit fact.
      if (workspace.status === target) {
        return {
          id: workspaceId,
          status: target,
          archivedAt: target === 'archived' ? toIso(workspace.archivedAt) : null,
        }
      }

      if (target === 'archived') {
        const activeRunCount = await countActiveRuns(transaction, workspaceId)
        if (activeRunCount > 0) {
          // Never auto-interrupt in-flight work (plan 3-T2): tell the user to
          // wait or cancel instead. Typed 409 keeps the mapping out of the
          // message regex.
          throw workspaceStateConflict(
            `该空间还有 ${activeRunCount} 个排队或运行中的任务，不能归档；请等待任务完成或先取消任务`,
          )
        }
      }

      const archivedAt = target === 'archived' ? new Date() : null
      await transaction`
        update workspaces
           set status = ${target}, archived_at = ${archivedAt}
         where tenant_id = ${tenantId} and id = ${workspaceId}
      `
      // Activity in the same transaction as the status change: the early return
      // above already makes a repeated archive/restore a no-op without a second
      // event, and the per-transaction token keeps a genuine
      // archive -> restore -> archive sequence distinct (the resulting status
      // alone would repeat, so a state-only key would silently drop it).
      const token = await activityTransitionToken(transaction)
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: target === 'archived' ? 'workspace_archived' : 'workspace_restored',
        actorUserId,
        objectType: 'workspace',
        objectId: workspaceId,
        dedupeKey: `${target === 'archived' ? 'workspace_archived' : 'workspace_restored'}:${token}`,
        metadata: {},
      })
      await writeAudit(
        transaction,
        actorUserId,
        workspaceId,
        target === 'archived' ? 'workspace.archive' : 'workspace.restore',
        target === 'archived' ? '负责人归档团队空间（只读保留）' : '负责人恢复团队空间',
      )
      return { id: workspaceId, status: target, archivedAt: toIso(archivedAt) }
    })
  }
}

async function assertCurrentOwner(
  transaction: DatabaseTransaction,
  workspaceId: string,
  actorUserId: string,
) {
  const [owner] = await transaction<{ userId: string }[]>`
    select user_id as "userId" from workspace_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
       and member_role = 'owner'
  `
  if (!owner || owner.userId !== actorUserId) {
    throw authorizationDenied('仅空间负责人可以归档或恢复团队空间')
  }
}

async function countActiveRuns(transaction: DatabaseTransaction, workspaceId: string): Promise<number> {
  const [row] = await transaction<{ count: number }[]>`
    select count(*)::integer as count
      from runs r
      join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
     where r.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
       and r.status in ('queued', 'running', 'waiting', 'cancel_requested')
  `
  return row?.count ?? 0
}

/**
 * Audit insert inside the state-change transaction, following the shape used by
 * `PostgresOperationsService.appendAudit` (~line 523). `safe_context` carries
 * only a generic human-readable detail, redacted through the shared helper: no
 * private content, credentials or hidden reasoning.
 */
async function writeAudit(
  transaction: DatabaseTransaction,
  actorUserId: string,
  workspaceId: string,
  action: 'workspace.archive' | 'workspace.restore',
  detail: string,
) {
  await transaction`
    insert into audit_events (
      id, tenant_id, actor_type, actor_id, action, object_type, object_id,
      result, trace_id, safe_context
    ) values (
      ${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actorUserId}, ${action},
      'workspace', ${workspaceId}, 'success', ${`trace-workspace-${action}-${workspaceId}`},
      ${transaction.json({ detail: redactSensitiveText(detail) })}
    )
  `
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null
}
