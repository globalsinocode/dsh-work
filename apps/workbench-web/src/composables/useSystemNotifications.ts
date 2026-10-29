import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useTaskStore } from '@/stores/tasks'
import {
  isLoginOrErrorRoute,
  isWorkbenchNotificationSupported,
  shouldAutoRequestNotificationPermission,
  urlBase64ToUint8Array,
} from '@/utils/system-notification-client'
import {
  isWorkbenchPushPayload,
  routeLocationSearch,
  routeShowsPushSession,
  type WorkbenchPushPayload,
} from '@/utils/push-notification-payload'

const POLL_MS = 60_000

/** 员工端系统通知：SW 推送、应用内顶部条、无推送时的未读轮询。 */
export function useSystemNotifications() {
  const route = useRoute()
  const router = useRouter()
  const authStore = useAuthStore()
  const taskStore = useTaskStore()

  const active = isWorkbenchNotificationSupported()
  const bannerPayload = ref<WorkbenchPushPayload | null>(null)
  const shownEventIds = new Set<string>()
  const runStatusSnapshot = new Map<string, string>()
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const lastUnreadSnapshot = new Map<string, number>()

  function showBanner(payload: WorkbenchPushPayload) {
    if (shownEventIds.has(payload.eventId)) return
    if (isLoginOrErrorRoute(route.path)) return
    if (routeShowsPushSession(route.path, routeLocationSearch(route), payload.sessionId)) return
    shownEventIds.add(payload.eventId)
    bannerPayload.value = payload
  }

  function clearBanner() {
    bannerPayload.value = null
  }

  async function ensurePushSubscription() {
    if (!active || !authStore.initialized || authStore.user.id === '—') return
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return
    if (Notification.permission !== 'granted') return
    try {
      const config = await workbenchApi.getPushConfig()
      const registration = await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
        })
      }
      await workbenchApi.savePushSubscription(subscription.toJSON())
    } catch {
      // 订阅失败不反复弹框
    }
  }

  async function maybeRequestPermissionOnEntry() {
    if (!active || !shouldAutoRequestNotificationPermission()) return
    if (!authStore.initialized || authStore.user.id === '—') return
    if (isLoginOrErrorRoute(route.path)) return
    if (!('Notification' in window)) return
    if (Notification.permission !== 'default') return
    try {
      await workbenchApi.getPushConfig()
    } catch {
      return
    }
    const permission = await Notification.requestPermission()
    if (permission === 'granted') await ensurePushSubscription()
  }

  async function pollConversationUnread() {
    if (!active || document.visibilityState !== 'visible') return
    if (isLoginOrErrorRoute(route.path) || isLoginOrErrorRoute(window.location.pathname)) return
    try {
      const page = await workbenchApi.listConversationTargets({ limit: 50 })
      for (const target of page.items) {
        const key = `${target.type}:${target.id}`
        const previous = lastUnreadSnapshot.get(key) ?? target.unreadCount
        lastUnreadSnapshot.set(key, target.unreadCount)
        if (target.muted || target.unreadCount <= previous) continue
        if (routeShowsPushSession(route.path, routeLocationSearch(route), target.id)) continue
        const preview = target.lastMessage?.text?.trim() || '发来一条新消息'
        showBanner({
          eventId: `poll:${key}:${target.lastMessage?.sentAt ?? target.lastActiveAt}`,
          type: 'collab_unread',
          tag: `collab:${target.type}:${target.id}`,
          title: target.name,
          body: target.type === 'group' && target.lastMessage
            ? `${target.lastMessage.authorName}：${preview}`
            : preview,
          url: target.type === 'group'
            ? `/workspaces/${target.id}`
            : `/workbench?agent=${encodeURIComponent(target.id)}`,
          sessionId: target.id,
          targetType: target.type,
          targetId: target.id,
        })
      }
    } catch {
      // 轮询失败静默
    }
  }

  function onServiceWorkerMessage(event: MessageEvent) {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'dsh-work-push' && isWorkbenchPushPayload(data.payload)) {
      showBanner(data.payload)
    }
    if (data.type === 'dsh-work-navigate' && typeof data.url === 'string') {
      void router.push(data.url)
    }
  }

  watch(
    () => [authStore.initialized, authStore.user.id] as const,
    ([initialized, userId]) => {
      if (!active || !initialized || userId === '—') return
      void maybeRequestPermissionOnEntry()
    },
    { immediate: true },
  )

  watch(
    () => taskStore.tasks.map((task) => `${task.id}:${task.status}`).join('|'),
    () => {
      if (!active) return
      for (const task of taskStore.tasks) {
        const previous = runStatusSnapshot.get(task.id)
        runStatusSnapshot.set(task.id, task.status)
        if (task.requestedBy !== authStore.user.id) continue
        if (!previous || previous === task.status) continue
        if (!['succeeded', 'failed', 'awaiting_approval'].includes(task.status)) continue
        if (['succeeded', 'failed', 'awaiting_approval', 'cancelled'].includes(previous)) continue
        const sessionId = task.sessionId ?? task.id
        if (routeShowsPushSession(route.path, routeLocationSearch(route), sessionId)) continue
        const runStatus = task.status === 'awaiting_approval'
          ? 'awaiting_approval' as const
          : task.status === 'succeeded'
            ? 'succeeded' as const
            : 'failed' as const
        const titles = {
          succeeded: '任务已完成',
          failed: '任务未完成',
          awaiting_approval: '有待确认的操作',
        } as const
        showBanner({
          eventId: `run-local:${task.id}:${task.status}`,
          type: 'run_finished',
          tag: `run:${task.id}`,
          title: titles[runStatus],
          body: task.title || (runStatus === 'succeeded'
            ? '可以回到对话查看结果'
            : runStatus === 'failed'
              ? '可以回到对话查看原因'
              : '打开对话后可以允许或拒绝'),
          url: task.workspaceType === 'team' && task.workspaceId
            ? `/workspaces/${task.workspaceId}?session=${sessionId}`
            : `/chat/${sessionId}`,
          sessionId,
          targetType: task.workspaceType === 'team' ? 'group' : 'agent',
          targetId: task.workspaceType === 'team' ? (task.workspaceId ?? task.id) : task.id,
          runId: task.id,
          runStatus,
        })
      }
    },
  )

  onMounted(() => {
    if (!active) return
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
    pollTimer = setInterval(() => { void pollConversationUnread() }, POLL_MS)
    void pollConversationUnread()
  })

  onBeforeUnmount(() => {
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
    if (pollTimer) clearInterval(pollTimer)
  })

  return {
    active,
    bannerPayload,
    clearBanner,
    ensurePushSubscription,
  }
}

export async function unregisterPushBeforeLogout() {
  if (!isWorkbenchNotificationSupported() || !('serviceWorker' in navigator)) return
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration) return
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      await workbenchApi.deletePushSubscription({ endpoint: subscription.endpoint })
      await subscription.unsubscribe()
    }
  } catch {
    // 退出仍继续
  }
}
