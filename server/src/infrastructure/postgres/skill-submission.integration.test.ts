import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { SkillSubmissionService, MAX_PENDING_SUBMISSIONS } from '../../modules/skill/skill-submission-service.ts'
import { SkillArtifactStore } from '../../modules/skill/skill-artifact-store.ts'
import { LocalObjectStorage } from '../storage/local-object-storage.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const ADMIN = 'U00008'
const EMPLOYEE = 'U00001'
const OTHER = 'U00002'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let agents: PostgresAgentService
let operations: PostgresOperationsService
let skills: PostgresSkillService
let authorization: PostgresAuthorizationService
let submissions: SkillSubmissionService
let scratch: string

// Attempt 创建时持久化的 Manifest 即装配结果；受理后调度器在后台交给 Runtime，测试等到 Runtime 收到再继续。
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
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_skill_submission_test', maxConnections: 3 })
  database = throwaway.client
  scratch = await mkdtemp(join(tmpdir(), 'skill-submission-'))
  operations = new PostgresOperationsService(database)
  const artifactStore = new SkillArtifactStore(new LocalObjectStorage(join(scratch, 'skills')))
  skills = new PostgresSkillService(database, operations, artifactStore)
  agents = new PostgresAgentService(database, operations, skills)
  authorization = new PostgresAuthorizationService(database)
  submissions = new SkillSubmissionService({
    database, skills, authorization, artifactStore, pythonSandboxAvailable: true, pythonPackages: ['openpyxl'],
  })
  // 另一位在职员工，用来确认看不到、不能操作他人的草稿。
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values (${OTHER}, ${tenantId}, ${`directory:skill-submission-${OTHER}`}, '另一位员工', 'active', 'ai-hub', true)
  `
  await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${OTHER}, 'role-employee', 'local')`
  // 替身 Runtime 的运行不会结束；放宽 Runtime 容量，避免后续用例排在占满的容量后面。
  await database`update runtimes set capacity = 32 where tenant_id = ${tenantId}`
})

after(async () => {
  await throwaway.dispose()
  await rm(scratch, { recursive: true, force: true })
})

function orchestration() {
  return new RunOrchestrationService(
    new PostgresRunRepository(database), new PostgresConversationRepository(database),
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)), runtime,
    undefined, operations, agents, undefined, authorization,
  )
}

async function publishedAgent(skillCreationEnabled: boolean) {
  const created = await agents.createAgent({
    id: `agent-skc-${randomUUID().slice(0, 8)}`,
    name: 'Skill 创建专家', description: '把员工反复做的工作写成 Skill。', owner: '平台治理', department: '平台治理',
    welcomeMessage: '', examplePrompts: ['帮我做一个 Skill'], systemPrompt: '你是 Skill 创建专家，帮员工把反复做的工作写成 Skill 草稿。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: [],
    skillCreationEnabled, changeSummary: 'Skill 创建测试', actor: ADMIN,
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

async function runFor(agentVersionId: string, userId = EMPLOYEE) {
  const service = orchestration()
  const session = await service.createSession({ userId, title: 'Skill 创建', agentVersionId })
  const run = (await service.startRun({ userId, sessionId: session.id, prompt: '帮我做一个周报 Skill', idempotencyKey: randomUUID() }))!
  await executedRun(run.id)
  const [attempt] = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${run.id}`
  assert.ok(attempt, '已创建 Attempt')
  return { runId: run.id, manifest: attempt.manifest }
}

/** 在一个临时工作区写出 Skill 目录，模拟专家用 bash 写好的草稿。 */
async function workspaceWith(name: string, options: { requirement?: string; description?: string } = {}) {
  const workspace = await mkdtemp(join(scratch, 'workspace-'))
  const directory = join(workspace, 'drafts', 'weekly')
  await mkdir(join(directory, 'scripts'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${options.description ?? '每周把销售日报汇总成周报。'}\n---\n\n按区域汇总员工上传的一周销售日报，运行 scripts/report.py 计算环比并写一段结论。\n`)
  await writeFile(join(directory, 'scripts', 'report.py'), 'import openpyxl\nprint("ok")\n')
  if (options.requirement) await writeFile(join(directory, 'requirements.txt'), `${options.requirement}\n`)
  return workspace
}

const tools = (manifest: RuntimeManifest) => manifest.tools.map(tool => tool.id)

test('只有开启开关的 Agent 在个人对话中装配两个工具', async () => {
  const withSwitch = await runFor(await publishedAgent(true))
  assert.ok(tools(withSwitch.manifest).includes('list_available_skills'))
  assert.ok(tools(withSwitch.manifest).includes('skill_draft_save'))
  const without = await runFor(await publishedAgent(false))
  assert.equal(tools(without.manifest).some(id => id === 'list_available_skills' || id === 'skill_draft_save'), false)
})

test('员工 AI 同事列表标出开启“可创建 Skill”的 Agent（Skill 广场入口，方案 4.8）', async () => {
  const withSwitch = await publishedAgent(true)
  const without = await publishedAgent(false)
  const listed = await agents.listWorkbenchAgents(EMPLOYEE)
  const byVersion = async (versionId: string) => {
    const [row] = await database<{ agentId: string }[]>`
      select agent_id as "agentId" from agent_versions where tenant_id = ${tenantId} and id = ${versionId}`
    return listed.find(agent => agent.id === row!.agentId)
  }
  assert.equal((await byVersion(withSwitch))?.canCreateSkills, true)
  assert.equal((await byVersion(without))?.canCreateSkills, false)
})

test('保存草稿：按包规则校验，生成新版本，卡片只给提交人看', async () => {
  const { runId, manifest } = await runFor(await publishedAgent(true))
  const listed = await submissions.listAvailableSkills(manifest, {})
  assert.ok(Array.isArray(listed.skills))

  const first = await submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-保存'))
  assert.equal(first.versionNumber, 1)
  assert.equal(first.compatibility.status === 'incompatible', false)
  assert.deepEqual(first.files.filter(file => file.script).map(file => file.path), ['scripts/report.py'])
  const second = await submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-保存', { description: '改过的说明。' }))
  assert.equal(second.submissionId, first.submissionId, '同一会话同名归为一个提交')
  assert.equal(second.versionNumber, 2)

  const cards = await submissions.loadForRuns([runId], EMPLOYEE)
  assert.deepEqual(cards.map(card => [card.versionNumber, card.latest, card.status]), [[1, false, 'draft'], [2, true, 'draft']])
  assert.equal(cards[1]?.description, '改过的说明。')
  assert.deepEqual(await submissions.loadForRuns([runId], OTHER), [], '其他员工看不到')
  const preview = await submissions.readVersionFile(EMPLOYEE, first.submissionId, second.versionId, 'SKILL.md')
  assert.match(preview.content, /^---\nname: 周报汇总-保存/)
  await assert.rejects(submissions.readVersionFile(OTHER, first.submissionId, second.versionId, 'SKILL.md'), { code: 'resource_not_found' })
})

test('不兼容、重名、非法目录的草稿：报告原因，不兼容的版本不能提交', async () => {
  const { manifest } = await runFor(await publishedAgent(true))
  const incompatible = await submissions.saveDraft(manifest, { directory: 'drafts/weekly' },
    await workspaceWith('周报汇总-不兼容', { requirement: 'not-installed-package==1.0' }))
  assert.equal(incompatible.compatibility.status, 'incompatible')
  await assert.rejects(submissions.submit(EMPLOYEE, incompatible.submissionId, incompatible.versionId), /不兼容/)

  await database`
    insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status)
    values ('skill-skc-existing', ${tenantId}, 'skill-skc-existing', '已有的周报', '报告', '已有 Skill。', ${ADMIN}, ${ADMIN}, 'draft')
  `
  await assert.rejects(submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith('已有的周报')), /已有同名 Skill/)
  await assert.rejects(submissions.saveDraft(manifest, { directory: 'output/weekly' }, await workspaceWith('周报汇总-目录')), /不能放在 output/)
  await assert.rejects(submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-缺说明', { description: '' })), { code: 'TOOL_PRECONDITION_FAILED' })
})

test('提交与撤回：只能由本人提交当前版本；待审核时不能保存；同时待审核不超过上限', async () => {
  const { manifest } = await runFor(await publishedAgent(true))
  const saved = await submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-提交'))
  await assert.rejects(submissions.submit(OTHER, saved.submissionId, saved.versionId), { code: 'resource_not_found' })
  const newer = await submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-提交', { description: '第二版。' }))
  await assert.rejects(submissions.submit(EMPLOYEE, saved.submissionId, saved.versionId), /更新的版本/)

  const pending = await submissions.submit(EMPLOYEE, newer.submissionId, newer.versionId)
  assert.equal(pending.status, 'pending')
  assert.ok(pending.submittedAt)
  await assert.rejects(submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-提交')), /已提交审核/)
  await assert.rejects(submissions.withdraw(OTHER, newer.submissionId), { code: 'resource_not_found' })
  assert.equal((await submissions.withdraw(EMPLOYEE, newer.submissionId)).status, 'draft')

  const ids: Array<[string, string]> = []
  for (let index = 0; index <= MAX_PENDING_SUBMISSIONS; index++) {
    const draft = await submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith(`周报汇总-上限-${index}`))
    ids.push([draft.submissionId, draft.versionId])
  }
  const [{ count: alreadyPending }] = await database<{ count: number }[]>`
    select count(*)::integer as count from skill_submissions
     where tenant_id = ${tenantId} and submitter_user_id = ${EMPLOYEE} and status = 'pending'`
  for (const [submissionId, versionId] of ids.slice(0, MAX_PENDING_SUBMISSIONS - alreadyPending)) {
    await submissions.submit(EMPLOYEE, submissionId, versionId)
  }
  const [overflowSubmission, overflowVersion] = ids[MAX_PENDING_SUBMISSIONS - alreadyPending]!
  await assert.rejects(submissions.submit(EMPLOYEE, overflowSubmission, overflowVersion), new RegExp(`已有 ${MAX_PENDING_SUBMISSIONS} 个 Skill 在等待审核`))
})

test('草稿工具只用于员工个人对话', async () => {
  const { manifest } = await runFor(await publishedAgent(true))
  const trial = { ...manifest, purpose: 'agent-release-trial' } as RuntimeManifest
  await assert.rejects(submissions.listAvailableSkills(trial, {}), /只用于员工个人对话/)
  await assert.rejects(submissions.saveDraft({ ...manifest, session_id: null } as RuntimeManifest, { directory: 'drafts/weekly' }, scratch), /只用于员工个人对话/)
})
