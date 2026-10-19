import type { TaskRunError } from '@/types/domain'

/** 与服务端错误目录一致的占位说明，不应单独作为「原因」展示。 */
const GENERIC_RUN_FAILURE_REASON = /DSH 运行时未能正常完成|具体原因见下方/

export function isGenericRunFailureReason(reason: string | undefined | null) {
  if (!reason?.trim()) return true
  return GENERIC_RUN_FAILURE_REASON.test(reason.trim())
}

/** 失败通知框「原因」行：优先展示 Runtime/平台返回的具体说明。 */
export function runFailureDetailReason(error: TaskRunError) {
  const reason = error.reason.trim()
  if (!isGenericRunFailureReason(reason)) return reason
  return ''
}
