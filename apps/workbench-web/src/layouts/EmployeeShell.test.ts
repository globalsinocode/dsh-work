import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useUiModeStore } from '@/stores/ui-mode'
import EmployeeShell from './EmployeeShell.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getSession: vi.fn(),
    getTasks: vi.fn(async () => []),
    getWorkspaces: vi.fn(async () => []),
    getSkills: vi.fn(async () => []),
    getAgents: vi.fn(async () => []),
    getArtifacts: vi.fn(async () => []),
    getNotificationCounts: vi.fn(async () => ({ total: 0, byWorkspace: {}, lastReadSequence: 0 })),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
  },
}))

afterEach(() => vi.restoreAllMocks())

async function setup(mode: 'work' | 'collab' = 'work', role: 'employee' | 'platform_admin' = 'employee') {
  vi.mocked(workbenchApi.getSession).mockResolvedValue({
    user: { id: 'U00001', name: '林岚', title: '', department: '', avatarText: '林', role, dataScopes: [] },
    identityProvider: 'prototype-sso',
    apiAudience: 'workbench',
  } as never)
  const pinia = createPinia()
  setActivePinia(pinia)
  useUiModeStore().mode = mode
  const page = { template: '<div>页面</div>' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/workbench', '/settings', '/skills', '/agents', '/workspaces', '/knowledge', '/automations', '/conversations/:id']
      .map(p => ({ path: `${p}/:rest(.*)*`, component: page })),
  })
  await router.push('/workbench')
  await router.isReady()
  const wrapper = mount(EmployeeShell, {
    attachTo: document.body,
    global: {
      plugins: [pinia, router, ElementPlus],
      stubs: {
        ElDropdown: { template: '<div><slot /><div class="menu"><slot name="dropdown" /></div></div>' },
        ElDropdownMenu: { template: '<ul><slot /></ul>' },
        ElDropdownItem: { template: '<li><slot /></li>' },
        ModeSwitchMenu: { template: '<div><slot /></div>' },
        NotificationInbox: true,
        AppLogo: true,
      },
    },
  })
  await flushPromises()
  return { wrapper }
}

describe('EmployeeShell', () => {
  it('renders the bottom account bar with profile and recent nav', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('button[aria-label="打开用户中心"]').exists()).toBe(true)
    expect(wrapper.get('.menu').text()).toContain('个人资料与设置')
    wrapper.unmount()
  })

  it('offers the opposite mode in the bottom account menu of either mode', async () => {
    const { wrapper } = await setup('work')
    expect(wrapper.get('.menu').text()).toContain('切换至协作模式')
    wrapper.unmount()

    const collabShell = await setup('collab')
    expect(collabShell.wrapper.get('.menu').text()).toContain('切换至工作模式')
    collabShell.wrapper.unmount()
  })

  it('groups the mode switch above the admin entry, outside the user-center section', async () => {
    const { wrapper } = await setup('work', 'platform_admin')
    const text = wrapper.get('.menu').text()
    expect(text.indexOf('个人资料与设置')).toBeLessThan(text.indexOf('切换至协作模式'))
    expect(text.indexOf('切换至协作模式')).toBeLessThan(text.indexOf('打开管理后台'))
    wrapper.unmount()
  })
})
