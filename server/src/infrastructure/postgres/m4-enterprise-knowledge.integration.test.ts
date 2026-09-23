import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresKnowledgeService } from '../../modules/knowledge/postgres-knowledge-service.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresWorkspaceAgentMemberService } from '../../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')
const knowledgeAgentId = 'agent-m4-knowledge'
const knowledgeAgentVersionId = 'agent-version-m4-knowledge-1'
const knowledgeAgentMemberId = 'm4-knowledge-agent-member'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let knowledge: PostgresKnowledgeService
let runtime: CapturingRuntime
let conversations: PostgresConversationRepository
let orchestration: RunOrchestrationService
let authorization: PostgresAuthorizationService

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_knowledge_test', maxConnections: 4 })
  database = throwaway.client
  knowledge = new PostgresKnowledgeService(database)
  authorization = new PostgresAuthorizationService(database)
  runtime = new CapturingRuntime()
  conversations = new PostgresConversationRepository(database)
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status
    ) values (
      ${knowledgeAgentId}, 'tenant-dsh-work', '供应链知识测试 Agent',
      '仅用于隔离数据库中的知识引用测试', '', 'U00008', 'U00008', 'published'
    )
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes,
      max_output_bytes, max_tool_calls, timeout_seconds, skill_refs, tool_refs,
      status, created_by, published_at
    ) values (
      ${knowledgeAgentVersionId}, 'tenant-dsh-work', ${knowledgeAgentId}, '1.0.0',
      '供应链知识测试 Agent', '隔离知识引用测试', '', '[]', '仅回答供应链知识问题。',
      '["role-employee"]', '["enterprise:authorized", "workspace:authorized", "domain:supply-chain"]',
      65536, 20, 300, '[]', '[]', 'published', 'U00008', now()
    )
  `
  await database`
    update agents set active_version_id = ${knowledgeAgentVersionId}
     where tenant_id = 'tenant-dsh-work' and id = ${knowledgeAgentId}
  `
  await database`
    insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
    values ('tenant-dsh-work', ${`principal-agent-${knowledgeAgentId}`}, 'role-employee')
  `
  await database`
    insert into agent_principal_scope_grants (tenant_id, principal_id, scope_value)
    values
      ('tenant-dsh-work', ${`principal-agent-${knowledgeAgentId}`}, 'enterprise:authorized'),
      ('tenant-dsh-work', ${`principal-agent-${knowledgeAgentId}`}, 'workspace:authorized'),
      ('tenant-dsh-work', ${`principal-agent-${knowledgeAgentId}`}, 'domain:supply-chain')
  `
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values ('tenant-dsh-work', 'ws-supply', 'agent', ${knowledgeAgentVersionId})
  `
  await database`
    insert into workspace_agent_members (
      id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by
    ) values (
      ${knowledgeAgentMemberId}, 'tenant-dsh-work', 'ws-supply',
      ${knowledgeAgentId}, ${knowledgeAgentVersionId}, 'available', 'U00001'
    )
  `
  orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database),
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    undefined,
    undefined,
    undefined,
    knowledge,
    authorization,
    { agentMembers: new PostgresWorkspaceAgentMemberService(database, authorization, new PostgresAgentService(database)) },
  )
})

after(async () => {
  await orchestration.close()
  await throwaway.dispose()
})

test('knowledge catalog filters role, workspace and effective Data Scope before Runtime injection', async () => {
  const enterpriseAccess = await authorization.authorizeWorkbench({ userId: 'U00001' })
  assert.equal(enterpriseAccess.dataScopes.includes('domain:supply-chain'), false)
  const enterprise = await knowledge.resolveContext({
    query: '供应链异常需要如何升级和闭环？',
    userId: 'U00001',
    workspaceId: null,
    dataScopes: enterpriseAccess.dataScopes,
  })
  assert.equal(enterprise.length, 0)

  const workspaceRestricted = await knowledge.resolveContext({
    query: '可用库存低于安全库存时如何处理？',
    userId: 'U00001',
    workspaceId: null,
    dataScopes: enterpriseAccess.dataScopes,
  })
  assert.ok(!workspaceRestricted.some(document => document.documentId === 'knowledge-inventory-policy-v21'))

  const supplyAccess = await authorization.authorizeWorkbench({ userId: 'U00001', workspaceId: 'ws-supply' })
  assert.equal(supplyAccess.dataScopes.includes('domain:supply-chain'), true)
  const supplyPolicy = await knowledge.resolveContext({
    query: '供应链异常需要如何升级和闭环？',
    userId: 'U00001',
    workspaceId: 'ws-supply',
    dataScopes: supplyAccess.dataScopes,
  })
  assert.deepEqual(supplyPolicy.map(document => document.documentId), ['knowledge-supply-exception-v32'])
  assert.equal(supplyPolicy[0]?.version, '3.2')
  assert.equal(supplyPolicy[0]?.synthetic, true)

  const workspaceAllowed = await knowledge.resolveContext({
    query: '可用库存低于安全库存时如何处理？',
    userId: 'U00001',
    workspaceId: 'ws-supply',
    dataScopes: supplyAccess.dataScopes,
  })
  assert.deepEqual(workspaceAllowed.map(document => document.documentId), ['knowledge-inventory-policy-v21'])

  const adminAccess = await authorization.authorizeWorkbench({ userId: 'U00008' })
  const unauthorized = await knowledge.resolveContext({
    query: '供应链异常如何升级？',
    userId: 'U00008',
    workspaceId: null,
    dataScopes: adminAccess.dataScopes,
  })
  assert.equal(unauthorized.length, 0)
})

test('knowledge answer persists immutable source version and exposes citation metadata', async () => {
  const session = await orchestration.createSession({
    userId: 'U00001',
    title: '知识查询自动化验证',
    workspaceId: 'ws-supply',
    agentVersionId: knowledgeAgentVersionId,
  })
  const run = await orchestration.startRun({
    userId: 'U00001',
    sessionId: session.id,
    prompt: '可用库存低于安全库存时如何处理？',
    idempotencyKey: randomUUID(),
    workspaceAgentMemberId: knowledgeAgentMemberId,
  })
  assert.ok(run)
  const task = await waitForTask(run.id)
  const manifest = runtime.manifest(run.id)
  assert.equal(manifest?.agent_version_id, knowledgeAgentVersionId)
  assert.ok(manifest?.data_scopes.includes('domain:supply-chain'))
  assert.equal(manifest?.knowledge_context[0]?.documentId, 'knowledge-inventory-policy-v21')
  assert.equal(manifest?.knowledge_context[0]?.version, '2.1')
  assert.match(manifest?.knowledge_context[0]?.excerpt ?? '', /安全库存/)

  assert.equal(task.result.sources[0]?.title, '库存安全水位管理规范')
  assert.equal(task.result.sources[0]?.version, '2.1')
  assert.equal(task.result.sources[0]?.dataScope, 'domain:supply-chain')
  assert.equal(task.result.sources[0]?.synthetic, true)
  assert.match(task.messages.at(-1)?.content ?? '', /参考来源/)
  assert.match(task.messages.at(-1)?.content ?? '', /库存安全水位管理规范 v2.1/)

  await assert.rejects(
    database`update knowledge_documents set content = '不得修改' where id = 'knowledge-inventory-policy-v21'`,
    /immutable/,
  )
})

async function waitForTask(runId: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, 'U00001')
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
  done: Promise<RuntimeExecutionSnapshot>
  resolveDone: (snapshot: RuntimeExecutionSnapshot) => void
}

class CapturingRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, Execution>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      status: 'queued',
      acceptedAt: now,
      startedAt: null,
      endedAt: null,
      manifestSha256: 'knowledge-test',
      attemptDirectory: '/tmp/knowledge-test',
      errorCode: null,
      errorMessage: null,
    }
    const execution = { manifest, events: [], listeners: new Set<RuntimeEventListener>(), snapshot, done, resolveDone }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '已进入知识查询队列')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '开始执行知识查询')
      this.emit(execution, 'assistant.completed', '根据当前授权制度，可用库存低于安全库存时应进入预警。【1】')
      execution.snapshot.status = 'completed'
      execution.snapshot.endedAt = new Date().toISOString()
      this.emit(execution, 'run.completed', '知识查询完成')
      execution.resolveDone(structuredClone(execution.snapshot))
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
  manifest(runId: string) { return this.executions.get(runId)?.manifest }

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
