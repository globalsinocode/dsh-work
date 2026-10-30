import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { loadBuiltinSkillCatalog, type BuiltinSkillCatalog } from '../../modules/skill/builtin-skills.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { assertCurrentExecutionAuthorization } from '../../modules/run/current-execution-authorization.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const ADMIN = 'U00008'
const catalogRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/builtin-skills')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let catalog: BuiltinSkillCatalog
let skills: PostgresSkillService
let agents: PostgresAgentService
let operations: PostgresOperationsService

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
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_builtin_skills_test', maxConnections: 3 })
  database = throwaway.client
  catalog = loadBuiltinSkillCatalog(catalogRoot)
  operations = new PostgresOperationsService(database, undefined, undefined, 'mock', catalog)
  skills = new PostgresSkillService(database, operations)
  agents = new PostgresAgentService(database, operations, skills)
})

after(async () => {
  await throwaway.dispose()
})

function orchestration() {
  return new RunOrchestrationService(
    new PostgresRunRepository(database), new PostgresConversationRepository(database),
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)), runtime,
    undefined, operations, agents, undefined, undefined,
    { builtinSkills: catalog },
  )
}

async function createAgent(agentSkills: string[] = [], tools: string[] = []) {
  return agents.createAgent({
    id: `agent-bsk-${randomUUID().slice(0, 8)}`,
    name: '资料整理助手', description: '整理员工提供的资料并输出成果。', owner: '平台治理', department: '平台治理',
    welcomeMessage: '', examplePrompts: ['整理资料'], systemPrompt: '你是资料整理助手，只处理当前工作区中已经授权的资料。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: agentSkills, tools,
    changeSummary: '验证平台内置 Skill 装配', actor: ADMIN,
    dataScopes: ['workspace:authorized'],
    executionRoleIds: ['role-employee'], executionDataScopes: ['workspace:authorized'],
  })
}

async function insertPublishedSkill(name: string) {
  const skillId = `skill-bsk-${randomUUID().slice(0, 8)}`
  const versionId = `${skillId}-1`
  await database.begin(async transaction => {
    await transaction`
      insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status)
      values (${skillId}, ${tenantId}, ${skillId}, ${name}, '报告', '生成部门统一样式的报告页面。', ${ADMIN}, ${ADMIN}, 'published')
    `
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, tool_refs, test_prompt, status, created_by, published_by, published_at, change_summary
      ) values (
        ${versionId}, ${tenantId}, ${skillId}, '1.0.0', ${name}, '报告', '生成部门统一样式的报告页面。',
        '按部门模板生成报告页面，标题、配色和页脚使用统一样式。',
        '{}',
        ${transaction.json(['read@1.0.0'])}, '生成报告', 'published', ${ADMIN}, ${ADMIN}, now(), '测试 Skill'
      )
    `
    await transaction`update skills set active_version_id = ${versionId} where tenant_id = ${tenantId} and id = ${skillId}`
  })
  return { skillId, reference: `${skillId}@1.0.0` }
}

async function manifestFor(agentVersionId: string, selected?: { skillId: string; reference: string }) {
  const service = orchestration()
  const session = await service.createSession({
    userId: 'U00001', title: '内置 Skill 装配', agentVersionId,
    ...(selected ? { selectedSkillVersionId: `${selected.skillId}-1`, selectedSkillReference: selected.reference } : {}),
  })
  const run = (await service.startRun({ userId: 'U00001', sessionId: session.id, prompt: '把资料整理成报告', idempotencyKey: randomUUID() }))!
  const [attempt] = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${run.id}`
  assert.ok(attempt, '已创建 Attempt')
  return attempt.manifest
}

const ref = (scenario: string) => {
  const skill = catalog.skills.find(item => item.scenario === scenario)!
  return { id: skill.id, reference: `${skill.id}@${skill.version}` }
}

const runtimeRow = async () => (await operations.getRuntimes()).find(item => item.id === 'runtime-local-01')!
async function setDisabledBuiltinSkills(disabledBuiltinSkills: string[] | undefined) {
  const current = await runtimeRow()
  return operations.updateRuntimeConfiguration({
    runtimeId: current.id, maxConcurrentWorkers: current.maxConcurrentWorkers,
    attemptTimeoutMinutes: current.attemptTimeoutMinutes, schedulingStatus: 'draining',
    disabledBuiltinSkills, actor: ADMIN,
  })
}

test('迁移新增覆盖场景与内置 Skill 停用清单，默认均为空', async () => {
  const [skill] = await database<{ value: unknown }[]>`select covered_builtin_scenarios as value from skills where tenant_id = ${tenantId} limit 1`
  assert.deepEqual(skill?.value, [])
  assert.deepEqual((await operations.getRuntimePolicy('runtime-local-01')).disabledBuiltinSkills, [])
})

test('未配置 Skill 的 Agent：员工对话以内联形式装配全部内置 Skill，并提供 activate_skill', async () => {
  const created = await createAgent()
  const manifest = await manifestFor(created.version.id)
  const builtin = catalog.skills.map(skill => `${skill.id}@${skill.version}`)
  assert.deepEqual(manifest.skills.map(skill => `${skill.id}@${skill.version}`), builtin)
  assert.deepEqual(manifest.agent_configuration.skill_instructions.map(skill => skill.id), catalog.skills.map(skill => skill.id))
  for (const skill of manifest.agent_configuration.skill_instructions) {
    assert.equal(skill.artifact_ref, undefined)
    assert.ok((skill.instructions ?? '').length > 200, '正文随 Manifest 留存')
  }
  assert.ok(manifest.tools.some(tool => tool.id === 'activate_skill'))
  assert.equal(manifest.builtin_skill_exclusions, undefined)
  const [rows] = await database<{ count: number }[]>`select count(*)::integer as count from skills where tenant_id = ${tenantId} and id like 'dsh-work-%'`
  assert.equal(rows?.count, 0, '内置 Skill 不写入 Skill 表')
})

test('标记覆盖 html-page 的 Skill 让位对应内置 Skill，未标记的并存', async () => {
  const report = await insertPublishedSkill('部门报告页面')
  const plain = await createAgent([report.reference])
  let manifest = await manifestFor(plain.version.id)
  assert.equal(manifest.skills[0]?.id, report.skillId, '已安装 Skill 排在内置 Skill 之前')
  assert.equal(manifest.skills.length, 4, '未标记覆盖时并存')

  await assert.rejects(skills.setCoveredBuiltinScenarios({ skillId: report.skillId, scenarios: ['chart'], actor: ADMIN }), /未知的内置场景/)
  const updated = await skills.setCoveredBuiltinScenarios({ skillId: report.skillId, scenarios: ['html-page', 'html-page'], actor: ADMIN })
  assert.deepEqual(updated.coveredBuiltinScenarios, ['html-page'])
  const [audit] = await database<{ action: string }[]>`
    select action from audit_events where tenant_id = ${tenantId} and object_id = ${report.skillId} and action = 'skill.builtin_cover.update'`
  assert.ok(audit, '写审计')

  manifest = await manifestFor(plain.version.id)
  const html = ref('html-page')
  assert.equal(manifest.skills.some(skill => skill.id === html.id), false)
  assert.deepEqual(manifest.builtin_skill_exclusions, [{ skill: html.reference, reason: 'covered', covered_by: report.reference }])
  assert.equal(manifest.skills.filter(skill => skill.id.startsWith('dsh-work-')).length, 2, '另两个内置 Skill 仍在')

  // Skill 广场：员工在会话中选择标记覆盖的 Skill，同样只对该会话生效。
  // 会话临时选用的 Skill 仍须落在 Agent 已授权的工具内。
  const bare = await createAgent([], ['read@1.0.0'])
  manifest = await manifestFor(bare.version.id, report)
  assert.deepEqual(manifest.builtin_skill_exclusions, [{ skill: html.reference, reason: 'covered', covered_by: report.reference }])
  assert.ok((await manifestFor(bare.version.id)).skills.some(skill => skill.id === html.id), '未选择时仍提供')
})

test('Runtime 紧急停用内置 Skill：新运行不装配并记录原因，只接受注册的内置 Skill，省略时保留', async () => {
  const analysis = ref('file-analysis')
  await assert.rejects(setDisabledBuiltinSkills(['skill-report']), /只能停用平台内置 Skill/)
  try {
    assert.deepEqual((await setDisabledBuiltinSkills([analysis.id, analysis.id]))?.disabledBuiltinSkills, [analysis.id])
    assert.deepEqual((await setDisabledBuiltinSkills(undefined))?.disabledBuiltinSkills, [analysis.id])
    const created = await createAgent()
    const manifest = await manifestFor(created.version.id)
    assert.equal(manifest.skills.some(skill => skill.id === analysis.id), false)
    assert.deepEqual(manifest.builtin_skill_exclusions, [{ skill: analysis.reference, reason: 'disabled' }])
  } finally {
    await setDisabledBuiltinSkills([])
  }
})

test('安装与旧文本接口拒绝内置 Skill 的保留名称', async () => {
  await assert.rejects(skills.createSkill({
    name: 'HTML 页面（平台内置）', category: '报告', description: '冒用内置 Skill 名称的测试 Skill。',
    instructions: '按部门模板生成报告页面，标题、配色和页脚使用统一样式。', toolIds: [], testPrompt: '生成报告', actor: ADMIN,
  }), /保留给平台内置 Skill/)
})

test('团队空间只授权 Agent 时，执行前复核不把内置 Skill 当作需要空间授权的 Skill', async () => {
  const authorization = new PostgresAuthorizationService(database)
  const workspaceId = `ws-bsk-team-${randomUUID().slice(0, 8)}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '内置 Skill 团队空间', '', 'team', 'U00001', 'active')
  `
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${workspaceId}, 'U00001', 'owner', 'U00001')
  `
  const created = await createAgent()
  await database`update agent_versions set status = 'published' where tenant_id = ${tenantId} and id = ${created.version.id}`
  await database`
    update agents set status = 'published', visible_role_ids = ${database.json(['role-employee'])}, active_version_id = ${created.version.id}, draft_version_id = null
     where tenant_id = ${tenantId} and id = ${created.agent.id}
  `
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, ${workspaceId}, 'agent', ${created.version.id})
  `
  const builtin = catalog.skills.map(skill => ({ id: skill.id, version: skill.version }))
  const manifest = {
    workspace_id: workspaceId, agent_version_id: created.version.id,
    user_context: { user_id: 'U00001', tenant_id: tenantId, role_ids: [] },
    skills: builtin, data_scopes: [], input: { message: '整理资料', file_mounts: [] },
  } as unknown as RuntimeManifest

  await assertCurrentExecutionAuthorization(authorization, undefined, manifest)
  // 对照：内置 Skill 若被当作附加 Skill，空间没有 Skill 授权时会被拒绝。
  await assert.rejects(authorization.authorizeTeamRunExecution({
    userId: 'U00001', workspaceId, agentVersionId: created.version.id,
    additionalSkillReferences: builtin.map(skill => `${skill.id}@${skill.version}`),
  }), /Skill/)
})

