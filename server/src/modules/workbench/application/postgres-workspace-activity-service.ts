import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { authorizationDenied, requestInvalid } from '../../../domain/authorization-errors.ts'
import type { PostgresWorkspaceService } from './postgres-workspace-service.ts'
import type { WorkspaceActivityKind, WorkspaceActivityObjectType } from './workspace-activity-writer.ts'

const tenantId = 'tenant-dsh-work'

export interface WorkspaceActivityItem {
  id: string
  kind: WorkspaceActivityKind
  actorUserId: string
  actorDisplayName: string
  objectType: WorkspaceActivityObjectType
  objectId: string
  /** Minimal member-visible extras copied from the `safe_metadata` column. */
  safeMetadata: Record<string, unknown>
  occurredAt: string
}

export interface WorkspaceActivityPage {
  workspaceId: string
  items: WorkspaceActivityItem[]
  nextCursor: string | null
}

export interface WorkspaceNotificationView extends WorkspaceActivityPage {
  muted: boolean
  mutedAt: string | null
  lastReadAt: string | null
  unreadCount: number
}

export interface WorkspaceNotificationStateView {
  workspaceId: string
  muted: boolean
  mutedAt: string | null
  lastReadAt: string | null
  unreadCount: number
}

interface ActivityRow {
  id: string
  kind: WorkspaceActivityKind
  actorUserId: string
  actorDisplayName: string
  objectType: WorkspaceActivityObjectType
  objectId: string
  metadata: Record<string, unknown> | null
  occurredAt: Date
  /**
   * Full-precision (microsecond) transaction time. `occurred_at` comes back as
   * a JS Date (millisecond precision); using that truncated value in the keyset
   * cursor would skip or repeat rows whose timestamps differ only below the
   * millisecond, so the cursor is built from this DB text token instead.
   */
  occurredAtToken: string
}

interface NotificationStateRow {
  lastReadAt: Date | null
  lastReadAtToken: string | null
  mutedAt: Date | null
}

interface Cursor {
  occurredAt: string
  id: string
}

interface PageInput {
  workspaceId: string
  actorUserId: string
  cursor?: string
  limit?: number
}

/**
 * Team workspace activity feed and in-app notification state (batch 3 / 3-T7 /
 * TW-08).
 *
 * Visibility rule (plan §6.4 可见投影, AC-15): every read re-resolves the
 * workspace through the READ gate (`resolveReadableWorkspace`: archived team
 * workspaces stay readable for current members, personal workspaces are
 * rejected, non-members and nonexistent workspaces are indistinguishable). No
 * membership decision is cached, so a member removed after receiving a
 * notification cannot use its old id to read the feed, the item or the
 * notification list.
 */
export class PostgresWorkspaceActivityService {
  private readonly database: DatabaseClient
  private readonly workspaces: PostgresWorkspaceService

  constructor(database: DatabaseClient, workspaces: PostgresWorkspaceService) {
    this.database = database
    this.workspaces = workspaces
  }

  /** Activity feed, newest first, keyset paginated. */
  async listActivity(input: PageInput): Promise<WorkspaceActivityPage> {
    const workspaceId = await this.assertReadableTeamWorkspace(input.workspaceId, input.actorUserId)
    const { limit, cursor } = parsePage(input)
    const items = await this.readActivityPage({ workspaceId, cursor, limit, afterToken: null })
    return toPage(workspaceId, items, limit)
  }

  /**
   * Single activity item ("click through"). The re-validated membership gate
   * runs before the row is even looked up, and a missing/foreign id denies with
   * the same authorization error so ids from other workspaces do not enumerate.
   */
  async getActivityItem(input: {
    workspaceId: string
    activityId: string
    actorUserId: string
  }): Promise<WorkspaceActivityItem> {
    const workspaceId = await this.assertReadableTeamWorkspace(input.workspaceId, input.actorUserId)
    const [row] = await this.database<ActivityRow[]>`
      select e.id, e.kind, e.actor_user_id as "actorUserId", u.display_name as "actorDisplayName",
             e.object_type as "objectType", e.object_id as "objectId",
             e.safe_metadata as metadata, e.occurred_at as "occurredAt",
             e.occurred_at::text as "occurredAtToken"
        from workspace_activity_events e
        join users u on u.tenant_id = e.tenant_id and u.id = e.actor_user_id
       where e.tenant_id = ${tenantId} and e.workspace_id = ${workspaceId}
         and e.id = ${input.activityId}
    `
    if (!row) throw authorizationDenied('动态不存在或不可访问')
    return toItem(row)
  }

  /**
   * Unread notification list for the calling user.
   *
   * Unread = activity after `last_read_at` (absent state = everything unread).
   * Muting reports `unreadCount: 0` (no reminder) but does not hide items and
   * never affects the activity feed, matching TW-08「关闭提醒仍可在动态里看到」.
   */
  async getNotifications(input: PageInput): Promise<WorkspaceNotificationView> {
    const workspaceId = await this.assertReadableTeamWorkspace(input.workspaceId, input.actorUserId)
    const { limit, cursor } = parsePage(input)
    const state = await this.readNotificationState(workspaceId, input.actorUserId)
    const items = await this.readActivityPage({
      workspaceId,
      cursor,
      limit,
      afterToken: state.lastReadAtToken,
    })
    const unreadCount = state.mutedAt ? 0 : await this.countUnread(workspaceId, state.lastReadAtToken)
    return {
      ...toPage(workspaceId, items, limit),
      muted: state.mutedAt !== null,
      mutedAt: toIso(state.mutedAt),
      lastReadAt: toIso(state.lastReadAt),
      unreadCount,
    }
  }

  /** Marks every current activity as read by advancing `last_read_at` to now. */
  async markNotificationsRead(input: {
    workspaceId: string
    actorUserId: string
  }): Promise<WorkspaceNotificationStateView> {
    const workspaceId = await this.assertReadableTeamWorkspace(input.workspaceId, input.actorUserId)
    const [row] = await this.database<{ lastReadAt: Date; mutedAt: Date | null }[]>`
      insert into workspace_notification_states (
        tenant_id, workspace_id, user_id, last_read_at, muted_at
      ) values (
        ${tenantId}, ${workspaceId}, ${input.actorUserId}, now(), null
      )
      on conflict (tenant_id, workspace_id, user_id)
        do update set last_read_at = greatest(
          coalesce(workspace_notification_states.last_read_at, now()),
          now()
        )
      returning last_read_at as "lastReadAt", muted_at as "mutedAt"
    `
    return {
      workspaceId,
      muted: row?.mutedAt != null,
      mutedAt: toIso(row?.mutedAt ?? null),
      lastReadAt: toIso(row?.lastReadAt ?? null),
      unreadCount: 0,
    }
  }

  /** Per-workspace reminder switch. Muting keeps the feed and read state intact. */
  async setNotificationsMuted(input: {
    workspaceId: string
    actorUserId: string
    muted: boolean
  }): Promise<WorkspaceNotificationStateView> {
    const workspaceId = await this.assertReadableTeamWorkspace(input.workspaceId, input.actorUserId)
    const mutedAt = input.muted ? new Date() : null
    const [row] = await this.database<{
      lastReadAt: Date | null
      lastReadAtToken: string | null
      mutedAt: Date | null
    }[]>`
      insert into workspace_notification_states (
        tenant_id, workspace_id, user_id, last_read_at, muted_at
      ) values (
        ${tenantId}, ${workspaceId}, ${input.actorUserId}, null, ${mutedAt}
      )
      on conflict (tenant_id, workspace_id, user_id)
        do update set muted_at = ${mutedAt}
      returning last_read_at as "lastReadAt", last_read_at::text as "lastReadAtToken",
                muted_at as "mutedAt"
    `
    const muted = row?.mutedAt != null
    return {
      workspaceId,
      muted,
      mutedAt: toIso(row?.mutedAt ?? null),
      lastReadAt: toIso(row?.lastReadAt ?? null),
      unreadCount: muted ? 0 : await this.countUnread(workspaceId, row?.lastReadAtToken ?? null),
    }
  }

  // -------------------------------------------------------------------------
  // Shared reads
  // -------------------------------------------------------------------------

  /**
   * Read gate shared by every public method. It returns the workspace id after
   * the READ track accepted it (`resolveReadableWorkspace` re-reads current
   * membership on every call): archived team workspaces stay readable, personal
   * workspaces get the established team-only 422, and non-members share the
   * nonexistent-workspace denial.
   */
  private async assertReadableTeamWorkspace(rawWorkspaceId: string, actorUserId: string): Promise<string> {
    const workspaceId = rawWorkspaceId?.trim()
    // An empty id — and the `standalone` sentinel, which `normalizeWorkspaceId` maps to
    // null the same way — would make resolveReadableWorkspace fall back to the caller's
    // personal workspace, whose lookup calls `ensurePersonalWorkspace()` and therefore
    // WRITES on a GET (adversarial review P2 measured `GET /workspaces/standalone/...`
    // creating a personal workspace + membership before the 422). Reject both values
    // before any workspace resolution.
    if (!workspaceId || workspaceId === 'standalone') {
      throw requestInvalid('仅支持团队工作空间查看团队动态')
    }
    const access = await this.workspaces.resolveReadableWorkspace(workspaceId, actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持团队工作空间查看团队动态')
    return workspaceId
  }

  private async readActivityPage(input: {
    workspaceId: string
    cursor: Cursor | null
    limit: number
    afterToken: string | null
  }): Promise<ActivityRow[]> {
    return this.runCursorQuery(() => this.database<ActivityRow[]>`
      select e.id, e.kind, e.actor_user_id as "actorUserId", u.display_name as "actorDisplayName",
             e.object_type as "objectType", e.object_id as "objectId",
             e.safe_metadata as metadata, e.occurred_at as "occurredAt",
             e.occurred_at::text as "occurredAtToken"
        from workspace_activity_events e
        join users u on u.tenant_id = e.tenant_id and u.id = e.actor_user_id
       where e.tenant_id = ${tenantId} and e.workspace_id = ${input.workspaceId}
         and ${input.afterToken === null
           ? this.database`true`
           // 双重转换：先 ::text 让驱动按字符串原样发送（否则 postgres.js 会把
           // timestamptz 参数折成毫秒精度），再在库内解析为 timestamptz。
           : this.database`e.occurred_at > (${input.afterToken}::text)::timestamptz`}
         and ${input.cursor === null
           ? this.database`true`
           : this.database`(e.occurred_at, e.id) < ((${input.cursor.occurredAt}::text)::timestamptz, ${input.cursor.id}::text)`}
       order by e.occurred_at desc, e.id desc
       limit ${input.limit + 1}
    `)
  }

  private async countUnread(workspaceId: string, afterToken: string | null): Promise<number> {
    const [row] = await this.runCursorQuery(() => this.database<{ count: number }[]>`
      select count(*)::integer as count
        from workspace_activity_events e
       where e.tenant_id = ${tenantId} and e.workspace_id = ${workspaceId}
         and ${afterToken === null
           ? this.database`true`
           : this.database`e.occurred_at > (${afterToken}::text)::timestamptz`}
    `)
    return row?.count ?? 0
  }

  /**
   * Cursor tokens are attacker-controlled text that reaches the database inside
   * a `::timestamptz` / `::text` cast. A well-formed base64 cursor can still
   * carry a non-timestamp (`{"t":"garbage"}`), an impossible date, an embedded
   * NUL or invalid UTF-8, and PostgreSQL answers with 22007/22008/22021/22P02
   * instead of a row — which the router would classify as a 500 infrastructure
   * failure. Translate exactly those codes into the contractual typed 422; any
   * other error is a real failure and keeps propagating. `decodeActivityCursor`
   * already rejects the cheap shapes (empty, NUL), this covers the rest.
   */
  private async runCursorQuery<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (isInvalidCursorTokenError(error)) throw requestInvalid('分页游标无效')
      throw error
    }
  }

  private async readNotificationState(
    workspaceId: string,
    actorUserId: string,
  ): Promise<{ lastReadAt: Date | null; lastReadAtToken: string | null; mutedAt: Date | null }> {
    const [row] = await this.database<NotificationStateRow[]>`
      select last_read_at as "lastReadAt", last_read_at::text as "lastReadAtToken",
             muted_at as "mutedAt"
        from workspace_notification_states
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
         and user_id = ${actorUserId}
    `
    return {
      lastReadAt: row?.lastReadAt ?? null,
      lastReadAtToken: row?.lastReadAtToken ?? null,
      mutedAt: row?.mutedAt ?? null,
    }
  }
}

function parsePage(input: PageInput): { limit: number; cursor: Cursor | null } {
  const limit = input.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw requestInvalid('limit 必须为 1 到 100 之间的整数')
  }
  return { limit, cursor: input.cursor ? decodeActivityCursor(input.cursor) : null }
}

function toPage(workspaceId: string, rows: ActivityRow[], limit: number): WorkspaceActivityPage {
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    workspaceId,
    items: page.map(toItem),
    nextCursor: hasMore && last ? encodeActivityCursor(last.occurredAtToken, last.id) : null,
  }
}

function toItem(row: ActivityRow): WorkspaceActivityItem {
  return {
    id: row.id,
    kind: row.kind,
    actorUserId: row.actorUserId,
    actorDisplayName: row.actorDisplayName,
    objectType: row.objectType,
    objectId: row.objectId,
    // safe_metadata is written by our own emitters; never spread an unknown row
    // shape into the response.
    safeMetadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    occurredAt: row.occurredAt.toISOString(),
  }
}

function encodeActivityCursor(occurredAtToken: string, id: string) {
  return Buffer.from(JSON.stringify({ t: occurredAtToken, i: id }), 'utf8').toString('base64url')
}

function decodeActivityCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown }
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') throw new Error('bad cursor')
    // Cheap shape guards before the value ever reaches a database cast: empty
    // tokens and embedded NULs are invalid by construction (we always encode a
    // DB-side timestamp text and an id), and the length caps stop a huge token
    // from being echoed into the query at all.
    if (!parsed.t.trim() || !parsed.i.trim()) throw new Error('bad cursor')
    if (parsed.t.includes('\u0000') || parsed.i.includes('\u0000')) throw new Error('bad cursor')
    if (parsed.t.length > 64 || parsed.i.length > 128) throw new Error('bad cursor')
    return { occurredAt: parsed.t, id: parsed.i }
  } catch {
    throw requestInvalid('分页游标无效')
  }
}

/**
 * PostgreSQL error codes a malformed cursor can produce inside the timestamp
 * cast: 22007 invalid_datetime_format, 22008 datetime_field_overflow,
 * 22021 character_not_in_repertoire (NUL / invalid UTF-8), 22P02
 * invalid_text_representation. Reviewed probes: `{"t":"garbage"}`, `t:""`,
 * `2026-13-45 99:99:99` and a NUL in `i` all reached the cast and produced an
 * unhandled 500 before this translation existed.
 */
const INVALID_CURSOR_SQLSTATE = new Set(['22007', '22008', '22021', '22P02'])

function isInvalidCursorTokenError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return INVALID_CURSOR_SQLSTATE.has(String((error as { code?: unknown }).code))
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}
