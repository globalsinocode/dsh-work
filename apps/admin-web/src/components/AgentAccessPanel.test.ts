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

function mountPanel() {
  const wrapper = mount(AgentAccessPanel, {
    props: { agentId: 'purchase-analyst', canManage: true },
    global: {
      plugins: [ElementPlus],
      stubs: { teleport: true, ElSelect: { template: '<div class="el-select-stub"><slot /></div>' }, ElOption: true },
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
})
