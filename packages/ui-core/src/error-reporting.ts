import type { App } from 'vue'

/** 只用到路由器的 afterEach（不让共享包依赖 vue-router）。 */
interface RouterLike { afterEach(guard: (to: { name?: unknown; meta?: Record<string, unknown> }) => unknown): unknown }

/**
 * 浏览器错误上报（错误记录方案 6.2，OBS-S1），员工端与管理端共用。
 *
 * - 捕获组件渲染错误、未处理的脚本错误与 Promise 拒绝、接口 5xx/超时/网络失败、失败提示、
 *   升级后分片加载失败与实时流放弃重连；
 * - 同一页面加载内同一问题首次出现时上报，之后只累计次数、最多每分钟（及页面隐藏时）补报一次，每次加载最多 20 个问题；
 * - 批量发送到 `/auth/{app}/client-errors`（登录前的页面也能上报），页面隐藏时用 `sendBeacon`；上报失败直接丢弃，不重试、不再触发上报；
 * - 失败提示只报错误码与提示模板（动作名），不报提示原文；不报请求体、页面文字与查询参数。
 */

export type ReportKind = 'render' | 'script' | 'promise' | 'api' | 'notice' | 'load' | 'stream'

export interface ErrorReport {
  kind: ReportKind
  message?: string
  stack?: string
  /** 前端路由名；不传时取当前路由名。 */
  route?: string
  traceId?: string
  runId?: string
  code?: string
  /** 仅失败提示：动作名等固定文案（如“发送消息”），不含用户内容。 */
  template?: string
}

interface QueuedReport extends ErrorReport { release?: string; count: number }

export interface ErrorReporterOptions {
  app: 'workbench' | 'admin'
  release?: string
  endpoint?: string
  pageViewEndpoint?: string
  /** 当前路由名（由路由器提供）。 */
  routeName?: () => string | undefined
  /** 测试替身；默认 `navigator.sendBeacon`，不可用时用 `fetch(keepalive)`。 */
  transport?: (url: string, body: string) => void
  flushDelayMs?: number
  /** 已上报问题再次出现时，累计次数最多多久补报一次。 */
  repeatDelayMs?: number
  maxProblems?: number
}

const TRACE_ID = /^trace-http-[0-9a-f-]{36}$/i
const SAFE = /^[A-Za-z0-9_.:-]{1,120}$/
const CODE = /^[A-Za-z0-9_]{1,80}$/
const TEMPLATE = /^[\p{Script=Han}A-Za-z0-9 _.:-]{1,40}$/u
const BATCH_SIZE = 20
const PAGE_VIEW_DEDUPE_MS = 30 * 60_000

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.length > max ? value.slice(0, max) : value
}

function defaultTransport(url: string, body: string) {
  try {
    const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' })
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, blob)) return
    void fetch(url, { method: 'POST', body, keepalive: true, credentials: 'include', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
      .catch(() => undefined)
  } catch {
    // 上报失败直接丢弃。
  }
}

export class ErrorReporter {
  private readonly options: Required<Pick<ErrorReporterOptions, 'app' | 'endpoint' | 'pageViewEndpoint' | 'flushDelayMs' | 'repeatDelayMs' | 'maxProblems'>> & ErrorReporterOptions
  /** 本次页面加载见过的问题；`unsent` 为尚未发出的次数。 */
  private readonly entries = new Map<string, { report: QueuedReport; unsent: number; sent: boolean }>()
  /** 页面访问（OBS-S2）：同一页面 30 分钟内只记一次，随错误一同批量发送到页面访问接口。 */
  private readonly pageSeenAt = new Map<string, number>()
  private pageViews: Array<{ page: string; inDingtalk: boolean }> = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private repeatTimer: ReturnType<typeof setTimeout> | undefined
  private reporting = false

  constructor(options: ErrorReporterOptions) {
    this.options = { endpoint: `/auth/${options.app}/client-errors`, pageViewEndpoint: `/auth/${options.app}/page-views`, flushDelayMs: 2_000, repeatDelayMs: 60_000, maxProblems: 20, ...options }
  }

  report(input: ErrorReport): void {
    if (this.reporting) return
    this.reporting = true
    try {
      const report = this.normalize(input)
      if (!report) return
      const key = [report.kind, report.code ?? '', report.template ?? '', report.route ?? '', (report.message ?? '').slice(0, 200), (report.stack ?? '').split('\n', 2)[1] ?? ''].join('|')
      const entry = this.entries.get(key)
      if (entry) {
        // 再次出现只累加次数：未发出的随首次上报一起发；已发出的按 repeatDelayMs 合并一次（或页面隐藏时）补报。
        entry.unsent = Math.min(entry.unsent + 1, 1_000)
        if (entry.sent) this.scheduleRepeat()
        return
      }
      if (this.entries.size >= this.options.maxProblems) return
      // 第一次出现：flushDelayMs 后上报。
      this.entries.set(key, { report, unsent: 1, sent: false })
      this.schedule()
    } catch {
      // 上报器自身的问题不得影响页面。
    } finally {
      this.reporting = false
    }
  }

  /** 失败提示：只取错误码、动作名与链路编号。 */
  reportNotice(action: string, cause: unknown): void {
    const failure = (cause && typeof cause === 'object' ? cause : {}) as { code?: unknown; traceId?: unknown; status?: unknown }
    const status = typeof failure.status === 'number' ? failure.status : undefined
    // 5xx 已由接口层上报，这里只记员工看到的业务失败提示。
    if (status !== undefined && status >= 500) return
    this.report({
      kind: 'notice',
      code: typeof failure.code === 'string' ? failure.code : 'client_failure',
      template: action,
      traceId: typeof failure.traceId === 'string' ? failure.traceId : undefined,
    })
  }

  /** 接口失败：只报 5xx、超时与网络失败（4xx 是业务结果）。 */
  reportApiFailure(input: { status?: number; code?: string; traceId?: string; message?: string; networkError?: boolean }): void {
    if (!input.networkError && (input.status === undefined || input.status < 500)) return
    this.report({
      kind: 'api',
      message: input.networkError ? '网络请求失败' : `接口返回 ${input.status}`,
      code: input.code,
      traceId: input.traceId,
    })
  }

  /** 记录一次页面访问（路由名）；未登录时服务端不记录。 */
  reportPageView(page: string): void {
    try {
      if (!SAFE.test(page)) return
      const now = Date.now()
      const last = this.pageSeenAt.get(page)
      if (last !== undefined && now - last < PAGE_VIEW_DEDUPE_MS) return
      this.pageSeenAt.set(page, now)
      const inDingtalk = typeof navigator !== 'undefined' && /DingTalk/i.test(navigator.userAgent)
      this.pageViews.push({ page, inDingtalk })
      this.schedule()
    } catch {
      // 不影响页面。
    }
  }

  /** 路由切换后记录页面访问（只用路由名，不用网址）。 */
  trackRouter(router: RouterLike): void {
    router.afterEach(to => {
      // 登录、改密等公开页面不记：此时未登录，服务端也不会记录，先记下反而会让登录后 30 分钟内漏记（PR #172 评审）。
      if (to.meta?.public === true) return
      if (typeof to.name === 'string') this.reportPageView(to.name)
    })
  }

  /** 发出全部未发出的次数（首次上报与累计的重复次数）与页面访问。 */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.repeatTimer) clearTimeout(this.repeatTimer)
    this.timer = undefined
    this.repeatTimer = undefined
    const queue: QueuedReport[] = []
    for (const entry of this.entries.values()) {
      if (entry.unsent === 0) continue
      queue.push({ ...entry.report, count: entry.unsent })
      entry.unsent = 0
      entry.sent = true
    }
    const transport = this.options.transport ?? defaultTransport
    while (this.pageViews.length) {
      const views = this.pageViews.splice(0, BATCH_SIZE)
      try {
        transport(this.options.pageViewEndpoint, JSON.stringify({ app: this.options.app, views }))
      } catch {
        // 丢弃。
      }
    }
    while (queue.length) {
      const batch = queue.splice(0, BATCH_SIZE)
      const body = JSON.stringify({ app: this.options.app, reports: batch })
      const url = this.options.endpoint
      try {
        ;(this.options.transport ?? defaultTransport)(url, body)
      } catch {
        // 丢弃。
      }
    }
  }

  /** 接入 Vue 应用与全局事件。 */
  install(app: App): void {
    const previous = app.config.errorHandler
    app.config.errorHandler = (error, instance, info) => {
      this.report({ kind: 'render', ...describeError(error) })
      if (previous) previous(error, instance, info)
      else console.error(error)
    }
    if (typeof window === 'undefined') return
    window.addEventListener('error', event => {
      const target = event.target as Element | null
      if (target && target !== (window as unknown as Element) && 'tagName' in target) {
        const tag = target.tagName
        if (tag === 'SCRIPT' || tag === 'LINK') this.report({ kind: 'load', message: `${tag === 'SCRIPT' ? '脚本' : '样式'}加载失败` })
        return
      }
      this.report({ kind: 'script', ...(event.error ? describeError(event.error) : { message: event.message }) })
    }, true)
    window.addEventListener('unhandledrejection', event => {
      this.report({ kind: 'promise', ...describeError(event.reason) })
    })
    // 升级后旧页面加载新分片失败：提示刷新并上报（Vite 预加载失败事件）。
    window.addEventListener('vite:preloadError', () => {
      this.report({ kind: 'load', message: '页面资源加载失败（可能刚升级）' })
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush()
    })
    window.addEventListener('pagehide', () => this.flush())
  }

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.options.flushDelayMs)
  }

  private scheduleRepeat() {
    if (this.repeatTimer || this.timer) return
    this.repeatTimer = setTimeout(() => this.flush(), this.options.repeatDelayMs)
  }

  private normalize(input: ErrorReport): QueuedReport | null {
    const route = input.route ?? this.options.routeName?.()
    const report: QueuedReport = { kind: input.kind, count: 1 }
    if (input.kind !== 'notice') {
      const message = text(input.message, 2_000)
      const stack = text(input.stack, 16_000)
      if (message) report.message = message
      if (stack) report.stack = stack
    } else {
      const template = text(input.template, 40)
      if (template && TEMPLATE.test(template)) report.template = template
    }
    if (route && SAFE.test(route)) report.route = route
    if (input.traceId && TRACE_ID.test(input.traceId)) report.traceId = input.traceId
    if (input.runId && SAFE.test(input.runId)) report.runId = input.runId
    if (input.code && CODE.test(input.code)) report.code = input.code
    if (input.kind === 'notice' && !report.code) return null
    if (this.options.release) report.release = this.options.release.slice(0, 64)
    return report
  }
}

/**
 * 平台接口错误（带 `code` 与 HTTP `status`）的消息是给员工看的提示，可能含对象名，只报错误码与链路编号；
 * 其他异常报名称与消息（服务端再脱敏，引号内容一律去掉）。
 */
function describeError(error: unknown): Pick<ErrorReport, 'message' | 'stack' | 'code' | 'traceId'> {
  const candidate = (error && typeof error === 'object' ? error : {}) as { code?: unknown; status?: unknown; traceId?: unknown; name?: unknown }
  if (typeof candidate.code === 'string' && typeof candidate.status === 'number') {
    return {
      message: `${typeof candidate.name === 'string' ? candidate.name : 'ApiError'} (${candidate.status})`,
      code: candidate.code,
      traceId: typeof candidate.traceId === 'string' ? candidate.traceId : undefined,
    }
  }
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: typeof error.stack === 'string' ? error.stack : undefined }
  }
  return { message: typeof error === 'string' ? error : '未知错误' }
}

let shared: ErrorReporter | undefined

/** 应用启动时创建一次；之后由 API 客户端、失败提示等通过 `errorReporter()` 使用。 */
export function setupErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  shared = new ErrorReporter(options)
  return shared
}

export function errorReporter(): ErrorReporter | undefined {
  return shared
}
