import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { LOCAL_PERMISSIONS } from './types.ts'
import { ADMIN_MODULE_LABELS, ADMIN_MODULES, adminModulePermission, missingDataScopes, missingPermissions } from '../../domain/admin-permissions.ts'
import { invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'
import { assertRoleDepartmentGrantable } from '../organization/postgres-organization-service.ts'
import { assertCanGrant, assertCanManageUser, assertCanReduceRole, isPlatformAdminActor, loadRoleGrants, requireAdminModuleActor } from '../authorization/admin-actor.ts'
import { authorizationDenied } from '../../domain/authorization-errors.ts'

const tenantId = 'tenant-dsh-work'
const managedScopeCode = 'application'

export const permissionCatalog = [
  { code: LOCAL_PERMISSIONS.workbenchUse, name: '使用员工工作台', category: '员工端', description: '登录并使用员工工作台。' },
  { code: LOCAL_PERMISSIONS.workbenchManage, name: '管理部门工作内容', category: '员工端', description: '执行员工端的部门管理操作。' },
  { code: LOCAL_PERMISSIONS.knowledgeView, name: '查看企业知识库', category: '企业知识库', description: '浏览可见知识库与文档，对话中添加知识库后检索。' },
  { code: LOCAL_PERMISSIONS.knowledgeDocs, name: '管理知识库文档', category: '企业知识库', description: '包含查看；在归属本人所属部门的知识库中上传和维护文档。' },
  { code: LOCAL_PERMISSIONS.knowledgeBases, name: '管理知识库', category: '企业知识库', description: '包含文档管理；新建知识库，改名、删除和调整归属本人所属部门的知识库授权。' },
  { code: LOCAL_PERMISSIONS.adminRead, name: '查看全部管理模块', category: '管理端', description: '查看全部管理模块的页面与配置，含员工与权限、钉钉集成（不含审计）。' },
  { code: LOCAL_PERMISSIONS.adminWrite, name: '修改全部管理模块', category: '管理端', description: '修改全部管理模块的配置，含员工与权限、钉钉集成（钉钉应用配置只限平台管理员）；授出的权限不能超过本人。' },
  ...ADMIN_MODULES.flatMap(module => [
    { code: adminModulePermission(module, 'read'), name: `查看${ADMIN_MODULE_LABELS[module]}`, category: '管理端模块', description: `查看管理端“${ADMIN_MODULE_LABELS[module]}”模块。` },
    ...(module === 'ops' ? [] : [{ code: adminModulePermission(module, 'write'), name: `修改${ADMIN_MODULE_LABELS[module]}`, category: '管理端模块', description: `包含查看；修改管理端“${ADMIN_MODULE_LABELS[module]}”模块，授出的权限不能超过本人。` }]),
  ]),
  { code: LOCAL_PERMISSIONS.auditRead, name: '读取安全审计', category: '安全', description: '查看审计与运行治理信息。' },
  { code: LOCAL_PERMISSIONS.dataProtectionTerms, name: '数据防护词表', category: '安全', description: '查看和维护保密词表与白名单。词表是机密内容，不默认授予所有管理员。' },
  { code: LOCAL_PERMISSIONS.adminAll, name: '全部管理权限', category: '系统', description: '系统级管理通配权限，仅用于平台管理员。' },
] as const

interface UserListRow {
  id: string
  username: string | null
  loginAccount: string | null
  name: string
  email: string | null
  department: string
  status: 'active' | 'disabled'
  authorizationVersion: number
  roles: Array<{ id: string; code: string; name: string; status: string }>
  /** 来自部门授权的角色（组织架构 ORG-S2），只能在“组织架构”中修改。 */
  departmentRoles: Array<{ id: string; code: string; name: string; status: string; departmentName: string; grantId: string }>
  dataScopes: string[]
  activeSessionCount: number
  lastSeenAt: Date | null
  /**
   * 钉钉绑定（钉钉接入方案 4.2）。
   * `status` 取最新记录：有有效记录为 bound，只有失效记录为 invalid，没有记录为 unbound。
   */
  dingtalk: {
    status: 'bound' | 'unbound' | 'invalid'
    boundBy: 'self' | 'admin' | null
    dingtalkName: string | null
    revokeReason: string | null
    selfRebindLocked: boolean
  }
}

interface UserListSummary {
  synchronized: number
  active: number
  authorized: number
  /** 有效独立账号中的钉钉绑定情况（“员工与权限”顶部概况）。 */
  dingtalk: { activeLocal: number; bound: number; selfBound: number; adminBound: number; unbound: number; invalid: number }
}

/** 最新一条钉钉绑定记录推导出的状态；别名 `u` 为 users。 */
const dingtalkStatusSql = `(
  case when exists (select 1 from external_account_bindings b where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = 'dingtalk' and b.status = 'valid') then 'bound'
       when exists (select 1 from external_account_bindings b where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = 'dingtalk') then 'invalid'
       else 'unbound' end)`

export class IdentityAdministrationService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  /** `nameOnly`：跨模块选择器只按姓名搜索，不能用手机号、邮箱或账号反查员工（功能规则第 13 节）。 */
  async listUsers(input: { query?: string; status?: string; dingtalk?: string; page?: number; pageSize?: number; nameOnly?: boolean }) {
    const nameOnly = input.nameOnly === true
    const query = input.query?.trim().slice(0, 100) ?? ''
    const status = input.status === 'active' || input.status === 'disabled' ? input.status : ''
    const dingtalk = input.dingtalk === 'bound' || input.dingtalk === 'unbound' || input.dingtalk === 'invalid' ? input.dingtalk : ''
    const dingtalkStatus = this.database.unsafe(dingtalkStatusSql)
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
                    and (ur.source_key = 'local' or ur.source_key like 'department:%') and r.status = 'active'
                    and (ur.valid_until is null or ur.valid_until > now())
               ))::integer as authorized,
               jsonb_build_object(
                 'activeLocal', count(*) filter (where u.status = 'active'),
                 'bound', count(*) filter (where u.status = 'active' and ${dingtalkStatus} = 'bound'),
                 'selfBound', count(*) filter (where u.status = 'active' and exists (select 1 from external_account_bindings b where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = 'dingtalk' and b.status = 'valid' and b.bound_by = 'self')),
                 'adminBound', count(*) filter (where u.status = 'active' and exists (select 1 from external_account_bindings b where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = 'dingtalk' and b.status = 'valid' and b.bound_by = 'admin')),
                 'unbound', count(*) filter (where u.status = 'active' and ${dingtalkStatus} = 'unbound'),
                 'invalid', count(*) filter (where u.status = 'active' and ${dingtalkStatus} = 'invalid')
               ) as dingtalk
          from users u
         where u.tenant_id = ${tenantId} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)
           and u.business_user
      `
      const [count] = await transaction<{ total: number }[]>`
        select count(*)::integer as total
          from users u
         where u.tenant_id = ${tenantId} and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)
           and u.business_user
           and (${status} = '' or u.status = ${status})
           and (${dingtalk} = '' or ${dingtalkStatus} = ${dingtalk})
           and (
             ${query} = ''
             or u.display_name ilike ${`%${query}%`}
             or (${!nameOnly}::boolean and (false
             or coalesce(u.email, '') ilike ${`%${query}%`}
             or exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id and c.username ilike ${`%${query}%`})
             or coalesce(u.department_id, '') ilike ${`%${query}%`}
             ))
           )
      `
      const items = await transaction<UserListRow[]>`
        select u.id, u.display_name as name,
               cred.username as username, cred.username as "loginAccount",
               u.email, coalesce(u.department_id, '未分配部门') as department,
               u.status,
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
                 select jsonb_agg(jsonb_build_object(
                   'id', r.id, 'code', r.code, 'name', r.name, 'status', r.status, 'departmentName', d.name, 'grantId', g.id
                 ) order by r.name, d.name)
                   from user_roles ur
                   join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
                   join org_department_grants g on g.tenant_id = ur.tenant_id and ur.source_key = 'department:' || g.id
                   join org_departments d on d.tenant_id = g.tenant_id and d.id = g.department_id
                  where ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.source_key like 'department:%'
               ), '[]'::jsonb) as "departmentRoles",
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
                 where s.tenant_id = u.tenant_id and s.user_id = u.id) as "lastSeenAt",
               (
                 select jsonb_build_object(
                   'status', ${dingtalkStatus},
                   'boundBy', case when latest.status = 'valid' then latest.bound_by end,
                   'dingtalkName', case when latest.status = 'valid' then latest.external_display_name end,
                   'revokeReason', case when latest.status = 'invalid' then latest.revoke_reason end,
                   'selfRebindLocked', exists (select 1 from external_account_bindings b where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = 'dingtalk' and b.self_rebind_locked)
                 ) from (select 1) one
                 left join lateral (
                   select b.status, b.bound_by, b.external_display_name, b.revoke_reason from external_account_bindings b
                    where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = 'dingtalk'
                    order by (b.status = 'valid') desc, b.bound_at desc limit 1
                 ) latest on true
               ) as dingtalk
         from users u
         join local_user_credentials cred on cred.tenant_id = u.tenant_id and cred.user_id = u.id
         where u.tenant_id = ${tenantId}
           and u.business_user
           and (${status} = '' or u.status = ${status})
           and (${dingtalk} = '' or ${dingtalkStatus} = ${dingtalk})
           and (
             ${query} = ''
             or u.display_name ilike ${`%${query}%`}
             or (${!nameOnly}::boolean and (false
             or coalesce(u.email, '') ilike ${`%${query}%`}
             or exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id and c.username ilike ${`%${query}%`})
             or coalesce(u.department_id, '') ilike ${`%${query}%`}
             ))
           )
         order by (u.status = 'active') desc, u.display_name, u.id
         limit ${pageSize} offset ${offset}
      `
      return {
        items,
        total: count?.total ?? 0,
        page,
        pageSize,
        summary: summary ?? { synchronized: 0, active: 0, authorized: 0, dingtalk: { activeLocal: 0, bound: 0, selfBound: 0, adminBound: 0, unbound: 0, invalid: 0 } },
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
                and (ur.source_key = 'local' or ur.source_key like 'department:%') and u.status = 'active'
                and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)
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

  /** 修改员工与权限的服务层复核（功能规则第 13 节），供目录同步等没有目标账号的写操作使用。 */
  async requireIdentityWriter(actorId: string) {
    return requireAdminModuleActor(this.database, actorId, 'identity', 'write')
  }

  async createRole(input: {
    /** 已废弃：角色编码由系统生成（功能规则第 13 节），传入的值被忽略。 */
    code?: string
    name: string
    description?: string
    permissions?: string[]
    dataScopes?: string[]
    actorId: string
  }) {
    const normalized = normalizeRoleInput(input)
    const roleId = `role-${normalized.code}-${randomUUID().slice(0, 8)}`
    await this.database.begin(async (transaction) => {
      await requireAdminModuleActor(transaction, input.actorId, 'identity', 'write')
      await assertCanGrant(transaction, input.actorId, normalized, '新角色的权限')
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
      if (!created) throw stateConflict(`不能重复使用角色编码：${normalized.code}`)
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
        throw invalidRequest('系统平台管理员角色必须保持启用并保留 admin:* 权限')
      }
    }
    await this.database.begin(async (transaction) => {
      // 先锁住角色行：与组织架构的 grantRole（对角色加 for share）互斥，避免检查之后、
      // 更新之前有人把这个角色授给部门，绕过“管理类角色不能授给部门”（OD8）。
      const [current] = await transaction<{ status: string }[]>`select status from roles where tenant_id = ${tenantId} and id = ${input.roleId} for update`
      await requireAdminModuleActor(transaction, input.actorId, 'identity', 'write')
      // 防提权（功能规则第 13 节）：平台管理员角色只有平台管理员能改；含操作人没有的权限的角色对其只读。
      if (input.roleId === 'role-platform-admin' && !(await isPlatformAdminActor(transaction, input.actorId))) {
        throw authorizationDenied('平台管理员角色只有平台管理员可以修改')
      }
      // 停用的角色重新启用后会恢复权限，判断“现有权限”时不看角色状态。
      const existing = await loadRoleGrants(transaction, [input.roleId], { includeDisabled: true })
      await assertCanGrant(transaction, input.actorId, existing, '这个角色现有的权限')
      await assertCanGrant(transaction, input.actorId, { permissions, dataScopes }, '修改后的角色权限')
      // 减权会让持有人降权（功能规则第 13 节）：持有人里有操作人不能操作的账号时不允许。
      // 按包含关系比较：读改成写（只存写码）等升级不算减权。
      const reduced = (current?.status === 'active' && input.status !== 'active')
        || missingPermissions(existing.permissions, permissions).length > 0
        || missingDataScopes(existing.dataScopes, dataScopes).length > 0
      if (reduced) await assertCanReduceRole(transaction, input.actorId, input.roleId)
      await assertRoleDepartmentGrantable(transaction, input.roleId, permissions)
      const [role] = await transaction<{ id: string }[]>`
        update roles set name = ${name}, description = ${description}, status = ${input.status},
                         permissions = ${transaction.json(permissions)}
         where tenant_id = ${tenantId} and id = ${input.roleId}
        returning id
      `
      if (!role) throw notFound(`角色不存在：${input.roleId}`)
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
      throw invalidRequest('角色有效期必须是未来时间')
    }
    if (input.roleId === 'role-platform-admin' && validUntil) {
      throw stateConflict('平台管理员角色不能设置有效期，请通过显式撤权和审计管理其生命周期')
    }
    await this.database.begin(async (transaction) => {
      const [user] = await transaction<{ id: string; status: string }[]>`
        select id, status from users where tenant_id = ${tenantId} and id = ${input.userId}
          and id in (select user_id from local_user_credentials where tenant_id = 'tenant-dsh-work')
          and business_user
      `
      if (!user) throw notFound(`用户不存在：${input.userId}`)
      const [role] = await transaction<{ id: string }[]>`
        select id from roles where tenant_id = ${tenantId} and id = ${input.roleId} and status = 'active'
      `
      if (!role) throw notFound(`角色不存在或已停用：${input.roleId}`)
      await requireAdminModuleActor(transaction, input.actorId, 'identity', 'write')
      await assertCanManageUser(transaction, input.actorId, input.userId)
      await assertCanGrant(transaction, input.actorId, await loadRoleGrants(transaction, [input.roleId]), '要分配的角色')
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
      // 先取平台管理员不变量锁再复核操作人：并发互撤时，后执行的一方读到的是已提交的授权。
      if (input.roleId === 'role-platform-admin') {
        await lockPlatformAdminInvariant(transaction)
      }
      await requireAdminModuleActor(transaction, input.actorId, 'identity', 'write')
      await assertCanManageUser(transaction, input.actorId, input.userId)
      const [user] = await transaction<{ id: string; status: string }[]>`
        select id, status from users where tenant_id = ${tenantId} and id = ${input.userId}
          and id in (select user_id from local_user_credentials where tenant_id = 'tenant-dsh-work')
      `
      if (!user) throw notFound(`员工不存在：${input.userId}`)
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
          await requireAnotherPlatformAdmin(transaction, input.userId)
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
          and id in (select user_id from local_user_credentials where tenant_id = 'tenant-dsh-work')
          and business_user
      `
      if (!user) throw notFound(`用户不存在：${input.userId}`)
      await requireAdminModuleActor(transaction, input.actorId, 'identity', 'write')
      await assertCanManageUser(transaction, input.actorId, input.userId)
      await assertCanGrant(transaction, input.actorId, { dataScopes: scopes }, '员工的数据范围')
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
          and id in (select user_id from local_user_credentials where tenant_id = 'tenant-dsh-work')
      `
      if (!user) throw notFound(`用户不存在：${input.userId}`)
      await requireAdminModuleActor(transaction, input.actorId, 'identity', 'write')
      await assertCanManageUser(transaction, input.actorId, input.userId)
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
    if (!role) throw notFound(`角色不存在：${roleId}`)
    return role
  }

  private async requireUser(userId: string) {
    const [user] = await this.database<UserListRow[]>`
      select u.id, u.display_name as name,
             cred.username as username, cred.username as "loginAccount",
             u.email, coalesce(u.department_id, '未分配部门') as department,
             u.status,
             u.local_authorization_version::integer as "authorizationVersion",
             coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'status', r.status) order by r.name)
               from user_roles ur join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
              where ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.source_key = 'local'
                and (ur.valid_until is null or ur.valid_until > now())), '[]'::jsonb) as roles,
             coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'id', r.id, 'code', r.code, 'name', r.name, 'status', r.status, 'departmentName', d.name, 'grantId', g.id
                 ) order by r.name, d.name)
                   from user_roles ur
                   join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
                   join org_department_grants g on g.tenant_id = ur.tenant_id and ur.source_key = 'department:' || g.id
                   join org_departments d on d.tenant_id = g.tenant_id and d.id = g.department_id
                  where ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.source_key like 'department:%'
               ), '[]'::jsonb) as "departmentRoles",
             coalesce((select jsonb_agg(dsg.scope_value order by dsg.scope_value)
               from data_scope_grants dsg where dsg.tenant_id = u.tenant_id
                and dsg.subject_type = 'user' and dsg.subject_id = u.id
              ), '[]'::jsonb) as "dataScopes",
             (select count(*)::integer from authentication_sessions s where s.tenant_id = u.tenant_id
                and s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as "activeSessionCount",
             (select max(s.last_seen_at) from authentication_sessions s where s.tenant_id = u.tenant_id
                and s.user_id = u.id) as "lastSeenAt"
        from users u
        join local_user_credentials cred on cred.tenant_id = u.tenant_id and cred.user_id = u.id
       where u.tenant_id = ${tenantId} and u.id = ${userId}
    `
    if (!user) throw notFound(`用户不存在：${userId}`)
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

export async function requireAnotherPlatformAdmin(transaction: DatabaseTransaction, excludedUserId: string) {
  const [row] = await transaction<{ count: number }[]>`
    select count(distinct u.id)::integer as count
      from users u
      join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
      join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
     where u.tenant_id = ${tenantId} and u.id <> ${excludedUserId} and u.status = 'active'
       and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)
       and u.business_user
       and ur.source_key = 'local' and ur.role_id = 'role-platform-admin'
       and (ur.valid_until is null or ur.valid_until > now())
       and r.status = 'active' and r.permissions ? ${LOCAL_PERMISSIONS.adminAll}
  `
  if (!row || row.count < 1) throw stateConflict('不能移除最后一个有效的平台管理员')
}

export async function lockPlatformAdminInvariant(transaction: DatabaseTransaction) {
  await transaction`
    select pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:role-platform-admin:minimum-one-active`}, 0)
    )
  `
}

function normalizeRoleInput(input: {
  name: string
  description?: string
  permissions?: string[]
  dataScopes?: string[]
}) {
  // 角色编码由系统生成（功能规则第 13 节）：创建后不变，用于审计与接口引用。
  const code = `role_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  return {
    code,
    name: requiredText(input.name, '角色名称', 80),
    description: optionalText(input.description, 500),
    permissions: normalizePermissions(input.permissions ?? []),
    dataScopes: normalizeScopes(input.dataScopes ?? []),
  }
}

function normalizePermissions(values: string[]) {
  if (!Array.isArray(values)) throw invalidRequest('角色权限必须是数组')
  const allowed = new Set(permissionCatalog.map(item => item.code))
  const normalized = unique(values.map(item => String(item).trim()).filter(Boolean))
  const unknown = normalized.filter(item => !allowed.has(item as typeof permissionCatalog[number]['code']))
  if (unknown.length > 0) throw invalidRequest(`包含未知的本地权限：${unknown.join('、')}`)
  return normalized.sort()
}

function normalizeScopes(values: string[]) {
  if (!Array.isArray(values)) throw invalidRequest('数据范围必须是数组')
  const scopes = unique(values.map(item => String(item).trim()).filter(Boolean))
  if (scopes.length > 100) throw invalidRequest('数据范围最多配置 100 项')
  for (const scope of scopes) {
    if (scope.length > 160 || !/^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(scope)) {
      throw invalidRequest(`数据范围格式无效：${scope}`)
    }
  }
  return scopes.sort()
}

function requiredText(value: string, label: string, maxLength: number) {
  const normalized = value.trim()
  if (!normalized) throw stateConflict(`${label}不能为空`)
  if (normalized.length > maxLength) throw stateConflict(`${label}长度不能超过 ${maxLength}`)
  return normalized
}

function optionalText(value: string | undefined, maxLength: number) {
  const normalized = value?.trim() ?? ''
  if (normalized.length > maxLength) throw stateConflict(`描述长度不能超过 ${maxLength}`)
  return normalized
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  if (!Number.isSafeInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value as number))
}
