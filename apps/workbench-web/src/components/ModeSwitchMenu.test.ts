import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ModeSwitchMenu from './ModeSwitchMenu.vue'
import { useUiModeStore } from '@/stores/ui-mode'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getPreferences: vi.fn().mockResolvedValue({ uiMode: 'work' }),
    updatePreferences: vi.fn().mockResolvedValue({ uiMode: 'work' }),
  },
}))

vi.mock('@/utils/feedback', () => ({
  notifyActionFailure: vi.fn(),
}))

function mountMenu() {
  setActivePinia(createPinia())
  useUiModeStore().mode = 'work'
  const handleClose = vi.fn()
  const ElDropdown = defineComponent({
    name: 'ElDropdown',
    emits: ['command', 'visible-change'],
    setup(_, { slots, expose }) {
      expose({ handleClose })
      return () => h('div', { class: 'stub-dropdown' }, [
        slots.default?.(),
        h('div', { class: 'stub-panel' }, slots.dropdown?.()),
      ])
    },
  })
  const wrapper = mount(ModeSwitchMenu, {
    slots: { default: 'Logo' },
    global: {
      stubs: {
        ElDropdown,
        ElDropdownMenu: { template: '<ul class="mode-switch-menu"><slot /></ul>' },
        ElDropdownItem: {
          props: ['command'],
          template: '<li role="menuitem" tabindex="0"><slot /></li>',
        },
        ElIcon: true,
      },
    },
    attachTo: document.body,
  })
  return { wrapper, handleClose }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ModeSwitchMenu', () => {
  it('closes via document Escape after the menu is open', async () => {
    const { wrapper, handleClose } = mountMenu()
    const dropdown = wrapper.findComponent({ name: 'ElDropdown' })
    dropdown.vm.$emit('visible-change', true)
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(handleClose).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('arms Escape on pointerdown and closes once visible-change fires if Esc came first', async () => {
    const { wrapper, handleClose } = mountMenu()
    await wrapper.get('[aria-label="切换模式"]').trigger('pointerdown')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(handleClose).toHaveBeenCalled()
    handleClose.mockClear()
    const dropdown = wrapper.findComponent({ name: 'ElDropdown' })
    dropdown.vm.$emit('visible-change', true)
    await flushPromises()
    await nextTick()
    expect(handleClose).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('clears a stale pendingClose on the next pointerdown so the menu can open again', async () => {
    vi.useFakeTimers()
    const { wrapper, handleClose } = mountMenu()
    await wrapper.get('[aria-label="切换模式"]').trigger('pointerdown')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    handleClose.mockClear()
    // 模拟菜单最终没有打开，超时解除武装
    vi.advanceTimersByTime(300)
    await wrapper.get('[aria-label="切换模式"]').trigger('pointerdown')
    const dropdown = wrapper.findComponent({ name: 'ElDropdown' })
    dropdown.vm.$emit('visible-change', true)
    await flushPromises()
    await nextTick()
    expect(handleClose).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('removes the Escape listener when the menu closes', async () => {
    const { wrapper, handleClose } = mountMenu()
    const dropdown = wrapper.findComponent({ name: 'ElDropdown' })
    dropdown.vm.$emit('visible-change', true)
    await flushPromises()
    dropdown.vm.$emit('visible-change', false)
    await flushPromises()
    handleClose.mockClear()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(handleClose).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
