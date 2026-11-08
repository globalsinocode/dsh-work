import type { PendingQuery, Row } from 'postgres'
import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import {
  MODEL_USAGE_BREAKDOWN_LIMIT,
  MODEL_USAGE_RANGE_DAYS,
  RELEASE_TRIAL_PURPOSE,
  RUN_SOURCE_BY_TASK_TYPE,
  SYSTEM_AGENT_LABEL,
  UNASSIGNED_DEPARTMENT,
  type ModelUsageBreakdownRow,
  type ModelUsageDimension,
  type ModelUsageExecution,
  type ModelUsageExecutionPage,
  type ModelUsageFilter,
  type ModelUsageMeasurement,
  type ModelUsageOverview,
  type ModelUsageQueryPort,
  type ModelUsageTotals,
  type RunSource,
} from '../../../domain/model-usage.ts'

const tenantId = 'tenant-dsh-work'

interface TotalsRow {
  totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheInputTokens: number
  requests: number; failedRequests: number; requestsKnown: boolean; executions: number; failedExecutions: number
  estimatedTokens: number
}

interface DetailRow {
  attemptId: string; runId: string; endpoint: 'chat' | 'search'; measurement: ModelUsageMeasurement
  status: ModelUsageExecution['status']; providerKey: string; providerName: string; model: string
  inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null
  requests: number | null; failedRequests: number | null; time: string; latencyMs: number | null; traceId: string
  employeeId: string; employeeName: string; department: string; source: RunSource
  agentId: string | null; agentName: string; routeName: string; errorCode: string | null
}

/**
 * 模型用量页的查询（管理端）。统计全部运行（不要求会话：定时任务、主动任务与系统运行都计入），
 * 时间按平台时区（DSH_WORK_TIMEZONE）划分；来源与 Agent 运行记录共用 domain/model-usage.ts 的映射。
 */
export class PostgresModelUsageService implements ModelUsageQueryPort {
  private readonly database: DatabaseClient
  private readonly timezone: string

  constructor(database: DatabaseClient, timezone: string) {
    this.database = database
    this.timezone = timezone
  }

  async getOverview(filter: ModelUsageFilter): Promise<ModelUsageOverview> {
    const tz = this.timezone
    const days = MODEL_USAGE_RANGE_DAYS[filter.range]
    const hourly = filter.range === 'today'
    // 四个查询互不依赖，并行执行。
    const [windowRows, totalsRows, trendRows, facets] = await Promise.all([
      this.database<{ today: string; from: string }[]>`
        select to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as today,
               to_char(now() at time zone ${tz} - make_interval(days => ${days - 1}), 'YYYY-MM-DD') as "from"
      `,
      this.database<(TotalsRow & { employees: number })[]>`
        ${this.filtered(filter)}
        select ${this.totalsColumns()}, count(distinct employee_id)::integer as employees from filtered
      `,
      this.database<{ bucket: string; model: string; tokens: number; estimatedTokens: number }[]>`
        ${this.filtered(filter)}
        select to_char(occurred_at at time zone ${tz}, ${hourly ? 'HH24' : 'YYYY-MM-DD'}) as bucket, model,
               coalesce(sum(input_tokens + output_tokens), 0)::float8 as tokens,
               coalesce(sum(input_tokens + output_tokens) filter (where measurement = 'estimated'), 0)::float8 as "estimatedTokens"
          from filtered group by 1, 2 order by 1, 2
      `,
      this.database<{ models: string[] | null; sources: RunSource[] | null }[]>`
        ${this.usageRows(this.windowCondition(filter))}
        select array_agg(distinct model order by model) as models, array_agg(distinct source order by source) as sources from usage_rows
      `,
    ])
    const window = windowRows[0]
    const totals = totalsRows[0]
    const buckets = hourly
      ? Array.from({ length: 24 }, (_, hour) => ({ bucket: String(hour).padStart(2, '0'), label: `${hour}时` }))
      : dayBuckets(window!.from, days)
    return {
      range: filter.range,
      from: window!.from,
      to: window!.today,
      granularity: hourly ? 'hour' : 'day',
      totals: { ...normalizeTotals(totals!), employees: totals?.employees ?? 0 },
      trend: buckets.map(item => ({
        ...item,
        models: trendRows
          .filter(row => row.bucket === item.bucket)
          .map(row => ({ model: row.model, tokens: row.tokens, estimatedTokens: row.estimatedTokens })),
      })),
      facets: { models: facets[0]?.models ?? [], sources: facets[0]?.sources ?? [] },
    }
  }

  async getBreakdown(filter: ModelUsageFilter, dimension: ModelUsageDimension): Promise<ModelUsageBreakdownRow[]> {
    const sql = this.database
    const grouping = {
      model: sql`model as key, model as label,
        string_agg(distinct provider_name, '、') || case when bool_and(endpoint = 'search') then ' · 联网搜索' else '' end as sub`,
      agent: sql`coalesce(agent_id, 'system') as key, max(agent_name) as label, '' as sub`,
      employee: sql`employee_id as key, max(employee_name) as label, max(department) as sub`,
      department: sql`department as key, department as label, '' as sub`,
      source: sql`source as key, source as label, '' as sub`,
    }[dimension]
    const rows = await sql<(TotalsRow & { key: string; label: string; sub: string | null })[]>`
      ${this.filtered(filter)}
      select ${grouping}, ${this.totalsColumns()}
        from filtered
       group by 1
       order by "totalTokens" desc, 1
       limit ${MODEL_USAGE_BREAKDOWN_LIMIT}
    `
    return rows.map(row => ({ ...normalizeTotals(row), key: row.key, label: row.label, sub: row.sub ?? '' }))
  }

  async getExecutions(filter: ModelUsageFilter, page: number, pageSize: number): Promise<ModelUsageExecutionPage> {
    const offset = (page - 1) * pageSize
    const [countRows, attempts] = await Promise.all([
      this.database<{ total: number }[]>`
        ${this.filtered(filter)}
        select count(distinct attempt_id)::integer as total from filtered
      `,
      this.database<{ attemptId: string }[]>`
        ${this.filtered(filter)}
        select attempt_id as "attemptId" from filtered
         group by attempt_id order by max(occurred_at) desc, attempt_id
         limit ${pageSize} offset ${offset}
      `,
    ])
    const count = countRows[0]
    const ids = attempts.map(row => row.attemptId)
    const details = ids.length === 0 ? [] : await this.database<DetailRow[]>`
      ${this.usageRows(this.database`mu.attempt_id = any(${ids})`)}
      select attempt_id as "attemptId", run_id as "runId", endpoint, measurement, status,
             provider as "providerKey", provider_name as "providerName", model,
             input_tokens::float8 as "inputTokens", output_tokens::float8 as "outputTokens",
             cache_read_tokens::float8 as "cacheReadTokens", cache_write_tokens::float8 as "cacheWriteTokens",
             request_count as requests, failed_request_count as "failedRequests",
             to_char(occurred_at at time zone ${this.timezone}, 'MM-DD HH24:MI') as time, latency_ms as "latencyMs",
             trace_id as "traceId", employee_id as "employeeId", employee_name as "employeeName", department,
             source, agent_id as "agentId", agent_name as "agentName", route_name as "routeName", error_code as "errorCode"
        from usage_rows
    `
    const items = ids.flatMap(id => {
      const rows = details.filter(row => row.attemptId === id)
      const base = rows.find(row => row.endpoint === 'chat') ?? rows[0]
      if (!base) return []
      const search = rows.find(row => row.endpoint === 'search' && row !== base)
      return [toExecution(base, search)]
    })
    return { items, total: count?.total ?? 0, page, pageSize }
  }

  private totalsColumns() {
    return this.database`
      coalesce(sum(input_tokens + output_tokens), 0)::float8 as "totalTokens",
      coalesce(sum(input_tokens), 0)::float8 as "inputTokens",
      coalesce(sum(output_tokens), 0)::float8 as "outputTokens",
      coalesce(sum(cache_read_tokens) filter (where cache_read_tokens is not null), 0)::float8 as "cacheReadTokens",
      coalesce(sum(input_tokens) filter (where cache_read_tokens is not null), 0)::float8 as "cacheInputTokens",
      coalesce(sum(request_count), 0)::float8 as requests,
      coalesce(sum(failed_request_count), 0)::float8 as "failedRequests",
      count(*) filter (where request_count is not null) > 0 as "requestsKnown",
      count(distinct attempt_id)::integer as executions,
      count(distinct attempt_id) filter (where status = 'failed')::integer as "failedExecutions",
      coalesce(sum(input_tokens + output_tokens) filter (where measurement = 'estimated'), 0)::float8 as "estimatedTokens"
    `
  }

  /** 统计范围的起点：平台时区当天零点往前推 N-1 天。 */
  private windowCondition(filter: ModelUsageFilter) {
    const tz = this.timezone
    const days = MODEL_USAGE_RANGE_DAYS[filter.range]
    return this.database`
      mu.occurred_at >= (date_trunc('day', now() at time zone ${tz}) - make_interval(days => ${days - 1})) at time zone ${tz}
    `
  }

  private filtered(filter: ModelUsageFilter) {
    const sql = this.database
    return sql`
      ${this.usageRows(this.windowCondition(filter))},
      filtered as (
        select * from usage_rows
         where (${filter.model ?? null}::text is null or model = ${filter.model ?? null})
           and (${filter.source ?? null}::text is null or source = ${filter.source ?? null})
           and (${filter.agent ?? null}::text is null or coalesce(agent_id, 'system') = ${filter.agent ?? null})
           and (${filter.employee ?? null}::text is null or employee_id = ${filter.employee ?? null})
           and (${filter.department ?? null}::text is null or department = ${filter.department ?? null})
      )
    `
  }

  /** 用量行加上运行来源、Agent、员工、部门、Provider 与路由名称；全部左连接，无会话的运行同样保留。 */
  private usageRows(condition: PendingQuery<Row[]>) {
    const sql = this.database
    return sql`
      with usage_rows as (
        select mu.attempt_id, mu.run_id, mu.endpoint, mu.measurement, mu.status, mu.provider, mu.model,
               mu.input_tokens, mu.output_tokens, mu.cache_read_tokens, mu.cache_write_tokens,
               mu.request_count, mu.failed_request_count, mu.occurred_at, mu.latency_ms, mu.trace_id,
               r.requested_by as employee_id,
               coalesce(u.display_name, r.requested_by) as employee_name,
               coalesce(nullif(btrim(u.department_id), ''), ${UNASSIGNED_DEPARTMENT}) as department,
               case when ra.manifest->>'purpose' = ${RELEASE_TRIAL_PURPOSE} then 'validation'
                    else coalesce(${sql.json(RUN_SOURCE_BY_TASK_TYPE)}::jsonb ->> t.source_type, 'system') end as source,
               ag.id as agent_id,
               coalesce(ag.name, ${SYSTEM_AGENT_LABEL}) as agent_name,
               coalesce(mp.name, mu.provider) as provider_name,
               coalesce(mr.name, ra.model_route_snapshot->>'routeKey', '—') as route_name,
               ra.error_code
          from model_usage_events mu
          join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id
          left join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
          left join run_attempts ra on ra.tenant_id = mu.tenant_id and ra.id = mu.attempt_id
          left join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
          -- Agent 版本取自 Attempt Manifest；早期运行的 Manifest 没有该字段时，用会话固定的版本。
          left join agent_versions av on av.tenant_id = r.tenant_id
                 and av.id = coalesce(ra.manifest->>'agent_version_id', s.agent_version_id)
          left join agents ag on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
          left join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
          left join model_providers mp on mp.tenant_id = mu.tenant_id and mp.key = mu.provider
          left join model_routes mr on mr.tenant_id = ra.tenant_id and mr.id = ra.model_route_snapshot->>'routeId'
         where mu.tenant_id = ${tenantId} and ${condition}
      )
    `
  }
}

function normalizeTotals(row: TotalsRow): ModelUsageTotals {
  return {
    totalTokens: row.totalTokens ?? 0,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheInputTokens: row.cacheInputTokens ?? 0,
    requests: row.requests ?? 0,
    failedRequests: row.failedRequests ?? 0,
    requestsKnown: Boolean(row.requestsKnown),
    executions: row.executions ?? 0,
    failedExecutions: row.failedExecutions ?? 0,
    estimatedTokens: row.estimatedTokens ?? 0,
  }
}

function dayBuckets(from: string, days: number) {
  const start = Date.parse(`${from}T00:00:00Z`)
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start + index * 86_400_000)
    const bucket = date.toISOString().slice(0, 10)
    return { bucket, label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}` }
  })
}

function toExecution(base: DetailRow, search: DetailRow | undefined): ModelUsageExecution {
  return {
    attemptId: base.attemptId,
    runId: base.runId,
    time: base.time,
    source: base.source,
    agentId: base.agentId,
    agentName: base.agentName,
    employeeId: base.employeeId,
    employeeName: base.employeeName,
    department: base.department,
    providerKey: base.providerKey,
    providerName: base.providerName,
    model: base.model,
    routeName: base.routeName,
    status: base.status,
    errorCode: base.errorCode,
    totalTokens: base.inputTokens + base.outputTokens + (search ? search.inputTokens + search.outputTokens : 0),
    inputTokens: base.inputTokens,
    outputTokens: base.outputTokens,
    cacheReadTokens: base.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens,
    requests: base.requests,
    failedRequests: base.failedRequests,
    measurement: base.measurement,
    search: search ? { model: search.model, inputTokens: search.inputTokens, outputTokens: search.outputTokens, requests: search.requests } : null,
    durationMs: base.latencyMs ?? 0,
    traceId: base.traceId,
  }
}
