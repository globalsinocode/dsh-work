export interface WorkbenchPushPayload {
  eventId: string
  type: 'collab_unread' | 'run_finished'
  tag: string
  title: string
  body: string
  url: string
  sessionId: string
  targetType: 'agent' | 'group'
  targetId: string
  runId?: string
  runStatus?: 'succeeded' | 'failed' | 'awaiting_approval'
}

export function isWorkbenchPushPayload(value: unknown): value is WorkbenchPushPayload {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.eventId === 'string'
    && typeof record.title === 'string'
    && typeof record.url === 'string'
}

import type { RouteLocationNormalizedLoaded } from 'vue-router'

export function routeLocationSearch(route: Pick<RouteLocationNormalizedLoaded, 'fullPath'>): string {
  const index = route.fullPath.indexOf('?')
  return index >= 0 ? route.fullPath.slice(index) : ''
}

/** 当前路由是否已在查看该条通知对应的会话（与 push-sw.js 口径一致）。 */
export function routeShowsPushSession(path: string, search: string, sessionId: string): boolean {
  if (!sessionId) return false
  const params = new URLSearchParams(search)
  if (params.get('session') === sessionId) return true
  if (params.get('conversation') === sessionId) return true
  const chatMatch = path.match(/^\/chat\/([^/]+)/)
  if (chatMatch && decodeURIComponent(chatMatch[1]) === sessionId) return true
  const sessionMatch = path.match(/^\/sessions\/([^/]+)/)
  if (sessionMatch && decodeURIComponent(sessionMatch[1]) === sessionId) return true
  const convMatch = path.match(/\/conversations\/([^/]+)/)
  if (convMatch && decodeURIComponent(convMatch[1]) === sessionId) return true
  return false
}
