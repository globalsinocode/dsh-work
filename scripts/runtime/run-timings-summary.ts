/**
 * EX-00: turns per-Attempt timing samples into a stage summary (sample size,
 * missing count, p50, p95, max) plus outcome counts. Pure, so it is unit-tested
 * without a database; `run-timings.ts` loads the samples.
 */
export interface AttemptSample {
  attemptId: string
  purpose: string | null
  outcome: 'completed' | 'failed' | 'cancelled' | 'unfinished'
  errorCode: string | null
  /** Stage values in milliseconds (memory in KB); null when not reported. */
  metrics: Record<string, number | null>
}

export const stageOrder = [
  ['queue_wait_ms', '排队等待（创建 Attempt → 领取）'],
  ['prepare_ms', '准备（受理 → 启动 Worker）'],
  ['worker_spawn_ms', 'Worker 进程启动'],
  ['worker_init_ms', 'ACP 初始化'],
  ['session_ready_ms', 'Session 就绪'],
  ['first_output_ms', '首次输出'],
  ['execution_ms', '执行（prompt → 结束）'],
  ['artifact_collect_ms', '成果收集'],
  ['elapsed_ms', 'Adapter 全程'],
  ['end_to_end_ms', '端到端（创建 Attempt → 终态）'],
  ['worker_rss_kb', 'Worker 内存 RSS（KB，结束时）'],
  ['worker_cpu_ms', 'Worker CPU 时间'],
  ['input_tokens', '输入 Token'],
  ['output_tokens', '输出 Token'],
  ['tool_call_count', '工具调用次数'],
] as const

export interface StageSummary {
  key: string
  label: string
  samples: number
  missing: number
  p50: number | null
  p95: number | null
  max: number | null
}

export interface TimingSummary {
  attempts: number
  outcomes: Record<AttemptSample['outcome'], number>
  failureRate: number | null
  errorCodes: Array<{ code: string; count: number }>
  stages: StageSummary[]
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (!sorted.length) return null
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[rank - 1]!
}

export function summarizeTimings(samples: readonly AttemptSample[]): TimingSummary {
  const outcomes = { completed: 0, failed: 0, cancelled: 0, unfinished: 0 }
  const codes = new Map<string, number>()
  for (const sample of samples) {
    outcomes[sample.outcome] += 1
    if (sample.outcome === 'failed') codes.set(sample.errorCode ?? 'UNKNOWN', (codes.get(sample.errorCode ?? 'UNKNOWN') ?? 0) + 1)
  }
  const finished = outcomes.completed + outcomes.failed
  return {
    attempts: samples.length,
    outcomes,
    // Failed samples count in the denominator; cancelled and unfinished do not.
    failureRate: finished ? outcomes.failed / finished : null,
    errorCodes: [...codes].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    stages: stageOrder.map(([key, label]) => {
      const values = samples
        .map(sample => sample.metrics[key])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .sort((a, b) => a - b)
      return {
        key, label,
        samples: values.length,
        missing: samples.length - values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        max: values.at(-1) ?? null,
      }
    }),
  }
}

export function formatSummary(summary: TimingSummary): string {
  const lines = [
    `Attempt 数：${summary.attempts}（完成 ${summary.outcomes.completed}，失败 ${summary.outcomes.failed}，取消 ${summary.outcomes.cancelled}，未结束 ${summary.outcomes.unfinished}）`,
    `失败率：${summary.failureRate === null ? '无已结束样本' : `${(summary.failureRate * 100).toFixed(1)}%`}`,
  ]
  if (summary.errorCodes.length) lines.push(`失败原因：${summary.errorCodes.map(item => `${item.code} ×${item.count}`).join('，')}`)
  lines.push('', '| 阶段 | 样本 | 缺失 | p50 | p95 | 最大 |', '| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const stage of summary.stages) {
    const show = (value: number | null) => value === null ? '—' : String(value)
    lines.push(`| ${stage.label} | ${stage.samples} | ${stage.missing} | ${show(stage.p50)} | ${show(stage.p95)} | ${show(stage.max)} |`)
  }
  return lines.join('\n')
}
