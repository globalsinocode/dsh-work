import { onBeforeUnmount, onMounted } from 'vue'

const DEFAULT_INTERVAL_MS = 60_000
const MIN_GAP_MS = 5_000

/**
 * 员工端 Agent 目录复核。
 *
 * 目录是服务端「当前可见性」的投影，不是长期缓存：管理端停用 Agent 后，已经打开的
 * 页面不会自动知道。这里在页面停留期间定期、以及窗口重新可见/聚焦时静默刷新，
 * 让「已停用」在最多一个周期内从目录消失；刷新失败保留上一次成功结果，由页面
 * 自身的错误态决定是否提示。
 */
export function useAgentCatalogSync(refresh: () => Promise<unknown>, intervalMs = DEFAULT_INTERVAL_MS) {
  let timer: ReturnType<typeof setInterval> | undefined
  let lastRefreshAt = 0
  let running = false

  async function sync() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (running) return
    const now = Date.now()
    if (now - lastRefreshAt < MIN_GAP_MS) return
    lastRefreshAt = now
    running = true
    try {
      await refresh()
    } catch {
      // 目录刷新失败不打断当前页面；保留上一次成功结果。
    } finally {
      running = false
    }
  }

  function onFocus() {
    void sync()
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') void sync()
  }

  onMounted(() => {
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    timer = setInterval(() => void sync(), intervalMs)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (timer) clearInterval(timer)
    timer = undefined
  })

  return { sync }
}
