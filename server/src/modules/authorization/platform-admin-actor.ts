import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { authorizationDenied } from '../../domain/authorization-errors.ts'

const tenantId = 'tenant-dsh-work'

export interface PlatformAdminActor {
  id: string
  displayName: string
  department: string
}

/**
 * 平台管理员的唯一判定口径（F-04）：用户与租户均有效，并持有本地授予（source_key = 'local'）、
 * 处于有效期内的启用角色，且角色含 admin:* 或 admin:write。外部目录同步的角色不能授予平台管理权限。
 * 授权服务、Agent 服务与发布服务必须共用本函数，不再各自维护查询。
 */
export async function requirePlatformAdminActor(
  sql: DatabaseClient | DatabaseTransaction,
  userId: string,
): Promise<PlatformAdminActor> {
  const [actor] = await platformAdminActors(sql, { userId })
  if (!actor) throw authorizationDenied(`操作人不存在、已停用或不是平台管理员：${userId}`)
  return actor
}

/** 按同一判定口径取一位平台管理员（平台预置等无请求身份的场景），优先 `preferredUserId`；没有时返回 undefined。 */
export async function findPlatformAdminActor(
  sql: DatabaseClient | DatabaseTransaction,
  preferredUserId: string,
): Promise<PlatformAdminActor | undefined> {
  const [actor] = await platformAdminActors(sql, { preferredUserId })
  return actor
}

function platformAdminActors(
  sql: DatabaseClient | DatabaseTransaction,
  filter: { userId: string } | { preferredUserId: string },
) {
  const userId = 'userId' in filter ? filter.userId : null
  const preferredUserId = 'preferredUserId' in filter ? filter.preferredUserId : null
  return sql<PlatformAdminActor[]>`
    select u.id, u.display_name as "displayName", coalesce(u.department_id, '未分配部门') as department
      from users u
     where u.tenant_id = ${tenantId} and (${userId}::text is null or u.id = ${userId}) and u.status = 'active'
       and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
       and exists (
         select 1 from user_roles ur
         join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
          where ur.tenant_id = u.tenant_id and ur.user_id = u.id
            and ur.source_key = 'local' and r.status = 'active'
            and (ur.valid_until is null or ur.valid_until > now())
            and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
       )
     order by (u.id = ${preferredUserId}::text) desc nulls last, u.created_at, u.id
     limit 1
  `
}
