import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { ConversationTarget } from '@/types/domain'
import CollabChatsView from './CollabChatsView.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    listConversationTargets: vi.fn(),
    markConversationTargetRead: vi.fn(),
    resolveConversation: vi.fn(),
    getAgents: vi.fn(),
  },
}))

const targets: ConversationTarget[] = [
  {
    type: 'group', id: 'g1', name: '采购群', description: '', avatarNames: ['甲'], available: true,
    lastActiveAt: '2026-10-23T08:00:00.000Z', unreadCount: 2, muted: false,
    lastMessage: { role: 'user', authorName: '周航', text: '收到', sentAt: '2026-10-23T08:00:00.000Z' },
  },
  {
    type: 'agent', id: 'a1', name: '库存助手', description: '', avatarNames: ['库'], available: true,
    lastActiveAt: '2026-10-23T07:00:00.000Z', unreadCount: 1, muted: false,
    lastMessage: { role: 'assistant', authorName: '库存助手', text: '好了', sentAt: '2026-10-23T07:00:00.000Z' },
  },
]

async function mountAt(path: string) {
  setActivePinia(createPinia())
  const page = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/c/chats', name: 'collab-chats', component: page },
      { path: '/c/chats/agent/:agentId', name: 'collab-agent-chat', component: page },
      { path: '/c/chats/group/:id', name: 'collab-group-chat', component: page },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(CollabChatsView, {
    global: {
      plugins: [router, ElementPlus],
      stubs: { CollabAgentChat: true, CollabGroupPage: true, CollabAgentPickerDialog: true, CreateProjectSpaceDialog: true },
    },
  })
  await flushPromises()
  return { wrapper, router }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('CollabChatsView: 未读与已读（S5e）', () => {
  beforeEach(() => {
    vi.mocked(workbenchApi.listConversationTargets).mockReset().mockResolvedValue({ items: structuredClone(targets), nextCursor: null })
    vi.mocked(workbenchApi.markConversationTargetRead).mockReset().mockResolvedValue({ type: 'group', id: 'g1', lastReadAt: '' })
    vi.mocked(workbenchApi.getAgents).mockReset().mockResolvedValue([])
  })
  afterEach(() => {
    setVisibility('visible')
    vi.useRealTimers()
  })

  it('marks only the open conversation read', async () => {
    const { wrapper } = await mountAt('/c/chats/group/g1')
    expect(workbenchApi.markConversationTargetRead).toHaveBeenCalledTimes(1)
    expect(workbenchApi.markConversationTargetRead).toHaveBeenCalledWith('group', 'g1', '2026-10-23T08:00:00.000Z')
    const badges = wrapper.findAll('[data-testid="conversation-unread"]')
    expect(badges).toHaveLength(1)
    expect(badges[0]!.text()).toContain('1 条未读')
    wrapper.unmount()
  })

  it('does not mark read on the bare list or while the page is hidden; marks once visible again', async () => {
    const bare = await mountAt('/c/chats')
    expect(workbenchApi.markConversationTargetRead).not.toHaveBeenCalled()
    bare.wrapper.unmount()

    setVisibility('hidden')
    const { wrapper } = await mountAt('/c/chats/agent/a1')
    expect(workbenchApi.markConversationTargetRead).not.toHaveBeenCalled()
    setVisibility('visible')
    await flushPromises()
    expect(workbenchApi.markConversationTargetRead).toHaveBeenCalledWith('agent', 'a1', '2026-10-23T07:00:00.000Z')
    wrapper.unmount()
  })

  it('refreshes the list when the page becomes visible and every minute while visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { wrapper } = await mountAt('/c/chats')
    expect(workbenchApi.listConversationTargets).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    await flushPromises()
    expect(workbenchApi.listConversationTargets).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(workbenchApi.listConversationTargets).toHaveBeenCalledTimes(3)
    setVisibility('hidden')
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(workbenchApi.listConversationTargets).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })
})
