<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import RunProgressSteps from './RunProgressSteps.vue'
import type { TaskRun } from '@/types/domain'
import { elapsedMs, formatElapsed, projectRunProgress } from '@/utils/run-progress-steps'

/**
 * EX-PROGRESS-01：执行中（排队或运行）的“正在处理”卡片——逐条列出已完成的步骤与耗时，
 * 当前步骤带每秒走动的计时，让员工看到任务仍在推进。时钟只在本卡片存在时运行。
 * 计时不放进读屏播报区，读屏只在当前步骤变化时播报。
 */
const props = defineProps<{ task: TaskRun }>()
const emit = defineEmits<{ 'open-details': [] }>()

const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => clearInterval(timer))

const progress = computed(() => projectRunProgress(props.task))
const offset = computed(() => props.task.clockOffsetMs ?? 0)
const totalLabel = computed(() => formatElapsed(elapsedMs(progress.value.startMs, now.value, offset.value)))
const activeLabels = computed(() => progress.value.rows.filter(row => row.state === 'active').map(row => row.label).join('，'))
</script>

<template>
  <article
    class="conversation-message conversation-message--assistant conversation-message--working"
    data-testid="run-progress-card"
  >
    <div class="assistant-identity">
      <span class="assistant-avatar">d</span>
      <div>
        <strong>dsh-work</strong>
        <span>正在处理<template v-if="totalLabel"> · 已用 {{ totalLabel }}</template></span>
      </div>
    </div>
    <div class="run-progress">
      <RunProgressSteps :rows="progress.rows" :now="now" :clock-offset-ms="offset" />
      <p class="run-progress-sr" role="status" data-testid="current-step">{{ activeLabels }}</p>
      <button type="button" class="run-progress__details" @click="emit('open-details')">查看执行过程</button>
    </div>
  </article>
</template>
