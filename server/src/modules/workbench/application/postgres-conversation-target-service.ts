import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { notFound } from '../../../domain/request-errors.ts'
import {
  decodeTargetCursor,
  encodeTargetCursor,
  previewText,
  type AgentConversation,
  type ConversationLocation,
  type ConversationMessagePreview,
  type ConversationTarget,
  type ConversationTargetPage,
  type ConversationTargetStore,
} from './conversation-targets.ts'
import { readableWorkspacePredicate } from './postgres-workspace-service.ts'

const tenantId = 'tenant-dsh-work'

/** 当前员工可用的 AI 同事（与 AI 同事页、新对话同一口径：已发布、角色可见、执行身份有效）。 */
export interface WorkbenchAgentDirectory {
  listWorkbenchAgents(userId: string, sessionRoleIds?: string[]): Promise<Array<{ id: string }>>
}

interface TargetRow {
  type: 'agent' | 'group'
  id: string
  name: string
  description: string | null
  avatarNames: string[] | null
  lastActiveAt: Date
  cursorTimestamp: string
  previewRole: 'user' | 'assistant' | null
  previewAuthor: string | null
  previewContent: string | null
  previewAt: Date | null
}

interface SegmentRow {
  sessionId: string
  title: string
  createdAt: Date
  lastActiveAt: Date
  cursorTimestamp: string
  agentVersion: string
  agentVersionId: string
  runCount: number
  latestRunId: string | null
  latestRunStatus: string | null
}

/**
 * 协作模式对话对象（项目空间方案 12.6）。单聊只聚合本人个人空间中的活动会话；群组只含本人
 * 当前是成员的活动项目空间（读取时重查成员关系，收权后不再返回）。预览只取 user / assistant
 * 消息，与会话详情的可读范围一致。
 */
export class PostgresConversationTargetService implements ConversationTargetStore {
  private readonly database: DatabaseClient
  private readonly agents: WorkbenchAgentDirectory

  constructor(database: DatabaseClient, agents: WorkbenchAgentDirectory) {
    this.database = database
    this.agents = agents
  }

  async listTargets(input: { userId: string; roleIds: string[]; query?: string; cursor?: string; limit?: number }): Promise<ConversationTargetPage> {
    const limit = input.limit ?? 30
    const cursor = input.cursor ? decodeTargetCursor(input.cursor) : null
    const pattern = input.query ? `%${input.query.replaceAll(/[\\%_]/g, value => `\\${value}`)}%` : null
    const sql = this.database
    const rows = await sql<TargetRow[]>`
      with agent_targets as (
        select 'agent'::text as type, av.agent_id as id, max(s.last_active_at) as last_active_at
          from sessions s
          join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
          join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
         where s.tenant_id = ${tenantId} and s.audience = 'workbench' and s.status = 'active'
           and s.created_by = ${input.userId}
           and w.workspace_type = 'personal' and w.created_by = ${input.userId}
         group by av.agent_id
      ),
      group_targets as (
        select 'group'::text as type, w.id,
               greatest(w.created_at, coalesce(max(s.last_active_at), w.created_at)) as last_active_at
          from workspaces w
          left join sessions s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
            and s.audience = 'workbench' and s.status = 'active'
         where w.tenant_id = ${tenantId} and w.workspace_type = 'team' and w.status = 'active'
           and (${readableWorkspacePredicate(sql, input.userId)})
         group by w.id
      ),
      targets as (
        select t.type, t.id, t.last_active_at,
               coalesce(cur.name, ag.name) as name, coalesce(cur.description, ag.description, '') as description
          from agent_targets t
          join agents ag on ag.tenant_id = ${tenantId} and ag.id = t.id
          left join agent_versions cur on cur.tenant_id = ag.tenant_id and cur.id = ag.active_version_id
        union all
        select t.type, t.id, t.last_active_at, w.name, coalesce(w.description, '')
          from group_targets t
          join workspaces w on w.tenant_id = ${tenantId} and w.id = t.id
      )
      select t.type, t.id, t.name, t.description, t.last_active_at as "lastActiveAt",
             to_char(t.last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorTimestamp",
             case when t.type = 'group' then (
               select array_agg(member.display_name order by member.rank, member.joined_at, member.user_id)
                 from (select u.display_name, m.joined_at, m.user_id,
                              case m.member_role when 'owner' then 0 when 'admin' then 1 else 2 end as rank
                         from workspace_members m
                         join users u on u.tenant_id = m.tenant_id and u.id = m.user_id
                        where m.tenant_id = ${tenantId} and m.workspace_id = t.id
                        order by rank, m.joined_at, m.user_id
                        limit 4) member
             ) else array[t.name] end as "avatarNames",
             preview.role as "previewRole", preview.author as "previewAuthor",
             preview.content as "previewContent", preview.created_at as "previewAt"
        from targets t
        left join lateral (
          select m.role, m.content, m.created_at,
                 case when m.role = 'user' then su.display_name else coalesce(mag.name, 'dsh-work') end as author
            from messages m
            join sessions ms on ms.tenant_id = m.tenant_id and ms.id = m.session_id
            join workspaces mw on mw.tenant_id = ms.tenant_id and mw.id = ms.workspace_id
            left join runs r on r.tenant_id = m.tenant_id and r.id = m.run_id
            left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
            left join agent_versions mav on mav.tenant_id = m.tenant_id
              and mav.id = coalesce(ra.manifest ->> 'agent_version_id', ms.agent_version_id)
            left join agents mag on mag.tenant_id = mav.tenant_id and mag.id = mav.agent_id
            left join users su on su.tenant_id = m.tenant_id and su.id = coalesce(m.sender_user_id, r.requested_by, ms.created_by)
           where m.tenant_id = ${tenantId} and m.role in ('user', 'assistant')
             and ms.audience = 'workbench' and ms.status = 'active'
             and (
               (t.type = 'agent' and ms.created_by = ${input.userId}
                 and mw.workspace_type = 'personal' and mw.created_by = ${input.userId}
                 and exists (select 1 from agent_versions sav where sav.tenant_id = ms.tenant_id
                   and sav.id = ms.agent_version_id and sav.agent_id = t.id))
               or (t.type = 'group' and ms.workspace_id = t.id)
             )
           order by m.created_at desc, m.id desc
           limit 1
        ) preview on true
       where ${pattern === null ? sql`true` : sql`t.name ilike ${pattern} escape '\\'`}
         and ${cursor === null ? sql`true` : sql`(
           t.last_active_at < ${cursor.lastActiveAt}::text::timestamptz
           or (t.last_active_at = ${cursor.lastActiveAt}::text::timestamptz and (t.type, t.id) > (${cursor.type}, ${cursor.id}))
         )`}
       order by t.last_active_at desc, t.type, t.id
       limit ${limit + 1}
    `
    const available = new Set((await this.agents.listWorkbenchAgents(input.userId, input.roleIds)).map(agent => agent.id))
    const items: ConversationTarget[] = rows.slice(0, limit).map(row => ({
      type: row.type,
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      avatarNames: row.avatarNames ?? [row.name],
      lastMessage: toPreview(row),
      lastActiveAt: row.lastActiveAt.toISOString(),
      available: row.type === 'group' || available.has(row.id),
    }))
    const last = rows[items.length - 1]
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeTargetCursor(last.cursorTimestamp, last.type, last.id) : null,
    }
  }

  async getAgentConversation(input: { userId: string; roleIds: string[]; agentId: string; cursor?: string; limit?: number }): Promise<AgentConversation> {
    const limit = input.limit ?? 5
    const cursor = input.cursor ? decodeTargetCursor(input.cursor) : null
    const sql = this.database
    const [agent] = await sql<Array<{ id: string; name: string; description: string; activeVersionId: string | null; version: string | null }>>`
      select ag.id, coalesce(cur.name, ag.name) as name, coalesce(cur.description, ag.description, '') as description,
             ag.active_version_id as "activeVersionId", cur.version
        from agents ag
        left join agent_versions cur on cur.tenant_id = ag.tenant_id and cur.id = ag.active_version_id
       where ag.tenant_id = ${tenantId} and ag.id = ${input.agentId}
    `
    const available = Boolean(agent) && (await this.agents.listWorkbenchAgents(input.userId, input.roleIds))
      .some(item => item.id === input.agentId)
    const rows = agent ? await sql<SegmentRow[]>`
      select s.id as "sessionId", s.title, s.created_at as "createdAt", s.last_active_at as "lastActiveAt",
             to_char(s.last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorTimestamp",
             av.version as "agentVersion", av.id as "agentVersionId",
             (select count(*)::integer from runs r where r.tenant_id = s.tenant_id and r.session_id = s.id) as "runCount",
             latest.id as "latestRunId", latest.status as "latestRunStatus"
        from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
        left join lateral (select r.id, r.status from runs r where r.tenant_id = s.tenant_id and r.session_id = s.id
          order by r.created_at desc, r.id desc limit 1) latest on true
       where s.tenant_id = ${tenantId} and s.audience = 'workbench' and s.status = 'active'
         and s.created_by = ${input.userId}
         and w.workspace_type = 'personal' and w.created_by = ${input.userId}
         and av.agent_id = ${input.agentId}
         and ${cursor === null ? sql`true` : sql`(s.last_active_at, s.id) < (${cursor.lastActiveAt}::text::timestamptz, ${cursor.id})`}
       order by s.last_active_at desc, s.id desc
       limit ${limit + 1}
    ` : []
    if (!agent || (!available && !rows.length && !cursor)) throw notFound('AI 同事不存在或当前不可用')

    // 续写只看本人与该 AI 同事最近的一段会话（不受分页影响）：版本一致且 AI 同事可用才续写。
    const [newest] = cursor === null ? rows : await sql<Array<{ sessionId: string; agentVersionId: string }>>`
      select s.id as "sessionId", s.agent_version_id as "agentVersionId"
        from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
       where s.tenant_id = ${tenantId} and s.audience = 'workbench' and s.status = 'active'
         and s.created_by = ${input.userId}
         and w.workspace_type = 'personal' and w.created_by = ${input.userId}
         and av.agent_id = ${input.agentId}
       order by s.last_active_at desc, s.id desc
       limit 1
    `
    const continueSessionId = available && newest && newest.agentVersionId === agent.activeVersionId ? newest.sessionId : null

    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        version: agent.version ?? items[0]?.agentVersion ?? '',
        available,
      },
      items: items.map(row => ({
        sessionId: row.sessionId,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        lastActiveAt: row.lastActiveAt.toISOString(),
        agentVersion: row.agentVersion,
        runCount: Number(row.runCount),
        latestRun: row.latestRunId ? { id: row.latestRunId, status: row.latestRunStatus ?? '' } : null,
      })),
      nextCursor: rows.length > limit && last ? encodeTargetCursor(last.cursorTimestamp, 'session', last.sessionId) : null,
      continueSessionId,
    }
  }

  async resolveConversation(input: { userId: string; conversationId: string }): Promise<ConversationLocation> {
    const sql = this.database
    const [row] = await sql<Array<{ sessionId: string; workspaceId: string; workspaceType: 'personal' | 'team'; agentId: string | null }>>`
      select s.id as "sessionId", w.id as "workspaceId", w.workspace_type as "workspaceType", av.agent_id as "agentId"
        from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
       where s.tenant_id = ${tenantId} and s.audience = 'workbench' and s.status = 'active'
         and (s.id = ${input.conversationId} or s.id = (
           select r.session_id from runs r where r.tenant_id = ${tenantId} and r.id = ${input.conversationId}))
         and (${readableWorkspacePredicate(sql, input.userId)})
         and (w.workspace_type = 'team' or s.created_by = ${input.userId})
       limit 1
    `
    if (!row) throw notFound('对话不存在或无权访问')
    if (row.workspaceType === 'team') return { type: 'group', workspaceId: row.workspaceId, sessionId: row.sessionId }
    if (!row.agentId) throw notFound('对话不存在或无权访问')
    return { type: 'agent', agentId: row.agentId, sessionId: row.sessionId }
  }
}

function toPreview(row: TargetRow): ConversationMessagePreview | null {
  if (!row.previewRole || row.previewContent === null || !row.previewAt) return null
  return {
    role: row.previewRole,
    authorName: row.previewAuthor ?? (row.previewRole === 'user' ? '成员' : 'dsh-work'),
    text: previewText(row.previewContent),
    sentAt: row.previewAt.toISOString(),
  }
}
