import type { DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type {
  AttemptState,
  CreateAttemptInput,
  CreateRunInput,
  JsonObject,
  RunAttemptRecord,
  RunRecord,
  RunState,
  StoredRunEvent,
} from './run-types.ts'

export interface RestartRecoveryResult {
  failed: Array<{ runId: string; attemptId: string }>
  queued: Array<{ run: RunRecord; attempt: RunAttemptRecord }>
}

/** An active run in a team workspace with its session's pinned agent version (1A-T5 sweep). */
export type WorkspaceActiveRun = RunRecord & { agentVersionId: string }

export interface AppendSystemEventInput {
  tenantId: string
  runId: string
  attemptId: string
  eventType: string
  displayMessage: string | null
  safeMetadata?: JsonObject
  traceId: string
  occurredAt?: string
}

export interface RunRepository {
  createRun(input: CreateRunInput, tx?: DatabaseTransaction): Promise<RunRecord>
  getRun(tenantId: string, runId: string): Promise<RunRecord | null>
  getRunForTask(tenantId: string, taskId: string): Promise<RunRecord | null>
  getAttempt(tenantId: string, attemptId: string): Promise<RunAttemptRecord | null>
  /** One-time PF-02 upgrade for a trusted queued manifest persisted before budget snapshots existed. */
  upgradeQueuedAttemptManifest(
    tenantId: string,
    attemptId: string,
    manifest: JsonObject,
    manifestSha256: string,
  ): Promise<void>
  createAttempt(input: CreateAttemptInput): Promise<RunAttemptRecord>
  claimAttempt(
    tenantId: string,
    attemptId: string,
    runtimeId: string,
    options?: { automationMaxConcurrent?: number },
  ): Promise<boolean>
  /**
   * AG-03 车道占用读数：自动任务有效并发上限（min(配置, capacity-1)，
   * 为交互保留一路）与当前占用（含 cancel_requested 未释放的 Worker）。
   * `exists=false`（Runtime 行缺失）或 `accepting=false`（暂停接活）都是
   * 部署/运维状态——调用方应留队重排而非把排队 Run 收敛为容量失败；
   * 只有 `exists && accepting && allowed <= 0` 才是确定的容量收敛条件。
   */
  automationLaneUsage(
    tenantId: string,
    runtimeId: string,
    configuredMax: number,
  ): Promise<{ allowed: number; running: number; exists: boolean; accepting: boolean }>
  /**
   * AG-03 条件收敛：仅当 Run 仍停在「无 Attempt 的 queued」时落终态。
   */
  convergeUndispatchedRun(tenantId: string, runId: string, to: 'failed' | 'cancelled'): Promise<boolean>
  /**
   * AG-03 暂停/停用清理：原子取消 queued Run（含其 queued Attempt）；
   * Attempt 已被领取或 Run 已离开 queued 时返回 false。
   */
  cancelQueuedRun(tenantId: string, runId: string, tx?: DatabaseTransaction): Promise<boolean>
  /**
   * 3-T2: workspace status behind an attempt (attempt → run → session → workspace).
   * Returns null when the chain is missing. Used by the scheduler to converge a
   * queued attempt whose workspace was archived while it waited, instead of
   * rescheduling it forever.
   */
  workspaceStatusForAttempt(tenantId: string, attemptId: string): Promise<'active' | 'archived' | null>
  transitionRun(tenantId: string, runId: string, to: RunState): Promise<RunRecord>
  transitionAttempt(
    tenantId: string,
    attemptId: string,
    to: AttemptState,
    errorCode?: string,
  ): Promise<RunAttemptRecord>
  appendEvent(event: StoredRunEvent): Promise<StoredRunEvent>
  /** Appends a server-authored event, computing the next per-attempt sequence transactionally. */
  appendSystemEvent(input: AppendSystemEventInput): Promise<StoredRunEvent>
  readEvents(tenantId: string, runId: string, afterSequence?: number): Promise<StoredRunEvent[]>
  readEventsAfterEvent(tenantId: string, runId: string, afterEventId?: string): Promise<StoredRunEvent[]>
  recoverAfterRestart(tenantId: string, runtimeId: string): Promise<RestartRecoveryResult>
  /**
   * Active (queued/running/waiting/cancel_requested) runs of one user in one
   * workspace, joined through sessions (1A-T5 revocation sweep).
   */
  listActiveRunsForWorkspaceUser(tenantId: string, workspaceId: string, userId: string): Promise<RunRecord[]>
  /**
   * Active runs whose session is pinned to the agent version of the given
   * workspace agent member (1A-T5 agent revocation sweep).
   */
  listActiveRunsForAgentMember(tenantId: string, workspaceId: string, agentMemberId: string): Promise<RunRecord[]>
  /** All active runs in a workspace with the session's pinned agent version. */
  listActiveRunsInWorkspace(tenantId: string, workspaceId: string): Promise<WorkspaceActiveRun[]>
}
