import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
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
const EMPLOYEE = 'U00001'
const SALES = 'role-skill-visibility-sales'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let skills: PostgresSkillService
let agents: PostgresAgentService
let operations: PostgresOperationsService
let authorization: PostgresAuthorizationService

// Attempt 创建时持久化的 Manifest 即执行快照；Runtime 不需要真正执行。受理后调度器在后台复核并交给
// Runtime，测试等到 Runtime 收到该 Run 再继续，避免后台查询落在测试结束之后。
const executed = new Map<string, () => void>()
const executions = new Map<string, Promise<void>>()
function executedRun(runId: string) {
  if (!executions.has(runId)) executions.set(runId, new Promise(resolve => executed.set(runId, resolve)))
  return executions.get(runId)!
}
const runtime: AgentRuntimePort = {
  async execute(manifest) {
    void executedRun(manifest.run_id)
    executed.get(manifest.run_id)!()
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
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_skill_visibility_test', maxConnections: 3 })
  database = throwaway.client
  operations = new PostgresOperationsService(database)
  skills = new PostgresSkillService(database, operations)
  agents = new PostgresAgentService(database, operations, skills)
  authorization = new PostgresAuthorizationService(database)
  await database`
    insert into roles (id, tenant_id, code, name, permissions)
    values (${SALES}, ${tenantId}, 'skill-visibility-sales', '销售部', '[]')
  `
})

after(async () => {
  await throwaway.dispose()
})

function orchestration() {
  return new RunOrchestrationService(
    new PostgresRunRepository(database), new PostgresConversationRepository(database),
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)), runtime,
    undefined, operations, agents, undefined, authorization,
  )
}

async function setSales(granted: boolean) {
  if (granted) {
    await database`
      insert into user_roles (tenant_id, user_id, role_id) values (${tenantId}, ${EMPLOYEE}, ${SALES})
      on conflict do nothing`
  } else {
    await database`delete from user_roles where tenant_id = ${tenantId} and user_id = ${EMPLOYEE} and role_id = ${SALES}`
  }
}

async function employeeRoles() {
  return (await authorization.authorizeWorkbench({ userId: EMPLOYEE })).roleIds
}

async function insertPublishedSkill(name: string) {
  const skillId = `skill-vis-${randomUUID().slice(0, 8)}`
  const versionId = `${skillId}-1`
  await database.begin(async transaction => {
    await transaction`
      insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status)
      values (${skillId}, ${tenantId}, ${skillId}, ${name}, '报告', '汇总销售日报。', ${ADMIN}, ${ADMIN}, 'published')
    `
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, tool_refs, test_prompt, status, created_by, published_by, published_at, change_summary
      ) values (
        ${versionId}, ${tenantId}, ${skillId}, '1.0.0', ${name}, '报告', '汇总销售日报。',
        '按区域汇总员工上传的一周销售日报，计算环比并写一段结论。', '{}',
        ${transaction.json(['read@1.0.0'])}, '汇总日报', 'published', ${ADMIN}, ${ADMIN}, now(), '测试 Skill'
      )
    `
    await transaction`update skills set active_version_id = ${versionId} where tenant_id = ${tenantId} and id = ${skillId}`
  })
  return { skillId, versionId, reference: `${skillId}@1.0.0` }
}

async function publishedAgent(agentSkills: string[] = []) {
  const created = await agents.createAgent({
    id: `agent-vis-${randomUUID().slice(0, 8)}`,
    name: '周报助手', description: '整理员工提供的日报。', owner: '平台治理', department: '平台治理',
    welcomeMessage: '', examplePrompts: ['整理周报'], systemPrompt: '你是周报助手，只处理当前工作区中已经授权的资料。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: agentSkills,
    changeSummary: 'Skill 可见范围测试', actor: ADMIN,
    executionRoleIds: ['role-employee'], executionDataScopes: ['workspace:authorized'],
  })
  await database`update agent_versions set status = 'published' where tenant_id = ${tenantId} and id = ${created.version.id}`
  await database`
    update agents set status = 'published', active_version_id = ${created.version.id}, draft_version_id = null,
                      visible_role_ids = ${database.json(['role-employee'])}
     where tenant_id = ${tenantId} and id = ${created.agent.id}
  `
  return created.version.id
}

const restrict = (skillId: string, roleIds: string[] | null) =>
  skills.setVisibleRoles({ skillId, roleIds, reason: '只给销售部使用', actor: ADMIN })
const visibleNames = async () => (await skills.listWorkbenchSkills(await employeeRoles())).map(item => item.name)

test('存量 Skill 默认全员可见；可见范围只接受全员或非空的现存角色，并写审计', async () => {
  const skill = await insertPublishedSkill('周报汇总-校验')
  const [row] = await database<{ value: unknown }[]>`select visible_role_ids as value from skills where tenant_id = ${tenantId} and id = ${skill.skillId}`
  assert.equal(row?.value, null)
  assert.ok((await visibleNames()).includes('周报汇总-校验'))

  await assert.rejects(restrict(skill.skillId, []), /非空的角色 ID 列表/)
  await assert.rejects(restrict(skill.skillId, ['role-not-exists']), /角色不存在或已停用/)
  await assert.rejects(skills.setVisibleRoles({ skillId: skill.skillId, roleIds: [SALES], reason: ' ', actor: ADMIN }), /调整原因/)
  await assert.rejects(skills.setVisibleRoles({ skillId: skill.skillId, roleIds: [SALES], reason: '原因', actor: EMPLOYEE }), /不是平台管理员/)

  const updated = await restrict(skill.skillId, [SALES, SALES])
  assert.deepEqual(updated.visibleRoleIds, [SALES])
  const [audit] = await database<{ detail: string }[]>`
    select action from audit_events where tenant_id = ${tenantId} and object_id = ${skill.skillId} and action = 'skill.visibility.update'`
  assert.ok(audit, '写审计')
  assert.equal((await restrict(skill.skillId, null)).visibleRoleIds, null)
})

test('Skill 广场与会话选择按员工当前角色过滤', async () => {
  const skill = await insertPublishedSkill('周报汇总-广场')
  await restrict(skill.skillId, [SALES])
  await setSales(false)
  assert.equal((await visibleNames()).includes('周报汇总-广场'), false)
  await assert.rejects(skills.resolveWorkbenchSkillVersion(skill.skillId, await employeeRoles()), { code: 'permission_denied' })

  await setSales(true)
  try {
    assert.ok((await visibleNames()).includes('周报汇总-广场'))
    assert.equal((await skills.resolveWorkbenchSkillVersion(skill.skillId, await employeeRoles())).reference, skill.reference)
  } finally {
    await setSales(false)
  }
})

test('员工失去角色后，发送与执行前复核都拒绝所选 Skill；恢复全员后放行', async () => {
  const skill = await insertPublishedSkill('周报汇总-复核')
  const agentVersionId = await publishedAgent()
  await restrict(skill.skillId, [SALES])
  await setSales(true)
  const service = orchestration()
  const session = await service.createSession({
    userId: EMPLOYEE, title: '可见范围复核', agentVersionId,
    selectedSkillVersionId: skill.versionId, selectedSkillReference: skill.reference,
  })
  const run = (await service.startRun({ userId: EMPLOYEE, sessionId: session.id, prompt: '汇总本周日报', idempotencyKey: randomUUID() }))!
  await executedRun(run.id)
  const [attempt] = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${run.id}`
  assert.ok(attempt, '有权限时正常受理')
  assert.equal(await authorization.sessionSelectedSkillReference(session.id), skill.reference)
  await assertCurrentExecutionAuthorization(authorization, undefined, attempt.manifest)

  await setSales(false)
  await assert.rejects(
    service.startRun({ userId: EMPLOYEE, sessionId: session.id, prompt: '再汇总一次', idempotencyKey: randomUUID() }),
    { code: 'permission_denied' },
  )
  await assert.rejects(assertCurrentExecutionAuthorization(authorization, undefined, attempt.manifest), { code: 'permission_denied' })

  await restrict(skill.skillId, null)
  await assertCurrentExecutionAuthorization(authorization, undefined, attempt.manifest)
})

test('Agent 固定引用的 Skill 不受可见范围限制', async () => {
  const skill = await insertPublishedSkill('周报汇总-固定')
  const agentVersionId = await publishedAgent([skill.reference])
  await restrict(skill.skillId, [SALES])
  await setSales(false)
  const service = orchestration()
  const session = await service.createSession({ userId: EMPLOYEE, title: '固定引用', agentVersionId })
  const run = (await service.startRun({ userId: EMPLOYEE, sessionId: session.id, prompt: '汇总本周日报', idempotencyKey: randomUUID() }))!
  await executedRun(run.id)
  const [attempt] = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${run.id}`
  assert.ok(attempt?.manifest.skills.some(item => item.id === skill.skillId), 'Manifest 装配了固定 Skill')
  assert.equal(await authorization.sessionSelectedSkillReference(session.id), null)
  await assertCurrentExecutionAuthorization(authorization, undefined, attempt!.manifest)
})
