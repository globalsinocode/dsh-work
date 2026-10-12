import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { LOCAL_PERMISSIONS } from './types.ts'

const tenantId = 'tenant-dsh-work'
const managedScopeCode = 'application'

export const permissionCatalog = [
  { code: LOCAL_PERMISSIONS.workbenchUse, name: '使用员工工作台', category: '员工端', description: '登录并使用员工工作台。' },
  { code: LOCAL_PERMISSIONS.workbenchManage, name: '管理部门工作内容', category: '员工端', description: '执行员工端的部门管理操作。' },
  { code: LOCAL_PERMISSIONS.adminRead, name: '读取管理配置', category: '管理端', description: '查看非审计类管理页面与配置。' },
  { code: LOCAL_PERMISSIONS.adminWrite, name: '变更管理配置', category: '管理端', description: '执行管理端写操作。' },
  { code: LOCAL_PERMISSIONS.auditRead, name: '读取安全审计', category: '安全', description: '查看审计与运行治理信息。' },
  { code: LOCAL_PERMISSIONS.adminAll, name: '全部管理权限', category: '系统', description: '系统级管理通配权限，仅用于平台管理员。' },
] as const

interface UserListRow {
  id: string
  externalUserId: string | null
  username: string | null
  name: string
  email: string | null
  department: string
  status: 'active' | 'disabled'
  identityProvider: 'local' | 'ai-hub'
  directorySyncedAt: Date | null
  authorizationVersion: number
  roles: Array<{ id: string; code: string; name: string; status: string }>
  dataScopes: string[]
  activeSessionCount: number
  lastSeenAt: Date | null
}

interface UserListSummary {
  synchronized: number
  active: number
  authorized: number
}

export class IdentityAdministrationService {
  private readonly database: DatabaseClient

  private readonly localAccounts: boolean

  constructor(database: DatabaseClient, localAccounts = false) {
    this.database = database
    this.localAccounts = localAccounts
  }

  async listUsers(input: { query?: string; status?: string; page?: number; pageSize?: number }) {
    const query = input.query?.trim().slice(0, 100) ?? ''
    const status = input.status === 'active' || input.status === 'disabled' ? input.status : ''
    const page = clampInteger(input.page, 1, 1_000_000, 1)
    const pageSize = clampInteger(input.pageSize, 10, 100, 20)
    const offset = (page - 1) * pageSize
    return this.database.begin(async (transaction) => {
      const [summary] = await transaction<UserListSummary[]>`
        select count(*)::integer as synchronized,
               count(*) filter (where u.status = 'active')::integer as active,
               count(*) filter (where exists (
                 select 1 from user_roles ur
                 join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
                  where ur.tenant_id = u.tenant_id and ur.user_id = u.id
                    and ur.source_key = 'local' and r.status = 'active'
                    and (ur.valid_until is null or ur.valid_until > now())
               ))::integer as authorized
          from users u
         where u.tenant_id = ${tenantId} and (u.identity_provider = 'ai-hub' or (${this.localAccounts} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)))
           and u.business_user
      `
      const [count] = await transaction<{ total: number }[]>`
        select count(*)::integer as total
          from users u
         where u.tenant_id = ${tenantId} and (u.identity_provider = 'ai-hub' or (${this.localAccounts} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)))
           and u.business_user
           and (${status} = '' or u.status = ${status})
           and (
             ${query} = ''
             or u.display_name ilike ${`%${query}%`}
             or coalesce(u.email, '') ilike ${`%${query}%`}
             or (${this.localAccounts} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id and c.username ilike ${`%${query}%`}))
             or coalesce(u.external_user_id, '') ilike ${`%${query}%`}
             or coalesce(u.department_id, '') ilike ${`%${query}%`}
           )
      `
      const items = await transaction<UserListRow[]>`
        select u.id, u.external_user_id as "externalUserId", u.display_name as name,
               (select c.username from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id) as username,
               u.email, coalesce(u.department_id, '未分配部门') as department,
               u.status, u.identity_provider as "identityProvider",
               u.directory_synced_at as "directorySyncedAt",
               u.local_authorization_version::integer as "authorizationVersion",
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'id', r.id, 'code', r.code, 'name', r.name, 'status', r.status
                 ) order by r.name, r.id)
                   from user_roles ur
                   join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
                  where ur.tenant_id = u.tenant_id and ur.user_id = u.id
                    and ur.source_key = 'local'
                    and (ur.valid_until is null or ur.valid_until > now())
               ), '[]'::jsonb) as roles,
               coalesce((
                 select jsonb_agg(dsg.scope_value order by dsg.scope_value)
                  from data_scope_grants dsg
                  where dsg.tenant_id = u.tenant_id and dsg.subject_type = 'user'
                    and dsg.subject_id = u.id
               ), '[]'::jsonb) as "dataScopes",
               (select count(*)::integer from authentication_sessions s
                 where s.tenant_id = u.tenant_id and s.user_id = u.id
                   and s.revoked_at is null and s.expires_at > now()) as "activeSessionCount",
               (select max(s.last_seen_at) from authentication_sessions s
                 where s.tenant_id = u.tenant_id and s.user_id = u.id) as "lastSeenAt"
         from users u
         where u.tenant_id = ${tenantId} and (u.identity_provider = 'ai-hub' or (${this.localAccounts} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)))
           and u.business_user
           and (${status} = '' or u.status = ${status})
           and (
             ${query} = ''
             or u.display_name ilike ${`%${query}%`}
             or coalesce(u.email, '') ilike ${`%${query}%`}
             or (${this.localAccounts} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id and c.username ilike ${`%${query}%`}))
             or coalesce(u.external_user_id, '') ilike ${`%${query}%`}
             or coalesce(u.department_id, '') ilike ${`%${query}%`}
           )
         order by (u.status = 'active') desc, u.display_name, u.id
         limit ${pageSize} offset ${offset}
      `
      return {
        items,
        total: count?.total ?? 0,
        page,
        pageSize,
        summary: summary ?? { synchronized: 0, active: 0, authorized: 0 },
      }
    })
  }

  async listRoles() {
    return this.database<{
      id: string
      code: string
      name: string
      description: string
      status: 'active' | 'disabled'
      permissions: string[]
      dataScopes: string[]
      userCount: number
      system: boolean
      updatedAt: Date
    }[]>`
      select r.id, r.code, r.name, r.description, r.status, r.permissions,
             coalesce((
               select jsonb_agg(dsg.scope_value order by dsg.scope_value)
                from data_scope_grants dsg
                where dsg.tenant_id = r.tenant_id and dsg.subject_type = 'role'
                  and dsg.subject_id = r.id
             ), '[]'::jsonb) as "dataScopes",
             (select count(distinct ur.user_id)::integer from user_roles ur
               join users u on u.tenant_id = ur.tenant_id and u.id = ur.user_id
              where ur.tenant_id = r.tenant_id and ur.role_id = r.id
                and ur.source_key = 'local' and u.status = 'active'
                and (u.identity_provider = 'ai-hub' or (${this.localAccounts} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)))
                and u.business_user
                and (ur.valid_until is null or ur.valid_until > now())) as "userCount",
             (r.id in ('role-platform-admin', 'role-employee', 'role-department-manager', 'role-auditor')) as system,
             r.updated_at as "updatedAt"
        from roles r
       where r.tenant_id = ${tenantId}
       order by (r.id = 'role-platform-admin') desc, r.status, r.name, r.id
    `
  }

  permissions() {
    return permissionCatalog.map(item => ({ ...item }))
  }

  async createRole(input: {
    code: string
    name: string
    description?: string
    permissions?: string[]
    dataScopes?: string[]
    actorId: string
  }) {
    const normalized = normalizeRoleInput(input)
    const roleId = `role-${normalized.code}-${randomUUID().slice(0, 8)}`
    await this.database.begin(async (transaction) => {
      const [created] = await transaction<{ id: string }[]>`
        insert into roles (
          id, tenant_id, code, name, description, permissions, status
        ) values (
          ${roleId}, ${tenantId}, ${normalized.code}, ${normalized.name},
          ${normalized.description}, ${transaction.json(normalized.permissions)}, 'active'
        )
        on conflict do nothing
        returning id
      `
      if (!created) throw new Error(`不能重复使用角色编码：${normalized.code}`)
      await replaceScopes(transaction, 'role', roleId, normalized.dataScopes, input.actorId)
      await appendAdministrationAudit(transaction, {
        actorId: input.actorId,
        action: 'authorization.role.create',
        objectType: 'role',
        objectId: roleId,
        context: { code: normalized.code },
      })
    })
    return this.requireRole(roleId)
  }

  async updateRole(input: {
    roleId: string
    name: string
    description?: string
    status: 'active' | 'disabled'
    permissions: string[]
    dataScopes: string[]
    actorId: string
  }) {
    const name = requiredText(input.name, '角色名称', 80)
    const description = optionalText(input.description, 500)
    const permissions = normalizePermissions(input.permissions)
    const dataScopes = normalizeScopes(input.dataScopes)
    if (input.roleId === 'role-platform-admin') {
      if (input.status !== 'active' || !permissions.includes(LOCAL_PERMISSIONS.adminAll)) {
        throw new Error('系统平台管理员角色必须保持启用并保留 admin:* 权限')
      }
    }
    await this.database.begin(async (transaction) => {
      const [role] = await transaction<{ id: string }[]>`
        update roles set name = ${name}, description = ${description}, status = ${input.status},
                         permissions = ${transaction.json(permissions)}
         where tenant_id = ${tenantId} and id = ${input.roleId}
        returning id
      `
      if (!role) throw new Error(`角色不存在：${input.roleId}`)
      await replaceScopes(transaction, 'role', input.roleId, dataScopes, input.actorId)
      await appendAdministrationAudit(transaction, {
        actorId: input.actorId,
        action: 'authorization.role.update',
        objectType: 'role',
        objectId: input.roleId,
      })
    })
    return this.requireRole(input.roleId)
  }

  async grantRole(input: {
    userId: string
    roleId: string
    validUntil?: string | null
    actorId: string
  }) {
    const validUntil = input.validUntil ? new Date(input.validUntil) : null
    if (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil <= new Date())) {
      throw new Error('角色有效期必须是未来时间')
    }
    if (input.roleId === 'role-platform-admin' && validUntil) {
      throw new Error('平台管理员角色不能设置有效期，请通过显式撤权和审计管理其生命周期')
    }
    await this.database.begin(async (transaction) => {
      const [user] = await transaction<{ id: string; status: string }[]>`
        select id, status from users where tenant_id = ${tenantId} and id = ${input.userId}
          and (identity_provider = 'ai-hub' or (${this.localAccounts} and id in (select user_id from local_user_credentials where tenant_id = 'tenant-dsh-work')))
          and business_user
      `
      if (!user) throw new Error(`用户不存在：${input.userId}`)
      const [role] = await transaction<{ id: string }[]>`
        select id from roles where tenant_id = ${tenantId} and id = ${input.roleId} and status = 'active'
      `
      if (!role) throw new Error(`角色不存在或已停用：${input.roleId}`)
      await transaction`
        insert into user_roles (
          tenant_id, user_id, role_id, source_key, valid_until, granted_by
        ) values (
          ${tenantId}, ${input.userId}, ${input.roleId}, 'local', ${validUntil}, ${input.actorId}
        )
        on conflict (tenant_id, user_id, role_id, source_key) do update
          set valid_until = excluded.valid_until, granted_by = excluded.granted_by,
              granted_at = now()
      `
      await appendAdministrationAudit(transaction, {
        actorId: input.actorId,
        action: 'authorization.user_role.grant',
        objectType: 'user',
        objectId: input.userId,
        context: {
          roleId: input.roleId,
          validUntil: validUntil?.toISOString() ?? null,
        },
      })
    })
    return this.requireUser(input.userId)
  }

  async revokeRole(input: { userId: string; roleId: string; actorId: string }) {
    await this.database.begin(async (transaction) => {
      if (input.roleId === 'role-platform-admin') {
        await lockPlatformAdminInvariant(transaction)
      }
      const [user] = await transaction<{ id: string; status: string }[]>`
        select id, status from users where tenant_id = ${tenantId} and id = ${input.userId}
          and (identity_provider = 'ai-hub' or (${this.localAccounts} and id in (select user_id from local_user_credentials where tenant_id = 'tenant-dsh-work')))
      `
      if (!user) throw new Error(`员工不存在：${input.userId}`)
      if (input.roleId === 'role-platform-admin') {
        const [assigned] = await transaction<{ assigned: boolean }[]>`
          select exists (
            select 1 from user_roles
             where tenant_id = ${tenantId} and user_id = ${input.userId}
               and role_id = ${input.roleId} and source_key = 'local'
               and (valid_until is null or valid_until > now())
          ) as assigned
        `
        if (assigned?.assigned && user.status === 'active') {
          await requireAnotherPlatformAdmin(transaction, input.userId, this.localAccounts)
        }
      }
      await transaction`
        delete from user_roles
         where tenant_id = ${tenantId} and user_id = ${input.userId}
           and role_id = ${input.roleId} and source_key = 'local'
      `
      await appendAdministrationAudit(transaction, {
        actorId: input.actorId,
        action: 'authorization.user_role.revoke',
        objectType: 'user',
        objectId: input.userId,
        context: { roleId: input.roleId },
      })
    })
    return this.requireUser(input.userId)
  }

  async replaceUserScopes(input: { userId: string; dataScopes: string[]; actorId: string }) {
    const scopes = normalizeScopes(input.dataScopes)
    await this.database.begin(async (transaction) => {
      const [user] = await transaction<{ id: string }[]>`
        select id from users where tenant_id = ${tenantId} and id = ${input.userId}
          and (identity_provider = 'ai-hub' or (${this.localAccounts} and id in (select user_id from local_user_credentials where tenant_id = 'tenant-dsh-work')))
          and business_user
      `
      if (!user) throw new Error(`用户不存在：${input.userId}`)
      await replaceScopes(transaction, 'user', input.userId, scopes, input.actorId)
      await appendAdministrationAudit(transaction, {
        actorId: input.actorId,
        action: 'authorization.user_scope.replace',
        objectType: 'user',
        objectId: input.userId,
        context: { scopeCount: scopes.length },
      })
    })
    return this.requireUser(input.userId)
  }

  async revokeSessions(input: { userId: string; actorId: string }) {
    const count = await this.database.begin(async (transaction) => {
      const [user] = await transaction<{ id: string }[]>`
        select id from users where tenant_id = ${tenantId} and id = ${input.userId}
          and (identity_provider = 'ai-hub' or (${this.localAccounts} and id in (select user_id from local_user_credentials where tenant_id = 'tenant-dsh-work')))
      `
      if (!user) throw new Error(`用户不存在：${input.userId}`)
      const revoked = await transaction<{ sessionHash: string }[]>`
        update authentication_sessions set revoked_at = now()
         where tenant_id = ${tenantId} and user_id = ${input.userId} and revoked_at is null
        returning session_hash as "sessionHash"
      `
      await appendAdministrationAudit(transaction, {
        actorId: input.actorId,
        action: 'identity.session.revoke',
        objectType: 'user',
        objectId: input.userId,
        context: { count: revoked.length },
      })
      return revoked.length
    })
    return { userId: input.userId, revokedSessions: count }
  }

  private async requireRole(roleId: string) {
    const role = (await this.listRoles()).find(item => item.id === roleId)
    if (!role) throw new Error(`角色不存在：${roleId}`)
    return role
  }

  private async requireUser(userId: string) {
    const [user] = await this.database<UserListRow[]>`
      select u.id, u.external_user_id as "externalUserId", u.display_name as name,
               (select c.username from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id) as username,
             u.email, coalesce(u.department_id, '未分配部门') as department,
             u.status, u.identity_provider as "identityProvider",
             u.directory_synced_at as "directorySyncedAt",
             u.local_authorization_version::integer as "authorizationVersion",
             coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'status', r.status) order by r.name)
               from user_roles ur join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
              where ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.source_key = 'local'
                and (ur.valid_until is null or ur.valid_until > now())), '[]'::jsonb) as roles,
             coalesce((select jsonb_agg(dsg.scope_value order by dsg.scope_value)
               from data_scope_grants dsg where dsg.tenant_id = u.tenant_id
                and dsg.subject_type = 'user' and dsg.subject_id = u.id
              ), '[]'::jsonb) as "dataScopes",
             (select count(*)::integer from authentication_sessions s where s.tenant_id = u.tenant_id
                and s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as "activeSessionCount",
             (select max(s.last_seen_at) from authentication_sessions s where s.tenant_id = u.tenant_id
                and s.user_id = u.id) as "lastSeenAt"
        from users u where u.tenant_id = ${tenantId} and u.id = ${userId}
          and (u.identity_provider = 'ai-hub' or (${this.localAccounts} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)))
    `
    if (!user) throw new Error(`用户不存在：${userId}`)
    return user
  }

}

async function appendAdministrationAudit(
  transaction: DatabaseTransaction,
  input: {
    actorId: string
    action: string
    objectType: string
    objectId: string
    context?: Record<string, unknown>
  },
) {
  await transaction`
    insert into audit_events (
      id, tenant_id, actor_type, actor_id, action, object_type,
      object_id, result, trace_id, safe_context
    ) values (
      ${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${input.actorId},
      ${input.action}, ${input.objectType}, ${input.objectId}, 'success',
      ${`trace-identity-${randomUUID()}`},
      ${transaction.json({
        audience: 'admin',
        authorizationSource: 'local',
        ...input.context,
      })}
    )
  `
}

async function replaceScopes(
  transaction: DatabaseTransaction,
  subjectType: 'user' | 'role',
  subjectId: string,
  scopes: string[],
  actorId: string,
) {
  await transaction`
    delete from data_scope_grants
     where tenant_id = ${tenantId} and subject_type = ${subjectType}
       and subject_id = ${subjectId}
  `
  for (const scope of scopes) {
    await transaction`
      insert into data_scope_grants (
        id, tenant_id, subject_type, subject_id, scope_code, scope_value, granted_by
      ) values (
        ${`grant-${randomUUID()}`}, ${tenantId}, ${subjectType}, ${subjectId},
        ${managedScopeCode}, ${scope}, ${actorId}
      )
    `
  }
}

export async function requireAnotherPlatformAdmin(transaction: DatabaseTransaction, excludedUserId: string, localAccounts = false) {
  const [row] = await transaction<{ count: number }[]>`
    select count(distinct u.id)::integer as count
      from users u
      join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
      join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
     where u.tenant_id = ${tenantId} and u.id <> ${excludedUserId} and u.status = 'active'
       and (case when ${localAccounts} then exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id) else u.identity_provider = 'ai-hub' end)
       and u.business_user
       and ur.source_key = 'local' and ur.role_id = 'role-platform-admin'
       and (ur.valid_until is null or ur.valid_until > now())
       and r.status = 'active' and r.permissions ? ${LOCAL_PERMISSIONS.adminAll}
  `
  if (!row || row.count < 1) throw new Error('不能移除最后一个有效的平台管理员')
}

export async function lockPlatformAdminInvariant(transaction: DatabaseTransaction) {
  await transaction`
    select pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:role-platform-admin:minimum-one-active`}, 0)
    )
  `
}

function normalizeRoleInput(input: {
  code: string
  name: string
  description?: string
  permissions?: string[]
  dataScopes?: string[]
}) {
  const code = input.code.trim()
  if (!/^[a-z][a-z0-9_]{2,49}$/.test(code)) {
    throw new Error('角色编码必须为 3-50 位小写字母、数字或下划线')
  }
  return {
    code,
    name: requiredText(input.name, '角色名称', 80),
    description: optionalText(input.description, 500),
    permissions: normalizePermissions(input.permissions ?? []),
    dataScopes: normalizeScopes(input.dataScopes ?? []),
  }
}

function normalizePermissions(values: string[]) {
  if (!Array.isArray(values)) throw new Error('角色权限必须是数组')
  const allowed = new Set(permissionCatalog.map(item => item.code))
  const normalized = unique(values.map(item => String(item).trim()).filter(Boolean))
  const unknown = normalized.filter(item => !allowed.has(item as typeof permissionCatalog[number]['code']))
  if (unknown.length > 0) throw new Error(`包含未知的本地权限：${unknown.join('、')}`)
  return normalized.sort()
}

function normalizeScopes(values: string[]) {
  if (!Array.isArray(values)) throw new Error('数据范围必须是数组')
  const scopes = unique(values.map(item => String(item).trim()).filter(Boolean))
  if (scopes.length > 100) throw new Error('数据范围最多配置 100 项')
  for (const scope of scopes) {
    if (scope.length > 160 || !/^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(scope)) {
      throw new Error(`数据范围格式无效：${scope}`)
    }
  }
  return scopes.sort()
}

function requiredText(value: string, label: string, maxLength: number) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label}不能为空`)
  if (normalized.length > maxLength) throw new Error(`${label}长度不能超过 ${maxLength}`)
  return normalized
}

function optionalText(value: string | undefined, maxLength: number) {
  const normalized = value?.trim() ?? ''
  if (normalized.length > maxLength) throw new Error(`描述长度不能超过 ${maxLength}`)
  return normalized
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  if (!Number.isSafeInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value as number))
}
