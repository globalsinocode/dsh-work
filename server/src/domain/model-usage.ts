import { invalidRequest } from './request-errors.ts'

/** 模型用量页（管理端）：统计全部运行经模型网关产生的用量。 */

export type ModelUsageRange = 'today' | '7d' | '30d'
export const modelUsageRanges: readonly ModelUsageRange[] = ['today', '7d', '30d']
export const MODEL_USAGE_RANGE_DAYS: Record<ModelUsageRange, number> = { today: 1, '7d': 7, '30d': 30 }

/** 运行来源：与 Agent 运行记录同一套映射（tasks.source_type + Attempt Manifest purpose）。 */
export type RunSource = 'conversation' | 'automation' | 'routine' | 'validation' | 'api' | 'event' | 'delegation' | 'system'
export const runSources: readonly RunSource[] = ['conversation', 'automation', 'routine', 'validation', 'api', 'event', 'delegation', 'system']

export const RUN_SOURCE_BY_TASK_TYPE: Readonly<Record<string, RunSource>> = {
  session: 'conversation',
  agent_routine: 'routine',
  automation: 'automation',
  api: 'api',
  event: 'event',
  delegation: 'delegation',
}
export const RELEASE_TRIAL_PURPOSE = 'agent-release-trial'

export function runSourceOf(sourceType: string | null, purpose: string | null): RunSource {
  if (purpose === RELEASE_TRIAL_PURPOSE) return 'validation'
  return (sourceType && RUN_SOURCE_BY_TASK_TYPE[sourceType]) || 'system'
}

export type ModelUsageDimension = 'model' | 'agent' | 'employee' | 'department' | 'source'
/** 按维度统计最多返回的项数（页面满额时提示缩小范围）。 */
export const MODEL_USAGE_BREAKDOWN_LIMIT = 200

export const modelUsageDimensions: readonly ModelUsageDimension[] = ['model', 'agent', 'employee', 'department', 'source']

export type ModelUsageMeasurement = 'gateway' | 'session-log' | 'estimated'

export interface ModelUsageFilter {
  range: ModelUsageRange
  model?: string
  source?: RunSource
  agent?: string
  employee?: string
  department?: string
}

export interface ModelUsageTotals {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  /** 只统计厂商返回了缓存数据的行。 */
  cacheReadTokens: number
  /** 缓存命中率的分母：返回了缓存数据的行的输入 token。 */
  cacheInputTokens: number
  /** 网关计量的请求次数（含重试）；requestsKnown 为 false 时没有请求数据。 */
  requests: number
  failedRequests: number
  requestsKnown: boolean
  executions: number
  failedExecutions: number
  /** 按文本长度估算的 token（模型网关上线前的数据）。 */
  estimatedTokens: number
}

export interface ModelUsageOverview {
  range: ModelUsageRange
  /** 统计范围（平台时区的日期，YYYY-MM-DD）。 */
  from: string
  to: string
  granularity: 'hour' | 'day'
  totals: ModelUsageTotals & { employees: number }
  trend: Array<{ bucket: string; label: string; models: Array<{ model: string; tokens: number; estimatedTokens: number }> }>
  facets: { models: string[]; sources: RunSource[] }
}

export interface ModelUsageBreakdownRow extends ModelUsageTotals {
  key: string
  label: string
  sub: string
}

export interface ModelUsageExecution {
  attemptId: string
  runId: string
  time: string
  source: RunSource
  agentId: string | null
  agentName: string
  employeeId: string
  employeeName: string
  department: string
  providerKey: string
  providerName: string
  model: string
  routeName: string
  status: 'success' | 'failed' | 'blocked' | 'cancelled'
  errorCode: string | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  requests: number | null
  failedRequests: number | null
  measurement: ModelUsageMeasurement
  /** 联网搜索单独计量；不计入对话模型的 token。 */
  search: { model: string; inputTokens: number; outputTokens: number; requests: number | null } | null
  durationMs: number
  traceId: string
}

export interface ModelUsageExecutionPage {
  items: ModelUsageExecution[]
  total: number
  page: number
  pageSize: number
}

/** 管理端模型用量的查询端口：生产为 PostgreSQL，P0 冒烟为确定性内存数据。 */
export interface ModelUsageQueryPort {
  getOverview(filter: ModelUsageFilter): Promise<ModelUsageOverview>
  getBreakdown(filter: ModelUsageFilter, dimension: ModelUsageDimension): Promise<ModelUsageBreakdownRow[]>
  getExecutions(filter: ModelUsageFilter, page: number, pageSize: number): Promise<ModelUsageExecutionPage>
}

/** 解析查询参数；非法的范围、来源与维度明确 422，空值视为不筛选。 */
export function parseModelUsageFilter(params: URLSearchParams): ModelUsageFilter {
  const range = params.get('range') ?? '7d'
  if (!modelUsageRanges.includes(range as ModelUsageRange)) throw invalidRequest('时间范围只支持今天、近 7 天、近 30 天')
  const source = params.get('source')?.trim() || undefined
  if (source && !runSources.includes(source as RunSource)) throw invalidRequest('运行来源无效')
  const text = (name: string) => params.get(name)?.trim().slice(0, 200) || undefined
  return {
    range: range as ModelUsageRange,
    ...(text('model') ? { model: text('model') } : {}),
    ...(source ? { source: source as RunSource } : {}),
    ...(text('agent') ? { agent: text('agent') } : {}),
    ...(text('employee') ? { employee: text('employee') } : {}),
    ...(text('department') ? { department: text('department') } : {}),
  }
}

export function parseModelUsageDimension(value: string | null): ModelUsageDimension {
  if (!value || !modelUsageDimensions.includes(value as ModelUsageDimension)) throw invalidRequest('统计维度无效')
  return value as ModelUsageDimension
}

/** 无部门的员工统一显示为“未归属部门”（users.department_id 由组织架构写入主部门名称）。 */
export const UNASSIGNED_DEPARTMENT = '未归属部门'
export const SYSTEM_AGENT_LABEL = '系统'
