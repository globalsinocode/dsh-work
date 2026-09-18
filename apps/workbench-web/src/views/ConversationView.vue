<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowDown,
  ArrowLeft,
  Close,
  CopyDocument,
  DataLine,
  Document,
  Lock,
  RefreshRight,
  Share,
} from '@element-plus/icons-vue'

import { AssistantMessageContent, RunTimeline, StatusTag } from '@dsh-work/ui-core'
import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useTaskStore } from '@/stores/tasks'
import type { Artifact, ChatMessage, SessionThread, TaskSource, TeamMemberRole, WorkspaceAgentMember } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'

const route = useRoute()
const router = useRouter()
const taskStore = useTaskStore()
const authStore = useAuthStore()

const detailsOpen = ref(false)
const conversationScroll = ref<HTMLElement>()
const showJumpToLatest = ref(false)
const stopping = ref(false)

/**
 * TW-10 会话模式：路由 id 不是任何 Run 时，按 Session 直接加载共享线程；
 * 线程中的执行记录以状态入口内联展示，点击进入对应 Run 详情。
 */
const sessionThread = ref<SessionThread | null>(null)
const threadMissing = ref(false)
/** Run/Session 目标解析在途标记：避免加载间隙闪现「未找到对话」。 */
const targetLoading = ref(false)

/**
 * TW-10 空间内嵌套：作为 /workspaces/:id/conversations/:conversationId 子路由
 * 渲染时 params.id 是空间 id、目标在 conversationId；独立 /conversations/:id
 * 路径仍按原样解析。团队会话的外部链接加载后归位到空间 URL
 * （reconcileConversationRoute），保证团队对话始终停留在空间上下文。
 */
const isEmbeddedInWorkspace = computed(() => route.name === 'workspace-conversation')
const embeddedWorkspaceId = computed(() =>
  isEmbeddedInWorkspace.value ? String(route.params.id) : '')
const routeTargetId = computed(() =>
  isEmbeddedInWorkspace.value ? String(route.params.conversationId) : String(route.params.id))

function conversationPath(target: string) {
  return isEmbeddedInWorkspace.value
    ? `/workspaces/${embeddedWorkspaceId.value}/conversations/${target}`
    : `/conversations/${target}`
}

const task = computed(() => taskStore.getTask(routeTargetId.value))
/**
 * 归档只读态（design §2.7 / 3-T1 执行轨）：运行所属团队空间归档后，续写（发送消息）
 * 与重试入口隐藏；内容、来源与成果下载保持可读。个人空间不会命中（AC-23）。
 */
const workspaceArchived = computed(() =>
  task.value?.workspaceType === 'team' && task.value.workspaceStatus === 'archived')
/** 会话模式的归档判断与 Run 视图同一口径：均以服务端返回的空间状态为准。 */
const sessionArchived = computed(() =>
  sessionThread.value?.workspaceType === 'team' && sessionThread.value.workspaceStatus === 'archived')
/** TW-10：团队会话的消息流是全空间共享讨论，发送与归因按成员区分。 */
const isTeamSession = computed(() =>
  task.value?.workspaceType === 'team' || sessionThread.value?.workspaceType === 'team')
/** 个人会话的写轨仍是创建者-only；团队共享会话的写轨见 canOperateRun。 */
const isRequester = computed(() => Boolean(task.value && task.value.requestedBy === authStore.user.id))
/**
 * TW-10：Run 视图的写权限。只读成员可读共享 Run 详情但不得发言/触发/停止/重试；
 * `currentUserRole` 由服务端随 Run 详情返回。团队 Run 字段缺失（旧数据/异常）
 * 时按只读处理（fail-closed），服务端写轨仍是最终裁决；个人 Run 无角色字段，不拦截。
 */
const TEAM_WRITE_ROLES: ReadonlySet<TeamMemberRole> = new Set(['owner', 'admin', 'member'])
function canWriteTeamRole(role: TeamMemberRole | null | undefined) {
  return role !== null && role !== undefined && TEAM_WRITE_ROLES.has(role)
}
const isRunViewer = computed(() =>
  task.value?.workspaceType === 'team' && !canWriteTeamRole(task.value.currentUserRole))
/**
 * 停止/重试写轨与服务端 requireWritableRun 一致（TW-10）：团队共享会话内
 * 任一可写成员（owner/admin/member）都可操作他人发起的 Run——卡住或误发
 * 的执行不能只靠发起人收敛；个人会话仍是创建者-only（isRequester），
 * 归档空间写轨整体关闭。
 */
const canOperateRun = computed(() => Boolean(
  task.value && !workspaceArchived.value && !isRunViewer.value
  && (task.value.workspaceType === 'team' || isRequester.value),
))
const canStop = computed(() => Boolean(
  task.value && canOperateRun.value
  && ['queued', 'running', 'awaiting_approval'].includes(task.value.status),
))
const canRetry = computed(() => Boolean(
  task.value && canOperateRun.value
  && ['failed', 'cancelled'].includes(task.value.status)
  && (task.value.error?.retryable ?? true)))
const canFollowUp = computed(() => !workspaceArchived.value && !isRunViewer.value)
/**
 * 会话模式写权限：团队会话要求非只读成员（服务端 currentUserRole，读轨，
 * 归档空间仍返回角色但由 sessionArchived 拦截）；个人会话仅创建者可写。
 * 角色为 null 且属团队会话时宁可漏开不可误开。
 */
const canWriteSession = computed(() => {
  const thread = sessionThread.value
  if (!thread || sessionArchived.value) return false
  if (thread.workspaceType === 'team') return canWriteTeamRole(thread.currentUserRole)
  return thread.createdBy === authStore.user.id
})
/** 只读成员查看共享会话时的提示（归档优先）。 */
const sessionReadOnly = computed(() =>
  Boolean(sessionThread.value) && !sessionArchived.value && !canWriteSession.value)

/**
 * 对话列表左右分栏（TW-10）：本人发送的 user 消息在右侧，其他成员与
 * Agent 消息在左侧，统一使用 Agent 回复的「身份行 + 卡片」样式。
 * 个人会话/个人 Run 的 user 消息即本人；团队线程恒带 senderId，
 * 团队 Run 缺归因时退回请求人口径。
 */
function isOwnMessage(message: { role: string; senderId?: string | null }) {
  if (message.role !== 'user') return false
  if (message.senderId) return message.senderId === authStore.user.id
  if (!isTeamSession.value) return true
  return task.value?.requestedBy === authStore.user.id
}

/** 当前空间可 @ 的 Agent 成员（仅团队会话加载；只读成员的名册可读但无发起权）。 */
const agentMembers = ref<WorkspaceAgentMember[]>([])
const mentionOptions = computed(() =>
  agentMembers.value
    .filter(member => member.status === 'available' && member.allowedActions.includes('start_conversation'))
    .map(member => ({ id: member.id, name: member.name })),
)

async function loadAgentMembers(workspaceId: string | undefined) {
  if (!workspaceId || !isTeamSession.value) {
    agentMembers.value = []
    return
  }
  try {
    agentMembers.value = await workbenchApi.listWorkspaceAgentMembers(workspaceId)
  } catch {
    agentMembers.value = []
  }
}
const currentStep = computed(() =>
  task.value?.steps.find((step) => ['running', 'awaiting_approval'].includes(step.status)),
)
const lastAssistantMessageId = computed(() =>
  [...(task.value?.messages ?? [])]
    .reverse()
    .find(message => message.role === 'assistant' && message.runId === task.value?.id)?.id,
)
function belongsToCurrentRun(message: ChatMessage) {
  return message.runId === task.value?.id
}

const sourceTypeLabels: Record<TaskSource['type'], string> = {
  knowledge: '企业知识',
  erp: '业务系统',
  mes: '生产系统',
  file: '上传文件',
}

function goBack() {
  // 嵌入态的返回固定归位到所属空间页（线程返回控件回到列表）：外部旧链接
  // 经 replace 归位后，router.back() 会跳出空间上下文，不能依赖历史栈。
  if (isEmbeddedInWorkspace.value) {
    void router.push(`/workspaces/${embeddedWorkspaceId.value}`)
    return
  }
  if (window.history.length > 1) router.back()
  else void router.push('/workbench')
}

function scrollToBottom(behavior: 'auto' | 'smooth' = 'smooth') {
  const target = conversationScroll.value
  if (!target) return
  target.scrollTo({ top: target.scrollHeight, behavior })
  showJumpToLatest.value = false
}

function onConversationScroll() {
  const target = conversationScroll.value
  if (!target) return
  showJumpToLatest.value = target.scrollHeight - target.scrollTop - target.clientHeight > 180
}

async function stopCurrentRun() {
  if (!task.value || stopping.value || !canOperateRun.value) return
  try {
    await ElMessageBox.confirm(
      '停止后会终止本轮运行尝试，已有对话和执行记录仍会保留。',
      '停止本轮执行？',
      {
        confirmButtonText: '停止本轮执行',
        cancelButtonText: '继续等待',
        type: 'warning',
      },
    )
    stopping.value = true
    await taskStore.cancelTask(task.value.id)
    ElMessage.success('本轮执行已停止，对话记录已保留')
  } catch {
    // User cancelled the confirmation.
  } finally {
    stopping.value = false
  }
}

async function retryRun() {
  if (!task.value || !canOperateRun.value) return
  try {
    await taskStore.retryTask(task.value.id)
    ElMessage.success('已创建新的运行尝试')
  } catch (error) {
    notifyActionFailure('重新执行', `运行 ${task.value.id}`, error, '刷新对话状态；确认本轮仍为失败或已停止后再重试。')
  }
}

function copyAnswer(content: string) {
  void navigator.clipboard.writeText(content)
  ElMessage.success('回答已复制')
}

function copyConversationLink() {
  void navigator.clipboard.writeText(window.location.href)
  ElMessage.success('对话链接已复制')
}

function download(item: Artifact) {
  void downloadArtifactFile(item)
}

function openSessionRun(runId: string) {
  void router.push(conversationPath(runId))
}

function formatSessionRunTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

async function submitFollowUp(payload: { prompt: string; files: File[]; workspaceId: string; mentions: string[]; confirm?: () => void }) {
  // TW-10 防线：viewer/角色未知不允许发言或触发执行，不能只靠模板不渲染
  // composer——函数本身也要 fail-closed。服务端写轨仍是最终裁决。
  if (!task.value || workspaceArchived.value || isRunViewer.value) return
  try {
    const mentionedMemberId = isTeamSession.value ? payload.mentions?.[0] : undefined
    if (isTeamSession.value && !mentionedMemberId) {
      // TW-10：团队共享会话里不 @ 的消息是全员可见的讨论，不产生执行。
      if (payload.files.length) {
        ElMessage.warning('带附件的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
        return
      }
      await taskStore.postSessionMessage(task.value.sessionId, payload.prompt)
      payload.confirm?.()
      try {
        await taskStore.refreshRun(task.value.id)
        ElMessage.success('讨论消息已发送，如需 Agent 处理请 @ 对应成员')
      } catch {
        ElMessage.warning('讨论消息已发送，但对话状态刷新失败，请稍后手动刷新。')
      }
    } else {
      const nextTask = await taskStore.sendMessage(task.value.id, payload.prompt, payload.files, mentionedMemberId)
      if (nextTask) await router.replace(conversationPath(nextTask.id))
      payload.confirm?.()
    }
    await nextTick(() => scrollToBottom())
  } catch (error) {
    notifyActionFailure('发送消息', `对话“${task.value.title}”`, error, '检查输入和附件后重试；已有对话内容不会丢失。')
  }
}

/** 会话模式：@ 触发新的 Run 并跳到 Run 详情；普通消息留在共享讨论线程。 */
async function submitSessionMessage(payload: { prompt: string; files: File[]; workspaceId: string; mentions: string[]; confirm?: () => void }) {
  const thread = sessionThread.value
  if (!thread || !canWriteSession.value) return
  try {
    const mentionedMemberId = isTeamSession.value ? payload.mentions?.[0] : undefined
    // 团队会话 @ 成员，或个人会话（沿用会话绑定 Agent）：发起 Run。
    if (mentionedMemberId || !isTeamSession.value) {
      const createdRun = await taskStore.startRunWithSessionFiles(thread.sessionId, {
        prompt: payload.prompt,
        attachments: payload.files,
        workspaceAgentMemberId: mentionedMemberId,
      })
      taskStore.subscribe(createdRun.id)
      await router.replace(conversationPath(createdRun.id))
      payload.confirm?.()
      return
    }
    if (payload.files.length) {
      ElMessage.warning('带附件的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
      return
    }
    await taskStore.postSessionMessage(thread.sessionId, payload.prompt)
    payload.confirm?.()
    try {
      sessionThread.value = await taskStore.loadSessionThread(thread.sessionId)
      await nextTick(() => scrollToBottom())
    } catch {
      ElMessage.warning('讨论消息已发送，但会话刷新失败，请稍后手动刷新。')
    }
  } catch (error) {
    notifyActionFailure('发送消息', `对话“${thread.title}”`, error, '检查输入后重试；已有讨论内容不会丢失。')
  }
}

async function initializeConversation() {
  await taskStore.load()
  const thread = await loadConversationTarget(routeTargetId.value)
  await reconcileConversationRoute()
  await loadAgentMembers(task.value?.workspaceId ?? thread?.workspaceId)
  await nextTick()
  scrollToBottom('auto')
}

/**
 * TW-10 路由归位：
 * - 空间外旧链接（/conversations/:id）解析到团队空间后跳转到
 *   /workspaces/:wid/conversations/:target，团队对话始终停留在空间上下文；
 * - 空间内嵌套时校验归属：目标实际属于其它空间（手改 URL/陈旧链接）则
 *   归位到其真实空间，避免「A 空间外壳渲染 B 会话」的错壳与错链；
 * - 个人空间会话不做跳转。
 */
async function reconcileConversationRoute() {
  const workspaceId = task.value?.workspaceId ?? sessionThread.value?.workspaceId
  if (isEmbeddedInWorkspace.value) {
    if (workspaceId && workspaceId !== embeddedWorkspaceId.value) {
      await router.replace(`/workspaces/${workspaceId}/conversations/${routeTargetId.value}`)
    }
    return
  }
  const workspaceType = task.value?.workspaceType ?? sessionThread.value?.workspaceType
  if (workspaceType !== 'team' || !workspaceId) return
  await router.replace(`/workspaces/${workspaceId}/conversations/${routeTargetId.value}`)
}

/**
 * Run ID 可直接定位共享 Run；不是 Run 时才退回 Session 线程视图。
 * 总是先刷新 Run 详情：列表缓存没有 currentUserRole/最新归因（TW-10），
 * 直接用缓存会把可写成员误判成只读；详情失败才退回列表数据保底。
 */
async function loadConversationTarget(id: string): Promise<SessionThread | null> {
  targetLoading.value = true
  try {
    const run = await taskStore.refreshRun(id).catch(() => null) ?? taskStore.getTask(id) ?? null
    return run ? null : await loadSessionMode(id)
  } finally {
    targetLoading.value = false
  }
}

async function loadSessionMode(id: string): Promise<SessionThread | null> {
  try {
    const thread = await taskStore.loadSessionThread(id)
    sessionThread.value = thread
    return thread
  } catch {
    threadMissing.value = true
    return null
  }
}

onMounted(initializeConversation)

watch(
  () => routeTargetId.value,
  async id => {
    sessionThread.value = null
    threadMissing.value = false
    const thread = await loadConversationTarget(String(id))
    await reconcileConversationRoute()
    await loadAgentMembers(task.value?.workspaceId ?? thread?.workspaceId)
  },
)

watch(
  [() => routeTargetId.value, () => task.value?.messages.length, () => task.value?.status, () => sessionThread.value?.messages.length],
  async () => {
    await nextTick()
    if (!showJumpToLatest.value) scrollToBottom('smooth')
  },
)
</script>

<template>
  <div class="conversation-page" :class="{ 'conversation-page--embedded': isEmbeddedInWorkspace }">
    <div v-if="(taskStore.loading || targetLoading) && !task && !sessionThread && !threadMissing" class="conversation-state">
      <el-skeleton :rows="8" animated />
    </div>

    <template v-else-if="!task && sessionThread">
      <header class="conversation-header">
        <div class="conversation-header__left">
          <button type="button" class="conversation-header__back" aria-label="返回" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <h1>{{ sessionThread.title }}</h1>
          <span class="conversation-skill"><span>发起人</span>{{ sessionThread.creatorName }}</span>
        </div>
      </header>

      <main
        ref="conversationScroll"
        class="conversation-scroll"
        aria-label="对话内容"
        @scroll.passive="onConversationScroll"
      >
        <div class="conversation-thread">
          <p v-if="!sessionThread.messages.length" class="thread-empty">
            还没有讨论内容。直接发送即发表全员可见的讨论消息；@ Agent 成员则发起一次执行。
          </p>
          <article
            v-for="message in sessionThread.messages"
            :key="message.id"
            class="conversation-message"
            :class="[`conversation-message--${message.role}`, { 'conversation-message--own': isOwnMessage(message) }]"
          >
            <template v-if="message.role === 'user'">
              <div class="assistant-identity">
                <span class="assistant-avatar assistant-avatar--user">{{ (message.senderName ?? '我').slice(0, 1) }}</span>
                <div>
                  <strong>{{ message.senderName ?? '我' }}</strong>
                  <span>{{ message.createdAt }}</span>
                </div>
              </div>
              <div class="assistant-answer user-message">
                <p>{{ message.content }}</p>
              </div>
            </template>
            <template v-else>
              <div class="assistant-identity">
                <span class="assistant-avatar">{{ (message.agentName ?? 'dsh-work').slice(0, 1) }}</span>
                <div>
                  <strong>{{ message.agentName ?? 'dsh-work' }}</strong>
                  <span>
                    {{ message.createdAt }}
                    <template v-if="message.runRequesterName"> · 由 {{ message.runRequesterName }} 发起</template>
                  </span>
                </div>
              </div>
              <div class="assistant-answer">
                <AssistantMessageContent :text="message.content" />
              </div>
            </template>
          </article>
          <section
            v-if="sessionThread.runs.length"
            class="session-run-list"
            aria-label="本讨论的执行记录"
          >
            <button
              v-for="run in sessionThread.runs"
              :key="run.runId"
              type="button"
              class="session-run"
              data-testid="session-run"
              @click="openSessionRun(run.runId)"
            >
              <StatusTag :status="run.status" dot />
              <span class="session-run__requester">{{ run.requesterName }} 发起</span>
              <time>{{ formatSessionRunTime(run.createdAt) }}</time>
            </button>
          </section>
          <div class="conversation-end" aria-hidden="true"></div>
        </div>
      </main>

      <div class="conversation-composer-dock">
        <div class="conversation-composer-dock__inner">
          <TaskComposer
            v-if="canWriteSession"
            compact
            :mention-options="isTeamSession ? mentionOptions : []"
            :files-require-mention="isTeamSession"
            @submit="submitSessionMessage"
          />
          <p v-else-if="sessionArchived" data-testid="conversation-archived-notice" class="conversation-archived-notice">
            该空间已归档，仅保留有权限的只读查看与下载；无法发言或发起执行。
          </p>
          <p v-else-if="sessionReadOnly" data-testid="conversation-readonly-notice" class="conversation-archived-notice">
            当前角色为只读成员，仅可查看讨论内容。
          </p>
          <p>AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
        </div>
      </div>
    </template>

    <el-result
      v-else-if="!task"
      class="conversation-state"
      icon="warning"
      title="未找到对话"
      sub-title="该对话可能已从历史中移除，或当前账号无权访问。文件和成果按保留策略独立管理。"
    >
      <template #extra>
        <el-button
          type="primary"
          @click="isEmbeddedInWorkspace ? router.push(`/workspaces/${embeddedWorkspaceId}`) : router.push('/workbench')"
        >
          {{ isEmbeddedInWorkspace ? '返回工作空间' : '返回工作台' }}
        </el-button>
      </template>
    </el-result>

    <template v-else>
      <header class="conversation-header">
        <div class="conversation-header__left">
          <button type="button" class="conversation-header__back" aria-label="返回" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <h1>{{ task.title }}</h1>
          <span v-if="task.skill" class="conversation-skill">
            <span>Skill</span>{{ task.skill.name }} · v{{ task.skill.version }}
          </span>
        </div>
        <div class="conversation-header__actions">
          <StatusTag :status="task.status" dot />
          <el-button text :icon="DataLine" @click="detailsOpen = true">
            <span class="header-action-label">对话详情</span>
          </el-button>
          <el-button
            v-if="canRetry"
            text
            :icon="RefreshRight"
            aria-label="重新执行本轮"
            @click="retryRun"
          />
        </div>
      </header>

      <main
        ref="conversationScroll"
        class="conversation-scroll"
        aria-label="对话内容"
        @scroll.passive="onConversationScroll"
      >
        <div class="conversation-thread">
          <article
            v-for="message in task.messages"
            :key="message.id"
            class="conversation-message"
            :class="[`conversation-message--${message.role}`, { 'conversation-message--own': isOwnMessage(message) }]"
          >
            <template v-if="message.role === 'user'">
              <div class="assistant-identity">
                <span class="assistant-avatar assistant-avatar--user">{{ (message.senderName ?? '我').slice(0, 1) }}</span>
                <div>
                  <strong>{{ message.senderName ?? '我' }}</strong>
                  <span>{{ message.createdAt }}</span>
                </div>
              </div>
              <div class="assistant-answer user-message">
                <p>{{ message.content }}</p>
              </div>
            </template>

            <template v-else>
              <div class="assistant-identity">
                <span class="assistant-avatar">{{ (message.agentName ?? 'dsh-work').slice(0, 1) }}</span>
                <div>
                  <strong>{{ message.agentName ?? 'dsh-work' }}</strong>
                  <span v-if="message.id === lastAssistantMessageId && belongsToCurrentRun(message) && task.status === 'succeeded'">
                    已完成{{ task.duration ? ` · ${task.duration}` : '' }}
                  </span>
                  <span v-else>
                    {{ message.createdAt }}
                    <template v-if="message.runRequesterName"> · 由 {{ message.runRequesterName }} 发起</template>
                  </span>
                </div>
              </div>

              <div class="assistant-answer">
                <AssistantMessageContent :text="message.content" />

                <div
                  v-if="message.id === lastAssistantMessageId && belongsToCurrentRun(message) && task.artifacts.length"
                  class="answer-artifacts"
                >
                  <button
                    v-for="artifact in task.artifacts"
                    :key="artifact.id"
                    type="button"
                    @click="download(artifact)"
                  >
                    <span><el-icon><Document /></el-icon></span>
                    <span>
                      <strong>{{ artifact.name }}</strong>
                      <small>{{ artifact.size }} · V{{ artifact.version }}</small>
                    </span>
                    <el-icon><ArrowDown /></el-icon>
                  </button>
                </div>

                <div class="assistant-actions">
                  <button type="button" aria-label="复制回答" @click="copyAnswer(message.content)">
                    <el-icon><CopyDocument /></el-icon>
                  </button>
                  <button
                    type="button"
                    aria-label="复制对话链接"
                    @click="copyConversationLink"
                  >
                    <el-icon><Share /></el-icon>
                  </button>
                  <span v-if="belongsToCurrentRun(message)" class="assistant-run-meta">
                    {{ task.tokenUsage ? `${task.tokenUsage.toLocaleString()} Token` : '自动' }}
                    · {{ task.agentVersion.split('@')[0] }}
                  </span>
                </div>
              </div>
            </template>
          </article>

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
              <span>{{ currentStep?.title ?? '正在准备回答' }}</span>
              <button type="button" @click="detailsOpen = true">查看执行过程</button>
            </div>
          </article>

          <section v-if="task.status === 'awaiting_approval'" class="conversation-notice approval-notice">
            <span class="conversation-notice__icon"><el-icon><Lock /></el-icon></span>
            <div>
              <strong>正在确认本轮工具权限</strong>
              <p>{{ task.approval?.reason ?? '服务端正在校验本轮工具、角色和数据范围。' }}</p>
              <dl>
                <div><dt>对象</dt><dd class="mono">{{ task.approval?.object ?? '受控工具' }}</dd></div>
                <div><dt>范围</dt><dd>{{ task.approval?.dataScope ?? '当前用户授权范围' }}</dd></div>
              </dl>
              <p>{{ task.approval?.nextStep ?? '确认结果会自动更新，无需重复提交。' }}</p>
            </div>
            <StatusTag status="awaiting_approval" label="自动确认中" />
          </section>

          <section v-if="task.error" class="conversation-notice error-notice">
            <span class="conversation-notice__icon"><el-icon><Close /></el-icon></span>
            <div>
              <strong>{{ task.error.message }}</strong>
              <dl>
                <div><dt>对象</dt><dd>{{ task.error.object }}</dd></div>
                <div><dt>原因</dt><dd>{{ task.error.reason }}</dd></div>
              </dl>
              <p><strong>下一步：</strong>{{ task.error.suggestion }}</p>
              <code>{{ task.error.code }}</code>
            </div>
            <el-button
              v-if="canRetry"
              type="primary"
              plain
              :icon="RefreshRight"
              @click="retryRun"
            >
              重新执行本轮
            </el-button>
          </section>

          <div class="conversation-end" aria-hidden="true"></div>
        </div>
      </main>

      <div class="conversation-composer-dock">
        <button
          v-if="showJumpToLatest"
          class="jump-latest"
          type="button"
          @click="scrollToBottom()"
        >
          回到最新消息
          <el-icon><ArrowDown /></el-icon>
        </button>
        <div class="conversation-composer-dock__inner">
          <TaskComposer
            v-if="canFollowUp"
            compact
            :running="canStop"
            :stopping="stopping"
            :mention-options="isTeamSession ? mentionOptions : []"
            :files-require-mention="isTeamSession"
            @submit="submitFollowUp"
            @stop="stopCurrentRun"
          />
          <p v-else-if="workspaceArchived" data-testid="conversation-archived-notice" class="conversation-archived-notice">
            该空间已归档，仅保留有权限的只读查看与下载；无法续写或重试。
          </p>
          <p v-else-if="isRunViewer" data-testid="conversation-readonly-notice" class="conversation-archived-notice">
            当前角色为只读成员，仅可查看讨论内容。
          </p>
          <p>AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
        </div>
      </div>

      <el-drawer
        v-model="detailsOpen"
        class="conversation-drawer"
        title="对话详情"
        size="420px"
      >
        <section class="drawer-section">
          <h2>当前执行</h2>
          <dl class="run-facts">
            <div><dt>工作空间</dt><dd>{{ task.workspaceName }}</dd></div>
            <div><dt>会话</dt><dd class="mono">{{ task.sessionId }}</dd></div>
            <div><dt>运行</dt><dd class="mono">{{ task.id }}</dd></div>
            <div><dt>Agent</dt><dd class="mono">{{ task.agentVersion }}</dd></div>
          </dl>
        </section>

        <section class="drawer-section">
          <h2>本轮执行步骤</h2>
          <RunTimeline :steps="task.steps" />
        </section>

        <section class="drawer-section">
          <h2>数据来源</h2>
          <div v-if="task.sources.length" class="source-list">
            <article v-for="source in task.sources" :key="source.id">
              <span>{{ sourceTypeLabels[source.type] }}</span>
              <strong>{{ source.title }}</strong>
              <small v-if="source.version || source.effectiveAt">
                <template v-if="source.version">v{{ source.version }}</template>
                <template v-if="source.effectiveAt"> · {{ source.effectiveAt }} 生效</template>
                <template v-if="source.dataScope"> · {{ source.dataScope }}</template>
                <template v-if="source.synthetic"> · 合成测试数据</template>
              </small>
              <p>{{ source.description }}</p>
            </article>
          </div>
          <el-empty v-else :image-size="56" description="本轮暂未产生来源记录" />
        </section>

        <section class="drawer-section">
          <h2>成果文件</h2>
          <div v-if="task.artifacts.length" class="drawer-artifacts">
            <button
              v-for="artifact in task.artifacts"
              :key="artifact.id"
              type="button"
              @click="download(artifact)"
            >
              <el-icon><Document /></el-icon>
              <span><strong>{{ artifact.name }}</strong><small>{{ artifact.size }}</small></span>
            </button>
          </div>
          <el-empty v-else :image-size="56" description="本轮暂未生成成果" />
        </section>
      </el-drawer>

    </template>
  </div>
</template>

<style scoped>
.conversation-page {
  position: relative;
  height: 100vh;
  overflow: hidden;
  color: #242624;
  background: #fff;
}

.conversation-state {
  max-width: 860px;
  margin: 0 auto;
  padding: 120px 28px;
}

.conversation-header {
  position: absolute;
  z-index: 12;
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  gap: 18px;
  padding: 0 22px;
  border-bottom: 1px solid rgb(234 235 232 / 75%);
  background: rgb(255 255 255 / 90%);
  backdrop-filter: blur(12px);
}

.conversation-header__left,
.conversation-header__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.conversation-header__left h1 {
  margin: 0;
  overflow: hidden;
  color: #242624;
  font-size: var(--dsh-font-size-body);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-skill {
  display: inline-flex;
  max-width: 260px;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  padding: 4px 8px;
  border: 1px solid #c9e6d9;
  border-radius: 999px;
  color: #23644f;
  background: #f0faf5;
  font-size: var(--dsh-font-size-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-skill span { color: #6d9586; }

.conversation-header__back {
  display: grid;
  width: 31px;
  height: 31px;
  flex: 0 0 auto;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: #686d68;
  background: transparent;
  cursor: pointer;
}

.conversation-header__back:hover {
  color: #222422;
  background: #f1f2f0;
}

.conversation-header__actions {
  flex: 0 0 auto;
}

.conversation-scroll {
  height: 100vh;
  padding: 94px 28px 226px;
  overflow-y: auto;
  scroll-behavior: smooth;
  scrollbar-gutter: stable;
}

.conversation-thread {
  width: min(100%, 920px);
  min-height: calc(100vh - 330px);
  margin: 0 auto;
}

/* TW-10 空间内嵌套：高度收敛到空间页对话面板，不再占满视口。 */
.conversation-page--embedded {
  height: 100%;
}

.conversation-page--embedded .conversation-scroll {
  height: 100%;
}

.conversation-page--embedded .conversation-thread {
  min-height: calc(100% - 330px);
}

.conversation-message {
  width: 100%;
}

.conversation-message + .conversation-message {
  margin-top: 30px;
}

/*
 * 人员消息与 Agent 回复共用「身份行 + 卡片」样式；本人消息镜像到右侧
 * （头像在右、卡片右对齐缩进），其他成员/Agent 保持在左。
 */
.assistant-avatar--user {
  background: #6b736d;
}

.user-message {
  padding-bottom: 16px;
}

.user-message p {
  margin: 0;
  font-size: var(--dsh-font-size-body);
  line-height: 1.65;
  white-space: pre-wrap;
}

.conversation-message--own .assistant-identity {
  flex-direction: row-reverse;
}

.conversation-message--own .assistant-identity > div {
  align-items: flex-end;
}

.conversation-message--own .assistant-answer {
  margin-right: 34px;
  margin-left: 20%;
}

.thread-empty {
  margin: 48px 0;
  color: #8a8f8a;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.8;
  text-align: center;
}

.session-run-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 30px;
}

.session-run {
  display: flex;
  width: fit-content;
  max-width: 100%;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #e2e8e4;
  border-radius: 10px;
  color: #59615b;
  background: #fbfdfc;
  font-size: var(--dsh-font-size-micro);
  cursor: pointer;
}

.session-run:hover {
  border-color: #b8dccd;
  background: #f2faf6;
}

.session-run__requester {
  font-weight: 600;
}

.assistant-identity {
  display: flex;
  align-items: center;
  gap: 9px;
}

.assistant-avatar {
  display: grid;
  width: 25px;
  height: 25px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: #fff;
  background: #3e5f55;
  font-size: var(--dsh-font-size-body);
  font-weight: 750;
}

.assistant-identity > div {
  display: flex;
  flex-direction: column;
}

.assistant-identity strong {
  color: #292c29;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.assistant-identity span:not(.assistant-avatar) {
  margin-top: 2px;
  color: #9a9e9a;
  font-size: var(--dsh-font-size-micro);
}

.working-answer {
  margin: 13px 0 0 34px;
}

.assistant-answer {
  margin: 12px 0 0 34px;
  padding: 16px 18px 12px;
  border: 1px solid #e8ebe8;
  border-radius: 14px;
  background: #fcfdfc;
}

.assistant-answer :deep(.assistant-message-content) {
  color: #303430;
}

.assistant-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 31px;
  margin-top: 15px;
  padding-top: 8px;
  border-top: 1px solid #edf0ed;
  color: #888d88;
}

.assistant-actions button {
  display: grid;
  width: 27px;
  height: 27px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 7px;
  color: #7e837e;
  background: transparent;
  cursor: pointer;
}

.assistant-actions button:hover {
  color: #175e4d;
  background: #eff6f3;
}

.assistant-run-meta {
  margin-left: 7px;
  color: #949994;
  font-size: var(--dsh-font-size-micro);
}

.answer-artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.answer-artifacts button {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 16px;
  align-items: center;
  min-width: 230px;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #e2e4e1;
  border-radius: 10px;
  color: #4c514c;
  background: #fafbfa;
  cursor: pointer;
  text-align: left;
}

.answer-artifacts button:hover {
  border-color: #bdcbc5;
  background: #f5f8f6;
}

.answer-artifacts button > span:first-child {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 8px;
  color: #356858;
  background: #eaf4f0;
}

.answer-artifacts button > span:nth-child(2) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.answer-artifacts strong {
  overflow: hidden;
  font-size: var(--dsh-font-size-badge);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.answer-artifacts small {
  margin-top: 3px;
  color: #939793;
  font-size: var(--dsh-font-size-micro);
}

.working-answer {
  display: flex;
  align-items: center;
  min-height: 42px;
  gap: 10px;
  color: #6e746f;
  font-size: var(--dsh-font-size-caption);
}

.working-answer > button {
  margin-left: auto;
  padding: 0;
  border: 0;
  color: #34705f;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
}

.working-dots {
  display: flex;
  gap: 3px;
}

.working-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #67a997;
  animation: working-pulse 1s ease-in-out infinite;
}

.working-dots i:nth-child(2) {
  animation-delay: 120ms;
}

.working-dots i:nth-child(3) {
  animation-delay: 240ms;
}

@keyframes working-pulse {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }

  50% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

.conversation-notice {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  margin: 36px 0 0 34px;
  padding: 14px;
  border: 1px solid #efd7b1;
  border-radius: 12px;
  background: #fff9ef;
}

.conversation-notice__icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  color: #9e5b12;
  background: #ffedcf;
}

.conversation-notice strong {
  font-size: var(--dsh-font-size-caption);
}

.conversation-notice p {
  margin: 5px 0 0;
  color: #767069;
  font-size: var(--dsh-font-size-badge);
  line-height: 1.6;
}

.conversation-notice dl {
  display: flex;
  gap: 20px;
  margin: 9px 0 0;
}

.conversation-notice dl div {
  display: flex;
  gap: 6px;
}

.conversation-notice dt,
.conversation-notice dd {
  margin: 0;
  font-size: var(--dsh-font-size-micro);
}

.conversation-notice dt {
  color: #9b8a74;
}

.conversation-notice__actions {
  display: flex;
  gap: 7px;
}

.error-notice {
  border-color: #efc8cc;
  background: #fff5f6;
}

.error-notice .conversation-notice__icon {
  color: #a92e3c;
  background: #ffe2e5;
}

.error-notice code {
  display: inline-block;
  margin-top: 7px;
  color: #9b3c47;
  font-size: var(--dsh-font-size-micro);
}

.conversation-end {
  height: 12px;
}

.conversation-composer-dock {
  position: absolute;
  z-index: 11;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 48px 28px 13px;
  background: linear-gradient(to bottom, rgb(255 255 255 / 0%), #fff 31%, #fff 100%);
  pointer-events: none;
}

.conversation-composer-dock__inner {
  width: min(100%, 920px);
  margin: 0 auto;
  pointer-events: auto;
}

.conversation-composer-dock__inner > p {
  margin: 7px 0 0;
  color: #aaada9;
  font-size: var(--dsh-font-size-micro);
  text-align: center;
}

/* 归档只读态：以提示替代续写输入，避免提交后才被服务端拒绝（design §2.7）。 */
.conversation-composer-dock__inner > p.conversation-archived-notice {
  margin-top: 0;
  padding: 12px 16px;
  border: 1px solid #f0d9b5;
  border-radius: 12px;
  color: #8a5a1e;
  background: #fdf6ec;
  font-size: var(--dsh-font-size-caption);
}

.conversation-composer-dock :deep(.composer__surface) {
  border-color: #dedfdd;
  border-radius: 15px;
  box-shadow: 0 9px 28px rgb(28 31 28 / 7%);
}

.conversation-composer-dock :deep(.composer__input) {
  min-height: 76px;
  font-size: var(--dsh-font-size-body);
}

.jump-latest {
  display: flex;
  align-items: center;
  width: max-content;
  min-height: 29px;
  gap: 5px;
  margin: 0 auto 9px;
  padding: 0 10px;
  border: 1px solid #dedfdd;
  border-radius: 999px;
  color: #626762;
  background: #fff;
  box-shadow: 0 5px 16px rgb(25 30 26 / 7%);
  cursor: pointer;
  font-size: var(--dsh-font-size-micro);
  pointer-events: auto;
}

.drawer-section + .drawer-section {
  margin-top: 28px;
}

.drawer-section h2 {
  margin: 0 0 12px;
  color: #272a27;
  font-size: var(--dsh-font-size-body);
}

.run-facts {
  margin: 0;
  padding: 3px 12px;
  border: 1px solid #e5e7e4;
  border-radius: 10px;
  background: #fafbfa;
}

.run-facts div {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid #eceeeb;
}

.run-facts div:last-child {
  border-bottom: 0;
}

.run-facts dt,
.run-facts dd {
  margin: 0;
  font-size: var(--dsh-font-size-badge);
}

.run-facts dt {
  color: #8a8f8a;
}

.run-facts dd {
  color: #424742;
  text-align: right;
}

.source-list {
  display: grid;
  gap: 8px;
}

.source-list article {
  padding: 11px;
  border: 1px solid #e5e7e4;
  border-radius: 9px;
}

.source-list article > span {
  color: #4c806f;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.source-list strong {
  display: block;
  margin-top: 4px;
  color: #343834;
  font-size: var(--dsh-font-size-badge);
}

.source-list small {
  display: block;
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
  line-height: 1.5;
}

.source-list p {
  margin: 5px 0 0;
  color: #828782;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.5;
}

.drawer-artifacts {
  display: grid;
  gap: 8px;
}

.drawer-artifacts button {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px;
  border: 1px solid #e5e7e4;
  border-radius: 9px;
  color: #48695e;
  background: #fff;
  cursor: pointer;
  text-align: left;
}

.drawer-artifacts button > span {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.drawer-artifacts strong {
  overflow: hidden;
  color: #343834;
  font-size: var(--dsh-font-size-badge);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-artifacts small {
  margin-top: 3px;
  color: #929692;
  font-size: var(--dsh-font-size-micro);
}

@media (max-width: 720px) {
  .conversation-header {
    min-height: 58px;
    padding: 0 10px 0 52px;
  }

  .conversation-header__back {
    display: none;
  }

  .conversation-header__actions {
    gap: 0;
  }

  .conversation-header__actions .status-tag,
  .header-action-label {
    display: none;
  }

  .conversation-scroll {
    padding: 78px 14px 218px;
  }

  .conversation-message--own .assistant-answer {
    margin-right: 0;
    margin-left: 12%;
  }

  .assistant-answer,
  .working-answer {
    margin-left: 0;
  }

  .assistant-answer {
    padding: 14px 14px 10px;
  }

  .assistant-answer :deep(.assistant-message-content) {
    font-size: var(--dsh-font-size-caption);
  }

  .conversation-notice {
    grid-template-columns: 30px minmax(0, 1fr);
    margin-left: 0;
  }

  .conversation-notice__actions,
  .conversation-notice > .el-button {
    grid-column: 1 / -1;
    justify-self: end;
  }

  .conversation-notice dl {
    flex-direction: column;
    gap: 5px;
  }

  .conversation-composer-dock {
    padding: 40px 10px 9px;
  }

  .conversation-composer-dock :deep(.composer__input) {
    min-height: 70px;
  }

  .assistant-run-meta {
    display: none;
  }

  .answer-artifacts button {
    width: 100%;
  }
}
</style>
