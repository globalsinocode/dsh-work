import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getNotificationCounts: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationsRead: vi.fn(),
  notificationEventsUrl: vi.fn((since?: number) => `/notifications/events?since=${since ?? 0}`),
}))

vi.mock('@/api/client', () => ({ workbenchApi: api }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void)
  }

  close() {}

  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
  }
}

describe('notification store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    api.getNotificationCounts.mockReset()
    api.listNotifications.mockReset()
    api.markNotificationsRead.mockReset()
  })

  it('refreshes counts and resumes from the last sequence', async () => {
    api.getNotificationCounts.mockResolvedValue({ total: 2, byWorkspace: { 'ws-b': 2 }, lastReadSequence: 10 })
    api.listNotifications.mockResolvedValue({ items: [{ id: 'n1', workspaceId: 'ws-b', sequence: 11 }], nextCursor: null })
    const { useNotificationStore } = await import('@/stores/notifications')
    const store = useNotificationStore()
    await store.load()
    FakeEventSource.instances[0]!.emit('notification.changed', { sequence: 42 })
    await vi.waitFor(() => expect(api.getNotificationCounts).toHaveBeenCalledTimes(2))
    store.reconnect()
    expect(FakeEventSource.instances.at(-1)?.url).toContain('since=11')
  })
})
