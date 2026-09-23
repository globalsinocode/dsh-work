import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { canonicalJson, sha256 } from '../runtime/canonical-json.ts'
import type { TaskRepository } from './task-repository.ts'
import {
  normalizeTaskBudget,
  taskBudgetCapabilities,
  type AttemptBudgetSettlement,
  type AttemptBudgetUsageRecord,
  type TaskBudgetLimits,
} from './task-budget-types.ts'
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
  initiatedByPrincipalId: string
  executedAsPrincipalId: string | null
  approvedByPrincipalId: string | null
  sourceType: TaskSourceType
  sourceRef: string | null
  correlationKey: string
  requestDigest: string | null
  budgetScopeTaskId: string
  workspaceId: string | null
  sessionId: string | null
  status: TaskStatus
  createdAt: Date
  updatedAt: Date
}

interface BudgetAccountRow {
  budgetScopeTaskId: string
  maxDurationMs: number | null
  maxToolCalls: number | null
  maxOutputBytes: number | null
}

interface BudgetUsageRow {
  id: string
  tenantId: string
  budgetScopeTaskId: string
  taskId: string
  runId: string
  attemptId: string
  status: AttemptBudgetUsageRecord['status']
  reservedDurationMs: number
  reservedToolCalls: number
  reservedOutputBytes: number
  actualDurationMs: number | null
  actualToolCalls: number | null
  actualOutputBytes: number | null
  inputTokens: number | null
  outputTokens: number | null
  costAmount: string | null
  costCurrency: string | null
  tokenMeasurement: AttemptBudgetUsageRecord['measurement']['tokens']
  costMeasurement: AttemptBudgetUsageRecord['measurement']['cost']
  durationMeasurement: AttemptBudgetUsageRecord['measurement']['duration']
  toolMeasurement: AttemptBudgetUsageRecord['measurement']['toolCalls']
  outputMeasurement: AttemptBudgetUsageRecord['measurement']['outputBytes']
  terminalStatus: AttemptBudgetUsageRecord['terminalStatus']
  createdAt: Date
  settledAt: Date | null
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

/** Memory proposals belong to their source Attempt; other writes retain Task-level deduplication. */
export function platformToolOperationKey(toolName: string, parameterDigest: string, attemptId: string): string {
  return `tool:${taskOperationParameterDigest({
    tool: toolName,
    parameterDigest,
    ...(toolName === 'propose_memory' ? { attemptId } : {}),
  })}`
}

export class PostgresTaskRepository implements TaskRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async createTask(input: CreateTaskInput, tx?: DatabaseTransaction): Promise<TaskRecord> {
    const normalized = normalizeTaskInput(input)
    const taskId = input.taskId ?? `task-${randomUUID()}`
    const budgetScopeTaskId = input.budgetScopeTaskId?.trim() || taskId
    const budget = normalizeTaskBudget(input.budget)
    const body = async (sql: DatabaseTransaction) => {
      const [created] = await sql<TaskRow[]>`
        insert into tasks (
          id, tenant_id, requested_by, source_type, source_ref, correlation_key,
          request_digest, budget_scope_task_id, workspace_id, session_id, status
        ) values (
          ${taskId}, ${normalized.tenantId}, ${normalized.requestedBy}, ${normalized.sourceType},
          ${normalized.sourceRef}, ${normalized.correlationKey}, ${normalized.requestDigest}, ${budgetScopeTaskId}, ${normalized.workspaceId},
          ${normalized.sessionId}, 'accepted'
        )
        on conflict (tenant_id, source_type, correlation_key) do nothing
        returning id, tenant_id as "tenantId", requested_by as "requestedBy",
                  initiated_by_principal_id as "initiatedByPrincipalId",
                  executed_as_principal_id as "executedAsPrincipalId",
                  approved_by_principal_id as "approvedByPrincipalId",
                  source_type as "sourceType", source_ref as "sourceRef",
                  correlation_key as "correlationKey", request_digest as "requestDigest",
                  budget_scope_task_id as "budgetScopeTaskId", workspace_id as "workspaceId",
                  session_id as "sessionId", status, created_at as "createdAt", updated_at as "updatedAt"
      `
      if (created) {
        await ensureBudgetAccount(sql, normalized.tenantId, budgetScopeTaskId, taskId, budget)
        return mapTask(created)
      }
      const [existing] = await sql<TaskRow[]>`
        select id, tenant_id as "tenantId", requested_by as "requestedBy",
               initiated_by_principal_id as "initiatedByPrincipalId",
               executed_as_principal_id as "executedAsPrincipalId",
               approved_by_principal_id as "approvedByPrincipalId",
               source_type as "sourceType", source_ref as "sourceRef",
               correlation_key as "correlationKey", request_digest as "requestDigest",
               budget_scope_task_id as "budgetScopeTaskId", workspace_id as "workspaceId",
               session_id as "sessionId", status, created_at as "createdAt", updated_at as "updatedAt"
          from tasks
         where tenant_id = ${normalized.tenantId} and source_type = ${normalized.sourceType}
           and correlation_key = ${normalized.correlationKey}
         for update
      `
      if (!existing) throw new Error('幂等 Task 查询失败')
      if (existing.requestedBy !== normalized.requestedBy
        || existing.sourceRef !== normalized.sourceRef
        || existing.requestDigest !== normalized.requestDigest
        || (input.budgetScopeTaskId !== undefined && existing.budgetScopeTaskId !== budgetScopeTaskId)
        || existing.workspaceId !== normalized.workspaceId
        || existing.sessionId !== normalized.sessionId) {
        throw new TaskContractConflictError('相同 Task 关联键对应的身份、来源或资源归属不一致')
      }
      await ensureBudgetAccount(sql, normalized.tenantId, existing.budgetScopeTaskId, existing.id, budget)
      return mapTask(existing)
    }
    return tx ? body(tx) : this.database.begin(body)
  }

  async getTask(tenantId: string, taskId: string, tx?: DatabaseTransaction): Promise<TaskRecord | null> {
    const sql = tx ?? this.database
    const [row] = await sql<TaskRow[]>`
      select id, tenant_id as "tenantId", requested_by as "requestedBy",
             initiated_by_principal_id as "initiatedByPrincipalId",
             executed_as_principal_id as "executedAsPrincipalId",
             approved_by_principal_id as "approvedByPrincipalId",
             source_type as "sourceType", source_ref as "sourceRef",
             correlation_key as "correlationKey", request_digest as "requestDigest",
             budget_scope_task_id as "budgetScopeTaskId", workspace_id as "workspaceId",
             session_id as "sessionId", status, created_at as "createdAt", updated_at as "updatedAt"
        from tasks where tenant_id = ${tenantId} and id = ${taskId}
    `
    return row ? mapTask(row) : null
  }

  async getBudgetSnapshot(tenantId: string, taskId: string, tx?: DatabaseTransaction) {
    const sql = tx ?? this.database
    const [row] = await sql<BudgetAccountRow[]>`
      select a.budget_scope_task_id as "budgetScopeTaskId",
             a.max_duration_ms::integer as "maxDurationMs",
             a.max_tool_calls::integer as "maxToolCalls",
             a.max_output_bytes::integer as "maxOutputBytes"
        from tasks t
        join task_budget_accounts a
          on a.tenant_id = t.tenant_id and a.budget_scope_task_id = t.budget_scope_task_id
       where t.tenant_id = ${tenantId} and t.id = ${taskId}
    `
    return row ? {
      budgetScopeTaskId: row.budgetScopeTaskId,
      limits: budgetLimits(row),
      capabilities: taskBudgetCapabilities,
    } : null
  }

  async getBudgetView(tenantId: string, taskId: string) {
    const snapshot = await this.getBudgetSnapshot(tenantId, taskId)
    if (!snapshot) return null
    const rows = await this.database<BudgetUsageRow[]>`
      select id, tenant_id as "tenantId", budget_scope_task_id as "budgetScopeTaskId",
             task_id as "taskId", run_id as "runId", attempt_id as "attemptId", status,
             reserved_duration_ms::integer as "reservedDurationMs",
             reserved_tool_calls::integer as "reservedToolCalls",
             reserved_output_bytes::integer as "reservedOutputBytes",
             actual_duration_ms::integer as "actualDurationMs",
             actual_tool_calls::integer as "actualToolCalls",
             actual_output_bytes::integer as "actualOutputBytes",
             input_tokens::integer as "inputTokens", output_tokens::integer as "outputTokens",
             cost_amount::text as "costAmount", cost_currency as "costCurrency",
             token_measurement as "tokenMeasurement", cost_measurement as "costMeasurement",
             duration_measurement as "durationMeasurement", tool_measurement as "toolMeasurement",
             output_measurement as "outputMeasurement", terminal_status as "terminalStatus",
             created_at as "createdAt", settled_at as "settledAt"
        from attempt_budget_usage
       where tenant_id = ${tenantId} and budget_scope_task_id = ${snapshot.budgetScopeTaskId}
       order by created_at asc, id asc
    `
    const attempts = rows.map(mapBudgetUsage)
    const settled = attempts.filter(item => item.status !== 'reserved')
    const charged = attempts.filter(item => item.status === 'settled')
    const active = attempts.filter(item => item.status === 'reserved')
    const tokensReported = charged.length > 0 && charged.every(item => item.measurement.tokens === 'reported')
    const usage = {
      durationMs: sum(settled, item => item.actual.durationMs ?? 0),
      toolCalls: sum(settled, item => item.actual.toolCalls ?? 0),
      outputBytes: sum(settled, item => item.actual.outputBytes ?? 0),
      inputTokens: tokensReported ? sum(charged, item => item.actual.inputTokens ?? 0) : null,
      outputTokens: tokensReported ? sum(charged, item => item.actual.outputTokens ?? 0) : null,
      tokenMeasurement: tokensReported ? 'reported' as const : 'unavailable' as const,
      costAmount: null,
      costCurrency: null,
    } as const
    const reserved = {
      durationMs: sum(active, item => item.reserved.durationMs),
      toolCalls: sum(active, item => item.reserved.toolCalls),
      outputBytes: sum(active, item => item.reserved.outputBytes),
    }
    return {
      scopeTaskId: snapshot.budgetScopeTaskId,
      limits: snapshot.limits,
      capabilities: snapshot.capabilities,
      usage,
      reserved,
      remaining: {
        durationMs: remaining(snapshot.limits.maxDurationMs, usage.durationMs, reserved.durationMs),
        toolCalls: remaining(snapshot.limits.maxToolCalls, usage.toolCalls, reserved.toolCalls),
        outputBytes: remaining(snapshot.limits.maxOutputBytes, usage.outputBytes, reserved.outputBytes),
      },
      attempts,
    }
  }

  async settleAttemptBudget(tenantId: string, attemptId: string, settlement: AttemptBudgetSettlement): Promise<void> {
    await this.database.begin(async sql => {
      const [peek] = await sql<Pick<BudgetUsageRow, 'budgetScopeTaskId'>[]>`
        select budget_scope_task_id as "budgetScopeTaskId"
          from attempt_budget_usage
         where tenant_id = ${tenantId} and attempt_id = ${attemptId}
      `
      if (!peek) throw new Error(`Attempt 预算预占不存在：${attemptId}`)
      // The fallback trigger locks the account before updating the usage row.
      // Keep the same order here so cancellation and precise settlement cannot
      // form an account-row/usage-row deadlock.
      await sql`select 1 from task_budget_accounts
        where tenant_id = ${tenantId} and budget_scope_task_id = ${peek.budgetScopeTaskId} for update`
      const [current] = await sql<BudgetUsageRow[]>`
        select id, tenant_id as "tenantId", budget_scope_task_id as "budgetScopeTaskId",
               task_id as "taskId", run_id as "runId", attempt_id as "attemptId", status,
               reserved_duration_ms::integer as "reservedDurationMs",
               reserved_tool_calls::integer as "reservedToolCalls",
               reserved_output_bytes::integer as "reservedOutputBytes",
               actual_duration_ms::integer as "actualDurationMs", actual_tool_calls::integer as "actualToolCalls",
               actual_output_bytes::integer as "actualOutputBytes", input_tokens::integer as "inputTokens",
               output_tokens::integer as "outputTokens", cost_amount::text as "costAmount", cost_currency as "costCurrency",
               token_measurement as "tokenMeasurement", cost_measurement as "costMeasurement",
               duration_measurement as "durationMeasurement", tool_measurement as "toolMeasurement",
               output_measurement as "outputMeasurement", terminal_status as "terminalStatus",
               created_at as "createdAt", settled_at as "settledAt"
          from attempt_budget_usage
         where tenant_id = ${tenantId} and attempt_id = ${attemptId}
         for update
      `
      if (!current) throw new Error(`Attempt 预算预占不存在：${attemptId}`)
      if (current.status !== 'reserved') return
      const actualDurationMs = Math.min(settlement.durationMs, current.reservedDurationMs)
      const reportedToolCalls = settlement.toolCalls ?? current.reservedToolCalls
      const actualToolCalls = Math.min(reportedToolCalls, current.reservedToolCalls)
      const actualOutputBytes = Math.min(settlement.outputBytes, current.reservedOutputBytes)
      await sql`
        update attempt_budget_usage
           set status = 'settled', actual_duration_ms = ${actualDurationMs},
               actual_tool_calls = ${actualToolCalls}, actual_output_bytes = ${actualOutputBytes},
               input_tokens = ${settlement.inputTokens}, output_tokens = ${settlement.outputTokens},
               cost_amount = null, cost_currency = null,
               token_measurement = ${settlement.tokenMeasurement}, cost_measurement = 'unavailable',
               duration_measurement = ${settlement.durationMs > current.reservedDurationMs ? 'reserved' : settlement.durationMeasurement},
               tool_measurement = ${reportedToolCalls > current.reservedToolCalls ? 'reserved' : settlement.toolMeasurement},
               output_measurement = ${settlement.outputBytes > current.reservedOutputBytes ? 'reserved' : settlement.outputMeasurement},
               terminal_status = ${settlement.terminalStatus}, settled_at = now()
         where tenant_id = ${tenantId} and attempt_id = ${attemptId} and status = 'reserved'
      `
    })
  }

  async registerOperation(input: RegisterTaskOperationInput, tx?: DatabaseTransaction): Promise<TaskOperationRecord> {
    return (await this.acceptOperation(input, tx)).operation
  }

  async acceptOperation(input: RegisterTaskOperationInput, tx?: DatabaseTransaction): Promise<{ operation: TaskOperationRecord; created: boolean }> {
    const normalized = normalizeOperationInput(input)
    const operationId = input.operationId ?? `operation-${randomUUID()}`
    const body = async (sql: DatabaseTransaction) => {
      const [created] = await sql<OperationRow[]>`
        insert into task_operations (
          id, tenant_id, task_id, run_id, attempt_id, operation_key,
          action_type, action_ref, parameter_digest, status, receipt, executor_principal_id
        ) values (
          ${operationId}, ${normalized.tenantId}, ${normalized.taskId}, ${normalized.runId},
          ${normalized.attemptId}, ${normalized.operationKey}, ${normalized.actionType},
          ${normalized.actionRef}, ${normalized.parameterDigest}, 'accepted', ${sql.json(normalized.receipt)},
          ${normalized.attemptId ? sql`(select executed_as_principal_id from tasks where tenant_id = ${normalized.tenantId} and id = ${normalized.taskId})` : null}
        )
        on conflict (tenant_id, task_id, operation_key) do nothing
        returning id, tenant_id as "tenantId", task_id as "taskId", run_id as "runId",
                  attempt_id as "attemptId", operation_key as "operationKey", action_type as "actionType",
                  action_ref as "actionRef", parameter_digest as "parameterDigest", status, receipt,
                  error_code as "errorCode", created_at as "createdAt", updated_at as "updatedAt",
                  resolved_at as "resolvedAt"
      `
      if (created) return { operation: mapOperation(created), created: true }
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
      if (existing.actionType !== normalized.actionType || existing.actionRef !== normalized.actionRef
        || existing.parameterDigest !== normalized.parameterDigest) {
        throw new TaskContractConflictError('相同操作键对应的动作或参数不一致')
      }
      return { operation: mapOperation(existing), created: false }
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
      if (current.status === input.status && input.status !== 'accepted') {
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
  const requestDigest = input.requestDigest?.trim() || null
  if (input.sourceType === 'session' && !sessionId) throw new TypeError('session 来源的 Task 必须固定 sessionId')
  if (requestDigest && !/^[a-f0-9]{64}$/.test(requestDigest)) throw new TypeError('Task requestDigest 必须是小写 sha256')
  return {
    ...input,
    sourceRef,
    correlationKey,
    requestDigest,
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

async function ensureBudgetAccount(
  sql: DatabaseTransaction,
  tenantId: string,
  budgetScopeTaskId: string,
  taskId: string,
  limits: TaskBudgetLimits,
): Promise<void> {
  if (budgetScopeTaskId !== taskId && (
    limits.maxDurationMs !== null || limits.maxToolCalls !== null || limits.maxOutputBytes !== null
  )) {
    throw new TaskContractConflictError('共享预算范围的子 Task 不能重新定义根预算')
  }
  if (budgetScopeTaskId === taskId) {
    await sql`
      insert into task_budget_accounts (
        tenant_id, budget_scope_task_id, max_duration_ms, max_tool_calls, max_output_bytes
      ) values (
        ${tenantId}, ${budgetScopeTaskId}, ${limits.maxDurationMs}, ${limits.maxToolCalls}, ${limits.maxOutputBytes}
      ) on conflict (tenant_id, budget_scope_task_id) do nothing
    `
  }
  const [account] = await sql<BudgetAccountRow[]>`
    select budget_scope_task_id as "budgetScopeTaskId",
           max_duration_ms::integer as "maxDurationMs",
           max_tool_calls::integer as "maxToolCalls",
           max_output_bytes::integer as "maxOutputBytes"
      from task_budget_accounts
     where tenant_id = ${tenantId} and budget_scope_task_id = ${budgetScopeTaskId}
     for update
  `
  if (!account) throw new TaskContractConflictError('Task 预算范围不存在')
  if (budgetScopeTaskId === taskId && (
    account.maxDurationMs !== limits.maxDurationMs
    || account.maxToolCalls !== limits.maxToolCalls
    || account.maxOutputBytes !== limits.maxOutputBytes
  )) {
    throw new TaskContractConflictError('相同 Task 关联键对应的累计预算不一致')
  }
}

function budgetLimits(row: BudgetAccountRow): TaskBudgetLimits {
  return {
    maxDurationMs: row.maxDurationMs,
    maxToolCalls: row.maxToolCalls,
    maxOutputBytes: row.maxOutputBytes,
  }
}

function mapBudgetUsage(row: BudgetUsageRow): AttemptBudgetUsageRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    budgetScopeTaskId: row.budgetScopeTaskId,
    taskId: row.taskId,
    runId: row.runId,
    attemptId: row.attemptId,
    status: row.status,
    reserved: {
      durationMs: row.reservedDurationMs,
      toolCalls: row.reservedToolCalls,
      outputBytes: row.reservedOutputBytes,
    },
    actual: {
      durationMs: row.actualDurationMs,
      toolCalls: row.actualToolCalls,
      outputBytes: row.actualOutputBytes,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costAmount: row.costAmount === null ? null : Number(row.costAmount),
      costCurrency: row.costCurrency,
    },
    measurement: {
      tokens: row.tokenMeasurement,
      cost: row.costMeasurement,
      duration: row.durationMeasurement,
      toolCalls: row.toolMeasurement,
      outputBytes: row.outputMeasurement,
    },
    terminalStatus: row.terminalStatus,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  }
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0)
}

function remaining(limit: number | null, used: number, reserved: number): number | null {
  return limit === null ? null : Math.max(0, limit - used - reserved)
}

function mapOperation(row: OperationRow): TaskOperationRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }
}
