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
import { acquireSkillSource, continueSkillSource, parseSkillSource, type SkillSource } from './skill-source.ts'
import type { FileSystemSkillArtifactStore } from './file-system-skill-artifact-store.ts'

const tenant = 'tenant-dsh-work'
type InstallationSource = SkillSource | { kind: 'zip'; fileName: string }
interface InstallationRow {
  id: string; runId: string | null; source: InstallationSource; resolvedUrl: string | null; resolvedRef: string | null
  package: SkillPackageArtifact | null; status: 'pending' | 'installed' | 'cancelled'; skillId: string | null; versionId: string | null
  plan: SkillInstallationPlan | null; planSha256: string | null; compatibilityStatus: SkillInstallationPlan['compatibility']['status'] | null
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
  constructor(db: DatabaseClient, orchestration: RunOrchestrationService, authorization: PostgresAuthorizationService, tools: PostgresToolConnectorService, acquire = acquireSkillSource, pythonSandboxAvailable = false, pythonPackages: string[] = [], artifactStore?: FileSystemSkillArtifactStore) {
    this.db = db; this.orchestration = orchestration; this.authorization = authorization; this.tools = tools; this.acquire = acquire; this.pythonSandboxAvailable = pythonSandboxAvailable; this.pythonPackages = pythonPackages; this.artifactStore = artifactStore
  }

  async testPackage(userId: string, skill: RuntimeSkillConfiguration, prompt: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const sessionId = `admin-session-${randomUUID()}`
    await this.db`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
      values (${sessionId}, ${tenant}, ${userId}, ${`Skill 试运行 ${skill.id}`}, 'active', 'admin', null, null)`
    const run = await this.orchestration.startAdminRun({ userId, sessionId, prompt, idempotencyKey: randomUUID(), source: '', testSkill: skill })
    for (let count = 0; count < 200; count++) {
      const detail = await this.detail(userId, sessionId)
      const current = detail.runs.find(item => item.id === run.id)
      if (current && ['succeeded', 'failed', 'cancelled'].includes(current.status)) {
        const requiredSkillIds = [skill.id, ...flattenDependencies(skill).map(item => item.id)]
        const activations = await this.db<{ skillId: string }[]>`select skill_id as "skillId" from skill_runtime_activations where tenant_id = ${tenant} and run_id = ${run.id} and skill_id in ${this.db(requiredSkillIds)}`
        const activatedIds = new Set(activations.map(item => item.skillId))
        const missingActivations = requiredSkillIds.filter(id => !activatedIds.has(id))
        const pythonSkillIds = [skill, ...flattenDependencies(skill)].filter(item => item.files?.some(file => file.path.endsWith('.py'))).map(item => item.id)
        const pythonExecutions = pythonSkillIds.length ? await this.db<{ skillId: string }[]>`select distinct skill_id as "skillId" from skill_python_executions where tenant_id = ${tenant} and run_id = ${run.id} and succeeded = true and skill_id in ${this.db(pythonSkillIds)}` : []
        const executedPythonIds = new Set(pythonExecutions.map(item => item.skillId))
        const missingPython = pythonSkillIds.filter(id => !executedPythonIds.has(id))
        const assistantSummary = detail.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n').slice(0, 6000)
        const passed = current.status === 'succeeded' && missingActivations.length === 0 && missingPython.length === 0 && Boolean(assistantSummary)
        return { passed, summary: passed ? assistantSummary : `严格试运行未通过：${missingActivations.length ? `缺少 Skill 激活证据（${missingActivations.join('、')}）` : missingPython.length ? `缺少 Python 沙箱成功证据（${missingPython.join('、')}）` : current.status !== 'succeeded' ? 'DSH Attempt 未成功完成' : 'DSH 未产生有效结果'}`, runId: run.id }
      }
      await delay(1000)
    }
    await this.orchestration.cancelAdminRun(run.id, userId)
    return { passed: false, summary: 'DSH 试运行超时，请检查 Runtime 后重试', runId: run.id }
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

  async confirm(userId: string, runId: string, sha256: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const owned = await this.requireRun(userId, runId)
    await this.db.begin(async tx => {
      await requireAdminInTransaction(tx, userId)
      const [run] = await tx<{ status: string }[]>`select status from runs where tenant_id = ${tenant} and id = ${runId} for update`
      const [row] = await tx<{ id: string; package: SkillPackageArtifact; plan: SkillInstallationPlan; planSha256: string; status: string; skillId: string | null }[]>`
        select id, package, plan, plan_sha256 as "planSha256", status, skill_id as "skillId" from skill_installations where tenant_id = ${tenant} and run_id = ${runId} and created_by = ${userId} for update
      `
      if (!row || !row.package || !row.plan || row.planSha256 !== sha256 || row.plan.sha256 !== sha256 || installationPlanDigest(row.plan) !== sha256) throw new Error('安装计划不存在或已变化，请重新查看计划')
      if (row.status === 'installed') {
        await this.recordInstallationReply(tx, owned.sessionId, runId, row.id, row.plan.rootName, row.skillId)
        return
      }
      if (row.status !== 'pending' || run?.status !== 'succeeded') throw new Error('安装已取消或助手尚未成功完成，请等待或重试')
      const root = await this.installPlan(tx, row, userId, `trace-${runId}`, '通过管理助手按确认的安装计划保存，等待严格试运行和发布')
      await this.recordInstallationReply(tx, owned.sessionId, runId, row.id, row.plan.rootName, root.skillId)
    })
    return this.detail(userId, owned.sessionId)
  }

  async confirmZip(userId: string, installationId: string, sha256: string) {
    await this.authorization.requirePlatformAdmin(userId)
    await this.db.begin(async tx => {
      await requireAdminInTransaction(tx, userId)
      const [row] = await tx<{ id: string; package: SkillPackageArtifact; plan: SkillInstallationPlan; planSha256: string; status: string }[]>`
        select id, package, plan, plan_sha256 as "planSha256", status from skill_installations
        where tenant_id = ${tenant} and id = ${installationId} and created_by = ${userId} and channel = 'zip' and run_id is null for update
      `
      this.assertPlan(row, sha256)
      if (row.status === 'installed') return
      if (row.status !== 'pending') throw new Error('安装已取消，请重新上传 Skill 包')
      await this.installPlan(tx, row, userId, `trace-${installationId}`, '通过 ZIP 包按确认的安装计划保存，等待严格试运行和发布')
    })
    return this.getZipInstallation(userId, installationId)
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
      select i.id, i.run_id as "runId", i.source, i.resolved_url as "resolvedUrl", i.resolved_ref as "resolvedRef", i.package, i.plan, i.plan_sha256 as "planSha256", i.compatibility_status as "compatibilityStatus", i.status, i.skill_id as "skillId", i.version_id as "versionId"
      from skill_installations i join runs r on r.tenant_id = i.tenant_id and r.id = i.run_id where i.tenant_id = ${tenant} and r.session_id = ${sessionId}
    `
  }

  private async getZipInstallation(userId: string, installationId: string) {
    const [row] = await this.db<InstallationRow[]>`
      select id, run_id as "runId", source, resolved_url as "resolvedUrl", resolved_ref as "resolvedRef", package, plan,
        plan_sha256 as "planSha256", compatibility_status as "compatibilityStatus", status, skill_id as "skillId", version_id as "versionId"
      from skill_installations where tenant_id = ${tenant} and id = ${installationId} and created_by = ${userId} and channel = 'zip'
    `
    if (!row) throw new Error('ZIP 安装计划不存在或不可访问')
    return this.preview(row)
  }

  private async prepareBundle(bytes: Uint8Array, selected?: string, directory?: string) {
    const bundle = parseSkillBundle(bytes, selected, directory)
    const unavailableTools: string[] = []
    for (const reference of [...new Set(bundle.packages.flatMap(pkg => pkg.toolIds))]) {
      if (reference === 'python_execute@1.0.0') continue
      try { await this.tools.assertAvailableReferences([reference]) }
      catch { unavailableTools.push(reference.split('@')[0]!) }
    }
    const preparedPlan = buildSkillInstallationPlan(bundle, { pythonSandboxAvailable: this.pythonSandboxAvailable, pythonPackages: this.pythonPackages, unavailableTools })
    const artifacts: SkillPackageArtifact[] = []
    for (const packageToStore of preparedPlan.packages) artifacts.push(await this.requireArtifactStore().put(packageToStore))
    const plan = externalizeSkillInstallationPlan(preparedPlan, artifacts)
    return { plan, pkg: plan.packages.find(item => item.name === plan.rootName)! }
  }

  private assertPlan(row: { package: SkillPackageArtifact; plan: SkillInstallationPlan; planSha256: string } | undefined, sha256: string) {
    if (!row || !row.package || !row.plan || row.planSha256 !== sha256 || row.plan.sha256 !== sha256 || installationPlanDigest(row.plan) !== sha256) {
      throw new Error('安装计划不存在或已变化，请重新查看计划')
    }
  }

  private async installPlan(tx: DatabaseTransaction, row: { id: string; plan: SkillInstallationPlan }, userId: string, traceId: string, changeSummary: string) {
    if (row.plan.compatibility.status === 'incompatible') throw new Error(`安装计划不兼容：${row.plan.compatibility.issues.map(issue => issue.message).join('；')}`)
    await this.tools.assertAvailableReferences(row.plan.summary.toolIds)
    for (const artifact of row.plan.packages) await this.requireArtifactStore().read(artifact)
    const identities = new Map(row.plan.packages.map(pkg => [pkg.name, { skillId: `skill-${randomUUID().slice(0, 12)}`, versionId: `skill-version-${randomUUID()}` }]))
    for (const pkg of row.plan.packages) {
      const identity = identities.get(pkg.name)!
      const dependencies = row.plan.edges.filter(edge => edge.from === pkg.name).map(edge => `${identities.get(edge.to)!.skillId}@0.1.0`)
      await tx`
        insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status)
        values (${identity.skillId}, ${tenant}, ${identity.skillId}, ${pkg.name}, '已安装 Skill', ${pkg.description}, ${userId}, ${userId}, 'draft')
      `
      await tx`
        insert into skill_versions (id, tenant_id, skill_id, version, name, category, description, instructions, manifest, artifact_ref, package_sha256, tool_refs, test_prompt, status, created_by, change_summary)
        values (${identity.versionId}, ${tenant}, ${identity.skillId}, '0.1.0', ${pkg.name}, '已安装 Skill', ${pkg.description}, '',
          ${tx.json(JSON.parse(JSON.stringify({ artifact: pkg, installationId: row.id, dependencies })))}, ${pkg.artifactRef}, ${pkg.sha256}, ${tx.json(pkg.toolIds)}, '请按照 Skill 说明完成一个最小示例；有参考资料时实际读取并说明结果，缺少业务输入时明确指出。', 'draft', ${userId}, ${changeSummary})
      `
      await tx`update skills set draft_version_id = ${identity.versionId} where tenant_id = ${tenant} and id = ${identity.skillId}`
    }
    for (const edge of row.plan.edges) {
      const from = identities.get(edge.from)!, to = identities.get(edge.to)!
      await tx`insert into skill_version_dependencies (tenant_id, skill_version_id, dependency_skill_version_id, dependency_type, evidence)
        values (${tenant}, ${from.versionId}, ${to.versionId}, 'skill', '安装计划解析的 Skill 激活依赖')`
    }
    const root = identities.get(row.plan.rootName)!
    await tx`update skill_installations set status = 'installed', skill_id = ${root.skillId}, version_id = ${root.versionId}, updated_at = now() where id = ${row.id}`
    await tx`
      insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
      values (${`audit-${randomUUID()}`}, ${tenant}, 'user', ${userId}, 'skill.install', 'skill', ${root.skillId}, 'success', ${traceId}, ${tx.json({ plan_sha256: row.plan.sha256, package_count: row.plan.packages.length })})
    `
    return root
  }

  private async recordInstallationReply(tx: DatabaseTransaction, sessionId: string, runId: string, installationId: string, skillName: string, skillId: string | null) {
    const content = `Skill“${skillName}”已安装完成，并保存为 0.1.0 待验证草稿。${skillId ? `\nSkill 标识：${skillId}` : ''}\n下一步：前往 Skill 中心执行严格试运行，确认结果后发布；发布前 Agent 不会使用该 Skill。`
    await tx`
      insert into messages (id, tenant_id, session_id, run_id, role, content)
      values (${`message-${installationId}-installed`}, ${tenant}, ${sessionId}, ${runId}, 'assistant', ${content})
      on conflict (id) do nothing
    `
    await tx`update sessions set last_active_at = now() where tenant_id = ${tenant} and id = ${sessionId}`
  }

  private requireArtifactStore() {
    if (!this.artifactStore) throw new Error('Skill 文件夹存储未配置')
    return this.artifactStore
  }

  private async preview(row: InstallationRow) {
    const packagePreview = row.package ? withoutFileContents(await this.requireArtifactStore().read(row.package)) : null
    const planPackages = row.plan
      ? await Promise.all(row.plan.packages.map(async artifact => withoutFileContents(await this.requireArtifactStore().read(artifact))))
      : null
    return {
      id: row.id, runId: row.runId, source: installationSourceLabel(row.source), resolvedUrl: row.resolvedUrl, resolvedRef: row.resolvedRef,
      status: row.status, skillId: row.skillId, package: packagePreview,
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
async function requireAdminInTransaction(tx: DatabaseTransaction, userId: string) {
  const [actor] = await tx`
    select u.id from users u join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
    join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
    where u.tenant_id = ${tenant} and u.id = ${userId} and u.status = 'active' and ur.source_key = 'local' and r.status = 'active'
      and (ur.valid_until is null or ur.valid_until > now()) and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
    for share of u, ur, r
  `
  if (!actor) throw new Error('当前用户没有管理写权限')
}
function flattenDependencies(skill: RuntimeSkillConfiguration): RuntimeSkillConfiguration[] {
  return (skill.dependencySkills ?? []).flatMap(item => [item, ...flattenDependencies(item)])
}
