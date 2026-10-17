import { randomUUID } from 'node:crypto'

import { authorizationDenied, requestInvalid } from '../../../domain/authorization-errors.ts'
import { RequestError } from '../../../domain/request-errors.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { sha256 } from '../../runtime/canonical-json.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import type { SessionAuthorizationContext } from '../../authorization/postgres-authorization-service.ts'
import { activityTransitionToken, recordWorkspaceActivity } from './workspace-activity-writer.ts'
import { workspaceStateConflict } from './workspace-state-conflict-error.ts'

const tenantId = 'tenant-dsh-work'

type TeamRole = 'owner' | 'admin' | 'member' | 'viewer'
const writerRoles: TeamRole[] = ['owner', 'admin', 'member']
const governanceRoles: TeamRole[] = ['owner', 'admin']
/** Run 仍会继续推进的状态：任务线程同一时间只允许一个。 */
const activeRunStatuses = ['queued', 'running', 'waiting', 'cancel_requested']

export interface ProjectBrief {
  versionId: string
  versionNo: number
  content: string
  dueDate: string | null
  updatedBy: { userId: string; displayName: string }
  updatedAt: string
}

export type ProjectTaskStatus = 'todo' | 'in_progress' | 'done' | 'failed'
export type ProjectTaskAction = 'edit' | 'remove' | 'start' | 'set_status' | 'complete'

export interface ProjectTaskFile {
  fileObjectId: string
  logicalFileId: string
  name: string
  versionNo: number
}

export interface ProjectTask {
  id: string
  title: string
  description: string
  createdBy: { userId: string; displayName: string }
  assignee:
    | { type: 'employee'; userId: string; displayName: string }
    | { type: 'agent'; agentMemberId: string; name: string }
  /** Agent 任务由任务线程最近一次 Run 推算；员工任务取存储状态。 */
  status: ProjectTaskStatus
  sessionId: string | null
  latestRunId: string | null
  inputFiles: ProjectTaskFile[]
  deliverableFiles: ProjectTaskFile[]
  completionNote: string | null
  completedAt: string | null
  dueDate: string | null
  createdAt: string
  updatedAt: string
  allowedActions: ProjectTaskAction[]
}

export interface ProjectTaskAssigneeInput {
  type: 'employee' | 'agent'
  id: string
}

/** 任务线程与 Run 编排之间的窄端口，避免项目服务与编排服务互相构造。 */
export interface ProjectTaskThreadPort {
  resolveTaskThread(sessionId: string): Promise<ProjectTaskThread | null>
}

export interface ProjectTaskThread {
  taskId: string
  agentMemberId: string
  projectContext: NonNullable<RuntimeManifest['project_context']> | null
}

/** 项目服务启动 Agent 任务时使用的编排能力（RunOrchestrationService 的子集）。 */
export interface ProjectRunStarter {
  createSession(input: {
    userId: string
    title: unknown
    workspaceId?: string
    agentVersionId?: string | null
    authorizationContext?: SessionAuthorizationContext
  }): Promise<{ id: string }>
  startRun(input: {
    userId: string
    sessionId: string
    prompt: unknown
    idempotencyKey: unknown
    fileIds?: string[]
    workspaceAgentMemberId?: string
    authorizationContext?: SessionAuthorizationContext
  }): Promise<{ id: string } | null | undefined>
}

export interface ProjectAgentMembers {
  requireAvailableAgentMemberVersion(workspaceId: string, workspaceAgentMemberId: string): Promise<{ agentId: string; agentVersionId: string }>
}

interface TaskRow {
  id: string
  workspaceId: string
  title: string
  description: string
  createdBy: string
  createdByName: string
  assigneeType: 'employee' | 'agent'
  assigneeUserId: string | null
  assigneeUserName: string | null
  assigneeAgentMemberId: string | null
  assigneeAgentName: string | null
  sessionId: string | null
  status: 'todo' | 'in_progress' | 'done'
  completionNote: string | null
  completedAt: Date | null
  dueDate: string | null
  createdAt: Date
  updatedAt: Date
  latestRunId: string | null
  latestRunStatus: string | null
}

/**
 * 项目空间 S1（docs/design/project-space-plan.md 第 4～6 节）：项目简报与项目任务。
 * 读取走读取轨（现任成员含只读成员，归档空间可读），写入走执行轨（活动空间、非只读成员）。
 * Agent 任务即任务线程，经既有 createSession / startRun 执行，不另建执行入口。
 */
export class PostgresProjectService implements ProjectTaskThreadPort {
  private runs?: ProjectRunStarter
  private readonly database: DatabaseClient
  private readonly agentMembers: ProjectAgentMembers

  constructor(database: DatabaseClient, agentMembers: ProjectAgentMembers) {
    this.database = database
    this.agentMembers = agentMembers
  }

  /** 编排服务依赖本服务的线程端口，故在构造后接线。 */
  attachRunStarter(runs: ProjectRunStarter) {
    this.runs = runs
  }

  // ---------------------------------------------------------------------------
  // 项目简报
  // ---------------------------------------------------------------------------

  async getBrief(workspaceId: string, actorUserId: string): Promise<ProjectBrief | null> {
    await this.requireRole(this.database, workspaceId, actorUserId, ['owner', 'admin', 'member', 'viewer'], { allowArchived: true })
    return this.latestBrief(this.database, workspaceId)
  }

  async saveBrief(
    workspaceId: string,
    actorUserId: string,
    input: { content: unknown; dueDate: unknown },
  ): Promise<ProjectBrief> {
    const content = requireText(input.content, '简报内容', 8000)
    const dueDate = optionalDate(input.dueDate, '截止时间')
    return this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      await this.requireRole(transaction, workspaceId, actorUserId, governanceRoles)
      const [{ next }] = await transaction<{ next: number }[]>`
        select coalesce(max(version_no), 0) + 1 as next from workspace_brief_versions
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
      `
      const versionId = `wbrief-${randomUUID()}`
      await transaction`
        insert into workspace_brief_versions (id, tenant_id, workspace_id, version_no, content, due_date, created_by)
        values (${versionId}, ${tenantId}, ${workspaceId}, ${next}, ${content}, ${dueDate}, ${actorUserId})
      `
      await recordWorkspaceActivity(transaction, {
        workspaceId, kind: 'brief_updated', actorUserId, objectType: 'brief', objectId: versionId,
        dedupeKey: `brief-updated:${versionId}`, metadata: { versionNo: next },
      })
      const brief = await this.latestBrief(transaction, workspaceId)
      if (!brief) throw new Error('项目简报保存后无法读取')
      return brief
    })
  }

  // ---------------------------------------------------------------------------
  // 项目任务
  // ---------------------------------------------------------------------------

  async listTasks(workspaceId: string, actorUserId: string): Promise<ProjectTask[]> {
    const role = await this.requireRole(this.database, workspaceId, actorUserId, ['owner', 'admin', 'member', 'viewer'], { allowArchived: true })
    const archived = await this.isArchived(workspaceId)
    const rows = await this.taskRows(this.database, workspaceId)
    return this.toTasks(rows, actorUserId, role, archived)
  }

  async createTask(
    workspaceId: string,
    actorUserId: string,
    input: { title: unknown; description?: unknown; assignee: unknown; inputFileIds?: unknown; dueDate?: unknown },
  ): Promise<ProjectTask> {
    const title = requireText(input.title, '任务标题', 120)
    const description = optionalText(input.description, '任务说明', 4000)
    const assignee = parseAssignee(input.assignee)
    const dueDate = optionalDate(input.dueDate, '截止时间')
    const inputFileIds = parseFileIds(input.inputFileIds, '引用文件')
    if (assignee.type === 'employee' && inputFileIds.length) throw requestInvalid('只有 Agent 任务可以引用执行输入文件')
    const taskId = `ptask-${randomUUID()}`
    await this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      await this.assertAssignee(transaction, workspaceId, assignee)
      await this.assertWorkspaceFiles(transaction, workspaceId, inputFileIds, 'input')
      await transaction`
        insert into project_tasks (
          id, tenant_id, workspace_id, title, description, created_by, assignee_type,
          assignee_user_id, assignee_agent_member_id, due_date
        ) values (
          ${taskId}, ${tenantId}, ${workspaceId}, ${title}, ${description}, ${actorUserId}, ${assignee.type},
          ${assignee.type === 'employee' ? assignee.id : null}, ${assignee.type === 'agent' ? assignee.id : null}, ${dueDate}
        )
      `
      await this.replaceTaskFiles(transaction, taskId, 'input', inputFileIds)
      await recordWorkspaceActivity(transaction, {
        workspaceId, kind: 'project_task_created', actorUserId, objectType: 'project_task', objectId: taskId,
        dedupeKey: `project-task-created:${taskId}`, metadata: { assigneeType: assignee.type },
      })
    })
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  async updateTask(
    workspaceId: string,
    taskId: string,
    actorUserId: string,
    input: { title?: unknown; description?: unknown; assignee?: unknown; inputFileIds?: unknown; dueDate?: unknown },
  ): Promise<ProjectTask> {
    await this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      const role = await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      const task = await this.lockTask(transaction, workspaceId, taskId)
      if (task.createdBy !== actorUserId && !governanceRoles.includes(role)) {
        throw authorizationDenied('只有任务创建人、负责人或管理员可以编辑任务')
      }
      const title = input.title === undefined ? task.title : requireText(input.title, '任务标题', 120)
      const description = input.description === undefined ? task.description : optionalText(input.description, '任务说明', 4000)
      const dueDate = input.dueDate === undefined ? task.dueDate : optionalDate(input.dueDate, '截止时间')
      let assigneeType = task.assigneeType
      let assigneeUserId = task.assigneeUserId
      let assigneeAgentMemberId = task.assigneeAgentMemberId
      let sessionId = task.sessionId
      if (input.assignee !== undefined) {
        const assignee = parseAssignee(input.assignee)
        const changed = assignee.type !== task.assigneeType
          || assignee.id !== (task.assigneeType === 'employee' ? task.assigneeUserId : task.assigneeAgentMemberId)
        if (changed) {
          if (task.sessionId && await hasActiveRun(transaction, task.sessionId)) {
            throw workspaceStateConflict('Agent 正在执行该任务，请等待完成或停止后再改派')
          }
          await this.assertAssignee(transaction, workspaceId, assignee)
          assigneeType = assignee.type
          assigneeUserId = assignee.type === 'employee' ? assignee.id : null
          assigneeAgentMemberId = assignee.type === 'agent' ? assignee.id : null
          // 一个任务线程固定一个 Agent 版本：改派后从新线程开始。
          sessionId = null
        }
      }
      const inputFileIds = input.inputFileIds === undefined ? undefined : parseFileIds(input.inputFileIds, '引用文件')
      if (assigneeType === 'employee' && inputFileIds?.length) throw requestInvalid('只有 Agent 任务可以引用执行输入文件')
      if (inputFileIds) await this.assertWorkspaceFiles(transaction, workspaceId, inputFileIds, 'input')
      await transaction`
        update project_tasks
           set title = ${title}, description = ${description}, due_date = ${dueDate},
               assignee_type = ${assigneeType}, assignee_user_id = ${assigneeUserId},
               assignee_agent_member_id = ${assigneeAgentMemberId}, session_id = ${sessionId},
               updated_at = now()
         where tenant_id = ${tenantId} and id = ${taskId}
      `
      if (inputFileIds) await this.replaceTaskFiles(transaction, taskId, 'input', inputFileIds)
      else if (assigneeType === 'employee') await this.replaceTaskFiles(transaction, taskId, 'input', [])
    })
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  async removeTask(workspaceId: string, taskId: string, actorUserId: string): Promise<void> {
    await this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      const role = await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      const task = await this.lockTask(transaction, workspaceId, taskId)
      if (task.createdBy !== actorUserId && !governanceRoles.includes(role)) {
        throw authorizationDenied('只有任务创建人、负责人或管理员可以移除任务')
      }
      if (task.sessionId && await hasActiveRun(transaction, task.sessionId)) {
        throw workspaceStateConflict('Agent 正在执行该任务，请等待完成或停止后再移除')
      }
      // 逻辑移除：任务线程与成果保留，可经历史追溯。
      await transaction`
        update project_tasks set removed_at = now(), removed_by = ${actorUserId}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${taskId}
      `
    })
  }

  /** 员工任务的状态推进：承接人、创建人、负责人或管理员。完成时可附说明与共享文件。 */
  async setEmployeeTaskStatus(
    workspaceId: string,
    taskId: string,
    actorUserId: string,
    input: { status: unknown; completionNote?: unknown; deliverableFileIds?: unknown },
  ): Promise<ProjectTask> {
    if (input.status !== 'todo' && input.status !== 'in_progress' && input.status !== 'done') {
      throw requestInvalid('status 必须是 todo、in_progress 或 done')
    }
    const status = input.status
    const note = status === 'done' ? optionalText(input.completionNote, '完成说明', 4000) || null : null
    const deliverables = status === 'done' ? parseFileIds(input.deliverableFileIds, '交付文件') : []
    await this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      const role = await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      const task = await this.lockTask(transaction, workspaceId, taskId)
      if (task.assigneeType !== 'employee') throw workspaceStateConflict('Agent 任务的状态由执行结果决定，不能手动修改')
      if (![task.assigneeUserId, task.createdBy].includes(actorUserId) && !governanceRoles.includes(role)) {
        throw authorizationDenied('只有承接人、任务创建人、负责人或管理员可以更新任务状态')
      }
      await this.assertWorkspaceFiles(transaction, workspaceId, deliverables, 'deliverable')
      await transaction`
        update project_tasks
           set status = ${status}, completion_note = ${note},
               completed_by = ${status === 'done' ? actorUserId : null},
               completed_at = ${status === 'done' ? new Date() : null},
               updated_at = now()
         where tenant_id = ${tenantId} and id = ${taskId}
      `
      await this.replaceTaskFiles(transaction, taskId, 'deliverable', deliverables)
      if (status === 'done' && task.status !== 'done') {
        await recordWorkspaceActivity(transaction, {
          workspaceId, kind: 'project_task_completed', actorUserId, objectType: 'project_task', objectId: taskId,
          dedupeKey: `project-task-completed:${taskId}:${await activityTransitionToken(transaction)}`,
        })
      }
    })
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  /**
   * 启动 Agent 任务：首次启动创建任务线程，首条消息为任务标题与说明；之后在线程中回复即续接。
   * 执行经既有 createSession / startRun，授权、复核与收权与团队对话一致。
   */
  async startAgentTask(
    workspaceId: string,
    taskId: string,
    actorUserId: string,
    input: { idempotencyKey: unknown; authorizationContext?: SessionAuthorizationContext },
  ): Promise<ProjectTask> {
    if (!this.runs) throw new Error('项目任务执行未接线')
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw requestInvalid('必须提供 idempotencyKey')
    }
    await this.requireRole(this.database, workspaceId, actorUserId, writerRoles)
    const task = await this.lockTask(this.database, workspaceId, taskId)
    if (task.assigneeType !== 'agent' || !task.assigneeAgentMemberId) throw workspaceStateConflict('员工任务不需要启动执行')
    if (task.sessionId) throw workspaceStateConflict('任务已启动，请在任务线程中回复以继续')
    const { agentVersionId } = await this.agentMembers.requireAvailableAgentMemberVersion(workspaceId, task.assigneeAgentMemberId)
    const session = await this.runs.createSession({
      userId: actorUserId,
      title: task.title,
      workspaceId,
      agentVersionId,
      authorizationContext: input.authorizationContext,
    })
    // 并发启动只有一个能绑定线程；落败方不发起执行。
    const [bound] = await this.database<{ id: string }[]>`
      update project_tasks set session_id = ${session.id}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${taskId} and session_id is null and removed_at is null
         and assignee_agent_member_id = ${task.assigneeAgentMemberId}
      returning id
    `
    if (!bound) throw workspaceStateConflict('任务已被其他成员启动或已改派，请刷新后查看')
    const inputFileIds = await this.taskFileIds(taskId, 'input')
    await this.runs.startRun({
      userId: actorUserId,
      sessionId: session.id,
      prompt: task.description ? `任务：${task.title}\n\n${task.description}` : `任务：${task.title}`,
      idempotencyKey: input.idempotencyKey,
      fileIds: inputFileIds,
      workspaceAgentMemberId: task.assigneeAgentMemberId,
      authorizationContext: input.authorizationContext,
    })
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  /** 把讨论中 @Agent 的线程设为任务：承接者为该线程最近一次执行的 Agent 成员。 */
  async markThreadAsTask(
    workspaceId: string,
    sessionId: string,
    actorUserId: string,
    input: { title?: unknown },
  ): Promise<ProjectTask> {
    const taskId = `ptask-${randomUUID()}`
    await this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      const [session] = await transaction<{ title: string; agentMemberId: string | null }[]>`
        select s.title,
               (select wam.id
                  from runs r
                  join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
                  join agent_versions av on av.tenant_id = r.tenant_id and av.id = ra.manifest->>'agent_version_id'
                  join workspace_agent_members wam on wam.tenant_id = r.tenant_id and wam.workspace_id = s.workspace_id
                   and wam.agent_id = av.agent_id and wam.status <> 'removed'
                 where r.tenant_id = s.tenant_id and r.session_id = s.id
                 order by r.created_at desc limit 1) as "agentMemberId"
          from sessions s
         where s.tenant_id = ${tenantId} and s.id = ${sessionId} and s.workspace_id = ${workspaceId}
           and s.status = 'active'
      `
      if (!session) throw requestInvalid('线程不存在或不属于该项目空间')
      if (!session.agentMemberId) throw workspaceStateConflict('只有 @Agent 执行过的线程可以设为任务')
      const [existing] = await transaction<{ id: string }[]>`
        select id from project_tasks where tenant_id = ${tenantId} and session_id = ${sessionId}
      `
      if (existing) throw workspaceStateConflict('该线程已经是任务')
      const title = input.title === undefined ? session.title.slice(0, 120) : requireText(input.title, '任务标题', 120)
      await transaction`
        insert into project_tasks (
          id, tenant_id, workspace_id, title, description, created_by, assignee_type,
          assignee_agent_member_id, session_id
        ) values (
          ${taskId}, ${tenantId}, ${workspaceId}, ${title}, '', ${actorUserId}, 'agent',
          ${session.agentMemberId}, ${sessionId}
        )
      `
      await recordWorkspaceActivity(transaction, {
        workspaceId, kind: 'project_task_created', actorUserId, objectType: 'project_task', objectId: taskId,
        dedupeKey: `project-task-created:${taskId}`, metadata: { assigneeType: 'agent' },
      })
    })
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  // ---------------------------------------------------------------------------
  // 任务线程端口（供 Run 编排使用）
  // ---------------------------------------------------------------------------

  async resolveTaskThread(sessionId: string): Promise<ProjectTaskThread | null> {
    const [row] = await this.database<{ taskId: string; workspaceId: string; agentMemberId: string }[]>`
      select id as "taskId", workspace_id as "workspaceId", assignee_agent_member_id as "agentMemberId"
        from project_tasks
       where tenant_id = ${tenantId} and session_id = ${sessionId} and removed_at is null
         and assignee_type = 'agent'
    `
    if (!row) return null
    const brief = await this.latestBrief(this.database, row.workspaceId)
    return {
      taskId: row.taskId,
      agentMemberId: row.agentMemberId,
      projectContext: brief ? {
        brief: {
          version_id: brief.versionId,
          version_no: brief.versionNo,
          content: brief.content,
          content_sha256: sha256(brief.content),
          due_date: brief.dueDate,
        },
      } : null,
    }
  }

  /** 任务线程同一时间只允许一个执行；执行中的回复需等待完成或先停止。 */
  async assertTaskThreadIdle(sessionId: string): Promise<void> {
    if (await hasActiveRun(this.database, sessionId)) {
      throw workspaceStateConflict('Agent 正在执行该任务，请等待完成或先停止后再回复')
    }
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private async requireTask(workspaceId: string, taskId: string, actorUserId: string): Promise<ProjectTask> {
    const role = await this.requireRole(this.database, workspaceId, actorUserId, ['owner', 'admin', 'member', 'viewer'], { allowArchived: true })
    const rows = await this.taskRows(this.database, workspaceId, taskId)
    const [task] = await this.toTasks(rows, actorUserId, role, await this.isArchived(workspaceId))
    if (!task) throw new RequestError(404, 'project_task_not_found', '任务不存在或已移除')
    return task
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
    if (row.type !== 'team') throw requestInvalid('仅项目空间支持简报与任务')
    if (!allowed.includes(row.role)) throw authorizationDenied('当前角色无权执行该操作')
    return row.role
  }

  private async isArchived(workspaceId: string): Promise<boolean> {
    const [row] = await this.database<{ status: string }[]>`
      select status from workspaces where tenant_id = ${tenantId} and id = ${workspaceId}
    `
    return row?.status === 'archived'
  }

  private async latestBrief(database: DatabaseClient | DatabaseTransaction, workspaceId: string): Promise<ProjectBrief | null> {
    const [row] = await database<{
      versionId: string; versionNo: number; content: string; dueDate: string | null
      createdBy: string; displayName: string; createdAt: Date
    }[]>`
      select b.id as "versionId", b.version_no as "versionNo", b.content, b.due_date::text as "dueDate",
             b.created_by as "createdBy", u.display_name as "displayName", b.created_at as "createdAt"
        from workspace_brief_versions b
        join users u on u.tenant_id = b.tenant_id and u.id = b.created_by
       where b.tenant_id = ${tenantId} and b.workspace_id = ${workspaceId}
       order by b.version_no desc limit 1
    `
    if (!row) return null
    return {
      versionId: row.versionId,
      versionNo: row.versionNo,
      content: row.content,
      dueDate: row.dueDate,
      updatedBy: { userId: row.createdBy, displayName: row.displayName },
      updatedAt: row.createdAt.toISOString(),
    }
  }

  private async lockTask(database: DatabaseClient | DatabaseTransaction, workspaceId: string, taskId: string) {
    const [row] = await database<{
      id: string; title: string; description: string; createdBy: string
      assigneeType: 'employee' | 'agent'; assigneeUserId: string | null; assigneeAgentMemberId: string | null
      sessionId: string | null; status: 'todo' | 'in_progress' | 'done'; dueDate: string | null
    }[]>`
      select id, title, description, created_by as "createdBy", assignee_type as "assigneeType",
             assignee_user_id as "assigneeUserId", assignee_agent_member_id as "assigneeAgentMemberId",
             session_id as "sessionId", status, due_date::text as "dueDate"
        from project_tasks
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${taskId} and removed_at is null
       for update
    `
    if (!row) throw new RequestError(404, 'project_task_not_found', '任务不存在或已移除')
    return row
  }

  private async assertAssignee(transaction: DatabaseTransaction, workspaceId: string, assignee: ProjectTaskAssigneeInput) {
    if (assignee.type === 'employee') {
      const [member] = await transaction<{ role: TeamRole }[]>`
        select member_role as role from workspace_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${assignee.id}
      `
      if (!member) throw requestInvalid('承接员工必须是本空间成员')
      if (member.role === 'viewer') throw requestInvalid('只读成员不能承接任务')
      return
    }
    const [agent] = await transaction<{ status: string }[]>`
      select status from workspace_agent_members
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${assignee.id}
    `
    if (!agent) throw requestInvalid('承接 Agent 必须是本空间的 Agent 成员')
    if (agent.status !== 'available') throw workspaceStateConflict('该 Agent 成员已停用，不能承接新任务')
  }

  private async assertWorkspaceFiles(
    transaction: DatabaseTransaction,
    workspaceId: string,
    fileObjectIds: string[],
    purpose: 'input' | 'deliverable',
  ) {
    if (!fileObjectIds.length) return
    const rows = await transaction<{ fileObjectId: string; parseStatus: string }[]>`
      select v.file_object_id as "fileObjectId", v.parse_status as "parseStatus"
        from workspace_file_versions v
        join workspace_files f on f.tenant_id = v.tenant_id and f.id = v.logical_file_id
       where v.tenant_id = ${tenantId} and f.workspace_id = ${workspaceId} and f.status = 'active'
         and v.file_object_id in ${transaction(fileObjectIds)}
    `
    const found = new Map(rows.map(row => [row.fileObjectId, row.parseStatus]))
    if (fileObjectIds.some(id => !found.has(id))) throw requestInvalid('只能引用本空间有效的共享文件')
    if (purpose === 'input' && fileObjectIds.some(id => found.get(id) !== 'succeeded')) {
      throw requestInvalid('引用的共享文件尚未解析成功，暂不能作为执行输入')
    }
  }

  private async replaceTaskFiles(
    transaction: DatabaseTransaction,
    taskId: string,
    purpose: 'input' | 'deliverable',
    fileObjectIds: string[],
  ) {
    await transaction`
      delete from project_task_files where tenant_id = ${tenantId} and task_id = ${taskId} and purpose = ${purpose}
    `
    for (const [position, fileObjectId] of fileObjectIds.entries()) {
      await transaction`
        insert into project_task_files (tenant_id, task_id, file_object_id, purpose, position)
        values (${tenantId}, ${taskId}, ${fileObjectId}, ${purpose}, ${position})
      `
    }
  }

  private async taskFileIds(taskId: string, purpose: 'input' | 'deliverable'): Promise<string[]> {
    const rows = await this.database<{ fileObjectId: string }[]>`
      select file_object_id as "fileObjectId" from project_task_files
       where tenant_id = ${tenantId} and task_id = ${taskId} and purpose = ${purpose}
       order by position
    `
    return rows.map(row => row.fileObjectId)
  }

  private async taskRows(database: DatabaseClient | DatabaseTransaction, workspaceId: string, taskId?: string): Promise<TaskRow[]> {
    return database<TaskRow[]>`
      select t.id, t.workspace_id as "workspaceId", t.title, t.description,
             t.created_by as "createdBy", cu.display_name as "createdByName",
             t.assignee_type as "assigneeType", t.assignee_user_id as "assigneeUserId", au.display_name as "assigneeUserName",
             t.assignee_agent_member_id as "assigneeAgentMemberId", a.name as "assigneeAgentName",
             t.session_id as "sessionId", t.status, t.completion_note as "completionNote", t.completed_at as "completedAt",
             t.due_date::text as "dueDate", t.created_at as "createdAt", t.updated_at as "updatedAt",
             lr.id as "latestRunId", lr.status as "latestRunStatus"
        from project_tasks t
        join users cu on cu.tenant_id = t.tenant_id and cu.id = t.created_by
        left join users au on au.tenant_id = t.tenant_id and au.id = t.assignee_user_id
        left join workspace_agent_members wam on wam.tenant_id = t.tenant_id and wam.id = t.assignee_agent_member_id
        left join agents a on a.tenant_id = wam.tenant_id and a.id = wam.agent_id
        left join lateral (
          select r.id, r.status from runs r
           where r.tenant_id = t.tenant_id and r.session_id = t.session_id
           order by r.created_at desc, r.id desc limit 1
        ) lr on true
       where t.tenant_id = ${tenantId} and t.workspace_id = ${workspaceId} and t.removed_at is null
         and (${taskId ?? null}::text is null or t.id = ${taskId ?? null})
       order by t.created_at desc, t.id desc
    `
  }

  private async toTasks(rows: TaskRow[], actorUserId: string, role: TeamRole, archived: boolean): Promise<ProjectTask[]> {
    if (!rows.length) return []
    const files = await this.database<{
      taskId: string; purpose: 'input' | 'deliverable'; fileObjectId: string
      logicalFileId: string; name: string; versionNo: number
    }[]>`
      select ptf.task_id as "taskId", ptf.purpose, ptf.file_object_id as "fileObjectId",
             f.id as "logicalFileId", f.name, v.version_no as "versionNo"
        from project_task_files ptf
        join workspace_file_versions v on v.tenant_id = ptf.tenant_id and v.file_object_id = ptf.file_object_id
        join workspace_files f on f.tenant_id = v.tenant_id and f.id = v.logical_file_id and f.status = 'active'
       where ptf.tenant_id = ${tenantId} and ptf.task_id in ${this.database(rows.map(row => row.id))}
       order by ptf.position
    `
    const writer = !archived && writerRoles.includes(role)
    const governance = governanceRoles.includes(role)
    return rows.map(row => {
      const own = files.filter(file => file.taskId === row.id)
      const pick = (purpose: 'input' | 'deliverable') => own.filter(file => file.purpose === purpose)
        .map(({ fileObjectId, logicalFileId, name, versionNo }) => ({ fileObjectId, logicalFileId, name, versionNo }))
      const status = row.assigneeType === 'agent' ? agentTaskStatus(row.latestRunStatus) : row.status
      const canManage = writer && (row.createdBy === actorUserId || governance)
      const allowedActions: ProjectTaskAction[] = []
      if (canManage) allowedActions.push('edit', 'remove')
      if (writer && row.assigneeType === 'agent' && !row.sessionId) allowedActions.push('start')
      if (writer && row.assigneeType === 'employee' && (canManage || row.assigneeUserId === actorUserId)) {
        allowedActions.push('set_status', 'complete')
      }
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        createdBy: { userId: row.createdBy, displayName: row.createdByName },
        assignee: row.assigneeType === 'employee'
          ? { type: 'employee' as const, userId: row.assigneeUserId ?? '', displayName: row.assigneeUserName ?? '' }
          : { type: 'agent' as const, agentMemberId: row.assigneeAgentMemberId ?? '', name: row.assigneeAgentName ?? '' },
        status,
        sessionId: row.sessionId,
        latestRunId: row.latestRunId,
        inputFiles: pick('input'),
        deliverableFiles: pick('deliverable'),
        completionNote: row.completionNote,
        completedAt: row.completedAt?.toISOString() ?? null,
        dueDate: row.dueDate,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        allowedActions,
      }
    })
  }
}

function agentTaskStatus(runStatus: string | null): ProjectTaskStatus {
  if (!runStatus) return 'todo'
  if (runStatus === 'succeeded') return 'done'
  if (runStatus === 'failed' || runStatus === 'cancelled') return 'failed'
  return 'in_progress'
}

async function hasActiveRun(database: DatabaseClient | DatabaseTransaction, sessionId: string): Promise<boolean> {
  const [row] = await database<{ id: string }[]>`
    select id from runs
     where tenant_id = ${tenantId} and session_id = ${sessionId} and status in ${database(activeRunStatuses)}
     limit 1
  `
  return Boolean(row)
}

async function lockActiveWorkspace(transaction: DatabaseTransaction, workspaceId: string) {
  const [workspace] = await transaction<{ status: string }[]>`
    select status from workspaces where tenant_id = ${tenantId} and id = ${workspaceId} for update
  `
  if (!workspace || workspace.status !== 'active') throw authorizationDenied('工作空间不存在、已归档或当前用户不是成员')
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw requestInvalid(`${field}不能为空`)
  const text = value.trim()
  if (text.length > max) throw requestInvalid(`${field}不能超过 ${max} 个字符`)
  return text
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw requestInvalid(`${field}必须是文本`)
  const text = value.trim()
  if (text.length > max) throw requestInvalid(`${field}不能超过 ${max} 个字符`)
  return text
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw requestInvalid(`${field}必须是 YYYY-MM-DD 格式的日期`)
  }
  return value
}

function parseAssignee(value: unknown): ProjectTaskAssigneeInput {
  if (!value || typeof value !== 'object') throw requestInvalid('必须选择承接者')
  const { type, id } = value as { type?: unknown; id?: unknown }
  if ((type !== 'employee' && type !== 'agent') || typeof id !== 'string' || !id.trim()) {
    throw requestInvalid('承接者必须是本空间的一位员工或一个 Agent 成员')
  }
  return { type, id: id.trim() }
}

function parseFileIds(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) {
    throw requestInvalid(`${field}必须是文件标识数组`)
  }
  const ids = [...new Set(value.map(id => (id as string).trim()))]
  if (ids.length > 5) throw requestInvalid(`${field}最多 5 个`)
  return ids
}
