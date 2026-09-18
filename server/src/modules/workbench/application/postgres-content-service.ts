import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import type { Artifact, Workspace } from '../../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import { authorizationDenied, canReadWorkspaceObject, isAuthorizationDenial, requestInvalid } from '../../authorization/authorization-errors.ts'
import type { FileMount } from '../../runtime/runtime-types.ts'
import { isAdminRunPurpose } from '../../runtime/runtime-types.ts'
import { BaselineFileSafetyScanner, type FileSafetyScannerPort } from './file-safety-scanner.ts'
import { extractDocument } from './document-extractor.ts'
import { PostgresWorkspaceService, readableWorkspacePredicate, type WorkspaceType } from './postgres-workspace-service.ts'
import { workspaceStateConflict } from './workspace-state-conflict-error.ts'
import { recordWorkspaceActivity } from './workspace-activity-writer.ts'

const tenantId = 'tenant-dsh-work'
const allowedExtensions = new Set(['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md'])

interface FileRow {
  id: string
  storageKey: string
  originalName: string
  mimeType: string
  sizeBytes: string | number
  createdAt: Date
  uploadedBy: string
  workspaceId: string
}

export interface WorkspaceFileSummary {
  id: string
  name: string
  type: string
  size: string
  uploadedBy: string
  uploadedAt: string
  scanStatus: string
  removable: boolean
  canDownload: boolean
  /** 逻辑文件 ID（TW-07）：同一逻辑文件的所有版本共享它。 */
  logicalFileId: string
  /** 本行对应的版本号（列表返回最新有效版本）。 */
  versionNo: number
  /** 逻辑文件下的版本总数（含失败版本，用于追溯）。 */
  versionCount: number
}

export interface WorkspaceFilePage {
  items: WorkspaceFileSummary[]
  nextCursor: string | null
}

/** One immutable object pinned to a logical file version (TW-07 / AC-13). */
export interface WorkspaceFileVersionSummary {
  versionNo: number
  /** Immutable `file_objects.id` used for download and run references. */
  fileId: string
  logicalFileId: string
  name: string
  type: string
  size: string
  note: string | null
  uploadedBy: string
  uploadedAt: string
  scanStatus: string
  parseStatus: string
  /**
   * True for the version the file list currently displays for this logical file:
   * the highest successfully-parsed version, or the highest version when none
   * parsed. Note this can be true while `latestVersionNo` is 0 (a backfilled file
   * whose historical parse never succeeded), so do not compare the two fields.
   */
  current: boolean
  canDownload: boolean
}

export interface WorkspaceFileVersionPage {
  logicalFileId: string
  name: string
  status: string
  latestVersionNo: number
  versionCount: number
  items: WorkspaceFileVersionSummary[]
}

export interface UploadedWorkspaceFileVersion {
  id: string
  logicalFileId: string
  versionNo: number
  name: string
  type: string
  size: string
  uploadedBy: string
  uploadedAt: string
  extractionStatus: 'succeeded'
}

export type PersonalFileSource = 'material' | 'attachment' | 'artifact'
export interface PersonalFileSummary {
  id: string
  name: string
  type: string
  size: string
  createdAt: string
  source: PersonalFileSource
  sessionId: string | null
  sourceSessionState: 'active' | 'removed' | null
  artifactId: string | null
  version: number | null
  scanStatus: string
  parseStatus: string
  canDownload: boolean
  canReference: boolean
  removable: boolean
}
export interface PersonalFileQuery {
  actorUserId: string
  source?: PersonalFileSource | 'all'
  query?: string
  cursor?: string
  limit?: number
}

interface RuntimeFileRow {
  workspaceId: string
  fileId: string
  extractionId: string
  originalName: string
  mimeType: string
  textStorageKey: string
  textSha256: string
}

export interface PreparedRuntimeFile {
  fileId: string
  extractionId: string
  mount: FileMount
}

interface PreparedRuntimeArtifact {
  artifactId: string
  artifactVersionId: string
  fileId: string
  name: string
  type: Artifact['type']
  mimeType: string
  bytes: Buffer
  sha256: string
  storageKey: string
}

export class PostgresContentService {
  private readonly database: DatabaseClient
  private readonly storageRoot: string
  private readonly authorization: PostgresAuthorizationService
  private readonly scanner: FileSafetyScannerPort
  private readonly workspaces: PostgresWorkspaceService

  constructor(
    database: DatabaseClient,
    storageRoot: string,
    authorization: PostgresAuthorizationService,
    scanner: FileSafetyScannerPort = new BaselineFileSafetyScanner(),
    workspaces = new PostgresWorkspaceService(database),
  ) {
    this.database = database
    this.storageRoot = resolve(storageRoot)
    this.authorization = authorization
    this.scanner = scanner
    this.workspaces = workspaces
  }

  /**
   * Workspace list for one actor (batch 3 / 3-T2).
   *
   * `status` filters the workspace lifecycle: `all` (the default, matching the
   * confirmed design decision 设计 §2.1/§6「默认全部；个人空间恒显」), `active`,
   * or `archived` (3-T3 归档筛选 — only workspaces the caller may still access,
   * i.e. teams where the caller is still a current member; personal spaces are
   * always active, so they appear under all/active but never under archived).
   *
   * `owner` is the CURRENT owner (`workspace_members.member_role = 'owner'`)
   * rather than the creator, which is a known 1A gap fixed here so a transfer
   * is reflected and 3-T3 can render ownership correctly. `created_by` is kept
   * only as a defensive fallback for anomalous rows.
   */
  async listWorkspaces(
    actorUserId: string,
    options: { status?: 'active' | 'archived' | 'all' } = {},
  ): Promise<Workspace[]> {
    await this.workspaces.ensurePersonalWorkspace(actorUserId)
    // 与 HTTP 层默认保持一致（all）。服务层若仍默认 active，后续新增调用者漏传
    // 就会静默只看活动空间，归档空间不可发现。
    const status = options.status ?? 'all'
    const rows = await this.database<{
      id: string
      name: string
      description: string
      type: WorkspaceType
      status: 'active' | 'archived'
      archivedAt: Date | null
      owner: string
      memberCount: number
      sessionCount: number
      artifactCount: number
      updatedAt: Date
    }[]>`
      select w.id, w.name, w.description, w.workspace_type as type,
             w.status, w.archived_at as "archivedAt",
             coalesce(owner.display_name, creator.display_name) as owner,
             count(distinct wm.user_id)::integer as "memberCount",
             count(distinct s.id)::integer as "sessionCount",
             count(distinct a.id)::integer as "artifactCount",
             greatest(w.created_at, coalesce(max(s.last_active_at), w.created_at)) as "updatedAt"
        from workspaces w
        join users creator on creator.tenant_id = w.tenant_id and creator.id = w.created_by
        left join lateral (
          select ou.display_name
            from workspace_members om
            join users ou on ou.tenant_id = om.tenant_id and ou.id = om.user_id
           where om.tenant_id = w.tenant_id and om.workspace_id = w.id
             and om.member_role = 'owner'
           order by om.joined_at asc, om.user_id asc
           limit 1
        ) owner on true
        left join workspace_members wm on wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
        left join sessions s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
        left join artifacts a on a.tenant_id = w.tenant_id and a.workspace_id = w.id
       where w.tenant_id = ${tenantId}
         and ${status === 'all'
           ? this.database.unsafe(`w.status in ('active', 'archived')`)
           : status === 'archived'
             ? this.database.unsafe(`w.status = 'archived'`)
             : this.database.unsafe(`w.status = 'active'`)}
         and (${readableWorkspacePredicate(this.database, actorUserId)})
       group by w.id, creator.display_name, owner.display_name
       order by "updatedAt" desc
    `
    return Promise.all(rows.map(async (row) => {
      const members = await this.database<{ name: string }[]>`
        select u.display_name as name from workspace_members wm
        join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id
        where wm.tenant_id = ${tenantId} and wm.workspace_id = ${row.id}
        order by wm.joined_at asc
      `
      const files = row.type === 'team'
        ? await this.listTeamWorkspaceFileSummaries(row.id)
        : await this.listPersonalWorkspaceFileSummaries(row.id)
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        type: row.type,
        status: row.status,
        archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
        memberCount: row.memberCount,
        sessionCount: row.sessionCount,
        artifactCount: row.artifactCount,
        updatedAt: formatDateTime(row.updatedAt),
        owner: row.owner,
        members: members.map((member) => member.name),
        files,
      }
    }))
  }

  /**
   * 团队空间卡片里的文件摘要按逻辑文件聚合（TW-07 / AC-29）：一个逻辑文件只出现
   * 一次，取最新有效版本，避免上传新版本后同一文件被重复计数。
   */
  private async listTeamWorkspaceFileSummaries(workspaceId: string) {
    const rows = await this.database<{
      id: string
      logicalFileId: string
      logicalName: string
      sizeBytes: string | number
      createdAt: Date
      uploadedBy: string
      versionNo: number
      versionCount: number
    }[]>`
      select f.id, wf.id as "logicalFileId", wf.name as "logicalName",
             f.size_bytes as "sizeBytes", f.created_at as "createdAt",
             u.display_name as "uploadedBy", wfv.version_no as "versionNo",
             (select count(*)::integer from workspace_file_versions c
               where c.tenant_id = wf.tenant_id and c.logical_file_id = wf.id) as "versionCount"
        from workspace_files wf
        -- 同 listWorkspaceFiles：优先最高解析成功版本，无成功版本时退化为最高版本，
        -- 避免失败文件从空间列表摘要里消失。
        join lateral (
          select v.version_no, v.file_object_id
            from workspace_file_versions v
           where v.tenant_id = wf.tenant_id and v.logical_file_id = wf.id
           order by (v.parse_status = 'succeeded') desc, v.version_no desc
           limit 1
        ) wfv on true
        join file_objects f on f.tenant_id = wf.tenant_id and f.id = wfv.file_object_id
        join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
       where wf.tenant_id = ${tenantId} and wf.workspace_id = ${workspaceId}
         and wf.status = 'active'
         and f.scan_status <> 'blocked' and f.removed_at is null
       order by f.created_at desc
    `
    return rows.map(file => ({
      id: file.id,
      name: file.logicalName,
      type: extname(file.logicalName).slice(1).toUpperCase() || 'FILE',
      size: formatSize(Number(file.sizeBytes)),
      uploadedBy: file.uploadedBy,
      uploadedAt: formatDateTime(file.createdAt),
      logicalFileId: file.logicalFileId,
      versionNo: file.versionNo,
      versionCount: file.versionCount,
    }))
  }

  /** 个人空间保持既有路径（AC-23）：不读逻辑文件，行为与 TW-07 之前一致。 */
  private async listPersonalWorkspaceFileSummaries(workspaceId: string) {
    const files = await this.database<Omit<FileRow, 'workspaceId'>[]>`
      select f.id, f.storage_key as "storageKey", f.original_name as "originalName",
             f.mime_type as "mimeType", f.size_bytes as "sizeBytes", f.created_at as "createdAt",
             u.display_name as "uploadedBy"
        from file_objects f
        join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
       where f.tenant_id = ${tenantId} and f.workspace_id = ${workspaceId} and f.scan_status = 'clean'
         and f.session_id is null and f.removed_at is null
       order by f.created_at desc
    `
    return files.map(file => ({
      id: file.id,
      name: file.originalName,
      type: extname(file.originalName).slice(1).toUpperCase() || 'FILE',
      size: formatSize(Number(file.sizeBytes)),
      uploadedBy: file.uploadedBy,
      uploadedAt: formatDateTime(file.createdAt),
    }))
  }

  /**
   * 3-T3 依赖：更新团队空间名称/说明。仅负责人；名称 2–60 字符；说明用 `null`
   * 显式清空（方案 3.3：清空必须显式传 null，不用 undefined 表示清空）。
   * 个人空间不提供该入口（沿用团队专用接口惯例）。
   */
  async updateWorkspace(
    workspaceId: string,
    input: { name?: string; description?: string | null },
    actorUserId: string,
  ) {
    const access = await this.workspaces.resolveReadableWorkspace(workspaceId, actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持修改团队工作空间')

    const name = input.name?.trim()
    if (name !== undefined && (name.length < 2 || name.length > 60)) {
      throw requestInvalid('工作空间名称必须为 2 到 60 个字符')
    }
    const rawDescription = input.description
    const description = rawDescription === undefined
      ? undefined
      : (rawDescription === null ? '' : rawDescription.trim())
    // 契约声明 200/403/422：空请求体属请求校验失败，必须显式 422，
    // 否则裸 Error 会被文案分类成 500（符合性评审 F2）。
    if (name === undefined && rawDescription === undefined) {
      throw requestInvalid('没有需要更新的字段')
    }

    await this.runWorkspaceWriteMutation(workspaceId, actorUserId, async (transaction) => {
      if (description !== undefined) {
        await transaction`
          update workspaces set description = ${description}
           where tenant_id = ${tenantId} and id = ${workspaceId}
        `
      }
      if (name !== undefined) {
        await transaction`
          update workspaces set name = ${name}
           where tenant_id = ${tenantId} and id = ${workspaceId}
        `
      }
    })
    const [updated] = (await this.listWorkspaces(actorUserId, { status: 'all' }))
      .filter(workspace => workspace.id === workspaceId)
    // 5-T4：与「不可访问」同文案的拒绝统一类型化（HTTP 仍是 403 permission_denied）。
    if (!updated) throw authorizationDenied('工作空间不存在或不可访问')
    return updated
  }

  async createWorkspace(input: { name: string; description: string }, actorUserId: string) {
    const id = `ws-${randomUUID()}`
    await this.database.begin(async (transaction) => {
      await transaction`
        insert into workspaces (id, tenant_id, name, description, created_by, status)
        values (${id}, ${tenantId}, ${input.name.trim()}, ${input.description.trim()}, ${actorUserId}, 'active')
      `
      await transaction`
        insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${tenantId}, ${id}, ${actorUserId}, 'owner', ${actorUserId})
      `
    })
    // 新空间恒为 active，这里显式限定以免受列表默认值变化影响。
    return (await this.listWorkspaces(actorUserId, { status: 'active' })).find((workspace) => workspace.id === id)
  }

  async listArtifacts(actorUserId: string): Promise<Artifact[]> {
    const rows = await this.database<{
      id: string
      name: string
      artifactType: Artifact['type']
      version: number
      sizeBytes: string | number
      createdAt: Date
      runId: string
      workspaceId: string
      sourceSessionStatus: string
      workspaceType: string | null
    }[]>`
      select a.id, a.name, a.artifact_type as "artifactType", av.version_no as version,
             f.size_bytes as "sizeBytes", av.created_at as "createdAt",
             av.source_run_id as "runId", a.workspace_id as "workspaceId",
             w.workspace_type as "workspaceType", s.status as "sourceSessionStatus"
        from artifacts a
        join artifact_versions av on av.tenant_id = a.tenant_id and av.artifact_id = a.id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
        join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
        left join workspaces w on w.tenant_id = a.tenant_id and w.id = a.workspace_id
       where a.tenant_id = ${tenantId}
         -- TW-10：团队会话成果对空间成员可见（下方 canReadWorkspaceObject 复核
         -- 移出/归档口径）；个人会话仍限创建者。
         and (
           s.created_by = ${actorUserId}
           or exists (
             select 1 from workspace_members sm
              where sm.tenant_id = s.tenant_id and sm.workspace_id = s.workspace_id
                and sm.user_id = ${actorUserId}
           )
         )
         and (w.workspace_type <> 'personal' or f.removed_at is null)
       order by av.created_at desc
    `
    // 团队成果与团队运行同一读取口径：成果列表同样要复核当前团队读权限，
    // 被移出/退出的成员不能继续看到自己此前在团队空间发布的成果（AC-09）。
    // 3-T1 读取轨：`canReadWorkspaceObject` 对归档空间的现任成员放行（只读保留），
    // 对非成员与不存在空间仍然 fail-closed。个人空间成果直接返回，保持原路径
    // （AC-23）——不在这里再查空间类型，避免每行一次往返（评审实测 200 行 = 200
    // 次多余查询）；团队成果按空间去重后只复核一次，既消掉 N+1 也消掉并发冷启动
    // 的缓存击穿。
    const teamWorkspaceIds = [...new Set(
      rows.filter(row => row.workspaceType === 'team').map(row => row.workspaceId),
    )]
    const readable = new Map<string, boolean>()
    await Promise.all(teamWorkspaceIds.map(async (workspaceId) => {
      readable.set(workspaceId, await canReadWorkspaceObject(this.authorization, workspaceId, actorUserId))
    }))
    const visible = rows.map(row => {
      if (row.workspaceType === 'personal') return row
      // 只有明确的团队空间且在 readable 中被判为可读才保留；类型为 null（空间行缺失）
      // 同样 fail-closed，不因「非团队」而放行（P-B 口径）。
      if (row.workspaceType !== 'team') return null
      return readable.get(row.workspaceId) === true ? row : null
    })
    return visible.filter((row): row is (typeof rows)[number] => row !== null).map((row) => ({
      id: row.id,
      name: row.name,
      type: row.artifactType,
      version: row.version,
      size: formatSize(Number(row.sizeBytes)),
      createdAt: formatDateTime(row.createdAt),
      runId: row.runId,
      workspaceId: row.workspaceId,
      summary: row.sourceSessionStatus === 'archived' ? '原对话已从历史中移除；成果独立保留，下载仍需当前授权。' : '由 DSH Runtime 本轮回答发布，保留来源 Run 与不可覆盖版本。',
    }))
  }

  /** Uses existing file_objects/extractions/Artifact relations; no second catalog.
   * Each immutable object appears once. Artifact membership takes precedence
   * over session attachment membership. Personal listings never aggregate teams. */
  async listPersonalFiles(input: PersonalFileQuery) {
    return this.queryPersonalFiles(input)
  }

  async getPersonalFile(fileId: string, actorUserId: string): Promise<PersonalFileSummary> {
    const page = await this.queryPersonalFiles({ actorUserId, limit: 1 }, fileId)
    if (!page.items[0]) throw authorizationDenied('文件不存在或不可访问')
    return page.items[0]
  }

  async storePersonalFile(name: string, mimeType: string, bytes: Buffer, actorUserId: string) {
    await this.authorization.authorizeWorkbench({ userId: actorUserId })
    const workspace = await this.workspaces.ensurePersonalWorkspace(actorUserId)
    return this.storeWorkspaceFile(workspace.id, name, mimeType, bytes, actorUserId)
  }

  private async queryPersonalFiles(input: PersonalFileQuery, fileId?: string) {
    await this.authorization.authorizeWorkbench({ userId: input.actorUserId })
    const source = input.source ?? 'all'
    if (!['all', 'material', 'attachment', 'artifact'].includes(source)) throw requestInvalid('无效的文件来源筛选')
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw requestInvalid('limit 必须为 1 到 100 之间的整数')
    if ((input.query?.length ?? 0) > 200) throw requestInvalid('搜索关键词不能超过 200 个字符')
    let cursor: { at: string; id: string } | undefined
    if (input.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (!cursor || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at))
          || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 160 || input.cursor.length > 1024) throw new Error('shape')
      } catch { throw requestInvalid('无效的分页游标') }
    }
    const pattern = input.query?.trim() ? `%${input.query.trim().replaceAll(/[\\%_]/g, value => `\\${value}`)}%` : null
    const rows = await this.database<Array<{
      id: string; name: string; mimeType: string; sizeBytes: number; createdAt: Date; cursorAt: string;
      source: PersonalFileSource; sessionId: string | null; sourceSessionState: 'active' | 'removed' | null;
      artifactId: string | null; version: number | null; scanStatus: string; parseStatus: string
    }>>`
      select f.id, f.original_name as name, f.mime_type as "mimeType", f.size_bytes as "sizeBytes",
             f.created_at as "createdAt", to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt",
             case when result.id is not null then 'artifact' when f.session_id is not null then 'attachment' else 'material' end as source,
             f.session_id as "sessionId", case when s.status = 'active' then 'active' when s.id is not null then 'removed' else null end as "sourceSessionState",
             result.id as "artifactId", result.version_no as version, f.scan_status as "scanStatus",
             coalesce(extraction.status, 'not_parsed') as "parseStatus"
        from file_objects f
        join workspaces w on w.tenant_id = f.tenant_id and w.id = f.workspace_id
        left join sessions s on s.tenant_id = f.tenant_id and s.id = f.session_id and s.workspace_id = f.workspace_id
        left join lateral (
          select a.id, av.version_no from artifact_versions av
          join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
           where av.tenant_id = f.tenant_id and av.file_object_id = f.id
             and a.workspace_id = w.id and a.session_id = f.session_id
           order by av.version_no desc, av.id desc limit 1
        ) result on true
        left join lateral (select fe.status from file_extractions fe where fe.tenant_id = f.tenant_id and fe.file_id = f.id
          and fe.extractor_version = 'm4-basic-v1' order by fe.created_at desc, fe.id desc limit 1) extraction on true
       where f.tenant_id = ${tenantId} and w.workspace_type = 'personal'
         and (${readableWorkspacePredicate(this.database, input.actorUserId)})
         and f.removed_at is null
         and ((f.session_id is null and f.uploaded_by = ${input.actorUserId})
           or (s.created_by = ${input.actorUserId} and s.audience = 'workbench'))
         and ${fileId ? this.database`f.id = ${fileId}` : this.database`true`}
         and ${source === 'all' ? this.database`true` : source === 'artifact' ? this.database`result.id is not null`
           : source === 'attachment' ? this.database`result.id is null and f.session_id is not null` : this.database`result.id is null and f.session_id is null`}
         and ${pattern === null ? this.database`true` : this.database`f.original_name ilike ${pattern} escape '\\'`}
         and ${cursor ? this.database`(f.created_at, f.id) < (${cursor.at}::text::timestamptz, ${cursor.id})` : this.database`true`}
       order by f.created_at desc, f.id desc limit ${limit + 1}
    `
    const items: PersonalFileSummary[] = rows.slice(0, limit).map(row => ({
      id: row.id, name: row.name, type: extname(row.name).slice(1).toUpperCase() || 'FILE', size: formatSize(Number(row.sizeBytes)),
      createdAt: row.createdAt.toISOString(), source: row.source, sessionId: row.sessionId, sourceSessionState: row.sourceSessionState,
      artifactId: row.artifactId, version: row.version, scanStatus: row.scanStatus, parseStatus: row.parseStatus,
      canDownload: row.scanStatus === 'clean', canReference: row.scanStatus === 'clean' && row.parseStatus === 'succeeded', removable: true,
    }))
    const last = rows[Math.min(rows.length, limit) - 1]
    return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.cursorAt, id: last.id })).toString('base64url') : null }
  }

  /** Remove from future use only. Original bytes, extracts, Artifact versions and
   * run_input_files are not deleted. Repeated authorized removal is idempotent. */
  async removePersonalFile(fileId: string, actorUserId: string) {
    await this.authorization.authorizeWorkbench({ userId: actorUserId })
    return this.database.begin(async tx => {
      const [row] = await tx<{ id: string }[]>`
        select f.id from file_objects f
        join workspaces w on w.tenant_id = f.tenant_id and w.id = f.workspace_id
        left join sessions s on s.tenant_id = f.tenant_id and s.id = f.session_id and s.workspace_id = w.id
         where f.tenant_id = ${tenantId} and f.id = ${fileId} and w.workspace_type = 'personal'
           and w.created_by = ${actorUserId} and w.status = 'active'
           and exists (select 1 from users u join tenants t on t.id = u.tenant_id
             where u.tenant_id = f.tenant_id and u.id = ${actorUserId} and u.status = 'active' and t.status = 'active')
           and ((f.session_id is null and f.uploaded_by = ${actorUserId}) or (s.created_by = ${actorUserId} and s.audience = 'workbench'))
         for update of f
      `
      if (!row) throw authorizationDenied('文件不存在或不可访问')
      const updated = await tx`update file_objects set removed_at = now(), removed_by = ${actorUserId}
        where tenant_id = ${tenantId} and id = ${fileId} and removed_at is null returning id`
      if (updated.length) await tx`insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
        values (${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actorUserId}, 'file.personal.remove', 'file', ${fileId}, 'success', ${`trace-${randomUUID()}`}, '{"physicalDeletion":false}')`
      return { id: fileId, removed: true as const, physicalDeletion: false as const }
    })
  }

  /**
   * Upload a brand-new team shared file (execution track). TW-07 adds the logical
   * file on top of the immutable object: the object stays version 1 and later
   * uploads add versions instead of overwriting it (AC-13).
   *
   * Personal spaces keep the pre-TW-07 path untouched (AC-23): no logical file,
   * no version rows, no change to how the personal file list is produced.
   */
  async storeWorkspaceFile(workspaceId: string, name: string, mimeType: string, bytes: Buffer, actorUserId: string): Promise<{
    id: string
    name: string
    size: string
    type: string
    uploadedBy: string
    uploadedAt: string
    extractionStatus: 'succeeded'
    /** Null for personal spaces: they stay outside the logical-file model (AC-23). */
    logicalFileId: string | null
    versionNo: number | null
  }> {
    const access = await this.workspaces.resolveAccessibleWorkspace(workspaceId, actorUserId)
    // 只读成员不得新建共享文件（方案 §5 / AC-08「直接调用写 API 也被拒绝」）。
    if (access.type === 'team') {
      await this.assertCanWriteWorkspaceFiles(workspaceId, actorUserId, '上传共享文件')
    }
    const stored = await this.storeInputFile({ workspaceId, sessionId: null, name, mimeType, bytes, actorUserId })
    if (access.type === 'personal') return { ...stored, logicalFileId: null, versionNo: null }

    const logicalFileId = `wfile-${randomUUID()}`
    await this.database.begin(async (transaction) => {
      // 与上传新版本/移除同口径：事务内先取空间行锁并复核「空间活跃 + 仍是成员 + 非只读」，
      // 否则请求在途时被归档/撤权仍会落库（第二轮验证 F-P2：兄弟路径漏了一处）。
      await this.lockActiveWorkspaceForFileWrite(transaction, workspaceId, actorUserId, {
        denyViewer: true,
        viewerAction: '上传共享文件',
      })
      await transaction`
        insert into workspace_files (
          id, tenant_id, workspace_id, name, status, latest_version_no, created_by
        ) values (
          ${logicalFileId}, ${tenantId}, ${workspaceId}, ${name}, 'active', 1, ${actorUserId}
        )
      `
      await transaction`
        insert into workspace_file_versions (
          id, tenant_id, logical_file_id, version_no, file_object_id, note, parse_status, created_by
        ) values (
          ${`wfv-${randomUUID()}`}, ${tenantId}, ${logicalFileId}, 1, ${stored.id}, null, 'succeeded', ${actorUserId}
        )
      `
      // 同事务写入动态：新增共享文件（v1）是一条团队动态。safe_metadata 只放
      // 逻辑文件 id 与版本号——文件名不进入动态（会话附件名属私有，团队动态统一
      // 不携带任何名称）。
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'file_uploaded',
        actorUserId,
        objectType: 'file',
        objectId: logicalFileId,
        dedupeKey: `file_uploaded:${stored.id}`,
        metadata: { logicalFileId, versionNo: 1 },
      })
    })
    return { ...stored, logicalFileId, versionNo: 1 }
  }

  /**
   * Shared workspace files for the current space: name search, keyset paging and
   * server-derived allowed actions (1B-T3 / 设计 §2.3). TW-07 returns one row per
   * LOGICAL file — the latest valid version — so uploading v2 neither duplicates
   * the file in the list nor silently hides v1's history (AC-29/AC-13). Removed
   * files leave the referenceable set here; historical runs keep their own
   * references.
   */
  async listWorkspaceFiles(input: {
    workspaceId: string
    actorUserId: string
    query?: string
    cursor?: string
    limit?: number
  }): Promise<WorkspaceFilePage> {
    // 3-T1 读取轨：列表属于「只读保留」，归档空间的现任成员仍可读取；上传/移除
    // 仍走 resolveAccessibleWorkspace（执行轨，归档一律拒绝）。
    const access = await this.workspaces.resolveReadableWorkspace(input.workspaceId, input.actorUserId)
    // 读取轨允许归档；但「可移除」是执行轨能力，归档空间一律 false。
    const [workspaceState] = await this.database<{ status: string }[]>`
      select status from workspaces where tenant_id = ${tenantId} and id = ${input.workspaceId}
    `
    const writable = workspaceState?.status === 'active'
    if (access.type === 'personal') throw requestInvalid('仅支持团队工作空间查询共享文件')
    const role = await this.workspaceMemberRole(input.workspaceId, input.actorUserId)
    const canManageAll = role === 'owner' || role === 'admin'
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const cursor = input.cursor ? decodeFileCursor(input.cursor) : null
    const pattern = input.query?.trim()
      ? `%${input.query.trim().replaceAll(/[\\%_]/g, match => `\\${match}`)}%`
      : null

    const rows = await this.database<{
      id: string
      logicalFileId: string
      logicalName: string
      logicalCreatedBy: string
      versionNo: number
      versionCount: number
      mimeType: string
      sizeBytes: string | number
      scanStatus: string
      uploadedById: string
      uploadedBy: string
      createdAt: Date
    }[]>`
      select f.id, wf.id as "logicalFileId", wf.name as "logicalName",
             wf.created_by as "logicalCreatedBy", wfv.version_no as "versionNo",
             (select count(*)::integer from workspace_file_versions c
               where c.tenant_id = wf.tenant_id and c.logical_file_id = wf.id) as "versionCount",
             f.mime_type as "mimeType", f.size_bytes as "sizeBytes", f.scan_status as "scanStatus",
             f.uploaded_by as "uploadedById", u.display_name as "uploadedBy",
             f.created_at as "createdAt"
        from workspace_files wf
        -- 列表展示「最高有效版本」（有效 = 解析成功），这样失败的 v2 不会顶掉可用的
        -- v1（TW-07）；但当没有任何解析成功版本时（例如回填的历史文件从未解析成功、
        -- latest_version_no 停在 0），退化为展示最高版本，避免该文件从列表里彻底
        -- 消失——TW-05 要求失败文件带「失败」状态可见。
        join lateral (
          select v.version_no, v.file_object_id
            from workspace_file_versions v
           where v.tenant_id = wf.tenant_id and v.logical_file_id = wf.id
           order by (v.parse_status = 'succeeded') desc, v.version_no desc
           limit 1
        ) wfv on true
        join file_objects f on f.tenant_id = wf.tenant_id and f.id = wfv.file_object_id
        join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
       where wf.tenant_id = ${tenantId} and wf.workspace_id = ${input.workspaceId}
         and wf.status = 'active'
         and f.removed_at is null and f.scan_status <> 'blocked'
         and ${pattern === null ? this.database`true` : this.database`wf.name ilike ${pattern} escape '\\'`}
         and ${cursor === null
           ? this.database`true`
           : this.database`(f.created_at, f.id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`}
       order by f.created_at desc, f.id desc
       limit ${limit + 1}
    `

    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const items = page.map(row => ({
      id: row.id,
      logicalFileId: row.logicalFileId,
      versionNo: row.versionNo,
      versionCount: row.versionCount,
      name: row.logicalName,
      type: extname(row.logicalName).slice(1).toUpperCase() || 'FILE',
      size: formatSize(Number(row.sizeBytes)),
      uploadedBy: row.uploadedBy,
      uploadedAt: formatDateTime(row.createdAt),
      scanStatus: row.scanStatus,
      // 权限在服务端判定：负责人/管理员可移除任何文件，成员只能移除自己创建或
      // 展示版本由自己上传的；**只读成员一律不能移除**（设计 §2.3「只读成员不渲染
      // 移除入口」/ 方案 §5「只读成员仅查看和下载」）——注意历史上传人被降级为
      // 只读后不再保留移除权，这与「上传」的判定一致（验证代理 D1）。
      // 归档空间属执行轨（3-T1）：移除会被拒，因此不得回报 removable。
      removable: writable && role !== 'viewer' && (
        canManageAll || row.logicalCreatedBy === input.actorUserId || row.uploadedById === input.actorUserId
      ),
      canDownload: row.scanStatus === 'clean',
    }))
    // 游标必须用原始时间戳：uploadedAt 是展示格式，喂回 timestamptz 会解析失败。
    const lastRow = page[page.length - 1]
    return {
      items,
      nextCursor: hasMore && lastRow
        ? encodeFileCursor(lastRow.createdAt.toISOString(), lastRow.id)
        : null,
    }
  }

  /**
   * Version history of one logical file, newest first (TW-07). Read track: current
   * members keep access after the workspace is archived; non-members and personal
   * spaces are rejected exactly like `listWorkspaceFiles`.
   */
  async listWorkspaceFileVersions(input: {
    workspaceId: string
    logicalFileId: string
    actorUserId: string
  }): Promise<WorkspaceFileVersionPage> {
    const access = await this.workspaces.resolveReadableWorkspace(input.workspaceId, input.actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持团队工作空间查询文件版本')

    const [logical] = await this.database<{
      id: string
      name: string
      status: string
      latestVersionNo: number
    }[]>`
      select id, name, status, latest_version_no as "latestVersionNo"
        from workspace_files
       where tenant_id = ${tenantId} and id = ${input.logicalFileId}
         and workspace_id = ${input.workspaceId} and status = 'active'
    `
    if (!logical) throw authorizationDenied('文件不存在或不可访问')

    const rows = await this.database<{
      versionNo: number
      fileObjectId: string
      note: string | null
      parseStatus: string
      originalName: string
      mimeType: string
      sizeBytes: string | number
      scanStatus: string
      removedAt: Date | null
      uploadedBy: string
      createdAt: Date
    }[]>`
      select wfv.version_no as "versionNo", wfv.file_object_id as "fileObjectId",
             wfv.note, wfv.parse_status as "parseStatus",
             f.original_name as "originalName", f.mime_type as "mimeType",
             f.size_bytes as "sizeBytes", f.scan_status as "scanStatus",
             f.removed_at as "removedAt",
             u.display_name as "uploadedBy", wfv.created_at as "createdAt"
        from workspace_file_versions wfv
        join file_objects f on f.tenant_id = wfv.tenant_id and f.id = wfv.file_object_id
        join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
       where wfv.tenant_id = ${tenantId} and wfv.logical_file_id = ${input.logicalFileId}
       order by wfv.version_no desc
    `

    return {
      logicalFileId: logical.id,
      name: logical.name,
      status: logical.status,
      latestVersionNo: logical.latestVersionNo,
      versionCount: rows.length,
      items: (() => {
        // `current` 必须与列表展示的版本一致：列表选「最高解析成功版本」，无成功
        // 版本时退化为最高版本（符合性评审 F4：此前用 latest_version_no 比较，
        // 在 latest=0 的文件上没有任何一行被标为 current）。
        const ordered = [...rows].sort((left, right) => {
          const leftOk = left.parseStatus === 'succeeded' ? 0 : 1
          const rightOk = right.parseStatus === 'succeeded' ? 0 : 1
          return leftOk - rightOk || right.versionNo - left.versionNo
        })
        const shownVersionNo = ordered[0]?.versionNo ?? null
        return rows.map(row => ({
          versionNo: row.versionNo,
          fileId: row.fileObjectId,
          logicalFileId: logical.id,
          name: row.originalName,
          type: extname(row.originalName).slice(1).toUpperCase() || 'FILE',
          size: formatSize(Number(row.sizeBytes)),
          note: row.note,
          uploadedBy: row.uploadedBy,
          uploadedAt: formatDateTime(row.createdAt),
          scanStatus: row.scanStatus,
          parseStatus: row.parseStatus,
          current: shownVersionNo !== null && row.versionNo === shownVersionNo,
          // 可下载还要看移除状态：已移除的对象即便扫描通过也下载不到（F5）。
          canDownload: row.scanStatus === 'clean' && row.removedAt === null,
        }))
      })(),
    }
  }

  /**
   * Append a new version to an existing logical file (TW-07, execution track).
   *
   * Version-number allocation serializes on the logical-file row
   * (`select ... for update`), so two concurrent uploads cannot claim the same
   * version number or overwrite each other. The object starts as an immutable
   * `file_objects` row plus a `pending` version row; `latest_version_no` only
   * advances after the extraction succeeded, so a failed version never breaks
   * the previous one (AC-13).
   */
  async uploadWorkspaceFileVersion(input: {
    workspaceId: string
    logicalFileId: string
    name: string
    mimeType: string
    bytes: Buffer
    note: string | null
    actorUserId: string
  }): Promise<UploadedWorkspaceFileVersion> {
    const access = await this.workspaces.resolveAccessibleWorkspace(input.workspaceId, input.actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持团队工作空间上传文件版本')
    // 方案 §5 权限矩阵：只读成员不得上传。上传是执行轨动作，必须查角色，
    // 不能只靠「空间可访问」（符合性评审 F1：viewer 此前可上传并拿到 201）。
    await this.assertCanWriteWorkspaceFiles(input.workspaceId, input.actorUserId, '上传文件版本')

    // 先在事务外完成校验、安全扫描与落盘：版本行只引用不可变对象，对象写入失败
    // 不会分配版本号。
    const prepared = await this.prepareObjectWrite({
      workspaceId: input.workspaceId,
      sessionId: null,
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.bytes,
      actorUserId: input.actorUserId,
    })

    let versionNo = 0
    try {
      await this.database.begin(async (transaction) => {
        // 先取空间行锁，再在锁内复核「空间活跃 + 成员角色」：事务外的复核（上面）
        // 与写入之间存在窗口，并发的移除成员/归档会让已被撤权的人写入成功
        // （质量评审 F6，与 3-T2 修掉的成员变更 TOCTOU 同类）。
        await this.lockActiveWorkspaceForFileWrite(transaction, input.workspaceId, input.actorUserId, {
          denyViewer: true,
          viewerAction: '上传文件版本',
        })
        const [logical] = await transaction<{ status: string }[]>`
          select status from workspace_files
           where tenant_id = ${tenantId} and id = ${input.logicalFileId}
             and workspace_id = ${input.workspaceId}
           for update
        `
        if (!logical) throw authorizationDenied('文件不存在或不可访问')
        if (logical.status !== 'active') throw workspaceStateConflict('该文件已移除，不能上传新版本')
        const [next] = await transaction<{ next: number }[]>`
          select (coalesce(max(version_no), 0) + 1)::integer as next
            from workspace_file_versions
           where tenant_id = ${tenantId} and logical_file_id = ${input.logicalFileId}
        `
        versionNo = next?.next ?? 1
        await transaction`
          insert into file_objects (
            id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
            size_bytes, sha256, scan_status, uploaded_by
          ) values (
            ${prepared.fileId}, ${tenantId}, ${input.workspaceId}, null, ${prepared.storageKey},
            ${input.name}, ${input.mimeType || 'application/octet-stream'},
            ${input.bytes.length}, ${prepared.sha256}, 'clean', ${input.actorUserId}
          )
        `
        await transaction`
          insert into workspace_file_versions (
            id, tenant_id, logical_file_id, version_no, file_object_id, note, parse_status, created_by
          ) values (
            ${`wfv-${randomUUID()}`}, ${tenantId}, ${input.logicalFileId}, ${versionNo},
            ${prepared.fileId}, ${input.note}, 'pending', ${input.actorUserId}
          )
        `
        // 新版本对象与版本行同事务落库，动态也同事务写入：版本号由行锁内的
        // max(version_no)+1 分配，因此 (logicalFileId, versionNo) 是本次业务事件的
        // 确定性去重键。safe_metadata 只放 id 与版本号，不含文件名/更新说明。
        await recordWorkspaceActivity(transaction, {
          workspaceId: input.workspaceId,
          kind: 'file_version_added',
          actorUserId: input.actorUserId,
          objectType: 'file',
          objectId: input.logicalFileId,
          dedupeKey: `file_version_added:${input.logicalFileId}:${versionNo}`,
          metadata: { logicalFileId: input.logicalFileId, versionNo },
        })
      })
    } catch (error) {
      // 行锁存在时理论上不会撞唯一约束；这里兜底把竞态翻译成明确 409，绝不后写覆盖。
      if (isUniqueViolation(error)) throw workspaceStateConflict('版本号分配冲突，请刷新后重试')
      throw error
    }

    try {
      const extraction = await this.extractInto(prepared.fileId, input.name, input.bytes, prepared.extension)
      await this.database.begin(async (transaction) => {
        await transaction`
          update workspace_file_versions set parse_status = 'succeeded'
           where tenant_id = ${tenantId} and logical_file_id = ${input.logicalFileId} and version_no = ${versionNo}
        `
        await transaction`
          update workspace_files
             set latest_version_no = greatest(latest_version_no, ${versionNo}), updated_at = now()
           where tenant_id = ${tenantId} and id = ${input.logicalFileId} and status = 'active'
        `
      })
      return {
        id: prepared.fileId,
        logicalFileId: input.logicalFileId,
        versionNo,
        name: input.name,
        type: prepared.extension.slice(1).toUpperCase(),
        size: formatSize(input.bytes.length),
        uploadedBy: await this.userDisplayName(input.actorUserId),
        uploadedAt: '刚刚',
        extractionStatus: extraction,
      }
    } catch (error) {
      // 失败版本保留记录与对象（可追溯），但绝不让 latest_version_no 前移。
      await this.database`
        update workspace_file_versions set parse_status = 'failed'
         where tenant_id = ${tenantId} and logical_file_id = ${input.logicalFileId} and version_no = ${versionNo}
      `
      throw error
    }
  }

  /**
   * Resolve one version to its immutable object id for download. The caller still
   * runs `readFile` on the result, so the existing read gate
   * (`readFile` → `canReadWorkspaceObject`) remains the single authorization
   * decision — archived workspaces stay readable for current members, removed
   * members are denied.
   */
  async resolveWorkspaceFileVersionFileId(input: {
    workspaceId: string
    logicalFileId: string
    versionNo: number
    actorUserId: string
  }): Promise<string> {
    const access = await this.workspaces.resolveReadableWorkspace(input.workspaceId, input.actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持团队工作空间下载文件版本')

    const [row] = await this.database<{ fileObjectId: string; removedAt: Date | null }[]>`
      select wfv.file_object_id as "fileObjectId", f.removed_at as "removedAt"
        from workspace_file_versions wfv
        join file_objects f on f.tenant_id = wfv.tenant_id and f.id = wfv.file_object_id
        join workspace_files wf on wf.tenant_id = wfv.tenant_id and wf.id = wfv.logical_file_id
       where wfv.tenant_id = ${tenantId} and wfv.logical_file_id = ${input.logicalFileId}
         and wfv.version_no = ${input.versionNo} and wf.workspace_id = ${input.workspaceId}
         and wf.status = 'active'
    `
    if (!row || row.removedAt) throw authorizationDenied('文件不存在或不可访问')
    return row.fileObjectId
  }

  /**
   * Logical removal of a shared workspace file (1B-T3 + TW-07): the logical file
   * leaves the effective list and every version object is marked removed so it
   * cannot be referenced again; version rows, objects, parse results and every
   * historical run reference stay intact (AC-13). Accepts either the logical file
   * id or any version's object id (the pre-TW-07 endpoint contract).
   */
  async removeWorkspaceFile(workspaceId: string, fileId: string, actorUserId: string): Promise<{ id: string; removed: true }> {
    const access = await this.workspaces.resolveAccessibleWorkspace(workspaceId, actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持团队工作空间移除共享文件')
    // 早失败用的角色探测；真正的判定在事务内（见下面 canManageAllLocked）。
    await this.workspaceMemberRole(workspaceId, actorUserId)

    return this.database.begin(async (transaction) => {
      // 事务内复核（质量评审 F6）：锁空间行后再确认「空间活跃 + 调用者仍是成员」，
      // 并把最终角色以锁内读到的为准重新计算，避免并发撤权/归档穿透。
      await this.lockActiveWorkspaceForFileWrite(transaction, workspaceId, actorUserId, {
        denyViewer: false,
        viewerAction: '移除共享文件',
      })
      const [lockedRole] = await transaction<{ role: string }[]>`
        select member_role as role from workspace_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
           and user_id = ${actorUserId}
      `
      const canManageAllLocked = lockedRole?.role === 'owner' || lockedRole?.role === 'admin'
      // 只读成员一律不能移除（设计 §2.3 / 方案 §5）：历史上传人被降级后不再保留移除权。
      const viewerDenied = !lockedRole || lockedRole.role === 'viewer'
      // 先按逻辑文件 ID 解析；兼容既有端点：也用某个版本的对象 ID 定位逻辑文件。
      const [direct] = await transaction<{ id: string; createdBy: string; removedAt: Date | null }[]>`
        select id, created_by as "createdBy", removed_at as "removedAt"
          from workspace_files
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${fileId}
         for update
      `
      let logical = direct
      if (!logical) {
        const [version] = await transaction<{ logicalFileId: string }[]>`
          select logical_file_id as "logicalFileId"
            from workspace_file_versions
           where tenant_id = ${tenantId} and file_object_id = ${fileId}
        `
        if (version) {
          const [locked] = await transaction<{ id: string; createdBy: string; removedAt: Date | null }[]>`
            select id, created_by as "createdBy", removed_at as "removedAt"
              from workspace_files
             where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${version.logicalFileId}
             for update
          `
          logical = locked
        }
      }

      if (logical) {
        if (logical.removedAt) return { id: fileId, removed: true }
        // 鉴权口径必须与列表一致：列表展示的是「最高解析成功版本」（无成功版本时
        // 退化为最高版本），若这里按最高版本判权，失败的 v3 会让 v2 的上传人
        // 看到可移除按钮却拿到 403（符合性评审 F2）。
        const [latest] = await transaction<{ createdBy: string }[]>`
          select created_by as "createdBy" from workspace_file_versions
           where tenant_id = ${tenantId} and logical_file_id = ${logical.id}
           order by (parse_status = 'succeeded') desc, version_no desc
           limit 1
        `
        if (viewerDenied || (!canManageAllLocked && logical.createdBy !== actorUserId && latest?.createdBy !== actorUserId)) {
          throw authorizationDenied('只有负责人、管理员或上传人本人可以移除该文件')
        }
        await transaction`
          update workspace_files
             set status = 'removed', removed_at = now(), removed_by = ${actorUserId}, updated_at = now()
           where tenant_id = ${tenantId} and id = ${logical.id} and status = 'active'
        `
        await transaction`
          update file_objects set removed_at = now(), removed_by = ${actorUserId}
           where tenant_id = ${tenantId} and removed_at is null
             and id in (
               select file_object_id from workspace_file_versions
                where tenant_id = ${tenantId} and logical_file_id = ${logical.id}
             )
        `
        // 逻辑文件移除是一条团队动态；一个逻辑文件只会从 active 变成 removed
        // 一次（上面的 removedAt 早退保证），所以逻辑文件 id 就是确定性去重键。
        await recordWorkspaceActivity(transaction, {
          workspaceId,
          kind: 'file_removed',
          actorUserId,
          objectType: 'file',
          objectId: logical.id,
          dedupeKey: `file_removed:${logical.id}`,
          metadata: { logicalFileId: logical.id },
        })
        return { id: fileId, removed: true }
      }

      // 兼容 TW-07 之前直接落在 file_objects 上的共享文件（无逻辑文件行）。
      const [file] = await transaction<{ uploadedBy: string; removedAt: Date | null }[]>`
        select uploaded_by as "uploadedBy", removed_at as "removedAt"
          from file_objects
         where tenant_id = ${tenantId} and id = ${fileId} and workspace_id = ${workspaceId}
           and session_id is null
         for update
      `
      if (!file) throw authorizationDenied('文件不存在或不可访问')
      if (file.removedAt) return { id: fileId, removed: true }
      if (viewerDenied || (!canManageAllLocked && file.uploadedBy !== actorUserId)) {
        throw authorizationDenied('只有负责人、管理员或上传人本人可以移除该文件')
      }
      await transaction`
        update file_objects set removed_at = now(), removed_by = ${actorUserId}
         where tenant_id = ${tenantId} and id = ${fileId} and removed_at is null
      `
      // 兼容路径（TW-07 之前直接落在 file_objects 上的共享文件）：对象 id 即去重键。
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'file_removed',
        actorUserId,
        objectType: 'file',
        objectId: fileId,
        dedupeKey: `file_removed:${fileId}`,
        metadata: {},
      })
      return { id: fileId, removed: true }
    })
  }

  /** Current team role of the actor, or null when not a member. */
  private async workspaceMemberRole(workspaceId: string, actorUserId: string) {
    const [member] = await this.database<{ role: 'owner' | 'admin' | 'member' | 'viewer' }[]>`
      select member_role as role from workspace_members
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${actorUserId}
    `
    if (!member) throw authorizationDenied('当前用户不是该空间的成员')
    return member.role
  }

  async storeSessionFile(sessionId: string, name: string, mimeType: string, bytes: Buffer, actorUserId: string) {
    const [session] = await this.database<{ id: string; workspaceId: string; createdBy: string; workspaceType: string | null }[]>`
      select s.id, s.workspace_id as "workspaceId", s.created_by as "createdBy",
             w.workspace_type as "workspaceType"
        from sessions s
        left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
       where s.tenant_id = ${tenantId} and s.id = ${sessionId} and s.status = 'active'
    `
    if (!session) throw authorizationDenied('Session 不存在或不可访问')
    // 上传属执行轨（3-T1）：归档不改 session.status，必须单独校验所属空间仍活跃，
    // 否则归档空间仍可上传会话附件（符合性评审 P1-2，实测返回 201）。
    await this.requireActiveWorkspace(session.workspaceId, actorUserId)
    if (session.workspaceType === 'team') {
      // TW-10 共享会话：任何非只读成员可在共享讨论串中附加文件（与发言同一写轨）。
      await this.assertCanWriteWorkspaceFiles(session.workspaceId, actorUserId, '向共享会话附加文件')
    } else if (session.createdBy !== actorUserId) {
      throw authorizationDenied('Session 不存在或不可访问')
    }
    return this.storeInputFile({ workspaceId: session.workspaceId, sessionId, name, mimeType, bytes, actorUserId })
  }

  /**
   * 回收“已上传但 Run 创建失败”的会话附件。只允许上传人清理；一旦文件已被任何
   * Run 输入引用，就按已参与历史保留，不再移除（AC-13）。
   */
  async discardSessionFile(sessionId: string, fileId: string, actorUserId: string) {
    return this.database.begin(async (transaction) => {
      const [file] = await transaction<{ uploadedBy: string; removedAt: Date | null }[]>`
        select uploaded_by as "uploadedBy", removed_at as "removedAt"
          from file_objects
         where tenant_id = ${tenantId} and id = ${fileId} and session_id = ${sessionId}
         for update
      `
      if (!file || file.uploadedBy !== actorUserId) {
        throw authorizationDenied('文件不存在或不可访问')
      }
      if (file.removedAt) return { id: fileId, removed: true }
      const [reference] = await transaction<{ referenced: boolean }[]>`
        select exists(
          select 1 from run_input_files
           where tenant_id = ${tenantId} and file_id = ${fileId}
        ) as "referenced"
      `
      if (reference?.referenced) return { id: fileId, removed: false }
      await transaction`
        update file_objects set removed_at = now(), removed_by = ${actorUserId}
         where tenant_id = ${tenantId} and id = ${fileId} and removed_at is null
      `
      return { id: fileId, removed: true }
    })
  }

  /**
   * 文件写入的事务内复核（质量评审 F6）：先取空间行锁——与归档、开跑、成员变更
   * 同一把锁、同一顺序（workspaces → …）——再在锁内确认空间仍活跃且调用者仍有
   * 上传资格。事务外的检查只用于尽早失败，不能作为唯一依据。
   */
  private async lockActiveWorkspaceForFileWrite(
    transaction: DatabaseTransaction,
    workspaceId: string,
    actorUserId: string,
    options: { denyViewer: boolean; viewerAction: string },
  ) {
    const [workspace] = await transaction<{ status: string }[]>`
      select status from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId}
       for update
    `
    if (!workspace) throw authorizationDenied('工作空间不存在或不可访问')
    if (workspace.status !== 'active') {
      throw authorizationDenied('工作空间已归档，仅支持有权限的只读查看与下载')
    }
    const [member] = await transaction<{ role: string }[]>`
      select member_role as role from workspace_members
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
         and user_id = ${actorUserId}
    `
    if (!member) throw authorizationDenied('当前用户不是该空间的成员')
    // 注意：**只有上传**对只读成员一律拒绝；移除的规则是「负责人/管理员/上传人本人」，
    // 被降级为只读的历史上传人仍可移除自己上传的文件，因此移除路径不在这里拦 viewer。
    if (options.denyViewer && member.role === 'viewer') {
      throw authorizationDenied(`只读成员没有权限${options.viewerAction}`)
    }
  }

  /**
   * 团队空间文件上传的角色闸门（方案 §5 / AC-08）：只读成员没有上传权限。
   * 管理动作（移除）另有规则，因此这里只表达「能否上传」。
   */
  private async assertCanWriteWorkspaceFiles(workspaceId: string, actorUserId: string, action: string) {
    const role = await this.workspaceMemberRole(workspaceId, actorUserId)
    if (role === 'viewer') {
      throw authorizationDenied(`只读成员没有权限${action}`)
    }
  }

  /**
   * Execution-track guard for writes that reach a workspace only through a session
   * or file row: personal spaces are the caller's own, team spaces must be active.
   */
  private async requireActiveWorkspace(workspaceId: string, actorUserId: string) {
    const access = await this.workspaces.resolveAccessibleWorkspace(workspaceId, actorUserId)
    if (access.type === 'personal' && access.id !== `ws-personal-${actorUserId}`) {
      throw authorizationDenied('工作空间不存在或不可访问')
    }
    return access
  }

  /** 运行输入文件「可解析」谓词：启用预检与实际挂载必须使用同一份条件。 */
  private runtimeFileReadyPredicate() {
    return this.database`
      and f.scan_status = 'clean'
      and f.removed_at is null
      and fe.status = 'succeeded'
      and fe.extractor_version = 'm4-basic-v1'
    `
  }

  private async resolveRuntimeFile(input: { sessionId: string; fileId: string; userId: string }): Promise<RuntimeFileRow> {
    const [row] = await this.database<RuntimeFileRow[]>`
      select f.workspace_id as "workspaceId", f.id as "fileId", fe.id as "extractionId", f.original_name as "originalName",
             f.mime_type as "mimeType", fe.text_storage_key as "textStorageKey",
             fe.text_sha256 as "textSha256"
        from file_objects f
        join file_extractions fe on fe.tenant_id = f.tenant_id and fe.file_id = f.id
        join sessions target on target.tenant_id = f.tenant_id and target.id = ${input.sessionId}
       where f.tenant_id = ${tenantId} and f.id = ${input.fileId}
         ${this.runtimeFileReadyPredicate()}
         and target.status = 'active'
         -- TW-10：团队会话是共享讨论——现任成员可在他人发起的会话中发起 Run；
         -- 个人会话仍限创建者。
         and (
           target.created_by = ${input.userId}
           or exists (
             select 1 from workspaces tw
               join workspace_members twm
                 on twm.tenant_id = tw.tenant_id and twm.workspace_id = tw.id
                and twm.user_id = ${input.userId}
              where tw.tenant_id = target.tenant_id and tw.id = target.workspace_id
                and tw.workspace_type = 'team' and tw.status = 'active'
           )
         )
         -- 文件必须与目标会话同空间（批次 1/A1）：作者身份不授予跨空间读取权。
         and f.workspace_id = target.workspace_id
         and (
           f.session_id = target.id
           -- 同空间本人的其他会话附件可复用；跨空间的本人会话附件同样拒绝。
           or f.session_id in (
             select id from sessions own
              where own.tenant_id = ${tenantId} and own.created_by = ${input.userId}
           )
           -- TW-10：同一团队空间内其它共享会话的附件——讨论对全员可见，附件同属
           -- 共享内容；跨空间的他人会话附件仍不可挂载。
           or exists (
             select 1 from sessions fs
               join workspaces fw on fw.tenant_id = fs.tenant_id and fw.id = fs.workspace_id
              where fs.tenant_id = f.tenant_id and fs.id = f.session_id
                and fs.workspace_id = target.workspace_id
                and fw.workspace_type = 'team' and fw.status = 'active'
           )
           -- 空间共享文件（session_id 为空）。刻意限定 session_id is null：挂在**其他
           -- 空间**会话下的附件不属于本空间共享讨论，成员身份不得成为读取依据
           -- （方案 §5/AC-10 口径在同空间共享模型下保留对跨空间附件的隔离）。
           or (
             f.session_id is null
             and f.workspace_id = target.workspace_id
             and exists (
               select 1 from workspaces w
                where w.tenant_id = f.tenant_id and w.id = f.workspace_id and w.status = 'active'
                  and (
                    (w.workspace_type = 'personal' and w.created_by = ${input.userId})
                    or (
                      w.workspace_type = 'team'
                      and exists (
                        select 1 from workspace_members wm
                         where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
                           and wm.user_id = ${input.userId}
                      )
                    )
                  )
             )
           )
         )
    `
    if (!row) throw authorizationDenied(`文件不存在、不可访问或解析未成功：${input.fileId}`)
    // Recheck current identity AND source-space access before reading bytes.
    // This does not trust cached role/data-scope values from the creating request.
    try {
      await this.authorization.authorizeWorkbench({ userId: input.userId, workspaceId: row.workspaceId })
    } catch (error) {
      if (isAuthorizationDenial(error)) throw authorizationDenied('文件不存在、不可访问或解析未成功')
      throw error
    }
    return row
  }

  /** Reauthorize immutable inputs without loading or replacing their snapshotted bytes. */
  async recheckRuntimeFiles(manifest: import('../../runtime/runtime-types.ts').RuntimeManifest): Promise<void> {
    for (const mount of manifest.input.file_mounts) {
      const row = await this.resolveRuntimeFile({
        sessionId: manifest.session_id, fileId: mount.file_id, userId: manifest.user_context.user_id,
      })
      if (row.textSha256 !== mount.content_sha256) throw authorizationDenied('输入文件解析版本已变化，不能执行旧快照')
    }
  }

  async prepareRuntimeFiles(input: {
    sessionId: string
    fileIds: string[]
    userId: string
  }): Promise<PreparedRuntimeFile[]> {
    const fileIds = [...new Set(input.fileIds.map(id => id.trim()).filter(Boolean))]
    if (fileIds.length > 5) throw new Error('每次 Run 最多分析 5 个文件')
    const prepared: PreparedRuntimeFile[] = []
    let totalBytes = 0
    for (const [index, fileId] of fileIds.entries()) {
      const row = await this.resolveRuntimeFile({ sessionId: input.sessionId, fileId, userId: input.userId })
      const content = await readFile(this.resolveStorage(row.textStorageKey), 'utf8')
      totalBytes += Buffer.byteLength(content)
      if (totalBytes > 1024 * 1024) throw new Error('本次 Run 的文件解析文本合计超过 1 MB，请减少或拆分文件')
      const safeName = safeMountName(row.originalName, index)
      prepared.push({
        fileId: row.fileId,
        extractionId: row.extractionId,
        mount: {
          file_id: row.fileId,
          mount_path: `/workspace/input/${safeName}.txt`,
          access: 'read_only',
          source_name: row.originalName,
          media_type: row.mimeType,
          content_sha256: row.textSha256,
          content,
        },
      })
    }
    return prepared
  }

  /**
   * AG-03 启用预检：fileIds 必须可挂载到该空间由该用户发起的运行。
   * 谓词与 prepareRuntimeFiles 同口径——扫描通过、未删除、解析成功，且
   * 满足三类访问之一：本人会话附件（自动任务会话由 owner 创建，「目标
   * 会话」与「本人其它会话」两分支在此合一）、任务空间内团队共享会话
   * 附件、空间共享文件（含空间 active + 个人属主/团队成员校验）。
   * 运行时 prepareRuntimeFiles 仍会逐次复核，此处只是让「启用即不可行」
   * 的配置在启用时报错而不是首次触发才失败。
   */
  async assertRuntimeFileAccess(input: {
    fileIds: string[]
    userId: string
    workspaceId: string
    tenantId: string
  }): Promise<void> {
    const fileIds = [...new Set(input.fileIds.map(id => id.trim()).filter(Boolean))]
    if (fileIds.length === 0) return
    if (fileIds.length > 5) throw requestInvalid('自动任务最多引用 5 个文件')
    for (const fileId of fileIds) {
      const [row] = await this.database<{ id: string }[]>`
        select f.id
          from file_objects f
          join file_extractions fe on fe.tenant_id = f.tenant_id and fe.file_id = f.id
          join workspaces target on target.tenant_id = f.tenant_id and target.id = ${input.workspaceId}
         where f.tenant_id = ${input.tenantId} and f.id = ${fileId}
           ${this.runtimeFileReadyPredicate()}
           and target.status = 'active'
           and (
             (target.workspace_type = 'personal' and target.created_by = ${input.userId})
             or (
               target.workspace_type = 'team'
               and exists (
                 select 1 from workspace_members target_member
                  where target_member.tenant_id = target.tenant_id
                    and target_member.workspace_id = target.id
                    and target_member.user_id = ${input.userId}
               )
             )
           )
           and (
             f.session_id in (
               select id from sessions own
                where own.tenant_id = ${input.tenantId} and own.created_by = ${input.userId}
             )
             or exists (
               select 1 from sessions fs
                 join workspaces fw on fw.tenant_id = fs.tenant_id and fw.id = fs.workspace_id
                where fs.tenant_id = f.tenant_id and fs.id = f.session_id
                  and fs.workspace_id = ${input.workspaceId}
                  and fw.workspace_type = 'team' and fw.status = 'active'
             )
             or (
               f.session_id is null
               and f.workspace_id = ${input.workspaceId}
               and exists (
                 select 1 from workspaces w
                  where w.tenant_id = f.tenant_id and w.id = f.workspace_id and w.status = 'active'
                    and (
                      (w.workspace_type = 'personal' and w.created_by = ${input.userId})
                      or (
                        w.workspace_type = 'team'
                        and exists (
                          select 1 from workspace_members wm
                           where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
                             and wm.user_id = ${input.userId}
                        )
                      )
                    )
               )
             )
           )
         limit 1
      `
      if (!row) throw requestInvalid(`任务输入文件不存在、不可访问或解析未成功：${fileId}`)
    }
  }

  /**
   * Collect task-local files only after DSH has completed its turn. Output is
   * validated before one database transaction publishes immutable Artifact
   * versions, so a partial or unsafe output set never appears in the UI.
   */
  async publishRuntimeArtifacts(input: {
    manifest: import('../../runtime/runtime-types.ts').RuntimeManifest
    workspaceDirectory: string
  }): Promise<Array<{ name: string; size: number }>> {
    const { manifest } = input
    // 管理侧 purpose 不产生员工成果；自动化任务（purpose='automation'）是
    // 员工运行，仍走正常成果收集（AG-03）。
    if (isAdminRunPurpose(manifest.purpose)) return []
    await this.requireActiveWorkspace(manifest.workspace_id, manifest.user_context.user_id)

    const workspaceRoot = resolve(input.workspaceDirectory)
    const outputRoot = resolve(workspaceRoot, 'output')
    if (!outputRoot.startsWith(`${workspaceRoot}/`)) throw new Error('Runtime 成果目录无效')
    const entries = await readdir(outputRoot, { withFileTypes: true })
    if (entries.length > 20) throw new Error('单次 Run 最多生成 20 个成果文件')

    const prepared: PreparedRuntimeArtifact[] = []
    let totalBytes = 0
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.name.startsWith('.') || entry.name.includes('\0')) {
        throw new Error(`成果目录只允许顶层普通文件：${entry.name}`)
      }
      const extension = extname(entry.name).toLowerCase()
      const type = artifactTypeForExtension(extension)
      if (!type) throw new Error(`成果文件格式不受支持：${entry.name}`)
      const sourcePath = resolve(outputRoot, entry.name)
      if (!sourcePath.startsWith(`${outputRoot}/`)) throw new Error(`成果文件路径无效：${entry.name}`)
      const details = await lstat(sourcePath)
      if (!details.isFile() || details.nlink !== 1) throw new Error(`成果文件不是独立普通文件：${entry.name}`)
      if (details.size < 1 || details.size > 10 * 1024 * 1024) throw new Error(`成果文件大小必须为 1 B～10 MB：${entry.name}`)
      totalBytes += details.size
      if (totalBytes > 20 * 1024 * 1024) throw new Error('单次 Run 成果文件合计不能超过 20 MB')
      const bytes = await readFile(sourcePath)
      const scan = await this.scanner.scan({ name: entry.name, mimeType: artifactMimeType(type), bytes })
      if (!scan.clean) throw new Error(`成果文件安全检查未通过：${entry.name}`)
      const contentSha256 = createHash('sha256').update(bytes).digest('hex')
      const identity = createHash('sha256').update(`${manifest.attempt_id}\0${entry.name}\0${contentSha256}`).digest('hex').slice(0, 32)
      const artifactIdentity = createHash('sha256').update(`${manifest.run_id}\0${entry.name}`).digest('hex').slice(0, 32)
      prepared.push({
        artifactId: `artifact-${artifactIdentity}`,
        artifactVersionId: `artifact-version-${identity}`,
        fileId: `file-artifact-${identity}`,
        name: entry.name,
        type,
        mimeType: artifactMimeType(type),
        bytes,
        sha256: contentSha256,
        storageKey: join('artifact-files', manifest.session_id, `file-artifact-${identity}${extension}`),
      })
    }

    for (const artifact of prepared) await this.writeStorage(artifact.storageKey, artifact.bytes)
    await this.database.begin(async transaction => {
      const [run] = await transaction<{ id: string }[]>`
        select r.id from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
         where r.tenant_id = ${tenantId} and r.id = ${manifest.run_id}
           and r.current_attempt_id = ${manifest.attempt_id}
           and r.session_id = ${manifest.session_id}
           and r.requested_by = ${manifest.user_context.user_id}
           and s.workspace_id = ${manifest.workspace_id}
           -- TW-10：共享会话中 Run 发起人未必是会话创建者（成员可在他人讨论串中
           -- @ 触发）；Run↔Session↔Manifest 的三方绑定已构成一致性校验，
           -- 不再要求发起人等于创建者。
           and s.status = 'active'
         for update of r
      `
      if (!run) throw authorizationDenied('Run 已变化，不能发布成果文件')

      for (const artifact of prepared) {
        const [existing] = await transaction<{ id: string }[]>`
          select id from artifact_versions
           where tenant_id = ${tenantId} and id = ${artifact.artifactVersionId}
        `
        if (existing) continue
        await transaction`
          insert into file_objects (
            id, tenant_id, workspace_id, session_id, storage_key, original_name,
            mime_type, size_bytes, sha256, scan_status, uploaded_by
          ) values (
            ${artifact.fileId}, ${tenantId}, ${manifest.workspace_id}, ${manifest.session_id},
            ${artifact.storageKey}, ${artifact.name}, ${artifact.mimeType}, ${artifact.bytes.length},
            ${artifact.sha256}, 'clean', ${manifest.user_context.user_id}
          )
        `
        await transaction`
          insert into artifacts (
            id, tenant_id, workspace_id, session_id, name, artifact_type, created_by
          ) values (
            ${artifact.artifactId}, ${tenantId}, ${manifest.workspace_id}, ${manifest.session_id},
            ${artifact.name}, ${artifact.type}, ${manifest.user_context.user_id}
          )
          on conflict (id) do nothing
        `
        const [version] = await transaction<{ versionNo: number }[]>`
          select coalesce(max(version_no), 0)::integer + 1 as "versionNo"
            from artifact_versions
           where tenant_id = ${tenantId} and artifact_id = ${artifact.artifactId}
        `
        await transaction`
          insert into artifact_versions (
            id, tenant_id, artifact_id, version_no, file_object_id, source_run_id
          ) values (
            ${artifact.artifactVersionId}, ${tenantId}, ${artifact.artifactId},
            ${version?.versionNo ?? 1}, ${artifact.fileId}, ${manifest.run_id}
          )
        `
      }
    })
    return prepared.map(artifact => ({ name: artifact.name, size: artifact.bytes.length }))
  }

  async getRunInputFileIds(runId: string) {
    const rows = await this.database<{ fileId: string }[]>`
      select rif.file_id as "fileId" from run_input_files rif
      join runs r on r.tenant_id = rif.tenant_id and r.current_attempt_id = rif.attempt_id
       where rif.tenant_id = ${tenantId} and rif.run_id = ${runId}
       order by rif.created_at
    `
    return rows.map(row => row.fileId)
  }

  /**
   * Validate, scan and persist the raw bytes of a NEW object, returning the fields
   * needed to insert its immutable `file_objects` row. The row itself is inserted
   * by the caller (inside the version-allocation transaction for TW-07).
   */
  private async prepareObjectWrite(input: {
    workspaceId: string
    sessionId: string | null
    name: string
    mimeType: string
    bytes: Buffer
    actorUserId: string
  }) {
    const { workspaceId, sessionId, name, mimeType, bytes } = input
    const extension = extname(name).toLowerCase()
    if (!allowedExtensions.has(extension)) throw new Error('仅支持 PDF、DOCX、XLSX、CSV、TXT 和 Markdown 文件')
    if (bytes.length < 1 || bytes.length > 20 * 1024 * 1024) throw new Error('文件大小必须为 1 B～20 MB')
    const scan = await this.scanner.scan({ name, mimeType, bytes })
    // 安全扫描拒绝是请求内容不合法，不是服务器故障：裸 Error 不含分类关键字会被
    // 映射成 500（质量评审实测 `MZ…` 请求体返回 500），改抛类型化 422。
    if (!scan.clean) {
      throw requestInvalid(`文件安全检查未通过：${scan.reason ?? '未知原因'}`)
    }
    const fileId = `file-${randomUUID()}`
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const storageKey = join(sessionId ? 'session-files' : 'workspace-files', sessionId ?? workspaceId ?? 'unknown', `${fileId}${extension}`)
    await this.writeStorage(storageKey, bytes)
    return { fileId, extension, sha256, storageKey }
  }

  /**
   * Parse a stored object and record the outcome. A failure is a typed 422 and is
   * kept as a failed `file_extractions` row plus a failed version row — it never
   * overwrites or invalidates a previous version (AC-13).
   */
  private async extractInto(fileId: string, name: string, bytes: Buffer, extension: string) {
    const extractionId = `extraction-${randomUUID()}`
    try {
      const extraction = extractDocument(name, bytes)
      const textBytes = Buffer.from(extraction.text, 'utf8')
      const textSha256 = createHash('sha256').update(textBytes).digest('hex')
      const textStorageKey = join('extractions', fileId, 'm4-basic-v1.txt')
      await this.writeStorage(textStorageKey, textBytes)
      await this.database`
        insert into file_extractions (
          id, tenant_id, file_id, extractor_version, detected_type, status,
          text_storage_key, text_sha256, character_count, page_count, sheet_count, row_count
        ) values (
          ${extractionId}, ${tenantId}, ${fileId}, 'm4-basic-v1', ${extraction.detectedType}, 'succeeded',
          ${textStorageKey}, ${textSha256}, ${extraction.text.length}, ${extraction.pageCount},
          ${extraction.sheetCount}, ${extraction.rowCount}
        )
      `
      return 'succeeded' as const
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('未知解析错误')
      const code = 'code' in error && typeof error.code === 'string' ? error.code : 'FILE_EXTRACTION_FAILED'
      await this.database`
        insert into file_extractions (
          id, tenant_id, file_id, extractor_version, detected_type, status, error_code, error_message
        ) values (
          ${extractionId}, ${tenantId}, ${fileId}, 'm4-basic-v1', ${detectedType(extension)}, 'failed',
          ${code}, ${error.message.slice(0, 500)}
        )
      `
      // 类型化 422：解析失败属请求输入问题，不能靠文案分类落到 500。
      throw requestInvalid(`文件解析失败（${code}）：${error.message}`)
    }
  }

  private async storeInputFile(input: {
    workspaceId: string
    sessionId: string | null
    name: string
    mimeType: string
    bytes: Buffer
    actorUserId: string
  }) {
    const { workspaceId, sessionId, name, mimeType, bytes, actorUserId } = input
    const prepared = await this.prepareObjectWrite(input)
    await this.database`
      insert into file_objects (
        id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
        size_bytes, sha256, scan_status, uploaded_by
      ) values (
        ${prepared.fileId}, ${tenantId}, ${workspaceId}, ${sessionId}, ${prepared.storageKey},
        ${name}, ${mimeType || 'application/octet-stream'},
        ${bytes.length}, ${prepared.sha256}, 'clean', ${actorUserId}
      )
    `
    await this.extractInto(prepared.fileId, name, bytes, prepared.extension)
    return {
      id: prepared.fileId,
      name,
      size: formatSize(bytes.length),
      type: prepared.extension.slice(1).toUpperCase(),
      uploadedBy: await this.userDisplayName(actorUserId),
      uploadedAt: '刚刚',
      extractionStatus: 'succeeded' as const,
    }
  }

  async readFile(fileId: string, actorUserId: string) {
    const [row] = await this.database<FileRow[]>`
      select f.id, f.storage_key as "storageKey", f.original_name as "originalName",
             f.mime_type as "mimeType", f.size_bytes as "sizeBytes", f.created_at as "createdAt",
             f.workspace_id as "workspaceId",
             u.display_name as "uploadedBy"
        from file_objects f
        join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
       where f.tenant_id = ${tenantId} and f.id = ${fileId} and f.scan_status = 'clean'
         and f.removed_at is null
         and (
           -- TW-10 共享会话：会话附件对会话所属空间的现任成员可读（含个人空间的
           -- 本人——个人空间成员行即 owner）；下方 canReadWorkspaceObject 仍复核
           -- 移出/归档口径。其他空间的会话附件不进入候选。
           f.session_id in (
             select s.id from sessions s
              where s.tenant_id = ${tenantId}
                and exists (
                  select 1 from workspace_members sm
                   where sm.tenant_id = s.tenant_id and sm.workspace_id = s.workspace_id
                     and sm.user_id = ${actorUserId}
                )
           )
           -- 空间共享文件（session_id 为空）。刻意限定 session_id is null：挂在其他
           -- 空间会话下的附件不属于本空间共享讨论，成员身份不得成为读取依据
           -- （方案 §5「查看他人私有对话与未发布成果：不允许」在同空间共享模型下
           -- 保留跨空间隔离）。
           or (
             f.session_id is null
             and f.workspace_id in (
               select w.id from workspaces w
                -- 3-T1 读取轨：候选空间包含归档，最终是否放行由下方 canReadWorkspaceObject
                -- 按「现任成员」统一判定（归档空间对现任成员只读保留，对非成员与不存在
                -- 空间仍然 fail-closed）。这里若不含 archived，共享文件即使对现任成员
                -- 也会在候选阶段被误判为「不存在」。
                where w.tenant_id = ${tenantId} and w.status in ('active', 'archived')
                  and (
                    (w.workspace_type = 'personal' and w.created_by = ${actorUserId})
                    or (
                      w.workspace_type = 'team'
                      and exists (
                        select 1 from workspace_members wm
                         where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
                           and wm.user_id = ${actorUserId}
                      )
                    )
                  )
             )
           )
         )
    `
    if (!row) throw authorizationDenied('文件不存在或不可访问')
    // 会话作者分支不校验团队身份：被移出/退出的成员仍能命中本人旧会话文件，
    // 必须再按对象所属空间复核当前团队读权限（1B-T4 / AC-09）。3-T1 起该门禁走
    // 读取轨：归档空间的现任成员可读，被移出成员与非成员一律拒绝。拒绝统一走
    // 类型化授权错误，并保持与「不存在」相同文案，避免用 fileId 枚举团队对象。
    try {
      await this.authorization.authorizeWorkbench({
        userId: actorUserId, workspaceId: row.workspaceId, allowArchived: true,
      })
    } catch (error) {
      if (isAuthorizationDenial(error)) throw authorizationDenied('文件不存在或不可访问')
      throw error
    }
    return { name: row.originalName, mimeType: row.mimeType, bytes: await readFile(this.resolveStorage(row.storageKey)) }
  }

  async artifactFileId(artifactId: string, version: number | undefined, actorUserId: string) {
    const [row] = await this.database<{ fileId: string; workspaceId: string }[]>`
      select av.file_object_id as "fileId", a.workspace_id as "workspaceId"
        from artifact_versions av
        join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
        join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
       where av.tenant_id = ${tenantId} and av.artifact_id = ${artifactId}
         -- TW-10：共享会话成果对会话所属空间的现任成员可读（canReadWorkspaceObject
         -- 后置复核移出/归档）；个人空间成员行即 owner，口径不变。
         and exists (
           select 1 from workspace_members sm
            where sm.tenant_id = s.tenant_id and sm.workspace_id = s.workspace_id
              and sm.user_id = ${actorUserId}
         )
         and (${version ?? null}::integer is null or av.version_no = ${version ?? null})
       order by av.version_no desc limit 1
    `
    if (!row) throw authorizationDenied('Artifact 不存在或不可访问')
    // 成果读取与团队运行同一收权口径：作者身份不足以越过当前团队读权限（AC-09）。
    if (!(await canReadWorkspaceObject(this.authorization, row.workspaceId, actorUserId))) {
      throw authorizationDenied('Artifact 不存在或不可访问')
    }
    return row.fileId
  }

  /**
   * 团队空间设置写入：先取空间行锁（与归档/成员变更同一把锁、同一锁序），
   * 再在锁内复核「空间活跃」与「调用者是负责人」。归档在等待锁期间提交时，
   * 这里必须拒绝，避免设置改写穿透只读态。
   */
  private async runWorkspaceWriteMutation(
    workspaceId: string,
    actorUserId: string,
    action: (transaction: DatabaseTransaction) => Promise<void>,
  ) {
    await this.database.begin(async (transaction) => {
      const [workspace] = await transaction<{ status: string }[]>`
        select status from workspaces
         where tenant_id = ${tenantId} and id = ${workspaceId}
         for update
      `
      if (!workspace) throw authorizationDenied('工作空间不存在或不可访问')
      if (workspace.status !== 'active') {
        throw authorizationDenied('工作空间已归档，仅支持有权限的只读查看与下载')
      }
      const [owner] = await transaction<{ role: string }[]>`
        select member_role as role from workspace_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
           and user_id = ${actorUserId} and member_role = 'owner'
      `
      if (!owner) throw authorizationDenied('仅空间负责人可以修改空间设置')
      await action(transaction)
    })
  }

  private async userDisplayName(userId: string) {
    const [user] = await this.database<{ displayName: string }[]>`
      select display_name as "displayName" from users
       where tenant_id = ${tenantId} and id = ${userId}
    `
    return user?.displayName ?? userId
  }

  private async writeStorage(storageKey: string, bytes: Buffer) {
    const target = this.resolveStorage(storageKey)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }

  private resolveStorage(storageKey: string) {
    const target = resolve(this.storageRoot, storageKey)
    if (!target.startsWith(`${this.storageRoot}/`)) throw new Error('非法存储路径')
    return target
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function detectedType(extension: string): 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text' {
  if (extension === '.pdf') return 'pdf'
  if (extension === '.docx') return 'docx'
  if (extension === '.xlsx') return 'xlsx'
  if (extension === '.csv') return 'csv'
  return 'text'
}

function artifactTypeForExtension(extension: string): Artifact['type'] | null {
  if (extension === '.md') return 'markdown'
  if (extension === '.txt') return 'text'
  if (extension === '.csv') return 'csv'
  if (extension === '.html' || extension === '.htm') return 'html'
  return null
}

function artifactMimeType(type: Artifact['type']) {
  if (type === 'markdown') return 'text/markdown; charset=utf-8'
  if (type === 'csv') return 'text/csv; charset=utf-8'
  if (type === 'html') return 'text/html; charset=utf-8'
  if (type === 'text') return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

function safeMountName(name: string, index: number) {
  const stem = name.replace(/\.[^.]+$/, '').replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 50) || 'document'
  return `${String(index + 1).padStart(2, '0')}-${stem}`
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value)
}

/** Cursor for the (created_at, id) keyset of shared workspace files. */
function encodeFileCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ at: createdAt, id })).toString('base64url')
}

function decodeFileCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown }
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('shape')
    return { createdAt: parsed.at, id: parsed.id }
  } catch {
    throw new Error('无效的分页游标')
  }
}

/** PostgreSQL unique_violation; used to translate a lost version-allocation race into a 409. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505'
}
