import { randomUUID } from 'node:crypto'

import type { ChatMessage, RunStep, TaskRun } from '../../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { RunState } from '../../run/run-types.ts'
import { PostgresWorkspaceService, readableWorkspacePredicate } from './postgres-workspace-service.ts'
import { authorizationDenied, requestInvalid } from '../../authorization/authorization-errors.ts'

const tenantId = 'tenant-dsh-work'
const conversationHistoryMessageLimit = 12
const conversationHistoryCharacterLimit = 24_000

interface SessionRow {
  id: string
  workspaceId: string
  workspaceType: 'personal' | 'team'
  workspaceStatus: 'active' | 'archived'
  /** TW-10：团队讨论会话可为 null（首次 @Agent 前不绑定 Agent）。 */
  agentVersionId: string | null
  createdBy: string
  selectedSkillVersionId: string | null
  selectedSkillReference?: string | null
  title: string
  createdAt: Date
}

type WorkbenchSession = Omit<SessionRow, 'createdAt'> & { createdAt: string }
interface AdminSession {
  id: string
  title: string
  createdAt: string
  workspaceId: null
  agentVersionId: null
  selectedSkillVersionId: null
  selectedSkillReference: null
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
  workspaceType: 'personal' | 'team'
  workspaceStatus: 'active' | 'archived'
  /** TW-10：取当前 Attempt Manifest 记录的 Agent 版本（团队会话逐消息绑定）。 */
  agentVersion: string | null
  agentName: string | null
  owner: string
  requestedBy: string
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

export interface UserSessionSummary extends WorkspaceSessionSummary {
  workspaceId: string
  workspaceName: string
  workspaceType: 'personal' | 'team'
  workspaceStatus: 'active' | 'archived'
  canContinue: boolean
  canRemove: boolean
}

export interface UserSessionQuery {
  actorUserId: string
  scope?: 'personal' | 'team' | 'all'
  query?: string
  cursor?: string
  limit?: number
}

interface MessageRow {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  runId: string | null
  /** TW-10 共享讨论：用户消息的作者（历史消息回退为会话创建者）。 */
  senderId: string | null
  senderName: string | null
  /** 该消息所属 Run 的发起人与执行 Agent（@ 触发归因，assistant 消息用）。 */
  runRequesterId: string | null
  runRequesterName: string | null
  agentName: string | null
}

export interface ConversationHistoryMessage {
  role: 'user' | 'assistant'
  content: string
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
  artifactType: 'xlsx' | 'docx' | 'pdf' | 'markdown' | 'csv' | 'text' | 'html'
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
    /** TW-10：显式传 null 表示团队讨论会话不绑定 Agent；省略沿用默认助手。 */
    agentVersionId?: string | null
    selectedSkillVersionId?: string
  }, tx?: DatabaseTransaction) {
    const id = `session-${randomUUID()}`
    const agentVersionId = input.agentVersionId === null
      ? null
      : input.agentVersionId ?? 'agent-version-dsh-work-assistant-1'
    const workspaceId = await this.resolveWorkspaceId(input.workspaceId, input.userId)
    const db = tx ?? this.database
    const [row] = await db<SessionRow[]>`
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

  /**
   * Load a session without the creator gate (TW-10). Team sessions are shared:
   * any current member may read them, so callers perform the membership/role
   * check themselves (see RunOrchestrationService.requireSessionAccess).
   * Creator-scoped paths keep using {@link requireSession}.
   */
  async findSessionRow(sessionId: string, audience: 'workbench' | 'admin' = 'workbench') {
    const [row] = await this.database<SessionRow[]>`
      select s.id, s.workspace_id as "workspaceId", s.agent_version_id as "agentVersionId",
             w.workspace_type as "workspaceType", w.status as "workspaceStatus",
             s.created_by as "createdBy",
             s.selected_skill_version_id as "selectedSkillVersionId",
             selected_skill.skill_id || '@' || selected_skill.version as "selectedSkillReference",
             s.title, s.created_at as "createdAt"
        from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join skill_versions selected_skill
          on selected_skill.tenant_id = s.tenant_id and selected_skill.id = s.selected_skill_version_id
       where s.tenant_id = ${tenantId} and s.id = ${sessionId}
         and s.status = 'active' and s.audience = ${audience}
    `
    return row ? { ...row, createdAt: row.createdAt.toISOString() } : null
  }

  async requireSession(sessionId: string, userId: string, audience?: 'workbench'): Promise<WorkbenchSession>
  async requireSession(sessionId: string, userId: string, audience: 'admin'): Promise<AdminSession>
  async requireSession(sessionId: string, userId: string, audience: 'workbench' | 'admin'): Promise<WorkbenchSession | AdminSession>
  async requireSession(sessionId: string, userId: string, audience: 'workbench' | 'admin' = 'workbench') {
    // Admin conversations are owned by one administrator and deliberately have
    // no Workspace/Agent binding. Do not run the workbench (TW-10) space query.
    // The caller still checks the operation's current admin role before execution.
    if (audience === 'admin') return this.requireAdminSession(sessionId, userId)

    const [row] = await this.database<SessionRow[]>`
      select s.id, s.workspace_id as "workspaceId", s.agent_version_id as "agentVersionId",
             w.workspace_type as "workspaceType", w.status as "workspaceStatus",
             s.created_by as "createdBy",
             s.selected_skill_version_id as "selectedSkillVersionId",
             selected_skill.skill_id || '@' || selected_skill.version as "selectedSkillReference",
             s.title, s.created_at as "createdAt"
        from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join skill_versions selected_skill
          on selected_skill.tenant_id = s.tenant_id and selected_skill.id = s.selected_skill_version_id
       where s.tenant_id = ${tenantId} and s.id = ${sessionId} and s.created_by = ${userId}
         and s.status = 'active' and s.audience = ${audience}
    `
    if (!row) throw authorizationDenied(`Session 不存在或不可访问：${sessionId}`)
    return { ...row, createdAt: row.createdAt.toISOString() }
  }

  private async requireAdminSession(sessionId: string, userId: string): Promise<AdminSession> {
    const [row] = await this.database<{ id: string; title: string; createdAt: Date }[]>`
      select s.id, s.title, s.created_at as "createdAt"
        from sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.created_by and u.status = 'active'
        join tenants t on t.id = s.tenant_id and t.status = 'active'
       where s.tenant_id = ${tenantId} and s.id = ${sessionId}
         and s.created_by = ${userId} and s.audience = 'admin' and s.status = 'active'
         and s.workspace_id is null and s.agent_version_id is null
    `
    if (!row) throw authorizationDenied(`Session 不存在或不可访问：${sessionId}`)
    return { ...row, createdAt: row.createdAt.toISOString(), workspaceId: null,
      agentVersionId: null, selectedSkillVersionId: null, selectedSkillReference: null }
  }

  async archiveSession(sessionId: string, userId: string) {
    return this.database.begin(async (transaction) => {
      // Same lock order as Run creation: Workspace -> Session -> Run. A member
      // removal/archive cannot cross this operation after a stale UI check.
      const [workspace] = await transaction<{ id: string; status: string }[]>`
        select w.id, w.status from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
         where s.tenant_id = ${tenantId} and s.id = ${sessionId}
           and s.created_by = ${userId} and s.audience = 'workbench'
         for update of w
      `
      if (!workspace) throw authorizationDenied('Session 不存在或不可访问')
      await this.requireWritableWorkspace(workspace.id, userId, transaction)
      const [session] = await transaction<{ id: string; title: string; workspaceId: string; status: string }[]>`
        select id, title, workspace_id as "workspaceId", status from sessions
         where tenant_id = ${tenantId} and id = ${sessionId} and created_by = ${userId}
           and audience = 'workbench' and status in ('active', 'archived')
         for update
      `
      if (!session) throw authorizationDenied(`Session 不存在或不可访问：${sessionId}`)
      // 移除会话改变历史入口可见性，属写入：归档团队空间保持只读。
      // 这里不会删除消息、Run 或文件；个人内容按独立保留策略管理。
      if (session.status === 'archived') return { sessionId: session.id, title: session.title,
        archived: true as const, removedFromHistory: true as const, physicalDeletion: false as const }

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
      return { sessionId: session.id, title: session.title, archived: true as const, removedFromHistory: true as const, physicalDeletion: false as const }
    })
  }

  async appendMessage(input: {
    sessionId: string
    /** 讨论消息为 null；@ 触发消息与 Agent 回复关联到 Run。 */
    runId?: string | null
    role: 'user' | 'assistant'
    content: string
    /** 用户消息作者；Agent 回复为空（归因经 runId → Run 关联）。 */
    senderUserId?: string | null
    messageId?: string
  }) {
    const id = input.messageId ?? `message-${randomUUID()}`
    await this.database`
      insert into messages (id, tenant_id, session_id, run_id, role, content, sender_user_id)
      values (${id}, ${tenantId}, ${input.sessionId}, ${input.runId ?? null}, ${input.role}, ${input.content},
              ${input.senderUserId ?? null})
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
   * Assistant messages committed by earlier Attempts of the same Run — e.g. a
   * partial answer preserved when the Attempt timed out. Unlike
   * getConversationHistory this intentionally returns the Run's own messages
   * so a retry can continue from the confirmed partial output as ordinary
   * conversation context (not a checkpoint resume of the old Attempt).
   */
  async getRunAssistantOutputs(runId: string): Promise<ConversationHistoryMessage[]> {
    return this.database<ConversationHistoryMessage[]>`
      select role, content from messages
       where tenant_id = ${tenantId} and run_id = ${runId} and role = 'assistant'
       order by created_at asc, id asc
    `
  }

  /**
   * Returns the causal product-Session context that existed before a Run was
   * created. The current Run is excluded so its prompt remains the single
   * authoritative `input.message`, and a retry receives the same preceding
   * conversation instead of later messages from the Session.
   */
  async getConversationHistory(sessionId: string, beforeRunId: string): Promise<ConversationHistoryMessage[]> {
    // TW-10：团队会话的讨论消息（run_id 为空）同样进入上下文窗口——@ 触发时
    // Agent 需要看到讨论语境；为区分多位发言人，团队空间里的 user 消息统一加
    // 「发送者：」前缀（个人会话发送者唯一，不加前缀以保持既有契约不变）。
    const recent = await this.database<(ConversationHistoryMessage & { senderName: string | null; team: boolean })[]>`
      select m.role, m.content, su.display_name as "senderName",
             (w.workspace_type = 'team') as team
        from messages m
        join runs current_run
          on current_run.tenant_id = m.tenant_id and current_run.id = ${beforeRunId}
        join sessions s on s.tenant_id = m.tenant_id and s.id = m.session_id
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join runs mr on mr.tenant_id = m.tenant_id and mr.id = m.run_id
        left join users su
          on su.tenant_id = m.tenant_id
         and su.id = coalesce(m.sender_user_id, mr.requested_by, s.created_by)
       where m.tenant_id = ${tenantId}
         and m.session_id = ${sessionId}
         and current_run.session_id = ${sessionId}
         and m.run_id is distinct from current_run.id
         and m.created_at < current_run.created_at
         and m.role in ('user', 'assistant')
       order by m.created_at desc, m.id desc
       limit ${conversationHistoryMessageLimit}
    `
    let remaining = conversationHistoryCharacterLimit
    return recent.map(message => {
      const prefix = message.team && message.role === 'user' && message.senderName
        ? `${message.senderName}：`
        : ''
      const contentBudget = remaining - prefix.length
      const content = contentBudget > 0
        ? `${prefix}${message.content.slice(-contentBudget)}`
        : ''
      remaining -= content.length
      return { role: message.role, content }
    }).filter(message => message.content).reverse()
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

  /** One owner-scoped query for the global history and stable Session detail.
   * Existing team/shared-session APIs remain separate consumers in this same
   * repository: global "my history" never widens to other members' Sessions. */
  async listSessionsForUser(input: UserSessionQuery): Promise<{ items: UserSessionSummary[]; nextCursor: string | null }> {
    return this.queryUserSessions(input)
  }

  async getSessionForUser(sessionId: string, actorUserId: string): Promise<UserSessionSummary> {
    const page = await this.queryUserSessions({ actorUserId, scope: 'all', limit: 1 }, sessionId)
    const row = page.items[0]
    if (!row) throw authorizationDenied('Session 不存在或不可访问')
    return row
  }

  private async queryUserSessions(input: UserSessionQuery, sessionId?: string) {
    const scope = input.scope ?? 'personal'
    if (!['personal', 'team', 'all'].includes(scope)) throw requestInvalid('scope 必须为 personal、team 或 all')
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw requestInvalid('limit 必须为 1 到 100 之间的整数')
    if ((input.query?.length ?? 0) > 200) throw requestInvalid('搜索关键词不能超过 200 个字符')
    const cursor = input.cursor ? decodeSessionCursor(input.cursor) : null
    const pattern = input.query?.trim() ? `%${input.query.trim().replaceAll(/[\\%_]/g, value => `\\${value}`)}%` : null
    const rows = await this.database<Array<Omit<UserSessionSummary, 'lastActiveAt' | 'latestRun'> & {
      lastActiveAt: Date; cursorTimestamp: string; latestRunId: string | null; latestRunStatus: RunState | null
    }>>`
      select s.id as "sessionId", s.title, s.created_by as "creatorId", u.display_name as "creatorName",
             s.last_active_at as "lastActiveAt",
             to_char(s.last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorTimestamp", w.id as "workspaceId", w.name as "workspaceName",
             w.workspace_type as "workspaceType", w.status as "workspaceStatus",
             (select count(*)::integer from runs r where r.tenant_id = s.tenant_id and r.session_id = s.id) as "runCount",
             latest.id as "latestRunId", latest.status as "latestRunStatus",
             (w.status = 'active' and (w.workspace_type = 'personal' or exists (
                select 1 from workspace_members m where m.tenant_id = w.tenant_id and m.workspace_id = w.id
                  and m.user_id = ${input.actorUserId} and m.member_role <> 'viewer'))) as "canContinue",
             (w.status = 'active' and not exists (select 1 from runs live where live.tenant_id = s.tenant_id
               and live.session_id = s.id and live.status in ('queued', 'running', 'cancel_requested'))) as "canRemove"
        from sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.created_by
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join lateral (select r.id, r.status from runs r where r.tenant_id = s.tenant_id and r.session_id = s.id
          order by r.created_at desc, r.id desc limit 1) latest on true
       where s.tenant_id = ${tenantId} and s.audience = 'workbench' and s.status = 'active'
         and s.created_by = ${input.actorUserId}
         and (${readableWorkspacePredicate(this.database, input.actorUserId)})
         and ${scope === 'all' ? this.database`true` : this.database`w.workspace_type = ${scope}`}
         and ${sessionId ? this.database`s.id = ${sessionId}` : this.database`true`}
         and ${pattern === null ? this.database`true` : this.database`s.title ilike ${pattern} escape '\\'`}
         and ${cursor === null ? this.database`true` : this.database`(s.last_active_at, s.id) < (${cursor.lastActiveAt}::text::timestamptz, ${cursor.id})`}
       order by s.last_active_at desc, s.id desc limit ${limit + 1}
    `
    const items: UserSessionSummary[] = rows.slice(0, limit).map(row => ({
      sessionId: row.sessionId, title: row.title, creatorId: row.creatorId, creatorName: row.creatorName,
      workspaceId: row.workspaceId, workspaceName: row.workspaceName, workspaceType: row.workspaceType,
      workspaceStatus: row.workspaceStatus, canContinue: row.canContinue, canRemove: row.canRemove,
      lastActiveAt: row.lastActiveAt.toISOString(), runCount: Number(row.runCount),
      latestRun: row.latestRunId ? { id: row.latestRunId, status: row.latestRunStatus! } : null,
    }))
    const last = items.at(-1)
    return { items, nextCursor: rows.length > limit && last ? encodeSessionCursor(rows[items.length - 1]!.cursorTimestamp, last.sessionId) : null }
  }

  /**
   * Execution-track guard for writes reached through a session row (3-T1): team
   * workspaces must still be active; personal workspaces keep the existing path.
   */
  private async requireWritableWorkspace(workspaceId: string, userId: string, sql: DatabaseTransaction) {
    // Keep all checks on the transaction connection. Borrowing the pool here
    // deadlocks a one-connection pool (or a saturated concurrent deletion burst).
    const [workspace] = await sql`
      select w.id from workspaces w
       where w.tenant_id = ${tenantId} and w.id = ${workspaceId} and w.status = 'active'
         and (${readableWorkspacePredicate(sql, userId)})
    `
    if (!workspace) throw authorizationDenied('工作空间不存在、已归档或当前用户无权访问')
  }

  async listTasks(userId: string): Promise<TaskRun[]> {
    const rows = await this.database<TaskRow[]>`
      select r.id, r.session_id as "sessionId", r.status,
             r.current_attempt_id as "currentAttemptId", r.created_at as "createdAt",
             r.updated_at as "updatedAt", s.title, s.workspace_id as "workspaceId",
             w.name as "workspaceName", w.workspace_type as "workspaceType",
             w.status as "workspaceStatus",
             av.version as "agentVersion", ag.name as "agentName",
             u.display_name as owner, r.requested_by as "requestedBy",
             ra.error_code as "errorCode", selected_skill.skill_id as "selectedSkillId",
             selected_skill.name as "selectedSkillName", selected_skill.version as "selectedSkillVersion"
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
        left join agent_versions av on av.tenant_id = s.tenant_id
          and av.id = coalesce(ra.manifest ->> 'agent_version_id', s.agent_version_id)
        left join agents ag on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
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
             w.name as "workspaceName", w.workspace_type as "workspaceType",
             w.status as "workspaceStatus",
             av.version as "agentVersion", ag.name as "agentName",
             u.display_name as owner, r.requested_by as "requestedBy",
             ra.error_code as "errorCode", selected_skill.skill_id as "selectedSkillId",
             selected_skill.name as "selectedSkillName", selected_skill.version as "selectedSkillVersion"
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
        left join agent_versions av on av.tenant_id = s.tenant_id
          and av.id = coalesce(ra.manifest ->> 'agent_version_id', s.agent_version_id)
        left join agents ag on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
        left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join skill_versions selected_skill
          on selected_skill.tenant_id = s.tenant_id and selected_skill.id = s.selected_skill_version_id
       where r.tenant_id = ${tenantId} and r.id = ${runId}
         -- TW-10：团队会话共享讨论——Run 详情对「发起人」或「空间现任成员」
         -- 放行（行定位），撤销/角色边界由路由层 authorizeTeamTaskRead 复核。
         -- 被移出成员的 workspace_members 行已删除，exists 不再命中。
         and (
           r.requested_by = ${userId}
           or exists (
             select 1 from workspace_members wm
             where wm.tenant_id = r.tenant_id
               and wm.workspace_id = s.workspace_id
               and wm.user_id = ${userId}
           )
         )
         and s.status = 'active' and s.audience = 'workbench'
    `
    return row ? this.mapTask(row) : null
  }

  /**
   * Shared message rows for a session (TW-10): user messages resolve their
   * author via sender_user_id; assistant messages resolve the triggering Run's
   * requester and the Agent recorded in the Run manifest (falling back to the
   * session-bound Agent for legacy rows).
   */
  private async loadSessionMessages(sessionId: string): Promise<MessageRow[]> {
    return this.database<MessageRow[]>`
      select m.id, m.role, m.content, m.created_at as "createdAt", m.run_id as "runId",
             coalesce(m.sender_user_id, r.requested_by) as "senderId",
             su.display_name as "senderName",
             r.requested_by as "runRequesterId", ru.display_name as "runRequesterName",
             ag.name as "agentName"
        from messages m
        left join runs r on r.tenant_id = m.tenant_id and r.id = m.run_id
        left join users su on su.tenant_id = m.tenant_id
          and su.id = coalesce(m.sender_user_id, r.requested_by)
        left join users ru on ru.tenant_id = r.tenant_id and ru.id = r.requested_by
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
        left join sessions ms on ms.tenant_id = m.tenant_id and ms.id = m.session_id
        left join agent_versions av on av.tenant_id = m.tenant_id
          and av.id = coalesce(ra.manifest ->> 'agent_version_id', ms.agent_version_id)
        left join agents ag on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
       where m.tenant_id = ${tenantId} and m.session_id = ${sessionId}
         and m.role in ('user', 'assistant')
       order by m.created_at asc
    `
  }

  /**
   * Workspace session activity signal for the live-update SSE (TW-10). The
   * marker is the newest change a viewer can observe: message writes bump
   * `last_active_at`, Run lifecycle transitions surface through
   * `max(runs.updated_at)`. The stream endpoint polls and diffs this marker
   * so discussion messages, @-triggered Runs and status changes all become
   * push events without an extra event table. Callers authorize separately.
   */
  async listWorkspaceSessionActivity(workspaceId: string) {
    return this.database<{ sessionId: string; activityAt: Date }[]>`
      select s.id as "sessionId",
             greatest(
               s.last_active_at,
               coalesce(
                 (select max(r.updated_at) from runs r
                   where r.tenant_id = s.tenant_id and r.session_id = s.id),
                 s.last_active_at
               )
             ) as "activityAt"
        from sessions s
       where s.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
         and s.status = 'active' and s.audience = 'workbench'
    `
  }

  /**
   * Shared team-discussion view (TW-10): session header plus every user/
   * assistant message with sender and Agent attribution, and the Run list so
   * the client can render execution status inline. Access is checked by the
   * caller (requireSessionAccess / authorizeTeamTaskRead); this method only
   * loads data for an active workbench session.
   */
  async getSessionThread(sessionId: string) {
    const [row] = await this.database<{
      id: string
      title: string
      workspaceId: string
      workspaceType: 'personal' | 'team'
      workspaceStatus: 'active' | 'archived'
      createdBy: string
      creatorName: string
      lastActiveAt: Date
      createdAt: Date
    }[]>`
      select s.id, s.title, s.workspace_id as "workspaceId",
             w.workspace_type as "workspaceType", w.status as "workspaceStatus",
             s.created_by as "createdBy", u.display_name as "creatorName",
             s.last_active_at as "lastActiveAt", s.created_at as "createdAt"
        from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        join users u on u.tenant_id = s.tenant_id and u.id = s.created_by
       where s.tenant_id = ${tenantId} and s.id = ${sessionId}
         and s.status = 'active' and s.audience = 'workbench'
    `
    if (!row) return null
    const messages = await this.loadSessionMessages(sessionId)
    const runs = await this.database<{
      id: string
      status: RunState
      requestedBy: string
      requesterName: string
      createdAt: Date
    }[]>`
      select r.id, r.status, r.requested_by as "requestedBy",
             ru.display_name as "requesterName", r.created_at as "createdAt"
        from runs r
        join users ru on ru.tenant_id = r.tenant_id and ru.id = r.requested_by
       where r.tenant_id = ${tenantId} and r.session_id = ${sessionId}
       order by r.created_at asc
    `
    return {
      sessionId: row.id,
      title: row.title,
      workspaceId: row.workspaceId,
      workspaceType: row.workspaceType,
      workspaceStatus: row.workspaceStatus,
      createdBy: row.createdBy,
      creatorName: row.creatorName,
      createdAt: row.createdAt.toISOString(),
      lastActiveAt: row.lastActiveAt.toISOString(),
      messages: messages.map(message => ({
        ...mapMessage(message),
        runId: message.runId,
        senderId: message.senderId,
        senderName: message.senderName,
        runRequesterId: message.runRequesterId,
        runRequesterName: message.runRequesterName,
        agentName: message.agentName,
      })),
      runs: runs.map(run => ({
        runId: run.id,
        status: run.status,
        requestedBy: run.requestedBy,
        requesterName: run.requesterName,
        createdAt: run.createdAt.toISOString(),
      })),
    }
  }

  private async mapTask(row: TaskRow): Promise<TaskRun> {
    const messages = await this.loadSessionMessages(row.sessionId)
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
      workspaceType: row.workspaceType,
      workspaceStatus: row.workspaceStatus,
      sessionId: row.sessionId,
      agentVersion: row.agentVersion ? `${row.agentName ?? 'dsh-work-assistant'}@${row.agentVersion}` : '',
      createdAt: formatDateTime(row.createdAt),
      updatedAt: formatDateTime(row.updatedAt),
      owner: row.owner,
      requestedBy: row.requestedBy,
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
      suggestion: '已生成的部分内容会保留并带入重新执行；可减少问题范围或文件数量后重试，若持续超时请联系管理员检查运行时容量。',
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
    runId: row.runId,
    senderId: row.senderId ?? undefined,
    senderName: row.senderName ?? undefined,
    runRequesterId: row.runRequesterId ?? undefined,
    runRequesterName: row.runRequesterName ?? undefined,
    agentName: row.agentName ?? undefined,
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
    if (typeof parsed.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(parsed.at) || !Number.isFinite(Date.parse(parsed.at))
      || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 160 || cursor.length > 1024) throw new Error('shape')
    return { lastActiveAt: parsed.at, id: parsed.id }
  } catch {
    throw requestInvalid('无效的分页游标')
  }
}
