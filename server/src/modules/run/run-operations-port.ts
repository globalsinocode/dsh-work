import type { AuditTrail } from '../../domain/audit-trail.ts'
import type { RunAttemptRecord, RunRecord } from './run-types.ts'
import type { AttemptModelUsageLine } from './model-usage-meter-port.ts'

/**
 * What run orchestration needs from operations: audit facts, the Runtime's timeout policy,
 * model usage and tool audit records. Defined here (by the consumer) so the run module does
 * not depend on the admin module. Implemented by PostgresOperationsService.
 */
export interface RunOperationsPort extends AuditTrail {
  getRuntimePolicy(runtimeId: string): Promise<{ timeoutSeconds: number; disabledTools?: readonly string[]; disabledBuiltinSkills?: readonly string[] }>
  recordModelUsage(input: {
    run: RunRecord
    attempt: RunAttemptRecord
    prompt: string
    output: string
    status: 'success' | 'failed' | 'cancelled'
    traceId: string
    inputTokens?: number
    outputTokens?: number
    /** 网关计量（有记录时优先使用，每种请求类型一行）；为空时按会话日志或估算记一行。 */
    gatewayUsage?: readonly AttemptModelUsageLine[]
  }): Promise<unknown>
  recordToolAudit(input: {
    runId: string
    attemptId: string
    traceId: string
    metadata: Record<string, unknown>
    result?: 'success' | 'failed' | 'blocked'
  }): Promise<unknown>
}
