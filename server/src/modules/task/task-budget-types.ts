export interface TaskBudgetInput {
  maxDurationMs?: number
  maxToolCalls?: number
  maxOutputBytes?: number
  /** Recognized so callers receive a stable unsupported-capability error. */
  maxTokens?: number
  /** Recognized so callers receive a stable unsupported-capability error. */
  maxCostAmount?: number
  costCurrency?: string
}

export interface TaskBudgetLimits {
  maxDurationMs: number | null
  maxToolCalls: number | null
  maxOutputBytes: number | null
}

export interface TaskBudgetCapabilities {
  duration: { measurement: 'runtime_or_timestamps'; enforcement: 'hard' }
  toolCalls: { measurement: 'runtime_or_conservative'; enforcement: 'hard' }
  outputBytes: { measurement: 'platform_or_conservative'; enforcement: 'hard' }
  tokens: { measurement: 'reported_or_unavailable'; enforcement: 'unsupported' }
  cost: { measurement: 'unavailable'; enforcement: 'unsupported' }
}

export interface TaskBudgetSnapshot {
  budgetScopeTaskId: string
  limits: TaskBudgetLimits
  capabilities: TaskBudgetCapabilities
}

export interface AttemptBudgetUsageRecord {
  id: string
  tenantId: string
  budgetScopeTaskId: string
  taskId: string
  runId: string
  attemptId: string
  status: 'reserved' | 'settled' | 'released'
  reserved: { durationMs: number; toolCalls: number; outputBytes: number }
  actual: {
    durationMs: number | null
    toolCalls: number | null
    outputBytes: number | null
    inputTokens: number | null
    outputTokens: number | null
    costAmount: number | null
    costCurrency: string | null
  }
  measurement: {
    tokens: 'reported' | 'unavailable'
    cost: 'reported' | 'unavailable'
    duration: 'runtime' | 'timestamps' | 'reserved' | 'zero'
    toolCalls: 'runtime' | 'reserved' | 'zero'
    outputBytes: 'platform' | 'reserved' | 'zero'
  }
  terminalStatus: 'succeeded' | 'failed' | 'cancelled' | null
  createdAt: string
  settledAt: string | null
}

export interface AttemptBudgetSettlement {
  durationMs: number
  toolCalls: number | null
  outputBytes: number
  inputTokens: number | null
  outputTokens: number | null
  tokenMeasurement: 'reported' | 'unavailable'
  durationMeasurement: 'runtime' | 'timestamps'
  toolMeasurement: 'runtime' | 'reserved'
  outputMeasurement: 'platform'
  terminalStatus: 'succeeded' | 'failed' | 'cancelled'
}

export interface TaskBudgetView {
  scopeTaskId: string
  limits: TaskBudgetLimits
  capabilities: TaskBudgetCapabilities
  usage: {
    durationMs: number
    toolCalls: number
    outputBytes: number
    inputTokens: number | null
    outputTokens: number | null
    tokenMeasurement: 'reported' | 'unavailable'
    costAmount: null
    costCurrency: null
  }
  reserved: { durationMs: number; toolCalls: number; outputBytes: number }
  remaining: {
    durationMs: number | null
    toolCalls: number | null
    outputBytes: number | null
  }
  attempts: AttemptBudgetUsageRecord[]
}

export const taskBudgetCapabilities: TaskBudgetCapabilities = {
  duration: { measurement: 'runtime_or_timestamps', enforcement: 'hard' },
  toolCalls: { measurement: 'runtime_or_conservative', enforcement: 'hard' },
  outputBytes: { measurement: 'platform_or_conservative', enforcement: 'hard' },
  tokens: { measurement: 'reported_or_unavailable', enforcement: 'unsupported' },
  cost: { measurement: 'unavailable', enforcement: 'unsupported' },
}

export function normalizeTaskBudget(input?: TaskBudgetInput | null): TaskBudgetLimits {
  if (input?.maxTokens !== undefined) {
    throw new TaskBudgetUnsupportedError('当前 Runtime 不能在执行中可靠停止 Token 消耗；maxTokens 暂不支持硬预算')
  }
  if (input?.maxCostAmount !== undefined || input?.costCurrency !== undefined) {
    throw new TaskBudgetUnsupportedError('当前模型路由没有可核验价格与成本回报；成本硬预算暂不支持')
  }
  return {
    maxDurationMs: optionalInteger(input?.maxDurationMs, 'maxDurationMs', 1_000, 86_400_000),
    maxToolCalls: optionalInteger(input?.maxToolCalls, 'maxToolCalls', 0, 100_000),
    maxOutputBytes: optionalInteger(input?.maxOutputBytes, 'maxOutputBytes', 1_024, 1_073_741_824),
  }
}

export class TaskBudgetUnsupportedError extends Error {
  readonly status = 422
  readonly code = 'TASK_BUDGET_UNSUPPORTED'

  constructor(message: string) {
    super(message)
    this.name = 'TaskBudgetUnsupportedError'
  }
}

export class TaskBudgetExceededError extends Error {
  readonly status = 409
  readonly code = 'TASK_BUDGET_EXCEEDED'

  constructor(message: string) {
    super(message)
    this.name = 'TaskBudgetExceededError'
  }
}

function optionalInteger(value: number | undefined, name: string, minimum: number, maximum: number): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} 必须是 ${minimum}～${maximum} 的安全整数`)
  }
  return value
}
