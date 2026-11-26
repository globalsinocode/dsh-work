/**
 * 使用情况（运营概览，错误记录与使用情况方案 6.5，OBS-S2）的领域类型与查询端口。
 * 只出使用量与功能分布，不含对话标题、消息正文或附件名称。
 */

export const USAGE_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const
export type UsageRange = keyof typeof USAGE_RANGE_DAYS

/** 页面访问保留天数（OB10）。 */
export const PRODUCT_EVENT_RETENTION_DAYS = 180
/** 同一员工同一端同一页面在该窗口内只记一次。 */
export const PAGE_VIEW_DEDUPE_MINUTES = 30
/** 按人明细与未使用名单最多返回的人数。 */
export const USAGE_PEOPLE_LIMIT = 2_000

export type UsageEntry = 'personal' | 'project' | 'automation' | 'routine'

export interface UsageFilter {
  range: UsageRange
  /** 部门名称（`users.department_id` 存主部门名称）；不传为全部。 */
  department?: string
}

export interface UsageOverview {
  range: UsageRange
  from: string
  to: string
  totals: {
    employees: number
    activeEmployees: number
    averageDailyActive: number
    newConversations: number
    runs: number
    succeededRuns: number
    finishedRuns: number
    tokens: number
    dingtalkEmployees: number
  }
  daily: Array<{ day: string; activeEmployees: number; runs: number }>
  agents: Array<{ name: string; runs: number; people: number }>
  pages: Array<{ page: string; people: number; views: number }>
  entries: Array<{ entry: UsageEntry; runs: number }>
  failures: Array<{ code: string; runs: number }>
  departments: Array<{ name: string; employees: number; activeEmployees: number }>
  departmentOptions: string[]
}

export interface UsagePerson {
  userId: string
  name: string
  department: string
  lastActiveAt: string | null
  activeDays: number
  conversations: number
  runs: number
  succeededRuns: number
  finishedRuns: number
  tokens: number
  topAgent: string | null
  topPage: string | null
}

export interface IdlePerson {
  userId: string
  name: string
  department: string
  createdAt: string
  /** 期间之前最近一次活动；从未使用为 null。 */
  lastActiveAt: string | null
}

export interface UsagePeople {
  active: UsagePerson[]
  idle: IdlePerson[]
}

export interface UsagePersonDetail extends UsagePerson {
  daily: Array<{ day: string; runs: number }>
  pages: Array<{ page: string; views: number }>
  entries: Array<{ entry: UsageEntry; runs: number }>
}

export interface UsageAnalyticsQueryPort {
  overview(filter: UsageFilter): Promise<UsageOverview>
  people(filter: UsageFilter): Promise<UsagePeople>
  person(userId: string, range: UsageRange): Promise<UsagePersonDetail | null>
}

export function parseUsageFilter(params: URLSearchParams): UsageFilter {
  const range = params.get('range')
  const department = params.get('department')?.trim()
  return {
    range: range && range in USAGE_RANGE_DAYS ? range as UsageRange : '30d',
    ...(department ? { department: department.slice(0, 120) } : {}),
  }
}
