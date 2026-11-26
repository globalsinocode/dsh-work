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
import { invalidRequest } from '../domain/request-errors.ts'
import { httpResult, type Router } from './router.ts'

export interface ClientErrorRouteOptions {
  record: (input: ErrorRecordInput) => Promise<void>
  authenticate?: ApiAuthenticator
  /** 校验 `Origin` 是本平台对应前端入口；不符时抛错。 */
  validateOrigin: (request: IncomingMessage, audience: 'workbench' | 'admin') => void
  now?: () => number
}

const MINUTE = 60_000

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

  // 登录前的页面（登录、钉钉免登）也要能上报，因此放在与登录同一前缀 `/auth/{workbench|admin}/` 下，
  // 不经 `/api/*/v1` 的强制身份校验；身份按需解析。
  for (const app of ['workbench', 'admin'] as const) router.post(`/auth/${app}/client-errors`, async request => {
    const contentType = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (contentType !== 'text/plain' && contentType !== 'application/json') {
      throw invalidRequest('上报内容类型不符合要求')
    }
    // 来源校验先于读取内容：其他网站发起的上报直接拒绝。
    options.validateOrigin(request, app)
    const text = await readBody(request)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new ClientErrorReportInvalid('上报内容不是有效 JSON')
    }
    const batch = parseClientErrorBatch(body)
    if (batch.app !== app) throw new ClientErrorReportInvalid('上报来源与内容不一致')

    let identity: RequestIdentity | undefined
    if (options.authenticate) {
      try {
        identity = await options.authenticate(request, app)
      } catch {
        identity = undefined // 未登录（登录页、钉钉免登失败）也接收。
      }
    }
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
}
