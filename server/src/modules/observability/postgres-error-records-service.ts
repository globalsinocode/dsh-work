import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import {
  DEDUPE_WINDOW_SECONDS,
  DETAIL_SAMPLE_LIMIT,
  ERROR_RANGE_DAYS,
  ERROR_RETENTION_DAYS,
  NEW_GROUPS_PER_HOUR,
  RUN_ERROR_LABELS,
  type ErrorGroupDetail,
  type ErrorGroupFilter,
  type ErrorGroupList,
  type ErrorGroupSummary,
  type ErrorLookupResult,
  type ErrorRange,
  type ErrorRecordsQueryPort,
  type ErrorSample,
  type ErrorSource,
  type LookupRun,
  type RunProblemSummary,
} from '../../domain/error-records.ts'
import type { ErrorRecordInput } from './client-error-report.ts'
import { fingerprintOf } from './client-error-report.ts'

const tenantId = 'tenant-dsh-work'
const PURGE_BATCH = 5_000

/** 浏览器堆栈按版本还原（OB7）；未配置时详情显示原始帧位置。 */
export type StackResolver = (stack: string, release: string | null) => Promise<{ stack: string; resolved: boolean }>

interface GroupRow {
  id: string; source: ErrorSource; kind: ErrorGroupSummary['kind']; message: string; route: string | null
  count: number; people: number; anonymous: boolean; firstSeenAt: Date; lastSeenAt: Date; lastRelease: string | null
}

interface SampleRow {
  occurredAt: Date; userId: string | null; userName: string | null; route: string | null; client: string | null
  release: string | null; traceId: string | null; runId: string | null; repeatCount: number; stack?: string | null
  groupId?: string; message?: string; source?: ErrorSource
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toSample(row: SampleRow): ErrorSample {
  return {
    occurredAt: iso(row.occurredAt), userId: row.userId, userName: row.userName, route: row.route, client: row.client,
    release: row.release, traceId: row.traceId, runId: row.runId, repeatCount: row.repeatCount,
  }
}

function toSummary(row: GroupRow): ErrorGroupSummary {
  return {
    id: row.id, source: row.source, kind: row.kind, message: row.message, route: row.route,
    count: Number(row.count), people: Number(row.people), anonymous: row.anonymous,
    firstSeenAt: iso(row.firstSeenAt), lastSeenAt: iso(row.lastSeenAt), lastRelease: row.lastRelease,
  }
}

/**
 * 错误记录（错误记录方案 6.1、6.5）：写入归并后的问题与样本、管理端查询、按天清理。
 * 写入只由上报接口与服务端失败钩子调用，调用方负责先脱敏（client-error-report.ts）。
 */
export class PostgresErrorRecordsService implements ErrorRecordsQueryPort {
  private readonly database: DatabaseClient
  private readonly resolveStack?: StackResolver

  constructor(database: DatabaseClient, options: { resolveStack?: StackResolver } = {}) {
    this.database = database
    this.resolveStack = options.resolveStack
  }

  async record(input: ErrorRecordInput): Promise<void> {
    await this.database.begin(async sql => {
      const existing = await sql<{ id: string }[]>`
        select id from error_groups where tenant_id = ${tenantId} and fingerprint = ${input.fingerprint} for update
      `
      let groupId = existing[0]?.id
      let fingerprint = input.fingerprint
      let kind: string = input.kind
      let message = input.message
      // 新增问题组上限只约束浏览器上报（可未登录、可被刷），按来源分别计数；服务端 5xx 与进程异常不受限，
      // 不会因浏览器端被刷而并入汇总组。计数与写入在同一事务内按“租户 + 来源”加锁，并发写入不会越过上限。
      if (!groupId && (input.source === 'workbench' || input.source === 'admin')) {
        await sql`select pg_advisory_xact_lock(hashtext(${`error-groups:${tenantId}:${input.source}`}))`
        const [{ recent }] = await sql<{ recent: number }[]>`
          select count(*)::integer as recent from error_groups
           where tenant_id = ${tenantId} and source = ${input.source}
             and first_seen_at > now() - interval '1 hour' and kind <> 'overflow'
        `
        if (recent >= NEW_GROUPS_PER_HOUR) {
          // 新增问题过多（PR #169 评审第 2 条）：新指纹并入该来源的汇总组，避免灌入大量假问题组。
          fingerprint = fingerprintOf(['overflow', input.source])
          kind = 'overflow'
          message = '新增问题过多，这段时间的新问题未单独归并'
        }
      }
      const [group] = await sql<{ id: string }[]>`
        insert into error_groups (id, tenant_id, fingerprint, source, kind, message, occurrence_count, last_release)
        values (${groupId ?? `err-${randomUUID()}`}, ${tenantId}, ${fingerprint}, ${input.source}, ${kind}, ${message},
                ${input.count}, ${input.release})
        on conflict (tenant_id, fingerprint) do update
          set last_seen_at = now(),
              occurrence_count = error_groups.occurrence_count + ${input.count},
              last_release = coalesce(excluded.last_release, error_groups.last_release)
        returning id
      `
      groupId = group!.id
      // 同一员工同一问题 1 分钟内的重复只累加次数，不新增样本。
      const updated = await sql`
        update error_occurrences set repeat_count = repeat_count + ${input.count}
         where id = (
           select id from error_occurrences
            where tenant_id = ${tenantId} and group_id = ${groupId}
              and user_id is not distinct from ${input.userId}
              and occurred_at > now() - make_interval(secs => ${DEDUPE_WINDOW_SECONDS})
            order by occurred_at desc limit 1
         )
      `
      if (updated.count > 0) return
      await sql`
        insert into error_occurrences (id, tenant_id, group_id, user_id, release, route, trace_id, run_id, client, stack, repeat_count)
        values (${`erro-${randomUUID()}`}, ${tenantId}, ${groupId}, ${input.userId}, ${input.release}, ${input.route},
                ${input.traceId}, ${input.runId}, ${input.client}, ${input.stack}, ${input.count})
      `
    })
  }

  async listGroups(filter: ErrorGroupFilter): Promise<ErrorGroupList> {
    const sql = this.database
    const days = ERROR_RANGE_DAYS[filter.range]
    const since = sql`now() - make_interval(days => ${days})`
    const [rows, releases] = await Promise.all([
      sql<GroupRow[]>`
        with window_rows as (
          select o.group_id, sum(o.repeat_count)::integer as count,
                 count(distinct o.user_id)::integer as people,
                 bool_or(o.user_id is null) as anonymous,
                 min(o.occurred_at) as first_in_window
            from error_occurrences o
           where o.tenant_id = ${tenantId} and o.occurred_at > ${since}
             ${filter.release ? sql`and o.release = ${filter.release}` : sql``}
           group by o.group_id
        )
        select g.id, g.source, g.kind, g.message, w.count, w.people, w.anonymous,
               g.first_seen_at as "firstSeenAt", g.last_seen_at as "lastSeenAt", g.last_release as "lastRelease",
               (select o.route from error_occurrences o where o.tenant_id = g.tenant_id and o.group_id = g.id
                 order by o.occurred_at desc limit 1) as route
          from error_groups g join window_rows w on w.group_id = g.id
         where g.tenant_id = ${tenantId}
           ${filter.source ? sql`and g.source = ${filter.source}` : sql``}
           ${filter.includeNotice ? sql`` : sql`and g.kind <> 'notice'`}
         order by ${filter.sort === 'count' ? sql`w.count desc, g.last_seen_at desc` : sql`g.last_seen_at desc`}
         limit 200
      `,
      sql<{ release: string }[]>`
        select distinct release from error_occurrences
         where tenant_id = ${tenantId} and release is not null and occurred_at > ${since}
         order by release desc limit 50
      `,
    ])
    return { items: rows.map(toSummary), releases: releases.map(row => row.release) }
  }

  async getGroup(id: string, range: ErrorRange): Promise<ErrorGroupDetail | null> {
    const sql = this.database
    // 次数、人数与列表同一周期口径（PR #171 评审）；累计次数另给 totalCount。
    const since = sql`now() - make_interval(days => ${ERROR_RANGE_DAYS[range]})`
    const [group] = await sql<(GroupRow & { totalCount: number })[]>`
      select g.id, g.source, g.kind, g.message,
             g.occurrence_count as "totalCount",
             (select coalesce(sum(repeat_count), 0)::integer from error_occurrences o
               where o.tenant_id = g.tenant_id and o.group_id = g.id and o.occurred_at > ${since}) as count,
             (select count(distinct user_id)::integer from error_occurrences o
               where o.tenant_id = g.tenant_id and o.group_id = g.id and o.occurred_at > ${since}) as people,
             exists (select 1 from error_occurrences o where o.tenant_id = g.tenant_id and o.group_id = g.id
                      and o.user_id is null and o.occurred_at > ${since}) as anonymous,
             g.first_seen_at as "firstSeenAt", g.last_seen_at as "lastSeenAt", g.last_release as "lastRelease",
             null::text as route
        from error_groups g where g.tenant_id = ${tenantId} and g.id = ${id}
    `
    if (!group) return null
    const samples = await sql<SampleRow[]>`
      select o.occurred_at as "occurredAt", o.user_id as "userId", u.display_name as "userName", o.route, o.client,
             o.release, o.trace_id as "traceId", o.run_id as "runId", o.repeat_count as "repeatCount", o.stack
        from error_occurrences o
        left join users u on u.tenant_id = o.tenant_id and u.id = o.user_id
       where o.tenant_id = ${tenantId} and o.group_id = ${id}
       order by o.occurred_at desc limit ${DETAIL_SAMPLE_LIMIT}
    `
    const latestWithStack = samples.find(sample => sample.stack)
    let stack: string | null = latestWithStack?.stack ?? null
    let stackResolved = false
    if (stack && this.resolveStack && (group.source === 'workbench' || group.source === 'admin')) {
      try {
        const result = await this.resolveStack(stack, latestWithStack?.release ?? null)
        stack = result.stack
        stackResolved = result.resolved
      } catch {
        // 还原失败时显示原始帧位置。
      }
    }
    return {
      ...toSummary({ ...group, route: samples[0]?.route ?? null }),
      totalCount: Number(group.totalCount),
      stack, stackResolved, samples: samples.map(toSample),
    }
  }

  async runProblems(range: ErrorRange): Promise<RunProblemSummary> {
    const sql = this.database
    const since = sql`now() - make_interval(days => ${ERROR_RANGE_DAYS[range]})`
    const [totals, reasons, tools] = await Promise.all([
      sql<{ total: number; failed: number; timedOut: number; cancelled: number; emptyAnswer: number }[]>`
        select count(*)::integer as total,
               count(*) filter (where r.status = 'failed')::integer as failed,
               count(*) filter (where ra.error_code = 'RUN_TIMEOUT')::integer as "timedOut",
               count(*) filter (where r.status = 'cancelled')::integer as cancelled,
               count(*) filter (where r.status = 'succeeded' and not exists (
                 select 1 from messages m where m.tenant_id = r.tenant_id and m.run_id = r.id
                    and m.role = 'assistant' and btrim(m.content) <> ''))::integer as "emptyAnswer"
          from runs r
          left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
         where r.tenant_id = ${tenantId} and r.created_at > ${since}
      `,
      sql<{ code: string; runs: number; people: number; lastAt: Date }[]>`
        with problem_runs as (
          select r.id, r.requested_by, r.updated_at,
                 case when r.status = 'succeeded' then 'EMPTY_ANSWER'
                      else coalesce(ra.error_code, case when r.status = 'cancelled' then 'CANCELLED' else 'UNKNOWN' end) end as code
            from runs r
            left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
           where r.tenant_id = ${tenantId} and r.created_at > ${since}
             and (r.status in ('failed', 'cancelled')
                  or (r.status = 'succeeded' and not exists (
                    select 1 from messages m where m.tenant_id = r.tenant_id and m.run_id = r.id
                       and m.role = 'assistant' and btrim(m.content) <> '')))
        )
        select code, count(*)::integer as runs, count(distinct requested_by)::integer as people, max(updated_at) as "lastAt"
          from problem_runs group by code order by runs desc limit 20
      `,
      sql<{ tool: string; failed: number; denied: number; topReason: string | null }[]>`
        with failures as (
          select e.safe_metadata->>'tool_name' as tool, coalesce(e.safe_metadata->>'error_code', 'UNKNOWN') as code
            from run_events e
           where e.tenant_id = ${tenantId} and e.event_type = 'tool.completed'
             and e.safe_metadata->>'status' = 'failed' and e.occurred_at > ${since}
        )
        select tool,
               count(*) filter (where code <> 'TOOL_PERMISSION_DENIED')::integer as failed,
               count(*) filter (where code = 'TOOL_PERMISSION_DENIED')::integer as denied,
               mode() within group (order by code) as "topReason"
          from failures where tool is not null group by tool order by count(*) desc limit 20
      `,
    ])
    const total = totals[0]
    return {
      totalRuns: total?.total ?? 0,
      failed: total?.failed ?? 0,
      timedOut: total?.timedOut ?? 0,
      cancelled: total?.cancelled ?? 0,
      emptyAnswer: total?.emptyAnswer ?? 0,
      reasons: reasons.map(row => ({
        code: row.code, label: RUN_ERROR_LABELS[row.code] ?? (row.code === 'CANCELLED' ? '已取消' : row.code === 'UNKNOWN' ? '未记录原因' : row.code),
        runs: row.runs, people: row.people, lastAt: iso(row.lastAt),
      })),
      tools: tools.map(row => ({ tool: row.tool, failed: row.failed, denied: row.denied, topReason: row.topReason ?? '—' })),
    }
  }

  async lookup(query: string): Promise<ErrorLookupResult> {
    const sql = this.database
    const value = query.trim().slice(0, 128)
    const empty: ErrorLookupResult = { query: value, kind: 'unknown', serverFailures: [], clientReports: [], runs: [] }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return empty
    const sampleColumns = sql`
      o.group_id as "groupId", g.message, g.source, o.occurred_at as "occurredAt", o.user_id as "userId",
      u.display_name as "userName", o.route, o.client, o.release, o.trace_id as "traceId", o.run_id as "runId",
      o.repeat_count as "repeatCount"`
    let samples: SampleRow[] = []
    let runIds: string[] = []
    let kind: ErrorLookupResult['kind'] = 'unknown'
    if (value.startsWith('trace-http-')) {
      kind = 'trace'
      samples = await sql<SampleRow[]>`
        select ${sampleColumns}
          from error_occurrences o join error_groups g on g.tenant_id = o.tenant_id and g.id = o.group_id
          left join users u on u.tenant_id = o.tenant_id and u.id = o.user_id
         where o.tenant_id = ${tenantId} and o.trace_id = ${value}
         order by o.occurred_at asc limit 50
      `
      runIds = [...new Set(samples.map(sample => sample.runId).filter((id): id is string => Boolean(id)))]
    } else {
      // 运行编号，或运行侧链路编号 `trace-<runId>`（run_events.trace_id）。
      const runId = value.startsWith('trace-') ? value.slice('trace-'.length) : value
      const [run] = await sql<{ id: string }[]>`select id from runs where tenant_id = ${tenantId} and id = ${runId}`
      if (!run) return empty
      kind = 'run'
      runIds = [run.id]
      samples = await sql<SampleRow[]>`
        select ${sampleColumns}
          from error_occurrences o join error_groups g on g.tenant_id = o.tenant_id and g.id = o.group_id
          left join users u on u.tenant_id = o.tenant_id and u.id = o.user_id
         where o.tenant_id = ${tenantId} and o.run_id = ${run.id}
         order by o.occurred_at asc limit 50
      `
    }
    const runs = runIds.length ? await sql<(Omit<LookupRun, 'createdAt'> & { createdAt: Date })[]>`
      select r.id as "runId", r.status, ra.error_code as "errorCode", ag.name as "agentName",
             coalesce(u.display_name, r.requested_by) as "requestedBy", r.created_at as "createdAt"
        from runs r
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
        left join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        left join agent_versions av on av.tenant_id = r.tenant_id
               and av.id = coalesce(ra.manifest->>'agent_version_id', s.agent_version_id)
        left join agents ag on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
        left join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
       where r.tenant_id = ${tenantId} and r.id = any(${runIds})
    ` : []
    const withMeta = (row: SampleRow) => ({ ...toSample(row), groupId: row.groupId!, message: row.message! })
    return {
      query: value,
      kind,
      serverFailures: samples.filter(row => row.source === 'server' || row.source === 'process').map(withMeta),
      clientReports: samples.filter(row => row.source === 'workbench' || row.source === 'admin')
        .map(row => ({ ...withMeta(row), source: row.source! })),
      runs: runs.map(row => ({ ...row, createdAt: iso(row.createdAt) })),
    }
  }

  /** 删除 90 天前的样本（每批最多 5,000 行），再删除没有样本的问题组。 */
  async purgeExpired(): Promise<{ removed: number }> {
    let removed = 0
    for (;;) {
      const result = await this.database`
        delete from error_occurrences where id in (
          select id from error_occurrences
           where tenant_id = ${tenantId} and occurred_at < now() - make_interval(days => ${ERROR_RETENTION_DAYS})
           limit ${PURGE_BATCH}
        )
      `
      removed += result.count
      if (result.count < PURGE_BATCH) break
      await new Promise(resolve => setImmediate(resolve))
    }
    await this.database`
      delete from error_groups g
       where g.tenant_id = ${tenantId}
         and not exists (select 1 from error_occurrences o where o.tenant_id = g.tenant_id and o.group_id = g.id)
         and g.last_seen_at < now() - make_interval(days => ${ERROR_RETENTION_DAYS})
    `
    return { removed }
  }
}
