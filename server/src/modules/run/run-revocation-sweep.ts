import { authorizationDenied, isAuthorizationDenial } from '../../domain/authorization-errors.ts'
import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import type { RunOrchestrationService } from './run-orchestration-service.ts'
import type { RunRepository } from './run-repository.ts'
import type { JsonObject } from './run-types.ts'

const tenantId = 'tenant-dsh-work'
const POLL_INTERVAL_MS = 2_000
const EVENT_BATCH_LIMIT = 25
/**
 * Bounded retry budget for a single revocation event. With the ~2s poll this is
 * roughly 40s of retries — enough for a transient database blip, short enough
 * that a permanently broken event stops and becomes inspectable.
 */
export const MAX_EVENT_ATTEMPTS = 20

export type RevocationEventKind =
  | 'member_removed'
  | 'member_exit'
  | 'role_changed'
  | 'agent_disabled'
  | 'agent_removed'

interface PendingRevocationEvent {
  id: string
  workspaceId: string
  userId: string
  kind: RevocationEventKind
  payload: JsonObject
}

/**
 * In-process revocation consumer (1A-T5): turns persistent
 * workspace_revocation_events and team_auth_revision bumps into cancellations
 * of in-flight team-workspace runs.
 *
 * CRITICAL design constraint (carried from T3/T4 reviews — do not violate):
 * workspace_revocation_events dedupes on
 * (workspace_id, user_id, kind, payload_hash), so repeated lifecycle events
 * with identical payloads (demote→promote→demote, disable→enable→disable)
 * produce only ONE row. This consumer therefore MUST NOT rely on events
 * alone: events are hints that trigger a sweep, never the source of truth.
 * The sweep cancels based on CURRENT authorization state — every event is
 * re-checked at processing time (isRevocationEffective), and every
 * team_auth_revision change (the canonical signal, bumped by every
 * membership/role/agent-grant mutation) triggers a full re-check of the
 * workspace's active runs even when no event row exists.
 *
 * Lifecycle follows the run pumpScheduler pattern: a ~2s poll loop (unref'd)
 * that performs real work only when pending work exists (revision changes or
 * pending events); start() on service init, close() on shutdown. Processing
 * is replay-safe: systemCancelRun is idempotent and re-running a pass over
 * already-processed state performs no additional cancellations.
 */
export class RunRevocationSweep {
  private timer?: NodeJS.Timeout
  private sweeping = false
  private closing = false
  private readonly lastSeenRevisions = new Map<string, number>()
  private readonly database: DatabaseClient
  private readonly runs: RunRepository
  private readonly orchestration: Pick<RunOrchestrationService, 'systemCancelRun'>
  private readonly authorization: PostgresAuthorizationService

  constructor(
    database: DatabaseClient,
    runs: RunRepository,
    orchestration: Pick<RunOrchestrationService, 'systemCancelRun'>,
    authorization: PostgresAuthorizationService,
  ) {
    this.database = database
    this.runs = runs
    this.orchestration = orchestration
    this.authorization = authorization
  }

  /** Starts the poll loop with an immediate initial pass (restart replay safety). */
  start() {
    this.scheduleTick(0)
  }

  close() {
    this.closing = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Runs one full sweep pass synchronously. Public so tests (and tick) can
   * drive the consumer deterministically.
   */
  async sweepOnce() {
    const { changedWorkspaces, pendingWorkspaces } = await this.readWorkspacesNeedingSweep()
    for (const workspace of changedWorkspaces) {
      try {
        await this.processPendingEvents(workspace.id)
        // team_auth_revision changed → full re-check of the workspace's active
        // runs. This is the catch-all for deduped events: a mutation whose
        // event row was swallowed by the payload_hash unique key still bumps
        // the revision, and this sweep re-checks CURRENT state for every
        // active run instead of trusting the (missing) event.
        await this.sweepWorkspaceActiveRuns(workspace.id)
        this.lastSeenRevisions.set(workspace.id, workspace.revision)
      } catch (error) {
        // Do not crash the loop: leave the revision unrecorded so the next
        // pass retries this workspace.
        console.error('revocation sweep workspace failed', workspace.id, error)
      }
    }
    for (const workspaceId of pendingWorkspaces) {
      try {
        await this.processPendingEvents(workspaceId)
      } catch (error) {
        console.error('revocation sweep events failed', workspaceId, error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  private scheduleTick(delayMs: number) {
    if (this.timer || this.closing) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, delayMs)
    this.timer.unref()
  }

  private async tick() {
    if (this.sweeping || this.closing) return
    this.sweeping = true
    try {
      await this.sweepOnce()
    } catch (error) {
      console.error('revocation sweep tick failed', error)
    } finally {
      this.sweeping = false
      this.scheduleTick(POLL_INTERVAL_MS)
    }
  }

  // -------------------------------------------------------------------------
  // Work discovery
  // -------------------------------------------------------------------------

  private async readWorkspacesNeedingSweep() {
    const rows = await this.database<{ id: string; revision: number }[]>`
      select id, team_auth_revision as revision from workspaces
       where tenant_id = ${tenantId} and workspace_type = 'team' and status = 'active'
    `
    const pendingRows = await this.database<{ workspaceId: string }[]>`
      select distinct workspace_id as "workspaceId" from workspace_revocation_events
       where tenant_id = ${tenantId} and status = 'pending'
    `
    const pendingSet = new Set(pendingRows.map(row => row.workspaceId))
    const changedWorkspaces: Array<{ id: string; revision: number }> = []
    for (const row of rows) {
      const seen = this.lastSeenRevisions.get(row.id)
      if (seen === undefined || seen !== row.revision) changedWorkspaces.push(row)
    }
    const changedSet = new Set(changedWorkspaces.map(row => row.id))
    const pendingWorkspaces = [...pendingSet].filter(id => !changedSet.has(id))
    return { changedWorkspaces, pendingWorkspaces }
  }

  private async readPendingEvents(workspaceId: string): Promise<PendingRevocationEvent[]> {
    const rows = await this.database<{ id: string; userId: string; kind: string; payload: JsonObject }[]>`
      select id, user_id as "userId", kind, payload
        from workspace_revocation_events
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and status = 'pending'
       order by created_at asc
       limit ${EVENT_BATCH_LIMIT}
    `
    return rows.map(row => ({
      id: row.id,
      workspaceId,
      userId: row.userId,
      kind: row.kind as RevocationEventKind,
      payload: row.payload,
    }))
  }

  // -------------------------------------------------------------------------
  // Event processing
  // -------------------------------------------------------------------------

  private async processPendingEvents(workspaceId: string) {
    const events = await this.readPendingEvents(workspaceId)
    for (const event of events) {
      try {
        // Current-state gate: the event payload is a hint, never the source
        // of truth. If the revocation is no longer effective (member
        // re-added, role promoted back, agent member re-enabled), skip the
        // sweep — but still mark the event processed so it is never replayed.
        const effective = await this.isRevocationEffective(event)
        if (effective) await this.sweepForEvent(event)
        await this.markProcessed(event.id)
      } catch (error) {
        // Unexpected error: count the attempt and leave the event pending so a
        // transient failure recovers. After MAX_EVENT_ATTEMPTS the event is
        // dead-lettered (terminal) instead of retrying forever, so a permanently
        // broken event is inspectable rather than drowning the logs.
        console.error('revocation event processing failed', event.id, error)
        await this.recordFailedAttempt(event.id, error).catch(() => undefined)
      }
    }
  }

  /**
   * Re-checks whether the revocation is still effective RIGHT NOW:
   * - member_removed/member_exit: the user is still absent from the workspace;
   * - role_changed: the current role denies run continuation (viewer is
   *   read-only per the plan §5 matrix; absence also counts);
   * - agent_disabled/agent_removed: the workspace agent member is still
   *   disabled/removed (or the row is gone).
   */
  private async isRevocationEffective(event: PendingRevocationEvent): Promise<boolean> {
    const [workspace] = await this.database<{ type: string }[]>`
      select workspace_type as type from workspaces
       where tenant_id = ${tenantId} and id = ${event.workspaceId} and status = 'active'
    `
    if (!workspace || workspace.type !== 'team') return false

    if (event.kind === 'agent_disabled' || event.kind === 'agent_removed') {
      const agentMemberId = typeof event.payload['agentMemberId'] === 'string'
        ? event.payload['agentMemberId']
        : null
      if (!agentMemberId) return false
      const [member] = await this.database<{ status: string }[]>`
        select status from workspace_agent_members
         where tenant_id = ${tenantId} and workspace_id = ${event.workspaceId} and id = ${agentMemberId}
      `
      // A missing row is treated as still-revoked (the member was removed and
      // never re-added).
      return !member || member.status !== 'available'
    }

    const [member] = await this.database<{ role: string }[]>`
      select member_role as role from workspace_members
       where tenant_id = ${tenantId} and workspace_id = ${event.workspaceId}
         and user_id = ${event.userId}
    `
    if (!member) return true
    if (event.kind === 'role_changed') return member.role === 'viewer'
    // member_removed / member_exit: the user is a member again — no longer effective.
    return false
  }

  private async sweepForEvent(event: PendingRevocationEvent) {
    const reason = revocationReason(event.kind)
    if (event.kind === 'agent_disabled' || event.kind === 'agent_removed') {
      const agentMemberId = typeof event.payload['agentMemberId'] === 'string'
        ? event.payload['agentMemberId']
        : null
      if (!agentMemberId) return
      // Cancel only runs whose session is pinned to the agent version of the
      // disabled/removed member (sessions↔runs join); runs on other versions,
      // other workspaces or other users are untouched.
      const activeRuns = await this.runs.listActiveRunsForAgentMember(tenantId, event.workspaceId, agentMemberId)
      for (const run of activeRuns) {
        await this.orchestration.systemCancelRun(run.id, 'system_revoke', reason)
      }
      return
    }
    const activeRuns = await this.runs.listActiveRunsForWorkspaceUser(tenantId, event.workspaceId, event.userId)
    for (const run of activeRuns) {
      await this.orchestration.systemCancelRun(run.id, 'system_revoke', reason)
    }
  }

  /**
   * Full-workspace re-check of active runs, used on every team_auth_revision
   * change: each run's requesting user is re-authorized against CURRENT
   * membership/role/agent grants, and denied runs are system-cancelled. This
   * is the team_auth_revision leg of the mechanism — it catches mutations
   * whose event row was deduped away and everything committed before process
   * restart. Idempotent: still-authorized runs simply pass.
   */
  private async sweepWorkspaceActiveRuns(workspaceId: string) {
    const activeRuns = await this.runs.listActiveRunsInWorkspace(tenantId, workspaceId)
    for (const run of activeRuns) {
      try {
        const current = await this.authorization.authorizeTeamRunExecution({
          userId: run.requestedBy,
          workspaceId,
          agentVersionId: run.agentVersionId,
        })
        // 项目空间 S0：交付边界是全体现任成员，加入数据范围更小的成员也会收紧授权。
        // 快照里超出当前共同范围的数据范围按撤权处理。
        const scopes = new Set(current.dataScopes)
        if (run.dataScopes.some(scope => !scopes.has(scope))) {
          throw authorizationDenied('空间成员变化后，任务快照超出当前可交付的数据范围')
        }
      } catch (error) {
        // Only a *classified authorization denial* may cancel a run. Any other
        // throw is an infrastructure failure (DB outage/timeout, identity
        // lookup error) and must NOT be read as "revoked" — cancelling on it
        // would mass-cancel every active run in the workspace, exactly the
        // 误删 harm AC-26 guards against. Unclassified errors are logged and
        // left alone; the run is still stopped by the execution-time recheck
        // and the next revision change re-runs this sweep.
        if (!isAuthorizationDenial(error)) {
          console.error('revocation sweep recheck failed (not treated as revocation)', workspaceId, run.id, error)
          continue
        }
        const reason = error instanceof Error ? error.message : String(error)
        await this.orchestration.systemCancelRun(run.id, 'system_revoke', reason)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event bookkeeping
  // -------------------------------------------------------------------------

  private async markProcessed(eventId: string) {
    await this.database`
      update workspace_revocation_events
         set status = 'processed', processed_at = now(), attempts = attempts + 1, last_error = null
       where tenant_id = ${tenantId} and id = ${eventId}
    `
  }

  /**
   * Counts a failed processing attempt and dead-letters the event once it
   * exhausts MAX_EVENT_ATTEMPTS. The increment and the escalation are one
   * statement so concurrent sweeps cannot both write the terminal state.
   */
  private async recordFailedAttempt(eventId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const [updated] = await this.database<{ status: string; attempts: number }[]>`
      update workspace_revocation_events
         set attempts = attempts + 1,
             status = case when attempts + 1 >= ${MAX_EVENT_ATTEMPTS} then 'dead_letter' else 'pending' end,
             last_error = ${message.slice(0, 500)}
       where tenant_id = ${tenantId} and id = ${eventId}
      returning status, attempts
    `
    if (updated?.status === 'dead_letter') {
      console.error('revocation event dead-lettered', eventId, `after ${updated.attempts} attempts`, message)
    }
  }
}

function revocationReason(kind: RevocationEventKind) {
  if (kind === 'member_removed') return '成员已被移出团队空间'
  if (kind === 'member_exit') return '成员已退出团队空间'
  if (kind === 'role_changed') return '角色已调整为只读'
  if (kind === 'agent_disabled') return 'Agent 成员已停用'
  return 'Agent 成员已移出'
}

