import { randomUUID } from 'node:crypto'

import type { ChatMessage, RunStep, TaskRun } from '../../../domain/types.ts'
import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import type { RunState } from '../../run/run-types.ts'
import { PostgresWorkspaceService } from './postgres-workspace-service.ts'
import { authorizationDenied } from '../../authorization/authorization-errors.ts'

const tenantId = 'tenant-dsh-work'

interface SessionRow {
  id: string
  workspaceId: string
  agentVersionId: string
  selectedSkillVersionId: string | null
  selectedSkillReference?: string | null
  title: string
  createdAt: Date
}

interface TaskRow {
  id: string
  sessionId: string
  status: RunState
  currentAttemptId: string | null
  createdAt: Date
  updatedAt: Date
  title: string
  workspaceId: string
  workspaceName: string
  agentVersion: string
  owner: string
  errorCode: string | null
  selectedSkillId: string | null
  selectedSkillName: string | null
  selectedSkillVersion: string | null
}

/** One Session summary row for the team history list (no message bodies). */
export interface WorkspaceSessionSummary {
  sessionId: string
  title: string
  creatorId: string
  creatorName: string
  lastActiveAt: string
  runCount: number
  latestRun: { id: string; status: RunState } | null
}

export interface WorkspaceSessionPage {
  items: WorkspaceSessionSummary[]
  nextCursor: string | null
}

interface MessageRow {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  runId: string | null
}

interface EventRow {
  id: string
  eventType: string
  displayMessage: string | null
  occurredAt: Date
}

interface ArtifactRow {
  id: string
  name: string
  artifactType: 'xlsx' | 'docx' | 'pdf' | 'markdown'
  version: number
  sizeBytes: string | number
  createdAt: Date
  workspaceId: string
}

interface SourceRow {
  id: string
  title: string
  version: string
  effectiveAt: Date
  dataScope: string
  excerpt: string
  synthetic: boolean
}

interface AttachmentRow {
  name: string
}

export class PostgresConversationRepository {
  private readonly database: DatabaseClient
  private readonly workspaces: PostgresWorkspaceService

  constructor(database: DatabaseClient, workspaces = new PostgresWorkspaceService(database)) {
    this.database = database
    this.workspaces = workspaces
  }

  async resolveWorkspaceId(workspaceId: string | null | undefined, userId: string) {
    return (await this.workspaces.resolveAccessibleWorkspace(workspaceId, userId)).id
  }

  async createSession(input: {
    userId: string
    title: string
    workspaceId?: string
    agentVersionId?: string
    selectedSkillVersionId?: string
  }) {
    const id = `session-${randomUUID()}`
    const agentVersionId = input.agentVersionId ?? 'agent-version-dsh-work-assistant-1'
    const workspaceId = await this.resolveWorkspaceId(input.workspaceId, input.userId)
    const [row] = await this.database<SessionRow[]>`
      insert into sessions (
        id, tenant_id, workspace_id, created_by, agent_version_id, selected_skill_version_id, title, status
      ) values (
        ${id}, ${tenantId}, ${workspaceId}, ${input.userId}, ${agentVersionId}, ${input.selectedSkillVersionId ?? null},
        ${truncateTitle(input.title)}, 'active'
      )
      returning id, workspace_id as "workspaceId", agent_version_id as "agentVersionId",
                selected_skill_version_id as "selectedSkillVersionId",
                title, created_at as "createdAt"
    `
    if (!row) throw new Error('Session 创建失败')
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      agentVersionId: row.agentVersionId,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async requireSession(sessionId: string, userId: string, audience: 'workbench' | 'admin' = 'workbench') {
    const [row] = await this.database<SessionRow[]>`
      select s.id, s.workspace_id as "workspaceId", s.agent_version_id as "agentVersionId",
             s.selected_skill_version_id as "selectedSkillVersionId",
             selected_skill.skill_id || '@' || selected_skill.version as "selectedSkillReference",
             s.title, s.created_at as "createdAt"
        from sessions s
        left join skill_versions selected_skill
          on selected_skill.tenant_id = s.tenant_id and selected_skill.id = s.selected_skill_version_id
       where s.tenant_id = ${tenantId} and s.id = ${sessionId} and s.created_by = ${userId}
         and s.status = 'active' and s.audience = ${audience}
    `
    if (!row) throw authorizationDenied(`Session 不存在或不可访问：${sessionId}`)
    return { ...row, createdAt: row.createdAt.toISOString() }
  }

  async archiveSession(sessionId: string, userId: string) {
    return this.database.begin(async (transaction) => {
      const [session] = await transaction<{ id: string; title: string; workspaceId: string }[]>`
        select id, title, workspace_id as "workspaceId" from sessions
         where tenant_id = ${tenantId} and id = ${sessionId} and created_by = ${userId}
           and status = 'active'
         for update
      `
      if (!session) throw authorizationDenied(`Session 不存在或不可访问：${sessionId}`)
      // 删除会话属执行轨（3-T1 决策）：归档是只读保留，删除会销毁要保留的历史内容，
      // 因此归档空间拒绝（活跃团队 + 当前成员，个人空间不受影响）。
      await this.requireWritableWorkspace(session.workspaceId)

      const [activeRun] = await transaction<{ id: string }[]>`
        select id from runs
         where tenant_id = ${tenantId} and session_id = ${sessionId}
           and status in ('queued', 'running', 'cancel_requested')
         limit 1
      `
      if (activeRun) throw new Error('对话当前状态不能删除：仍有运行正在执行，请先停止当前运行')

      await transaction`
        update sessions set status = 'archived', last_active_at = now()
         where tenant_id = ${tenantId} and id = ${sessionId}
      `
      return { sessionId: session.id, title: session.title, archived: true as const }
    })
  }

  async appendMessage(input: {
    sessionId: string
    runId: string
    role: 'user' | 'assistant'
    content: string
    messageId?: string
  }) {
    const id = input.messageId ?? `message-${randomUUID()}`
    await this.database`
      insert into messages (id, tenant_id, session_id, run_id, role, content)
      values (${id}, ${tenantId}, ${input.sessionId}, ${input.runId}, ${input.role}, ${input.content})
      on conflict (id) do nothing
    `
    await this.database`
      update sessions set last_active_at = now()
       where tenant_id = ${tenantId} and id = ${input.sessionId}
    `
    return id
  }

  async getRunPrompt(runId: string) {
    const [row] = await this.database<{ content: string }[]>`
      select content from messages
       where tenant_id = ${tenantId} and run_id = ${runId} and role = 'user'
       order by created_at asc limit 1
    `
    if (!row) throw new Error(`Run 没有关联的用户消息：${runId}`)
    return row.content
  }

  /**
   * Team Session pagination (1B-T1): one row per Session ordered by most recent
   * activity, with the latest Run pointer and Run count. Session identity is the
   * stable list key (方案 §6.2 新增团队历史会话入口使用稳定 Session 身份), and the
   * summary never carries message bodies.
   *
   * Keyset pagination on (last_active_at, id) instead of OFFSET so a parallel run
   * cannot shift a page. Workspace scoping plus the sessions_by_workspace index
   * keep the query bounded; the caller is authorized separately.
   */
  async listWorkspaceSessions(input: {
    workspaceId: string
    actorUserId: string
    query?: string
    cursor?: string
    limit?: number
  }): Promise<WorkspaceSessionPage> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const cursor = input.cursor ? decodeSessionCursor(input.cursor) : null
    const pattern = input.query?.trim()
      ? `%${input.query.trim().replaceAll(/[\\%_]/g, match => `\\${match}`)}%`
      : null

    const rows = await this.database<{
      sessionId: string
      title: string
      creatorId: string
      creatorName: string
      lastActiveAt: Date
      runCount: number
      latestRunId: string | null
      latestRunStatus: RunState | null
    }[]>`
      select s.id as "sessionId", s.title,
             s.created_by as "creatorId", u.display_name as "creatorName",
             s.last_active_at as "lastActiveAt",
             (select count(*)::integer from runs r
               where r.tenant_id = s.tenant_id and r.session_id = s.id) as "runCount",
             latest.id as "latestRunId", latest.status as "latestRunStatus"
        from sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.created_by
        left join lateral (
          select r.id, r.status
            from runs r
           where r.tenant_id = s.tenant_id and r.session_id = s.id
           order by r.created_at desc, r.id desc
           limit 1
        ) latest on true
       where s.tenant_id = ${tenantId}
         and s.workspace_id = ${input.workspaceId}
         and s.status = 'active' and s.audience = 'workbench'
         and s.created_by = ${input.actorUserId}
         and ${pattern === null ? this.database`true` : this.database`s.title ilike ${pattern} escape '\\'`}
         and ${cursor === null
           ? this.database`true`
           : this.database`(s.last_active_at, s.id) < (${cursor.lastActiveAt}::timestamptz, ${cursor.id})`}
       order by s.last_active_at desc, s.id desc
       limit ${limit + 1}
    `

    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(row => ({
      sessionId: row.sessionId,
      title: row.title,
      creatorId: row.creatorId,
      creatorName: row.creatorName,
      lastActiveAt: row.lastActiveAt.toISOString(),
      runCount: Number(row.runCount),
      latestRun: row.latestRunId ? { id: row.latestRunId, status: row.latestRunStatus as RunState } : null,
    }))
    const last = items[items.length - 1]
    return {
      items,
      nextCursor: hasMore && last ? encodeSessionCursor(last.lastActiveAt, last.sessionId) : null,
    }
  }

  /**
   * Execution-track guard for writes reached through a session row (3-T1): team
   * workspaces must still be active; personal workspaces keep the existing path.
   */
  private async requireWritableWorkspace(workspaceId: string) {
    const [workspace] = await this.database<{ type: 'personal' | 'team' }[]>`
      select workspace_type as type from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId} and status = 'active'
    `
    if (workspace) return
    // 空间不存在或已归档：区分成因只用于拒绝文案，不改变拒绝结果。
    const [anyStatus] = await this.database<{ type: 'personal' | 'team'; status: string }[]>`
      select workspace_type as type, status from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId}
    `
    if (anyStatus?.type === 'personal') return
    throw authorizationDenied('工作空间已归档，仅支持有权限的只读查看与下载')
  }

  async listTasks(userId: string): Promise<TaskRun[]> {
    const rows = await this.database<TaskRow[]>`
      select r.id, r.session_id as "sessionId", r.status,
             r.current_attempt_id as "currentAttemptId", r.created_at as "createdAt",
             r.updated_at as "updatedAt", s.title, s.workspace_id as "workspaceId",
             w.name as "workspaceName", av.version as "agentVersion", u.display_name as owner,
             ra.error_code as "errorCode", selected_skill.skill_id as "selectedSkillId",
             selected_skill.name as "selectedSkillName", selected_skill.version as "selectedSkillVersion"
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
        join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
        left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join skill_versions selected_skill
          on selected_skill.tenant_id = s.tenant_id and selected_skill.id = s.selected_skill_version_id
       where r.tenant_id = ${tenantId} and r.requested_by = ${userId}
         and s.status = 'active' and s.audience = 'workbench'
       order by r.created_at desc
       limit 50
    `
    return Promise.all(rows.map((row) => this.mapTask(row)))
  }

  async getTask(runId: string, userId: string): Promise<TaskRun | null> {
    const [row] = await this.database<TaskRow[]>`
      select r.id, r.session_id as "sessionId", r.status,
             r.current_attempt_id as "currentAttemptId", r.created_at as "createdAt",
             r.updated_at as "updatedAt", s.title, s.workspace_id as "workspaceId",
             w.name as "workspaceName", av.version as "agentVersion", u.display_name as owner,
             ra.error_code as "errorCode", selected_skill.skill_id as "selectedSkillId",
             selected_skill.name as "selectedSkillName", selected_skill.version as "selectedSkillVersion"
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
        join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
        left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join skill_versions selected_skill
          on selected_skill.tenant_id = s.tenant_id and selected_skill.id = s.selected_skill_version_id
       where r.tenant_id = ${tenantId} and r.id = ${runId} and r.requested_by = ${userId}
         and s.status = 'active' and s.audience = 'workbench'
    `
    return row ? this.mapTask(row) : null
  }

  private async mapTask(row: TaskRow): Promise<TaskRun> {
    const messages = await this.database<MessageRow[]>`
      select id, role, content, created_at as "createdAt", run_id as "runId"
        from messages
       where tenant_id = ${tenantId} and session_id = ${row.sessionId}
         and role in ('user', 'assistant')
       order by created_at asc
    `
    const events = row.currentAttemptId
      ? await this.database<EventRow[]>`
          select id, event_type as "eventType", display_message as "displayMessage",
                 occurred_at as "occurredAt"
            from run_events
           where tenant_id = ${tenantId} and attempt_id = ${row.currentAttemptId}
           order by sequence asc
        `
      : []
    const runMessages = messages.filter((message) => message.runId === row.id)
    const artifacts = await this.database<ArtifactRow[]>`
      select a.id, a.name, a.artifact_type as "artifactType", av.version_no as version,
             f.size_bytes as "sizeBytes", av.created_at as "createdAt", a.workspace_id as "workspaceId"
        from artifact_versions av
        join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
       where av.tenant_id = ${tenantId} and av.source_run_id = ${row.id}
       order by av.version_no desc
    `
    const sources = row.currentAttemptId
      ? await this.database<SourceRow[]>`
          select kd.id, kd.title, kd.version, kd.effective_date as "effectiveAt",
                 kd.data_scope as "dataScope", rks.excerpt, ks.synthetic
            from run_knowledge_sources rks
            join knowledge_documents kd on kd.tenant_id = rks.tenant_id and kd.id = rks.document_id
            join knowledge_sources ks on ks.tenant_id = kd.tenant_id and ks.id = kd.source_id
           where rks.tenant_id = ${tenantId} and rks.run_id = ${row.id}
             and rks.attempt_id = ${row.currentAttemptId}
           order by rks.relevance_score desc, kd.effective_date desc
        `
      : []
    const attachments = row.currentAttemptId
      ? await this.database<AttachmentRow[]>`
          select f.original_name as name from run_input_files rif
          join file_objects f on f.tenant_id = rif.tenant_id and f.id = rif.file_id
           where rif.tenant_id = ${tenantId} and rif.run_id = ${row.id}
             and rif.attempt_id = ${row.currentAttemptId}
           order by rif.created_at
        `
      : []
    const prompt = runMessages.find((message) => message.role === 'user')?.content ?? row.title
    return {
      id: row.id,
      attemptId: row.currentAttemptId,
      title: row.title,
      prompt,
      status: mapStatus(row.status),
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      sessionId: row.sessionId,
      agentVersion: `dsh-work-assistant@${row.agentVersion}`,
      createdAt: formatDateTime(row.createdAt),
      updatedAt: formatDateTime(row.updatedAt),
      owner: row.owner,
      messages: messages.map(mapMessage),
      steps: mapSteps(row.id, events, row.status),
      sources: sources.map(source => ({
        id: source.id,
        type: 'knowledge' as const,
        title: source.title,
        description: source.excerpt,
        version: source.version,
        effectiveAt: formatDate(source.effectiveAt),
        dataScope: source.dataScope,
        synthetic: source.synthetic,
        updatedAt: formatDate(source.effectiveAt),
      })),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        type: artifact.artifactType,
        version: artifact.version,
        size: formatSize(Number(artifact.sizeBytes)),
        createdAt: formatDateTime(artifact.createdAt),
        runId: row.id,
        workspaceId: artifact.workspaceId,
        summary: '由 DSH Runtime 本轮回答发布，保留来源 Run 与不可覆盖版本。',
      })),
      attachments: attachments.map(attachment => attachment.name),
      skill: row.selectedSkillId && row.selectedSkillName && row.selectedSkillVersion
        ? { id: row.selectedSkillId, name: row.selectedSkillName, version: row.selectedSkillVersion }
        : undefined,
      summary: row.status === 'succeeded' ? '本轮对话已由 DSH Runtime 执行完成。' : undefined,
      error: row.status === 'failed' ? toRunError(row.id, row.errorCode) : undefined,
    }
  }
}

export function toRunError(runId: string, errorCode: string | null | undefined): NonNullable<TaskRun['error']> {
  const code = errorCode ?? 'RUNTIME_EXECUTION_FAILED'
  const catalog: Record<string, Omit<NonNullable<TaskRun['error']>, 'code' | 'object'>> = {
    RUN_TIMEOUT: {
      message: '本轮执行超时',
      reason: '执行时间超过当前 Agent 与运行时配置中的较短时限。',
      suggestion: '减少问题范围或文件数量后重新执行；若持续超时，请联系管理员检查运行时容量。',
      retryable: true,
    },
    CONNECTOR_TIMEOUT: {
      message: '企业系统连接超时',
      reason: '连接器在规定时间内没有返回结果，本轮已安全停止。',
      suggestion: '稍后重新执行；若持续失败，请管理员在连接器页面执行健康检查。',
      retryable: true,
    },
    CONNECTOR_UNAVAILABLE: {
      message: '企业系统连接器不可用',
      reason: '本轮所需连接器离线、已停用或未通过健康检查。',
      suggestion: '请管理员恢复连接器后再重新执行，本轮不会绕过连接器直接访问企业系统。',
      retryable: true,
    },
    TOOL_PERMISSION_DENIED: {
      message: '工具权限请求被拒绝',
      reason: '当前角色、数据范围或审批策略不允许执行所请求的工具操作。',
      suggestion: '调整问题范围，或联系管理员核对 Agent、工具和工作空间授权。',
      retryable: false,
    },
    MODEL_INVOCATION_FAILED: {
      message: '模型调用失败',
      reason: '当前批准模型没有正常完成本轮生成。',
      suggestion: '稍后重新执行；若持续失败，请管理员检查模型服务商和密钥引用状态。',
      retryable: true,
    },
    TOOL_TIMEOUT: {
      message: '工具调用超时',
      reason: 'DSH Worker 调用当前工具时超过了允许时限，本轮已安全停止。',
      suggestion: '稍后重新执行；若持续失败，请管理员检查工具健康状态和超时配置。',
      retryable: true,
    },
    NETWORK_UNAVAILABLE: {
      message: '运行网络暂时不可用',
      reason: 'DSH Worker 与获准模型或服务之间的连接在本轮中断。',
      suggestion: '网络恢复后重新执行；若持续失败，请管理员检查模型出口和代理配置。',
      retryable: true,
    },
    RUNTIME_WORKER_CRASH: {
      message: 'DSH Worker 异常退出',
      reason: '负责当前 Attempt 的隔离 Worker 在完成前退出。',
      suggestion: '可重新执行创建新的 Attempt；若再次发生，请管理员根据运行编号检查 Runtime 日志。',
      retryable: true,
    },
    SERVICE_SHUTDOWN: {
      message: '服务停止导致执行中断',
      reason: 'dsh-work 或 Runtime 在当前 Attempt 执行期间停止。',
      suggestion: '服务恢复后重新执行，本轮不会被误标为员工主动取消。',
      retryable: true,
    },
    SERVICE_RESTARTED: {
      message: '服务重启后执行已安全终止',
      reason: '服务启动时发现上一个进程遗留的运行中 Attempt，无法安全续接原 Worker。',
      suggestion: '重新执行以创建新的 Attempt；原 Attempt 和审计记录会继续保留。',
      retryable: true,
    },
    RUNTIME_EXECUTION_FAILED: {
      message: '本轮执行失败',
      reason: 'DSH 运行时未能正常完成当前执行尝试。',
      suggestion: '可重新执行创建新的 Attempt；若再次失败，请在对话详情中复制运行编号交给管理员排查。',
      retryable: true,
    },
  }
  const detail = catalog[code] ?? {
    message: '本轮执行失败',
    reason: `运行时返回错误码 ${code}。`,
    suggestion: '可重新执行；若再次失败，请将运行编号和错误码交给管理员排查。',
    retryable: true,
  }
  return { code, object: `运行 ${runId}`, ...detail }
}

function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
  }
}

function mapSteps(runId: string, events: EventRow[], status: RunState): RunStep[] {
  if (events.length === 0) {
    return [{ id: `${runId}-queued`, title: '等待执行调度', detail: '任务已进入执行队列。', status: 'pending' }]
  }
  return events
    .filter((event) => !['assistant.delta', 'assistant.completed'].includes(event.eventType))
    .map((event, index, visibleEvents) => ({
      id: event.id,
      title: eventTitle(event.eventType),
      detail: event.displayMessage ?? '执行状态已更新。',
      status: eventStepStatus(event.eventType, status, index === visibleEvents.length - 1),
    }))
}

function eventTitle(eventType: string) {
  const titles: Record<string, string> = {
    'run.queued': '进入执行队列',
    'run.started': '执行服务开始运行',
    'approval.required': '等待权限确认',
    'approval.resolved': '权限确认完成',
    'run.cancel_requested': '正在取消',
    'run.cancelled': '执行已取消',
    'run.failed': '执行失败',
    'run.completed': '执行完成',
  }
  return titles[eventType] ?? '运行事件'
}

function eventStepStatus(eventType: string, status: RunState, isLast: boolean): RunStep['status'] {
  if (eventType === 'approval.required') return 'awaiting_approval'
  if (eventType === 'run.failed' || eventType === 'run.cancelled') return 'failed'
  if (eventType === 'run.completed') return 'succeeded'
  if (isLast && ['queued', 'running', 'cancel_requested'].includes(status)) return 'running'
  return 'succeeded'
}

function mapStatus(status: RunState): TaskRun['status'] {
  if (status === 'cancel_requested') return 'running'
  return status
}

function truncateTitle(value: string) {
  const title = value.trim()
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value)
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10)
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Cursor for the (last_active_at, id) keyset; base64url keeps it URL-safe. */
function encodeSessionCursor(lastActiveAt: string, id: string) {
  return Buffer.from(JSON.stringify({ at: lastActiveAt, id })).toString('base64url')
}

function decodeSessionCursor(cursor: string): { lastActiveAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown }
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('shape')
    return { lastActiveAt: parsed.at, id: parsed.id }
  } catch {
    throw new Error('无效的分页游标')
  }
}
