import type { JsonObject } from '../run/run-types.ts'
import type { TaskBudgetInput } from './task-budget-types.ts'

export type TaskSourceType = 'session' | 'automation' | 'api' | 'event' | 'system'
export type TaskStatus = 'accepted' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
export type TaskOperationStatus = 'accepted' | 'completed' | 'failed' | 'unknown'

export interface TaskRecord {
  id: string
  tenantId: string
  requestedBy: string
  sourceType: TaskSourceType
  sourceRef: string | null
  correlationKey: string
  requestDigest: string | null
  budgetScopeTaskId: string
  workspaceId: string | null
  sessionId: string | null
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export interface CreateTaskInput {
  taskId?: string
  tenantId: string
  requestedBy: string
  sourceType: TaskSourceType
  sourceRef?: string | null
  correlationKey: string
  requestDigest?: string | null
  /** PF-06 delegated Tasks will point at the root Task's shared budget scope. */
  budgetScopeTaskId?: string
  budget?: TaskBudgetInput | null
  workspaceId?: string | null
  sessionId?: string | null
}

export interface TaskOperationRecord {
  id: string
  tenantId: string
  taskId: string
  runId: string | null
  attemptId: string | null
  operationKey: string
  actionType: string
  actionRef: string
  parameterDigest: string
  status: TaskOperationStatus
  receipt: JsonObject
  errorCode: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface RegisterTaskOperationInput {
  operationId?: string
  tenantId: string
  taskId: string
  runId?: string | null
  attemptId?: string | null
  operationKey: string
  actionType: string
  actionRef: string
  parameterDigest: string
  receipt?: JsonObject
}

export interface ResolveTaskOperationInput {
  tenantId: string
  operationId: string
  /** accepted records an asynchronous system's acknowledgement without claiming completion. */
  status: TaskOperationStatus
  receipt: JsonObject
  errorCode?: string | null
}
