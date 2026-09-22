import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { ControlledMemoryCandidate } from '@/types/domain'
import MemoryGovernanceView from './MemoryGovernanceView.vue'

const candidate: ControlledMemoryCandidate = {
  id: 'memory-candidate-1', consentId: 'memory-consent-1', memoryKey: 'a'.repeat(64),
  kind: 'experience', title: '异常分析核对方法',
  content: '分析异常时先核对当前数据版本、缺失字段和外部操作回执，再形成可复核的结论。',
  contentDigest: 'b'.repeat(64), visibility: 'workspace', scopeRef: 'ws-1',
  retentionUntil: '2026-12-31T00:00:00.000Z', status: 'pending', submittedBy: 'U00001',
  reviewedBy: null, reviewedAt: null, reviewComment: null,
  approvedEntryId: null, approvedVersionId: null, createdAt: '2026-09-22T00:00:00.000Z',
}

afterEach(() => vi.restoreAllMocks())

describe('controlled memory governance', () => {
  it('shows provenance and publishes a reviewed candidate', async () => {
    vi.spyOn(adminApi, 'getMemoryCandidates').mockResolvedValue([candidate])
    const review = vi.spyOn(adminApi, 'reviewMemoryCandidate').mockResolvedValue({
      ...candidate, status: 'approved', approvedEntryId: 'memory-entry-1', approvedVersionId: 'memory-version-1',
    })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ permissions: ['admin:write'] })
    const wrapper = mount(MemoryGovernanceView, {
      global: { plugins: [pinia, ElementPlus], stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('异常分析核对方法')
    expect(wrapper.text()).toContain('工作空间')
    const publish = wrapper.findAll('button').find(button => button.text() === '发布')
    await publish!.trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('memory-candidate-1', {
      decision: 'approved', resolutionKey: 'admin:memory-candidate-1:approved',
      comment: '已确认来源、范围、可使用期限和非权威边界',
    })
    wrapper.unmount()
  })
})
