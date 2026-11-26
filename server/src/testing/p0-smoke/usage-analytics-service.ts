import {
  USAGE_RANGE_DAYS,
  type UsageAnalyticsQueryPort,
  type UsageFilter,
  type UsageOverview,
  type UsagePeople,
  type UsagePerson,
  type UsagePersonDetail,
  type UsageRange,
} from '../../domain/usage-analytics.ts'

/**
 * P0 冒烟的使用情况（OBS-E2E-04）：确定性内存数据，按周期缩放，不代表真实统计口径；
 * 口径由 usage-analytics.integration.test.ts 覆盖。
 */
const scale: Record<UsageRange, number> = { '7d': 0.3, '30d': 1, '90d': 2.6 }

interface SmokePerson extends Omit<UsagePerson, 'lastActiveAt'> { hoursAgo: number }

const people: SmokePerson[] = [
  { userId: 'U00001', name: '林岚', department: '华东销售部', hoursAgo: 1, activeDays: 21, conversations: 64, runs: 214, succeededRuns: 210, finishedRuns: 214, tokens: 1_900_000, topAgent: '合同审阅助手', topPage: 'workbench' },
  { userId: 'U00002', name: '赵宁', department: '研发中心', hoursAgo: 3, activeDays: 18, conversations: 41, runs: 388, succeededRuns: 361, finishedRuns: 388, tokens: 3_200_000, topAgent: '数据分析师', topPage: 'workspaces' },
  { userId: 'U00003', name: '周航', department: '财务部', hoursAgo: 26, activeDays: 9, conversations: 20, runs: 61, succeededRuns: 61, finishedRuns: 61, tokens: 600_000, topAgent: '财务报销核对', topPage: 'workbench' },
  { userId: 'U00004', name: '马骏', department: '华东销售部', hoursAgo: 60, activeDays: 4, conversations: 6, runs: 12, succeededRuns: 10, finishedRuns: 12, tokens: 100_000, topAgent: '周报写作', topPage: 'knowledge' },
]
const idle = [
  { userId: 'U00005', name: '吴婷', department: '财务部', createdAt: '2026-10-08T02:00:00.000Z', lastActiveAt: null },
  { userId: 'U00006', name: '郑凯', department: '行政部', createdAt: '2026-10-08T02:00:00.000Z', lastActiveAt: '2026-10-14T06:00:00.000Z' },
]
const departments = [
  { name: '华东销售部', employees: 42, active: 37 },
  { name: '研发中心', employees: 35, active: 31 },
  { name: '财务部', employees: 18, active: 9 },
  { name: '行政部', employees: 10, active: 3 },
]

const isoHoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const dayString = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)

function toPerson({ hoursAgo, ...person }: SmokePerson, factor: number): UsagePerson {
  return {
    ...person, lastActiveAt: isoHoursAgo(hoursAgo),
    activeDays: Math.max(1, Math.round(person.activeDays * Math.min(factor, 1))),
    conversations: Math.round(person.conversations * factor), runs: Math.round(person.runs * factor),
    succeededRuns: Math.round(person.succeededRuns * factor), finishedRuns: Math.round(person.finishedRuns * factor),
    tokens: Math.round(person.tokens * factor),
  }
}

export class SmokeUsageAnalyticsService implements UsageAnalyticsQueryPort {
  async overview(filter: UsageFilter): Promise<UsageOverview> {
    const factor = scale[filter.range]
    const days = USAGE_RANGE_DAYS[filter.range]
    const depts = departments.filter(item => !filter.department || item.name === filter.department)
    const employees = depts.reduce((sum, item) => sum + item.employees, 0)
    const active = Math.round(depts.reduce((sum, item) => sum + item.active, 0) * (filter.range === '7d' ? 0.8 : filter.range === '90d' ? 1.05 : 1))
    const share = employees ? active / 80 : 0
    const daily = Array.from({ length: days }, (_, index) => {
      const weekend = index % 7 === 5 || index % 7 === 6
      return { day: dayString(days - 1 - index), activeEmployees: Math.round((weekend ? 9 : 41 + (index * 7) % 13) * share), runs: Math.round((weekend ? 30 : 120 + (index * 11) % 40) * share) }
    })
    const runs = daily.reduce((sum, item) => sum + item.runs, 0)
    return {
      range: filter.range, from: dayString(days - 1), to: dayString(0),
      totals: {
        employees, activeEmployees: Math.min(active, employees),
        averageDailyActive: Math.round(daily.reduce((sum, item) => sum + item.activeEmployees, 0) / days * 10) / 10,
        newConversations: Math.round(1_284 * factor * share), runs, succeededRuns: Math.round(runs * 0.961), finishedRuns: runs,
        tokens: Math.round(18_400_000 * factor * share), dingtalkEmployees: Math.round(23 * share),
      },
      daily,
      agents: [
        { name: '合同审阅助手', runs: Math.round(1_180 * factor), people: 54 },
        { name: '数据分析师', runs: Math.round(860 * factor), people: 41 },
        { name: '周报写作', runs: Math.round(620 * factor), people: 66 },
      ],
      pages: [
        { page: 'workbench', people: 86, views: Math.round(3_100 * factor) },
        { page: 'workspaces', people: 48, views: Math.round(900 * factor) },
        { page: 'knowledge', people: 33, views: Math.round(410 * factor) },
      ],
      entries: [
        { entry: 'personal', runs: Math.round(runs * 0.62) }, { entry: 'project', runs: Math.round(runs * 0.21) },
        { entry: 'automation', runs: Math.round(runs * 0.11) }, { entry: 'routine', runs: Math.round(runs * 0.06) },
      ],
      failures: [{ code: 'RUN_TIMEOUT', runs: Math.round(61 * factor) }, { code: 'MODEL_CREDENTIAL_INVALID', runs: Math.round(12 * factor) }],
      departments: depts.map(item => ({ name: item.name, employees: item.employees, activeEmployees: item.active })),
      departmentOptions: departments.map(item => item.name),
    }
  }

  async people(filter: UsageFilter): Promise<UsagePeople> {
    const factor = scale[filter.range]
    const inDept = (department: string) => !filter.department || department === filter.department
    return {
      active: people.filter(person => inDept(person.department)).map(person => toPerson(person, factor)),
      idle: idle.filter(person => inDept(person.department)),
    }
  }

  async person(userId: string, range: UsageRange): Promise<UsagePersonDetail | null> {
    const found = people.find(person => person.userId === userId)
    if (!found) return null
    const days = USAGE_RANGE_DAYS[range]
    return {
      ...toPerson(found, scale[range]),
      daily: Array.from({ length: days }, (_, index) => ({ day: dayString(days - 1 - index), runs: index % 7 > 4 ? 0 : 3 + (index * 5) % 9 })),
      pages: [{ page: found.topPage ?? 'workbench', views: 62 }, { page: 'knowledge', views: 9 }],
      entries: [{ entry: 'personal', runs: Math.round(found.runs * 0.7) }, { entry: 'project', runs: Math.round(found.runs * 0.3) }],
    }
  }
}
