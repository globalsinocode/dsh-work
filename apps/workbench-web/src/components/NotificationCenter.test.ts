import ElementPlus, { ElMessage } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useCollabConversationStore } from '@/stores/collab-conversations'
import { useNotificationStore } from '@/stores/notifications'
import { useUiModeStore } from '@/stores/ui-mode'
import type { UserNotification } from '@/types/domain'
import NotificationCenter from './NotificationCenter.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getNotificationUnreadCount: vi.fn(),
    listUserNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
    listConversationTargets: vi.fn(),
    markConversationTargetRead: vi.fn(),
  },
}))

const supply = { id: 'ws-supply', name: '供应链经营分析' }
const notifications: UserNotification[] = [
  {
    id: 'n-mention', kind: 'mention', createdAt: new Date().toISOString(), read: false, visible: true,
    actor: { id: 'U2', name: '周敏' }, workspace: supply, objectName: null, detail: null,
    target: { type: 'message', id: 'msg-1', sessionId: 'session-1' },
  },
  {
    id: 'n-task', kind: 'task_assigned', createdAt: new Date().toISOString(), read: true, visible: true,
    actor: { id: 'U2', name: '周敏' }, workspace: supply, objectName: '核对库存', detail: null,
    target: { type: 'project_task', id: 'ptask-1', sessionId: null },
  },
  {
    id: 'n-hidden', kind: 'task_completed', createdAt: new Date().toISOString(), read: true, visible: false,
    actor: null, workspace: null, objectName: null, detail: null, target: null,
  },
]

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function setup(unread = 1) {
  vi.mocked(workbenchApi.getNotificationUnreadCount).mockResolvedValue({ unread })
  vi.mocked(workbenchApi.listUserNotifications).mockImplementation(async query =>
    ({ items: (query?.status === 'unread' ? notifications.filter(item => !item.read) : notifications).map(item => ({ ...item })), nextCursor: null }))
  vi.mocked(workbenchApi.markNotificationRead).mockResolvedValue({ id: 'n', read: true })
  vi.mocked(workbenchApi.markAllNotificationsRead).mockResolvedValue({ read: 1 })
  vi.mocked(workbenchApi.listConversationTargets).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(workbenchApi.markConversationTargetRead).mockResolvedValue({ type: 'group', id: 'ws-supply', lastReadAt: '' })
  const pinia = createPinia()
  setActivePinia(pinia)
  const page = { template: '<div>页面</div>' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/workbench', component: page },
      { path: '/workspaces/:id', name: 'workspace-detail', component: page, children: [
        { path: 'conversations/:conversationId', name: 'workspace-conversation', component: page },
        { path: 'tasks/:taskId', name: 'workspace-task', component: page },
      ] },
      { path: '/c/chats/group/:id', name: 'collab-group-chat', component: page },
    ],
  })
  await router.push('/workbench')
  await router.isReady()
  const wrapper = mount(NotificationCenter, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
  await flushPromises()
  return { wrapper, router }
}

function panel() {
  return document.body.querySelector('[role="dialog"][aria-label="通知"]')
}

function itemButton(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('.notification-item')].find(button => button.getAttribute('aria-label')?.includes(label))
}

describe('NotificationCenter', () => {
  it('shows the unread count on the bell and lists notifications with names in bold', async () => {
    const { wrapper } = await setup(3)
    const bell = wrapper.get('[data-testid="notification-bell"]')
    expect(bell.attributes('aria-label')).toBe('通知，3 条未读')
    expect(bell.text()).toContain('3')

    await bell.trigger('click')
    await flushPromises()
    expect(panel()).not.toBeNull()
    expect(itemButton('周敏 在 「供应链经营分析」 中 @ 了你')?.getAttribute('aria-label')).toMatch(/^未读：/)
    expect(itemButton('周敏 把任务 「核对库存」 指派给你')?.querySelectorAll('strong')).toHaveLength(2)
    expect(itemButton('一条通知（该内容已不可见）')).toBeDefined()
    wrapper.unmount()
  })

  it('hides the badge when nothing is unread', async () => {
    const { wrapper } = await setup(0)
    const bell = wrapper.get('[data-testid="notification-bell"]')
    expect(bell.attributes('aria-label')).toBe('通知')
    expect(bell.find('.notification-bell__badge').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens a mention as the discussion in work mode and as the group chat in collaboration mode', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    itemButton('中 @ 了你')!.click()
    await flushPromises()
    expect(workbenchApi.markNotificationRead).toHaveBeenCalledWith('n-mention')
    expect(router.currentRoute.value.fullPath).toBe('/workspaces/ws-supply/conversations/session-1')
    expect(panel()).toBeNull()
    expect(wrapper.emitted('navigate')).toHaveLength(1)

    useUiModeStore().mode = 'collab'
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    itemButton('中 @ 了你')!.click()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/c/chats/group/ws-supply')
    wrapper.unmount()
  })

  it('does not navigate for a notification that is no longer visible', async () => {
    const warning = vi.spyOn(ElMessage, 'warning')
    const { wrapper, router } = await setup()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    itemButton('该内容已不可见')!.click()
    await flushPromises()
    expect(warning).toHaveBeenCalledWith('该内容已不可见')
    expect(router.currentRoute.value.fullPath).toBe('/workbench')
    expect(panel()).not.toBeNull()
    wrapper.unmount()
  })

  it('marks everything read and shows the empty unread tab', async () => {
    const { wrapper } = await setup(1)
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    const readAll = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('全部标为已读'))
    readAll!.click()
    await flushPromises()
    expect(workbenchApi.markAllNotificationsRead).toHaveBeenCalled()
    expect(wrapper.get('[data-testid="notification-bell"]').attributes('aria-label')).toBe('通知')

    vi.mocked(workbenchApi.listUserNotifications).mockResolvedValue({ items: [], nextCursor: null })
    const unreadTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.trim() === '未读')
    unreadTab!.click()
    await flushPromises()
    expect(panel()?.textContent).toContain('暂时没有未读通知')
    wrapper.unmount()
  })

  it('is a modal dialog whose tabs control the list, and item names include time and project', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    expect(panel()?.getAttribute('aria-modal')).toBe('true')
    const tabpanel = document.getElementById('notification-tabpanel')
    expect(tabpanel?.getAttribute('role')).toBe('tabpanel')
    expect(tabpanel?.getAttribute('aria-labelledby')).toBe('notification-tab-all')
    expect(document.getElementById('notification-tab-all')?.getAttribute('aria-controls')).toBe('notification-tabpanel')
    expect(itemButton('中 @ 了你')?.getAttribute('aria-label')).toMatch(/中 @ 了你，.+ · 供应链经营分析$/)
    wrapper.unmount()
  })

  it('takes the unread count from the server after reading instead of guessing locally', async () => {
    const { wrapper } = await setup(2)
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    // 被读的是静音项目里的通知：服务端本来就不计它，读完未读数不变。
    vi.mocked(workbenchApi.getNotificationUnreadCount).mockResolvedValue({ unread: 2 })
    itemButton('中 @ 了你')!.click()
    await flushPromises()
    expect(useNotificationStore().unread).toBe(2)
    wrapper.unmount()
  })

  it('refreshes the collaboration chat list after reading an @ notification', async () => {
    const { wrapper } = await setup()
    const conversations = useCollabConversationStore()
    await conversations.load()
    vi.mocked(workbenchApi.listConversationTargets).mockClear()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    itemButton('中 @ 了你')!.click()
    await flushPromises()
    expect(workbenchApi.listConversationTargets).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('marks the group\'s @ notifications read when the group is opened in the chat list', async () => {
    const { wrapper } = await setup(1)
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    const conversations = useCollabConversationStore()
    conversations.targets = [{
      type: 'group', id: 'ws-supply', name: '供应链经营分析', description: '', avatarNames: [], lastMessage: null,
      lastActiveAt: '', unreadCount: 1, mentioned: true,
    } as never]
    vi.mocked(workbenchApi.getNotificationUnreadCount).mockResolvedValue({ unread: 0 })
    await conversations.markRead('group', 'ws-supply')
    await flushPromises()
    expect(useNotificationStore().items.find(item => item.id === 'n-mention')?.read).toBe(true)
    expect(wrapper.get('[data-testid="notification-bell"]').attributes('aria-label')).toBe('通知')
    wrapper.unmount()
  })

  it('does not let a slow list load undo mark-all-read', async () => {
    const { wrapper } = await setup(1)
    let finishSlowLoad: (value: { items: UserNotification[]; nextCursor: null }) => void = () => undefined
    vi.mocked(workbenchApi.listUserNotifications).mockImplementationOnce(() => new Promise(resolve => { finishSlowLoad = resolve }))
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    const store = useNotificationStore()
    vi.mocked(workbenchApi.listUserNotifications).mockResolvedValue({ items: notifications.map(item => ({ ...item, read: true })), nextCursor: null })
    vi.mocked(workbenchApi.getNotificationUnreadCount).mockResolvedValue({ unread: 0 })
    await store.markAllRead()
    finishSlowLoad({ items: notifications.map(item => ({ ...item })), nextCursor: null })
    await flushPromises()
    expect(store.items.every(item => item.read)).toBe(true)
    expect(store.unread).toBe(0)
    wrapper.unmount()
  })
})
