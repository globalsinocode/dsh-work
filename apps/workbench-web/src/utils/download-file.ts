import { runGuardedAction } from '@/utils/action-guard'

/** @deprecated 使用 `runGuardedAction`；保留别名避免扩散调用点。 */
export const runGuardedDownload = runGuardedAction

export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
