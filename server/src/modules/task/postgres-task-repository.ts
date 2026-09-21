import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { canonicalJson, sha256 } from '../runtime/canonical-json.ts'
import type { TaskRepository } from './task-repository.ts'
import type {
  CreateTaskInput,
  RegisterTaskOperationInput,
  ResolveTaskOperationInput,
  TaskOperationRecord,
  TaskOperationStatus,
  TaskRecord,
  TaskSourceType,
  TaskStatus,
} from './task-types.ts'

interface TaskRow {
  id: string
  tenantId: string
  requestedBy: string
  sourceType: TaskSourceType
  sourceRef: string | null
  correlationKey: string
  workspaceId: string | null
  sessionId: string | null
  status: TaskStatus
  createdAt: Date
  updatedAt: Date
}

interface OperationRow {
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
  receipt: TaskOperationRecord['receipt']
  errorCode: string | null
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
}

export class TaskContractConflictError extends Error {
  readonly code = 'TASK_CONTRACT_CONFLICT'
  readonly status = 409

  constructor(message: string) {
    super(message)
    this.name = 'TaskContractConflictError'
  }
}

/** Canonical digest fixed before an external side effect is accepted. */
export function taskOperationParameterDigest(parameters: unknown): string {
  return sha256(canonicalJson(parameters))
}

export class PostgresTaskRepository implements TaskRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async createTask(input: CreateTaskInput, tx?: DatabaseTransaction): Promise<TaskRecord> {
    const normalized = normalizeTaskInput(input)
    const taskId = input.taskId ?? `task-${randomUUID()}`
    const body = async (sql: DatabaseTransaction) => {
      const [created] = await sql<TaskRow[]>`
        insert into tasks (
          id, tenant_id, requested_by, source_type, source_ref, correlation_key,
          workspace_id, session_id, status
        ) values (
          ${taskId}, ${normalized.tenantId}, ${normalized.requestedBy}, ${normalized.sourceType},
          ${normalized.sourceRef}, ${normalized.correlationKey}, ${normalized.workspaceId},
          ${normalized.sessionId}, 'accepted'
        )
        on conflict (tenant_id, source_type, correlation_key) do nothing
        returning id, tenant_id as "tenantId", requested_by as "requestedBy",
                  source_type as "sourceType", source_ref as "sourceRef",
                  correlation_key as "correlationKey", workspace_id as "workspaceId",
                  session_id as "sessionId", status, created_at as "createdAt", updated_at as "updatedAt"
      `
      if (created) return mapTask(created)
      const [existing] = await sql<TaskRow[]>`
        select id, tenant_id as "tenantId", requested_by as "requestedBy",
               source_type as "sourceType", source_ref as "sourceRef",
               correlation_key as "correlationKey", workspace_id as "workspaceId",
               session_id as "sessionId", status, created_at as "createdAt", updated_at as "updatedAt"
          from tasks
         where tenant_id = ${normalized.tenantId} and source_type = ${normalized.sourceType}
           and correlation_key = ${normalized.correlationKey}
         for update
      `
      if (!existing) throw new Error('幂等 Task 查询失败')
      if (existing.requestedBy !== normalized.requestedBy
        || existing.sourceRef !== normalized.sourceRef
        || existing.workspaceId !== normalized.workspaceId
        || existing.sessionId !== normalized.sessionId) {
        throw new TaskContractConflictError('相同 Task 关联键对应的身份、来源或资源归属不一致')
      }
      return mapTask(existing)
    }
    return tx ? body(tx) : this.database.begin(body)
  }

  async getTask(tenantId: string, taskId: string, tx?: DatabaseTransaction): Promise<TaskRecord | null> {
    const sql = tx ?? this.database
    const [row] = await sql<TaskRow[]>`
      select id, tenant_id as "tenantId", requested_by as "requestedBy",
             source_type as "sourceType", source_ref as "sourceRef",
             correlation_key as "correlationKey", workspace_id as "workspaceId",
             session_id as "sessionId", status, created_at as "createdAt", updated_at as "updatedAt"
        from tasks where tenant_id = ${tenantId} and id = ${taskId}
    `
    return row ? mapTask(row) : null
  }

  async registerOperation(input: RegisterTaskOperationInput, tx?: DatabaseTransaction): Promise<TaskOperationRecord> {
    const normalized = normalizeOperationInput(input)
    const operationId = input.operationId ?? `operation-${randomUUID()}`
    const body = async (sql: DatabaseTransaction) => {
      const [created] = await sql<OperationRow[]>`
        insert into task_operations (
          id, tenant_id, task_id, run_id, attempt_id, operation_key,
          action_type, action_ref, parameter_digest, status, receipt
        ) values (
          ${operationId}, ${normalized.tenantId}, ${normalized.taskId}, ${normalized.runId},
          ${normalized.attemptId}, ${normalized.operationKey}, ${normalized.actionType},
          ${normalized.actionRef}, ${normalized.parameterDigest}, 'accepted', ${sql.json(normalized.receipt)}
        )
        on conflict (tenant_id, task_id, operation_key) do nothing
        returning id, tenant_id as "tenantId", task_id as "taskId", run_id as "runId",
                  attempt_id as "attemptId", operation_key as "operationKey", action_type as "actionType",
                  action_ref as "actionRef", parameter_digest as "parameterDigest", status, receipt,
                  error_code as "errorCode", created_at as "createdAt", updated_at as "updatedAt",
                  resolved_at as "resolvedAt"
      `
      if (created) return mapOperation(created)
      const [existing] = await sql<OperationRow[]>`
        select id, tenant_id as "tenantId", task_id as "taskId", run_id as "runId",
               attempt_id as "attemptId", operation_key as "operationKey", action_type as "actionType",
               action_ref as "actionRef", parameter_digest as "parameterDigest", status, receipt,
               error_code as "errorCode", created_at as "createdAt", updated_at as "updatedAt",
               resolved_at as "resolvedAt"
          from task_operations
         where tenant_id = ${normalized.tenantId} and task_id = ${normalized.taskId}
           and operation_key = ${normalized.operationKey}
         for update
      `
      if (!existing) throw new Error('幂等外部操作查询失败')
      if (existing.runId !== normalized.runId || existing.attemptId !== normalized.attemptId
        || existing.actionType !== normalized.actionType || existing.actionRef !== normalized.actionRef
        || existing.parameterDigest !== normalized.parameterDigest) {
        throw new TaskContractConflictError('相同操作键对应的动作、参数或执行来源不一致')
      }
      return mapOperation(existing)
    }
    return tx ? body(tx) : this.database.begin(body)
  }

  async getOperation(tenantId: string, operationId: string): Promise<TaskOperationRecord | null> {
    const [row] = await this.database<OperationRow[]>`
      select id, tenant_id as "tenantId", task_id as "taskId", run_id as "runId",
             attempt_id as "attemptId", operation_key as "operationKey", action_type as "actionType",
             action_ref as "actionRef", parameter_digest as "parameterDigest", status, receipt,
             error_code as "errorCode", created_at as "createdAt", updated_at as "updatedAt",
             resolved_at as "resolvedAt"
        from task_operations where tenant_id = ${tenantId} and id = ${operationId}
    `
    return row ? mapOperation(row) : null
  }

  async listOperations(tenantId: string, taskId: string): Promise<TaskOperationRecord[]> {
    const rows = await this.database<OperationRow[]>`
      select id, tenant_id as "tenantId", task_id as "taskId", run_id as "runId",
             attempt_id as "attemptId", operation_key as "operationKey", action_type as "actionType",
             action_ref as "actionRef", parameter_digest as "parameterDigest", status, receipt,
             error_code as "errorCode", created_at as "createdAt", updated_at as "updatedAt",
             resolved_at as "resolvedAt"
        from task_operations
       where tenant_id = ${tenantId} and task_id = ${taskId}
       order by created_at asc, id asc
    `
    return rows.map(mapOperation)
  }

  async resolveOperation(input: ResolveTaskOperationInput): Promise<TaskOperationRecord> {
    if (input.status === 'failed' && !input.errorCode?.trim()) {
      throw new TypeError('failed 操作必须提供 errorCode')
    }
    if (input.status !== 'failed' && input.errorCode != null) {
      throw new TypeError('只有 failed 操作可以提供 errorCode')
    }
    return this.database.begin(async (sql) => {
      const [current] = await sql<OperationRow[]>`
        select id, tenant_id as "tenantId", task_id as "taskId", run_id as "runId",
               attempt_id as "attemptId", operation_key as "operationKey", action_type as "actionType",
               action_ref as "actionRef", parameter_digest as "parameterDigest", status, receipt,
               error_code as "errorCode", created_at as "createdAt", updated_at as "updatedAt",
               resolved_at as "resolvedAt"
          from task_operations
         where tenant_id = ${input.tenantId} and id = ${input.operationId}
         for update
      `
      if (!current) throw new Error(`外部操作不存在：${input.operationId}`)
      if (current.status === input.status) {
        if (current.errorCode !== (input.errorCode ?? null) || canonicalJson(current.receipt) !== canonicalJson(input.receipt)) {
          throw new TaskContractConflictError('外部操作终态已记录且回执不同')
        }
        return mapOperation(current)
      }
      const allowed = current.status === 'accepted'
        || (current.status === 'unknown' && (input.status === 'completed' || input.status === 'failed'))
      if (!allowed || current.status === 'completed' || current.status === 'failed') {
        throw new TaskContractConflictError(`外部操作不能从 ${current.status} 转换为 ${input.status}`)
      }
      const [updated] = await sql<OperationRow[]>`
        update task_operations
           set status = ${input.status}, receipt = ${sql.json(input.receipt)},
               error_code = ${input.errorCode ?? null}, updated_at = now(),
               resolved_at = case when ${input.status} in ('completed', 'failed') then now() else null end
         where tenant_id = ${input.tenantId} and id = ${input.operationId}
        returning id, tenant_id as "tenantId", task_id as "taskId", run_id as "runId",
                  attempt_id as "attemptId", operation_key as "operationKey", action_type as "actionType",
                  action_ref as "actionRef", parameter_digest as "parameterDigest", status, receipt,
                  error_code as "errorCode", created_at as "createdAt", updated_at as "updatedAt",
                  resolved_at as "resolvedAt"
      `
      if (!updated) throw new Error('外部操作状态更新失败')
      return mapOperation(updated)
    })
  }
}

function normalizeTaskInput(input: CreateTaskInput) {
  const correlationKey = input.correlationKey.trim()
  if (!correlationKey || correlationKey.length > 200) throw new TypeError('Task correlationKey 长度必须为 1～200')
  const sourceRef = input.sourceRef?.trim() || null
  const sessionId = input.sessionId?.trim() || null
  if (input.sourceType === 'session' && !sessionId) throw new TypeError('session 来源的 Task 必须固定 sessionId')
  return {
    ...input,
    sourceRef,
    correlationKey,
    workspaceId: input.workspaceId?.trim() || null,
    sessionId,
  }
}

function normalizeOperationInput(input: RegisterTaskOperationInput) {
  const operationKey = input.operationKey.trim()
  const actionType = input.actionType.trim()
  const actionRef = input.actionRef.trim()
  if (!operationKey || operationKey.length > 200) throw new TypeError('operationKey 长度必须为 1～200')
  if (!actionType || actionType.length > 100) throw new TypeError('actionType 长度必须为 1～100')
  if (!actionRef || actionRef.length > 200) throw new TypeError('actionRef 长度必须为 1～200')
  if (!/^[a-f0-9]{64}$/.test(input.parameterDigest)) throw new TypeError('parameterDigest 必须是小写 sha256')
  if (input.attemptId && !input.runId) throw new TypeError('attemptId 必须与 runId 一起提供')
  return {
    ...input,
    runId: input.runId ?? null,
    attemptId: input.attemptId ?? null,
    operationKey,
    actionType,
    actionRef,
    receipt: input.receipt ?? {},
  }
}

function mapTask(row: TaskRow): TaskRecord {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

function mapOperation(row: OperationRow): TaskOperationRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }
}
