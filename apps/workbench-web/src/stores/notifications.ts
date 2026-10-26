import { defineStore } from 'pinia'
import { ref } from 'vue'

import { workbenchApi } from '@/api/client'
import type { AccountNotificationItem } from '@/types/domain'

let eventSource: EventSource | null = null

export const useNotificationStore = defineStore('notifications', () => {
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
