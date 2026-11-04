<script setup lang="ts">
import { computed, toRef } from 'vue'
import { Close, CopyDocument, RefreshRight, Share, Warning } from '@element-plus/icons-vue'
import { StatusTag } from '@dsh-work/ui-core'

import ConversationMessageItem from './ConversationMessageItem.vue'
import RunApprovalNotice from './RunApprovalNotice.vue'
import RunArtifactCards from './RunArtifactCards.vue'
import AgentRecommendationCards from './AgentRecommendationCards.vue'
import SkillDraftCards from './SkillDraftCards.vue'
import RunProgressCard from './RunProgressCard.vue'
import RunProgressSummary from './RunProgressSummary.vue'
import { resultOutcomeLabels, useRunProgress } from '@/composables/useRunProgress'
import { useAuthStore } from '@/stores/auth'
import type { AgentRecommendation, Artifact, ChatMessage, TaskRun } from '@/types/domain'
import { mentionsUser } from '@/utils/mentions'
import '@/styles/conversation-thread.css'

/**
 * 一次执行（Run）的消息流（S5b 从 ConversationView 拆出）：消息、本轮成果卡片（预览 / 下载 /
 * 继续修改）、执行中状态、审批等待、失败与结论提示。A 的对话详情与 B 的对话页（每段会话）
 * 共用；操作只发事件，写权限、导航与预览右栏由调用方决定。
 *
 * 个人会话详情可能含多轮 Run 的消息：成果优先取 threadArtifacts，并按 artifact.runId
 * 挂到该 Run 最后一条助手回复下，避免只展示最新 Run 的 result.artifacts。
 */
const props = withDefaults(defineProps<{
  task: TaskRun
  /** 本人发送的消息（右侧）；由调用方按发送者与会话类型判定。 */
  isOwn: (message: ChatMessage) => boolean
  canFollowUp?: boolean
  canRetry?: boolean
  /** 已在输入区引用的成果文件，对应卡片显示“已引用”。 */
  referencedFileIds?: string[]
  /** 右栏正在预览的成果版本（`id@version`），对应卡片标为选中。 */
  previewKey?: string | null
}>(), { canFollowUp: false, canRetry: false, referencedFileIds: () => [], previewKey: null })

const authStore = useAuthStore()

const emit = defineEmits<{
  preview: [artifact: Artifact]
  download: [artifact: Artifact]
  'continue-editing': [artifact: Artifact]
  'copy-answer': [content: string]
  'copy-link': []
  'open-details': []
  retry: []
  /** 推荐卡片“去聊天”：带上推荐所在那一轮员工的问题，供目标对话预填。 */
  'open-recommended-agent': [recommendation: AgentRecommendation, prompt: string]
}>()

const task = toRef(props, 'task')
const { isTerminalRun } = useRunProgress(computed(() => task.value))

/** 气泡可展示的成果：多轮线程用 threadArtifacts，否则退回本轮 result.artifacts。 */
const displayArtifacts = computed(() =>
  task.value.threadArtifacts?.length ? task.value.threadArtifacts : task.value.result.artifacts,
)

/** 每个 runId 下最后一条助手消息 id → 用于挂成果卡。 */
const lastAssistantIdByRun = computed(() => {
  const map = new Map<string, string>()
  for (const message of task.value.messages) {
    if (message.role === 'assistant' && message.runId) map.set(message.runId, message.id)
  }
  return map
})

const lastAssistantMessageId = computed(() => lastAssistantIdByRun.value.get(task.value.id))

/** EX-PROGRESS-01：本轮结束后，执行步骤摘要放在本轮第一条回复上方。 */
const firstAssistantMessageId = computed(() =>
  task.value.messages.find(message => message.role === 'assistant' && belongsToCurrentRun(message))?.id)

function belongsToCurrentRun(message: ChatMessage) {
  return message.runId === task.value.id
}

function artifactsForMessage(message: ChatMessage) {
  if (message.role !== 'assistant' || !message.runId) return []
  if (lastAssistantIdByRun.value.get(message.runId) !== message.id) return []
  return displayArtifacts.value.filter(artifact =>
    artifact.runId === message.runId
    || (!artifact.runId && message.runId === task.value.id),
  )
}

/** 推荐卡片与成果卡同一规则：挂在该 Run 最后一条助手回复下。 */
function recommendationsForMessage(message: ChatMessage) {
  if (message.role !== 'assistant' || !message.runId) return []
  if (lastAssistantIdByRun.value.get(message.runId) !== message.id) return []
  return (task.value.recommendations ?? []).filter(item => item.runId === message.runId)
}

/** Skill 草稿卡片同样挂在该 Run 最后一条助手回复下（Skill 创建专家方案 4.3）。 */
function skillDraftsForMessage(message: ChatMessage) {
  if (message.role !== 'assistant' || !message.runId) return []
  if (lastAssistantIdByRun.value.get(message.runId) !== message.id) return []
  return (task.value.skillDrafts ?? []).filter(item => item.runId === message.runId)
}

function openRecommendedAgent(recommendation: AgentRecommendation) {
  if (recommendation.suggestedPrompt) {
    emit('open-recommended-agent', recommendation, recommendation.suggestedPrompt)
    return
  }
  const prompt = task.value.messages.find(message => message.role === 'user' && message.runId === recommendation.runId)?.content
    ?? (recommendation.runId === task.value.id ? task.value.prompt : '')
  emit('open-recommended-agent', recommendation, prompt)
}

/** 执行隔离 2b-2：本轮 output 中未登记为成果的文件及原因，列在本轮最后一条回复下。 */
function skippedArtifactsForMessage(message: ChatMessage) {
  if (message.id !== lastAssistantMessageId.value || !belongsToCurrentRun(message) || !isTerminalRun.value) return []
  return task.value.result.pendingItems.filter(item => item.kind === 'artifact_skipped').map(item => item.message)
}

/**
 * 历史轮次的结果说明：停止或失败、没有任何回复的较早一轮，在其问题下留一行说明；
 * 本轮的停止与失败仍由下方的卡片说明，这里不重复。
 */
const pastRunNotes = computed(() => {
  const answered = new Set(task.value.messages.filter(message => message.role === 'assistant').map(message => message.runId))
  const byRun = new Map<string, string>()
  for (const run of task.value.threadRuns ?? []) {
    if (run.runId === task.value.id || answered.has(run.runId)) continue
    if (run.status === 'cancelled') byRun.set(run.runId, run.stoppedBy ? `已停止（${run.stoppedBy}），没有生成回复` : '已停止，没有生成回复')
    else if (run.status === 'failed') byRun.set(run.runId, '这一轮没有完成，没有生成回复')
  }
  // 每轮只在该轮最后一条员工消息下标出一次：按消息 id 记录，渲染时直接取。
  const byMessage = new Map<string, string>()
  const lastUserByRun = new Map<string, string>()
  for (const message of task.value.messages) {
    if (message.role === 'user' && message.runId && byRun.has(message.runId)) lastUserByRun.set(message.runId, message.id)
  }
  for (const [runId, messageId] of lastUserByRun) byMessage.set(messageId, byRun.get(runId)!)
  return byMessage
})

function pastRunNote(message: ChatMessage) {
  return pastRunNotes.value.get(message.id)
}

/** 本轮最后一条回复在执行结束后显示业务结论与耗时，代替发送时间。 */
function messageMeta(message: ChatMessage) {
  if (message.id !== lastAssistantMessageId.value || !belongsToCurrentRun(message) || !isTerminalRun.value) return undefined
  return `${resultOutcomeLabels[task.value.result.outcome]}${task.value.duration ? ` · ${task.value.duration}` : ''}`
}
</script>

<template>
  <template v-for="message in task.messages" :key="message.id">
    <ConversationMessageItem
      :message="message"
      :own="isOwn(message)"
      :meta="messageMeta(message)"
      :tag="!isOwn(message) && mentionsUser(message, authStore.user.id) ? '@了你' : undefined"
    >
      <template v-if="isTerminalRun && message.id === firstAssistantMessageId" #before>
        <RunProgressSummary :task="task" />
      </template>
      <RunArtifactCards
        :artifacts="artifactsForMessage(message)"
        :can-continue-editing="canFollowUp && belongsToCurrentRun(message)"
        :referenced-file-ids="referencedFileIds"
        :preview-key="previewKey"
        @preview="emit('preview', $event)"
        @download="emit('download', $event)"
        @continue-editing="emit('continue-editing', $event)"
      />
      <AgentRecommendationCards
        :recommendations="recommendationsForMessage(message)"
        @open="openRecommendedAgent"
      />
      <SkillDraftCards :drafts="skillDraftsForMessage(message)" />

      <div
        v-if="skippedArtifactsForMessage(message).length"
        class="answer-skipped"
        role="note"
        aria-label="未登记为成果的文件"
        data-testid="artifact-skipped"
      >
        <p class="answer-skipped__title">以下文件未登记为成果</p>
        <ul>
          <li v-for="line in skippedArtifactsForMessage(message)" :key="line">{{ line }}</li>
        </ul>
      </div>

      <div class="assistant-actions">
        <button type="button" aria-label="复制回答" @click="emit('copy-answer', message.content)">
          <el-icon><CopyDocument /></el-icon>
        </button>
        <button
          type="button"
          aria-label="复制对话链接"
          @click="emit('copy-link')"
        >
          <el-icon><Share /></el-icon>
        </button>
        <span v-if="belongsToCurrentRun(message)" class="assistant-run-meta">
          {{ task.tokenUsage ? `${task.tokenUsage.toLocaleString()} Token` : '自动' }}
          · {{ task.agentVersion.split('@')[0] }}
        </span>
      </div>
    </ConversationMessageItem>
    <p v-if="pastRunNote(message)" class="conversation-past-run" data-testid="past-run-note">{{ pastRunNote(message) }}</p>
  </template>

  <RunProgressCard
    v-if="['queued', 'running'].includes(task.status)"
    :task="task"
    @open-details="emit('open-details')"
  />

  <RunApprovalNotice v-if="task.status === 'awaiting_approval'" :task="task" />

  <section v-if="task.result.error" class="conversation-notice error-notice" data-testid="run-error-notice">
    <span class="conversation-notice__icon"><el-icon><Close /></el-icon></span>
    <div>
      <strong>{{ task.result.error.message }}</strong>
      <dl>
        <div><dt>对象</dt><dd>{{ task.result.error.object }}</dd></div>
        <div><dt>原因</dt><dd>{{ task.result.error.reason }}</dd></div>
      </dl>
      <p><strong>下一步：</strong>{{ task.result.error.suggestion }}</p>
      <ul v-if="task.result.pendingItems.some(item => item.kind === 'external_effect_unknown')" class="result-pending">
        <li v-for="item in task.result.pendingItems.filter(item => item.kind === 'external_effect_unknown')" :key="item.message">{{ item.message }}</li>
      </ul>
      <code>{{ task.result.error.code }}</code>
    </div>
    <el-button
      v-if="canRetry"
      type="primary"
      plain
      :icon="RefreshRight"
      @click="emit('retry')"
    >
      重新执行本轮
    </el-button>
  </section>

  <section
    v-if="isTerminalRun && task.result.outcome === 'not_achieved' && !task.result.error"
    class="conversation-notice verify-notice verify-notice--neutral"
    data-testid="run-result-not-achieved"
  >
    <span class="conversation-notice__icon"><el-icon><Warning /></el-icon></span>
    <div>
      <strong>{{ task.result.summary }}</strong>
    </div>
    <StatusTag :status="task.result.outcome" :label="resultOutcomeLabels[task.result.outcome]" />
  </section>

  <p v-if="task.status === 'cancelled' && task.stoppedBy" class="conversation-stopped-by" data-testid="run-stopped-by">
    本轮执行已由 {{ task.stoppedBy }} 停止
  </p>

</template>
