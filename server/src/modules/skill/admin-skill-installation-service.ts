import { setTimeout as delay } from 'node:timers/promises'
import type { RuntimeSkillConfiguration } from './postgres-skill-service.ts'
import { randomUUID } from 'node:crypto'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { RunOrchestrationService } from '../run/run-orchestration-service.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import type { PostgresToolConnectorService } from '../tool/postgres-tool-connector-service.ts'
import { parseSkillPackage, type SkillPackage } from './skill-package.ts'
import { acquireSkillSource, continueSkillSource, parseSkillSource, type SkillSource } from './skill-source.ts'

const tenant = 'tenant-dsh-work'
interface InstallationRow {
  id: string; runId: string; source: SkillSource; resolvedUrl: string | null; resolvedRef: string | null
  package: SkillPackage | null; status: 'pending' | 'installed' | 'cancelled'; skillId: string | null; versionId: string | null
}
export class AdminSkillInstallationService {
  private readonly db: DatabaseClient
  private readonly orchestration: RunOrchestrationService
  private readonly authorization: PostgresAuthorizationService
  private readonly tools: PostgresToolConnectorService
  private readonly acquire: typeof acquireSkillSource
  constructor(db: DatabaseClient, orchestration: RunOrchestrationService, authorization: PostgresAuthorizationService, tools: PostgresToolConnectorService, acquire = acquireSkillSource) {
    this.db = db; this.orchestration = orchestration; this.authorization = authorization; this.tools = tools; this.acquire = acquire
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
        return { passed: current.status === 'succeeded' && detail.messages.some(message => message.role === 'assistant'),
          summary: detail.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n').slice(0, 6000) || 'DSH 试运行未产生有效结果', runId: run.id }
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
    return { ...session, messages, runs, installations: rows.map(preview) }
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
    if (existing?.package) return preview(existing)
    const acquired = await this.acquire(source, AbortSignal.any([signal, AbortSignal.timeout(60000)]))
    signal.throwIfAborted()
    const pkg = parseSkillPackage(acquired.bytes, source.selected, source.directory)
    await this.tools.assertAvailableReferences(pkg.toolIds)
    await this.authorization.requirePlatformAdmin(userId)
    await this.db.begin(async tx => {
      await this.requireActiveAttempt(manifest, tx, true)
      signal.throwIfAborted()
      await tx`
        insert into skill_installations (id, tenant_id, run_id, created_by, source, resolved_url, resolved_ref, package)
        values (${`installation-${randomUUID()}`}, ${tenant}, ${manifest.run_id}, ${userId}, ${tx.json(JSON.parse(JSON.stringify(source)))}, ${acquired.resolvedUrl}, ${acquired.resolvedRef}, ${tx.json(JSON.parse(JSON.stringify(pkg)))})
        on conflict (tenant_id, run_id) do nothing
      `
    })
    const row = (await this.readInstallations(manifest.session_id)).find(row => row.runId === manifest.run_id)!
    if (row.status === 'cancelled') throw new Error('本次安装已取消')
    return preview(row)
  }

  async confirm(userId: string, runId: string, sha256: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const owned = await this.requireRun(userId, runId)
    await this.db.begin(async tx => {
      await requireAdminInTransaction(tx, userId)
      const [run] = await tx<{ status: string }[]>`select status from runs where tenant_id = ${tenant} and id = ${runId} for update`
      const [row] = await tx<{ id: string; package: SkillPackage; status: string }[]>`
        select id, package, status from skill_installations where tenant_id = ${tenant} and run_id = ${runId} and created_by = ${userId} for update
      `
      if (!row || !row.package || row.package.sha256 !== sha256) throw new Error('安装预览不存在或已变化，请重新查看包信息')
      if (row.status === 'installed') return
      if (row.status !== 'pending' || run?.status !== 'succeeded') throw new Error('安装已取消或助手尚未成功完成，请等待或重试')
      await this.tools.assertAvailableReferences(row.package.toolIds)
      const skillId = `skill-${randomUUID().slice(0, 12)}`, versionId = `skill-version-${randomUUID()}`, pkg = row.package
      await tx`
        insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status)
        values (${skillId}, ${tenant}, ${skillId}, ${pkg.name}, '已安装 Skill', ${pkg.description}, ${userId}, ${userId}, 'draft')
      `
      await tx`
        insert into skill_versions (id, tenant_id, skill_id, version, name, category, description, instructions, manifest, tool_refs, test_prompt, status, created_by, change_summary)
        values (${versionId}, ${tenant}, ${skillId}, '0.1.0', ${pkg.name}, '已安装 Skill', ${pkg.description}, ${pkg.instructions},
          ${tx.json(JSON.parse(JSON.stringify({ package: pkg, installationId: row.id })))}, ${tx.json(pkg.toolIds)}, '请按照 Skill 说明完成一个最小示例；有参考资料时实际读取并说明结果，缺少业务输入时明确指出。', 'draft', ${userId}, '通过管理助手安装已有 Skill 包，等待验证和发布')
      `
      await tx`update skills set draft_version_id = ${versionId} where tenant_id = ${tenant} and id = ${skillId}`
      await tx`update skill_installations set status = 'installed', skill_id = ${skillId}, version_id = ${versionId}, updated_at = now() where id = ${row.id}`
      await tx`
        insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
        values (${`audit-${randomUUID()}`}, ${tenant}, 'user', ${userId}, 'skill.install', 'skill', ${skillId}, 'success', ${`trace-${runId}`}, ${tx.json({ package_sha256: pkg.sha256 })})
      `
    })
    return this.detail(userId, owned.sessionId)
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
      select i.id, i.run_id as "runId", i.source, i.resolved_url as "resolvedUrl", i.resolved_ref as "resolvedRef", i.package, i.status, i.skill_id as "skillId", i.version_id as "versionId"
      from skill_installations i join runs r on r.tenant_id = i.tenant_id and r.id = i.run_id where i.tenant_id = ${tenant} and r.session_id = ${sessionId}
    `
  }
}
function preview(row: InstallationRow) {
  return { id: row.id, runId: row.runId, source: row.source.url ?? '', resolvedUrl: row.resolvedUrl, resolvedRef: row.resolvedRef, status: row.status, skillId: row.skillId,
    package: row.package ? { ...row.package, files: row.package.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) } : null }
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
