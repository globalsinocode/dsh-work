import type { JsonObject, JsonValue, RunState } from '../../domain/run-state.ts'

export type { JsonObject, JsonValue, RunState }
import type { TaskBudgetInput } from '../task/task-budget-types.ts'

export type AttemptState = RunState

export interface RunRecord {
  id: string
  tenantId: string
  /** PF-01 stable business task envelope. */
  taskId: string
  /** Product conversation context. Null for API/event/system Task execution. */
  sessionId: string | null
  requestedBy: string
  idempotencyKey: string
  status: RunState
  currentAttemptId: string | null
  createdAt: string
  updatedAt: string
}

export interface RunAttemptRecord {
  id: string
  tenantId: string
  runId: string
  attemptNo: number
  runtimeId: string | null
  manifest: JsonObject
  manifestSha256: string
  modelRouteSnapshot: JsonObject
  status: AttemptState
  startedAt: string | null
  endedAt: string | null
  errorCode: string | null
  createdAt: string
}

export interface StoredRunEvent {
  id: string
  tenantId: string
  runId: string
  attemptId: string
  sequence: number
  eventType: string
  displayMessage: string | null
  safeMetadata: JsonObject
  traceId: string
  occurredAt: string
  streamPosition?: number
}

export interface CreateRunInput {
  tenantId: string
  sessionId: string | null
  requestedBy: string
  idempotencyKey: string
  /** Existing callers omit this and receive an idempotent session-backed Task. */
  taskId?: string
  taskSourceType?: 'session' | 'automation' | 'api' | 'event' | 'system' | 'delegation' | 'agent_routine'
  taskSourceRef?: string | null
  taskCorrelationKey?: string
  taskRequestDigest?: string | null
  taskBudget?: TaskBudgetInput | null
  /** Required when sessionId is null; checked against the Task owner workspace. */
  workspaceId?: string | null
  /**
   * 项目空间任务线程：同一 Session 同一时间只允许一个活动 Run。在 Session 行锁内复核，
   * 有其他活动 Run 时以 conflictMessage 拒绝（幂等重放不受影响）。
   */
  requireIdleSession?: { conflictMessage: string }
}

export interface CreateAttemptInput {
  attemptId?: string
  tenantId: string
  runId: string
  runtimeId?: string
  manifest: JsonObject
  manifestSha256: string
  modelRouteSnapshot: JsonObject
  knowledgeSources?: Array<{
    documentId: string
    relevanceScore: number
    excerpt: string
  }>
  memorySources?: Array<{
    memoryVersionId: string
    relevanceScore: number
    excerpt: string
  }>
  inputFiles?: Array<{
    fileId: string
    extractionId: string
    mountPath: string
  }>
}
