/** Web Push 与通知栏点击；由 Workbox generateSW 通过 importScripts 加载。 */

const MAX_EVENT_IDS = 200
const shownEventIds = new Set()

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url
  event.waitUntil(openRelativeUrl(typeof url === 'string' && url.length > 0 ? url : '/workbench'))
})

async function handlePush(event) {
  let payload
  try {
    payload = event.data?.json()
  } catch {
    return
  }
  if (!payload || typeof payload.eventId !== 'string') return
  if (shownEventIds.has(payload.eventId)) return
  shownEventIds.add(payload.eventId)
  if (shownEventIds.size > MAX_EVENT_IDS) {
    const first = shownEventIds.values().next().value
    shownEventIds.delete(first)
  }

  const title = typeof payload.title === 'string' ? payload.title : 'dsh-work'
  const body = typeof payload.body === 'string' ? payload.body : ''
  const tag = typeof payload.tag === 'string' ? payload.tag : undefined
  const relativeUrl = typeof payload.url === 'string' ? payload.url : '/workbench'

  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const visible = windowClients.filter((client) => client.visibilityState === 'visible')

  if (visible.length > 0) {
    if (visible.some((client) => isViewingTarget(client.url, payload))) return
    for (const client of visible) {
      client.postMessage({ type: 'dsh-work-push', payload })
    }
    return
  }

  await self.registration.showNotification(title, {
    body,
    tag,
    icon: '/pwa-192.png',
    data: { url: relativeUrl, eventId: payload.eventId },
  })
}

function isViewingTarget(clientUrl, payload) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (!sessionId) return false
  try {
    const url = new URL(clientUrl)
    if (url.searchParams.get('session') === sessionId) return true
    const chatMatch = url.pathname.match(/^\/chat\/([^/]+)/)
    if (chatMatch && decodeURIComponent(chatMatch[1]) === sessionId) return true
    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)/)
    if (sessionMatch && decodeURIComponent(sessionMatch[1]) === sessionId) return true
    const convMatch = url.pathname.match(/\/conversations\/([^/]+)/)
    if (convMatch && decodeURIComponent(convMatch[1]) === sessionId) return true
    if (url.searchParams.get('conversation') === sessionId) return true
  } catch {
    return false
  }
  return false
}

async function openRelativeUrl(relativePath) {
  const target = new URL(relativePath, self.location.origin)
  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windowClients) {
    if (!client.url.startsWith(self.location.origin)) continue
    if ('focus' in client) await client.focus()
    client.postMessage({ type: 'dsh-work-navigate', url: `${target.pathname}${target.search}${target.hash}` })
    return
  }
  await self.clients.openWindow(target.href)
}
