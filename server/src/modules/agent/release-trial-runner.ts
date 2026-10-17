import type { RunState } from '../../domain/run-state.ts'

/**
 * What Agent validation needs from run orchestration: start one validation case through the
 * normal Run/Attempt → DSH chain without waiting, read its outcome later, and cancel it.
 * Defined by the consumer so the agent module does not depend on the run module.
 * Implemented by ReleaseTrialEntry.
 */
export interface ReleaseTrialRunner {
  startReleaseTrialCase(input: {
    userId: string
    sessionId: string
    agentVersionId: string
    message: string
    idempotencyKey: string
    /** A routine case runs in the routine's schedule timezone, as the routine itself will. */
    timezone?: string
  }): Promise<{ runId: string }>
  getReleaseTrialResult(runId: string): Promise<ReleaseTrialResult | null>
  systemCancelRun(runId: string, cause: 'system_revoke', reason?: string): Promise<unknown>
}

export interface ReleaseTrialResult {
  status: RunState
  attemptId: string | null
  /** Attempt error code, e.g. SERVICE_RESTARTED when a restart stopped the case. */
  errorCode: string | null
  output: string
}
