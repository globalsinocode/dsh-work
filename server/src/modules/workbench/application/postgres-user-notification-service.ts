import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { requestInvalid } from '../../../domain/authorization-errors.ts'
import { notFound } from '../../../domain/request-errors.ts'
import { readableWorkspacePredicate } from './postgres-workspace-service.ts'
import type { UserNotificationKind, UserNotificationObjectType } from '../../notification/user-notification-writer.ts'

const tenantId = 'tenant-dsh-work'

/** 方案 NC4：只保留最近 90 天的通知；更早的不再列出、不计未读，并由每日清扫删除（NC-S4）。 */
const retentionDays = 90
/** 每批删除条数：分批提交，避免一次长事务锁住大量行。 */
const purgeBatchSize = 1000

export interface UserNotificationItem {
  id: string
  kind: UserNotificationKind
  createdAt: string
  read: boolean
  /**
   * 接收人当前是否仍能看到通知对应的内容。为 false 时不返回任何名称与跳转目标，
   * 界面显示“该内容已不可见”（方案第 7 节：失权后不能经旧通知看到名称）。
   */
  visible: boolean
  actor: { id: string; name: string } | null
  workspace: { id: string; name: string } | null
  /** 对象名称：任务标题、定时任务名称或提交的 Skill 名称；@ 与被加入项目没有单独的对象名称。 */
  objectName: string | null
  /**
   * 事件的代码值（NC-S3）：定时执行的 `state`（paused/stopped）与 `reason`、定时任务的
   * `outcome`（failed/skipped/missed/interrupted）、Skill 审核的 `result`（approved/rejected）。
   */
  detail: Record<string, string> | null
  target: { type: UserNotificationObjectType; id: string; sessionId: string | null } | null
}

/** 允许返回给员工的事件代码；`safe_metadata` 中的其他键（如执行 ID）不对外。 */
const detailKeys = ['state', 'reason', 'outcome', 'result'] as const
// 钉钉绑定通知（DT-S1）：`reason` 为 admin_unbind / rebound_to_other；钉钉姓名取自绑定记录作为 objectName。

export interface UserNotificationPage {
  items: UserNotificationItem[]
  nextCursor: string | null
}

interface NotificationRow {
  id: string
  kind: UserNotificationKind
  createdAtToken: string
  createdAt: Date
  readAt: Date | null
  visible: boolean
  actorUserId: string | null
  actorName: string | null
  workspaceId: string | null
  workspaceName: string | null
  objectType: UserNotificationObjectType
  objectId: string
  objectName: string | null
  sessionId: string | null
  metadata: Record<string, unknown>
}

/**
 * 站内通知（方案 NC-S1）：本人的通知列表、未读数与已读。只读写接收人本人的记录；
 * 每次读取按接收人当前权限重新判断可见性并解析名称，通知本身不是授权依据。
 */
export class PostgresUserNotificationService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async list(input: { userId: string; status?: string | null; cursor?: string | null; limit?: number }): Promise<UserNotificationPage> {
    const status = input.status ?? 'all'
    if (status !== 'all' && status !== 'unread') throw requestInvalid('status 必须为 all 或 unread')
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw requestInvalid('limit 必须为 1 到 50 之间的整数')
    const cursor = input.cursor ? decodeCursor(input.cursor) : null
    const sql = this.database
    const rows = await sql<NotificationRow[]>`
      select n.id, n.kind, n.created_at::text as "createdAtToken", n.created_at as "createdAt", n.read_at as "readAt",
             v.visible, n.actor_user_id as "actorUserId", actor.display_name as "actorName",
             n.workspace_id as "workspaceId", w.name as "workspaceName",
             n.object_type as "objectType", n.object_id as "objectId",
             coalesce(pt.title, au.name, ss.name, eb.external_display_name) as "objectName",
             coalesce(n.safe_metadata ->> 'sessionId', ss.session_id) as "sessionId",
             n.safe_metadata as metadata
        from user_notifications n
        ${visibilityJoins(sql, input.userId)}
       where n.tenant_id = ${tenantId} and n.recipient_user_id = ${input.userId}
         and n.created_at > now() - make_interval(days => ${retentionDays})
         and ${status === 'unread' ? countsAsUnread(sql) : sql`true`}
         and ${cursor === null ? sql`true` : sql`(n.created_at, n.id) < ((${cursor.at}::text)::timestamptz, ${cursor.id})`}
       order by n.created_at desc, n.id desc
       limit ${limit + 1}
    `
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      items: page.map(toItem),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAtToken, last.id) : null,
    }
  }

  /** 未读数：在保留期内、计入未读（见 `countsAsUnread`）的通知，与“未读”页签同一口径。 */
  async unreadCount(userId: string): Promise<{ unread: number }> {
    const sql = this.database
    const [row] = await sql<Array<{ unread: number }>>`
      select count(*)::integer as unread
        from user_notifications n
        ${visibilityJoins(sql, userId)}
       where n.tenant_id = ${tenantId} and n.recipient_user_id = ${userId}
         and n.created_at > now() - make_interval(days => ${retentionDays})
         and ${countsAsUnread(sql)}
    `
    return { unread: Number(row?.unread ?? 0) }
  }

  async markRead(userId: string, notificationId: string): Promise<{ id: string; read: true }> {
    const sql = this.database
    const [row] = await sql<Array<{ id: string }>>`
      with marked as (
        update user_notifications set read_at = coalesce(read_at, now())
         where tenant_id = ${tenantId} and recipient_user_id = ${userId} and id = ${notificationId}
        returning id, kind, object_id
      ), ${mentionsReadWith(sql, userId)}
      select id from marked
    `
    if (!row) throw notFound('通知不存在')
    return { id: row.id, read: true }
  }

  /**
   * 保留清扫（NC-S4）：删除超过保留期的通知，与已读未读无关。分批删除、可重复执行；多个实例同时执行
   * 时跳过对方锁住的行，各删各的批次。一直删到某一批没有可删的为止（被锁的行留到下次）。只删通知记录，
   * 不动 @ 提醒等业务数据。默认用数据库时间，与读取侧的保留期判断同一时钟；测试可传入时间。
   */
  async purgeExpired(now?: Date): Promise<{ removed: number }> {
    const sql = this.database
    const cutoff = now
      ? sql`${now}::timestamptz - make_interval(days => ${retentionDays})`
      : sql`now() - make_interval(days => ${retentionDays})`
    let removed = 0
    for (;;) {
      const rows = await sql<Array<{ id: string }>>`
        delete from user_notifications
         where id in (
           select id from user_notifications
            where tenant_id = ${tenantId} and created_at <= ${cutoff}
            order by created_at
            limit ${purgeBatchSize}
            for update skip locked
         )
        returning id
      `
      removed += rows.length
      if (rows.length === 0) return { removed }
    }
  }

  /** 全部标为已读：只标保留期内的通知（看不到的过期通知不计入，也不与清扫争锁）。 */
  async markAllRead(userId: string): Promise<{ read: number }> {
    const sql = this.database
    const rows = await sql<Array<{ id: string }>>`
      with marked as (
        update user_notifications set read_at = now()
         where tenant_id = ${tenantId} and recipient_user_id = ${userId} and read_at is null
           and created_at > now() - make_interval(days => ${retentionDays})
        returning id, kind, object_id
      ), ${mentionsReadWith(sql, userId)}
      select id from marked
    `
    return { read: rows.length }
  }
}

/**
 * 已读的 @ 通知同步到 `message_mentions`（方案 NC4），使群组“[有人@我]”标记一并消失。接在名为
 * `marked`（含 `kind`、`object_id`）的 CTE 之后；与通知更新同一条语句，两者一起提交。
 */
function mentionsReadWith(sql: DatabaseClient, userId: string) {
  return sql`mentions_read as (
    update message_mentions mm set read_at = now()
      from marked
     where marked.kind = 'mention' and mm.tenant_id = ${tenantId} and mm.mentioned_user_id = ${userId}
       and mm.message_id = marked.object_id and mm.read_at is null
  )`
}

/**
 * 计入未读（未读数与“未读”页签同一口径）：未读、仍可见；静音空间的通知照常列出但不计未读，
 * @ 我不受静音影响（方案 NC5，与 D38 一致）。依赖 `visibilityJoins` 产出的 `v` 与 `ns`。
 */
function countsAsUnread(sql: DatabaseClient) {
  return sql`(n.read_at is null and v.visible and (n.kind = 'mention' or ns.muted_at is null))`
}

/**
 * 读取时的可见性：所在项目空间仍对本人可读（现任成员、账号有效）；任务未被删除；@ 所在的会话仍有效；
 * 定时任务未停用且仍归本人；Skill 提交仍归本人。别名 `n` 是通知行，产出 `w`、`pt`、`au`、`ss`、
 * `actor`、静音状态 `ns` 与布尔列 `v.visible`。
 */
function visibilityJoins(sql: DatabaseClient, userId: string) {
  return sql`
    left join workspaces w on w.tenant_id = n.tenant_id and w.id = n.workspace_id
    left join project_tasks pt on n.object_type = 'project_task'
      and pt.tenant_id = n.tenant_id and pt.id = n.object_id and pt.workspace_id = n.workspace_id
      and pt.removed_at is null
    left join messages m on n.object_type = 'message' and m.tenant_id = n.tenant_id and m.id = n.object_id
    left join sessions s on s.tenant_id = m.tenant_id and s.id = m.session_id
      and s.workspace_id = n.workspace_id and s.status = 'active'
    left join agent_automations au on n.object_type = 'automation'
      and au.tenant_id = n.tenant_id and au.id = n.object_id
      and au.owner_user_id = n.recipient_user_id and au.status <> 'disabled'
    left join skill_submissions ss on n.object_type = 'skill_submission'
      and ss.tenant_id = n.tenant_id and ss.id = n.object_id and ss.submitter_user_id = n.recipient_user_id
    left join external_account_bindings eb on n.object_type = 'dingtalk_binding'
      and eb.tenant_id = n.tenant_id and eb.id = n.object_id
    left join users actor on actor.tenant_id = n.tenant_id and actor.id = n.actor_user_id
    left join workspace_notification_states ns
      on ns.tenant_id = n.tenant_id and ns.workspace_id = n.workspace_id and ns.user_id = n.recipient_user_id
    cross join lateral (select (
      (n.workspace_id is null or (w.id is not null and (${readableWorkspacePredicate(sql, userId)})))
      and (n.object_type <> 'project_task' or pt.id is not null)
      and (n.object_type <> 'message' or s.id is not null)
      and (n.object_type <> 'automation' or au.id is not null)
      and (n.object_type <> 'skill_submission' or ss.id is not null)
    ) as visible) v
  `
}

function toItem(row: NotificationRow): UserNotificationItem {
  const base = { id: row.id, kind: row.kind, createdAt: row.createdAt.toISOString(), read: row.readAt !== null }
  if (!row.visible) return { ...base, visible: false, actor: null, workspace: null, objectName: null, detail: null, target: null }
  const detail = Object.fromEntries(detailKeys.flatMap(key => {
    const value = row.metadata[key]
    return typeof value === 'string' ? [[key, value]] : []
  }))
  return {
    ...base,
    visible: true,
    actor: row.actorUserId ? { id: row.actorUserId, name: row.actorName ?? '' } : null,
    workspace: row.workspaceId ? { id: row.workspaceId, name: row.workspaceName ?? '' } : null,
    objectName: row.objectName,
    detail: Object.keys(detail).length ? detail : null,
    target: { type: row.objectType, id: row.objectId, sessionId: row.sessionId },
  }
}

function encodeCursor(createdAtToken: string, id: string) {
  return Buffer.from(JSON.stringify({ at: createdAtToken, id }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    if (cursor.length > 512) throw new Error('length')
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown }
    if (typeof parsed.at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(parsed.at) || parsed.at.length > 64
      || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 160) throw new Error('shape')
    return { at: parsed.at, id: parsed.id }
  } catch {
    throw requestInvalid('无效的分页游标')
  }
}
