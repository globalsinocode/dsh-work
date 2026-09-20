import { randomUUID } from 'node:crypto'

import type { ChatMessage, RunStep, TaskRun, TaskRunError } from '../../../domain/types.ts'
import { deriveTaskResult, type TaskResult, type TaskResultEvidence, type TaskResultOutcome } from '../../../domain/task-result.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { JsonObject, RunState } from '../../run/run-types.ts'
import { PostgresWorkspaceService, readableWorkspacePredicate } from './postgres-workspace-service.ts'
import { authorizationDenied, requestInvalid } from '../../authorization/authorization-errors.ts'
import { workspaceStateConflict } from './workspace-state-conflict-error.ts'

const tenantId = 'tenant-dsh-work'
const conversationHistoryMessageLimit = 12
const conversationHistoryCharacterLimit = 24_000
/** SSE 活动轮询跟踪的最近活跃会话数上限（评审 M8 查询边界）。 */
const workspaceSessionActivitySessionLimit = 500
/** 共享线程一次返回的最近消息数上限（评审 M8 查询边界）。 */
const sessionThreadMessageLimit = 500
/**
 * SSE 归档增量 id 集上限（二审残留）：客户端 since 水位线可由请求方给出
 * 任意早的时刻，归档集必须自身有界——超出上限的更老归档由客户端全量
 * resync 兜底，不做无界扫描。
 */
const workspaceSessionArchivedIdsLimit = 2000

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
  /** I-06：终态遥测与截断/中断标记的证据来源。 */
  safeMetadata: JsonObject
  occurredAt: Date
}

interface ToolAuditRow {
  id: string
  parameterSummary: JsonObject
  result: 'success' | 'failed' | 'blocked'
  occurredAt: Date
}

interface ArtifactRow {
  id: string
  artifactVersionId: string
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
    const insertSession = async (db: DatabaseClient | DatabaseTransaction) => {
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
    // 评审高2：团队会话的 INSERT 必须与「空间活跃 + 当前成员非 viewer」的复核
    // 在同一个空间锁事务里完成，否则预检到插入之间归档/撤权仍能穿透。
    // 个人空间保持本人规则不变；调用方已持有事务时（自动化受理）由其自治。
    if (!tx) {
      const [workspace] = await this.database<{ type: 'personal' | 'team' }[]>`
        select workspace_type as type from workspaces
         where tenant_id = ${tenantId} and id = ${workspaceId}
      `
      if (workspace?.type === 'team') {
        return this.database.begin(async transaction => {
          const [locked] = await transaction<{ id: string; status: string }[]>`
            select id, status from workspaces
             where tenant_id = ${tenantId} and id = ${workspaceId}
             for update
          `
          if (!locked || locked.status !== 'active') {
            throw authorizationDenied('工作空间不存在、已归档或当前用户不是成员')
          }
          const [member] = await transaction<{ role: string }[]>`
            select member_role as role from workspace_members
             where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
               and user_id = ${input.userId}
          `
          if (!member || member.role === 'viewer') {
            throw authorizationDenied('当前用户角色没有权限创建共享会话')
          }
          return insertSession(transaction)
        })
      }
    }
    return insertSession(tx ?? this.database)
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
      const [workspace] = await transaction<{ id: string; status: string; type: 'personal' | 'team' }[]>`
        select w.id, w.status, w.workspace_type as type from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
         where s.tenant_id = ${tenantId} and s.id = ${sessionId}
           and s.created_by = ${userId} and s.audience = 'workbench'
         for update of w
      `
      if (!workspace) throw authorizationDenied('Session 不存在或不可访问')
      await this.requireWritableWorkspace(workspace.id, userId, transaction)
      // 移除共享会话改变全队入口，属团队写入而非个人隐藏：团队会话的创建者
      // 还必须持有非 viewer 角色。readableWorkspacePredicate 放行 viewer，
      // 因此必须在空间锁内单独复核——成员降级与归档都在锁序内串行化。
      if (workspace.type === 'team') {
        const [membership] = await transaction<{ role: string }[]>`
          select member_role as role
            from workspace_members
           where tenant_id = ${tenantId}
             and workspace_id = ${workspace.id}
             and user_id = ${userId}
        `
        if (!membership || membership.role === 'viewer') {
          throw authorizationDenied('当前用户角色没有权限移除该共享会话')
        }
      }
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
      // M-R4：归档对 SSE 是「提交后可见」的变更——last_active_at 用 now()
      // 记的是事务开始时间，晚提交时可能早于观察者的水位线。同一事务里
      //  bump 空间修订号：修订号只在提交后递增，作为与归档一致的变更信号
      // 触发订阅方做无时间过滤的补扫，同时顺带收紧读轨缓存有效期。
      await transaction`
        update workspaces set team_auth_revision = team_auth_revision + 1
         where tenant_id = ${tenantId} and id = ${session.workspaceId}
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

  /**
   * TW-10 shared-discussion commit. The orchestration-layer write check is only
   * a fast fail — this transaction takes the same workspaces → sessions lock
   * order as `archiveSession`/`createRun` and re-asserts 「空间活跃 + 会话活跃 +
   * 调用者仍是非只读成员」inside the lock, so a demotion, removal or archive
   * landing between the pre-check and the commit cannot slip a message in.
   * Message insert and the activity bump commit together; a client-supplied
   * deterministic message id makes retries idempotent.
   */
  async appendDiscussionMessage(input: {
    sessionId: string
    userId: string
    content: string
    messageId: string
  }): Promise<{ messageId: string; created: boolean }> {
    return this.database.begin(async (transaction) => {
      const [locked] = await transaction<{
        workspaceId: string
        sessionStatus: string
      }[]>`
        select w.id as "workspaceId", s.status as "sessionStatus"
          from sessions s
          join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
         where s.tenant_id = ${tenantId} and s.id = ${input.sessionId}
           and s.audience = 'workbench' and w.workspace_type = 'team'
           and w.status = 'active'
         for update of w, s
      `
      if (!locked || locked.sessionStatus !== 'active') {
        throw authorizationDenied('Session 不存在或不可访问')
      }
      const [membership] = await transaction<{ role: string }[]>`
        select wm.member_role as role
          from workspace_members wm
          join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id and u.status = 'active'
         where wm.tenant_id = ${tenantId}
           and wm.workspace_id = ${locked.workspaceId}
           and wm.user_id = ${input.userId}
      `
      if (!membership || membership.role === 'viewer') {
        throw authorizationDenied('当前用户角色没有权限在该会话中发言')
      }
      const [inserted] = await transaction<{ id: string }[]>`
        insert into messages (id, tenant_id, session_id, run_id, role, content, sender_user_id)
        values (${input.messageId}, ${tenantId}, ${input.sessionId}, null, 'user', ${input.content}, ${input.userId})
        on conflict (id) do nothing
        returning id
      `
      if (inserted) {
        await transaction`
          update sessions set last_active_at = now()
           where tenant_id = ${tenantId} and id = ${input.sessionId}
        `
        return { messageId: input.messageId, created: true }
      }
      // 键冲突即同一次逻辑请求的重放：必须核对确实是「同会话、同发送者、
      // 同消息类型、同正文」的同一条消息（M-R2）——不能仅凭相同内容认定
      // 重放；任一维度不符都按冲突拒绝，绝不静默吞掉或归到别人名下。
      const [existing] = await transaction<{
        sessionId: string
        senderId: string | null
        role: string
        content: string
      }[]>`
        select session_id as "sessionId", sender_user_id as "senderId", role, content
          from messages
         where tenant_id = ${tenantId} and id = ${input.messageId}
      `
      if (!existing
        || existing.sessionId !== input.sessionId
        || existing.senderId !== input.userId
        || existing.role !== 'user'
        || existing.content !== input.content) {
        throw workspaceStateConflict('幂等键已被其他消息占用，请更换 idempotencyKey 后重试')
      }
      return { messageId: input.messageId, created: false }
    })
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
      /** 微秒级游标文本（同个人历史口径）：toISOString 只到毫秒会丢行（评审 M3）。 */
      cursorTimestamp: string
      runCount: number
      latestRunId: string | null
      latestRunStatus: RunState | null
    }[]>`
      select s.id as "sessionId", s.title,
             s.created_by as "creatorId", u.display_name as "creatorName",
             s.last_active_at as "lastActiveAt",
             to_char(s.last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorTimestamp",
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
           : this.database`(s.last_active_at, s.id) < (${cursor.lastActiveAt}::text::timestamptz, ${cursor.id})`}
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
      cursorTimestamp: row.cursorTimestamp,
    }))
    const last = items[items.length - 1]
    return {
      items: items.map(({ cursorTimestamp: _cursorTimestamp, ...item }) => item),
      nextCursor: hasMore && last ? encodeSessionCursor(last.cursorTimestamp, last.sessionId) : null,
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
             (w.status = 'active' and (w.workspace_type = 'personal' or exists (
                select 1 from workspace_members rm where rm.tenant_id = w.tenant_id and rm.workspace_id = w.id
                  and rm.user_id = ${input.actorUserId} and rm.member_role <> 'viewer'))
              and not exists (select 1 from runs live where live.tenant_id = s.tenant_id
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

  /**
   * Run 行定位（发起人或空间现任成员），详情与独立结果读取共用；
   * 撤销/角色边界由路由层 authorizeTeamTaskRead 复核。
   */
  private async findTaskRow(runId: string, userId: string): Promise<TaskRow | null> {
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
    return row ?? null
  }

  async getTask(runId: string, userId: string): Promise<TaskRun | null> {
    const row = await this.findTaskRow(runId, userId)
    return row ? this.mapTask(row) : null
  }

  /**
   * I-06：独立结果读取入口（GET /runs/:id/result）。只装配核验证据，
   * 不加载消息正文；授权与详情同一口径（行定位 + 路由层读取门禁）。
   * 结果读取失败只影响本投影，不触发任何新的执行。
   */
  async getTaskResult(runId: string, userId: string): Promise<{ result: TaskResult; workspaceId: string } | null> {
    const row = await this.findTaskRow(runId, userId)
    if (!row) return null
    const messageIds = await this.database<{ id: string }[]>`
      select id from messages
       where tenant_id = ${tenantId} and run_id = ${row.id} and role = 'assistant'
    `
    const evidence = await this.loadTaskResultEvidence(row, new Set(messageIds.map(message => message.id)))
    return { result: deriveTaskResult(evidence), workspaceId: row.workspaceId }
  }

  /**
   * I-06 批量 outcome 投影（自动任务执行列表等列表场景）：按 Run 分组
   * 装载当前 Attempt 的证据后逐条推导，避免逐行多次往返。sources 不影响
   * outcome，批量路径不加载来源明细。
   */
  async getTaskResultOutcomes(runIds: string[]): Promise<Map<string, TaskResultOutcome>> {
    const outcomes = new Map<string, TaskResultOutcome>()
    if (!runIds.length) return outcomes
    const rows = await this.database<Array<Pick<TaskRow, 'id' | 'status' | 'currentAttemptId' | 'updatedAt' | 'errorCode'>>>`
      select r.id, r.status, r.current_attempt_id as "currentAttemptId",
             r.updated_at as "updatedAt", ra.error_code as "errorCode"
        from runs r
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
       where r.tenant_id = ${tenantId} and r.id = any(${runIds})
    `
    if (!rows.length) return outcomes
    const attemptIds = rows.map(row => row.currentAttemptId).filter((id): id is string => id !== null)
    const events = attemptIds.length
      ? await this.database<Array<EventRow & { attemptId: string }>>`
          select e.id, e.event_type as "eventType", e.display_message as "displayMessage",
                 e.safe_metadata as "safeMetadata", e.occurred_at as "occurredAt",
                 e.attempt_id as "attemptId"
            from run_events e
           where e.tenant_id = ${tenantId} and e.attempt_id = any(${attemptIds})
           order by e.attempt_id asc, e.sequence asc
        `
      : []
    const messageIds = await this.database<{ id: string; runId: string }[]>`
      select id, run_id as "runId" from messages
       where tenant_id = ${tenantId} and run_id = any(${runIds}) and role = 'assistant'
    `
    const artifacts = await this.database<Array<ArtifactRow & { sourceRunId: string; sourceAttemptId: string | null }>>`
      select a.id, av.id as "artifactVersionId", a.name, a.artifact_type as "artifactType", av.version_no as version,
             f.size_bytes as "sizeBytes", av.created_at as "createdAt", a.workspace_id as "workspaceId",
             av.source_run_id as "sourceRunId", av.source_attempt_id as "sourceAttemptId"
        from artifact_versions av
        join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
       where av.tenant_id = ${tenantId} and av.source_run_id = any(${runIds})
       order by av.version_no desc
    `
    const toolAudits = attemptIds.length
      ? await this.database<Array<ToolAuditRow & { attemptId: string }>>`
          select tal.id, tal.parameter_summary as "parameterSummary", tal.result,
                 tal.occurred_at as "occurredAt", tal.attempt_id as "attemptId"
            from tool_audit_logs tal
           where tal.tenant_id = ${tenantId} and tal.attempt_id = any(${attemptIds})
           order by tal.occurred_at asc
        `
      : []
    for (const row of rows) {
      const committed = new Set(messageIds.filter(message => message.runId === row.id).map(message => message.id))
      const evidence: TaskResultEvidence = {
        run: { id: row.id, status: row.status, updatedAt: row.updatedAt },
        attemptId: row.currentAttemptId,
        events: events.filter(event => event.attemptId === row.currentAttemptId),
        committedMessageIds: committed,
        artifacts: artifacts
          // 与 loadTaskResultEvidence 同口径：只认当前 Attempt 登记的成果，
          // 历史 Attempt 的交付不并入本次核验（I-06 评审）。
          .filter(artifact => artifact.sourceRunId === row.id && artifact.sourceAttemptId === row.currentAttemptId)
          .map(artifact => mapArtifactEvidenceRow(artifact, row.id)),
        sources: [],
        toolAudits: toolAudits
          .filter(audit => audit.attemptId === row.currentAttemptId)
          .map(mapToolAuditRow),
        runError: row.status === 'failed' ? toRunError(row.id, row.errorCode) : null,
      }
      outcomes.set(row.id, deriveTaskResult(evidence).outcome)
    }
    return outcomes
  }

  /**
   * Shared message rows for a session (TW-10): user messages resolve their
   * author via sender_user_id; assistant messages resolve the triggering Run's
   * requester and the Agent recorded in the Run manifest (falling back to the
   * session-bound Agent for legacy rows).
   */
  private async loadSessionMessages(
    sessionId: string,
    options: { runId?: string; limit?: number; beforeMessageId?: string } = {},
  ): Promise<MessageRow[]> {
    // 查询边界（评审 M8）：调用方可用 runId 只取该 Run 的消息（Run 详情不再
    // 先拉全会话再内存过滤），或用 limit 只取最近 N 条（共享线程）。无界路径
    // 仅为历史调用方保留。
    // beforeMessageId：加载更早一页（评审中3）——游标就是当前最旧一条消息
    // 的 id。边界比较整体留在 SQL 子查询里（二审残留 1）：created_at 不能
    // 经 JS Date 往返——毫秒截断会把同毫秒不同微秒的消息错误排出上一页。
    let beforeValid = false
    if (options.beforeMessageId) {
      const [boundary] = await this.database<{ id: string }[]>`
        select id from messages
         where tenant_id = ${tenantId} and session_id = ${sessionId}
           and id = ${options.beforeMessageId}
      `
      if (!boundary) throw requestInvalid('无效的消息分页游标')
      beforeValid = true
    }
    const rows = await this.database<MessageRow[]>`
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
         and ${options.runId ? this.database`m.run_id = ${options.runId}` : this.database`true`}
         and ${beforeValid
           ? this.database`(m.created_at, m.id) < (
               select b.created_at, b.id from messages b
                where b.tenant_id = ${tenantId} and b.session_id = ${sessionId}
                  and b.id = ${options.beforeMessageId}
             )`
           : this.database`true`}
       order by m.created_at desc, m.id desc
       ${options.limit ? this.database`limit ${options.limit}` : this.database``}
    `
    return rows.reverse()
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
    // 有界活跃集（评审 M8）：先按 last_active_at 走索引取最近 500 个会话，
    // 昂贵的 max(runs.updated_at) 只对这些会话计算。被挤出窗口的旧会话一旦
    // 有写入会推高 last_active_at 重新进入窗口，下一拍即被检测到。
    const sessions = await this.database<{ sessionId: string; activityAt: Date; activityEpoch: number }[]>`
      select s.id as "sessionId",
             activity.activity_at as "activityAt",
             extract(epoch from activity.activity_at)::float8 as "activityEpoch"
        from sessions s
        cross join lateral (
          select greatest(
                   s.last_active_at,
                   coalesce(
                     (select max(r.updated_at) from runs r
                       where r.tenant_id = s.tenant_id and r.session_id = s.id),
                     s.last_active_at
                   )
                 ) as activity_at
        ) activity
       where s.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
         and s.status = 'active' and s.audience = 'workbench'
       order by s.last_active_at desc, s.id desc
       limit ${workspaceSessionActivitySessionLimit}
    `
    // team_auth_revision 随页返回（M-R4）：归档在同一事务里 bump 修订号，
    // 订阅方以「修订号变化」作为提交后一致的归档变更信号，做无时间过滤的
    // 补扫——不再只靠 last_active_at 与某个时间水位线比较。
    const [workspace] = await this.database<{ revision: number }[]>`
      select team_auth_revision as revision from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId}
    `
    return { sessions, revision: workspace?.revision ?? 0 }
  }

  /**
   * 归档增量跟踪（评审中4）：归档的唯一路径会把 last_active_at 推到 now()，
   * 因此「status=archived 且 last_active_at >= since」精确捕获 since 之后
   * 归档的会话——被挤出活动窗口后才归档的会话不再漏通知，而建流前的历史
   * 归档也不会每轮全量回扫（归档集与活跃窗口解耦，有界）。
   */
  async listRecentlyArchivedSessionIds(workspaceId: string, since: Date) {
    // LIMIT+1 探测截断（四审）：容量上限是对的，但「超限即丢失」必须伴随
    // 恢复信号——订阅方据此发 resync 要求客户端整体重取，而不是静默漏报。
    const rows = await this.database<{ sessionId: string }[]>`
      select s.id as "sessionId"
        from sessions s
       where s.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
         and s.status = 'archived' and s.audience = 'workbench'
         and s.last_active_at >= ${since}
       order by s.last_active_at desc
       limit ${workspaceSessionArchivedIdsLimit + 1}
    `
    return {
      ids: rows.slice(0, workspaceSessionArchivedIdsLimit).map(row => row.sessionId),
      truncated: rows.length > workspaceSessionArchivedIdsLimit,
    }
  }

  /**
   * 直接复核指定会话的当前归档状态（M-R4）：曾活跃集合中消失的成员不看
   * 任何时间戳——归档事务开始早、提交晚导致 last_active_at 早于水位线时
   * 也能命中。ids 由调用方的有界跟踪集合提供。
   */
  async listArchivedSessionIdsAmong(workspaceId: string, sessionIds: string[]) {
    if (!sessionIds.length) return []
    const rows = await this.database<{ sessionId: string }[]>`
      select s.id as "sessionId"
        from sessions s
       where s.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
         and s.status = 'archived' and s.audience = 'workbench'
         and s.id = any(${sessionIds})
    `
    return rows.map(row => row.sessionId)
  }

  /**
   * 修订号补扫（M-R4）：空间修订号变化（归档/成员变更已提交）时对归档集
   * 做一次无时间过滤的有界回扫，覆盖「从未进入活跃窗口、且归档时间戳
   * 早于客户端水位线」的残余缝隙。
   */
  async listArchivedSessionIds(workspaceId: string) {
    const rows = await this.database<{ sessionId: string }[]>`
      select s.id as "sessionId"
        from sessions s
       where s.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
         and s.status = 'archived' and s.audience = 'workbench'
       order by s.last_active_at desc
       limit ${workspaceSessionArchivedIdsLimit + 1}
    `
    return {
      ids: rows.slice(0, workspaceSessionArchivedIdsLimit).map(row => row.sessionId),
      truncated: rows.length > workspaceSessionArchivedIdsLimit,
    }
  }

  /**
   * Shared team-discussion view (TW-10): session header plus every user/
   * assistant message with sender and Agent attribution, and the Run list so
   * the client can render execution status inline. Access is checked by the
   * caller (requireSessionAccess / authorizeTeamTaskRead); this method only
   * loads data for an active workbench session.
   */
  async getSessionThread(sessionId: string, options?: { before?: string }) {
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
    // 只取最近 500 条（sessionThreadMessageLimit）：共享讨论可能有上千条历史，
    // 全量加载既慢又撑爆响应体。多取一条判断是否还有更早历史——截断必须
    // 显式告知客户端并给出翻页游标，不能静默丢消息（评审中3）。
    const loaded = await this.loadSessionMessages(sessionId, {
      limit: sessionThreadMessageLimit + 1,
      beforeMessageId: options?.before,
    })
    const hasMoreMessages = loaded.length > sessionThreadMessageLimit
    const messages = hasMoreMessages ? loaded.slice(1) : loaded
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
      latestRun: runs.length > 0
        ? { id: runs[runs.length - 1]!.id, status: runs[runs.length - 1]!.status }
        : null,
      // 「加载更早」契约（评审中3）：hasMoreMessages 为 true 时，用
      // messagesCursor（本页最旧一条消息的 id）作 before 参数再取上一页。
      hasMoreMessages,
      messagesCursor: hasMoreMessages && messages.length > 0 ? messages[0]!.id : null,
    }
  }

  /**
   * I-06：装配版本化任务结果的核验证据。全部来自持久化记录——当前
   * Attempt 的 run_events（含 safe_metadata 遥测）、Run 已提交的
   * assistant 消息 id、当前 Attempt 登记的 artifact_versions 与
   * tool_audit_logs 记录；成果按 source_attempt_id 关联到当前 Attempt，
   * 前一次 Attempt 登记的成果不得计入本次交付核验。
   * 不从回答正文或运行时内存猜测。
   */
  private async loadTaskResultEvidence(
    row: TaskRow,
    committedMessageIds: ReadonlySet<string>,
  ): Promise<TaskResultEvidence> {
    const events = row.currentAttemptId
      ? await this.database<EventRow[]>`
          select id, event_type as "eventType", display_message as "displayMessage",
                 safe_metadata as "safeMetadata", occurred_at as "occurredAt"
            from run_events
           where tenant_id = ${tenantId} and attempt_id = ${row.currentAttemptId}
           order by sequence asc
        `
      : []
    const artifacts = row.currentAttemptId
      ? await this.database<ArtifactRow[]>`
          select a.id, av.id as "artifactVersionId", a.name, a.artifact_type as "artifactType", av.version_no as version,
                 f.size_bytes as "sizeBytes", av.created_at as "createdAt", a.workspace_id as "workspaceId"
            from artifact_versions av
            join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
            join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
           where av.tenant_id = ${tenantId} and av.source_run_id = ${row.id}
             and av.source_attempt_id = ${row.currentAttemptId}
           order by av.version_no desc
        `
      : []
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
    const toolAudits = row.currentAttemptId
      ? await this.database<ToolAuditRow[]>`
          select id, parameter_summary as "parameterSummary", result, occurred_at as "occurredAt"
            from tool_audit_logs
           where tenant_id = ${tenantId} and attempt_id = ${row.currentAttemptId}
           order by occurred_at asc
        `
      : []
    return {
      run: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      attemptId: row.currentAttemptId,
      events,
      committedMessageIds,
      artifacts: artifacts.map(artifact => mapArtifactEvidenceRow(artifact, row.id)),
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
      toolAudits: toolAudits.map(mapToolAuditRow),
      runError: row.status === 'failed' ? toRunError(row.id, row.errorCode) : null,
    }
  }

  private async mapTask(row: TaskRow): Promise<TaskRun> {
    // 团队 Run 详情只取该 Run 的消息（评审 M8）：共享会话里全会话加载会把
    // 几百条无关讨论一并载入。个人 Run 详情保持 AC-23 原契约——返回会话的
    // 完整多轮消息历史，不按 Run 收窄（评审中3）。
    const messages = row.workspaceType === 'team'
      ? await this.loadSessionMessages(row.sessionId, { runId: row.id })
      : await this.loadSessionMessages(row.sessionId)
    const runMessages = messages.filter((message) => message.runId === row.id)
    const committedMessageIds = new Set(
      runMessages.filter(message => message.role === 'assistant').map(message => message.id),
    )
    const evidence = await this.loadTaskResultEvidence(row, committedMessageIds)
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
      steps: mapSteps(row.id, evidence.events, row.status),
      result: deriveTaskResult(evidence),
      attachments: attachments.map(attachment => attachment.name),
      skill: row.selectedSkillId && row.selectedSkillName && row.selectedSkillVersion
        ? { id: row.selectedSkillId, name: row.selectedSkillName, version: row.selectedSkillVersion }
        : undefined,
    }
  }
}

function mapArtifactRow(artifact: ArtifactRow, runId: string) {
  return {
    id: artifact.id,
    name: artifact.name,
    type: artifact.artifactType,
    version: artifact.version,
    size: formatSize(Number(artifact.sizeBytes)),
    createdAt: formatDateTime(artifact.createdAt),
    runId,
    workspaceId: artifact.workspaceId,
    summary: '由 DSH Runtime 本轮回答发布，保留来源 Run 与不可覆盖版本。',
  }
}

function mapArtifactEvidenceRow(artifact: ArtifactRow, runId: string) {
  return {
    artifact: mapArtifactRow(artifact, runId),
    artifactVersionId: artifact.artifactVersionId,
  }
}

function mapToolAuditRow(audit: ToolAuditRow) {
  return {
    id: audit.id,
    toolName: typeof audit.parameterSummary['tool_name'] === 'string' ? audit.parameterSummary['tool_name'] : null,
    decision: typeof audit.parameterSummary['decision'] === 'string' ? audit.parameterSummary['decision'] : null,
    result: audit.result,
    occurredAt: audit.occurredAt,
  }
}

export function toRunError(runId: string, errorCode: string | null | undefined): TaskRunError {
  const code = errorCode ?? 'RUNTIME_EXECUTION_FAILED'
  const catalog: Record<string, Omit<TaskRunError, 'code' | 'object'>> = {
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
