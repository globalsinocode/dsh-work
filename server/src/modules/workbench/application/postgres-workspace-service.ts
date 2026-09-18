import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { authorizationDenied } from '../../authorization/authorization-errors.ts'

const tenantId = 'tenant-dsh-work'

export type WorkspaceType = 'personal' | 'team'

export interface AccessibleWorkspace {
  id: string
  type: WorkspaceType
}

export class PostgresWorkspaceService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async ensurePersonalWorkspace(userId: string): Promise<AccessibleWorkspace> {
    const proposedId = personalWorkspaceIdFor(userId)
    await this.database`
      insert into workspaces (
        id, tenant_id, name, description, workspace_type, created_by, status
      )
      select ${proposedId}, u.tenant_id, '我的空间',
             '仅你可访问的默认工作空间，用于归档个人对话、文件和成果。',
             'personal', u.id, 'active'
        from users u
        join tenants t on t.id = u.tenant_id and t.status = 'active'
       where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
      on conflict do nothing
    `

    const [workspace] = await this.database<{ id: string }[]>`
      select id from workspaces
       where tenant_id = ${tenantId} and workspace_type = 'personal'
         and created_by = ${userId} and status = 'active'
       order by created_at asc
       limit 1
    `
    if (!workspace) throw new Error('当前用户不存在、已停用或无法创建个人工作空间')

    await this.database`
      insert into workspace_members (
        tenant_id, workspace_id, user_id, member_role, added_by
      ) values (
        ${tenantId}, ${workspace.id}, ${userId}, 'owner', ${userId}
      )
      on conflict (tenant_id, workspace_id, user_id) do update
        set member_role = 'owner', added_by = excluded.added_by
    `
    return { id: workspace.id, type: 'personal' }
  }

  /**
   * Execution-track resolver (the default for every caller): an archived
   * workspace is rejected, even for its owner. Session creation, uploads and
   * logical file removal all resolve through here on purpose (3-T1).
   */
  async resolveAccessibleWorkspace(
    requestedWorkspaceId: string | null | undefined,
    userId: string,
  ): Promise<AccessibleWorkspace> {
    return this.resolveWorkspace(requestedWorkspaceId, userId, { allowArchived: false })
  }

  /**
   * Read-track resolver (batch 3 / 3-T1 归档 = 只读保留): current members keep
   * read/list access to an archived team workspace. Opt-in per call site —
   * read paths pass `allowArchived: true`, execution paths use
   * `resolveAccessibleWorkspace` and keep failing closed.
   *
   * Non-members and nonexistent workspaces deny with the same wording as the
   * execution track, so an archived workspace stays non-enumerable.
   */
  async resolveReadableWorkspace(
    requestedWorkspaceId: string | null | undefined,
    userId: string,
  ): Promise<AccessibleWorkspace> {
    return this.resolveWorkspace(requestedWorkspaceId, userId, { allowArchived: true })
  }

  private async resolveWorkspace(
    requestedWorkspaceId: string | null | undefined,
    userId: string,
    options: { allowArchived: boolean },
  ): Promise<AccessibleWorkspace> {
    const workspaceId = normalizeWorkspaceId(requestedWorkspaceId)
    if (!workspaceId) return this.ensurePersonalWorkspace(userId)

    const [workspace] = await this.database<{ id: string; type: WorkspaceType }[]>`
      select w.id, w.workspace_type as type
        from workspaces w
       where w.tenant_id = ${tenantId} and w.id = ${workspaceId}
         and ${options.allowArchived
           ? this.database.unsafe(`w.status in ('active', 'archived')`)
           : this.database.unsafe(`w.status = 'active'`)}
         and (
           (w.workspace_type = 'personal' and w.created_by = ${userId})
           or (
             w.workspace_type = 'team'
             and exists (
               select 1 from workspace_members wm
                where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
                  and wm.user_id = ${userId}
             )
           )
         )
    `
    if (!workspace) throw authorizationDenied('工作空间不存在、已归档或当前用户无权访问')
    return workspace
  }
}

export function personalWorkspaceIdFor(userId: string) {
  return `ws-personal-${userId}`
}

function normalizeWorkspaceId(workspaceId: string | null | undefined) {
  const normalized = workspaceId?.trim()
  return normalized && normalized !== 'standalone' ? normalized : null
}

/** Shared SQL read predicate for alias `w`. It is a resource boundary, not a
 * replacement for HTTP/function permission checks. No caller-controlled SQL. */
export function readableWorkspacePredicate(sql: DatabaseClient, userId: string) {
  return sql`w.status in ('active', 'archived')
    and exists (select 1 from users actor join tenants tenant on tenant.id = actor.tenant_id
      where actor.tenant_id = w.tenant_id and actor.id = ${userId}
        and actor.status = 'active' and tenant.status = 'active')
    and ((w.workspace_type = 'personal' and w.created_by = ${userId})
      or (w.workspace_type = 'team' and exists (
        select 1 from workspace_members access_member
         where access_member.tenant_id = w.tenant_id and access_member.workspace_id = w.id
           and access_member.user_id = ${userId})))`
}
