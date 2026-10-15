import type { JsonObject, RunRecord } from '../run-types.ts'
import { notFound } from '../../../domain/request-errors.ts'
import { tenantId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/** System-side cancellation and convergence of Runs whose Runtime has no live execution. */
export class RunCancellation {
  private readonly deps: OrchestrationDependencies

  constructor(deps: OrchestrationDependencies) {
    this.deps = deps
  }

  /**
   * System-side cancellation for the revocation pipeline (1A-T5). Deliberately
   * NOT user-gated: it must never call requireWritableRun — a revoked
   * employee is by definition not the actor here. Idempotent convergence by
   * state, mirroring the existing user cancel flow:
   * - terminal (succeeded/failed/cancelled): return the run unchanged;
   * - queued: cancel the attempt + run directly and write a run_events note
   *   (a queued run has no Runtime execution, so runtime.cancel reports
   *   accepted=false and we converge in the database);
   * - running/cancel_requested: call runtime.cancel with the system cause;
   *   the existing adapter event path (run.cancel_requested → run.cancelled)
   *   performs the downstream transitions.
   * Audits through the existing cancel audit pattern with actor 'system'.
   */
  async systemCancelRun(runId: string, cause: 'system_revoke', reason?: string) {
    const run = await this.deps.runs.getRun(tenantId, runId)
    if (!run) throw notFound(`Run 不存在：${runId}`)
    await this.deps.delegation?.cancelActiveDescendants(run.taskId, reason ?? '父任务授权已撤销，终止所有活动子任务')
    if (run.status === 'waiting') {
      if (!this.deps.persistentWait) throw new Error('持久化等待服务未接线')
      await this.deps.persistentWait.cancelRun(run.id, 'system')
      await this.deps.operations?.appendAudit('system', 'run.wait.cancel', runId, 'blocked', `trace-${runId}`, `系统撤权终止等待：${reason ?? '授权已撤销'}`)
      return (await this.deps.runs.getRun(tenantId, runId)) ?? run
    }
    if (!['queued', 'running', 'cancel_requested'].includes(run.status)) return run

    const result = await this.deps.runtime.cancel(runId, 'system', cause)
    const detail = `系统撤权取消：${reason ?? '授权已撤销'}`
    await this.deps.operations?.appendAudit('system', 'run.cancel.request', runId, 'success', `trace-${runId}`, detail)
    // Convergence when the Runtime adapter has NO execution record and reports
    // accepted=false. This covers every non-terminal state that would otherwise
    // be stranded forever:
    //   - 'queued': claimed for accounting but not yet dispatched;
    //   - 'running' (phantom): the scheduler claim sets runs.status='running'
    //     before Runtime.execute() has registered the execution, so a
    //     revocation landing in that window is invisible to the adapter. A real
    //     in-flight execution always has a record, so accepted=false here means
    //     no Runtime work is running and converging in the database is safe;
    //   - 'cancel_requested': already asked to cancel, but the runtime's
    //     terminal event was lost, so nothing else will ever terminate it.
    // The status is re-read under the transition guard so a concurrent real
    // cancellation/completion is never overwritten.
    if (!result.accepted && ['queued', 'running', 'cancel_requested'].includes(run.status)) {
      return (await this.cancelRunBySystem(run.id, cause, reason)) ?? run
    }
    return (await this.deps.runs.getRun(tenantId, runId)) ?? run
  }

  /**
   * Terminal convergence for a system-revoked run whose Runtime adapter has no
   * live execution: cancels the attempt and run, then writes the explanatory
   * run_events note.
   */
  private async cancelRunBySystem(runId: string, cause: 'system_revoke', reason?: string) {
    return this.convergeCancelledRun(runId, current => ({
      attemptId: current.currentAttemptId ?? `attempt-${current.id}`,
      displayMessage: '授权已撤销，任务未执行',
      safeMetadata: { cause, reason: reason ?? '授权已撤销' },
    }))
  }

  /**
   * Cancels the attempt and run of a non-terminal run whose Runtime adapter has
   * no live execution, then writes the explanatory run_events note. Re-reads
   * the status first, so a concurrent completion/cancellation is never
   * overwritten and an already-terminal run is returned untouched.
   */
  async convergeCancelledRun(
    runId: string,
    buildNote: (run: RunRecord) => { attemptId: string; displayMessage: string; safeMetadata: JsonObject },
  ) {
    const current = await this.deps.runs.getRun(tenantId, runId)
    if (!current || !['queued', 'running', 'cancel_requested'].includes(current.status)) return current
    if (current.currentAttemptId) {
      const attempt = await this.deps.runs.getAttempt(tenantId, current.currentAttemptId)
      if (attempt && !['failed', 'cancelled', 'succeeded'].includes(attempt.status)) {
        await this.deps.runs.transitionAttempt(tenantId, current.currentAttemptId, 'cancelled')
      }
    }
    const cancelled = await this.deps.runs.transitionRun(tenantId, runId, 'cancelled')
    if (current.currentAttemptId) {
      await this.deps.persistentWait?.cancelPreparingForAttempt({ runId, attemptId: current.currentAttemptId })
    }
    const note = buildNote(current)
    await this.deps.runs.appendSystemEvent({
      tenantId,
      runId,
      attemptId: note.attemptId,
      eventType: 'run.cancelled',
      displayMessage: note.displayMessage,
      safeMetadata: note.safeMetadata,
      traceId: `trace-${runId}`,
    })
    return cancelled
  }
}
