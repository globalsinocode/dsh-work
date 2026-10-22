import { AdminApiError } from '../api/client'

export const AUTHORIZATION_CHANGE_CODES = [
  'authorization_denied',
  'permission_revoked',
  'role_disabled',
  'data_scope_revoked',
] as const

export type AuthorizationChangeListener = (error: AdminApiError) => void

let listener: AuthorizationChangeListener | null = null
let pendingNotification: Promise<void> | undefined

export function setAuthorizationChangeListener(next: AuthorizationChangeListener | null): void {
  listener = next
}

export function isAuthorizationChangeCode(code: string): boolean {
  return (AUTHORIZATION_CHANGE_CODES as readonly string[]).includes(code)
}

export function createAuthorizationChangeHandler(refresh: () => Promise<void>) {
  return async (error: AdminApiError) => {
    if (error.status !== 403 || !isAuthorizationChangeCode(error.code)) return
    if (!pendingNotification) {
      pendingNotification = refresh()
        .then(() => { listener?.(error) })
        .finally(() => { pendingNotification = undefined })
    }
    await pendingNotification
  }
}

let handler: ReturnType<typeof createAuthorizationChangeHandler> | null = null

export function setAuthorizationChangeHandler(next: ReturnType<typeof createAuthorizationChangeHandler> | null): void {
  handler = next
}

export async function notifyAuthorizationChange(error: AdminApiError): Promise<void> {
  if (!handler) return
  await handler(error)
}
