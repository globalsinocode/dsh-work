import { describe, expect, it } from 'vitest'

import { routeShowsPushSession } from '@/utils/push-notification-payload'
import {
  isWorkbenchNotificationSupported,
  shouldAutoRequestNotificationPermission,
} from '@/utils/system-notification-client'

describe('system-notification-client', () => {
  it('supports notifications when the Notification API exists', () => {
    const original = globalThis.Notification
    // @ts-expect-error test stub
    globalThis.Notification = function Notification() {}
    expect(isWorkbenchNotificationSupported()).toBe(true)
    if (original) globalThis.Notification = original
    else Reflect.deleteProperty(globalThis, 'Notification')
  })

  it('only auto-requests permission on mobile or standalone PWA', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('standalone'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    })) as typeof window.matchMedia
    expect(shouldAutoRequestNotificationPermission()).toBe(true)
    window.matchMedia = ((query: string) => ({
      matches: query.includes('min-width: 901px'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    })) as typeof window.matchMedia
    expect(shouldAutoRequestNotificationPermission()).toBe(false)
    window.matchMedia = original
  })
})

describe('push-notification-payload', () => {
  it('matches workspace session query and chat paths', () => {
    expect(routeShowsPushSession('/workspaces/ws-1', '?session=sess-1', 'sess-1')).toBe(true)
    expect(routeShowsPushSession('/chat/sess-1', '', 'sess-1')).toBe(true)
    expect(routeShowsPushSession('/workbench', '', 'sess-1')).toBe(false)
  })
})
