import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { requirePlatformAdminActor } from '../authorization/platform-admin-actor.ts'
import { invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'

const tenantId = 'tenant-dsh-work'
const maxNameLength = 60
const maxMembersPerRequest = 200

/** 管理类权限：带任一权限的角色不能授给部门（方案 OD8），只能单独授给个人。 */
export const DEPARTMENT_FORBIDDEN_PERMISSIONS = ['admin:*', 'admin:write', 'admin:read', 'audit:read', 'data-protection:terms'] as const

export interface OrganizationDepartment {
  id: string
  parentId: string | null
  name: string
  sortOrder: number
}

export interface OrganizationMember {
  departmentId: string
  userId: string
  primary: boolean
}

export interface OrganizationEmployee {
  id: string
  name: string
  email: string | null
  loginAccount: string | null
  status: 'active' | 'disabled'
}

export interface OrganizationGrant {
  id: string
  departmentId: string
  /** 部门被删除后授权失效，仍返回原部门名称供管理员识别。 */
  departmentName: string
  roleId: string
  includeDescendants: boolean
  status: 'active' | 'invalid'
}

export interface OrganizationRole {
  id: string
  code: string
  name: string
  status: 'active' | 'disabled'
  /** 启用且不含管理类权限的角色才能授给部门。 */
  assignable: boolean
}

export interface OrganizationRoleAssignment {
  userId: string
  roleId: string
  /** direct：在“员工与权限”中直接授予；其余为授予该角色的部门授权 ID。 */
  source: 'direct' | { grantId: string }
}

export interface OrganizationSnapshot {
  departments: OrganizationDepartment[]
  members: OrganizationMember[]
  employees: OrganizationEmployee[]
  grants: OrganizationGrant[]
  roles: OrganizationRole[]
  roleAssignments: OrganizationRoleAssignment[]
}

interface DepartmentRow {
  id: string
  parentId: string | null
  name: string
  path: string
}

/**
 * 企业组织架构 ORG-S1（docs/design/org-structure-plan.md）：本地维护的部门树、成员与主部门。
 * 部门本身不带权限；按部门授权是第二期（ORG-S2）。所有写操作只有平台管理员可以执行，按企业
 * 串行（事务级咨询锁），在同一事务中同步员工的显示部门（users.department_id = 主部门名称）并写审计。
 */
export class PostgresOrganizationService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async snapshot(): Promise<OrganizationSnapshot> {
    return readSnapshot(this.database)
  }

  async createDepartment(input: { parentId: unknown; name: unknown; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const parent = await requireDepartment(transaction, text(input.parentId, '上级部门'))
      const name = departmentName(input.name)
      await assertSiblingNameFree(transaction, parent.id, name)
      const id = `dept-${randomUUID()}`
      await transaction`
        insert into org_departments (id, tenant_id, parent_id, name, path, sort_order, updated_by)
        values (
          ${id}, ${tenantId}, ${parent.id}, ${name}, ${`${parent.path}${id}/`},
          (select coalesce(max(sort_order) + 1, 0) from org_departments
            where tenant_id = ${tenantId} and parent_id = ${parent.id} and status = 'active'),
          ${input.actorId}
        )
      `
      return { action: 'organization.department.create', objectId: id, context: { parentId: parent.id } }
    })
  }

  async updateDepartment(input: { departmentId: string; name?: unknown; parentId?: unknown; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      const changed: string[] = []
      // 同时移动和改名时，按改名后的名称检查新上级下是否重名。
      const finalName = input.name !== undefined ? departmentName(input.name) : department.name
      const renamed = finalName !== department.name
      if (input.parentId !== undefined && input.parentId !== department.parentId) {
        if (!department.parentId) throw stateConflict('根部门不能移动')
        const target = await requireDepartment(transaction, text(input.parentId, '上级部门'))
        if (target.path.startsWith(department.path)) throw stateConflict('不能移动到本部门自己或它的下级部门之下')
        await assertSiblingNameFree(transaction, target.id, finalName, department.id)
        const newPath = `${target.path}${department.id}/`
        await transaction`
          update org_departments
             set path = ${newPath} || substr(path, ${department.path.length + 1}), updated_at = now()
           where tenant_id = ${tenantId} and left(path, ${department.path.length}) = ${department.path}
        `
        await transaction`
          update org_departments
             set parent_id = ${target.id}, name = ${finalName}, updated_by = ${input.actorId},
                 sort_order = (select coalesce(max(sort_order) + 1, 0) from org_departments
                                where tenant_id = ${tenantId} and parent_id = ${target.id} and status = 'active')
           where tenant_id = ${tenantId} and id = ${department.id}
        `
        changed.push('parent')
      } else if (renamed) {
        if (department.parentId) await assertSiblingNameFree(transaction, department.parentId, finalName, department.id)
        await transaction`
          update org_departments set name = ${finalName}, updated_at = now(), updated_by = ${input.actorId}
           where tenant_id = ${tenantId} and id = ${department.id}
        `
      }
      // 移动时名称与上级在同一条语句中写入，避免先以旧名挂到新上级下触发同级重名约束。
      if (renamed) {
        await transaction`
          update users u set department_id = ${finalName}, updated_at = now()
            from org_department_members m
           where m.tenant_id = ${tenantId} and m.department_id = ${department.id} and m.is_primary
             and u.tenant_id = m.tenant_id and u.id = m.user_id
        `
        changed.push('name')
      }
      return { action: 'organization.department.update', objectId: department.id, context: { changed } }
    }, { syncRoles: input.parentId !== undefined })
  }

  async reorderDepartment(input: { departmentId: string; direction: unknown; actorId: string }) {
    if (input.direction !== 'up' && input.direction !== 'down') throw invalidRequest('direction 必须为 up 或 down')
    const direction = input.direction
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      if (!department.parentId) throw stateConflict('根部门不能调整顺序')
      const siblings = await transaction<{ id: string }[]>`
        select id from org_departments
         where tenant_id = ${tenantId} and parent_id = ${department.parentId} and status = 'active'
         order by sort_order, name, id
      `
      const index = siblings.findIndex(sibling => sibling.id === department.id)
      const swapWith = direction === 'up' ? index - 1 : index + 1
      if (swapWith >= 0 && swapWith < siblings.length) {
        const order = siblings.map(sibling => sibling.id)
        ;[order[index], order[swapWith]] = [order[swapWith]!, order[index]!]
        for (const [position, id] of order.entries()) {
          await transaction`update org_departments set sort_order = ${position} where tenant_id = ${tenantId} and id = ${id}`
        }
      }
      return { action: 'organization.department.reorder', objectId: department.id, context: { direction } }
    }, { syncRoles: false })
  }

  async removeDepartment(input: { departmentId: string; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      if (!department.parentId) throw stateConflict('根部门不能删除')
      const [usage] = await transaction<{ children: number; members: number }[]>`
        select (select count(*)::integer from org_departments
                 where tenant_id = ${tenantId} and parent_id = ${department.id} and status = 'active') as children,
               (select count(*)::integer from org_department_members
                 where tenant_id = ${tenantId} and department_id = ${department.id}) as members
      `
      const reasons = [
        usage!.children ? `还有 ${usage!.children} 个下级部门` : '',
        usage!.members ? `还有 ${usage!.members} 名成员` : '',
      ].filter(Boolean)
      if (reasons.length) throw stateConflict(`不能删除“${department.name}”：${reasons.join('，')}`)
      await transaction`
        update org_departments set status = 'removed', updated_at = now(), updated_by = ${input.actorId}
         where tenant_id = ${tenantId} and id = ${department.id}
      `
      // 部门授权保留但失效，不转移给上级部门（方案 6.3）。
      await transaction`
        update org_department_grants set status = 'invalid', invalidated_at = now()
         where tenant_id = ${tenantId} and department_id = ${department.id} and status = 'active'
      `
      return { action: 'organization.department.remove', objectId: department.id, context: {} }
    })
  }

  async addMembers(input: { departmentId: string; userIds: unknown; actorId: string }) {
    if (!Array.isArray(input.userIds) || input.userIds.length === 0 || input.userIds.length > maxMembersPerRequest
      || input.userIds.some(id => typeof id !== 'string' || !id)) {
      throw invalidRequest(`userIds 必须为 1–${maxMembersPerRequest} 个员工 ID`)
    }
    const userIds = [...new Set(input.userIds as string[])]
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      const valid = await transaction<{ id: string }[]>`
        select u.id from users u
         where u.tenant_id = ${tenantId} and u.id in ${transaction(userIds)} and u.status = 'active' and u.business_user
           and (u.identity_provider = 'ai-hub'
                or exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id))
      `
      if (valid.length !== userIds.length) throw invalidRequest('包含不存在或已停用的员工')
      for (const userId of userIds) await addMembership(transaction, department.id, userId, input.actorId)
      return { action: 'organization.member.add', objectId: department.id, context: { userIds } }
    })
  }

  async removeMember(input: { departmentId: string; userId: string; newPrimaryDepartmentId?: unknown; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const memberships = await transaction<{ departmentId: string; primary: boolean }[]>`
        select m.department_id as "departmentId", m.is_primary as primary
          from org_department_members m
         where m.tenant_id = ${tenantId} and m.user_id = ${input.userId}
      `
      const removed = memberships.find(membership => membership.departmentId === input.departmentId)
      if (!removed) throw notFound('该员工不在这个部门中')
      const others = memberships.filter(membership => membership.departmentId !== input.departmentId)
      let newPrimary: string | null = null
      if (removed.primary && others.length) {
        newPrimary = typeof input.newPrimaryDepartmentId === 'string' ? input.newPrimaryDepartmentId : null
        if (!newPrimary || !others.some(membership => membership.departmentId === newPrimary)) {
          throw invalidRequest('本部门是该员工的主部门，请从其所属的其他部门中指定新的主部门')
        }
      }
      await transaction`
        delete from org_department_members
         where tenant_id = ${tenantId} and department_id = ${input.departmentId} and user_id = ${input.userId}
      `
      if (newPrimary) {
        await transaction`
          update org_department_members set is_primary = true
           where tenant_id = ${tenantId} and department_id = ${newPrimary} and user_id = ${input.userId}
        `
      }
      await syncDisplayDepartment(transaction, input.userId)
      return { action: 'organization.member.remove', objectId: input.departmentId, context: { userId: input.userId, newPrimary } }
    })
  }

  async setPrimaryDepartment(input: { departmentId: string; userId: string; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const [membership] = await transaction`
        select 1 from org_department_members
         where tenant_id = ${tenantId} and department_id = ${input.departmentId} and user_id = ${input.userId}
      `
      if (!membership) throw notFound('该员工不在这个部门中')
      await transaction`
        update org_department_members set is_primary = false
         where tenant_id = ${tenantId} and user_id = ${input.userId} and is_primary
      `
      await transaction`
        update org_department_members set is_primary = true
         where tenant_id = ${tenantId} and department_id = ${input.departmentId} and user_id = ${input.userId}
      `
      await syncDisplayDepartment(transaction, input.userId)
      return { action: 'organization.member.primary', objectId: input.departmentId, context: { userId: input.userId } }
    }, { syncRoles: false })
  }

  async grantRole(input: { departmentId: string; roleId: unknown; includeDescendants?: unknown; actorId: string }) {
    if (typeof input.roleId !== 'string' || !input.roleId) throw invalidRequest('请选择要授予的角色')
    if (input.includeDescendants !== undefined && typeof input.includeDescendants !== 'boolean') {
      throw invalidRequest('includeDescendants 必须为布尔值')
    }
    const roleId = input.roleId
    const includeDescendants = input.includeDescendants ?? true
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      const [role] = await transaction<{ name: string; status: string; permissions: string[] }[]>`
        select name, status, permissions from roles where tenant_id = ${tenantId} and id = ${roleId} for share
      `
      if (!role) throw notFound('角色不存在')
      if (role.status !== 'active') throw stateConflict(`角色“${role.name}”已停用，不能授给部门`)
      if (hasForbiddenPermission(role.permissions)) {
        throw stateConflict(`角色“${role.name}”含管理类权限，只能在“员工与权限”中单独授给个人`)
      }
      const [existing] = await transaction`
        select 1 from org_department_grants
         where tenant_id = ${tenantId} and department_id = ${department.id} and role_id = ${roleId} and status = 'active'
      `
      if (existing) throw stateConflict('本部门已授予这个角色')
      const id = `dept-grant-${randomUUID()}`
      await transaction`
        insert into org_department_grants (id, tenant_id, department_id, role_id, include_descendants, granted_by)
        values (${id}, ${tenantId}, ${department.id}, ${roleId}, ${includeDescendants}, ${input.actorId})
      `
      return { action: 'organization.grant.create', objectId: id, context: { departmentId: department.id, roleId, includeDescendants } }
    })
  }

  /** 删除部门授权；失效授权（部门已删除）同样通过它清除。 */
  async revokeGrant(input: { grantId: string; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const [grant] = await transaction<{ departmentId: string; roleId: string }[]>`
        delete from org_department_grants where tenant_id = ${tenantId} and id = ${input.grantId}
        returning department_id as "departmentId", role_id as "roleId"
      `
      if (!grant) throw notFound('部门授权不存在')
      return { action: 'organization.grant.revoke', objectId: input.grantId, context: { ...grant } }
    })
  }

  /** syncRoles=false 用于不改变部门覆盖范围的写操作（改名、排序、设主部门），省去重算部门角色。 */
  private async write(
    actorId: string,
    change: (transaction: DatabaseTransaction) => Promise<{ action: string; objectId: string; context: Record<string, unknown> }>,
    options: { syncRoles?: boolean } = {},
  ): Promise<OrganizationSnapshot> {
    return this.database.begin(async (transaction) => {
      await requirePlatformAdminActor(transaction, actorId)
      await lockOrganization(transaction)
      const audit = await change(transaction)
      if (options.syncRoles !== false) await syncDepartmentRoles(transaction)
      await appendOrganizationAudit(transaction, { actorId, ...audit })
      return readSnapshot(transaction)
    })
  }
}

/**
 * 新建账号时把员工放入一个部门并设为主部门（方案第 5 节“员工账号”），与建号同一事务。
 * 只校验部门有效；操作人是否为平台管理员由建号流程负责。
 */
export async function assignNewAccountDepartment(
  transaction: DatabaseTransaction,
  input: { userId: string; departmentId: unknown; actorId: string },
) {
  if (typeof input.departmentId !== 'string' || !input.departmentId) throw invalidRequest('部门无效')
  await lockOrganization(transaction)
  const department = await requireDepartment(transaction, input.departmentId)
  await addMembership(transaction, department.id, input.userId, input.actorId)
  await syncDepartmentRoles(transaction)
}

/**
 * 角色在已授给部门时不能加入管理类权限（方案 OD8），否则调整部门成员就会间接授予管理权限。
 * 由“员工与权限”修改角色时在同一事务中调用。
 */
export async function assertRoleDepartmentGrantable(transaction: DatabaseTransaction, roleId: string, permissions: string[]) {
  if (!hasForbiddenPermission(permissions)) return
  const [granted] = await transaction`
    select 1 from org_department_grants where tenant_id = ${tenantId} and role_id = ${roleId} and status = 'active' limit 1
  `
  if (granted) throw stateConflict('该角色已授给部门，不能加入管理类权限；请先在“组织架构”中删除对应的部门授权')
}

function hasForbiddenPermission(permissions: unknown) {
  return Array.isArray(permissions) && permissions.some(permission => (DEPARTMENT_FORBIDDEN_PERMISSIONS as readonly string[]).includes(permission))
}

/**
 * 把有效的部门授权展开为 user_roles（source_key = 'department:<grant_id>'），与期望集合对比后
 * 只增删差异行：授权、成员关系、部门移动或删除后都调用。权限版本由 user_roles 触发器按行递增
 * （方案 6.2）。停用的角色仍展开，由读取端按角色状态忽略，重新启用即恢复。
 */
async function syncDepartmentRoles(transaction: DatabaseTransaction) {
  await transaction`
    with desired as (
      select distinct m.user_id, g.role_id, 'department:' || g.id as source_key
        from org_department_grants g
        join org_departments granted on granted.tenant_id = g.tenant_id and granted.id = g.department_id and granted.status = 'active'
        join org_departments covered on covered.tenant_id = g.tenant_id and covered.status = 'active'
         and (covered.id = granted.id or (g.include_descendants and left(covered.path, length(granted.path)) = granted.path))
        join org_department_members m on m.tenant_id = covered.tenant_id and m.department_id = covered.id
       where g.tenant_id = ${tenantId} and g.status = 'active'
    )
    delete from user_roles ur
     where ur.tenant_id = ${tenantId} and ur.source_key like 'department:%'
       and not exists (
         select 1 from desired d where d.user_id = ur.user_id and d.role_id = ur.role_id and d.source_key = ur.source_key
       )
  `
  await transaction`
    with desired as (
      select distinct m.user_id, g.role_id, 'department:' || g.id as source_key, g.granted_by
        from org_department_grants g
        join org_departments granted on granted.tenant_id = g.tenant_id and granted.id = g.department_id and granted.status = 'active'
        join org_departments covered on covered.tenant_id = g.tenant_id and covered.status = 'active'
         and (covered.id = granted.id or (g.include_descendants and left(covered.path, length(granted.path)) = granted.path))
        join org_department_members m on m.tenant_id = covered.tenant_id and m.department_id = covered.id
       where g.tenant_id = ${tenantId} and g.status = 'active'
    )
    insert into user_roles (tenant_id, user_id, role_id, source_key, granted_by)
    select ${tenantId}, d.user_id, d.role_id, d.source_key, d.granted_by from desired d
    on conflict do nothing
  `
}

async function readSnapshot(sql: DatabaseClient | DatabaseTransaction): Promise<OrganizationSnapshot> {
  const departments = await sql<OrganizationDepartment[]>`
    select id, parent_id as "parentId", name, sort_order as "sortOrder"
      from org_departments
     where tenant_id = ${tenantId} and status = 'active'
     order by path = '/' || id || '/' desc, sort_order, name, id
  `
  const members = await sql<OrganizationMember[]>`
    select m.department_id as "departmentId", m.user_id as "userId", m.is_primary as primary
      from org_department_members m
      join org_departments d on d.tenant_id = m.tenant_id and d.id = m.department_id and d.status = 'active'
     where m.tenant_id = ${tenantId}
     order by m.user_id, m.department_id
  `
  const employees = await sql<OrganizationEmployee[]>`
    select u.id, u.display_name as name, u.email, u.status,
           coalesce(
             (select c.username from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id),
             case when u.identity_provider = 'ai-hub' then u.external_subject end
           ) as "loginAccount"
      from users u
     where u.tenant_id = ${tenantId} and u.business_user
       and (u.identity_provider = 'ai-hub'
            or exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id))
     order by u.display_name, u.id
  `
  const grants = await sql<OrganizationGrant[]>`
    select g.id, g.department_id as "departmentId", d.name as "departmentName", g.role_id as "roleId",
           g.include_descendants as "includeDescendants", g.status
      from org_department_grants g
      join org_departments d on d.tenant_id = g.tenant_id and d.id = g.department_id
     where g.tenant_id = ${tenantId}
     order by g.created_at, g.id
  `
  const roleRows = await sql<(Omit<OrganizationRole, 'assignable'> & { permissions: string[] })[]>`
    select id, code, name, status, permissions from roles where tenant_id = ${tenantId} order by name, id
  `
  const roles = roleRows.map(({ permissions, ...role }) => ({
    ...role, assignable: role.status === 'active' && !hasForbiddenPermission(permissions),
  }))
  const assignmentRows = await sql<{ userId: string; roleId: string; sourceKey: string }[]>`
    select ur.user_id as "userId", ur.role_id as "roleId", ur.source_key as "sourceKey"
      from user_roles ur
      join users u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.business_user
     where ur.tenant_id = ${tenantId} and (ur.valid_until is null or ur.valid_until > now())
       and (ur.source_key = 'local' or ur.source_key like 'department:%')
     order by ur.user_id, ur.role_id, ur.source_key
  `
  const roleAssignments = assignmentRows.map(row => ({
    userId: row.userId,
    roleId: row.roleId,
    source: row.sourceKey === 'local' ? 'direct' as const : { grantId: row.sourceKey.slice('department:'.length) },
  }))
  return { departments, members, employees, grants, roles, roleAssignments }
}

/** 树的写操作按企业串行，避免两次并发移动绕过“不能移到自己下级之下”的检查而形成环。 */
async function lockOrganization(transaction: DatabaseTransaction) {
  await transaction`select pg_advisory_xact_lock(hashtext(${`org-departments:${tenantId}`}))`
}

async function requireDepartment(transaction: DatabaseTransaction, departmentId: string): Promise<DepartmentRow> {
  const [department] = await transaction<DepartmentRow[]>`
    select id, parent_id as "parentId", name, path
      from org_departments
     where tenant_id = ${tenantId} and id = ${departmentId} and status = 'active'
  `
  if (!department) throw notFound('部门不存在或已删除')
  return department
}

async function assertSiblingNameFree(transaction: DatabaseTransaction, parentId: string, name: string, exceptId = '') {
  const [clash] = await transaction`
    select 1 from org_departments
     where tenant_id = ${tenantId} and parent_id = ${parentId} and status = 'active' and name = ${name} and id <> ${exceptId}
  `
  if (clash) throw stateConflict('同一上级部门下已有同名部门')
}

/** 加入部门；还没有主部门的员工以该部门为主部门。重复加入幂等。 */
async function addMembership(transaction: DatabaseTransaction, departmentId: string, userId: string, actorId: string) {
  await transaction`
    insert into org_department_members (tenant_id, department_id, user_id, is_primary, added_by)
    values (
      ${tenantId}, ${departmentId}, ${userId},
      not exists (select 1 from org_department_members where tenant_id = ${tenantId} and user_id = ${userId} and is_primary),
      ${actorId}
    )
    on conflict (tenant_id, department_id, user_id) do nothing
  `
  await syncDisplayDepartment(transaction, userId)
}

/** 显示部门 = 主部门名称；没有主部门时为空（页面显示“未分配部门”）。 */
async function syncDisplayDepartment(transaction: DatabaseTransaction, userId: string) {
  await transaction`
    update users u
       set department_id = (
             select d.name from org_department_members m
               join org_departments d on d.tenant_id = m.tenant_id and d.id = m.department_id
              where m.tenant_id = u.tenant_id and m.user_id = u.id and m.is_primary
           ),
           updated_at = now()
     where u.tenant_id = ${tenantId} and u.id = ${userId}
  `
}

async function appendOrganizationAudit(
  transaction: DatabaseTransaction,
  input: { actorId: string; action: string; objectId: string; context: Record<string, unknown> },
) {
  await transaction`
    insert into audit_events (
      id, tenant_id, actor_type, actor_id, action, object_type,
      object_id, result, trace_id, safe_context
    ) values (
      ${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${input.actorId},
      ${input.action}, 'org_department', ${input.objectId}, 'success',
      ${`trace-organization-${randomUUID()}`},
      ${transaction.json({ audience: 'admin', ...input.context })}
    )
  `
}

function text(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw invalidRequest(`${label}不能为空`)
  return value.trim()
}

function departmentName(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw invalidRequest('请输入部门名称')
  const name = value.trim()
  if ([...name].length > maxNameLength) throw invalidRequest(`部门名称不能超过 ${maxNameLength} 个字符`)
  return name
}
