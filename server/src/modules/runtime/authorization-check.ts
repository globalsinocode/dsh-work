/** 平台授权复核硬超时；生产 env 下限严格大于旧 DSH 工具侧 6 秒探测预算。 */
export const AUTHORIZATION_CHECK_TIMEOUT_MS = 10_000
/** 慢日志阈值；达到后只记录，不拒绝。 */
export const AUTHORIZATION_CHECK_SLOW_MS = 5_000
/** 工具探测还要覆盖最多 3 秒容器静止等待，并保留 2 秒事件循环/IPC 余量。 */
export const AUTHORIZATION_TOOL_PROBE_OVERHEAD_MS = 5_000

export function authorizationToolProbeTimeoutMs(authorizationTimeoutMs: number): number {
  return authorizationTimeoutMs + AUTHORIZATION_TOOL_PROBE_OVERHEAD_MS
}

export type AuthorizationCheckPhase =
  | 'setup'
  | 'pre_start'
  | 'tool'
  | 'permission'
  | 'post_prompt'
  | 'post_collect'
  | 'scheduled'
  | 'unknown'

export type AuthorizationCheckOutcome =
  | 'slow'
  | 'recovered'
  | 'late_success'
  | 'late_error'
  | 'timeout'
  | 'error'
  | 'denied'

export interface AuthorizationCheckLogEntry {
  event: 'authorization.check'
  at: string
  level: 'warn' | 'info'
  run_id: string
  attempt_id: string
  phase: AuthorizationCheckPhase
  outcome: AuthorizationCheckOutcome
  duration_ms: number
  slow_ms: number
  timeout_ms: number
  error_name?: string
  error_code?: string
}

export function resolveAuthorizationCheckTimeoutMs(value: string | undefined): number {
  if (value === undefined || value === '') return AUTHORIZATION_CHECK_TIMEOUT_MS
  if (!/^\d+$/.test(value)) {
    throw new Error(`DSH_WORK_AUTHORIZATION_CHECK_TIMEOUT_MS 必须是无外围空白的整数毫秒：${value}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 7_000 || parsed > 30_000) {
    throw new Error(`DSH_WORK_AUTHORIZATION_CHECK_TIMEOUT_MS 必须在 7000–30000 之间：${value}`)
  }
  return parsed
}

export function authorizationCheckLogEntry(input: {
  level: 'warn' | 'info'
  runId: string
  attemptId: string
  phase: AuthorizationCheckPhase
  outcome: AuthorizationCheckOutcome
  durationMs: number
  slowMs: number
  timeoutMs: number
  error?: unknown
}): AuthorizationCheckLogEntry {
  const error = input.error
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
  return {
    event: 'authorization.check',
    at: new Date().toISOString(),
    level: input.level,
    run_id: input.runId,
    attempt_id: input.attemptId,
    phase: input.phase,
    outcome: input.outcome,
    duration_ms: Math.round(input.durationMs),
    slow_ms: input.slowMs,
    timeout_ms: input.timeoutMs,
    ...(error instanceof Error ? { error_name: error.name } : {}),
    ...(code ? { error_code: code } : {}),
  }
}

export function writeAuthorizationCheckLog(entry: AuthorizationCheckLogEntry): void {
  const line = JSON.stringify(entry)
  if (entry.level === 'info') console.info(line)
  else console.warn(line)
}
