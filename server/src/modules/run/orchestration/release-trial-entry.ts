import { invalidRequest } from '../../../domain/request-errors.ts'
import type { ReleaseTrialResult, ReleaseTrialRunner } from '../../agent/release-trial-runner.ts'
import type { RunRecord } from '../run-types.ts'
import type { AttemptDispatcher } from './attempt-dispatcher.ts'
import type { RunCancellation } from './run-cancellation.ts'
import { tenantId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/**
 * Entry point for Agent validation (S3): one validation case through the real Runtime path.
 * Starting a case only creates and queues the Run; the case Attempt waits in the
 * `agent-release-trial` lane (at most two at a time, always leaving one Worker for
 * interactive work). The validation service reads the outcome later.
 */
export class ReleaseTrialEntry implements ReleaseTrialRunner {
  private readonly deps: OrchestrationDependencies
  private readonly dispatcher: AttemptDispatcher
  private readonly cancellation: RunCancellation

  constructor(deps: OrchestrationDependencies, dispatcher: AttemptDispatcher, cancellation: RunCancellation) {
    this.deps = deps
    this.dispatcher = dispatcher
    this.cancellation = cancellation
  }

  /** ReleaseTrialRunner port: validation cancels a case through the same system cancellation. */
  systemCancelRun(runId: string, cause: 'system_revoke', reason?: string) {
    return this.cancellation.systemCancelRun(runId, cause, reason)
  }

  /** Creates the case Run in the validation Session and queues its Attempt; does not wait. */
  async startReleaseTrialCase(input: {
    userId: string
    sessionId: string
    agentVersionId: string
    message: string
    idempotencyKey: string
    timezone?: string
  }): Promise<{ runId: string }> {
    if (!this.deps.agents) throw invalidRequest('验证执行链路未接入：缺少 Agent 运行时服务')
    const run = await this.deps.runs.createRun({
      tenantId, sessionId: input.sessionId, requestedBy: input.userId, idempotencyKey: input.idempotencyKey,
    })
    if (!run.currentAttemptId && run.status === 'queued') {
      await this.deps.conversations.appendMessage({
        sessionId: run.sessionId!, runId: run.id, role: 'user', content: input.message, messageId: `message-user-${run.id}`,
      })
      await this.dispatcher.failUndispatchedRun(run, () => this.dispatchTrialAttempt(
        run, input.userId, input.agentVersionId, input.message, input.timezone,
      ))
    }
    return { runId: run.id }
  }

  async getReleaseTrialResult(runId: string): Promise<ReleaseTrialResult | null> {
    const run = await this.deps.runs.getRun(tenantId, runId)
    if (!run) return null
    const attempt = run.currentAttemptId ? await this.deps.runs.getAttempt(tenantId, run.currentAttemptId) : null
    const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
    const outputs = terminal ? await this.deps.conversations.getRunAssistantOutputs(run.id) : []
    return {
      status: run.status,
      attemptId: run.currentAttemptId ?? null,
      errorCode: attempt?.errorCode ?? null,
      output: outputs.map(output => output.content).join('\n'),
    }
  }

  /**
   * Same Manifest builder as employee runs. Only three things differ: the
   * `agent-release-trial` purpose makes the builder authorize with the Agent's own grants
   * capped by what its audience can reach (no admin roles) and isolates external effects
   * (approval-gated calls are refused, MCP and platform writes return trial_only), and
   * there is no workspace, so no files and, by design, no experience. Knowledge, skills,
   * tools, bindings, approvals, write policy and limits are exactly what production gets.
   */
  private async dispatchTrialAttempt(run: RunRecord, userId: string, agentVersionId: string, message: string, timezone?: string) {
    await this.dispatcher.dispatch(run, {
      prompt: message,
      workspaceId: '',
      agentVersionId,
      userId,
      fileIds: [],
      preparedFiles: [],
      purpose: 'agent-release-trial',
      timezone,
    })
  }
}
