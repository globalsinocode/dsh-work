/** 员工工作台（PC 浏览器与移动/PWA）是否具备系统通知能力。 */
export function isWorkbenchNotificationSupported(): boolean {
  if (typeof window === 'undefined') return false
  return 'Notification' in window
}

/**
 * 移动/PWA：登录进入工作台后自动弹出系统权限框。
 * PC 浏览器通常需用户手势，仅在用户中心打开「系统通知」时申请权限。
 */
export function shouldAutoRequestNotificationPermission(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const narrow = window.matchMedia('(max-width: 900px)').matches
  return coarse && narrow
}

/** @deprecated 使用 isWorkbenchNotificationSupported */
export function isSystemNotificationClient(): boolean {
  return isWorkbenchNotificationSupported()
}

export function isLoginOrErrorRoute(path: string): boolean {
  return path === '/login'
    || path.startsWith('/login-error')
    || path.startsWith('/forbidden')
    || path.startsWith('/change-password')
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}
