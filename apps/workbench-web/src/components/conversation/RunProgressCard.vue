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
/**
 * 执行中的 AI 同事名称与完成后的回复一致：agentVersion 为“名称@版本”（无版本时为空串），
 * 取不到时退回本轮已有回复的 agentName（不取其他轮，避免共享对话里借用别的同事），再退回 dsh-work。
 */
const agentName = computed(() => props.task.agentVersion.split('@')[0]
  || props.task.messages.find(message => message.role === 'assistant' && message.runId === props.task.id && message.agentName)?.agentName
  || 'dsh-work')
</script>

<template>
  <article
    class="conversation-message conversation-message--assistant conversation-message--working"
    data-testid="run-progress-card"
  >
    <div class="assistant-identity">
      <span class="assistant-avatar">{{ agentName.slice(0, 1) }}</span>
      <div>
        <strong>{{ agentName }}</strong>
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
