import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import SettingsView from './SettingsView.vue'

// 视图在 onMounted 里读取 ?mcpGrant；不装 router 时 useRoute() 为 undefined，
// 会产生未处理的 Promise 拒绝（Vitest 4 会因此判整轮失败）。
const route = vi.hoisted(() => ({ query: {} as Record<string, unknown> }))
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => router }))

afterEach(() => vi.restoreAllMocks())

describe('SettingsView', () => {
  it('shows enterprise identity and content retention without controlled-memory controls', async () => {
    // @ts-expect-error jsdom 无 Notification，需 stub 才会渲染用户中心通知区块
    globalThis.Notification = function Notification() {}
    vi.spyOn(workbenchApi, 'getContentPolicy').mockResolvedValue({
      version: 'v1', physicalDeletion: false, retentionDays: null, notice: '保留规则',
    })
    vi.spyOn(workbenchApi, 'getSession').mockResolvedValue({
      user: { id: 'U00001', name: '林岚', title: '', department: '', avatarText: '林', role: 'employee', dataScopes: [] },
      identityProvider: 'prototype-sso',
      apiAudience: 'workbench',
    })
    vi.spyOn(workbenchApi, 'listMcpGrants').mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 20 })
    vi.spyOn(workbenchApi, 'getNotificationPreferences').mockResolvedValue({ collabUnread: true, runFinished: true })
    vi.spyOn(workbenchApi, 'getPushConfig').mockRejectedValue(Object.assign(new Error('通知服务暂不可用'), { status: 503 }))
    const pinia = createPinia()
    setActivePinia(pinia)
    await useAuthStore().load()
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } } })
    await flushPromises()

    expect(wrapper.text()).toContain('企业身份')
    expect(wrapper.text()).toContain('内容保留与账号停用')
    expect(wrapper.text()).toContain('系统通知')
    expect(wrapper.text()).toContain('保留规则')
    expect(wrapper.text()).not.toContain('受控记忆')
  })
})
