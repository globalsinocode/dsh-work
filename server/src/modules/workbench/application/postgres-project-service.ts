import { randomUUID } from 'node:crypto'

import { authorizationDenied, isAuthorizationDenial, requestInvalid } from '../../../domain/authorization-errors.ts'
import { resolvePlatformTimezone } from '../../../domain/execution-time.ts'
import { nextSlotUtc, normalizeSchedule, slotsBetween, type ExecutionSchedule } from '../../../domain/execution-schedule.ts'
import {
  projectGovernanceRoles as governanceRoles,
  projectWriterRoles as writerRoles,
  type ProjectTeamRole as TeamRole,
} from '../../../domain/project-roles.ts'
import { RequestError } from '../../../domain/request-errors.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { sha256 } from '../../runtime/canonical-json.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import type { SessionAuthorizationContext } from '../../authorization/postgres-authorization-service.ts'
import type { PostgresProjectArchiveService } from './postgres-project-archive-service.ts'
import { activityTransitionToken, recordWorkspaceActivity } from './workspace-activity-writer.ts'
import { workspaceStateConflict } from './workspace-state-conflict-error.ts'

const tenantId = 'tenant-dsh-work'

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

/** S4：两类任务状态相同，由人推进；Agent 任务第一次执行开始时自动进入进行中。 */
export type ProjectTaskStatus = 'todo' | 'in_progress' | 'done'
export type ProjectTaskAction = 'edit' | 'remove' | 'start' | 'set_status' | 'complete' | 'resume'

/** S4：Agent 任务的执行规则（与自动任务同一日历语义；“工作日”存为每周一至五）。 */
export type ProjectTaskSchedule = ExecutionSchedule
export type ProjectTaskScheduleState = 'active' | 'paused' | 'stopped'

/** 定时执行的固定提示；任务说明、评论与历史结论经对话历史与摘要带入。 */
export const SCHEDULED_RUN_PROMPT = '按任务说明执行本期工作；与上次结论相比有变化时说明变化；没有新进展时以“无变化”开头并说明原因。'
/** 连续失败达到该次数时暂停定时执行。 */
export const SCHEDULE_FAILURE_LIMIT = 3
/** 定时槽位迟到容差：超出视为错过（服务停机），不补跑；与自动任务一致。 */
const SCHEDULE_MAX_LATENESS_MS = 10 * 60_000
/** 每个空间启用定时规则的 Agent 任务上限。 */
const SCHEDULED_TASKS_PER_WORKSPACE = 20

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
  /** S4：两类任务都取存储状态（由人推进），不再由执行推算。 */
  status: ProjectTaskStatus
  sessionId: string | null
  latestRunId: string | null
  /** 最近一次执行的状态与时间（Agent 任务）；单次执行结果不改任务状态。 */
  latestRunStatus: string | null
  latestRunAt: string | null
  /** S4：Agent 任务的执行规则；员工任务为 null。 */
  schedule: ProjectTaskSchedule | null
  scheduleState: ProjectTaskScheduleState | null
  /** 暂停或停止的原因：completed、due_passed、consecutive_failures、setter_ineligible、agent_unavailable、workspace_archived。 */
  scheduleReason: string | null
  /** 下一次定时执行（UTC ISO）；手动规则、暂停或停止时为 null。 */
  nextRunAt: string | null
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
/** 任务线程同一时间只允许一个执行；受理前复核与 createRun 锁内复核共用此提示。 */
export const TASK_THREAD_BUSY = 'Agent 正在执行该任务，请等待完成或先停止后再回复'

export interface ProjectTaskThreadPort {
  resolveTaskThread(sessionId: string): Promise<ProjectTaskThread | null>
  /** S3：员工任务的任务对话只能评论，不能交给 Agent 执行。 */
  assertNotEmployeeTaskThread(sessionId: string): Promise<void>
  /** S3：任务对话中有人发言后的收敛（承接人首次发言时把待办的员工任务推进为进行中）；不抛错。 */
  noteTaskConversationMessage(sessionId: string, userId: string): Promise<void>
  /** S4：任务对话中的执行已受理：待办的 Agent 任务进入进行中。不抛错。 */
  noteTaskRunStarted?(sessionId: string): Promise<void>
  /** S4：任务对话中的执行结束：成功清零、失败累计，连续失败达到上限时暂停定时执行。不抛错。 */
  noteTaskRunTerminal?(sessionId: string, status: 'succeeded' | 'failed'): Promise<void>
}

/** 经 Agent 写入的归因（S6）：动作人仍是发起成员，另记执行的 Agent 成员与 Run。 */
export interface ProjectTaskVia {
  agentMemberId: string
  agentName: string
  runId: string
}

/** S3：任务事件（员工任务的状态推进、完成与同类改派），在任务对话中作为系统记录展示。 */
export interface ProjectTaskEvent {
  id: string
  kind:
    | 'status_changed' | 'completed' | 'reassigned' | 'edited'
    | 'schedule_changed' | 'schedule_paused' | 'schedule_resumed' | 'schedule_stopped'
    | 'scheduled_run' | 'execution_skipped' | 'execution_missed'
  sessionId: string | null
  actor: { userId: string; displayName: string }
  metadata: Record<string, unknown>
  createdAt: string
}

export interface ProjectTaskThread {
  taskId: string
  agentMemberId: string
  /** S4：已完成的任务不再执行，重新打开后才能交给 Agent。 */
  status: ProjectTaskStatus
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
  postDiscussionMessage(input: {
    userId: string
    sessionId: string
    content: unknown
    idempotencyKey?: string | null
    skipProjectTaskSync?: boolean
  }): Promise<unknown>
  startRun(input: {
    userId: string
    sessionId: string
    prompt: unknown
    idempotencyKey: unknown
    fileIds?: string[]
    workspaceAgentMemberId?: string
    /** 定时触发：只装配项目任务读工具（S6）。 */
    scheduled?: boolean
    authorizationContext?: SessionAuthorizationContext
  }): Promise<{ id: string } | null | undefined>
}

/** 任务完成后触发项目档案员（RunOrchestrationService 的子集）；不抛错。 */
export interface ProjectArchivistTrigger {
  scheduleProjectArchive(workspaceId: string, requestedBy: string): Promise<void>
}

export interface ProjectAgentMembers {
  requireAvailableAgentMemberVersion(workspaceId: string, workspaceAgentMemberId: string): Promise<{ agentId: string; agentVersionId: string }>
}

interface TaskRow {
  id: string
  /** 微秒精度的 created_at（UTC），只用于分页游标；Date 只到毫秒，会让同一毫秒内的任务被跳过。 */
  cursorTimestamp: string
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
  latestRunAt: Date | null
  schedule: ProjectTaskSchedule | null
  scheduleState: ProjectTaskScheduleState | null
  scheduleReason: string | null
  nextSlotUtc: Date | null
}

/**
 * 项目空间 S1（docs/design/project-space-plan.md 第 4～6 节）：项目简报与项目任务。
 * 读取走读取轨（现任成员含只读成员，归档空间可读），写入走执行轨（活动空间、非只读成员）。
 * Agent 任务即任务线程，经既有 createSession / startRun 执行，不另建执行入口。
 */
export class PostgresProjectService implements ProjectTaskThreadPort {
  private runs?: ProjectRunStarter
  private archivist?: ProjectArchivistTrigger
  private readonly database: DatabaseClient
  private readonly agentMembers: ProjectAgentMembers
  private readonly archive?: PostgresProjectArchiveService

  constructor(database: DatabaseClient, agentMembers: ProjectAgentMembers, archive?: PostgresProjectArchiveService) {
    this.database = database
    this.agentMembers = agentMembers
    this.archive = archive
  }

  /** 编排服务依赖本服务的线程端口，故在构造后接线。 */
  attachRunStarter(runs: ProjectRunStarter & Partial<ProjectArchivistTrigger>) {
    this.runs = runs
    if (runs.scheduleProjectArchive) this.archivist = runs as ProjectArchivistTrigger
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

  async listTasks(
    workspaceId: string,
    actorUserId: string,
    input: { limit?: unknown; cursor?: unknown; sessionId?: unknown } = {},
  ): Promise<{ items: ProjectTask[]; nextCursor: string | null; total: number }> {
    const role = await this.requireRole(this.database, workspaceId, actorUserId, ['owner', 'admin', 'member', 'viewer'], { allowArchived: true })
    const archived = await this.isArchived(workspaceId)
    const limit = parseTaskPageLimit(input.limit)
    const cursor = parseTaskCursor(input.cursor)
    const sessionId = parseTaskSessionFilter(input.sessionId)
    // 多取一条用于判断是否还有下一页；游标按 (created_at, id) 倒序，与列表排序一致。
    const rows = await this.taskRows(this.database, workspaceId, undefined, { limit: limit + 1, cursor, sessionId })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    const [count] = await this.database<{ total: number }[]>`
      select count(*)::integer as total from project_tasks
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and removed_at is null
    `
    return {
      items: await this.toTasks(page, actorUserId, role, archived),
      nextCursor: hasMore && last
        ? encodeTaskCursor(last.cursorTimestamp, last.id)
        : null,
      total: count?.total ?? 0,
    }
  }

  /** 任务详情（读取轨）：全部现任成员可读，归档后仍可读；已移除或不存在返回 404。 */
  async getTask(workspaceId: string, taskId: string, actorUserId: string): Promise<ProjectTask> {
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  async createTask(
    workspaceId: string,
    actorUserId: string,
    input: {
      title: unknown; description?: unknown; assignee: unknown; inputFileIds?: unknown; dueDate?: unknown
      schedule?: unknown; startNow?: unknown
    },
    authorizationContext?: SessionAuthorizationContext,
    via?: ProjectTaskVia,
  ): Promise<ProjectTask> {
    const title = requireText(input.title, '任务标题', 120)
    const description = optionalText(input.description, '任务说明', 4000)
    const assignee = parseAssignee(input.assignee)
    const dueDate = optionalDate(input.dueDate, '截止时间')
    const inputFileIds = parseFileIds(input.inputFileIds, '引用文件')
    if (assignee.type === 'employee' && inputFileIds.length) throw requestInvalid('只有 Agent 任务可以引用执行输入文件')
    // S4：每个 Agent 任务都有执行规则，未指定时默认每天 09:00；员工任务没有执行规则。
    if (assignee.type === 'employee' && input.schedule !== undefined && input.schedule !== null) {
      throw requestInvalid('只有 Agent 任务可以设置执行规则')
    }
    if (input.startNow !== undefined && typeof input.startNow !== 'boolean') throw requestInvalid('startNow 必须是布尔值')
    if (input.startNow && assignee.type !== 'agent') throw requestInvalid('只有 Agent 任务可以立即执行')
    // S6：经 Agent 创建的 Agent 任务固定手动规则且不立即执行（D34）。
    if (via && assignee.type === 'agent' && input.startNow) {
      throw requestInvalid('经 Agent 创建的任务不能立即执行')
    }
    const schedule = assignee.type === 'agent'
      ? (via ? parseSchedule({ kind: 'manual' }) : parseSchedule(input.schedule))
      : null
    const taskId = `ptask-${randomUUID()}`
    // S3：两类任务创建时都有任务对话。会话先于任务建立（经既有 createSession 的授权）；
    // 任务写入失败时归档这条空会话。
    await this.requireRole(this.database, workspaceId, actorUserId, writerRoles)
    const sessionId = await this.openTaskConversation(workspaceId, actorUserId, title, authorizationContext)
    try {
    await this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      await this.assertAssignee(transaction, workspaceId, assignee)
      await this.assertWorkspaceFiles(transaction, workspaceId, inputFileIds, 'input')
      if (schedule) await assertScheduleQuota(transaction, workspaceId, schedule, null)
      await transaction`
        insert into project_tasks (
          id, tenant_id, workspace_id, title, description, created_by, assignee_type,
          assignee_user_id, assignee_agent_member_id, due_date, session_id,
          schedule, schedule_state, schedule_set_by, next_slot_utc, created_via
        ) values (
          ${taskId}, ${tenantId}, ${workspaceId}, ${title}, ${description}, ${actorUserId}, ${assignee.type},
          ${assignee.type === 'employee' ? assignee.id : null}, ${assignee.type === 'agent' ? assignee.id : null}, ${dueDate},
          ${sessionId},
          ${schedule ? transaction.json(schedule as never) : null}, ${schedule ? 'active' : null},
          ${schedule ? actorUserId : null}, ${schedule ? nextSlotUtc(schedule, new Date()) : null},
          ${via ? transaction.json(via as never) : null}
        )
      `
      await this.replaceTaskFiles(transaction, taskId, 'input', inputFileIds)
      await recordWorkspaceActivity(transaction, {
        workspaceId, kind: 'project_task_created', actorUserId, objectType: 'project_task', objectId: taskId,
        dedupeKey: `project-task-created:${taskId}`,
        metadata: {
          assigneeType: assignee.type,
          ...(via ? {
            viaAgentMemberId: via.agentMemberId,
            viaAgentName: via.agentName,
            viaRunId: via.runId,
          } : {}),
        },
      })
    })
    } catch (error) {
      await this.discardUnstartedThread(sessionId, null)
      throw error
    }
    await this.postTaskBrief(sessionId, actorUserId, taskId, title, description)
    // S4：“保存并立即执行”。任务已建好，执行受理失败时把错误交给调用方，任务保留，可再“立即执行”。
    if (input.startNow && !via) {
      return this.startAgentTask(workspaceId, taskId, actorUserId, {
        idempotencyKey: `project-task-start-now-${taskId}`, authorizationContext,
      })
    }
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  /** 读取任务事件（读取轨）：全部现任成员可读，归档可读；按发生时间正序。 */
  async listTaskEvents(workspaceId: string, taskId: string, actorUserId: string): Promise<ProjectTaskEvent[]> {
    await this.requireTask(workspaceId, taskId, actorUserId)
    const rows = await this.database<{
      id: string; kind: ProjectTaskEvent['kind']; sessionId: string | null
      actorUserId: string; actorName: string; metadata: Record<string, unknown>; createdAt: Date
    }[]>`
      select e.id, e.kind, e.session_id as "sessionId", e.actor_user_id as "actorUserId",
             u.display_name as "actorName", e.metadata, e.created_at as "createdAt"
        from project_task_events e
        join users u on u.tenant_id = e.tenant_id and u.id = e.actor_user_id
       where e.tenant_id = ${tenantId} and e.task_id = ${taskId}
       order by e.created_at, e.id
    `
    return rows.map(row => ({
      id: row.id,
      kind: row.kind,
      sessionId: row.sessionId,
      actor: { userId: row.actorUserId, displayName: row.actorName },
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  /** 新建任务对话（团队会话，不预先绑定 Agent；Agent 任务每次执行按承接成员绑定版本）。 */
  private async openTaskConversation(
    workspaceId: string,
    actorUserId: string,
    title: string,
    authorizationContext?: SessionAuthorizationContext,
  ): Promise<string> {
    if (!this.runs) throw new Error('项目任务对话未接线')
    const session = await this.runs.createSession({
      userId: actorUserId,
      title,
      workspaceId,
      agentVersionId: null,
      authorizationContext,
    })
    return session.id
  }

  /** 任务对话的首条消息：任务标题与说明，发言人为创建（或改派）的成员。失败只记录，不影响任务本身。 */
  private async postTaskBrief(sessionId: string, actorUserId: string, taskId: string, title: string, description: string) {
    try {
      await this.runs?.postDiscussionMessage({
        userId: actorUserId,
        sessionId,
        content: description ? `${title}\n\n${description}` : title,
        idempotencyKey: `project-task-brief-${taskId}-${sessionId}`,
        skipProjectTaskSync: true,
      })
    } catch (error) {
      console.error('Project task brief message failed:', error)
    }
  }

  private async recordTaskEvent(transaction: DatabaseTransaction, input: {
    taskId: string
    sessionId: string | null
    kind: ProjectTaskEvent['kind']
    actorUserId: string
    metadata?: Record<string, unknown>
  }) {
    await transaction`
      insert into project_task_events (id, tenant_id, task_id, session_id, kind, actor_user_id, metadata)
      values (${`ptevent-${randomUUID()}`}, ${tenantId}, ${input.taskId}, ${input.sessionId}, ${input.kind},
              ${input.actorUserId}, ${transaction.json((input.metadata ?? {}) as never)})
    `
  }

  async updateTask(
    workspaceId: string,
    taskId: string,
    actorUserId: string,
    input: {
      title?: unknown; description?: unknown; assignee?: unknown; inputFileIds?: unknown; dueDate?: unknown
      schedule?: unknown
    },
    authorizationContext?: SessionAuthorizationContext,
    via?: ProjectTaskVia,
  ): Promise<ProjectTask> {
    const scheduleInput = input.schedule === undefined ? undefined : parseSchedule(input.schedule)
    // S3 改派：员工换员工沿用原任务对话并记一条事件；跨类型或换 Agent 从新的任务对话开始。
    // 新会话需经 createSession 的授权，因此先于事务建立；事务中改派条件已变化时丢弃它。
    let freshSessionId: string | null = null
    let freshUsed = false
    if (input.assignee !== undefined) {
      const preview = await this.lockTask(this.database, workspaceId, taskId)
      if (needsNewConversation(preview, parseAssignee(input.assignee))) {
        await this.requireRole(this.database, workspaceId, actorUserId, writerRoles)
        const nextTitle = input.title === undefined ? preview.title : requireText(input.title, '任务标题', 120)
        freshSessionId = await this.openTaskConversation(workspaceId, actorUserId, nextTitle, authorizationContext)
      }
    }
    let briefTitle = ''
    let briefDescription = ''
    try {
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
      let assigneeChanged = false
      if (input.assignee !== undefined) {
        const assignee = parseAssignee(input.assignee)
        const changed = assignee.type !== task.assigneeType
          || assignee.id !== (task.assigneeType === 'employee' ? task.assigneeUserId : task.assigneeAgentMemberId)
        assigneeChanged = changed
        if (changed) {
          if (task.sessionId && await hasActiveRun(transaction, task.sessionId)) {
            throw workspaceStateConflict('Agent 正在执行该任务，请等待完成或停止后再改派')
          }
          await this.assertAssignee(transaction, workspaceId, assignee)
          if (needsNewConversation(task, assignee)) {
            if (!freshSessionId) throw workspaceStateConflict('任务已被其他成员修改，请刷新后重试')
            sessionId = freshSessionId
            freshUsed = true
            // S6：经 Agent 的跨类型或换 Agent 改派也记一条事件（新任务对话中），时间线据此显示结果卡片。
            if (via) {
              await this.recordTaskEvent(transaction, {
                taskId, sessionId, kind: 'reassigned', actorUserId,
                metadata: {
                  from: await assigneeName(transaction, task.assigneeType, task.assigneeUserId ?? task.assigneeAgentMemberId),
                  to: await assigneeName(transaction, assignee.type, assignee.id),
                  via,
                },
              })
            }
          } else {
            const names = await transaction<{ id: string; name: string }[]>`
              select id, display_name as name from users
               where tenant_id = ${tenantId} and id in ${transaction([task.assigneeUserId ?? '', assignee.id])}
            `
            await this.recordTaskEvent(transaction, {
              taskId, sessionId: task.sessionId, kind: 'reassigned', actorUserId,
              metadata: {
                from: names.find(row => row.id === task.assigneeUserId)?.name ?? '',
                to: names.find(row => row.id === assignee.id)?.name ?? '',
                ...(via ? { via } : {}),
              },
            })
          }
          assigneeType = assignee.type
          assigneeUserId = assignee.type === 'employee' ? assignee.id : null
          assigneeAgentMemberId = assignee.type === 'agent' ? assignee.id : null
        }
      }
      briefTitle = title
      briefDescription = description
      const inputFileIds = input.inputFileIds === undefined ? undefined : parseFileIds(input.inputFileIds, '引用文件')
      if (assigneeType === 'employee' && inputFileIds?.length) throw requestInvalid('只有 Agent 任务可以引用执行输入文件')
      if (inputFileIds) await this.assertWorkspaceFiles(transaction, workspaceId, inputFileIds, 'input')
      if (assigneeType === 'employee' && scheduleInput && input.schedule !== null) {
        throw requestInvalid('只有 Agent 任务可以设置执行规则')
      }
      // S4：执行规则只属于 Agent 任务。改派给员工时删除；从员工改派给 Agent 时按输入或默认每天建立；
      // 修改规则时由修改人接管归因，暂停清除、失败计数清零，从当前时刻重新计算下次时间点。
      // S6：经 Agent 改派给（另一个）Agent 时固定手动规则（D34）；经 Agent 不接受执行规则输入，
      // 负责人未变时保留原规则。
      if (via && scheduleInput !== undefined) throw requestInvalid('经 Agent 修改任务时不能设置执行规则')
      const becameAgent = assigneeType === 'agent' && task.assigneeType !== 'agent'
      const viaManual = Boolean(via) && assigneeType === 'agent' && assigneeChanged
      const schedule = assigneeType === 'agent'
        ? (viaManual ? parseSchedule({ kind: 'manual' }) : (scheduleInput ?? (becameAgent ? parseSchedule(undefined) : task.schedule)))
        : null
      const scheduleTouched = assigneeType === 'agent' && (becameAgent || scheduleInput !== undefined || viaManual)
      if (scheduleTouched && schedule) await assertScheduleQuota(transaction, workspaceId, schedule, taskId)
      // 一条语句同时改负责人与执行规则：两者受 project_tasks_schedule_shape 共同约束。
      const scheduleMode = assigneeType === 'employee' ? 'clear' : scheduleTouched ? 'set' : 'keep'
      const finished = task.status === 'done'
      const nextSlot = scheduleMode === 'set' && schedule && !finished ? nextSlotUtc(schedule, new Date()) : null
      await transaction`
        update project_tasks
           set title = ${title}, description = ${description}, due_date = ${dueDate},
               assignee_type = ${assigneeType}, assignee_user_id = ${assigneeUserId},
               assignee_agent_member_id = ${assigneeAgentMemberId}, session_id = ${sessionId},
               schedule = case ${scheduleMode}::text when 'clear' then null
                 when 'set' then ${transaction.json((schedule ?? {}) as never)} else schedule end,
               schedule_revision = case ${scheduleMode}::text when 'set' then schedule_revision + 1 else schedule_revision end,
               schedule_state = case ${scheduleMode}::text when 'clear' then null
                 when 'set' then ${finished ? 'stopped' : 'active'}::text else schedule_state end,
               schedule_reason = case ${scheduleMode}::text when 'clear' then null
                 when 'set' then ${finished ? 'completed' : null}::text else schedule_reason end,
               schedule_set_by = case ${scheduleMode}::text when 'clear' then null
                 when 'set' then ${actorUserId}::text else schedule_set_by end,
               next_slot_utc = case ${scheduleMode}::text when 'clear' then null
                 when 'set' then ${nextSlot}::timestamptz else next_slot_utc end,
               consecutive_failures = case ${scheduleMode}::text when 'keep' then consecutive_failures else 0 end,
               updated_at = now()
         where tenant_id = ${tenantId} and id = ${taskId}
      `
      if (scheduleMode === 'set' && !becameAgent && schedule && !sameSchedule(task.schedule, schedule)) {
        await this.recordTaskEvent(transaction, {
          taskId, sessionId, kind: 'schedule_changed', actorUserId,
          metadata: { schedule, ...(via ? { via } : {}) },
        })
      }
      // S6：标题、说明、截止日期变更写入 edited，供时间线结果卡片展示。
      // previous 记录修改前的标题与截止日期，结果卡片据此显示“原值 → 新值”。
      const edited: Record<string, unknown> = {}
      const previous: Record<string, unknown> = {}
      if (title !== task.title) { edited.title = title; previous.title = task.title }
      if (description !== task.description) edited.description = description
      if (dueDate !== task.dueDate) { edited.dueDate = dueDate; previous.dueDate = task.dueDate }
      if (Object.keys(edited).length) {
        await this.recordTaskEvent(transaction, {
          taskId, sessionId, kind: 'edited', actorUserId,
          metadata: { ...edited, previous, ...(via ? { via } : {}) },
        })
      }
      if (inputFileIds) await this.replaceTaskFiles(transaction, taskId, 'input', inputFileIds)
      else if (assigneeType === 'employee') await this.replaceTaskFiles(transaction, taskId, 'input', [])
    })
    } catch (error) {
      if (freshSessionId) await this.discardUnstartedThread(freshSessionId, null)
      throw error
    }
    if (freshSessionId && !freshUsed) await this.discardUnstartedThread(freshSessionId, null)
    if (freshSessionId && freshUsed) await this.postTaskBrief(freshSessionId, actorUserId, taskId, briefTitle, briefDescription)
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

  /**
   * 任务状态推进（S4 起两类任务相同）：员工任务由任务负责人、创建人、空间负责人或管理员推进；
   * Agent 任务由创建人、空间负责人或管理员推进。完成时可附说明与共享文件。
   * Agent 任务标记完成时停止定时执行；改回待办或进行中时按规则从当前时刻恢复。
   */
  async setTaskStatus(
    workspaceId: string,
    taskId: string,
    actorUserId: string,
    input: { status: unknown; completionNote?: unknown; deliverableFileIds?: unknown },
    via?: ProjectTaskVia,
  ): Promise<ProjectTask> {
    if (input.status !== 'todo' && input.status !== 'in_progress' && input.status !== 'done') {
      throw requestInvalid('status 必须是 todo、in_progress 或 done')
    }
    const status = input.status
    const note = status === 'done' ? optionalText(input.completionNote, '完成说明', 4000) || null : null
    const deliverables = status === 'done' ? parseFileIds(input.deliverableFileIds, '交付文件') : []
    let completed = false
    await this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      const role = await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      const task = await this.lockTask(transaction, workspaceId, taskId)
      if (![task.assigneeUserId, task.createdBy].includes(actorUserId) && !governanceRoles.includes(role)) {
        throw authorizationDenied('只有任务负责人、任务创建人、空间负责人或管理员可以更新任务状态')
      }
      if (task.assigneeType === 'agent' && status === 'done' && task.sessionId && await hasActiveRun(transaction, task.sessionId)) {
        throw workspaceStateConflict('Agent 正在执行该任务，请等待完成或停止后再标记完成')
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
      if (task.assigneeType === 'agent' && task.schedule && task.status !== status) {
        if (status === 'done') {
          await transaction`
            update project_tasks set schedule_state = 'stopped', schedule_reason = 'completed', next_slot_utc = null
             where tenant_id = ${tenantId} and id = ${taskId}
          `
        } else if (task.status === 'done') {
          await transaction`
            update project_tasks
               set schedule_state = 'active', schedule_reason = null, consecutive_failures = 0,
                   next_slot_utc = ${nextSlotUtc(task.schedule, new Date())}
             where tenant_id = ${tenantId} and id = ${taskId}
          `
        }
      }
      await this.replaceTaskFiles(transaction, taskId, 'deliverable', deliverables)
      // S3：状态推进与完成在任务对话中作为系统记录展示。
      if (status !== 'done' && task.status !== status) {
        await this.recordTaskEvent(transaction, {
          taskId, sessionId: task.sessionId, kind: 'status_changed', actorUserId,
          metadata: { from: task.status, to: status, ...(via ? { via } : {}) },
        })
      }
      if (status === 'done' && task.status !== 'done') {
        const names = deliverables.length ? await transaction<{ name: string }[]>`
          select f.name from workspace_file_versions v
            join workspace_files f on f.tenant_id = v.tenant_id and f.id = v.logical_file_id
           where v.tenant_id = ${tenantId} and v.file_object_id in ${transaction(deliverables)}
        ` : []
        await this.recordTaskEvent(transaction, {
          taskId, sessionId: task.sessionId, kind: 'completed', actorUserId,
          metadata: { note, deliverables: names.map(row => row.name), ...(via ? { via } : {}) },
        })
        await recordWorkspaceActivity(transaction, {
          workspaceId, kind: 'project_task_completed', actorUserId, objectType: 'project_task', objectId: taskId,
          dedupeKey: `project-task-completed:${taskId}:${await activityTransitionToken(transaction)}`,
          metadata: via ? {
            viaAgentMemberId: via.agentMemberId,
            viaAgentName: via.agentName,
            viaRunId: via.runId,
          } : {},
        })
        if (this.archive) {
          // 项目空间 S2：完成说明与交付文件名交给档案员整理（S4 起 Agent 任务标记完成同样登记）。
          await this.archive.recordEmployeeTaskResult(transaction, {
            workspaceId, taskId, title: task.title, note, deliverableNames: names.map(row => row.name),
          })
          completed = true
        }
      }
    })
    if (completed) await this.archivist?.scheduleProjectArchive(workspaceId, actorUserId)
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  /** S4：恢复已暂停的定时执行；恢复人接管归因，失败计数清零，从当前时刻计算下次时间点。 */
  async resumeTaskSchedule(workspaceId: string, taskId: string, actorUserId: string): Promise<ProjectTask> {
    await this.database.begin(async (transaction) => {
      await lockActiveWorkspace(transaction, workspaceId)
      const role = await this.requireRole(transaction, workspaceId, actorUserId, writerRoles)
      const task = await this.lockTask(transaction, workspaceId, taskId)
      if (task.createdBy !== actorUserId && !governanceRoles.includes(role)) {
        throw authorizationDenied('只有任务创建人、空间负责人或管理员可以恢复定时执行')
      }
      if (task.assigneeType !== 'agent' || !task.schedule) throw workspaceStateConflict('员工任务没有执行规则')
      if (task.scheduleState !== 'paused') throw workspaceStateConflict('定时执行未暂停')
      await transaction`
        update project_tasks
           set schedule_state = 'active', schedule_reason = null, schedule_set_by = ${actorUserId},
               consecutive_failures = 0, next_slot_utc = ${nextSlotUtc(task.schedule, new Date())}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${taskId}
      `
      await this.recordTaskEvent(transaction, {
        taskId, sessionId: task.sessionId, kind: 'schedule_resumed', actorUserId,
      })
    })
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  /**
   * 启动 Agent 任务（S3）：任务对话在创建时已存在，首次执行在该对话中发起，带上任务引用的文件；
   * 可附补充要求（成员在对话里写下后“交给 Agent”），未附时以开始执行的指令发起。之后在对话中回复即续接。
   * 执行经既有 startRun，授权、复核与收权与团队对话一致。没有任务对话的旧任务先补建。
   */
  async startAgentTask(
    workspaceId: string,
    taskId: string,
    actorUserId: string,
    input: { idempotencyKey: unknown; prompt?: unknown; authorizationContext?: SessionAuthorizationContext },
  ): Promise<ProjectTask> {
    if (!this.runs) throw new Error('项目任务执行未接线')
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw requestInvalid('必须提供 idempotencyKey')
    }
    const extra = optionalText(input.prompt, '补充要求', 20000)
    await this.requireRole(this.database, workspaceId, actorUserId, writerRoles)
    const task = await this.lockTask(this.database, workspaceId, taskId)
    if (task.assigneeType !== 'agent' || !task.assigneeAgentMemberId) throw workspaceStateConflict('员工任务不需要启动执行')
    if (task.status === 'done') throw workspaceStateConflict('任务已完成，改回进行中后才能执行')
    await this.agentMembers.requireAvailableAgentMemberVersion(workspaceId, task.assigneeAgentMemberId)
    let sessionId = task.sessionId
    if (!sessionId) {
      const created = await this.openTaskConversation(workspaceId, actorUserId, task.title, input.authorizationContext)
      // 并发补建只有一个能绑定；落败方丢弃自己的会话，沿用已绑定的。
      const [bound] = await this.database<{ id: string }[]>`
        update project_tasks set session_id = ${created}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${taskId} and session_id is null and removed_at is null
        returning id
      `
      if (!bound) {
        await this.discardUnstartedThread(created, null)
        throw workspaceStateConflict('任务已被其他成员启动或已改派，请刷新后查看')
      }
      sessionId = created
      await this.postTaskBrief(sessionId, actorUserId, taskId, task.title, task.description)
    }
    // S4：“立即执行”在任何执行规则下都可用；同一时间只有一个执行由 startRun 在会话锁内复核（409）。
    const [run] = await this.database<{ id: string }[]>`
      select id from runs where tenant_id = ${tenantId} and session_id = ${sessionId} limit 1
    `
    const inputFileIds = await this.taskFileIds(taskId, 'input')
    await this.runs.startRun({
      userId: actorUserId,
      sessionId,
      prompt: extra || (run ? SCHEDULED_RUN_PROMPT : `请开始执行任务“${task.title}”。`),
      idempotencyKey: input.idempotencyKey,
      fileIds: inputFileIds,
      workspaceAgentMemberId: task.assigneeAgentMemberId,
      authorizationContext: input.authorizationContext,
    })
    return this.requireTask(workspaceId, taskId, actorUserId)
  }

  /** 启动未能创建 Run 时的补偿：解绑任务线程并归档这条空会话；已有 Run 的线程原样保留。 */
  private async discardUnstartedThread(sessionId: string, taskId: string | null) {
    await this.database.begin(async (transaction) => {
      // 锁顺序与 createRun 一致：workspaces -> sessions -> runs。
      const [owner] = await transaction<{ workspaceId: string }[]>`
        select workspace_id as "workspaceId" from sessions where tenant_id = ${tenantId} and id = ${sessionId}
      `
      if (!owner) return
      await transaction`select id from workspaces where tenant_id = ${tenantId} and id = ${owner.workspaceId} for update`
      const [session] = await transaction<{ workspaceId: string }[]>`
        select workspace_id as "workspaceId" from sessions
         where tenant_id = ${tenantId} and id = ${sessionId} and status = 'active'
         for update
      `
      if (!session) return
      const [run] = await transaction<{ id: string }[]>`
        select id from runs where tenant_id = ${tenantId} and session_id = ${sessionId} limit 1
      `
      if (run) return
      if (taskId) {
        await transaction`
          update project_tasks set session_id = null, updated_at = now()
           where tenant_id = ${tenantId} and id = ${taskId} and session_id = ${sessionId}
        `
      }
      await transaction`
        update sessions set status = 'archived', last_active_at = now()
         where tenant_id = ${tenantId} and id = ${sessionId}
      `
      await transaction`
        update workspaces set team_auth_revision = team_auth_revision + 1
         where tenant_id = ${tenantId} and id = ${session.workspaceId}
      `
    })
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
      const [member] = await transaction<{ status: string }[]>`
        select status from workspace_agent_members where tenant_id = ${tenantId} and id = ${session.agentMemberId}
      `
      if (member?.status !== 'available') throw workspaceStateConflict('该 Agent 成员已停用，不能承接新任务')
      const [existing] = await transaction<{ id: string }[]>`
        select id from project_tasks where tenant_id = ${tenantId} and session_id = ${sessionId}
      `
      if (existing) throw workspaceStateConflict('该线程已经是任务')
      const title = input.title === undefined ? session.title.slice(0, 120) : requireText(input.title, '任务标题', 120)
      // S4：设为任务的线程已经执行过，直接进入进行中；执行规则取默认（每天 09:00）。
      const schedule = parseSchedule(undefined)
      await assertScheduleQuota(transaction, workspaceId, schedule, null)
      try {
        await transaction`
          insert into project_tasks (
            id, tenant_id, workspace_id, title, description, created_by, assignee_type,
            assignee_agent_member_id, session_id, status,
            schedule, schedule_state, schedule_set_by, next_slot_utc
          ) values (
            ${taskId}, ${tenantId}, ${workspaceId}, ${title}, '', ${actorUserId}, 'agent',
            ${session.agentMemberId}, ${sessionId}, 'in_progress',
            ${transaction.json(schedule as never)}, 'active', ${actorUserId}, ${nextSlotUtc(schedule, new Date())}
          )
        `
      } catch (error) {
        // 并发“设为任务”撞 project_tasks_session_unique 时与预检同义返回 409，而不是落到 500；
        // postgres.js 把约束名放在 constraint_name（见 postgres-run-repository 的序列冲突判断），
        // 其他唯一约束冲突保持原错误，避免把无关的 23505 误报成“该线程已经是任务”。
        const failure = error as { code?: string; constraint_name?: string }
        if (failure.code === '23505' && failure.constraint_name === 'project_tasks_session_unique') {
          throw workspaceStateConflict('该线程已经是任务')
        }
        throw error
      }
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
    const [row] = await this.database<{ taskId: string; workspaceId: string; agentMemberId: string; status: ProjectTaskStatus }[]>`
      select id as "taskId", workspace_id as "workspaceId", assignee_agent_member_id as "agentMemberId", status
        from project_tasks
       where tenant_id = ${tenantId} and session_id = ${sessionId} and removed_at is null
         and assignee_type = 'agent'
    `
    if (!row) return null
    const [brief, archive] = await Promise.all([
      this.latestBrief(this.database, row.workspaceId),
      this.archive?.archiveContext(row.workspaceId) ?? null,
    ])
    return {
      taskId: row.taskId,
      agentMemberId: row.agentMemberId,
      status: row.status,
      projectContext: brief || archive ? {
        ...(brief ? {
          brief: {
            version_id: brief.versionId,
            version_no: brief.versionNo,
            content: brief.content,
            content_sha256: sha256(brief.content),
            due_date: brief.dueDate,
          },
        } : {}),
        ...(archive ? { archive } : {}),
      } : null,
    }
  }

  /** 任务线程同一时间只允许一个执行；执行中的回复需等待完成或先停止。 */
  async assertTaskThreadIdle(sessionId: string): Promise<void> {
    if (await hasActiveRun(this.database, sessionId)) {
      throw workspaceStateConflict(TASK_THREAD_BUSY)
    }
  }

  /** S3：员工任务的任务对话只用于进度与评论，@Agent 发起执行一律拒绝。 */
  async assertNotEmployeeTaskThread(sessionId: string): Promise<void> {
    const [row] = await this.database<{ id: string }[]>`
      select id from project_tasks
       where tenant_id = ${tenantId} and session_id = ${sessionId} and removed_at is null
         and assignee_type = 'employee'
    `
    if (row) throw requestInvalid('员工任务的对话只能发表进度与评论，不能交给 Agent 执行')
  }

  /** S3：承接人在待办的员工任务对话中首次发言时，任务自动推进为进行中，并留下系统记录。不抛错。 */
  async noteTaskConversationMessage(sessionId: string, userId: string): Promise<void> {
    try {
      await this.database.begin(async (transaction) => {
        const [task] = await transaction<{ id: string; workspaceId: string; status: string; assigneeUserId: string | null }[]>`
          select id, workspace_id as "workspaceId", status, assignee_user_id as "assigneeUserId"
            from project_tasks
           where tenant_id = ${tenantId} and session_id = ${sessionId} and removed_at is null
             and assignee_type = 'employee'
           for update
        `
        if (!task || task.status !== 'todo' || task.assigneeUserId !== userId) return
        await transaction`
          update project_tasks set status = 'in_progress', updated_at = now()
           where tenant_id = ${tenantId} and id = ${task.id}
        `
        await this.recordTaskEvent(transaction, {
          taskId: task.id, sessionId, kind: 'status_changed', actorUserId: userId,
          metadata: { from: 'todo', to: 'in_progress', auto: true },
        })
      })
    } catch (error) {
      console.error('Project task conversation sync failed:', error)
    }
  }

  /** S4：任务对话中的执行已受理时，待办的 Agent 任务进入进行中。不抛错。 */
  async noteTaskRunStarted(sessionId: string): Promise<void> {
    try {
      await this.database`
        update project_tasks set status = 'in_progress', updated_at = now()
         where tenant_id = ${tenantId} and session_id = ${sessionId} and removed_at is null
           and assignee_type = 'agent' and status = 'todo'
      `
    } catch (error) {
      console.error('Project task run start sync failed:', error)
    }
  }

  /**
   * S4：任务对话中的执行结束。成功清零失败计数；失败累计，连续失败达到上限且定时执行启用中时暂停，
   * 并在任务对话中留下系统记录。停止（取消）不计入。不抛错。
   */
  async noteTaskRunTerminal(sessionId: string, status: 'succeeded' | 'failed'): Promise<void> {
    try {
      if (status === 'succeeded') {
        await this.database`
          update project_tasks set consecutive_failures = 0
           where tenant_id = ${tenantId} and session_id = ${sessionId} and removed_at is null
             and assignee_type = 'agent' and consecutive_failures <> 0
        `
        return
      }
      await this.database.begin(async (transaction) => {
        const [task] = await transaction<{
          id: string; schedule: ProjectTaskSchedule | null; scheduleState: ProjectTaskScheduleState | null
          setBy: string | null; failures: number
        }[]>`
          select id, schedule, schedule_state as "scheduleState", schedule_set_by as "setBy",
                 consecutive_failures as failures
            from project_tasks
           where tenant_id = ${tenantId} and session_id = ${sessionId} and removed_at is null and assignee_type = 'agent'
           for update
        `
        if (!task) return
        const failures = task.failures + 1
        const pause = failures >= SCHEDULE_FAILURE_LIMIT && task.scheduleState === 'active'
          && task.schedule !== null && task.schedule.kind !== 'manual'
        await transaction`
          update project_tasks
             set consecutive_failures = ${failures},
                 schedule_state = ${pause ? 'paused' : task.scheduleState},
                 schedule_reason = ${pause ? 'consecutive_failures' : null},
                 next_slot_utc = case when ${pause} then null else next_slot_utc end
           where tenant_id = ${tenantId} and id = ${task.id}
        `
        if (pause && task.setBy) {
          await this.recordTaskEvent(transaction, {
            taskId: task.id, sessionId, kind: 'schedule_paused', actorUserId: task.setBy,
            metadata: { reason: 'consecutive_failures', failures },
          })
        }
      })
    } catch (error) {
      console.error('Project task run terminal sync failed:', error)
    }
  }

  /**
   * S4 调度：处理到期的定时执行（由自动任务触发扫描在同一调度所有者锁下按轮调用）。
   * 每个任务每轮只受理最近一个未迟到的时间点；超出迟到容差的时间点合并为一条“错过”记录，不补跑。
   */
  async processDueSchedules(now: Date = new Date()): Promise<void> {
    const due = await this.database<{ id: string }[]>`
      select id from project_tasks
       where tenant_id = ${tenantId} and schedule_state = 'active' and removed_at is null
         and next_slot_utc is not null and next_slot_utc <= ${now}
       order by next_slot_utc, id
       limit 50
    `
    for (const { id } of due) {
      await this.processScheduledSlot(id, now).catch((error: unknown) => {
        console.error(`project task ${id} schedule failed`, error)
      })
    }
  }

  private async processScheduledSlot(taskId: string, now: Date): Promise<void> {
    if (!this.runs) throw new Error('项目任务执行未接线')
    const plan = await this.database.begin(async (transaction) => {
      const [task] = await transaction<{
        id: string; workspaceId: string; sessionId: string | null; agentMemberId: string | null
        schedule: ProjectTaskSchedule | null; scheduleState: ProjectTaskScheduleState | null
        setBy: string | null; nextSlot: Date | null; status: ProjectTaskStatus; dueDate: string | null
        workspaceStatus: string; agentStatus: string | null
      }[]>`
        select t.id, t.workspace_id as "workspaceId", t.session_id as "sessionId",
               t.assignee_agent_member_id as "agentMemberId", t.schedule, t.schedule_state as "scheduleState",
               t.schedule_set_by as "setBy", t.next_slot_utc as "nextSlot", t.status, t.due_date::text as "dueDate",
               w.status as "workspaceStatus", wam.status as "agentStatus"
          from project_tasks t
          join workspaces w on w.tenant_id = t.tenant_id and w.id = t.workspace_id
          left join workspace_agent_members wam on wam.tenant_id = t.tenant_id and wam.id = t.assignee_agent_member_id
         where t.tenant_id = ${tenantId} and t.id = ${taskId} and t.removed_at is null and t.assignee_type = 'agent'
         for update of t
      `
      if (!task?.schedule || !task.setBy || task.scheduleState !== 'active' || !task.nextSlot || task.nextSlot > now) return null
      const setBy = task.setBy
      const stop = async (reason: string) => {
        await transaction`
          update project_tasks set schedule_state = 'stopped', schedule_reason = ${reason}, next_slot_utc = null
           where tenant_id = ${tenantId} and id = ${taskId}
        `
        await this.recordTaskEvent(transaction, {
          taskId, sessionId: task.sessionId, kind: 'schedule_stopped', actorUserId: setBy, metadata: { reason },
        })
        return null
      }
      if (task.workspaceStatus !== 'active') return stop('workspace_archived')
      if (task.agentStatus !== 'available') return stop('agent_unavailable')
      if (task.status === 'done') return stop('completed')
      if (task.dueDate && task.dueDate < localDate(now, task.schedule.timezone)) return stop('due_passed')

      const slots = slotsBetween(task.schedule, new Date(task.nextSlot.getTime() - 1), now)
      const missed = slots.filter(slot => now.getTime() - slot.getTime() > SCHEDULE_MAX_LATENESS_MS)
      const slot = slots.filter(item => now.getTime() - item.getTime() <= SCHEDULE_MAX_LATENESS_MS).at(-1)
      await transaction`
        update project_tasks set next_slot_utc = ${nextSlotUtc(task.schedule, now)}
         where tenant_id = ${tenantId} and id = ${taskId}
      `
      if (missed.length) {
        await this.recordTaskEvent(transaction, {
          taskId, sessionId: task.sessionId, kind: 'execution_missed', actorUserId: setBy,
          metadata: { from: missed[0]!.toISOString(), to: missed.at(-1)!.toISOString(), count: missed.length },
        })
      }
      if (!slot || !task.sessionId || !task.agentMemberId) return null
      if (await hasActiveRun(transaction, task.sessionId)) {
        await this.recordTaskEvent(transaction, {
          taskId, sessionId: task.sessionId, kind: 'execution_skipped', actorUserId: setBy,
          metadata: { slot: slot.toISOString(), reason: 'busy' },
        })
        return null
      }
      return {
        workspaceId: task.workspaceId, sessionId: task.sessionId, agentMemberId: task.agentMemberId,
        setBy, slot: slot.toISOString(),
      }
    })
    if (!plan) return
    const record = async (kind: ProjectTaskEvent['kind'], metadata: Record<string, unknown>, pause = false) => {
      await this.database.begin(async (transaction) => {
        if (pause) {
          await transaction`
            update project_tasks set schedule_state = 'paused', schedule_reason = ${String(metadata.reason)}, next_slot_utc = null
             where tenant_id = ${tenantId} and id = ${taskId} and schedule_state = 'active'
          `
        }
        await this.recordTaskEvent(transaction, { taskId, sessionId: plan.sessionId, kind, actorUserId: plan.setBy, metadata })
      })
    }
    try {
      // 执行身份仍是 Agent（数据范围取 Agent 授权与全体成员交集）；规则设置人只用于 Run 归因与准入。
      const run = await this.runs.startRun({
        userId: plan.setBy,
        sessionId: plan.sessionId,
        prompt: SCHEDULED_RUN_PROMPT,
        idempotencyKey: `project-task-schedule-${taskId}-${plan.slot}`,
        fileIds: await this.taskFileIds(taskId, 'input'),
        workspaceAgentMemberId: plan.agentMemberId,
        scheduled: true,
      })
      await record('scheduled_run', { slot: plan.slot, runId: run?.id ?? null })
    } catch (error) {
      if (isAuthorizationDenial(error)) {
        await record('schedule_paused', { reason: 'setter_ineligible', slot: plan.slot }, true)
      } else if ((error as { status?: unknown }).status === 409) {
        await record('execution_skipped', { slot: plan.slot, reason: 'busy' })
      } else {
        await record('execution_skipped', { slot: plan.slot, reason: 'start_failed' })
        console.error(`project task ${taskId} scheduled run was not accepted`, error)
      }
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
      schedule: ProjectTaskSchedule | null; scheduleState: ProjectTaskScheduleState | null
    }[]>`
      select id, title, description, created_by as "createdBy", assignee_type as "assigneeType",
             assignee_user_id as "assigneeUserId", assignee_agent_member_id as "assigneeAgentMemberId",
             session_id as "sessionId", status, due_date::text as "dueDate",
             schedule, schedule_state as "scheduleState"
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
      if (!member) throw requestInvalid('任务负责人必须是本空间成员')
      if (member.role === 'viewer') throw requestInvalid('只读成员不能承接任务')
      return
    }
    const [agent] = await transaction<{ status: string }[]>`
      select status from workspace_agent_members
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${assignee.id}
    `
    if (!agent) throw requestInvalid('负责任务的 Agent 必须是本空间的 Agent 成员')
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

  private async taskRows(
    database: DatabaseClient | DatabaseTransaction,
    workspaceId: string,
    taskId?: string,
    page?: { limit: number; cursor: { createdAt: string; id: string } | null; sessionId?: string | null },
  ): Promise<TaskRow[]> {
    const cursor = page?.cursor ?? null
    const sessionId = page?.sessionId ?? null
    return database<TaskRow[]>`
      select t.id, t.workspace_id as "workspaceId", t.title, t.description,
             t.created_by as "createdBy", cu.display_name as "createdByName",
             t.assignee_type as "assigneeType", t.assignee_user_id as "assigneeUserId", au.display_name as "assigneeUserName",
             t.assignee_agent_member_id as "assigneeAgentMemberId", a.name as "assigneeAgentName",
             t.session_id as "sessionId", t.status, t.completion_note as "completionNote", t.completed_at as "completedAt",
             t.due_date::text as "dueDate", t.created_at as "createdAt", t.updated_at as "updatedAt",
             to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorTimestamp",
             lr.id as "latestRunId", lr.status as "latestRunStatus", lr.created_at as "latestRunAt",
             t.schedule, t.schedule_state as "scheduleState", t.schedule_reason as "scheduleReason",
             t.next_slot_utc as "nextSlotUtc"
        from project_tasks t
        join users cu on cu.tenant_id = t.tenant_id and cu.id = t.created_by
        left join users au on au.tenant_id = t.tenant_id and au.id = t.assignee_user_id
        left join workspace_agent_members wam on wam.tenant_id = t.tenant_id and wam.id = t.assignee_agent_member_id
        left join agents a on a.tenant_id = wam.tenant_id and a.id = wam.agent_id
        left join lateral (
          select r.id, r.status, r.created_at from runs r
           where r.tenant_id = t.tenant_id and r.session_id = t.session_id
           order by r.created_at desc, r.id desc limit 1
        ) lr on true
       where t.tenant_id = ${tenantId} and t.workspace_id = ${workspaceId} and t.removed_at is null
         and (${taskId ?? null}::text is null or t.id = ${taskId ?? null})
         and (${sessionId}::text is null or t.session_id = ${sessionId})
         -- ::text 先行：postgres.js 按 timestamptz 参数序列化时会经 Date 截到毫秒，游标失去微秒精度。
         and (${cursor === null} or (t.created_at, t.id) < (${cursor?.createdAt ?? null}::text::timestamptz, ${cursor?.id ?? null}))
       order by t.created_at desc, t.id desc
       limit ${page?.limit ?? null}
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
      const canManage = writer && (row.createdBy === actorUserId || governance)
      const allowedActions: ProjectTaskAction[] = []
      if (canManage) allowedActions.push('edit', 'remove')
      if (writer && row.assigneeType === 'agent' && row.status !== 'done') allowedActions.push('start')
      if (writer && (canManage || (row.assigneeType === 'employee' && row.assigneeUserId === actorUserId))) {
        allowedActions.push('set_status', 'complete')
      }
      if (canManage && row.assigneeType === 'agent' && row.scheduleState === 'paused') allowedActions.push('resume')
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        createdBy: { userId: row.createdBy, displayName: row.createdByName },
        assignee: row.assigneeType === 'employee'
          ? { type: 'employee' as const, userId: row.assigneeUserId ?? '', displayName: row.assigneeUserName ?? '' }
          : { type: 'agent' as const, agentMemberId: row.assigneeAgentMemberId ?? '', name: row.assigneeAgentName ?? '' },
        status: row.status,
        sessionId: row.sessionId,
        latestRunId: row.latestRunId,
        latestRunStatus: row.latestRunStatus,
        latestRunAt: row.latestRunAt?.toISOString() ?? null,
        schedule: row.schedule,
        scheduleState: row.scheduleState,
        scheduleReason: row.scheduleReason,
        nextRunAt: row.nextSlotUtc?.toISOString() ?? null,
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

/** 改派是否需要新的任务对话：承接者变化且不是“员工换员工”。 */
function needsNewConversation(
  task: { assigneeType: 'employee' | 'agent'; assigneeUserId: string | null; assigneeAgentMemberId: string | null },
  assignee: ProjectTaskAssigneeInput,
): boolean {
  const changed = assignee.type !== task.assigneeType
    || assignee.id !== (task.assigneeType === 'employee' ? task.assigneeUserId : task.assigneeAgentMemberId)
  return changed && !(task.assigneeType === 'employee' && assignee.type === 'employee')
}

const platformTimezone = resolvePlatformTimezone(process.env['DSH_WORK_TIMEZONE'])

/** S4：解析执行规则；未指定时默认每天 09:00。时区取平台默认时区，不接受客户端指定。 */
function parseSchedule(value: unknown): ProjectTaskSchedule {
  if (value === undefined || value === null) return { kind: 'daily', timezone: platformTimezone, timeOfDay: '09:00' }
  if (typeof value !== 'object' || Array.isArray(value)) throw requestInvalid('执行规则无效')
  const { kind, timeOfDay, weekdays } = value as { kind?: unknown; timeOfDay?: unknown; weekdays?: unknown }
  if (weekdays !== undefined && !Array.isArray(weekdays)) throw requestInvalid('执行星期必须是数组')
  try {
    return normalizeSchedule({ kind, timezone: platformTimezone, timeOfDay, weekdays } as ExecutionSchedule)
  } catch (error) {
    if (error instanceof RequestError) throw requestInvalid(error.message)
    throw error
  }
}

function sameSchedule(a: ProjectTaskSchedule | null, b: ProjectTaskSchedule | null): boolean {
  return JSON.stringify([a?.kind, a?.timeOfDay ?? null, a?.weekdays ?? null])
    === JSON.stringify([b?.kind, b?.timeOfDay ?? null, b?.weekdays ?? null])
}

/** 每个空间启用定时规则（非手动）的未完成 Agent 任务不超过上限。 */
async function assertScheduleQuota(
  transaction: DatabaseTransaction,
  workspaceId: string,
  schedule: ProjectTaskSchedule,
  excludeTaskId: string | null,
) {
  if (schedule.kind === 'manual') return
  const [row] = await transaction<{ count: number }[]>`
    select count(*)::integer as count from project_tasks
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and removed_at is null
       and assignee_type = 'agent' and status <> 'done' and schedule->>'kind' <> 'manual'
       and (${excludeTaskId}::text is null or id <> ${excludeTaskId})
  `
  if ((row?.count ?? 0) >= SCHEDULED_TASKS_PER_WORKSPACE) {
    throw workspaceStateConflict(`每个项目空间最多 ${SCHEDULED_TASKS_PER_WORKSPACE} 个定时执行的 Agent 任务，请先完成或改为手动`)
  }
}

/** 规则时区下的日历日期 YYYY-MM-DD（截止日期按当地日期比较）。 */
function localDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
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

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`)
  // PostgreSQL 没有公元 0 年。
  return !value.startsWith('0000') && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  // Date.parse 会接受 2026-02-30 这类越界日期，按 UTC 回读核对年月日，避免到 PostgreSQL 才报错。
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isCalendarDate(value)) {
    throw requestInvalid(`${field}必须是 YYYY-MM-DD 格式的日期`)
  }
  return value
}

const TASK_PAGE_DEFAULT = 50
const TASK_PAGE_MAX = 100

/** 任务列表分页：默认 50 条，最大 100 条。 */
function parseTaskPageLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return TASK_PAGE_DEFAULT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_PAGE_MAX) throw requestInvalid('limit 必须是 1 到 100 的整数')
  return limit
}

/** 按任务线程查找：对话页只需判断当前线程是不是任务，不能靠翻页（较早的任务不在第一页）。 */
function parseTaskSessionFilter(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 200) throw requestInvalid('sessionId 无效')
  return value
}

/** 游标按 (created_at, id) 倒序；id 用于同一时间戳内稳定推进。 */
function encodeTaskCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url')
}

function parseTaskCursor(value: unknown): { createdAt: string; id: string } | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw requestInvalid('cursor 无效')
  let decoded: string
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    throw requestInvalid('cursor 无效')
  }
  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) throw requestInvalid('cursor 无效')
  const createdAt = decoded.slice(0, separator)
  const id = decoded.slice(separator + 1)
  if (!id || Number.isNaN(Date.parse(createdAt))) throw requestInvalid('cursor 无效')
  return { createdAt, id }
}

/** 负责人显示名：员工取姓名，Agent 成员取 Agent 名称（改派事件用）。 */
async function assigneeName(transaction: DatabaseTransaction, type: 'employee' | 'agent', id: string | null): Promise<string> {
  if (!id) return ''
  const [row] = type === 'employee'
    ? await transaction<{ name: string }[]>`select display_name as name from users where tenant_id = ${tenantId} and id = ${id}`
    : await transaction<{ name: string }[]>`
        select a.name from workspace_agent_members wam
          join agents a on a.tenant_id = wam.tenant_id and a.id = wam.agent_id
         where wam.tenant_id = ${tenantId} and wam.id = ${id}`
  return row?.name ?? ''
}

function parseAssignee(value: unknown): ProjectTaskAssigneeInput {
  if (!value || typeof value !== 'object') throw requestInvalid('必须选择任务负责人')
  const { type, id } = value as { type?: unknown; id?: unknown }
  if ((type !== 'employee' && type !== 'agent') || typeof id !== 'string' || !id.trim()) {
    throw requestInvalid('任务负责人必须是本空间的一位员工或一个 Agent 成员')
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
