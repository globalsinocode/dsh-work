import { randomUUID } from 'node:crypto'

import { authorizationDenied, requestInvalid } from '../../../domain/authorization-errors.ts'
import { archiveDigest, archiveLimits, normalizeArchiveItems, type ArchiveInputMaterial } from '../../../domain/project-archive.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { workspaceStateConflict } from './workspace-state-conflict-error.ts'

const tenantId = 'tenant-dsh-work'

type TeamRole = 'owner' | 'admin' | 'member' | 'viewer'
const writerRoles: TeamRole[] = ['owner', 'admin', 'member']
const allRoles: TeamRole[] = ['owner', 'admin', 'member', 'viewer']
const terminalRunStatuses = ['succeeded', 'failed', 'cancelled']
/** 认领后迟迟没有挂上 Run 的整理视为已中断，可由下一次触发接管。 */
const staleUnattachedMinutes = 10

export type ArchiveSourceKind = 'archivist' | 'manual' | 'rollback'

export interface ProjectArchiveVersion {
  versionId: string
  versionNo: number
  items: string[]
  sourceKind: ArchiveSourceKind
  /** 档案员版本所依据的项目任务；任务已移除时仍保留标题。 */
  sourceTasks: Array<{ id: string; title: string }>
  rollbackFromVersionNo: number | null
  createdBy: { userId: string; displayName: string } | null
  createdAt: string
}

export interface ProjectArchive {
  current: ProjectArchiveVersion | null
  /** 档案员是否正在整理（只在档案页签展示）。 */
  archivistRunning: boolean
}

/** 一次整理批次：认领的待整理成果与开始时的档案基线。 */
export interface ArchiveUpdate {
  updateId: string
  workspaceId: string
  baseVersionNo: number
  items: string[]
  brief: string | null
  materials: ArchiveInputMaterial[]
}

export type ArchiveUpdateOutcome = { items: string[] } | { failure: string }

export interface ArchiveUpdateResult {
  /** false：该 Run 不是（或已不再是）档案整理运行。 */
  handled: boolean
  workspaceId?: string
  /** 仍有待整理成果（含因人工修改而丢弃的批次），应再触发一次整理。 */
  reschedule: boolean
}

/** Run 编排使用的档案员端口。 */
export interface ProjectArchivePort {
  recordAgentTaskResult(run: { id: string; sessionId: string | null }, output: string): Promise<string | null>
  beginArchiveUpdate(workspaceId: string): Promise<ArchiveUpdate | null>
  attachArchiveUpdateRun(updateId: string, runId: string): Promise<void>
  abandonArchiveUpdate(updateId: string): Promise<void>
  finishArchiveUpdate(runId: string, outcome: ArchiveUpdateOutcome): Promise<ArchiveUpdateResult>
  archivable(workspaceId: string, updateId: string): Promise<boolean>
}

interface VersionRow {
  versionId: string
  versionNo: number
  items: string[]
  sourceKind: ArchiveSourceKind
  sourceTaskIds: string[]
  rollbackFromVersionNo: number | null
  createdBy: string | null
  displayName: string | null
  createdAt: Date
}

/**
 * 项目空间 S2（docs/design/project-space-plan.md 第 7 节）：项目档案与档案员的持久化。
 * 读取：现任成员（含只读成员，归档空间可读）；写入：活动空间的非只读成员，携带基于的版本号。
 * 档案员的整理批次按空间串行：任务完成时登记待整理成果，整理开始时认领，结束时写入新版本或释放。
 */
export class PostgresProjectArchiveService implements ProjectArchivePort {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  // ---------------------------------------------------------------------------
  // 成员读写
  // ---------------------------------------------------------------------------

  async getArchive(workspaceId: string, actorUserId: string): Promise<ProjectArchive> {
    await this.requireRole(this.database, workspaceId, actorUserId, allRoles, { allowArchived: true })
    const [current] = await this.versionRows(this.database, workspaceId, 1)
    const [state] = await this.database<{ updateId: string | null }[]>`
      select update_id as "updateId" from workspace_archivist_state
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
    `
    return {
      current: current ? await this.toVersion(current) : null,
      archivistRunning: Boolean(state?.updateId),
    }
  }

  async listVersions(workspaceId: string, actorUserId: string): Promise<ProjectArchiveVersion[]> {
    await this.requireRole(this.database, workspaceId, actorUserId, allRoles, { allowArchived: true })
    const rows = await this.versionRows(this.database, workspaceId, 100)
    return Promise.all(rows.map(row => this.toVersion(row)))
  }

  async saveArchive(
    workspaceId: string,
    actorUserId: string,
    input: { baseVersionNo: unknown; items: unknown },
  ): Promise<ProjectArchiveVersion> {
    const baseVersionNo = parseBaseVersion(input.baseVersionNo)
    const normalized = normalizeArchiveItems(input.items)
    if ('error' in normalized) throw requestInvalid(normalized.error)
    return this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      const next = await this.assertBaseVersion(transaction, workspaceId, baseVersionNo)
      return this.insertVersion(transaction, workspaceId, next, {
        items: normalized.items, sourceKind: 'manual', createdBy: actorUserId,
      })
    })
  }

  async rollbackArchive(
    workspaceId: string,
    actorUserId: string,
    input: { versionNo: unknown; baseVersionNo: unknown },
  ): Promise<ProjectArchiveVersion> {
    const baseVersionNo = parseBaseVersion(input.baseVersionNo)
    if (!Number.isInteger(input.versionNo) || (input.versionNo as number) < 1) throw requestInvalid('versionNo 无效')
    const versionNo = input.versionNo as number
    return this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      const next = await this.assertBaseVersion(transaction, workspaceId, baseVersionNo)
      if (versionNo === baseVersionNo) throw requestInvalid('已经是当前版本')
      const [target] = await transaction<{ items: string[] }[]>`
        select items from workspace_archive_versions
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and version_no = ${versionNo}
      `
      if (!target) throw requestInvalid('要回退的档案版本不存在')
      return this.insertVersion(transaction, workspaceId, next, {
        items: target.items, sourceKind: 'rollback', createdBy: actorUserId, rollbackFromVersionNo: versionNo,
      })
    })
  }

  // ---------------------------------------------------------------------------
  // 项目任务与 Agent 执行使用
  // ---------------------------------------------------------------------------

  /** Agent 任务线程执行时携带的档案；没有条目时不携带。 */
  async archiveContext(workspaceId: string): Promise<NonNullable<RuntimeManifest['project_context']>['archive'] | null> {
    const [row] = await this.versionRows(this.database, workspaceId, 1)
    if (!row || row.items.length === 0) return null
    return {
      version_id: row.versionId,
      version_no: row.versionNo,
      items: row.items,
      items_sha256: archiveDigest(row.items),
    }
  }

  /** 员工任务完成时在同一事务内登记待整理成果。 */
  async recordEmployeeTaskResult(
    transaction: DatabaseTransaction,
    input: { workspaceId: string; taskId: string; title: string; note: string | null; deliverableNames: string[] },
  ): Promise<void> {
    const parts = [input.note?.trim() || '（未填写完成说明）']
    if (input.deliverableNames.length) parts.push(`交付文件：${input.deliverableNames.join('、')}`)
    await transaction`
      insert into workspace_archive_inputs (id, tenant_id, workspace_id, project_task_id, title, content)
      values (${`warchin-${randomUUID()}`}, ${tenantId}, ${input.workspaceId}, ${input.taskId}, ${input.title},
              ${parts.join('\n').slice(0, 8000)})
    `
  }

  /** Agent 任务线程的一次执行成功：登记该次最终回复，返回所属空间；不是任务线程时返回 null。 */
  async recordAgentTaskResult(run: { id: string; sessionId: string | null }, output: string): Promise<string | null> {
    if (!run.sessionId || !output.trim()) return null
    const [row] = await this.database<{ workspaceId: string }[]>`
      insert into workspace_archive_inputs (id, tenant_id, workspace_id, project_task_id, source_run_id, title, content)
      select ${`warchin-${randomUUID()}`}, pt.tenant_id, pt.workspace_id, pt.id, ${run.id}, pt.title, ${output.trim().slice(0, 8000)}
        from project_tasks pt
        join workspaces w on w.tenant_id = pt.tenant_id and w.id = pt.workspace_id
       where pt.tenant_id = ${tenantId} and pt.session_id = ${run.sessionId} and pt.removed_at is null
         and pt.assignee_type = 'agent' and w.status = 'active' and w.workspace_type = 'team'
      on conflict (tenant_id, source_run_id) where source_run_id is not null do nothing
      returning workspace_id as "workspaceId"
    `
    return row?.workspaceId ?? null
  }

  // ---------------------------------------------------------------------------
  // 档案员整理批次（供 Run 编排使用）
  // ---------------------------------------------------------------------------

  async beginArchiveUpdate(workspaceId: string): Promise<ArchiveUpdate | null> {
    return this.database.begin(async (transaction) => {
      const [workspace] = await transaction<{ status: string; type: string }[]>`
        select status, workspace_type as type from workspaces
         where tenant_id = ${tenantId} and id = ${workspaceId} for update
      `
      if (!workspace || workspace.status !== 'active' || workspace.type !== 'team') return null
      await transaction`
        insert into workspace_archivist_state (tenant_id, workspace_id) values (${tenantId}, ${workspaceId})
        on conflict (tenant_id, workspace_id) do nothing
      `
      const [state] = await transaction<{ updateId: string | null; runId: string | null; runStatus: string | null; stale: boolean }[]>`
        select s.update_id as "updateId", s.run_id as "runId", r.status as "runStatus",
               (s.run_id is null and s.started_at < now() - make_interval(mins => ${staleUnattachedMinutes})) as stale
          from workspace_archivist_state s
          left join runs r on r.tenant_id = s.tenant_id and r.id = s.run_id
         where s.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
         for update of s
      `
      if (state?.updateId) {
        // 进行中的整理会在结束后处理新成果；只接管已中断的批次。
        const interrupted = state.stale || (state.runStatus !== null && terminalRunStatuses.includes(state.runStatus))
        if (!interrupted) return null
        await releaseInputs(transaction, state.updateId)
      }
      const inputs = await transaction<{ id: string; title: string; content: string }[]>`
        select id, title, content from workspace_archive_inputs
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
           and consumed_at is null and abandoned_at is null and update_id is null
         order by created_at, id
         limit ${archiveLimits.maxInputsPerUpdate}
         for update
      `
      if (inputs.length === 0) {
        if (state?.updateId) await clearState(transaction, workspaceId)
        return null
      }
      const updateId = `warchup-${randomUUID()}`
      const [current] = await this.versionRows(transaction, workspaceId, 1)
      const baseVersionNo = current?.versionNo ?? 0
      await transaction`
        update workspace_archive_inputs set update_id = ${updateId}
         where tenant_id = ${tenantId} and id in ${transaction(inputs.map(input => input.id))}
      `
      await transaction`
        update workspace_archivist_state
           set update_id = ${updateId}, run_id = null, base_version_no = ${baseVersionNo},
               started_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
      `
      const [brief] = await transaction<{ content: string }[]>`
        select content from workspace_brief_versions
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
         order by version_no desc limit 1
      `
      return {
        updateId,
        workspaceId,
        baseVersionNo,
        items: current?.items ?? [],
        brief: brief?.content ?? null,
        materials: inputs.map(input => ({ taskTitle: input.title, content: input.content })),
      }
    })
  }

  async attachArchiveUpdateRun(updateId: string, runId: string): Promise<void> {
    await this.database`
      update workspace_archivist_state set run_id = ${runId}, updated_at = now()
       where tenant_id = ${tenantId} and update_id = ${updateId}
    `
  }

  /** 未能发起运行：释放认领，成果留待下一次触发。 */
  async abandonArchiveUpdate(updateId: string): Promise<void> {
    await this.database.begin(async (transaction) => {
      const [owner] = await transaction<{ workspaceId: string }[]>`
        select workspace_id as "workspaceId" from workspace_archivist_state
         where tenant_id = ${tenantId} and update_id = ${updateId}
      `
      if (owner) await transaction`select id from workspaces where tenant_id = ${tenantId} and id = ${owner.workspaceId} for update`
      const [state] = await transaction<{ workspaceId: string }[]>`
        select workspace_id as "workspaceId" from workspace_archivist_state
         where tenant_id = ${tenantId} and update_id = ${updateId} for update
      `
      await releaseInputs(transaction, updateId)
      if (state) await clearState(transaction, state.workspaceId)
    })
  }

  async finishArchiveUpdate(runId: string, outcome: ArchiveUpdateOutcome): Promise<ArchiveUpdateResult> {
    const [owner] = await this.database<{ workspaceId: string }[]>`
      select workspace_id as "workspaceId" from workspace_archivist_state
       where tenant_id = ${tenantId} and run_id = ${runId} and update_id is not null
    `
    if (!owner) return { handled: false, reschedule: false }
    return this.database.begin(async (transaction) => {
      // 与成员写入、开始整理相同的加锁顺序：先空间，后整理状态。
      await transaction`
        select id from workspaces where tenant_id = ${tenantId} and id = ${owner.workspaceId} for update
      `
      const [state] = await transaction<{ workspaceId: string; updateId: string; baseVersionNo: number }[]>`
        select workspace_id as "workspaceId", update_id as "updateId", base_version_no as "baseVersionNo"
          from workspace_archivist_state
         where tenant_id = ${tenantId} and run_id = ${runId} and update_id is not null
         for update
      `
      if (!state) return { handled: false, reschedule: false }
      const { workspaceId, updateId } = state
      const inputs = await transaction<{ id: string; taskId: string }[]>`
        select id, project_task_id as "taskId" from workspace_archive_inputs
         where tenant_id = ${tenantId} and update_id = ${updateId}
         order by created_at, id
      `
      if ('failure' in outcome) {
        await transaction`
          update workspace_archive_inputs
             set update_id = null, attempts = attempts + 1,
                 abandoned_at = case when attempts + 1 >= ${archiveLimits.maxInputAttempts} then now() else null end
           where tenant_id = ${tenantId} and update_id = ${updateId}
        `
        await clearState(transaction, workspaceId)
        return { handled: true, workspaceId, reschedule: false }
      }
      const [current] = await this.versionRows(transaction, workspaceId, 1)
      const currentNo = current?.versionNo ?? 0
      if (currentNo !== state.baseVersionNo) {
        // 人工优先：整理期间档案已被修改，丢弃本次输出，基于最新版本重新整理。
        await releaseInputs(transaction, updateId)
        await clearState(transaction, workspaceId)
        return { handled: true, workspaceId, reschedule: true }
      }
      const unchanged = current !== undefined && current.items.length === outcome.items.length
        && current.items.every((item, index) => item === outcome.items[index])
      if (!unchanged && !(current === undefined && outcome.items.length === 0)) {
        await this.insertVersion(transaction, workspaceId, currentNo + 1, {
          items: outcome.items,
          sourceKind: 'archivist',
          sourceRunId: runId,
          sourceTaskIds: [...new Set(inputs.map(input => input.taskId))],
        })
      }
      await transaction`
        update workspace_archive_inputs set consumed_at = now()
         where tenant_id = ${tenantId} and update_id = ${updateId}
      `
      await clearState(transaction, workspaceId)
      const [pending] = await transaction<{ id: string }[]>`
        select id from workspace_archive_inputs
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
           and consumed_at is null and abandoned_at is null and update_id is null
         limit 1
      `
      return { handled: true, workspaceId, reschedule: Boolean(pending) }
    })
  }

  /** 执行前复核：空间仍是活动的项目空间，且该批次仍是当前整理。 */
  async archivable(workspaceId: string, updateId: string): Promise<boolean> {
    const [row] = await this.database<{ id: string }[]>`
      select w.id from workspaces w
        join workspace_archivist_state s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
       where w.tenant_id = ${tenantId} and w.id = ${workspaceId} and w.status = 'active'
         and w.workspace_type = 'team' and s.update_id = ${updateId}
    `
    return Boolean(row)
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private async assertBaseVersion(transaction: DatabaseTransaction, workspaceId: string, baseVersionNo: number): Promise<number> {
    const [current] = await this.versionRows(transaction, workspaceId, 1)
    const currentNo = current?.versionNo ?? 0
    if (currentNo !== baseVersionNo) throw workspaceStateConflict('档案已被更新，请刷新后再修改')
    return currentNo + 1
  }

  private async insertVersion(
    transaction: DatabaseTransaction,
    workspaceId: string,
    versionNo: number,
    input: {
      items: string[]
      sourceKind: ArchiveSourceKind
      createdBy?: string
      sourceRunId?: string
      sourceTaskIds?: string[]
      rollbackFromVersionNo?: number
    },
  ): Promise<ProjectArchiveVersion> {
    const versionId = `warch-${randomUUID()}`
    await transaction`
      insert into workspace_archive_versions (
        id, tenant_id, workspace_id, version_no, items, source_kind, source_run_id,
        source_task_ids, rollback_from_version_no, created_by
      ) values (
        ${versionId}, ${tenantId}, ${workspaceId}, ${versionNo}, ${transaction.json(input.items)}, ${input.sourceKind},
        ${input.sourceRunId ?? null}, ${input.sourceTaskIds ?? []}, ${input.rollbackFromVersionNo ?? null}, ${input.createdBy ?? null}
      )
    `
    const [row] = await this.versionRows(transaction, workspaceId, 1)
    if (!row || row.versionId !== versionId) throw new Error('档案版本保存后无法读取')
    return this.toVersion(row, transaction)
  }

  private async versionRows(database: DatabaseClient | DatabaseTransaction, workspaceId: string, limit: number): Promise<VersionRow[]> {
    return database<VersionRow[]>`
      select v.id as "versionId", v.version_no as "versionNo", v.items, v.source_kind as "sourceKind",
             v.source_task_ids as "sourceTaskIds", v.rollback_from_version_no as "rollbackFromVersionNo",
             v.created_by as "createdBy", u.display_name as "displayName", v.created_at as "createdAt"
        from workspace_archive_versions v
        left join users u on u.tenant_id = v.tenant_id and u.id = v.created_by
       where v.tenant_id = ${tenantId} and v.workspace_id = ${workspaceId}
       order by v.version_no desc
       limit ${limit}
    `
  }

  private async toVersion(row: VersionRow, database: DatabaseClient | DatabaseTransaction = this.database): Promise<ProjectArchiveVersion> {
    const titles = row.sourceTaskIds.length
      ? await database<{ id: string; title: string }[]>`
          select id, title from project_tasks where tenant_id = ${tenantId} and id in ${database(row.sourceTaskIds)}
        `
      : []
    const byId = new Map(titles.map(task => [task.id, task.title]))
    return {
      versionId: row.versionId,
      versionNo: row.versionNo,
      items: row.items,
      sourceKind: row.sourceKind,
      sourceTasks: row.sourceTaskIds.filter(id => byId.has(id)).map(id => ({ id, title: byId.get(id)! })),
      rollbackFromVersionNo: row.rollbackFromVersionNo,
      createdBy: row.createdBy ? { userId: row.createdBy, displayName: row.displayName ?? row.createdBy } : null,
      createdAt: row.createdAt.toISOString(),
    }
  }

  private async requireRole(
    database: DatabaseClient | DatabaseTransaction,
    workspaceId: string,
    userId: string,
    allowed: TeamRole[],
    options: { allowArchived?: boolean } = {},
  ): Promise<TeamRole> {
    const [row] = await database<{ role: TeamRole; status: string; type: string }[]>`
      select wm.member_role as role, w.status, w.workspace_type as type
        from workspaces w
        join workspace_members wm on wm.tenant_id = w.tenant_id and wm.workspace_id = w.id and wm.user_id = ${userId}
       where w.tenant_id = ${tenantId} and w.id = ${workspaceId}
    `
    if (!row || (row.status !== 'active' && !(options.allowArchived && row.status === 'archived'))) {
      throw authorizationDenied('工作空间不存在、已归档或当前用户不是成员')
    }
    if (row.type !== 'team') throw requestInvalid('仅项目空间支持项目档案')
    if (!allowed.includes(row.role)) throw authorizationDenied('当前角色无权执行该操作')
    return row.role
  }
}

function parseBaseVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw requestInvalid('baseVersionNo 无效')
  return value as number
}

async function lockActiveWorkspace(transaction: DatabaseTransaction, workspaceId: string) {
  const [workspace] = await transaction<{ status: string }[]>`
    select status from workspaces where tenant_id = ${tenantId} and id = ${workspaceId} for update
  `
  if (!workspace || workspace.status !== 'active') throw authorizationDenied('工作空间不存在、已归档或当前用户不是成员')
}

async function releaseInputs(transaction: DatabaseTransaction, updateId: string) {
  await transaction`
    update workspace_archive_inputs set update_id = null
     where tenant_id = ${tenantId} and update_id = ${updateId} and consumed_at is null
  `
}

async function clearState(transaction: DatabaseTransaction, workspaceId: string) {
  await transaction`
    update workspace_archivist_state
       set update_id = null, run_id = null, started_at = null, updated_at = now()
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
  `
}
