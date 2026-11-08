import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DataProtectionService, MemoryDataProtectionStore } from '../data-protection/data-protection-service.ts'
import { GATEWAY_ORIGIN_HEADER, ModelGateway } from './model-gateway.ts'
import { classifyAttemptModelFailure } from './model-gateway-failure.ts'
import { MemoryModelGatewayRequestLog } from './model-gateway-request-log.ts'
import { UsageAccumulator } from './model-gateway-usage.ts'
import type { ModelGatewayBinding, ModelGatewayRequestRecord } from './model-gateway-types.ts'

interface UpstreamCall { url: string; headers: Record<string, string>; body: string }

const deepSeekBinding = (overrides: Partial<ModelGatewayBinding> = {}): ModelGatewayBinding => ({
  tenantId: 'tenant-dsh-work',
  runId: 'run-1',
  attemptId: 'attempt-1',
  route: {
    routeId: 'route-default',
    providerKey: 'deepseek-official',
    modelKey: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    credentialRefId: 'credential-deepseek',
    trustLevel: 'external',
  },
  expiresAt: Date.now() + 60_000,
  ...overrides,
})

function sse(events: unknown[]): string {
  return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
}

function streamResponse(text: string, status = 200, contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder()
  // 拆成小片段，验证跨片段解析。
  const pieces = text.match(/[\s\S]{1,7}/g) ?? []
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  }), { status, headers: { 'content-type': contentType } })
}

describe('模型网关（DLP-S1 最小链路）', () => {
  let log: MemoryModelGatewayRequestLog
  let calls: UpstreamCall[]
  let respond: (call: UpstreamCall) => Response | Promise<Response>
  let secrets: Map<string, string>
  let gateway: ModelGateway
  let base: string

  beforeEach(async () => {
    log = new MemoryModelGatewayRequestLog()
    calls = []
    secrets = new Map([['credential-deepseek', 'sk-vendor-secret']])
    respond = () => streamResponse(sse(['[DONE]']))
    gateway = new ModelGateway({
      dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)),
      log,
      credentials: {
        readSecret: async (_tenantId, credentialRefId) => {
          const secret = secrets.get(credentialRefId)
          if (!secret) throw new Error('missing')
          return secret
        },
      },
      fetch: async (url, init) => {
        const call = {
          url,
          headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value])),
          body: Buffer.from(init.body as Uint8Array).toString('utf8'),
        }
        calls.push(call)
        return respond(call)
      },
    })
    base = await gateway.start()
  })

  afterEach(async () => {
    await gateway.stop()
  })

  const post = (path: string, token: string | undefined, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  it('校验令牌后用平台密钥转发流式请求，原样回传并记录含缓存的用量', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    assert.match(token, /^dshwg_/)
    const upstreamText = sse([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [], usage: { prompt_tokens: 8600, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8448 }, prompt_cache_hit_tokens: 8448, prompt_cache_miss_tokens: 152 } },
      '[DONE]',
    ])
    respond = () => streamResponse(upstreamText)
    const requestBody = { model: 'deepseek-v4-pro', stream: true, messages: [{ role: 'user', content: '你好' }] }
    const response = await post('/v1/chat/completions', token, requestBody)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), upstreamText)
    assert.equal(response.headers.get(GATEWAY_ORIGIN_HEADER), null)

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.deepseek.com/chat/completions')
    assert.equal(calls[0]!.headers['authorization'], 'Bearer sk-vendor-secret')
    assert.deepEqual(JSON.parse(calls[0]!.body), requestBody, '请求体原样转发')

    const [record] = log.records
    assert.equal(record?.outcome, 'succeeded')
    assert.equal(record?.origin, 'upstream')
    assert.equal(record?.endpoint, 'chat')
    assert.equal(record?.modelKey, 'deepseek-v4-pro')
    assert.equal(record?.inputTokens, 8600)
    assert.equal(record?.outputTokens, 12)
    assert.equal(record?.cacheReadTokens, 8448)
    assert.equal(record?.cacheWriteTokens, null)
    assert.doesNotMatch(JSON.stringify(log.records), /sk-vendor-secret|dshwg_|你好/, '记录不含密钥、令牌与正文')
  })

  it('非流式回复同样计量；厂商未返回缓存用量时记为 null', async () => {
    const token = gateway.issueToken(deepSeekBinding({ route: { ...deepSeekBinding().route, providerKey: 'acme', baseUrl: 'https://llm.acme.example/v1/', modelKey: 'acme-large' } }))
    respond = () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } })
    const response = await post('/v1/chat/completions', token, { model: 'acme-large' })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(calls[0]!.url, 'https://llm.acme.example/v1/chat/completions')
    assert.deepEqual(
      [log.records[0]?.inputTokens, log.records[0]?.outputTokens, log.records[0]?.cacheReadTokens, log.records[0]?.cacheWriteTokens],
      [20, 3, null, null],
    )
  })

  it('令牌缺失、无效、过期或已吊销时 403 拒绝并带网关来源头，不转发', async () => {
    const expired = gateway.issueToken(deepSeekBinding({ attemptId: 'attempt-expired', expiresAt: Date.now() - 1 }))
    const revoked = gateway.issueToken(deepSeekBinding({ attemptId: 'attempt-revoked' }))
    gateway.revokeToken('attempt-revoked')
    for (const token of [undefined, 'dshwg_unknown', 'sk-not-a-gateway-token', expired, revoked]) {
      const response = await post('/v1/chat/completions', token, { model: 'deepseek-v4-pro' })
      assert.equal(response.status, 403)
      assert.equal(response.headers.get(GATEWAY_ORIGIN_HEADER), 'gateway')
      const body = await response.json() as { code: string; error: { code: string } }
      assert.equal(body.code, 'MODEL_ROUTE_UNAVAILABLE')
      assert.equal(body.error.code, 'MODEL_ROUTE_UNAVAILABLE')
    }
    assert.equal(calls.length, 0)
    assert.equal(log.records.length, 0, '无法确定 Attempt 的请求不写记录')
  })

  it('同一 Attempt 重新签发令牌后旧令牌失效', async () => {
    const first = gateway.issueToken(deepSeekBinding())
    const second = gateway.issueToken(deepSeekBinding())
    assert.equal((await post('/v1/chat/completions', first, { model: 'deepseek-v4-pro' })).status, 403)
    const ok = await post('/v1/chat/completions', second, { model: 'deepseek-v4-pro' })
    assert.equal(ok.status, 200)
    await ok.text()
  })

  it('请求模型与路由不符时拒绝并记录，Attempt 归为 MODEL_ROUTE_UNAVAILABLE', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    const response = await post('/v1/chat/completions', token, { model: 'deepseek-v4-flash' })
    assert.equal(response.status, 403)
    assert.equal(response.headers.get(GATEWAY_ORIGIN_HEADER), 'gateway')
    assert.equal(calls.length, 0)
    assert.equal(log.records[0]?.origin, 'gateway')
    assert.equal(log.records[0]?.errorCode, 'MODEL_ROUTE_UNAVAILABLE')
    assert.equal(log.records[0]?.modelKey, 'deepseek-v4-flash')
    assert.equal((await gateway.inspectAttemptFailure('tenant-dsh-work', 'attempt-1')).failure?.code, 'MODEL_ROUTE_UNAVAILABLE')
  })

  it('请求体不是 JSON 或未声明模型时拒绝', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    assert.equal((await post('/v1/chat/completions', token, 'not json')).status, 400)
    assert.equal((await post('/v1/chat/completions', token, { messages: [] })).status, 400)
    assert.equal(calls.length, 0)
  })

  it('厂商密钥缺失或无法解密时拒绝，Attempt 归为 MODEL_CREDENTIAL_INVALID', async () => {
    secrets.clear()
    const token = gateway.issueToken(deepSeekBinding())
    const response = await post('/v1/chat/completions', token, { model: 'deepseek-v4-pro' })
    assert.equal(response.status, 403)
    assert.equal((await response.json() as { code: string }).code, 'MODEL_CREDENTIAL_INVALID')
    assert.equal(calls.length, 0)
    assert.equal((await gateway.inspectAttemptFailure('tenant-dsh-work', 'attempt-1')).failure?.code, 'MODEL_CREDENTIAL_INVALID')
  })

  it('厂商错误原样透传（不带网关来源头），只记录状态码与错误码', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: { message: 'Authentication Fails, your api key sk-x is invalid', type: 'authentication_error' } }, 'MODEL_CREDENTIAL_INVALID'],
      [402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } }, 'MODEL_QUOTA_EXHAUSTED'],
      [429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, 'MODEL_QUOTA_EXHAUSTED'],
      [429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }, 'MODEL_RATE_LIMITED'],
      [503, { error: { message: 'Service Unavailable' } }, 'MODEL_UPSTREAM_UNAVAILABLE'],
      [400, { error: { message: 'Invalid request', type: 'invalid_request_error' } }, 'MODEL_INVOCATION_FAILED'],
    ]
    for (const [index, [status, body, expected]] of cases.entries()) {
      const attemptId = `attempt-upstream-${index}`
      const token = gateway.issueToken(deepSeekBinding({ attemptId }))
      respond = () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after': '1' } })
      const response = await post('/v1/chat/completions', token, { model: 'deepseek-v4-pro' })
      assert.equal(response.status, status)
      assert.equal(response.headers.get(GATEWAY_ORIGIN_HEADER), null)
      assert.equal(response.headers.get('retry-after'), '1')
      assert.deepEqual(await response.json(), body)
      const [record] = await log.listForAttempt('tenant-dsh-work', attemptId)
      assert.equal(record?.origin, 'upstream')
      assert.equal(record?.httpStatus, status)
      const failure = (await gateway.inspectAttemptFailure('tenant-dsh-work', attemptId)).failure
      assert.equal(failure?.code, expected, `status ${status}`)
    }
    assert.doesNotMatch(JSON.stringify(log.records), /Authentication Fails|sk-x/, '不保存厂商错误消息')
  })

  it('厂商不可达时以 502 返回网关错误，Attempt 归为 MODEL_UPSTREAM_UNAVAILABLE', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    respond = () => { throw new TypeError('fetch failed') }
    const response = await post('/v1/chat/completions', token, { model: 'deepseek-v4-pro' })
    assert.equal(response.status, 502)
    assert.equal(response.headers.get(GATEWAY_ORIGIN_HEADER), 'gateway')
    assert.equal(log.records[0]?.origin, 'transport')
    assert.equal((await gateway.inspectAttemptFailure('tenant-dsh-work', 'attempt-1')).failure?.code, 'MODEL_UPSTREAM_UNAVAILABLE')
  })

  it('联网搜索：DeepSeek 官方路由透传到 Anthropic 兼容搜索接口并按 Anthropic 口径计量', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    const upstreamText = sse([
      { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { text: 'result' } },
      { type: 'message_delta', usage: { output_tokens: 40 } },
    ])
    respond = () => streamResponse(upstreamText)
    // 插件同时发送 x-api-key 与 Bearer，任一即可通过认证。
    const response = await post('/anthropic/v1/messages', undefined, { model: 'deepseek-v4-flash', messages: [] }, { 'x-api-key': token, 'anthropic-version': '2023-06-01' })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), upstreamText)
    assert.equal(calls[0]!.url, 'https://api.deepseek.com/anthropic/v1/messages')
    assert.equal(calls[0]!.headers['x-api-key'], 'sk-vendor-secret')
    assert.equal(calls[0]!.headers['anthropic-version'], '2023-06-01')
    const [record] = log.records
    assert.equal(record?.endpoint, 'search')
    assert.equal(record?.modelKey, 'deepseek-v4-flash')
    assert.deepEqual([record?.inputTokens, record?.outputTokens, record?.cacheReadTokens, record?.cacheWriteTokens], [45, 40, 10, 5])
  })

  it('联网搜索：默认路由不是 DeepSeek 官方，或搜索模型不符时拒绝', async () => {
    const other = gateway.issueToken(deepSeekBinding({ attemptId: 'attempt-other', route: { ...deepSeekBinding().route, baseUrl: 'https://llm.acme.example/v1' } }))
    assert.equal((await post('/anthropic/v1/messages', other, { model: 'deepseek-v4-flash' })).status, 403)
    const deepSeek = gateway.issueToken(deepSeekBinding())
    assert.equal((await post('/anthropic/v1/messages', deepSeek, { model: 'deepseek-v4-pro' })).status, 403)
    assert.equal(calls.length, 0)
  })

  it('等待响应头时 DSH 断开记为中止，不归为模型错误', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    let release: () => void = () => undefined
    respond = () => new Promise<Response>((_resolve, reject) => {
      release = () => reject(new DOMException('aborted', 'AbortError'))
    })
    const controller = new AbortController()
    const pending = fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro' }), signal: controller.signal,
    }).catch(() => undefined)
    while (calls.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await pending
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    while (log.records.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(log.records[0]?.outcome, 'aborted')
    const inspected = await gateway.inspectAttemptFailure('tenant-dsh-work', 'attempt-1')
    assert.equal(inspected.failure, undefined)
    assert.equal(inspected.chatRequests, 1)
  })

  it('写请求记录失败不改变返回给 DSH 的状态码', async () => {
    const failing = new ModelGateway({
      dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)),
      log: { record: async () => { throw new Error('database down') }, listForAttempt: async () => [] },
      credentials: { readSecret: async () => 'sk' },
      fetch: async () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } }),
      onError: () => undefined,
    })
    const failingBase = await failing.start()
    try {
      const token = failing.issueToken(deepSeekBinding())
      const send = (model: string) => fetch(`${failingBase}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model }),
      })
      assert.equal((await send('deepseek-v4-flash')).status, 403, '网关拒绝仍为 403')
      const limited = await send('deepseek-v4-pro')
      assert.equal(limited.status, 429, '厂商错误仍原样透传')
      await limited.text()
    } finally {
      await failing.stop()
    }
  })

  it('请求体过大或不是 JSON 用 MODEL_REQUEST_INVALID，不提示路由问题', async () => {
    const small = new ModelGateway({ dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)), log, credentials: { readSecret: async () => 'sk' }, maxRequestBytes: 16, fetch: async () => new Response('') })
    const smallBase = await small.start()
    try {
      const token = small.issueToken(deepSeekBinding({ attemptId: 'attempt-large' }))
      const response = await fetch(`${smallBase}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: ['x'.repeat(64)] }),
      })
      assert.equal(response.status, 413)
      assert.equal((await response.json() as { code: string }).code, 'MODEL_REQUEST_INVALID')
      assert.equal((await small.inspectAttemptFailure('tenant-dsh-work', 'attempt-large')).failure?.code, 'MODEL_INVOCATION_FAILED')
    } finally {
      await small.stop()
    }
  })

  it('200 流中途出现厂商错误事件时记为失败并按上游不可用分类', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    respond = () => streamResponse('data: {"choices":[{"delta":{"content":"a"}}]}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')
    const response = await post('/v1/chat/completions', token, { model: 'deepseek-v4-pro' })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(log.records[0]?.outcome, 'failed')
    assert.equal(log.records[0]?.errorCode, 'overloaded_error')
    assert.equal((await gateway.inspectAttemptFailure('tenant-dsh-work', 'attempt-1')).failure?.code, 'MODEL_UPSTREAM_UNAVAILABLE')
  })

  it('只看对话请求：联网搜索失败不把 Attempt 归为模型错误', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    respond = () => streamResponse(sse(['[DONE]']))
    await (await post('/v1/chat/completions', token, { model: 'deepseek-v4-pro' })).text()
    respond = () => new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), { status: 429, headers: { 'content-type': 'application/json' } })
    await (await post('/anthropic/v1/messages', token, { model: 'deepseek-v4-flash' })).text()
    const inspected = await gateway.inspectAttemptFailure('tenant-dsh-work', 'attempt-1')
    assert.equal(inspected.failure, undefined)
    assert.equal(inspected.chatRequests, 1)
  })

  it('厂商发完错误响应头后卡住时，读取错误正文也受时限约束', async () => {
    const slow = new ModelGateway({
      dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)),
      log, credentials: { readSecret: async () => 'sk' }, upstreamHeadersTimeoutMs: 50,
      fetch: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'))
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        },
      }), { status: 500, headers: { 'content-type': 'application/json' } }),
    })
    const slowBase = await slow.start()
    try {
      const token = slow.issueToken(deepSeekBinding({ attemptId: 'attempt-slow' }))
      const response = await fetch(`${slowBase}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-pro' }),
      })
      assert.equal(response.status, 500)
      await response.text()
      assert.equal((await slow.inspectAttemptFailure('tenant-dsh-work', 'attempt-slow')).failure?.code, 'MODEL_UPSTREAM_UNAVAILABLE')
    } finally {
      await slow.stop()
    }
  })

  it('签发新令牌时清理已过期的令牌', async () => {
    let now = Date.now()
    const clocked = new ModelGateway({ dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)), log, credentials: { readSecret: async () => 'sk' }, now: () => now })
    clocked.issueToken(deepSeekBinding({ attemptId: 'attempt-old', expiresAt: now + 10 }))
    now += 100
    clocked.issueToken(deepSeekBinding({ attemptId: 'attempt-new', expiresAt: now + 10_000 }))
    const internals = clocked as unknown as { bindings: Map<string, unknown>; attemptTokens: Map<string, string> }
    assert.equal(internals.bindings.size, 1)
    assert.deepEqual([...internals.attemptTokens.keys()], ['attempt-new'])
  })

  it('不提供其他接口', async () => {
    const token = gateway.issueToken(deepSeekBinding())
    assert.equal((await post('/v1/embeddings', token, { model: 'deepseek-v4-pro' })).status, 404)
    assert.equal((await fetch(`${base}/v1/chat/completions`)).status, 404)
  })
})

describe('网关记录的失败分类（模型路由方案 4.7）', () => {
  const record = (fields: Partial<ModelGatewayRequestRecord>): ModelGatewayRequestRecord => ({
    id: 'r', tenantId: 't', runId: 'run', attemptId: 'a', routeId: 'route', providerKey: 'p', modelKey: 'm',
    endpoint: 'chat', origin: 'upstream', outcome: 'failed', httpStatus: 500, errorCode: null,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    startedAt: '2026-11-07T00:00:00.000Z', finishedAt: '2026-11-07T00:00:00.000Z', ...fields,
  })

  it('以最后一个请求为准：失败后又成功则不归为模型错误', () => {
    assert.equal(classifyAttemptModelFailure([]), undefined)
    assert.equal(classifyAttemptModelFailure([record({ httpStatus: 429 }), record({ outcome: 'succeeded', httpStatus: 200 })]), undefined)
    assert.equal(classifyAttemptModelFailure([record({ outcome: 'succeeded', httpStatus: 200 }), record({ httpStatus: 429 })])?.code, 'MODEL_RATE_LIMITED')
  })

  it('网关拒绝按记录的平台错误码；408 归为上游不可用；客户端中止不是模型错误', () => {
    assert.equal(classifyAttemptModelFailure([record({ origin: 'transport', outcome: 'aborted', httpStatus: null })]), undefined)
    assert.equal(classifyAttemptModelFailure([record({ origin: 'gateway', httpStatus: 403, errorCode: 'MODEL_ROUTE_UNAVAILABLE' })])?.code, 'MODEL_ROUTE_UNAVAILABLE')
    assert.equal(classifyAttemptModelFailure([record({ httpStatus: 408 })])?.code, 'MODEL_UPSTREAM_UNAVAILABLE')
    assert.equal(classifyAttemptModelFailure([record({ outcome: 'aborted', httpStatus: 200 })]), undefined)
  })
})

describe('用量解析', () => {
  it('OpenAI 兼容只有 DeepSeek 命中字段时也读取缓存读取量', () => {
    const usage = new UsageAccumulator()
    usage.acceptSseChunk('data: {"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_cache_hit_tokens":64}}\n')
    assert.deepEqual(usage.finish(), { inputTokens: 100, outputTokens: 5, cacheReadTokens: 64, cacheWriteTokens: null })
  })

  it('没有用量时全部为 null', () => {
    const usage = new UsageAccumulator()
    usage.acceptSseChunk('data: {"choices":[]}\n\ndata: [DONE]\n')
    assert.deepEqual(usage.finish(), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null })
  })

  it('Anthropic 非流式回复', () => {
    const usage = new UsageAccumulator()
    usage.acceptJson({ type: 'message', usage: { input_tokens: 7, output_tokens: 2 } })
    assert.deepEqual(usage.finish(), { inputTokens: 7, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null })
  })
})
