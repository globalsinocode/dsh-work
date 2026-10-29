<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { projectTaskDetailKey } from '@/composables/project-task-detail'
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
  Warning,
} from '@element-plus/icons-vue'

import { AssistantMessageContent, RunTimeline, StatusTag } from '@dsh-work/ui-core'
import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { Artifact, ChatMessage, ProjectTask, ProjectTaskEvent, SessionThread, SessionThreadMessage, TaskResultOutcome, TaskRun, TaskSource, TeamMemberRole, WorkspaceAgentMember } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import ArtifactPreviewDialog from '@/components/ArtifactPreviewDialog.vue'
import { runGuardedAction } from '@/utils/action-guard'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'
import { exportConversation } from '@/utils/conversation-export'
import { continueChoice, type ContinueChoice } from '@/utils/continue-intent'
import { colleagueMentionOptions, mentionsUser, splitMentions, type MentionOption } from '@/utils/mentions'
import { scheduleLabel, scheduleReasonLabel } from '@/utils/project-task-schedule'
import { isTransientRequestError } from '@/utils/request-error'
import { runFailureDetailReason } from '@/utils/run-error-display'
import { TEAM_COMPOSER_SHORTCUT_HINT } from '@/utils/team-composer-hints'
import {
  createEmptyTeamComposerBridge,
  teamComposerBridgeKey,
} from '@/components/team-space-composer/team-composer-bridge'
import ArtifactPreviewPanel from '@/components/conversation/ArtifactPreviewPanel.vue'
import ConversationMessageItem from '@/components/conversation/ConversationMessageItem.vue'
import RunArtifactCards from '@/components/conversation/RunArtifactCards.vue'
import RunProgressCard from '@/components/conversation/RunProgressCard.vue'
import RunProgressSummary from '@/components/conversation/RunProgressSummary.vue'
import RunStepsDisclosure from '@/components/conversation/RunStepsDisclosure.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import '@/styles/conversation-thread.css'

const route = useRoute()
const router = useRouter()
const taskStore = useTaskStore()
const authStore = useAuthStore()
const contentStore = useContentStore()

const detailsOpen = ref(false)
const previewOpen = ref(false)
const previewArtifact = ref<Artifact | null>(null)
const conversationScroll = ref<HTMLElement>()
const showJumpToLatest = ref(false)
const stopping = ref(false)
const retrying = ref(false)

/**
 * TW-10 会话模式：路由 id 不是任何 Run 时，按 Session 直接加载共享线程；
 * 线程中的执行记录以状态入口内联展示，点击进入对应 Run 详情。
 */
const sessionThread = ref<SessionThread | null>(null)
const threadMissing = ref(false)
/** 「加载更早」在途标记（评审中3）：线程只保留最近一页，更早历史按需前置合并。 */
const loadingEarlierMessages = ref(false)
/** Run/Session 目标解析在途标记：避免加载间隙闪现「未找到对话」。 */
const targetLoading = ref(false)

/**
 * TW-10 空间内嵌套：作为 /workspaces/:id/conversations/:conversationId 子路由
 * 渲染时 params.id 是空间 id、目标在 conversationId；独立 /conversations/:id
 * 路径仍按原样解析。团队会话的外部链接加载后归位到空间 URL
 * （reconcileConversationRoute），保证团队对话始终停留在空间上下文。
 */
/**
 * 项目任务详情内嵌：作为 /workspaces/:id/tasks/:taskId/thread/:conversationId 渲染时，
 * 任务信息、返回与任务标识由外层任务详情提供，线程内导航（续接产生新 Run、查看执行记录）
 * 停留在任务详情下。
 */
const isTaskThreadRoute = computed(() => route.name === 'workspace-task-thread')
const isEmbeddedInWorkspace = computed(() =>
  route.name === 'workspace-conversation' || isTaskThreadRoute.value)
const isActiveConversationRoute = computed(() =>
  route.name === 'workspace-conversation' || route.name === 'conversation' || isTaskThreadRoute.value)
const embeddedWorkspaceId = computed(() =>
  isEmbeddedInWorkspace.value ? String(route.params.id) : '')
const routeTargetId = computed(() => {
  if (route.name === 'workspace-conversation' || route.name === 'workspace-task-thread') {
    return String(route.params.conversationId ?? '')
  }
  if (route.name === 'conversation') {
    return String(route.params.id ?? '')
  }
  return ''
})

/**
 * EX-ARTIFACT-08：点击成果在右栏预览。宽屏（≥1280px）与对话并排；窄屏与空间内嵌时为抽屉。
 * 右栏与「对话详情」抽屉同在右侧，打开一个就收起另一个；切换到别的对话时关闭。
 */
const wideForPreview = useMediaQuery('(min-width: 1280px)', true)
const previewDocked = computed(() => wideForPreview.value && !isEmbeddedInWorkspace.value)
const previewKey = computed(() => previewArtifact.value ? `${previewArtifact.value.id}@${previewArtifact.value.version}` : null)
/**
 * HTML / Markdown / CSV 仍走成果预览对话框（源代码切换与表格）。
 * PDF 与纯文本走右栏：PDF 只展示解析文本或失败原因，文本展示该版本原文（EX-ARTIFACT-08）。
 */
const DIALOG_PREVIEW_TYPES = new Set<Artifact['type']>(['html', 'markdown', 'csv'])
function openPreview(artifact: Artifact) {
  detailsOpen.value = false
  previewArtifact.value = artifact
  previewOpen.value = DIALOG_PREVIEW_TYPES.has(artifact.type)
}
const panelArtifact = computed(() => {
  const artifact = previewArtifact.value
  if (!artifact || previewOpen.value || DIALOG_PREVIEW_TYPES.has(artifact.type)) return null
  return artifact
})
function closePreview() {
  previewArtifact.value = null
  previewOpen.value = false
}
watch(detailsOpen, (open) => { if (open) closePreview() })

function conversationPath(target: string) {
  if (isTaskThreadRoute.value) {
    return `/workspaces/${embeddedWorkspaceId.value}/tasks/${String(route.params.taskId)}/thread/${target}`
  }
  return isEmbeddedInWorkspace.value
    ? `/workspaces/${embeddedWorkspaceId.value}/conversations/${target}`
    : `/conversations/${target}`
}

const task = computed(() => taskStore.getTask(routeTargetId.value))
/**
 * 归档只读态（design §2.7 / 3-T1 执行轨）：运行所属团队空间归档后，续写（发送消息）
 * 与重试入口隐藏；内容、来源与成果下载保持可读。个人空间不会命中（AC-23）。
 */
const currentWorkspace = computed(() => contentStore.workspaces.find(item => item.id === task.value?.workspaceId))
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
const canResolveApproval = computed(() => Boolean(
  task.value?.status === 'awaiting_approval'
  && isRequester.value
  && task.value.approval?.employeeResolvable,
))
const resolvingApproval = ref(false)
const canStop = computed(() => Boolean(
  task.value && canOperateRun.value
  && ['queued', 'running', 'awaiting_approval'].includes(task.value.status),
))
const teamRunMissingPinnedAgent = computed(() => Boolean(
  task.value?.workspaceType === 'team'
  && ['failed', 'cancelled'].includes(task.value.status)
  && !task.value.agentVersion,
))
const canRetry = computed(() => Boolean(
  task.value && canOperateRun.value
  && ['failed', 'cancelled'].includes(task.value.status)
  && !teamRunMissingPinnedAgent.value
  && !task.value.result.pendingItems.some(item => item.kind === 'external_effect_unknown')
  && (task.value.result.error?.retryable ?? true)))
const canFollowUp = computed(() => !workspaceArchived.value && !isRunViewer.value)
/** 失败通知框「原因」：展示 Runtime/平台遥测的具体说明（非目录占位文案）。 */
const runFailureDetail = computed(() => {
  const error = task.value?.result.error
  if (!error) return ''
  return runFailureDetailReason(error)
})
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

/** 当前空间可 @ 的 Agent 成员（独立对话页加载；空间内嵌由底栏使用空间页名册）。 */
const agentMembers = ref<WorkspaceAgentMember[]>([])
/** D38：可 @ 的同事（现任成员，不含本人）；任务对话中不 @ 同事。 */
const colleagues = ref<Array<{ userId: string; displayName: string }>>([])
const mentionOptions = computed<MentionOption[]>(() => [
  ...agentMembers.value
    .filter(member => member.status === 'available' && member.allowedActions.includes('start_conversation'))
    .map(member => ({ id: member.id, name: member.name, kind: 'agent' as const })),
  ...(projectTask.value ? [] : colleagueMentionOptions(colleagues.value, authStore.user.id)),
])

/**
 * 项目空间 S1：当前线程若是 Agent 任务线程，回复默认交给承接 Agent，无需 @；
 * 服务端同样按任务线程固定承接 Agent，这里只决定输入框的默认行为与提示。
 */
const projectTask = ref<ProjectTask | null>(null)
const currentSessionId = computed(() => task.value?.sessionId ?? sessionThread.value?.sessionId ?? null)
/** 追问会换到新 Run 的地址但仍是同一对话：只在换到别的会话时关闭成果预览。 */
let previewSessionId: string | null = null
watch(currentSessionId, (sessionId) => {
  if (!sessionId) return
  if (previewSessionId && sessionId !== previewSessionId) {
    previewArtifact.value = null
    previewOpen.value = false
  }
  previewSessionId = sessionId
}, { immediate: true })
const projectTaskLoading = ref(false)
const projectTaskError = ref('')

const taskDetail = inject(projectTaskDetailKey, null)
/** 任务详情内的任务对话（会话视图）；执行详情（Run 视图）不算。 */
const inTaskConversation = computed(() => isTaskThreadRoute.value && !task.value && Boolean(sessionThread.value))
const conversationTask = computed(() => taskDetail?.task.value ?? projectTask.value)
const isAgentTaskConversation = computed(() => inTaskConversation.value && conversationTask.value?.assignee.type === 'agent')
const isEmployeeTaskConversation = computed(() => inTaskConversation.value && conversationTask.value?.assignee.type === 'employee')
const taskThreadAgentId = computed(() =>
  conversationTask.value?.assignee.type === 'agent' ? conversationTask.value.assignee.agentMemberId : undefined)
const taskThreadAgentName = computed(() =>
  conversationTask.value?.assignee.type === 'agent' ? conversationTask.value.assignee.name : '')
/** 空间页外挂底栏时隐藏本页浮动 composer 区；任务对话内嵌时仍在本页展示发送方式与输入框。 */
const showSessionComposerDock = computed(() =>
  inTaskConversation.value
  || !isEmbeddedInWorkspace.value
  || sessionArchived.value
  || sessionReadOnly.value,
)
const showRunComposerDock = computed(() =>
  isTaskThreadRoute.value
  || !isEmbeddedInWorkspace.value
  || workspaceArchived.value
  || isRunViewer.value,
)
const showTeamComposerShortcutHint = computed(() =>
  isTeamSession.value && mentionOptions.value.length > 0 && !inTaskConversation.value)

async function loadProjectTask(workspaceId: string | undefined) {
  const sessionId = currentSessionId.value
  if (!workspaceId || !isTeamSession.value || !sessionId) {
    projectTask.value = null
    projectTaskError.value = ''
    projectTaskLoading.value = false
    return
  }
  projectTaskLoading.value = true
  projectTaskError.value = ''
  try {
    const page = await workbenchApi.listProjectTasks(workspaceId, { sessionId, limit: 1 })
    if (currentSessionId.value !== sessionId) return
    projectTask.value = page.items.find(item => item.sessionId === sessionId) ?? null
    if (projectTask.value && route.name === 'workspace-conversation') {
      await router.replace(`/workspaces/${workspaceId}/tasks/${projectTask.value.id}/thread/${routeTargetId.value}`)
    }
  } catch (error) {
    if (currentSessionId.value !== sessionId) return
    projectTask.value = null
    projectTaskError.value = error instanceof Error ? error.message : '任务线程信息读取失败'
  } finally {
    if (currentSessionId.value === sessionId) projectTaskLoading.value = false
  }
}

function reloadProjectTask() {
  const workspaceId = task.value?.workspaceId ?? sessionThread.value?.workspaceId ?? currentWorkspace.value?.id
  void loadProjectTask(workspaceId)
}

const teamComposerBridge = inject(teamComposerBridgeKey, null)

async function loadAgentMembers(workspaceId: string | undefined) {
  if (isEmbeddedInWorkspace.value) return
  if (!workspaceId || !isTeamSession.value) {
    agentMembers.value = []
    colleagues.value = []
    return
  }
  await Promise.all([
    (async () => {
      try {
        agentMembers.value = await workbenchApi.listWorkspaceAgentMembers(workspaceId)
      } catch {
        agentMembers.value = []
      }
    })(),
    (async () => {
      try {
        colleagues.value = (await workbenchApi.listWorkspaceMembers(workspaceId)).items
      } catch {
        colleagues.value = []
      }
    })(),
  ])
}

function syncTeamComposerBridge() {
  if (!isEmbeddedInWorkspace.value || !teamComposerBridge) return
  const bridge = teamComposerBridge.value
  bridge.sessionId = sessionThread.value?.sessionId ?? task.value?.sessionId ?? ''
  bridge.viewingRun = Boolean(task.value)
  bridge.running = canStop.value
  bridge.stopping = stopping.value
  bridge.stop = canStop.value ? () => { void stopCurrentRun() } : null
  bridge.submitSession = sessionThread.value && canWriteSession.value
    ? payload => { void submitSessionMessage(payload) }
    : null
  bridge.submitFollowUp = task.value && canFollowUp.value
    ? payload => { void submitFollowUp(payload) }
    : null
  bridge.showJumpToLatest = showJumpToLatest.value
  bridge.scrollToLatest = () => scrollToBottom()
}
const lastAssistantMessageId = computed(() =>
  [...(task.value?.messages ?? [])]
    .reverse()
    .find(message => message.role === 'assistant' && message.runId === task.value?.id)?.id,
)
function belongsToCurrentRun(message: ChatMessage) {
  return message.runId === task.value?.id
}

/** 线程消息的可空归因归一为 ChatMessage 的可选字段（null 与缺省同样按「无」渲染）。 */
function toChatMessage(message: SessionThreadMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    runId: message.runId,
    senderId: message.senderId ?? undefined,
    senderName: message.senderName ?? undefined,
    runRequesterId: message.runRequesterId ?? undefined,
    runRequesterName: message.runRequesterName ?? undefined,
    agentName: message.agentName ?? undefined,
  }
}

/**
 * 对话页展示的消息流（TW-10 团队会话）：团队 Run 详情按查询边界只返回本轮
 * 消息（评审 M8），共享会话的历史在共享线程接口里。线程可用时以线程全量
 * 历史为准（保持会话时序，打开旧 Run 也不把该轮消息挪到末尾），并把尚未
 * 落库的流式回答（Run 事件累积）追加在末尾；个人 Run 与线程缺失时退回
 * Run 详情自带的消息（个人契约本就是完整多轮历史）。
 */
const conversationMessages = computed<ChatMessage[]>(() => {
  const thread = sessionThread.value
  const runMessages = task.value?.messages ?? []
  if (!thread) return runMessages
  const known = new Set(thread.messages.map(message => message.id))
  return [
    ...thread.messages.map(toChatMessage),
    ...runMessages.filter(message => !known.has(message.id)),
  ]
})

/** EX-PROGRESS-01：本轮结束后，步骤摘要放在本轮第一条回复上方。 */
const firstCurrentRunAssistantMessageId = computed(() =>
  conversationMessages.value.find(message => message.role === 'assistant' && message.runId === task.value?.id)?.id,
)

/** 各 Run 在消息流里最后一条 assistant 回复的 id，成果卡片挂在这条消息下。 */
const terminalAssistantMessageIdByRun = computed(() => {
  const map = new Map<string, string>()
  for (const message of conversationMessages.value) {
    if (message.role === 'assistant' && message.runId) map.set(message.runId, message.id)
  }
  return map
})

/** 同一会话内各 Run 已登记成果（列表缓存 + 按需拉取的 Run 详情）。 */
const runArtifactsById = computed(() => {
  const map = new Map<string, Artifact[]>()
  const sessionId = task.value?.sessionId ?? sessionThread.value?.sessionId
  if (!sessionId) {
    if (task.value?.result.artifacts.length) map.set(task.value.id, task.value.result.artifacts)
    return map
  }
  for (const item of taskStore.tasks) {
    if (item.sessionId === sessionId && item.result.artifacts.length) {
      map.set(item.id, item.result.artifacts)
    }
  }
  return map
})

function messageArtifacts(message: ChatMessage): Artifact[] {
  if (message.role !== 'assistant' || !message.runId) return []
  if (terminalAssistantMessageIdByRun.value.get(message.runId) !== message.id) return []
  return runArtifactsById.value.get(message.runId) ?? []
}

type ThreadMessageLike = Pick<ChatMessage, 'id' | 'role' | 'runId'>

function firstUserMessageIdByRunIn(messages: ThreadMessageLike[]) {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'user' && message.runId && !map.has(message.runId)) {
      map.set(message.runId, message.id)
    }
  }
  return map
}

const firstUserMessageIdByRun = computed(() => firstUserMessageIdByRunIn(conversationMessages.value))

const firstUserMessageIdByRunInThread = computed(() =>
  firstUserMessageIdByRunIn(sessionThread.value?.messages ?? []),
)

/** 各 Run 首轮用户消息附带的输入文件（文件名来自 Run 详情 attachments）。 */
const runAttachmentsById = computed(() => {
  const map = new Map<string, string[]>()
  const sessionId = task.value?.sessionId ?? sessionThread.value?.sessionId
  if (!sessionId) {
    if (task.value?.attachments.length) map.set(task.value.id, task.value.attachments)
    return map
  }
  for (const item of taskStore.tasks) {
    if (item.sessionId === sessionId && item.attachments.length) {
      map.set(item.id, item.attachments)
    }
  }
  if (task.value?.attachments.length) map.set(task.value.id, task.value.attachments)
  return map
})

function messageInputAttachments(
  message: ThreadMessageLike,
  firstByRun: Map<string, string>,
) {
  if (message.role !== 'user') return []

  const runId = message.runId ?? (task.value?.attachments.length ? task.value.id : null)
  if (!runId) return []

  const firstUserId = firstByRun.get(runId)
    ?? conversationMessages.value.find(item => item.role === 'user' && item.runId === runId)?.id

  if (firstUserId !== message.id) {
    // 旧夹具/投影未带 runId：本轮仅一条用户消息时仍展示 Run 级 attachments。
    const loneUser = conversationMessages.value.filter(item => item.role === 'user')
    if (loneUser.length !== 1 || loneUser[0]!.id !== message.id || task.value?.id !== runId) return []
  }

  return runAttachmentsById.value.get(runId) ?? (task.value?.id === runId ? task.value.attachments : [])
}

let prefetchRunArtifactsEpoch = 0
/**
 * 已确认无需再拉取详情的 Run。预拉取本身会写 store，若重复触发就会形成
 * 「监控 → 拉取 → store 变更 → 监控」的自我驱动请求环，因此必须幂等。
 */
const prefetchedRunArtifacts = new Set<string>()

function isFinishedStatus(status: TaskRun['status']) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

/** 缓存里已有结论（有成果，或终态且无成果）时不必再拉。返回 true 表示可跳过。 */
function artifactPrefetchSettled(runId: string) {
  if (prefetchedRunArtifacts.has(runId)) return true
  const cached = taskStore.getTask(runId)
  if (!cached) return false
  if (cached.result.artifacts.length || isFinishedStatus(cached.status)) {
    prefetchedRunArtifacts.add(runId)
    return true
  }
  return false
}

async function prefetchSessionRunArtifacts() {
  const sessionId = task.value?.sessionId ?? sessionThread.value?.sessionId
  if (!sessionId) return
  const epoch = ++prefetchRunArtifactsEpoch
  const runIds = new Set(
    conversationMessages.value
      .filter(message => message.runId)
      .map(message => message.runId as string),
  )
  for (const runId of runIds) {
    if (epoch !== prefetchRunArtifactsEpoch) return
    if (artifactPrefetchSettled(runId)) continue
    try {
      const loaded = await taskStore.loadTask(runId)
      // 只有拿到结论才记账：仍在执行且暂无成果的 Run 允许后续轮次再补一次。
      if (loaded.result.artifacts.length || isFinishedStatus(loaded.status)) {
        prefetchedRunArtifacts.add(runId)
      }
    } catch {
      // 无权、已删除或尚未终态的 Run 忽略，不阻塞对话渲染。
    }
  }
}
/**
 * D38：打开团队对话（讨论或其中一次执行）即把该讨论的 @ 提醒标为已读——执行详情只载入本次执行的
 * 消息，不能以“页面里有没有 @ 本人的发言”为条件；停留期间新到 @ 本人的发言也随即已读。只写本人的
 * 提醒状态，失败不影响阅读（下次打开再标）。
 */
const mentionsOfMeInView = computed(() => {
  const messages: Array<{ senderId?: string | null; mentionedUserIds?: string[] }> =
    sessionThread.value?.messages ?? task.value?.messages ?? []
  return messages.filter(message => message.senderId !== authStore.user.id && mentionsUser(message, authStore.user.id)).length
})
watch([currentSessionId, isTeamSession, mentionsOfMeInView], async ([sessionId, team]) => {
  const workspaceId = task.value?.workspaceId ?? sessionThread.value?.workspaceId
  if (!sessionId || !team || !workspaceId) return
  try {
    await workbenchApi.markMentionsRead(workspaceId, sessionId)
  } catch {
    // 标记失败不打扰阅读：提醒保留，下次打开再标。
  }
}, { immediate: true })

const sourceTypeLabels: Record<TaskSource['type'], string> = {
  knowledge: '企业知识',
  erp: '业务系统',
  mes: '生产系统',
  file: '上传文件',
}

/**
 * I-06 结果外层展示：业务结论只看 result.outcome，不由 status === 'succeeded'
 * 推断达成；执行状态仍由 task.status 与步骤时间线表达。
 */
const resultOutcomeLabels: Record<TaskResultOutcome, string> = {
  pending: '结果生成中',
  achieved: '目标已达成',
  unverified: '结果待核验',
  not_achieved: '目标未达成',
}
const isTerminalRun = computed(() =>
  Boolean(task.value && ['succeeded', 'failed', 'cancelled'].includes(task.value.status)))

function goBack() {
  if (isTaskThreadRoute.value) {
    const sessionId = task.value?.sessionId ?? sessionThread.value?.sessionId
    void router.push(sessionId ? conversationPath(sessionId) : `/workspaces/${embeddedWorkspaceId.value}/tasks/${String(route.params.taskId)}`)
    return
  }
  // 嵌入态的返回固定归位到所属空间页（线程返回控件回到列表）：外部旧链接
  // 经 replace 归位后，router.back() 会跳出空间上下文，不能依赖历史栈。
  if (isEmbeddedInWorkspace.value) {
    const workspaceId = String(route.params.id ?? embeddedWorkspaceId.value)
    if (!workspaceId) {
      void router.push({ name: 'workspaces' })
      return
    }
    const view = String(route.query.view ?? '')
    void router.push({
      name: 'workspace-detail',
      params: { id: workspaceId },
      query: view === 'history' ? { view: 'history' } : {},
    })
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
  syncTeamComposerBridge()
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

async function resolveApproval(decision: 'approved' | 'rejected') {
  if (!task.value || resolvingApproval.value || !canResolveApproval.value) return
  resolvingApproval.value = true
  try {
    await taskStore.resolveRunApproval(task.value.id, decision)
    ElMessage.success(decision === 'approved' ? '已允许本次操作' : '已拒绝本次操作')
  } catch (cause) {
    notifyActionFailure('确认操作', task.value.title, cause, '请刷新对话后重试。')
  } finally {
    resolvingApproval.value = false
  }
}

function retryRun() {
  const current = task.value
  if (!current || !canOperateRun.value) return
  void runGuardedAction(`run-retry:${current.id}`, async () => {
    retrying.value = true
    try {
      await taskStore.retryTask(current.id)
      ElMessage.success('已创建新的运行尝试')
    } catch (error) {
      notifyActionFailure('重新执行', `运行 ${current.id}`, error, '刷新对话状态；确认本轮仍为失败或已停止后再重试。')
    } finally {
      retrying.value = false
    }
  })
}

function copyAnswer(content: string) {
  void navigator.clipboard.writeText(content)
  ElMessage.success('回答已复制')
}

function copyConversationLink() {
  void navigator.clipboard.writeText(window.location.href)
  ElMessage.success('对话链接已复制')
}

function exportSessionTranscript() {
  const current = task.value
  if (!current) return
  void exportConversation({ scope: 'session', sessionId: current.sessionId, title: current.title })
}

function exportCurrentRunTranscript() {
  const current = task.value
  if (!current) return
  void exportConversation({
    scope: 'run',
    sessionId: current.sessionId,
    runId: current.id,
    title: current.title,
  })
}

function download(item: Artifact) {
  void downloadArtifactFile(item)
}

/**
 * EX-02「继续修改」：把本轮成果作为只读输入带进下一条消息。服务端按会话与空间权限
 * 重新校验；Agent 输出同名文件时登记为该成果的下一版本，旧版本保持可下载。
 */
const referencedArtifacts = ref<Array<{ fileId: string; name: string; version: number }>>([])
const maxReferencedFiles = 5

function continueEditing(artifact: Artifact) {
  if (!artifact.fileId || !artifact.canReference) return
  if (referencedArtifacts.value.some(item => item.fileId === artifact.fileId)) return
  if (referencedArtifacts.value.length >= maxReferencedFiles) {
    ElMessage.warning(`每条消息最多引用 ${maxReferencedFiles} 个文件`)
    return
  }
  referencedArtifacts.value.push({ fileId: artifact.fileId, name: artifact.name, version: artifact.version })
  ElMessage.success(`已引用 ${artifact.name}，在下方说明要怎么修改`)
}

function removeReferencedArtifact(fileId: string) {
  referencedArtifacts.value = referencedArtifacts.value.filter(item => item.fileId !== fileId)
}

// 引用只在当前会话内有效：切到其他会话时清空，避免把成果带进无关对话。
watch(() => task.value?.sessionId, (sessionId, previous) => {
  if (sessionId !== previous) referencedArtifacts.value = []
})

function openSessionRun(runId: string) {
  void router.push(conversationPath(runId))
}

// ---------------------------------------------------------------------------
// 项目空间 S3：任务详情内的任务对话（会话视图）
// ---------------------------------------------------------------------------

const taskAgentLabel = computed(() =>
  conversationTask.value?.assignee.type === 'agent' ? conversationTask.value.assignee.name : 'Agent')
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'awaiting_approval', 'waiting', 'cancel_requested']
const threadHasActiveRun = computed(() =>
  (sessionThread.value?.runs ?? []).some(run => ACTIVE_RUN_STATUSES.includes(run.status)))
/** 尚未执行过的 Agent 任务：“交给 Agent”经任务启动（带上任务引用的文件）。 */
const taskNotStarted = computed(() => isAgentTaskConversation.value && !(sessionThread.value?.runs.length ?? 0))
/** Agent 任务对话的发送方式：默认交给 Agent，可选“仅评论”；执行中只能评论。 */
const sendMode = ref<'agent' | 'comment'>('agent')
/** S4：已完成的 Agent 任务不再执行，改回进行中后才能交给 Agent。 */
const agentTaskDone = computed(() => isAgentTaskConversation.value && conversationTask.value?.status === 'done')
const effectiveSendMode = computed<'agent' | 'comment'>(() =>
  !isAgentTaskConversation.value || threadHasActiveRun.value || agentTaskDone.value ? 'comment' : sendMode.value)
/** S4：两类任务都可在对话中“标记完成”；协作模式改由任务详情的操作菜单提供（D37）。 */
const canCompleteFromConversation = computed(() =>
  inTaskConversation.value && !taskDetail?.completeInMenu && conversationTask.value?.status !== 'done'
  && Boolean(taskDetail?.can('complete')))
const canStartFromConversation = computed(() => taskNotStarted.value && Boolean(taskDetail?.can('start')))
const taskComposerPlaceholder = computed(() => {
  if (!inTaskConversation.value) return ''
  if (isEmployeeTaskConversation.value) return '更新进度或写评论…'
  if (threadHasActiveRun.value) return `写评论…（${taskAgentLabel.value} 执行中，暂不能交给 Agent）`
  if (agentTaskDone.value) return '写评论…（任务已完成，改回进行中后才能交给 Agent）'
  if (effectiveSendMode.value === 'comment') return '写评论…'
  return taskNotStarted.value ? `补充要求，交给 ${taskAgentLabel.value} 开始执行…` : `继续交代，交给 ${taskAgentLabel.value} 处理…`
})

const runStatusLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待中',
  awaiting_approval: '等待确认',
  cancel_requested: '正在停止',
  succeeded: '执行完成',
  failed: '执行失败',
  cancelled: '已停止',
}
const taskStatusLabels: Record<string, string> = { todo: '待办', in_progress: '进行中', done: '已完成' }

type SessionRunRecord = SessionThread['runs'][number]
type TimelineItem =
  | { kind: 'message'; key: string; at: string; message: SessionThreadMessage; quiet?: boolean }
  | { kind: 'run'; key: string; at: string; run: SessionRunRecord }
  | { kind: 'event'; key: string; at: string; event: ProjectTaskEvent }

/** S4：定时执行发起的 Run（由 scheduled_run 事件登记）。 */
const scheduledRunIds = computed(() => new Set((taskDetail?.events.value ?? [])
  .filter(event => event.kind === 'scheduled_run' && event.metadata.runId)
  .map(event => String(event.metadata.runId))))

const taskTimeline = computed<TimelineItem[]>(() => {
  const thread = sessionThread.value
  if (!thread) return []
  const runs = new Map(thread.runs.map(run => [run.runId, run]))
  const scheduled = scheduledRunIds.value
  const placed = new Set<string>()
  const items: TimelineItem[] = []
  for (const message of thread.messages) {
    if (message.role === 'user' && message.runId && scheduled.has(message.runId)) continue
    const quiet = message.role !== 'user' && Boolean(message.runId && scheduled.has(message.runId))
      && message.content.trim().startsWith('无变化')
    items.push({ kind: 'message', key: message.id, at: message.sentAt ?? '', message, quiet })
    const run = message.role === 'user' && message.runId ? runs.get(message.runId) : undefined
    if (run && !placed.has(run.runId)) {
      placed.add(run.runId)
      items.push({ kind: 'run', key: `run-${run.runId}`, at: run.createdAt, run })
    }
  }
  const extras: TimelineItem[] = [
    ...thread.runs.filter(run => !placed.has(run.runId))
      .map(run => ({ kind: 'run' as const, key: `run-${run.runId}`, at: run.createdAt, run })),
    ...(taskDetail?.events.value ?? [])
      .filter(event => event.kind !== 'scheduled_run')
      .filter(event => !event.sessionId || event.sessionId === thread.sessionId)
      .map(event => ({ kind: 'event' as const, key: event.id, at: event.createdAt, event })),
  ].sort((left, right) => left.at.localeCompare(right.at))
  for (const extra of extras) {
    const index = items.findIndex(item => item.at !== '' && item.at > extra.at)
    if (index < 0) items.push(extra)
    else items.splice(index, 0, extra)
  }
  return items
})

function runRecordText(run: SessionRunRecord) {
  const status = runStatusLabels[run.status] ?? run.status
  const stopped = run.status === 'cancelled' && run.stoppedByName ? `（${run.stoppedByName} 停止）` : ''
  if (scheduledRunIds.value.has(run.runId)) return `定时执行 · ${status}${stopped}`
  return `${run.requesterName} 交给 ${taskAgentLabel.value} 执行 · ${status}${stopped}`
}

function runRecordTone(run: SessionRunRecord) {
  if (run.status === 'succeeded') return 'success'
  if (run.status === 'failed') return 'danger'
  if (ACTIVE_RUN_STATUSES.includes(run.status)) return 'active'
  return 'muted'
}

function eventText(event: ProjectTaskEvent) {
  if (event.kind === 'completed') return `${event.actor.displayName} 标记完成`
  if (event.kind === 'schedule_changed') return `${event.actor.displayName} 将执行规则改为${scheduleLabel(event.metadata.schedule ?? null)}`
  if (event.kind === 'schedule_resumed') return `${event.actor.displayName} 恢复了定时执行`
  if (event.kind === 'schedule_paused') return `定时执行已暂停：${scheduleReasonLabel(event.metadata.reason ?? null)}`
  if (event.kind === 'schedule_stopped') return `定时执行已停止：${scheduleReasonLabel(event.metadata.reason ?? null)}`
  if (event.kind === 'execution_skipped') {
    return event.metadata.reason === 'busy' ? '定时执行跳过：上一次执行尚未结束' : '定时执行跳过：未能受理，下次到点再试'
  }
  if (event.kind === 'execution_missed') return `错过 ${event.metadata.count ?? 1} 次定时执行（服务未运行），不补跑`
  if (event.kind === 'reassigned') return `${event.actor.displayName} 将负责人从 ${event.metadata.from || '—'} 改为 ${event.metadata.to || '—'}`
  const to = taskStatusLabels[event.metadata.to ?? ''] ?? event.metadata.to ?? ''
  return event.metadata.auto
    ? `${event.actor.displayName} 更新了进度，任务进入${to}`
    : `${event.actor.displayName} 将状态改为${to}`
}

function formatTimelineTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** D37：每次执行的最后一条回复下挂该次执行登记的成果、执行步骤与复制。 */
const threadLastReplyIdByRun = computed(() => {
  const map = new Map<string, string>()
  for (const message of sessionThread.value?.messages ?? []) {
    if (message.role === 'assistant' && message.runId) map.set(message.runId, message.id)
  }
  return map
})

function isLastRunReply(message: SessionThreadMessage) {
  return Boolean(message.runId && threadLastReplyIdByRun.value.get(message.runId) === message.id)
}

function threadArtifactsFor(message: SessionThreadMessage) {
  if (!isLastRunReply(message)) return []
  return (sessionThread.value?.artifacts ?? []).filter(artifact => artifact.runId === message.runId)
}

/**
 * D37：排队或执行中的执行与会话页同样显示进度卡片：读取 Run 详情并订阅其事件（本人刚发起的
 * 执行已在发送时订阅）；读取失败时只保留执行记录。结束后卡片消失，由回复与成果取代。
 */
const LIVE_RUN_STATUSES = ['queued', 'running']
const threadLiveRunIds = computed(() => inTaskConversation.value
  ? (sessionThread.value?.runs ?? []).filter(run => LIVE_RUN_STATUSES.includes(run.status)).map(run => run.runId)
  : [])
watch(threadLiveRunIds, (runIds) => {
  for (const runId of runIds) {
    if (!taskStore.getTask(runId)) void taskStore.loadTask(runId).catch(() => undefined)
  }
}, { immediate: true })

function liveRun(runId: string) {
  const run = taskStore.getTask(runId)
  return run && LIVE_RUN_STATUSES.includes(run.status) ? run : undefined
}

/** 继续修改只用于下一条交给 Agent 的消息：执行中或任务已完成时只能评论，不提供。 */
const canContinueEditingInThread = computed(() =>
  canWriteSession.value && isAgentTaskConversation.value && !threadHasActiveRun.value && !agentTaskDone.value)

function continueEditingInThread(artifact: Artifact) {
  continueEditing(artifact)
  sendMode.value = 'agent'
}

/** 任务对话的首条消息是任务标题与说明（创建任务时写入），不算评论。 */
const briefMessageId = computed(() =>
  sessionThread.value && !sessionThread.value.hasMoreMessages ? sessionThread.value.messages[0]?.id ?? null : null)

function messageTag(message: SessionThreadMessage) {
  if (message.role !== 'user' || message.id === briefMessageId.value) return ''
  if (isAgentTaskConversation.value && !message.runId) return '评论'
  const assignee = conversationTask.value?.assignee
  if (isEmployeeTaskConversation.value && assignee?.type === 'employee' && message.senderId === assignee.userId) return '负责人'
  return ''
}

async function refreshTaskConversation() {
  const sessionId = sessionThread.value?.sessionId
  if (!sessionId) return
  try {
    sessionThread.value = await taskStore.loadSessionThread(sessionId)
    await nextTick(() => scrollToBottom())
  } catch {
    ElMessage.warning('已发送，但对话刷新失败，请稍后手动刷新。')
  }
  await taskDetail?.refresh()
}

async function startTaskFromConversation() {
  if (!taskDetail) return
  if (await taskDetail.start()) await refreshTaskConversation()
}

async function submitTaskConversation(
  sessionId: string,
  payload: { prompt: string; files: File[]; confirm?: () => void; release?: () => void },
) {
  const title = conversationTask.value?.title ?? sessionThread.value?.title ?? ''
  try {
    if (effectiveSendMode.value === 'agent') {
      if (taskNotStarted.value && taskDetail) {
        if (payload.files.length) {
          ElMessage.warning('开始执行时会带上任务引用的共享文件；附件请在开始执行后随回复发送。')
          payload.release?.()
          return
        }
        if (!(await taskDetail.start(payload.prompt))) {
          payload.release?.()
          return
        }
      } else {
        const createdRun = await taskStore.startRunWithSessionFiles(sessionId, {
          prompt: payload.prompt,
          attachments: payload.files,
          referencedFileIds: referencedArtifacts.value.map(item => item.fileId),
          workspaceAgentMemberId: taskThreadAgentId.value,
        })
        referencedArtifacts.value = []
        taskStore.subscribe(createdRun.id)
      }
    } else {
      if (referencedArtifacts.value.length) {
        ElMessage.warning('引用的成果需要交给 Agent 处理；只评论时请先移除引用。')
        return
      }
      if (payload.files.length) {
        ElMessage.warning(isAgentTaskConversation.value
          ? '评论不支持附件；需要 Agent 处理文件时请选择“交给 Agent”。'
          : '任务对话中的发言暂不支持附件，请上传到共享文件后在发言中说明。')
        payload.release?.()
        return
      }
      await taskStore.postSessionMessage(sessionId, payload.prompt)
    }
    payload.confirm?.()
    await refreshTaskConversation()
  } catch (error) {
    payload.release?.()
    notifyActionFailure('发送', `任务“${title}”`, error, '检查输入后重试；已有对话内容不会丢失。')
  }
}

function formatSessionRunTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * EX-02「继续」的语义：只发一句“继续”时先问清楚是重新执行上一轮、继续修改成果，
 * 还是作为新消息接着讨论。关闭对话框表示取消，输入保留。
 */
async function askContinueIntent(choice: ContinueChoice): Promise<'primary' | 'message' | 'abort'> {
  const names = choice.kind === 'revise' ? choice.artifacts.map(item => `《${item.name}》`).join('、') : ''
  try {
    await ElMessageBox.confirm(
      choice.kind === 'retry'
        ? '上一轮没有完成。重新执行会从头再跑上一轮的原问题；作为新消息发送则让 Agent 接着当前对话回应。'
        : `继续修改会把${names}作为本条消息的输入，Agent 输出同名文件时登记为新版本；作为新消息发送则只接着讨论。`,
      '你想怎么继续？',
      {
        confirmButtonText: choice.kind === 'retry' ? '重新执行上一轮'
          : choice.artifacts.length === 1 ? `继续修改${names}` : `继续修改 ${choice.artifacts.length} 个成果`,
        cancelButtonText: '作为新消息发送',
        distinguishCancelAndClose: true,
        type: 'info',
      },
    )
    return 'primary'
  } catch (action) {
    return action === 'cancel' ? 'message' : 'abort'
  }
}

async function retryRunFromComposer(): Promise<boolean> {
  const current = task.value
  if (!current || !canOperateRun.value) return false
  const outcome = await runGuardedAction(`run-retry:${current.id}`, async () => {
    retrying.value = true
    try {
      await taskStore.retryTask(current.id)
      ElMessage.success('已创建新的运行尝试')
      return true
    } catch (error) {
      notifyActionFailure('重新执行', `运行 ${current.id}`, error, '刷新对话状态；确认本轮仍为失败或已停止后再重试。')
      return false
    } finally {
      retrying.value = false
    }
  })
  return outcome === true
}

async function submitFollowUp(payload: {
  prompt: string
  files: File[]
  workspaceId: string
  mentions: string[]
  confirm?: () => void
  release?: () => void
}) {
  // TW-10 防线：viewer/角色未知不允许发言或触发执行，不能只靠模板不渲染
  // composer——函数本身也要 fail-closed。服务端写轨仍是最终裁决。
  if (!task.value || workspaceArchived.value || isRunViewer.value) {
    payload.release?.()
    return
  }
  if (isTeamSession.value && (projectTaskLoading.value || projectTaskError.value)) {
    ElMessage.warning(projectTaskError.value
      ? '任务信息读取失败，为避免误发为评论，请先重试读取'
      : '正在读取任务信息，请稍候再发送')
    payload.release?.()
    return
  }
  try {
    const { agentMemberIds, userIds } = splitMentions(payload.mentions)
    const mentionedUserIds = isTeamSession.value && !taskThreadAgentId.value ? userIds : []
    const mentionedMemberId = isTeamSession.value ? agentMemberIds[0] ?? taskThreadAgentId.value : undefined
    if (isTeamSession.value && !mentionedMemberId) {
      // TW-10：团队共享会话里不 @ Agent 的消息是全员可见的讨论，不产生执行；@ 同事只提醒（D38）。
      if (payload.files.length || referencedArtifacts.value.length) {
        ElMessage.warning('带附件或引用成果的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
        payload.release?.()
        return
      }
      await taskStore.postSessionMessage(task.value.sessionId, payload.prompt, mentionedUserIds)
      payload.confirm?.()
      try {
        await taskStore.refreshRun(task.value.id)
        ElMessage.success('讨论消息已发送，如需 Agent 处理请 @ 对应成员')
      } catch {
        ElMessage.warning('讨论消息已发送，但对话状态刷新失败，请稍后手动刷新。')
      }
    } else {
      const choice = continueChoice({
        prompt: payload.prompt,
        hasAttachments: payload.files.length > 0 || referencedArtifacts.value.length > 0,
        status: task.value.status,
        canRetry: canRetry.value,
        artifacts: task.value.result.artifacts,
      })
      if (choice) {
        const decision = await askContinueIntent(choice)
        if (decision === 'abort') {
          payload.release?.()
          return
        }
        if (decision === 'primary' && choice.kind === 'retry') {
          if (await retryRunFromComposer()) payload.confirm?.()
          else payload.release?.()
          return
        }
        if (decision === 'primary' && choice.kind === 'revise') referencedArtifacts.value = [...choice.artifacts]
      }
      const nextTask = await taskStore.sendMessage(
        task.value.id, payload.prompt, payload.files, mentionedMemberId,
        referencedArtifacts.value.map(item => item.fileId),
        mentionedUserIds,
      )
      referencedArtifacts.value = []
      if (nextTask) await router.replace(conversationPath(nextTask.id))
      payload.confirm?.()
    }
    await nextTick(() => scrollToBottom())
  } catch (error) {
    payload.release?.()
    notifyActionFailure('发送消息', `对话“${task.value.title}”`, error, '检查输入和附件后重试；已有对话内容不会丢失。')
  }
}

/** 会话模式：@ 触发新的 Run 并跳到 Run 详情；普通消息留在共享讨论线程。 */
async function submitSessionMessage(payload: {
  prompt: string
  files: File[]
  workspaceId: string
  mentions: string[]
  confirm?: () => void
  release?: () => void
}) {
  const thread = sessionThread.value
  if (!thread || !canWriteSession.value) {
    payload.release?.()
    return
  }
  if (inTaskConversation.value) {
    if (projectTaskLoading.value || projectTaskError.value) {
      ElMessage.warning(projectTaskError.value ? '任务信息读取失败，请先重试读取' : '正在读取任务信息，请稍候再发送')
      payload.release?.()
      return
    }
    await submitTaskConversation(thread.sessionId, payload)
    return
  }
  if (isTeamSession.value && (projectTaskLoading.value || projectTaskError.value)) {
    ElMessage.warning(projectTaskError.value
      ? '任务信息读取失败，为避免误发为评论，请先重试读取'
      : '正在读取任务信息，请稍候再发送')
    payload.release?.()
    return
  }
  try {
    const { agentMemberIds, userIds } = splitMentions(payload.mentions)
    const mentionedUserIds = isTeamSession.value && !taskThreadAgentId.value ? userIds : []
    const mentionedMemberId = isTeamSession.value ? agentMemberIds[0] ?? taskThreadAgentId.value : undefined
    // 团队会话 @ 成员，或个人会话（沿用会话绑定 Agent）：发起 Run。
    if (mentionedMemberId || !isTeamSession.value) {
      const createdRun = await taskStore.startRunWithSessionFiles(thread.sessionId, {
        prompt: payload.prompt,
        attachments: payload.files,
        workspaceAgentMemberId: mentionedMemberId,
        mentionedUserIds,
      })
      taskStore.subscribe(createdRun.id)
      await router.replace(conversationPath(createdRun.id))
      payload.confirm?.()
      return
    }
    if (payload.files.length) {
      ElMessage.warning('带附件的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
      payload.release?.()
      return
    }
    await taskStore.postSessionMessage(thread.sessionId, payload.prompt, mentionedUserIds)
    payload.confirm?.()
    try {
      sessionThread.value = await taskStore.loadSessionThread(thread.sessionId)
      await nextTick(() => scrollToBottom())
    } catch {
      ElMessage.warning('讨论消息已发送，但会话刷新失败，请稍后手动刷新。')
    }
  } catch (error) {
    payload.release?.()
    notifyActionFailure('发送消息', `对话“${thread.title}”`, error, '检查输入后重试；已有讨论内容不会丢失。')
  }
}

/**
 * 加载共享线程更早一页并前置合并（评审中3）：服务端只回最近一页，
 * `messagesCursor` 是当前最旧一条消息的 id。合并期间若已切到别的会话，
 * 迟到响应直接丢弃。
 */
async function loadEarlierMessages() {
  const thread = sessionThread.value
  if (!thread?.hasMoreMessages || !thread.messagesCursor || loadingEarlierMessages.value) return
  loadingEarlierMessages.value = true
  try {
    const page = await taskStore.loadEarlierThreadMessages(thread.sessionId, thread.messagesCursor)
    const current = sessionThread.value
    if (!current || current.sessionId !== thread.sessionId) return
    sessionThread.value = {
      ...current,
      messages: [...page.messages, ...current.messages],
      hasMoreMessages: page.hasMoreMessages ?? false,
      messagesCursor: page.messagesCursor ?? null,
    }
  } catch (error) {
    notifyActionFailure('加载更早消息', `对话“${thread.title}”`, error, '稍后重试。')
  } finally {
    loadingEarlierMessages.value = false
  }
}

async function initializeConversation() {
  if (!isActiveConversationRoute.value || !routeTargetId.value) return
  await taskStore.load()
  const thread = await loadConversationTarget(routeTargetId.value)
  if (!isEmbeddedInWorkspace.value) {
    await loadAgentMembers(task.value?.workspaceId ?? thread?.workspaceId)
  }
  if (!isActiveConversationRoute.value || !routeTargetId.value) return
  await loadProjectTask(task.value?.workspaceId ?? thread?.workspaceId)
  await reconcileConversationRoute()
  syncTeamComposerBridge()
  void prefetchSessionRunArtifacts()
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
  if (!isActiveConversationRoute.value || !routeTargetId.value) return
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
/**
 * 当前目标「状态为最新」的水位线（二审残留）：每次开始解析目标时刷新。
 * 订阅空间 SSE 时作为 since 传入——目标加载到流建立之间归档的会话由
 * 服务端基线轮补推 session.archived。
 */
const contentSyncedAt = ref<string>(new Date().toISOString())
/** Run 详情暂时取不到（5xx/超时/断网）时的失败态：与「确实不存在」分开展示。 */
const targetLoadFailed = ref(false)

async function loadConversationTarget(id: string): Promise<SessionThread | null> {
  targetLoading.value = true
  contentSyncedAt.value = new Date().toISOString()
  try {
    let refreshError: unknown = null
    const run = await taskStore.refreshRun(id).catch((cause: unknown) => {
      refreshError = cause
      return null
    }) ?? taskStore.getTask(id) ?? null
    if (!run) {
      // 暂时性失败（网关 504、超时、断网、限流）不能落成「未找到对话」：那会让员工
      // 以为对话丢了。改成可重试的失败态；其余情形仍按原语义回退到会话线程
      // （旧链接可能本来就指向会话，也可能指向已删除的 Run）。
      if (refreshError && isTransientRequestError(refreshError)) {
        targetLoadFailed.value = true
        return null
      }
      return await loadSessionMode(id)
    }
    targetLoadFailed.value = false
    // 团队 Run 目标：Run 详情只含本轮消息，补拉共享线程让对话页保留完整历史。
    await loadRunSharedThread(run)
    return null
  } finally {
    targetLoading.value = false
  }
}

/**
 * 团队 Run 目标下的历史补拉：失败只降级为「仅本轮消息」，不阻断 Run 详情
 * （否则一次线程读取失败会把可读的执行详情也判成「未找到对话」）。
 */
async function loadRunSharedThread(run: TaskRun) {
  if (run.workspaceType !== 'team' || !run.sessionId) {
    sessionThread.value = null
    return
  }
  try {
    sessionThread.value = await taskStore.loadSessionThread(run.sessionId)
  } catch {
    sessionThread.value = null
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
    if (!isActiveConversationRoute.value || !id) return
    prefetchRunArtifactsEpoch++
    prefetchedRunArtifacts.clear()
    sessionThread.value = null
    threadMissing.value = false
    const thread = await loadConversationTarget(String(id))
    if (!isActiveConversationRoute.value || !routeTargetId.value) return
    if (!isEmbeddedInWorkspace.value) {
      await loadAgentMembers(task.value?.workspaceId ?? thread?.workspaceId)
    }
    await loadProjectTask(task.value?.workspaceId ?? thread?.workspaceId)
    await reconcileConversationRoute()
    syncTeamComposerBridge()
    void prefetchSessionRunArtifacts()
  },
)

watch(
  [
    () => sessionThread.value?.sessionId,
    () => task.value?.id,
    () => task.value?.status,
    canStop,
    stopping,
    canWriteSession,
    canFollowUp,
  ],
  () => syncTeamComposerBridge(),
  { immediate: true },
)

// 必须是多源写法（数组里放多个 getter），Vue 才会逐个元素比较；写成
// 「一个 getter 返回新数组」时按对象标识比较，任何一次 store 变更——包括本回调
// 自己触发的成果预拉取——都会被判成“变了”，从而把预拉取打成无限请求环。
watch(
  [
    () => task.value?.sessionId,
    () => sessionThread.value?.sessionId,
    () => conversationMessages.value.map(message => `${message.id}:${message.runId ?? ''}`).join('|'),
  ],
  () => { void prefetchSessionRunArtifacts() },
)

/**
 * TW-10 实时更新：当前目标属于团队空间时订阅空间会话活动流——其他成员的
 * 讨论消息、@ 触发或 Run 状态变化推送 `session.updated` 标记，线程视图刷新
 * 共享线程、Run 视图刷新 Run 详情（Run 详情同样包含会话级讨论消息）。
 * 同一空间多个消费者共享一条 SSE 连接（store 引用计数），个人空间不订阅。
 */
const streamWorkspaceId = computed(() => {
  if (sessionThread.value?.workspaceType === 'team') return sessionThread.value.workspaceId
  if (task.value?.workspaceType === 'team') return task.value.workspaceId
  return ''
})
const streamSessionId = computed(() => sessionThread.value?.sessionId ?? task.value?.sessionId ?? '')

let sessionRefreshTimer: ReturnType<typeof setTimeout> | undefined
let sessionRefreshInFlight = false
let sessionRefreshQueued = false

async function refreshSharedTarget() {
  if (sessionRefreshInFlight) {
    sessionRefreshQueued = true
    return
  }
  sessionRefreshInFlight = true
  try {
    // 团队 Run 目标同时持有线程与 Run 详情：线程带新的讨论消息，Run 带执行
    // 状态。两者都刷新，任一失败都不影响另一个已加载的视图。
    const thread = sessionThread.value
    if (thread) {
      try {
        sessionThread.value = await taskStore.loadSessionThread(thread.sessionId)
        if (isTaskThreadRoute.value) void taskDetail?.refresh()
      } catch {
        // 会话被删除或已失权：无 Run 详情时与初次加载同一口径落到「未找到对话」。
        sessionThread.value = null
        if (!task.value) threadMissing.value = true
      }
    }
    const currentTask = task.value
    if (currentTask) await taskStore.refreshRun(currentTask.id).catch(() => undefined)
  } finally {
    sessionRefreshInFlight = false
    if (sessionRefreshQueued) {
      sessionRefreshQueued = false
      void refreshSharedTarget()
    }
  }
}

watch(
  // 第二个元素是断线重连的通配标记（'*'）：SSE 重连后服务端不补推断开
  // 期间的变更，store 用 resync 标记通知所有订阅视图整体重取。
  () => [
    streamSessionId.value ? taskStore.sessionActivity[streamSessionId.value] : undefined,
    taskStore.sessionActivity['*'],
  ],
  ([marker, resync]) => {
    if (!marker && !resync) return
    if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer)
    sessionRefreshTimer = setTimeout(() => void refreshSharedTarget(), 150)
  },
)

watch(streamWorkspaceId, (workspaceId, previous) => {
  if (previous && previous !== workspaceId) taskStore.unsubscribeWorkspaceSessions(previous)
  if (workspaceId) taskStore.subscribeWorkspaceSessions(workspaceId, contentSyncedAt.value)
  // 缓存里已有团队 Run（从工作台最近对话/空间列表直接进入）时，挂载那一刻
  // 空间就已确定，非 immediate 的 watch 不会触发——团队对话会静默失去实时
  // 更新。首帧就按已确定的空间建订阅，空间变化仍走上面的换约分支。
}, { immediate: true })

onBeforeUnmount(() => {
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer)
  if (streamWorkspaceId.value) taskStore.unsubscribeWorkspaceSessions(streamWorkspaceId.value)
  if (teamComposerBridge) teamComposerBridge.value = createEmptyTeamComposerBridge()
})

watch(
  [() => routeTargetId.value, () => task.value?.messages.length, () => task.value?.status, () => sessionThread.value?.messages.length],
  async () => {
    await nextTick()
    if (!showJumpToLatest.value) scrollToBottom('smooth')
  },
)
</script>

<template>
  <div
    class="conversation-page"
    :class="{
      'conversation-page--embedded': isEmbeddedInWorkspace,
      'conversation-page--task': inTaskConversation,
      'conversation-page--previewing': Boolean(task && panelArtifact && previewDocked),
    }"
  >
    <div v-if="(taskStore.loading || targetLoading) && !task && !sessionThread && !threadMissing" class="conversation-state">
      <el-skeleton :rows="8" animated />
    </div>

    <template v-else-if="!task && sessionThread">
      <header v-if="!inTaskConversation" class="conversation-header">
        <div class="conversation-header__left">
          <button type="button" class="conversation-header__back" :aria-label="isTaskThreadRoute ? '返回任务对话' : '返回'" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <h1 v-if="!isTaskThreadRoute">{{ sessionThread.title }}</h1>
          <span class="conversation-skill"><span>发起人</span>{{ sessionThread.creatorName }}</span>
          <span v-if="projectTask && !isTaskThreadRoute" class="conversation-skill" data-testid="task-thread-badge"><span>任务</span>{{ projectTask.title }}</span>
        </div>
      </header>

      <main
        ref="conversationScroll"
        class="conversation-scroll"
        aria-label="对话内容"
        @scroll.passive="onConversationScroll"
      >
        <div class="conversation-thread">
          <button
            v-if="sessionThread.hasMoreMessages"
            type="button"
            data-testid="thread-load-earlier"
            class="thread-earlier"
            :disabled="loadingEarlierMessages"
            @click="loadEarlierMessages"
          >{{ loadingEarlierMessages ? '正在加载…' : '加载更早消息' }}</button>
          <template v-if="inTaskConversation">
            <template v-for="item in taskTimeline" :key="item.key">
              <details
                v-if="item.kind === 'message' && item.quiet"
                class="task-conversation-quiet"
                data-testid="task-conversation-quiet"
              >
                <summary class="task-conversation-record">
                  <span class="task-conversation-record__line" aria-hidden="true"></span>
                  <span>{{ formatTimelineTime(item.message.sentAt ?? '') }} · {{ item.message.agentName ?? taskAgentLabel }} · 无变化（展开）</span>
                  <span class="task-conversation-record__line" aria-hidden="true"></span>
                </summary>
                <div class="assistant-answer task-conversation-quiet__body">
                  <AssistantMessageContent :text="item.message.content" />
                </div>
              </details>
              <ConversationMessageItem
                v-else-if="item.kind === 'message'"
                class="conversation-message"
                data-testid="task-conversation-message"
                :message="item.message"
                :own="isOwnMessage(item.message)"
                :tag="messageTag(item.message)"
                :show-requester="false"
              >
                <template v-if="isLastRunReply(item.message)" #before>
                  <RunStepsDisclosure :run-id="item.message.runId!" />
                </template>
                <template v-if="isLastRunReply(item.message)">
                  <RunArtifactCards
                    :artifacts="threadArtifactsFor(item.message)"
                    :can-continue-editing="canContinueEditingInThread"
                    :referenced-file-ids="referencedArtifacts.map(reference => reference.fileId)"
                    :preview-key="previewKey"
                    @preview="openPreview"
                    @download="download"
                    @continue-editing="continueEditingInThread"
                  />
                  <div class="assistant-actions">
                    <button type="button" aria-label="复制回答" @click="copyAnswer(item.message.content)">
                      <el-icon><CopyDocument /></el-icon>
                    </button>
                  </div>
                </template>
              </ConversationMessageItem>
              <template v-else-if="item.kind === 'run'">
                <button
                  type="button"
                  class="task-conversation-record task-conversation-record--run"
                  :class="`task-conversation-record--${runRecordTone(item.run)}`"
                  data-testid="task-conversation-run"
                  :title="'查看执行详情'"
                  @click="openSessionRun(item.run.runId)"
                >
                  <span class="task-conversation-record__line" aria-hidden="true"></span>
                  <span>{{ formatTimelineTime(item.run.createdAt) }} · {{ runRecordText(item.run) }}</span>
                  <span class="task-conversation-record__line" aria-hidden="true"></span>
                </button>
                <RunProgressCard
                  v-if="liveRun(item.run.runId)"
                  :task="liveRun(item.run.runId)!"
                  @open-details="openSessionRun(item.run.runId)"
                />
              </template>
              <div v-else class="task-conversation-event" data-testid="task-conversation-event">
                <p class="task-conversation-record">
                  <span class="task-conversation-record__line" aria-hidden="true"></span>
                  <span>{{ formatTimelineTime(item.event.createdAt) }} · {{ eventText(item.event) }}</span>
                  <span class="task-conversation-record__line" aria-hidden="true"></span>
                </p>
                <div v-if="item.event.kind === 'completed' && (item.event.metadata.note || item.event.metadata.deliverables?.length)" class="task-conversation-completion">
                  <p v-if="item.event.metadata.note">{{ item.event.metadata.note }}</p>
                  <p v-if="item.event.metadata.deliverables?.length" class="task-conversation-completion__files">
                    交付文件：{{ item.event.metadata.deliverables.join('、') }}
                  </p>
                </div>
              </div>
            </template>
            <div v-if="taskNotStarted" class="task-conversation-start" data-testid="task-conversation-start">
              <div>
                <strong>还没有交给 {{ taskAgentLabel }}</strong>
                <span>在下方写补充要求并“交给 {{ taskAgentLabel }}”即开始执行；也可以直接开始。</span>
              </div>
              <el-button v-if="canStartFromConversation" type="primary" @click="startTaskFromConversation">开始执行</el-button>
            </div>
          </template>
          <template v-else>
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
                <ul
                  v-if="messageInputAttachments(message, firstUserMessageIdByRunInThread).length"
                  class="message-attachments"
                  data-testid="user-message-attachments"
                  aria-label="附带文件"
                >
                  <li
                    v-for="name in messageInputAttachments(message, firstUserMessageIdByRunInThread)"
                    :key="name"
                    class="message-attachment"
                    :title="name"
                  >
                    <el-icon><Document /></el-icon>
                    <span>{{ name }}</span>
                  </li>
                </ul>
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
          </template>
          <div class="conversation-end" aria-hidden="true"></div>
        </div>
      </main>

      <div v-if="showSessionComposerDock" class="conversation-composer-dock">
        <div class="conversation-composer-dock__inner">
          <p v-if="canWriteSession && taskThreadAgentName && !inTaskConversation" data-testid="task-thread-notice" class="conversation-task-thread-notice">
            回复会直接交给“{{ taskThreadAgentName }}”继续处理，无需 @；Agent 执行期间请等待完成或先停止。
          </p>
          <p v-if="projectTaskError" class="conversation-task-thread-notice" role="alert" data-testid="task-thread-error">
            任务信息读取失败：{{ projectTaskError }}
            <el-button link type="primary" @click="reloadProjectTask">重试</el-button>
          </p>
          <div v-if="canWriteSession && inTaskConversation" class="task-conversation-modes" data-testid="task-conversation-modes">
            <div v-if="isAgentTaskConversation" class="task-conversation-modes__switch" role="radiogroup" aria-label="发送方式">
              <button
                type="button"
                role="radio"
                data-testid="task-send-agent"
                :aria-checked="effectiveSendMode === 'agent'"
                :disabled="threadHasActiveRun || agentTaskDone"
                :class="{ 'is-active': effectiveSendMode === 'agent' }"
                @click="sendMode = 'agent'"
              >
                交给 {{ taskAgentLabel }}
              </button>
              <button
                type="button"
                role="radio"
                data-testid="task-send-comment"
                :aria-checked="effectiveSendMode === 'comment'"
                :class="{ 'is-active': effectiveSendMode === 'comment' }"
                @click="sendMode = 'comment'"
              >
                仅评论
              </button>
            </div>
            <span class="task-conversation-modes__hint" data-testid="task-send-hint">
              <template v-if="isEmployeeTaskConversation">发言对空间成员可见，不会触发 Agent</template>
              <template v-else-if="threadHasActiveRun">{{ taskAgentLabel }} 执行中，暂时只能评论</template>
              <template v-else-if="agentTaskDone">任务已完成，暂时只能评论</template>
              <template v-else-if="effectiveSendMode === 'agent'">{{ taskNotStarted ? '发送即开始执行' : '发送后交给 Agent 继续处理' }}</template>
              <template v-else>评论对空间成员可见，不会触发 Agent</template>
            </span>
            <el-button
              v-if="canCompleteFromConversation"
              class="task-conversation-modes__complete"
              data-testid="task-complete-from-conversation"
              type="success"
              plain
              size="small"
              @click="taskDetail?.openComplete()"
            >
              标记完成
            </el-button>
          </div>
          <div
            v-if="canWriteSession && inTaskConversation && referencedArtifacts.length"
            class="referenced-artifacts"
            data-testid="referenced-artifacts"
          >
            <span>引用成果</span>
            <el-tag
              v-for="item in referencedArtifacts"
              :key="item.fileId"
              closable
              effect="plain"
              @close="removeReferencedArtifact(item.fileId)"
            >
              {{ item.name }} · V{{ item.version }}
            </el-tag>
          </div>
          <TaskComposer
            v-if="canWriteSession && (!isEmbeddedInWorkspace || inTaskConversation)"
            compact
            :initial-workspace-id="streamWorkspaceId"
            :mention-options="isTeamSession && !inTaskConversation ? mentionOptions : []"
            :files-require-mention="isTeamSession && !taskThreadAgentId && !inTaskConversation"
            :placeholder="inTaskConversation ? taskComposerPlaceholder : undefined"
            @submit="submitSessionMessage"
          />
          <p v-else-if="sessionArchived" data-testid="conversation-archived-notice" class="conversation-archived-notice">
            该空间已归档，仅保留有权限的只读查看与下载；无法发言或发起执行。
          </p>
          <p v-else-if="sessionReadOnly" data-testid="conversation-readonly-notice" class="conversation-archived-notice">
            当前角色为只读成员，仅可查看讨论内容。
          </p>
          <p
            v-if="showTeamComposerShortcutHint && canWriteSession"
            class="conversation-composer-hint"
            data-testid="team-composer-shortcut-hint"
          >
            {{ TEAM_COMPOSER_SHORTCUT_HINT }}
          </p>
          <p>AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
        </div>
      </div>

      <ArtifactPreviewPanel
        v-if="inTaskConversation"
        class="conversation-preview"
        :artifact="panelArtifact"
        :docked="previewDocked"
        @close="closePreview"
      />
    </template>

    <el-result
      v-else-if="!task"
      class="conversation-state"
      :icon="targetLoadFailed ? 'error' : 'warning'"
      :title="targetLoadFailed ? '对话加载失败' : '未找到对话'"
      :sub-title="targetLoadFailed
        ? '工作台暂时没能取回这个对话，通常是网络或服务繁忙。稍后点「重新加载」即可，对话内容不会丢失。'
        : '该对话可能已从历史中移除，或当前账号无权访问。文件和成果按保留策略独立管理。'"
    >
      <template #extra>
        <el-button
          v-if="targetLoadFailed"
          type="primary"
          :loading="targetLoading"
          @click="initializeConversation"
        >
          重新加载
        </el-button>
        <el-button
          :type="targetLoadFailed ? 'default' : 'primary'"
          @click="isEmbeddedInWorkspace ? router.push(`/workspaces/${embeddedWorkspaceId}`) : router.push('/workbench')"
        >
          {{ isEmbeddedInWorkspace ? '返回工作空间' : '返回工作台' }}
        </el-button>
      </template>
    </el-result>

    <template v-else>
      <header class="conversation-header">
        <div class="conversation-header__left">
          <button type="button" class="conversation-header__back" :aria-label="isTaskThreadRoute ? '返回任务对话' : '返回'" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <template v-if="!isTaskThreadRoute">
            <h1>{{ task.title }}</h1><span v-if="currentWorkspace?.type === 'team'">团队：{{ currentWorkspace.name }}</span>
          </template>
          <span v-if="task.skill" class="conversation-skill">
            <span>Skill</span>{{ task.skill.name }} · v{{ task.skill.version }}
          </span>
        </div>
        <div class="conversation-header__actions">
          <span v-if="projectTask && !isTaskThreadRoute" class="conversation-skill" data-testid="task-thread-badge"><span>任务</span>{{ projectTask.title }}</span>
          <StatusTag :status="task.status" dot />
          <el-button text :icon="DataLine" @click="detailsOpen = true">
            <span class="header-action-label">对话详情</span>
          </el-button>
          <el-button text data-testid="export-session" @click="exportSessionTranscript">
            <span class="header-action-label">导出完整会话</span>
          </el-button>
          <el-button text data-testid="export-run" @click="exportCurrentRunTranscript">
            <span class="header-action-label">导出本次 Run</span>
          </el-button>
          <el-button
            v-if="canRetry"
            text
            :icon="RefreshRight"
            aria-label="重新执行本轮"
            :loading="retrying"
            :disabled="retrying"
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
          <button
            v-if="sessionThread?.hasMoreMessages"
            type="button"
            data-testid="thread-load-earlier"
            class="thread-earlier"
            :disabled="loadingEarlierMessages"
            @click="loadEarlierMessages"
          >{{ loadingEarlierMessages ? '正在加载…' : '加载更早消息' }}</button>
          <article
            v-for="message in conversationMessages"
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
                <ul
                  v-if="messageInputAttachments(message, firstUserMessageIdByRun).length"
                  class="message-attachments"
                  data-testid="user-message-attachments"
                  aria-label="附带文件"
                >
                  <li
                    v-for="name in messageInputAttachments(message, firstUserMessageIdByRun)"
                    :key="name"
                    class="message-attachment"
                    :title="name"
                  >
                    <el-icon><Document /></el-icon>
                    <span>{{ name }}</span>
                  </li>
                </ul>
              </div>
            </template>

            <template v-else>
              <RunProgressSummary
                v-if="isTerminalRun && task && message.id === firstCurrentRunAssistantMessageId"
                :task="task"
              />
              <div class="assistant-identity">
                <span class="assistant-avatar">{{ (message.agentName ?? 'dsh-work').slice(0, 1) }}</span>
                <div>
                  <strong>{{ message.agentName ?? 'dsh-work' }}</strong>
                  <span v-if="message.id === lastAssistantMessageId && belongsToCurrentRun(message) && isTerminalRun">
                    {{ resultOutcomeLabels[task.result.outcome] }}{{ task.duration ? ` · ${task.duration}` : '' }}
                  </span>
                  <span v-else>
                    {{ message.createdAt }}
                    <template v-if="message.runRequesterName"> · 由 {{ message.runRequesterName }} 发起</template>
                  </span>
                </div>
              </div>

              <div class="assistant-answer">
                <AssistantMessageContent :text="message.content" />

                <RunArtifactCards
                  :artifacts="messageArtifacts(message)"
                  :can-continue-editing="canFollowUp && belongsToCurrentRun(message)"
                  :referenced-file-ids="referencedArtifacts.map(item => item.fileId)"
                  :preview-key="previewKey"
                  @preview="openPreview"
                  @download="download"
                  @continue-editing="continueEditing"
                />

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

          <RunProgressCard
            v-if="['queued', 'running'].includes(task.status)"
            :task="task"
            @open-details="detailsOpen = true"
          />

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
              <div v-if="canResolveApproval" class="conversation-notice__actions">
                <el-button type="primary" :loading="resolvingApproval" @click="resolveApproval('approved')">
                  允许本次
                </el-button>
                <el-button :disabled="resolvingApproval" @click="resolveApproval('rejected')">
                  拒绝
                </el-button>
              </div>
            </div>
            <StatusTag status="awaiting_approval" label="等待确认" />
          </section>

          <section
            v-if="task.result.error"
            class="conversation-notice error-notice"
            data-testid="run-failure-notice"
            role="alert"
          >
            <span class="conversation-notice__icon"><el-icon><Close /></el-icon></span>
            <div>
              <strong>{{ task.result.error.message }}</strong>
              <dl>
                <div><dt>对象</dt><dd>{{ task.result.error.object }}</dd></div>
                <div>
                  <dt>原因</dt>
                  <dd
                    class="error-notice__reason"
                    :class="{ 'error-notice__reason--detail': runFailureDetail }"
                    data-testid="run-failure-reason"
                  >
                    {{ runFailureDetail || task.result.error.reason }}
                  </dd>
                </div>
              </dl>
              <p><strong>下一步：</strong>{{ task.result.error.suggestion }}</p>
              <p v-if="teamRunMissingPinnedAgent" class="error-notice__hint" data-testid="run-retry-requires-mention">
                此运行无法使用「重新执行本轮」。请在下方输入框重新 @Agent 发起执行。
              </p>
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
              :loading="retrying"
              :disabled="retrying"
              @click="retryRun"
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

          <div class="conversation-end" aria-hidden="true"></div>
        </div>
      </main>

      <div v-if="showRunComposerDock" class="conversation-composer-dock">
        <button
          v-if="showJumpToLatest"
          class="jump-latest"
          type="button"
          @click="scrollToBottom()"
        >
          回到最新消息
          <el-icon><ArrowDown /></el-icon>
        </button>
        <div v-if="isTaskThreadRoute" class="conversation-composer-dock__inner" data-testid="run-view-task-return">
          <p class="conversation-task-thread-notice">
            这里是单次执行的详情。补充要求或评论请回到任务对话发言。
            <el-button link type="primary" data-testid="run-view-back-to-task" @click="goBack">返回任务对话</el-button>
          </p>
          <p>AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
        </div>
        <div v-else class="conversation-composer-dock__inner">
          <div
            v-if="canFollowUp && referencedArtifacts.length"
            class="referenced-artifacts"
            data-testid="referenced-artifacts"
          >
            <span>引用成果</span>
            <el-tag
              v-for="item in referencedArtifacts"
              :key="item.fileId"
              closable
              effect="plain"
              @close="removeReferencedArtifact(item.fileId)"
            >
              {{ item.name }} · V{{ item.version }}
            </el-tag>
          </div>
          <p v-if="canFollowUp && taskThreadAgentName" data-testid="task-thread-notice" class="conversation-task-thread-notice">
            回复会直接交给“{{ taskThreadAgentName }}”继续处理，无需 @；Agent 执行期间请等待完成或先停止。
          </p>
          <p v-if="projectTaskError" class="conversation-task-thread-notice" role="alert" data-testid="task-thread-error">
            任务信息读取失败：{{ projectTaskError }}
            <el-button link type="primary" @click="reloadProjectTask">重试</el-button>
          </p>
          <TaskComposer :show-workspace-context="currentWorkspace?.type === 'team'" @open-files="router.push('/files')"
            v-if="canFollowUp && !isEmbeddedInWorkspace"
            compact
            :initial-workspace-id="streamWorkspaceId"
            :running="canStop"
            :stopping="stopping"
            :mention-options="isTeamSession ? mentionOptions : []"
            :files-require-mention="isTeamSession && !taskThreadAgentId"
            @submit="submitFollowUp"
            @stop="stopCurrentRun"
          />
          <p v-else-if="workspaceArchived" data-testid="conversation-archived-notice" class="conversation-archived-notice">
            该空间已归档，仅保留有权限的只读查看与下载；无法续写或重试。
          </p>
          <p v-else-if="isRunViewer" data-testid="conversation-readonly-notice" class="conversation-archived-notice">
            当前角色为只读成员，仅可查看讨论内容。
          </p>
          <p
            v-if="showTeamComposerShortcutHint && canFollowUp"
            class="conversation-composer-hint"
            data-testid="team-composer-shortcut-hint"
          >
            {{ TEAM_COMPOSER_SHORTCUT_HINT }}
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
            <div v-if="currentWorkspace?.type === 'team'"><dt>团队归属</dt><dd>{{ currentWorkspace.name }}</dd></div>
            <div><dt>会话</dt><dd class="mono">{{ task.sessionId }}</dd></div>
            <div><dt>运行</dt><dd class="mono">{{ task.id }}</dd></div>
            <div><dt>Agent</dt><dd class="mono">{{ task.agentVersion }}</dd></div>
          </dl>
        </section>

        <section class="drawer-section" data-testid="run-result-section">
          <h2>结果核验</h2>
          <div class="result-verification">
            <p class="result-verification__head">
              <StatusTag :status="task.result.outcome" :label="resultOutcomeLabels[task.result.outcome]" dot />
              <StatusTag :status="task.result.execution === 'cancel_requested' ? 'running' : task.result.execution === 'waiting' ? 'awaiting_approval' : task.result.execution" />
            </p>
            <p>{{ task.result.summary }}</p>
            <ul v-if="task.result.pendingItems.length" class="result-pending">
              <li v-for="item in task.result.pendingItems" :key="item.kind">{{ item.message }}</li>
            </ul>
            <dl v-if="task.result.receipts.length" class="result-receipts">
              <div v-for="receipt in task.result.receipts" :key="`${receipt.kind}-${receipt.ref ?? receipt.label}`">
                <dt><StatusTag :status="receipt.status" /></dt>
                <dd>{{ receipt.label }}<code v-if="receipt.ref" class="mono">{{ receipt.ref }}</code></dd>
              </div>
            </dl>
            <dl class="run-facts">
              <div><dt>声明成果</dt><dd>{{ task.result.evidence.artifactsClaimed ?? '未上报' }}</dd></div>
              <div><dt>登记成果</dt><dd>{{ task.result.evidence.artifactsRegistered }}</dd></div>
              <div v-if="task.result.evidence.toolCalls !== null"><dt>工具调用</dt><dd data-testid="tool-call-facts">{{ task.result.evidence.toolCalls }}<template v-if="task.result.evidence.toolFailures">（失败 {{ task.result.evidence.toolFailures }}，原因见执行步骤）</template></dd></div>
              <div v-if="task.result.evidence.inputTokens !== null || task.result.evidence.outputTokens !== null">
                <dt>Token</dt>
                <dd>{{ task.result.evidence.inputTokens ?? 0 }} 入 / {{ task.result.evidence.outputTokens ?? 0 }} 出</dd>
              </div>
            </dl>
          </div>
        </section>

        <section class="drawer-section">
          <h2>本轮执行步骤</h2>
          <RunTimeline :steps="task.steps" />
        </section>

        <section class="drawer-section">
          <h2>数据来源</h2>
          <div v-if="task.result.sources.length" class="source-list">
            <article v-for="source in task.result.sources" :key="source.id">
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
          <div v-if="task.result.artifacts.length" class="drawer-artifacts">
            <div
              v-for="artifact in task.result.artifacts"
              :key="artifact.id"
              class="drawer-artifact-row"
            >
              <button
                type="button"
                class="drawer-artifact-row__open"
                data-testid="drawer-artifact-preview"
                @click="openPreview(artifact)"
              >
                <el-icon><Document /></el-icon>
                <span><strong>{{ artifact.name }}</strong><small>{{ artifact.size }}</small></span>
              </button>
              <button
                type="button"
                class="drawer-artifact-row__download"
                data-testid="drawer-artifact-download"
                @click="download(artifact)"
              >
                下载
              </button>
            </div>
          </div>
          <el-empty v-else :image-size="56" description="本轮暂未生成成果" />
        </section>
      </el-drawer>

      <ArtifactPreviewPanel
        class="conversation-preview"
        :artifact="panelArtifact"
        :docked="previewDocked"
        @close="closePreview"
      />

    </template>
    <ArtifactPreviewDialog
      v-if="previewOpen && previewArtifact"
      v-model:open="previewOpen"
      :artifact="previewArtifact"
    />
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

/* EX-ARTIFACT-08：成果预览右栏与对话并排，标题栏、对话与输入区让出右栏宽度。 */
.conversation-page--previewing {
  --conversation-preview-width: clamp(380px, 36vw, 520px);
}

.conversation-page--previewing .conversation-header,
.conversation-page--previewing .conversation-composer-dock {
  right: var(--conversation-preview-width);
}

.conversation-page--previewing .conversation-scroll {
  margin-right: var(--conversation-preview-width);
}

.conversation-page > .conversation-preview {
  position: absolute;
  z-index: 13;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--conversation-preview-width);
}

/* TW-10 空间内嵌套：高度收敛到空间页对话面板，底栏由空间页承载。 */
.conversation-page--embedded {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.conversation-page--embedded .conversation-header {
  position: static;
  flex: 0 0 auto;
}

.conversation-page--embedded .conversation-scroll {
  min-height: 0;
  flex: 1;
  height: auto;
  padding: 12px 20px 10px;
}

.conversation-page--embedded .conversation-thread {
  min-height: 0;
}

.conversation-page--task .conversation-scroll {
  padding-top: 8px;
}

.conversation-page--task .conversation-thread {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 18px;
  width: min(100%, 760px);
}

.task-conversation-tag {
  padding: 0 6px;
  border-radius: 5px;
  color: #6b6f6c;
  background: #f1f2f3;
  font-size: var(--dsh-font-size-micro);
  line-height: 18px;
}

.task-conversation-quiet > summary {
  cursor: pointer;
  list-style: none;
}

.task-conversation-quiet > summary::-webkit-details-marker {
  display: none;
}

.task-conversation-quiet__body {
  margin: 10px 0 0 34px;
}

.task-conversation-record {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  color: #8a8e8b;
  background: transparent;
  font: inherit;
  font-size: var(--dsh-font-size-micro);
  text-align: center;
}

.task-conversation-record__line {
  height: 1px;
  flex: 1 1 auto;
  background: #eeeff0;
}

.task-conversation-record--run {
  cursor: pointer;
}

.task-conversation-record--run:hover span:not(.task-conversation-record__line) {
  text-decoration: underline;
}

.task-conversation-record--run:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: 2px;
  border-radius: 4px;
}

.task-conversation-record--success {
  color: #1f8a4c;
}

.task-conversation-record--danger {
  color: var(--dsh-color-danger);
}

.task-conversation-record--active {
  color: #2f6bdc;
}

.task-conversation-completion {
  margin: 8px auto 0;
  max-width: 560px;
  padding: 10px 14px;
  border: 1px solid #cfe6d8;
  border-radius: 10px;
  color: #2c2f2d;
  background: #f2faf5;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
  white-space: pre-wrap;
}

.task-conversation-completion p {
  margin: 0;
}

.task-conversation-completion__files {
  color: #4b4f4c;
  font-size: var(--dsh-font-size-micro);
}

.task-conversation-start {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  border: 1px dashed #d9dbde;
  border-radius: 12px;
}

.task-conversation-start > div {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
}

.task-conversation-start span {
  color: #6b6f6c;
  font-size: var(--dsh-font-size-micro);
}

.task-conversation-modes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.task-conversation-modes__switch {
  display: inline-flex;
  padding: 3px;
  border-radius: 9px;
  background: #f2f3f4;
}

.task-conversation-modes__switch button {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  color: #6b6f6c;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: var(--dsh-font-size-micro);
}

.task-conversation-modes__switch button.is-active {
  color: #1d201e;
  background: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
  font-weight: 600;
}

.task-conversation-modes__switch button:disabled {
  color: #a6a9ad;
  cursor: not-allowed;
}

.task-conversation-modes__switch button:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: 1px;
}

.task-conversation-modes__hint {
  color: #8a8e8b;
  font-size: var(--dsh-font-size-micro);
}

.task-conversation-modes__complete {
  margin-left: auto;
}

.conversation-page--embedded .conversation-composer-dock {
  position: static;
  flex: 0 0 auto;
  padding: 8px 20px 12px;
  background: #fff;
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

/* 用户附件挂在气泡顶部，视觉与 Agent 成果卡片一致，但不提供操作按钮。 */
.user-message .user-message-attachments.answer-artifacts {
  justify-content: flex-start;
  margin-top: 0;
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid #eef0ee;
}

.user-message .answer-artifact {
  width: fit-content;
  max-width: 100%;
}

.user-message .answer-artifact__card {
  display: grid;
  width: fit-content;
  max-width: min(100%, 22rem);
  grid-template-columns: 30px minmax(0, auto);
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #e2e4e1;
  border-radius: 10px;
  color: #4c514c;
  background: #fafbfa;
}

.user-message .answer-artifact__card > span:first-child {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 8px;
  color: #356858;
  background: #eaf4f0;
}

.user-message .answer-artifact__card > span:nth-child(2) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.user-message .answer-artifact__card strong {
  overflow: hidden;
  max-width: 16rem;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.thread-earlier {
  display: block;
  margin: 0 auto 18px;
  padding: 5px 14px;
  border: 1px solid #dfe4df;
  border-radius: 999px;
  color: #4f5751;
  background: #f6f8f6;
  font-size: var(--dsh-font-size-micro);
  cursor: pointer;
}

.thread-earlier:disabled {
  cursor: default;
  opacity: 0.6;
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

.answer-artifact {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.answer-artifact__revise {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border: 1px solid #e2e4e1;
  border-radius: 10px;
  color: #356858;
  background: #fafbfa;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
  white-space: nowrap;
}

.answer-artifact__revise:hover:not(:disabled) {
  border-color: #bdcbc5;
  background: #f5f8f6;
}

.answer-artifact__revise:disabled {
  color: #8a908a;
  cursor: default;
}

.referenced-artifacts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: #6b716b;
  font-size: var(--dsh-font-size-badge);
}

.answer-artifact__open {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  align-items: center;
  min-width: 200px;
  flex: 1 1 auto;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #e2e4e1;
  border-radius: 10px;
  color: #4c514c;
  background: #fafbfa;
  cursor: pointer;
  text-align: left;
}

.answer-artifact__open:hover {
  border-color: #bdcbc5;
  background: #f5f8f6;
}

.answer-artifact__open > span:first-child {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 8px;
  color: #356858;
  background: #eaf4f0;
}

.answer-artifact__open > span:nth-child(2) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.answer-artifact__download {
  flex: 0 0 auto;
  padding: 8px 12px;
  border: 1px solid #e2e4e1;
  border-radius: 10px;
  color: #356858;
  background: #fafbfa;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
  white-space: nowrap;
}

.answer-artifact__download:hover {
  border-color: #bdcbc5;
  background: #f5f8f6;
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

.error-notice__reason {
  margin: 0;
  color: #5c3036;
  line-height: 1.55;
}

.error-notice__reason--detail {
  color: #7a1f2c;
  font-size: var(--dsh-font-size-subheading);
  font-weight: 650;
}

.error-notice__hint {
  margin: 8px 0 0;
  color: #7a1f2c;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.55;
}

.error-notice code {
  display: inline-block;
  margin-top: 7px;
  color: #9b3c47;
  font-size: var(--dsh-font-size-micro);
}

.verify-notice {
  border-color: #f0d9b5;
  background: #fffaf1;
}

.verify-notice .conversation-notice__icon {
  color: #a14506;
  background: #ffe9c7;
}

.verify-notice--neutral {
  border-color: #e3e7ed;
  background: #f7f8fa;
}

.verify-notice--neutral .conversation-notice__icon {
  color: #667085;
  background: #eceef1;
}

.result-verification > p {
  margin: 6px 0 0;
  color: #55504a;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.result-verification__head {
  display: flex;
  gap: 8px;
  align-items: center;
}

.result-pending {
  margin: 8px 0 0;
  padding-left: 18px;
  color: #a14506;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.result-receipts {
  margin: 10px 0 0;
  border-top: 1px dashed #e8e2d9;
  padding-top: 10px;
}

.result-receipts div {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 6px;
}

.result-receipts dt,
.result-receipts dd {
  margin: 0;
  font-size: var(--dsh-font-size-micro);
}

.result-receipts dd {
  color: #55504a;
}

.result-receipts code {
  display: block;
  color: #9b8a74;
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

.conversation-composer-hint {
  margin: 0;
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.5;
  text-align: center;
}

.conversation-composer-dock__inner > p {
  margin: 7px 0 0;
  color: #aaada9;
  font-size: var(--dsh-font-size-micro);
  text-align: center;
}

/* 归档只读态：以提示替代续写输入，避免提交后才被服务端拒绝（design §2.7）。 */
.conversation-composer-dock__inner > p.conversation-task-thread-notice {
  margin: 0 0 8px;
  padding: 6px 10px;
  border: 1px solid #e3e6e4;
  border-radius: 8px;
  color: #5c605d;
  background: #f7f8f7;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.5;
}

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

.drawer-artifact-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.drawer-artifact-row__open {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
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

.drawer-artifact-row__download {
  flex: 0 0 auto;
  padding: 10px 12px;
  border: 1px solid #e5e7e4;
  border-radius: 9px;
  color: #48695e;
  background: #fff;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
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


  .assistant-answer:not(.user-message) .answer-artifact {
    width: 100%;
  }

  .answer-artifact__open {
    flex: 1;
    min-width: 0;
  }
}
</style>
