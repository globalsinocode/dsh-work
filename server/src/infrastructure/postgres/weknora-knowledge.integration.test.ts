import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresKnowledgeConnection } from '../../modules/knowledge/knowledge-connection.ts'
import { minimumRelevanceScore, WeKnoraKnowledgeProvider } from '../../modules/knowledge/weknora-knowledge-provider.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { WeKnoraDouble } from '../../testing/weknora-double.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

// weknora-knowledge-plan 第 12 节 P1：一次性 PostgreSQL + 按 WeKnora v0.9.0 接口实现的测试 HTTP 服务。
const tenantId = 'tenant-dsh-work'
const ADMIN = 'U00008'
const EMPLOYEE = 'U00001'
const root = `dept-root-${tenantId}`

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let agents: PostgresAgentService
let conversations: PostgresConversationRepository
let provider: WeKnoraKnowledgeProvider
let orchestration: RunOrchestrationService
let runtime: CapturingRuntime
let agentVersionId: string
const double = new WeKnoraDouble()

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_weknora_knowledge_test', maxConnections: 4 })
  database = throwaway.client
  const baseUrl = await double.start()
  const operations = new PostgresOperationsService(database)
  agents = new PostgresAgentService(database, operations, new PostgresSkillService(database, operations))
  conversations = new PostgresConversationRepository(database)
  const connection = new PostgresKnowledgeConnection(database, { bootstrap: { baseUrl, apiKey: double.apiKey, embeddingModelId: 'embed-1', timeoutMs: 500 } })
  await connection.ensureBootstrap()
  provider = new WeKnoraKnowledgeProvider(database, connection)
  runtime = new CapturingRuntime()
  orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database), conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)), runtime,
    undefined, operations, agents, provider, new PostgresAuthorizationService(database),
  )
  agentVersionId = await publishedAgent(['role-employee'])

  // 部门树：根 → 供应链部 → 计划组；另有财务部。员工属于计划组。
  await database`
    insert into org_departments (id, tenant_id, parent_id, name, path) values
      ('dept-supply', ${tenantId}, ${root}, '供应链部', ${`/${root}/dept-supply/`}),
      ('dept-plan', ${tenantId}, 'dept-supply', '计划组', ${`/${root}/dept-supply/dept-plan/`}),
      ('dept-finance', ${tenantId}, ${root}, '财务部', ${`/${root}/dept-finance/`})
  `
  await database`
    insert into org_department_members (tenant_id, department_id, user_id, is_primary)
    values (${tenantId}, 'dept-plan', ${EMPLOYEE}, true)
  `
  await knowledgeBase('kb-supply', 'kb-ext-supply', '供应链制度库', 'dept-supply', true)
  await knowledgeBase('kb-supply-only', 'kb-ext-supply-only', '供应链部内部库', 'dept-supply', false)
  await knowledgeBase('kb-finance', 'kb-ext-finance', '财务制度库', 'dept-finance', true)
})

after(async () => {
  await orchestration.close()
  await double.stop()
  await throwaway.dispose()
})

beforeEach(() => {
  double.reset()
  double.documents = [
    { id: 'doc-safety', knowledgeBaseId: 'kb-ext-supply', title: '库存安全水位规范', fileName: '库存安全水位规范.pdf', updatedAt: '2026-08-01T09:30:00Z' },
    { id: 'doc-transfer', knowledgeBaseId: 'kb-ext-supply', title: '调拨操作规范', fileName: '调拨操作规范.docx', updatedAt: '2026-07-15T02:00:00Z' },
    { id: 'doc-finance', knowledgeBaseId: 'kb-ext-finance', title: '报销制度', fileName: '报销制度.pdf', updatedAt: '2026-06-01T00:00:00Z' },
  ]
  double.chunks = [
    { id: 'c1', knowledgeId: 'doc-safety', content: '可用库存低于安全库存时应进入预警。', score: 0.91 },
    { id: 'c2', knowledgeId: 'doc-safety', content: '安全库存按七天用量计算。', score: 0.85 },
    { id: 'c3', knowledgeId: 'doc-transfer', content: '跨仓调拨须提前一天申请。', score: 0.12 },
    { id: 'c4', knowledgeId: 'doc-finance', content: '差旅报销须在十个工作日内提交。', score: 0.95 },
  ]
})

async function knowledgeBase(id: string, externalId: string, name: string, department: string, includeDescendants: boolean) {
  await database`
    insert into external_knowledge_bases (id, tenant_id, connection_id, external_id, name, owner_department_id, embedding_model_id, created_by)
    values (${id}, ${tenantId}, ${provider.connectionId}, ${externalId}, ${name}, ${department}, 'embed-1', ${ADMIN})
  `
  await database`
    insert into external_knowledge_base_grants (id, tenant_id, knowledge_base_id, department_id, include_descendants, granted_by, granted_via)
    values (${`grant-${id}`}, ${tenantId}, ${id}, ${department}, ${includeDescendants}, ${ADMIN}, 'admin')
  `
}

async function publishedAgent(executionRoleIds: string[]) {
  const created = await agents.createAgent({
    id: `agent-knowledge-${randomUUID().slice(0, 8)}`,
    name: '制度问答', description: '依据企业知识库回答员工的制度问题。', owner: '平台治理', department: '平台治理',
    welcomeMessage: '', examplePrompts: ['安全库存怎么算？'], systemPrompt: '你是制度问答助手，只依据当前员工已授权的企业知识回答制度问题。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: [],
    changeSummary: '知识库测试', actor: ADMIN,
    executionRoleIds, executionDataScopes: ['workspace:authorized'],
  })
  await database`update agent_versions set status = 'published' where tenant_id = ${tenantId} and id = ${created.version.id}`
  await database`
    update agents set status = 'published', active_version_id = ${created.version.id}, draft_version_id = null,
                      visible_role_ids = '["role-employee"]'::jsonb
     where tenant_id = ${tenantId} and id = ${created.agent.id}
  `
  return created.version.id
}

async function session(selected: string[], versionId = agentVersionId) {
  const created = await orchestration.createSession({ userId: EMPLOYEE, title: '制度问答', agentVersionId: versionId })
  for (const id of selected) {
    await database`
      insert into session_knowledge_bases (tenant_id, session_id, knowledge_base_id, added_by)
      values (${tenantId}, ${created.id}, ${id}, ${EMPLOYEE})
    `
  }
  return created.id
}

async function ask(sessionId: string, prompt: string) {
  const run = (await orchestration.startRun({ userId: EMPLOYEE, sessionId, prompt, idempotencyKey: randomUUID() }))!
  const task = await waitForTask(run.id)
  const [attempt] = await database<{ id: string; manifest: RuntimeManifest }[]>`
    select id, manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${run.id}
  `
  return { runId: run.id, attemptId: attempt!.id, manifest: attempt!.manifest, task, answer: task.messages.at(-1)?.content ?? '' }
}

const searches = () => double.requests.filter(request => request.path === '/api/v1/knowledge-search')

test('迁移给带 workbench:use 的角色加上查看权限，并删除原有知识表', async () => {
  const [role] = await database<{ permissions: string[] }[]>`select permissions from roles where tenant_id = ${tenantId} and id = 'role-employee'`
  assert.ok(role?.permissions.includes('knowledge:view'))
  const [tables] = await database<{ count: number }[]>`
    select count(*)::int as count from information_schema.tables
     where table_name in ('knowledge_documents', 'knowledge_sources', 'knowledge_chunks', 'run_knowledge_sources')
  `
  assert.equal(tables?.count, 0)
})

test('会话没有添加知识库时不调用 WeKnora，Manifest 标为 not_selected（WK4、WK18）', async () => {
  const result = await ask(await session([]), '安全库存怎么算？')
  assert.equal(result.manifest.knowledge_status, 'not_selected')
  assert.deepEqual(result.manifest.knowledge_context, [])
  assert.equal(searches().length, 0)
  assert.doesNotMatch(result.answer, /参考来源|不可用/)
})

test('只检索所选且可见的知识库，按部门授权与“包含下级”计算可见范围（5.3、5.7）', async () => {
  const sessionId = await session(['kb-supply', 'kb-supply-only', 'kb-finance'])
  const result = await ask(sessionId, '安全库存怎么算？')

  const [request] = searches()
  assert.deepEqual((request?.body as { knowledge_base_ids: string[] }).knowledge_base_ids, ['kb-ext-supply'])
  assert.equal(result.manifest.knowledge_status, 'ok')
  assert.deepEqual(result.manifest.knowledge_skipped_bases, ['供应链部内部库', '财务制度库'])
  // 低于最低相关度的分段不注入，每篇文档只留最相关的分段。
  assert.deepEqual(result.manifest.knowledge_context.map(document => document.documentId), ['weknora:doc-safety'])
  const [document] = result.manifest.knowledge_context
  assert.equal(document?.excerpt, '可用库存低于安全库存时应进入预警。')
  assert.equal(document?.version, '20260801.0930')
  assert.equal(document?.dataScope, 'knowledge:供应链制度库')

  assert.match(result.answer, /参考来源\n- 【1】库存安全水位规范（更新于 2026-08-01）/)
  assert.match(result.answer, /知识库“财务制度库”你已无权查看，本次未使用/)
  assert.deepEqual(result.task.result.sources.map(source => ({
    title: source.title, knowledgeBaseName: source.knowledgeBaseName, fileName: source.fileName, updatedAt: source.updatedAt,
  })), [{ title: '库存安全水位规范', knowledgeBaseName: '供应链制度库', fileName: '库存安全水位规范.pdf', updatedAt: '2026-08-01' }])
})

test('追问时查询词带上同一会话的上一条提问（WK4、4.3）', async () => {
  const sessionId = await session(['kb-supply'])
  await ask(sessionId, '库存相关的制度有哪些？')
  await ask(sessionId, '那第二条呢？')
  assert.equal((searches().at(-1)?.body as { query: string }).query, '库存相关的制度有哪些？\n那第二条呢？')
})

test('所选知识库全部不可见时跳过检索，状态为 skipped（5.7）', async () => {
  const result = await ask(await session(['kb-finance']), '报销期限？')
  assert.equal(result.manifest.knowledge_status, 'skipped')
  assert.equal(searches().length, 0)
  assert.match(result.answer, /财务制度库/)

  await database`update external_knowledge_bases set status = 'deleted' where tenant_id = ${tenantId} and id = 'kb-supply'`
  try {
    const deleted = await ask(await session(['kb-supply']), '安全库存？')
    assert.equal(deleted.manifest.knowledge_status, 'skipped')
    assert.equal(searches().length, 0)
  } finally {
    await database`update external_knowledge_bases set status = 'active' where tenant_id = ${tenantId} and id = 'kb-supply'`
  }
})

test('调岗后下一次执行的可见范围随之变化；没有部门时看不到任何知识库（5.5、WK7）', async () => {
  await database`update org_department_members set department_id = 'dept-finance' where tenant_id = ${tenantId} and user_id = ${EMPLOYEE}`
  try {
    const moved = await ask(await session(['kb-supply', 'kb-finance']), '报销期限？')
    assert.deepEqual((searches().at(-1)?.body as { knowledge_base_ids: string[] }).knowledge_base_ids, ['kb-ext-finance'])
    assert.deepEqual(moved.manifest.knowledge_skipped_bases, ['供应链制度库'])
    await database`delete from org_department_members where tenant_id = ${tenantId} and user_id = ${EMPLOYEE}`
    const none = await ask(await session(['kb-supply']), '安全库存？')
    assert.equal(none.manifest.knowledge_status, 'skipped')
  } finally {
    await database`
      insert into org_department_members (tenant_id, department_id, user_id, is_primary)
      values (${tenantId}, 'dept-plan', ${EMPLOYEE}, true)
      on conflict (tenant_id, department_id, user_id) do nothing
    `
    await database`delete from org_department_members where tenant_id = ${tenantId} and user_id = ${EMPLOYEE} and department_id <> 'dept-plan'`
  }
})

test('WeKnora 返回范围之外的分段时丢弃（4.4 第 4 步）', async () => {
  double.ignoreKnowledgeBaseScope = true
  const result = await ask(await session(['kb-supply']), '报销和库存？')
  assert.deepEqual(result.manifest.knowledge_context.map(document => document.documentId), ['weknora:doc-safety'])
})

test('超长分段按码点截断后不超过 4000 字（4.5）', async () => {
  double.chunks = [{ id: 'long', knowledgeId: 'doc-safety', content: `${'库'.repeat(3997)}😀😀`, score: 0.9 }]
  const result = await ask(await session(['kb-supply']), '库存？')
  const excerpt = result.manifest.knowledge_context[0]?.excerpt ?? ''
  assert.ok(excerpt.length <= 4000)
  // 第一个表情放得下，第二个会超出：整体截掉，不留下半个代理对。
  assert.equal(excerpt, `${'库'.repeat(3997)}😀…`)
})

test('最低相关度：恰好等于门槛的保留，低于门槛的丢弃（4.4 第 1 步）', async () => {
  double.documents.push(
    { id: 'doc-edge', knowledgeBaseId: 'kb-ext-supply', title: '门槛文档', fileName: 'edge.pdf', updatedAt: '2026-05-01T00:00:00Z' },
    { id: 'doc-below', knowledgeBaseId: 'kb-ext-supply', title: '低分文档', fileName: 'below.pdf', updatedAt: '2026-04-01T00:00:00Z' },
  )
  double.chunks = [
    { id: 'edge', knowledgeId: 'doc-edge', content: '门槛上的分段。', score: minimumRelevanceScore },
    { id: 'below', knowledgeId: 'doc-below', content: '门槛下的分段。', score: minimumRelevanceScore - 0.01 },
  ]
  const result = await ask(await session(['kb-supply']), '门槛？')
  assert.deepEqual(result.manifest.knowledge_context.map(document => document.documentId), ['weknora:doc-edge'])
})

test('单篇文档元数据缺失只丢弃该篇，由后面的候选补上（4.4）', async () => {
  double.documents.push(
    { id: 'doc-ghost', knowledgeBaseId: 'kb-ext-supply', title: '已删除的文档', fileName: 'ghost.pdf', updatedAt: '2026-08-01T00:00:00Z' },
    { id: 'doc-a', knowledgeBaseId: 'kb-ext-supply', title: '盘点规范', fileName: 'a.pdf', updatedAt: '2026-05-01T00:00:00Z' },
    { id: 'doc-b', knowledgeBaseId: 'kb-ext-supply', title: '收货规范', fileName: 'b.pdf', updatedAt: '2026-04-01T00:00:00Z' },
  )
  double.chunks.push(
    { id: 'g1', knowledgeId: 'doc-ghost', content: '这篇文档已被删除。', score: 0.99 },
    { id: 'a1', knowledgeId: 'doc-a', content: '每月盘点一次。', score: 0.7 },
    { id: 'b1', knowledgeId: 'doc-b', content: '收货当日入账。', score: 0.6 },
  )
  double.hiddenMetadataIds = ['doc-ghost']
  const result = await ask(await session(['kb-supply']), '仓库制度？')
  assert.equal(result.manifest.knowledge_status, 'ok')
  assert.deepEqual(result.manifest.knowledge_context.map(document => document.documentId),
    ['weknora:doc-safety', 'weknora:doc-a', 'weknora:doc-b'])
})

test('AI Hub 账号与停用的连接不检索，也不提示添加知识库（第 3 节、4.5）', async () => {
  const sessionId = await session(['kb-supply'])
  await database`update users set identity_provider = 'ai-hub' where tenant_id = ${tenantId} and id = ${EMPLOYEE}`
  try {
    const oidc = await ask(sessionId, '安全库存？')
    assert.equal(oidc.manifest.knowledge_status, undefined)
  } finally {
    await database`update users set identity_provider = 'local' where tenant_id = ${tenantId} and id = ${EMPLOYEE}`
  }
  await database`update external_knowledge_connections set status = 'disabled' where tenant_id = ${tenantId}`
  try {
    const disabled = await ask(sessionId, '安全库存？')
    assert.equal(disabled.manifest.knowledge_status, undefined)
  } finally {
    await database`update external_knowledge_connections set status = 'active' where tenant_id = ${tenantId}`
  }
  assert.equal(searches().length, 0)
  await assert.rejects(
    database`update external_knowledge_bases set name = '  ' where tenant_id = ${tenantId} and id = 'kb-supply'`,
    /check constraint/,
  )
})

test('WeKnora 不可用时执行继续，回答注明不可用并记录原因（WK2、第 7 节）', async () => {
  double.failWith = 503
  const result = await ask(await session(['kb-supply']), '安全库存？')
  assert.equal(result.manifest.knowledge_status, 'unavailable')
  assert.deepEqual(result.manifest.knowledge_context, [])
  assert.match(result.answer, /企业知识库暂不可用，本次回答未引用企业知识/)
  const [connection] = await database<{ reason: string | null }[]>`
    select last_failure_reason as reason from external_knowledge_connections where tenant_id = ${tenantId}
  `
  assert.equal(connection?.reason, 'server')
  const [audit] = await database<{ result: string }[]>`
    select result from audit_events
     where tenant_id = ${tenantId} and action = 'knowledge.retrieve.unavailable' and object_id = ${result.runId}
  `
  assert.equal(audit?.result, 'failed')

  double.failWith = null
  double.failBatchWith = 500
  const metadata = await ask(await session(['kb-supply']), '安全库存？')
  assert.equal(metadata.manifest.knowledge_status, 'unavailable')
})

test('Agent 岗位角色不具备查看级别时不检索，也不加知识说明（WK14）', async () => {
  await database`
    insert into roles (id, tenant_id, code, name, permissions)
    values ('role-no-knowledge', ${tenantId}, 'no_knowledge', '无知识权限', '["workbench:use"]')
  `
  const versionId = await publishedAgent(['role-no-knowledge'])
  const result = await ask(await session(['kb-supply'], versionId), '安全库存？')
  assert.equal(result.manifest.knowledge_status, undefined)
  assert.equal(searches().length, 0)
})

async function waitForTask(runId: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, EMPLOYEE)
    if (task?.status === 'succeeded') return task
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等待知识查询 Run 完成超时')
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
}

/** 立即完成的 Runtime 替身：回答经 RunEventRecorder 追加引用页脚后写入会话。 */
class CapturingRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, Execution>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued', acceptedAt: now,
      startedAt: null, endedAt: null, manifestSha256: 'knowledge-test', attemptDirectory: '/tmp/knowledge-test',
      errorCode: null, errorMessage: null,
    }
    const execution: Execution = { manifest, events: [], listeners: new Set(), snapshot }
    this.executions.set(manifest.run_id, execution)
    setTimeout(() => {
      snapshot.status = 'running'
      snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '开始执行')
      this.emit(execution, 'assistant.completed', '根据制度，可用库存低于安全库存时应进入预警。')
      snapshot.status = 'completed'
      snapshot.endedAt = new Date().toISOString()
      this.emit(execution, 'run.completed', '完成')
      resolveDone(structuredClone(snapshot))
    }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('Run not found')
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => execution.listeners.delete(listener)
  }

  async cancel() { return { accepted: false } }
  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() {
    return { status: 'healthy' as const, runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio' as const, message: 'test' }
  }
  async close() {}

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], displayMessage: string) {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: execution.manifest.run_id,
      attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      display_message: displayMessage,
      safe_metadata: {},
      trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => listener(event))
  }
}
