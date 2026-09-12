import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CapabilityManagementView from './CapabilityManagementView.vue'
import { useAuthStore } from '../stores/auth'
import { useContentStore } from '../stores/content'

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

async function render(canManage = true, initial = '/capabilities') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: canManage ? ['admin:write'] : ['admin:read'] })
  const content = useContentStore()
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/capabilities', component: CapabilityManagementView }] })
  await router.push(initial)
  await router.isReady()
  const wrapper = mount(CapabilityManagementView, { global: { plugins: [pinia, router, ElementPlus] } })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router, auth: useAuthStore() }
}

describe('Skill installation sibling tab', () => {
  it('opens the dedicated tab, removes the old create dialog, and preserves inputs across tabs', async () => {
    const { wrapper, router } = await render()
    expect(wrapper.findAll('[role="tablist"][aria-label="能力类型"] [role="tab"]').map(tab => tab.text())).toEqual(['Skill 中心 0', '新增 Skill', '工具目录 0', '连接器状态 0'])
    expect(wrapper.find('[data-action="create-skills"]').exists()).toBe(false)
    await wrapper.get('#capability-tab-install').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('install')
    expect(wrapper.get('#capability-panel-install').isVisible()).toBe(true)
    expect(wrapper.find('.capability-toolbar').exists()).toBe(false)
    const fileInput = wrapper.get('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { value: [new File(['demo'], 'sample.zip')], configurable: true })
    await fileInput.trigger('change')
    await flushPromises()
    await wrapper.get('#capability-tab-skills').trigger('click')
    await flushPromises()
    await wrapper.get('#capability-tab-install').trigger('click')
    await flushPromises()
    expect(wrapper.get('#capability-panel-install').text()).toContain('sample.zip')
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('hides installation from readers even for a direct URL and responds to permission revocation', async () => {
    const { wrapper, auth } = await render(false, '/capabilities?tab=install')
    expect(wrapper.find('#capability-tab-install').exists()).toBe(false)
    expect(wrapper.find('#capability-panel-install').exists()).toBe(false)
    expect(wrapper.get('#capability-tab-skills').attributes('aria-selected')).toBe('true')
    auth.$patch({ permissions: ['admin:write'] })
    await flushPromises()
    expect(wrapper.get('#capability-panel-install').isVisible()).toBe(true)
    auth.$patch({ permissions: ['admin:read'] })
    await flushPromises()
    expect(wrapper.find('#capability-panel-install').exists()).toBe(false)
  })

  it('supports keyboard tab navigation', async () => {
    const { wrapper, router } = await render()
    await wrapper.get('#capability-tab-skills').trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('install')
    await wrapper.get('#capability-tab-install').trigger('keydown', { key: 'End' })
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('connectors')
  })
})
