<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { StatusTag } from '@dsh-work/ui-core'

import RunProgressSteps from '@/components/conversation/RunProgressSteps.vue'
import type { TaskRun } from '@/types/domain'
import { elapsedMs, formatElapsed, projectRunProgress } from '@/utils/run-progress-steps'
import '@/styles/conversation-thread.css'

/**
 * 群聊中一次还没有回复的执行（MODE-E2E-09）：执行记录不再单独占一行，而是以 Agent 条目出现在
 * 回复的位置——执行中显示步骤与计时，等待确认、失败、停止说明原因；回复写入后由回复取代本条目。
 * 步骤来自 Run 详情的实时事件（`task`），拿不到详情时只显示状态。
 */
const props = defineProps<{
  status: string
  agentName: string | null
  requesterName: string
  stoppedByName: string | null
  time: string
  task?: TaskRun
  canStop: boolean
  stopping?: boolean
}>()
const emit = defineEmits<{ open: []; stop: [] }>()

const active = computed(() => props.status === 'queued' || props.status === 'running')
const awaiting = computed(() => props.status === 'awaiting_approval' || props.status === 'waiting')
/** 标签配色沿用 StatusTag：持久化等待与等待确认同色，请求停止中按“已停止”。 */
const tagStatus = computed(() => awaiting.value ? 'awaiting_approval' : props.status === 'cancel_requested' ? 'cancelled' : props.status)
const name = computed(() => props.agentName ?? 'Agent')
const progress = computed(() => props.task ? projectRunProgress(props.task) : undefined)
const offset = computed(() => props.task?.clockOffsetMs ?? 0)

// 计时只在执行中走动；结束后停表。
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
watch(active, (running) => {
  if (timer) clearInterval(timer)
  timer = running ? setInterval(() => { now.value = Date.now() }, 1000) : undefined
}, { immediate: true })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const elapsed = computed(() => progress.value ? formatElapsed(elapsedMs(progress.value.startMs, now.value, offset.value)) : '')
const chipLabel = computed(() => {
  if (props.status === 'running') return elapsed.value ? `执行中 · 已用 ${elapsed.value}` : '执行中'
  if (props.status === 'cancelled' && props.stoppedByName) return `${props.stoppedByName} 停止`
  if (props.status === 'cancel_requested') return '正在停止'
  return undefined
})
const activeLabels = computed(() => progress.value?.rows.filter(row => row.state === 'active').map(row => row.label).join('，') ?? '')
const notice = computed(() => {
  if (props.status === 'queued') return '排队中，即将开始执行。'
  if (props.status === 'running') return '正在执行…'
  if (awaiting.value) return '等待确认后继续执行，可在执行详情中处理。'
  if (props.status === 'cancel_requested') return '正在停止这次执行…'
  if (props.status === 'failed') return '这次执行没有完成，可在执行详情中查看原因。'
  if (props.status === 'cancelled') return `执行已被 ${props.stoppedByName ?? '成员'} 停止，没有生成回复。`
  return '执行已结束，没有生成回复。'
})
</script>

<template>
  <article
    class="conversation-message conversation-message--assistant collab-run-entry"
    data-testid="group-run-entry"
    :data-status="status"
  >
    <!-- 状态标签放在身份行之外：身份行的说明文字样式会覆盖标签内的配色。 -->
    <div class="collab-run-entry__head">
      <div class="assistant-identity">
        <span class="assistant-avatar">{{ name.slice(0, 1) }}</span>
        <div>
          <strong>{{ name }}</strong>
          <span>{{ time }} · 由 {{ requesterName }} 发起</span>
        </div>
      </div>
      <StatusTag :status="tagStatus" :label="chipLabel" dot />
    </div>
    <div class="assistant-answer collab-run-entry__body">
      <RunProgressSteps
        v-if="active && progress?.rows.length"
        :rows="progress.rows"
        :now="now"
        :clock-offset-ms="offset"
      />
      <p v-else class="collab-run-entry__notice">{{ notice }}</p>
      <p v-if="active" class="run-progress-sr" role="status">{{ activeLabels }}</p>
      <div class="collab-run-entry__actions">
        <button type="button" class="collab-run-entry__link" @click="emit('open')">查看执行详情</button>
        <button
          v-if="active && canStop"
          type="button"
          class="collab-run-entry__link collab-run-entry__link--danger"
          :disabled="stopping"
          @click="emit('stop')"
        >{{ stopping ? '正在停止…' : '停止' }}</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.collab-run-entry__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.collab-run-entry__notice {
  margin: 0;
  color: var(--dsh-color-muted);
}

.collab-run-entry__actions {
  display: flex;
  gap: 16px;
  margin-top: 8px;
}

.collab-run-entry__link {
  padding: 0;
  border: 0;
  color: var(--el-color-primary);
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
}

.collab-run-entry__link--danger {
  color: var(--el-color-danger);
}

.collab-run-entry__link:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>
