<script setup lang="ts">
import { computed, toRef } from 'vue'
import { Close, CopyDocument, Document, Download, EditPen, Lock, RefreshRight, Share, Warning } from '@element-plus/icons-vue'
import { StatusTag } from '@dsh-work/ui-core'

import ArtifactImageThumb from './ArtifactImageThumb.vue'
import ConversationMessageItem from './ConversationMessageItem.vue'
import { resultOutcomeLabels, useRunProgress } from '@/composables/useRunProgress'
import type { Artifact, ChatMessage, TaskRun } from '@/types/domain'
import { isImageArtifact, isOfficeArtifact, unavailableTextNote } from '@/utils/artifact-preview'
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

const emit = defineEmits<{
  preview: [artifact: Artifact]
  download: [artifact: Artifact]
  'continue-editing': [artifact: Artifact]
  'copy-answer': [content: string]
  'copy-link': []
  'open-details': []
  retry: []
}>()

const task = toRef(props, 'task')
const { currentStepLabel, quietLabel, isTerminalRun } = useRunProgress(computed(() => task.value))

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

function belongsToCurrentRun(message: ChatMessage) {
  return message.runId === task.value.id
}

function isReferenced(artifact: Artifact) {
  return Boolean(artifact.fileId && props.referencedFileIds.includes(artifact.fileId))
}

function artifactsForMessage(message: ChatMessage) {
  if (message.role !== 'assistant' || !message.runId) return []
  if (lastAssistantIdByRun.value.get(message.runId) !== message.id) return []
  return displayArtifacts.value.filter(artifact =>
    artifact.runId === message.runId
    || (!artifact.runId && message.runId === task.value.id),
  )
}

/** 执行隔离 2b-2：本轮 output 中未登记为成果的文件及原因，列在本轮最后一条回复下。 */
function skippedArtifactsForMessage(message: ChatMessage) {
  if (message.id !== lastAssistantMessageId.value || !belongsToCurrentRun(message) || !isTerminalRun.value) return []
  return task.value.result.pendingItems.filter(item => item.kind === 'artifact_skipped').map(item => item.message)
}

/** 本轮最后一条回复在执行结束后显示业务结论与耗时，代替发送时间。 */
function messageMeta(message: ChatMessage) {
  if (message.id !== lastAssistantMessageId.value || !belongsToCurrentRun(message) || !isTerminalRun.value) return undefined
  return `${resultOutcomeLabels[task.value.result.outcome]}${task.value.duration ? ` · ${task.value.duration}` : ''}`
}

/** Office/PDF 成果没有可用解析文本时，在卡片旁说明；点开右栏同样说明并提供下载。 */
function bodyUnavailableNote(artifact: Artifact) {
  return isOfficeArtifact(artifact.type) && artifact.textPreview !== 'available' ? unavailableTextNote(artifact) : ''
}

function isPreviewing(artifact: Artifact) {
  return props.previewKey === `${artifact.id}@${artifact.version}`
}
</script>

<template>
  <ConversationMessageItem
    v-for="message in task.messages"
    :key="message.id"
    :message="message"
    :own="isOwn(message)"
    :meta="messageMeta(message)"
  >
    <div
      v-if="artifactsForMessage(message).length"
      class="answer-artifacts"
      data-testid="answer-artifacts"
    >
      <div
        v-for="artifact in artifactsForMessage(message)"
        :key="artifact.id"
        class="answer-artifact"
        :data-testid="`answer-artifact-${artifact.id}`"
      >
        <div class="answer-artifact__row">
          <button
            type="button"
            class="answer-artifact__open"
            :class="{ 'is-active': isPreviewing(artifact) }"
            :aria-label="`预览成果 ${artifact.name}`"
            :aria-pressed="isPreviewing(artifact)"
            :data-testid="`preview-artifact-${artifact.id}`"
            @click="emit('preview', artifact)"
          >
            <span><el-icon><Document /></el-icon></span>
            <span>
              <strong>{{ artifact.name }}</strong>
              <small>{{ artifact.size }} · V{{ artifact.version }}</small>
            </span>
            <span class="answer-artifact__state">{{ isPreviewing(artifact) ? '预览中' : '预览' }}</span>
          </button>
          <button
            type="button"
            class="answer-artifact__download"
            :aria-label="`下载成果 ${artifact.name}`"
            @click="emit('download', artifact)"
          >
            <el-icon><Download /></el-icon>
          </button>
          <button
            v-if="canFollowUp && artifact.canReference && artifact.fileId && belongsToCurrentRun(message)"
            type="button"
            class="answer-artifact__revise"
            :data-testid="`continue-editing-${artifact.id}`"
            :disabled="isReferenced(artifact)"
            @click="emit('continue-editing', artifact)"
          >
            <el-icon><EditPen /></el-icon>
            {{ isReferenced(artifact) ? '已引用' : '继续修改' }}
          </button>
        </div>
        <p
          v-if="bodyUnavailableNote(artifact)"
          class="answer-artifact__unavailable"
          :data-testid="`artifact-body-unavailable-${artifact.id}`"
        >{{ bodyUnavailableNote(artifact) }}</p>
        <ArtifactImageThumb
          v-if="isImageArtifact(artifact.type)"
          :artifact="artifact"
          :active="isPreviewing(artifact)"
          @open="emit('preview', artifact)"
        />
      </div>
    </div>

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

  <article
    v-if="['queued', 'running'].includes(task.status)"
    class="conversation-message conversation-message--assistant conversation-message--working"
  >
    <div class="assistant-identity">
      <span class="assistant-avatar">d</span>
      <div>
        <strong>dsh-work</strong>
        <span>正在处理</span>
      </div>
    </div>
    <div class="working-answer">
      <span class="working-dots"><i></i><i></i><i></i></span>
      <span data-testid="current-step">{{ currentStepLabel }}</span>
      <button type="button" @click="emit('open-details')">查看执行过程</button>
    </div>
    <p v-if="quietLabel" class="working-quiet" role="status" data-testid="run-quiet-hint">
      已 {{ quietLabel }}没有新的输出，任务仍在运行。Agent 可能在等待模型或工具返回，无需重复提交。
    </p>
  </article>

  <section v-if="task.status === 'awaiting_approval'" class="conversation-notice approval-notice">
    <span class="conversation-notice__icon"><el-icon><Lock /></el-icon></span>
    <div>
      <strong>等待本轮工具权限确认</strong>
      <p>{{ task.approval?.reason ?? '服务端已暂停当前执行并保留审批所需的动作边界。' }}</p>
      <dl>
        <div><dt>对象</dt><dd class="mono">{{ task.approval?.object ?? '受控工具' }}</dd></div>
        <div><dt>范围</dt><dd>{{ task.approval?.dataScope ?? '当前用户授权范围' }}</dd></div>
      </dl>
      <p>{{ task.approval?.nextStep ?? '审批完成后会从新的 Attempt 继续执行，无需重复提交。' }}</p>
    </div>
    <StatusTag status="awaiting_approval" label="等待确认" />
  </section>

  <section v-if="task.result.error" class="conversation-notice error-notice">
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
