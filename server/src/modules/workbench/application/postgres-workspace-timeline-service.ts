import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { requestInvalid } from '../../../domain/authorization-errors.ts'
import { decodeTargetCursor, encodeTargetCursor, previewText } from './conversation-targets.ts'
import type { PostgresWorkspaceService } from './postgres-workspace-service.ts'

const tenantId = 'tenant-dsh-work'

/**
 * 群聊时间线（员工端双模式 S5d，项目空间方案 12.6，D26～D28）：一个群组（项目空间）的讨论话题
 * 消息、执行记录、任务卡片与系统记录按时间合并。只读，读取轨（归档空间现任成员可读）。
 *
 * - 讨论：不属于任何任务的团队会话（任务对话不进群聊，D27）；只取 user / assistant 消息。
 * - 执行记录：讨论中 @Agent 触发的 Run。
 * - 任务卡片：任务创建、Agent 任务每次执行结束（定时执行“无变化”标为 quiet）、任务标记完成，
 *   以及经 Agent 的编辑 / 改派 / 状态推进（S6）。卡片取自 project_tasks / runs /
 *   project_task_events，不写入消息表，不进 Agent 对话历史。
 * - 系统记录：群组创建，以及成员、Agent 成员、负责人、归档与恢复相关的空间动态。
 */
export type WorkspaceTimelineItem =
  | {
      kind: 'message'
      id: string
      at: string
      sessionId: string
      sessionTitle: string
      role: 'user' | 'assistant'
      content: string
      senderId: string | null
      senderName: string | null
      agentName: string | null
      runId: string | null
      runRequesterName: string | null
      /** 用户发言触发 Run 时附带的输入文件名；无文件时为 null。 */
      attachments?: string[] | null
      /** D38：该发言 @ 并登记了提醒的同事（用户 id）。 */
      mentionedUserIds: string[]
    }
  | {
      kind: 'run'
      id: string
      at: string
      sessionId: string
      sessionTitle: string
      runId: string
      status: string
      requesterName: string
      agentName: string | null
      stoppedByName: string | null
    }
  | {
      kind: 'task'
      id: string
      at: string
      event: 'created' | 'run_finished' | 'completed' | 'edited' | 'reassigned' | 'status_changed'
      actorName: string | null
      /** 经 Agent 写入时标注“经 某 Agent”（S6）。 */
      viaAgentName: string | null
      task: {
        id: string
        title: string
        status: 'todo' | 'in_progress' | 'done'
        assigneeType: 'employee' | 'agent'
        assigneeName: string
        schedule: Record<string, unknown> | null
        removed: boolean
      }
      run: { id: string; status: string; scheduled: boolean; quiet: boolean; summary: string | null } | null
      /** 完成说明（completed）。 */
      note: string | null
      /**
       * 经 Agent 的修改内容（S6，edited / reassigned / status_changed）：事件 metadata 去掉 via，
       * edited 含新值与 previous（原值），reassigned / status_changed 含 from / to。
       */
      changes?: Record<string, unknown> | null
    }
  | {
      kind: 'system'
      id: string
      at: string
      activityKind: string
      actorName: string
      safeMetadata: Record<string, unknown>
    }

export interface WorkspaceTimelinePage {
  workspaceId: string
  items: WorkspaceTimelineItem[]
  nextCursor: string | null
}

/** 在群聊中显示为系统记录的空间动态（文件、简报与任务另有页签或卡片）。 */
export const timelineSystemKinds = [
  'member_added', 'member_removed', 'member_exit', 'role_changed', 'owner_transferred',
  'agent_member_added', 'agent_member_removed', 'workspace_archived', 'workspace_restored',
] as const

interface TimelineRow {
  kind: WorkspaceTimelineItem['kind']
  id: string
  at: Date
  cursorTimestamp: string
  payload: Record<string, unknown>
}

export class PostgresWorkspaceTimelineService {
  private readonly database: DatabaseClient
  private readonly workspaces: PostgresWorkspaceService

  constructor(database: DatabaseClient, workspaces: PostgresWorkspaceService) {
    this.database = database
    this.workspaces = workspaces
  }

  async getTimeline(input: { workspaceId: string; actorUserId: string; before?: string; limit?: number }): Promise<WorkspaceTimelinePage> {
    const workspaceId = input.workspaceId?.trim()
    // 与动态接口同一口径：空 ID 与 standalone 不得落到本人个人空间（GET 不产生写入）。
    if (!workspaceId || workspaceId === 'standalone') throw requestInvalid('仅支持团队工作空间查看群聊')
    const access = await this.workspaces.resolveReadableWorkspace(workspaceId, input.actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持团队工作空间查看群聊')
    const limit = input.limit ?? 40
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw requestInvalid('limit 必须是 1 到 100 之间的整数')
    const cursor = input.before ? decodeTargetCursor(input.before) : null
    const sql = this.database
    const rows = await sql<TimelineRow[]>`
      with task_sessions as (
        select pt.session_id as session_id from project_tasks pt
         where pt.tenant_id = ${tenantId} and pt.workspace_id = ${workspaceId} and pt.session_id is not null
        union
        select e.session_id from project_task_events e
          join project_tasks pt on pt.tenant_id = e.tenant_id and pt.id = e.task_id
         where e.tenant_id = ${tenantId} and pt.workspace_id = ${workspaceId} and e.session_id is not null
      ),
      discussions as (
        select s.id, s.title from sessions s
         where s.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
           and s.audience = 'workbench' and s.status = 'active'
           and s.id not in (select session_id from task_sessions)
      ),
      tasks as (
        select pt.*, coalesce(au.display_name, wav.name, ag.name, 'Agent') as assignee_name
          from project_tasks pt
          left join users au on au.tenant_id = pt.tenant_id and au.id = pt.assignee_user_id
          left join workspace_agent_members wam on wam.tenant_id = pt.tenant_id and wam.id = pt.assignee_agent_member_id
          left join agent_versions wav on wav.tenant_id = wam.tenant_id and wav.id = wam.agent_version_id
          left join agents ag on ag.tenant_id = wam.tenant_id and ag.id = wam.agent_id
         where pt.tenant_id = ${tenantId} and pt.workspace_id = ${workspaceId}
      ),
      items as (
        select 'message'::text as kind, 'm:' || m.id as id, m.created_at as at,
               jsonb_build_object(
                 'sessionId', d.id, 'sessionTitle', d.title, 'role', m.role, 'content', m.content,
                 'senderId', coalesce(m.sender_user_id, r.requested_by), 'senderName', su.display_name,
                 'agentName', case when m.role = 'assistant' then mag.name end,
                 'runId', m.run_id, 'runRequesterName', ru.display_name,
                 'mentionedUserIds', array(select mm.mentioned_user_id from message_mentions mm
                    where mm.tenant_id = m.tenant_id and mm.message_id = m.id order by mm.mentioned_user_id),
                 -- 输入文件取该 Run 所有 Attempt 的去重并集（审批恢复的 Attempt 不重新登记输入文件）；
                 -- 同一会话更早的 Run 已用过的文件是跨轮延续带入的，不算本条发言发送。
                 'attachments', case when m.role = 'user' then (
                   select jsonb_agg(input.name order by input.at, input.name)
                     from (
                       select f.original_name as name, min(rif.created_at) as at
                         from run_input_files rif
                         join file_objects f on f.tenant_id = rif.tenant_id and f.id = rif.file_id
                        where rif.tenant_id = r.tenant_id and rif.run_id = r.id
                          and not exists (
                            select 1 from run_input_files earlier
                              join runs er on er.tenant_id = earlier.tenant_id and er.id = earlier.run_id
                             where earlier.tenant_id = rif.tenant_id and earlier.file_id = rif.file_id
                               and er.session_id = r.session_id and er.created_at < r.created_at
                          )
                        group by rif.file_id, f.original_name
                     ) input
                 ) end) as payload
          from messages m
          join discussions d on d.id = m.session_id
          left join runs r on r.tenant_id = m.tenant_id and r.id = m.run_id
          left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
          left join agent_versions mav on mav.tenant_id = m.tenant_id and mav.id = ra.manifest ->> 'agent_version_id'
          left join agents mag on mag.tenant_id = mav.tenant_id and mag.id = mav.agent_id
          left join users su on su.tenant_id = m.tenant_id and su.id = coalesce(m.sender_user_id, r.requested_by)
          left join users ru on ru.tenant_id = r.tenant_id and ru.id = r.requested_by
         where m.tenant_id = ${tenantId} and m.role in ('user', 'assistant')
        union all
        -- Run 在触发它的那条发言之前几毫秒创建；执行记录按“不早于触发发言”排序，始终显示在发言之后。
        select 'run', 'r:' || r.id, greatest(r.created_at, coalesce(trigger_message.created_at, r.created_at)),
               jsonb_build_object(
                 'sessionId', d.id, 'sessionTitle', d.title, 'runId', r.id, 'status', r.status,
                 'requesterName', ru.display_name, 'agentName', rag.name,
                 'stoppedByName', case when r.status = 'cancelled' then stopper.display_name end)
          from runs r
          join discussions d on d.id = r.session_id
          join users ru on ru.tenant_id = r.tenant_id and ru.id = r.requested_by
          left join users stopper on stopper.tenant_id = r.tenant_id and stopper.id = r.cancel_requested_by
          left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
          left join agent_versions rav on rav.tenant_id = r.tenant_id and rav.id = ra.manifest ->> 'agent_version_id'
          left join agents rag on rag.tenant_id = rav.tenant_id and rag.id = rav.agent_id
          left join lateral (
            select min(tm.created_at) as created_at from messages tm
             where tm.tenant_id = r.tenant_id and tm.run_id = r.id and tm.role = 'user'
          ) trigger_message on true
         where r.tenant_id = ${tenantId}
        union all
        select 'task', 'tc:' || t.id, t.created_at,
               jsonb_build_object('event', 'created', 'actorName', cu.display_name,
                 'viaAgentName', t.created_via ->> 'agentName',
                 'task', ${taskJson(sql)}, 'run', null, 'note', null)
          from tasks t
          left join users cu on cu.tenant_id = t.tenant_id and cu.id = t.created_by
        union all
        select 'task', 'tr:' || r.id, r.updated_at,
               jsonb_build_object('event', 'run_finished', 'actorName', ru.display_name,
                 'viaAgentName', null, 'task', ${taskJson(sql)},
                 'run', jsonb_build_object('id', r.id, 'status', r.status,
                   'scheduled', scheduled.id is not null,
                   'quiet', scheduled.id is not null and coalesce(btrim(reply.content), '') like '无变化%',
                   'summary', reply.content),
                 'note', null)
          from runs r
          join tasks t on t.session_id = r.session_id and t.assignee_type = 'agent'
          left join users ru on ru.tenant_id = r.tenant_id and ru.id = r.requested_by
          left join lateral (
            select e.id from project_task_events e
             where e.tenant_id = r.tenant_id and e.task_id = t.id and e.kind = 'scheduled_run'
               and e.metadata ->> 'runId' = r.id
             limit 1
          ) scheduled on true
          left join lateral (
            select rm.content from messages rm
             where rm.tenant_id = r.tenant_id and rm.run_id = r.id and rm.role = 'assistant'
             order by rm.created_at desc, rm.id desc
             limit 1
          ) reply on true
         where r.tenant_id = ${tenantId} and r.status in ('succeeded', 'failed', 'cancelled')
        union all
        select 'task', 'td:' || e.id, e.created_at,
               jsonb_build_object('event', e.kind, 'actorName', eu.display_name,
                 'viaAgentName', e.metadata #>> '{via,agentName}',
                 'task', ${taskJson(sql)}, 'run', null,
                 'note', case when e.kind = 'completed' then e.metadata ->> 'note' end,
                 'changes', case when e.kind = 'completed' then null else e.metadata - 'via' end)
          from project_task_events e
          join tasks t on t.id = e.task_id
          left join users eu on eu.tenant_id = e.tenant_id and eu.id = e.actor_user_id
         where e.tenant_id = ${tenantId}
           -- 群聊只显示任务完成，以及经 Agent 的编辑 / 改派 / 状态推进（S6 结果卡片）；人直接的
           -- 编辑、改派与执行自动推进的状态只在任务对话中显示。
           and (e.kind = 'completed'
             or (e.kind in ('edited', 'reassigned', 'status_changed') and e.metadata ? 'via'))
        union all
        select 'system', 'a:' || ae.id, ae.occurred_at,
               jsonb_build_object('activityKind', ae.kind, 'actorName', coalesce(au.display_name, '成员'),
                 'safeMetadata', ae.safe_metadata)
          from workspace_activity_events ae
          left join users au on au.tenant_id = ae.tenant_id and au.id = ae.actor_user_id
         where ae.tenant_id = ${tenantId} and ae.workspace_id = ${workspaceId}
           and ae.kind in ${sql([...timelineSystemKinds])}
        union all
        select 'system', 'w:' || w.id, w.created_at,
               jsonb_build_object('activityKind', 'workspace_created', 'actorName', coalesce(wu.display_name, '成员'),
                 'safeMetadata', '{}'::jsonb)
          from workspaces w
          left join users wu on wu.tenant_id = w.tenant_id and wu.id = w.created_by
         where w.tenant_id = ${tenantId} and w.id = ${workspaceId}
      )
      select kind, id, at, payload,
             to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorTimestamp"
        from items
       where ${cursor === null ? sql`true` : sql`(at, id) < (${cursor.lastActiveAt}::text::timestamptz, ${cursor.id})`}
       order by at desc, id desc
       limit ${limit + 1}
    `
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      workspaceId,
      items: page.map(toItem),
      nextCursor: rows.length > limit && last ? encodeTargetCursor(last.cursorTimestamp, last.kind, last.id) : null,
    }
  }
}

function taskJson(sql: DatabaseClient) {
  return sql`jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status,
    'assigneeType', t.assignee_type, 'assigneeName', t.assignee_name, 'schedule', t.schedule,
    'removed', t.removed_at is not null)`
}

function toItem(row: TimelineRow): WorkspaceTimelineItem {
  const at = row.at.toISOString()
  const payload = row.payload
  if (row.kind === 'task') {
    const run = payload['run'] as { summary?: string | null } | null
    return {
      kind: 'task',
      id: row.id,
      at,
      ...payload,
      run: run ? { ...run, summary: run.summary ? previewText(run.summary) : null } : null,
    } as WorkspaceTimelineItem
  }
  return { kind: row.kind, id: row.id, at, ...payload } as WorkspaceTimelineItem
}
