import type { RunState } from '../../domain/run-state.ts'

/**
 * What Agent release governance and validation need from run orchestration.
 * Implemented by ReleaseTrialEntry on RunOrchestrationService.
 */
export interface ReleaseTrialResult {
  status: RunState
  attemptId: string | null
  /** Attempt error code, e.g. SERVICE_RESTARTED when a restart stopped the case. */
  errorCode: string | null
  output: string
}

export interface ReleaseTrialRunner {
  /** 发布治理：阻塞等待试运行终态并返回完整结果。 */
  runReleaseTrialCase(input: {
    userId: string
    sessionId: string
    draftVersionId: string
    expectedDefinitionFingerprint?: string
    message: string
    idempotencyKey: string
    deadlineMs?: number
  }): Promise<{ runId: string; attemptId: string | null; status: string; output: string; failureReason?: string }>
  /** Agent 验证：异步启动案例，稍后通过 getReleaseTrialResult 读取终态。 */
  startReleaseTrialCase(input: {
    userId: string
    sessionId: string
    agentVersionId: string
    message: string
    idempotencyKey: string
    timezone?: string
  }): Promise<{ runId: string }>
  getReleaseTrialResult(runId: string): Promise<ReleaseTrialResult | null>
  systemCancelRun(runId: string, cause: 'system_revoke', reason?: string): Promise<unknown>
}
