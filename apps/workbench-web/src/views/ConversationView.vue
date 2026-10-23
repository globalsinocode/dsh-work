<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { projectTaskDetailKey } from '@/composables/project-task-detail'
import { spaceView, useSpaceRoutes } from '@/composables/space-routes'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowDown,
  ArrowLeft,
  DataLine,
  Document,
  RefreshRight,
} from '@element-plus/icons-vue'

import { AssistantMessageContent, RunTimeline, StatusTag } from '@dsh-work/ui-core'
import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { ProjectTask, ProjectTaskEvent, SessionThread, SessionThreadMessage, TaskSource, TeamMemberRole, WorkspaceAgentMember } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import { notifyActionFailure } from '@/utils/feedback'
import { continueChoice, type ContinueChoice } from '@/utils/continue-intent'
import { scheduleLabel, scheduleReasonLabel } from '@/utils/project-task-schedule'
import ConversationMessageItem from '@/components/conversation/ConversationMessageItem.vue'
import RunComposer from '@/components/conversation/RunComposer.vue'
import RunMessageList from '@/components/conversation/RunMessageList.vue'
import SessionDiscussionList from '@/components/conversation/SessionDiscussionList.vue'
import { useRunActions } from '@/composables/useRunActions'
import { resultOutcomeLabels, useRunProgress } from '@/composables/useRunProgress'
import '@/styles/conversation-thread.css'

const route = useRoute()
const router = useRouter()
const taskStore = useTaskStore()
const authStore = useAuthStore()
const contentStore = useContentStore()

const detailsOpen = ref(false)
const conversationScroll = ref<HTMLElement>()
const showJumpToLatest = ref(false)

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
const spaceRoutes = useSpaceRoutes()
const isTaskThreadRoute = computed(() => spaceView(route) === 'task-thread')
const isEmbeddedInWorkspace = computed(() =>
  spaceView(route) === 'conversation' || isTaskThreadRoute.value)
const embeddedWorkspaceId = computed(() =>
  isEmbeddedInWorkspace.value ? String(route.params.id) : '')
const routeTargetId = computed(() =>
  isEmbeddedInWorkspace.value ? String(route.params.conversationId) : String(route.params.id))

function conversationPath(target: string) {
  if (isTaskThreadRoute.value) {
    return spaceRoutes.taskThread(embeddedWorkspaceId.value, String(route.params.taskId), target)
  }
  return isEmbeddedInWorkspace.value
    ? spaceRoutes.conversation(embeddedWorkspaceId.value, target)
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
const canStop = computed(() => Boolean(
  task.value && canOperateRun.value
  && ['queued', 'running', 'awaiting_approval'].includes(task.value.status),
))
const canRetry = computed(() => Boolean(
  task.value && canOperateRun.value
  && ['failed', 'cancelled'].includes(task.value.status)
  && !task.value.result.pendingItems.some(item => item.kind === 'external_effect_unknown')
  && (task.value.result.error?.retryable ?? true)))
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

/**
 * 项目空间 S1：当前线程若是 Agent 任务线程，回复默认交给承接 Agent，无需 @；
 * 服务端同样按任务线程固定承接 Agent，这里只决定输入框的默认行为与提示。
 */
const projectTask = ref<ProjectTask | null>(null)
const currentSessionId = computed(() => task.value?.sessionId ?? sessionThread.value?.sessionId ?? null)
const taskThreadAgentId = computed(() =>
  projectTask.value?.assignee.type === 'agent' ? projectTask.value.assignee.agentMemberId : undefined)
const taskThreadAgentName = computed(() =>
  projectTask.value?.assignee.type === 'agent' ? projectTask.value.assignee.name : '')
const markingAsTask = ref(false)
const projectTaskLoading = ref(false)
const projectTaskError = ref('')
/** 已经过 @Agent 执行、但还不是任务的团队线程，可由非只读成员设为任务。 */
const canMarkAsTask = computed(() => {
  if (!isTeamSession.value || projectTask.value || !currentSessionId.value) return false
  if (task.value) return canOperateRun.value
  return canWriteSession.value && (sessionThread.value?.runs.length ?? 0) > 0
})

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
    // 按线程精确查找：任务较多时，较早任务的线程不在列表第一页。
    const page = await workbenchApi.listProjectTasks(workspaceId, { sessionId, limit: 1 })
    if (currentSessionId.value !== sessionId) return
    projectTask.value = page.items.find(item => item.sessionId === sessionId) ?? null
    // 任务线程统一在所属任务的详情里打开（“任务”页签）：从历史、侧栏等入口进入“对话”页签时归位。
    if (projectTask.value && spaceView(route) === 'conversation') {
      await router.replace(spaceRoutes.taskThread(workspaceId, projectTask.value.id, routeTargetId.value))
    }
  } catch (error) {
    // 旧会话的失败不能写到新会话上；新会话的加载状态也不能被旧请求提前结束。
    if (currentSessionId.value !== sessionId) return
    projectTask.value = null
    projectTaskError.value = error instanceof Error ? error.message : '任务线程信息读取失败'
  } finally {
    if (currentSessionId.value === sessionId) projectTaskLoading.value = false
  }
}

/** 任务线程信息读取失败后手动重试。 */
function reloadProjectTask() {
  const workspaceId = task.value?.workspaceId ?? sessionThread.value?.workspaceId ?? currentWorkspace.value?.id
  void loadProjectTask(workspaceId)
}

async function markAsTask() {
  const workspaceId = task.value?.workspaceId ?? sessionThread.value?.workspaceId
  const sessionId = currentSessionId.value
  if (!workspaceId || !sessionId || markingAsTask.value) return
  markingAsTask.value = true
  try {
    const marked = await workbenchApi.markSessionAsProjectTask(workspaceId, sessionId)
    projectTask.value = marked
    ElMessage.success('已设为任务')
    // 任务线程在所属任务的详情里继续（“任务”页签），与任务信息和操作放在一起。
    if (!isTaskThreadRoute.value) {
      await router.replace(spaceRoutes.taskThread(workspaceId, marked.id, routeTargetId.value))
    }
  } catch (error) {
    notifyActionFailure('设为任务', '当前线程', error, '确认该线程已由 Agent 执行过且尚未设为任务后重试。')
  } finally {
    markingAsTask.value = false
  }
}

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
const { quietLabel } = useRunProgress(task)

const sourceTypeLabels: Record<TaskSource['type'], string> = {
  knowledge: '企业知识',
  erp: '业务系统',
  mes: '生产系统',
  file: '上传文件',
}


function goBack() {
  // 任务详情内的执行详情：返回任务对话（会话视图）。
  if (isTaskThreadRoute.value) {
    const sessionId = task.value?.sessionId ?? sessionThread.value?.sessionId
    void router.push(sessionId ? conversationPath(sessionId) : spaceRoutes.task(embeddedWorkspaceId.value, String(route.params.taskId)))
    return
  }
  // 嵌入态的返回固定归位到所属空间页（线程返回控件回到列表）：外部旧链接
  // 经 replace 归位后，router.back() 会跳出空间上下文，不能依赖历史栈。
  if (isEmbeddedInWorkspace.value) {
    void router.push(spaceRoutes.home(embeddedWorkspaceId.value))
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

const {
  stopping,
  stopRun: stopCurrentRun,
  retryRun,
  copyAnswer,
  copyConversationLink,
  download,
  referencedArtifacts,
  continueEditing,
  removeReferencedArtifact,
} = useRunActions(task, {
  canOperate: canOperateRun,
  onRetried: async next => { await router.replace(conversationPath(next.id)) },
})

function openSessionRun(runId: string) {
  void router.push(conversationPath(runId))
}

// ---------------------------------------------------------------------------
// 项目空间 S3：任务详情内的任务对话（会话视图）
// ---------------------------------------------------------------------------

/** 任务详情经 provide 提供的任务、事件与写动作；不在任务详情内时为 null。 */
const taskDetail = inject(projectTaskDetailKey, null)
/** 任务详情内的任务对话（会话视图）；执行详情（Run 视图）不算。 */
const inTaskConversation = computed(() => isTaskThreadRoute.value && !task.value && Boolean(sessionThread.value))
const conversationTask = computed(() => taskDetail?.task.value ?? projectTask.value)
const isAgentTaskConversation = computed(() => inTaskConversation.value && conversationTask.value?.assignee.type === 'agent')
const isEmployeeTaskConversation = computed(() => inTaskConversation.value && conversationTask.value?.assignee.type === 'employee')
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
/** S4：两类任务都可在对话中“标记完成”。 */
const canCompleteFromConversation = computed(() =>
  inTaskConversation.value && conversationTask.value?.status !== 'done' && Boolean(taskDetail?.can('complete')))
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

/**
 * 任务对话时间线：消息按原顺序；每次执行的记录紧跟在发起它的那条消息之后；其余执行记录与
 * 任务事件（员工任务的状态推进、完成、改派）按时间插入。
 */
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
    // 定时执行的固定提示不是成员发言，由“定时执行”记录代替；没有新进展的回复折叠为一行。
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
  // S4：执行规则与定时执行的系统记录；定时类记录的 actor 只是归因人，不展示。
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

/** 任务对话的首条消息是任务标题与说明（创建任务时写入），不算评论。 */
const briefMessageId = computed(() =>
  sessionThread.value && !sessionThread.value.hasMoreMessages ? sessionThread.value.messages[0]?.id ?? null : null)

/** 消息旁的标记：Agent 任务里不交给 Agent 的发言是“评论”；员工任务里负责人的发言标“负责人”。 */
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

/** 任务对话的发送：按发送方式交给 Agent 或发表评论，停留在任务对话中。 */
async function submitTaskConversation(
  sessionId: string,
  payload: { prompt: string; files: File[]; confirm?: () => void },
) {
  const title = conversationTask.value?.title ?? sessionThread.value?.title ?? ''
  try {
    if (effectiveSendMode.value === 'agent') {
      if (taskNotStarted.value && taskDetail) {
        if (payload.files.length) {
          ElMessage.warning('开始执行时会带上任务引用的共享文件；附件请在开始执行后随回复发送。')
          return
        }
        if (!(await taskDetail.start(payload.prompt))) return
      } else {
        const createdRun = await taskStore.startRunWithSessionFiles(sessionId, {
          prompt: payload.prompt,
          attachments: payload.files,
          workspaceAgentMemberId: taskThreadAgentId.value,
        })
        taskStore.subscribe(createdRun.id)
      }
    } else {
      if (payload.files.length) {
        ElMessage.warning(isAgentTaskConversation.value
          ? '评论不支持附件；需要 Agent 处理文件时请选择“交给 Agent”。'
          : '任务对话中的发言暂不支持附件，请上传到共享文件后在发言中说明。')
        return
      }
      await taskStore.postSessionMessage(sessionId, payload.prompt)
    }
    payload.confirm?.()
    await refreshTaskConversation()
  } catch (error) {
    notifyActionFailure('发送', `任务“${title}”`, error, '检查输入后重试；已有对话内容不会丢失。')
  }
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

async function submitFollowUp(payload: { prompt: string; files: File[]; workspaceId: string; mentions: string[]; confirm?: () => void }) {
  // TW-10 防线：viewer/角色未知不允许发言或触发执行，不能只靠模板不渲染
  // composer——函数本身也要 fail-closed。服务端写轨仍是最终裁决。
  if (!task.value || workspaceArchived.value || isRunViewer.value) return
  // 任务线程识别完成前不把回复当讨论消息发送：那会静默不触发承接 Agent。
  if (isTeamSession.value && (projectTaskLoading.value || projectTaskError.value)) {
    ElMessage.warning(projectTaskError.value
      ? '任务信息读取失败，为避免误发为评论，请先重试读取'
      : '正在读取任务信息，请稍候再发送')
    return
  }
  try {
    const mentionedMemberId = isTeamSession.value ? payload.mentions?.[0] ?? taskThreadAgentId.value : undefined
    if (isTeamSession.value && !mentionedMemberId) {
      // TW-10：团队共享会话里不 @ 的消息是全员可见的讨论，不产生执行。
      if (payload.files.length || referencedArtifacts.value.length) {
        ElMessage.warning('带附件或引用成果的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
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
      const choice = continueChoice({
        prompt: payload.prompt,
        hasAttachments: payload.files.length > 0 || referencedArtifacts.value.length > 0,
        status: task.value.status,
        canRetry: canRetry.value,
        artifacts: task.value.result.artifacts,
      })
      if (choice) {
        const decision = await askContinueIntent(choice)
        if (decision === 'abort') return
        if (decision === 'primary' && choice.kind === 'retry') {
          if (await retryRun()) payload.confirm?.()
          return
        }
        if (decision === 'primary' && choice.kind === 'revise') referencedArtifacts.value = [...choice.artifacts]
      }
      const nextTask = await taskStore.sendMessage(
        task.value.id, payload.prompt, payload.files, mentionedMemberId,
        referencedArtifacts.value.map(item => item.fileId),
      )
      referencedArtifacts.value = []
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
  if (inTaskConversation.value) {
    if (projectTaskLoading.value || projectTaskError.value) {
      ElMessage.warning(projectTaskError.value ? '任务信息读取失败，请先重试读取' : '正在读取任务信息，请稍候再发送')
      return
    }
    await submitTaskConversation(thread.sessionId, payload)
    return
  }
  if (isTeamSession.value && (projectTaskLoading.value || projectTaskError.value)) {
    ElMessage.warning(projectTaskError.value
      ? '任务信息读取失败，为避免误发为评论，请先重试读取'
      : '正在读取任务信息，请稍候再发送')
    return
  }
  try {
    const mentionedMemberId = isTeamSession.value ? payload.mentions?.[0] ?? taskThreadAgentId.value : undefined
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
  await taskStore.load()
  const thread = await loadConversationTarget(routeTargetId.value)
  await reconcileConversationRoute()
  await loadAgentMembers(task.value?.workspaceId ?? thread?.workspaceId)
  await loadProjectTask(task.value?.workspaceId ?? thread?.workspaceId)
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
      await router.replace(spaceRoutes.conversation(workspaceId, routeTargetId.value))
    }
    return
  }
  const workspaceType = task.value?.workspaceType ?? sessionThread.value?.workspaceType
  if (workspaceType !== 'team' || !workspaceId) return
  await router.replace(spaceRoutes.conversation(workspaceId, routeTargetId.value))
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

async function loadConversationTarget(id: string): Promise<SessionThread | null> {
  targetLoading.value = true
  contentSyncedAt.value = new Date().toISOString()
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
    await loadProjectTask(task.value?.workspaceId ?? thread?.workspaceId)
  },
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
    if (sessionThread.value) {
      try {
        sessionThread.value = await taskStore.loadSessionThread(sessionThread.value.sessionId)
        // 任务对话：执行结束或他人发言可能改变任务状态，同步刷新任务信息。
        if (isTaskThreadRoute.value) void taskDetail?.refresh()
      } catch {
        // 会话被删除或已失权：与初次加载同一口径落到「未找到对话」。
        sessionThread.value = null
        threadMissing.value = true
      }
    } else if (task.value) {
      await taskStore.refreshRun(task.value.id).catch(() => undefined)
    }
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
})

onBeforeUnmount(() => {
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer)
  if (streamWorkspaceId.value) taskStore.unsubscribeWorkspaceSessions(streamWorkspaceId.value)
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
  <div class="conversation-page" :class="{ 'conversation-page--embedded': isEmbeddedInWorkspace, 'conversation-page--task': inTaskConversation }">
    <div v-if="(taskStore.loading || targetLoading) && !task && !sessionThread && !threadMissing" class="conversation-state">
      <el-skeleton :rows="8" animated />
    </div>

    <template v-else-if="!task && sessionThread">
      <!-- 任务详情内的任务对话：标题与操作由外层任务详情给出。 -->
      <header v-if="!inTaskConversation" class="conversation-header">
        <div class="conversation-header__left">
          <button type="button" class="conversation-header__back" :aria-label="isTaskThreadRoute ? '返回任务对话' : '返回'" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <h1 v-if="!isTaskThreadRoute">{{ sessionThread.title }}</h1>
          <span class="conversation-skill"><span>发起人</span>{{ sessionThread.creatorName }}</span>
          <span v-if="projectTask && !isTaskThreadRoute" class="conversation-skill" data-testid="task-thread-badge"><span>任务</span>{{ projectTask.title }}</span>
        </div>
        <div v-if="canMarkAsTask" class="conversation-header__actions">
          <el-button data-testid="mark-as-task" text :loading="markingAsTask" @click="markAsTask">设为任务</el-button>
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
                data-testid="task-conversation-message"
                :message="item.message"
                :own="isOwnMessage(item.message)"
                :tag="messageTag(item.message)"
                :show-requester="false"
              />
              <button
                v-else-if="item.kind === 'run'"
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
          <SessionDiscussionList :thread="sessionThread" :is-own="isOwnMessage" @open-run="openSessionRun" />
          </template>
          <div class="conversation-end" aria-hidden="true"></div>
        </div>
      </main>

      <div class="conversation-composer-dock">
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
          <TaskComposer
            v-if="canWriteSession"
            compact
            :mention-options="isTeamSession && !inTaskConversation ? mentionOptions : []"
            :files-require-mention="isTeamSession && !taskThreadAgentId && !inTaskConversation"
            :placeholder="taskComposerPlaceholder"
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
          @click="isEmbeddedInWorkspace ? router.push(spaceRoutes.home(embeddedWorkspaceId)) : router.push('/workbench')"
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
          <!-- 任务详情内：标题与所属空间已由外层任务信息与面包屑给出。 -->
          <template v-if="!isTaskThreadRoute">
            <h1>{{ task.title }}</h1><span v-if="currentWorkspace?.type === 'team'">项目空间：{{ currentWorkspace.name }}</span>
          </template>
          <span v-if="task.skill" class="conversation-skill">
            <span>Skill</span>{{ task.skill.name }} · v{{ task.skill.version }}
          </span>
        </div>
        <div class="conversation-header__actions">
          <span v-if="projectTask && !isTaskThreadRoute" class="conversation-skill" data-testid="task-thread-badge"><span>任务</span>{{ projectTask.title }}</span>
          <el-button v-if="canMarkAsTask" data-testid="mark-as-task" text :loading="markingAsTask" @click="markAsTask">设为任务</el-button>
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
          <RunMessageList
            :task="task"
            :is-own="isOwnMessage"
            :can-follow-up="canFollowUp"
            :can-retry="canRetry"
            :referenced-file-ids="referencedArtifacts.map(item => item.fileId)"
            @download="download"
            @continue-editing="continueEditing"
            @copy-answer="copyAnswer"
            @copy-link="copyConversationLink()"
            @open-details="detailsOpen = true"
            @retry="retryRun"
          />

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
        <div v-if="isTaskThreadRoute" class="conversation-composer-dock__inner" data-testid="run-view-task-return">
          <p class="conversation-task-thread-notice">
            这里是单次执行的详情。补充要求或评论请回到任务对话发言。
            <el-button link type="primary" data-testid="run-view-back-to-task" @click="goBack">返回任务对话</el-button>
          </p>
          <p>AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
        </div>
        <div v-else class="conversation-composer-dock__inner">
          <RunComposer
            v-if="canFollowUp"
            :referenced-artifacts="referencedArtifacts"
            :show-workspace-context="currentWorkspace?.type === 'team'"
            :running="canStop"
            :stopping="stopping"
            :mention-options="isTeamSession ? mentionOptions : []"
            :files-require-mention="isTeamSession && !taskThreadAgentId"
            @open-files="router.push('/files')"
            @remove-reference="removeReferencedArtifact"
            @submit="submitFollowUp"
            @stop="stopCurrentRun"
          >
            <template #notices>
              <p v-if="taskThreadAgentName" data-testid="task-thread-notice" class="conversation-task-thread-notice">
                回复会直接交给“{{ taskThreadAgentName }}”继续处理，无需 @；Agent 执行期间请等待完成或先停止。
              </p>
              <p v-if="projectTaskError" class="conversation-task-thread-notice" role="alert" data-testid="task-thread-error">
                任务信息读取失败：{{ projectTaskError }}
                <el-button link type="primary" @click="reloadProjectTask">重试</el-button>
              </p>
            </template>
          </RunComposer>
          <template v-else>
            <p v-if="projectTaskError" class="conversation-task-thread-notice" role="alert" data-testid="task-thread-error">
              任务信息读取失败：{{ projectTaskError }}
              <el-button link type="primary" @click="reloadProjectTask">重试</el-button>
            </p>
            <p v-if="workspaceArchived" data-testid="conversation-archived-notice" class="conversation-archived-notice">
              该空间已归档，仅保留有权限的只读查看与下载；无法续写或重试。
            </p>
            <p v-else-if="isRunViewer" data-testid="conversation-readonly-notice" class="conversation-archived-notice">
              当前角色为只读成员，仅可查看讨论内容。
            </p>
          </template>
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
          <p v-if="quietLabel" class="working-quiet working-quiet--drawer" role="status">已 {{ quietLabel }}没有新的执行事件，任务仍在运行。</p>
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
            <button
              v-for="artifact in task.result.artifacts"
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

/* 项目空间 S3：任务详情内的任务对话——没有会话标题栏，时间线与系统记录。 */
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

/* S4：定时执行“无变化”的回复默认折叠为一行。 */
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
.conversation-composer-dock__inner > p.conversation-task-thread-notice {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-brand-soft);
  color: var(--dsh-color-brand-dark);
  font-size: var(--dsh-font-size-micro);
}

.conversation-archived-notice {
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

  .conversation-composer-dock {
    padding: 40px 10px 9px;
  }

  .conversation-composer-dock :deep(.composer__input) {
    min-height: 70px;
  }
}
</style>
