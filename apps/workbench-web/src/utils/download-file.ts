/** 与 TaskComposer `SUBMIT_DEBOUNCE_MS` 同口径：短窗口内忽略连点。 */
const DOWNLOAD_DEBOUNCE_MS = 600

const inFlight = new Map<string, Promise<void>>()
const lastTriggeredAt = new Map<string, number>()

/**
 * 合并同一资源的并发下载，并在防抖窗口内忽略重复触发。
 * 完成后重置时间戳，失败后可立即重试。
 */
export function runGuardedDownload(key: string, action: () => Promise<void>): Promise<void> {
  const pending = inFlight.get(key)
  if (pending) return pending

  const now = Date.now()
  const last = lastTriggeredAt.get(key) ?? 0
  if (now - last < DOWNLOAD_DEBOUNCE_MS) return Promise.resolve()

  lastTriggeredAt.set(key, now)
  const job = action().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, job)
  return job
}

export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
