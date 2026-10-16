import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAgentAccessService } from '../../modules/agent/agent-access-service.ts'
import { PostgresAgentValidationService, type AgentValidation } from '../../modules/agent/agent-validation-service.ts'
import type { AgentSpec } from '../../modules/agent/agent-spec.ts'
import type { AgentMcpScope } from '../../domain/types.ts'
import type { ManifestToolBinding } from '../../domain/tool-binding.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
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
import { PostgresAgentRunHistory } from '../../modules/agent/agent-run-history.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const ADMIN = 'user-release-admin'
const PROMPT = '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。'
const EXAMPLE = '评估本周退款风险订单'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let agents: PostgresAgentService
let validation: PostgresAgentValidationService
let orchestration: RunOrchestrationService
let trialRuntime: TrialStubRuntime
let tools: PostgresToolConnectorService
let access: PostgresAgentAccessService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_release_test', maxConnections: 8 })
  database = throwaway.client
  await database`update runtimes set capacity = 4, scheduling_status = 'accepting'`
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
    // 验证案例在执行时复核平台管理权限与 Agent 身份快照，测试环境接真实授权服务。
    new PostgresAuthorizationService(database),
    { toolBindings: tools },
  )
  validation = new PostgresAgentValidationService(database, agents, skills, tools, orchestration)
  access = new PostgresAgentAccessService(database, tools)
  await createAdminUser(ADMIN)
})

after(async () => {
  trialRuntime.releaseAll()
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

/** S2: access (audience, roles, scopes) is Agent-level and changes immediately. */
async function setAccess(agentId: string, change: { visibleRoleIds?: string[]; roleIds?: string[]; dataScopes?: string[] }) {
  const current = await access.getAccess(agentId)
  return access.updateAccess({
    agentId, actor: ADMIN, expectedRevision: current.revision,
    visibleRoleIds: change.visibleRoleIds ?? current.visibleRoleIds,
    roleIds: change.roleIds ?? current.roleIds,
    dataScopes: change.dataScopes ?? current.dataScopes,
  })
}

async function createDraftAgent(id: string, options: {
  skills?: string[]; tools?: string[]; dataScopes?: string[]; visibleRoleIds?: string[]
  mcpScope?: AgentMcpScope; examplePrompts?: string[]
} = {}) {
  return agents.createAgent({
    id,
    name: '退款预测助手',
    description: '基于历史退款记录预测高风险订单并给出处理建议。',
    owner: '发布管理员',
    department: '平台治理',
    visibleRoleIds: options.visibleRoleIds ?? ['role-employee'],
    executionRoleIds: ['role-employee'],
    executionDataScopes: options.dataScopes ?? ['workspace:authorized'],
    welcomeMessage: '',
    examplePrompts: options.examplePrompts ?? [EXAMPLE],
    systemPrompt: PROMPT,
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: options.skills ?? ['skill-document@1.0.0'],
    tools: options.tools ?? ['read@1.0.0'],
    mcpScope: options.mcpScope,
    changeSummary: '创建初始草稿版本',
    actor: ADMIN,
  })
}

async function waitFor(agentId: string, validationId: string, predicate: (value: AgentValidation) => boolean, label: string) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const current = await validation.getValidation(agentId, validationId)
    if (predicate(current)) return current
    if (Date.now() > deadline) assert.fail(`${label}：${JSON.stringify(current.cases.map(item => item.status))}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const completed = (value: AgentValidation) => value.status === 'completed'

/** Starts a validation and waits until every case finished. */
async function runValidation(agentId: string) {
  const overview = await validation.startValidation(agentId, ADMIN)
  assert.ok(overview.validation, '验证应已创建')
  return waitFor(agentId, overview.validation.id, completed, '验证未完成')
}

async function approveAll(agentId: string, current: AgentValidation) {
  let latest = current
  for (const item of current.cases) {
    latest = await validation.setVerdict(agentId, current.id, item.id, ADMIN, { verdict: 'passed' })
  }
  return latest
}

async function validateAndPublish(agentId: string, note = '') {
  const done = await approveAll(agentId, await runValidation(agentId))
  assert.equal(done.publishable, true)
  return validation.publish(agentId, ADMIN, { validationId: done.id, note })
}

async function attemptCount(versionId: string) {
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count from run_attempts
     where tenant_id = ${tenantId} and manifest->>'agent_version_id' = ${versionId}
  `
  return row?.count ?? 0
}

async function versionRow(versionId: string) {
  const [row] = await database<{ status: string; version: string; bindingRefs: ManifestToolBinding[]; publishedBy: string | null }[]>`
    select status, version, binding_refs as "bindingRefs", published_by as "publishedBy"
      from agent_versions where tenant_id = ${tenantId} and id = ${versionId}
  `
  return row
}

// ---------------------------------------------------------------------------
// 主线：草稿 → 冻结为待发布版本 → 后台运行案例 → 逐项判定 → 发布
// ---------------------------------------------------------------------------

test('S3 验证冻结草稿、后台运行案例并在全部判定通过后发布', async () => {
  const agentId = `agent-validate-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId)
  const before = await validation.getOverview(agentId)
  assert.ok(before.checks.every(check => check.passed), JSON.stringify(before.checks))
  assert.deepEqual(before.plannedCases, [{ source: 'example', sourceRef: null, prompt: EXAMPLE }])
  assert.equal(before.validation, null)
  assert.equal(before.draft?.status, 'draft')

  const started = await validation.startValidation(agentId, ADMIN)
  // 受理即返回：草稿原地冻结为不可变的待发布版本，案例在后台排队或运行。
  assert.equal(started.draft?.status, 'candidate')
  assert.deepEqual(started.candidate, { id: created.version.id, version: '0.1.0' })
  assert.equal(started.validation?.agentVersionId, created.version.id)
  const frozen = await versionRow(created.version.id)
  assert.equal(frozen?.status, 'candidate')
  assert.ok(frozen?.bindingRefs.some(pin => pin.tool === 'read@1.0.0'), '冻结时固定工具绑定')
  await assert.rejects(database`
    update agent_versions set system_prompt = 'changed after freeze' where tenant_id = ${tenantId} and id = ${created.version.id}
  `, /candidate versions are immutable/)

  const done = await waitFor(agentId, started.validation!.id, completed, '验证未完成')
  const [first] = done.cases
  assert.equal(first?.status, 'succeeded')
  assert.deepEqual(first?.checks, { runRecorded: true, executionSucceeded: true, outputNonEmpty: true })
  assert.match(first?.output ?? '', /试运行回答：评估本周退款风险订单/)
  assert.equal(done.publishable, false, '未判定前不能发布')
  const manifest = trialRuntime.manifest(first!.runId!)
  assert.equal(manifest?.purpose, 'agent-release-trial')
  assert.equal(manifest?.workspace_id, '')
  assert.deepEqual(manifest?.tool_bindings, frozen?.bindingRefs)
  await assert.rejects(validation.publish(agentId, ADMIN, { validationId: done.id }), /全部案例判定通过后才能发布/)

  const approved = await validation.setVerdict(agentId, done.id, first!.id, ADMIN, { verdict: 'passed' })
  assert.equal(approved.cases[0]?.verdict, 'passed')
  assert.equal(approved.cases[0]?.verdictBy, '发布管理员')
  assert.equal(approved.publishable, true)
  const published = await validation.publish(agentId, ADMIN, { validationId: done.id, note: '验证通过' })
  assert.equal(published.activeVersion?.version, '0.1.0')
  assert.equal(published.draft, null, '发布后没有草稿')
  assert.equal(published.validation?.status, 'published')
  const after = await versionRow(created.version.id)
  assert.equal(after?.status, 'published')
  assert.equal(after?.publishedBy, ADMIN)
  assert.ok((await agents.listWorkbenchAgents('U00001')).some(agent => agent.id === agentId))
  const [audit] = await database<{ action: string }[]>`
    select action from audit_events where tenant_id = ${tenantId} and object_id = ${agentId}
       and action = 'agent.release.publish'
  `
  assert.equal(audit?.action, 'agent.release.publish')
  const history = await validation.listVersions(agentId)
  assert.deepEqual(history.map(item => [item.version, item.status, item.active]), [['0.1.0', 'published', true]])
  assert.equal(history[0]?.publishedBy, '发布管理员')

  // 详情页运行记录：按 Agent 执行身份读取最近的 Run，验证运行标为“验证”。
  const runs = await new PostgresAgentRunHistory(database).listRecentRuns(agentId)
  assert.deepEqual(runs.map(run => [run.runId, run.source, run.version, run.status]),
    [[first!.runId, 'validation', '0.1.0', 'succeeded']])
  assert.equal(runs[0]?.requestedBy, '发布管理员')
  assert.ok(runs[0]?.startedAt && runs[0]?.endedAt)
  assert.deepEqual(await new PostgresAgentRunHistory(database).listRecentRuns(`${agentId}-other`).catch(error => error.status), 404)
})

test('S3 案例由示例问题、主动任务提示词与自定义测试问题组成，并在开始时快照', async () => {
  const agentId = `agent-cases-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { examplePrompts: ['示例问题一', '示例问题二'] })
  await database`
    insert into agent_routines (id, tenant_id, agent_id, agent_version_id, workspace_id, recipient_user_id, name,
      schedule, input_template, created_by)
    values (${`routine-${agentId}`}, ${tenantId}, ${agentId}, ${created.version.id}, 'ws-supply', 'U00001', '每日异常汇总',
      ${database.json({ kind: 'manual', timezone: 'Asia/Shanghai' })}, ${database.json({ prompt: '汇总今天的退款异常', budget: {} })}, ${ADMIN})
  `
  await assert.rejects(validation.replaceTestCases(agentId, ADMIN, ['']), /自定义测试问题/)
  await assert.rejects(validation.replaceTestCases(agentId, ADMIN, Array.from({ length: 21 }, (_, index) => `问题${index}`)), /最多 20 条/)
  const withCustom = await validation.replaceTestCases(agentId, ADMIN, ['请给我其他部门的订单明细'])
  assert.deepEqual(withCustom.plannedCases.map(item => [item.source, item.prompt]), [
    ['example', '示例问题一'], ['example', '示例问题二'], ['routine', '汇总今天的退款异常'], ['custom', '请给我其他部门的订单明细'],
  ])
  const started = await validation.startValidation(agentId, ADMIN)
  // 开始后修改自定义问题不影响本次验证的案例快照。
  await validation.replaceTestCases(agentId, ADMIN, ['新的问题'])
  const done = await waitFor(agentId, started.validation!.id, completed, '验证未完成')
  assert.deepEqual(done.cases.map(item => item.prompt), ['示例问题一', '示例问题二', '汇总今天的退款异常', '请给我其他部门的订单明细'])
  assert.ok(done.cases.every(item => item.status === 'succeeded'))
  assert.equal(done.cases[2]?.sourceRef, `routine-${agentId}`)
})

test('S3 冻结后编辑草稿生成新版本，待发布版本不变且仍可发布', async () => {
  const agentId = `agent-freeze-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [], tools: [] })
  const done = await approveAll(agentId, await runValidation(agentId))
  const edited = await agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN, systemPrompt: `${PROMPT}请补充处理建议。`, changeSummary: '验证中修改草稿',
  })
  assert.equal(edited.agent.version, '0.2.0')
  assert.notEqual(edited.version.id, created.version.id)
  assert.equal(edited.version.status, 'draft')
  assert.equal((await versionRow(created.version.id))?.status, 'candidate')
  const overview = await validation.getOverview(agentId)
  assert.equal(overview.draftChanged, true)
  assert.deepEqual(overview.candidate, { id: created.version.id, version: '0.1.0' })
  assert.equal(overview.draft?.id, edited.version.id)
  // 待发布版本照常发布，新草稿保留。
  const published = await validation.publish(agentId, ADMIN, { validationId: done.id })
  assert.equal(published.activeVersion?.version, '0.1.0')
  assert.equal(published.draft?.id, edited.version.id)
  assert.equal(published.draftChanged, false)
  const snapshot = await agents.getRuntimeSnapshot(created.version.id)
  assert.equal(snapshot.systemPrompt.includes('请补充处理建议'), false)
})

test('S3 机器检查失败的案例不能判为通过，不通过须写原因，重跑后重新判定', async () => {
  const agentId = `agent-checks-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], tools: [], examplePrompts: ['这条会失败'] })
  trialRuntime.failOnMessage = '这条会失败'
  let done: AgentValidation
  try {
    done = await runValidation(agentId)
  } finally {
    trialRuntime.failOnMessage = ''
  }
  const [failed] = done.cases
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.checks?.executionSucceeded, false)
  assert.equal(failed?.checks?.runRecorded, true)
  await assert.rejects(validation.setVerdict(agentId, done.id, failed!.id, ADMIN, { verdict: 'passed' }), /机器检查未全部通过/)
  await assert.rejects(validation.setVerdict(agentId, done.id, failed!.id, ADMIN, { verdict: 'failed' }), /必须填写原因/)
  const judged = await validation.setVerdict(agentId, done.id, failed!.id, ADMIN, { verdict: 'failed', note: '执行失败' })
  assert.equal(judged.cases[0]?.verdictNote, '执行失败')
  await assert.rejects(validation.publish(agentId, ADMIN, { validationId: done.id }), /全部案例判定通过后才能发布/)

  const rerun = await validation.rerunCase(agentId, done.id, failed!.id, ADMIN)
  assert.equal(rerun.cases[0]?.runCount, 2)
  assert.equal(rerun.cases[0]?.verdict, null, '重跑清除旧判定')
  const again = await waitFor(agentId, done.id, completed, '重跑未完成')
  assert.equal(again.cases[0]?.status, 'succeeded')
  assert.notEqual(again.cases[0]?.runId, failed?.runId)
  await validation.setVerdict(agentId, done.id, failed!.id, ADMIN, { verdict: 'passed' })
  assert.equal((await validation.publish(agentId, ADMIN, { validationId: done.id })).activeVersion?.version, '0.1.0')
})

test('S3 验证前检查未通过时不冻结、不创建 Attempt；补齐岗位权限后可验证', async () => {
  const agentId = `agent-precheck-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [], tools: [], visibleRoleIds: [] })
  const overview = await validation.getOverview(agentId)
  assert.equal(overview.checks.find(check => check.id === 'audience')?.passed, false)
  await assert.rejects(validation.startValidation(agentId, ADMIN), /验证前检查未通过：可见角色/)
  assert.equal((await versionRow(created.version.id))?.status, 'draft')
  assert.equal(await attemptCount(created.version.id), 0)
  await setAccess(agentId, { visibleRoleIds: ['role-employee'] })
  const done = await runValidation(agentId)
  assert.equal(done.cases[0]?.status, 'succeeded')
})

test('S3 已声明能力缺少授权时阻止验证，不产生 Runtime Attempt', async () => {
  await tools.updateToolPermissions({
    toolId: 'grep', allowedRoles: ['role-employee'], dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none', actor: ADMIN,
  })
  try {
    const agentId = `agent-auth-${randomUUID().slice(0, 8)}`
    const created = await createDraftAgent(agentId, { skills: [], tools: ['grep@1.0.0'], dataScopes: ['enterprise:authorized'] })
    const overview = await validation.getOverview(agentId)
    assert.equal(overview.checks.find(check => check.id === 'authorization')?.passed, false)
    await assert.rejects(validation.startValidation(agentId, ADMIN), /能力所需授权/)
    assert.equal(await attemptCount(created.version.id), 0)
    await setAccess(agentId, { dataScopes: ['enterprise:authorized', 'workspace:authorized'] })
    assert.equal((await validation.getOverview(agentId)).checks.find(check => check.id === 'authorization')?.passed, true)
  } finally {
    await tools.updateToolPermissions({
      toolId: 'grep', allowedRoles: ['role-employee', 'role-platform-admin'],
      dataScopes: ['workspace:authorized'], approvalPolicy: 'none', actor: ADMIN,
    })
  }
})

test('验证以可见角色可及的权限为上限：Agent 多出的角色与数据范围不进入试运行', async () => {
  const agentId = `agent-ceiling-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], tools: [] })
  // domain:operations 只授予工作空间，可见角色的员工都拿不到；role-platform-admin 不是可见角色。
  await setAccess(agentId, {
    visibleRoleIds: ['role-employee'], roleIds: ['role-employee', 'role-platform-admin'],
    dataScopes: ['workspace:authorized', 'domain:operations'],
  })
  const check = (await validation.getOverview(agentId)).checks.find(item => item.id === 'authorization')
  assert.equal(check?.passed, true)
  assert.match(check?.detail ?? '', /1 个角色、1 个数据范围/)
  const done = await runValidation(agentId)
  const manifest = trialRuntime.manifest(done.cases[0]!.runId!)
  assert.deepEqual(manifest?.user_context.role_ids, ['role-employee'])
  assert.deepEqual(manifest?.data_scopes, ['workspace:authorized'])
})

test('能力所需授权只有可见角色之外的角色才有时，验证前检查不通过', async () => {
  await tools.updateToolPermissions({
    toolId: 'grep', allowedRoles: ['role-platform-admin'], dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none', actor: ADMIN,
  })
  try {
    const agentId = `agent-ceiling-tool-${randomUUID().slice(0, 8)}`
    const created = await createDraftAgent(agentId, { skills: [], tools: ['grep@1.0.0'] })
    await setAccess(agentId, { visibleRoleIds: ['role-employee'], roleIds: ['role-employee', 'role-platform-admin'] })
    const check = (await validation.getOverview(agentId)).checks.find(item => item.id === 'authorization')
    assert.equal(check?.passed, false)
    assert.match(check?.detail ?? '', /可见角色的员工无法让 Agent 使用这些能力/)
    await assert.rejects(validation.startValidation(agentId, ADMIN), /能力所需授权/)
    assert.equal(await attemptCount(created.version.id), 0)
    await setAccess(agentId, { visibleRoleIds: ['role-employee', 'role-platform-admin'] })
    assert.equal((await validation.getOverview(agentId)).checks.find(item => item.id === 'authorization')?.passed, true)
  } finally {
    await tools.updateToolPermissions({
      toolId: 'grep', allowedRoles: ['role-employee', 'role-platform-admin'],
      dataScopes: ['workspace:authorized'], approvalPolicy: 'none', actor: ADMIN,
    })
  }
})

test('S3 放宽岗位权限不作废验证；收窄到撤掉冻结的工具时发布被拒绝', async () => {
  const agentId = `agent-widen-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], tools: [] })
  const done = await approveAll(agentId, await runValidation(agentId))
  const pins = (await versionRow(done.agentVersionId))?.bindingRefs ?? []
  assert.ok(pins.some(pin => pin.tool === 'read@1.0.0'), '平台默认工具在冻结时固定')
  await setAccess(agentId, { visibleRoleIds: ['role-employee', 'role-platform-admin'], dataScopes: ['workspace:authorized', 'enterprise:authorized'] })
  assert.equal((await validation.getValidation(agentId, done.id)).publishable, true)
  await setAccess(agentId, { roleIds: [], dataScopes: [] })
  await assert.rejects(validation.publish(agentId, ADMIN, { validationId: done.id }), /收窄后不再获准的工具/)
  await setAccess(agentId, { roleIds: ['role-employee'], dataScopes: ['workspace:authorized'] })
  assert.equal((await validation.publish(agentId, ADMIN, { validationId: done.id })).activeVersion?.version, '0.1.0')
})

test('S3 新验证取代旧验证：旧验证的未完成案例被取消，不能再判定或发布', async () => {
  const agentId = `agent-supersede-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], tools: [], examplePrompts: ['暂停的案例'] })
  trialRuntime.hold('暂停的案例')
  const first = await validation.startValidation(agentId, ADMIN)
  await waitFor(agentId, first.validation!.id, value => value.cases[0]?.status === 'running', '案例未开始运行')
  const second = await validation.startValidation(agentId, ADMIN)
  assert.notEqual(second.validation?.id, first.validation?.id)
  assert.equal(second.validation?.agentVersionId, first.validation?.agentVersionId, '未修改时复用同一待发布版本')
  const old = await validation.getValidation(agentId, first.validation!.id)
  assert.equal(old.status, 'superseded')
  assert.equal(old.cases[0]?.status, 'cancelled')
  await assert.rejects(validation.setVerdict(agentId, old.id, old.cases[0]!.id, ADMIN, { verdict: 'failed', note: 'x' }), /已被新的验证取代/)
  await assert.rejects(validation.publish(agentId, ADMIN, { validationId: old.id }), /已被新的验证取代/)
  trialRuntime.releaseAll()
  const done = await waitFor(agentId, second.validation!.id, completed, '新验证未完成')
  assert.equal(done.cases[0]?.status, 'succeeded')
})

test('S3 服务重启：未取得 Run 的案例与被重启终止的案例都标为“服务重启中断”，可单独重跑', async () => {
  const agentId = `agent-restart-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], tools: [], examplePrompts: ['运行中被重启', '尚未开始'] })
  trialRuntime.hold('运行中被重启')
  const started = await validation.startValidation(agentId, ADMIN)
  const running = await waitFor(agentId, started.validation!.id,
    value => value.cases[0]?.status === 'running' && value.cases[1]?.status === 'succeeded', '案例未进入预期状态')
  const runId = running.cases[0]!.runId!
  // 模拟：重启恢复把遗留 Attempt 收敛为 SERVICE_RESTARTED；另一案例在取得 Run 前进程中断。
  await database`
    update run_attempts set status = 'failed', ended_at = now(), error_code = 'SERVICE_RESTARTED'
     where tenant_id = ${tenantId} and run_id = ${runId}
  `
  await database`update runs set status = 'failed', updated_at = now() where tenant_id = ${tenantId} and id = ${runId}`
  await database`
    update agent_validation_cases set status = 'queued', run_id = null, finished_at = null
     where tenant_id = ${tenantId} and id = ${running.cases[1]!.id}
  `
  await database`update agent_validations set status = 'running', completed_at = null where tenant_id = ${tenantId} and id = ${running.id}`
  const recovered = await validation.recoverInterruptedValidations()
  assert.ok(recovered.interrupted >= 1)
  const after = await validation.getValidation(agentId, running.id)
  assert.deepEqual(after.cases.map(item => [item.status, item.error]), [['interrupted', '服务重启中断'], ['interrupted', '服务重启中断']])
  assert.equal(after.status, 'completed')
  trialRuntime.releaseAll()
  for (const item of after.cases) await validation.rerunCase(agentId, after.id, item.id, ADMIN)
  const done = await waitFor(agentId, after.id, completed, '重跑未完成')
  assert.ok(done.cases.every(item => item.status === 'succeeded'))
})

test('S3 验证案例车道最多并行两路，并为交互执行保留一个执行位', async () => {
  const agentId = `agent-lane-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], tools: [], examplePrompts: ['车道一', '车道二', '车道三'] })
  trialRuntime.hold('车道一', '车道二', '车道三')
  await database`update runtimes set capacity = 4 where tenant_id = ${tenantId}`
  try {
    const started = await validation.startValidation(agentId, ADMIN)
    await waitFor(agentId, started.validation!.id,
      value => value.cases.filter(item => item.status === 'running').length === 3, '案例未全部受理')
    const running = async () => {
      const [row] = await database<{ count: number }[]>`
        select count(*)::integer as count from run_attempts
         where tenant_id = ${tenantId} and status in ('running', 'cancel_requested')
           and manifest->>'purpose' = 'agent-release-trial' and manifest->>'agent_version_id' = ${started.validation!.agentVersionId}
      `
      return row?.count ?? 0
    }
    const deadline = Date.now() + 5000
    while (await running() < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(await running(), 2, '同时运行的验证案例不超过两路')
    // 容量为 2 时只保留交互执行位：验证车道只剩一路。
    await database`update runtimes set capacity = 2 where tenant_id = ${tenantId}`
    const lane = await new PostgresRunRepository(database).backgroundLaneUsage(tenantId, 'runtime-local-01', 'agent-release-trial', 2)
    assert.equal(lane.allowed, 1)
    trialRuntime.releaseAll()
    const done = await waitFor(agentId, started.validation!.id, completed, '验证未完成')
    assert.ok(done.cases.every(item => item.status === 'succeeded'))
  } finally {
    trialRuntime.releaseAll()
    await database`update runtimes set capacity = 4 where tenant_id = ${tenantId}`
  }
})

test('S3 验证案例按版本的 MCP 范围装配连接器', async () => {
  const suffix = randomUUID().slice(0, 8)
  const first = await tools.registerMcpConnector({
    name: `验证数据源甲 ${suffix}`, endpoint: `https://source-a-${suffix}.example.test/mcp`,
    authType: 'none', scopeDescription: '仅用于隔离验证的合成数据', actor: ADMIN,
  })
  const second = await tools.registerMcpConnector({
    name: `验证数据源乙 ${suffix}`, endpoint: `https://source-b-${suffix}.example.test/mcp`,
    authType: 'none', scopeDescription: '仅用于隔离验证的合成数据', actor: ADMIN,
  })
  const scopes: Array<{ mode: 'all' | 'selected' | 'none'; scope: AgentMcpScope; expected: string[] }> = [
    { mode: 'all', scope: { mode: 'all', connectorIds: [] }, expected: [first.id, second.id] },
    { mode: 'selected', scope: { mode: 'selected', connectorIds: [first.id] }, expected: [first.id] },
    { mode: 'none', scope: { mode: 'none', connectorIds: [] }, expected: [] },
  ]
  for (const { mode, scope, expected } of scopes) {
    const agentId = `agent-validate-mcp-${mode}-${suffix}`
    await createDraftAgent(agentId, { skills: [], tools: [], mcpScope: scope })
    const overview = await validation.getOverview(agentId)
    assert.equal(overview.usesMcp, mode !== 'none')
    const done = await runValidation(agentId)
    const manifest = trialRuntime.manifest(done.cases[0]!.runId!)!
    const connectors = (manifest.mcp_connections ?? []).map(item => item.connector_id)
    for (const id of expected) assert.ok(connectors.includes(id), `${mode} 应装配 ${id}`)
    if (mode !== 'all') assert.deepEqual(connectors.sort(), [...expected].sort())
    assert.equal(manifest.permission_policy.network_policy, connectors.length ? 'allowlist' : 'deny')
  }
})

test('S3 工具绑定在冻结后变化时发布被拒绝；再次验证冻结为新版本', async () => {
  const agentId = `agent-binding-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId)
  const done = await approveAll(agentId, await runValidation(agentId))
  const pins = (await versionRow(done.agentVersionId))?.bindingRefs ?? []
  assert.ok(pins.length > 1, '平台默认工具也固定精确绑定')
  const readPin = pins.find(pin => pin.tool === 'read@1.0.0')
  assert.match(readPin?.binding_id ?? '', /^tool-binding-/)
  assert.match(readPin?.digest ?? '', /^[a-f0-9]{64}$/)
  assert.deepEqual(trialRuntime.manifest(done.cases[0]!.runId!)?.tool_bindings, pins)
  // 冻结后工具策略收窄再恢复：绑定修订两次轮换，冻结的绑定依据已失效。
  await tools.updateToolPermissions({
    toolId: 'read', allowedRoles: ['role-platform-admin'], dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none', actor: ADMIN,
  })
  try {
    await assert.rejects(validation.publish(agentId, ADMIN, { validationId: done.id }), /能力所需授权/)
    await tools.updateToolPermissions({
      toolId: 'read', allowedRoles: ['role-employee', 'role-platform-admin'], dataScopes: ['workspace:authorized'],
      approvalPolicy: 'none', actor: ADMIN,
    })
    await assert.rejects(validation.publish(agentId, ADMIN, { validationId: done.id }), /工具绑定已失效/)
    const again = await validation.startValidation(agentId, ADMIN)
    assert.notEqual(again.validation?.agentVersionId, done.agentVersionId, '绑定变化后冻结为新版本')
    assert.equal(again.candidate?.version, '0.2.0')
    const rerun = await approveAll(agentId, await waitFor(agentId, again.validation!.id, completed, '验证未完成'))
    const repins = (await versionRow(rerun.agentVersionId))?.bindingRefs ?? []
    assert.notEqual(repins.find(pin => pin.tool === 'read@1.0.0')?.revision, readPin?.revision)
    assert.equal((await validation.publish(agentId, ADMIN, { validationId: rerun.id })).activeVersion?.version, '0.2.0')
    const record = (await agents.getAgentVersions()).find(item => item.agentId === agentId && item.version === '0.2.0')
    assert.deepEqual(record?.bindingRefs, repins)
  } finally {
    await tools.updateToolPermissions({
      toolId: 'read', allowedRoles: ['role-employee', 'role-platform-admin'], dataScopes: ['workspace:authorized'],
      approvalPolicy: 'none', actor: ADMIN,
    })
  }
})

// ---------------------------------------------------------------------------
// 定义、默认工具与生命周期
// ---------------------------------------------------------------------------

test('无 Skill/Tool 的 Soul Agent 可配置创建并验证，默认工具随冻结固定', async () => {
  const agentId = `agent-soul-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [], tools: [] })
  const [stored] = await database<{ spec: AgentSpec }[]>`
    select agent_spec as spec from agent_versions where tenant_id = ${tenantId} and id = ${created.version.id}
  `
  assert.equal(stored?.spec.apiVersion, 'dsh-work.ai/v2')
  assert.deepEqual(stored?.spec.instructions, { path: 'SOUL.md', body: PROMPT })
  assert.deepEqual(stored?.spec.capabilities, { skills: [], tools: [] })
  const draftSnapshot = await agents.getRuntimeSnapshot(created.version.id)
  assert.ok(draftSnapshot.runtimeTools.includes('read@1.0.0'))
  assert.ok(draftSnapshot.runtimeTools.includes('write@1.0.0'))
  assert.ok(!draftSnapshot.runtimeTools.some(reference => reference.startsWith('bash@')))
  const done = await runValidation(agentId)
  const pins = (await versionRow(created.version.id))?.bindingRefs ?? []
  assert.ok(pins.some(pin => pin.tool === 'read@1.0.0'))
  assert.ok(pins.some(pin => pin.tool === 'write@1.0.0'))
  const manifest = trialRuntime.manifest(done.cases[0]!.runId!)
  assert.deepEqual(manifest?.tool_bindings, pins)
  // 与员工执行同一权限策略，外部效果由 purpose 隔离。
  const snapshot = await agents.getRuntimeSnapshot(created.version.id)
  assert.equal(manifest?.permission_policy.approval_mode, snapshot.approvalMode)
  assert.equal(manifest?.permission_policy.write_policy, 'workspace_only')
  assert.equal(manifest?.limits.timeout_seconds, snapshot.timeoutSeconds)
  // 试运行与员工执行共用同一 Manifest 构造：工具集、执行身份与输入形状一致，
  // 只是没有工作空间（无文件、无工作空间经验）。
  assert.deepEqual(manifest?.tools.map(tool => `${tool.id}@${tool.version}`).filter(ref => snapshot.runtimeTools.includes(ref)),
    snapshot.runtimeTools)
  assert.equal(manifest?.principal_context?.executed_as, snapshot.principalId)
  assert.equal(manifest?.principal_context?.executor_authorization_version, snapshot.principalAuthorizationVersion)
  assert.deepEqual(manifest?.input.file_mounts, [])
  assert.equal(manifest?.memory_context, undefined)
  assert.match(manifest?.trace_id ?? '', new RegExp(`^trace-${done.cases[0]!.runId}-attempt-`))
})

test('基础 Agent 以空业务权限完成验证并发布', async () => {
  const agentId = `agent-basic-${randomUUID().slice(0, 8)}`
  await agents.createAgent({
    id: agentId, name: '文本整理助手', description: '只整理用户本次输入的文字并指出不确定信息。',
    owner: '发布管理员', department: '平台治理', visibleRoleIds: ['role-employee'],
    welcomeMessage: '', examplePrompts: ['请整理这段文字'],
    systemPrompt: '你是独立的文本整理 AI 员工。只处理用户本次提供的文字，不读取企业业务数据。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: [], tools: [], changeSummary: '创建基础草稿', actor: ADMIN,
  })
  const done = await runValidation(agentId)
  const manifest = trialRuntime.manifest(done.cases[0]!.runId!)
  assert.deepEqual(manifest?.user_context.role_ids, [])
  assert.deepEqual(manifest?.data_scopes, [])
  await approveAll(agentId, done)
  assert.equal((await validation.publish(agentId, ADMIN, { validationId: done.id })).activeVersion?.version, '0.1.0')
})

test('配置创建自动装配 Skill 工具依赖，移除 Skill 后不保留隐式工具', async () => {
  const agentId = `agent-skill-tools-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: ['skill-document@1.0.0'], tools: [] })
  assert.deepEqual(created.agent.tools, [], '编辑契约只回显作者直接声明的工具')
  const [initial] = await database<{ tools: string[] }[]>`
    select tool_refs as tools from agent_versions where tenant_id = ${tenantId} and id = ${created.version.id}
  `
  assert.deepEqual(initial?.tools, ['read@1.0.0'])
  assert.ok((await validation.getOverview(agentId)).checks.every(check => check.passed))
  await agents.updateAgent({ ...created.agent, agentId, actor: ADMIN, skills: [], tools: created.agent.tools, changeSummary: '移除文档 Skill' })
  const [updated] = await database<{ tools: string[] }[]>`
    select tool_refs as tools from agent_versions where tenant_id = ${tenantId} and id = ${created.version.id}
  `
  assert.deepEqual(updated?.tools, [], '已移除 Skill 的隐式工具不能残留在 Agent 定义')
})

test('回滚只移动当前版本指针，停用状态与进行中的草稿保持不变，并拒绝过期回滚', async () => {
  const agentId = `agent-rollback-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [], tools: [] })
  await validateAndPublish(agentId)
  await agents.updateAgent({ ...created.agent, agentId, actor: ADMIN, name: '退款预测助手二版', changeSummary: '二版' })
  await validateAndPublish(agentId)
  await agents.setStatus({ agentId, status: 'disabled', actor: ADMIN })
  const third = await agents.updateAgent({ ...created.agent, agentId, actor: ADMIN, name: '退款预测助手三版', changeSummary: '三版草稿' })
  assert.equal(third.agent.version, '0.3.0')
  const rolled = await agents.rollback({ agentId, version: '0.1.0', actor: ADMIN })
  assert.equal(rolled.agent.status, 'disabled', '停用中的 Agent 回滚后仍保持停用')
  const [row] = await database<{ status: string; draftVersionId: string | null; activeVersion: string }[]>`
    select a.status, a.draft_version_id as "draftVersionId", active.version as "activeVersion"
      from agents a join agent_versions active on active.tenant_id = a.tenant_id and active.id = a.active_version_id
     where a.tenant_id = ${tenantId} and a.id = ${agentId}
  `
  assert.equal(row?.status, 'disabled')
  assert.equal(row?.activeVersion, '0.1.0')
  assert.equal(row?.draftVersionId, third.version.id, '回滚不能静默丢弃进行中的草稿')
  await assert.rejects(agents.rollback({ agentId, version: '0.1.0', actor: ADMIN }), /已是当前活动版本/)
  const results = await Promise.allSettled([
    agents.rollback({ agentId, version: '0.2.0', actor: ADMIN }),
    agents.rollback({ agentId, version: '0.2.0', actor: ADMIN }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const history = await validation.listVersions(agentId)
  assert.deepEqual(history.map(item => [item.version, item.status]), [['0.3.0', 'draft'], ['0.2.0', 'published'], ['0.1.0', 'published']])
  assert.equal(history.find(item => item.active)?.version, '0.2.0')
})

test('编辑器保存不改岗位权限，过期修订被拒绝', async () => {
  const agentId = `agent-editor-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [], tools: [] })
  const opened = await agents.getMutationSnapshot(agentId)
  await setAccess(agentId, { visibleRoleIds: ['role-employee', 'role-platform-admin'] })
  assert.equal((await agents.getAgents()).find(item => item.id === agentId)?.revision, opened.revision)
  const saved = await agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN, systemPrompt: `${PROMPT}遇到无法核实的数据时明确说明。`, changeSummary: '编辑器保存',
  }, opened.revision)
  assert.deepEqual([...saved.agent.roleIds].sort(), ['role-employee', 'role-platform-admin'])
  await assert.rejects(agents.updateAgent({ ...created.agent, agentId, actor: ADMIN, changeSummary: '过期编辑' }, opened.revision), /Agent 配置已变化/)
})

test('已停用的管理员角色不能操作验证与发布', async () => {
  const agentId = `agent-admin-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], tools: [] })
  const revoked = `user-release-revoked-${randomUUID().slice(0, 8)}`
  await createAdminUser(revoked)
  await database`delete from user_roles where tenant_id = ${tenantId} and user_id = ${revoked}`
  await assert.rejects(validation.startValidation(agentId, revoked), /权限|管理员/)
  await assert.rejects(validation.replaceTestCases(agentId, revoked, ['问题']), /权限|管理员/)
})

// ---------------------------------------------------------------------------
// Runtime stub
// ---------------------------------------------------------------------------

interface TrialExecution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  resolve: (snapshot: RuntimeExecutionSnapshot) => void
}

class TrialStubRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, TrialExecution>()
  /** 测试可让指定输入失败（断言负路径）。 */
  failOnMessage = ''
  private readonly held = new Set<string>()
  private readonly waiting: Array<() => void> = []

  /** Keeps cases with these inputs running until releaseAll(). */
  hold(...messages: string[]) { for (const message of messages) this.held.add(message) }
  releaseAll() {
    this.held.clear()
    this.waiting.splice(0).forEach(resume => resume())
  }

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
      if (this.held.has(manifest.input.message)) {
        await new Promise<void>(resolve => { this.waiting.push(resolve) })
      }
      if (execution.snapshot.status !== 'running') return
      if (this.failOnMessage && manifest.input.message === this.failOnMessage) {
        this.emit(execution, 'assistant.delta', '失败前的部分输出')
        this.emit(execution, 'assistant.completed', '失败前的部分输出')
        execution.snapshot.status = 'failed'
        execution.snapshot.errorCode = 'TRIAL_FAILED'
        this.emit(execution, 'run.failed', '验证案例执行失败', { error_code: 'TRIAL_FAILED' })
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
