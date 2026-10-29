<script setup lang="ts">
import { computed } from 'vue'

import RunProgressSteps from './RunProgressSteps.vue'
import type { TaskRun } from '@/types/domain'
import { projectRunProgress } from '@/utils/run-progress-steps'

/**
 * EX-PROGRESS-01：执行结束后，执行步骤收起为回答上方的一行“已完成 N 个步骤（调用工具 M 次）”，
 * 点击展开同一份列表。总用时已在回答标题行显示，这里不重复；没有调用工具时不显示。
 */
const props = defineProps<{ task: TaskRun }>()

const progress = computed(() => projectRunProgress(props.task))
</script>

<template>
  <details v-if="progress.toolCount" class="run-progress-summary" data-testid="run-progress-summary">
    <summary>已完成 {{ progress.rows.length }} 个步骤（调用工具 {{ progress.toolCount }} 次）</summary>
    <RunProgressSteps :rows="progress.rows" />
  </details>
</template>
