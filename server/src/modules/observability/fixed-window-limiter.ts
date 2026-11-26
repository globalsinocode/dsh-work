/**
 * 进程内固定窗口计数（错误上报限流）。只用于丢弃过量上报，不是安全边界：
 * 重启后清零可以接受。键数量有上限，超出时先清理过期窗口，仍超出则拒绝新键。
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly now: () => number

  constructor(options: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }) {
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.maxKeys = options.maxKeys ?? 10_000
    this.now = options.now ?? Date.now
  }

  /** 尝试占用 `amount` 个名额，返回实际获准的数量（0 表示全部丢弃）。 */
  take(key: string, amount = 1): number {
    const now = this.now()
    let window = this.windows.get(key)
    if (!window || now - window.start >= this.windowMs) {
      if (!window && this.windows.size >= this.maxKeys) {
        this.prune(now)
        if (this.windows.size >= this.maxKeys) return 0
      }
      window = { start: now, count: 0 }
      this.windows.set(key, window)
    }
    const granted = Math.max(0, Math.min(amount, this.limit - window.count))
    window.count += granted
    return granted
  }

  private prune(now: number) {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key)
    }
  }
}
