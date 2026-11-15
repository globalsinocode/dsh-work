import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { authorizationDenied } from '../../domain/authorization-errors.ts'
import {
  ADMIN_MODULE_LABELS,
  acceptedAdminPermissions,
  ALL_MODULES_WRITE_PERMISSION,
  missingDataScopes,
  missingPermissions,
  moduleAdministrationPermissions,
  PLATFORM_ADMIN_PERMISSION,
  type AdminLevel,
  type AdminModule,
} from '../../domain/admin-permissions.ts'

const tenantId = 'tenant-dsh-work'

export interface AdminActor {
  id: string
  displayName: string
  department: string
}

type Sql = DatabaseClient | DatabaseTransaction

/**
 * 服务层管理判定的唯一实现（管理端模块权限方案 5.1、第 6 节）：用户与租户均有效，并持有
 * **本地授予**（`source_key = 'local'`）、有效期内的启用角色，且角色含 `codes` 之一。
 * 部门授予与外部目录同步的角色不能构成管理权限。
 */
function adminActors(sql: Sql, codes: string[], filter: { userId: string } | { preferredUserId: string }, businessUserOnly = false) {
  const userId = 'userId' in filter ? filter.userId : null
  const preferredUserId = 'preferredUserId' in filter ? filter.preferredUserId : null
  return sql<AdminActor[]>`
    select u.id, u.display_name as "displayName", coalesce(u.department_id, '未分配部门') as department
      from users u
     where u.tenant_id = ${tenantId} and (${userId}::text is null or u.id = ${userId}) and u.status = 'active'
       and (${!businessUserOnly}::boolean or u.business_user)
       and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
       and exists (
         select 1 from user_roles ur
         join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
          where ur.tenant_id = u.tenant_id and ur.user_id = u.id
            and ur.source_key = 'local' and r.status = 'active'
            and (ur.valid_until is null or ur.valid_until > now())
            and r.permissions ?| ${codes}::text[]
       )
     order by (u.id = ${preferredUserId}::text) desc nulls last, u.created_at, u.id
     limit 1
  `
}

/** 要求操作人持有某模块的查看或修改权限（`admin:*`、`admin:read|write` 视为全部模块）。 */
export async function requireAdminModuleActor(sql: Sql, userId: string, module: AdminModule, level: AdminLevel): Promise<AdminActor> {
  const [actor] = await adminActors(sql, acceptedAdminPermissions(module, level), { userId })
  if (!actor) {
    throw authorizationDenied(`操作人不存在、已停用或没有${ADMIN_MODULE_LABELS[module]}的${level === 'write' ? '修改' : '查看'}权限：${userId}`)
  }
  return actor
}

/** 要求操作人能使用管理端模块功能或管理助手（持有任一模块管理权限）。 */
export async function requireAdminAccessActor(sql: Sql, userId: string): Promise<AdminActor> {
  const [actor] = await adminActors(sql, moduleAdministrationPermissions(), { userId })
  if (!actor) throw authorizationDenied(`操作人不存在、已停用或没有管理权限：${userId}`)
  return actor
}

/** 平台管理员专属范围（员工与权限、独立账号、钉钉集成）：只认本地授予的 `admin:*`，且须为业务员工。 */
export async function requirePlatformAdminOnly(sql: Sql, userId: string, message = '只有平台管理员可以执行该操作'): Promise<AdminActor> {
  const [actor] = await adminActors(sql, [PLATFORM_ADMIN_PERMISSION], { userId }, true)
  if (!actor) throw authorizationDenied(message)
  return actor
}

/**
 * 本地授予的 `admin:*`，与模块判定 `requireAdminModuleActor` 同一口径（不要求业务员工：
 * 初始化的平台管理员可以不是业务员工）。只有钉钉与独立账号沿用原有的业务员工要求，见 `requirePlatformAdminOnly`。
 */
export async function isPlatformAdminActor(sql: Sql, userId: string): Promise<boolean> {
  const [actor] = await adminActors(sql, [PLATFORM_ADMIN_PERMISSION], { userId })
  return Boolean(actor)
}

/**
 * 按全模块修改口径取一位管理员（平台预置等无请求身份的后台场景），优先 `preferredUserId`；没有时返回 undefined。
 * 不属于请求授权，不按模块收窄（方案第 6 节）。
 */
export async function findPlatformAdminActor(sql: Sql, preferredUserId: string): Promise<AdminActor | undefined> {
  const [actor] = await adminActors(sql, [PLATFORM_ADMIN_PERMISSION, ALL_MODULES_WRITE_PERMISSION], { preferredUserId })
  return actor
}

/** 本地授予、有效期内的启用角色上的权限码（管理判定只认这些），用于按模块过滤读取结果。 */
export async function loadLocalAdminPermissions(sql: Sql, userId: string): Promise<string[]> {
  const [row] = await sql<{ permissions: string[] }[]>`
    select coalesce(array_agg(distinct permission.value) filter (where permission.value is not null), '{}') as permissions
      from users u
      join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.source_key = 'local'
        and (ur.valid_until is null or ur.valid_until > now())
      join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.status = 'active'
      cross join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value)
     where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
     group by u.id
  `
  return row?.permissions ?? []
}

export interface GrantCeiling {
  platformAdmin: boolean
  permissions: string[]
  dataScopes: string[]
}

/**
 * 操作人自身的授权上限（方案 AP5、5.3）：当前全部有效角色（本地与部门授予）的权限码并集，
 * 以及授予本人或这些角色的数据范围。与会话层 `resolveAuthorization` 同一口径，在调用方事务内计算。
 */
export async function loadGrantCeiling(sql: Sql, userId: string): Promise<GrantCeiling> {
  const [row] = await sql<{ permissions: string[]; dataScopes: string[] }[]>`
    select coalesce(array_agg(distinct permission.value) filter (where permission.value is not null), '{}') as permissions,
           coalesce(array_agg(distinct dsg.scope_value) filter (where dsg.scope_value is not null), '{}') as "dataScopes"
      from users u
      left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
        and (ur.source_key = 'local' or ur.source_key like 'department:%')
        and (ur.valid_until is null or ur.valid_until > now())
      left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.status = 'active'
      left join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value) on true
      left join data_scope_grants dsg on dsg.tenant_id = u.tenant_id
        and ((dsg.subject_type = 'user' and dsg.subject_id = u.id) or (dsg.subject_type = 'role' and dsg.subject_id = r.id))
     where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
     group by u.id
  `
  const platformAdmin = await isPlatformAdminActor(sql, userId)
  return {
    platformAdmin,
    // 平台管理员只按本地授予判定：非本地来源的 `admin:*` 不能让子集比较全部放行。
    permissions: (row?.permissions ?? []).filter(code => platformAdmin || code !== PLATFORM_ADMIN_PERMISSION),
    dataScopes: row?.dataScopes ?? [],
  }
}

/** 角色的权限码与授予该角色的数据范围（用于判断授出这些角色是否超出操作人）。 */
export async function loadRoleGrants(sql: Sql, roleIds: string[], options: { includeDisabled?: boolean } = {}): Promise<{ permissions: string[]; dataScopes: string[] }> {
  if (!roleIds.length) return { permissions: [], dataScopes: [] }
  const includeDisabled = options.includeDisabled ?? false
  const [row] = await sql<{ permissions: string[]; dataScopes: string[] }[]>`
    select coalesce((select array_agg(distinct permission.value)
                       from roles r, jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value)
                      where r.tenant_id = ${tenantId} and r.id = any(${roleIds}::text[]) and (${includeDisabled}::boolean or r.status = 'active')), '{}') as permissions,
           coalesce((select array_agg(distinct dsg.scope_value)
                       from data_scope_grants dsg
                      where dsg.tenant_id = ${tenantId} and dsg.subject_type = 'role' and dsg.subject_id = any(${roleIds}::text[])), '{}') as "dataScopes"
  `
  return { permissions: row?.permissions ?? [], dataScopes: row?.dataScopes ?? [] }
}

/**
 * 授出不超过自身（方案 AP5）：非平台管理员授出的权限码与数据范围须是自身子集，否则拒绝并列出缺少的部分。
 * 平台管理员直接放行。
 */
export function assertWithinGrantCeiling(
  ceiling: GrantCeiling,
  granted: { permissions?: string[]; dataScopes?: string[] },
  subject: string,
) {
  if (ceiling.platformAdmin) return
  const permissions = missingPermissions(granted.permissions ?? [], ceiling.permissions)
  const scopes = missingDataScopes(granted.dataScopes ?? [], ceiling.dataScopes)
  if (!permissions.length && !scopes.length) return
  const parts = [
    permissions.length ? `权限 ${permissions.join('、')}` : '',
    scopes.length ? `数据范围 ${scopes.join('、')}` : '',
  ].filter(Boolean)
  throw authorizationDenied(`${subject}超出了你自己的授权：缺少${parts.join('，')}。请联系平台管理员处理`)
}

/**
 * 某员工持有的权限与数据范围，**不看账号是否停用**：停用的平台管理员被重新启用后会立即恢复权限，
 * 判断能否操作这个账号时必须按它持有的授权算（管理端模块权限方案 AP13 ④）。
 */
async function loadHeldGrants(sql: Sql, userId: string): Promise<HeldGrants> {
  return (await loadHeldGrantsForUsers(sql, [userId])).get(userId) ?? { platformAdmin: false, permissions: [], dataScopes: [] }
}

interface HeldGrants { platformAdmin: boolean; permissions: string[]; dataScopes: string[] }

async function loadHeldGrantsForUsers(sql: Sql, userIds: string[]): Promise<Map<string, HeldGrants>> {
  if (!userIds.length) return new Map()
  const rows = await sql<{ userId: string; permissions: string[]; dataScopes: string[]; platformAdmin: boolean }[]>`
    select u.id as "userId",
           coalesce(array_agg(distinct permission.value) filter (where permission.value is not null), '{}') as permissions,
           coalesce(array_agg(distinct dsg.scope_value) filter (where dsg.scope_value is not null), '{}') as "dataScopes",
           coalesce(bool_or(ur.source_key = 'local' and r.permissions ? ${PLATFORM_ADMIN_PERMISSION}), false) as "platformAdmin"
      from users u
      left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
        and (ur.source_key = 'local' or ur.source_key like 'department:%')
        and (ur.valid_until is null or ur.valid_until > now())
      left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.status = 'active'
      left join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value) on true
      left join data_scope_grants dsg on dsg.tenant_id = u.tenant_id
        and ((dsg.subject_type = 'user' and dsg.subject_id = u.id) or (dsg.subject_type = 'role' and dsg.subject_id = r.id))
     where u.tenant_id = ${tenantId} and u.id = any(${userIds}::text[])
     group by u.id
  `
  return new Map(rows.map(({ userId, ...grants }) => [userId, grants]))
}

/**
 * 名单页的逐行提示（与 `assertCanManageUser` 同一口径）：返回操作人能操作的账号。只决定按钮是否显示，
 * 每次写操作仍由 `assertCanManageUser` 在事务内复核。
 */
export async function manageableUserIds(sql: Sql, actorId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set()
  if (await isPlatformAdminActor(sql, actorId)) return new Set(userIds)
  const grants = await loadHeldGrantsForUsers(sql, userIds)
  const actor = await loadGrantCeiling(sql, actorId)
  return new Set(userIds.filter((userId) => {
    if (userId === actorId) return false
    const target = grants.get(userId)
    if (!target) return false
    return !target.platformAdmin
      && !missingPermissions(target.permissions, actor.permissions).length
      && !missingDataScopes(target.dataScopes, actor.dataScopes).length
  }))
}

/**
 * 减少角色的权限、数据范围或停用角色（方案 AP13 ④，2026-11-15 补充）：会让持有这个角色的人降权，
 * 等于在操作这些账号。非平台管理员只有在全部持有人都是自己能操作的账号时才能减权；
 * 增加权限、改名称与说明不受此限（仍受“授出不超过自身”约束）。
 */
export async function assertCanReduceRole(sql: Sql, actorId: string, roleId: string) {
  if (await isPlatformAdminActor(sql, actorId)) return
  const holders = await sql<{ userId: string }[]>`
    select distinct user_id as "userId" from user_roles
     where tenant_id = ${tenantId} and role_id = ${roleId}
       and (source_key = 'local' or source_key like 'department:%')
       and (valid_until is null or valid_until > now())
  `
  const denied = '这个角色有你不能操作的持有人（你自己、平台管理员或权限比你高的员工），只能增加权限或修改名称说明；减少权限或停用请联系平台管理员'
  if (holders.some(holder => holder.userId === actorId)) throw authorizationDenied(denied)
  const grants = await loadHeldGrantsForUsers(sql, holders.map(holder => holder.userId))
  const actor = await loadGrantCeiling(sql, actorId)
  for (const target of grants.values()) {
    if (target.platformAdmin
      || missingPermissions(target.permissions, actor.permissions).length
      || missingDataScopes(target.dataScopes, actor.dataScopes).length) {
      throw authorizationDenied(denied)
    }
  }
}

/**
 * 员工与权限、钉钉对某个账号的操作（分配或移除角色、数据范围、停用、重置密码、撤销会话、钉钉绑定）
 * 的对象约束（方案 AP13 ③④）：非平台管理员不能操作自己的账号，不能操作平台管理员，
 * 也不能操作持有自己没有的权限或数据范围的账号。
 */
export async function assertCanManageUser(sql: Sql, actorId: string, targetUserId: string) {
  if (await isPlatformAdminActor(sql, actorId)) return
  if (actorId === targetUserId) throw authorizationDenied('不能操作自己的账号，请联系其他管理员处理')
  const target = await loadHeldGrants(sql, targetUserId)
  if (target.platformAdmin) throw authorizationDenied('不能操作平台管理员的账号')
  const actor = await loadGrantCeiling(sql, actorId)
  if (missingPermissions(target.permissions, actor.permissions).length || missingDataScopes(target.dataScopes, actor.dataScopes).length) {
    throw authorizationDenied('对方的权限比你高，不能操作这个账号')
  }
}

/**
 * 授出权限与数据范围的上限（方案 AP13 ①）：非平台管理员授出的不超过本人；`admin:*` 只有平台管理员能授出。
 */
export async function assertCanGrant(sql: Sql, actorId: string, granted: { permissions?: string[]; dataScopes?: string[] }, subject: string) {
  const ceiling = await loadGrantCeiling(sql, actorId)
  if (ceiling.platformAdmin) return
  if ((granted.permissions ?? []).includes(PLATFORM_ADMIN_PERMISSION)) throw authorizationDenied('只有平台管理员可以授出平台管理员权限（admin:*）')
  assertWithinGrantCeiling(ceiling, granted, subject)
}
