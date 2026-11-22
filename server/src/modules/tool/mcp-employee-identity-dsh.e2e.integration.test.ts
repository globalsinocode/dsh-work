/**
 * EA-S1 P1（外部业务应用接入方案第 10 节）：受控真实 DSH 下，“发送员工身份”的调用上下文请求头
 * 真正到达外部 MCP 服务。一次性 PostgreSQL + 平台真实服务与 Run/Attempt 链路 + 执行容器中的真实 DSH，
 * 模型用经平台模型网关转发的本地假上游（按脚本发起一次 MCP 调用，不连接真实厂商），
 * MCP 用本文件中的假外部应用（校验 Bearer、记录每次工具调用的请求头、按手机号识别员工、shared 拒绝写入）。
 *
 * Opt-in，不进 CI：`pnpm --filter @dsh-work/server test:ea:e2e`（设置 DSH_WORK_EA_P1_E2E=1）。
 * 需要 `.env` 的 DSH_RUNTIME_HOME（锁定版本的 DSH）、DSH_WORK_EXECUTION_IMAGE（已按摘要拉取的执行镜像）
 * 与 DSH_WORK_TEST_DATABASE_URL（只接受回环地址）。执行容器启动检查会清扫遗留的 dsh-exec-* 容器，
 * 不要在本机服务有运行中的 Agent 任务时执行。
 *
 * 与 mcp-connector-governance.integration.test.ts 的分工：后者用手工构造的 Manifest 核对可见类型判定表；
 * 本文件核对各真实入口构造的 Manifest 经真实 DSH 下发后，外部 MCP 服务在请求上实际收到的请求头。
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

import { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import { PostgresAgentService } from '../agent/postgres-agent-service.ts'
import { AgentRoutineService } from '../automation/agent-routine-service.ts'
import { AutomationService } from '../automation/automation-service.ts'
import { defaultAutomationConfig } from '../automation/automation-types.ts'
import { PostgresAutomationRepository } from '../automation/postgres-automation-repository.ts'
import type { AgentMcpScope } from '../../domain/types.ts'
import { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import { DataProtectionService, MemoryDataProtectionStore } from '../data-protection/data-protection-service.ts'
import { createThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { LocalObjectStorage } from '../../infrastructure/storage/local-object-storage.ts'
import { ModelGateway } from '../model-gateway/model-gateway.ts'
import { MemoryModelGatewayRequestLog } from '../model-gateway/model-gateway-request-log.ts'
import { ModelGovernanceService } from '../model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../model/postgres-model-governance-repository.ts'
import { PostgresRunRepository } from '../run/postgres-run-repository.ts'
import { PostgresTaskRepository } from '../task/postgres-task-repository.ts'
import { RunOrchestrationService } from '../run/run-orchestration-service.ts'
import { DshAcpRuntimeAdapter } from '../runtime/dsh-acp-runtime-adapter.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation } from '../runtime/dsh-runtime-installation.ts'
import { startExecutionContainers } from '../runtime/execution-container-startup.ts'
import { PostgresEncryptedCredentialStore } from './postgres-encrypted-credential-store.ts'
import { PostgresMcpConnectorService } from './postgres-mcp-connector-service.ts'
import { PostgresContentService } from '../workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../workbench/application/postgres-conversation-repository.ts'
import { PostgresWorkspaceAgentMemberService } from '../workbench/application/postgres-workspace-agent-member-service.ts'

const maintenance = process.env.DSH_WORK_TEST_DATABASE_URL
const skip = process.env.DSH_WORK_EA_P1_E2E !== '1' ? 'DSH_WORK_EA_P1_E2E is not set'
  : !process.env.DSH_RUNTIME_HOME ? 'DSH_RUNTIME_HOME is not set'
    : !process.env.DSH_WORK_EXECUTION_IMAGE ? 'DSH_WORK_EXECUTION_IMAGE is not set'
      : !maintenance ? 'DSH_WORK_TEST_DATABASE_URL is not set'
        : !['localhost', '127.0.0.1', '::1'].includes(new URL(maintenance).hostname) ? 'DSH_WORK_TEST_DATABASE_URL must be loopback'
          : false
const projectRoot = resolve(import.meta.dirname, '../../../..')
const tenantId = 'tenant-dsh-work'
const VENDOR_SECRET = 'sk-ea-p1-vendor-secret'
const LIST_TOOL = 'receivables_list'

/** 外部 MCP 服务在一次工具调用上实际收到的请求头（只保留认证与调用上下文）。 */
interface ObservedCall { tool: string; authorized: boolean; headers: Record<string, string> }

/** 假外部业务应用：只认自己的 Bearer 凭据，按手机号识别员工，shared 只返回公开数据并拒绝写入。 */
async function startFakeExternalApp(token: string) {
  const calls: ObservedCall[] = []
  /** 每个通过 Bearer 校验的 HTTP 请求（含 initialize、tools/list）收到的调用上下文请求头。 */
  const requests: Array<Record<string, string>> = []
  const records = [
    { id: 'AR-1', owner: '13800138008', amount: 1200, public: false },
    { id: 'AR-2', owner: '13900139009', amount: 800, public: false },
    { id: 'AR-3', owner: null, amount: 0, public: true },
  ]
  const contextHeaders = (request: IncomingMessage) => Object.fromEntries(Object.entries(request.headers)
    .filter(([name]) => name.startsWith('x-dsh-work-'))
    .map(([name, value]) => [name, String(value)]))
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const expected = Buffer.from(`Bearer ${token}`)
    const actual = Buffer.from(request.headers.authorization ?? '')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.writeHead(401).end('Unauthorized')
      return
    }
    const headers = contextHeaders(request)
    requests.push(headers)
    const mcp = new McpServer({ name: 'ea-p1-external-app', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.registerTool(LIST_TOOL, { description: 'List the receivables the current viewer may see.', inputSchema: {} }, async () => {
      calls.push({ tool: LIST_TOOL, authorized: true, headers })
      const visibility = headers['x-dsh-work-visibility']
      const visible = visibility === 'personal'
        ? records.filter(item => item.public || item.owner === headers['x-dsh-work-viewer-mobile'])
        : records.filter(item => item.public)
      return { content: [{ type: 'text', text: JSON.stringify({ visibility: visibility ?? 'none', items: visible.map(item => item.id) }) }] }
    })
    mcp.registerTool('receivables_note', {
      description: 'Add a note to one receivable on behalf of the viewer.',
      inputSchema: { id: z.string().min(1).max(20), note: z.string().max(200) },
    }, async ({ id }) => {
      calls.push({ tool: 'receivables_note', authorized: true, headers })
      if (headers['x-dsh-work-visibility'] !== 'personal') return { content: [{ type: 'text', text: 'shared results cannot write' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({ receipt: `note-${id}`, operator: headers['x-dsh-work-viewer-user-id'] }) }] }
    })
    const transport = new StreamableHTTPServerTransport({})
    response.on('close', () => { void transport.close(); void mcp.close() })
    await mcp.connect(transport)
    await transport.handleRequest(request, response)
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end('fake external app error')
    })
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    calls,
    requests,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  }
}

/** 假上游每次收到的模型请求：工具清单里的查询工具与已返回的工具结果文本。 */
interface ObservedModelRequest { listTools: string[]; toolResults: string[] }

/** OpenAI 兼容假上游：第一轮调用请求中工具清单里名字含 receivables_list 的工具，拿到工具结果后作答。 */
function startFakeModel(observed: ObservedModelRequest[]) {
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body) as { model: string; tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string; content?: unknown }> }
    // 选定的每个外部应用都有同名的查询工具（mcp__<server>__receivables_list），一轮里都调用一次。
    const toolNames = parsed.tools?.map(tool => tool.function?.name ?? '').filter(name => name.endsWith(LIST_TOOL)) ?? []
    const toolMessages = (parsed.messages ?? []).filter(message => message.role === 'tool')
    observed.push({ listTools: toolNames, toolResults: toolMessages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)) })
    const answered = toolMessages.length > 0
    const calling = toolNames.length > 0 && !answered
    const delta = calling
      ? { role: 'assistant', content: null, tool_calls: toolNames.map((name, index) => ({ index, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: '{}' } })) }
      : { role: 'assistant', content: toolNames.length ? 'EA P1：已查询应收。' : 'EA P1：没有可用的应收工具。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (choices: unknown[], extra: object = {}) => response.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices, ...extra })}\n\n`)
    chunk([{ index: 0, delta, finish_reason: null }])
    chunk([{ index: 0, delta: {}, finish_reason: calling ? 'tool_calls' : 'stop' }])
    chunk([], { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })
    response.end('data: [DONE]\n\n')
  }
  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
}

describe('EA-S1 P1：受控真实 DSH 下发调用上下文请求头', { skip, timeout: 900_000 }, () => {
  const nonce = randomUUID().slice(0, 8)
  const enabledToken = randomBytes(32).toString('hex')
  const plainToken = randomBytes(32).toString('hex')
  const employee = `user-ea-${nonce}`
  let directory: string
  let disposable: Awaited<ReturnType<typeof createThrowawayDatabase>>
  let execution: Awaited<ReturnType<typeof startExecutionContainers>>
  let enabledApp: Awaited<ReturnType<typeof startFakeExternalApp>>
  let plainApp: Awaited<ReturnType<typeof startFakeExternalApp>>
  let modelUpstream: Server
  const modelRequests: ObservedModelRequest[] = []
  let gateway: ModelGateway
  let runtime: DshAcpRuntimeAdapter
  let orchestration: RunOrchestrationService
  let mcp: PostgresMcpConnectorService
  let runs: PostgresRunRepository
  let agents: PostgresAgentService
  let agentMembers: PostgresWorkspaceAgentMemberService
  let enabledServer: string
  let plainServer: string
  let scope: AgentMcpScope
  let personalWorkspace: string
  let projectWorkspace: string
  let automations: AutomationService
  let routines: AgentRoutineService

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ea-p1-'))
    enabledApp = await startFakeExternalApp(enabledToken)
    plainApp = await startFakeExternalApp(plainToken)
    modelUpstream = startFakeModel(modelRequests)
    await new Promise<void>(resolveListen => modelUpstream.listen(0, '127.0.0.1', resolveListen))
    const upstreamBase = `http://127.0.0.1:${(modelUpstream.address() as { port: number }).port}`
    gateway = new ModelGateway({
      dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)),
      log: new MemoryModelGatewayRequestLog(),
      credentials: { readSecret: async () => VENDOR_SECRET },
      fetch: (url, init) => fetch(url.replace(/^https?:\/\/[^/]+/, upstreamBase), init),
    })
    await gateway.start()

    disposable = await createThrowawayDatabase({ namePrefix: 'dsh_work_ea_p1', maxConnections: 8 })
    const database = disposable.client
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
      resolveMcpConnections: manifest => mcp.resolveRuntimeConnections(manifest),
      recordMcpInvocation: (manifest, invocation) => mcp.recordMcpInvocation(manifest, invocation),
      permissionDecision: async () => 'allow_once',
      collectArtifacts: (manifest, workspaceDirectory) => content.publishRuntimeArtifacts({ manifest, workspaceDirectory }),
      remoteExecution: containers,
    })
    const operations = new PostgresOperationsService(database, runtime, authorization, 'mock')
    const secrets = new PostgresEncryptedCredentialStore(database, { masterKeyBase64: randomBytes(32).toString('base64'), keyId: 'ea-p1-disposable' })
    mcp = new PostgresMcpConnectorService(database, runtime, operations, secrets)
    agents = new PostgresAgentService(database, operations, undefined, mcp)
    agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
    orchestration = new RunOrchestrationService(
      runs, conversations, new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
      runtime, content, operations, agents, undefined, authorization,
      { agentMembers, tasks: new PostgresTaskRepository(database), toolChecks: { assertPinnedConnections: pins => mcp.assertPinnedConnections(pins) } },
    )
    automations = new AutomationService(database, new PostgresAutomationRepository(database), conversations, runs, orchestration,
      authorization, agents, content, undefined, defaultAutomationConfig)
    routines = new AgentRoutineService(database, authorization, runs, orchestration, conversations)

    // 员工：手机号登录（带 +86 保存）并绑定钉钉；有自己的个人空间。
    await database`
      insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
      values (${employee}, ${tenantId}, ${`directory:${employee}`}, 'EA P1 员工', null, 'active', 'local', true)
    `
    await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${employee}, 'role-employee', 'local')`
    await database`
      insert into local_user_credentials (tenant_id, user_id, username, password_hash, must_change_password)
      values (${tenantId}, ${employee}, '+8613800138008', 'test-hash', false)
    `
    await database`
      insert into external_account_bindings (id, tenant_id, channel, user_id, external_user_id, bound_by, status)
      values (${`binding-ea-${nonce}`}, ${tenantId}, 'dingtalk', ${employee}, ${`ding-ea-${nonce}`}, 'self', 'valid')
    `
    // 个人空间随用户创建（每人一个）。
    const [personal] = await database<{ id: string }[]>`
      select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${employee}
    `
    assert.ok(personal, 'the personal workspace is created with the user')
    personalWorkspace = personal.id
    // 项目空间：员工是成员。
    projectWorkspace = `ws-ea-project-${nonce}`
    await database`
      insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
      values (${projectWorkspace}, ${tenantId}, 'EA P1 项目空间', '', 'team', ${employee}, 'active')
    `
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${projectWorkspace}, ${employee}, 'owner', ${employee})
    `

    // 两个外部应用各用独立凭据：一个开启“发送员工身份”，一个不开启。
    const enabled = await mcp.registerMcpConnector({
      name: `EA 应收 ${nonce}`, endpoint: enabledApp.url, authType: 'bearer', bearerToken: enabledToken,
      scopeDescription: '一次性假外部应用', actor: 'U00008',
    })
    const plain = await mcp.registerMcpConnector({
      name: `EA 未开启 ${nonce}`, endpoint: plainApp.url, authType: 'bearer', bearerToken: plainToken,
      scopeDescription: '一次性假外部应用（未开启发送员工身份）', actor: 'U00008',
    })
    assert.equal(enabled.status, 'healthy')
    assert.equal(plain.status, 'healthy')
    await mcp.setMcpEmployeeIdentity({ connectorId: enabled.id, enabled: true, actor: 'U00008' })
    enabledServer = enabled.mcp!.serverName
    plainServer = plain.mcp!.serverName
    scope = { mode: 'selected', connectorIds: [enabled.id, plain.id] }
  })

  after(async () => {
    await orchestration?.close().catch(() => undefined)
    await runtime?.close().catch(() => undefined)
    execution?.containers.close()
    await gateway?.stop().catch(() => undefined)
    if (modelUpstream) await new Promise<void>(resolveClose => modelUpstream.close(() => resolveClose()))
    await enabledApp?.close()
    await plainApp?.close()
    await disposable?.dispose()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  async function publishedAgent(suffix: string, visibleRoleIds = ['role-employee']) {
    const id = `agent-ea-${suffix}-${nonce}`
    const created = await agents.createAgent({
      id, name: `EA P1 ${suffix}`, description: '一次性核对外部应用调用上下文。', owner: employee, department: '验收',
      visibleRoleIds, executionRoleIds: ['role-employee'], executionDataScopes: ['workspace:authorized'],
      welcomeMessage: '', examplePrompts: ['查一下我的应收'],
      systemPrompt: '你是一次性验收助手。按用户要求调用应收工具并简短回答。', workInstructions: '', skills: [], mcpScope: scope,
      maxOutputBytes: 65536, maxToolCalls: 12, timeoutSeconds: 180, changeSummary: 'EA P1', actor: 'U00008',
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

  async function waitForRun(runId: string) {
    const deadline = Date.now() + 240_000
    let status = ''
    while (Date.now() < deadline) {
      status = (await runs.getRun(tenantId, runId))?.status ?? ''
      if (['succeeded', 'failed', 'cancelled'].includes(status)) break
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
    const [attempt] = await disposable.client<{ id: string; manifest: unknown; errorCode: string | null }[]>`
      select id, manifest, error_code as "errorCode" from run_attempts where tenant_id = ${tenantId} and run_id = ${runId} order by attempt_no desc limit 1
    `
    return { status, attemptId: attempt?.id ?? '', manifest: attempt?.manifest, errorCode: attempt?.errorCode ?? null }
  }

  /**
   * 请求头只经环境变量注入：员工标识与凭据不出现在持久化的 Manifest 中。
   * （成功的 Attempt 结束后工作区即被删除，DSH 侧注入内容由 dsh-attempt-patch 的单元测试覆盖。）
   */
  function assertNotPersisted(manifest: unknown) {
    const serialized = JSON.stringify(manifest)
    for (const value of ['13800138008', `ding-ea-${nonce}`, enabledToken, plainToken]) {
      assert.ok(!serialized.includes(value), `Manifest must not contain ${value.slice(0, 6)}…`)
    }
  }

  async function auditContext(runId: string, expectRows: boolean) {
    const deadline = Date.now() + 15_000
    for (;;) {
      const rows = await auditRows(runId)
      if (!expectRows || rows.length > 0 || Date.now() > deadline) return rows
      await new Promise(resolveWait => setTimeout(resolveWait, 200))
    }
  }

  async function auditRows(runId: string) {
    return disposable.client<{ serverName: string; callContext: string | null }[]>`
      select c.server_name as "serverName", a.call_context as "callContext"
        from mcp_invocation_audits a
        join mcp_connector_profiles c on c.tenant_id = a.tenant_id and c.connector_id = a.connector_id
       where a.tenant_id = ${tenantId} and a.run_id = ${runId}
    `
  }

  /**
   * 跑完一次运行后核对：开启开关的外部应用在线路上收到的请求头、未开启的外部应用什么都没收到、
   * 调用审计记录的可见类型、员工标识与凭据未落盘。expected 为 null 表示不应带任何调用上下文。
   */
  async function assertRunContext(
    runId: string,
    before: { enabled: number; plain: number; enabledRequests: number; plainRequests: number; model: number },
    expected: { visibility: 'personal' | 'shared'; agentId: string } | 'no-external-call',
  ) {
    const { status, attemptId, manifest, errorCode } = await waitForRun(runId)
    assert.equal(status, 'succeeded', `run ${runId} did not succeed: ${errorCode ?? 'no error code'}`)
    const enabledCalls = enabledApp.calls.slice(before.enabled).filter(call => call.tool === LIST_TOOL)
    const plainCalls = plainApp.calls.slice(before.plain).filter(call => call.tool === LIST_TOOL)
    if (expected === 'no-external-call') {
      // 发布验证仍装载选定的 MCP，但工具调用由 DSH 策略返回 trial_only、不执行（功能规则第 9 节）；
      // 列出工具等请求仍会到达外部应用，平台不为发布验证发送调用上下文（外部应用接入方案 5.1）。
      const seen = modelRequests.slice(before.model)
      assert.ok(seen.some(request => request.listTools.length === 2), 'the model was offered both external apps\' tools')
      assert.ok(seen.some(request => request.toolResults.some(text => text.includes('trial_only'))), 'DSH answered the calls with trial_only')
      assert.deepEqual([enabledCalls.length, plainCalls.length], [0, 0], 'no tool call reached an external app')
      const arrived = [...enabledApp.requests.slice(before.enabledRequests), ...plainApp.requests.slice(before.plainRequests)]
      assert.ok(arrived.every(headers => Object.keys(headers).length === 0), 'requests that did arrive (e.g. tools/list) carry no call context')
      assert.ok((await auditRows(runId)).every(row => row.callContext === null))
      assertNotPersisted(manifest)
      return { attemptId, headers: {} as Record<string, string> }
    }
    const audits = await auditContext(runId, true)
    assert.ok(plainCalls.length >= 1, 'the app without the switch was called in this run')
    assert.ok(plainCalls.every(call => Object.keys(call.headers).length === 0), 'the app without the switch never sees call context')
    assert.ok(audits.every(row => row.serverName !== plainServer || row.callContext === null))
    const mine = enabledCalls.filter(call => call.headers['x-dsh-work-attempt-id'] === attemptId)
    assert.ok(mine.length >= 1, 'the enabled external app received the tool call with this Attempt')
    const headers = mine[0]!.headers
    assert.equal(headers['x-dsh-work-visibility'], expected.visibility)
    assert.equal(headers['x-dsh-work-run-id'], runId)
    assert.equal(headers['x-dsh-work-agent-id'], expected.agentId)
    if (expected.visibility === 'shared') {
      assert.deepEqual(Object.keys(headers).filter(name => name.startsWith('x-dsh-work-viewer-')), [], 'shared carries no employee identity')
    }
    assert.ok(audits.some(row => row.serverName === enabledServer && row.callContext === expected.visibility))
    assertNotPersisted(manifest)
    return { attemptId, headers }
  }

  it('员工本人在个人空间的对话：personal，带本人标识；未开启的外部应用不带调用上下文', async () => {
    const agent = await publishedAgent('personal')
    const session = await orchestration.createSession({ userId: employee, workspaceId: personalWorkspace, title: 'EA P1 个人对话', agentVersionId: agent.version.id })
    const before = { enabled: enabledApp.calls.length, plain: plainApp.calls.length, enabledRequests: enabledApp.requests.length, plainRequests: plainApp.requests.length, model: modelRequests.length }
    const run = await orchestration.startRun({
      userId: employee, sessionId: session.id, prompt: '查一下我的应收。', idempotencyKey: `ea-personal-${nonce}`,
    })
    assert.ok(run)
    const { attemptId, headers } = await assertRunContext(run.id, before, { visibility: 'personal', agentId: agent.agent.id })
    assert.equal(headers['x-dsh-work-attempt-id'], attemptId)
    assert.equal(headers['x-dsh-work-viewer-user-id'], employee)
    assert.equal(headers['x-dsh-work-viewer-mobile'], '13800138008', 'mobile without +86')
    assert.equal(headers['x-dsh-work-viewer-dingtalk-userid'], `ding-ea-${nonce}`)
    assert.equal(headers['x-dsh-work-viewer-email'], undefined, 'no email when the login account is a mobile number')
  })

  it('项目空间的对话：shared，不带员工标识', async () => {
    const agent = await publishedAgent('project')
    const member = await agentMembers.addAgentMember(projectWorkspace, agent.agent.id, employee, ['role-employee'])
    const session = await orchestration.createSession({ userId: employee, workspaceId: projectWorkspace, title: 'EA P1 项目对话', agentVersionId: agent.version.id })
    const before = { enabled: enabledApp.calls.length, plain: plainApp.calls.length, enabledRequests: enabledApp.requests.length, plainRequests: plainApp.requests.length, model: modelRequests.length }
    const run = await orchestration.startRun({
      userId: employee, sessionId: session.id, prompt: '查一下项目的应收。', idempotencyKey: `ea-project-${nonce}`, workspaceAgentMemberId: member.id,
    })
    assert.ok(run)
    await assertRunContext(run.id, before, { visibility: 'shared', agentId: agent.agent.id })
  })

  it('个人空间的定时任务：personal，员工为任务所有人', async () => {
    const agent = await publishedAgent('routine-personal')
    const created = await automations.create(employee, {
      name: 'EA P1 个人定时', agentId: agent.agent.id, workspaceId: personalWorkspace,
      schedule: { kind: 'manual', timezone: 'Asia/Shanghai' }, inputTemplate: { prompt: '查一下我的应收。' },
    })
    await automations.enable(employee, created.id)
    const before = { enabled: enabledApp.calls.length, plain: plainApp.calls.length, enabledRequests: enabledApp.requests.length, plainRequests: plainApp.requests.length, model: modelRequests.length }
    const accepted = await automations.runNow(employee, created.id, `ea-automation-personal-${nonce}`)
    assert.equal(accepted.admissionStatus, 'accepted')
    const { headers } = await assertRunContext(accepted.runId!, before, { visibility: 'personal', agentId: agent.agent.id })
    assert.equal(headers['x-dsh-work-viewer-user-id'], employee)
    assert.equal(headers['x-dsh-work-viewer-mobile'], '13800138008')
  })

  it('结果归属空间为项目空间的定时任务：shared', async () => {
    const agent = await publishedAgent('routine-project')
    await agentMembers.addAgentMember(projectWorkspace, agent.agent.id, employee, ['role-employee'])
    const created = await automations.create(employee, {
      name: 'EA P1 项目定时', agentId: agent.agent.id, workspaceId: projectWorkspace,
      schedule: { kind: 'manual', timezone: 'Asia/Shanghai' }, inputTemplate: { prompt: '查一下项目的应收。' },
    })
    await automations.enable(employee, created.id)
    const before = { enabled: enabledApp.calls.length, plain: plainApp.calls.length, enabledRequests: enabledApp.requests.length, plainRequests: plainApp.requests.length, model: modelRequests.length }
    const accepted = await automations.runNow(employee, created.id, `ea-automation-project-${nonce}`)
    assert.equal(accepted.admissionStatus, 'accepted')
    await assertRunContext(accepted.runId!, before, { visibility: 'shared', agentId: agent.agent.id })
  })

  it('放在项目空间的 Agent 主动任务：personal，员工标识为接收人', async () => {
    const agent = await publishedAgent('proactive')
    await agentMembers.addAgentMember(projectWorkspace, agent.agent.id, employee, ['role-employee'])
    const routine = await routines.create('U00008', {
      agentId: agent.agent.id, agentVersionId: agent.version.id, workspaceId: projectWorkspace, recipientUserId: employee,
      name: 'EA P1 主动任务', schedule: { kind: 'manual', timezone: 'Asia/Shanghai' }, inputTemplate: { prompt: '查一下应收并提醒接收人。' },
    })
    await routines.enable('U00008', agent.agent.id, routine.id, {
      expectedRevision: routine.revision, roleIds: ['role-employee'], dataScopes: ['workspace:authorized'],
    })
    const before = { enabled: enabledApp.calls.length, plain: plainApp.calls.length, enabledRequests: enabledApp.requests.length, plainRequests: plainApp.requests.length, model: modelRequests.length }
    const accepted = await routines.runNow('U00008', agent.agent.id, routine.id, `ea-routine-${nonce}`)
    assert.equal(accepted.admissionStatus, 'accepted')
    const { headers } = await assertRunContext(accepted.runId!, before, { visibility: 'personal', agentId: agent.agent.id })
    assert.equal(headers['x-dsh-work-viewer-user-id'], employee)
    assert.equal(headers['x-dsh-work-viewer-mobile'], '13800138008')
  })

  it('发布验证：工具调用由 DSH 返回 trial_only、不到外部应用，到达的请求不带调用上下文', async () => {
    // 发布验证由有 Agent 管理权限的平台管理员发起（种子数据中的 U00008），与员工身份无关。
    const agent = await publishedAgent('trial', ['role-employee', 'role-platform-admin'])
    // 与 AgentValidationService 建验证会话的方式一致：管理受众、不绑定工作空间。
    const session = { id: `admin-session-ea-${nonce}` }
    await disposable.client`
      insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
      values (${session.id}, ${tenantId}, 'U00008', 'EA P1 发布验证', 'active', 'admin', null, null)
    `
    const before = { enabled: enabledApp.calls.length, plain: plainApp.calls.length, enabledRequests: enabledApp.requests.length, plainRequests: plainApp.requests.length, model: modelRequests.length }
    const { runId } = await orchestration.startReleaseTrialCase({
      userId: 'U00008', sessionId: session.id, agentVersionId: agent.version.id, message: '查一下应收。', idempotencyKey: `ea-trial-${nonce}`,
    })
    await assertRunContext(runId, before, 'no-external-call')
  })
})
