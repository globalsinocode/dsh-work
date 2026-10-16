/**
 * What Agent release governance needs from run orchestration: run one trial case through the
 * normal Run/Attempt → DSH chain, and cancel trial runs. Defined by the consumer so the agent
 * module does not depend on the run module. Implemented by RunOrchestrationService.
 */
export interface ReleaseTrialRunner {
  runReleaseTrialCase(input: {
    userId: string
    sessionId: string
    draftVersionId: string
    expectedDefinitionFingerprint?: string
    message: string
    idempotencyKey: string
    deadlineMs?: number
  }): Promise<{ runId: string; attemptId: string | null; status: string; output: string; failureReason?: string }>
  systemCancelRun(runId: string, cause: 'system_revoke', reason?: string): Promise<unknown>
}
