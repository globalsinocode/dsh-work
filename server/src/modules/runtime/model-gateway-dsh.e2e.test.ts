import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { DataProtectionService, MemoryDataProtectionStore } from '../data-protection/data-protection-service.ts'
import { DshAcpRuntimeAdapter } from './dsh-acp-runtime-adapter.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation } from './dsh-runtime-installation.ts'
import type { RuntimeManifest, RuntimeModelRoute } from './runtime-types.ts'
import { ModelGateway } from '../model-gateway/model-gateway.ts'
import { MemoryModelGatewayRequestLog } from '../model-gateway/model-gateway-request-log.ts'

/**
 * 模型路由方案第 8 节 P1（MR-S2）与数据防护方案 DLP-S1：受控真实 DSH + 平台模型网关 + 记录请求的
 * OpenAI 兼容假上游（不连接真实厂商）。Opt-in：`pnpm --filter @dsh-work/server test:model-gateway:e2e`
 * （设置 DSH_WORK_MODEL_GATEWAY_E2E=1，DSH_RUNTIME_HOME 为锁定版本的 DSH checkout）。
 *
 * 覆盖：路由生效（上游收到路由模型与平台密钥）、共享 settings.yaml 中的同名路由不影响平台路由、
 * 令牌与请求模型不符被拒绝、厂商 401 / 400 不被重试、429 与 5xx 按 retryPolicy 重试后分类、
 * 联网搜索经网关透传。
 */
const skip = process.env.DSH_WORK_MODEL_GATEWAY_E2E !== '1' ? 'DSH_WORK_MODEL_GATEWAY_E2E is not set'
  : !process.env.DSH_RUNTIME_HOME ? 'DSH_RUNTIME_HOME is not set' : false
const projectRoot = resolve(import.meta.dirname, '../../../..')
const VENDOR_SECRET = 'sk-p1-vendor-secret'

type Behaviour = { status: number; body?: unknown } | 'answer' | 'search-then-answer' | 'echo-placeholder'

interface UpstreamRequest { path: string; authorization: string | undefined; apiKey: string | undefined; model: string }

describe('受控 DSH 经平台模型网关执行（MR-S2 P1）', { skip, timeout: 300_000 }, () => {
  let root: string
  let upstream: Server
  let upstreamBase: string
  let behaviour: Behaviour = 'answer'
  const requests: UpstreamRequest[] = []
  const upstreamBodies: string[] = []
  let gateway: ModelGateway
  let log: MemoryModelGatewayRequestLog
  let adapter: DshAcpRuntimeAdapter

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-gateway-p1-'))
    upstream = createServer((request, response) => void handleUpstream(request, response))
    await new Promise<void>(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen))
    upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

    log = new MemoryModelGatewayRequestLog()
    gateway = new ModelGateway({
      dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)),
      log,
      credentials: { readSecret: async () => VENDOR_SECRET },
      // 路由的 base_url 用 DeepSeek 官方地址（启用联网搜索与思考格式），转发时改写到本地假上游。
      fetch: (url, init) => fetch(url.replace('https://api.deepseek.com', upstreamBase), init),
    })
    await gateway.start()

    // 共享 DSH_HOME 的 settings.yaml 声明同名路由并指向不可达地址：平台每 Attempt 隔离 settings.path，不受影响。
    const dshHome = join(root, 'dsh-home')
    await mkdir(dshHome, { recursive: true })
    await writeFile(join(dshHome, 'settings.yaml'), [
      'llm-pi-ai:',
      '  providers:',
      '    dshw-deepseek-official:',
      '      baseURL: http://127.0.0.1:9/v1',
      '',
    ].join('\n'))

    const env = { ...process.env, DSH_WORK_DATA_ROOT: join(root, 'data') }
    const installation = await resolveDshRuntimeInstallation({ projectRoot, env })
    await preflightDshRuntime(installation)
    adapter = new DshAcpRuntimeAdapter({
      runtimeId: 'runtime-gateway-p1',
      runtimeRoot: join(root, 'attempts'),
      dshRepository: installation.home,
      process: { ...installation.process, env: { ...installation.process.env, DSH_HOME: dshHome } },
      modelGateway: gateway,
      setupTimeoutMs: 60_000,
    })
  })

  after(async () => {
    await adapter?.close()
    await gateway?.stop()
    await new Promise<void>(resolveClose => upstream?.close(() => resolveClose()))
    if (root) await rm(root, { recursive: true, force: true })
  })

  async function handleUpstream(request: IncomingMessage, response: ServerResponse) {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body) as { model: string; messages?: Array<{ role: string }> }
    upstreamBodies.push(body)
    requests.push({
      path: request.url ?? '',
      authorization: request.headers['authorization'],
      apiKey: request.headers['x-api-key'] as string | undefined,
      model: parsed.model,
    })
    if (request.url === '/anthropic/v1/messages') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'msg_p1', type: 'message', role: 'assistant', model: parsed.model,
        content: [{ type: 'text', text: 'P1 搜索结果：网关透传成功。' }],
        stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 6 },
      }))
      return
    }
    if (typeof behaviour === 'object') {
      response.writeHead(behaviour.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(behaviour.body ?? { error: { message: 'failure', code: `status_${behaviour.status}` } }))
      return
    }
    const toolResults = (parsed.messages ?? []).filter(message => message.role === 'tool').length
    const searching = behaviour === 'search-then-answer' && toolResults === 0
    const delta = searching
      ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['dsh-work 模型网关'] }) } }] }
      : { role: 'assistant', content: behaviour === 'echo-placeholder' ? `号码是 ${body.match(/\{\{PERSONAL_[a-z2-7]{10}\}\}/)?.[0] ?? '未遮盖'}` : 'P1 回答完成' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (choices: unknown[], extra: object = {}) => response.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices, ...extra })}\n\n`)
    chunk([{ index: 0, delta, finish_reason: null }])
    chunk([{ index: 0, delta: {}, finish_reason: searching ? 'tool_calls' : 'stop' }])
    chunk([], { usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, prompt_tokens_details: { cached_tokens: 64 } } })
    response.end('data: [DONE]\n\n')
  }

  const route: RuntimeModelRoute = {
    route_id: 'route-p1', route_key: 'default', provider_key: 'deepseek-official', provider_type: 'openai-completions',
    model_key: 'deepseek-v4-pro', base_url: 'https://api.deepseek.com', credential_ref_id: 'credential-p1', trust_level: 'external',
  }

  function manifest(runId: string, tools: string[] = [], message = '你好'): RuntimeManifest {
    return {
      manifest_version: '1.0',
      run_id: runId,
      attempt_id: `${runId}-attempt`,
      task_id: `task-${runId}`,
      session_id: `session-${runId}`,
      workspace_id: 'ws-p1',
      agent_version_id: 'agent-p1-v1',
      agent_configuration: { system_prompt: '你是用于验证模型网关链路的测试助手，按用户要求简短回答。', skill_instructions: [] },
      user_context: { user_id: 'usr-p1', tenant_id: 'tenant-p1', role_ids: ['role-employee'] },
      permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'workspace_only' },
      skills: [],
      tools: tools.map(id => ({ id, version: '1.0.0' })),
      data_scopes: [],
      knowledge_context: [],
      model_route_id: route.route_id,
      model_route: route,
      input: { message, file_mounts: [] },
      budget: { scope_task_id: `task-${runId}`, cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null }, reservation: { duration_ms: 120_000, tool_calls: 5, output_bytes: 64 * 1024 }, enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' } },
      limits: { timeout_seconds: 120, max_output_bytes: 64 * 1024, max_tool_calls: 5 },
      created_at: new Date().toISOString(),
      trace_id: `trace-${runId}`,
    }
  }

  async function run(runId: string, next: Behaviour, tools: string[] = [], message = '你好') {
    behaviour = next
    requests.length = 0
    const result = await (await adapter.execute(manifest(runId, tools, message))).done
    return { result, requests: [...requests], records: await log.listForAttempt('tenant-p1', `${runId}-attempt`) }
  }

  it('路由生效：上游收到路由模型与平台密钥，共享 settings.yaml 的同名路由不覆盖', async () => {
    const { result, requests: seen, records } = await run('run-p1-ok', 'answer')
    assert.equal(result.status, 'completed', result.errorMessage ?? undefined)
    assert.ok(seen.length >= 1)
    assert.ok(seen.every(item => item.path === '/chat/completions' && item.model === 'deepseek-v4-pro'))
    assert.ok(seen.every(item => item.authorization === `Bearer ${VENDOR_SECRET}`), '上游只收到平台密钥')
    assert.equal(records.at(-1)?.outcome, 'succeeded')
    assert.equal(records.at(-1)?.inputTokens, 120)
    assert.equal(records.at(-1)?.cacheReadTokens, 64)
  })

  it('外部厂商：上游收不到原值，回答中的占位符已还原（DLP-S2）', async () => {
    upstreamBodies.length = 0
    behaviour = 'echo-placeholder'
    const execution = await adapter.execute(manifest('run-p1-mask', [], '记一下电话 13812345678'))
    const emitted: unknown[] = []
    adapter.subscribe('run-p1-mask', event => emitted.push(event))
    const result = await execution.done
    assert.equal(result.status, 'completed', result.errorMessage ?? undefined)
    assert.ok(upstreamBodies.length >= 1)
    assert.ok(upstreamBodies.every(body => !body.includes('13812345678')), '上游请求不含原值')
    assert.ok(upstreamBodies.some(body => /\{\{PERSONAL_[a-z2-7]{10}\}\}/.test(body)))
    assert.match(JSON.stringify(emitted), /号码是 13812345678/, 'DSH 收到的回答已还原')
  })

  it('厂商 401 不被重试，以 MODEL_CREDENTIAL_INVALID 结束', async () => {
    const { result, requests: seen } = await run('run-p1-401', { status: 401, body: { error: { message: 'bad key', type: 'authentication_error' } } })
    assert.equal(result.errorCode, 'MODEL_CREDENTIAL_INVALID')
    assert.equal(seen.length, 1)
  })

  it('除 408/429/5xx 外的 4xx 不被重试', async () => {
    const { result, requests: seen } = await run('run-p1-400', { status: 400 })
    assert.equal(result.errorCode, 'MODEL_INVOCATION_FAILED')
    assert.equal(seen.length, 1)
  })

  it('429 经 retryPolicy 重试仍失败后以 MODEL_RATE_LIMITED 结束', async () => {
    const { result, requests: seen } = await run('run-p1-429', { status: 429, body: { error: { message: 'slow down', code: 'rate_limit_exceeded' } } })
    assert.equal(result.errorCode, 'MODEL_RATE_LIMITED')
    assert.equal(seen.length, 3, '1 次请求 + 2 次重试')
  })

  it('额度类错误以 MODEL_QUOTA_EXHAUSTED 结束且不被重试', async () => {
    const { result, requests: seen } = await run('run-p1-402', { status: 402, body: { error: { message: 'Insufficient Balance' } } })
    assert.equal(result.errorCode, 'MODEL_QUOTA_EXHAUSTED')
    assert.equal(seen.length, 1)
  })

  it('5xx 重试后以 MODEL_UPSTREAM_UNAVAILABLE 结束', async () => {
    const { result, requests: seen } = await run('run-p1-503', { status: 503 })
    assert.equal(result.errorCode, 'MODEL_UPSTREAM_UNAVAILABLE')
    assert.equal(seen.length, 3)
  })

  it('联网搜索经网关透传 DeepSeek 搜索接口，使用平台密钥与搜索模型', async () => {
    const { result, requests: seen, records } = await run('run-p1-search', 'search-then-answer', ['web_search'])
    assert.equal(result.status, 'completed', result.errorMessage ?? undefined)
    const search = seen.find(item => item.path === '/anthropic/v1/messages')
    assert.ok(search, '搜索请求经网关到达上游')
    assert.equal(search.model, 'deepseek-v4-flash')
    assert.equal(search.apiKey, VENDOR_SECRET)
    assert.ok(records.some(record => record.endpoint === 'search' && record.outcome === 'succeeded'))
  })
})
