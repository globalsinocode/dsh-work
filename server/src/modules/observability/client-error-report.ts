import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { CLIENT_ERROR_KINDS, type ClientErrorKind, type ErrorKind, type ErrorSource } from '../../domain/error-records.ts'
import {
  maskPersonalData,
  normalizeForFingerprint,
  parseStackFrames,
  sanitizeErrorMessage,
  sanitizeStack,
  stableFileName,
} from './error-sanitize.ts'

/**
 * 浏览器上报（`POST /auth/{workbench|admin}/client-errors`）的结构校验、脱敏与指纹（错误记录方案 6.2、6.3）。
 * 结构固定：多余字段、类型或长度不符即整批拒绝；所有文本在服务端脱敏，不信任客户端。
 */

export const MAX_BATCH_BYTES = 32 * 1024
export const MAX_BATCH_ITEMS = 20

export class ClientErrorReportInvalid extends Error {
  readonly status = 422
  readonly code = 'invalid_request'
}

/** 已校验、已脱敏，可直接入库的一条记录。 */
export interface ErrorRecordInput {
  source: ErrorSource
  kind: ErrorKind
  message: string
  stack: string | null
  route: string | null
  traceId: string | null
  runId: string | null
  release: string | null
  client: string | null
  userId: string | null
  /** 同一页面加载内同一问题的次数（客户端去重后计数）。 */
  count: number
  fingerprint: string
}

export interface ClientErrorBatch {
  app: 'workbench' | 'admin'
  reports: Array<Omit<ErrorRecordInput, 'userId' | 'client' | 'source'>>
}

const ITEM_FIELDS = new Set(['kind', 'message', 'stack', 'route', 'traceId', 'runId', 'code', 'template', 'release', 'count'])
const TRACE_ID = /^trace-http-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const ROUTE_NAME = /^[A-Za-z0-9_.:/-]{1,120}$/
const CODE = /^[A-Za-z0-9_]{1,80}$/
// 失败提示的动作名是界面固定文案（如“发送消息”），允许中文；入库前仍按数据防护规则遮盖。
const TEMPLATE = /^[\p{Script=Han}A-Za-z0-9 _.:-]{1,40}$/u
const RELEASE = /^[A-Za-z0-9_.+-]{1,64}$|^开发构建$/

function invalid(message: string): never {
  throw new ClientErrorReportInvalid(message)
}

function optionalString(item: Record<string, unknown>, key: string, max: number, pattern?: RegExp): string | null {
  const value = item[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > max) invalid(`${key} 不符合要求`)
  if (pattern && !pattern.test(value)) invalid(`${key} 格式不符合要求`)
  return value
}

export function fingerprintOf(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)
}

/** 校验并脱敏一批浏览器上报；任何一条不合规则整批拒绝。 */
export function parseClientErrorBatch(body: unknown): ClientErrorBatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求内容必须是对象')
  const record = body as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'app' && key !== 'reports')) invalid('请求包含未知字段')
  if (record.app !== 'workbench' && record.app !== 'admin') invalid('app 不符合要求')
  if (!Array.isArray(record.reports) || record.reports.length === 0 || record.reports.length > MAX_BATCH_ITEMS) {
    invalid(`reports 必须是 1～${MAX_BATCH_ITEMS} 条`)
  }
  const app = record.app
  const reports = record.reports.map((raw): ClientErrorBatch['reports'][number] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('上报条目必须是对象')
    const item = raw as Record<string, unknown>
    if (Object.keys(item).some(key => !ITEM_FIELDS.has(key))) invalid('上报条目包含未知字段')
    const kind = item.kind
    if (typeof kind !== 'string' || !(CLIENT_ERROR_KINDS as readonly string[]).includes(kind)) invalid('kind 不符合要求')
    const count = item.count === undefined ? 1 : item.count
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1_000) invalid('count 不符合要求')
    const route = optionalString(item, 'route', 120, ROUTE_NAME)
    const traceId = optionalString(item, 'traceId', 64, TRACE_ID)
    const runId = optionalString(item, 'runId', 128, SAFE_ID)
    const release = optionalString(item, 'release', 64, RELEASE)
    const code = optionalString(item, 'code', 80, CODE)
    const template = optionalString(item, 'template', 40, TEMPLATE)
    const rawMessage = optionalString(item, 'message', 2_000)
    const rawStack = optionalString(item, 'stack', 16_000)

    if (kind === 'notice') {
      // 失败提示只存错误码与提示模板编号，不收提示原文与堆栈（评审第 3 条）。
      if (rawMessage !== null || rawStack !== null) invalid('失败提示不能包含提示原文或堆栈')
      if (!code) invalid('失败提示必须带错误码')
      const message = maskPersonalData(`失败提示 ${template ?? '未命名'}（${code}）`)
      return {
        kind, message, stack: null, route, traceId, runId, release, count,
        fingerprint: fingerprintOf([app, 'notice', route ?? '', template ?? '', code]),
      }
    }
    if (template !== null) invalid('template 只用于失败提示')
    const message = sanitizeErrorMessage(code ? `${rawMessage ?? ''}${rawMessage ? ' ' : ''}(${code})` : rawMessage)
    const frames = parseStackFrames(rawStack)
    const top = frames[0]
    return {
      kind: kind as ClientErrorKind,
      message,
      stack: sanitizeStack(rawStack),
      route, traceId, runId, release, count,
      fingerprint: fingerprintOf([
        app, kind, normalizeForFingerprint(message),
        top ? `${stableFileName(top.file)}:${top.fn}` : (kind === 'api' || kind === 'load' || kind === 'stream' ? route ?? '' : ''),
      ]),
    }
  })
  return { app, reports }
}

/** 浏览器与系统的简称（不存完整 User-Agent）。 */
export function clientSummary(userAgent: string | undefined): string | null {
  if (!userAgent) return null
  const ua = userAgent.slice(0, 512)
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
      : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
        : /Windows/.test(ua) ? 'Windows'
          : /Linux/.test(ua) ? 'Linux' : '其他系统'
  if (/DingTalk/i.test(ua)) return `钉钉 ${os}`
  const browsers: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, 'Edge'], [/Firefox\/(\d+)/, 'Firefox'], [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+).*Safari/, 'Safari'],
  ]
  for (const [pattern, name] of browsers) {
    const match = pattern.exec(ua)
    if (match) return `${name} ${match[1]} / ${os}`
  }
  return `其他浏览器 / ${os}`
}

/**
 * 上报来源 IP（评审第 2 条）：服务只监听本机、由 Nginx 反向代理。只有直连地址是回环地址
 * （即来自本机 Nginx）时才采用 `X-Real-IP`，否则用直连地址；不读取 `X-Forwarded-For`。
 */
export function clientAddress(request: IncomingMessage): string {
  const remote = request.socket.remoteAddress ?? 'unknown'
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (loopback) {
    const header = request.headers['x-real-ip']
    const realIp = Array.isArray(header) ? undefined : header?.trim()
    if (realIp && /^[0-9a-fA-F:.]{2,45}$/.test(realIp)) return realIp
  }
  return remote
}
