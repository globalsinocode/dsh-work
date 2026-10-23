<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Close, Document } from '@element-plus/icons-vue'
import { StatusTag } from '@dsh-work/ui-core'
import { TaskComposer, describeWorkspaceActivity } from '@dsh-work/workbench-components'

import ConversationMessageItem from '@/components/conversation/ConversationMessageItem.vue'
import { workbenchApi } from '@/api/client'
import { collabSpaceRoutes } from '@/composables/space-routes'
import { useAuthStore } from '@/stores/auth'
import { useCollabConversationStore } from '@/stores/collab-conversations'
import { useTaskStore } from '@/stores/tasks'
import type { WorkspaceFile, WorkspaceTimelineItem } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
import { scheduleLabel } from '@/utils/project-task-schedule'
import '@/styles/conversation-thread.css'

/**
 * 群聊（S5d，D26～D28）：一个群组的讨论话题连续显示（段首“话题 · 时间”），任务以卡片出现，
 * 夹有执行记录与系统记录。发言规则与 A 的共享讨论一致（3.4）：不 @ 是讨论，@ Agent 才执行，
 * 只有一个可发起的 Agent 时预选它且可取消；发送续写最近一段讨论，没有讨论时开启第一段。
 * 任务卡片进入群组的任务详情，执行记录进入群组内的执行详情（与 A 同一页面）。
 */
const props = defineProps<{
  workspaceId: string
  canWrite: boolean
  archived: boolean
  /** 服务端角色已确定（名册加载完成）；之前不提示“没有 Agent”。 */
  roleKnown: boolean
  mentionOptions: Array<{ id: string; name: string }>
  hasAgentMembers: boolean
  focusSessionId?: string
  /** 文件页签“引用到对话”带来的空间文件。 */
  pendingFile: WorkspaceFile | null
}>()
const emit = defineEmits<{ 'clear-file': []; 'open-info': [] }>()

const router = useRouter()
const authStore = useAuthStore()
const taskStore = useTaskStore()
const conversations = useCollabConversationStore()

/** 已加载的时间线，新到旧（与接口一致）。 */
const items = ref<WorkspaceTimelineItem[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadError = ref('')
const loadingEarlier = ref(false)
const scroller = ref<HTMLElement>()
const expandedQuiet = ref<Set<string>>(new Set())
let generation = 0

/** 只有一个可发起的 Agent 成员时预选它（3.4）；用户可取消改为纯讨论。 */
const singleAgent = computed(() => props.mentionOptions.length === 1 ? props.mentionOptions[0] : undefined)
const preselect = ref(true)
watch(singleAgent, () => { preselect.value = true })

type DisplayItem = WorkspaceTimelineItem & { divider?: string }

/** 旧到新显示；讨论消息与执行记录换到另一段会话时插入“话题 · 时间”分隔。 */
const displayItems = computed<DisplayItem[]>(() => {
  let session: string | undefined
  return [...items.value].reverse().map(item => {
    if (item.kind !== 'message' && item.kind !== 'run') return item
    if (item.sessionId === session) return item
    session = item.sessionId
    return { ...item, divider: `${item.sessionTitle} · ${formatTime(item.at)}` }
  })
})

/** 发送续写的讨论：最近一条讨论消息或执行记录所在的会话。 */
const latestSessionId = computed(() =>
  items.value.find(item => item.kind === 'message' || item.kind === 'run')?.sessionId as string | undefined)

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function systemText(item: Extract<WorkspaceTimelineItem, { kind: 'system' }>) {
  if (item.activityKind === 'workspace_created') return `${item.actorName} 创建了群组`
  return describeWorkspaceActivity({
    kind: item.activityKind as Parameters<typeof describeWorkspaceActivity>[0]['kind'],
    actorDisplayName: item.actorName,
    safeMetadata: item.safeMetadata as Parameters<typeof describeWorkspaceActivity>[0]['safeMetadata'],
  })
}

const taskStatusLabels: Record<string, string> = { todo: '待办', in_progress: '进行中', done: '已完成' }

function taskEventLabel(item: Extract<WorkspaceTimelineItem, { kind: 'task' }>) {
  if (item.event === 'created') return `${item.actorName ?? '成员'} 创建了任务`
  if (item.event === 'completed') return `${item.actorName ?? '成员'} 标记任务完成`
  const trigger = item.run?.scheduled ? '定时执行' : '执行'
  const outcome = item.run?.status === 'succeeded' ? '完成' : item.run?.status === 'cancelled' ? '已停止' : '失败'
  return `${item.task.assigneeName} ${trigger}${outcome}`
}

function isOwnMessage(item: Extract<WorkspaceTimelineItem, { kind: 'message' }>) {
  return item.role === 'user' && item.senderId === authStore.user.id
}

function openRun(runId: string) {
  void router.push(collabSpaceRoutes.conversation(props.workspaceId, runId))
}

function openTask(item: Extract<WorkspaceTimelineItem, { kind: 'task' }>) {
  if (item.task.removed) {
    ElMessage.info('该任务已删除')
    return
  }
  void router.push(collabSpaceRoutes.task(props.workspaceId, item.task.id))
}

function toggleQuiet(id: string) {
  const next = new Set(expandedQuiet.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedQuiet.value = next
}

async function load() {
  const current = ++generation
  loading.value = true
  loadError.value = ''
  try {
    const page = await workbenchApi.getWorkspaceTimeline(props.workspaceId)
    if (current !== generation) return
    items.value = page.items
    nextCursor.value = page.nextCursor
    loading.value = false
    if (props.focusSessionId) await focusSession(props.focusSessionId, current)
    else await scrollToBottom('auto')
  } catch (cause) {
    if (current === generation) loadError.value = cause instanceof Error ? cause.message : '群聊加载失败'
  } finally {
    if (current === generation) loading.value = false
  }
}

/** 重取最新一页并与已展开的更早内容合并。 */
async function reloadNewest() {
  const current = generation
  const page = await workbenchApi.getWorkspaceTimeline(props.workspaceId)
  if (current !== generation) return
  const fresh = new Set(page.items.map(item => item.id))
  const oldestFresh = page.items.at(-1)
  const older = oldestFresh ? items.value.filter(item => !fresh.has(item.id) && item.at < oldestFresh.at) : []
  items.value = [...page.items, ...older]
  if (!older.length) nextCursor.value = page.nextCursor
}

async function loadEarlier() {
  if (!nextCursor.value || loadingEarlier.value) return
  const current = generation
  const target = scroller.value
  const previousHeight = target?.scrollHeight ?? 0
  loadingEarlier.value = true
  try {
    const page = await workbenchApi.getWorkspaceTimeline(props.workspaceId, nextCursor.value)
    if (current !== generation) return
    const known = new Set(items.value.map(item => item.id))
    items.value = [...items.value, ...page.items.filter(item => !known.has(item.id))]
    nextCursor.value = page.nextCursor
    await nextTick()
    if (target) target.scrollTop += target.scrollHeight - previousHeight
  } catch (cause) {
    notifyActionFailure('加载更早的消息', '群聊', cause, '稍后重试。')
  } finally {
    loadingEarlier.value = false
  }
}

async function focusSession(sessionId: string, current: number) {
  const present = () => items.value.some(item => (item.kind === 'message' || item.kind === 'run') && item.sessionId === sessionId)
  for (let page = 0; page < 10 && !present() && nextCursor.value; page++) {
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

async function submit(payload: { prompt: string; files: File[]; workspaceId: string; mentions: string[]; confirm: () => void }) {
  if (!props.canWrite || !props.hasAgentMembers) return
  const allowed = new Set(props.mentionOptions.map(option => option.id))
  const mentioned = payload.mentions.find(id => allowed.has(id))
  const memberId = mentioned ?? (preselect.value ? singleAgent.value?.id : undefined)
  const references = props.pendingFile ? [props.pendingFile.id] : []
  if (!memberId && (payload.files.length || references.length)) {
    ElMessage.warning('带附件或引用文件的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
    return
  }
  try {
    // 续写最近一段讨论；群组还没有讨论时开启第一段（与 A 的空间内新对话同一入口）。
    let sessionId = latestSessionId.value
    if (!sessionId) sessionId = (await workbenchApi.createSession({ title: payload.prompt, workspaceId: props.workspaceId })).id
    if (memberId) {
      const run = await taskStore.startRunWithSessionFiles(sessionId, {
        prompt: payload.prompt,
        attachments: payload.files,
        referencedFileIds: references,
        workspaceAgentMemberId: memberId,
      })
      taskStore.subscribe(run.id)
    } else {
      await taskStore.postSessionMessage(sessionId, payload.prompt)
    }
    payload.confirm()
    if (references.length) emit('clear-file')
    await reloadNewest()
    await scrollToBottom()
    void conversations.refresh()
  } catch (cause) {
    notifyActionFailure('发送消息', '群聊', cause, '检查输入、附件与所 @ 的 Agent 后重试；已有讨论内容不会丢失。')
  }
}

// 实时更新：订阅空间会话活动流（与 A 的共享讨论同一条 SSE），任一讨论或执行变化时刷新最新一页，
// 并刷新对话列表的预览与未读（打开中的群组随即由对话页标记已读，S5e）。
let refreshTimer: ReturnType<typeof setTimeout> | undefined
watch(() => taskStore.sessionActivity, () => {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    void reloadNewest().catch(() => undefined)
    void conversations.refresh()
  }, 300)
}, { deep: true })

watch(() => props.workspaceId, (workspaceId, previous) => {
  if (previous) taskStore.unsubscribeWorkspaceSessions(previous)
  taskStore.subscribeWorkspaceSessions(workspaceId, new Date().toISOString())
  void load()
}, { immediate: true })
watch(() => props.focusSessionId, (sessionId) => {
  if (sessionId && !loading.value) void focusSession(sessionId, generation)
})
onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
  taskStore.unsubscribeWorkspaceSessions(props.workspaceId)
})
</script>

<template>
  <section class="collab-group-timeline" aria-label="群聊">
    <div ref="scroller" class="collab-group-timeline__scroll">
      <div class="collab-group-timeline__thread">
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
          >{{ loadingEarlier ? '正在加载…' : '加载更早的消息' }}</button>
          <p v-if="!items.length" class="thread-empty">还没有讨论。直接发送即发表全员可见的讨论消息；@ Agent 成员则发起一次执行。</p>

          <template v-for="item in displayItems" :key="item.id">
            <p
              v-if="item.divider"
              class="collab-group-timeline__divider"
              :data-session-id="item.kind === 'message' || item.kind === 'run' ? item.sessionId : undefined"
            >
              <span aria-hidden="true"></span>
              <span>{{ item.divider }}</span>
              <span aria-hidden="true"></span>
            </p>

            <div v-if="item.kind === 'message'" class="collab-group-timeline__message">
              <ConversationMessageItem :message="{ ...item, createdAt: formatTime(item.at) }" :own="isOwnMessage(item)">
                <button
                  v-if="item.runId"
                  type="button"
                  class="collab-group-timeline__run-link"
                  @click="openRun(item.runId)"
                >查看执行详情</button>
              </ConversationMessageItem>
            </div>

            <button
              v-else-if="item.kind === 'run'"
              type="button"
              class="collab-group-timeline__record collab-group-timeline__record--run"
              data-testid="group-run-record"
              @click="openRun(item.runId)"
            >
              <StatusTag :status="item.status" dot />
              <span>
                {{ item.requesterName }} 让 {{ item.agentName ?? 'Agent' }} 执行<template v-if="item.stoppedByName"> · {{ item.stoppedByName }} 停止</template>
              </span>
              <span class="collab-group-timeline__record-time">{{ formatTime(item.at) }}</span>
            </button>

            <article
              v-else-if="item.kind === 'task'"
              class="collab-task-card"
              :class="{ 'collab-task-card--quiet': item.run?.quiet && !expandedQuiet.has(item.id) }"
              data-testid="group-task-card"
            >
              <template v-if="item.run?.quiet && !expandedQuiet.has(item.id)">
                <button type="button" class="collab-task-card__quiet" @click="toggleQuiet(item.id)">
                  {{ formatTime(item.at) }} · {{ item.task.title }} · 定时执行无变化（展开）
                </button>
              </template>
              <template v-else>
                <header class="collab-task-card__head">
                  <span class="collab-task-card__icon" aria-hidden="true"><el-icon><Document /></el-icon></span>
                  <span class="collab-task-card__event">{{ taskEventLabel(item) }}</span>
                  <span class="collab-task-card__time">{{ formatTime(item.at) }}</span>
                </header>
                <button type="button" class="collab-task-card__body" :aria-label="`打开任务：${item.task.title}`" @click="openTask(item)">
                  <strong>{{ item.task.title }}</strong>
                  <span class="collab-task-card__meta">
                    <el-tag size="small" effect="plain" :type="item.task.status === 'done' ? 'success' : item.task.status === 'in_progress' ? 'primary' : 'info'">
                      {{ item.task.removed ? '已删除' : taskStatusLabels[item.task.status] }}
                    </el-tag>
                    <span>负责人 · {{ item.task.assigneeName }}</span>
                    <span v-if="item.task.assigneeType === 'agent'">执行规则 · {{ scheduleLabel(item.task.schedule) }}</span>
                  </span>
                  <span v-if="item.run?.summary" class="collab-task-card__summary">{{ item.run.summary }}</span>
                  <span v-else-if="item.note" class="collab-task-card__summary">完成说明：{{ item.note }}</span>
                </button>
              </template>
            </article>

            <p v-else class="collab-group-timeline__record collab-group-timeline__record--system" data-testid="group-system-record">
              <span aria-hidden="true"></span>
              <span>{{ formatTime(item.at) }} · {{ systemText(item) }}</span>
              <span aria-hidden="true"></span>
            </p>
          </template>
        </template>
      </div>
    </div>

    <div class="collab-group-timeline__dock">
      <div class="collab-group-timeline__dock-inner">
        <template v-if="canWrite && hasAgentMembers">
          <div v-if="pendingFile" class="referenced-artifacts" data-testid="group-referenced-file">
            <span>引用文件</span>
            <el-tag closable effect="plain" @close="emit('clear-file')">{{ pendingFile.name }}</el-tag>
          </div>
          <p v-if="singleAgent" class="collab-group-timeline__preset">
            <template v-if="preselect">
              发送后交给 @{{ singleAgent.name }} 执行
              <button type="button" class="collab-group-timeline__preset-toggle" @click="preselect = false">
                <el-icon><Close /></el-icon>改为讨论
              </button>
            </template>
            <template v-else>
              不 @ Agent 的消息只是讨论，不会触发执行
              <button type="button" class="collab-group-timeline__preset-toggle" @click="preselect = true">交给 @{{ singleAgent.name }}</button>
            </template>
          </p>
          <p v-else class="collab-group-timeline__preset">群聊中 @ Agent 才会执行，其他消息只是成员间讨论。</p>
          <TaskComposer
            compact
            :mention-options="mentionOptions"
            :files-require-mention="!(preselect && singleAgent)"
            placeholder="发消息，@ Agent 让它执行"
            @submit="submit"
          />
        </template>
        <p v-else-if="archived" class="collab-group-timeline__notice" data-testid="group-archived-notice">
          该群组已归档，仅保留有权限的只读查看与下载；无法发言或发起执行。
        </p>
        <p v-else-if="roleKnown && !canWrite" class="collab-group-timeline__notice" data-testid="group-readonly-notice">
          当前角色为只读成员，仅可查看讨论内容。
        </p>
        <p v-else-if="roleKnown && !hasAgentMembers" class="collab-group-timeline__notice" data-testid="group-no-agent-notice">
          该群组还没有 Agent 成员，请先添加 Agent 再发消息。
          <el-button link type="primary" @click="emit('open-info')">打开群信息</el-button>
        </p>
        <p class="collab-group-timeline__disclaimer">AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.collab-group-timeline {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.collab-group-timeline__scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px 24px;
}

.collab-group-timeline__thread {
  display: flex;
  width: min(100%, 860px);
  flex-direction: column;
  gap: 14px;
  margin: 0 auto;
}

.collab-group-timeline__divider,
.collab-group-timeline__record--system {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 6px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.collab-group-timeline__divider span[aria-hidden],
.collab-group-timeline__record--system span[aria-hidden] {
  height: 1px;
  flex: 1;
  background: var(--dsh-color-border);
}

.collab-group-timeline__run-link {
  margin-top: 8px;
  padding: 0;
  border: 0;
  color: var(--el-color-primary);
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
}

.collab-group-timeline__record--run {
  display: flex;
  align-items: center;
  gap: 10px;
  align-self: flex-start;
  padding: 6px 12px;
  border: 1px solid var(--dsh-color-border);
  border-radius: 999px;
  color: var(--dsh-color-text);
  background: var(--dsh-color-canvas);
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
}

.collab-group-timeline__record-time { color: var(--dsh-color-muted); }

.collab-task-card {
  align-self: stretch;
  max-width: 640px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-lg);
  background: #fff;
}

.collab-task-card--quiet { border-style: dashed; }

.collab-task-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.collab-task-card__icon { display: inline-flex; color: var(--el-color-primary); }
.collab-task-card__event { flex: 1; }

.collab-task-card__body {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 6px;
  padding: 8px 14px 12px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.collab-task-card__body strong { color: var(--dsh-color-ink); }

.collab-task-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.collab-task-card__summary {
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.collab-task-card__quiet {
  width: 100%;
  padding: 8px 14px;
  border: 0;
  color: var(--dsh-color-muted);
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
  text-align: left;
}

.collab-group-timeline__dock {
  padding: 8px 24px 12px;
  border-top: 1px solid var(--dsh-color-border);
  background: #fff;
}

.collab-group-timeline__dock-inner {
  display: flex;
  width: min(100%, 860px);
  flex-direction: column;
  gap: 8px;
  margin: 0 auto;
}

.collab-group-timeline__preset,
.collab-group-timeline__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.collab-group-timeline__notice {
  padding: 12px 14px;
  border-radius: var(--dsh-radius-md);
  color: var(--dsh-color-text);
  background: var(--dsh-color-canvas);
}

.collab-group-timeline__preset-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  color: var(--el-color-primary);
  background: transparent;
  cursor: pointer;
}

.collab-group-timeline__disclaimer {
  margin: 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
  text-align: center;
}

.collab-group-timeline button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

@media (max-width: 820px) {
  .collab-group-timeline__scroll { padding: 12px; }
  .collab-group-timeline__dock { padding: 8px 10px 10px; }
}
</style>
