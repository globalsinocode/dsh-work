import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { ConversationTarget } from '@/types/domain'
import CollabTargetList from './CollabTargetList.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => router }))
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
    unreadCount: 0, muted: false,
    lastMessage: { role: 'user', authorName: '我', text: '查一下', sentAt: NOW },
  },
  {
    type: 'agent', id: 'a2', name: '报表助手', description: '生成报表', avatarNames: ['报'], available: false, lastActiveAt: NOW,
    unreadCount: 3, muted: false,
    lastMessage: { role: 'assistant', authorName: '报表助手', text: '已完成', sentAt: NOW },
  },
  {
    type: 'group', id: 'g1', name: '采购群', description: '', avatarNames: ['甲', '乙', '丙'], available: true, lastActiveAt: NOW,
    unreadCount: 120, muted: true,
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
        ElDropdown: { name: 'ElDropdown', emits: ['command'], template: '<div><slot /><div class="menu"><slot name="dropdown" /></div></div>' },
        ElDropdownMenu: { template: '<ul><slot /></ul>' },
        ElDropdownItem: { template: '<li><slot /></li>' },
        ElDialog: true,
        CreateProjectSpaceDialog: { name: 'CreateProjectSpaceDialog', props: ['modelValue', 'mode'], emits: ['created'], template: '<div class="create-dialog" :data-open="String(modelValue)" :data-mode="mode" />' },
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

  it('gives each row a stable accessible name from the object name, not the preview', async () => {
    const wrapper = mountList({ pendingAgent: { id: 'a9', name: '新同事', description: '简介里别进名称' } })
    await flushPromises()
    const buttons = wrapper.findAll('ul[aria-label="对话"] button')
    expect(buttons[0].attributes('aria-label')).toBe('新同事')
    expect(buttons[1].attributes('aria-label')).toBe('库存助手')
    expect(buttons[2].attributes('aria-label')).toBe('报表助手，不可用，3 条未读')
    expect(buttons[3].attributes('aria-label')).toBe('采购群，99 条以上未读（已静音）')
    // 预览仍可见，但不进可访问名称
    expect(buttons[3].text()).toContain('林岚：收到')
    expect(buttons[3].attributes('aria-label')).not.toContain('林岚')
    wrapper.unmount()
  })

  it('shows unread counts with an accessible label, capped at 99+ and muted groups dimmed', async () => {
    const wrapper = mountList()
    await flushPromises()
    const buttons = wrapper.findAll('ul[aria-label="对话"] button')
    expect(buttons[0].find('[data-testid="conversation-unread"]').exists()).toBe(false)
    const agent = buttons[1].get('[data-testid="conversation-unread"]')
    expect(agent.text()).toContain('3')
    expect(agent.text()).toContain('3 条未读')
    expect(agent.classes()).not.toContain('collab-target__unread--muted')
    const group = buttons[2].get('[data-testid="conversation-unread"]')
    expect(group.get('[aria-hidden="true"]').text()).toBe('99+')
    expect(group.text()).toContain('99 条以上未读（已静音）')
    expect(group.classes()).toContain('collab-target__unread--muted')
    wrapper.unmount()
  })

  it('refreshes the first page when mounted again', async () => {
    const first = mountList()
    await flushPromises()
    first.unmount()
    const second = mount(CollabTargetList, { global: { plugins: [ElementPlus], stubs: { ElDialog: true, CreateProjectSpaceDialog: true } } })
    await flushPromises()
    expect(workbenchApi.listConversationTargets).toHaveBeenCalledTimes(2)
    second.unmount()
  })

  it('creates a group from the menu and opens it with the group info', async () => {
    const wrapper = mountList()
    await flushPromises()
    expect(wrapper.get('.menu').text()).toContain('发起对话')
    expect(wrapper.get('.menu').text()).not.toContain('即将上线')
    expect(wrapper.get('.create-dialog').attributes('data-open')).toBe('false')
    wrapper.findComponent({ name: 'ElDropdown' }).vm.$emit('command', 'group')
    await flushPromises()
    expect(wrapper.get('.create-dialog').attributes('data-open')).toBe('true')
    expect(wrapper.get('.create-dialog').attributes('data-mode')).toBe('collab')
    wrapper.findComponent({ name: 'CreateProjectSpaceDialog' }).vm.$emit('created', { id: 'ws-new' })
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith({ name: 'collab-group-chat', params: { id: 'ws-new' }, query: { info: '1' } })
    wrapper.unmount()
  })
})
