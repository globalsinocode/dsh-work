import type { TaskRunError } from './types.ts'
import { redactSensitiveText } from './redact-sensitive-text.ts'

export interface RunFailureEvent {
  eventType: string
  displayMessage: string | null
  safeMetadata: Record<string, unknown>
}

const GENERIC_RUN_ERROR_REASONS = new Set([
  'DSH 运行时未能正常完成当前执行尝试。',
  'DSH 运行时未能正常完成当前执行尝试（具体原因见下方「原因」或对话详情中的执行过程）。',
])

/**
 * 从当前 Attempt 的终态失败事件提取可展示原因（已脱敏、有长度上限）。
 * 与治理侧试运行卡片共用同一口径。
 */
export function extractRunFailureReason(events: readonly RunFailureEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (!event.eventType.endsWith('.failed') && event.eventType !== 'run.cancelled') continue
    const reason = event.safeMetadata['reason']
    if (typeof reason === 'string' && reason.trim()) {
      return redactSensitiveText(reason.trim()).slice(0, 500)
    }
    if (event.displayMessage?.trim()) {
      return redactSensitiveText(event.displayMessage.trim()).slice(0, 500)
    }
    const code = event.safeMetadata['error_code']
    if (typeof code === 'string' && code.trim()) return code.trim()
  }
  return undefined
}

/** 将 run_events 中的遥测原因合并进面向员工的 TaskRunError.reason。 */
export function enrichTaskRunError(error: TaskRunError, events: readonly RunFailureEvent[]): TaskRunError {
  const detail = extractRunFailureReason(events)
  if (!detail) return error
  if (GENERIC_RUN_ERROR_REASONS.has(error.reason) || error.code === 'RUNTIME_EXECUTION_FAILED') {
    return { ...error, reason: detail }
  }
  if (error.reason.includes(detail)) return error
  return { ...error, reason: `${error.reason}（${detail}）` }
}
