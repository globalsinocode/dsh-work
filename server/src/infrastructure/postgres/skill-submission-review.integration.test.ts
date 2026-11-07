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
import { SkillSubmissionService } from '../../modules/skill/skill-submission-service.ts'
import { SkillArtifactStore } from '../../modules/skill/skill-artifact-store.ts'
import { LocalObjectStorage } from '../storage/local-object-storage.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Router } from '../../http/router.ts'
import { testApiAuthenticator } from '../../testing/test-identity.ts'
import { registerSkillSubmissionReviewRoutes } from '../../http/admin/skill-submission-review-routes.ts'
import { SkillSubmissionReviewService } from '../../modules/skill/skill-submission-review-service.ts'
import { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import type { RuntimeSkillConfiguration } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresRunRepository as RunEvents } from '../../modules/run/postgres-run-repository.ts'

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
let reviews: SkillSubmissionReviewService
let trialOutcome: 'passed' | 'failed' = 'passed'
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
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_skill_submission_review_test', maxConnections: 3 })
  database = throwaway.client
  scratch = await mkdtemp(join(tmpdir(), 'skill-submission-review-'))
  operations = new PostgresOperationsService(database)
  const artifactStore = new SkillArtifactStore(new LocalObjectStorage(join(scratch, 'skills')))
  skills = new PostgresSkillService(database, operations, artifactStore)
  agents = new PostgresAgentService(database, operations, skills)
  authorization = new PostgresAuthorizationService(database)
  submissions = new SkillSubmissionService({
    database, skills, authorization, artifactStore, pythonSandboxAvailable: true, pythonPackages: ['openpyxl'],
  })
  reviews = new SkillSubmissionReviewService({ database, skills, artifactStore, audit: operations })
  // 合成的严格试运行证据（不调用模型、不运行容器）：按 trialOutcome 写入激活与 Python 执行证据，
  // 由真实的 packageTestProgress 判定并经现有发布门禁核对。
  const installation = new AdminSkillInstallationService(database, {} as never, authorization)
  skills.setPackageTestLifecycle({
    start: (userId, skill, prompt) => seedTrial(installation, userId, skill, prompt),
    progress: (userId, skill, runId) => installation.packageTestProgress(userId, skill, runId),
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


async function seedTrial(installation: AdminSkillInstallationService, userId: string, skill: RuntimeSkillConfiguration, prompt: string) {
  const sessionId = `admin-session-${randomUUID()}`, runId = `run-${randomUUID()}`, attemptId = `attempt-${randomUUID()}`
  await database`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
    values (${sessionId}, ${tenantId}, ${userId}, '合成审核试运行', 'active', 'admin', null, null)`
  await database`insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${randomUUID()}, 'queued')`
  const manifest = { purpose: 'admin-skill-test', run_id: runId, session_id: sessionId, attempt_id: attemptId,
    skills: [{ id: skill.id, version: skill.version }], input: { message: prompt, file_mounts: [] },
    agent_configuration: { system_prompt: '合成证据，不是模型运行', skill_instructions: [skill] } }
  await database`insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${attemptId}, ${tenantId}, ${runId}, 1, ${database.json(JSON.parse(JSON.stringify(manifest)))}, ${'a'.repeat(64)}, '{}'::jsonb, 'succeeded')`
  await database`update runs set current_attempt_id = ${attemptId}, status = 'succeeded' where id = ${runId}`
  await database`insert into skill_runtime_activations (id, tenant_id, run_id, attempt_id, skill_id, skill_version, content_sha256)
    values (${randomUUID()}, ${tenantId}, ${runId}, ${attemptId}, ${skill.id}, ${skill.version}, ${'a'.repeat(64)})`
  for (const file of (skill.files ?? []).filter(item => item.path.endsWith('.py'))) {
    await database`insert into skill_python_executions (id, tenant_id, run_id, attempt_id, skill_id, entry_path, succeeded)
      values (${randomUUID()}, ${tenantId}, ${runId}, ${attemptId}, ${skill.id}, ${file.path}, ${trialOutcome === 'passed'})`
  }
  await new RunEvents(database).appendEvent({ id: randomUUID(), tenantId, runId, attemptId, sequence: 1,
    eventType: 'assistant.completed', displayMessage: '周报已生成。', safeMetadata: { synthetic: true },
    traceId: `trace-${runId}`, occurredAt: new Date().toISOString() })
  return installation.packageTestProgress(userId, skill, runId)
}

/** 员工保存并提交一份草稿，返回提交、版本与保存它的 Run。 */
async function pendingSubmission(name: string, agentVersionId?: string) {
  const { runId, manifest } = await runFor(agentVersionId ?? await publishedAgent(true))
  const saved = await submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith(name))
  await submissions.submit(EMPLOYEE, saved.submissionId, saved.versionId)
  return { ...saved, runId, manifest }
}

async function card(runId: string) {
  const cards = await submissions.loadForRuns([runId], EMPLOYEE)
  return cards.at(-1)!
}

test('待审核列表与详情：未试运行不能发布；试运行通过后选择可见范围发布，卡片显示已发布', async () => {
  const submitted = await pendingSubmission('周报汇总-审核通过')
  const listed = (await reviews.listPending()).find(item => item.id === submitted.submissionId)
  assert.ok(listed)
  assert.equal(listed.source, 'conversation')
  assert.equal(listed.scriptCount, 1)
  assert.equal(listed.trial.status, 'not_started')
  assert.equal(listed.submitter.id, EMPLOYEE)
  const detail = await reviews.getDetail(submitted.submissionId)
  assert.deepEqual(detail.files.filter(file => file.script).map(file => file.path), ['scripts/report.py'])
  const script = await reviews.readVersionFile(submitted.submissionId, submitted.versionId, 'scripts/report.py')
  assert.match(script.content, /openpyxl/)

  await assert.rejects(reviews.approve(ADMIN, submitted.submissionId, { versionId: submitted.versionId, visibleRoleIds: null }), /严格试运行/)
  await assert.rejects(reviews.startTrial(EMPLOYEE, submitted.submissionId, submitted.versionId), /不是平台管理员/)
  const trial = await reviews.startTrial(ADMIN, submitted.submissionId, submitted.versionId)
  assert.equal(trial.status, 'passed', trial.resultSummary)
  assert.equal((await reviews.getDetail(submitted.submissionId)).trial.status, 'passed')

  // 审核前不进入 Skill 列表，也不能从 Skill 详情直接发布。
  const skillId = (await reviews.getDetail(submitted.submissionId)).trial.skillId!
  assert.equal((await skills.getSkills()).some(skill => skill.id === skillId), false)
  await assert.rejects(skills.setStatus({ skillId, status: 'published', actor: ADMIN }), /待审核/)

  await assert.rejects(reviews.approve(ADMIN, submitted.submissionId, { versionId: submitted.versionId, visibleRoleIds: [] }), /非空的角色/)
  const approved = await reviews.approve(ADMIN, submitted.submissionId, { versionId: submitted.versionId, visibleRoleIds: ['role-employee'] })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.skill.status, 'published')
  assert.deepEqual(approved.skill.visibleRoleIds, ['role-employee'])
  assert.ok((await skills.getSkills()).some(skill => skill.id === skillId))
  const published = (await skills.listWorkbenchSkills(['role-employee'])).find(skill => skill.id === skillId)
  assert.ok(published)
  // 平台默认的试运行提示语只给管理员验证用，员工端不当作“推荐提问”，也不预填进输入框。
  assert.equal(published.testPrompt, '')
  assert.ok((await skills.getSkills()).find(skill => skill.id === skillId)?.testPrompt, '管理端仍保留试运行提示语')
  assert.equal((await skills.listWorkbenchSkills([])).some(skill => skill.id === skillId), false, '指定角色发布后对其他角色不可见')
  assert.equal((await card(submitted.runId)).status, 'approved')
  assert.equal((await reviews.listPending()).some(item => item.id === submitted.submissionId), false)
  const [audit] = await database<{ count: number }[]>`
    select count(*)::integer as count from audit_events where tenant_id = ${tenantId} and action = 'skill.submission.approve' and object_id = ${submitted.submissionId}`
  assert.equal(audit?.count, 1)
  // NC-04：审核结论通知提交人，跳转到提交时的对话。
  assert.deepEqual(await reviewNotifications(submitted.submissionId), [{ recipient: EMPLOYEE, result: 'approved', actor: ADMIN }])
})

test('拒绝必须填写原因；只能审核管理员看到的版本；卡片显示拒绝原因并释放待发布版本', async () => {
  const submitted = await pendingSubmission('周报汇总-拒绝')
  await reviews.startTrial(ADMIN, submitted.submissionId, submitted.versionId)
  await assert.rejects(reviews.reject(ADMIN, submitted.submissionId, { versionId: submitted.versionId, note: '  ' }), /拒绝原因/)
  await assert.rejects(reviews.reject(ADMIN, submitted.submissionId, { versionId: 'skill-submission-version-other', note: '不合适' }), /版本已变化/)
  const rejected = await reviews.reject(ADMIN, submitted.submissionId, { versionId: submitted.versionId, note: '请写清每个区域的数据来源。' })
  assert.equal(rejected.status, 'rejected')
  const rejectedCard = await card(submitted.runId)
  assert.equal(rejectedCard.status, 'rejected')
  assert.equal(rejectedCard.reviewNote, '请写清每个区域的数据来源。')
  // NC-04：拒绝也通知提交人；通知只带结论代码，拒绝原因留在草稿卡片上。
  assert.deepEqual(await reviewNotifications(submitted.submissionId), [{ recipient: EMPLOYEE, result: 'rejected', actor: ADMIN }])
  const [stored] = await database<{ metadata: string }[]>`
    select safe_metadata::text as metadata from user_notifications where tenant_id = ${tenantId} and object_id = ${submitted.submissionId}`
  assert.equal(stored?.metadata.includes('数据来源'), false)
  const [skill] = await database<{ draft: string | null }[]>`
    select draft_version_id as draft from skills where tenant_id = ${tenantId} and id = ${rejected.trial.skillId ?? ''}`
  assert.equal(skill?.draft ?? null, null)
  await assert.rejects(reviews.approve(ADMIN, submitted.submissionId, { versionId: submitted.versionId, visibleRoleIds: null }), /已撤回或已审核/)

  const [retired] = await database<{ status: string; installation: string }[]>`
    select sv.status, i.status as installation from skill_versions sv
      join skill_installations i on i.tenant_id = sv.tenant_id and i.version_id = sv.id
     where sv.tenant_id = ${tenantId} and sv.skill_id = ${rejected.trial.skillId ?? ''}`
  assert.deepEqual(retired, { status: 'disabled', installation: 'cancelled' }, '被拒版本存下的待发布版本作废')

  // 被拒后在原会话修改：生成新版本，可重新提交。
  const revised = await submissions.saveDraft(submitted.manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-拒绝', { description: '补充了数据来源。' }))
  assert.equal(revised.versionNumber, 2)
  assert.equal((await submissions.submit(EMPLOYEE, revised.submissionId, revised.versionId)).status, 'pending')
})

test('试运行未通过时不能发布；员工撤回会释放待发布版本，原样再提交沿用已有证据', async () => {
  trialOutcome = 'failed'
  try {
    const submitted = await pendingSubmission('周报汇总-未通过')
    const failed = await reviews.startTrial(ADMIN, submitted.submissionId, submitted.versionId)
    assert.equal(failed.status, 'failed')
    assert.equal((await reviews.getDetail(submitted.submissionId)).trial.status, 'failed')
    await assert.rejects(reviews.approve(ADMIN, submitted.submissionId, { versionId: submitted.versionId, visibleRoleIds: null }), /测试/)
  } finally {
    trialOutcome = 'passed'
  }

  const submitted = await pendingSubmission('周报汇总-撤回')
  await reviews.startTrial(ADMIN, submitted.submissionId, submitted.versionId)
  const skillId = (await reviews.getDetail(submitted.submissionId)).trial.skillId!
  await submissions.withdraw(EMPLOYEE, submitted.submissionId)
  const [released] = await database<{ draft: string | null }[]>`select draft_version_id as draft from skills where tenant_id = ${tenantId} and id = ${skillId}`
  assert.equal(released?.draft ?? null, null)
  await assert.rejects(reviews.getDetail(submitted.submissionId), /已撤回/)
  await submissions.submit(EMPLOYEE, submitted.submissionId, submitted.versionId)
  assert.equal((await reviews.getDetail(submitted.submissionId)).trial.status, 'passed')
  // 不再试运行，直接通过：待发布版本指回已存的版本，沿用已有证据。
  const [{ count: trialsBefore }] = await database<{ count: number }[]>`
    select count(*)::integer as count from skill_test_bindings where tenant_id = ${tenantId} and skill_id = ${skillId}`
  assert.equal((await reviews.approve(ADMIN, submitted.submissionId, { versionId: submitted.versionId, visibleRoleIds: null })).status, 'approved')
  const [{ count: trialsAfter }] = await database<{ count: number }[]>`
    select count(*)::integer as count from skill_test_bindings where tenant_id = ${tenantId} and skill_id = ${skillId}`
  assert.equal(trialsAfter, trialsBefore)
})

test('已发布 Skill 的修订：同一 Skill 的新版本，重新审核后发布', async () => {
  const agentVersionId = await publishedAgent(true)
  const first = await pendingSubmission('周报汇总-修订', agentVersionId)
  await reviews.startTrial(ADMIN, first.submissionId, first.versionId)
  const approved = await reviews.approve(ADMIN, first.submissionId, { versionId: first.versionId, visibleRoleIds: ['role-employee'] })
  const revised = await submissions.saveDraft(first.manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-修订', { description: '第二版周报。' }))
  await submissions.submit(EMPLOYEE, revised.submissionId, revised.versionId)
  const listed = (await reviews.listPending()).find(item => item.id === first.submissionId)
  assert.equal(listed?.publishedSkillId, approved.skill.id)
  assert.deepEqual(listed?.publishedVisibleRoleIds, ['role-employee'], '审核修订时能看到当前可见范围')
  await reviews.startTrial(ADMIN, revised.submissionId, revised.versionId)
  const published = await reviews.approve(ADMIN, revised.submissionId, { versionId: revised.versionId, visibleRoleIds: ['role-employee'] })
  assert.equal(published.skill.id, approved.skill.id)
  assert.equal(published.skill.version, '0.2.0')
  assert.equal(published.skill.description, '第二版周报。')
})

test('审核接口：非管理员无权限', async () => {
  const router = new Router({ authenticateApi: async (request, audience) => {
    const identity = await testApiAuthenticator(request, audience)
    return request.headers['x-test-employee'] === 'true' ? { ...identity, userId: EMPLOYEE, permissions: [] } : identity
  } })
  registerSkillSubmissionReviewRoutes(router, reviews)
  const server = createServer((request, response) => { void router.handle(request, response) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const url = `http://127.0.0.1:${address.port}/api/admin/v1/skill-submissions`
    const asAdmin = await fetch(url)
    assert.equal(asAdmin.status, 200)
    const asEmployee = await fetch(url, { headers: { 'x-test-employee': 'true' } })
    assert.equal(asEmployee.status, 403)
  } finally {
    server.close()
  }
})

test('撤回后修改再提交：此前存下的待发布版本作废，新版本可通过', async () => {
  const submitted = await pendingSubmission('周报汇总-改后再提交')
  await reviews.startTrial(ADMIN, submitted.submissionId, submitted.versionId)
  const skillId = (await reviews.getDetail(submitted.submissionId)).trial.skillId!
  await submissions.withdraw(EMPLOYEE, submitted.submissionId)
  const revised = await submissions.saveDraft(submitted.manifest, { directory: 'drafts/weekly' }, await workspaceWith('周报汇总-改后再提交', { description: '改过的周报。' }))
  await submissions.submit(EMPLOYEE, revised.submissionId, revised.versionId)
  await reviews.startTrial(ADMIN, revised.submissionId, revised.versionId)
  const versions = await database<{ status: string; description: string }[]>`
    select status, description from skill_versions where tenant_id = ${tenantId} and skill_id = ${skillId} order by created_at`
  assert.deepEqual(versions.map(row => row.status), ['disabled', 'draft'])
  const approved = await reviews.approve(ADMIN, revised.submissionId, { versionId: revised.versionId, visibleRoleIds: null })
  assert.equal(approved.skill.description, '改过的周报。')
})

test('草稿重名检查与安装同一规范化：忽略大小写与首尾空白', async () => {
  await database`
    insert into skills (id, tenant_id, key, installation_key, name, category, description, owner_user_id, created_by, status)
    values ('skill-skc-weekly-en', ${tenantId}, 'skill-skc-weekly-en', 'weekly summary', 'Weekly Summary', '报告', '已有 Skill。', ${ADMIN}, ${ADMIN}, 'draft')
  `
  const { manifest } = await runFor(await publishedAgent(true))
  await assert.rejects(submissions.saveDraft(manifest, { directory: 'drafts/weekly' }, await workspaceWith('weekly summary')), /已有同名 Skill/)
})

/** 站内通知 NC-S3：某个提交的审核结论通知。 */
async function reviewNotifications(submissionId: string) {
  const rows = await database<{ recipient: string; result: string; actor: string | null }[]>`
    select recipient_user_id as recipient, safe_metadata ->> 'result' as result, actor_user_id as actor
      from user_notifications
     where tenant_id = ${tenantId} and kind = 'skill_review_result' and object_id = ${submissionId}
     order by created_at`
  return rows.map(row => ({ recipient: row.recipient, result: row.result, actor: row.actor }))
}
