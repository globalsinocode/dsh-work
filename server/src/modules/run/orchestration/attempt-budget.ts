import type { RuntimeEvent, RuntimeManifest } from '../../runtime/runtime-types.ts'
import type { RunRecord } from '../run-types.ts'
import { notFound } from '../../../domain/request-errors.ts'
import { nonNegativeInteger } from './manifest-helpers.ts'
import { tenantId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/** Task budget: what an Attempt may reserve and what it actually consumed. */
export class AttemptBudget {
  private readonly deps: OrchestrationDependencies

  constructor(deps: OrchestrationDependencies) {
    this.deps = deps
  }

  /** Settles the Attempt against its Task budget from the terminal Runtime event. */
  async settle(
    event: RuntimeEvent,
    terminalStatus: 'succeeded' | 'failed' | 'cancelled',
    output: string,
  ): Promise<void> {
    if (!this.deps.tasks) return
    const attempt = await this.deps.runs.getAttempt(tenantId, event.attempt_id)
    if (!attempt) throw notFound(`Attempt 不存在，不能结算预算：${event.attempt_id}`)
    const reportedInput = nonNegativeInteger(event.safe_metadata['input_tokens'])
    const reportedOutput = nonNegativeInteger(event.safe_metadata['output_tokens'])
    const hasReportedTokens = event.safe_metadata['token_usage_source'] === 'dsh-session-log'
      && reportedInput !== null && reportedOutput !== null
    const elapsed = nonNegativeInteger(event.safe_metadata['elapsed_ms'])
    const toolUsageAvailable = event.safe_metadata['usage_source'] === 'dsh-session-log'
    const toolCalls = toolUsageAvailable
      ? nonNegativeInteger(event.safe_metadata['tool_call_count'])
      : null
    const startedAt = attempt.startedAt ? new Date(attempt.startedAt).getTime() : new Date(attempt.createdAt).getTime()
    const timestampDuration = Math.max(0, Date.parse(event.occurred_at) - startedAt)
    await this.deps.tasks.settleAttemptBudget(tenantId, event.attempt_id, {
      durationMs: elapsed ?? timestampDuration,
      toolCalls,
      outputBytes: Buffer.byteLength(output),
      inputTokens: hasReportedTokens ? reportedInput : null,
      outputTokens: hasReportedTokens ? reportedOutput : null,
      tokenMeasurement: hasReportedTokens ? 'reported' : 'unavailable',
      durationMeasurement: elapsed === null ? 'timestamps' : 'runtime',
      toolMeasurement: toolCalls === null ? 'reserved' : 'runtime',
      outputMeasurement: 'platform',
      terminalStatus,
    })
  }

  /** Budget section of a Manifest: cumulative Task limits plus this Attempt's reservation. */
  async manifest(run: RunRecord, limits: RuntimeManifest['limits']): Promise<RuntimeManifest['budget']> {
    const snapshot = await this.deps.tasks?.getBudgetSnapshot(tenantId, run.taskId)
    return {
      scope_task_id: snapshot?.budgetScopeTaskId ?? run.taskId,
      cumulative_limits: {
        max_duration_ms: snapshot?.limits.maxDurationMs ?? null,
        max_tool_calls: snapshot?.limits.maxToolCalls ?? null,
        max_output_bytes: snapshot?.limits.maxOutputBytes ?? null,
      },
      reservation: {
        duration_ms: limits.timeout_seconds * 1000,
        tool_calls: limits.max_tool_calls,
        output_bytes: limits.max_output_bytes,
      },
      enforcement: {
        duration: 'hard', tool_calls: 'hard', output_bytes: 'hard',
        tokens: 'unsupported', cost: 'unsupported',
      },
    }
  }
}
