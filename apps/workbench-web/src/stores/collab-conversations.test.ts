import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { ConversationTarget } from '@/types/domain'
import { useCollabConversationStore } from './collab-conversations'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    listConversationTargets: vi.fn(),
    markConversationTargetRead: vi.fn(),
  },
}))

function target(overrides: Partial<ConversationTarget>): ConversationTarget {
  return {
    type: 'group', id: 'g1', name: '采购群', description: '', avatarNames: [], available: true,
    lastActiveAt: '2026-10-23T08:00:00.000Z', unreadCount: 0, muted: false,
    lastMessage: { role: 'user', authorName: '周航', text: '收到', sentAt: '2026-10-23T08:00:00.000Z' },
    ...overrides,
  }
}

describe('collab conversations store: 已读（S5e）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(workbenchApi.markConversationTargetRead).mockReset().mockResolvedValue({ type: 'group', id: 'g1', lastReadAt: '' })
    vi.mocked(workbenchApi.listConversationTargets).mockReset().mockImplementation(async () => ({
      items: [target({ unreadCount: 2 }), target({ type: 'agent', id: 'a1', unreadCount: 0 })],
      nextCursor: null,
    }))
  })

  it('marks read up to the last listed message and clears the count locally', async () => {
    const store = useCollabConversationStore()
    await store.load()
    await store.markRead('group', 'g1')
    expect(workbenchApi.markConversationTargetRead).toHaveBeenCalledWith('group', 'g1', '2026-10-23T08:00:00.000Z')
    expect(store.targets[0]!.unreadCount).toBe(0)
  })

  it('skips targets without unread messages or not in the list', async () => {
    const store = useCollabConversationStore()
    await store.load()
    await store.markRead('agent', 'a1')
    await store.markRead('group', 'missing')
    expect(workbenchApi.markConversationTargetRead).not.toHaveBeenCalled()
  })

  it('swallows a failed write; the next refresh shows the unread count again', async () => {
    vi.mocked(workbenchApi.markConversationTargetRead).mockRejectedValue(new Error('offline'))
    const store = useCollabConversationStore()
    await store.load()
    await expect(store.markRead('group', 'g1')).resolves.toBeUndefined()
    await store.refresh()
    expect(store.targets[0]!.unreadCount).toBe(2)
  })
})
