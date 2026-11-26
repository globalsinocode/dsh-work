import ElementPlus, { ElMessage } from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import type { OrganizationSnapshot } from '@/types/domain'
import OrganizationView from './OrganizationView.vue'

const auth = vi.hoisted(() => ({ canManage: true, canWrite(module: string) { return module === 'org' && this.canManage } }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

const wrappers: VueWrapper[] = []

function organization(): OrganizationSnapshot {
  return {
    departments: [
      { id: 'root', parentId: null, name: '示例企业', sortOrder: 0 },
      { id: 'scm', parentId: 'root', name: '供应链中心', sortOrder: 0 },
      { id: 'buy', parentId: 'scm', name: '采购部', sortOrder: 0 },
      { id: 'fin', parentId: 'root', name: '财务部', sortOrder: 1 },
    ],
    members: [
      { departmentId: 'scm', userId: 'u1', primary: true },
      { departmentId: 'buy', userId: 'u2', primary: true },
      { departmentId: 'scm', userId: 'u3', primary: false },
      { departmentId: 'fin', userId: 'u3', primary: true },
    ],
    employees: [
      { id: 'u1', name: '张伟', email: 'zhangwei@example.invalid', loginAccount: 'zhangwei@example.invalid', status: 'active' },
      { id: 'u2', name: '李娜', email: null, loginAccount: 'lina@example.invalid', status: 'active' },
      { id: 'u3', name: '陈静', email: null, loginAccount: 'chenjing@example.invalid', status: 'active' },
      { id: 'u4', name: '朱琳', email: null, loginAccount: 'zhulin@example.invalid', status: 'active' },
      { id: 'u5', name: '郭雪', email: null, loginAccount: 'guoxue@example.invalid', status: 'active' },
      { id: 'u6', name: '停用员工', email: null, loginAccount: 'disabled@example.invalid', status: 'disabled' },
    ],
    grants: [{ id: 'g1', departmentId: 'scm', departmentName: '供应链中心', roleId: 'role-analyst', includeDescendants: true, status: 'active' }],
    roles: [
      { id: 'role-employee', code: 'employee', name: '员工', status: 'active', assignable: true },
      { id: 'role-analyst', code: 'analyst', name: '供应链分析员', status: 'active', assignable: true },
      { id: 'role-platform-admin', code: 'platform_admin', name: '平台管理员', status: 'active', assignable: false },
    ],
    roleAssignments: [
      { userId: 'u1', roleId: 'role-employee', source: 'direct' },
      { userId: 'u1', roleId: 'role-analyst', source: { grantId: 'g1' } },
      { userId: 'u2', roleId: 'role-analyst', source: { grantId: 'g1' } },
      { userId: 'u3', roleId: 'role-analyst', source: { grantId: 'g1' } },
    ],
  }
}

async function render() {
  const wrapper = mount(OrganizationView, { global: { plugins: [ElementPlus], stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true } }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

async function selectDepartment(wrapper: VueWrapper, name: string) {
  const node = wrapper.findAll('.tree-node__name').find(item => item.text() === name)
  expect(node, `部门 ${name}`).toBeTruthy()
  await node!.trigger('click')
  await flushPromises()
}

function button(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAll('button').find(item => item.text() === text)
  expect(found, `按钮 ${text}`).toBeTruthy()
  return found!
}

beforeEach(() => {
  auth.canManage = true
  vi.spyOn(adminApi, 'getOrganization').mockResolvedValue(organization())
})

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  ElMessage.closeAll()
  vi.restoreAllMocks()
})

describe('OrganizationView', () => {
  it('opens straight into the tree with member counts and a compact overview', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain('部门本身不带权限')
    const counts = Object.fromEntries(wrapper.findAll('.tree-node').map(node => [node.get('.tree-node__name').text(), node.get('.tree-node__count').text()]))
    expect(counts).toEqual({ 示例企业: '3', 供应链中心: '3', 采购部: '1', 财务部: '1' })
    const metrics = wrapper.findAll('.overview-stat__value').map(item => item.text())
    expect(metrics).toEqual(['4', '3', '3', '1'])
    expect(wrapper.find('.metric-card').exists()).toBe(false)

    // 根部门没有直属成员时，空状态直接给出查看整棵子树成员的入口。
    expect(wrapper.text()).toContain('本部门还没有直属成员')
    await button(wrapper, '查看含下级部门的 3 名成员').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('张伟')
    expect(wrapper.text()).toContain('李娜')

    await selectDepartment(wrapper, '供应链中心')
    expect(wrapper.get('.department-header').text()).toContain('示例企业 / 供应链中心')
    expect(wrapper.get('.department-header').text()).toContain('直属成员 2 人 · 含下级 3 人 · 下级部门 1 个')
    expect(wrapper.text()).toContain('张伟')
    expect(wrapper.text()).not.toContain('李娜')
    await wrapper.get('.filter-bar input[type="checkbox"]').setValue(true)
    expect(wrapper.text()).toContain('李娜')
    expect(wrapper.text()).toContain('在下级部门')
  })

  it('offers sub-department matches when a search finds no direct members', async () => {
    const wrapper = await render()
    await wrapper.get('input[aria-label="搜索成员"]').setValue('张伟')
    await flushPromises()
    expect(wrapper.text()).toContain('没有匹配的成员')
    await button(wrapper, '在下级部门中找到 1 名匹配成员').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('张伟')
    expect(wrapper.text()).not.toContain('李娜')
  })

  it('resets the member filters when jumping to the parent department from an inherited grant', async () => {
    const wrapper = await render()
    await selectDepartment(wrapper, '采购部')
    await wrapper.get('.filter-bar input[type="checkbox"]').setValue(true)
    await wrapper.get('input[aria-label="搜索成员"]').setValue('李')
    await wrapper.findAll('.el-tabs__item').find(item => item.text().startsWith('部门授权'))!.trigger('click')
    await flushPromises()
    await button(wrapper, '到上级部门修改').trigger('click')
    await flushPromises()
    expect(wrapper.get('.department-header').text()).toContain('示例企业 / 供应链中心')
    expect((wrapper.get('.filter-bar input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.get('input[aria-label="搜索成员"]').element as HTMLInputElement).value).toBe('')
  })

  it('asks for a new primary department when removing a member from their primary department', async () => {
    const updated = organization()
    const remove = vi.spyOn(adminApi, 'removeDepartmentMember').mockResolvedValue(updated)
    const wrapper = await render()
    await selectDepartment(wrapper, '财务部')
    await button(wrapper, '移出').trigger('click')
    await flushPromises()
    const dialog = wrapper.findAll('[role="dialog"]').find(item => item.text().includes('移出部门'))!
    expect(dialog.text()).toContain('新的主部门')
    await dialog.findAll('button').find(item => item.text() === '移出')!.trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith('fin', 'u3', 'scm')
  })

  it('adds only unassigned active employees in one batch', async () => {
    const add = vi.spyOn(adminApi, 'addDepartmentMembers').mockResolvedValue(organization())
    const wrapper = await render()
    await selectDepartment(wrapper, '财务部')
    await button(wrapper, '添加成员').trigger('click')
    await flushPromises()
    const dialog = wrapper.findAll('[role="dialog"]').find(item => item.text().includes('添加成员到'))!
    expect(dialog.text()).not.toContain('停用员工')
    await dialog.findAll('input[type="checkbox"]').find(input => input.element.closest('label')?.textContent?.includes('只看未分配'))!.setValue(true)
    await flushPromises()
    expect(dialog.text()).toContain('显示 2 人')
    await dialog.findAll('button').find(item => item.text() === '全选当前列表')!.trigger('click')
    await flushPromises()
    await dialog.findAll('button').find(item => item.text().startsWith('添加（'))!.trigger('click')
    await flushPromises()
    expect(add).toHaveBeenCalledWith('fin', ['u4', 'u5'])
  })

  it('lists own and inherited department grants and grants a role to the subtree by default', async () => {
    const grant = vi.spyOn(adminApi, 'grantDepartmentRole').mockResolvedValue(organization())
    const wrapper = await render()
    await selectDepartment(wrapper, '采购部')
    await wrapper.findAll('.el-tabs__item').find(item => item.text().startsWith('部门授权'))!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('供应链分析员')
    expect(wrapper.text()).toContain('上级“供应链中心”')
    expect(wrapper.text()).toContain('到上级部门修改')

    await selectDepartment(wrapper, '财务部')
    await button(wrapper, '添加部门授权').trigger('click')
    await flushPromises()
    const dialog = wrapper.findAll('[role="dialog"]').find(item => item.text().includes('添加部门授权'))!
    expect(dialog.text()).toContain('将覆盖 1 名员工')
    await dialog.findAll('button').find(item => item.text() === '授权')!.trigger('click')
    await flushPromises()
    expect(grant).toHaveBeenCalledWith('fin', 'role-employee', true)
  })

  it('shows each role with where it comes from in the employee drawer', async () => {
    const wrapper = await render()
    await selectDepartment(wrapper, '采购部')
    const row = wrapper.findAll('.el-table__body tr').find(item => item.text().includes('李娜'))!
    await row.findAll('button').find(item => item.text() === '查看权限')!.trigger('click')
    await flushPromises()
    const drawer = wrapper.findAll('[role="dialog"]').find(item => item.text().includes('员工部门与角色'))!
    expect(drawer.text()).toContain('示例企业 / 供应链中心 / 采购部')
    expect(drawer.text()).toContain('来自“示例企业 / 供应链中心”（下级继承）')
  })

  it('hides write actions from read-only administrators', async () => {
    auth.canManage = false
    const wrapper = await render()
    expect(wrapper.findAll('button').some(item => ['新建子部门', '添加成员', '删除'].includes(item.text()))).toBe(false)
  })
})
