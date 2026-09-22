import ElementPlus, { ElMessageBox } from 'element-plus'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import type { PersistentApproval } from '@/types/domain'
import ApprovalManagementView from './ApprovalManagementView.vue'
import { useAuthStore } from '@/stores/auth'

const pending: PersistentApproval = {
  id: 'approval-1', runId: 'run-1', taskId: 'task-1', sourceAttemptId: 'attempt-1',
  checkpointId: 'checkpoint-1', checkpointDigest: 'a'.repeat(64), actionName: 'erp.update',
  parameterDigest: 'b'.repeat(64), resourceRef: 'erp://orders/42', executionIdentity: 'U00001',
  dataVersion: 'etag-v1', riskLevel: 'high', status: 'pending',
  expiresAt: '2026-09-23T00:00:00.000Z', requestedAt: '2026-09-22T00:00:00.000Z',
  resolvedBy: null, resolvedAt: null, resumedAttemptId: null, actionConsumedAt: null,
}

afterEach(() => vi.restoreAllMocks())

describe('persistent action approvals', () => {
  it('shows the action-bound facts and submits an idempotent approval decision', async () => {
    vi.spyOn(adminApi, 'getApprovals').mockResolvedValue([pending])
    const resolve = vi.spyOn(adminApi, 'resolveApproval').mockResolvedValue({
      ...pending, status: 'approved', resolvedBy: 'U00008', resolvedAt: '2026-09-22T00:01:00.000Z', resumedAttemptId: 'attempt-2',
    })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/approvals', component: ApprovalManagementView }] })
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ permissions: ['admin:write'] })
    await router.push('/approvals')
    await router.isReady()
    const wrapper = mount(ApprovalManagementView, {
      global: {
        plugins: [pinia, router, ElementPlus],
        stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true },
      },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('erp.update')
    expect(wrapper.text()).toContain('erp://orders/42')
    expect(wrapper.text()).toContain('bbbbbbbbbbbb')
    const approveButton = wrapper.findAll('button').find(button => button.text() === '批准')
    expect(approveButton).toBeDefined()
    await approveButton!.trigger('click')
    await flushPromises()
    expect(resolve).toHaveBeenCalledWith('approval-1', {
      decision: 'approved', resolutionKey: 'admin:approval-1:approved', comment: '管理员确认当前动作快照',
    })
    wrapper.unmount()
  })
})
