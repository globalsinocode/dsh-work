import type { IncomingMessage } from 'node:http'

import type { ApiAuthenticator, RequestIdentity } from '../modules/identity/types.ts'
import {
  ClientErrorReportInvalid,
  MAX_BATCH_BYTES,
  clientAddress,
  clientSummary,
  parseClientErrorBatch,
  type ErrorRecordInput,
} from '../modules/observability/client-error-report.ts'
import { FixedWindowLimiter } from '../modules/observability/fixed-window-limiter.ts'
import { RequestError, invalidRequest } from '../domain/request-errors.ts'
import { httpResult, type Router } from './router.ts'

export interface ClientErrorRouteOptions {
  record: (input: ErrorRecordInput) => Promise<void>
  /** 页面访问（OBS-S2）；不传时不注册页面访问接口。 */
  recordPageViews?: (userId: string, app: 'workbench' | 'admin', views: PageView[]) => Promise<number>
  authenticate?: ApiAuthenticator
  /** 校验 `Origin` 是本平台对应前端入口；不符时抛错。 */
  validateOrigin: (request: IncomingMessage, audience: 'workbench' | 'admin') => void
  now?: () => number
}

const MINUTE = 60_000
const PAGE_NAME = /^[A-Za-z0-9_.:/-]{1,120}$/

export interface PageView { page: string; inDingtalk: boolean }

/** 页面访问的结构校验：`{ app, views: [{ page, inDingtalk }] }`，最多 20 条，多余字段整批拒绝。 */
export function parsePageViews(body: unknown, app: 'workbench' | 'admin'): PageView[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest('请求内容必须是对象')
  const record = body as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'app' && key !== 'views')) throw invalidRequest('请求包含未知字段')
  if (record.app !== app) throw invalidRequest('上报来源与内容不一致')
  if (!Array.isArray(record.views) || record.views.length === 0 || record.views.length > 20) throw invalidRequest('views 必须是 1～20 条')
  return record.views.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidRequest('页面访问必须是对象')
    const item = raw as Record<string, unknown>
    if (Object.keys(item).some(key => key !== 'page' && key !== 'inDingtalk')) throw invalidRequest('页面访问包含未知字段')
    if (typeof item.page !== 'string' || !PAGE_NAME.test(item.page)) throw invalidRequest('page 必须是页面路由名')
    if (item.inDingtalk !== undefined && typeof item.inDingtalk !== 'boolean') throw invalidRequest('inDingtalk 不符合要求')
    return { page: item.page, inDingtalk: item.inDingtalk === true }
  })
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size > MAX_BATCH_BYTES) throw new ClientErrorReportInvalid('上报内容超过 32 KB')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * 浏览器错误上报（`POST /auth/{workbench|admin}/client-errors`，错误记录方案 6.2，OBS-S1）。登录与否都接收：已登录记员工，未登录不记身份、
 * 按来源 IP 更严格限流。超出限额的条目直接丢弃，仍返回 202，不让上报影响页面。
 */
export function registerClientErrorRoutes(router: Router, options: ClientErrorRouteOptions) {
  const now = options.now ?? Date.now
  const perUser = new FixedWindowLimiter({ limit: 60, windowMs: MINUTE, now })
  const perAddress = new FixedWindowLimiter({ limit: 10, windowMs: MINUTE, now })
  const anonymousTotal = new FixedWindowLimiter({ limit: 300, windowMs: MINUTE, now })
  const pageViewsPerUser = new FixedWindowLimiter({ limit: 120, windowMs: MINUTE, now })
  // 页面访问接口在读请求体与查身份之前按来源地址限流（PR #172 评审）：未登录的请求不能借它给数据库加压。
  const pageViewsPerAddress = new FixedWindowLimiter({ limit: 60, windowMs: MINUTE, now })

  const readReport = async (request: IncomingMessage, app: 'workbench' | 'admin') => {
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (contentType !== 'text/plain' && contentType !== 'application/json') throw invalidRequest('上报内容类型不符合要求')
    // 来源校验先于读取内容：其他网站发起的上报直接拒绝。
    options.validateOrigin(request, app)
    const text = await readBody(request)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new ClientErrorReportInvalid('上报内容不是有效 JSON')
    }
  }
  const resolveIdentity = async (request: IncomingMessage, app: 'workbench' | 'admin') => {
    if (!options.authenticate) return undefined
    try {
      return await options.authenticate(request, app)
    } catch {
      return undefined // 未登录（登录页、钉钉免登失败）。
    }
  }

  // 登录前的页面（登录、钉钉免登）也要能上报，因此放在与登录同一前缀 `/auth/{workbench|admin}/` 下，
  // 不经 `/api/*/v1` 的强制身份校验；身份按需解析。
  for (const app of ['workbench', 'admin'] as const) router.post(`/auth/${app}/client-errors`, async request => {
    const batch = parseClientErrorBatch(await readReport(request, app))
    if (batch.app !== app) throw new ClientErrorReportInvalid('上报来源与内容不一致')

    const identity: RequestIdentity | undefined = await resolveIdentity(request, app)
    const reports = batch.reports
    const allowed = identity
      ? perUser.take(`user:${identity.userId}`, reports.length)
      // 全局额度只扣按来源地址实际放行的条数，单个来源不能多占全局额度（PR #171 评审）。
      : anonymousTotal.take('anonymous', perAddress.take(`ip:${clientAddress(request)}`, reports.length))
    const client = clientSummary(request.headers['user-agent'])
    for (const report of reports.slice(0, allowed)) {
      await options.record({ ...report, source: app, client, userId: identity?.userId ?? null })
    }
    return httpResult(202, { data: { accepted: allowed, dropped: reports.length - allowed } })
  })

  if (options.recordPageViews) {
    const recordPageViews = options.recordPageViews
    // 页面访问只记已登录员工（OBS-S2，OB8）：只有路由名、端与是否在钉钉内，不记网址与页面内容。
    for (const app of ['workbench', 'admin'] as const) router.post(`/auth/${app}/page-views`, async request => {
      if (!pageViewsPerAddress.take(`ip:${clientAddress(request)}`)) return httpResult(202, { data: { recorded: 0 } })
      const views = parsePageViews(await readReport(request, app), app)
      const identity = await resolveIdentity(request, app)
      if (!identity) throw new RequestError(401, 'authentication_required', '请先登录')
      const allowed = pageViewsPerUser.take(`user:${identity.userId}`, views.length)
      const recorded = allowed ? await recordPageViews(identity.userId, app, views.slice(0, allowed)) : 0
      return httpResult(202, { data: { recorded } })
    })
  }
}
