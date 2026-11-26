/**
 * 错误记录（docs/design/error-tracking-usage-plan.md，OBS-S1）的领域类型与管理端查询端口。
 * 纯类型与常量，不访问数据库；PostgreSQL 实现在 modules/observability，P0 冒烟实现在 testing/p0-smoke。
 */

export const ERROR_SOURCES = ['workbench', 'admin', 'server', 'process'] as const
export type ErrorSource = typeof ERROR_SOURCES[number]

/** 浏览器可上报的类型；`http`、`uncaught` 只由服务端写入，`overflow` 是新增问题过多时的汇总组。 */
export const CLIENT_ERROR_KINDS = ['render', 'script', 'promise', 'api', 'notice', 'load', 'stream'] as const
export type ClientErrorKind = typeof CLIENT_ERROR_KINDS[number]
export type ErrorKind = ClientErrorKind | 'http' | 'uncaught' | 'overflow'

export const ERROR_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const
export type ErrorRange = keyof typeof ERROR_RANGE_DAYS

/** 样本保留天数（OB10）。 */
export const ERROR_RETENTION_DAYS = 90
/** 每个租户每小时最多新增的问题组（评审第 2 条）；超出后新指纹并入汇总组。 */
export const NEW_GROUPS_PER_HOUR = 200
/** 同一员工同一问题在该窗口内的重复只累加次数，不新增样本。 */
export const DEDUPE_WINDOW_SECONDS = 60
/** 详情中返回的最近样本数。 */
export const DETAIL_SAMPLE_LIMIT = 20

export interface ErrorGroupFilter {
  range: ErrorRange
  source?: ErrorSource
  /** 是否包含“提示”类（员工看到的失败提示）；默认不含。 */
  includeNotice: boolean
  release?: string
  sort: 'recent' | 'count'
}

export interface ErrorGroupSummary {
  id: string
  source: ErrorSource
  kind: ErrorKind
  message: string
  /** 最近一个样本的页面或路由。 */
  route: string | null
  /** 周期内次数（含 1 分钟内的重复）。 */
  count: number
  /** 周期内受影响的员工数；未登录上报不计入。 */
  people: number
  anonymous: boolean
  firstSeenAt: string
  lastSeenAt: string
  lastRelease: string | null
}

export interface ErrorGroupList {
  items: ErrorGroupSummary[]
  releases: string[]
}

export interface ErrorSample {
  occurredAt: string
  userId: string | null
  userName: string | null
  route: string | null
  client: string | null
  release: string | null
  traceId: string | null
  runId: string | null
  repeatCount: number
}

export interface ErrorGroupDetail extends ErrorGroupSummary {
  /** 自首次出现以来的累计次数；`count`、`people` 与列表同一周期。 */
  totalCount: number
  /** 最近样本的堆栈：浏览器堆栈按源码映射还原（还原不了时为原始帧位置）。 */
  stack: string | null
  stackResolved: boolean
  samples: ErrorSample[]
}

export interface RunProblemSummary {
  failed: number
  timedOut: number
  cancelled: number
  emptyAnswer: number
  totalRuns: number
  reasons: Array<{ code: string; label: string; runs: number; people: number; lastAt: string }>
  tools: Array<{ tool: string; failed: number; denied: number; topReason: string }>
}

export interface LookupRun {
  runId: string
  status: string
  errorCode: string | null
  agentName: string | null
  requestedBy: string | null
  createdAt: string
}

export interface ErrorLookupResult {
  query: string
  kind: 'trace' | 'run' | 'unknown'
  serverFailures: Array<ErrorSample & { groupId: string; message: string }>
  clientReports: Array<ErrorSample & { groupId: string; message: string; source: ErrorSource }>
  runs: LookupRun[]
}

export interface ErrorRecordsQueryPort {
  listGroups(filter: ErrorGroupFilter): Promise<ErrorGroupList>
  getGroup(id: string, range: ErrorRange): Promise<ErrorGroupDetail | null>
  runProblems(range: ErrorRange): Promise<RunProblemSummary>
  lookup(query: string): Promise<ErrorLookupResult>
}

export function parseErrorGroupFilter(params: URLSearchParams): ErrorGroupFilter {
  const range = params.get('range')
  const source = params.get('source')
  const release = params.get('release')?.trim()
  return {
    range: range && range in ERROR_RANGE_DAYS ? range as ErrorRange : '7d',
    ...(source && (ERROR_SOURCES as readonly string[]).includes(source) ? { source: source as ErrorSource } : {}),
    includeNotice: params.get('include_notice') === 'true',
    ...(release ? { release: release.slice(0, 64) } : {}),
    sort: params.get('sort') === 'count' ? 'count' : 'recent',
  }
}

export function parseErrorRange(value: string | null): ErrorRange {
  return value && value in ERROR_RANGE_DAYS ? value as ErrorRange : '7d'
}

/** 运行失败原因的中文说明；未登记的错误码原样显示。 */
export const RUN_ERROR_LABELS: Record<string, string> = {
  RUN_TIMEOUT: '运行超时',
  SERVICE_RESTARTED: '服务重启中断',
  RUNTIME_UNAVAILABLE: '运行时不可用',
  RUNTIME_EXECUTION_FAILED: '运行时执行失败',
  MODEL_CREDENTIAL_INVALID: '模型凭据无效',
  MODEL_ROUTE_UNAVAILABLE: '模型路由不可用',
  EXECUTION_CONTAINER_UNAVAILABLE: '执行容器不可用',
  BACKGROUND_CAPACITY_EXHAUSTED: '后台容量已满',
  EMPTY_ANSWER: '成功但没有回答',
}

/** 服务端 5xx 的安全摘要，交给错误记录（错误记录方案 6.2）；不含请求体与原始错误对象。 */
export interface ServerFailure {
  traceId: string
  method: string
  /** 注册的路由模板，不含实际参数值。 */
  routePath: string
  status: number
  code: string
  /** 原始错误消息（调用方负责脱敏后再保存）。 */
  errorMessage: string
  params: Record<string, string>
  userId: string | null
}
