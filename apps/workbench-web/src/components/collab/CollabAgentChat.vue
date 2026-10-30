<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowLeft } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

import ArtifactPreviewPanel from '@/components/conversation/ArtifactPreviewPanel.vue'
import RunComposer from '@/components/conversation/RunComposer.vue'
import { useOpenRecommendedAgent } from '@/composables/useOpenRecommendedAgent'
import { takeRecommendationPrefill } from '@/utils/recommendation-prefill'
import RunMessageList from '@/components/conversation/RunMessageList.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useRunActions } from '@/composables/useRunActions'
import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useCollabConversationStore } from '@/stores/collab-conversations'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { Artifact, AgentConversation, AgentConversationSegment, ChatMessage, TaskRun } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
import '@/styles/conversation-thread.css'

const openRecommendedAgent = useOpenRecommendedAgent()
/** 推荐卡片跳转带来的问题：预填进输入框，不自动发送；发送后提示消失。 */
const recommendationPrefill = ref('')
/** 输入框只在挂载时读取初始内容：带入预填时换 key 重新挂载，发送时不重挂以免打断提交。 */
const composerKey = ref(0)

/**
 * 协作模式单聊（S5c，D26）：与一个 AI 同事的多段会话按时间连续显示，段首“话题 · 时间”。
 * 每段内容读取该段最近一次执行（个人 Run 详情含整段会话的消息），渲染复用 A 的
 * RunMessageList；发送时续写服务端给出的最近一段会话，没有可续写的会话时开启新会话——
 * 都经既有 startRun / createSession，不新增执行入口。
 */
const props = defineProps<{
  agentId: string
  /** 链接定位的会话：加载到该段并滚动到段首。 */
  focusSessionId?: string
}>()
const emit = defineEmits<{ back: [] }>()

const taskStore = useTaskStore()
const authStore = useAuthStore()
const contentStore = useContentStore()
const conversations = useCollabConversationStore()

const conversation = ref<AgentConversation | null>(null)
/** 已加载的会话分段，新到旧（与接口一致）；显示时反转为旧到新。 */
const segments = ref<AgentConversationSegment[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadError = ref('')
const loadingEarlier = ref(false)
const segmentErrors = ref<Record<string, string>>({})
const scroller = ref<HTMLElement>()
let generation = 0

const agent = computed(() => conversation.value?.agent)
const agentProfile = computed(() => contentStore.agents.find(item => item.id === props.agentId))
const displaySegments = computed(() => [...segments.value].reverse())
const newestSegment = computed(() => segments.value[0])
const continueSessionId = computed(() => conversation.value?.continueSessionId ?? null)
const canSend = computed(() => agent.value?.available === true)

function segmentTask(segment: AgentConversationSegment): TaskRun | undefined {
  return segment.latestRun ? taskStore.getTask(segment.latestRun.id) : undefined
}

const latestTask = computed(() => newestSegment.value ? segmentTask(newestSegment.value) : undefined)
/** 单聊都是本人的个人会话：停止与重试与 A 的个人对话同一口径（仅发起人）。 */
const canOperate = computed(() => Boolean(latestTask.value && latestTask.value.requestedBy === authStore.user.id))
const running = computed(() => ['queued', 'running', 'awaiting_approval'].includes(latestTask.value?.status ?? ''))
const resolvingApproval = ref(false)

function canResolveApproval(segment: AgentConversationSegment) {
  const run = segmentTask(segment)
  return Boolean(
    run?.status === 'awaiting_approval'
    && run.requestedBy === authStore.user.id
    && run.approval?.employeeResolvable,
  )
}

async function resolveApproval(segment: AgentConversationSegment, decision: 'approved' | 'rejected') {
  const run = segmentTask(segment)
  if (!run || resolvingApproval.value) return
  resolvingApproval.value = true
  try {
    await taskStore.resolveRunApproval(run.id, decision)
    ElMessage.success(decision === 'approved' ? '已允许本次操作' : '已拒绝本次操作')
  } catch (cause) {
    notifyActionFailure('确认操作', run.title, cause, '请刷新对话后重试。')
  } finally {
    resolvingApproval.value = false
  }
}

const {
  stopping,
  stopRun,
  retryRun,
  copyAnswer,
  copyConversationLink,
  download,
  referencedArtifacts,
  continueEditing,
  removeReferencedArtifact,
} = useRunActions(latestTask, {
  canOperate,
  onRetried: () => reloadNewest(),
})

/** EX-ARTIFACT-08：点击成果在右栏预览；宽屏（≥1280px）作为第三栏，否则为抽屉。换 AI 同事时关闭。 */
const previewArtifact = ref<Artifact | null>(null)
const previewDocked = useMediaQuery('(min-width: 1280px)', true)
const previewKey = computed(() => previewArtifact.value ? `${previewArtifact.value.id}@${previewArtifact.value.version}` : null)
watch(() => props.agentId, () => { previewArtifact.value = null })

/** 只有续写目标那一段可以“继续修改”：引用只在同一会话内有效。 */
function canFollowUp(segment: AgentConversationSegment) {
  return canSend.value && segment.sessionId === continueSessionId.value
}

function canRetry(segment: AgentConversationSegment) {
  const task = segmentTask(segment)
  return Boolean(task && segment === newestSegment.value && canSend.value && canOperate.value
    && ['failed', 'cancelled'].includes(task.status)
    && !task.result.pendingItems.some(item => item.kind === 'external_effect_unknown')
    && (task.result.error?.retryable ?? true))
}

/** 复制的链接沿用 A 的对话地址（与模式无关，12.5），协作模式打开时再映射回单聊。 */
function segmentLink(segment: AgentConversationSegment) {
  return new URL(`/conversations/${segment.latestRun?.id ?? segment.sessionId}`, window.location.origin).toString()
}

function isOwn(message: ChatMessage) {
  return message.role === 'user'
}

function segmentLabel(segment: AgentConversationSegment) {
  const date = new Date(segment.createdAt)
  const time = Number.isNaN(date.getTime())
    ? segment.createdAt
    : date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `${segment.title} · ${time}`
}

/** 读取分段最近一次执行；已缓存的终态执行不重复请求。 */
async function ensureRuns(list: AgentConversationSegment[]) {
  await Promise.all(list.map(async segment => {
    const runId = segment.latestRun?.id
    if (!runId) return
    const cached = taskStore.getTask(runId)
    if (cached && ['succeeded', 'failed', 'cancelled'].includes(cached.status)) return
    try {
      await taskStore.refreshRun(runId)
      delete segmentErrors.value[segment.sessionId]
    } catch (cause) {
      if (!taskStore.getTask(runId)) {
        segmentErrors.value[segment.sessionId] = cause instanceof Error ? cause.message : '这段对话暂时无法读取'
      }
    }
  }))
}

async function load() {
  const current = ++generation
  loading.value = true
  loadError.value = ''
  conversation.value = null
  segments.value = []
  nextCursor.value = null
  segmentErrors.value = {}
  try {
    const page = await workbenchApi.getAgentConversation(props.agentId)
    if (current !== generation) return
    conversation.value = page
    segments.value = page.items
    nextCursor.value = page.nextCursor
    await ensureRuns(page.items)
    if (current !== generation) return
    // 先结束加载态再定位：分段渲染出来后才能滚动到链接指向的那一段。
    loading.value = false
    if (props.focusSessionId) await focusSession(props.focusSessionId, current)
    else await scrollToBottom('auto')
  } catch (cause) {
    if (current === generation) loadError.value = cause instanceof Error ? cause.message : '对话加载失败'
  } finally {
    if (current === generation) loading.value = false
  }
}

/** 发送或重试后重取第一页：新会话与新执行出现在末尾，已展开的更早分段保留。 */
async function reloadNewest() {
  const current = generation
  const page = await workbenchApi.getAgentConversation(props.agentId)
  if (current !== generation) return
  const fresh = new Set(page.items.map(item => item.sessionId))
  const oldestFresh = page.items.at(-1)
  const older = oldestFresh
    ? segments.value.filter(item => !fresh.has(item.sessionId) && item.lastActiveAt <= oldestFresh.lastActiveAt)
    : segments.value
  conversation.value = page
  segments.value = [...page.items, ...older]
  if (!older.length) nextCursor.value = page.nextCursor
  await ensureRuns(page.items)
}

async function loadEarlier() {
  if (!nextCursor.value || loadingEarlier.value) return
  const current = generation
  const target = scroller.value
  const previousHeight = target?.scrollHeight ?? 0
  loadingEarlier.value = true
  try {
    const page = await workbenchApi.getAgentConversation(props.agentId, nextCursor.value)
    if (current !== generation) return
    const known = new Set(segments.value.map(item => item.sessionId))
    const added = page.items.filter(item => !known.has(item.sessionId))
    segments.value = [...segments.value, ...added]
    nextCursor.value = page.nextCursor
    await ensureRuns(added)
    // 保持当前阅读位置：新内容加在上方。
    await nextTick()
    if (target) target.scrollTop += target.scrollHeight - previousHeight
  } catch (cause) {
    notifyActionFailure('加载更早的对话', `与“${agent.value?.name ?? 'AI 同事'}”的对话`, cause, '稍后重试。')
  } finally {
    loadingEarlier.value = false
  }
}

async function focusSession(sessionId: string, current: number) {
  for (let page = 0; page < 10 && !segments.value.some(item => item.sessionId === sessionId) && nextCursor.value; page++) {
    await loadEarlier()
    if (current !== generation) return
  }
  await nextTick()
  const element = scroller.value?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`)
  if (element) element.scrollIntoView({ block: 'start' })
  else await scrollToBottom('auto')
}

async function scrollToBottom(behavior: 'auto' | 'smooth' = 'smooth') {
  await nextTick()
  const target = scroller.value
  if (target) target.scrollTo({ top: target.scrollHeight, behavior })
}

async function submit(payload: {
  prompt: string; files: File[]; workspaceId: string; mentions: string[]; confirm: () => void }) {
  recommendationPrefill.value = ''
  if (!canSend.value) return
  const references = referencedArtifacts.value.map(item => item.fileId)
  try {
    const sessionId = continueSessionId.value
    if (sessionId) {
      // 续写最近一段会话：与 A 的续写同一入口（POST /sessions/:id/runs）。
      const task = await taskStore.startRunWithSessionFiles(sessionId, {
        prompt: payload.prompt,
        attachments: payload.files,
        referencedFileIds: references,
      })
      taskStore.subscribe(task.id)
    } else {
      // 首次对话或 Agent 版本已变化：经既有 createSession 开启新会话，固定 AI 同事当前版本。
      await taskStore.createTask(payload.prompt, payload.files, undefined, undefined, props.agentId, references)
    }
    payload.confirm()
    referencedArtifacts.value = []
    await reloadNewest()
    await scrollToBottom()
    void conversations.refresh()
  } catch (cause) {
    notifyActionFailure('发送消息', `与“${agent.value?.name ?? 'AI 同事'}”的对话`, cause, '检查输入和附件后重试；已有对话内容不会丢失。')
  }
}

watch(() => props.agentId, () => {
  recommendationPrefill.value = takeRecommendationPrefill()
  if (recommendationPrefill.value) composerKey.value += 1
  void load()
}, { immediate: true })
watch(() => props.focusSessionId, (sessionId) => {
  if (sessionId && !loading.value) void focusSession(sessionId, generation)
})
// 最近一段的回复到达或执行结束：滚到最新，执行结束后更新列表预览。
watch(() => [latestTask.value?.messages.length, latestTask.value?.status] as const, (next, previous) => {
  if (!previous[1]) return
  void scrollToBottom()
  if (next[1] !== previous[1] && ['succeeded', 'failed', 'cancelled'].includes(next[1] ?? '')) void conversations.refresh()
})
</script>

<template>
  <div class="collab-agent-chat-layout">
    <section class="collab-agent-chat" :aria-label="agent ? `与 ${agent.name} 的对话` : '对话'">
      <header class="collab-agent-chat__header">
        <button type="button" class="collab-agent-chat__back" aria-label="返回对话列表" @click="emit('back')">
          <el-icon><ArrowLeft /></el-icon>
        </button>
        <span class="collab-agent-chat__avatar" aria-hidden="true">{{ (agent?.name ?? agentProfile?.name ?? 'A').slice(0, 1) }}</span>
        <div class="collab-agent-chat__title">
          <h1>{{ agent?.name ?? agentProfile?.name ?? 'AI 同事' }}</h1>
          <p>{{ agent?.description ?? agentProfile?.description ?? '' }}</p>
        </div>
        <el-tag v-if="agent && !agent.available" type="info" size="small" effect="plain">不可用</el-tag>
      </header>

      <div ref="scroller" class="collab-agent-chat__scroll" aria-label="聊天">
        <div class="collab-agent-chat__thread">
          <el-skeleton v-if="loading" :rows="6" animated />
          <el-alert v-else-if="loadError" type="error" :closable="false" :title="loadError">
            <el-button size="small" @click="load">重试</el-button>
          </el-alert>
          <template v-else>
            <button
              v-if="nextCursor"
              type="button"
              class="thread-earlier"
              :disabled="loadingEarlier"
              @click="loadEarlier"
            >{{ loadingEarlier ? '正在加载…' : '加载更早的对话' }}</button>

            <div v-if="!segments.length" class="collab-agent-chat__welcome">
              <strong>开始与 {{ agent?.name ?? agentProfile?.name ?? 'AI 同事' }} 对话</strong>
              <p>{{ agentProfile?.welcomeMessage || agent?.description || '在下方输入你的问题，发送后开始新的对话。' }}</p>
            </div>

            <section
              v-for="segment in displaySegments"
              :key="segment.sessionId"
              class="collab-segment"
              :data-session-id="segment.sessionId"
              :aria-label="segmentLabel(segment)"
            >
              <p class="collab-segment__divider">
                <span aria-hidden="true"></span>
                <span>{{ segmentLabel(segment) }}</span>
                <span aria-hidden="true"></span>
              </p>
              <RunMessageList
                @open-recommended-agent="openRecommendedAgent"
                v-if="segmentTask(segment)"
                :task="segmentTask(segment)!"
                :is-own="isOwn"
                :can-follow-up="canFollowUp(segment)"
                :can-retry="canRetry(segment)"
                :can-resolve-approval="canResolveApproval(segment)"
                :resolving-approval="resolvingApproval"
                :referenced-file-ids="referencedArtifacts.map(item => item.fileId)"
                :preview-key="previewKey"
                @preview="previewArtifact = $event"
                @download="download"
                @continue-editing="continueEditing"
                @copy-answer="copyAnswer"
                @copy-link="copyConversationLink(segmentLink(segment))"
                @retry="retryRun"
                @resolve-approval="(decision) => resolveApproval(segment, decision)"
              />
              <p v-else-if="segmentErrors[segment.sessionId]" class="collab-segment__empty" role="alert">
                这段对话暂时无法读取：{{ segmentErrors[segment.sessionId] }}
              </p>
              <p v-else class="collab-segment__empty">这段对话还没有消息。</p>
            </section>
          </template>
        </div>
      </div>

      <div class="collab-agent-chat__dock">
        <div class="collab-agent-chat__dock-inner">
          <RunComposer
            v-if="canSend"
            :key="`${props.agentId}-${composerKey}`"
            :initial-prompt="recommendationPrefill"
            :referenced-artifacts="referencedArtifacts"
            :running="running && canOperate"
            :stopping="stopping"
            :placeholder="`发消息给 ${agent?.name ?? 'AI 同事'}`"
            @remove-reference="removeReferencedArtifact"
            @submit="submit"
            @stop="stopRun"
          >
            <template #notices>
              <p v-if="recommendationPrefill" class="collab-agent-chat__notice" role="status" data-testid="recommendation-prefill-notice">
                已带入你在 dsh-work 助手那里的问题，确认后再发送；原对话记录与附件不会带入。
              </p>
              <p v-if="segments.length && !continueSessionId" class="collab-agent-chat__notice" data-testid="new-session-notice">
                {{ agent?.name }} 已更新版本，发送后将开始新的对话。
              </p>
            </template>
          </RunComposer>
          <p v-else-if="agent" class="collab-agent-chat__notice collab-agent-chat__notice--blocked" data-testid="agent-unavailable-notice">
            该 AI 同事当前不可用，历史对话仍可查看；如需继续，请联系管理员或选择其他 AI 同事。
          </p>
          <p class="collab-agent-chat__disclaimer">AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
        </div>
      </div>
    </section>
    <ArtifactPreviewPanel
      class="collab-agent-chat__preview"
      :artifact="previewArtifact"
      :docked="previewDocked"
      :fullscreen-max-width="820"
      @close="previewArtifact = null"
    />
  </div>
</template>

<style scoped>
.collab-agent-chat-layout {
  display: flex;
  height: 100%;
  min-height: 0;
}

.collab-agent-chat {
  display: flex;
  height: 100%;
  min-height: 0;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  background: #fff;
}

.collab-agent-chat__preview {
  width: clamp(360px, 32vw, 480px);
  flex: 0 0 auto;
}

.collab-agent-chat__header {
  display: flex;
  align-items: center;
  min-height: 64px;
  gap: 12px;
  padding: 10px 24px;
  border-bottom: 1px solid var(--dsh-color-border);
}

.collab-agent-chat__back {
  display: none;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 0;
  border-radius: var(--dsh-radius-sm);
  color: var(--dsh-color-text);
  background: transparent;
  cursor: pointer;
}

.collab-agent-chat__avatar {
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: var(--dsh-color-brand);
  font-weight: 650;
}

.collab-agent-chat__title {
  min-width: 0;
  flex: 1;
}

.collab-agent-chat__title h1 {
  margin: 0;
  overflow: hidden;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collab-agent-chat__title p {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collab-agent-chat__scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 24px;
}

.collab-agent-chat__thread {
  display: flex;
  width: min(100%, 860px);
  flex-direction: column;
  gap: 18px;
  margin: 0 auto;
}

.collab-agent-chat__welcome {
  margin: 48px auto;
  max-width: 520px;
  color: var(--dsh-color-muted);
  text-align: center;
}

.collab-agent-chat__welcome strong {
  display: block;
  margin-bottom: 8px;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
}

.collab-segment {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.collab-segment__divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.collab-segment__divider span:not([aria-hidden]) {
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collab-segment__divider span[aria-hidden] {
  height: 1px;
  flex: 1;
  background: var(--dsh-color-border);
}

.collab-segment__empty {
  margin: 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  text-align: center;
}

.collab-agent-chat__dock {
  padding: 8px 24px 12px;
  border-top: 1px solid var(--dsh-color-border);
  background: #fff;
}

.collab-agent-chat__dock-inner {
  display: flex;
  width: min(100%, 860px);
  flex-direction: column;
  gap: 8px;
  margin: 0 auto;
}

.collab-agent-chat__notice {
  margin: 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.collab-agent-chat__notice--blocked {
  padding: 12px 14px;
  border-radius: var(--dsh-radius-md);
  color: var(--dsh-color-text);
  background: var(--collab-canvas, var(--dsh-color-canvas));
}

.collab-agent-chat__disclaimer {
  margin: 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
  text-align: center;
}

@media (max-width: 820px) {
  .collab-agent-chat__header { padding: 8px 12px; }
  .collab-agent-chat__back { display: grid; }
  .collab-agent-chat__scroll { padding: 14px 12px 18px; }
  .collab-agent-chat__dock { padding: 8px 10px 10px; }
}
</style>
