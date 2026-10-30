import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { AgentRecommendationService } from '../../modules/agent/agent-recommendation-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const ADMIN = 'U00008'
const EMPLOYEE = 'U00001'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let agents: PostgresAgentService
let operations: PostgresOperationsService
let authorization: PostgresAuthorizationService
let conversations: PostgresConversationRepository
let recommendations: AgentRecommendationService

// Attempt 创建时持久化的 Manifest 即装配结果；Runtime 不需要真正执行。
const runtime: AgentRuntimePort = {
  async execute(manifest) {
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: new Date().toISOString(), done: new Promise(() => undefined) }
  },
  subscribe: () => () => undefined,
  async cancel() { return { accepted: false } },
  status: () => undefined,
  async health() {
    return { status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio', message: 'test' }
  },
  async close() {},
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_recommendation_test', maxConnections: 3 })
  database = throwaway.client
  operations = new PostgresOperationsService(database)
  agents = new PostgresAgentService(database, operations, new PostgresSkillService(database, operations))
  authorization = new PostgresAuthorizationService(database)
  conversations = new PostgresConversationRepository(database)
  recommendations = new AgentRecommendationService(database, agents, authorization)
  conversations.setRecommendationReader(recommendations)
})

after(async () => {
  await throwaway.dispose()
})

function orchestration() {
  return new RunOrchestrationService(
    new PostgresRunRepository(database), conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)), runtime,
    undefined, operations, agents, undefined, undefined,
  )
}

/** 已发布、员工可见的 Agent；visibleRoleIds 为空时员工不可用。 */
async function publishedAgent(name: string, options: { recommend?: boolean; visibleRoleIds?: string[] } = {}) {
  const created = await agents.createAgent({
    id: `agent-rec-${randomUUID().slice(0, 8)}`,
    name, description: `${name}：负责一类专门工作。`, owner: '平台治理', department: '平台治理',
    welcomeMessage: '', examplePrompts: [`请${name}处理一件事`], systemPrompt: `你是${name}，只处理与本职相关、当前员工已经授权的工作。`,
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: [],
    dataScopes: ['workspace:authorized'],
    agentRecommendationEnabled: options.recommend === true,
    changeSummary: '推荐测试', actor: ADMIN,
    executionRoleIds: ['role-employee'], executionDataScopes: ['workspace:authorized'],
  })
  await database`update agent_versions set status = 'published' where tenant_id = ${tenantId} and id = ${created.version.id}`
  await database`
    update agents set status = 'published', active_version_id = ${created.version.id}, draft_version_id = null,
                      visible_role_ids = ${database.json(options.visibleRoleIds ?? ['role-employee'])}
     where tenant_id = ${tenantId} and id = ${created.agent.id}
  `
  return { agentId: created.agent.id, versionId: created.version.id }
}

async function runFor(agentVersionId: string, prompt = '这件事该找哪个 AI 同事？') {
  const service = orchestration()
  const session = await service.createSession({ userId: EMPLOYEE, title: '推荐测试', agentVersionId })
  const run = (await service.startRun({ userId: EMPLOYEE, sessionId: session.id, prompt, idempotencyKey: randomUUID() }))!
  const [attempt] = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${run.id}`
  assert.ok(attempt, '已创建 Attempt')
  return { runId: run.id, manifest: attempt.manifest }
}

test('迁移为 dsh-work 助手发布开启推荐的新版本', async () => {
  const [row] = await database<{ id: string; enabled: boolean }[]>`
    select av.id, av.agent_recommendation_enabled as enabled
      from agents a join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
     where a.tenant_id = ${tenantId} and a.id = 'agent-dsh-work-assistant'`
  assert.deepEqual(row, { id: 'agent-version-dsh-work-assistant-agent-recommendation-1', enabled: true })
})

test('只有开启开关的 Agent 在个人对话中装配推荐工具', async () => {
  const withSwitch = await publishedAgent('开关开启助手', { recommend: true })
  const without = await publishedAgent('开关关闭助手')
  const toolsOf = async (versionId: string) => (await runFor(versionId)).manifest.tools.map(tool => tool.id)
  const enabled = await toolsOf(withSwitch.versionId)
  assert.ok(enabled.includes('list_colleague_agents') && enabled.includes('recommend_agents'))
  const disabled = await toolsOf(without.versionId)
  assert.equal(disabled.some(id => id === 'list_colleague_agents' || id === 'recommend_agents'), false)
})

test('目录只列员工本人可用的同事，不含本 Agent；推荐逐项校验并在同一 Attempt 中替换', async () => {
  const source = await publishedAgent('推荐来源助手', { recommend: true })
  const usable = await publishedAgent('合同审查')
  const usable2 = await publishedAgent('交付分析')
  const hidden = await publishedAgent('财务内控', { visibleRoleIds: ['role-platform-admin'] })
  const { runId, manifest } = await runFor(source.versionId)

  const listed = await recommendations.listColleagues(manifest)
  const ids = listed.agents.map(agent => agent.agentId)
  assert.ok(ids.includes(usable.agentId) && ids.includes(usable2.agentId))
  assert.equal(ids.includes(hidden.agentId), false, '员工不可用的同事不出现')
  assert.equal(ids.includes(source.agentId), false, '不含本 Agent')
  assert.ok(listed.agents.find(agent => agent.agentId === usable.agentId)?.examplePrompts.length)

  const rejects = async (recommendationsInput: unknown, pattern: RegExp) =>
    assert.rejects(recommendations.recommend(manifest, { recommendations: recommendationsInput }), pattern)
  await rejects([{ agentId: hidden.agentId, reason: '负责财务' }], /不能推荐这位 AI 同事/)
  await rejects([{ agentId: source.agentId, reason: '我自己' }], /不能推荐这位 AI 同事/)
  await rejects([{ agentId: usable.agentId, reason: '审查合同' }, { agentId: usable.agentId, reason: '再推荐一次' }], /重复出现/)
  await rejects([{ agentId: usable.agentId, reason: '长'.repeat(121) }], /推荐理由/)
  await rejects([1, 2, 3, 4].map(() => ({ agentId: usable.agentId, reason: '多' })), /1～3 位/)

  const first = await recommendations.recommend(manifest, { recommendations: [{ agentId: usable.agentId, reason: '能逐条审查合同条款' }] })
  assert.deepEqual(first.recommended.map(item => item.agentId), [usable.agentId])
  await recommendations.recommend(manifest, { recommendations: [
    { agentId: usable2.agentId, reason: '能读取订单与到货数据' },
    { agentId: usable.agentId, reason: '能逐条审查合同条款' },
  ] })
  const views = await recommendations.loadForRuns([runId], EMPLOYEE)
  assert.deepEqual(views.map(view => [view.agentId, view.reason, view.available]), [
    [usable2.agentId, '能读取订单与到货数据', true],
    [usable.agentId, '能逐条审查合同条款', true],
  ])
  assert.equal(views[0]?.name, '交付分析')

  // 会话详情按 Run 挂推荐；同事被停用后标为不可用。
  const detail = await conversations.getTask(runId, EMPLOYEE)
  assert.equal(detail?.recommendations?.length, 2)
  await database`update agents set status = 'disabled' where tenant_id = ${tenantId} and id = ${usable2.agentId}`
  const after = await recommendations.loadForRuns([runId], EMPLOYEE)
  assert.equal(after.find(view => view.agentId === usable2.agentId)?.available, false)
  assert.equal(after.find(view => view.agentId === usable.agentId)?.available, true)
})

test('会话详情只展示当前 Attempt 的推荐：重试后旧 Attempt 的推荐不再出现', async () => {
  const source = await publishedAgent('重试来源助手', { recommend: true })
  const colleague = await publishedAgent('采购审核')
  const { runId, manifest } = await runFor(source.versionId)
  await recommendations.recommend(manifest, { recommendations: [{ agentId: colleague.agentId, reason: '负责采购审核' }] })
  assert.equal((await recommendations.loadForRuns([runId], EMPLOYEE)).length, 1)

  const retryAttemptId = `attempt-${randomUUID()}`
  await database`
    insert into run_attempts
    select * from jsonb_populate_record(null::run_attempts, (
      select to_jsonb(ra) || jsonb_build_object('id', ${retryAttemptId}::text, 'attempt_no', ra.attempt_no + 1, 'status', 'queued')
        from run_attempts ra where ra.tenant_id = ${tenantId} and ra.id = ${manifest.attempt_id}
    ))
  `
  await database`update runs set current_attempt_id = ${retryAttemptId} where tenant_id = ${tenantId} and id = ${runId}`
  assert.deepEqual(await recommendations.loadForRuns([runId], EMPLOYEE), [])
})
