import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import CollabShell from './CollabShell.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getSession: vi.fn(),
    listTasks: vi.fn(),
    listSessions: vi.fn(),
    getWorkspaces: vi.fn(),
  },
}))

afterEach(() => vi.restoreAllMocks())

async function setup(role: 'employee' | 'platform_admin', path = '/c/chats') {
  vi.mocked(workbenchApi.getSession).mockResolvedValue({
    user: { id: 'U00001', name: '林岚', title: '', department: '', avatarText: '林', role, dataScopes: [] },
    identityProvider: 'prototype-sso',
    apiAudience: 'workbench',
  } as never)
  const pinia = createPinia()
  setActivePinia(pinia)
  await useAuthStore().load()
  const page = { template: '<div>页面</div>' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/c/chats', '/c/agents', '/c/groups', '/automations', '/settings', '/skills', '/files', '/history']
      .map(p => ({ path: `${p}/:rest(.*)*`, component: page })),
  })
  await router.push(path)
  await router.isReady()
  const push = vi.spyOn(router, 'push')
  const wrapper = mount(CollabShell, {
    attachTo: document.body,
    global: {
      plugins: [pinia, router, ElementPlus],
      stubs: {
        ElDropdown: { template: '<div><slot /><div class="menu"><slot name="dropdown" /></div></div>' },
        ElDropdownMenu: { template: '<ul><slot /></ul>' },
        ElDropdownItem: { template: '<li><slot /></li>' },
        ModeSwitchMenu: { template: '<div><slot /></div>' }, AppLogo: true,
      },
    },
  })
  await flushPromises()
  return { wrapper, router, push }
}

describe('CollabShell', () => {
  it('renders the four primary nav buttons in order', async () => {
    const { wrapper } = await setup('employee')
    const nav = wrapper.findAll('nav[aria-label="协作模式主导航"]')
    expect(nav).toHaveLength(1)
    expect(nav[0].findAll('button').map(b => b.text())).toEqual(['对话', 'AI 同事', '群组', '定时任务'])
    wrapper.unmount()
  })

  it('navigates when a nav button is clicked', async () => {
    const { wrapper, push } = await setup('employee')
    await wrapper.findAll('nav button').find(b => b.text() === '群组')!.trigger('click')
    expect(push).toHaveBeenCalledWith('/c/groups')
    wrapper.unmount()
  })

  it('marks the current section with aria-current', async () => {
    const { wrapper, router } = await setup('employee', '/c/chats/group/ws-1')
    const current = () => wrapper.findAll('nav button[aria-current="page"]').map(b => b.text())
    expect(current()).toEqual(['对话'])
    await router.push('/c/groups/ws-1')
    await flushPromises()
    expect(current()).toEqual(['群组'])
    await router.push('/automations')
    await flushPromises()
    expect(current()).toEqual(['定时任务'])
    wrapper.unmount()
  })

  it('lists account menu entries and hides admin for employees', async () => {
    const { wrapper } = await setup('employee')
    expect(wrapper.find('button[aria-label="打开用户菜单"]').text()).toBe('林')
    const text = wrapper.get('.menu').text()
    for (const label of ['用户中心', 'Skill 广场', '我的文件', '历史对话']) expect(text).toContain(label)
    expect(text.indexOf('用户中心')).toBeLessThan(text.indexOf('历史对话'))
    expect(text).not.toContain('打开管理后台')
    wrapper.unmount()
  })

  it('shows the admin entry for admin roles', async () => {
    const { wrapper } = await setup('platform_admin')
    expect(wrapper.get('.menu').text()).toContain('打开管理后台')
    wrapper.unmount()
  })
})
