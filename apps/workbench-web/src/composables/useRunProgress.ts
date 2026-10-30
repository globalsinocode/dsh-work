import { computed, type Ref } from 'vue'

import type { TaskResultOutcome, TaskRun } from '@/types/domain'

/**
 * I-06 结果外层展示：业务结论只看 result.outcome，不由 status === 'succeeded'
 * 推断达成；执行状态仍由 task.status 与步骤时间线表达。
 */
export const resultOutcomeLabels: Record<TaskResultOutcome, string> = {
  pending: '结果生成中',
  achieved: '目标已达成',
  unverified: '结果待核验',
  not_achieved: '目标未达成',
}

/** 一次执行（Run）是否已终结；执行中的步骤与计时见 RunProgressCard（EX-PROGRESS-01）。 */
export function useRunProgress(task: Ref<TaskRun | undefined>) {
  const isTerminalRun = computed(() =>
    Boolean(task.value && ['succeeded', 'failed', 'cancelled'].includes(task.value.status)))

  return { isTerminalRun }
}
