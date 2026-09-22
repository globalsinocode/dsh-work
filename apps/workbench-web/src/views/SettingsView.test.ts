import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { ControlledMemoryConsent } from '@/types/domain'
import SettingsView from './SettingsView.vue'

const consent: ControlledMemoryConsent = {
  id: 'memory-consent-1', sourceRunId: 'run-1', sourceAttemptId: 'attempt-1',
  workspaceId: 'ws-1', agentVersionId: 'agent-version-1', visibility: 'private',
  retentionUntil: '2026-12-31T00:00:00.000Z', purpose: '用户明确提交稳定偏好候选',
  status: 'active', withdrawnAt: null, createdAt: '2026-09-22T00:00:00.000Z',
  candidateId: 'memory-candidate-1', candidateStatus: 'approved', title: '分析报告展示偏好',
}

afterEach(() => vi.restoreAllMocks())

describe('SettingsView controlled-memory consent', () => {
  it('shows the employee scope and withdraws future use while preserving historical evidence', async () => {
    vi.spyOn(workbenchApi, 'getContentPolicy').mockResolvedValue({
      version: 'v1', physicalDeletion: false, retentionDays: null, notice: '保留规则',
    })
    vi.spyOn(workbenchApi, 'listMemoryConsents').mockResolvedValue([consent])
    vi.spyOn(workbenchApi, 'getSession').mockResolvedValue({
      user: { id: 'U00001', name: '林岚', title: '', department: '', avatarText: '林', role: 'employee', dataScopes: [] },
      identityProvider: 'prototype-sso',
      apiAudience: 'workbench',
    })
    const withdraw = vi.spyOn(workbenchApi, 'withdrawMemoryConsent').mockResolvedValue({
      ...consent, status: 'withdrawn', withdrawnAt: '2026-09-22T01:00:00.000Z',
    })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)
    const pinia = createPinia()
    setActivePinia(pinia)
    await useAuthStore().load()
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } } })
    await flushPromises()

    expect(wrapper.text()).toContain('分析报告展示偏好')
    expect(wrapper.text()).toContain('仅本人')
    await wrapper.findAll('button').find(button => button.text() === '撤回授权')!.trigger('click')
    await flushPromises()
    expect(withdraw).toHaveBeenCalledWith('memory-consent-1')
    expect(ElMessageBox.confirm).toHaveBeenCalledWith(
      expect.stringContaining('历史审核与引用记录仍会保留'),
      '撤回记忆授权',
      expect.any(Object),
    )
  })
})
