/**
 * 项目空间 S6：Agent 查看与维护项目任务的平台工具处理器。
 *
 * 每次调用按发起人（Manifest.user_context.user_id）复核权限，经既有项目任务服务写入；
 * 归因写入 created_via / 事件 metadata.via（经某 Agent）。不另建任务逻辑。
 */
import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { authorizationDenied, requestInvalid } from '../../../domain/authorization-errors.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { resolvePlatformTimezone } from '../../../domain/execution-time.ts'
import { PlatformToolError, toolPreconditionFailed } from '../../runtime/platform-tool-contract.ts'
import type { PostgresProjectService, ProjectTask, ProjectTaskAssigneeInput, ProjectTaskVia } from './postgres-project-service.ts'

const tenantId = 'tenant-dsh-work'
/** 列表按页读取任务再筛选；最多扫描这么多条，超过时如实告知结果不完整。 */
const LIST_PAGE_SIZE = 100
const LIST_SCAN_MAX = 1000

export class ProjectTaskTools {
  private readonly projects: PostgresProjectService
  private readonly database: DatabaseClient

  constructor(projects: PostgresProjectService, database: DatabaseClient) {
    this.projects = projects
    this.database = database
  }

  async list(input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) {
    this.assertAlive(signal)
    const { workspaceId, actorUserId } = this.requireEmployeeContext(manifest)
    const limit = Math.min(50, Math.max(1, typeof input['limit'] === 'number' ? input['limit'] : 20))
    const status = typeof input['status'] === 'string' ? input['status'] : 'open'
    const assigneeId = typeof input['assigneeId'] === 'string' ? input['assigneeId'] : null
    const query = typeof input['query'] === 'string' ? input['query'].trim().toLowerCase() : null
    const matches = (task: ProjectTask) => {
      if (status === 'open' ? task.status === 'done' : status !== 'all' && task.status !== status) return false
      if (assigneeId && !((task.assignee.type === 'employee' && task.assignee.userId === assigneeId)
        || (task.assignee.type === 'agent' && task.assignee.agentMemberId === assigneeId))) return false
      return !query || task.title.toLowerCase().includes(query)
    }
    // 筛选条件不在服务端分页里：按页读完全部任务（有上限）再筛选，较早的匹配任务不会被漏掉。
    const matched: ProjectTask[] = []
    let cursor: string | null = null
    let scanned = 0
    do {
      this.assertAlive(signal)
      const page = await this.projects.listTasks(workspaceId, actorUserId, { limit: LIST_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
      scanned += page.items.length
      matched.push(...page.items.filter(matches))
      cursor = page.nextCursor
    } while (cursor && scanned < LIST_SCAN_MAX)
    const members = await this.listAssignableMembers(workspaceId)
    return {
      tasks: matched.slice(0, limit).map(summarizeTask),
      members,
      /** 符合条件的任务数；truncated 为 true 时只统计了最近 LIST_SCAN_MAX 条任务。 */
      total: matched.length,
      truncated: Boolean(cursor),
    }
  }

  async get(input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) {
    this.assertAlive(signal)
    const { workspaceId, actorUserId } = this.requireEmployeeContext(manifest)
    const taskId = requireString(input['taskId'], 'taskId')
    const task = await this.projects.getTask(workspaceId, taskId, actorUserId)
    return { task: summarizeTaskDetail(task) }
  }

  async create(input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) {
    this.assertAlive(signal)
    const { workspaceId, actorUserId } = this.requireEmployeeContext(manifest)
    const via = await this.requireVia(manifest)
    assertDueDateNotPast(input['dueDate'], manifest)
    // D34（Agent 任务固定手动、不立即执行）由任务服务按 via 执行，这里不另设规则。
    const task = await this.projects.createTask(workspaceId, actorUserId, {
      title: input['title'],
      description: input['description'],
      assignee: parseToolAssignee(input['assignee']),
      dueDate: input['dueDate'],
    }, undefined, via)
    return { task: summarizeTask(task) }
  }

  async update(input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) {
    this.assertAlive(signal)
    const { workspaceId, actorUserId } = this.requireEmployeeContext(manifest)
    const via = await this.requireVia(manifest)
    const taskId = requireString(input['taskId'], 'taskId')
    const fields = {
      ...(input['title'] !== undefined ? { title: input['title'] } : {}),
      ...(input['description'] !== undefined ? { description: input['description'] } : {}),
      ...(input['assignee'] !== undefined ? { assignee: parseToolAssignee(input['assignee']) } : {}),
      ...(input['dueDate'] !== undefined ? { dueDate: input['dueDate'] } : {}),
    }
    const hasFieldChange = Object.keys(fields).length > 0
    const hasStatusChange = input['status'] !== undefined
    if (!hasFieldChange && !hasStatusChange) throw toolPreconditionFailed('project_task_update 至少需要一项变更')
    assertDueDateNotPast(input['dueDate'], manifest)
    if (input['completionNote'] !== undefined && input['status'] !== 'done') {
      throw toolPreconditionFailed('completionNote 只能在标记完成（status 为 done）时提供')
    }
    // D34（改派给 Agent 时固定手动规则）由任务服务按 via 执行。
    let task = hasFieldChange ? await this.projects.updateTask(workspaceId, taskId, actorUserId, fields, undefined, via) : null
    if (hasStatusChange) {
      try {
        task = await this.projects.setTaskStatus(workspaceId, taskId, actorUserId, {
          status: input['status'],
          completionNote: input['completionNote'],
        }, via)
      } catch (error) {
        if (!task) throw error
        // 字段修改与状态推进是两次写入：前一次已生效时不能报告“未执行”。
        const reason = error instanceof Error ? error.message : '状态更新失败'
        throw new PlatformToolError({
          status: typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500,
          code: 'TOOL_PARTIALLY_APPLIED',
          message: `任务的${Object.keys(fields).map(fieldLabel).join('、')}已修改，但状态未更新：${reason}。请先用 project_task_get 确认当前任务。`,
          effectState: 'unknown',
        })
      }
    }
    return { task: summarizeTask(task!) }
  }

  private requireEmployeeContext(manifest: RuntimeManifest) {
    if (manifest.purpose) {
      throw toolPreconditionFailed('项目任务工具不能用于系统或管理运行')
    }
    const workspaceId = manifest.workspace_id?.trim()
    const actorUserId = manifest.user_context.user_id?.trim()
    if (!workspaceId || !actorUserId) {
      throw toolPreconditionFailed('项目任务工具需要团队空间中的员工发起运行')
    }
    return { workspaceId, actorUserId }
  }

  /**
   * 执行本次运行的 Agent 成员：按运行版本所属的 Agent 找本空间的成员（成员按 Agent 唯一）。
   * 运行中负责人升级了该成员的版本不影响写入；成员被停用或移出则拒绝。
   */
  private async requireVia(manifest: RuntimeManifest): Promise<ProjectTaskVia> {
    const workspaceId = manifest.workspace_id?.trim()
    const agentVersionId = manifest.agent_version_id?.trim()
    if (!workspaceId || !agentVersionId) {
      throw toolPreconditionFailed('缺少项目空间或 Agent 版本，无法归因项目任务写入')
    }
    const [row] = await this.database<{ id: string; name: string }[]>`
      select wam.id, a.name
        from agent_versions av
        join workspace_agent_members wam on wam.tenant_id = av.tenant_id and wam.agent_id = av.agent_id
        join agents a on a.tenant_id = wam.tenant_id and a.id = wam.agent_id
       where av.tenant_id = ${tenantId} and av.id = ${agentVersionId}
         and wam.workspace_id = ${workspaceId}
         and wam.status = 'available'
       limit 1
    `
    if (!row) throw authorizationDenied('当前 Agent 成员不可用，无法维护项目任务')
    return { agentMemberId: row.id, agentName: row.name, runId: manifest.run_id }
  }

  private async listAssignableMembers(workspaceId: string) {
    const employees = await this.database<{ id: string; name: string }[]>`
      select u.id, u.display_name as name
        from workspace_members wm
        join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id
       where wm.tenant_id = ${tenantId} and wm.workspace_id = ${workspaceId}
         and wm.member_role in ('owner', 'admin', 'member')
       order by u.display_name, u.id
    `
    const agents = await this.database<{ id: string; name: string }[]>`
      select wam.id, a.name
        from workspace_agent_members wam
        join agents a on a.tenant_id = wam.tenant_id and a.id = wam.agent_id
       where wam.tenant_id = ${tenantId} and wam.workspace_id = ${workspaceId}
         and wam.status = 'available'
       order by a.name, wam.id
    `
    return [
      ...employees.map(row => ({ type: 'employee' as const, id: row.id, name: row.name })),
      ...agents.map(row => ({ type: 'agent' as const, id: row.id, name: row.name })),
    ]
  }

  private assertAlive(signal: AbortSignal) {
    if (signal.aborted) throw new PlatformToolError({ status: 409, code: 'TOOL_CANCELLED', message: '工具调用已取消' })
  }
}

function summarizeTask(task: ProjectTask) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    dueDate: task.dueDate,
    assignee: task.assignee.type === 'employee'
      ? { type: 'employee', id: task.assignee.userId, name: task.assignee.displayName }
      : { type: 'agent', id: task.assignee.agentMemberId, name: task.assignee.name },
    latestRun: task.latestRunId
      ? { id: task.latestRunId, status: task.latestRunStatus, at: task.latestRunAt }
      : null,
  }
}

function summarizeTaskDetail(task: ProjectTask) {
  return {
    ...summarizeTask(task),
    description: task.description,
    schedule: task.schedule,
    scheduleState: task.scheduleState,
    nextRunAt: task.nextRunAt,
    completionNote: task.completionNote,
  }
}

/**
 * Agent 写入的截止日期不能早于今天（按本次运行的时区，即模型看到的“当前时间”所用时区）。
 * “本周五”这类相对日期在周末会落到已过去的日期；拒绝后 Agent 改用正确日期或先向成员确认。
 * 人在界面上填写截止日期不受此限制。
 */
function assertDueDateNotPast(value: unknown, manifest: RuntimeManifest, now: Date = new Date()) {
  if (typeof value !== 'string' || !value) return
  const timezone = manifest.timezone?.trim() || resolvePlatformTimezone(process.env['DSH_WORK_TIMEZONE'])
  const today = localDate(now, timezone)
  if (value < today) {
    throw new PlatformToolError({
      status: 422,
      code: 'DUE_DATE_IN_PAST',
      message: `截止日期 ${value} 早于今天（${today}，${timezone}）。请改用不早于今天的日期，或先向成员确认要哪一天。`,
      effectState: 'not_started',
    })
  }
}

function localDate(instant: Date, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).map(part => [part.type, part.value]))
  return `${parts['year']}-${parts['month']}-${parts['day']}`
}

function fieldLabel(key: string): string {
  return ({ title: '标题', description: '说明', assignee: '负责人', dueDate: '截止日期' } as Record<string, string>)[key] ?? key
}

function parseToolAssignee(value: unknown): ProjectTaskAssigneeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestInvalid('assignee 无效')
  const record = value as { type?: unknown; id?: unknown }
  if ((record.type !== 'employee' && record.type !== 'agent') || typeof record.id !== 'string' || !record.id.trim()) {
    throw requestInvalid('assignee 必须包含 type 与 id')
  }
  return { type: record.type, id: record.id.trim() }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw requestInvalid(`${field} 不能为空`)
  return value.trim()
}

/**
 * 将业务错误转为平台工具错误；供 Adapter 包装时使用。
 * 任务服务的拒绝（无权限、状态冲突、参数无效、对象不存在）都在写入事务提交前发生，任务没有变化，
 * 报告为未执行；其他错误交给桥接层按工具效果分类（写入为结果未知）。
 */
export function mapProjectTaskToolError(error: unknown): never {
  if (error instanceof PlatformToolError) throw error
  const typed = error as { status?: unknown; code?: unknown; message?: unknown }
  if (error instanceof Error && typeof typed.status === 'number' && typed.status >= 400 && typed.status < 500
    && typeof typed.code === 'string') {
    throw new PlatformToolError({
      status: typed.status,
      code: typed.code,
      message: error.message,
      effectState: 'not_started',
    })
  }
  throw error
}
