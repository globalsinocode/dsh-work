import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ModelGovernanceView from './ModelGovernanceView.vue'
import { adminApi } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { ModelRoute } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

const route: ModelRoute = {
  id: 'route-default', key: 'default', name: '平台默认模型路由', purpose: 'default',
  providerModelId: 'model-1', providerId: 'provider-1', providerName: 'DeepSeek',
  modelKey: 'deepseek-v4-pro', modelName: 'DeepSeek V4 Pro', priority: 100, enabled: true,
  updatedAt: '2026-10-15T00:00:00.000Z',
}

async function render() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: ['admin:write'] })
  vi.spyOn(adminApi, 'getModelProviders').mockResolvedValue([])
  vi.spyOn(adminApi, 'getModelRoutes').mockResolvedValue([route])
  const wrapper = mount(ModelGovernanceView, {
    attachTo: document.body,
    global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('ModelGovernanceView', () => {
  it('states that model routes are recorded only and do not choose the executing model', async () => {
    const wrapper = await render()
    const notice = wrapper.find('.record-only-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('模型路由目前仅记录')
    expect(notice.text()).toContain('DSH Profile')
    expect(notice.text()).toContain('新运行会被拒绝')
    expect(wrapper.text()).toContain('模型路由（仅记录）')
    expect(wrapper.text()).toContain('仅记录到运行快照')
  })
})
