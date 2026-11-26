import {
  ERROR_RANGE_DAYS,
  RUN_ERROR_LABELS,
  type ErrorGroupDetail,
  type ErrorGroupFilter,
  type ErrorGroupList,
  type ErrorLookupResult,
  type ErrorRecordsQueryPort,
  type RunProblemSummary,
} from '../../domain/error-records.ts'

/**
 * P0 冒烟的错误记录（OBS-E2E-01、OBS-E2E-02）：确定性内存数据，不代表真实统计口径；
 * 归并、去重与关联口径由 error-records.integration.test.ts 覆盖。
 */
export const SMOKE_TRACE_ID = 'trace-http-7c1e9d20-0f3b-4a8e-9b61-5d2c88e4b42a'
export const SMOKE_RUN_ID = 'run-smoke-err-001'

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

const groups: Array<Omit<ErrorGroupDetail, 'totalCount'> & { totalCount?: number }> = [
  {
    id: 'err-smoke-render', source: 'workbench', kind: 'render', route: 'conversation',
    message: "TypeError: Cannot read properties of undefined (reading 'artifacts')",
    count: 37, people: 12, anonymous: false, firstSeenAt: hoursAgo(50), lastSeenAt: hoursAgo(1), lastRelease: '2026.11.26-01',
    stack: '  at renderArtifacts (src/components/ArtifactList.vue:48:22)\n  at setup (src/views/ConversationView.vue:312:9)', stackResolved: true, totalCount: 52,
    samples: [
      { occurredAt: hoursAgo(1), userId: 'U00001', userName: '林岚', route: 'conversation', client: 'Chrome 131 / macOS', release: '2026.11.26-01', traceId: null, runId: null, repeatCount: 2 },
      { occurredAt: hoursAgo(3), userId: 'U00002', userName: '赵宁', route: 'conversation', client: '钉钉 iOS', release: '2026.11.26-01', traceId: null, runId: null, repeatCount: 1 },
    ],
  },
  {
    id: 'err-smoke-server', source: 'server', kind: 'http', route: 'GET /api/workbench/v1/runs/:runId/events',
    message: '500 operation_failed：会话事件读取失败',
    count: 21, people: 9, anonymous: false, firstSeenAt: hoursAgo(30), lastSeenAt: hoursAgo(2), lastRelease: '2026.11.26-01',
    stack: null, stackResolved: false,
    samples: [
      { occurredAt: hoursAgo(2), userId: 'U00001', userName: '林岚', route: 'GET /api/workbench/v1/runs/:runId/events', client: null, release: '2026.11.26-01', traceId: SMOKE_TRACE_ID, runId: SMOKE_RUN_ID, repeatCount: 1 },
    ],
  },
  {
    id: 'err-smoke-load', source: 'workbench', kind: 'load', route: 'project-space',
    message: '页面资源加载失败（可能刚升级）',
    count: 14, people: 14, anonymous: false, firstSeenAt: hoursAgo(4), lastSeenAt: hoursAgo(3), lastRelease: '2026.11.16-01',
    stack: null, stackResolved: false,
    samples: [{ occurredAt: hoursAgo(3), userId: 'U00003', userName: '周航', route: 'project-space', client: 'Edge 131 / Windows', release: '2026.11.16-01', traceId: null, runId: null, repeatCount: 1 }],
  },
  {
    id: 'err-smoke-dingtalk', source: 'workbench', kind: 'script', route: 'dingtalk-login',
    message: 'Error: requestAuthCode fail (errorCode 7)',
    count: 6, people: 0, anonymous: true, firstSeenAt: hoursAgo(26), lastSeenAt: hoursAgo(5), lastRelease: '2026.11.26-01',
    stack: '  at requestCode (dingtalk-Bx81kQ.js:1:731)', stackResolved: false,
    samples: [{ occurredAt: hoursAgo(5), userId: null, userName: null, route: 'dingtalk-login', client: '钉钉 Android', release: '2026.11.26-01', traceId: null, runId: null, repeatCount: 1 }],
  },
  {
    id: 'err-smoke-admin', source: 'admin', kind: 'api', route: 'skills',
    message: '网络请求失败',
    count: 3, people: 1, anonymous: false, firstSeenAt: hoursAgo(72), lastSeenAt: hoursAgo(70), lastRelease: '2026.11.16-01',
    stack: null, stackResolved: false,
    samples: [{ occurredAt: hoursAgo(70), userId: 'admin-001', userName: '平台管理员', route: 'skills', client: 'Chrome 131 / macOS', release: '2026.11.16-01', traceId: null, runId: null, repeatCount: 3 }],
  },
  {
    id: 'err-smoke-notice', source: 'workbench', kind: 'notice', route: 'project-space',
    message: '失败提示 打开项目（forbidden）',
    count: 52, people: 17, anonymous: false, firstSeenAt: hoursAgo(120), lastSeenAt: hoursAgo(1), lastRelease: '2026.11.26-01',
    stack: null, stackResolved: false,
    samples: [{ occurredAt: hoursAgo(1), userId: 'U00004', userName: '马骏', route: 'project-space', client: '钉钉 iOS', release: '2026.11.26-01', traceId: SMOKE_TRACE_ID, runId: null, repeatCount: 1 }],
  },
]

export class SmokeErrorRecordsService implements ErrorRecordsQueryPort {
  async listGroups(filter: ErrorGroupFilter): Promise<ErrorGroupList> {
    const since = Date.now() - ERROR_RANGE_DAYS[filter.range] * 86_400_000
    const items = groups
      .filter(group => Date.parse(group.lastSeenAt) > since)
      .filter(group => !filter.source || group.source === filter.source)
      .filter(group => filter.includeNotice || group.kind !== 'notice')
      .filter(group => !filter.release || group.lastRelease === filter.release)
      .sort((a, b) => filter.sort === 'count' ? b.count - a.count : Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .map(({ stack: _stack, stackResolved: _resolved, samples: _samples, totalCount: _total, ...summary }) => summary)
    return { items, releases: ['2026.11.26-01', '2026.11.16-01'] }
  }

  async getGroup(id: string) {
    const group = groups.find(item => item.id === id)
    return group ? { ...group, totalCount: group.totalCount ?? group.count } : null
  }

  async runProblems(): Promise<RunProblemSummary> {
    return {
      totalRuns: 3_902, failed: 142, timedOut: 61, cancelled: 35, emptyAnswer: 18,
      reasons: [
        { code: 'RUN_TIMEOUT', label: RUN_ERROR_LABELS.RUN_TIMEOUT!, runs: 61, people: 23, lastAt: hoursAgo(2) },
        { code: 'EXECUTION_CONTAINER_UNAVAILABLE', label: RUN_ERROR_LABELS.EXECUTION_CONTAINER_UNAVAILABLE!, runs: 38, people: 30, lastAt: hoursAgo(40) },
        { code: 'EMPTY_ANSWER', label: RUN_ERROR_LABELS.EMPTY_ANSWER!, runs: 18, people: 11, lastAt: hoursAgo(3) },
      ],
      tools: [
        { tool: 'bash', failed: 44, denied: 6, topReason: 'TOOL_TIMEOUT' },
        { tool: 'web_fetch', failed: 7, denied: 19, topReason: 'TOOL_PERMISSION_DENIED' },
      ],
    }
  }

  async lookup(query: string): Promise<ErrorLookupResult> {
    const value = query.trim()
    const run = { runId: SMOKE_RUN_ID, status: 'failed', errorCode: 'RUN_TIMEOUT', agentName: '合同审阅助手', requestedBy: '林岚', createdAt: hoursAgo(2) }
    const server = groups[1]!
    const serverFailures = [{ ...server.samples[0]!, groupId: server.id, message: server.message }]
    if (value === SMOKE_TRACE_ID) {
      const notice = groups[5]!
      return {
        query: value, kind: 'trace', serverFailures,
        clientReports: [{ ...notice.samples[0]!, groupId: notice.id, message: notice.message, source: 'workbench' }],
        runs: [run],
      }
    }
    if (value === SMOKE_RUN_ID || value === `trace-${SMOKE_RUN_ID}`) {
      return { query: value, kind: 'run', serverFailures, clientReports: [], runs: [run] }
    }
    return { query: value, kind: 'unknown', serverFailures: [], clientReports: [], runs: [] }
  }
}
