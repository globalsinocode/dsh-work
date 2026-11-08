import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { DEEPSEEK_WEB_SEARCH_MODEL, deepSeekSearchEndpoint, isDeepSeekOfficialBaseUrl } from '../../domain/deepseek-official.ts'
import { classifyAttemptModelFailure, type ModelFailureCode } from './model-gateway-failure.ts'
import { SseResponseRestorer, applyRequestTexts, collectRequestTexts, requestHasImage, restoreJsonResponse } from './model-gateway-redaction.ts'
import { UsageAccumulator } from './model-gateway-usage.ts'
import type {
  ModelGatewayBinding,
  ModelGatewayCredentialResolver,
  ModelGatewayDataProtection,
  ModelGatewayEndpoint,
  ModelGatewayMaskCounts,
  ModelGatewayMaskResult,
  ModelGatewayOrigin,
  ModelGatewayOutcome,
  ModelGatewayRejectionCode,
  ModelGatewayRequestLog,
  ModelGatewayRequestRecord,
  ModelGatewayUsage,
} from './model-gateway-types.ts'

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ModelGatewayOptions {
  credentials: ModelGatewayCredentialResolver
  log: ModelGatewayRequestLog
  dataProtection: ModelGatewayDataProtection
  /** 只对本机或执行网络开放（数据防护方案 5.2）；默认 127.0.0.1。 */
  host?: string
  /** 0 表示由系统分配端口。 */
  port?: number
  fetch?: FetchLike
  now?: () => number
  /** 请求体上限，默认 64 MiB（含图片）。 */
  maxRequestBytes?: number
  /** 等待厂商响应头的时限，默认 120 秒；之后的流式正文不设总时限，由 DSH 的空闲超时约束。 */
  upstreamHeadersTimeoutMs?: number
  onError?: (message: string) => void
}

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024
const DEFAULT_HEADERS_TIMEOUT_MS = 120_000
const MAX_ERROR_BODY_BYTES = 64 * 1024
/** 需要还原的非流式回复要整体缓冲，超过此上限按失败处理。 */
const MAX_RESTORED_JSON_BYTES = 32 * 1024 * 1024
const TOKEN_PREFIX = 'dshwg_'
/** 网关自身响应带此头，与厂商透传的同状态码错误区分（模型路由方案 4.7）。 */
export const GATEWAY_ORIGIN_HEADER = 'x-dshw-origin'

/**
 * 平台模型网关（DLP-S1 最小链路）：校验 Attempt 令牌与请求模型，用平台加密保存的厂商密钥转发，
 * 记录用量与结果，对外部厂商遮盖请求并还原回复（DLP-S2）。保持厂商协议原样，不做协议互转、不回退、
 * 不重试（重试由 DSH 的 retryPolicy 按状态码决定）。
 */
export class ModelGateway {
  private readonly options: ModelGatewayOptions
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly bindings = new Map<string, ModelGatewayBinding>()
  private readonly attemptTokens = new Map<string, string>()
  private server: Server | undefined
  private rootUrl: string | undefined

  constructor(options: ModelGatewayOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? Date.now
  }

  /** 网关根地址，如 `http://127.0.0.1:PORT`；未启动时抛错。 */
  get baseUrl(): string {
    if (!this.rootUrl) throw new Error('模型网关未启动')
    return this.rootUrl
  }

  async start(): Promise<string> {
    if (this.rootUrl) return this.rootUrl
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.options.onError?.(`model gateway request failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!response.headersSent) this.reject(response, 500, 'MODEL_UPSTREAM_UNAVAILABLE', '模型网关内部错误')
        else response.destroy()
      })
    })
    server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
    this.server = server
    this.rootUrl = `http://${host}:${address.port}`
    return this.rootUrl
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.rootUrl = undefined
    this.bindings.clear()
    this.attemptTokens.clear()
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /**
   * 为 Attempt 签发短期令牌（模型路由方案 4.5）。同一 Attempt 再次签发会吊销旧令牌。
   * 令牌只以摘要保存在本进程内存中，不落库；服务重启后 DSH Worker 随之结束，令牌自然失效。
   */
  issueToken(binding: ModelGatewayBinding): string {
    this.revokeToken(binding.attemptId)
    this.sweepExpiredTokens()
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const digest = tokenDigest(token)
    this.bindings.set(digest, structuredClone(binding))
    this.attemptTokens.set(binding.attemptId, digest)
    return token
  }

  /** Attempt 终态即吊销（模型路由方案 4.5）。 */
  revokeToken(attemptId: string): void {
    const digest = this.attemptTokens.get(attemptId)
    if (!digest) return
    this.bindings.delete(digest)
    this.attemptTokens.delete(attemptId)
  }

  /**
   * Attempt 失败时按网关记录分类（模型路由方案 4.7），一次查询同时给出对话请求数。只看对话请求：
   * 联网搜索失败由 DSH 作为工具失败处理，不代表模型调用失败。
   */
  async inspectAttemptFailure(tenantId: string, attemptId: string): Promise<{
    failure: { code: ModelFailureCode; message: string } | undefined
    chatRequests: number
  }> {
    const chat = (await this.options.log.listForAttempt(tenantId, attemptId)).filter(record => record.endpoint === 'chat')
    return { failure: classifyAttemptModelFailure(chat), chatRequests: chat.length }
  }

  /** 漏掉吊销的令牌（如异常退出）在下次签发时按过期时间清理，不在内存中长期滞留。 */
  private sweepExpiredTokens(): void {
    const now = this.now()
    for (const [digest, binding] of this.bindings) {
      if (binding.expiresAt <= now) {
        this.bindings.delete(digest)
        if (this.attemptTokens.get(binding.attemptId) === digest) this.attemptTokens.delete(binding.attemptId)
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?')[0]
    const endpoint: ModelGatewayEndpoint | undefined = path === '/v1/chat/completions'
      ? 'chat'
      : path === '/anthropic/v1/messages' ? 'search' : undefined
    if (request.method !== 'POST' || !endpoint) {
      request.resume()
      this.reject(response, 404, 'MODEL_ROUTE_UNAVAILABLE', '模型网关不提供该接口')
      return
    }
    const binding = this.authenticate(request)
    if (!binding) {
      request.resume()
      // 无法确定 Attempt，不写请求记录；DSH 收到 403 不重试。
      this.reject(response, 403, 'MODEL_ROUTE_UNAVAILABLE', '模型网关令牌无效或已过期')
      return
    }
    const startedAt = new Date(this.now()).toISOString()
    const record = (fields: {
      modelKey: string
      origin: ModelGatewayOrigin
      outcome: ModelGatewayOutcome
      httpStatus: number | null
      errorCode: string | null
      usage?: ModelGatewayUsage
    }): ModelGatewayRequestRecord => ({
      id: `gwreq-${randomUUID()}`,
      tenantId: binding.tenantId,
      runId: binding.runId,
      attemptId: binding.attemptId,
      routeId: binding.route.routeId,
      providerKey: binding.route.providerKey,
      modelKey: fields.modelKey,
      endpoint,
      origin: fields.origin,
      outcome: fields.outcome,
      httpStatus: fields.httpStatus,
      errorCode: fields.errorCode,
      inputTokens: fields.usage?.inputTokens ?? null,
      outputTokens: fields.usage?.outputTokens ?? null,
      cacheReadTokens: fields.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: fields.usage?.cacheWriteTokens ?? null,
      startedAt,
      finishedAt: new Date(this.now()).toISOString(),
    })
    // 写记录失败不能改变返回给 DSH 的状态码（否则 403/429 会变成可重试的 500），只记日志。
    const save = async (entry: ModelGatewayRequestRecord) => {
      try {
        await this.options.log.record(entry)
      } catch (error) {
        this.options.onError?.(`model gateway request record failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const rejectRecorded = async (status: number, code: ModelGatewayRejectionCode, message: string, modelKey: string) => {
      await save(record({ modelKey, origin: 'gateway', outcome: 'failed', httpStatus: status, errorCode: code }))
      this.reject(response, status, code, message)
    }

    // 读请求体之前就监听断开：遮盖耗时期间 DSH 断开时不再发往厂商，也要留下记录。
    const controller = new AbortController()
    let clientGone = false
    const onClose = () => {
      if (!response.writableFinished) {
        clientGone = true
        controller.abort()
      }
    }
    response.on('close', onClose)

    const body = await readBody(request, this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES)
    if (!body) {
      await rejectRecorded(413, 'MODEL_REQUEST_INVALID', '模型请求体过大', binding.route.modelKey)
      return
    }
    const requestedModel = readModel(body)
    if (requestedModel === undefined) {
      await rejectRecorded(400, 'MODEL_REQUEST_INVALID', '模型请求不是有效的 JSON 或未声明模型', binding.route.modelKey)
      return
    }
    const modelKey = requestedModel.slice(0, 200)
    if (endpoint === 'chat' && requestedModel !== binding.route.modelKey) {
      await rejectRecorded(403, 'MODEL_ROUTE_UNAVAILABLE', '请求的模型与本次运行的模型路由不符', modelKey)
      return
    }
    // 数据防护方案 D12：只为 DeepSeek 官方的这一个搜索接口透传，且只放行插件的搜索模型。
    if (endpoint === 'search' && (!isDeepSeekOfficialBaseUrl(binding.route.baseUrl) || requestedModel !== DEEPSEEK_WEB_SEARCH_MODEL)) {
      await rejectRecorded(403, 'MODEL_ROUTE_UNAVAILABLE', '本次运行的模型路由不支持联网搜索', modelKey)
      return
    }

    let secret: string
    try {
      secret = await this.options.credentials.readSecret(binding.tenantId, binding.route.credentialRefId)
      if (!secret.trim()) throw new Error('empty secret')
    } catch {
      await rejectRecorded(403, 'MODEL_CREDENTIAL_INVALID', '模型厂商密钥缺失或无法解密', modelKey)
      return
    }

    // 外部厂商遮盖后转发；识别、读词表任何一步失败都拒绝转发，不降级（方案 5.6.2）。内部部署不处理（D5）。
    const parsedBody = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    let outbound: Buffer = body
    let masked: ModelGatewayMaskResult | undefined
    let counts: ModelGatewayMaskCounts = { secret: 0, personal: 0, term: 0 }
    if (binding.route.trustLevel === 'external') {
      try {
        const collected = collectRequestTexts(parsedBody)
        masked = await this.options.dataProtection.mask(binding.tenantId, collected.texts, collected.contexts)
        counts = masked.counts
        if (masked.hasPlaceholders) outbound = Buffer.from(JSON.stringify(applyRequestTexts(parsedBody, masked.texts)), 'utf8')
      } catch (error) {
        this.options.onError?.(`model gateway data protection failed: ${error instanceof Error ? error.name : 'unknown'}`)
        await rejectRecorded(403, 'DATA_POLICY_UNAVAILABLE', '数据防护暂时不可用，本轮未发送给模型', modelKey)
        return
      }
    }
    try {
      await this.options.dataProtection.recordGatewayEvent({
        tenantId: binding.tenantId,
        runId: binding.runId,
        attemptId: binding.attemptId,
        providerKey: binding.route.providerKey,
        modelKey,
        endpoint,
        trustLevel: binding.route.trustLevel,
        counts,
        action: counts.secret + counts.personal + counts.term > 0 ? 'masked' : 'passed',
        hasImage: requestHasImage(parsedBody['messages']),
      })
    } catch (error) {
      this.options.onError?.(`model gateway data protection audit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const restoring = masked?.hasPlaceholders ? masked : undefined

    const target = endpoint === 'chat' ? `${binding.route.baseUrl.replace(/\/+$/, '')}/chat/completions` : deepSeekSearchEndpoint(binding.route.baseUrl)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: headerValue(request, 'accept') ?? '*/*',
      authorization: `Bearer ${secret}`,
    }
    if (endpoint === 'search') {
      headers['x-api-key'] = secret
      headers['anthropic-version'] = headerValue(request, 'anthropic-version') ?? '2023-06-01'
      const beta = headerValue(request, 'anthropic-beta')
      if (beta) headers['anthropic-beta'] = beta
    }

    if (clientGone) {
      await save(record({ modelKey, origin: 'transport', outcome: 'aborted', httpStatus: null, errorCode: null }))
      return
    }
    const headersTimer = setTimeout(() => controller.abort(), this.options.upstreamHeadersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS)
    let upstream: Response
    try {
      upstream = await this.fetchImpl(target, { method: 'POST', headers, body: new Uint8Array(outbound), signal: controller.signal, redirect: 'error' })
    } catch {
      clearTimeout(headersTimer)
      if (clientGone) {
        await save(record({ modelKey, origin: 'transport', outcome: 'aborted', httpStatus: null, errorCode: null }))
        return
      }
      await save(record({ modelKey, origin: 'transport', outcome: 'failed', httpStatus: null, errorCode: 'UPSTREAM_UNREACHABLE' }))
      // 502 归入 DSH retryPolicy 的 SERVER，按次数重试。
      this.reject(response, 502, 'MODEL_UPSTREAM_UNAVAILABLE', '无法连接模型厂商')
      return
    }
    clearTimeout(headersTimer)

    if (upstream.status >= 400) {
      // 错误正文同样受时限约束：厂商发完响应头后卡住时不让网关一直挂起。
      const bodyTimer = setTimeout(() => controller.abort(), this.options.upstreamHeadersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS)
      const errorBody = await readLimited(upstream, MAX_ERROR_BODY_BYTES).finally(() => clearTimeout(bodyTimer))
      response.off('close', onClose)
      await save(record({
        modelKey, origin: 'upstream', outcome: 'failed', httpStatus: upstream.status, errorCode: vendorErrorCode(errorBody),
      }))
      // 厂商错误原样透传给 DSH（状态码、正文），由 DSH 按 retryPolicy 决定是否重试。
      response.writeHead(upstream.status, passthroughHeaders(upstream))
      response.end(errorBody)
      return
    }

    const usage = new UsageAccumulator()
    const streaming = (upstream.headers.get('content-type') ?? '').includes('text/event-stream')
    response.writeHead(upstream.status, passthroughHeaders(upstream))
    const decoder = new TextDecoder()
    const sseRestorer = streaming && restoring ? new SseResponseRestorer(encode => restoring.createRestorer(encode)) : undefined
    const jsonChunks: Buffer[] = []
    let jsonBytes = 0
    let outcome: ModelGatewayOutcome = 'succeeded'
    let origin: ModelGatewayOrigin = 'upstream'
    try {
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          const text = streaming ? decoder.decode(chunk, { stream: true }) : ''
          if (streaming) usage.acceptSseChunk(text)
          else if (restoring && jsonBytes + chunk.byteLength > MAX_RESTORED_JSON_BYTES) {
            // 超限时失败关闭：不能把含占位符的原文发给 DSH。
            throw new Error('restored response too large')
          } else if (restoring || jsonBytes < 8 * 1024 * 1024) {
            jsonChunks.push(Buffer.from(chunk))
            jsonBytes += chunk.byteLength
          }
          // 需要还原的非流式回复读完后一次写出，不能先把含占位符的原文发给 DSH。
          if (!streaming && restoring) continue
          const outgoing = sseRestorer ? sseRestorer.push(text) : chunk
          if (outgoing.length > 0 && !response.write(outgoing)) await waitForDrain(response)
        }
      }
      if (sseRestorer) {
        const rest = sseRestorer.finish()
        if (rest) response.write(rest)
      }
      if (!streaming && jsonBytes) {
        const replyText = Buffer.concat(jsonChunks).toString('utf8')
        let reply: unknown
        try {
          reply = JSON.parse(replyText)
          usage.acceptJson(reply)
        } catch {
          // 非 JSON 回复不计量，也没有可还原的字段，原样放行。
        }
        if (restoring) {
          const isObject = reply !== null && typeof reply === 'object' && !Array.isArray(reply)
          response.write(isObject ? JSON.stringify(restoreJsonResponse(reply as Record<string, unknown>, encode => restoring.createRestorer(encode))) : replyText)
        }
      }
    } catch {
      outcome = clientGone ? 'aborted' : 'failed'
      if (!clientGone) origin = 'transport'
    } finally {
      response.off('close', onClose)
    }
    const finalUsage = usage.finish()
    // 200 流中途出现厂商错误事件（如 overloaded_error）：按厂商失败记录，不当成功。
    const streamError = outcome === 'succeeded' ? usage.streamError : null
    // 先写记录再结束响应：DSH 收到结果（或中断）后若立即失败，Adapter 分类时读到的就是本次请求的记录。
    await save(record({
      modelKey,
      origin,
      outcome: streamError ? 'failed' : outcome,
      httpStatus: upstream.status,
      errorCode: streamError ?? (outcome === 'failed' ? 'UPSTREAM_STREAM_INTERRUPTED' : null),
      usage: finalUsage,
    }))
    if (outcome === 'succeeded') response.end()
    else response.destroy()
  }

  private authenticate(request: IncomingMessage): ModelGatewayBinding | undefined {
    const authorization = headerValue(request, 'authorization')
    const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
    const token = bearer ?? headerValue(request, 'x-api-key')
    if (!token || !token.startsWith(TOKEN_PREFIX)) return undefined
    const binding = this.bindings.get(tokenDigest(token))
    if (!binding) return undefined
    if (binding.expiresAt <= this.now()) {
      this.revokeToken(binding.attemptId)
      return undefined
    }
    return binding
  }

  private reject(response: ServerResponse, status: number, code: ModelGatewayRejectionCode, message: string): void {
    if (response.headersSent) {
      response.destroy()
      return
    }
    // 厂商兼容的错误结构；code 同时放在顶层与 error 内，便于排障（DLP-S0 #5）。
    const body = JSON.stringify({ code, error: { message, type: 'dshw_gateway_error', code } })
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      [GATEWAY_ORIGIN_HEADER]: 'gateway',
    })
    response.end(body)
  }
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > limit) {
      request.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function readModel(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const model = (parsed as Record<string, unknown>)['model']
    return typeof model === 'string' && model.length > 0 ? model : undefined
  } catch {
    return undefined
  }
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const remaining = limit - size
        if (remaining <= 0) break
        const piece = Buffer.from(chunk).subarray(0, remaining)
        chunks.push(piece)
        size += piece.byteLength
      }
    }
  } catch {
    // 错误正文读取失败时只保留已读部分。
  }
  return Buffer.concat(chunks)
}

/** 只取厂商错误码或类型（不保存错误消息，避免把请求内容带进记录）。 */
function vendorErrorCode(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const root = parsed as Record<string, unknown>
    const error = root['error'] !== null && typeof root['error'] === 'object' ? root['error'] as Record<string, unknown> : root
    for (const key of ['code', 'type']) {
      const value = error[key]
      if ((typeof value === 'string' && value) || typeof value === 'number') return String(value).replace(/[^\w.:-]/g, '_').slice(0, 80)
    }
    return null
  } catch {
    return null
  }
}

function passthroughHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of ['content-type', 'retry-after', 'cache-control']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise(resolve => {
    // 连接已断开时 drain 和 close 都不会再来。
    if (response.destroyed) {
      resolve()
      return
    }
    const done = () => {
      response.off('drain', done)
      response.off('close', done)
      resolve()
    }
    response.once('drain', done)
    response.once('close', done)
  })
}
