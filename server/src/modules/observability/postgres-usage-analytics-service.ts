import type { PendingQuery, Row } from 'postgres'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { RELEASE_TRIAL_PURPOSE, UNASSIGNED_DEPARTMENT } from '../../domain/model-usage.ts'
import { invalidRequest } from '../../domain/request-errors.ts'
import {
  PAGE_VIEW_DEDUPE_MINUTES,
  PRODUCT_EVENT_RETENTION_DAYS,
  USAGE_PEOPLE_LIMIT,
  USAGE_RANGE_DAYS,
  type IdlePerson,
  type UsageAnalyticsQueryPort,
  type UsageEntry,
  type UsageFilter,
  type UsageOverview,
  type UsagePeople,
  type UsagePerson,
  type UsagePersonDetail,
  type UsageRange,
} from '../../domain/usage-analytics.ts'

const tenantId = 'tenant-dsh-work'
const PURGE_BATCH = 5_000
const UNKNOWN_AGENT = '未知 AI 同事'

export interface PageViewInput { page: string; inDingtalk: boolean }

interface PersonRow {
  userId: string; name: string; department: string; lastActiveAt: Date | null; activeDays: number; conversations: number
  runs: number; succeededRuns: number; finishedRuns: number; tokens: number; topAgent: string | null; topPage: string | null
}

const iso = (value: Date | string | null) => value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString()

function toPerson(row: PersonRow): UsagePerson {
  return {
    userId: row.userId, name: row.name, department: row.department, lastActiveAt: iso(row.lastActiveAt),
    activeDays: Number(row.activeDays), conversations: Number(row.conversations), runs: Number(row.runs),
    succeededRuns: Number(row.succeededRuns), finishedRuns: Number(row.finishedRuns), tokens: Number(row.tokens),
    topAgent: row.topAgent, topPage: row.topPage,
  }
}

/**
 * 运营概览的使用情况（OBS-S2）。员工活动 = 期间内本人发起的员工侧运行（对话、项目空间、定时任务、主动任务；
 * 不含发布试运行、管理助手与系统运行）、新建的员工端对话与员工端页面访问。时间按平台时区按天划分。
 */
export class PostgresUsageAnalyticsService implements UsageAnalyticsQueryPort {
  private readonly database: DatabaseClient
  private readonly timezone: string

  constructor(database: DatabaseClient, timezone: string) {
    this.database = database
    this.timezone = timezone
  }

  /** 记录页面访问；同一员工同一端同一页面 30 分钟内只记一次。 */
  async recordPageViews(userId: string, app: 'workbench' | 'admin', views: readonly PageViewInput[]): Promise<number> {
    let recorded = 0
    for (const view of views) {
      // 按“员工 + 端 + 页面”加事务锁再判断，两个标签页同时上报也只记一次（PR #172 评审）。
      const result = await this.database.begin(async sql => {
        await sql`select pg_advisory_xact_lock(hashtext(${`page-view:${tenantId}:${userId}:${app}:${view.page}`}))`
        return sql`
        insert into product_events (tenant_id, user_id, app, page, in_dingtalk)
        select ${tenantId}, ${userId}, ${app}, ${view.page}, ${view.inDingtalk}
         where not exists (
           select 1 from product_events
            where tenant_id = ${tenantId} and user_id = ${userId} and app = ${app} and page = ${view.page}
              and occurred_at > now() - make_interval(mins => ${PAGE_VIEW_DEDUPE_MINUTES})
         )
      `
      })
      recorded += result.count
    }
    return recorded
  }

  async purgeExpired(): Promise<{ removed: number }> {
    let removed = 0
    for (;;) {
      const result = await this.database`
        delete from product_events where id in (
          select id from product_events
           where tenant_id = ${tenantId} and occurred_at < now() - make_interval(days => ${PRODUCT_EVENT_RETENTION_DAYS})
           limit ${PURGE_BATCH}
        )
      `
      removed += result.count
      if (result.count < PURGE_BATCH) return { removed }
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  async overview(filter: UsageFilter): Promise<UsageOverview> {
    await this.assertDepartment(filter.department)
    const sql = this.database
    const tz = this.timezone
    const days = USAGE_RANGE_DAYS[filter.range]
    const scope = this.scope(filter)
    // 各统计先按员工或按天聚合一次（PR #172 评审）：不对每个员工、每一天重复扫描期间内的记录。
    const [windowRows, totals, daily, agents, pages, entries, failures, departments, options] = await Promise.all([
      sql<{ from: string; to: string }[]>`
        select to_char(now() at time zone ${tz} - make_interval(days => ${days - 1}), 'YYYY-MM-DD') as "from",
               to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as "to"
      `,
      sql<Omit<UsageOverview['totals'], 'averageDailyActive'>[]>`
        ${scope},
        run_totals as (
          select count(*)::integer as runs,
                 count(*) filter (where status = 'succeeded')::integer as succeeded,
                 count(*) filter (where status in ('succeeded', 'failed', 'cancelled'))::integer as finished
            from employee_runs
        ),
        token_totals as (
          select coalesce(sum(mu.input_tokens + mu.output_tokens), 0)::float8 as tokens
            from model_usage_events mu join employee_runs r on r.id = mu.run_id where mu.tenant_id = ${tenantId}
        )
        select (select count(*) from people)::integer as employees,
               (select count(distinct user_id) from activity)::integer as "activeEmployees",
               (select count(*) from employee_sessions)::integer as "newConversations",
               rt.runs, rt.succeeded as "succeededRuns", rt.finished as "finishedRuns", tt.tokens,
               (select count(distinct user_id) from employee_views where in_dingtalk)::integer as "dingtalkEmployees"
          from run_totals rt cross join token_totals tt
      `,
      sql<{ day: string; activeEmployees: number; runs: number }[]>`
        ${scope},
        days as (
          select to_char(d, 'YYYY-MM-DD') as day
            from generate_series((now() at time zone ${tz})::date - ${days - 1}::integer, (now() at time zone ${tz})::date, interval '1 day') d
        ),
        active_by_day as (
          select to_char(at at time zone ${tz}, 'YYYY-MM-DD') as day, count(distinct user_id)::integer as n from activity group by 1
        ),
        runs_by_day as (
          select to_char(created_at at time zone ${tz}, 'YYYY-MM-DD') as day, count(*)::integer as n from employee_runs group by 1
        )
        select days.day, coalesce(a.n, 0) as "activeEmployees", coalesce(r.n, 0) as runs
          from days left join active_by_day a on a.day = days.day left join runs_by_day r on r.day = days.day
         order by days.day
      `,
      sql<{ name: string; runs: number; people: number }[]>`
        ${scope}
        select agent_name as name, count(*)::integer as runs, count(distinct user_id)::integer as people
          from employee_runs group by agent_name order by runs desc, name limit 10
      `,
      sql<{ page: string; people: number; views: number }[]>`
        ${scope}
        select page, count(distinct user_id)::integer as people, count(*)::integer as views
          from employee_views group by page order by people desc, views desc, page limit 10
      `,
      sql<{ entry: UsageEntry; runs: number }[]>`
        ${scope}
        select entry, count(*)::integer as runs from employee_runs group by entry order by runs desc
      `,
      sql<{ code: string; runs: number }[]>`
        ${scope}
        select coalesce(error_code, 'UNKNOWN') as code, count(*)::integer as runs
          from employee_runs where status = 'failed' group by 1 order by runs desc limit 8
      `,
      sql<{ name: string; employees: number; activeEmployees: number }[]>`
        ${scope},
        active_people as (select distinct user_id from activity)
        select p.department as name, count(*)::integer as employees, count(a.user_id)::integer as "activeEmployees"
          from people p left join active_people a on a.user_id = p.user_id
         group by p.department order by employees desc, name
      `,
      this.departmentNames(),
    ])
    const totalsRow = totals[0]!
    const averageDailyActive = daily.length
      ? Math.round(daily.reduce((sum, item) => sum + item.activeEmployees, 0) / daily.length * 10) / 10
      : 0
    return {
      range: filter.range,
      from: windowRows[0]!.from,
      to: windowRows[0]!.to,
      totals: { ...totalsRow, tokens: Number(totalsRow.tokens), averageDailyActive },
      daily: [...daily],
      agents: [...agents],
      pages: [...pages],
      entries: [...entries],
      failures: [...failures],
      departments: [...departments],
      departmentOptions: options,
    }
  }

  async people(filter: UsageFilter): Promise<UsagePeople> {
    await this.assertDepartment(filter.department)
    const sql = this.database
    const [active, idleRows] = await Promise.all([
      this.personRows(filter),
      sql<{ userId: string; name: string; department: string; createdAt: Date }[]>`
        ${this.scope(filter)},
        active_people as (select distinct user_id from activity)
        select p.user_id as "userId", p.name, p.department, p.created_at as "createdAt"
          from people p left join active_people a on a.user_id = p.user_id
         where a.user_id is null
         order by p.name
         limit ${USAGE_PEOPLE_LIMIT}
      `,
    ])
    // 最近一次活跃只看期间开始之前、与明细同一口径的活动（PR #172 评审）：不含发布试运行、管理助手与系统运行。
    const idleIds = idleRows.map(row => row.userId)
    const lastActive = idleIds.length ? await sql<{ userId: string; lastActiveAt: Date }[]>`
      ${this.scope(filter, { userIds: idleIds, window: 'before' })}
      select user_id as "userId", max(at) as "lastActiveAt" from activity group by user_id
    ` : []
    const lastById = new Map(lastActive.map(row => [row.userId, row.lastActiveAt]))
    const idle: IdlePerson[] = idleRows
      .map(row => ({ ...row, createdAt: iso(row.createdAt)!, lastActiveAt: iso(lastById.get(row.userId) ?? null) }))
      .sort((a, b) => (a.lastActiveAt ?? '').localeCompare(b.lastActiveAt ?? '') || a.name.localeCompare(b.name))
    return { active, idle }
  }

  async person(userId: string, range: UsageRange): Promise<UsagePersonDetail | null> {
    const sql = this.database
    const tz = this.timezone
    const days = USAGE_RANGE_DAYS[range]
    const filter: UsageFilter = { range }
    const [summary] = await this.personRows(filter, userId)
    if (!summary) return null
    const scope = this.scope(filter, { userIds: [userId] })
    const [daily, pages, entries] = await Promise.all([
      sql<{ day: string; runs: number }[]>`
        ${scope},
        days as (
          select to_char(d, 'YYYY-MM-DD') as day
            from generate_series((now() at time zone ${tz})::date - ${days - 1}::integer, (now() at time zone ${tz})::date, interval '1 day') d
        ),
        runs_by_day as (
          select to_char(created_at at time zone ${tz}, 'YYYY-MM-DD') as day, count(*)::integer as n from employee_runs group by 1
        )
        select days.day, coalesce(r.n, 0) as runs from days left join runs_by_day r on r.day = days.day order by days.day
      `,
      sql<{ page: string; views: number }[]>`
        ${scope}
        select page, count(*)::integer as views from employee_views group by page order by views desc, page limit 10
      `,
      sql<{ entry: UsageEntry; runs: number }[]>`
        ${scope}
        select entry, count(*)::integer as runs from employee_runs group by entry order by runs desc
      `,
    ])
    return { ...summary, daily: [...daily], pages: [...pages], entries: [...entries] }
  }

  private async personRows(filter: UsageFilter, userId?: string): Promise<UsagePerson[]> {
    const sql = this.database
    const tz = this.timezone
    const rows = await sql<PersonRow[]>`
      ${this.scope(filter, userId ? { userIds: [userId] } : {})},
      activity_by_user as (
        select user_id, max(at) as last_at, count(distinct to_char(at at time zone ${tz}, 'YYYY-MM-DD'))::integer as days
          from activity group by user_id
      ),
      runs_by_user as (
        select user_id, count(*)::integer as runs,
               count(*) filter (where status = 'succeeded')::integer as succeeded,
               count(*) filter (where status in ('succeeded', 'failed', 'cancelled'))::integer as finished
          from employee_runs group by user_id
      ),
      tokens_by_user as (
        select r.user_id, sum(mu.input_tokens + mu.output_tokens)::float8 as tokens
          from model_usage_events mu join employee_runs r on r.id = mu.run_id
         where mu.tenant_id = ${tenantId} group by r.user_id
      ),
      sessions_by_user as (select user_id, count(*)::integer as n from employee_sessions group by user_id),
      top_agent as (
        select distinct on (user_id) user_id, agent_name
          from (select user_id, agent_name, count(*) as n from employee_runs group by user_id, agent_name) ranked
         order by user_id, n desc, agent_name
      ),
      top_page as (
        select distinct on (user_id) user_id, page
          from (select user_id, page, count(*) as n from employee_views group by user_id, page) ranked
         order by user_id, n desc, page
      )
      select p.user_id as "userId", p.name, p.department, a.last_at as "lastActiveAt", a.days as "activeDays",
             coalesce(s.n, 0) as conversations, coalesce(r.runs, 0) as runs, coalesce(r.succeeded, 0) as "succeededRuns",
             coalesce(r.finished, 0) as "finishedRuns", coalesce(t.tokens, 0) as tokens,
             ag.agent_name as "topAgent", pg.page as "topPage"
        from people p
        join activity_by_user a on a.user_id = p.user_id
        left join runs_by_user r on r.user_id = p.user_id
        left join tokens_by_user t on t.user_id = p.user_id
        left join sessions_by_user s on s.user_id = p.user_id
        left join top_agent ag on ag.user_id = p.user_id
        left join top_page pg on pg.user_id = p.user_id
       order by a.last_at desc, p.name
       limit ${USAGE_PEOPLE_LIMIT}
    `
    return rows.map(toPerson)
  }

  /** 在职员工的部门名称（主部门）；筛选不存在的部门时明确报错，而不是静默返回 0 人（PR #172 评审）。 */
  private async departmentNames(): Promise<string[]> {
    const rows = await this.database<{ name: string }[]>`
      select distinct coalesce(nullif(btrim(department_id), ''), ${UNASSIGNED_DEPARTMENT}) as name
        from users where tenant_id = ${tenantId} and status = 'active' order by 1
    `
    return rows.map(row => row.name)
  }

  private async assertDepartment(department: string | undefined) {
    if (department && !(await this.departmentNames()).includes(department)) {
      throw invalidRequest(`部门“${department}”不存在或没有在职员工`)
    }
  }

  /** 公共 CTE：员工、期间内的员工侧运行、新建对话、页面访问与合并后的活动。 */
  private scope(filter: UsageFilter, options: { userIds?: readonly string[]; window?: 'in' | 'before' } = {}): PendingQuery<Row[]> {
    const sql = this.database
    const tz = this.timezone
    const days = USAGE_RANGE_DAYS[filter.range]
    const department = sql`coalesce(nullif(btrim(u.department_id), ''), ${UNASSIGNED_DEPARTMENT})`
    // 'before'：期间开始之前（未使用名单的最近一次活跃）。
    const inWindow = options.window === 'before' ? sql`< (select from_at from bounds)` : sql`>= (select from_at from bounds)`
    return sql`
      with bounds as (
        select (date_trunc('day', now() at time zone ${tz}) - make_interval(days => ${days - 1})) at time zone ${tz} as from_at
      ),
      people as (
        select u.id as user_id, u.display_name as name, ${department} as department, u.created_at
          from users u
         where u.tenant_id = ${tenantId} and u.status = 'active'
           ${filter.department ? sql`and ${department} = ${filter.department}` : sql``}
           ${options.userIds ? sql`and u.id = any(${[...options.userIds]})` : sql``}
      ),
      employee_runs as (
        select r.id, r.requested_by as user_id, r.status, r.created_at, ra.error_code,
               case when t.source_type = 'automation' then 'automation'
                    when t.source_type = 'agent_routine' then 'routine'
                    when w.workspace_type = 'team' then 'project'
                    else 'personal' end as entry,
               coalesce(ag.name, ${UNKNOWN_AGENT}) as agent_name
          from runs r
          join people p on p.user_id = r.requested_by
          left join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
          left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
          left join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
          left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
          left join agent_versions av on av.tenant_id = r.tenant_id
                 and av.id = coalesce(ra.manifest->>'agent_version_id', s.agent_version_id)
          left join agents ag on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
         where r.tenant_id = ${tenantId} and r.created_at  ${inWindow}
           and coalesce(ra.manifest->>'purpose', '') <> ${RELEASE_TRIAL_PURPOSE}
           and (s.audience = 'workbench' or t.source_type in ('automation', 'agent_routine'))
      ),
      employee_sessions as (
        select s.id, s.created_by as user_id, s.created_at
          from sessions s join people p on p.user_id = s.created_by
         where s.tenant_id = ${tenantId} and s.audience = 'workbench' and s.created_at  ${inWindow}
           -- 发布试运行的会话不是员工对话。
           and not exists (
             select 1 from runs tr join run_attempts ta on ta.tenant_id = tr.tenant_id and ta.run_id = tr.id
              where tr.tenant_id = s.tenant_id and tr.session_id = s.id and ta.manifest->>'purpose' = ${RELEASE_TRIAL_PURPOSE}
           )
      ),
      employee_views as (
        select e.user_id, e.page, e.in_dingtalk, e.occurred_at
          from product_events e join people p on p.user_id = e.user_id
         where e.tenant_id = ${tenantId} and e.app = 'workbench' and e.occurred_at  ${inWindow}
      ),
      activity as (
        select user_id, created_at as at from employee_runs
        union all select user_id, created_at from employee_sessions
        union all select user_id, occurred_at from employee_views
      )
    `
  }
}
