import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.vue'
import AdminAssistantView from './views/AdminAssistantView.vue'
import { useAuthStore } from './stores/auth'
import { useAdminAssistantStore } from './stores/admin-assistant'

import { adminApi } from './api/client'
import { conversationFixture } from './testing/assistant-fixtures'

const wrappers: VueWrapper[] = []
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })

async function render() {
  vi.spyOn(adminApi, 'getAssistantConversations').mockResolvedValue([{ id: conversationFixture().id, title: '安装 Skill' }])
  vi.spyOn(adminApi, 'getAssistantConversation').mockResolvedValue(conversationFixture())
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.$patch({ permissions: ['admin:write'] })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/assistant', component: AdminAssistantView, meta: { title: '管理助手' } },
    { path: '/agents', component: { template: '<div>Agent 管理</div>' }, meta: { title: 'Agent 管理' } },
    { path: '/about', component: { template: '<div>关于 dsh-work</div>' }, meta: { title: '关于 dsh-work' } },
  ] })
  await router.push('/assistant?context=skills')
  await router.isReady()
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router, auth, store: useAdminAssistantStore() }
}

describe('global management conversation history', () => {
  it('restores history from another page using the standard collapsible navigation group', async () => {
    const { wrapper, router, store } = await render()
    await store.select(conversationFixture().id)
    const previousId = store.selectedId
    store.current.draft = '继续查看安装信息'
    await router.push('/agents')
    await flushPromises()
    const navigation = wrapper.get('nav')
    const agentGovernance = navigation.findAll('section').find(section => section.text().includes('Agent 治理'))
    expect(agentGovernance?.text()).toContain('Skill 管理')
    expect(agentGovernance?.text()).toContain('工具管理')
    expect(agentGovernance?.text()).toContain('连接器管理')
    expect(agentGovernance?.text()).not.toContain('Skill 与工具')
    expect(navigation.findAll('section').at(-1)?.attributes('aria-label')).toBe('对话记录')
    const history = navigation.get('[aria-label="对话记录"]')
    expect(navigation.findAll('section').at(-2)?.text()).toContain('安全与运维')
    expect(history.findAll('button').some(button => button.text() === '新对话')).toBe(false)
    await wrapper.get('[aria-label="打开导航"]').trigger('click')
    await history.findAll('.admin-conversation-item')[0]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/assistant')
    expect(store.selectedId).toBe(previousId)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('继续查看安装信息')
    expect(wrapper.text()).toContain('确认安装')
    expect(wrapper.find('.admin-sidebar--mobile-open').exists()).toBe(false)
    expect(wrapper.find('main [aria-label="管理对话"]').exists()).toBe(false)
    await history.get('.admin-nav-group__label').trigger('click')
    expect(history.get('#admin-conversation-records').isVisible()).toBe(false)
    await history.get('.admin-nav-group__label').trigger('click')
    expect(history.get('#admin-conversation-records').isVisible()).toBe(true)
    expect(store.selectedId).toBe(previousId)
  })

  it('hides management conversations when admin read access is absent', async () => {
    const { wrapper, auth } = await render()
    auth.$patch({ permissions: ['audit:read'] })
    await flushPromises()
    expect(wrapper.find('nav [aria-label="对话记录"]').exists()).toBe(false)
  })

  it('opens the about page from the authenticated user dropdown', async () => {
    const { wrapper, router } = await render()
    await wrapper.get('.header-user-button').trigger('click')

    const aboutItem = [...document.body.querySelectorAll('.el-dropdown-menu__item')]
      .find(item => item.textContent?.includes('关于 dsh-work'))
    expect(aboutItem).toBeTruthy()
    ;(aboutItem as HTMLElement).click()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/about')
    expect(wrapper.text()).toContain('关于 dsh-work')
  })
})
