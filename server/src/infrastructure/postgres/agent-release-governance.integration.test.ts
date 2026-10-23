import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAgentAccessService } from '../../modules/agent/agent-access-service.ts'
import { PostgresAgentValidationService, type AgentValidation } from '../../modules/agent/agent-validation-service.ts'
import type { AgentSpec } from '../../modules/agent/agent-spec.ts'
import type { AgentMcpScope } from '../../domain/types.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresMcpConnectorService } from '../../modules/tool/postgres-mcp-connector-service.ts'
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
let operations: PostgresOperationsService
let mcp: PostgresMcpConnectorService
let access: PostgresAgentAccessService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_release_test', maxConnections: 8 })
  database = throwaway.client
  await database`update runtimes set capacity = 4, scheduling_status = 'accepting'`
  trialRuntime = new TrialStubRuntime()
  mcp = new PostgresMcpConnectorService(database, trialRuntime)
  operations = new PostgresOperationsService(database, trialRuntime)
  const skills = new PostgresSkillService(database)
  agents = new PostgresAgentService(database, undefined, skills, mcp)
  orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database),
    new PostgresConversationRepository(database),
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    trialRuntime,
    undefined,
    operations,
    agents,
    undefined,
    // 验证案例在执行时复核平台管理权限与 Agent 身份快照，测试环境接真实授权服务。
    new PostgresAuthorizationService(database),
    {
      toolChecks: {
        assertPinnedConnections: pins => mcp.assertPinnedConnections(pins),
      },
    },
  )
  validation = new PostgresAgentValidationService(database, agents, skills, orchestration, mcp)
  access = new PostgresAgentAccessService(database)
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
  skills?: string[]; webSearchEnabled?: boolean; projectTasksEnabled?: boolean
  dataScopes?: string[]; visibleRoleIds?: string[]; roleIds?: string[]
  mcpScope?: AgentMcpScope; examplePrompts?: string[]
} = {}) {
  return agents.createAgent({
    id,
    name: '退款预测助手',
    description: '基于历史退款记录预测高风险订单并给出处理建议。',
    owner: '发布管理员',
    department: '平台治理',
    visibleRoleIds: options.visibleRoleIds ?? ['role-employee'],
    executionRoleIds: options.roleIds ?? ['role-employee'],
    executionDataScopes: options.dataScopes ?? ['workspace:authorized'],
    welcomeMessage: '',
    examplePrompts: options.examplePrompts ?? [EXAMPLE],
    systemPrompt: PROMPT,
    maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: options.skills ?? ['skill-document@1.0.0'],
    webSearchEnabled: options.webSearchEnabled,
    projectTasksEnabled: options.projectTasksEnabled,
    mcpScope: options.mcpScope,
    changeSummary: '创建初始草稿版本',
    actor: ADMIN,
  })
}

async function createPublishedSkill(id: string, toolRefs: string[]) {
  const versionId = `skill-version-${id}-1`
  await database.begin(async transaction => {
    await transaction`
      insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status)
      values (${id}, ${tenantId}, ${id}, '联网检索', '研究', '检索公开资料并整理要点。', ${ADMIN}, ${ADMIN}, 'published')
    `
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, tool_refs, test_prompt, status, created_by, published_by, published_at, change_summary
      ) values (
        ${versionId}, ${tenantId}, ${id}, '1.0.0', '联网检索', '研究', '检索公开资料并整理要点。',
        '检索公开资料，逐条列出每条结论的来源链接，并整理成要点。', '{}', ${transaction.json(toolRefs)}, '检索测试',
        'published', ${ADMIN}, ${ADMIN}, now(), '测试 Skill'
      )
    `
    await transaction`update skills set active_version_id = ${versionId} where tenant_id = ${tenantId} and id = ${id}`
  })
  return id
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
  const [row] = await database<{ status: string; version: string; publishedBy: string | null }[]>`
    select status, version, published_by as "publishedBy"
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
  assert.ok(manifest?.tools.some(tool => tool.id === 'read'), '试运行装配平台内置工具')
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
      ${database.json({ kind: 'manual', timezone: 'Asia/Taipei' })}, ${database.json({ prompt: '汇总今天的退款异常', budget: {} })}, ${ADMIN})
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
  // 主动任务案例按该主动任务的日程时区执行；其他案例使用平台默认时区。
  assert.equal(trialRuntime.manifest(done.cases[2]!.runId!)?.timezone, 'Asia/Taipei')
  assert.equal(trialRuntime.manifest(done.cases[0]!.runId!)?.timezone, 'Asia/Shanghai')
})

test('S3 冻结后编辑草稿生成新版本，待发布版本不变且仍可发布', async () => {
  const agentId = `agent-freeze-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [] })
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
  await createDraftAgent(agentId, { skills: [], examplePrompts: ['这条会失败'] })
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
  const created = await createDraftAgent(agentId, { skills: [], visibleRoleIds: [] })
  const overview = await validation.getOverview(agentId)
  assert.equal(overview.checks.find(check => check.id === 'audience')?.passed, false)
  await assert.rejects(validation.startValidation(agentId, ADMIN), /验证前检查未通过：可见角色/)
  assert.equal((await versionRow(created.version.id))?.status, 'draft')
  assert.equal(await attemptCount(created.version.id), 0)
  await setAccess(agentId, { visibleRoleIds: ['role-employee'] })
  const done = await runValidation(agentId)
  assert.equal(done.cases[0]?.status, 'succeeded')
})

test('S3 岗位角色必填：未授予时验证前检查不通过，撤掉全部岗位角色后不能发布', async () => {
  const agentId = `agent-roles-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [], roleIds: [], dataScopes: [] })
  const overview = await validation.getOverview(agentId)
  assert.equal(overview.checks.find(check => check.id === 'roles')?.passed, false)
  await assert.rejects(validation.startValidation(agentId, ADMIN), /验证前检查未通过：岗位角色/)
  assert.equal(await attemptCount(created.version.id), 0)

  await setAccess(agentId, { roleIds: ['role-employee'], dataScopes: ['workspace:authorized'] })
  assert.equal((await validation.getOverview(agentId)).checks.find(check => check.id === 'roles')?.passed, true)
  const done = await approveAll(agentId, await runValidation(agentId))
  await setAccess(agentId, { roleIds: [] })
  await assert.rejects(validation.publish(agentId, ADMIN, { validationId: done.id }), /岗位角色/)
})

test('验证以可见角色可及的权限为上限：Agent 多出的角色与数据范围不进入试运行', async () => {
  const agentId = `agent-ceiling-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [] })
  // domain:operations 只授予工作空间，可见角色的员工都拿不到；role-platform-admin 不是可见角色。
  await setAccess(agentId, {
    visibleRoleIds: ['role-employee'], roleIds: ['role-employee', 'role-platform-admin'],
    dataScopes: ['workspace:authorized', 'domain:operations'],
  })
  const check = (await validation.getOverview(agentId)).checks.find(item => item.id === 'authorization')
  assert.equal(check?.passed, true)
  assert.match(check?.detail ?? '', /1 个角色、1 个数据范围/)
  // 项目空间按 Agent 全部岗位角色执行：可见角色以外的角色要提示未经验证，但不阻断。
  assert.match(check?.warning ?? '', /不在可见角色内，验证不会覆盖/)
  const done = await runValidation(agentId)
  const manifest = trialRuntime.manifest(done.cases[0]!.runId!)
  assert.deepEqual(manifest?.user_context.role_ids, ['role-employee'])
  assert.deepEqual(manifest?.data_scopes, ['workspace:authorized'])
})

test('S3 调整岗位权限不作废验证，发布时复核当前授权', async () => {
  const agentId = `agent-widen-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [] })
  const done = await approveAll(agentId, await runValidation(agentId))
  await setAccess(agentId, { visibleRoleIds: ['role-employee', 'role-platform-admin'], dataScopes: ['workspace:authorized', 'enterprise:authorized'] })
  assert.equal((await validation.getValidation(agentId, done.id)).publishable, true)
  await setAccess(agentId, { roleIds: [] })
  await assert.rejects(validation.publish(agentId, ADMIN, { validationId: done.id }), /岗位角色/)
  await setAccess(agentId, { roleIds: ['role-employee'], dataScopes: ['workspace:authorized'] })
  assert.equal((await validation.publish(agentId, ADMIN, { validationId: done.id })).activeVersion?.version, '0.1.0')
})

test('S3 新验证取代旧验证：旧验证的未完成案例被取消，不能再判定或发布', async () => {
  const agentId = `agent-supersede-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], examplePrompts: ['暂停的案例'] })
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
  await createDraftAgent(agentId, { skills: [], examplePrompts: ['运行中被重启', '尚未开始'] })
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
  // 被收敛的 Attempt 随后又收到 Runtime 的完成事件：只入事件日志，不改状态、不写回答。
  const logged: string[] = []
  const consoleError = console.error
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); consoleError(...args) }
  try {
    trialRuntime.releaseAll()
    for (const item of after.cases) await validation.rerunCase(agentId, after.id, item.id, ADMIN)
    const done = await waitFor(agentId, after.id, completed, '重跑未完成')
    assert.ok(done.cases.every(item => item.status === 'succeeded'))
    for (let tries = 0; tries < 100; tries += 1) {
      const [row] = await database<{ count: number }[]>`
        select count(*)::integer as count from run_events
         where tenant_id = ${tenantId} and run_id = ${runId} and event_type = 'run.completed'
      `
      if (row?.count) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    // 事件写入后其后果在同一条链上处理；再等一拍让链尾落定。
    await new Promise(resolve => setTimeout(resolve, 50))
    const [late] = await database<{ runStatus: string; attemptStatus: string; answers: number; events: number }[]>`
      select r.status as "runStatus", a.status as "attemptStatus",
             (select count(*)::integer from messages m where m.tenant_id = r.tenant_id and m.run_id = r.id and m.role = 'assistant') as answers,
             (select count(*)::integer from run_events e where e.tenant_id = r.tenant_id and e.run_id = r.id and e.event_type = 'run.completed') as events
        from runs r join run_attempts a on a.tenant_id = r.tenant_id and a.run_id = r.id
       where r.tenant_id = ${tenantId} and r.id = ${runId}
    `
    assert.deepEqual({ ...late }, { runStatus: 'failed', attemptStatus: 'failed', answers: 0, events: 1 })
    assert.deepEqual(logged.filter(line => line.includes('persist runtime event failed')), [])
  } finally {
    console.error = consoleError
  }
})

test('S3 验证案例车道最多并行两路，并为交互执行保留一个执行位', async () => {
  const agentId = `agent-lane-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], examplePrompts: ['车道一', '车道二', '车道三'] })
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
  const first = await mcp.registerMcpConnector({
    name: `验证数据源甲 ${suffix}`, endpoint: `https://source-a-${suffix}.example.test/mcp`,
    authType: 'none', scopeDescription: '仅用于隔离验证的合成数据', actor: ADMIN,
  })
  const second = await mcp.registerMcpConnector({
    name: `验证数据源乙 ${suffix}`, endpoint: `https://source-b-${suffix}.example.test/mcp`,
    authType: 'none', scopeDescription: '仅用于隔离验证的合成数据', actor: ADMIN,
  })
  const scopes: Array<{ mode: 'selected' | 'none'; scope: AgentMcpScope; expected: string[] }> = [
    { mode: 'selected', scope: { mode: 'selected', connectorIds: [first.id] }, expected: [first.id] },
    { mode: 'selected', scope: { mode: 'selected', connectorIds: [first.id, second.id] }, expected: [first.id, second.id] },
    { mode: 'none', scope: { mode: 'none', connectorIds: [] }, expected: [] },
  ]
  for (const { mode, scope, expected } of scopes) {
    const agentId = `agent-validate-mcp-${mode}-${expected.length}-${suffix}`
    await createDraftAgent(agentId, { skills: [], mcpScope: scope })
    const overview = await validation.getOverview(agentId)
    assert.equal(overview.usesMcp, mode !== 'none')
    const done = await runValidation(agentId)
    const manifest = trialRuntime.manifest(done.cases[0]!.runId!)!
    const connectors = (manifest.mcp_connections ?? []).map(item => item.connector_id)
    assert.deepEqual(connectors.sort(), [...expected].sort())
    assert.equal(manifest.permission_policy.network_policy, connectors.length ? 'allowlist' : 'deny')
  }
})

test('联网搜索按 Agent 版本开关装配；Skill 需要联网搜索时须先开启', async () => {
  const skillId = await createPublishedSkill(`skill-web-${randomUUID().slice(0, 8)}`, ['web_search@1.0.0'])
  const agentId = `agent-web-${randomUUID().slice(0, 8)}`
  await assert.rejects(createDraftAgent(agentId, { skills: [`${skillId}@1.0.0`] }), /未开启联网搜索/)
  const created = await createDraftAgent(agentId, { skills: [] })
  assert.equal(created.agent.webSearchEnabled, false)
  assert.ok(!(await agents.getRuntimeSnapshot(created.version.id)).runtimeTools.includes('web_search'))
  const enabled = await agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN, skills: [`${skillId}@1.0.0`], webSearchEnabled: true, changeSummary: '开启联网搜索',
  })
  assert.equal(enabled.agent.webSearchEnabled, true)
  assert.ok((await agents.getRuntimeSnapshot(enabled.version.id)).runtimeTools.includes('web_search'))
  // 编辑时省略开关保留当前设置。
  const kept = await agents.updateAgent({ ...enabled.agent, agentId, actor: ADMIN, webSearchEnabled: undefined, changeSummary: '只改说明' })
  assert.equal(kept.agent.webSearchEnabled, true)
  const done = await runValidation(agentId)
  assert.ok(trialRuntime.manifest(done.cases[0]!.runId!)?.tools.some(tool => tool.id === 'web_search'))
})

test('项目任务管理开关随草稿保存与省略保留；不进入默认 runtimeTools', async () => {
  const agentId = `agent-project-tasks-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [] })
  assert.equal(created.agent.projectTasksEnabled, false)
  const enabled = await agents.updateAgent({
    ...created.agent, agentId, actor: ADMIN, projectTasksEnabled: true, changeSummary: '开启项目任务管理',
  })
  assert.equal(enabled.agent.projectTasksEnabled, true)
  assert.equal(enabled.version.projectTasksEnabled, true)
  const [stored] = await database<{ spec: AgentSpec }[]>`
    select agent_spec as spec from agent_versions where tenant_id = ${tenantId} and id = ${enabled.version.id}
  `
  assert.equal(stored?.spec.capabilities.projectTasks, true)
  assert.ok(!(await agents.getRuntimeSnapshot(enabled.version.id)).runtimeTools.includes('project_tasks_list'))
  const kept = await agents.updateAgent({
    ...enabled.agent, agentId, actor: ADMIN, projectTasksEnabled: undefined, changeSummary: '只改说明',
  })
  assert.equal(kept.agent.projectTasksEnabled, true)
})

test('Runtime 停用的内置工具不进入新 Attempt，执行中的 Attempt 不因停用而失败', async () => {
  const runtime = (await operations.getRuntimes()).find(item => item.id === 'runtime-local-01')!
  const configure = (disabledTools: string[]) => operations.updateRuntimeConfiguration({
    runtimeId: runtime.id, maxConcurrentWorkers: 4, attemptTimeoutMinutes: runtime.attemptTimeoutMinutes,
    schedulingStatus: 'accepting', disabledTools, actor: ADMIN,
  })
  await assert.rejects(configure(['activate_skill']), /只能停用 DSH 内置工具/)
  await assert.rejects(configure(['bash']), /只能停用 DSH 内置工具/)
  const agentId = `agent-kill-${randomUUID().slice(0, 8)}`
  await createDraftAgent(agentId, { skills: [], webSearchEnabled: true, examplePrompts: ['执行中停用'] })
  trialRuntime.hold('执行中停用')
  try {
    const started = await validation.startValidation(agentId, ADMIN)
    const running = await waitFor(agentId, started.validation!.id, value => value.cases[0]?.status === 'running', '案例未开始运行')
    const pinned = trialRuntime.manifest(running.cases[0]!.runId!)!
    assert.ok(pinned.tools.some(tool => tool.id === 'web_search'))
    await orchestration.assertCurrentRunAuthorization(pinned)
    const updated = await configure(['web_search'])
    assert.deepEqual(updated?.disabledTools, ['web_search'])
    assert.deepEqual((await operations.getRuntimePolicy(runtime.id)).disabledTools, ['web_search'])
    // 停用不是撤权：执行中的 Attempt 继续运行，被停用工具的下一次调用由 DSH 策略单独拒绝。
    await orchestration.assertCurrentRunAuthorization(pinned)
    trialRuntime.releaseAll()
    await waitFor(agentId, started.validation!.id, completed, '验证未完成')
    // 新 Attempt 不再装配被停用的工具。
    const rerun = await validation.startValidation(agentId, ADMIN)
    const done = await waitFor(agentId, rerun.validation!.id, completed, '新验证未完成')
    const manifest = trialRuntime.manifest(done.cases[0]!.runId!)!
    assert.ok(!manifest.tools.some(tool => tool.id === 'web_search'))
    assert.ok(manifest.tools.some(tool => tool.id === 'read'))
  } finally {
    trialRuntime.releaseAll()
    await configure([])
  }
})

// ---------------------------------------------------------------------------
// 定义、默认工具与生命周期
// ---------------------------------------------------------------------------

test('无 Skill/Tool 的 Soul Agent 可配置创建并验证，默认工具随冻结固定', async () => {
  const agentId = `agent-soul-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [] })
  const [stored] = await database<{ spec: AgentSpec }[]>`
    select agent_spec as spec from agent_versions where tenant_id = ${tenantId} and id = ${created.version.id}
  `
  assert.equal(stored?.spec.apiVersion, 'dsh-work.ai/v2')
  assert.deepEqual(stored?.spec.instructions, { path: 'SOUL.md', body: PROMPT })
  assert.deepEqual(stored?.spec.capabilities, { skills: [], webSearch: false, projectTasks: false })
  const draftSnapshot = await agents.getRuntimeSnapshot(created.version.id)
  assert.ok(draftSnapshot.runtimeTools.includes('read'))
  assert.ok(draftSnapshot.runtimeTools.includes('write'))
  assert.ok(!draftSnapshot.runtimeTools.includes('bash'))
  assert.ok(!draftSnapshot.runtimeTools.includes('web_search'), '联网搜索默认关闭')
  const done = await runValidation(agentId)
  const manifest = trialRuntime.manifest(done.cases[0]!.runId!)
  assert.deepEqual(manifest?.tools.filter(tool => tool.id === 'read' || tool.id === 'write').map(tool => `${tool.id}@${tool.version}`),
    ['read@1.0.0', 'write@1.0.0'])
  // 与员工执行同一权限策略，外部效果由 purpose 隔离。
  const snapshot = await agents.getRuntimeSnapshot(created.version.id)
  assert.equal(manifest?.permission_policy.approval_mode, snapshot.approvalMode)
  assert.equal(manifest?.permission_policy.write_policy, 'workspace_only')
  assert.equal(manifest?.limits.timeout_seconds, snapshot.timeoutSeconds)
  // 试运行与员工执行共用同一 Manifest 构造：工具集、执行身份与输入形状一致，
  // 只是没有工作空间（无文件、无工作空间经验）。
  assert.deepEqual(manifest?.tools.map(tool => tool.id).filter(id => snapshot.runtimeTools.includes(id)),
    snapshot.runtimeTools)
  assert.equal(manifest?.principal_context?.executed_as, snapshot.principalId)
  assert.equal(manifest?.principal_context?.executor_authorization_version, snapshot.principalAuthorizationVersion)
  assert.deepEqual(manifest?.input.file_mounts, [])
  assert.equal(manifest?.memory_context, undefined)
  assert.match(manifest?.trace_id ?? '', new RegExp(`^trace-${done.cases[0]!.runId}-attempt-`))
})

test('基础 Agent 不继承创建者权限；岗位角色必填，授予后无数据范围也能完成验证并发布', async () => {
  const agentId = `agent-basic-${randomUUID().slice(0, 8)}`
  await agents.createAgent({
    id: agentId, name: '文本整理助手', description: '只整理用户本次输入的文字并指出不确定信息。',
    owner: '发布管理员', department: '平台治理', visibleRoleIds: ['role-employee'],
    welcomeMessage: '', examplePrompts: ['请整理这段文字'],
    systemPrompt: '你是独立的文本整理 AI 员工。只处理用户本次提供的文字，不读取企业业务数据。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: [], changeSummary: '创建基础草稿', actor: ADMIN,
  })
  await assert.rejects(validation.startValidation(agentId, ADMIN), /验证前检查未通过：岗位角色/)
  await setAccess(agentId, { roleIds: ['role-employee'] })
  const done = await runValidation(agentId)
  const manifest = trialRuntime.manifest(done.cases[0]!.runId!)
  assert.deepEqual(manifest?.user_context.role_ids, ['role-employee'])
  assert.deepEqual(manifest?.data_scopes, [])
  await approveAll(agentId, done)
  assert.equal((await validation.publish(agentId, ADMIN, { validationId: done.id })).activeVersion?.version, '0.1.0')
})

test('Skill 的工具依赖由平台装配，Agent 版本不保存工具引用', async () => {
  const agentId = `agent-skill-tools-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: ['skill-document@1.0.0'] })
  assert.ok((await validation.getOverview(agentId)).checks.every(check => check.passed))
  const snapshot = await agents.getRuntimeSnapshot(created.version.id)
  assert.deepEqual(snapshot.skillInstructions[0]?.tools, ['read@1.0.0'])
  assert.ok(snapshot.runtimeTools.includes('read'))
  const [columns] = await database<{ count: number }[]>`
    select count(*)::integer as count from information_schema.columns
     where table_name = 'agent_versions' and column_name in ('tool_refs', 'binding_refs')
  `
  assert.equal(columns?.count, 0)
})

test('回滚只移动当前版本指针，停用状态与进行中的草稿保持不变，并拒绝过期回滚', async () => {
  const agentId = `agent-rollback-${randomUUID().slice(0, 8)}`
  const created = await createDraftAgent(agentId, { skills: [] })
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
  const created = await createDraftAgent(agentId, { skills: [] })
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
  await createDraftAgent(agentId, { skills: [] })
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

  /** 已派发 Attempt 的固化 Manifest：用于断言工具集等执行期固定内容。 */
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
