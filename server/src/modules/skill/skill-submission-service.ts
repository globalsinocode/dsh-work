import type { PythonModuleIndex } from '../runtime/execution-backend.ts'
import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { assertRealWorkspaceDirectory } from '../../infrastructure/storage/workspace-directory.ts'
import { MAX_SKILL_BYTES, MAX_SKILL_FILES } from '../../domain/skill-package-limits.ts'
import { RequestError, notFound, stateConflict } from '../../domain/request-errors.ts'
import type { SkillDraftView } from '../../domain/types.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import { toolPreconditionFailed } from '../runtime/platform-tool-contract.ts'
import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import type { PostgresSkillService } from './postgres-skill-service.ts'
import type { BuiltinSkillCatalog } from './builtin-skills.ts'
import { isReservedBuiltinSkillName } from './builtin-skills.ts'
import { parseSkillDirectoryFiles, type SkillCompatibility, type SkillPackageArtifact } from './skill-package.ts'
import { buildSkillInstallationPlan } from './skill-installation-plan.ts'
import type { SkillArtifactStore } from './skill-artifact-store.ts'
import { releaseSubmissionDraft } from './skill-submission-review-service.ts'
import { installationKey } from './skill-identity.ts'

const tenantId = 'tenant-dsh-work'
const MAX_LISTED_SKILLS = 50
/** 每位员工同时待审核的提交上限（skill-creator-plan 7 待定项，原型确认为 5）。 */
export const MAX_PENDING_SUBMISSIONS = 5
/** 草稿目录不能放在这些工作区目录下：output/ 是成果、input/ 是员工文件、skills/ 是已激活 Skill 的只读副本。 */
const RESERVED_WORKSPACE_ROOTS = new Set(['output', 'input', 'skills'])

export type { SkillDraftView }

interface SubmissionRow {
  id: string
  submitterUserId: string
  status: 'draft' | 'pending' | 'approved' | 'rejected'
  currentVersionId: string | null
  skillId: string | null
}

/**
 * Skill 创建专家（docs/design/skill-creator-plan.md 4.2～4.3）。
 *
 * - `list_available_skills`：发起员工当前可选用的已发布 Skill（同 Skill 广场口径）与平台内置 Skill，供先查重。
 * - `skill_draft_save`：读取本 Attempt 工作区中的一个 Skill 目录，按与 ZIP 安装相同的包规则与兼容性检查
 *   校验，存为不可变的草稿版本。只保存草稿；提交审核由员工在卡片上发起（SC2），不经模型。
 *
 * 平台不证明草稿“试跑通过”：专家在执行容器中的试跑与保存的包没有绑定。严格试运行在审核时由管理员发起
 * （skill-submission-review-service）。
 */
export class SkillSubmissionService {
  private readonly database: DatabaseClient
  private readonly skills: Pick<PostgresSkillService, 'listWorkbenchSkills'>
  private readonly authorization: Pick<PostgresAuthorizationService, 'authorizeWorkbench'>
  private readonly artifactStore: SkillArtifactStore
  private readonly builtinSkills?: BuiltinSkillCatalog
  private readonly python: { sandboxAvailable: boolean; packages: string[]; modules: PythonModuleIndex | null }

  constructor(input: {
    database: DatabaseClient
    skills: Pick<PostgresSkillService, 'listWorkbenchSkills'>
    authorization: Pick<PostgresAuthorizationService, 'authorizeWorkbench'>
    artifactStore: SkillArtifactStore
    builtinSkills?: BuiltinSkillCatalog
    pythonSandboxAvailable?: boolean
    pythonPackages?: string[]
    pythonModules?: PythonModuleIndex | null
  }) {
    this.database = input.database
    this.skills = input.skills
    this.authorization = input.authorization
    this.artifactStore = input.artifactStore
    this.builtinSkills = input.builtinSkills
    this.python = { sandboxAvailable: input.pythonSandboxAvailable === true, packages: input.pythonPackages ?? [], modules: input.pythonModules ?? null }
  }

  /** `list_available_skills`：员工本人可选用的已发布 Skill 与平台内置 Skill，可按关键词筛选。 */
  async listAvailableSkills(manifest: RuntimeManifest, input: Record<string, unknown>) {
    assertConversation(manifest)
    const query = typeof input['query'] === 'string' ? input['query'].trim().toLowerCase() : ''
    const context = await this.authorization.authorizeWorkbench({ userId: manifest.user_context.user_id })
    const installed = (await this.skills.listWorkbenchSkills(context.roleIds))
      .map(skill => ({ name: skill.name, description: skill.description, source: 'skill-plaza' as const }))
    const builtin = (this.builtinSkills?.skills ?? [])
      .map(skill => ({ name: skill.name, description: skill.description, source: 'platform-builtin' as const }))
    const matches = [...installed, ...builtin]
      .filter(skill => !query || `${skill.name}\n${skill.description}`.toLowerCase().includes(query))
    return { skills: matches.slice(0, MAX_LISTED_SKILLS), total: matches.length }
  }

  /** `skill_draft_save`：校验工作区中的 Skill 目录并保存为新的草稿版本。 */
  async saveDraft(manifest: RuntimeManifest, input: Record<string, unknown>, workspaceDirectory: string) {
    assertConversation(manifest)
    const directory = normalizeDraftDirectory(input['directory'])
    const files = await readDraftDirectory(workspaceDirectory, directory)
    let parsed
    try {
      parsed = parseSkillDirectoryFiles(files)
    } catch (error) {
      if (error instanceof RequestError) throw toolPreconditionFailed(error.message)
      throw error
    }
    const plan = buildSkillInstallationPlan({ root: parsed, packages: [parsed], edges: [] }, {
      pythonSandboxAvailable: this.python.sandboxAvailable,
      pythonPackages: this.python.packages,
      pythonModules: this.python.modules,
    })
    const pkg = plan.packages[0]!
    const compatibility = plan.compatibility
    if (isReservedBuiltinSkillName(pkg.name)) throw toolPreconditionFailed(`Skill 名称不能以平台内置 Skill 的后缀结尾：${pkg.name}`)
    const userId = manifest.user_context.user_id
    const sessionId = manifest.session_id!

    const [existing] = await this.database<SubmissionRow[]>`
      select id, submitter_user_id as "submitterUserId", status, current_version_id as "currentVersionId", skill_id as "skillId"
        from skill_submissions
       where tenant_id = ${tenantId} and source = 'conversation' and session_id = ${sessionId} and name = ${pkg.name}
    `
    // 不按名称覆盖已有 Skill（功能规则 5.3），与安装、审核同一规范化名称（忽略首尾空白与大小写）；通过审核后的修订沿用自己的 skill_id。其他尚未通过审核的提交
    // 在审核试运行时存下的 Skill 不占用名称（通过时再核对重名）。
    const [conflict] = await this.database<{ id: string }[]>`
      select s.id from skills s where s.tenant_id = ${tenantId}
        and (s.installation_key = ${installationKey(pkg.name)} or lower(btrim(s.name)) = ${installationKey(pkg.name)})
        and s.id is distinct from ${existing?.skillId ?? null}
        and not (s.active_version_id is null and exists (
          select 1 from skill_submissions other where other.tenant_id = s.tenant_id and other.skill_id = s.id
        ))
    `
    if (conflict) throw toolPreconditionFailed(`已有同名 Skill“${pkg.name}”，请换一个名称`)
    if (existing?.status === 'pending') throw toolPreconditionFailed('这个 Skill 已提交审核；请员工先在草稿卡片上撤回，再保存修改')

    const artifact = await this.artifactStore.put(pkg)
    const scriptCount = pkg.files.filter(file => file.path.endsWith('.py')).length
    const saved = await this.database.begin(async transaction => {
      const submissionId = existing?.id ?? `skill-submission-${randomUUID()}`
      if (!existing) {
        await transaction`
          insert into skill_submissions (id, tenant_id, submitter_user_id, source, session_id, name)
          values (${submissionId}, ${tenantId}, ${userId}, 'conversation', ${sessionId}, ${pkg.name})
        `
      }
      const [locked] = await transaction<{ status: string; currentVersionId: string | null }[]>`
        select status, current_version_id as "currentVersionId" from skill_submissions
         where tenant_id = ${tenantId} and id = ${submissionId} for update
      `
      if (locked?.status === 'pending') throw toolPreconditionFailed('这个 Skill 已提交审核；请员工先在草稿卡片上撤回，再保存修改')
      const [{ next }] = await transaction<{ next: number }[]>`
        select coalesce(max(version_number), 0) + 1 as next from skill_submission_versions
         where tenant_id = ${tenantId} and submission_id = ${submissionId}
      `
      const versionId = `skill-submission-version-${randomUUID()}`
      await transaction`
        insert into skill_submission_versions (
          id, tenant_id, submission_id, version_number, run_id, attempt_id, artifact, package_sha256, compatibility, script_count
        ) values (
          ${versionId}, ${tenantId}, ${submissionId}, ${next}, ${manifest.run_id}, ${manifest.attempt_id},
          ${transaction.json(artifact as never)}, ${pkg.sha256}, ${transaction.json(compatibility as never)}, ${scriptCount}
        )
      `
      await transaction`
        update skill_submissions
           set current_version_id = ${versionId}, status = 'draft', submitted_at = null, updated_at = now()
         where tenant_id = ${tenantId} and id = ${submissionId}
      `
      return { submissionId, versionId, versionNumber: next }
    })
    return {
      ...saved,
      name: pkg.name,
      description: pkg.description,
      files: pkg.files.map(file => ({ path: file.path, size: file.size, script: file.path.endsWith('.py') })),
      compatibility,
      note: compatibility.status === 'incompatible'
        ? '已保存，但这个版本不兼容，员工不能提交。按 compatibility.issues 修改后重新保存。'
        : '草稿已保存，并作为卡片显示在你的回复下方。是否提交审核由员工在卡片上决定，不要替员工提交。',
    }
  }

  /** 员工在草稿卡片上提交审核：只能提交自己的、当前版本的、非不兼容的草稿；同时待审核不超过上限。 */
  async submit(userId: string, submissionId: string, versionId: string) {
    await this.authorization.authorizeWorkbench({ userId })
    await this.database.begin(async transaction => {
      await transaction`select pg_advisory_xact_lock(hashtext(${`skill-submission:${tenantId}:${userId}`}))`
      const submission = await lockOwnSubmission(transaction, userId, submissionId)
      if (submission.status === 'pending') return
      if (submission.status !== 'draft') throw stateConflict('这个草稿已审核，修改后保存新版本再提交')
      if (submission.currentVersionId !== versionId) throw stateConflict('草稿已有更新的版本，请提交最新版本')
      const [version] = await transaction<{ compatibility: SkillCompatibility }[]>`
        select compatibility from skill_submission_versions where tenant_id = ${tenantId} and id = ${versionId}
      `
      if (version?.compatibility.status === 'incompatible') throw stateConflict('这个版本不兼容，不能提交审核')
      const [{ count }] = await transaction<{ count: number }[]>`
        select count(*)::integer as count from skill_submissions
         where tenant_id = ${tenantId} and submitter_user_id = ${userId} and status = 'pending'
      `
      if (count >= MAX_PENDING_SUBMISSIONS) {
        throw stateConflict(`你已有 ${MAX_PENDING_SUBMISSIONS} 个 Skill 在等待审核，等审核完成或撤回一个后再提交`)
      }
      await transaction`
        update skill_submissions set status = 'pending', submitted_at = now(), review_note = null, updated_at = now()
         where tenant_id = ${tenantId} and id = ${submissionId}
      `
    })
    return this.getDraft(userId, submissionId)
  }

  /** 员工撤回尚未审核的提交，回到草稿。 */
  async withdraw(userId: string, submissionId: string) {
    await this.authorization.authorizeWorkbench({ userId })
    await this.database.begin(async transaction => {
      const submission = await lockOwnSubmission(transaction, userId, submissionId)
      if (submission.status === 'draft') return
      if (submission.status !== 'pending') throw stateConflict('只有等待审核的提交可以撤回')
      const [version] = await transaction<{ skillVersionId: string | null }[]>`
        select skill_version_id as "skillVersionId" from skill_submission_versions
         where tenant_id = ${tenantId} and id = ${submission.currentVersionId}
      `
      await releaseSubmissionDraft(transaction, submission.skillId, version?.skillVersionId ?? null)
      await transaction`
        update skill_submissions set status = 'draft', submitted_at = null, updated_at = now()
         where tenant_id = ${tenantId} and id = ${submissionId}
      `
    })
    return this.getDraft(userId, submissionId)
  }

  /** 草稿卡片预览：读取某个版本中的一个文本文件（只限提交人本人）。 */
  async readVersionFile(userId: string, submissionId: string, versionId: string, path: string) {
    await this.authorization.authorizeWorkbench({ userId })
    const [row] = await this.database<{ artifact: SkillPackageArtifact }[]>`
      select v.artifact from skill_submission_versions v
        join skill_submissions s on s.tenant_id = v.tenant_id and s.id = v.submission_id
       where v.tenant_id = ${tenantId} and v.id = ${versionId} and s.id = ${submissionId}
         and s.submitter_user_id = ${userId}
    `
    if (!row) throw notFound('草稿不存在或不可访问')
    const pkg = await this.artifactStore.read(row.artifact)
    const file = pkg.files.find(item => item.path === path)
    if (!file) throw notFound(`草稿中没有这个文件：${path}`)
    return { path: file.path, size: file.size, content: file.content }
  }

  /** 会话详情的草稿卡片：各 Run 当前 Attempt 保存的版本，带所属提交的当前状态。只给提交人本人看。 */
  async loadForRuns(runIds: string[], viewerUserId: string): Promise<SkillDraftView[]> {
    if (!runIds.length) return []
    const rows = await this.database<DraftRow[]>`
      select v.id as "versionId", v.version_number as "versionNumber", v.run_id as "runId",
             v.artifact, v.compatibility, v.script_count as "scriptCount",
             s.id as "submissionId", s.name, s.status, s.current_version_id as "currentVersionId",
             s.review_note as "reviewNote", s.submitted_at as "submittedAt", s.reviewed_at as "reviewedAt"
        from skill_submission_versions v
        join runs r on r.tenant_id = v.tenant_id and r.id = v.run_id and r.current_attempt_id = v.attempt_id
        join skill_submissions s on s.tenant_id = v.tenant_id and s.id = v.submission_id
       where v.tenant_id = ${tenantId} and v.run_id = any(${runIds})
         and s.submitter_user_id = ${viewerUserId}
       order by r.created_at, v.version_number
    `
    return rows.map(toDraftView)
  }

  private async getDraft(userId: string, submissionId: string): Promise<SkillDraftView> {
    const [row] = await this.database<DraftRow[]>`
      select v.id as "versionId", v.version_number as "versionNumber", v.run_id as "runId",
             v.artifact, v.compatibility, v.script_count as "scriptCount",
             s.id as "submissionId", s.name, s.status, s.current_version_id as "currentVersionId",
             s.review_note as "reviewNote", s.submitted_at as "submittedAt", s.reviewed_at as "reviewedAt"
        from skill_submissions s
        join skill_submission_versions v on v.tenant_id = s.tenant_id and v.id = s.current_version_id
       where s.tenant_id = ${tenantId} and s.id = ${submissionId} and s.submitter_user_id = ${userId}
    `
    if (!row) throw notFound('草稿不存在或不可访问')
    return toDraftView(row)
  }
}

interface DraftRow {
  versionId: string
  versionNumber: number
  runId: string | null
  artifact: SkillPackageArtifact
  compatibility: SkillCompatibility
  scriptCount: number
  submissionId: string
  name: string
  status: SkillDraftView['status']
  currentVersionId: string | null
  reviewNote: string | null
  submittedAt: Date | null
  reviewedAt: Date | null
}

function toDraftView(row: DraftRow): SkillDraftView {
  return {
    submissionId: row.submissionId,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    runId: row.runId ?? '',
    name: row.name,
    description: row.artifact.description,
    files: row.artifact.files.map(file => ({ path: file.path, size: file.size, script: file.path.endsWith('.py') })),
    compatibility: row.compatibility,
    status: row.status,
    latest: row.currentVersionId === row.versionId,
    ...(row.reviewNote ? { reviewNote: row.reviewNote } : {}),
    ...(row.submittedAt ? { submittedAt: row.submittedAt.toISOString() } : {}),
    ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
  }
}

async function lockOwnSubmission(transaction: DatabaseTransaction, userId: string, submissionId: string): Promise<SubmissionRow> {
  const [row] = await transaction<SubmissionRow[]>`
    select id, submitter_user_id as "submitterUserId", status, current_version_id as "currentVersionId", skill_id as "skillId"
      from skill_submissions where tenant_id = ${tenantId} and id = ${submissionId} for update
  `
  if (!row) throw notFound('草稿不存在或不可访问')
  // 不泄露他人提交是否存在：非提交人按不存在处理。
  if (row.submitterUserId !== userId) throw notFound('草稿不存在或不可访问')
  return row
}

function assertConversation(manifest: RuntimeManifest) {
  if (manifest.purpose || !manifest.session_id) throw toolPreconditionFailed('Skill 创建工具只用于员工个人对话')
}

/** 工具参数：工作区内的相对目录，不能是 output/、input/、skills/ 下的目录，不能逃出工作区。 */
export function normalizeDraftDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw toolPreconditionFailed('directory 必须是工作区内的相对目录，例如 drafts/weekly-report')
  const raw = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (isAbsolute(raw) || raw.startsWith('/')) throw toolPreconditionFailed('directory 必须是工作区内的相对路径')
  const normalized = normalize(raw).split(sep).join('/')
  if (!normalized || normalized === '.' || normalized.split('/').some(part => part === '..' || part === '')) {
    throw toolPreconditionFailed('directory 不能包含 .. 或空目录名')
  }
  if (RESERVED_WORKSPACE_ROOTS.has(normalized.split('/')[0]!)) {
    throw toolPreconditionFailed('草稿目录不能放在 output/、input/ 或 skills/ 下，请用 drafts/<名称> 这样的目录')
  }
  return normalized
}

/** 只收集普通文件；符号链接、特殊文件、超出数量或大小上限时拒绝（与 ZIP 安装同一上限）。 */
export async function readDraftDirectory(workspaceRoot: string, relativeDirectory: string): Promise<Record<string, Uint8Array>> {
  const root = join(workspaceRoot, relativeDirectory)
  let exists: boolean
  try {
    exists = await assertRealWorkspaceDirectory(workspaceRoot, root)
  } catch (error) {
    throw toolPreconditionFailed(error instanceof Error ? error.message : '草稿目录无效')
  }
  if (!exists) throw toolPreconditionFailed(`工作区中没有这个目录：${relativeDirectory}`)
  const files: Record<string, Uint8Array> = {}
  let total = 0
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      const details = await lstat(absolute)
      if (details.isSymbolicLink()) throw toolPreconditionFailed(`草稿目录不允许符号链接：${path}`)
      if (details.isDirectory()) { await walk(absolute, path); continue }
      if (!details.isFile()) throw toolPreconditionFailed(`草稿目录不允许特殊文件：${path}`)
      if (Object.keys(files).length >= MAX_SKILL_FILES) throw toolPreconditionFailed(`单个 Skill 最多包含 ${MAX_SKILL_FILES} 个文件`)
      total += details.size
      if (total > MAX_SKILL_BYTES) throw toolPreconditionFailed('Skill 文件总大小超过 1 MB')
      files[path] = await readFile(absolute)
    }
  }
  await walk(root, '')
  return files
}
