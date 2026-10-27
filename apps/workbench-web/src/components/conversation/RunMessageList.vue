<script setup lang="ts">
import { computed, reactive, ref, toRef } from 'vue'
import { ArrowDown, ArrowUp, Close, CopyDocument, Document, EditPen, Lock, RefreshRight, Share, Warning, View } from '@element-plus/icons-vue'
import { AssistantMessageContent, StatusTag } from '@dsh-work/ui-core'

import ArtifactImageThumb from './ArtifactImageThumb.vue'
import ConversationMessageItem from './ConversationMessageItem.vue'
import { workbenchApi } from '@/api/client'
import ArtifactContentDialog from '@/components/ArtifactContentDialog.vue'
import ArtifactTextView from '@/components/ArtifactTextView.vue'
import { resultOutcomeLabels, useRunProgress } from '@/composables/useRunProgress'
import type { Artifact, ChatMessage, TaskRun } from '@/types/domain'
import { isImageArtifact, isOfficeArtifact, unavailableTextNote, type OfficeArtifactType } from '@/utils/artifact-preview'
import { notifyActionFailure } from '@/utils/feedback'
import '@/styles/conversation-thread.css'

/**
 * 一次执行（Run）的消息流（S5b 从 ConversationView 拆出）：消息、本轮成果卡片（下载 /
 * 继续修改）、执行中状态、审批等待、失败与结论提示。A 的对话详情与 B 的对话页（每段会话）
 * 共用；操作只发事件，写权限与导航由调用方决定。
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
}>(), { canFollowUp: false, canRetry: false, referencedFileIds: () => [] })

const emit = defineEmits<{
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

/**
 * 成果就地展开正文：Markdown/文本读原文，Office/PDF 读解析文本（执行隔离 2b-5）。加载失败时在原处
 * 提示，再次展开会重新加载。
 */
const previewState = reactive<Record<string, { open: boolean; loading: boolean; text: string; error: string; officeType?: OfficeArtifactType }>>({})

/** 可展开正文：文本类成果，以及解析文本可用的 Office/PDF 成果。 */
function canViewBody(artifact: Artifact) {
  return artifact.type === 'markdown' || artifact.type === 'text'
    || (isOfficeArtifact(artifact.type) && artifact.textPreview === 'available')
}

/** Office/PDF 成果没有可用解析文本时，代替“查看正文”的说明。 */
function bodyUnavailableNote(artifact: Artifact) {
  return isOfficeArtifact(artifact.type) && artifact.textPreview !== 'available' ? unavailableTextNote(artifact) : ''
}

/** 图片成果点击缩略图后放大查看。 */
const imageDialogOpen = ref(false)
const imageArtifact = ref<Artifact | null>(null)
function openImage(artifact: Artifact) {
  imageArtifact.value = artifact
  imageDialogOpen.value = true
}

function previewKey(artifact: Artifact) {
  return `${artifact.id}@${artifact.version}`
}

function isPreviewOpen(artifact: Artifact) {
  return Boolean(previewState[previewKey(artifact)]?.open)
}

async function togglePreview(artifact: Artifact) {
  if (!canViewBody(artifact)) return
  const key = previewKey(artifact)
  const current = previewState[key]
  if (current?.open) {
    current.open = false
    return
  }
  if (current?.text) {
    current.open = true
    return
  }
  previewState[key] = { open: true, loading: true, text: '', error: '' }
  try {
    if (isOfficeArtifact(artifact.type)) {
      const preview = await workbenchApi.getArtifactText(artifact.id, artifact.version)
      previewState[key] = preview.status === 'available'
        ? { open: true, loading: false, text: preview.text, error: '', officeType: artifact.type }
        : { open: true, loading: false, text: '', error: unavailableTextNote({ textPreview: preview.status, textPreviewError: preview.status === 'failed' ? preview.message : undefined }) }
      return
    }
    const blob = await workbenchApi.downloadArtifact(artifact.id, artifact.version)
    const text = await blob.text()
    previewState[key] = { open: true, loading: false, text, error: '' }
  } catch (cause) {
    previewState[key] = { open: true, loading: false, text: '', error: '预览加载失败' }
    notifyActionFailure('预览成果', `成果“${artifact.name}”V${artifact.version}`, cause, '可改用下载后本地打开；若仍失败，请联系工作空间管理员。')
  }
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
            class="answer-artifact__download"
            :aria-label="`下载成果 ${artifact.name}`"
            @click="emit('download', artifact)"
          >
            <span><el-icon><Document /></el-icon></span>
            <span>
              <strong>{{ artifact.name }}</strong>
              <small>{{ artifact.size }} · V{{ artifact.version }}</small>
            </span>
            <el-icon><ArrowDown /></el-icon>
          </button>
          <button
            v-if="canViewBody(artifact)"
            type="button"
            class="answer-artifact__preview"
            :aria-label="isPreviewOpen(artifact) ? `收起 ${artifact.name} 正文` : `展开 ${artifact.name} 正文`"
            :aria-expanded="isPreviewOpen(artifact)"
            :data-testid="`preview-artifact-${artifact.id}`"
            @click="togglePreview(artifact)"
          >
            <el-icon><component :is="isPreviewOpen(artifact) ? ArrowUp : View" /></el-icon>
            {{ isPreviewOpen(artifact) ? '收起正文' : '查看正文' }}
          </button>
          <span
            v-else-if="bodyUnavailableNote(artifact)"
            class="answer-artifact__unavailable"
            :data-testid="`artifact-body-unavailable-${artifact.id}`"
          >{{ bodyUnavailableNote(artifact) }}</span>
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
        <div
          v-if="previewState[`${artifact.id}@${artifact.version}`]?.open"
          class="answer-artifact__body"
          :data-testid="`artifact-body-${artifact.id}`"
        >
          <p v-if="previewState[`${artifact.id}@${artifact.version}`]?.loading" class="answer-artifact__body-status">正在加载正文…</p>
          <p v-else-if="previewState[`${artifact.id}@${artifact.version}`]?.error" class="answer-artifact__body-status">{{ previewState[`${artifact.id}@${artifact.version}`].error }}</p>
          <ArtifactTextView
            v-else-if="previewState[`${artifact.id}@${artifact.version}`]?.officeType"
            :type="previewState[`${artifact.id}@${artifact.version}`]!.officeType!"
            :text="previewState[`${artifact.id}@${artifact.version}`]?.text || ''"
          />
          <AssistantMessageContent
            v-else
            :text="previewState[`${artifact.id}@${artifact.version}`]?.text || ''"
          />
        </div>
        <ArtifactImageThumb v-if="isImageArtifact(artifact.type)" :artifact="artifact" @open="openImage(artifact)" />
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

  <ArtifactContentDialog v-model:open="imageDialogOpen" :artifact="imageArtifact" />
</template>
