/**
 * SKC-02 P1 浏览器夹具：管理员审核员工 Skill 提交（docs/design/skill-creator-plan.md 4.4）。
 *
 * 一次性 PostgreSQL 上运行真实的 Skill 服务、审核服务与发布门禁；两条待审核提交由测试接口准备。
 * 严格试运行是合成证据：名称含“会议纪要”的提交停在运行中（未完成），其余写入激活与 Python 退出码 0
 * 的证据后由真实 packageTestProgress 判定。不调用模型、不运行容器，不连接 OIDC 或生产 DSH。
 */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createThrowawayDatabase } from '../../server/src/infrastructure/postgres/test-database.ts'
import { LocalObjectStorage } from '../../server/src/infrastructure/storage/local-object-storage.ts'
import { testApiAuthenticator } from '../../server/src/testing/test-identity.ts'
import { envelope, Router, requireRequestIdentity } from '../../server/src/http/router.ts'
import { registerSkillRoutes } from '../../server/src/http/admin/skill-routes.ts'
import { registerSkillSubmissionReviewRoutes } from '../../server/src/http/admin/skill-submission-review-routes.ts'
import { PostgresAuthorizationService } from '../../server/src/modules/authorization/postgres-authorization-service.ts'
import { PostgresOperationsService } from '../../server/src/modules/admin/application/postgres-operations-service.ts'
import { PostgresRunRepository } from '../../server/src/modules/run/postgres-run-repository.ts'
import { AdminSkillInstallationService } from '../../server/src/modules/skill/admin-skill-installation-service.ts'
import { PostgresSkillService, type RuntimeSkillConfiguration } from '../../server/src/modules/skill/postgres-skill-service.ts'
import { SkillArtifactStore } from '../../server/src/modules/skill/skill-artifact-store.ts'
import { SkillSubmissionReviewService } from '../../server/src/modules/skill/skill-submission-review-service.ts'
import { parseSkillDirectoryFiles } from '../../server/src/modules/skill/skill-package.ts'
import { buildSkillInstallationPlan } from '../../server/src/modules/skill/skill-installation-plan.ts'

const tenantId = 'tenant-dsh-work'
const EMPLOYEE = 'U00001'
const port = Number(process.env.DSH_WORK_SKILL_REVIEW_SERVER_PORT ?? 4394)
const database = await createThrowawayDatabase({ namePrefix: 'dsh_skc02_browser', maxConnections: 4 })
const scratch = await mkdtemp(join(tmpdir(), 'skc02-browser-'))
const artifactStore = new SkillArtifactStore(new LocalObjectStorage(join(scratch, 'skills')))
const operations = new PostgresOperationsService(database.client)
const skills = new PostgresSkillService(database.client, operations, artifactStore)
const installation = new AdminSkillInstallationService(database.client, {} as never, new PostgresAuthorizationService(database.client))
const runs = new PostgresRunRepository(database.client)
skills.setPackageTestLifecycle({
  start: (userId, skill, prompt) => syntheticTrial(userId, skill, prompt),
  progress: (userId, skill, runId) => installation.packageTestProgress(userId, skill, runId),
})
const reviews = new SkillSubmissionReviewService({ database: database.client, skills, artifactStore, audit: operations })

async function syntheticTrial(userId: string, skill: RuntimeSkillConfiguration, prompt: string) {
  const sql = database.client
  const unfinished = (skill.name ?? '').includes('会议纪要')
  const sessionId = `admin-session-${randomUUID()}`, runId = `run-${randomUUID()}`, attemptId = `attempt-${randomUUID()}`
  await sql`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
    values (${sessionId}, ${tenantId}, ${userId}, '合成审核试运行', 'active', 'admin', null, null)`
  await sql`insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${randomUUID()}, 'queued')`
  const manifest = { purpose: 'admin-skill-test', run_id: runId, session_id: sessionId, attempt_id: attemptId,
    skills: [{ id: skill.id, version: skill.version }], input: { message: prompt, file_mounts: [] },
    agent_configuration: { system_prompt: '合成证据，不是模型运行', skill_instructions: [skill] } }
  await sql`insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${attemptId}, ${tenantId}, ${runId}, 1, ${sql.json(JSON.parse(JSON.stringify(manifest)))}, ${'a'.repeat(64)}, '{}'::jsonb,
            ${unfinished ? 'running' : 'succeeded'})`
  await sql`update runs set current_attempt_id = ${attemptId}, status = ${unfinished ? 'running' : 'succeeded'} where id = ${runId}`
  if (!unfinished) {
    await sql`insert into skill_runtime_activations (id, tenant_id, run_id, attempt_id, skill_id, skill_version, content_sha256)
      values (${randomUUID()}, ${tenantId}, ${runId}, ${attemptId}, ${skill.id}, ${skill.version}, ${'a'.repeat(64)})`
    for (const file of (skill.files ?? []).filter(item => item.path.endsWith('.py'))) {
      await sql`insert into skill_python_executions (id, tenant_id, run_id, attempt_id, skill_id, entry_path, succeeded)
        values (${randomUUID()}, ${tenantId}, ${runId}, ${attemptId}, ${skill.id}, ${file.path}, true)`
    }
    await runs.appendEvent({ id: randomUUID(), tenantId, runId, attemptId, sequence: 1,
      eventType: 'assistant.completed', displayMessage: '已按 Skill 说明完成示例。', safeMetadata: { synthetic: true },
      traceId: `trace-${runId}`, occurredAt: new Date().toISOString() })
  }
  return installation.packageTestProgress(userId, skill, runId)
}

/** 准备一条员工对话创建、已提交待审核的 Skill（与 skill_draft_save 同一包规则与存储）。 */
async function seedSubmission(name: string, description: string, script: boolean) {
  const sql = database.client
  const encode = (text: string) => new TextEncoder().encode(text)
  const files: Record<string, Uint8Array> = {
    'SKILL.md': encode(`---\nname: ${name}\ndescription: ${description}\n---\n\n${script ? '运行 scripts/report.py 按区域汇总一周销售日报并计算环比。' : '按固定格式整理会议纪要：议题、结论、待办与负责人。'}\n`),
    ...(script ? { 'scripts/report.py': encode('import openpyxl\n\nprint("按区域汇总销售日报")\n') } : {}),
  }
  const plan = buildSkillInstallationPlan({ root: parseSkillDirectoryFiles(files), packages: [parseSkillDirectoryFiles(files)], edges: [] },
    { pythonSandboxAvailable: true, pythonPackages: ['openpyxl'] })
  const pkg = plan.packages[0]!
  const artifact = await artifactStore.put(pkg)
  const sessionId = `session-${randomUUID()}`, submissionId = `skill-submission-${randomUUID()}`, versionId = `skill-submission-version-${randomUUID()}`
  // 员工个人空间里的一次对话（种子数据中的任一 Agent 版本即可，审核不依赖它）。
  await sql`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
    select ${sessionId}, ${tenantId}, ${EMPLOYEE}, '和 Skill 创建专家的对话', 'active', 'workbench',
           (select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${EMPLOYEE} limit 1),
           (select id from agent_versions where tenant_id = ${tenantId} order by created_at limit 1)`
  await sql`insert into skill_submissions (id, tenant_id, submitter_user_id, source, session_id, name, status, submitted_at)
    values (${submissionId}, ${tenantId}, ${EMPLOYEE}, 'conversation', ${sessionId}, ${pkg.name}, 'pending', now())`
  await sql`insert into skill_submission_versions (id, tenant_id, submission_id, version_number, artifact, package_sha256, compatibility, script_count)
    values (${versionId}, ${tenantId}, ${submissionId}, 1, ${sql.json(artifact as never)}, ${pkg.sha256}, ${sql.json(plan.compatibility as never)}, ${script ? 1 : 0})`
  await sql`update skill_submissions set current_version_id = ${versionId} where id = ${submissionId}`
  return { submissionId, versionId }
}

const router = new Router({ authenticateApi: testApiAuthenticator })
const base = '/api/admin/v1'
router.get(`${base}/session`, (_request, context) => {
  const identity = requireRequestIdentity(context, 'admin')
  return envelope('admin', {
    user: identity.profile, identityProvider: identity.identityProvider, apiAudience: 'admin',
    permissions: ['admin:read', 'admin:write'],
  }, 'postgres')
})
router.get(`${base}/identity/roles`, async () => envelope('admin', await database.client`
  select id, code, name, description, status, permissions,
    '[]'::jsonb as "dataScopes", 0 as "userCount", false as system, now() as "updatedAt"
    from roles where tenant_id = ${tenantId} and status = 'active' order by name
`, 'postgres'))
for (const path of ['tasks', 'runtimes', 'workspaces', 'health', 'usage', 'assistant/sessions', 'connectors']) {
  router.get(`${base}/${path}`, () => envelope('admin', [], 'postgres'))
}
router.get(`${base}/platform-status`, () => envelope('admin', { mode: 'test', identity: 'prototype', persistence: 'postgres', runtime: 'synthetic' }, 'postgres'))
registerSkillRoutes(router, skills, async () => ({ skills: [], scenarios: [], disabledBuiltinSkills: [] }))
registerSkillSubmissionReviewRoutes(router, reviews)

// 测试接口：清空并准备两条待审核提交；读取提交人看到的结论（P1 浏览器只走管理端，员工卡片由集成测试覆盖）。
router.post(`${base}/test/skill-submissions/fixture`, async () => {
  const suffix = randomUUID().slice(0, 6)
  const weekly = await seedSubmission(`周报汇总-${suffix}`, '每周把销售日报汇总成周报。', true)
  const minutes = await seedSubmission(`会议纪要-${suffix}`, '按固定格式整理会议纪要。', false)
  return envelope('admin', { suffix, weekly, minutes }, 'postgres')
})
router.get(`${base}/test/skill-submissions/:submissionId/outcome`, async (_request, context) => {
  const [row] = await database.client<{ status: string; reviewNote: string | null }[]>`
    select status, review_note as "reviewNote" from skill_submissions where tenant_id = ${tenantId} and id = ${context.params['submissionId'] ?? ''}`
  return envelope('admin', row ?? null, 'postgres')
})
router.get('/health', () => ({ status: 'ok', testOnly: true, runtime: 'synthetic-skill-trial' }))

const server = createServer((request, response) => void router.handle(request, response))
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
console.log('SKC-02 admin browser ready; throwaway PostgreSQL and synthetic Skill trial evidence, no model/DSH/OIDC.')

let closing = false
async function close() {
  if (closing) return
  closing = true
  await new Promise<void>(resolve => server.close(() => resolve()))
  await database.dispose()
  await rm(scratch, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
