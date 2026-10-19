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
    capabilities: [{
      reference: 'order-query@1.0.0', name: '订单查询', source: 'declared',
      requiredRoleIds: ['role-purchase-analyst'], requiredScopes: ['region:east'],
      missingRole: true, missingScopes: ['region:east'],
    }],
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
    expect(wrapper.text()).toContain('缺少角色 采购分析员、数据范围 region:east，暂不可用')
  })

  it('fills the missing role and scope in one click and saves with the read revision', async () => {
    vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue(accessFixture())
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)
    const update = vi.spyOn(adminApi, 'updateAgentAccess').mockImplementation(async (_agentId, input) => ({
      ...accessFixture(), revision: 4, roleIds: input.roleIds, dataScopes: input.dataScopes,
      capabilities: [{ ...accessFixture().capabilities[0]!, missingRole: false, missingScopes: [] }],
    }))
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-action="fill-access-gaps"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('暂不可用')
    await wrapper.get('[data-action="save-agent-access"]').trigger('click')
    await flushPromises()
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
    // 未选择岗位角色和数据范围：不预填，也不提示能力缺授权。
    expect(wrapper.find('[data-testid="agent-access-capability-summary"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('缺少授权')

    const exposed = wrapper.vm as unknown as { validateRequired: () => boolean; dirty: boolean; complete: boolean }
    expect(exposed.dirty).toBe(false)
    expect(exposed.validateRequired()).toBe(false)
    await flushPromises()
    // 可见角色已选，岗位角色必填项标为错误（错误文案由 ElFormItem 过渡渲染，这里断言错误状态）。
    expect(wrapper.findAll('.el-form-item.is-error')).toHaveLength(1)
    expect(update).not.toHaveBeenCalled()
  })

  it('embedded: after a job role is chosen, shows which capabilities are usable and saves without confirmation', async () => {
    vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue({ ...accessFixture(), roleIds: ['role-finance'] })
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
    const wrapper = mountPanel(true)
    await flushPromises()
    const summary = wrapper.get('[data-testid="agent-access-capability-summary"]').text()
    expect(summary).toContain('0/1 项可用，订单查询 缺少授权')
    const exposed = wrapper.vm as unknown as { validateRequired: () => boolean; save: (options?: { confirm?: boolean }) => Promise<boolean> }
    expect(exposed.validateRequired()).toBe(true)
    await expect(exposed.save({ confirm: false })).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('marks roles needed by capabilities and warns when a role with management permissions is granted', async () => {
    const fixture = accessFixture()
    fixture.roleOptions = [
      { id: 'role-platform-admin', name: '平台管理员', status: 'active', privileged: true },
      ...fixture.roleOptions,
    ]
    // 能力也接受平台管理员时，它仍排在最后并带风险标记。
    fixture.capabilities = [{ ...fixture.capabilities[0]!, requiredRoleIds: ['role-platform-admin', 'role-purchase-analyst'] }]
    vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue({ ...fixture, roleIds: ['role-platform-admin'] })
    const wrapper = mountPanel(true)
    await flushPromises()
    const jobRoleSelect = wrapper.findAll('.el-select-stub')[1]!
    const options = jobRoleSelect.findAll('.option-stub')
    // 能力需要的角色排在最前，含管理权限的排在最后；只做标记，不自动选择。
    expect(options[0]!.attributes('data-value')).toBe('role-purchase-analyst')
    expect(options[0]!.find('[data-testid="role-needed-tag"]').exists()).toBe(true)
    expect(options.at(-1)!.attributes('data-value')).toBe('role-platform-admin')
    expect(options.at(-1)!.find('[data-testid="role-privileged-tag"]').exists()).toBe(true)
    expect(options.at(-1)!.find('[data-testid="role-needed-tag"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="role-privileged-warning"]').text()).toContain('平台管理员 含管理权限')
  })
})
