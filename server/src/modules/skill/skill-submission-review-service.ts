import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { notFound, stateConflict } from '../../domain/request-errors.ts'
import type { AuditTrail } from '../../domain/audit-trail.ts'
import type {
  SkillSubmissionReviewDetail,
  SkillSubmissionReviewItem,
  SkillSubmissionTrialStatus,
} from '../../domain/types.ts'
import type { PostgresSkillService, SkillTestRunProgress } from './postgres-skill-service.ts'
import type { SkillCompatibility, SkillPackageArtifact } from './skill-package.ts'
import type { SkillArtifactStore } from './skill-artifact-store.ts'
import { skillConflict, skillInvalid } from './skill-errors.ts'
import { recordUserNotification } from '../notification/user-notification-writer.ts'
import { DEFAULT_SKILL_TEST_PROMPT, installationKey, lockInstallationKey, nextInstalledVersion } from './skill-identity.ts'

const tenantId = 'tenant-dsh-work'
const SUBMISSION_CATEGORY = '员工创建 Skill'

type SkillService = Pick<PostgresSkillService,
  'requirePlatformAdmin' | 'normalizeVisibleRoles' | 'startSkillTest' | 'getSkillTestProgress' | 'publishSubmissionDraft'>

interface ReviewRow {
  id: string
  name: string
  source: SkillSubmissionReviewItem['source']
  sessionId: string | null
  status: SkillSubmissionReviewItem['status']
  skillId: string | null
  submitterId: string
  submitterName: string
  submittedAt: Date | null
  versionId: string
  versionNumber: number
  scriptCount: number
  artifact: SkillPackageArtifact
  compatibility: SkillCompatibility
  skillVersionId: string | null
  publishedSkillId: string | null
  publishedVisibleRoleIds: string[] | null
}

/**
 * 管理员审核员工 Skill 提交（docs/design/skill-creator-plan.md 4.4，SC3/SC4）。
 *
 * - 管理员在详情点“开始试运行”：平台以该管理员身份把提交的当前版本存为 Skill 的待发布版本（新 Skill
 *   或已通过 Skill 的新版本，安装来源 submission），再走现有严格试运行；运行与证据记在该管理员名下。
 * - 通过：沿用现有发布门禁（当前版本须有严格试运行通过证据），在同一发布事务中写入可见范围与审核结论，
 *   不先以全员可见发布再收窄。
 * - 拒绝：必须填写原因；释放待发布版本指针。提交人在草稿卡片上看到结论。
 *
 * 所有审核动作都锁定提交并核对“待审核且仍是管理员看到的版本”，员工撤回后再保存的新版本不会被盲审通过。
 */
export class SkillSubmissionReviewService {
  private readonly database: DatabaseClient
  private readonly skills: SkillService
  private readonly artifactStore: SkillArtifactStore
  private readonly audit?: AuditTrail

  constructor(input: { database: DatabaseClient; skills: SkillService; artifactStore: SkillArtifactStore; audit?: AuditTrail }) {
    this.database = input.database
    this.skills = input.skills
    this.artifactStore = input.artifactStore
    this.audit = input.audit
  }

  /** 待审核列表：按提交时间先后。 */
  async listPending(): Promise<SkillSubmissionReviewItem[]> {
    const rows = await this.readRows({})
    return Promise.all(rows.map(async row => ({ ...toItem(row), trial: await this.trialState(row.skillVersionId) })))
  }

  async getDetail(submissionId: string): Promise<SkillSubmissionReviewDetail> {
    const [row] = await this.readRows({ submissionId })
    if (!row) throw notFound('提交不存在或已撤回')
    const trial = await this.trialState(row.skillVersionId)
    return {
      ...toItem(row),
      files: row.artifact.files.map(file => ({ path: file.path, size: file.size, script: file.path.endsWith('.py') })),
      compatibility: row.compatibility,
      trial: {
        ...trial,
        ...(row.skillVersionId ? { skillId: row.skillId ?? undefined } : {}),
        ...(trial.resultSummary ? { resultSummary: trial.resultSummary } : {}),
      },
    }
  }

  /** 审核详情预览：读取提交版本中的一个文件（SKILL.md、脚本源码等），按纯文本展示。 */
  async readVersionFile(submissionId: string, versionId: string, path: string) {
    const [row] = await this.database<{ artifact: SkillPackageArtifact }[]>`
      select v.artifact from skill_submission_versions v
        join skill_submissions s on s.tenant_id = v.tenant_id and s.id = v.submission_id
       where v.tenant_id = ${tenantId} and v.id = ${versionId} and s.id = ${submissionId} and s.status <> 'draft'
    `
    if (!row) throw notFound('提交不存在或已撤回')
    const pkg = await this.artifactStore.read(row.artifact)
    const file = pkg.files.find(item => item.path === path)
    if (!file) throw notFound(`提交中没有这个文件：${path}`)
    return { path: file.path, size: file.size, content: file.content }
  }

  /** 开始严格试运行：先把提交的当前版本存为 Skill 待发布版本（已存过则沿用），再复用管理员试运行。 */
  async startTrial(actorId: string, submissionId: string, versionId: string): Promise<SkillTestRunProgress> {
    const actor = await this.skills.requirePlatformAdmin(actorId)
    const skillId = await this.database.begin(transaction => this.materialize(transaction, actor.id, submissionId, versionId))
    return this.skills.startSkillTest({ skillId, actor: actor.id })
  }

  async getTrialProgress(actorId: string, submissionId: string, runId: string): Promise<SkillTestRunProgress> {
    const [row] = await this.database<{ skillId: string | null }[]>`
      select skill_id as "skillId" from skill_submissions where tenant_id = ${tenantId} and id = ${submissionId}
    `
    if (!row?.skillId) throw notFound('这个提交还没有开始试运行')
    return this.skills.getSkillTestProgress({ skillId: row.skillId, runId, actor: actorId })
  }

  /** 通过并发布：可见范围为 null（全员）或非空角色列表。 */
  async approve(actorId: string, submissionId: string, input: { versionId?: unknown; visibleRoleIds?: unknown }) {
    const actor = await this.skills.requirePlatformAdmin(actorId)
    if (typeof input.versionId !== 'string' || !input.versionId) throw skillInvalid('versionId 必须是非空字符串')
    const versionId = input.versionId
    const roleIds = await this.skills.normalizeVisibleRoles(input.visibleRoleIds)
    const [row] = await this.database<{ status: string; skillId: string | null; skillVersionId: string | null }[]>`
      select s.status, s.skill_id as "skillId", v.skill_version_id as "skillVersionId"
        from skill_submissions s
        join skill_submission_versions v on v.tenant_id = s.tenant_id and v.id = s.current_version_id
       where s.tenant_id = ${tenantId} and s.id = ${submissionId}
    `
    if (!row) throw notFound('提交不存在或已撤回')
    // 先给出明确结论；发布事务内 lockPending 仍会再次核对。
    if (row.status !== 'pending') throw stateConflict('这个提交已撤回或已审核，请刷新')
    if (!row.skillId || !row.skillVersionId) throw skillConflict('这个提交还没有通过严格试运行，不能发布', 'skill_test_required')
    const skillVersionId = row.skillVersionId
    let lockedName = ''
    let submitterUserId = ''
    // 员工撤回后原样再次提交时，待发布版本指针已释放：先指回已存的版本，沿用其试运行证据。
    await this.database.begin(async transaction => {
      const submission = await lockPending(transaction, submissionId, versionId)
      if (submission.skillVersionId !== skillVersionId) throw stateConflict('提交的版本已变化，请刷新后重新审核')
      await pointDraft(transaction, row.skillId!, skillVersionId)
    })
    const result = await this.skills.publishSubmissionDraft({
      skillId: row.skillId,
      skillVersionId,
      actor: actor.id,
      // 加锁顺序与撤回、拒绝一致：先提交，再同名互斥锁，最后 Skill（publishDraft 随后锁定）。
      lock: async transaction => {
        const submission = await lockPending(transaction, submissionId, versionId)
        if (submission.skillVersionId !== skillVersionId) throw stateConflict('提交的版本已变化，请刷新后重新审核')
        lockedName = submission.name
        submitterUserId = submission.submitterUserId
        await lockInstallationKey(transaction, tenantId, installationKey(submission.name))
      },
      apply: async transaction => {
        const key = installationKey(lockedName)
        const [taken] = await transaction<{ id: string }[]>`
          select id from skills where tenant_id = ${tenantId} and installation_key = ${key} and id <> ${row.skillId}
        `
        if (taken) throw skillConflict(`已有同名 Skill“${lockedName}”，不能发布；请拒绝并说明需要换一个名称`, 'skill_name_conflict')
        await transaction`
          update skills set visible_role_ids = ${roleIds ? transaction.json(roleIds) : null},
                            installation_key = ${key}, updated_at = now()
           where tenant_id = ${tenantId} and id = ${row.skillId}
        `
        await transaction`
          update skill_submissions
             set status = 'approved', reviewed_by = ${actor.id}, reviewed_at = now(), reviewed_version_id = ${versionId},
                 review_note = null, updated_at = now()
           where tenant_id = ${tenantId} and id = ${submissionId}
        `
        await notifyReviewResult(transaction, { submissionId, versionId, submitterUserId, reviewerId: actor.id, result: 'approved' })
      },
    })
    await this.audit?.appendAudit(actor.id, 'skill.submission.approve', submissionId, 'success', `trace-skill-${randomUUID()}`,
      `发布为 Skill ${row.skillId} v${result.release.version}；可见范围：${roleIds ? roleIds.join('、') : '全员'}`, 'skill_submission')
    return { ...(await this.getDetail(submissionId)), skill: result.skill }
  }

  /** 拒绝：必须填写 1～500 字原因（提交人在草稿卡片上看到）。 */
  async reject(actorId: string, submissionId: string, input: { versionId?: unknown; note?: unknown }) {
    const actor = await this.skills.requirePlatformAdmin(actorId)
    if (typeof input.versionId !== 'string' || !input.versionId) throw skillInvalid('versionId 必须是非空字符串')
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (!note || note.length > 500) throw skillInvalid('请填写 1～500 字的拒绝原因，提交人会在草稿卡片上看到')
    const versionId = input.versionId
    await this.database.begin(async transaction => {
      const submission = await lockPending(transaction, submissionId, versionId)
      await releaseSubmissionDraft(transaction, submission.skillId, submission.skillVersionId)
      // 被拒的版本不会再发布（再次提交须保存新版本），作废它存下的待发布版本。
      await retireSubmissionVersions(transaction, submissionId, null)
      await transaction`
        update skill_submissions
           set status = 'rejected', reviewed_by = ${actor.id}, reviewed_at = now(), reviewed_version_id = ${versionId},
               review_note = ${note}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${submissionId}
      `
      await notifyReviewResult(transaction, {
        submissionId, versionId, submitterUserId: submission.submitterUserId, reviewerId: actor.id, result: 'rejected',
      })
    })
    await this.audit?.appendAudit(actor.id, 'skill.submission.reject', submissionId, 'success', `trace-skill-${randomUUID()}`,
      `拒绝原因：${note}`, 'skill_submission')
    return this.getDetail(submissionId)
  }

  private async materialize(transaction: DatabaseTransaction, actorId: string, submissionId: string, versionId: string) {
    const submission = await lockPending(transaction, submissionId, versionId)
    if (submission.compatibility.status === 'incompatible') throw stateConflict('这个版本不兼容，不能试运行')
    if (submission.skillId && submission.skillVersionId) {
      await pointDraft(transaction, submission.skillId, submission.skillVersionId)
      return submission.skillId
    }
    if (submission.skillId) {
      const [skill] = await transaction<{ draftVersionId: string | null }[]>`
        select draft_version_id as "draftVersionId" from skills where tenant_id = ${tenantId} and id = ${submission.skillId} for update
      `
      if (skill?.draftVersionId) throw skillConflict('这个 Skill 已有其他待发布版本，请先在 Skill 详情中处理后再试运行', 'skill_draft_conflict')
    }
    const key = installationKey(submission.name)
    await lockInstallationKey(transaction, tenantId, key)
    const [taken] = await transaction<{ id: string }[]>`
      select id from skills where tenant_id = ${tenantId} and installation_key = ${key}
         and id is distinct from ${submission.skillId}
    `
    if (taken) throw skillConflict(`已有同名 Skill“${submission.name}”；请拒绝并说明需要换一个名称`, 'skill_name_conflict')

    const pkg = await this.artifactStore.read(submission.artifact)
    let skillId = submission.skillId
    let version = '0.1.0'
    if (skillId) {
      const [latest] = await transaction<{ version: string }[]>`
        select version from skill_versions where tenant_id = ${tenantId} and skill_id = ${skillId}
        order by split_part(version, '.', 1)::integer desc, split_part(version, '.', 2)::integer desc, split_part(version, '.', 3)::integer desc limit 1
      `
      if (latest) version = nextInstalledVersion(latest.version)
    } else {
      skillId = `skill-${randomUUID().slice(0, 12)}`
      // 通过审核前不占用 installation_key：未通过的提交不阻止管理员安装同名 Skill，通过时再核对重名。
      await transaction`
        insert into skills (id, tenant_id, key, installation_key, name, category, description, owner_user_id, created_by, status)
        values (${skillId}, ${tenantId}, ${skillId}, null, ${pkg.name}, ${SUBMISSION_CATEGORY}, ${pkg.description},
                ${submission.submitterUserId}, ${actorId}, 'draft')
      `
      await transaction`update skill_submissions set skill_id = ${skillId} where tenant_id = ${tenantId} and id = ${submissionId}`
    }
    const installationId = `skill-installation-${randomUUID()}`
    const skillVersionId = `skill-version-${randomUUID()}`
    await transaction`
      insert into skill_versions (id, tenant_id, skill_id, version, name, category, description, instructions, manifest,
                                  artifact_ref, package_sha256, tool_refs, test_prompt, status, created_by, change_summary)
      values (${skillVersionId}, ${tenantId}, ${skillId}, ${version}, ${pkg.name}, ${SUBMISSION_CATEGORY}, ${pkg.description}, '',
              ${transaction.json(JSON.parse(JSON.stringify({
                artifact: submission.artifact, installationId, dependencies: [],
                submissionId, submissionVersionId: versionId,
              })))},
              ${submission.artifact.artifactRef}, ${submission.artifact.sha256}, ${transaction.json(submission.artifact.toolIds)},
              ${DEFAULT_SKILL_TEST_PROMPT}, 'draft', ${actorId}, ${`员工提交审核（对话创建，第 ${submission.versionNumber} 版）`})
    `
    await transaction`
      insert into skill_installations (id, tenant_id, run_id, created_by, source, package, status, skill_id, version_id,
                                       channel, result_type, installed_version, compatibility_status)
      values (${installationId}, ${tenantId}, null, ${actorId},
              ${transaction.json({ type: 'submission', submissionId, versionId })}, ${transaction.json(JSON.parse(JSON.stringify(submission.artifact)))},
              'installed', ${skillId}, ${skillVersionId}, 'submission', ${submission.skillId ? 'updated' : 'created'}, ${version},
              ${submission.compatibility.status})
    `
    await transaction`
      update skills set draft_version_id = ${skillVersionId}, name = ${pkg.name}, description = ${pkg.description}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${skillId}
    `
    await transaction`
      update skill_submission_versions set skill_version_id = ${skillVersionId}
       where tenant_id = ${tenantId} and id = ${versionId}
    `
    // 员工撤回后修改再提交：此前版本存下的待发布版本不会再发布，标为停用并取消其安装记录。
    await retireSubmissionVersions(transaction, submissionId, skillVersionId)
    return skillId
  }

  /** 最近一次严格试运行：已记录的结果，或尚未记录结果的已启动运行。 */
  private async trialState(skillVersionId: string | null): Promise<SkillSubmissionReviewItem['trial'] & { resultSummary?: string }> {
    if (!skillVersionId) return { status: 'not_started' }
    const [result] = await this.database<{ status: 'passed' | 'failed'; runId: string | null; summary: string; createdAt: Date }[]>`
      select status, runtime_run_id as "runId", result_summary as summary, created_at as "createdAt" from skill_test_runs
       where tenant_id = ${tenantId} and skill_version_id = ${skillVersionId} and evidence_policy <> 'legacy'
       order by created_at desc limit 1
    `
    const [binding] = await this.database<{ runId: string; runStatus: string; createdAt: Date }[]>`
      select b.run_id as "runId", r.status as "runStatus", b.created_at as "createdAt"
        from skill_test_bindings b join runs r on r.tenant_id = b.tenant_id and r.id = b.run_id
       where b.tenant_id = ${tenantId} and b.skill_version_id = ${skillVersionId}
       order by b.created_at desc limit 1
    `
    if (binding && (!result || (binding.runId !== result.runId && binding.createdAt > result.createdAt))) {
      const status: SkillSubmissionTrialStatus = ['succeeded', 'failed', 'cancelled'].includes(binding.runStatus) ? 'unconfirmed' : 'running'
      return { status, runId: binding.runId }
    }
    if (!result) return { status: 'not_started' }
    return {
      status: result.status,
      ...(result.runId ? { runId: result.runId } : {}),
      testedAt: result.createdAt.toISOString(),
      resultSummary: result.summary,
    }
  }

  /** 不带 submissionId 时只列待审核；带时取该提交（已撤回回到草稿的不给管理员看）。 */
  private readRows(filter: { submissionId?: string }) {
    return this.database<ReviewRow[]>`
      select s.id, s.name, s.source, s.session_id as "sessionId", s.status, s.skill_id as "skillId",
             s.submitter_user_id as "submitterId", u.display_name as "submitterName", s.submitted_at as "submittedAt",
             v.id as "versionId", v.version_number as "versionNumber", v.script_count as "scriptCount",
             v.artifact, v.compatibility, v.skill_version_id as "skillVersionId",
             case when skill.active_version_id is not null then skill.id end as "publishedSkillId",
             skill.visible_role_ids as "publishedVisibleRoleIds"
        from skill_submissions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.submitter_user_id
        join skill_submission_versions v on v.tenant_id = s.tenant_id and v.id = s.current_version_id
        left join skills skill on skill.tenant_id = s.tenant_id and skill.id = s.skill_id
       where s.tenant_id = ${tenantId}
         and ${filter.submissionId ? this.database`s.id = ${filter.submissionId} and s.status <> 'draft'` : this.database`s.status = 'pending'`}
       order by s.submitted_at asc nulls last, s.created_at asc
    `
  }
}

interface LockedSubmission {
  name: string
  submitterUserId: string
  skillId: string | null
  versionNumber: number
  artifact: SkillPackageArtifact
  compatibility: SkillCompatibility
  skillVersionId: string | null
}

/** 锁定提交，要求仍待审核且当前版本就是管理员看到的版本。 */
async function lockPending(transaction: DatabaseTransaction, submissionId: string, versionId: string): Promise<LockedSubmission> {
  const [row] = await transaction<{ status: string; currentVersionId: string | null; name: string; submitterUserId: string; skillId: string | null }[]>`
    select status, current_version_id as "currentVersionId", name, submitter_user_id as "submitterUserId", skill_id as "skillId"
      from skill_submissions where tenant_id = ${tenantId} and id = ${submissionId}
     for update
  `
  if (!row) throw notFound('提交不存在')
  if (row.status !== 'pending') throw stateConflict('这个提交已撤回或已审核，请刷新')
  if (row.currentVersionId !== versionId) throw stateConflict('提交的版本已变化，请刷新后重新审核')
  // 取得锁后单独读取版本：并发审核时能看到前一事务刚写入的 skill_version_id，而不是加锁前的快照。
  const [version] = await transaction<Pick<LockedSubmission, 'versionNumber' | 'artifact' | 'compatibility' | 'skillVersionId'>[]>`
    select version_number as "versionNumber", artifact, compatibility, skill_version_id as "skillVersionId"
      from skill_submission_versions where tenant_id = ${tenantId} and id = ${versionId} and submission_id = ${submissionId}
  `
  if (!version) throw stateConflict('提交的版本已变化，请刷新后重新审核')
  return { name: row.name, submitterUserId: row.submitterUserId, skillId: row.skillId, ...version }
}

/** 让 Skill 的待发布版本指向提交存下的版本；已被其他待发布版本占用时拒绝。 */
async function pointDraft(transaction: DatabaseTransaction, skillId: string, skillVersionId: string) {
  const [skill] = await transaction<{ draftVersionId: string | null }[]>`
    select draft_version_id as "draftVersionId" from skills where tenant_id = ${tenantId} and id = ${skillId} for update
  `
  if (skill?.draftVersionId === skillVersionId) return
  if (skill?.draftVersionId) throw skillConflict('这个 Skill 已有其他待发布版本，请先在 Skill 详情中处理后再审核', 'skill_draft_conflict')
  await transaction`
    update skills set draft_version_id = ${skillVersionId}, updated_at = now()
     where tenant_id = ${tenantId} and id = ${skillId}
  `
}

/** 作废提交中除 `keep` 以外仍为草稿的待发布版本：版本标为停用、安装记录取消；试运行证据保留。 */
async function retireSubmissionVersions(transaction: DatabaseTransaction, submissionId: string, keep: string | null) {
  const retired = await transaction<{ id: string }[]>`
    update skill_versions sv set status = 'disabled'
      from skill_submission_versions v
     where v.tenant_id = ${tenantId} and v.submission_id = ${submissionId} and v.skill_version_id = sv.id
       and sv.tenant_id = ${tenantId} and sv.status = 'draft' and sv.id is distinct from ${keep}
       and not exists (select 1 from skills s where s.tenant_id = sv.tenant_id and s.draft_version_id = sv.id)
    returning sv.id
  `
  if (!retired.length) return
  await transaction`
    update skill_installations set status = 'cancelled', updated_at = now()
     where tenant_id = ${tenantId} and channel = 'submission' and version_id in ${transaction(retired.map(row => row.id))}
  `
}

/** 撤回或拒绝时释放提交占用的 Skill 待发布版本指针，不影响已发布版本；版本记录与试运行证据保留。 */
export async function releaseSubmissionDraft(transaction: DatabaseTransaction, skillId: string | null, skillVersionId: string | null) {
  if (!skillId || !skillVersionId) return
  await transaction`
    update skills set draft_version_id = null, updated_at = now()
     where tenant_id = ${tenantId} and id = ${skillId} and draft_version_id = ${skillVersionId}
  `
}

function toItem(row: ReviewRow): SkillSubmissionReviewItem {
  return {
    id: row.id,
    name: row.name,
    description: row.artifact.description,
    submitter: { id: row.submitterId, displayName: row.submitterName },
    source: row.source,
    sessionId: row.sessionId,
    status: row.status,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    scriptCount: row.scriptCount,
    ...(row.publishedSkillId ? { publishedSkillId: row.publishedSkillId, publishedVisibleRoleIds: row.publishedVisibleRoleIds } : {}),
    trial: { status: 'not_started' },
    submittedAt: (row.submittedAt ?? new Date(0)).toISOString(),
  }
}


/**
 * 审核结论通知提交人（站内通知 NC-S3），与审核同一事务。只带结论代码，不带拒绝原因
 * （原因在草稿卡片上）；跳转所需的对话由读取时从提交记录解析。管理员审核自己的提交不通知。
 */
async function notifyReviewResult(transaction: DatabaseTransaction, input: {
  submissionId: string; versionId: string; submitterUserId: string; reviewerId: string; result: 'approved' | 'rejected'
}) {
  await recordUserNotification(transaction, {
    recipientUserId: input.submitterUserId, kind: 'skill_review_result', workspaceId: null,
    objectType: 'skill_submission', objectId: input.submissionId, actorUserId: input.reviewerId,
    dedupeKey: `skill_review:${input.submissionId}:${input.versionId}`, metadata: { result: input.result },
  })
}
