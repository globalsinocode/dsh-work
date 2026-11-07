import { defineStore } from 'pinia'
import { ref } from 'vue'

import { workbenchApi } from '@/api/client'
import type { AccountNotificationItem, UserNotification } from '@/types/domain'

let eventSource: EventSource | null = null

export const useWorkspaceNotificationStore = defineStore('workspace-notifications', () => {
  const items = ref<AccountNotificationItem[]>([])
  const unreadTotal = ref(0)
  const unreadByWorkspace = ref<Record<string, number>>({})
  const lastSequence = ref(0)
  const loading = ref(false)
  const inboxOpen = ref(false)

  async function refreshCounts() {
    const counts = await workbenchApi.getNotificationCounts()
    unreadTotal.value = counts.total
    unreadByWorkspace.value = counts.byWorkspace
    lastSequence.value = Math.max(lastSequence.value, counts.lastReadSequence)
  }

  async function loadPage(input: { cursor?: string; unread?: boolean } = {}) {
    loading.value = true
    try {
      const page = await workbenchApi.listNotifications({
        cursor: input.cursor,
        limit: 20,
        unread: input.unread,
      })
      if (input.cursor) items.value.push(...page.items)
      else items.value = page.items
      const maxRendered = page.items.reduce((max, item) => Math.max(max, item.sequence), lastSequence.value)
      lastSequence.value = maxRendered
      return page.nextCursor
    } finally {
      loading.value = false
    }
  }

  async function load() {
    await refreshCounts()
    await loadPage()
    connectEvents()
  }

  async function markReadThroughHighestRendered() {
    const highest = items.value.reduce((max, item) => Math.max(max, item.sequence), 0)
    if (highest <= 0) return
    const result = await workbenchApi.markNotificationsRead({ throughSequence: highest })
    lastSequence.value = Math.max(lastSequence.value, result.lastReadSequence)
    await refreshCounts()
    items.value = items.value.filter(item => item.sequence > result.lastReadSequence)
  }

  function disconnectEvents() {
    eventSource?.close()
    eventSource = null
  }

  function connectEvents() {
    if (typeof EventSource === 'undefined') return
    disconnectEvents()
    const since = lastSequence.value
    eventSource = new EventSource(workbenchApi.notificationEventsUrl(since), { withCredentials: true })
    eventSource.addEventListener('notification.changed', () => {
      void refreshCounts()
    })
  }

  function reconnect() {
    connectEvents()
  }

  function reset() {
    disconnectEvents()
    items.value = []
    unreadTotal.value = 0
    unreadByWorkspace.value = {}
    lastSequence.value = 0
    inboxOpen.value = false
  }

  return {
    items,
    unreadTotal,
    unreadByWorkspace,
    lastSequence,
    loading,
    inboxOpen,
    load,
    loadPage,
    refreshCounts,
    markReadThroughHighestRendered,
    reconnect,
    reset,
  }
})

export type NotificationTab = 'all' | 'unread'

/**
 * 站内通知（方案 NC-S2）：铃铛角标的未读数与面板中的通知列表。未读数与“未读”页签同一口径，
 * 均以服务端为准；本地只在标记已读后先行扣减，失败时由下次刷新纠正。迟到的旧请求不覆盖新结果。
 */
export const useNotificationStore = defineStore('workbench-notifications', () => {
  const unread = ref(0)
  const items = ref<UserNotification[]>([])
  const nextCursor = ref<string | null>(null)
  const tab = ref<NotificationTab>('all')
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref('')
  let generation = 0
  let countGeneration = 0

  /** 只刷新角标：轮询与页面重新可见时调用。迟到的旧响应不覆盖新结果；失败保留上一次的数字。 */
  async function refreshUnread() {
    const current = ++countGeneration
    try {
      const { unread: count } = await workbenchApi.getNotificationUnreadCount()
      if (current === countGeneration) unread.value = count
    } catch {
      // 角标刷新失败时保留原值，下次轮询再取。
    }
  }

  async function load(nextTab: NotificationTab = tab.value) {
    const current = ++generation
    tab.value = nextTab
    loading.value = true
    error.value = ''
    try {
      const [page] = await Promise.all([workbenchApi.listUserNotifications({ status: nextTab }), refreshUnread()])
      if (current !== generation) return
      items.value = page.items
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current !== generation) return
      error.value = cause instanceof Error ? cause.message : '通知加载失败'
    } finally {
      if (current === generation) loading.value = false
    }
  }

  async function loadMore() {
    if (!nextCursor.value || loadingMore.value) return
    const current = generation
    loadingMore.value = true
    try {
      const page = await workbenchApi.listUserNotifications({ status: tab.value, cursor: nextCursor.value })
      if (current !== generation) return
      const known = new Set(items.value.map(item => item.id))
      items.value = [...items.value, ...page.items.filter(item => !known.has(item.id))]
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current !== generation) error.value = cause instanceof Error ? cause.message : '通知加载失败'
    } finally {
      loadingMore.value = false
    }
  }

  /**
   * 点开一条：本地先标为已读，再写服务端并以服务端的未读数为准。不在本地扣减角标：
   * 静音项目的通知本来就不计未读，本地无从判断。
   */
  async function markRead(item: UserNotification) {
    if (item.read) return
    item.read = true
    try {
      await workbenchApi.markNotificationRead(item.id)
    } catch {
      // 写入失败不阻断跳转：下次刷新会重新显示未读。
    }
    await refreshUnread()
  }

  async function markAllRead() {
    await workbenchApi.markAllNotificationsRead()
    // 作废进行中的列表加载与角标刷新：迟到的旧结果不能把已读的条目重新显示为未读。
    const reloading = loading.value
    generation++
    countGeneration++
    loading.value = false
    for (const item of items.value) item.read = true
    if (tab.value === 'unread') items.value = []
    nextCursor.value = tab.value === 'unread' ? null : nextCursor.value
    unread.value = 0
    // 被作废的加载重新取一次，结果已是全部已读后的状态。
    if (reloading) await load()
  }

  /** 打开群组时服务端已把该群的 @ 通知标为已读：本地同步，再以服务端的未读数为准（方案 NC4）。 */
  async function markWorkspaceMentionsRead(workspaceId: string) {
    for (const item of items.value) {
      if (item.kind === 'mention' && item.workspace?.id === workspaceId) item.read = true
    }
    if (tab.value === 'unread') items.value = items.value.filter(item => !item.read)
    await refreshUnread()
  }

  function reset() {
    generation++
    countGeneration++
    unread.value = 0
    items.value = []
    nextCursor.value = null
    tab.value = 'all'
    loading.value = false
    loadingMore.value = false
    error.value = ''
  }

  return {
    unread, items, nextCursor, tab, loading, loadingMore, error,
    refreshUnread, load, loadMore, markRead, markAllRead, markWorkspaceMentionsRead, reset,
  }
})
