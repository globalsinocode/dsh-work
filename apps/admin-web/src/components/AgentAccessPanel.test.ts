import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AgentAccessPanel from './AgentAccessPanel.vue'
import { adminApi } from '../api/client'
import type { AgentAccess } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

function accessFixture(): AgentAccess {
  return {
    agentId: 'purchase-analyst', revision: 3, principalId: 'principal-agent-purchase-analyst',
    principalStatus: 'active',
    visibleRoleIds: ['role-finance', 'role-purchase'], roleIds: [], dataScopes: [],
    roleOptions: [
      { id: 'role-finance', name: '财务部', status: 'active' },
      { id: 'role-purchase', name: '采购部', status: 'active' },
      { id: 'role-purchase-analyst', name: '采购分析员', status: 'active' },
    ],
    scopeOptions: ['region:east'],
    routines: [{
      id: 'routine-1', name: '异常汇总', status: 'active',
      schedule: { kind: 'daily', timezone: 'Asia/Shanghai', timeOfDay: '08:00' },
      recipientUserId: 'U00002', recipientName: '采购主管',
    }],
  }
}

function mountPanel(embedded = false) {
  const wrapper = mount(AgentAccessPanel, {
    props: { agentId: 'purchase-analyst', canManage: true, embedded },
    global: {
      plugins: [ElementPlus],
      stubs: {
        teleport: true,
        ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
        ElOption: { props: ['value', 'label'], template: '<div class="option-stub" :data-value="value"><slot /></div>' },
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('AgentAccessPanel', () => {
  it('summarizes who may ask, what the Agent holds and what it does on its own', async () => {
    vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue(accessFixture())
    const wrapper = mountPanel()
    await flushPromises()
    const overview = wrapper.get('[data-testid="agent-access-overview"]').text()
    expect(overview).toContain('财务部、采购部可以向它请求工作')
    expect(overview).toContain('未持有岗位角色')
    expect(overview).toContain('每天 08:00，向采购主管交付「异常汇总」')
    // 内置工具不按角色授权，不再列出“能力所需授权”。
    expect(wrapper.text()).not.toContain('能力所需授权')
    expect(wrapper.find('[data-action="fill-access-gaps"]').exists()).toBe(false)
  })

  it('saves the chosen role and scope with the read revision', async () => {
    vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue(accessFixture())
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)
    const update = vi.spyOn(adminApi, 'updateAgentAccess').mockImplementation(async (_agentId, input) => ({
      ...accessFixture(), revision: 4, roleIds: input.roleIds, dataScopes: input.dataScopes,
    }))
    const wrapper = mountPanel()
    await flushPromises()
    const exposed = wrapper.vm as unknown as { save: () => Promise<boolean> }
    const form = (wrapper.vm.$ as unknown as { setupState: { form: { roleIds: string[]; dataScopes: string[] } } }).setupState.form
    form.roleIds = ['role-purchase-analyst']
    form.dataScopes = ['region:east']
    await flushPromises()
    await expect(exposed.save()).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith('purchase-analyst', {
      expectedRevision: 3,
      visibleRoleIds: ['role-finance', 'role-purchase'],
      roleIds: ['role-purchase-analyst'],
      dataScopes: ['region:east'],
      principalStatus: 'active',
    })
    expect(wrapper.emitted('updated')?.[0]?.[0]).toMatchObject({ revision: 4 })
  })

  it('embedded in the draft flow: job role is required, nothing is pre-filled, and no gap hints before a choice', async () => {
    vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue(accessFixture())
    const update = vi.spyOn(adminApi, 'updateAgentAccess')
    const wrapper = mountPanel(true)
    await flushPromises()
    expect(wrapper.find('[data-testid="agent-access-overview"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('执行身份')
    expect(wrapper.find('[data-action="save-agent-access"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="fill-access-gaps"]').exists()).toBe(false)
    // 未选择岗位角色和数据范围：不预填。
    expect(wrapper.find('[data-testid="agent-access-capability-summary"]').exists()).toBe(false)

    const exposed = wrapper.vm as unknown as { validateRequired: () => boolean; dirty: boolean; complete: boolean }
    expect(exposed.dirty).toBe(false)
    expect(exposed.validateRequired()).toBe(false)
    await flushPromises()
    // 可见角色已选，岗位角色必填项标为错误（错误文案由 ElFormItem 过渡渲染，这里断言错误状态）。
    expect(wrapper.findAll('.el-form-item.is-error')).toHaveLength(1)
    expect(update).not.toHaveBeenCalled()
  })

  it('embedded: after a job role is chosen, saves without confirmation', async () => {
    vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue({ ...accessFixture(), roleIds: ['role-finance'] })
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
    const wrapper = mountPanel(true)
    await flushPromises()
    const exposed = wrapper.vm as unknown as { validateRequired: () => boolean; save: (options?: { confirm?: boolean }) => Promise<boolean> }
    expect(exposed.validateRequired()).toBe(true)
    await expect(exposed.save({ confirm: false })).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('lists roles with management permissions last and warns when one is granted', async () => {
    const fixture = accessFixture()
    fixture.roleOptions = [
      { id: 'role-platform-admin', name: '平台管理员', status: 'active', privileged: true },
      ...fixture.roleOptions,
    ]
    vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue({ ...fixture, roleIds: ['role-platform-admin'] })
    const wrapper = mountPanel(true)
    await flushPromises()
    const jobRoleSelect = wrapper.findAll('.el-select-stub')[1]!
    const options = jobRoleSelect.findAll('.option-stub')
    // 含管理权限的角色排在最后并带风险标记，其余保持原顺序；不自动选择。
    expect(options.map(option => option.attributes('data-value'))).toEqual(['role-finance', 'role-purchase', 'role-purchase-analyst', 'role-platform-admin'])
    expect(options.at(-1)!.find('[data-testid="role-privileged-tag"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="role-needed-tag"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="role-privileged-warning"]').text()).toContain('平台管理员 含管理权限')
  })
})
