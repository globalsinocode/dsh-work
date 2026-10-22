import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getNotificationCounts: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
  notificationEventsUrl: vi.fn(() => '/notifications/events'),
}))

vi.mock('@/api/client', () => ({ workbenchApi: api }))

import NotificationInbox from './NotificationInbox.vue'

describe('NotificationInbox', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.getNotificationCounts.mockResolvedValue({ total: 1, byWorkspace: { 'ws-a': 1 }, lastReadSequence: 0 })
    api.listNotifications.mockResolvedValue({
      items: [{
        id: 'n1',
        workspaceId: 'ws-a',
        sequence: 1,
        kind: 'discussion_posted',
        occurredAt: '2026-10-22T08:00:00.000Z',
        objectType: 'session',
        objectId: 'session-1',
        metadata: {},
      }],
      nextCursor: null,
    })
    vi.stubGlobal('EventSource', class {
      close() {}
      addEventListener() {}
    })
  })

  it('opens the drawer and loads notifications from the store', async () => {
    const wrapper = mount(NotificationInbox, {
      global: {
        plugins: [ElementPlus],
        stubs: { RouterLink: true },
      },
    })
    await wrapper.getByRole('button', { name: '打开通知' }).click()
    await flushPromises()
    expect(api.listNotifications).toHaveBeenCalled()
    expect(wrapper.text()).toContain('工作空间通知')
  })
})
