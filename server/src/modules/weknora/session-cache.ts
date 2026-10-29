export interface CachedWeknoraSession {
  accessToken: string
  weknoraUserId: string
  expiresAtMs: number
}

export class WeknoraSessionCache {
  private readonly entries = new Map<string, CachedWeknoraSession>()

  get(key: string, nowMs = Date.now()): CachedWeknoraSession | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  set(key: string, session: CachedWeknoraSession) {
    this.entries.set(key, session)
  }

  delete(key: string) {
    this.entries.delete(key)
  }

  deleteByUser(userId: string) {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${userId}:`)) this.entries.delete(key)
    }
  }
}

export function cacheKey(userId: string, weknoraUserId: string) {
  return `${userId}:${weknoraUserId}`
}

export function cacheExpiryMs(expiresInSeconds: number, nowMs = Date.now()) {
  const ttlMs = Math.min(expiresInSeconds, 600) * 1000
  return nowMs + ttlMs
}
