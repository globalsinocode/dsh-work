import {
  MODEL_USAGE_BREAKDOWN_LIMIT,
  MODEL_USAGE_RANGE_DAYS,
  type ModelUsageBreakdownRow,
  type ModelUsageDimension,
  type ModelUsageExecution,
  type ModelUsageExecutionPage,
  type ModelUsageFilter,
  type ModelUsageOverview,
  type ModelUsageQueryPort,
  type ModelUsageTotals,
  type RunSource,
} from '../../domain/model-usage.ts'

/**
 * P0 冒烟用的模型用量数据：固定种子生成近 30 天的执行，相对“现在”计算日期，
 * 让时间范围、趋势、维度统计与下钻在浏览器冒烟中都有确定的数据。不连接数据库。
 */
interface SmokeExecution extends ModelUsageExecution {
  occurredAt: Date
}

interface UsageLine {
  execution: SmokeExecution
  model: string
  providerName: string
  endpoint: 'chat' | 'search'
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
  requests: number | null
  failedRequests: number | null
  estimated: boolean
}

const TIMEZONE = 'Asia/Shanghai'

export class SmokeModelUsageService implements ModelUsageQueryPort {
  private readonly executions: SmokeExecution[]
  private readonly now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.now = now
    this.executions = generateExecutions(now())
  }

  async getOverview(filter: ModelUsageFilter): Promise<ModelUsageOverview> {
    const lines = this.lines(filter)
    const days = MODEL_USAGE_RANGE_DAYS[filter.range]
    const hourly = filter.range === 'today'
    const today = localDate(this.now())
    const from = localDate(new Date(this.now().getTime() - (days - 1) * 86_400_000))
    const buckets = hourly
      ? Array.from({ length: 24 }, (_, hour) => ({ bucket: String(hour).padStart(2, '0'), label: `${hour}时` }))
      : Array.from({ length: days }, (_, index) => {
          const date = new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000)
          return { bucket: date.toISOString().slice(0, 10), label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}` }
        })
    const window = this.lines({ range: filter.range })
    return {
      range: filter.range,
      from,
      to: today,
      granularity: hourly ? 'hour' : 'day',
      totals: { ...aggregate(lines), employees: new Set(lines.map(line => line.execution.employeeId)).size },
      trend: buckets.map(item => {
        const inBucket = lines.filter(line => (hourly ? localHour(line.execution.occurredAt) : localDate(line.execution.occurredAt)) === item.bucket)
        const models = [...new Set(inBucket.map(line => line.model))].sort()
        return {
          ...item,
          models: models.map(model => {
            const own = inBucket.filter(line => line.model === model)
            return {
              model,
              tokens: own.reduce((total, line) => total + line.inputTokens + line.outputTokens, 0),
              estimatedTokens: own.filter(line => line.estimated).reduce((total, line) => total + line.inputTokens + line.outputTokens, 0),
            }
          }),
        }
      }),
      facets: {
        models: [...new Set(window.map(line => line.model))].sort(),
        sources: [...new Set(window.map(line => line.execution.source))].sort() as RunSource[],
      },
    }
  }

  async getBreakdown(filter: ModelUsageFilter, dimension: ModelUsageDimension): Promise<ModelUsageBreakdownRow[]> {
    const groups = new Map<string, { label: string; sub: string; lines: UsageLine[] }>()
    for (const line of this.lines(filter)) {
      const { key, label, sub } = groupOf(line, dimension)
      const group = groups.get(key) ?? { label, sub, lines: [] }
      group.lines.push(line)
      groups.set(key, group)
    }
    return [...groups.entries()]
      .map(([key, group]) => ({ key, label: group.label, sub: group.sub, ...aggregate(group.lines) }))
      .sort((left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key))
      .slice(0, MODEL_USAGE_BREAKDOWN_LIMIT)
  }

  async getExecutions(filter: ModelUsageFilter, page: number, pageSize: number): Promise<ModelUsageExecutionPage> {
    const ids = new Set(this.lines(filter).map(line => line.execution.attemptId))
    const matched = this.executions.filter(execution => ids.has(execution.attemptId))
    const items = matched.slice((page - 1) * pageSize, page * pageSize).map(({ occurredAt: _occurredAt, ...execution }) => execution)
    return { items, total: matched.length, page, pageSize }
  }

  private lines(filter: ModelUsageFilter): UsageLine[] {
    const days = MODEL_USAGE_RANGE_DAYS[filter.range]
    const fromDate = localDate(new Date(this.now().getTime() - (days - 1) * 86_400_000))
    const lines: UsageLine[] = []
    for (const execution of this.executions) {
      if (localDate(execution.occurredAt) < fromDate) continue
      const estimated = execution.measurement === 'estimated'
      lines.push({
        execution, model: execution.model, providerName: execution.providerName, endpoint: 'chat',
        inputTokens: execution.inputTokens, outputTokens: execution.outputTokens, cacheReadTokens: execution.cacheReadTokens,
        requests: execution.requests, failedRequests: execution.failedRequests, estimated,
      })
      if (execution.search) {
        lines.push({
          execution, model: execution.search.model, providerName: 'DeepSeek 官方', endpoint: 'search',
          inputTokens: execution.search.inputTokens, outputTokens: execution.search.outputTokens, cacheReadTokens: null,
          requests: execution.search.requests, failedRequests: execution.search.requests === null ? null : 0, estimated,
        })
      }
    }
    return lines.filter(line =>
      (!filter.model || line.model === filter.model)
      && (!filter.source || line.execution.source === filter.source)
      && (!filter.agent || (line.execution.agentId ?? 'system') === filter.agent)
      && (!filter.employee || line.execution.employeeId === filter.employee)
      && (!filter.department || line.execution.department === filter.department))
  }
}

function groupOf(line: UsageLine, dimension: ModelUsageDimension) {
  switch (dimension) {
    case 'model': return { key: line.model, label: line.model, sub: line.endpoint === 'search' ? `${line.providerName} · 联网搜索` : line.providerName }
    case 'agent': return { key: line.execution.agentId ?? 'system', label: line.execution.agentName, sub: '' }
    case 'employee': return { key: line.execution.employeeId, label: line.execution.employeeName, sub: line.execution.department }
    case 'department': return { key: line.execution.department, label: line.execution.department, sub: '' }
    case 'source': return { key: line.execution.source, label: line.execution.source, sub: '' }
  }
}

function aggregate(lines: UsageLine[]): ModelUsageTotals {
  const executions = new Set(lines.map(line => line.execution.attemptId))
  const failed = new Set(lines.filter(line => line.execution.status === 'failed').map(line => line.execution.attemptId))
  const cached = lines.filter(line => line.cacheReadTokens !== null)
  const metered = lines.filter(line => line.requests !== null)
  return {
    totalTokens: lines.reduce((total, line) => total + line.inputTokens + line.outputTokens, 0),
    inputTokens: lines.reduce((total, line) => total + line.inputTokens, 0),
    outputTokens: lines.reduce((total, line) => total + line.outputTokens, 0),
    cacheReadTokens: cached.reduce((total, line) => total + (line.cacheReadTokens ?? 0), 0),
    cacheInputTokens: cached.reduce((total, line) => total + line.inputTokens, 0),
    requests: metered.reduce((total, line) => total + (line.requests ?? 0), 0),
    failedRequests: metered.reduce((total, line) => total + (line.failedRequests ?? 0), 0),
    requestsKnown: metered.length > 0,
    executions: executions.size,
    failedExecutions: failed.size,
    estimatedTokens: lines.filter(line => line.estimated).reduce((total, line) => total + line.inputTokens + line.outputTokens, 0),
  }
}

function localDate(date: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function localHour(date: Date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).format(date).padStart(2, '0')
}

function localTime(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

const people: Array<{ id: string; name: string; department: string }> = [
  { id: 'U00001', name: '林岚', department: '华东销售部' },
  { id: 'U10021', name: '周衡', department: '华东销售部' },
  { id: 'U10086', name: '陈默', department: '法务部' },
  { id: 'U10088', name: '赵宁', department: '客服中心' },
]

const agents: Array<{ id: string | null; name: string; source: RunSource; staff: number[]; search: boolean }> = [
  { id: 'dsh-work-assistant', name: 'DSH 工作助手', source: 'conversation', staff: [0, 1], search: true },
  { id: 'contract-reviewer', name: '合同审查助手', source: 'conversation', staff: [2], search: false },
  { id: 'service-helper', name: '客服知识助手', source: 'conversation', staff: [3], search: true },
  { id: 'inventory-report', name: '库存日报', source: 'automation', staff: [0], search: false },
  { id: 'dsh-work-assistant', name: 'DSH 工作助手', source: 'routine', staff: [1], search: false },
  { id: null, name: '系统', source: 'system', staff: [0, 2], search: false },
]

/** 固定种子：21 天前的数据为估算（模型网关上线前），6–9 天前切到备用路由（百炼）。 */
function generateExecutions(now: Date): SmokeExecution[] {
  let seed = 20261108
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const between = (min: number, max: number) => Math.floor(min + random() * (max - min + 1))
  const executions: SmokeExecution[] = []
  for (let day = 0; day < 30; day++) {
    const count = day === 0 ? 4 : between(2, 4)
    for (let index = 0; index < count; index++) {
      const agent = agents[between(0, agents.length - 1)]!
      const person = people[agent.staff[between(0, agent.staff.length - 1)]!]!
      const occurredAt = new Date(now.getTime() - day * 86_400_000 - (index + 1) * 37 * 60_000)
      const estimated = day >= 21
      const backup = day >= 6 && day <= 9 && agent.source !== 'system'
      const model = backup ? 'qwen3.8-flash' : 'deepseek-v4-pro'
      const roll = random()
      const status: ModelUsageExecution['status'] = roll < 0.08 ? 'failed' : roll < 0.12 ? 'cancelled' : 'success'
      const inputTokens = status === 'failed' ? 0 : agent.source === 'system' ? between(2000, 6000) : between(6000, 40000)
      const outputTokens = status === 'failed' ? 0 : between(200, 3000)
      // 与网关汇总一致：所有请求都失败时厂商没有返回用量，缓存为“未返回”。
      const cacheReadTokens = estimated || status === 'failed' ? null : Math.round(inputTokens * (backup ? 0.2 : 0.55))
      const search = agent.search && status === 'success' && random() < 0.35
        ? { model: 'deepseek-v4-flash', inputTokens: between(800, 1500), outputTokens: between(200, 400), requests: estimated ? null : 1 }
        : null
      const attemptId = `attempt-smoke-${day}-${index}`
      executions.push({
        attemptId,
        runId: `run-smoke-${day}-${index}`,
        time: localTime(occurredAt),
        occurredAt,
        source: agent.source,
        agentId: agent.id,
        agentName: agent.name,
        employeeId: person.id,
        employeeName: person.name,
        department: person.department,
        providerKey: backup ? 'bailian' : 'deepseek-official',
        providerName: backup ? '阿里云百炼' : 'DeepSeek 官方',
        model,
        routeName: backup ? '备用路由' : '平台默认模型路由',
        status,
        errorCode: status === 'failed' ? (backup ? 'MODEL_RATE_LIMITED' : 'MODEL_UPSTREAM_UNAVAILABLE') : null,
        totalTokens: inputTokens + outputTokens + (search ? search.inputTokens + search.outputTokens : 0),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: null,
        requests: estimated ? null : status === 'failed' ? 3 : between(1, 4),
        failedRequests: estimated ? null : status === 'failed' ? 3 : 0,
        measurement: estimated ? 'estimated' : 'gateway',
        search,
        durationMs: between(8, 90) * 1000,
        traceId: `trace-smoke-${day}-${index}`,
      })
    }
  }
  return executions.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
}
