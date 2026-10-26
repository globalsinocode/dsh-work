import { computed, onBeforeUnmount, ref, type Ref } from 'vue'

import type { TaskResultOutcome, TaskRun } from '@/types/domain'
import { runQuietLabel, runQuietMs } from '@/utils/run-quiet'

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

/** 一次执行（Run）的进行中展示：当前步骤、长时间无输出提示与是否已终结。 */
export function useRunProgress(task: Ref<TaskRun | undefined>) {
  // 最近一个进行中的步骤（EX-01 实时工具调用会排在“开始执行”之后）。
  const currentStep = computed(() =>
    [...(task.value?.steps ?? [])].reverse().find((step) => ['running', 'awaiting_approval'].includes(step.status)),
  )
  const currentStepLabel = computed(() => {
    const step = currentStep.value
    if (!step) return '正在准备回答'
    return step.tool && step.status === 'running' ? `正在调用 ${step.tool}` : step.title
  })
  // EX-01：执行中长时间没有新事件时提示仍在运行。时钟每 5 秒走一次，只驱动这条提示。
  const clock = ref(Date.now())
  const clockTimer = setInterval(() => { clock.value = Date.now() }, 5000)
  onBeforeUnmount(() => clearInterval(clockTimer))
  const quietLabel = computed(() => runQuietLabel(runQuietMs(task.value, clock.value)))
  const isTerminalRun = computed(() =>
    Boolean(task.value && ['succeeded', 'failed', 'cancelled'].includes(task.value.status)))

  return { currentStepLabel, quietLabel, isTerminalRun }
}
