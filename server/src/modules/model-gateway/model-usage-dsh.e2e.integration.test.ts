/**
 * 模型路由方案第 8 节 P1（MR-S3）：受控真实 DSH 下，运行结束时写入的用量与模型网关的逐次请求记录一致。
 * 一次性 PostgreSQL + 平台真实服务与 Run/Attempt 链路 + 执行容器中的真实 DSH，模型用经平台模型网关转发的
 * 本地 OpenAI 兼容假上游（返回带缓存读取的用量，不连接真实厂商）；网关记录写入 PostgreSQL，
 * 与生产一致由 ModelGatewayUsageMeter 汇总后交给运行结束处理。
 *
 * 核对三处数字一致：用量记录 `model_usage_events`（对话与联网搜索各一行，实际模型、请求次数、失败次数、缓存读）、
 * 管理端“模型用量”页的执行明细（PostgresModelUsageService.getExecutions），以及 Task 预算结算 `attempt_budget_usage`。
 *
 * 同一套环境还覆盖模型路由方案第 8 节 P1（MR-S2）的两条路由时机：停用默认路由不影响进行中的 Attempt（之后新建的运行被拒绝），
 * 更换默认路由后重试的新 Attempt 使用新路由。
 *
 * Opt-in，不进 CI：`pnpm --filter @dsh-work/server test:model-usage:e2e`（设置 DSH_WORK_MODEL_USAGE_E2E=1）。
 * 需要 `.env` 的 DSH_RUNTIME_HOME（锁定版本的 DSH）、DSH_WORK_EXECUTION_IMAGE（已按摘要拉取的执行镜像）
 * 与 DSH_WORK_TEST_DATABASE_URL（只接受回环地址）。执行容器启动检查会清扫遗留的 dsh-exec-* 容器，
 * 不要在本机服务有运行中的 Agent 任务时执行。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { PostgresModelUsageService } from '../admin/application/postgres-model-usage-service.ts'
import { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import { PostgresAgentService } from '../agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import { DataProtectionService, MemoryDataProtectionStore } from '../data-protection/data-protection-service.ts'
import { createThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { LocalObjectStorage } from '../../infrastructure/storage/local-object-storage.ts'
import { ModelGovernanceService } from '../model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../model/postgres-model-governance-repository.ts'
import { PostgresRunRepository } from '../run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../run/run-orchestration-service.ts'
import { DshAcpRuntimeAdapter } from '../runtime/dsh-acp-runtime-adapter.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation } from '../runtime/dsh-runtime-installation.ts'
import { startExecutionContainers } from '../runtime/execution-container-startup.ts'
import { PostgresTaskRepository } from '../task/postgres-task-repository.ts'
import { PostgresContentService } from '../workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../workbench/application/postgres-conversation-repository.ts'
import { ModelGateway } from './model-gateway.ts'
import { PostgresModelGatewayRequestLog } from './model-gateway-request-log.ts'
import { ModelGatewayUsageMeter } from './model-gateway-usage-meter.ts'

const maintenance = process.env.DSH_WORK_TEST_DATABASE_URL
const skip = process.env.DSH_WORK_MODEL_USAGE_E2E !== '1' ? 'DSH_WORK_MODEL_USAGE_E2E is not set'
  : !process.env.DSH_RUNTIME_HOME ? 'DSH_RUNTIME_HOME is not set'
    : !process.env.DSH_WORK_EXECUTION_IMAGE ? 'DSH_WORK_EXECUTION_IMAGE is not set'
      : !maintenance ? 'DSH_WORK_TEST_DATABASE_URL is not set'
        : !['localhost', '127.0.0.1', '::1'].includes(new URL(maintenance).hostname) ? 'DSH_WORK_TEST_DATABASE_URL must be loopback'
          : false
const projectRoot = resolve(import.meta.dirname, '../../../..')
const tenantId = 'tenant-dsh-work'
const VENDOR_SECRET = 'sk-mr-s3-vendor-secret'

/** 假上游每轮对话返回的用量（含缓存读取）；联网搜索接口返回的用量不含缓存字段。 */
const CHAT_USAGE = { prompt: 120, completion: 8, cached: 64 }
const SEARCH_USAGE = { input: 9, output: 6 }

/**
 * 假上游的脚本：
 * - search-with-retry：第一轮先返回一次 503（DSH 按 retryPolicy 重试），随后调用 web_search，拿到结果后作答；
 * - unauthorized：每次都返回 401（不被重试，运行失败）；
 * - search：不注入失败，先调用 web_search，拿到结果后作答；
 * - answer：直接作答。
 * 设置 gate 时第一次对话请求先停在上游，等测试放行后再继续。
 */
type Script = 'search-with-retry' | 'search' | 'unauthorized' | 'answer'

interface UpstreamState {
  script: Script
  hits: UpstreamHit[]
  failedOnce: boolean
  /** 第一次对话请求到达时调用 onArrive，然后等 gate 放行再作答。 */
  gate: Promise<void> | null
  onArrive: (() => void) | null
}

/** 上游实际收到的请求：路径、返回状态与请求体中的模型。 */
interface UpstreamHit { path: string; status: number; model: string }

function startFakeUpstream(state: UpstreamState) {
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body) as { model: string; messages?: Array<{ role: string }> }
    const path = request.url ?? ''
    const reply = (status: number, payload: unknown) => {
      state.hits.push({ path, status, model: parsed.model })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (path === '/anthropic/v1/messages') {
      reply(200, {
        id: 'msg_mr_s3', type: 'message', role: 'assistant', model: parsed.model,
        content: [{ type: 'text', text: 'MR-S3 搜索结果：网关计量。' }],
        stop_reason: 'end_turn', usage: { input_tokens: SEARCH_USAGE.input, output_tokens: SEARCH_USAGE.output },
      })
      return
    }
    if (state.script === 'unauthorized') {
      reply(401, { error: { message: 'bad key', type: 'authentication_error' } })
      return
    }
    if (state.gate) {
      const gate = state.gate
      state.gate = null
      state.onArrive?.()
      await gate
    }
    if (state.script === 'search-with-retry' && !state.failedOnce) {
      state.failedOnce = true
      reply(503, { error: { message: 'temporarily unavailable', code: 'status_503' } })
      return
    }
    const searching = (state.script === 'search-with-retry' || state.script === 'search') && (parsed.messages ?? []).filter(message => message.role === 'tool').length === 0
    const delta = searching
      ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['dsh-work 模型用量'] }) } }] }
      : { role: 'assistant', content: 'MR-S3 回答完成' }
    state.hits.push({ path, status: 200, model: parsed.model })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (choices: unknown[], extra: object = {}) => response.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices, ...extra })}\n\n`)
    chunk([{ index: 0, delta, finish_reason: null }])
    chunk([{ index: 0, delta: {}, finish_reason: searching ? 'tool_calls' : 'stop' }])
    chunk([], { usage: { prompt_tokens: CHAT_USAGE.prompt, completion_tokens: CHAT_USAGE.completion, total_tokens: CHAT_USAGE.prompt + CHAT_USAGE.completion, prompt_tokens_details: { cached_tokens: CHAT_USAGE.cached } } })
    response.end('data: [DONE]\n\n')
  }
  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
}

interface UsageRow {
  endpoint: string; provider: string; model: string; status: string; measurement: string; estimated: boolean
  inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null
  requests: number | null; failedRequests: number | null
}

interface GatewayRow {
  endpoint: string; origin: string; outcome: string; modelKey: string
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null
}

describe('MR-S3 与 MR-S2 P1：受控真实 DSH 下的用量计量与路由时机', { skip, timeout: 900_000 }, () => {
  const nonce = randomUUID().slice(0, 8)
  const employee = `user-mr-s3-${nonce}`
  const upstreamState: UpstreamState = { script: 'search-with-retry', hits: [], failedOnce: false, gate: null, onArrive: null }
  let directory: string
  let disposable: Awaited<ReturnType<typeof createThrowawayDatabase>>
  let execution: Awaited<ReturnType<typeof startExecutionContainers>>
  let upstream: Server
  let gateway: ModelGateway
  let runtime: DshAcpRuntimeAdapter
  let orchestration: RunOrchestrationService
  let runs: PostgresRunRepository
  let agents: PostgresAgentService
  let usage: PostgresModelUsageService
  let models: ModelGovernanceService
  let personalWorkspace: string

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mr-s3-p1-'))
    upstream = startFakeUpstream(upstreamState)
    await new Promise<void>(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen))
    const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

    disposable = await createThrowawayDatabase({ namePrefix: 'dsh_work_mr_s3_p1', maxConnections: 8 })
    const database = disposable.client
    // 与生产一致：网关把逐次请求写入 PostgreSQL，运行结束时由同一张表汇总。
    gateway = new ModelGateway({
      dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)),
      log: new PostgresModelGatewayRequestLog(database),
      credentials: { readSecret: async () => VENDOR_SECRET },
      // 种子路由的 base_url 是 DeepSeek 官方地址（启用联网搜索），转发时改写到本地假上游。
      fetch: (url, init) => fetch(url.replace(/^https?:\/\/[^/]+/, upstreamBase), init),
    })
    await gateway.start()

    const baseInstallation = await resolveDshRuntimeInstallation({ projectRoot })
    await preflightDshRuntime(baseInstallation)
    execution = await startExecutionContainers(baseInstallation, { projectRoot, dataRoot: directory, image: process.env.DSH_WORK_EXECUTION_IMAGE })
    const { installation, containers } = execution
    const authorization = new PostgresAuthorizationService(database)
    const conversations = new PostgresConversationRepository(database)
    const content = new PostgresContentService(database, new LocalObjectStorage(resolve(directory, 'storage')), authorization)
    runs = new PostgresRunRepository(database)
    runtime = new DshAcpRuntimeAdapter({
      runtimeId: 'runtime-local-01',
      runtimeRoot: resolve(directory, 'attempts'),
      dshRepository: installation.home,
      runtimeVersion: installation.version,
      runtimeCommit: installation.commit,
      protocolVersion: installation.protocolVersion,
      launchMode: installation.launchMode,
      process: installation.process,
      modelGateway: gateway,
      setupTimeoutMs: 60_000,
      authorizeExecution: async manifest => { await orchestration.assertCurrentRunAuthorization(manifest) },
      permissionDecision: async () => 'allow_once',
      collectArtifacts: (manifest, workspaceDirectory) => content.publishRuntimeArtifacts({ manifest, workspaceDirectory }),
      remoteExecution: containers,
    })
    const operations = new PostgresOperationsService(database, runtime, authorization, 'mock')
    agents = new PostgresAgentService(database, operations)
    models = new ModelGovernanceService(new PostgresModelGovernanceRepository(database))
    orchestration = new RunOrchestrationService(
      runs, conversations, models,
      runtime, content, operations, agents, undefined, authorization,
      {
        tasks: new PostgresTaskRepository(database),
        modelUsage: new ModelGatewayUsageMeter(new PostgresModelGatewayRequestLog(database)),
      },
    )
    usage = new PostgresModelUsageService(database, 'Asia/Shanghai')

    await database`
      insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
      values (${employee}, ${tenantId}, ${`directory:${employee}`}, 'MR-S3 员工', null, 'active', 'local', true)
    `
    await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${employee}, 'role-employee', 'local')`
    const [personal] = await database<{ id: string }[]>`
      select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${employee}
    `
    assert.ok(personal, 'the personal workspace is created with the user')
    personalWorkspace = personal.id
  })

  after(async () => {
    await orchestration?.close().catch(() => undefined)
    await runtime?.close().catch(() => undefined)
    execution?.containers.close()
    await gateway?.stop().catch(() => undefined)
    if (upstream) await new Promise<void>(resolveClose => upstream.close(() => resolveClose()))
    await disposable?.dispose()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  async function publishedAgent(suffix: string) {
    const id = `agent-mr-s3-${suffix}-${nonce}`
    const created = await agents.createAgent({
      id, name: `MR-S3 ${suffix}`, description: '一次性核对模型用量计量。', owner: employee, department: '验收',
      visibleRoleIds: ['role-employee'], executionRoleIds: ['role-employee'], executionDataScopes: ['workspace:authorized'],
      welcomeMessage: '', examplePrompts: ['搜一下模型用量'],
      systemPrompt: '你是一次性验收助手。按用户要求联网搜索并简短回答。', workInstructions: '', skills: [],
      mcpScope: { mode: 'none', connectorIds: [] }, webSearchEnabled: true,
      maxOutputBytes: 65536, maxToolCalls: 12, timeoutSeconds: 180, changeSummary: 'MR-S3 P1', actor: 'U00008',
    })
    await disposable.client`
      update agent_versions set status = 'published', published_at = now(), published_by = 'U00008'
       where tenant_id = ${tenantId} and id = ${created.version.id} and status = 'draft'
    `
    await disposable.client`
      update agents set status = 'published', active_version_id = ${created.version.id}, draft_version_id = null
       where tenant_id = ${tenantId} and id = ${id}
    `
    return created
  }

  async function startConversation(suffix: string, prompt: string) {
    const agent = await publishedAgent(suffix)
    const session = await orchestration.createSession({ userId: employee, workspaceId: personalWorkspace, title: `MR-S3 ${suffix}`, agentVersionId: agent.version.id })
    const run = await orchestration.startRun({ userId: employee, sessionId: session.id, prompt, idempotencyKey: `mr-s3-${suffix}-${nonce}` })
    assert.ok(run)
    return run.id
  }

  async function waitForRun(runId: string) {
    const deadline = Date.now() + 240_000
    let status = ''
    while (Date.now() < deadline) {
      status = (await runs.getRun(tenantId, runId))?.status ?? ''
      if (['succeeded', 'failed', 'cancelled'].includes(status)) break
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
    const [attempt] = await disposable.client<{ id: string; errorCode: string | null }[]>`
      select id, error_code as "errorCode" from run_attempts where tenant_id = ${tenantId} and run_id = ${runId} order by attempt_no desc limit 1
    `
    assert.ok(attempt, `run ${runId} has an attempt`)
    return { status, attemptId: attempt.id, errorCode: attempt.errorCode }
  }

  /** 用量与预算在终态事件之后写入；等到用量行出现（失败运行同样有网关记录，必然写入）。 */
  async function usageRows(attemptId: string) {
    const deadline = Date.now() + 30_000
    for (;;) {
      const rows = await disposable.client<UsageRow[]>`
        select endpoint, provider, model, status, measurement, estimated,
               input_tokens::integer as "inputTokens", output_tokens::integer as "outputTokens",
               cache_read_tokens::integer as "cacheReadTokens", cache_write_tokens::integer as "cacheWriteTokens",
               request_count as requests, failed_request_count as "failedRequests"
          from model_usage_events where tenant_id = ${tenantId} and attempt_id = ${attemptId}
         order by endpoint
      `
      // postgres 返回 Result 数组，转成普通数组以便 deepStrictEqual。
      if (rows.length > 0 || Date.now() > deadline) return rows.map(row => ({ ...row }))
      await new Promise(resolveWait => setTimeout(resolveWait, 200))
    }
  }

  async function gatewayRows(attemptId: string) {
    return disposable.client<GatewayRow[]>`
      select endpoint, origin, outcome, model_key as "modelKey", input_tokens as "inputTokens",
             output_tokens as "outputTokens", cache_read_tokens as "cacheReadTokens"
        from model_gateway_requests where tenant_id = ${tenantId} and attempt_id = ${attemptId}
       order by started_at
    `
  }

  async function budgetRow(attemptId: string) {
    const deadline = Date.now() + 30_000
    for (;;) {
      const [row] = await disposable.client<{ inputTokens: number | null; outputTokens: number | null; tokenMeasurement: string; terminalStatus: string | null }[]>`
        select input_tokens::integer as "inputTokens", output_tokens::integer as "outputTokens",
               token_measurement as "tokenMeasurement", terminal_status as "terminalStatus"
          from attempt_budget_usage where tenant_id = ${tenantId} and attempt_id = ${attemptId}
      `
      if ((row && row.terminalStatus !== null) || Date.now() > deadline) return row
      await new Promise(resolveWait => setTimeout(resolveWait, 200))
    }
  }

  async function executionDetail(attemptId: string) {
    // 用“近 7 天”而非“今天”：测试跨平台时区零点时仍能查到本次执行。
    const page = await usage.getExecutions({ range: '7d' }, 1, 50)
    return page.items.find(item => item.attemptId === attemptId)
  }

  /** 网关记录中厂商成功返回的最后一次请求的模型（模型路由方案 4.6 的实际模型）。 */
  function succeededModel(rows: GatewayRow[], endpoint: 'chat' | 'search') {
    return rows.filter(row => row.endpoint === endpoint && row.origin === 'upstream' && row.outcome === 'succeeded').at(-1)?.modelKey
  }

  /** 由网关记录按请求类型求和，作为三处数字的共同基准。 */
  function totals(rows: GatewayRow[], endpoint: 'chat' | 'search') {
    const items = rows.filter(row => row.endpoint === endpoint)
    const sum = (pick: (row: GatewayRow) => number | null) => items.reduce((total, row) => total + (pick(row) ?? 0), 0)
    return {
      requests: items.length,
      failed: items.filter(row => row.outcome === 'failed').length,
      input: sum(row => row.inputTokens),
      output: sum(row => row.outputTokens),
      cacheRead: sum(row => row.cacheReadTokens),
    }
  }

  it('对话含一次 503 重试与联网搜索：用量两行、执行明细与预算结算都等于网关记录之和', async () => {
    upstreamState.script = 'search-with-retry'
    upstreamState.failedOnce = false
    upstreamState.hits.length = 0
    const runId = await startConversation('search', '搜一下模型用量，然后简短回答。')
    const { status, attemptId, errorCode } = await waitForRun(runId)
    assert.equal(status, 'succeeded', `run did not succeed: ${errorCode ?? 'no error code'}`)

    // 上游实际收到的请求：一次 503、两轮成功的对话、一次联网搜索。
    assert.deepEqual(upstreamState.hits.map(hit => `${hit.path} ${hit.status}`), [
      '/chat/completions 503', '/chat/completions 200', '/anthropic/v1/messages 200', '/chat/completions 200',
    ])
    const gatewayRecords = await gatewayRows(attemptId)
    const chat = totals(gatewayRecords, 'chat')
    const search = totals(gatewayRecords, 'search')
    assert.deepEqual(chat, { requests: 3, failed: 1, input: CHAT_USAGE.prompt * 2, output: CHAT_USAGE.completion * 2, cacheRead: CHAT_USAGE.cached * 2 })
    assert.deepEqual(search, { requests: 1, failed: 0, input: SEARCH_USAGE.input, output: SEARCH_USAGE.output, cacheRead: 0 })

    // 1. 用量记录：对话与联网搜索各一行，实际模型取厂商成功返回的请求，measurement 为 gateway。
    const rows = await usageRows(attemptId)
    assert.equal(rows.find(row => row.endpoint === 'chat')?.model, succeededModel(gatewayRecords, 'chat'), 'chat model comes from the vendor-succeeded request')
    assert.equal(rows.find(row => row.endpoint === 'search')?.model, succeededModel(gatewayRecords, 'search'), 'search model comes from the vendor-succeeded request')
    assert.deepEqual(rows, [
      {
        endpoint: 'chat', provider: 'deepseek-official', model: 'deepseek-v4-pro', status: 'success', measurement: 'gateway', estimated: false,
        inputTokens: chat.input, outputTokens: chat.output, cacheReadTokens: chat.cacheRead, cacheWriteTokens: null,
        requests: chat.requests, failedRequests: chat.failed,
      },
      {
        endpoint: 'search', provider: 'deepseek-official', model: 'deepseek-v4-flash', status: 'success', measurement: 'gateway', estimated: false,
        inputTokens: search.input, outputTokens: search.output, cacheReadTokens: null, cacheWriteTokens: null,
        requests: search.requests, failedRequests: search.failed,
      },
    ])

    // 2. 管理端“模型用量”执行明细：同一组数字。
    const detail = await executionDetail(attemptId)
    assert.ok(detail, 'the execution appears in the model usage page')
    assert.equal(detail.runId, runId)
    assert.equal(detail.source, 'conversation')
    assert.equal(detail.employeeId, employee)
    assert.equal(detail.model, 'deepseek-v4-pro')
    assert.equal(detail.measurement, 'gateway')
    assert.equal(detail.inputTokens, chat.input)
    assert.equal(detail.outputTokens, chat.output)
    assert.equal(detail.cacheReadTokens, chat.cacheRead)
    assert.equal(detail.requests, chat.requests)
    assert.equal(detail.failedRequests, chat.failed)
    assert.deepEqual(detail.search, { model: 'deepseek-v4-flash', inputTokens: search.input, outputTokens: search.output, requests: search.requests })
    assert.equal(detail.totalTokens, chat.input + chat.output + search.input + search.output)

    // 3. Task 预算结算：网关计量优先于 DSH 会话日志，与用量页同一组数字。
    const budget = await budgetRow(attemptId)
    assert.ok(budget, 'the attempt budget is settled')
    assert.equal(budget.terminalStatus, 'succeeded')
    assert.equal(budget.tokenMeasurement, 'reported')
    assert.equal(budget.inputTokens, chat.input + search.input)
    assert.equal(budget.outputTokens, chat.output + search.output)
  })

  it('厂商 401 运行失败：用量记录一次失败请求、零 token，执行明细与之一致', async () => {
    upstreamState.script = 'unauthorized'
    upstreamState.hits.length = 0
    const runId = await startConversation('unauthorized', '你好')
    const { status, attemptId, errorCode } = await waitForRun(runId)
    assert.equal(status, 'failed')
    assert.equal(errorCode, 'MODEL_CREDENTIAL_INVALID')
    assert.deepEqual(upstreamState.hits.map(hit => `${hit.path} ${hit.status}`), ['/chat/completions 401'], '401 is not retried')

    const gatewayRecords = await gatewayRows(attemptId)
    assert.equal(gatewayRecords.length, 1)
    assert.equal(gatewayRecords[0]?.origin, 'upstream')
    assert.equal(gatewayRecords[0]?.outcome, 'failed')

    const rows = await usageRows(attemptId)
    assert.deepEqual(rows, [{
      endpoint: 'chat', provider: 'deepseek-official', model: 'deepseek-v4-pro', status: 'failed', measurement: 'gateway', estimated: false,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, requests: 1, failedRequests: 1,
    }])
    const detail = await executionDetail(attemptId)
    assert.ok(detail)
    assert.equal(detail.status, 'failed')
    assert.equal(detail.errorCode, 'MODEL_CREDENTIAL_INVALID')
    assert.equal(detail.requests, 1)
    assert.equal(detail.failedRequests, 1)
    assert.equal(detail.totalTokens, 0)
    assert.equal(detail.search, null)

    // 网关有记录（虽无用量）即以网关计量结算：零 token，与用量页一致。
    const budget = await budgetRow(attemptId)
    assert.ok(budget, 'the attempt budget is settled')
    assert.equal(budget.terminalStatus, 'failed')
    assert.equal(budget.tokenMeasurement, 'reported')
    assert.equal(budget.inputTokens, 0)
    assert.equal(budget.outputTokens, 0)
  })

  async function defaultRoute() {
    const route = (await models.listRoutes()).find(item => item.id === 'route-default')
    assert.ok(route, 'the seeded default route exists')
    return route
  }

  async function setDefaultRoute(change: { enabled?: boolean; providerModelId?: string }) {
    const route = await defaultRoute()
    await models.updateRoute({
      routeId: route.id, name: route.name, actor: 'U00008',
      providerModelId: change.providerModelId ?? route.providerModelId, enabled: change.enabled ?? route.enabled,
    })
  }

  async function chatModelsOf(attemptId: string) {
    return (await gatewayRows(attemptId)).filter(row => row.endpoint === 'chat').map(row => row.modelKey)
  }

  /** 等待 promise，超时则失败（避免运行提前结束时干等到整个用例的时限）。 */
  async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })])
    } finally {
      clearTimeout(timer)
    }
  }

  it('MR-S2：停用默认路由后，进行中的 Attempt 仍按固定路由发出后续请求并完成，之后新建的运行被拒绝', async () => {
    const original = await defaultRoute()
    let release: (() => void) | undefined
    try {
      // 运行需要多轮模型请求：第一轮对话（停在上游）→ 联网搜索 → 第二轮对话。停用发生在第一轮返回之前，
      // 搜索与第二轮对话都在停用之后才发出，用来证明停用后的请求仍按 Manifest 中固定的路由放行。
      upstreamState.script = 'search'
      upstreamState.hits.length = 0
      let arrived!: () => void
      const arrival = new Promise<void>(resolveArrival => { arrived = resolveArrival })
      upstreamState.gate = new Promise<void>(resolveGate => { release = resolveGate })
      upstreamState.onArrive = arrived
      const runId = await startConversation('disable', '搜一下模型路由，然后简短回答。')
      await within(arrival, 120_000, 'the first model request never reached the upstream')

      await setDefaultRoute({ enabled: false })
      assert.equal((await defaultRoute()).enabled, false)
      const [{ disabledAt }] = await disposable.client<{ disabledAt: Date }[]>`select now() as "disabledAt"`
      const hitsBeforeRelease = upstreamState.hits.length
      await assert.rejects(startConversation('after-disable', '你好'), (error: { code?: string }) => error.code === 'MODEL_ROUTE_NOT_READY',
        'a run created after disabling has no default route')
      release!()

      const { status, attemptId, errorCode } = await waitForRun(runId)
      assert.equal(status, 'succeeded', `the in-progress run must finish on its pinned route: ${errorCode ?? 'no error code'}`)
      const after = await disposable.client<{ endpoint: string; routeId: string; modelKey: string; outcome: string }[]>`
        select endpoint, route_id as "routeId", model_key as "modelKey", outcome from model_gateway_requests
         where tenant_id = ${tenantId} and attempt_id = ${attemptId} and started_at > ${disabledAt}
         order by started_at
      `
      assert.deepEqual(after.map(record => record.endpoint), ['search', 'chat'], 'the search and the second chat round were sent after the disable')
      assert.ok(after.every(record => record.routeId === original.id && record.outcome === 'succeeded'), 'requests after the disable used the pinned route')
      assert.equal(after.at(-1)?.modelKey, original.modelKey)
      // 上游实际收到的停用后请求：对话仍是固定路由的模型。
      const upstreamAfter = upstreamState.hits.slice(hitsBeforeRelease + 1)
      assert.deepEqual(upstreamAfter.map(hit => hit.path), ['/anthropic/v1/messages', '/chat/completions'])
      assert.equal(upstreamAfter.at(-1)?.model, original.modelKey)
    } finally {
      release?.()
      upstreamState.gate = null
      upstreamState.onArrive = null
      await setDefaultRoute({ enabled: true })
    }
  })

  it('MR-S2：更换默认路由后重试，新 Attempt 使用新路由', async () => {
    const original = await defaultRoute()
    upstreamState.script = 'unauthorized'
    upstreamState.hits.length = 0
    const runId = await startConversation('retry', '你好')
    const first = await waitForRun(runId)
    assert.equal(first.status, 'failed')
    assert.equal(first.errorCode, 'MODEL_CREDENTIAL_INVALID')
    assert.deepEqual(await chatModelsOf(first.attemptId), [original.modelKey])

    // 管理员在同一 Provider 下添加模型并把默认路由指向它（能力与原模型一致）。
    const providerModels = await disposable.client<{ providerId: string; capabilities: string[] }[]>`
      select provider_id as "providerId", capabilities from provider_models where tenant_id = ${tenantId} and id = ${original.providerModelId}
    `
    await models.createProviderModel({
      providerId: providerModels[0]!.providerId, modelKey: `deepseek-mr-s2-${nonce}`, displayName: 'MR-S2 替换模型',
      capabilities: providerModels[0]!.capabilities, actor: 'U00008',
    })
    // createProviderModel 返回所属 Provider，按模型标识取新模型。
    const [replacement] = await disposable.client<{ id: string }[]>`
      select id from provider_models where tenant_id = ${tenantId} and model_key = ${`deepseek-mr-s2-${nonce}`}
    `
    assert.ok(replacement, 'the replacement model was created')
    try {
      await setDefaultRoute({ providerModelId: replacement.id })
      upstreamState.script = 'answer'
      upstreamState.hits.length = 0
      await orchestration.retry(runId, employee)
      const deadline = Date.now() + 30_000
      let second = await waitForRun(runId)
      while (second.attemptId === first.attemptId && Date.now() < deadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, 200))
        second = await waitForRun(runId)
      }
      assert.notEqual(second.attemptId, first.attemptId, 'retry created a new Attempt')
      assert.equal(second.status, 'succeeded', `retry did not succeed: ${second.errorCode ?? 'no error code'}`)
      const [attempt] = await disposable.client<{ manifest: { model_route?: { route_id: string; model_key: string } } }[]>`
        select manifest from run_attempts where tenant_id = ${tenantId} and id = ${second.attemptId}
      `
      assert.equal(attempt?.manifest.model_route?.route_id, original.id)
      assert.equal(attempt?.manifest.model_route?.model_key, `deepseek-mr-s2-${nonce}`, 'the retry pinned the new default route target')
      const retried = await chatModelsOf(second.attemptId)
      assert.ok(retried.length >= 1 && retried.every(model => model === `deepseek-mr-s2-${nonce}`), 'the gateway recorded the new model')
      const received = upstreamState.hits.filter(hit => hit.path === '/chat/completions').map(hit => hit.model)
      assert.ok(received.length >= 1 && received.every(model => model === `deepseek-mr-s2-${nonce}`), 'the upstream actually received the new model')
      const rows = await usageRows(second.attemptId)
      assert.equal(rows.find(row => row.endpoint === 'chat')?.model, `deepseek-mr-s2-${nonce}`)
      // 原 Attempt 的记录不受影响。
      assert.deepEqual(await chatModelsOf(first.attemptId), [original.modelKey])
    } finally {
      await setDefaultRoute({ providerModelId: original.providerModelId })
    }
  })
})
