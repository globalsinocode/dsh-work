<script setup lang="ts">
import { computed, ref } from 'vue'

import RunProgressSteps from './RunProgressSteps.vue'
import { workbenchApi } from '@/api/client'
import type { TaskRun } from '@/types/domain'
import { projectRunProgress } from '@/utils/run-progress-steps'

/**
 * 任务对话里一次执行的步骤（D37）：任务对话的数据只有消息与执行状态，步骤在展开时才按 runId
 * 读取执行详情，避免打开对话时为每次执行各发一次请求。读到后与会话页同样显示
 * “已完成 N 个步骤（调用工具 M 次）”与步骤列表。
 */
const props = defineProps<{ runId: string }>()
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled']

const run = ref<TaskRun | null>(null)
const loading = ref(false)
const failed = ref(false)

const progress = computed(() => run.value ? projectRunProgress(run.value) : null)
const label = computed(() => {
  if (loading.value) return '正在读取执行步骤…'
  if (failed.value) return '执行步骤读取失败，展开重试'
  if (!progress.value) return '执行步骤'
  if (!progress.value.rows.length) return '这次执行没有记录步骤'
  return progress.value.toolCount
    ? `已完成 ${progress.value.rows.length} 个步骤（调用工具 ${progress.value.toolCount} 次）`
    : `已完成 ${progress.value.rows.length} 个步骤`
})

async function onToggle(event: Event) {
  // 已结束的执行步骤不再变化，读一次即可；仍在进行（或审批后续跑）的每次展开重新读取。
  if (!(event.target as HTMLDetailsElement).open || loading.value) return
  if (run.value && TERMINAL_STATUSES.includes(run.value.status)) return
  loading.value = true
  failed.value = false
  try {
    run.value = await workbenchApi.getRun(props.runId)
  } catch {
    failed.value = true
    ;(event.target as HTMLDetailsElement).open = false
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <details class="run-progress-summary" data-testid="run-steps-disclosure" @toggle="onToggle">
    <summary>{{ label }}</summary>
    <RunProgressSteps v-if="progress && progress.rows.length" :rows="progress.rows" />
  </details>
</template>
