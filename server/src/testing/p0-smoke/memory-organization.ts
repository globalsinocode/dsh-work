import { invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'
import type {
  OrganizationDepartment,
  OrganizationEmployee,
  OrganizationGrant,
  OrganizationMember,
  OrganizationRole,
  OrganizationRoleAssignment,
  OrganizationSnapshot,
} from '../../modules/organization/postgres-organization-service.ts'

/**
 * P0 冒烟用的组织架构（验收目录 ORG-P0-01）：一棵确定性的部门树与员工，只用于页面冒烟，
 * 随 `/api/testing/p0/reset` 重建。约束口径（重名、移到下级之下、删除拦截、主部门）与
 * PostgreSQL 实现一致的部分在这里简化重现；并发、审计与显示部门写回由 ORG-01～04 集成测试保证。
 */
export class MemoryOrganizationStore {
  private departments: OrganizationDepartment[] = [
    { id: 'dept-root', parentId: null, name: '示例企业', sortOrder: 0 },
    { id: 'dept-scm', parentId: 'dept-root', name: '供应链中心', sortOrder: 0 },
    { id: 'dept-buy', parentId: 'dept-scm', name: '采购部', sortOrder: 0 },
    { id: 'dept-wms', parentId: 'dept-scm', name: '仓储物流部', sortOrder: 1 },
    { id: 'dept-dig', parentId: 'dept-root', name: '数字化中心', sortOrder: 1 },
    { id: 'dept-fin', parentId: 'dept-root', name: '财务部', sortOrder: 2 },
    { id: 'dept-sal', parentId: 'dept-root', name: '销售部', sortOrder: 3 },
    { id: 'dept-east', parentId: 'dept-sal', name: '华东销售部', sortOrder: 0 },
    { id: 'dept-south', parentId: 'dept-sal', name: '华南销售部', sortOrder: 1 },
    { id: 'dept-hr', parentId: 'dept-root', name: '人力资源部', sortOrder: 4 },
  ]

  private members: OrganizationMember[] = [
    { departmentId: 'dept-scm', userId: 'U30001', primary: true },
    { departmentId: 'dept-buy', userId: 'U30002', primary: true },
    { departmentId: 'dept-buy', userId: 'U30003', primary: true },
    { departmentId: 'dept-wms', userId: 'U30004', primary: true },
    { departmentId: 'dept-dig', userId: 'U30005', primary: true },
    { departmentId: 'dept-scm', userId: 'U30005', primary: false },
    { departmentId: 'dept-dig', userId: 'U30006', primary: true },
    { departmentId: 'dept-fin', userId: 'U30007', primary: true },
    { departmentId: 'dept-sal', userId: 'U30008', primary: true },
    { departmentId: 'dept-east', userId: 'U30009', primary: true },
  ]

  private readonly employees: OrganizationEmployee[] = [
    ['U30001', '张伟', 'zhangwei'], ['U30002', '李娜', 'lina'], ['U30003', '王磊', 'wanglei'], ['U30004', '刘洋', 'liuyang'],
    ['U30005', '陈静', 'chenjing'], ['U30006', '杨帆', 'yangfan'], ['U30007', '黄强', 'huangqiang'], ['U30008', '吴昊', 'wuhao'],
    ['U30009', '徐丽', 'xuli'], ['U30010', '马超', 'machao'], ['U30011', '朱琳', 'zhulin'], ['U30012', '郭雪', 'guoxue'],
  ].map(([id, name, account]) => ({
    id: id!, name: name!, email: `${account}@example.invalid`, loginAccount: `${account}@example.invalid`, status: 'active' as const,
  }))

  private readonly roles: OrganizationRole[] = [
    { id: 'role-employee', code: 'employee', name: '员工', status: 'active', assignable: true },
    { id: 'role-department-manager', code: 'department_manager', name: '部门负责人', status: 'active', assignable: true },
    { id: 'role-supply-analyst', code: 'supply_analyst', name: '供应链分析员', status: 'active', assignable: true },
    { id: 'role-platform-admin', code: 'platform_admin', name: '平台管理员', status: 'active', assignable: false },
    { id: 'role-auditor', code: 'auditor', name: '审计员', status: 'active', assignable: false },
  ]

  private grants: OrganizationGrant[] = [
    { id: 'grant-smoke-scm', departmentId: 'dept-scm', departmentName: '供应链中心', roleId: 'role-supply-analyst', includeDescendants: true, status: 'active' },
  ]

  private sequence = 0

  async snapshot(): Promise<OrganizationSnapshot> {
    return {
      departments: this.departments.map(department => ({ ...department })),
      members: this.members.map(member => ({ ...member })),
      employees: this.employees.map(employee => ({ ...employee })),
      grants: this.grants.map(grant => ({ ...grant })),
      roles: this.roles.map(role => ({ ...role })),
      roleAssignments: this.roleAssignments(),
    }
  }

  async grantRole(input: { departmentId: string; roleId: unknown; includeDescendants?: unknown; actorId: string }) {
    if (typeof input.roleId !== 'string' || !input.roleId) throw invalidRequest('请选择要授予的角色')
    if (input.includeDescendants !== undefined && typeof input.includeDescendants !== 'boolean') throw invalidRequest('includeDescendants 必须为布尔值')
    const department = this.require(input.departmentId)
    const role = this.roles.find(item => item.id === input.roleId)
    if (!role) throw notFound('角色不存在')
    if (role.status !== 'active') throw stateConflict(`角色“${role.name}”已停用，不能授给部门`)
    if (!role.assignable) throw stateConflict(`角色“${role.name}”含管理类权限，只能在“员工与权限”中单独授给个人`)
    if (this.grants.some(grant => grant.status === 'active' && grant.departmentId === department.id && grant.roleId === role.id)) {
      throw stateConflict('本部门已授予这个角色')
    }
    this.grants.push({
      id: `grant-smoke-${++this.sequence}`, departmentId: department.id, departmentName: department.name,
      roleId: role.id, includeDescendants: input.includeDescendants !== false, status: 'active',
    })
    return this.snapshot()
  }

  async revokeGrant(input: { grantId: string; actorId: string }) {
    if (!this.grants.some(grant => grant.id === input.grantId)) throw notFound('部门授权不存在')
    this.grants = this.grants.filter(grant => grant.id !== input.grantId)
    return this.snapshot()
  }

  /** 冒烟员工都直接持有“员工”角色；部门授权按当前成员关系展开，与 PostgreSQL 的展开口径一致。 */
  private roleAssignments(): OrganizationRoleAssignment[] {
    const direct = this.employees.map(employee => ({ userId: employee.id, roleId: 'role-employee', source: 'direct' as const }))
    const derived = this.grants.filter(grant => grant.status === 'active').flatMap(grant => {
      const covered = grant.includeDescendants ? this.descendants(grant.departmentId) : [grant.departmentId]
      const userIds = [...new Set(this.members.filter(member => covered.includes(member.departmentId)).map(member => member.userId))]
      return userIds.map(userId => ({ userId, roleId: grant.roleId, source: { grantId: grant.id } }))
    })
    return [...direct, ...derived]
  }

  async createDepartment(input: { parentId: unknown; name: unknown; actorId: string }) {
    const parent = this.require(String(input.parentId ?? ''))
    const name = this.name(input.name)
    this.assertNameFree(parent.id, name)
    this.departments.push({ id: `dept-smoke-${++this.sequence}`, parentId: parent.id, name, sortOrder: this.nextOrder(parent.id) })
    return this.snapshot()
  }

  async updateDepartment(input: { departmentId: string; name?: unknown; parentId?: unknown; actorId: string }) {
    const department = this.require(input.departmentId)
    const name = input.name !== undefined ? this.name(input.name) : department.name
    if (input.parentId !== undefined && input.parentId !== department.parentId) {
      if (!department.parentId) throw stateConflict('根部门不能移动')
      const target = this.require(String(input.parentId))
      if (this.descendants(department.id).includes(target.id)) throw stateConflict('不能移动到本部门自己或它的下级部门之下')
      this.assertNameFree(target.id, name, department.id)
      department.sortOrder = this.nextOrder(target.id)
      department.parentId = target.id
    } else if (department.parentId) {
      this.assertNameFree(department.parentId, name, department.id)
    }
    department.name = name
    return this.snapshot()
  }

  async reorderDepartment(input: { departmentId: string; direction: unknown; actorId: string }) {
    if (input.direction !== 'up' && input.direction !== 'down') throw invalidRequest('direction 必须为 up 或 down')
    const department = this.require(input.departmentId)
    if (!department.parentId) throw stateConflict('根部门不能调整顺序')
    // 与 PostgreSQL 一致：交换后把同级重新编号，删除部门后留下的空号不会让调整失效。
    const siblings = this.childrenOf(department.parentId)
    const index = siblings.indexOf(department)
    const swapWith = input.direction === 'up' ? index - 1 : index + 1
    if (swapWith >= 0 && swapWith < siblings.length) {
      ;[siblings[index], siblings[swapWith]] = [siblings[swapWith]!, siblings[index]!]
      siblings.forEach((sibling, position) => { sibling.sortOrder = position })
    }
    return this.snapshot()
  }

  async removeDepartment(input: { departmentId: string; actorId: string }) {
    const department = this.require(input.departmentId)
    if (!department.parentId) throw stateConflict('根部门不能删除')
    const children = this.childrenOf(department.id).length
    const members = this.members.filter(member => member.departmentId === department.id).length
    const reasons = [children ? `还有 ${children} 个下级部门` : '', members ? `还有 ${members} 名成员` : ''].filter(Boolean)
    if (reasons.length) throw stateConflict(`不能删除“${department.name}”：${reasons.join('，')}`)
    this.departments = this.departments.filter(item => item.id !== department.id)
    for (const grant of this.grants) if (grant.departmentId === department.id) grant.status = 'invalid'
    return this.snapshot()
  }

  async addMembers(input: { departmentId: string; userIds: unknown; actorId: string }) {
    const department = this.require(input.departmentId)
    if (!Array.isArray(input.userIds) || input.userIds.length === 0 || input.userIds.length > 200
      || input.userIds.some(id => typeof id !== 'string' || !id)) {
      throw invalidRequest('userIds 必须为 1–200 个员工 ID')
    }
    const userIds = [...new Set(input.userIds as string[])]
    // 与 PostgreSQL 一致：先整体校验，任何一个无效都不加入任何人。
    if (!userIds.every(userId => this.employees.some(employee => employee.id === userId && employee.status === 'active'))) {
      throw invalidRequest('包含不存在或已停用的员工')
    }
    for (const userId of userIds) {
      if (this.members.some(member => member.departmentId === department.id && member.userId === userId)) continue
      const hasPrimary = this.members.some(member => member.userId === userId && member.primary)
      this.members.push({ departmentId: department.id, userId, primary: !hasPrimary })
    }
    return this.snapshot()
  }

  async removeMember(input: { departmentId: string; userId: string; newPrimaryDepartmentId?: unknown; actorId: string }) {
    const removed = this.members.find(member => member.departmentId === input.departmentId && member.userId === input.userId)
    if (!removed) throw notFound('该员工不在这个部门中')
    const others = this.members.filter(member => member.userId === input.userId && member !== removed)
    if (removed.primary && others.length) {
      const next = others.find(member => member.departmentId === input.newPrimaryDepartmentId)
      if (!next) throw invalidRequest('本部门是该员工的主部门，请从其所属的其他部门中指定新的主部门')
      next.primary = true
    }
    this.members = this.members.filter(member => member !== removed)
    return this.snapshot()
  }

  async setPrimaryDepartment(input: { departmentId: string; userId: string; actorId: string }) {
    const target = this.members.find(member => member.departmentId === input.departmentId && member.userId === input.userId)
    if (!target) throw notFound('该员工不在这个部门中')
    for (const member of this.members) if (member.userId === input.userId) member.primary = member === target
    return this.snapshot()
  }

  private require(id: string) {
    const department = this.departments.find(item => item.id === id)
    if (!department) throw notFound('部门不存在或已删除')
    return department
  }

  private childrenOf(id: string) {
    return this.departments.filter(item => item.parentId === id).sort((a, b) => a.sortOrder - b.sortOrder)
  }

  private nextOrder(parentId: string) {
    return Math.max(-1, ...this.childrenOf(parentId).map(child => child.sortOrder)) + 1
  }

  private descendants(id: string): string[] {
    return [id, ...this.childrenOf(id).flatMap(child => this.descendants(child.id))]
  }

  private name(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) throw invalidRequest('请输入部门名称')
    if ([...value.trim()].length > 60) throw invalidRequest('部门名称不能超过 60 个字符')
    return value.trim()
  }

  private assertNameFree(parentId: string, name: string, exceptId = '') {
    if (this.childrenOf(parentId).some(item => item.name === name && item.id !== exceptId)) throw stateConflict('同一上级部门下已有同名部门')
  }
}
