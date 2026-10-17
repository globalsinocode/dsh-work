/**
 * EX-01「长时间无输出」提示：执行中超过阈值没有收到任何运行事件（输出、工具步骤、状态）时，
 * 告诉员工任务仍在运行，避免误以为卡死而重复提交。
 *
 * 时间以客户端收到最后一个事件的时刻为准（`TaskRun.lastActivityAt`），不依赖服务端时钟；
 * 只在 `running` 时提示——排队与等待审批另有说明。
 */

export const RUN_QUIET_THRESHOLD_MS = 30_000

export function runQuietMs(
  task: { status: string; lastActivityAt?: number } | null | undefined,
  now: number,
): number {
  if (!task || task.status !== 'running' || task.lastActivityAt === undefined) return 0
  return Math.max(0, now - task.lastActivityAt)
}

/** 形如「35 秒」「2 分钟」；不足阈值返回 null，表示不提示。 */
export function runQuietLabel(quietMs: number): string | null {
  if (quietMs < RUN_QUIET_THRESHOLD_MS) return null
  const seconds = Math.floor(quietMs / 1000)
  return seconds < 120 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`
}
