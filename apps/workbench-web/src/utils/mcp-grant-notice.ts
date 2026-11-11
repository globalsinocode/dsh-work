/** 员工台外部连接 OAuth 结果提示：刷新页面后仍可看到最近一次失败原因。 */

const STORAGE_KEY = 'dsh-work:workbench:mcp-grant-notice'
const TTL_MS = 24 * 60 * 60 * 1000

type StoredNotice = { message: string; expiresAt: number }

function hasSessionStorage(): boolean {
  try {
    return typeof sessionStorage !== 'undefined'
  } catch {
    return false
  }
}

export function saveMcpGrantNotice(message: string): void {
  if (!hasSessionStorage() || !message.trim()) return
  try {
    const payload: StoredNotice = { message: message.trim(), expiresAt: Date.now() + TTL_MS }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch { /* ignore */ }
}

export function loadMcpGrantNotice(): string | null {
  if (!hasSessionStorage()) return null
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredNotice
    if (!parsed?.message || parsed.expiresAt < Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    return parsed.message
  } catch {
    sessionStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export function clearMcpGrantNotice(): void {
  if (!hasSessionStorage()) return
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}
