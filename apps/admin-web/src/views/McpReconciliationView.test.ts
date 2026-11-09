import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { McpReconciliationPage } from '@/types/domain'
import McpReconciliationView from './McpReconciliationView.vue'

const pendingPage: McpReconciliationPage = {
  limit: 200,
  connectors: [{ id: 'c1', name: '旧版 CRM', deleted: true, pendingCount: 1, resolvedCount: 0 }],
  items: [{
    id: 'a1', runId: 'run-1', attemptId: 'attempt-1', connectorId: 'c1', connectorName: '旧版 CRM', connectorDeleted: true,
    actorUserId: 'U1', actorName: '发起员工', executorPrincipalId: null, executorName: null, capabilityName: 'crm.update',
    parameterDigest: 'd'.repeat(64), result: 'unknown', occurredAt: '2026-11-09T06:00:00.000Z',
    resolvedResult: null, resolvedBy: null, resolvedByName: null, resolvedAt: null, resolutionNote: null,
  }],
}

function render(permissions: string[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions })
  return mount(McpReconciliationView, {
    global: { plugins: [pinia, ElementPlus], stubs: { ElSelect: { template: '<div><slot /></div>' }, ElOption: true } },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('MCP call reconciliation', () => {
  it('lists pending calls including ones on deleted connectors and offers registration to platform admins', async () => {
    vi.spyOn(adminApi, 'getMcpReconciliation').mockResolvedValue(pendingPage)
    const wrapper = render(['admin:*'])
    await flushPromises()
    expect(adminApi.getMcpReconciliation).toHaveBeenCalledWith('pending', 'all')
    expect(wrapper.text()).toContain('crm.update')
    expect(wrapper.text()).toContain('已删除')
    expect(wrapper.text()).toContain('历史记录未归因')
    expect(wrapper.text()).toContain('结果未知')
    expect(wrapper.findAll('button').some(button => button.text() === '登记结论')).toBe(true)
    wrapper.unmount()
  })

  it('offers registration to admin:write holders, matching the server rule', async () => {
    vi.spyOn(adminApi, 'getMcpReconciliation').mockResolvedValue(pendingPage)
    const wrapper = render(['admin:write'])
    await flushPromises()
    expect(wrapper.findAll('button').some(button => button.text() === '登记结论')).toBe(true)
    wrapper.unmount()
  })

  it('keeps read-only administrators from registering', async () => {
    vi.spyOn(adminApi, 'getMcpReconciliation').mockResolvedValue(pendingPage)
    const wrapper = render(['admin:read'])
    await flushPromises()
    expect(wrapper.text()).toContain('登记结论需要平台管理权限')
    expect(wrapper.findAll('button').some(button => button.text() === '登记结论')).toBe(false)
    wrapper.unmount()
  })

  it('reports a load failure instead of an empty list', async () => {
    vi.spyOn(adminApi, 'getMcpReconciliation').mockRejectedValue(new Error('服务暂时不可用'))
    const wrapper = render(['admin:*'])
    await flushPromises()
    expect(wrapper.text()).toContain('调用审计加载失败')
    expect(wrapper.text()).not.toContain('没有待核对的调用')
    wrapper.unmount()
  })
})
