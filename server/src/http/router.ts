import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

import { logHttpFailure } from './http-error-log.ts'

import type {
  ApiAudience,
  ApiAuthenticator,
  RequestIdentity,
} from '../modules/identity/types.ts'
import { isAuthorizationDenial, publicAuthorizationResponseCode } from '../domain/authorization-errors.ts'
import { invalidRequest, stateConflict } from '../domain/request-errors.ts'

export interface ApiMeta {
  api: 'workbench' | 'admin' | 'system'
  adapter: 'prototype-memory' | 'postgres'
  timestamp: string
}

export interface ApiEnvelope<T> {
  data: T
  meta: ApiMeta
}

export interface RouteContext {
  params: Record<string, string>
  url: URL
  identity?: RequestIdentity
}

export interface HttpResult {
  status: number
  body: unknown
}

type RouteHandler = (
  request: IncomingMessage,
  context: RouteContext,
  response: ServerResponse,
) => unknown | Promise<unknown>

interface RouteDefinition {
  path: string
  method: string
  pattern: RegExp
  parameterNames: string[]
  handler: RouteHandler
}

function writeJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

export class Router {
  private readonly routes: RouteDefinition[] = []
  private readonly authenticateApi?: ApiAuthenticator

  constructor(options: { authenticateApi?: ApiAuthenticator } = {}) {
    this.authenticateApi = options.authenticateApi
  }

  get(path: string, handler: RouteHandler) {
    this.register('GET', path, handler)
  }

  post(path: string, handler: RouteHandler) {
    this.register('POST', path, handler)
  }

  put(path: string, handler: RouteHandler) {
    this.register('PUT', path, handler)
  }

  patch(path: string, handler: RouteHandler) {
    this.register('PATCH', path, handler)
  }

  delete(path: string, handler: RouteHandler) {
    this.register('DELETE', path, handler)
  }

  /** Registered method + path pairs in registration order (used to check the API documents). */
  listRoutes(): Array<{ method: string; path: string }> {
    return this.routes.map(({ method, path }) => ({ method, path }))
  }

  private register(method: string, path: string, handler: RouteHandler) {
    const parameterNames: string[] = []
    const source = path
      .split('/')
      .map((segment) => {
        if (!segment.startsWith(':')) return escapeRegExp(segment)
        parameterNames.push(segment.slice(1))
        return '([^/]+)'
      })
      .join('/')
    this.routes.push({ path, method, pattern: new RegExp(`^${source}$`), parameterNames, handler })
  }

  async handle(request: IncomingMessage, response: ServerResponse) {
    const requestId = resolveRequestId(request)
    response.setHeader('X-Request-Id', requestId)
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { Allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' })
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const method = request.method ?? 'GET'
    const route = this.routes.find((candidate) => candidate.method === method && candidate.pattern.test(url.pathname))

    if (!route) {
      const error = {
        code: 'route_not_found',
        message: `没有找到 ${request.method ?? 'GET'} ${url.pathname}`,
        object: '当前接口',
        suggestion: '请刷新页面；若问题持续，请确认前后端版本一致。',
        traceId: `trace-http-${randomUUID()}`,
      }
      logHttpFailure({ requestId, traceId: error.traceId, method, path: '[unmatched]', status: 404,
        code: error.code, safeMessage: '未匹配到路由', responseStarted: false })
      writeJson(response, 404, { error })
      return
    }

    try {
      const match = route.pattern.exec(url.pathname)
      const params = Object.fromEntries(
        route.parameterNames.map((name, index) => [name, decodeURIComponent(match?.[index + 1] ?? '')]),
      )
      const audience = apiAudience(url.pathname)
      const identity = audience && this.authenticateApi
        ? await this.authenticateApi(request, audience)
        : undefined
      if (identity) assertApiRouteAccess(identity, url.pathname, request.method)
      const result = await route.handler(request, { params, url, identity }, response)
      if (response.headersSent || response.writableEnded) return
      if (isHttpResult(result)) {
        if (result.status >= 400 && result.status <= 599) logErrorResult(result, method, route.path, requestId)
        writeJson(response, result.status, result.body)
      } else writeJson(response, 200, result)
    } catch (error) {
      const failure = classifyHttpError(error, url.pathname)
      logHttpFailure({ requestId, traceId: failure.error.traceId, method, path: route.path,
        status: failure.status, code: failure.error.code, error,
        safeMessage: failure.error.message, responseStarted: response.headersSent || response.writableEnded })
      if (response.headersSent || response.writableEnded) {
        response.end()
        return
      }
      writeJson(response, failure.status, { error: failure.error })
    }
  }
}

export interface HttpErrorDetail {
  code: string
  message: string
  object: string
  suggestion: string
  traceId: string
}

export function classifyHttpError(error: unknown, path: string): { status: number; error: HttpErrorDetail } {
  const object = inferRequestObject(path)
  const traceId = `trace-http-${randomUUID()}`

  // Status always comes from the error's type or explicit status/code, never from its wording.
  if (isTypedHttpError(error)) {
    const status = error.status
    const suggestions: Record<typeof status, string> = {
      401: '请检查账号和密码并重新登录；若使用统一登录，请管理员检查身份服务配置。',
      403: '请联系业务应用管理员，在 dsh-work 中为当前账号配置角色与数据范围。',
      404: '返回列表确认对象仍存在，然后重新选择。',
      409: '刷新对象当前状态后重试；若仍有任务在执行，请等待完成或先取消。',
      429: '请稍后重试；若仍受限，请等待登录限流窗口结束。',
      421: '请从已配置的前端入口访问；请管理员检查允许入口及反向代理 Host/协议转发配置。',
      422: '按提示调整输入内容后重新提交。',
      500: `稍后重试；若问题持续，请将链路编号 ${traceId} 提供给管理员。`,
      502: '稍后重试；若问题持续，请检查 AI Hub 与身份服务健康状态。',
      503: '稍后重试；若问题持续，请检查 AI Hub 与身份服务健康状态。',
      504: '稍后重试；若持续发生，请管理员检查运行时或连接器健康状态。',
    }
    const explicit = 'suggestion' in error && typeof error.suggestion === 'string' ? error.suggestion : undefined
    const suggestion = explicit
      ?? (['MODEL_CAPABILITY_MISMATCH', 'MODEL_CAPABILITY_UNAVAILABLE'].includes(error.code)
        ? '请管理员核对 Agent 模型能力要求、默认模型路由及 DSH 支持情况；能力不足时不能直接重试或忽略要求。'
        : ['RUNTIME_UNAVAILABLE', 'PYTHON_UNAVAILABLE'].includes(error.code)
          ? '请管理员检查对应执行能力；配置修复并重启服务后再提交任务。'
          : status === 503 && error.code.startsWith('skill_')
            ? '请管理员检查 Skill 存储和试运行执行能力，恢复后重试。'
            : suggestions[status])
    // 收敛后的公开 403 码只属于员工端契约：员工端不接受内部细节，统一映射进封闭集合；
    // 管理端按 5-T4 保留内部稳定码（permission_denied），管理端 OpenAPI 与用例依赖它。
    const code = status === 403 && apiAudience(path) !== 'admin' && isAuthorizationDenial(error)
      ? publicAuthorizationResponseCode(error.code)
      : error.code
    return {
      status,
      error: {
        code,
        message: status === 500 ? `${object}操作未完成` : status === 504 ? `${object}处理超时` : error.message,
        object,
        suggestion,
        traceId,
      },
    }
  }

  if (error instanceof SyntaxError) {
    return { status: 422, error: { code: 'invalid_request', message: `${object}请求内容不是有效 JSON`, object, suggestion: '检查请求字段和 JSON 格式后重新提交。', traceId } }
  }
  if (isTimeoutFailure(error)) {
    return { status: 504, error: { code: 'dependency_timeout', message: `${object}处理超时`, object, suggestion: '稍后重试；若持续发生，请管理员检查运行时或连接器健康状态。', traceId } }
  }
  // Anything untyped is an unexpected fault: never guess a 4xx from the message.
  return { status: 500, error: { code: 'operation_failed', message: `${object}操作未完成`, object, suggestion: `稍后重试；若问题持续，请将链路编号 ${traceId} 提供给管理员。`, traceId } }
}

const timeoutErrorCodes = new Set(['ETIMEDOUT', 'CONNECT_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

/** Platform timeouts recognised by type or system error code (AbortSignal.timeout, sockets, fetch, postgres). */
function isTimeoutFailure(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 3) return false
  const code = (error as { code?: unknown }).code
  if (error.name === 'TimeoutError' || (typeof code === 'string' && timeoutErrorCodes.has(code))) return true
  return isTimeoutFailure((error as { cause?: unknown }).cause, depth + 1)
}

function inferRequestObject(path: string) {
  const segments = path.split('/').filter(Boolean)
  const mappings: Array<[string, string]> = [
    ['artifacts', '成果'], ['files', '文件'], ['connectors', '连接器'], ['runtimes', '运行时'],
    ['runs', '运行'], ['sessions', '对话'], ['workspaces', '工作空间'], ['agents', 'Agent'], ['skills', 'Skill'], ['tools', '工具'],
    ['identity', '员工与权限'],
  ]
  for (const [segment, label] of mappings) {
    const index = segments.indexOf(segment)
    if (index >= 0) return `${label}${segments[index + 1] ? ` ${segments[index + 1]}` : ''}`
  }
  return '当前请求'
}

export function httpResult(status: number, body: unknown): HttpResult {
  return { status, body }
}

export function requireRequestIdentity(
  context: RouteContext,
  audience?: ApiAudience,
): RequestIdentity {
  const identity = context.identity
  if (!identity || (audience && identity.audience !== audience)) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    throw error
  }
  return identity
}

export function sessionAuthorizationContext(identity: RequestIdentity) {
  return {
    roleIds: [...identity.roleIds],
    dataScopes: [...identity.dataScopes],
  }
}

export function assertApiRouteAccess(
  identity: RequestIdentity,
  path: string,
  method: string | undefined,
) {
  if (identity.audience !== 'admin') return
  const permissions = new Set(identity.permissions)
  const isPlatformAdmin = permissions.has('admin:*')
  if (path === '/api/admin/v1/session') return
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method ?? 'GET')) {
    const isAssistantConversationCommand = path === '/api/admin/v1/assistant/messages'
      || /^\/api\/admin\/v1\/assistant\/runs\/[^/]+\/(cancel|retry)$/.test(path)
    if (path.startsWith('/api/admin/v1/identity/') && !isPlatformAdmin) {
      throw routePermissionDenied('只有平台管理员可以修改员工授权和身份同步配置')
    }
    if (!isPlatformAdmin
      && !permissions.has('admin:write')
      && !(isAssistantConversationCommand && permissions.has('admin:read'))) {
      throw routePermissionDenied('当前用户没有管理写权限')
    }
    return
  }
  const auditRoute = path === '/api/admin/v1/audit-events'
    || path === '/api/admin/v1/operations/summary'
    || path.startsWith('/api/admin/v1/operations/runs/')
  const allowed = auditRoute
    ? isPlatformAdmin
      || permissions.has('audit:read')
    : isPlatformAdmin
      || permissions.has('admin:read')
      || permissions.has('admin:write')
  if (!allowed) {
    throw routePermissionDenied(
      auditRoute ? '当前用户没有审计读取权限' : '当前用户没有管理读取权限',
    )
  }
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  // Collect bytes and decode once: decoding each chunk separately corrupts a
  // multi-byte UTF-8 character (for example Chinese text) split across chunks.
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size > 1024 * 1024) throw invalidRequest('请求体超过 1 MB 限制')
    chunks.push(bytes)
  }
  const body = Buffer.concat(chunks, size).toString('utf8')
  if (!body) throw stateConflict('请求体不能为空')
  return JSON.parse(body) as T
}

export function envelope<T>(api: ApiMeta['api'], data: T, adapter: ApiMeta['adapter'] = 'prototype-memory'): ApiEnvelope<T> {
  return {
    data,
    meta: {
      api,
      adapter,
      timestamp: new Date().toISOString(),
    },
  }
}

function isHttpResult(value: unknown): value is HttpResult {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function apiAudience(path: string): ApiAudience | null {
  if (path.startsWith('/api/workbench/v1/')) return 'workbench'
  if (path.startsWith('/api/admin/v1/')) return 'admin'
  return null
}

/** Typed domain, identity and capability errors: an explicit status and a stable code. */
function isTypedHttpError(
  error: unknown,
): error is Error & { status: 401 | 403 | 404 | 409 | 421 | 422 | 429 | 500 | 502 | 503 | 504; code: string; suggestion?: string } {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & { status?: unknown; code?: unknown }
  return [401, 403, 404, 409, 421, 422, 429, 500, 502, 503, 504].includes(Number(candidate.status))
    && typeof candidate.code === 'string'
    && /^[a-z0-9_]{1,80}$/i.test(candidate.code)
}

/** Explicit 422 so input validation does not depend on message-text matching. */
export function routeValidationFailed(message: string) {
  const error = new Error(message) as Error & { status: number; code: string }
  error.status = 422
  error.code = 'invalid_request'
  return error
}

export function routePermissionDenied(message: string) {
  const error = new Error(message) as Error & { status: number; code: string }
  error.status = 403
  error.code = 'authorization_denied'
  return error
}

/** Explicit httpResult errors also get a diagnostic, without logging the surrounding payload.
 * Existing response bodies are not changed; absent trace IDs are server-side correlations only.
 */
const requestIdPattern = /^[a-f0-9]{32}$/

/** Accept only a 16-byte lowercase hex id. Anything else is replaced, never normalized. */
function resolveRequestId(request: IncomingMessage): string {
  const header = request.headers['x-request-id']
  if (typeof header === 'string' && requestIdPattern.test(header)) return header
  return randomBytes(16).toString('hex')
}

function logErrorResult(result: HttpResult, method: string, path: string, requestId: string) {
  const body = result.body
  const detail = body && typeof body === 'object' && 'error' in body
    && body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {}
  const traceId = typeof detail.traceId === 'string' && /^trace-http-[a-f0-9-]{36}$/i.test(detail.traceId)
    ? detail.traceId : `trace-http-${randomUUID()}`
  const code = typeof detail.code === 'string' && /^[a-z0-9_]{1,80}$/i.test(detail.code)
    ? detail.code : 'http_error_response'
  const message = typeof detail.message === 'string' ? detail.message : '接口返回错误状态'
  logHttpFailure({ requestId, traceId, method, path, status: result.status, code,
    error: new Error(message), safeMessage: '接口返回错误状态', responseStarted: false })
}
