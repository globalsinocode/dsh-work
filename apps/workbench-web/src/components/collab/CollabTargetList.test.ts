import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { ConversationTarget } from '@/types/domain'
import CollabTargetList from './CollabTargetList.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    listConversationTargets: vi.fn(),
    getAgents: vi.fn(),
  },
}))

const NOW = new Date().toISOString()
const targets: ConversationTarget[] = [
  {
    type: 'agent', id: 'a1', name: '库存助手', description: '盘点库存', avatarNames: ['库'], available: true, lastActiveAt: NOW,
    lastMessage: { role: 'user', authorName: '我', text: '查一下', sentAt: NOW },
  },
  {
    type: 'agent', id: 'a2', name: '报表助手', description: '生成报表', avatarNames: ['报'], available: false, lastActiveAt: NOW,
    lastMessage: { role: 'assistant', authorName: '报表助手', text: '已完成', sentAt: NOW },
  },
  {
    type: 'group', id: 'g1', name: '采购群', description: '', avatarNames: ['甲', '乙', '丙'], available: true, lastActiveAt: NOW,
    lastMessage: { role: 'assistant', authorName: '林岚', text: '收到', sentAt: NOW },
  },
]

function page(items: ConversationTarget[], nextCursor: string | null = null) {
  return { items, nextCursor } as never
}

function mountList(props: Record<string, unknown> = {}) {
  setActivePinia(createPinia())
  return mount(CollabTargetList, {
    props,
    global: {
      plugins: [ElementPlus],
      stubs: {
        ElDropdown: { template: '<div><slot /><div class="menu"><slot name="dropdown" /></div></div>' },
        ElDropdownMenu: { template: '<ul><slot /></ul>' },
        ElDropdownItem: { template: '<li><slot /></li>' },
        ElDialog: true,
      },
    },
  })
}

beforeEach(() => {
  vi.mocked(workbenchApi.listConversationTargets).mockResolvedValue(page(targets))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('CollabTargetList', () => {
  it('loads on mount and renders rows with previews', async () => {
    const wrapper = mountList({ activeKey: 'agent:a1' })
    await flushPromises()
    expect(workbenchApi.listConversationTargets).toHaveBeenCalledTimes(1)
    const buttons = wrapper.findAll('ul[aria-label="对话"] button')
    expect(buttons).toHaveLength(3)
    expect(wrapper.get('.collab-target-list__caption').text()).toBe('对话 · 3')
    expect(buttons[0].text()).toContain('我：查一下')
    expect(buttons[0].attributes('aria-current')).toBe('page')
    expect(buttons[1].text()).toContain('不可用')
    expect(buttons[1].text()).toContain('已完成')
    expect(buttons[2].text()).toContain('林岚：收到')
    expect(buttons[2].attributes('aria-current')).toBeUndefined()
    wrapper.unmount()
  })

  it('emits select and start-agent', async () => {
    const wrapper = mountList({ pendingAgent: { id: 'a9', name: '新同事', description: '' } })
    await flushPromises()
    const rows = wrapper.findAll('ul[aria-label="对话"] button')
    expect(rows[0].text()).toContain('新同事')
    expect(rows[0].text()).toContain('开始新的对话')
    await rows[0].trigger('click')
    expect(wrapper.emitted('start-agent')![0]).toEqual(['a9'])
    await wrapper.findAll('ul[aria-label="对话"] button')[3].trigger('click')
    expect(wrapper.emitted('select')![0]).toEqual([{ type: 'group', id: 'g1' }])
    wrapper.unmount()
  })

  it('does not duplicate a pending agent that already has a row', async () => {
    const wrapper = mountList({ pendingAgent: { id: 'a1', name: '库存助手', description: '' } })
    await flushPromises()
    expect(wrapper.findAll('ul[aria-label="对话"] li')).toHaveLength(3)
    wrapper.unmount()
  })

  it('debounces search input', async () => {
    const wrapper = mountList()
    await flushPromises()
    vi.useFakeTimers()
    await wrapper.get('input[aria-label="搜索对话"]').setValue('库')
    expect(workbenchApi.listConversationTargets).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    expect(workbenchApi.listConversationTargets).toHaveBeenLastCalledWith({ query: '库' })
    wrapper.unmount()
  })

  it('shows empty states', async () => {
    vi.mocked(workbenchApi.listConversationTargets).mockResolvedValue(page([]))
    const wrapper = mountList()
    await flushPromises()
    expect(wrapper.text()).toContain('还没有对话')
    wrapper.unmount()
  })

  it('shows error with retry and load more', async () => {
    vi.mocked(workbenchApi.listConversationTargets).mockRejectedValueOnce(new Error('boom'))
    const wrapper = mountList()
    await flushPromises()
    expect(wrapper.text()).toContain('boom')
    vi.mocked(workbenchApi.listConversationTargets).mockResolvedValue(page(targets, 'c2'))
    await wrapper.findAll('button').find(b => b.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('boom')
    vi.mocked(workbenchApi.listConversationTargets).mockResolvedValue(page([], null))
    await wrapper.findAll('button').find(b => b.text() === '加载更多')!.trigger('click')
    await flushPromises()
    expect(workbenchApi.listConversationTargets).toHaveBeenLastCalledWith({ query: undefined, cursor: 'c2' })
    wrapper.unmount()
  })

  it('offers disabled group creation in the menu', async () => {
    const wrapper = mountList()
    await flushPromises()
    expect(wrapper.get('.menu').text()).toContain('发起对话')
    expect(wrapper.get('.menu').text()).toContain('即将上线')
    wrapper.unmount()
  })
})
