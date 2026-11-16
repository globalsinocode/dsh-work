import { randomUUID } from 'node:crypto'

import type { UserProfile, UserRole } from '../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { ApiAudience } from './types.ts'
import { authorizationDenied } from '../../domain/authorization-errors.ts'
import { hasModuleAdministrationAccess } from '../../domain/admin-permissions.ts'

const tenantId = 'tenant-dsh-work'

export interface LocalAuthorizationContext {
  profile: UserProfile
  roleIds: string[]
  roleCodes: string[]
  permissions: string[]
  dataScopes: string[]
  authorizationVersion: number
}

export class IdentitySessionRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async updateAuthorizationVersion(sessionHash: string, authorizationVersion: number) {
    await this.database`
      update authentication_sessions
         set authorization_version = ${authorizationVersion}, last_seen_at = now()
       where session_hash = ${sessionHash} and tenant_id = ${tenantId}
         and revoked_at is null and expires_at > now()
    `
  }

  async resolveAuthorization(userId: string, database: DatabaseClient | DatabaseTransaction = this.database): Promise<LocalAuthorizationContext> {
    const [user] = await database<{
      id: string
      name: string
      department: string
      authorizationVersion: number
      roleIds: string[]
      roleCodes: string[]
      permissions: string[]
      dataScopes: string[]
    }[]>`
      select u.id, u.display_name as name,
             coalesce(u.department_id, '未分配部门') as department,
             u.local_authorization_version::integer as "authorizationVersion",
             coalesce(array_agg(distinct r.id) filter (where r.id is not null), '{}') as "roleIds",
             coalesce(array_agg(distinct r.code) filter (where r.code is not null), '{}') as "roleCodes",
             coalesce(array_agg(distinct permission.value) filter (where permission.value is not null), '{}') as permissions,
             coalesce(array_agg(distinct dsg.scope_value) filter (where dsg.scope_value is not null), '{}') as "dataScopes"
        from users u
        join tenants t on t.id = u.tenant_id and t.status = 'active'
        left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
          and (ur.source_key = 'local' or ur.source_key like 'department:%')
          and (ur.valid_until is null or ur.valid_until > now())
        left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
          and r.status = 'active'
        left join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value) on true
        left join data_scope_grants dsg on dsg.tenant_id = u.tenant_id
          and (
            (dsg.subject_type = 'user' and dsg.subject_id = u.id)
            or (dsg.subject_type = 'role' and dsg.subject_id = r.id)
          )
       where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and u.business_user
       group by u.id
    `
    if (!user) throw authorizationDenied('当前用户不存在、已停用或所属企业不可用')
    const role = primaryRole(user.roleCodes, user.permissions)
    return {
      profile: {
        id: user.id,
        name: user.name,
        title: roleTitle(role, user.permissions),
        department: user.department,
        avatarText: [...user.name][0] ?? '用',
        role,
        dataScopes: unique(user.dataScopes).sort(),
      },
      roleIds: unique(user.roleIds),
      roleCodes: unique(user.roleCodes),
      permissions: unique(user.permissions),
      dataScopes: unique(user.dataScopes).sort(),
      authorizationVersion: user.authorizationVersion,
    }
  }

  /**
   * `allSources`：员工主动退出登录时撤销该账号在此 audience 的全部来源会话（密码与钉钉，钉钉接入方案 4.3）；
   * 切换登录方式时只清理当前 Cookie 对应的会话。
   */
  async logoutSession(sessionHash: string, audience: ApiAudience, options: { allSources?: boolean } = {}) {
    return this.database.begin(async (transaction) => {
      const [session] = await transaction<{ userId: string; provider: string }[]>`
        update authentication_sessions set revoked_at = now()
         where session_hash = ${sessionHash} and tenant_id = ${tenantId}
           and audience = ${audience} and revoked_at is null
        returning user_id as "userId", authentication_provider as provider
      `
      if (!session) return false
      if (options.allSources) {
        await transaction`
          update authentication_sessions set revoked_at = now()
           where tenant_id = ${tenantId} and user_id = ${session.userId}
             and audience = ${audience} and revoked_at is null
        `
      }
      await appendIdentityAudit(transaction, {
        userId: session.userId,
        action: 'identity.logout',
        result: 'success',
        audience,
        context: { provider: session.provider },
      })
      return true
    })
  }

}

async function appendIdentityAudit(
  transaction: DatabaseTransaction,
  input: {
    userId: string
    action: string
    result: 'success' | 'failed' | 'blocked'
    audience: ApiAudience | 'system'
    objectType?: string
    objectId?: string
    context?: Record<string, unknown>
  },
) {
  await transaction`
    insert into audit_events (
      id, tenant_id, actor_type, actor_id, action, object_type,
      object_id, result, trace_id, safe_context
    ) values (
      ${`audit-${randomUUID()}`}, ${tenantId},
      ${input.audience === 'system' ? 'system' : 'user'}, ${input.userId},
      ${input.action}, ${input.objectType ?? 'identity_session'},
      ${input.objectId ?? input.audience}, ${input.result},
      ${`trace-identity-${randomUUID()}`},
      ${transaction.json({
        audience: input.audience,
        ...input.context,
      })}
    )
  `
}

function primaryRole(roleCodes: string[], permissions: string[]): UserRole {
  const roles = new Set(roleCodes)
  const granted = new Set(permissions)
  if (roles.has('platform_admin') || granted.has('admin:*')) {
    return 'platform_admin'
  }
  if (roles.has('auditor') && !granted.has('admin:write')) {
    return 'auditor'
  }
  if (granted.has('admin:write') || granted.has('admin:read')) return 'business_admin'
  // 只持有模块权限码（管理端模块权限方案 5.1）的管理员同样归入业务管理员，标题显示“模块管理员”。
  if (hasModuleAdministrationAccess(granted)) return 'business_admin'
  if (granted.has('audit:read')) return 'auditor'
  if (roles.has('department_manager') || granted.has('workbench:manage')) {
    return 'department_manager'
  }
  return 'employee'
}

function roleTitle(role: UserRole, permissions: string[]) {
  if (role === 'business_admin' && !permissions.includes('admin:read') && !permissions.includes('admin:write')) return '模块管理员'
  if (role === 'platform_admin') return 'AI 平台管理员'
  if (role === 'business_admin') return '业务管理员'
  if (role === 'auditor') return '安全审计员'
  if (role === 'department_manager') return '部门负责人'
  return '企业员工'
}

function unique(values: string[]) {
  return [...new Set(values)]
}
