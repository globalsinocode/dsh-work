import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import {
  AuthorizationDeniedError,
  permissionDenied,
  requestInvalid,
} from '../../../domain/authorization-errors.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import type { PostgresWorkspaceService } from './postgres-workspace-service.ts'

const tenantId = 'tenant-dsh-work'

/** 冻结契约（批次 4 §2）：只接受 7d / 30d，缺省 7d。 */
const rangeDaysByValue: Record<string, number> = { '7d': 7, '30d': 30 }

export type WorkspaceUsageRange = '7d' | '30d'

export interface WorkspaceUsageDailyPoint {
  /** MM-DD，按数据库会话时区分桶，升序零填充。 */
  day: string
  callCount: number
  successCount: number
  failedCount: number
  inputTokens: number
  outputTokens: number
}

export interface WorkspaceUsageTotals {
  callCount: number
  successCount: number
  failedCount: number
  estimatedCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface WorkspaceUsageView {
  workspaceId: string
  range: WorkspaceUsageRange
  rangeDays: number
  totals: WorkspaceUsageTotals
  daily: WorkspaceUsageDailyPoint[]
}

interface UsageDayRow {
  day: string
  /** count()/sum() 在 postgres.js 里按 bigint 解码为字符串，见 toDailyPoint。 */
  callCount: string
  successCount: string
  failedCount: string
  estimatedCount: string
  inputTokens: string
  outputTokens: string
}

/**
 * 空间用量（批次 4 / 4-T1 / TW-09，AC-30）。
 *
 * 只读聚合面：仅负责人/管理员可读，读取轨（归档空间仍可读），个人空间 422，
 * 非成员与不存在空间不可枚举。数据源是 `model_usage_events`（每次 attempt 一行，
 * 由 DSH 上报或平台估算），严格按该空间会话所属 Run 过滤；不展示金额、币种、
 * provider/model 或员工身份（最小必要面）。
 *
 * 授权每次都从数据库重新解析（`resolveReadableWorkspace` + `requireTeamRole`），
 * 与 3-T7 的动态面同口径：失权成员的旧请求不会因为路由前置守卫而被放行。
 */
export class PostgresWorkspaceUsageService {
  private readonly database: DatabaseClient
  private readonly workspaces: PostgresWorkspaceService
  private readonly authorization: PostgresAuthorizationService

  constructor(
    database: DatabaseClient,
    workspaces: PostgresWorkspaceService,
    authorization: PostgresAuthorizationService,
  ) {
    this.database = database
    this.workspaces = workspaces
    this.authorization = authorization
  }

  async getWorkspaceUsage(input: {
    workspaceId: string
    actorUserId: string
    range?: string | null
  }): Promise<WorkspaceUsageView> {
    const { range, rangeDays } = parseUsageRange(input.range)
    const workspaceId = await this.assertReadableTeamWorkspace(input.workspaceId, input.actorUserId)
    await this.assertUsageRole(workspaceId, input.actorUserId)

    // 聚合形状（质量评审 P1 / 规格评审 S3 修正）：**先**把该空间窗口内的用量事件
    // 过滤成一个集合、按日聚合，再与日序列左连接。原写法是「日序列 → 全空间会话 →
    // 全 Run → 按日过滤事件」，join 条件里不含 days 的部分会生成 days×sessions×runs
    // 的中间量，并对整个租户的 model_usage_events 做哈希扫描（评审实测 16.3 万行时
    // 180ms、哈希溢写 temp；本形状 4.9ms 且结果逐行一致，走 sessions_by_workspace →
    // runs_by_session → model_usage_by_run 索引）。
    //
    // 状态口径（规格评审 S1）：DB 的 CHECK 允许 'blocked'，但当前没有任何写入者。
    // 这里只统计 success/failed，保证 callCount === successCount + failedCount 恒成立、
    // estimatedCount ⊆ callCount；将来真出现第三个状态时也不会出现「总数与分项对不上」。
    const rows = await this.database<UsageDayRow[]>`
      with workspace_usage_events as (
        select mu.occurred_at, mu.input_tokens, mu.output_tokens, mu.status, mu.estimated
          from sessions s
          join runs r
            on r.tenant_id = s.tenant_id and r.session_id = s.id
          join model_usage_events mu
            on mu.tenant_id = r.tenant_id and mu.run_id = r.id
         where s.tenant_id = ${tenantId}
           and s.workspace_id = ${workspaceId}
           and mu.status in ('success', 'failed')
           and mu.occurred_at >= current_date - make_interval(days => ${rangeDays - 1})
           and mu.occurred_at < current_date + interval '1 day'
      ),
      daily as (
        select date_trunc('day', occurred_at)::date as day,
               count(*) as "callCount",
               count(*) filter (where status = 'success') as "successCount",
               count(*) filter (where status = 'failed') as "failedCount",
               count(*) filter (where estimated) as "estimatedCount",
               coalesce(sum(input_tokens), 0) as "inputTokens",
               coalesce(sum(output_tokens), 0) as "outputTokens"
          from workspace_usage_events
         group by 1
      )
      select to_char(days.day, 'MM-DD') as day,
             coalesce(daily."callCount", 0) as "callCount",
             coalesce(daily."successCount", 0) as "successCount",
             coalesce(daily."failedCount", 0) as "failedCount",
             coalesce(daily."estimatedCount", 0) as "estimatedCount",
             coalesce(daily."inputTokens", 0) as "inputTokens",
             coalesce(daily."outputTokens", 0) as "outputTokens"
        from generate_series(
               current_date - make_interval(days => ${rangeDays - 1}),
               current_date,
               interval '1 day'
             ) days(day)
        left join daily on daily.day = days.day::date
       order by days.day
    `

    const days = rows.map(toDayTotals)
    // totals 由已按日分桶的行求和，避免第二次数据库往返；口径与 daily 必然一致。
    const totals = days.reduce<WorkspaceUsageTotals>((sum, point) => ({
      callCount: sum.callCount + point.callCount,
      successCount: sum.successCount + point.successCount,
      failedCount: sum.failedCount + point.failedCount,
      estimatedCount: sum.estimatedCount + point.estimatedCount,
      inputTokens: sum.inputTokens + point.inputTokens,
      outputTokens: sum.outputTokens + point.outputTokens,
      totalTokens: sum.totalTokens + point.inputTokens + point.outputTokens,
    }), {
      callCount: 0,
      successCount: 0,
      failedCount: 0,
      estimatedCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })

    // daily 按契约只暴露日维度计数与 token；estimatedCount 只在 totals 上出现。
    const daily: WorkspaceUsageDailyPoint[] = days.map(day => ({
      day: day.day,
      callCount: day.callCount,
      successCount: day.successCount,
      failedCount: day.failedCount,
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
    }))
    return { workspaceId, range, rangeDays, totals, daily }
  }

  /**
   * 读轨空间解析，与 3-T7 动态面同口径：归档空间的现任成员仍可读；非成员与
   * 不存在空间返回同一个 `resolveReadableWorkspace` 拒绝（不可枚举）。
   */
  private async assertReadableTeamWorkspace(rawWorkspaceId: string, actorUserId: string): Promise<string> {
    const workspaceId = typeof rawWorkspaceId === 'string' ? rawWorkspaceId.trim() : ''
    // 空 id / `standalone` 哨兵都会让 resolveReadableWorkspace 回退到调用者的个人
    // 空间（`normalizeWorkspaceId` 把 '' 与 'standalone' 都归一为 null），而那条
    // 回退路径会 `ensurePersonalWorkspace()` **写库**。读接口不得产生写副作用
    // （质量评审 P2 实测：GET /workspaces/standalone/usage 返回 422 但多出一个个人
    // 空间），因此在任何空间解析之前先拒绝这两个值。
    if (!workspaceId || workspaceId === 'standalone') {
      throw requestInvalid('仅支持团队工作空间查看空间用量')
    }
    const access = await this.workspaces.resolveReadableWorkspace(workspaceId, actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持团队工作空间查看空间用量')
    return workspaceId
  }

  /**
   * 角色门禁：`requireTeamRole` 在角色不足时已经抛类型化 `AuthorizationDeniedError`
   * （status 403 / code `permission_denied`），这里只需保留它并给出面向用户的中文
   * 说明；其余错误（数据库故障等）原样透传，绝不吞成 403。
   *
   * 历史：此前该分支抛的是裸 Error（无 status），HTTP 会被分类成 **500**，本服务靠
   * 匹配中文消息前缀来翻译（规格评审 S2）。现已把类型化下沉到授权服务本身，这个
   * 文本匹配随之删除。
   */
  private async assertUsageRole(workspaceId: string, actorUserId: string): Promise<void> {
    try {
      await this.authorization.requireTeamRole(workspaceId, actorUserId, ['owner', 'admin'], { purpose: 'read' })
    } catch (error) {
      if (error instanceof AuthorizationDeniedError && error.status === 403) {
        throw permissionDenied('仅负责人或管理员可以查看空间用量')
      }
      throw error
    }
  }
}

function parseUsageRange(raw: string | null | undefined): { range: WorkspaceUsageRange; rangeDays: number } {
  if (raw === null || raw === undefined) return { range: '7d', rangeDays: 7 }
  // Object.hasOwn 而不是直接取值：原型链上的 'toString' 等名字不能通过校验。
  if (!Object.hasOwn(rangeDaysByValue, raw)) throw requestInvalid('range 仅支持 7d 或 30d')
  return { range: raw as WorkspaceUsageRange, rangeDays: rangeDaysByValue[raw]! }
}

/**
 * postgres.js 把 bigint 列（`count()` / `sum()` 的返回类型）解码成字符串，以免
 * 超出 JS 安全整数时静默丢精度。这里的计数与 token 都是非负整数，且窗口最多 30 天，
 * 总量远低于 `Number.MAX_SAFE_INTEGER`（约 9.0×10^15），因此 `Number()` 转换在
 * 本接口口径下是精确的。
 */
function toDayTotals(row: UsageDayRow): WorkspaceUsageDailyPoint & { estimatedCount: number } {
  return {
    day: row.day,
    callCount: Number(row.callCount),
    successCount: Number(row.successCount),
    failedCount: Number(row.failedCount),
    estimatedCount: Number(row.estimatedCount),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
  }
}
