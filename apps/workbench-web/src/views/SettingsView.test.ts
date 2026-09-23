import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import SettingsView from './SettingsView.vue'

afterEach(() => vi.restoreAllMocks())

describe('SettingsView', () => {
  it('shows enterprise identity and content retention without controlled-memory controls', async () => {
    vi.spyOn(workbenchApi, 'getContentPolicy').mockResolvedValue({
      version: 'v1', physicalDeletion: false, retentionDays: null, notice: '保留规则',
    })
    vi.spyOn(workbenchApi, 'getSession').mockResolvedValue({
      user: { id: 'U00001', name: '林岚', title: '', department: '', avatarText: '林', role: 'employee', dataScopes: [] },
      identityProvider: 'prototype-sso',
      apiAudience: 'workbench',
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    await useAuthStore().load()
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } } })
    await flushPromises()

    expect(wrapper.text()).toContain('企业身份')
    expect(wrapper.text()).toContain('内容保留与账号停用')
    expect(wrapper.text()).toContain('保留规则')
    expect(wrapper.text()).not.toContain('受控记忆')
  })
})
