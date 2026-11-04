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
/** 群聊里只显示正在进行的步骤，其余折叠成计数，完整步骤在执行详情中查看。 */
const currentRows = computed(() => progress.value?.rows.filter(row => row.state === 'active') ?? [])
/**
 * 有正在进行的步骤时，转圈与步骤计时已表明“执行中、用了多久”，不再重复状态标签、不套卡片。
 * 群聊状态与执行详情可能短暂不同步（详情里已没有进行中的步骤），这时回到状态标签加说明，避免把已完成的步骤当作进度。
 */
const showSteps = computed(() => active.value && currentRows.value.length > 0)
const chipLabel = computed(() => {
  if (props.status === 'running') return elapsed.value ? `执行中 · 已用 ${elapsed.value}` : '执行中'
  if (props.status === 'cancelled' && props.stoppedByName) return `${props.stoppedByName} 停止`
  if (props.status === 'cancel_requested') return '正在停止'
  return undefined
})
/** 已结束的步骤分开计数：失败或未收到结果的步骤不算“已完成”，避免在群聊里掩盖失败。 */
const stepSummary = computed(() => {
  const rows = progress.value?.rows ?? []
  const done = rows.filter(row => row.state === 'done').length
  const failed = rows.filter(row => row.state === 'failed' || row.state === 'unknown').length
  return [done ? `已完成 ${done} 步` : '', failed ? `${failed} 步失败` : ''].filter(Boolean).join(' · ')
})
const notice = computed(() => {
  if (props.status === 'queued') return '排队中，即将开始执行。'
  if (props.status === 'running') return '正在执行…'
  if (awaiting.value) return '等待确认后继续执行，可在执行详情中处理。'
  if (props.status === 'cancel_requested') return '正在停止这次执行…'
  if (props.status === 'failed') return '这次执行没有完成，可在执行详情中查看原因。'
  if (props.status === 'cancelled') return `执行已被 ${props.stoppedByName ?? '成员'} 停止，没有生成回复。`
  return '执行已结束，没有生成回复。'
})
/** 读屏播报：有进行中的步骤时报步骤与计数，否则报与页面一致的说明，不留空。 */
const liveAnnouncement = computed(() => showSteps.value
  ? [currentRows.value.map(row => row.label).join('，'), stepSummary.value].filter(Boolean).join('，')
  : notice.value)
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
      <StatusTag v-if="!showSteps" :status="tagStatus" :label="chipLabel" dot />
    </div>
    <!-- 执行中只留步骤与操作一行，不再套卡片；等待、失败、停止等需要说明原因时仍用卡片。 -->
    <div class="collab-run-entry__body" :class="showSteps ? 'collab-run-entry__body--live' : 'assistant-answer'">
      <RunProgressSteps
        v-if="showSteps"
        :rows="currentRows"
        :now="now"
        :clock-offset-ms="offset"
      />
      <p v-else class="collab-run-entry__notice">{{ notice }}</p>
      <p v-if="active" class="run-progress-sr" role="status">{{ liveAnnouncement }}</p>
      <div class="collab-run-entry__actions">
        <span v-if="showSteps && stepSummary" class="collab-run-entry__done">{{ stepSummary }}</span>
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

.collab-run-entry__body {
  /* 读屏播报区（.run-progress-sr）的定位祖先，避免它逃出群组时间线滚动区把整页撑高。 */
  position: relative;
}

.collab-run-entry__body--live {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 4px 20px;
  margin: 6px 0 0 34px;
}

.collab-run-entry__body--live .run-progress-steps {
  min-width: 0;
  max-width: 100%;
}

.collab-run-entry__body--live .collab-run-entry__actions {
  margin-top: 0;
  padding-bottom: 4px;
}

.collab-run-entry__notice {
  margin: 0;
  color: var(--dsh-color-muted);
}

.collab-run-entry__actions {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 8px;
}

.collab-run-entry__done {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
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
