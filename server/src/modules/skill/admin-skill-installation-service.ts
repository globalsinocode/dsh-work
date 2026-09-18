import { normalizeSkillTestScenario } from '../../domain/skill-test-scenario.ts'
import { evaluateAttemptEvidence, SKILL_TEST_EVIDENCE_POLICY, SKILL_TEST_SCENARIO_POLICY } from './skill-test-evidence.ts'
import { authorizationDenied, requestInvalid } from '../authorization/authorization-errors.ts'
import { ExecutionCapabilityUnavailableError } from '../runtime/execution-capabilities.ts'
import { setTimeout as delay } from 'node:timers/promises'
import type { RuntimeSkillConfiguration } from './postgres-skill-service.ts'
import { randomUUID } from 'node:crypto'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { RunOrchestrationService } from '../run/run-orchestration-service.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import type { PostgresToolConnectorService } from '../tool/postgres-tool-connector-service.ts'
import { parseSkillBundle, type SkillPackage, type SkillPackageArtifact } from './skill-package.ts'
import { buildSkillInstallationPlan, externalizeSkillInstallationPlan, installationPlanDigest, type SkillInstallationPlan } from './skill-installation-plan.ts'
import { acquireSkillSource, continueSkillSource, parseSkillSource, parseSkillLink, type SkillSource } from './skill-source.ts'
import type { FileSystemSkillArtifactStore } from './file-system-skill-artifact-store.ts'

const tenant = 'tenant-dsh-work'
type SkillTestRunStatus = 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled'
export interface SkillTestProgressStep {
  id: string
  title: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  occurredAt?: string
}
export interface PackageTestProgress {
  evidencePolicy?: string
  attemptId: string
  runId: string
  sessionId: string
  status: SkillTestRunStatus
  passed?: boolean
  summary?: string
  steps: SkillTestProgressStep[]
}
type InstallationSource = SkillSource | { kind: 'zip'; fileName: string }
type InstallationResultType = 'created' | 'updated' | 'duplicate'
interface InstallationRow {
  id: string; channel?: 'assistant' | 'zip' | 'link'; runId: string | null; source: InstallationSource; resolvedUrl: string | null; resolvedRef: string | null
  package: SkillPackageArtifact | null; status: 'pending' | 'installed' | 'cancelled'; skillId: string | null; versionId: string | null
  plan: SkillInstallationPlan | null; planSha256: string | null; compatibilityStatus: SkillInstallationPlan['compatibility']['status'] | null
  resultType: InstallationResultType | null; installedVersion: string | null
}
interface InstalledIdentity {
  skillId: string
  versionId: string
  version: string
  action: InstallationResultType
}
export class AdminSkillInstallationService {
  private readonly db: DatabaseClient
  private readonly orchestration: RunOrchestrationService
  private readonly authorization: PostgresAuthorizationService
  private readonly tools: PostgresToolConnectorService
  private readonly acquire: typeof acquireSkillSource
  private readonly pythonSandboxAvailable: boolean
  private readonly pythonPackages: string[]
  private readonly artifactStore?: FileSystemSkillArtifactStore
  private readonly checkRuntime?: (references: string[], requiredPackages: string[]) => Promise<void>
  constructor(db: DatabaseClient, orchestration: RunOrchestrationService, authorization: PostgresAuthorizationService, tools: PostgresToolConnectorService, acquire = acquireSkillSource, pythonSandboxAvailable = false, pythonPackages: string[] = [], artifactStore?: FileSystemSkillArtifactStore, checkRuntime?: (references: string[], requiredPackages: string[]) => Promise<void>) {
    this.db = db; this.orchestration = orchestration; this.authorization = authorization; this.tools = tools; this.acquire = acquire; this.pythonSandboxAvailable = pythonSandboxAvailable; this.pythonPackages = pythonPackages; this.artifactStore = artifactStore; this.checkRuntime = checkRuntime
  }

  async testPackage(userId: string, skill: RuntimeSkillConfiguration, prompt: string) {
    const started = await this.startPackageTest(userId, skill, prompt)
    for (let count = 0; count < 200; count++) {
      const progress = await this.packageTestProgress(userId, skill, started.runId)
      if (['succeeded', 'failed', 'cancelled'].includes(progress.status)) {
        return { passed: progress.passed ?? false, summary: progress.summary ?? 'DSH 试运行未产生结果', runId: progress.runId, attemptId: progress.attemptId, evidencePolicy: progress.evidencePolicy }
      }
      await delay(1000)
    }
    await this.orchestration.cancelAdminRun(started.runId, userId)
    return { passed: false, summary: 'DSH 试运行超时，请检查 Runtime 后重试', runId: started.runId, attemptId: started.attemptId }
  }

  async startPackageTest(userId: string, skill: RuntimeSkillConfiguration, prompt: string): Promise<PackageTestProgress> {
    await this.authorization.requirePlatformAdmin(userId)
    const sessionId = `admin-session-${randomUUID()}`
    await this.db`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
      values (${sessionId}, ${tenant}, ${userId}, ${`Skill 试运行 ${skill.id}`}, 'active', 'admin', null, null)`
    const run = await this.orchestration.startAdminRun({ userId, sessionId, prompt, idempotencyKey: randomUUID(), source: '', testSkill: skill })
    return this.packageTestProgress(userId, skill, run.id)
  }

  async packageTestProgress(userId: string, skill: RuntimeSkillConfiguration, runId: string): Promise<PackageTestProgress> {
    await this.authorization.requirePlatformAdmin(userId)
    const owned = await this.requireRun(userId, runId)
    const [attempt] = await this.db<{ id: string; status: string; runStatus: string; manifest: RuntimeManifest; createdAt: Date; startedAt: Date | null; endedAt: Date | null }[]>`
      select ra.id, ra.status, r.status as "runStatus", ra.manifest,
             ra.created_at as "createdAt", ra.started_at as "startedAt", ra.ended_at as "endedAt"
        from runs r
        join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id and ra.run_id = r.id
       where r.tenant_id = ${tenant} and r.id = ${runId}
    `
    if (!attempt || attempt.manifest.purpose !== 'admin-skill-test') throw new Error('Skill 试运行不存在或类型不匹配')
    const expectedReference = `${skill.id}@${skill.version}`
    if (!attempt.manifest.skills.some(reference => `${reference.id}@${reference.version}` === expectedReference)) throw new Error('Skill 试运行版本已变化，请重新发起')

    owned.status = attempt.runStatus
    const catalog = attempt.manifest.agent_configuration.skill_instructions
    const scenario = attempt.manifest.test_scenario === undefined ? undefined : normalizeSkillTestScenario(attempt.manifest.test_scenario, catalog)
    const requiredCatalog = scenario ? catalog.filter(skill => scenario.requiredSkills.includes(`${skill.id}@${skill.version}`)) : catalog
    const requiredSkillIds = requiredCatalog.map(item => item.id)
    const activations = await this.db<{ attemptId: string; skillId: string; skillVersion: string; createdAt: Date }[]>`
      select attempt_id as "attemptId", skill_id as "skillId", skill_version as "skillVersion", created_at as "createdAt"
        from skill_runtime_activations where tenant_id = ${tenant} and run_id = ${runId} and attempt_id = ${attempt.id}
        order by created_at
    `
    const pythonSkillIds = scenario ? [...new Set(scenario.requiredPythonEntries.map(entry => entry.skill.slice(0, entry.skill.lastIndexOf('@'))))]
      : catalog.filter(item => item.files?.some(file => file.path.endsWith('.py'))).map(item => item.id)
    const pythonExecutions = await this.db<{ attemptId: string; skillId: string; entry: string; succeeded: boolean; createdAt: Date }[]>`
      select attempt_id as "attemptId", skill_id as "skillId", entry_path as entry, succeeded, created_at as "createdAt"
        from skill_python_executions where tenant_id = ${tenant} and run_id = ${runId} and attempt_id = ${attempt.id}
        order by created_at
    `
    const events = await this.db<{ attemptId: string; eventType: string; displayMessage: string | null; occurredAt: Date }[]>`
      select attempt_id as "attemptId", event_type as "eventType", display_message as "displayMessage", occurred_at as "occurredAt"
        from run_events where tenant_id = ${tenant} and run_id = ${runId} and attempt_id = ${attempt.id}
        order by stream_position, sequence
    `
    const [current] = await this.db<{ attemptId: string | null }[]>`
      select current_attempt_id as "attemptId" from runs where tenant_id = ${tenant} and id = ${runId}
    `
    if (current?.attemptId !== attempt.id) throw Object.assign(new Error('试运行 Attempt 已变化，请刷新'), {
      status: 409, code: 'skill_test_attempt_changed',
    })
    const activatedIds = new Set(activations.filter(row => catalog.some(skill => skill.id === row.skillId && skill.version === row.skillVersion)).map(row => row.skillId))
    const { missingActivations, missingPython, passed, assertionResults, validationLevel } = evaluateAttemptEvidence({
      attemptId: attempt.id, runStatus: owned.status, attemptStatus: attempt.status,
      manifest: attempt.manifest, activations, pythonExecutions, events,
    })
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(owned.status)
    const summary = terminal
      ? passed
        ? `${scenario ? '场景' : '严格'}试运行通过：${validationLevel === 'business-assertions' ? '声明的结果断言通过；' : '仅执行验证；'}已验证 ${requiredSkillIds.length} 个 Skill${pythonSkillIds.length ? `、${pythonSkillIds.length} 个含 Python 的 Skill` : ''}，本 Attempt 已返回非空回答，业务正确性仍需验收。`
        : `严格试运行未通过：${missingActivations.length ? `缺少 Skill 激活证据（${missingActivations.join('、')}）` : missingPython.length ? `缺少 Python 沙箱成功证据（${missingPython.join('、')}）` : owned.status !== 'succeeded' ? 'DSH Attempt 未成功完成' : assertionResults.some(result => !result.passed) ? '结果断言未通过' : 'DSH 未产生有效结果'}`
      : undefined
    const workerStarted = events.find(event => event.eventType === 'run.started')
    const activeStatus = (completed: boolean, running: boolean): SkillTestProgressStep['status'] => completed ? 'completed' : terminal ? 'failed' : running ? 'running' : 'pending'
    const steps: SkillTestProgressStep[] = [
      { id: 'created', title: '创建严格试运行', description: `已锁定 ${skill.name ?? skill.id}@${skill.version}，Run ${runId}`, status: 'completed', occurredAt: attempt.createdAt.toISOString() },
      { id: 'scheduled', title: '等待 Runtime 调度', description: owned.status === 'queued' ? '正在等待可用的 DSH Worker' : 'Runtime 已接收本次试运行', status: owned.status === 'queued' ? 'running' : 'completed', occurredAt: attempt.startedAt?.toISOString() },
      { id: 'worker', title: '启动 DSH Worker', description: workerStarted ? 'Worker 已启动并加载固定运行清单' : owned.status === 'queued' ? '等待可用 Worker' : '正在启动 Worker', status: activeStatus(Boolean(workerStarted), owned.status === 'running'), occurredAt: workerStarted?.occurredAt.toISOString() },
      ...requiredCatalog.map((item, index) => {
        const activation = activations.find(row => row.skillId === item.id && row.skillVersion === item.version)
        return { id: `activation:${item.id}`, title: `${index === 0 ? '激活根 Skill' : '激活依赖 Skill'}：${item.name ?? item.id}`, description: activation ? `已校验 ${activation.skillId}@${activation.skillVersion} 的锁定内容摘要` : '等待 DSH 调用 activate_skill', status: activeStatus(Boolean(activation), owned.status === 'running' && (index === 0 || activatedIds.has(requiredCatalog[index - 1]!.id))), ...(activation ? { occurredAt: activation.createdAt.toISOString() } : {}) }
      }),
      ...(scenario ? scenario.requiredPythonEntries.map(entry => ({
        skillId: entry.skill.slice(0, entry.skill.lastIndexOf('@')), entry: entry.entry,
      })) : pythonSkillIds.map(skillId => ({ skillId, entry: null }))).map(({ skillId, entry }) => {
        const executions = pythonExecutions.filter(row => row.skillId === skillId
          && (entry ? row.entry === entry : catalog.find(skill => skill.id === skillId)?.files?.some(file => file.path === row.entry && file.path.endsWith('.py'))))
        const successful = executions.find(row => row.succeeded)
        return { id: `python:${skillId}${entry ? `:${entry}` : ''}`, title: `执行 Python 验证：${skillId}${entry ? ` / ${entry}` : ''}`, description: successful ? `沙箱入口 ${successful.entry} 执行成功` : executions.length ? `沙箱入口执行失败：${executions.at(-1)!.entry}` : '等待 DSH 调用声明的 python_execute 入口', status: activeStatus(Boolean(successful), owned.status === 'running' && activatedIds.has(skillId)), ...(successful ? { occurredAt: successful.createdAt.toISOString() } : {}) }
      }),
      ...assertionResults.map(result => ({ id: result.id, title: '验证场景结果', description: `${result.kind}：${result.passed ? '通过' : '未通过'}`, status: activeStatus(result.passed, !terminal) })),
      { id: 'result', title: '核验试运行条件', description: terminal ? (passed ? '本次试运行条件通过，发布另检查完整覆盖' : '存在未通过的试运行条件') : owned.status === 'running' ? '正在核验运行结果与执行证据' : '等待前置步骤完成', status: terminal ? (passed ? 'completed' : 'failed') : owned.status === 'running' ? 'running' : 'pending', ...(attempt.endedAt ? { occurredAt: attempt.endedAt.toISOString() } : {}) },
    ]
    return { runId, evidencePolicy: scenario ? SKILL_TEST_SCENARIO_POLICY : SKILL_TEST_EVIDENCE_POLICY, attemptId: attempt.id, sessionId: owned.sessionId, status: owned.status as SkillTestRunStatus, ...(terminal ? { passed, summary } : {}), steps }
  }

  async send(userId: string, input: { sessionId: string; message: string; requestId: string }) {
    await this.authorization.requirePlatformAdmin(userId)
    if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000) throw Object.assign(new Error('消息长度必须为 1～20000 个字符'), { status: 422, code: 'invalid_message' })
    if (!/^admin-session-[a-f0-9-]{36}$/.test(input.sessionId) || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw new Error('请求标识无效')
    // Validate before persisting: rejected credential-bearing commands never enter history.
    let source = parseSkillSource(input.message)
    await this.db`
      insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
      values (${input.sessionId}, ${tenant}, ${userId}, ${input.message.slice(0, 80)}, 'active', 'admin', null, null)
      on conflict (tenant_id, id) do nothing
    `
    await this.requireSession(userId, input.sessionId)
    const recent = await this.db<{ role: 'user' | 'assistant'; content: string }[]>`
      select role, left(content, 24000) as content from messages
       where tenant_id = ${tenant} and session_id = ${input.sessionId} and role in ('user', 'assistant')
       order by created_at desc, id desc limit 12
    `
    let remaining = 24000
    const history = recent.map(message => {
      const bounded = remaining > 0 ? message.content.slice(-remaining) : ''
      remaining -= bounded.length
      return { role: message.role, content: bounded }
    }).filter(message => message.content).reverse()
    if (!source) {
      const [previous] = await this.db<{ source: string }[]>`
        select ra.manifest->>'installation_source' as source from runs r
        join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
        where r.tenant_id = ${tenant} and r.session_id = ${input.sessionId}
          and ra.manifest->>'purpose' = 'admin-skill-install'
          and coalesce(ra.manifest->>'installation_source', '') <> ''
        order by r.created_at desc, r.id desc limit 1
      `
      source = continueSkillSource(input.message, previous ? JSON.parse(previous.source) as SkillSource : null)
    }
    await this.orchestration.startAdminRun({ userId, sessionId: input.sessionId, prompt: input.message, idempotencyKey: input.requestId, source: source ? JSON.stringify(source) : '', history })
    return this.detail(userId, input.sessionId)
  }

  async list(userId: string) {
    return this.db<{ id: string; title: string }[]>`
      select s.id, s.title from sessions s
       where s.tenant_id = ${tenant} and s.created_by = ${userId} and s.audience = 'admin' and s.status = 'active'
         and exists(select 1 from messages m where m.tenant_id = s.tenant_id and m.session_id = s.id)
       order by s.last_active_at desc limit 100
    `
  }

  async detail(userId: string, sessionId: string) {
    const session = await this.requireSession(userId, sessionId)
    const messages = await this.db<{ id: string; role: 'user' | 'assistant'; text: string; runId: string }[]>`
      select id, role, content as text, run_id as "runId" from messages
       where tenant_id = ${tenant} and session_id = ${sessionId} order by created_at, id
    `
    const runs = await this.db<{ id: string; status: string; error: string | null }[]>`
      select r.id, r.status, ra.error_code as error from runs r
      left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
       where r.tenant_id = ${tenant} and r.session_id = ${sessionId} order by r.created_at
    `
    const rows = await this.readInstallations(sessionId)
    return { ...session, messages, runs, installations: await Promise.all(rows.map(row => this.preview(row))) }
  }

  async prepare(manifest: RuntimeManifest, signal: AbortSignal) {
    if (manifest.purpose !== 'admin-skill-install') throw new Error('当前运行没有安装权限')
    const userId = manifest.user_context.user_id
    await this.authorization.requirePlatformAdmin(userId)
    await this.requireActiveAttempt(manifest)
    if (!manifest.installation_source) return { message: '未提供已有 Skill 来源，请向管理员索取链接或支持的安装命令。' }
    const source = JSON.parse(manifest.installation_source) as SkillSource
    const existing = (await this.readInstallations(manifest.session_id)).find(row => row.runId === manifest.run_id)
    if (existing?.status === 'cancelled') throw new Error('本次安装已取消，请重新发送来源')
    if (existing?.plan) return this.preview(existing)
    try {
      const acquired = await this.acquire(source, AbortSignal.any([signal, AbortSignal.timeout(60000)]))
      signal.throwIfAborted()
      const { plan, pkg } = await this.prepareBundle(acquired.bytes, source.selected, source.directory)
      await this.authorization.requirePlatformAdmin(userId)
      await this.db.begin(async tx => {
        await this.requireActiveAttempt(manifest, tx, true)
        signal.throwIfAborted()
        await tx`
          insert into skill_installations (id, tenant_id, run_id, created_by, source, resolved_url, resolved_ref, package, plan, plan_sha256, compatibility_status)
          values (${`installation-${randomUUID()}`}, ${tenant}, ${manifest.run_id}, ${userId}, ${tx.json(JSON.parse(JSON.stringify(source)))}, ${acquired.resolvedUrl}, ${acquired.resolvedRef}, ${tx.json(JSON.parse(JSON.stringify(pkg)))}, ${tx.json(JSON.parse(JSON.stringify(plan)))}, ${plan.sha256}, ${plan.compatibility.status})
          on conflict (tenant_id, run_id) do update set
            source = excluded.source, resolved_url = excluded.resolved_url, resolved_ref = excluded.resolved_ref,
            package = excluded.package, plan = excluded.plan, plan_sha256 = excluded.plan_sha256,
            compatibility_status = excluded.compatibility_status, updated_at = now()
          where skill_installations.status = 'pending' and skill_installations.plan is null
        `
      })
      const row = (await this.readInstallations(manifest.session_id)).find(row => row.runId === manifest.run_id)!
      if (row.status === 'cancelled') throw new Error('本次安装已取消')
      return this.preview(row)
    } catch (cause) {
      await this.recordFailureReply(manifest.session_id, manifest.run_id, 'prepare', cause)
      throw cause
    }
  }

  async prepareZip(userId: string, input: { fileName: string; bytes: Uint8Array }) {
    await this.authorization.requirePlatformAdmin(userId)
    if (!input.fileName.toLowerCase().endsWith('.zip')) throw new Error('仅支持 ZIP 格式的 Skill 包')
    if (!input.bytes.byteLength) throw new Error('Skill 包不能为空')
    const { plan, pkg } = await this.prepareBundle(input.bytes)
    const id = `installation-${randomUUID()}`
    const source: InstallationSource = { kind: 'zip', fileName: input.fileName }
    await this.authorization.requirePlatformAdmin(userId)
    await this.db`
      insert into skill_installations (id, tenant_id, run_id, created_by, source, resolved_url, resolved_ref, package, plan, plan_sha256, compatibility_status, channel)
      values (${id}, ${tenant}, null, ${userId}, ${this.db.json(source)}, null, null, ${this.db.json(JSON.parse(JSON.stringify(pkg)))}, ${this.db.json(JSON.parse(JSON.stringify(plan)))}, ${plan.sha256}, ${plan.compatibility.status}, 'zip')
    `
    return this.getZipInstallation(userId, id)
  }

  /** No model, Session, Run or shell: acquire once, validate, snapshot, then await an explicit draft-save confirmation. */
  async prepareLink(userId: string, input: { url: string; selected?: string }, signal?: AbortSignal) {
    await this.authorization.requirePlatformAdmin(userId)
    const source = parseSkillLink(input)
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)])
    bounded.throwIfAborted()
    const acquired = await this.acquire(source, bounded)
    bounded.throwIfAborted()
    const { plan, pkg } = await this.prepareBundle(acquired.bytes, source.selected, source.directory, true)
    const id = `installation-${randomUUID()}`
    await this.db.begin(async tx => {
      await requireAdminInTransaction(tx, userId)
      bounded.throwIfAborted()
      await tx`insert into skill_installations (id, tenant_id, run_id, created_by, source, resolved_url, resolved_ref, package, plan, plan_sha256, compatibility_status, channel)
        values (${id}, ${tenant}, null, ${userId}, ${tx.json(JSON.parse(JSON.stringify(source)))}, ${acquired.resolvedUrl}, ${acquired.resolvedRef},
          ${tx.json(JSON.parse(JSON.stringify(pkg)))}, ${tx.json(JSON.parse(JSON.stringify(plan)))}, ${plan.sha256}, ${plan.compatibility.status}, 'link')`
      bounded.throwIfAborted()
    })
    return this.getDirectInstallation(userId, id)
  }

  async confirm(userId: string, runId: string, sha256: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const owned = await this.requireRun(userId, runId)
    try {
      await this.db.begin(async tx => {
        await requireAdminInTransaction(tx, userId)
        const [run] = await tx<{ status: string }[]>`select status from runs where tenant_id = ${tenant} and id = ${runId} for update`
        const [row] = await tx<{ id: string; package: SkillPackageArtifact; plan: SkillInstallationPlan; planSha256: string; status: string; skillId: string | null; versionId: string | null; resultType: InstallationResultType | null; installedVersion: string | null }[]>`
          select id, package, plan, plan_sha256 as "planSha256", status, skill_id as "skillId", version_id as "versionId",
            result_type as "resultType", installed_version as "installedVersion"
          from skill_installations where tenant_id = ${tenant} and run_id = ${runId} and created_by = ${userId} for update
        `
        if (!row || !row.package || !row.plan || row.planSha256 !== sha256 || row.plan.sha256 !== sha256 || installationPlanDigest(row.plan) !== sha256) throw new Error('安装计划不存在或已变化，请重新查看计划')
        if (row.status === 'installed') {
          await this.recordInstallationReply(tx, owned.sessionId, runId, row.id, row.plan.rootName, {
            skillId: row.skillId!, versionId: row.versionId!, version: row.installedVersion ?? '0.1.0', action: row.resultType ?? 'created',
          })
          return
        }
        if (row.status !== 'pending' || run?.status !== 'succeeded') throw new Error('安装已取消或助手尚未成功完成，请等待或重试')
        const root = await this.installPlan(tx, row, userId, `trace-${runId}`, '通过管理助手按确认的安装计划保存，等待严格试运行和发布')
        await this.recordInstallationReply(tx, owned.sessionId, runId, row.id, row.plan.rootName, root)
      })
    } catch (cause) {
      await this.recordFailureReply(owned.sessionId, runId, 'confirm', cause)
      throw cause
    }
    return this.detail(userId, owned.sessionId)
  }

  /** Kept as a strict ZIP-only compatibility wrapper for existing service callers. */
  async confirmZip(userId: string, installationId: string, sha256: string) {
    return this.confirmDirect(userId, installationId, sha256, 'zip')
  }

  async confirmDirect(userId: string, installationId: string, sha256: string, expectedChannel?: 'zip') {
    await this.authorization.requirePlatformAdmin(userId)
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw requestInvalid('安装计划摘要无效')
    await this.db.begin(async tx => {
      await requireAdminInTransaction(tx, userId)
      const [row] = await tx<{ id: string; channel: 'zip' | 'link'; package: SkillPackageArtifact; plan: SkillInstallationPlan; planSha256: string; status: string }[]>`
        select id, channel, package, plan, plan_sha256 as "planSha256", status from skill_installations
        where tenant_id = ${tenant} and id = ${installationId} and created_by = ${userId} and channel in ('zip', 'link') and run_id is null for update
      `
      if (!row || (expectedChannel && row.channel !== expectedChannel)) throw authorizationDenied('安装计划不存在或不可访问')
      this.assertPlan(row, sha256)
      if (row.status === 'installed') return
      if (row.status !== 'pending') throw requestInvalid('安装已取消，请重新提供来源')
      await this.installPlan(tx, row, userId, `trace-${installationId}`, `通过 ${row.channel === 'link' ? '链接' : 'ZIP 包'}按确认计划保存草稿，尚未发布`)
    })
    return this.getDirectInstallation(userId, installationId)
  }

  async cancelDirect(userId: string, installationId: string) {
    await this.authorization.requirePlatformAdmin(userId)
    await this.db.begin(async tx => {
      await requireAdminInTransaction(tx, userId)
      const [row] = await tx<{ status: string }[]>`select status from skill_installations where tenant_id = ${tenant} and id = ${installationId}
        and created_by = ${userId} and channel in ('zip', 'link') and run_id is null for update`
      if (!row) throw authorizationDenied('安装计划不存在或不可访问')
      if (row.status === 'installed') throw Object.assign(new Error('草稿已保存，不能取消安装计划'), { status: 409, code: 'state_conflict' })
      await tx`update skill_installations set status = 'cancelled', updated_at = now() where tenant_id = ${tenant} and id = ${installationId}`
    })
    return this.getDirectInstallation(userId, installationId)
  }

  async cancel(userId: string, runId: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const run = await this.requireRun(userId, runId)
    await this.db.begin(async tx => {
      await tx`select id from runs where tenant_id = ${tenant} and id = ${runId} for update`
      await tx`
        insert into skill_installations (id, tenant_id, run_id, created_by, source, status)
        values (${`installation-${randomUUID()}`}, ${tenant}, ${runId}, ${userId}, '{}', 'cancelled')
        on conflict (tenant_id, run_id) do update set status = 'cancelled', updated_at = now() where skill_installations.status = 'pending'
      `
    })
    await this.orchestration.cancelAdminRun(runId, userId)
    await this.recordConversationReply(run.sessionId, runId, `message-${runId}-installation-cancelled`, 'Skill 安装已取消，本次未创建或修改 Skill。')
    return this.detail(userId, run.sessionId)
  }

  async retry(userId: string, runId: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const run = await this.requireRun(userId, runId)
    if (!['failed', 'cancelled'].includes(run.status)) throw new Error('只有失败或已取消的运行可以重试')
    await this.db`delete from skill_installations where tenant_id = ${tenant} and run_id = ${runId} and status <> 'installed'`
    await this.orchestration.retryAdminRun(runId, userId)
    return this.detail(userId, run.sessionId)
  }

  async recordActivation(manifest: RuntimeManifest, skill: RuntimeManifest['agent_configuration']['skill_instructions'][number], contentSha256: string) {
    await this.requireActiveAttempt(manifest)
    await this.db`insert into skill_runtime_activations (id, tenant_id, run_id, attempt_id, skill_id, skill_version, content_sha256)
      values (${`skill-activation-${randomUUID()}`}, ${tenant}, ${manifest.run_id}, ${manifest.attempt_id}, ${skill.id}, ${skill.version}, ${contentSha256})
      on conflict (tenant_id, attempt_id, skill_id, skill_version) do nothing`
  }
  async recordPythonExecution(manifest: RuntimeManifest, skillId: string, entry: string, succeeded: boolean) {
    await this.requireActiveAttempt(manifest)
    await this.db`insert into skill_python_executions (id, tenant_id, run_id, attempt_id, skill_id, entry_path, succeeded)
      values (${`skill-python-${randomUUID()}`}, ${tenant}, ${manifest.run_id}, ${manifest.attempt_id}, ${skillId}, ${entry}, ${succeeded})`
  }

  private async requireSession(userId: string, sessionId: string) {
    const [row] = await this.db<{ id: string; title: string }[]>`
      select id, title from sessions where tenant_id = ${tenant} and id = ${sessionId} and created_by = ${userId} and audience = 'admin' and status = 'active'
    `
    if (!row) throw new Error('管理对话不存在或不可访问')
    return row
  }
  private async requireRun(userId: string, runId: string) {
    const [row] = await this.db<{ sessionId: string; status: string }[]>`
      select r.session_id as "sessionId", r.status from runs r join sessions s on s.id = r.session_id and s.tenant_id = r.tenant_id
       where r.tenant_id = ${tenant} and r.id = ${runId} and r.requested_by = ${userId} and s.created_by = ${userId} and s.audience = 'admin'
    `
    if (!row) throw new Error('安装运行不存在或不可访问')
    return row
  }
  private async requireActiveAttempt(manifest: RuntimeManifest, sql: DatabaseClient | DatabaseTransaction = this.db, lock = false) {
    const rows = await sql<{ id: string }[]>`
      select id from runs where tenant_id = ${tenant} and id = ${manifest.run_id} and current_attempt_id = ${manifest.attempt_id}
        and requested_by = ${manifest.user_context.user_id} and status = 'running'
      ${lock ? sql`for update` : sql``}
    `
    if (!rows.length) throw new Error('Attempt 已结束、取消或被新 Attempt 替代')
  }
  private async readInstallations(sessionId: string) {
    return this.db<InstallationRow[]>`
      select i.id, i.channel, i.run_id as "runId", i.source, i.resolved_url as "resolvedUrl", i.resolved_ref as "resolvedRef", i.package, i.plan, i.plan_sha256 as "planSha256", i.compatibility_status as "compatibilityStatus", i.status, i.skill_id as "skillId", i.version_id as "versionId",
        i.result_type as "resultType", i.installed_version as "installedVersion"
      from skill_installations i join runs r on r.tenant_id = i.tenant_id and r.id = i.run_id where i.tenant_id = ${tenant} and r.session_id = ${sessionId}
    `
  }

  private async getZipInstallation(userId: string, installationId: string) {
    return this.getDirectInstallation(userId, installationId, 'zip')
  }

  async getDirectInstallation(userId: string, installationId: string, expectedChannel?: 'zip') {
    await this.authorization.requirePlatformAdmin(userId)
    const [row] = await this.db<InstallationRow[]>`
      select id, channel, run_id as "runId", source, resolved_url as "resolvedUrl", resolved_ref as "resolvedRef", package, plan,
        plan_sha256 as "planSha256", compatibility_status as "compatibilityStatus", status, skill_id as "skillId", version_id as "versionId",
        result_type as "resultType", installed_version as "installedVersion"
      from skill_installations where tenant_id = ${tenant} and id = ${installationId} and created_by = ${userId} and channel in ('zip', 'link') and run_id is null
    `
    if (!row || (expectedChannel && row.channel !== expectedChannel)) throw authorizationDenied('安装计划不存在或不可访问')
    return this.preview(row)
  }

  private async prepareBundle(bytes: Uint8Array, selected?: string, directory?: string, deferRuntimeRequirements = false) {
    const bundle = parseSkillBundle(bytes, selected, directory)
    const unavailableTools: string[] = []
    for (const reference of [...new Set(bundle.packages.flatMap(pkg => pkg.toolIds))]) {
      if (reference === 'python_execute@1.0.0') continue
      try {
        if (deferRuntimeRequirements) await this.tools.assertDraftReferences([reference])
        else await this.tools.assertAvailableReferences([reference])
      }
      catch { unavailableTools.push(reference.split('@')[0]!) }
    }
    const preparedPlan = buildSkillInstallationPlan(bundle, { pythonSandboxAvailable: this.pythonSandboxAvailable, pythonPackages: this.pythonPackages, unavailableTools, deferRuntimeRequirements })
    const artifacts: SkillPackageArtifact[] = []
    for (const packageToStore of preparedPlan.packages) artifacts.push(await this.requireArtifactStore().put(packageToStore))
    const plan = externalizeSkillInstallationPlan(preparedPlan, artifacts)
    return { plan, pkg: plan.packages.find(item => item.name === plan.rootName)! }
  }

  private assertPlan(row: { package: SkillPackageArtifact; plan: SkillInstallationPlan; planSha256: string } | undefined, sha256: string) {
    if (!row || !row.package || !row.plan || row.planSha256 !== sha256 || row.plan.sha256 !== sha256 || installationPlanDigest(row.plan) !== sha256) {
      throw Object.assign(new Error('安装计划不存在或已变化，请重新查看计划'), { status: 409, code: 'skill_installation_plan_changed' })
    }
  }

  private async installPlan(tx: DatabaseTransaction, row: { id: string; channel?: string; plan: SkillInstallationPlan }, userId: string, traceId: string, changeSummary: string) {
    if (row.plan.compatibility.status === 'incompatible') throw new Error(`安装计划不兼容：${row.plan.compatibility.issues.map(issue => issue.message).join('；')}`)
    if (row.channel === 'link') await this.tools.assertDraftReferences(row.plan.summary.toolIds, tx)
    else await this.tools.assertAvailableReferences(row.plan.summary.toolIds)
    for (const artifact of row.plan.packages) await this.requireArtifactStore().read(artifact)
    const packageKeys = [...new Set(row.plan.packages.map(pkg => installationKey(pkg.name)))].sort()
    for (const key of packageKeys) await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenant}:skill-install:${key}`}, 0))`
    const identities = new Map<string, InstalledIdentity>()
    for (const pkg of row.plan.packages) identities.set(pkg.name, await this.resolveInstalledIdentity(tx, pkg, userId))
    let promoted = true
    while (promoted) {
      promoted = false
      for (const edge of row.plan.edges) {
        const parent = identities.get(edge.from)!, dependency = identities.get(edge.to)!
        if (parent.action !== 'duplicate' || dependency.action === 'duplicate') continue
        identities.set(edge.from, await this.promoteDuplicateIdentity(tx, row.plan.packages.find(pkg => pkg.name === edge.from)!, parent))
        promoted = true
      }
    }
    for (const pkg of row.plan.packages) {
      const identity = identities.get(pkg.name)!
      if (identity.action === 'duplicate') continue
      const dependencies = row.plan.edges.filter(edge => edge.from === pkg.name).map(edge => {
        const dependency = identities.get(edge.to)!
        return `${dependency.skillId}@${dependency.version}`
      })
      await tx`
        insert into skill_versions (id, tenant_id, skill_id, version, name, category, description, instructions, manifest, artifact_ref, package_sha256, tool_refs, test_prompt, status, created_by, change_summary)
        values (${identity.versionId}, ${tenant}, ${identity.skillId}, ${identity.version}, ${pkg.name}, '已安装 Skill', ${pkg.description}, '',
          ${tx.json(JSON.parse(JSON.stringify({ artifact: pkg, installationId: row.id, dependencies, ...(row.channel === 'link' ? { installationChannel: 'link' } : {}) })))}, ${pkg.artifactRef}, ${pkg.sha256}, ${tx.json(pkg.toolIds)}, '请按照 Skill 说明完成一个最小示例；有参考资料时实际读取并说明结果，缺少业务输入时明确指出。', 'draft', ${userId}, ${changeSummary})
      `
      await tx`update skills set name = ${pkg.name}, description = ${pkg.description}, draft_version_id = ${identity.versionId}, updated_at = now() where tenant_id = ${tenant} and id = ${identity.skillId}`
    }
    for (const edge of row.plan.edges) {
      const from = identities.get(edge.from)!, to = identities.get(edge.to)!
      if (from.action === 'duplicate') continue
      await tx`insert into skill_version_dependencies (tenant_id, skill_version_id, dependency_skill_version_id, dependency_type, evidence)
        values (${tenant}, ${from.versionId}, ${to.versionId}, 'skill', '安装计划解析的 Skill 激活依赖')`
    }
    const root = identities.get(row.plan.rootName)!
    await tx`update skill_installations set status = 'installed', skill_id = ${root.skillId}, version_id = ${root.versionId}, result_type = ${root.action}, installed_version = ${root.version}, updated_at = now() where id = ${row.id}`
    await tx`
      insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
      values (${`audit-${randomUUID()}`}, ${tenant}, 'user', ${userId}, 'skill.install', 'skill', ${root.skillId}, 'success', ${traceId}, ${tx.json({ plan_sha256: row.plan.sha256, package_count: row.plan.packages.length, result_type: root.action, installed_version: root.version })})
    `
    return root
  }

  private async resolveInstalledIdentity(tx: DatabaseTransaction, pkg: SkillPackageArtifact, userId: string): Promise<InstalledIdentity> {
    const key = installationKey(pkg.name)
    const [existing] = await tx<{ skillId: string; draftVersionId: string | null }[]>`
      select id as "skillId", draft_version_id as "draftVersionId"
      from skills where tenant_id = ${tenant} and installation_key = ${key} for update
    `
    if (!existing) {
      const identity = { skillId: `skill-${randomUUID().slice(0, 12)}`, versionId: `skill-version-${randomUUID()}`, version: '0.1.0', action: 'created' as const }
      await tx`
        insert into skills (id, tenant_id, key, installation_key, name, category, description, owner_user_id, created_by, status)
        values (${identity.skillId}, ${tenant}, ${identity.skillId}, ${key}, ${pkg.name}, '已安装 Skill', ${pkg.description}, ${userId}, ${userId}, 'draft')
      `
      return identity
    }
    const [sameVersion] = await tx<{ versionId: string; version: string }[]>`
      select id as "versionId", version from skill_versions
      where tenant_id = ${tenant} and skill_id = ${existing.skillId} and package_sha256 = ${pkg.sha256}
      order by created_at desc, id desc limit 1
    `
    if (sameVersion) return { skillId: existing.skillId, ...sameVersion, action: 'duplicate' }
    if (existing.draftVersionId) {
      const [draft] = await tx<{ version: string }[]>`select version from skill_versions where tenant_id = ${tenant} and id = ${existing.draftVersionId}`
      throw Object.assign(new Error(`Skill“${pkg.name}”已有内容不同的待验证草稿${draft ? ` v${draft.version}` : ''}，本次安装未覆盖。请先发布或删除现有草稿后重试。`), { status: 409, code: 'skill_draft_conflict' })
    }
    const [latest] = await tx<{ version: string }[]>`
      select version from skill_versions where tenant_id = ${tenant} and skill_id = ${existing.skillId}
      order by split_part(version, '.', 1)::integer desc, split_part(version, '.', 2)::integer desc, split_part(version, '.', 3)::integer desc limit 1
    `
    if (!latest) throw new Error(`Skill“${pkg.name}”没有可用的版本记录`)
    return { skillId: existing.skillId, versionId: `skill-version-${randomUUID()}`, version: nextInstalledVersion(latest.version), action: 'updated' }
  }

  private async promoteDuplicateIdentity(tx: DatabaseTransaction, pkg: SkillPackageArtifact, identity: InstalledIdentity): Promise<InstalledIdentity> {
    const [existing] = await tx<{ draftVersionId: string | null }[]>`
      select draft_version_id as "draftVersionId" from skills
      where tenant_id = ${tenant} and id = ${identity.skillId} for update
    `
    if (existing?.draftVersionId) {
      throw Object.assign(new Error(`Skill“${pkg.name}”的依赖内容已变化，但当前已有待验证草稿，本次安装未覆盖。请先发布或删除现有草稿后重试。`), { status: 409, code: 'skill_draft_conflict' })
    }
    const [latest] = await tx<{ version: string }[]>`
      select version from skill_versions where tenant_id = ${tenant} and skill_id = ${identity.skillId}
      order by split_part(version, '.', 1)::integer desc, split_part(version, '.', 2)::integer desc, split_part(version, '.', 3)::integer desc limit 1
    `
    if (!latest) throw new Error(`Skill“${pkg.name}”没有可用的版本记录`)
    return { skillId: identity.skillId, versionId: `skill-version-${randomUUID()}`, version: nextInstalledVersion(latest.version), action: 'updated' }
  }

  private async recordInstallationReply(tx: DatabaseTransaction, sessionId: string, runId: string, installationId: string, skillName: string, result: InstalledIdentity) {
    const content = installationResultMessage(skillName, result)
    await tx`
      insert into messages (id, tenant_id, session_id, run_id, role, content)
      values (${`message-${installationId}-installed`}, ${tenant}, ${sessionId}, ${runId}, 'assistant', ${content})
      on conflict (id) do nothing
    `
    await tx`update sessions set last_active_at = now() where tenant_id = ${tenant} and id = ${sessionId}`
  }

  private async recordFailureReply(sessionId: string, runId: string, stage: 'prepare' | 'confirm', cause: unknown) {
    const reason = safeInstallationFailure(cause)
    await this.recordConversationReply(sessionId, runId, `message-${runId}-installation-${stage}-failed`, `Skill 安装失败：${reason}\n本次未创建或覆盖 Skill。请根据提示处理后重试。`).catch(() => undefined)
  }

  private async recordConversationReply(sessionId: string, runId: string, id: string, content: string) {
    await this.db.begin(async tx => {
      await tx`
        insert into messages (id, tenant_id, session_id, run_id, role, content)
        values (${id}, ${tenant}, ${sessionId}, ${runId}, 'assistant', ${content})
        on conflict (id) do nothing
      `
      await tx`update sessions set last_active_at = now() where tenant_id = ${tenant} and id = ${sessionId}`
    })
  }

  private requireArtifactStore() {
    if (!this.artifactStore) throw new Error('Skill 文件夹存储未配置')
    return this.artifactStore
  }

  private async linkPublicationState(row: InstallationRow) {
    const blockers: Array<{ code: string; message: string }> = []
    try {
      if (!this.checkRuntime) throw new ExecutionCapabilityUnavailableError('dsh')
      await this.checkRuntime(row.plan?.summary.toolIds ?? [], [...new Set((row.plan?.packages ?? []).flatMap(pkg => pkg.requirements
        .filter(r => r.type === 'external' && r.name.startsWith('python-package:')).map(r => r.name.slice('python-package:'.length))))])
    } catch (cause) {
      blockers.push(cause instanceof ExecutionCapabilityUnavailableError
        ? { code: cause.code, message: cause.message }
        : cause instanceof Error && 'code' in cause && cause.code === 'SKILL_DEPENDENCIES_UNAVAILABLE'
          ? { code: 'SKILL_DEPENDENCIES_UNAVAILABLE', message: '声明的 Python 依赖未配置并验证，当前不可发布' }
          : { code: 'RUNTIME_UNAVAILABLE', message: '执行能力尚未确认可用，当前不可发布' })
    }
    if (row.plan?.summary.pythonFiles && !this.pythonSandboxAvailable) {
      if (!blockers.some(b => b.code === 'PYTHON_UNAVAILABLE')) blockers.push({ code: 'PYTHON_UNAVAILABLE', message: 'Python 沙箱未就绪，脚本仅保存，当前不可发布' })
    }
    if (row.plan?.packages.some(pkg => pkg.requirements.some(r => r.type === 'external' && r.status !== 'resolved'))) {
      blockers.push({ code: 'DEPENDENCIES_UNVERIFIED', message: '运行依赖未验证，须配置受控执行环境并重新试运行' })
    }
    try { await this.tools.assertAvailableReferences(row.plan?.summary.toolIds ?? []) }
    catch { blockers.push({ code: 'TOOLS_UNAVAILABLE', message: '所需平台工具暂不可执行，不能发布' }) }
    blockers.push({ code: 'TRIAL_REQUIRED', message: row.resultType === 'duplicate'
      ? '本次未创建版本或执行发布；已有版本状态请在 Skill 中心查看'
      : '导入只保存草稿；发布前须在 Skill 中心完成当前版本的真实试运行及发布检查' })
    return { canSaveDraft: row.status === 'pending' && Boolean(row.plan) && row.plan?.compatibility.status !== 'incompatible', canPublish: false as const, publicationBlockers: blockers }
  }

  private async preview(row: InstallationRow) {
    const packagePreview = row.package ? withoutFileContents(await this.requireArtifactStore().read(row.package)) : null
    const planPackages = row.plan
      ? await Promise.all(row.plan.packages.map(async artifact => withoutFileContents(await this.requireArtifactStore().read(artifact))))
      : null
    return {
      id: row.id, channel: row.channel ?? (row.runId ? 'assistant' : 'zip'), runId: row.runId, source: installationSourceLabel(row.source), resolvedUrl: row.resolvedUrl, resolvedRef: row.resolvedRef,
      status: row.status, skillId: row.skillId, resultType: row.resultType, installedVersion: row.installedVersion, package: packagePreview,
      ...(row.channel === 'link' ? await this.linkPublicationState(row) : {}),
      planSha256: row.planSha256, compatibilityStatus: row.compatibilityStatus,
      plan: row.plan ? { ...row.plan, packages: planPackages! } : null,
    }
  }
}
function withoutFileContents(pkg: SkillPackage) {
  return { ...pkg, files: pkg.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) }
}
function installationSourceLabel(source: InstallationSource) {
  return 'fileName' in source ? source.fileName : source.url
}
function installationKey(name: string) {
  return name.trim().normalize('NFC').toLowerCase()
}
function nextInstalledVersion(current: string) {
  const [major = 0, minor = 0] = current.split('.').map(Number)
  return `${major}.${minor + 1}.0`
}
function installationResultMessage(skillName: string, result: InstalledIdentity) {
  if (result.action === 'duplicate') {
    return `Skill“${skillName}”已经安装，现有 v${result.version} 与本次包内容一致，本次未创建重复 Skill。\nSkill 标识：${result.skillId}\n无需重复安装；如需使用，请确认该版本已完成验证并发布。`
  }
  const action = result.action === 'updated' ? `已作为现有 Skill 的新版本 v${result.version} 安装完成` : `已安装完成，并保存为 v${result.version} 待验证草稿`
  return `Skill“${skillName}”${action}。\nSkill 标识：${result.skillId}\n下一步：前往 Skill 中心执行严格试运行，确认结果后发布；发布前 Agent 不会使用该版本。`
}
function safeInstallationFailure(cause: unknown) {
  if (!(cause instanceof Error)) return '平台未能完成安装，请稍后重试'
  const text = cause.message.trim().replace(/\s+/g, ' ').slice(0, 500)
  return text || '平台未能完成安装，请稍后重试'
}
async function requireAdminInTransaction(tx: DatabaseTransaction, userId: string) {
  const [actor] = await tx`
    select u.id from users u join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
    join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
    where u.tenant_id = ${tenant} and u.id = ${userId} and u.status = 'active' and ur.source_key = 'local' and r.status = 'active'
      and (ur.valid_until is null or ur.valid_until > now()) and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
    for share of u, ur, r
  `
  if (!actor) throw authorizationDenied('当前用户没有管理写权限')
}
