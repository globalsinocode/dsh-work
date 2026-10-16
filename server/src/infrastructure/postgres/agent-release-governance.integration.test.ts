import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAgentAccessService } from '../../modules/agent/agent-access-service.ts'
import { PostgresAgentDataService } from '../../modules/agent-data/postgres-agent-data-service.ts'
import type { AgentSpec } from '../../modules/agent/agent-spec.ts'
import { parseAgentPackage } from '../../modules/agent/agent-package.ts'
import type { AgentMcpScope } from '../../domain/types.ts'
import { PostgresAgentReleaseService, type TrialRunStep } from '../../modules/agent/postgres-agent-release-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { assertCurrentExecutionAuthorization } from '../../modules/run/current-execution-authorization.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const ADMIN = 'user-release-admin'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let agents: PostgresAgentService
let release: PostgresAgentReleaseService
let orchestration: RunOrchestrationService
let trialRuntime: TrialStubRuntime
let tools: PostgresToolConnectorService
let access: PostgresAgentAccessService

/** S2: access (audience, roles, scopes) is Agent-level and changes immediately. */
async function setAccess(agentId: string, change: { visibleRoleIds?: string[]; roleIds?: string[]; dataScopes?: string[] }, actor = ADMIN) {
  const current = await access.getAccess(agentId)
  return access.updateAccess({
    agentId, actor, expectedRevision: current.revision,
    visibleRoleIds: change.visibleRoleIds ?? current.visibleRoleIds,
    roleIds: change.roleIds ?? current.roleIds,
    dataScopes: change.dataScopes ?? current.dataScopes,
  })
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_release_test', maxConnections: 8 })
  database = throwaway.client
  trialRuntime = new TrialStubRuntime()
  tools = new PostgresToolConnectorService(database, trialRuntime)
  const skills = new PostgresSkillService(database, undefined, tools)
  agents = new PostgresAgentService(database, undefined, skills, tools)
  orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database),
    new PostgresConversationRepository(database),
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    trialRuntime,
    undefined,
    undefined,
    agents,
    undefined,
    // 发布试运行目的在执行时复核平台管理权限，测试环境接真实授权服务
    new PostgresAuthorizationService(database),
    // B-03/I-04：试运行 Attempt 固定的绑定修订在执行前复核真实绑定服务。
    { toolBindings: tools },
  )
  release = new PostgresAgentReleaseService(database, agents, skills, tools, orchestration)
  access = new PostgresAgentAccessService(database, tools)
  await createAdminUser(ADMIN)
})

after(async () => {
  await orchestration.close()
  await throwaway.dispose()
})

async function createAdminUser(id: string) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
    values (${id}, ${tenantId}, ${`directory:${id}`}, '发布管理员', null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-platform-admin', 'local')
    on conflict do nothing
  `
}

async function createDraftAgent(id: string, skills = ['skill-document@1.0.0'], tools = ['read@1.0.0'],
  dataScopes = ['workspace:authorized'], mcpScope?: AgentMcpScope) {
  return agents.createAgent({
    id,
    name: '退款预测助手',
    description: '基于历史退款记录预测高风险订单并给出处理建议。',
    owner: '发布管理员',
    department: '平台治理',
    visibleRoleIds: ['role-employee'],
    executionRoleIds: ['role-employee'],
    executionDataScopes: dataScopes,
    welcomeMessage: '',
    examplePrompts: ['评估本周退款风险订单'],
    systemPrompt: '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。',
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills,
    tools,
    mcpScope,
    changeSummary: '创建初始草稿版本',
    actor: ADMIN,
  })
}

const PROMPT = '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。'

/** 按生产发布流程逐项运行：前四项确认通过后，第五项停在待人工确认。 */
async function runCasesToReview(agentId: string) {
  const state = await release.getReleaseState(agentId)
  const candidate = state.candidate ?? (await release.ensureCandidate(agentId, ADMIN)).candidate!
  let current = await release.startTrial(agentId, ADMIN, candidate.cases[0]!.id)
  for (let index = 0; index < candidate.cases.length - 1; index++) {
    if (current.trialRuns[0]?.status !== 'asserting') return current
    const testCase = candidate.cases[index]!
    current = await release.confirmTrial(agentId, current.trialRuns[0]!.id, [{ caseId: testCase.id, verdict: 'passed' }], ADMIN)
    const next = candidate.cases[index + 1]!
    current = await release.continueTrialCase(agentId, current.trialRuns[0]!.id, {
      caseId: next.id, input: next.input, rubric: next.manualReview.rubric,
    }, ADMIN)
  }
  return current
}

/** 当前待确认案例逐项登记结论。 */
async function confirmLatestTrial(agentId: string, verdict: 'passed' | 'failed' = 'passed') {
  const state = await release.getReleaseState(agentId)
  const trial = state.trialRuns[0]
  assert.equal(trial?.status, 'asserting', '试运行应停在待逐项确认状态')
  const caseRuns = trial.steps.flatMap(step => step.caseRuns ?? []).filter(run => !run.verdict)
  assert.ok(caseRuns.length > 0, '试运行缺少案例执行记录')
  return release.confirmTrial(agentId, trial.id, caseRuns.map(run => ({
    caseId: run.caseId, verdict, ...(verdict === 'failed' ? { note: '回答未说明缺失信息' } : {}),
  })), ADMIN)
}

// ---------------------------------------------------------------------------
// 配置创建主线：候选懒建 → 检查 → 封存试运行 → 逐项确认 → 审核发布 → 版本证据
// ---------------------------------------------------------------------------

test('配置创建的草稿走完检查、试运行与发布，版本证据落库', async () => {
  const agentId = 'agent-release-config'
  await createDraftAgent(agentId)

  // GET 只读：不创建候选
  const initial = await release.getReleaseState(agentId)
  assert.equal(initial.candidate, undefined)

  const state = await release.ensureCandidate(agentId, ADMIN)
  assert.ok(state.candidate)
  assert.equal(state.candidate.revision, 1)
  assert.equal(state.candidate.status, 'draft')
  assert.equal(state.candidate.cases.length, 5)
  assert.deepEqual(
    state.candidate.cases.map(item => item.kind).sort(),
    ['capability_failure', 'invalid_input', 'permission_denied', 'prompt_injection', 'success'],
  )

  const checked = await release.runChecks(agentId, ADMIN)
  assert.ok(checked.candidate?.checks.length)
  assert.ok(checked.candidate.checks.every(item => item.status === 'passed'), checked.candidate.checks.map(item => item.detail).join(' | '))

  const trialed = await runCasesToReview(agentId)
  // 执行完毕停在 asserting：发布门禁不接受未经逐项确认的试运行
  assert.equal(trialed.trialRuns[0]?.status, 'asserting')
  assert.equal(trialed.trialRuns[0]?.submissionRevision, 1)
  assert.equal(trialed.candidate?.sealedRevision, 1)
  // 试运行必须经 Run/Attempt → Runtime Adapter → DSH 真实执行：每个案例留有 runId/attemptId
  const dshStep = trialed.trialRuns[0]?.steps.find(step => step.id === 'dsh')
  assert.equal(dshStep?.caseRuns?.length, 5)
  assert.ok(dshStep?.caseRuns?.every(item => item.runId && item.attemptId && item.status === 'succeeded'))
  assert.ok(dshStep?.caseRuns?.every(item => item.automatedAssertions.every(assertion => assertion.passed)))
  const finalCase = state.candidate!.cases.at(-1)!
  assert.equal(trialed.trialRuns[0]?.progress?.caseId, finalCase.id)
  assert.equal(trialed.trialRuns[0]?.progress?.runId, dshStep?.caseRuns?.at(-1)?.runId)
  assert.equal(trialed.trialRuns[0]?.progress?.runStatus, 'succeeded')
  assert.ok(trialed.trialRuns[0]?.progress?.events.some(event => event.type === 'run.started'))
  assert.ok(trialed.trialRuns[0]?.progress?.events.some(event => event.type === 'run.completed'))
  assert.ok(trialed.trialRuns[0]?.progress?.events.every(event => !event.label.includes('试运行回答：')),
    '运行过程只返回受控状态，不泄露原始回答或 Runtime 日志')
  const trialRunsInDb = await database<{ count: number }[]>`
    select count(*)::integer as count from runs
     where tenant_id = ${tenantId} and session_id in (
       select id from sessions where tenant_id = ${tenantId} and title like '发布试运行%'
     )
  `
  assert.equal(trialRunsInDb[0]?.count, 5)

  // 未逐项确认：不能发布
  await assert.rejects(release.publish(agentId, '', ADMIN), /需要一次.*通过试运行/)

  const confirmed = await confirmLatestTrial(agentId)
  assert.equal(confirmed.trialRuns[0]?.status, 'passed')
  assert.ok(confirmed.trialRuns[0]?.steps.flatMap(step => step.caseRuns ?? []).every(item => item.verdict === 'passed'))

  // 直接审核发布仍要复核当前检查；试运行历史通过不能覆盖检查退化。
  const checks = checked.candidate!.checks
  await database`
    update agent_release_submissions
       set checks = ${database.json([{ ...checks[0], status: 'failed' }, ...checks.slice(1)])}
     where tenant_id = ${tenantId} and id = ${confirmed.candidate!.id}
  `
  await assert.rejects(release.publish(agentId, '', ADMIN), /候选检查未全部通过/)
  assert.equal((await agents.getAgents()).find(item => item.id === agentId)?.status, 'draft')
  await database`
    update agent_release_submissions set checks = ${database.json(checks.map(check => ({ ...check })))}
     where tenant_id = ${tenantId} and id = ${confirmed.candidate!.id}
  `

  // 新流程：试运行通过后一次审核确认即发布，无需中间 submitted 状态。
  const published = await release.publish(agentId, '业务效果已确认', ADMIN)
  // 发布后候选进入终态，证据随版本落库：
  // 1 条配置检查 + 1 条绑定修订固定 + 每案例 1 条 runtime_verified（真实 runId）+ 1 条业务确认 = 8 条。
  assert.equal(published.candidate, undefined)
  assert.equal(published.evidence['0.1.0']?.length, 8)
  const runtimeEvidence = published.evidence['0.1.0']?.filter(item => item.kind === 'runtime_verified') ?? []
  assert.equal(runtimeEvidence.length, 5)
  assert.ok(runtimeEvidence.every(item => item.runId?.startsWith('run-')))
  assert.ok(published.evidence['0.1.0']?.some(item => item.kind === 'business_accepted'))
  // B-03/I-04：发布版本携带真实封存绑定依据（tool-binding-* 修订 + 摘要），非占位文本。
  const bindingEvidence = published.evidence['0.1.0']?.find(item => item.summary.includes('平台绑定修订固定'))
  assert.ok(bindingEvidence, '发布证据缺少绑定修订固定项')
  assert.match(bindingEvidence.summary, /read@1\.0\.0 rev\d+（摘要 [a-f0-9]{12}）/)

  const agentRows = await agents.getAgents()
  const agent = agentRows.find(item => item.id === agentId)
  assert.equal(agent?.status, 'published')

  const after = await release.getReleaseState(agentId)
  assert.equal(after.candidate, undefined)
  assert.equal(after.evidence['0.1.0']?.length, 8)

  const records = await agents.getReleaseRecords()
  assert.ok(records.some(item => item.agentId === agentId && item.action === 'published'))
})

test('运行中的单项案例可读取已持久化检查进度与自身 Run 事件', async () => {
  const agentId = 'agent-release-live-progress'
  await createDraftAgent(agentId)
  const candidate = (await release.ensureCandidate(agentId, ADMIN)).candidate!
  const firstCase = candidate.cases[0]!
  trialRuntime.pauseOnMessage = firstCase.input
  const paused = trialRuntime.waitUntilPaused()
  try {
    const running = release.startTrial(agentId, ADMIN, firstCase.id)
    await paused
    const state = await release.getReleaseState(agentId)
    const trial = state.trialRuns[0]!
    assert.equal(trial.status, 'executing')
    assert.deepEqual(trial.steps.slice(0, 3).map(step => step.status), ['passed', 'passed', 'passed'])
    assert.equal(trial.steps.find(step => step.id === 'dsh')?.status, 'running')
    assert.equal(trial.progress?.caseId, firstCase.id)
    assert.ok(trial.progress?.runId?.startsWith('run-'))
    assert.equal(trial.progress?.runStatus, 'running')
    assert.ok(trial.progress.events.some(event => event.type === 'run.started'))
    trialRuntime.resumePaused()
    assert.equal((await running).trialRuns[0]?.status, 'asserting')
  } finally {
    trialRuntime.pauseOnMessage = ''
    trialRuntime.resumePaused()
  }
})

test('五类案例逐项运行与确认，不能跳项，后续案例编辑保留已通过证据', async () => {
  const agentId = 'agent-release-progressive'
  await createDraftAgent(agentId)
  const prepared = await release.ensureCandidate(agentId, ADMIN)
  const cases = prepared.candidate!.cases
  const first = await release.startTrial(agentId, ADMIN, cases[0]!.id)
  const trialId = first.trialRuns[0]!.id
  const revision = first.candidate!.revision
  assert.equal(first.trialRuns[0]!.status, 'asserting')
  assert.equal(first.trialRuns[0]!.steps.flatMap(step => step.caseRuns ?? []).length, 1)
  await assert.rejects(release.startTrial(agentId, ADMIN, cases[0]!.id), /仍在进行/)
  await assert.rejects(release.publish(agentId, '', ADMIN), /通过试运行/)
  await assert.rejects(release.continueTrialCase(agentId, trialId, {
    caseId: cases[1]!.id, input: cases[1]!.input, rubric: cases[1]!.manualReview.rubric,
  }, ADMIN), /先确认上一项/)
  await release.confirmTrial(agentId, trialId, [{ caseId: cases[0]!.id, verdict: 'passed' }], ADMIN)
  await assert.rejects(release.continueTrialCase(agentId, trialId, {
    caseId: cases[2]!.id, input: cases[2]!.input, rubric: cases[2]!.manualReview.rubric,
  }, ADMIN), /只能按顺序/)

  for (let index = 1; index < cases.length; index++) {
    const testCase = cases[index]!
    const input = index === 1 ? '缺少订单编号的退款风险评估请求' : testCase.input
    const rubric = index === 1 ? '先索取订单编号，不编造退款风险结论' : testCase.manualReview.rubric
    const executed = await release.continueTrialCase(agentId, trialId, {
      caseId: testCase.id, input, rubric,
    }, ADMIN)
    const runs = executed.trialRuns[0]!.steps.flatMap(step => step.caseRuns ?? [])
    assert.equal(executed.candidate!.revision, revision)
    assert.equal(executed.candidate!.cases[index]!.input, input)
    assert.equal(runs.length, index + 1)
    assert.equal(runs[index]!.caseId, testCase.id)
    assert.ok(runs.slice(0, index).every(run => run.verdict === 'passed'))
    assert.equal(executed.trialRuns[0]!.status, 'asserting')
    const confirmed = await release.confirmTrial(agentId, trialId, [{ caseId: testCase.id, verdict: 'passed' }], ADMIN)
    assert.equal(confirmed.trialRuns[0]!.status, index === cases.length - 1 ? 'passed' : 'asserting')
  }
  const published = await release.publish(agentId, '五项逐项验证通过', ADMIN)
  assert.equal(published.candidate, undefined)
  assert.equal(published.evidence['0.1.0']?.filter(item => item.kind === 'runtime_verified').length, 5)
})

test('草稿定义在两项之间变化时拒绝继续，旧案例证据不能混入新定义', async () => {
  const agentId = 'agent-release-definition-drift'
  const created = await createDraftAgent(agentId)
  const prepared = await release.ensureCandidate(agentId, ADMIN)
  const cases = prepared.candidate!.cases
  const first = await release.startTrial(agentId, ADMIN, cases[0]!.id)
  const trialId = first.trialRuns[0]!.id
  await release.confirmTrial(agentId, trialId, [{ caseId: cases[0]!.id, verdict: 'passed' }], ADMIN)
  const [sealed] = await database<{ fingerprint: string }[]>`
    select bound_fingerprint as fingerprint from agent_release_submissions
     where tenant_id = ${tenantId} and id = ${prepared.candidate!.id}
  `

  await agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN,
    systemPrompt: `${created.agent.systemPrompt}\n临时修改分析规则。`,
    changeSummary: '修改后续案例的执行定义',
  })
  await assert.rejects(
    agents.getRuntimeSnapshot(created.version.id, [], sealed!.fingerprint),
    /草稿定义已偏离封存内容/,
    'Attempt 准备时也必须拒绝封存后变化的草稿',
  )
  await assert.rejects(
    tools.resolveMcpConnectionsForAgentVersion(created.version.id, { mode: 'all', connectorIds: [] }),
    /MCP 使用范围已偏离/,
    'MCP 范围在 Runtime 快照读取后变化也不能混入本次试运行',
  )
  const next = { caseId: cases[1]!.id, input: cases[1]!.input, rubric: cases[1]!.manualReview.rubric }
  await assert.rejects(release.continueTrialCase(agentId, trialId, next, ADMIN), /定义与封存内容不一致/)
  const blocked = await release.getReleaseState(agentId)
  assert.equal(blocked.definitionChanged, true)
  assert.equal(blocked.trialRuns[0]!.steps.flatMap(step => step.caseRuns ?? []).length, 1)

  // 同步变更后的候选会推进修订并作废封存；即使随后恢复原文，也不能续用旧试运行。
  const revised = await release.ensureCandidate(agentId, ADMIN)
  assert.ok(revised.candidate!.revision > prepared.candidate!.revision)
  await agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN,
    changeSummary: '恢复原分析规则',
  })
  await assert.rejects(release.continueTrialCase(agentId, trialId, next, ADMIN), /封存修订已变化/)
})

test('试运行保存完整回答供人工审核，不能仅保留开头', async () => {
  const agentId = 'agent-release-full-output'
  await createDraftAgent(agentId)
  const state = await release.ensureCandidate(agentId, ADMIN)
  const marker = `结尾核验-${'甲'.repeat(270)}`
  await release.updateCases(agentId, state.candidate!.cases.map((item, index) => ({
    ...item,
    input: index === 0 ? `${item.input}\n${marker}` : item.input,
  })), ADMIN)
  await release.runChecks(agentId, ADMIN)
  const trial = await runCasesToReview(agentId)
  const caseRun = trial.trialRuns[0]?.steps.find(step => step.id === 'dsh')?.caseRuns?.[0]
  assert.equal(caseRun?.status, 'succeeded')
  assert.ok(caseRun?.outputExcerpt.length && caseRun.outputExcerpt.length > 240)
  assert.ok(caseRun.outputExcerpt.includes(marker))
})

test('数据声明发布前复核集合授权，且试运行证据固定数据定义', async () => {
  const agentId = 'agent-release-data'
  await createDraftAgent(agentId, [], [], ['enterprise:authorized'])
  const dataService = new PostgresAgentDataService(database)
  const collectionId = await dataService.publishCollection({ tenantId, key: 'release_data_records',
    schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    queryFields: ['code'], retentionDays: 30, actorUserId: ADMIN })
  const base = {
    agentId, name: '退款预测助手', description: '基于历史退款记录预测高风险订单并给出处理建议。',
    owner: '发布管理员', department: '平台治理', visibility: '指定角色', roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized'], welcomeMessage: '', examplePrompts: ['评估本周退款风险订单'],
    systemPrompt: '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: [], tools: [],
    changeSummary: '声明结构化数据需求', actor: ADMIN,
  }
  await agents.updateAgent({ ...base, data: { state: false,
    collections: [{ key: 'release_data_records', scope: 'tenant', schemaVersion: 1, actions: ['query'] }] } })
  await release.ensureCandidate(agentId, ADMIN)
  const blocked = await release.runChecks(agentId, ADMIN)
  assert.equal(blocked.candidate?.checks.find(item => item.id === 'data')?.status, 'failed')
  await assert.rejects(runCasesToReview(agentId), /试运行被阻塞/)
  await dataService.setGrant({ tenantId, collectionId, agentId, actions: ['query'], actorUserId: ADMIN })
  const checked = await release.runChecks(agentId, ADMIN)
  assert.equal(checked.candidate?.checks.find(item => item.id === 'data')?.status, 'passed')
  const trial = await runCasesToReview(agentId)
  const caseRun = trial.trialRuns[0]?.steps.flatMap(step => step.caseRuns ?? [])[0]
  assert.ok(caseRun?.runId)
  assert.ok(trialRuntime.manifest(caseRun.runId!)?.tools.some(tool => tool.id === 'data_query'),
    JSON.stringify(trialRuntime.manifest(caseRun.runId!)?.tools))
  await confirmLatestTrial(agentId)
  await dataService.setGrant({ tenantId, collectionId, agentId, actions: [], actorUserId: ADMIN })
  await assert.rejects(release.publish(agentId, '', ADMIN), /集合 release_data_records 未发布、版本不兼容或缺少当前授权/)
  await dataService.setGrant({ tenantId, collectionId, agentId, actions: ['query'], actorUserId: ADMIN })
  await agents.updateAgent({ ...base, data: { state: true,
    collections: [{ key: 'release_data_records', scope: 'tenant', schemaVersion: 1, actions: ['query'] }] } })
  assert.equal((await release.getReleaseState(agentId)).definitionChanged, true)
  await assert.rejects(release.publish(agentId, '', ADMIN), /发布前必须.*封存试运行/)
  await release.ensureCandidate(agentId, ADMIN)
  await release.runChecks(agentId, ADMIN)
  await runCasesToReview(agentId)
  await confirmLatestTrial(agentId)
  assert.equal((await release.publish(agentId, '集合授权已确认', ADMIN)).candidate, undefined)
})

test('试运行缩小 Agent 授权后拒绝不再获准的工具，不产生 Runtime Attempt', async () => {
  await tools.updateToolPermissions({
    toolId: 'grep', allowedRoles: ['role-employee'], dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none', actor: ADMIN,
  })
  try {
    const agentId = `agent-trial-narrow-${randomUUID().slice(0, 8)}`
    const created = await createDraftAgent(agentId, [], ['grep@1.0.0'],
      ['workspace:authorized', 'enterprise:authorized'])
    await release.ensureCandidate(agentId, ADMIN)
    const checked = await release.runChecks(agentId, ADMIN)
    assert.ok(checked.candidate?.checks.every(item => item.status === 'passed'))
    await setAccess(agentId, { roleIds: ['role-employee'], dataScopes: ['enterprise:authorized'] })
    await assert.rejects(assertCurrentExecutionAuthorization(new PostgresAuthorizationService(database), undefined, {
      purpose: 'agent-release-trial', agent_version_id: created.version.id, workspace_id: '',
      user_context: { user_id: ADMIN, tenant_id: tenantId, role_ids: ['role-employee'] },
      data_scopes: ['enterprise:authorized'], input: { message: 'test', file_mounts: [] },
    } as unknown as RuntimeManifest), /当前身份、固定能力或输入资源授权已撤销/)
    const firstCaseId = (await release.getReleaseState(agentId)).candidate!.cases[0]!.id
    await assert.rejects(release.startTrial(agentId, ADMIN, firstCaseId), /试运行被阻塞：执行器与 Runtime 兼容/)
    assert.equal((await release.getReleaseState(agentId)).trialRuns.length, 0)
    const attempts = await database<{ count: number }[]>`
      select count(*)::integer as count from run_attempts
       where tenant_id = ${tenantId} and manifest->>'agent_version_id' = ${created.version.id}
    `
    assert.equal(attempts[0]?.count, 0)
  } finally {
    await tools.updateToolPermissions({
      toolId: 'grep', allowedRoles: ['role-employee', 'role-platform-admin'],
      dataScopes: ['workspace:authorized'], approvalPolicy: 'none', actor: ADMIN,
    })
  }
})

test('Run 本地文件 Skill 不要求新 Agent 领取员工业务角色或平台数据范围', async () => {
  const agentId = `agent-run-local-${randomUUID().slice(0, 8)}`
  const created = await agents.createAgent({
    id: agentId, name: '当前工作区文档助手', description: '整理本次输入和当前工作区内的文件。',
    owner: '发布管理员', department: '平台治理', 
    visibleRoleIds: [], welcomeMessage: '', examplePrompts: ['整理这份材料'],
    systemPrompt: '只处理本次 Run 中已获授权的输入文件和当前工作区内容。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'], tools: [], changeSummary: '验证本地基础工具', actor: ADMIN,
  })
  const principal = await agents.getAgentPrincipal(agentId)
  assert.deepEqual(principal.roleIds, [])
  assert.deepEqual(principal.dataScopes, [])
  const [stored] = await database<{ tools: string[] }[]>`
    select tool_refs as tools from agent_versions
     where tenant_id = ${tenantId} and id = ${created.version.id}
  `
  assert.ok(stored?.tools.includes('read@1.0.0'))
  await release.ensureCandidate(agentId, ADMIN)
  await setAccess(agentId, { visibleRoleIds: ['role-employee'] })
  const checked = await release.runChecks(agentId, ADMIN)
  assert.ok(checked.candidate?.checks.every(item => item.status === 'passed'),
    JSON.stringify(checked.candidate?.checks))
  const started = await release.startTrial(agentId, ADMIN, checked.candidate!.cases[0]!.id)
  const first = started.trialRuns[0]?.steps.flatMap(step => step.caseRuns ?? [])[0]
  assert.ok(first?.runId)
  const manifest = trialRuntime.manifest(first.runId!)
  assert.deepEqual(manifest?.user_context.role_ids, [])
  assert.deepEqual(manifest?.data_scopes, [])
  assert.ok(manifest?.tools.some(tool => tool.id === 'read'))
  assert.ok(!manifest?.tools.some(tool => tool.id === 'glob' || tool.id === 'grep'))
  // F-02：试运行与员工执行使用同一权限策略（审批模式、工作区写入），外部效果由 purpose 隔离。
  const snapshot = await agents.getRuntimeSnapshot(manifest!.agent_version_id!)
  assert.equal(manifest?.purpose, 'agent-release-trial')
  assert.equal(manifest?.permission_policy.approval_mode, snapshot.approvalMode)
  assert.equal(manifest?.permission_policy.write_policy, 'workspace_only')
  // 测试环境未配置 Runtime 策略上限：试运行超时即 Agent 自身超时（不再是固定 150 秒等待）。
  assert.equal(manifest?.limits.timeout_seconds, snapshot.timeoutSeconds)
})

test('无 Skill/Tool 的 Soul Agent 可从界面配置创建并通过自动检查', async () => {
  const configuredId = 'agent-soul-config'
  const configured = await createDraftAgent(configuredId, [], [])
  const [configSpec] = await database<{ spec: AgentSpec }[]>`
    select agent_spec as spec from agent_versions
     where tenant_id = ${tenantId} and id = ${configured.version.id}
  `
  assert.ok(configSpec)
  assert.equal(configSpec.spec.apiVersion, 'dsh-work.ai/v2')
  assert.deepEqual(configSpec.spec.instructions, { path: 'SOUL.md', body: PROMPT })
  assert.deepEqual(configSpec.spec.capabilities, { skills: [], tools: [] })
  const exported = parseAgentPackage(await release.exportVersionPackage(configuredId, configured.version.id))
  assert.equal(exported.checksumsVerified, true)
  assert.deepEqual(exported.spec, configSpec.spec)
  await assert.rejects(release.exportVersionPackage('another-agent', configured.version.id), /不存在/)
  const draftSnapshot = await agents.getRuntimeSnapshot(configured.version.id)
  assert.ok(draftSnapshot.runtimeTools.includes('read@1.0.0'))
  assert.ok(draftSnapshot.runtimeTools.includes('write@1.0.0'))
  assert.ok(!draftSnapshot.runtimeTools.some(reference => reference.startsWith('bash@')))
  await release.ensureCandidate(configuredId, ADMIN)
  const exportedAfterGeneratedCases = parseAgentPackage(await release.exportVersionPackage(configuredId, configured.version.id))
  assert.deepEqual(exportedAfterGeneratedCases.spec, configSpec.spec)
  assert.deepEqual(exportedAfterGeneratedCases.cases, [])
  // 不预先调用 runChecks：试运行入口必须自动检查并封存。
  const started = await runCasesToReview(configuredId)
  assert.ok(started.candidate?.checks.every(item => item.status === 'passed'))
  const configTrial = await confirmLatestTrial(configuredId)
  assert.equal(configTrial.trialRuns[0]?.status, 'passed')
  const sealedDefaults = configTrial.candidate?.bindingRefs ?? []
  assert.ok(sealedDefaults.some(pin => pin.tool === 'read@1.0.0'))
  assert.ok(sealedDefaults.some(pin => pin.tool === 'write@1.0.0'))
  const firstRun = configTrial.trialRuns[0]?.steps.flatMap(step => step.caseRuns ?? []).find(run => run.runId)
  assert.deepEqual(trialRuntime.manifest(firstRun!.runId!)?.tool_bindings, sealedDefaults)


})

test('基础 Agent 无业务授权创建，发布前设置可见角色后以空业务权限完成试运行', async () => {
  const agentId = `agent-basic-${randomUUID().slice(0, 8)}`
  const created = await agents.createAgent({
    id: agentId, name: '文本整理助手', description: '只整理用户本次输入的文字并指出不确定信息。',
    owner: '发布管理员', department: '平台治理', 
    visibleRoleIds: [], welcomeMessage: '', examplePrompts: ['请整理这段文字'],
    systemPrompt: '你是独立的文本整理 AI 员工。只处理用户本次提供的文字，不读取企业业务数据。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: [], tools: [], changeSummary: '创建基础草稿', actor: ADMIN,
  })
  const identity = await agents.getAgentPrincipal(agentId)
  assert.equal(identity.status, 'active')
  assert.deepEqual(identity.roleIds, [])
  assert.deepEqual(identity.dataScopes, [])
  const pending = await release.ensureCandidate(agentId, ADMIN)
  const initial = await release.runChecks(agentId, ADMIN)
  assert.equal(initial.candidate?.checks.find(item => item.id === 'audience')?.status, 'failed')
  assert.equal(initial.candidate?.checks.find(item => item.id === 'principal')?.status, 'passed')
  await assert.rejects(release.startTrial(agentId, ADMIN, pending.candidate!.cases[0]!.id), /试运行被阻塞：员工可见范围/)
  await setAccess(agentId, { visibleRoleIds: ['role-employee'] })
  const configured = await release.getReleaseState(agentId)
  // F-09：可见角色不属于定义，设置后不推进修订；试运行前的自动检查重新评估可见范围。
  assert.equal(configured.candidate!.revision, pending.candidate!.revision)
  const trial = await runCasesToReview(agentId)
  const firstRun = trial.trialRuns[0]!.steps.flatMap(step => step.caseRuns ?? [])[0]!
  const manifest = trialRuntime.manifest(firstRun.runId!)
  assert.deepEqual(manifest?.user_context.role_ids, [])
  assert.deepEqual(manifest?.data_scopes, [])
  assert.equal(manifest?.mcp_connections, undefined)
  await confirmLatestTrial(agentId)
  assert.equal((await release.publish(agentId, '基础能力验收通过', ADMIN)).candidate, undefined)
  assert.equal(created.agent.id, agentId)
})

test('岗位权限属于 Agent：调整可见角色与数据授权都沿用已通过的试运行并立即生效', async () => {
  // S2：可见角色、岗位角色、数据范围都不属于版本，调整后不推进修订、不作废封存证据。
  const roleOnly = `agent-scope-role-${randomUUID().slice(0, 8)}`
  await createDraftAgent(roleOnly, [], [], [])
  await release.ensureCandidate(roleOnly, ADMIN)
  await runCasesToReview(roleOnly)
  const rolePassed = await confirmLatestTrial(roleOnly)
  await setAccess(roleOnly, { visibleRoleIds: ['role-employee', 'role-platform-admin'], dataScopes: ['workspace:authorized'] })
  const roleChanged = await release.getReleaseState(roleOnly)
  assert.equal(roleChanged.candidate!.revision, rolePassed.candidate!.revision)
  assert.equal(roleChanged.candidate!.sealedRevision, rolePassed.candidate!.sealedRevision)
  await release.publish(roleOnly, '可见范围扩大后发布', ADMIN)
  const [published] = await database<{ roleIds: string[] }[]>`
    select visible_role_ids as "roleIds" from agents where tenant_id = ${tenantId} and id = ${roleOnly}
  `
  assert.deepEqual([...published!.roleIds].sort(), ['role-employee', 'role-platform-admin'])
  // 发布后收回可见角色立即生效，不需要新版本。
  await setAccess(roleOnly, { visibleRoleIds: ['role-platform-admin'] })
  assert.equal((await agents.listWorkbenchAgents('U00001')).some(agent => agent.id === roleOnly), false)
})

test('发起试运行自动检查失效依赖，阻塞时不创建试运行或 Attempt', async () => {
  const agentId = `agent-auto-check-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, [], [])
  await release.ensureCandidate(agentId, ADMIN)
  await database`
    update agent_versions set skill_refs = ${database.json(['skill-unavailable@1.0.0'])}
     where tenant_id = ${tenantId} and id = ${created.version.id}
  `
  await assert.rejects(runCasesToReview(agentId), /试运行被阻塞/)
  const state = await release.getReleaseState(agentId)
  assert.ok(state.candidate?.checks.some(check => check.status === 'failed'))
  assert.equal(state.trialRuns.length, 0)
  const attempts = await database<{ count: number }[]>`
    select count(*)::integer as count from run_attempts
     where tenant_id = ${tenantId} and manifest->>'agent_version_id' = ${created.version.id}
  `
  assert.equal(attempts[0]?.count, 0)
})

test('配置创建自动装配 Skill 工具依赖，移除 Skill 后不保留隐式工具', async () => {
  const agentId = 'agent-skill-derived-tools'
  const created = await createDraftAgent(agentId, ['skill-document@1.0.0'], [])
  assert.deepEqual(created.agent.tools, [], '编辑契约只回显作者直接声明的工具')
  const [initial] = await database<{ tools: string[]; spec: AgentSpec }[]>`
    select tool_refs as tools, agent_spec as spec from agent_versions
     where tenant_id = ${tenantId} and id = ${created.version.id}
  `
  assert.deepEqual(initial?.spec.capabilities.tools, [])
  assert.deepEqual(initial?.tools, ['read@1.0.0'])
  await release.ensureCandidate(agentId, ADMIN)
  const checks = await release.runChecks(agentId, ADMIN)
  assert.ok(checks.candidate?.checks.every(item => item.status === 'passed'))

  await agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN, skills: [], tools: created.agent.tools,
    changeSummary: '移除文档 Skill',
  })
  const [updated] = await database<{ tools: string[]; spec: AgentSpec }[]>`
    select tool_refs as tools, agent_spec as spec from agent_versions
     where tenant_id = ${tenantId} and id = ${created.version.id}
  `
  assert.deepEqual(updated?.spec.capabilities.tools, [])
  assert.deepEqual(updated?.tools, [], '已移除 Skill 的隐式工具不能残留在 Agent 定义')

  const withExplicit = await createDraftAgent('agent-skill-explicit-tool', ['skill-document@1.0.0'], ['write@1.0.0'])
  assert.deepEqual(withExplicit.agent.tools, ['write@1.0.0'])
  const [combined] = await database<{ tools: string[] }[]>`
    select tool_refs as tools from agent_versions
     where tenant_id = ${tenantId} and id = ${withExplicit.version.id}
  `
  assert.deepEqual(combined?.tools, ['write@1.0.0', 'read@1.0.0'])
  await agents.updateAgent({
    ...withExplicit.agent, agentId: withExplicit.agent.id, actor: ADMIN,
    skills: [], tools: withExplicit.agent.tools, changeSummary: '移除 Skill，保留直接声明的工具',
  })
  const [withoutSkill] = await database<{ tools: string[] }[]>`
    select tool_refs as tools from agent_versions
     where tenant_id = ${tenantId} and id = ${withExplicit.version.id}
  `
  assert.deepEqual(withoutSkill?.tools, ['write@1.0.0'])
})

test('试运行 Attempt 实际按 Agent Version 的 MCP 范围装配连接器', async () => {
  const suffix = randomUUID().slice(0, 8)
  const first = await tools.registerMcpConnector({
    name: `试运行数据源甲 ${suffix}`, endpoint: `https://source-a-${suffix}.example.test/mcp`,
    authType: 'none', scopeDescription: '仅用于隔离试运行的合成数据', actor: ADMIN,
  })
  const second = await tools.registerMcpConnector({
    name: `试运行数据源乙 ${suffix}`, endpoint: `https://source-b-${suffix}.example.test/mcp`,
    authType: 'none', scopeDescription: '仅用于隔离试运行的合成数据', actor: ADMIN,
  })
  const scopes: Array<{ mode: 'all' | 'selected' | 'none'; scope: AgentMcpScope; expected: string[] }> = [
    { mode: 'all', scope: { mode: 'all', connectorIds: [] }, expected: [first.id, second.id] },
    { mode: 'selected', scope: { mode: 'selected', connectorIds: [first.id] }, expected: [first.id] },
    { mode: 'none', scope: { mode: 'none', connectorIds: [] }, expected: [] },
  ]
  const versionIds = new Map<string, string>()
  for (const { mode, scope, expected } of scopes) {
    const agentId = `agent-release-mcp-${mode}-${suffix}`
    const created = await createDraftAgent(agentId, [], [], ['workspace:authorized'], scope)
    versionIds.set(mode, created.version.id)
    await release.ensureCandidate(agentId, ADMIN)
    const checks = await release.runChecks(agentId, ADMIN)
    assert.ok(checks.candidate?.checks.every(item => item.status === 'passed'))
    await runCasesToReview(agentId)
    const result = await confirmLatestTrial(agentId)
    const run = result.trialRuns[0]!.steps.flatMap(step => step.caseRuns ?? []).find(item => item.runId)
    const manifest = trialRuntime.manifest(run!.runId!)!
    assert.deepEqual((manifest.mcp_connections ?? []).map(item => item.connector_id).sort(), expected.sort())
    assert.equal(manifest.permission_policy.network_policy, expected.length ? 'allowlist' : 'deny')
  }
  const third = await tools.registerMcpConnector({
    name: `试运行数据源丙 ${suffix}`, endpoint: `https://source-c-${suffix}.example.test/mcp`,
    authType: 'none', scopeDescription: '验证后续 Attempt 的动态全部范围', actor: ADMIN,
  })
  const allSnapshot = await agents.getRuntimeSnapshot(versionIds.get('all')!)
  assert.ok(allSnapshot.mcpConnections.some(item => item.connector_id === third.id))
  const selectedSnapshot = await agents.getRuntimeSnapshot(versionIds.get('selected')!)
  assert.deepEqual(selectedSnapshot.mcpConnections.map(item => item.connector_id), [first.id])
  await tools.setMcpConnectorStatus({ connectorId: first.id, status: 'disabled', actor: ADMIN })
  await assert.rejects(agents.getRuntimeSnapshot(versionIds.get('selected')!), /已选 MCP Connector 不可用或已变化/)
})

test('定义修改推进修订并作废检查与封存，发布要求最新封存试运行通过', async () => {
  const agentId = 'agent-release-revision'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)
  await release.runChecks(agentId, ADMIN)
  await runCasesToReview(agentId)
  const trialed = await confirmLatestTrial(agentId)
  assert.equal(trialed.trialRuns[0]?.status, 'passed')

  // 修改定义 → 修订推进、封存与检查作废。
  await agents.updateAgent({
    agentId,
    name: '退款预测助手',
    description: '基于历史退款记录预测高风险订单并给出处理建议（修订版）。',
    owner: '发布管理员',
    department: '平台治理',
    welcomeMessage: '',
    examplePrompts: ['评估本周退款风险订单'],
    systemPrompt: '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。',
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    tools: ['read@1.0.0'],
    changeSummary: '更新说明',
    workInstructions: '先核对来源与数据范围，再列出可追溯的判断依据；无法确认时明确交给人工复核。',
    actor: ADMIN,
  })
  // GET 只读：只标记漂移，不推进修订
  const stale = await release.getReleaseState(agentId)
  assert.equal(stale.candidate?.revision, 1)
  assert.equal(stale.definitionChanged, true)
  await assert.rejects(release.publish(agentId, '', ADMIN), /发布前必须.*封存试运行/)

  const refreshed = await release.ensureCandidate(agentId, ADMIN)
  assert.equal(refreshed.candidate?.revision, 2)
  assert.equal(refreshed.candidate?.checks.length, 0)
  assert.equal(refreshed.candidate?.sealedRevision, undefined)

  await assert.rejects(release.publish(agentId, '', ADMIN), /试运行对应的修订已被修改/)

  await release.runChecks(agentId, ADMIN)
  await runCasesToReview(agentId)
  const retrialed = await confirmLatestTrial(agentId)
  assert.equal(retrialed.trialRuns[0]?.status, 'passed')
  assert.equal(retrialed.trialRuns[0]?.submissionRevision, 2)
  const published = await release.publish(agentId, '', ADMIN)
  assert.equal(published.candidate, undefined)
  // F-06：未填写审核意见时不代填业务确认，证据只有配置检查 + 绑定修订 + 5 条案例 = 7 条。
  assert.equal(published.evidence['0.1.0']?.length, 7)
  assert.ok(!published.evidence['0.1.0']?.some(item => item.kind === 'business_accepted'))
  const publishedSnapshot = await agents.getRuntimeSnapshot((await agents.getAgentVersions())
    .find(version => version.agentId === agentId && version.version === '0.1.0')!.id)
  assert.match(publishedSnapshot.systemPrompt, /# AGENTS\.md · 工作规程/)
  assert.match(publishedSnapshot.systemPrompt, /先核对来源与数据范围/)
})

test('审核人判定任一案例不符合预期时试运行记为失败并阻塞发布', async () => {
  const agentId = 'agent-release-reject'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)
  await release.runChecks(agentId, ADMIN)
  const pending = await runCasesToReview(agentId)
  const pendingTrial = pending.trialRuns[0]!
  const pendingCase = pendingTrial.steps.flatMap(step => step.caseRuns ?? []).find(run => !run.verdict)!
  // 不通过必须附原因；缺失原因时结论不落库，试运行仍停在待确认。
  await assert.rejects(
    release.confirmTrial(agentId, pendingTrial.id, [{ caseId: pendingCase.caseId, verdict: 'failed', note: '  ' }], ADMIN),
    /必须填写原因/,
  )
  assert.equal((await release.getReleaseState(agentId)).trialRuns[0]?.status, 'asserting')

  const rejected = await confirmLatestTrial(agentId, 'failed')
  assert.equal(rejected.trialRuns[0]?.status, 'failed')
  assert.equal(rejected.trialRuns[0]?.failureStage, '案例终态断言')
  const rejectedRun = rejected.trialRuns[0]!.steps.flatMap(step => step.caseRuns ?? []).find(run => run.verdict === 'failed')
  assert.equal(rejectedRun?.verdictNote, '回答未说明缺失信息')
  assert.match(rejected.trialRuns[0]!.steps.find(step => step.id === 'assert')?.detail ?? '', /（回答未说明缺失信息）/)
  await assert.rejects(release.publish(agentId, '', ADMIN), /需要一次.*通过试运行/)
})

test('机器断言失败直接阻塞试运行，不能由人工判定覆盖', async () => {
  const agentId = 'agent-release-assertion-failed'
  await createDraftAgent(agentId)
  const state = await release.ensureCandidate(agentId, ADMIN)
  trialRuntime.failOnMessage = state.candidate!.cases[0]!.input
  try {
    await release.runChecks(agentId, ADMIN)
    const trialed = await runCasesToReview(agentId)
    const trial = trialed.trialRuns[0]!
    assert.equal(trial.status, 'failed')
    assert.equal(trial.failureStage, '案例终态断言')
    const failedRun = trial.steps.flatMap(step => step.caseRuns ?? []).find(run => run.status === 'failed')
    assert.ok(failedRun)
    assert.equal(failedRun.automatedAssertions.find(item => item.assertion === 'execution_succeeded')?.passed, false)
    await assert.rejects(
      release.confirmTrial(agentId, trial.id, [{ caseId: failedRun.caseId, verdict: 'passed' }], ADMIN),
      /不在待确认状态/,
    )
  } finally {
    trialRuntime.failOnMessage = ''
  }
})

test('升级前通过的三案例试运行不能作为 v1 发布证据', async () => {
  const agentId = 'agent-release-legacy-trial'
  await createDraftAgent(agentId)
  const state = await release.ensureCandidate(agentId, ADMIN)
  const candidate = state.candidate!
  const legacyCases = candidate.cases.slice(0, 3).map(item => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    input: item.input,
    expect: item.manualReview.rubric,
  }))
  const legacyRuns = legacyCases.map(item => ({
    caseId: item.id,
    name: item.name,
    kind: item.kind,
    expect: item.expect,
    runId: `legacy-run-${item.id}`,
    attemptId: `legacy-attempt-${item.id}`,
    status: 'succeeded',
    outputExcerpt: '旧版输出',
    verdict: 'passed',
  }))
  const legacySteps = [{ id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', caseRuns: legacyRuns }]
  await database`
    update agent_release_submissions
       set cases = ${database.json(legacyCases)}, sealed_revision = revision, sealed_at = now()
     where tenant_id = ${tenantId} and id = ${candidate.id}
  `
  const trialId = `trial-${randomUUID()}`
  await database`
    insert into agent_trial_runs (id, tenant_id, submission_id, agent_id, submission_revision, status, steps, created_by, finished_at)
    values (${trialId}, ${tenantId}, ${candidate.id}, ${agentId}, ${candidate.revision}, 'passed', ${database.json(legacySteps)}, ${ADMIN}, now())
  `

  await assert.rejects(release.publish(agentId, '', ADMIN), /旧版或无效试运行证据不能发布.*重新运行 v1 评测/)
  await database`
    update agent_release_submissions set status = 'submitted'
     where tenant_id = ${tenantId} and id = ${candidate.id}
  `
  await assert.rejects(release.publish(agentId, '', ADMIN), /旧版或无效试运行证据不能发布.*重新运行 v1 评测/)
  const stillDraft = await agents.getAgents()
  assert.equal(stillDraft.find(item => item.id === agentId)?.status, 'draft')
})

test('案例编辑的 origin 由服务端维护：未改写的生成案例保留标记，改写即清除，调用方不能伪造', async () => {
  const agentId = 'agent-release-origin'
  await createDraftAgent(agentId)
  const state = await release.ensureCandidate(agentId, ADMIN)
  const generated = state.candidate!.cases
  assert.ok(generated.length > 0)
  assert.ok(generated.every(item => item.origin === 'generated'))

  const updated = await release.updateCases(agentId, [
    // 调用方剥离 origin 原样回写：服务端按既有案例 id 恢复标记
    ...generated.map(item => ({
      id: item.id,
      evaluationApiVersion: item.evaluationApiVersion,
      name: item.name,
      kind: item.kind,
      input: item.input,
      automatedAssertions: item.automatedAssertions,
      manualReview: item.manualReview,
    })),
    // 调用方伪造 origin：服务端忽略
    {
      id: '',
      evaluationApiVersion: 'dsh-work.ai/evaluation/v1' as const,
      name: '伪造来源案例',
      kind: 'success' as const,
      input: '评估退款风险',
      automatedAssertions: ['run_attempt_recorded', 'execution_succeeded', 'output_non_empty'],
      manualReview: { required: true as const, rubric: '输出依据' },
      origin: 'generated' as const,
    },
  ], ADMIN)
  const kept = updated.candidate!.cases.filter(item => generated.some(g => g.id === item.id))
  assert.ok(kept.every(item => item.origin === 'generated'))
  const forged = updated.candidate!.cases.find(item => item.name === '伪造来源案例')
  assert.ok(forged)
  assert.equal(forged.origin, undefined)

  // F-08：改写生成案例的输入后清除 generated 标记，其余未改动案例保留；改回原文也不恢复标记。
  const strip = (item: typeof generated[number]) => ({
    id: item.id, evaluationApiVersion: item.evaluationApiVersion, name: item.name, kind: item.kind,
    input: item.input, automatedAssertions: item.automatedAssertions, manualReview: item.manualReview,
  })
  const target = generated.find(item => item.kind === 'success')!
  const rewritten = await release.updateCases(agentId, generated.map(item => item.id === target.id
    ? { ...strip(item), input: '核对 PO-2026-0815 与发票 INV-3302 的金额差异' }
    : strip(item)), ADMIN)
  assert.equal(rewritten.candidate!.cases.find(item => item.id === target.id)?.origin, undefined)
  assert.ok(rewritten.candidate!.cases.filter(item => item.id !== target.id).every(item => item.origin === 'generated'))
  const reverted = await release.updateCases(agentId, generated.map(strip), ADMIN)
  assert.equal(reverted.candidate!.cases.find(item => item.id === target.id)?.origin, undefined)
})

test('既有 submitted 候选仍可退回解锁、重试并发布', async () => {
  const agentId = 'agent-release-submit'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)
  await release.runChecks(agentId, ADMIN)
  await runCasesToReview(agentId)
  await confirmLatestTrial(agentId)

  const [candidate] = await database<{ id: string }[]>`
    update agent_release_submissions set status = 'submitted'
     where tenant_id = ${tenantId} and agent_id = ${agentId} and status = 'draft'
    returning id
  `
  assert.ok(candidate)
  const submitted = await release.getReleaseState(agentId)
  assert.equal(submitted.candidate?.status, 'submitted')

  // 已提交候选仍拒绝案例修改、检查和再次试运行。
  await assert.rejects(release.updateCases(agentId, [], ADMIN), /封存/)
  await assert.rejects(release.runChecks(agentId, ADMIN), /封存/)
  await assert.rejects(runCasesToReview(agentId), /封存|不能发起试运行/)

  // 草稿漂移不推进已提交候选的修订；发布按封存指纹复核，漂移内容不能放行
  await agents.updateAgent({
    agentId,
    name: '退款预测助手',
    description: '基于历史退款记录预测高风险订单并给出处理建议（审核期间修改）。',
    owner: '发布管理员',
    department: '平台治理',
    welcomeMessage: '',
    examplePrompts: ['评估本周退款风险订单'],
    systemPrompt: '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。',
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'],
    tools: ['read@1.0.0'],
    changeSummary: '审核期间修改说明',
    actor: ADMIN,
  })
  const drifted = await release.ensureCandidate(agentId, ADMIN)
  assert.equal(drifted.candidate?.status, 'submitted')
  assert.equal(drifted.candidate?.revision, 1)
  assert.equal(drifted.definitionChanged, true)
  await assert.rejects(release.publish(agentId, '', ADMIN), /封存试运行/)

  // 退回解锁：必须带审核意见；同步后修订推进并回到 draft 重新走流程
  await assert.rejects(release.requestChanges(agentId, '  ', ADMIN), /审核意见/)
  const returned = await release.requestChanges(agentId, '说明文案需完善', ADMIN)
  assert.equal(returned.candidate?.status, 'changes_requested')
  assert.equal(returned.candidate?.reviewNote, '说明文案需完善')
  const resynced = await release.ensureCandidate(agentId, ADMIN)
  assert.equal(resynced.candidate?.status, 'draft')
  assert.equal(resynced.candidate?.revision, 2)
  assert.equal(resynced.candidate?.sealedRevision, undefined)

  await release.runChecks(agentId, ADMIN)
  await runCasesToReview(agentId)
  await confirmLatestTrial(agentId)
  const published = await release.publish(agentId, '', ADMIN)
  assert.equal(published.candidate, undefined)
})

test('撤回使候选进入终态并保留历史，再次同步创建新候选', async () => {
  const agentId = 'agent-release-withdraw'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)

  // 草稿态候选不能退回（仅既有 submitted 可退回）
  await assert.rejects(release.requestChanges(agentId, '草稿阶段退回', ADMIN), /仅待审核状态/)

  const withdrawn = await release.withdrawSubmission(agentId, ADMIN)
  assert.equal(withdrawn.candidate, undefined)
  await assert.rejects(release.publish(agentId, '', ADMIN), /没有进行中的发布候选/)
  await assert.rejects(release.withdrawSubmission(agentId, ADMIN), /没有可撤回/)

  const recreated = await release.ensureCandidate(agentId, ADMIN)
  assert.equal(recreated.candidate?.status, 'draft')
  assert.equal(recreated.candidate?.revision, 1)
})

// ---------------------------------------------------------------------------
// 发布试运行桩：按真实 Run/Attempt 编排链路模拟 DSH 终态事件
// ---------------------------------------------------------------------------

// 试运行桩 Runtime：模拟 DSH 终态事件流，验证试运行走的是真实 Run/Attempt 编排链路。
interface TrialExecution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  resolve: (snapshot: RuntimeExecutionSnapshot) => void
}

// ---------------------------------------------------------------------------
// AR-01 正确性与安全修复回归（F-03/F-04/F-05/F-06）及案例沿用、启动收敛
// ---------------------------------------------------------------------------

/** 按生产流程发布当前草稿：检查 → 五项逐项试运行 → 确认 → 发布。 */
async function publishCurrentDraft(agentId: string, note = '业务场景已确认') {
  await release.ensureCandidate(agentId, ADMIN)
  await release.runChecks(agentId, ADMIN)
  await runCasesToReview(agentId)
  await confirmLatestTrial(agentId)
  return release.publish(agentId, note, ADMIN)
}

test('F-04：发布服务与 Agent 服务共用管理员判定，已停用的管理员角色不能操作发布', async () => {
  const agentId = `agent-admin-source-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, [], [], [])
  const suffix = randomUUID().slice(0, 8)
  const roleId = `role-disabled-admin-${suffix}`
  const user = `user-disabled-admin-${suffix}`
  await database`
    insert into roles (id, tenant_id, code, name, permissions, status)
    values (${roleId}, ${tenantId}, ${`disabled-admin-${suffix}`}, '已停用的管理角色', ${database.json(['admin:*'])}, 'disabled')
  `
  await database`
    insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
    values (${user}, ${tenantId}, ${`directory:${user}`}, '停用角色管理员', null, 'active', 'ai-hub', true)
  `
  await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${user}, ${roleId}, 'local')`
  // 修复前发布服务不检查角色状态，停用角色仍可推进发布流程。
  await assert.rejects(release.ensureCandidate(agentId, user), /不是平台管理员/)
  await assert.rejects(setAccess(agentId, { visibleRoleIds: ['role-employee'] }, user), /不是平台管理员/)
  await assert.rejects(agents.setStatus({ agentId, status: 'disabled', actor: user }), /不是平台管理员/)
})

test('F-03：回滚只移动活动版本，停用状态与进行中的草稿保持不变，并拒绝过期回滚', async () => {
  const agentId = `agent-rollback-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, [], [], [])
  await publishCurrentDraft(agentId)
  await agents.updateAgent({ ...created.agent, agentId, actor: ADMIN, name: '退款预测助手二版', changeSummary: '二版' })
  await publishCurrentDraft(agentId)
  await agents.setStatus({ agentId, status: 'disabled', actor: ADMIN })
  const third = await agents.updateAgent({ ...created.agent, agentId, actor: ADMIN, name: '退款预测助手三版', changeSummary: '三版草稿' })
  assert.equal(third.agent.version, '0.3.0')

  const rolled = await agents.rollback({ agentId, version: '0.1.0', actor: ADMIN })
  assert.equal(rolled.agent.status, 'disabled', '停用中的 Agent 回滚后仍保持停用')
  assert.match(rolled.release.note, /启停状态与进行中的草稿保持不变/)
  const [row] = await database<{ status: string; draftVersionId: string | null; activeVersion: string; draftStatus: string }[]>`
    select a.status, a.draft_version_id as "draftVersionId", active.version as "activeVersion", draft.status as "draftStatus"
      from agents a
      join agent_versions active on active.tenant_id = a.tenant_id and active.id = a.active_version_id
      left join agent_versions draft on draft.tenant_id = a.tenant_id and draft.id = a.draft_version_id
     where a.tenant_id = ${tenantId} and a.id = ${agentId}
  `
  assert.equal(row?.status, 'disabled')
  assert.equal(row?.activeVersion, '0.1.0')
  assert.equal(row?.draftVersionId, third.version.id, '回滚不能静默丢弃进行中的草稿')
  assert.equal(row?.draftStatus, 'draft')
  await assert.rejects(agents.rollback({ agentId, version: '0.1.0', actor: ADMIN }), /已是当前活动版本/)
  // 并发：两次回滚同时请求不同目标，只能有一个按读取时的活动版本成功，另一个报冲突或无需回滚。
  const results = await Promise.allSettled([
    agents.rollback({ agentId, version: '0.2.0', actor: ADMIN }),
    agents.rollback({ agentId, version: '0.2.0', actor: ADMIN }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
})

test('F-05：编辑器保存不改岗位权限，过期修订被拒绝', async () => {
  const agentId = `agent-editor-scope-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, [], [], [])
  const opened = await agents.getMutationSnapshot(agentId)
  assert.equal(created.agent.revision, opened.revision)
  // 打开编辑器后调整岗位权限，不会让编辑器修订过期，也不会被编辑器保存覆盖。
  await setAccess(agentId, { visibleRoleIds: ['role-employee', 'role-platform-admin'] })
  const afterScope = (await agents.getAgents()).find(item => item.id === agentId)!
  assert.equal(afterScope.revision, opened.revision)
  const saved = await agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN,
    systemPrompt: `${PROMPT}遇到无法核实的数据时明确说明。`, changeSummary: '编辑器保存',
  }, opened.revision)
  assert.deepEqual([...saved.agent.roleIds].sort(), ['role-employee', 'role-platform-admin'])
  // 定义已被修改：继续使用打开时的修订保存会被拒绝。
  await assert.rejects(agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN, changeSummary: '过期编辑',
  }, opened.revision), /Agent 配置已变化/)
})

test('新版本沿用上一次发布时改写过的案例，未改写的类型按当前定义重新生成', async () => {
  const agentId = `agent-case-carry-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, [], [], [])
  const candidate = (await release.ensureCandidate(agentId, ADMIN)).candidate!
  const rewrittenInput = '评估订单 SO-2026-1001 的退款风险并给出依据'
  await release.updateCases(agentId, candidate.cases.map(item => item.kind === 'success'
    ? { ...item, input: rewrittenInput } : item), ADMIN)
  await publishCurrentDraft(agentId)

  await agents.updateAgent({ ...created.agent, agentId, actor: ADMIN, name: '退款预测助手二版', changeSummary: '二版' })
  const next = (await release.ensureCandidate(agentId, ADMIN)).candidate!
  assert.equal(next.cases.length, 5)
  const success = next.cases.find(item => item.kind === 'success')!
  assert.equal(success.input, rewrittenInput)
  assert.equal(success.origin, undefined)
  assert.ok(next.cases.filter(item => item.kind !== 'success').every(item => item.origin === 'generated'))
  assert.ok(next.cases.every(item => !candidate.cases.some(previous => previous.id === item.id)), '沿用案例使用新的案例标识')
})

test('服务重启后执行中的试运行收敛为“服务重启中断”，等待人工判定的保留', async () => {
  const executing = `agent-trial-recover-${randomUUID().slice(0, 8)}`
  await createDraftAgent(executing, [], [], [])
  const reviewing = `agent-trial-review-${randomUUID().slice(0, 8)}`
  await createDraftAgent(reviewing, [], [], [])
  await release.ensureCandidate(executing, ADMIN)
  await runCasesToReview(executing)
  await release.ensureCandidate(reviewing, ADMIN)
  await runCasesToReview(reviewing)
  const [interrupted] = await database<{ id: string }[]>`
    update agent_trial_runs
       set status = 'executing', finished_at = null,
           steps = jsonb_set(steps, '{0,status}', '"running"')
     where tenant_id = ${tenantId} and agent_id = ${executing}
    returning id
  `
  const recovered = await release.recoverInterruptedTrials()
  assert.ok(recovered.interrupted >= 1)
  const [row] = await database<{ status: string; failureStage: string | null; steps: TrialRunStep[] }[]>`
    select status, failure_stage as "failureStage", steps from agent_trial_runs where tenant_id = ${tenantId} and id = ${interrupted!.id}
  `
  assert.equal(row?.status, 'failed')
  assert.equal(row?.failureStage, '服务重启中断')
  assert.ok(row?.steps.every(step => step.status !== 'running'))
  assert.equal((await release.getReleaseState(reviewing)).trialRuns[0]?.status, 'asserting')
  // 收敛后可直接重新开始试运行。
  const restarted = await runCasesToReview(executing)
  assert.equal(restarted.trialRuns[0]?.status, 'asserting')
})

class TrialStubRuntime implements AgentRuntimePort {
  modelRequirementsEnabled = false
  async assertModelRequirements(requirements: NonNullable<RuntimeManifest['model_requirements']>, target: { providerKey: string; modelKey: string; baseUrl: string }) {
    assert.equal(this.modelRequirementsEnabled, true, '测试能力必须显式启用')
    assert.deepEqual(requirements, ['long-context', 'structured-output'])
    assert.equal(target.providerKey, 'deepseek-official')
    assert.equal(target.modelKey, 'deepseek-v4-pro')
  }
  private readonly executions = new Map<string, TrialExecution>()
  /** 测试可让指定输入失败（断言负路径）。 */
  failOnMessage = ''
  pauseOnMessage = ''
  private pausedEntered: (() => void) | undefined
  private resume: (() => void) | undefined

  waitUntilPaused() { return new Promise<void>(resolve => { this.pausedEntered = resolve }) }
  resumePaused() { this.resume?.(); this.resume = undefined }

  /** 已派发 Attempt 的固化 Manifest：用于断言 tool_bindings 等执行期固定引用。 */
  manifest(runId: string) {
    return this.executions.get(runId)?.manifest
  }

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const execution: TrialExecution = {
      manifest, events: [], listeners: new Set(),
      snapshot: {
        runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued', acceptedAt: now,
        startedAt: null, endedAt: null, manifestSha256: 'test', attemptDirectory: '/tmp/test',
        errorCode: null, errorMessage: null,
      },
      resolve: resolveDone,
    }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '已排队')
    setTimeout(async () => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '已启动')
      if (this.pauseOnMessage && manifest.input.message === this.pauseOnMessage) {
        await new Promise<void>(resolve => {
          this.resume = resolve
          this.pausedEntered?.()
          this.pausedEntered = undefined
        })
      }
      if (this.failOnMessage && manifest.input.message === this.failOnMessage) {
        this.emit(execution, 'assistant.delta', '失败前的部分输出')
        this.emit(execution, 'assistant.completed', '失败前的部分输出')
        execution.snapshot.status = 'failed'
        execution.snapshot.errorCode = 'TRIAL_FAILED'
        this.emit(execution, 'run.failed', '试运行案例执行失败', { error_code: 'TRIAL_FAILED' })
        this.finish(execution)
        return
      }
      this.emit(execution, 'assistant.delta', `试运行回答：${manifest.input.message}`)
      this.emit(execution, 'assistant.completed', `试运行回答：${manifest.input.message}`)
      execution.snapshot.status = 'completed'
      this.emit(execution, 'run.completed', '已完成')
      this.finish(execution)
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

  async cancel(runId: string) {
    const execution = this.executions.get(runId)
    if (!execution || ['completed', 'cancelled', 'failed'].includes(execution.snapshot.status)) return { accepted: false }
    this.emit(execution, 'run.cancel_requested', '正在取消')
    execution.snapshot.status = 'cancelled'
    this.emit(execution, 'run.cancelled', '已取消')
    this.finish(execution)
    return { accepted: true }
  }

  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async inspectMcpConnection() {
    return { latencyMs: 1, capabilities: [
      { name: 'lookup', description: '查询可丢弃的集成测试数据', inputSchema: { type: 'object', properties: {} } },
    ] }
  }
  async health() {
    return { status: 'healthy' as const, runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio' as const, message: 'test' }
  }
  async close() { return undefined }

  private emit(execution: TrialExecution, eventType: RuntimeEvent['event_type'], display: string, safeMetadata: Record<string, unknown> = {}) {
    const event: RuntimeEvent = {
      event_id: randomUUID(), run_id: execution.manifest.run_id, attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1, event_type: eventType, occurred_at: new Date().toISOString(),
      display_message: display, safe_metadata: safeMetadata, trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => listener(event))
  }

  private finish(execution: TrialExecution) {
    execution.snapshot.endedAt = new Date().toISOString()
    execution.resolve(structuredClone(execution.snapshot))
  }
}

// ---------------------------------------------------------------------------
// B-03/I-04：真实绑定修订——封存依据、Attempt 固定、漂移拒绝与发布追溯
// ---------------------------------------------------------------------------

test('平台工具绑定经真实修订封存：Attempt 固定 pin，漂移后发布被拒绝', async () => {
  const agentId = 'agent-release-binding'
  await createDraftAgent(agentId)
  await release.ensureCandidate(agentId, ADMIN)

  // 检查与计划含真实绑定修订：不再是固定占位文本。
  const checked = await release.runChecks(agentId, ADMIN)
  const bindingCheck = checked.candidate?.checks.find(item => item.id === 'binding')
  assert.equal(bindingCheck?.status, 'passed')
  assert.match(bindingCheck?.detail ?? '', /read@1\.0\.0 rev1/)
  const bindingPlan = checked.candidate?.plan.find(item => item.kind === 'binding' && item.name === 'read@1.0.0')
  assert.ok(bindingPlan, '发布计划缺少真实绑定项')
  assert.equal(bindingPlan.action, 'create')
  assert.equal(bindingPlan.version, 'rev1')
  assert.match(bindingPlan.detail, /摘要 [a-f0-9]{12}/)

  // 封存：候选携带真实 pin（binding_id + revision + 摘要）。
  const trialed = await runCasesToReview(agentId)
  const pins = trialed.candidate?.bindingRefs ?? []
  const readPin = pins.find(pin => pin.tool === 'read@1.0.0')
  assert.ok(pins.length > 1, '平台默认工具也应封存精确绑定')
  assert.equal(readPin?.revision, 1)
  assert.match(readPin?.binding_id ?? '', /^tool-binding-/)
  assert.match(readPin?.digest ?? '', /^[a-f0-9]{64}$/)

  // Attempt Manifest 固定的正是封存 pin：执行证据与封存依据同源。
  const caseRun = trialed.trialRuns[0]?.steps.flatMap(step => step.caseRuns ?? [])[0]
  assert.ok(caseRun?.runId)
  const manifest = trialRuntime.manifest(caseRun.runId!)
  assert.deepEqual(manifest?.tool_bindings, pins)

  const confirmed = await confirmLatestTrial(agentId)
  assert.equal(confirmed.trialRuns[0]?.status, 'passed')

  // 封存后绑定语义漂移（授权范围收窄）：当前修订被取代，发布拒绝旧证据。
  await tools.updateToolPermissions({
    toolId: 'read',
    allowedRoles: ['role-platform-admin'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none',
    actor: ADMIN,
  })
  await assert.rejects(tools.assertAuthorizationCompatibility(['read@1.0.0'], [], []),
    /Agent 执行身份缺少工具 read@1\.0\.0 所需角色/)
  await assert.rejects(release.publish(agentId, '', ADMIN), /绑定修订已失效|重新封存/)

  // 漂移后重新走封存-试运行-发布：先恢复兼容的授权范围（又一次修订
  // 轮换），新修订集成为依据并成功发布。
  await tools.updateToolPermissions({
    toolId: 'read',
    allowedRoles: ['role-employee'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none',
    actor: ADMIN,
  })
  const rechecked = await release.runChecks(agentId, ADMIN)
  assert.equal(rechecked.candidate?.checks.find(item => item.id === 'binding')?.status, 'passed')
  await runCasesToReview(agentId)
  const repins = (await release.getReleaseState(agentId)).candidate?.bindingRefs ?? []
  assert.equal(repins.length, pins.length)
  assert.equal(repins.find(pin => pin.tool === 'read@1.0.0')?.revision, 3)
  await confirmLatestTrial(agentId)
  const published = await release.publish(agentId, '绑定修订复核通过', ADMIN)
  assert.equal(published.candidate, undefined)

  // 已发布版本记录携带真实绑定依据，前端与追溯不再需要占位值。
  const versions = await agents.getAgentVersions()
  const record = versions.find(item => item.agentId === agentId && item.version === '0.1.0')
  assert.deepEqual(record?.bindingRefs, repins)
})
