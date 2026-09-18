<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowRight,
  ChatDotRound,
  Close,
  Document,
  Files,
  InfoFilled,
  Plus,
} from '@element-plus/icons-vue'

import { ArtifactCard } from '@dsh-work/ui-core'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { workbenchApi } from '@/api/client'
import type {
  Artifact,
  TeamMemberRole,
  Workspace,
  WorkspaceActivityItem,
  WorkspaceAgentMember,
  WorkspaceFile,
  WorkspaceFileVersion,
  WorkspaceMember,
  WorkspaceNotificationState,
  WorkspaceUsageRange,
  WorkspaceUsageTotals,
} from '@/types/domain'
import ArtifactPreviewDialog from '@/components/ArtifactPreviewDialog.vue'
import ConversationStarter from '@/components/ConversationStarter.vue'
import WorkspaceFileVersionsDialog from '@/components/WorkspaceFileVersionsDialog.vue'
import WorkspaceMemberDialog from '@/components/WorkspaceMemberDialog.vue'
import WorkspaceSessionHistory from '@/components/WorkspaceSessionHistory.vue'
import WorkspaceSettingsDialog from '@/components/WorkspaceSettingsDialog.vue'
import WorkspaceUsageDialog from '@/components/WorkspaceUsageDialog.vue'
import { WorkspaceInfoPanel, describeWorkspaceActivity } from '@dsh-work/workbench-components'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'
import { resolveCurrentUserRole } from '@/utils/member-roles'
import { buildActivityDisplayItems } from '@/utils/workspace-activity'
import { formatFileVersionLabel, toVersionFileReference } from '@/utils/workspace-file-versions'

type WorkspaceTab = 'conversation' | 'files' | 'artifacts'
/** 对话页签内的视图：新对话（默认）/ 历史对话（design §2.2）。 */
type ConversationView = 'new' | 'history'

/**
 * 当前操作人角色可由路由宿主注入（测试与后续服务端返回角色字段时使用）；
 * 缺省时按 utils/member-roles 的保守口径从空间负责人推导。
 */
const props = withDefaults(
  defineProps<{ currentUserRole?: TeamMemberRole | null }>(),
  { currentUserRole: undefined },
)

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const starterRef = ref<{
  useWorkspaceFile: (file: WorkspaceFile) => void
}>()
const tabButtonRefs = ref<HTMLButtonElement[]>([])
const panelCollapsed = ref(false)
const mobileInfoOpen = ref(false)
const uploadInput = ref<HTMLInputElement>()
const uploading = ref(false)

/**
 * TW-07 / 3-T9 文件版本 UI。版本列表与历史下载属读取轨（归档空间仍可用）；上传新
 * 版本属执行轨（归档与只读成员都没有入口，服务端同样 403）。个人空间不渲染任何
 * 版本 UI，也不发版本请求（AC-23）。
 */
const versionDialogOpen = ref(false)
const versionDialogFile = ref<{ logicalFileId: string; name: string } | null>(null)
/** 触发「版本」入口的元素：对话框关闭后把焦点还给它（design §4）。 */
const versionTrigger = ref<HTMLElement | null>(null)
const versionUploadInput = ref<HTMLInputElement>()
/** 已经点开上传、等待用户选文件的逻辑文件 id（`change` 事件里消费）。 */
const pendingVersionUploadId = ref<string | null>(null)
/** 正在上传的逻辑文件 id（用于行内 loading，直到请求结束）。 */
const versionUploadingId = ref<string | null>(null)
/** 最近一次上传失败的逻辑文件与原因；行内说明「原版本未受影响」。 */
const versionUploadError = ref<{ logicalFileId: string; message: string } | null>(null)

const memberDialogOpen = ref(false)
const settingsDialogOpen = ref(false)
/** HTML 成果预览：读取轨，归档空间与个人空间同样可预览（与下载同口径）。 */
const previewOpen = ref(false)
const previewArtifact = ref<Artifact | null>(null)
const agentMembers = ref<WorkspaceAgentMember[]>([])
const workspaceMembers = ref<WorkspaceMember[]>([])
/** 服务端返回的调用者角色（负责人转交后不再等于创建者，不能靠姓名推断）。 */
const serverUserRole = ref<TeamMemberRole | null>(null)
/** 当前操作人可发起对话的 Agent 成员：与服务端 allowedActions 一致（只读成员为空）。 */
const startableAgentMemberIds = computed(() => agentMembers.value
  .filter(member => member.status === 'available' && member.allowedActions.includes('start_conversation'))
  .map(member => member.id))
const presetAgentMember = ref<WorkspaceAgentMember | null>(null)
/**
 * 预选是否来自「唯一可发起成员」的自动回填（TW-02：只有一个可用 Agent 时可默认
 * 选中）；用户在 Agent 区点「开始对话」的显式选择为 false，不会被自动逻辑改写。
 */
const presetAgentMemberAuto = ref(false)
/**
 * TW-10：输入框可 @ 的 Agent 成员（id + 名称），与 startableAgentMemberIds
 * 同一过滤口径（可用 + allowedActions 含 start_conversation）。
 */
const startableMentionOptions = computed(() => agentMembers.value
  .filter(member => member.status === 'available' && member.allowedActions.includes('start_conversation'))
  .map(member => ({ id: member.id, name: member.name })))

/** 摘要固定取最新 3 条；抽屉分页 20 条（design §2.9 / TW-08）。 */
const ACTIVITY_SUMMARY_LIMIT = 3
const ACTIVITY_PAGE_SIZE = 20
/** 最近动态摘要（服务端 limit=3）；个人空间不请求（AC-23）。 */
const activitySummary = ref<WorkspaceActivityItem[]>([])
const activityLoading = ref(false)
const activityError = ref(false)
/** 调用者本人的未读与静音状态；null 表示尚未加载或加载失败。 */
const notificationState = ref<WorkspaceNotificationState | null>(null)
const notificationError = ref(false)
const activityDrawerOpen = ref(false)
const activityDrawerItems = ref<WorkspaceActivityItem[]>([])
const activityDrawerCursor = ref<string | null>(null)
const activityDrawerLoading = ref(false)
const activityDrawerLoadingMore = ref(false)
const activityDrawerError = ref(false)
/** 触发「查看全部」的元素：抽屉关闭后把焦点还给它（design §4）。 */
const activityTrigger = ref<HTMLElement | null>(null)

/**
 * 空间用量（TW-09 / 4-T2，口径 §1）：仅团队 + 负责人/管理员可见。摘要固定按 7 天
 * 窗口加载；普通成员／只读成员、角色未解析（名册请求失败）与个人空间一律不渲染、
 * 零请求（AC-30 / AC-23，沿用「宁可漏开不可误开」）。
 */
const USAGE_SUMMARY_RANGE: WorkspaceUsageRange = '7d'
const usageSummary = ref<WorkspaceUsageTotals | null>(null)
const usageLoading = ref(false)
const usageError = ref(false)
const usageDialogOpen = ref(false)
/** 触发「查看详情」的元素：弹窗关闭后把焦点还给它（design §4）。 */
const usageTrigger = ref<HTMLElement | null>(null)

/**
 * 动态相关请求的世代号（摘要／通知状态／抽屉三条流各自独立）。异步回写前必须同时
 * 比对世代号与发起时的空间 id：切换空间或连续重试时，晚到的旧响应否则会把上一个
 * 空间的动态、未读数与静音标签写进当前视图（评审 P1-2 实测）。
 */
let summaryRequestSeq = 0
let notificationRequestSeq = 0
let drawerRequestSeq = 0
/**
 * 空间用量摘要请求的世代号（与 3-T8/3-T9 同一模式）：回写前必须同时比对世代号与
 * 发起时的空间 id，切换空间或连续重试时晚到的旧响应不得写进当前视图。
 */
let usageRequestSeq = 0

type ActivityStream = 'summary' | 'notification' | 'drawer'

function currentRequestSeq(stream: ActivityStream) {
  return stream === 'summary' ? summaryRequestSeq : stream === 'notification' ? notificationRequestSeq : drawerRequestSeq
}

function isCurrentActivityRequest(seq: number, workspaceId: string, stream: ActivityStream) {
  return seq === currentRequestSeq(stream) && workspaceId === (workspace.value?.id ?? '')
}

/** 空间切换时作废所有在途动态请求（即使切回同一个空间也不会落回旧响应）。 */
function invalidateActivityRequests() {
  summaryRequestSeq += 1
  notificationRequestSeq += 1
  drawerRequestSeq += 1
}

const requestedTab = String(route.query.tab ?? 'conversation')
const activeTab = ref<WorkspaceTab>(
  ['conversation', 'files', 'artifacts'].includes(requestedTab)
    ? (requestedTab as WorkspaceTab)
    : 'conversation',
)
/** 默认新对话；`?view=history` 深链在空间对象就绪后由 watch 恢复（仅团队）。 */
const conversationView = ref<ConversationView>('new')
const conversationViews: Array<{ id: ConversationView; label: string }> = [
  { id: 'new', label: '新对话' },
  { id: 'history', label: '历史对话' },
]

const workspaceId = computed(() => String(route.params.id ?? ''))
const workspace = computed(() =>
  contentStore.workspaces.find((item) => item.id === workspaceId.value),
)
const isPersonal = computed(() => workspace.value?.type === 'personal')
const isTeam = computed(() => workspace.value?.type === 'team')
/**
 * 归档只读态：仅团队空间在服务端 `status === 'archived'` 时进入（个人空间恒为
 * active，即使夹具强行带上归档状态也不渲染归档提示，AC-23）。
 */
const isArchived = computed(() => isTeam.value && workspace.value?.status === 'archived')
/**
 * 归档执行轨（design §2.7）：归档隐藏新对话、上传等写入口，但历史、文件与成果
 * 内容保持可读。新对话入口只在活动空间渲染；归档时对话页签固定展示历史。
 */
const showConversationStarter = computed(() => !isArchived.value)
const showConversationViewSwitch = computed(() => isTeam.value && !isArchived.value)
const showSessionHistory = computed(() => isTeam.value && (conversationView.value === 'history' || isArchived.value))
/**
 * 当前操作人的团队角色。优先采用 `GET /workspaces/:id/members` 返回的
 * `currentUserRole`（负责人转交后创建者不再是负责人，按姓名推断会失效）；
 * 名册未就绪或加载失败时才回退到「负责人姓名 == 当前用户姓名」的保守判断，
 * 其余一律 null，团队写入口不渲染（不臆造权限，不误开入口）。
 */
const currentUserRole = computed<TeamMemberRole | null>(() => {
  if (props.currentUserRole !== undefined) return props.currentUserRole
  // 优先采用服务端返回的角色：负责人转交后创建者不再是负责人，按姓名推断会让
  // 新负责人失去全部写入口、旧创建者被误判。仅在名册尚未加载完成/加载失败时
  // 才回退到「负责人姓名 == 当前用户姓名」的保守判断。
  if (serverUserRole.value !== null) return serverUserRole.value
  return resolveCurrentUserRole({
    workspaceType: workspace.value?.type,
    archived: isArchived.value,
    owner: workspace.value?.owner,
    userName: authStore.user.name,
  })
})
const workspaceArtifacts = computed(() =>
  contentStore.artifacts.filter((artifact) => artifact.workspaceId === workspaceId.value),
)
/** 负责人判定来自服务端角色，不在前端按创建者猜测（负责人-only 动作的唯一依据）。 */
const isOwner = computed(() => currentUserRole.value === 'owner')
/**
 * 上传新版本（执行轨）：归档空间隐藏入口；只读成员（viewer）不给入口；角色**未知**
 * （名册请求失败，`currentUserRole === null`）时也不给入口——宁可漏开不可误开，
 * 与 `WorkspaceInfoPanel` 对 `currentUserRole=null` 的既有口径一致。服务端 403 仍是
 * 最终兜底（评审 P2 修复后注释与实现对齐）。
 */
const canUploadFileVersions = computed(() =>
  isTeam.value
  && !isArchived.value
  // 角色未解析出来（名册请求失败）时**不给**入口：与「宁可漏开不可误开」及
  // WorkspaceInfoPanel 对 currentUserRole=null 的既有口径一致，避免给只读成员
  // 一个注定 403 的假入口（评审 P2）。
  && currentUserRole.value !== null
  && currentUserRole.value !== 'viewer')
/**
 * 「引用此版本」与「引用到对话」同口径：归档空间无法发起新对话，因此不渲染引用
 * 入口（版本列表与下载仍保留）。
 */
const canReferenceFileVersion = computed(() => isTeam.value && !isArchived.value)
/**
 * TW-10 共享讨论的写入口径：团队空间中非只读成员且空间未归档才可发言/触发
 * 执行；角色未知（名册请求失败）时宁可漏开不可误开，与上传入口一致。
 */
const canWriteTeamContent = computed(() =>
  isTeam.value
  && !isArchived.value
  && currentUserRole.value !== null
  && currentUserRole.value !== 'viewer')
/**
 * 空间用量可见门禁的**角色来源**：只认服务端给出的角色——父组件显式传入的
 * `currentUserRole`（管理端嵌入时）或 `GET /workspaces/:id/members` 返回的
 * `currentUserRole`。**刻意不使用** `currentUserRole` computed 的姓名推断回退
 * （`resolveCurrentUserRole`：「负责人姓名 == 当前用户姓名 ⇒ owner」）：用量是
 * 消耗/费用类数据，只有服务端确认的负责人/管理员才该看到；名册失败时宁可漏开。
 * 评审 P2/N3 实测：名册失败 + 姓名相同会让回退判定为 owner，从而渲染区块并发一次
 * 注定 403 的请求。
 */
const usageServerRole = computed<TeamMemberRole | null>(() =>
  props.currentUserRole !== undefined ? props.currentUserRole : serverUserRole.value)
/**
 * 空间用量的可见门禁：仅团队空间中**服务端确认**的负责人／管理员。角色未知
 * （名册请求失败）时不渲染也不请求——宁可漏开不可误开（AC-30）。归档空间属读取轨，
 * 负责人/管理员仍可查看（口径 §1）。
 */
const canViewUsage = computed(() =>
  isTeam.value && (usageServerRole.value === 'owner' || usageServerRole.value === 'admin'))
/** 动态文件名的解析来源：已加载的空间文件列表（面板与抽屉共用）。 */
const activityFiles = computed(() => workspace.value?.files ?? [])
const activitySummaryItems = computed(() => buildActivityDisplayItems(activitySummary.value, activityFiles.value))
/** 未读计数；静音时按服务端口径视为 0（面板侧再兜一层）。 */
const activityUnread = computed(() => (notificationState.value?.muted ? 0 : notificationState.value?.unreadCount ?? 0))
const activityMuted = computed(() => notificationState.value?.muted ?? false)
/** 「查看全部」抽屉行：文案同样只由 kind + safeMetadata + 演员名生成。 */
const activityDrawerRows = computed(() => activityDrawerItems.value.map((item) => {
  const [display] = buildActivityDisplayItems([item], activityFiles.value)
  return {
    ...display!,
    description: describeWorkspaceActivity({
      kind: item.kind,
      actorDisplayName: item.actorDisplayName,
      safeMetadata: item.safeMetadata,
      fileName: display?.fileName,
    }),
  }
}))
const workspaceTabs = computed(() => [
  {
    id: 'conversation' as const,
    label: '对话',
    count: workspace.value?.sessionCount ?? 0,
    icon: ChatDotRound,
  },
  {
    id: 'files' as const,
    label: isPersonal.value ? '文件' : '共享文件',
    count: workspace.value?.files.length ?? 0,
    icon: Files,
  },
  {
    id: 'artifacts' as const,
    label: '成果',
    count: workspaceArtifacts.value.length,
    icon: Document,
  },
])

function selectTab(tab: WorkspaceTab) {
  activeTab.value = tab
  const query = { ...route.query }
  if (tab === 'conversation') delete query.tab
  else query.tab = tab
  void router.replace({ query })
}

/**
 * 视图切换写入 `?view=history`（design §2.2）。只有团队空间渲染切换行：
 * 个人空间的 `conversationView` 恒为 `new`，既不渲染历史视图也不发历史请求（AC-23）。
 */
function setConversationView(view: ConversationView) {
  conversationView.value = view
  const query = { ...route.query }
  if (view === 'history') query.view = 'history'
  else delete query.view
  void router.replace({ query })
}

watch(
  () => [route.query.view, isTeam.value] as const,
  ([view, team]) => {
    conversationView.value = team && String(view ?? '') === 'history' ? 'history' : 'new'
  },
  { immediate: true },
)

function onTabKeydown(event: KeyboardEvent, index: number) {
  const keyTargets: Record<string, number> = {
    ArrowLeft: (index - 1 + workspaceTabs.value.length) % workspaceTabs.value.length,
    ArrowRight: (index + 1) % workspaceTabs.value.length,
    Home: 0,
    End: workspaceTabs.value.length - 1,
  }
  const targetIndex = keyTargets[event.key]
  if (targetIndex === undefined) return
  event.preventDefault()
  const target = workspaceTabs.value[targetIndex]
  if (!target) return
  selectTab(target.id)
  void nextTick(() => tabButtonRefs.value[targetIndex]?.focus())
}

function useWorkspaceFile(file: WorkspaceFile) {
  if (isTeam.value) setConversationView('new')
  selectTab('conversation')
  mobileInfoOpen.value = false
  void nextTick(() => {
    starterRef.value?.useWorkspaceFile(file)
    ElMessage.success(`已将“${file.name}”带入新对话`)
  })
}

function uploadFile() {
  uploadInput.value?.click()
}

async function onUploadSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !workspace.value) return
  uploading.value = true
  try {
    await contentStore.uploadWorkspaceFile(workspace.value.id, file)
    ElMessage.success(`已上传“${file.name}”并通过基础安全门禁`)
  } catch (error) {
    notifyActionFailure('文件上传', `工作空间“${workspace.value.name}”中的文件“${file.name}”`, error, '按支持的格式和 20 MB 限制调整文件后重新上传。')
  } finally {
    uploading.value = false
    input.value = ''
  }
}

/** 文件行是否渲染 TW-07 版本 UI：仅团队逻辑文件（个人空间恒 false，AC-23）。 */
function showFileVersions(file: WorkspaceFile) {
  return isTeam.value && Boolean(file.logicalFileId)
}

/**
 * 文件行的版本标记文案：只有服务端真的给出正整数版本号时才渲染（旧夹具/边界数据
 * 可能只有 logicalFileId 而没有 versionNo，否则会出现空白徽标——评审 nit）。
 */
function fileVersionLabel(file: WorkspaceFile) {
  if (!showFileVersions(file)) return ''
  return formatFileVersionLabel(file)
}

/** 打开版本列表（读取轨）：归档空间仍可查看历史版本（服务端 allowArchived）。 */
function openVersionDialog(file: WorkspaceFile, event?: MouseEvent) {
  if (!file.logicalFileId) return
  versionTrigger.value = (event?.currentTarget as HTMLElement | null) ?? null
  versionDialogFile.value = { logicalFileId: file.logicalFileId, name: file.name }
  versionDialogOpen.value = true
}

/** 对话框关闭后把焦点还给「版本」触发按钮（design §4）。 */
watch(versionDialogOpen, (open) => {
  if (open) return
  void nextTick(() => {
    const trigger = versionTrigger.value
    if (trigger?.isConnected) trigger.focus()
  })
})

/**
 * 按版本引用到新对话：`ConversationStarter.useWorkspaceFile(file)` 用传入对象的
 * `id` 作为引用的不可变对象 id，因此这里必须传该版本的 `fileId`
 * （`toVersionFileReference`），历史 Run 才能追溯实际输入版本。
 */
function referenceFileVersion(version: WorkspaceFileVersion) {
  if (!canReferenceFileVersion.value) return
  versionDialogOpen.value = false
  useWorkspaceFile(toVersionFileReference(version))
}

/** 「上传新版本」入口（执行轨）：先选文件，再询问可选的更新说明。 */
function uploadNewVersion(file: WorkspaceFile) {
  if (!canUploadFileVersions.value || versionUploadingId.value || !file.logicalFileId) return
  pendingVersionUploadId.value = file.logicalFileId
  versionUploadInput.value?.click()
}

/**
 * 新版本上传：更新说明 ≤500 且留空时不发送 `X-File-Note`（服务端存 `null`）。
 * 只有上传成功才刷新文件列表，使服务端判定的新版本成为当前版本；失败时保留原
 * 有列表与 `current`，只在行内说明「原版本未受影响」（AC-13：解析失败不破坏旧版）。
 */
async function onVersionUploadSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const selected = input.files?.[0]
  // 无论结果如何都清空 input，否则同一个文件无法再次触发 change。
  input.value = ''
  const logicalFileId = pendingVersionUploadId.value
  pendingVersionUploadId.value = null
  const current = workspace.value
  if (!selected || !logicalFileId || !current || !canUploadFileVersions.value) return

  let note = ''
  try {
    const result = await ElMessageBox.prompt(
      '可填写本次更新说明，便于团队识别升级内容；留空则不记录说明。',
      '上传新版本',
      {
        confirmButtonText: '上传',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '更新说明（可选，最多 500 字）',
        inputValue: '',
        inputValidator: (value: string) => !value || value.length <= 500 || '更新说明不能超过 500 字',
      },
    )
    note = String(result.value ?? '')
  } catch {
    // 用户取消：不发起上传，也不改变任何既有状态。
    return
  }

  versionUploadError.value = null
  versionUploadingId.value = logicalFileId
  let uploaded: Awaited<ReturnType<typeof workbenchApi.uploadWorkspaceFileVersion>>
  try {
    uploaded = await workbenchApi.uploadWorkspaceFileVersion(current.id, logicalFileId, selected, note)
  } catch (error) {
    versionUploadingId.value = null
    versionUploadError.value = {
      logicalFileId,
      message: error instanceof Error ? error.message : '上传新版本失败',
    }
    notifyActionFailure('上传新版本', `工作空间“${current.name}”中的文件`, error, '修正文件内容或更新说明后重新上传；原版本仍可继续使用。')
    return
  }
  versionUploadingId.value = null
  ElMessage.success(`已上传“${selected.name}”的 V${uploaded.versionNo} 版本`)
  try {
    // 上传已成功，刷新失败不能反过来把这次上传说成失败。
    await contentStore.refresh()
  } catch (error) {
    notifyActionFailure('刷新文件列表', `工作空间“${current.name}”`, error, '刷新页面查看最新版本。')
  }
}

function download(item: Artifact) {
  void downloadArtifactFile(item)
}

function openArtifactPreview(item: Artifact) {
  previewArtifact.value = item
  previewOpen.value = true
}

watch(
  () => route.query.tab,
  (tab) => {
    const value = String(tab ?? 'conversation')
    if (['conversation', 'files', 'artifacts'].includes(value)) {
      activeTab.value = value as WorkspaceTab
    }
  },
)

/**
 * Agent 成员列表只按既有 T4 接口加载，且严格限定团队空间：个人空间既不发
 * 请求也不渲染（AC-23）。
 */
async function loadAgentMembers(workspaceId = workspace.value?.id ?? '') {
  if (!workspaceId || !isTeam.value) return
  try {
    agentMembers.value = await workbenchApi.listWorkspaceAgentMembers(workspaceId)
  } catch (error) {
    agentMembers.value = []
    notifyActionFailure('加载 Agent 成员', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后刷新页面重试。')
  }
}

/**
 * 加载员工名册与服务端判定的调用者角色。团队成员均可读取；个人空间不请求
 * （AC-23）。名册同时用于成员弹窗与设置弹窗的转交候选项。
 */
async function loadWorkspaceMembers(workspaceId = workspace.value?.id ?? '') {
  if (!workspaceId || !isTeam.value) return
  try {
    const directory = await workbenchApi.listWorkspaceMembers(workspaceId)
    workspaceMembers.value = directory.items
    serverUserRole.value = directory.currentUserRole
  } catch (error) {
    workspaceMembers.value = []
    serverUserRole.value = null
    notifyActionFailure('加载员工成员', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后刷新页面重试。')
  }
}

/**
 * 最近动态摘要（服务端 limit=3）。只在团队分支调用，个人空间不产生任何动态
 * 请求（AC-23）。失败时就地显示错误与「重试」，不清空右栏其它区块。
 */
async function loadActivitySummary(workspaceId = workspace.value?.id ?? '') {
  if (!workspaceId || !isTeam.value) return
  const seq = ++summaryRequestSeq
  activityLoading.value = true
  try {
    const page = await workbenchApi.listWorkspaceActivity(workspaceId, { limit: ACTIVITY_SUMMARY_LIMIT })
    if (!isCurrentActivityRequest(seq, workspaceId, 'summary')) return
    const items = Array.isArray(page.items) ? page.items : []
    activitySummary.value = items.slice(0, ACTIVITY_SUMMARY_LIMIT)
    activityError.value = false
  } catch (error) {
    if (!isCurrentActivityRequest(seq, workspaceId, 'summary')) return
    activityError.value = true
    activitySummary.value = []
    notifyActionFailure('加载最近动态', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后点击「重试」；若仍失败，请联系工作空间管理员。')
  } finally {
    if (isCurrentActivityRequest(seq, workspaceId, 'summary')) activityLoading.value = false
  }
}

/** 未读计数与静音状态；未读条目本身由抽屉的 activity feed 提供，这里只要状态。 */
async function loadNotificationState(workspaceId = workspace.value?.id ?? '') {
  if (!workspaceId || !isTeam.value) return
  const seq = ++notificationRequestSeq
  try {
    const state = await workbenchApi.getWorkspaceNotifications(workspaceId, { limit: 1 })
    if (!isCurrentActivityRequest(seq, workspaceId, 'notification')) return
    notificationState.value = state
    notificationError.value = false
  } catch (error) {
    if (!isCurrentActivityRequest(seq, workspaceId, 'notification')) return
    // 保留旧值/空值并显式进入错误态：不把「加载失败」渲染成「没有未读」。
    notificationError.value = true
    notifyActionFailure('加载提醒状态', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后点击「重试」；若仍失败，请联系工作空间管理员。')
  }
}

/** 摘要加载失败后的原地重试（同时重取提醒状态）。 */
function retryActivity() {
  void loadActivitySummary()
  void loadNotificationState()
}

/** 用量请求是否仍属于当前空间且未被更新的请求取代。 */
function isCurrentUsageRequest(seq: number, workspaceId: string) {
  return seq === usageRequestSeq && workspaceId === (workspace.value?.id ?? '')
}

/** 空间切换时作废在途用量请求（即使切回同一个空间也不会落回旧响应）。 */
function invalidateUsageRequests() {
  usageRequestSeq += 1
}

/**
 * 空间用量摘要（固定 7 天窗口）。只在角色门禁内调用；失败时清空摘要并进入错误态，
 * 绝不把失败渲染成「零消耗」（design §2.10）。
 */
async function loadWorkspaceUsage(workspaceId = workspace.value?.id ?? '') {
  if (!workspaceId || !canViewUsage.value) return
  const seq = ++usageRequestSeq
  usageLoading.value = true
  try {
    const usage = await workbenchApi.listWorkspaceUsage(workspaceId, { range: USAGE_SUMMARY_RANGE })
    if (!isCurrentUsageRequest(seq, workspaceId)) return
    usageSummary.value = usage.totals
    usageError.value = false
  } catch (error) {
    if (!isCurrentUsageRequest(seq, workspaceId)) return
    usageSummary.value = null
    usageError.value = true
    notifyActionFailure('加载空间用量', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后点击「重试」；若仍失败，请联系工作空间管理员。')
  } finally {
    if (isCurrentUsageRequest(seq, workspaceId)) usageLoading.value = false
  }
}

/** 用量摘要加载失败后的原地重试（真的重新请求）。 */
function retryUsage() {
  void loadWorkspaceUsage()
}

/** 打开用量详情弹窗，并记住触发元素用于关闭后恢复焦点（design §4）。 */
function openUsageDialog(event?: MouseEvent) {
  usageTrigger.value = (event?.currentTarget as HTMLElement | null) ?? null
  usageDialogOpen.value = true
}

/** 弹窗关闭后把焦点还给「查看详情」（design §4）。 */
watch(usageDialogOpen, (open) => {
  if (open) return
  void nextTick(() => {
    const trigger = usageTrigger.value
    if (trigger?.isConnected) trigger.focus()
  })
})

/**
 * 标记全部已读：归档空间同样可用（只写调用者本人的通知状态，属读取轨）。
 * 成功后未读徽标归零并重新渲染。
 */
async function markActivityRead() {
  const current = workspace.value
  if (!current || !isTeam.value) return
  const seq = ++notificationRequestSeq
  try {
    const state = await workbenchApi.markWorkspaceNotificationsRead(current.id)
    if (!isCurrentActivityRequest(seq, current.id, 'notification')) return
    notificationState.value = state
    notificationError.value = false
  } catch (error) {
    if (!isCurrentActivityRequest(seq, current.id, 'notification')) return
    notifyActionFailure('标记全部已读', `工作空间“${current.name}”的团队动态`, error, '稍后重试；若仍失败，请联系工作空间管理员。')
  }
}

/** 关闭／恢复提醒；静音只影响徽标，绝不过滤动态列表。 */
async function toggleActivityMute() {
  const current = workspace.value
  if (!current || !isTeam.value) return
  const muted = notificationState.value?.muted ?? false
  const seq = ++notificationRequestSeq
  try {
    const state = muted
      ? await workbenchApi.unmuteWorkspaceNotifications(current.id)
      : await workbenchApi.muteWorkspaceNotifications(current.id)
    if (!isCurrentActivityRequest(seq, current.id, 'notification')) return
    notificationState.value = state
    notificationError.value = false
  } catch (error) {
    if (!isCurrentActivityRequest(seq, current.id, 'notification')) return
    notifyActionFailure(muted ? '恢复提醒' : '关闭提醒', `工作空间“${current.name}”的团队动态`, error, '稍后重试；若仍失败，请联系工作空间管理员。')
  }
}

/** 打开「查看全部」抽屉：首次打开加载第一页，并记住触发元素用于焦点恢复。 */
function openActivityDrawer(event?: MouseEvent) {
  activityTrigger.value = (event?.currentTarget as HTMLElement | null) ?? null
  activityDrawerOpen.value = true
  if (!activityDrawerItems.value.length && !activityDrawerLoading.value) void loadActivityPage()
}

/** 抽屉关闭后把焦点还给「查看全部」（design §4）。 */
watch(activityDrawerOpen, (open) => {
  if (open) return
  void nextTick(() => {
    const trigger = activityTrigger.value
    if (trigger?.isConnected) trigger.focus()
  })
})

/** 抽屉第一页：`limit=20`，游标分页跟随服务端 `nextCursor`。 */
async function loadActivityPage(workspaceId = workspace.value?.id ?? '') {
  if (!workspaceId || !isTeam.value) return
  const seq = ++drawerRequestSeq
  activityDrawerLoading.value = true
  try {
    const page = await workbenchApi.listWorkspaceActivity(workspaceId, { limit: ACTIVITY_PAGE_SIZE })
    if (!isCurrentActivityRequest(seq, workspaceId, 'drawer')) return
    const items = Array.isArray(page.items) ? page.items : []
    activityDrawerItems.value = items
    // 空首页即使带游标也视为到底：否则会出现「空列表 + 可加载更多」的死角，点下去还是空页。
    activityDrawerCursor.value = items.length > 0 ? page.nextCursor ?? null : null
    activityDrawerError.value = false
  } catch (error) {
    if (!isCurrentActivityRequest(seq, workspaceId, 'drawer')) return
    activityDrawerError.value = true
    activityDrawerItems.value = []
    activityDrawerCursor.value = null
    notifyActionFailure('加载全部动态', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后点击「重试」；若仍失败，请联系工作空间管理员。')
  } finally {
    if (isCurrentActivityRequest(seq, workspaceId, 'drawer')) activityDrawerLoading.value = false
  }
}

/** 追加下一页；失败时保留已加载行与游标，可再次点击「加载更多」。 */
async function loadMoreActivity() {
  const workspaceId = workspace.value?.id ?? ''
  const cursor = activityDrawerCursor.value
  if (!workspaceId || !isTeam.value || !cursor || activityDrawerLoadingMore.value) return
  // 不递增世代号：这是对当前页的追加，必须与当前页同世代；但首页重新加载会让它作废。
  const seq = drawerRequestSeq
  activityDrawerLoadingMore.value = true
  try {
    const page = await workbenchApi.listWorkspaceActivity(workspaceId, { cursor, limit: ACTIVITY_PAGE_SIZE })
    if (!isCurrentActivityRequest(seq, workspaceId, 'drawer')) return
    const incoming = Array.isArray(page.items) ? page.items : []
    const known = new Set(activityDrawerItems.value.map(item => item.id))
    const fresh = incoming.filter(item => !known.has(item.id))
    activityDrawerItems.value = [...activityDrawerItems.value, ...fresh]
    const next = page.nextCursor ?? null
    // 服务端重复给出同一游标、或本页没有新条目时视为到底：既避免重复渲染，也避免无限翻页。
    activityDrawerCursor.value = next && fresh.length > 0 && next !== cursor ? next : null
  } catch (error) {
    if (!isCurrentActivityRequest(seq, workspaceId, 'drawer')) return
    notifyActionFailure('加载更多动态', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后点击「加载更多」重试。')
  } finally {
    if (isCurrentActivityRequest(seq, workspaceId, 'drawer')) activityDrawerLoadingMore.value = false
  }
}

function startAgentConversation(agentMemberId: string) {
  // 纵深防御：归档空间不得新开对话（执行轨）。右栏入口已在面板内隐藏，这里再挡一次，
  // 避免任何其它调用路径绕过。
  if (isArchived.value) return
  const member = agentMembers.value.find(item => item.id === agentMemberId)
  if (!member) return
  presetAgentMember.value = member
  presetAgentMemberAuto.value = false
  memberDialogOpen.value = false
  setConversationView('new')
  selectTab('conversation')
}

/**
 * 唯一可发起 Agent 成员的自动预选（TW-02「只有一个可用 Agent 时可默认选中，但必须
 * 明确显示身份」——身份由新对话区的预选横幅展示）。只在预选空缺或已失效时回填，
 * 不覆盖用户仍有效的显式选择；自动预选在可选成员不再唯一时撤销，交还选择权。
 */
watch(startableAgentMemberIds, ids => {
  const presetStartable = !!presetAgentMember.value && ids.includes(presetAgentMember.value.id)
  if (ids.length === 1) {
    if (!presetStartable) {
      presetAgentMember.value = agentMembers.value.find(member => member.id === ids[0]) ?? null
      presetAgentMemberAuto.value = true
    }
    return
  }
  if (presetAgentMemberAuto.value) {
    presetAgentMember.value = null
    presetAgentMemberAuto.value = false
  }
})

function refreshTeamMembers() {
  void loadAgentMembers()
  void loadWorkspaceMembers()
}

/**
 * 恢复空间（design §2.7，负责人-only）：恢复不重新添加已移除成员、不扩大授权，
 * 仅把空间置回 active，写入口随后按当前权限重新出现。确认前置，失败沿用
 * 结构化反馈（design §3 错误映射）。
 */
async function restoreWorkspace() {
  const current = workspace.value
  if (!current || !isOwner.value) return
  try {
    await ElMessageBox.confirm(
      `恢复后写入口按当前权限重新出现；不会重新添加已移除成员，也不扩大授权。“${current.name}”将恢复为活动空间。`,
      '恢复空间？',
      { confirmButtonText: '恢复空间', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await workbenchApi.restoreWorkspace(current.id)
    await contentStore.refresh()
    ElMessage.success('已恢复该空间')
  } catch (error) {
    notifyActionFailure('恢复空间', `工作空间“${current.name}”`, error, '稍后重试；若仍失败，请联系管理员。')
  }
}

/**
 * 空间设置保存（3-T3 依赖的 `PATCH /workspaces/:id`）：把服务端返回的空间摘要
 * 同步进列表，避免重新拉取整页。名称/说明的写入由设置弹窗直接调用接口。
 */
function onWorkspaceSettingsSaved(updated: Workspace) {
  const index = contentStore.workspaces.findIndex((item) => item.id === updated.id)
  if (index >= 0) contentStore.workspaces.splice(index, 1, updated)
  else contentStore.workspaces.push(updated)
}

/** 归档/恢复后刷新服务端状态（含 archivedAt 与当前负责人）。 */
function onWorkspaceStatusChanged() {
  void contentStore.refresh()
}

onMounted(() => {
  void contentStore.refresh()
})

/**
 * 空间详情依赖 Store 里的空间对象：解析结果可能是团队或个人。团队分支在
 * 对象就绪后再加载 Agent 成员；个人空间分支不产生任何新请求（AC-23）。
 */
/** 上一次真正加载过的空间 id：同 id 的对象替换不重复请求（规格评审 F1）。 */
let loadedWorkspaceId: string | null = null

watch(workspace, (value) => {
  const nextId = value?.id ?? ''
  // `onMounted` 的 `contentStore.refresh()` 会用新对象替换 store 数组，`workspace`
  // computed 因此再次触发。同一个 id 只是同一空间的新对象，重复加载没有意义（评审
  // F1 实测摘要与提醒状态各发 2 次请求）；只有真正的空间切换才重置状态并加载。
  // 与 3-T3 列表筛选的「同参去重」同一思路。
  if (nextId && nextId === loadedWorkspaceId) return
  loadedWorkspaceId = nextId || null
  // 先作废在途请求，再清空本地状态：否则旧响应会在清空之后落回来（评审 P1-2）。
  invalidateActivityRequests()
  invalidateUsageRequests()
  presetAgentMember.value = null
  presetAgentMemberAuto.value = false
  memberDialogOpen.value = false
  settingsDialogOpen.value = false
  agentMembers.value = []
  workspaceMembers.value = []
  serverUserRole.value = null
  activitySummary.value = []
  activityLoading.value = false
  activityError.value = false
  notificationState.value = null
  notificationError.value = false
  activityDrawerOpen.value = false
  activityDrawerItems.value = []
  activityDrawerCursor.value = null
  activityDrawerError.value = false
  activityDrawerLoading.value = false
  activityDrawerLoadingMore.value = false
  versionDialogOpen.value = false
  versionDialogFile.value = null
  versionTrigger.value = null
  pendingVersionUploadId.value = null
  versionUploadingId.value = null
  versionUploadError.value = null
  usageSummary.value = null
  usageLoading.value = false
  usageError.value = false
  usageDialogOpen.value = false
  usageTrigger.value = null
  if (value?.type === 'team') {
    void loadAgentMembers(value.id)
    void loadWorkspaceMembers(value.id)
    // 团队动态与通知只在团队分支加载；个人空间零请求（AC-23）。
    void loadActivitySummary(value.id)
    void loadNotificationState(value.id)
  }
}, { immediate: true })

/**
 * 空间用量在「角色门禁 + 空间」任一变化时重新判定：先作废在途请求并清空本地状态，
 * 只有 `canViewUsage` 为 true 才加载。角色未解析出来（名册请求仍在途或失败）时这里
 * 拿到的是 false，**不发请求**；名册返回后 computed 变化会自动触发一次加载。
 * 个人空间、成员与只读成员因此天然零请求（AC-30 / AC-23）。
 *
 * 注册在主 workspace watcher 之后，保证切换空间时先走上面的状态重置（含作废世代号）。
 */
watch(
  () => [canViewUsage.value, workspaceId.value] as const,
  ([allowed, id]) => {
    invalidateUsageRequests()
    usageSummary.value = null
    usageLoading.value = false
    usageError.value = false
    usageDialogOpen.value = false
    usageTrigger.value = null
    if (!allowed || !id) return
    void loadWorkspaceUsage(id)
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="contentStore.loading && !workspace" class="workspace-context-state">
    <el-skeleton :rows="8" animated />
  </div>

  <el-result
    v-else-if="!workspace"
    icon="warning"
    title="工作空间不存在或你没有访问权限"
    sub-title="请返回工作空间列表重新选择。"
  >
    <template #extra>
      <el-button type="primary" @click="router.push('/workspaces')">返回工作空间</el-button>
    </template>
  </el-result>

  <div
    v-else
    class="workspace-context-page"
    :class="{ 'workspace-context-page--collapsed': panelCollapsed }"
  >
    <main class="workspace-context-page__main">
      <header class="workspace-context-page__header">
        <nav class="workspace-context-tabs" role="tablist" aria-label="工作空间内容">
          <button
            v-for="(tab, index) in workspaceTabs"
            :id="`workspace-tab-${tab.id}`"
            :key="tab.id"
            ref="tabButtonRefs"
            class="workspace-context-tabs__item"
            :class="{ 'is-active': activeTab === tab.id }"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :aria-controls="`workspace-panel-${tab.id}`"
            :tabindex="activeTab === tab.id ? 0 : -1"
            @click="selectTab(tab.id)"
            @keydown="onTabKeydown($event, index)"
          >
            <el-icon><component :is="tab.icon" /></el-icon>
            <span>{{ tab.label }}</span>
            <small>{{ tab.count }}</small>
          </button>
        </nav>

        <div class="workspace-context-page__header-actions">
          <button
            v-if="panelCollapsed"
            class="workspace-context-page__panel-open"
            type="button"
            aria-label="展开工作空间信息"
            @click="panelCollapsed = false"
          >
            <el-icon><InfoFilled /></el-icon>
            <span>空间信息</span>
            <el-icon><ArrowRight /></el-icon>
          </button>

          <button
            class="workspace-context-page__mobile-info"
            type="button"
            aria-label="查看工作空间信息"
            @click="mobileInfoOpen = true"
          >
            <el-icon><InfoFilled /></el-icon>
            <span>空间信息</span>
          </button>
        </div>
      </header>

      <el-alert
        v-if="isArchived"
        data-testid="workspace-archived-alert"
        class="workspace-context-page__archive"
        type="warning"
        :closable="false"
        show-icon
      >
        <template #title>
          <span class="workspace-context-page__archive-text">该空间已归档，仅保留有权限的只读查看与下载</span>
          <el-button
            v-if="isOwner"
            data-testid="workspace-restore"
            type="primary"
            plain
            size="small"
            @click="restoreWorkspace"
          >
            恢复空间
          </el-button>
        </template>
      </el-alert>

      <div class="workspace-context-page__content">
        <section
          v-show="activeTab === 'conversation'"
          id="workspace-panel-conversation"
          class="workspace-conversation-pane"
          role="tabpanel"
          aria-labelledby="workspace-tab-conversation"
        >
          <div
            v-if="showConversationViewSwitch"
            class="panel workspace-conversation-pane__viewbar"
            data-testid="conversation-view-switch"
            role="tablist"
            aria-label="对话视图"
          >
            <button
              v-for="view in conversationViews"
              :key="view.id"
              class="workspace-conversation-pane__view"
              :class="{ 'is-active': conversationView === view.id }"
              type="button"
              role="tab"
              :aria-selected="conversationView === view.id"
              @click="setConversationView(view.id)"
            >
              {{ view.label }}
            </button>
          </div>

          <div class="workspace-conversation-pane__body">
            <ConversationStarter
              v-if="showConversationStarter"
              v-show="conversationView === 'new'"
              ref="starterRef"
              embedded
              :workspace-id="workspace.id"
              :workspace-name="workspace.name"
              workspace-locked
              :title="`在“${workspace.name}”中开始对话`"
              :preset-agent-member="isTeam ? presetAgentMember : null"
              :startable-agent-member-ids="isTeam ? startableAgentMemberIds : []"
              :requires-agent-member="isTeam"
              :can-discuss="!isTeam || canWriteTeamContent"
              :mention-options="isTeam ? startableMentionOptions : []"
            />

            <WorkspaceSessionHistory
              v-if="showSessionHistory"
              :workspace-id="workspace.id"
              :workspace-name="workspace.name"
              :can-start-conversation="!isArchived && canWriteTeamContent"
              :archived="isArchived"
              @start-new="setConversationView('new')"
            />
          </div>
        </section>

        <section
          v-if="activeTab === 'files'"
          id="workspace-panel-files"
          class="workspace-tab-pane"
          role="tabpanel"
          aria-labelledby="workspace-tab-files"
        >
          <header class="workspace-tab-pane__header">
            <div>
              <span class="workspace-tab-pane__eyebrow">{{ isPersonal ? '个人资料' : '团队资源' }}</span>
              <h1>{{ isPersonal ? '文件' : '共享文件' }}</h1>
              <p>{{ isPersonal ? '管理仅你可访问的资料，并将指定文件直接引用到新对话。' : '查看团队在当前工作空间共享的资料，并将指定文件直接引用到新对话。' }}</p>
            </div>
            <el-button
              v-if="!isArchived"
              data-testid="workspace-upload"
              type="primary"
              :icon="Plus"
              :loading="uploading"
              @click="uploadFile"
            >
              上传文件
            </el-button>
            <input ref="uploadInput" class="visually-hidden" type="file" accept=".pdf,.docx,.xlsx,.csv,.txt,.md" @change="onUploadSelected" />
            <!-- 执行轨：上传新版本入口只在「团队 + 活跃 + 非只读成员」时存在。 -->
            <input
              v-if="canUploadFileVersions"
              ref="versionUploadInput"
              data-testid="workspace-file-upload-input"
              class="visually-hidden"
              type="file"
              accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
              @change="onVersionUploadSelected"
            />
          </header>

          <div v-if="workspace.files.length" class="workspace-file-list panel">
            <article v-for="file in workspace.files" :key="file.id" class="workspace-file-row">
              <span class="workspace-file-row__icon"><el-icon><Files /></el-icon></span>
              <div class="workspace-file-row__copy">
                <strong class="workspace-file-row__name">
                  <span class="workspace-file-row__name-text">{{ file.name }}</span>
                  <span
                    v-if="fileVersionLabel(file)"
                    data-testid="workspace-file-version"
                    class="workspace-file-row__version"
                  >{{ fileVersionLabel(file) }}</span>
                </strong>
                <span class="workspace-file-row__meta">{{ file.size }} · {{ file.uploadedBy }}上传 · {{ file.uploadedAt }}</span>
                <span
                  v-if="versionUploadError && versionUploadError.logicalFileId === file.logicalFileId"
                  data-testid="workspace-file-upload-error"
                  class="workspace-file-row__error"
                  role="alert"
                >
                  上传新版本失败：{{ versionUploadError.message }}。原版本未受影响，仍显示 {{ formatFileVersionLabel(file) }}。
                </span>
              </div>
              <span class="workspace-file-row__type">{{ file.type }}</span>
              <div class="workspace-file-row__actions">
                <el-button
                  v-if="showFileVersions(file)"
                  data-testid="workspace-file-versions"
                  plain
                  @click="openVersionDialog(file, $event)"
                >
                  版本
                </el-button>
                <el-button
                  v-if="canUploadFileVersions && file.logicalFileId"
                  data-testid="workspace-file-upload-version"
                  plain
                  :loading="versionUploadingId === file.logicalFileId"
                  :disabled="versionUploadingId !== null"
                  @click="uploadNewVersion(file)"
                >
                  上传新版本
                </el-button>
                <el-button v-if="!isArchived" plain @click="useWorkspaceFile(file)">引用到对话</el-button>
              </div>
            </article>
          </div>

          <el-empty v-else :description="isPersonal ? '我的空间暂无文件' : '当前工作空间暂无共享文件'">
            <el-button
              v-if="!isArchived"
              data-testid="workspace-upload-empty"
              type="primary"
              :icon="Plus"
              @click="uploadFile"
            >
              上传第一个文件
            </el-button>
          </el-empty>
        </section>

        <section
          v-if="activeTab === 'artifacts'"
          id="workspace-panel-artifacts"
          class="workspace-tab-pane"
          role="tabpanel"
          aria-labelledby="workspace-tab-artifacts"
        >
          <header class="workspace-tab-pane__header">
            <div>
              <span class="workspace-tab-pane__eyebrow">成果文件</span>
              <h1>成果</h1>
              <p>集中查看当前工作空间内生成的报告、表格和分析文件，并追溯来源运行。</p>
            </div>
            <span class="workspace-tab-pane__count">{{ workspaceArtifacts.length }} 个已加载成果</span>
          </header>

          <div v-if="workspaceArtifacts.length" class="workspace-artifact-grid">
            <ArtifactCard
              v-for="artifact in workspaceArtifacts"
              :key="artifact.id"
              :artifact="artifact"
              @download="download(artifact)"
              @preview="openArtifactPreview(artifact)"
            />
          </div>
          <el-empty v-else description="当前工作空间暂无成果文件" />
        </section>
      </div>
    </main>

    <aside v-if="!panelCollapsed" class="workspace-context-page__aside">
      <WorkspaceInfoPanel
        :workspace="workspace"
        :data-scopes="authStore.user.dataScopes"
        :current-user-role="currentUserRole"
        :agent-members="agentMembers"
        :active-agent-member-id="presetAgentMember?.id ?? ''"
        :activity-items="activitySummaryItems"
        :activity-loading="activityLoading"
        :activity-error="activityError"
        :notification-error="notificationError"
        :unread-count="activityUnread"
        :muted="activityMuted"
        :can-view-usage="canViewUsage"
        :usage-summary="usageSummary"
        :usage-loading="usageLoading"
        :usage-error="usageError"
        collapsible
        @collapse="panelCollapsed = true"
        @manage-members="memberDialogOpen = true"
        @open-settings="settingsDialogOpen = true"
        @start-agent-conversation="startAgentConversation"
        @view-all-activity="openActivityDrawer"
        @mark-activity-read="markActivityRead"
        @toggle-activity-mute="toggleActivityMute"
        @retry-activity="retryActivity"
        @view-usage-detail="openUsageDialog"
        @retry-usage="retryUsage"
      />
    </aside>

    <el-drawer
      v-model="mobileInfoOpen"
      class="workspace-context-drawer"
      direction="rtl"
      size="min(360px, 100vw)"
      :with-header="false"
    >
      <WorkspaceInfoPanel
        :workspace="workspace"
        :data-scopes="authStore.user.dataScopes"
        :current-user-role="currentUserRole"
        :agent-members="agentMembers"
        :active-agent-member-id="presetAgentMember?.id ?? ''"
        :activity-items="activitySummaryItems"
        :activity-loading="activityLoading"
        :activity-error="activityError"
        :notification-error="notificationError"
        :unread-count="activityUnread"
        :muted="activityMuted"
        :can-view-usage="canViewUsage"
        :usage-summary="usageSummary"
        :usage-loading="usageLoading"
        :usage-error="usageError"
        @manage-members="memberDialogOpen = true"
        @open-settings="settingsDialogOpen = true"
        @start-agent-conversation="startAgentConversation"
        @view-all-activity="openActivityDrawer"
        @mark-activity-read="markActivityRead"
        @toggle-activity-mute="toggleActivityMute"
        @retry-activity="retryActivity"
        @view-usage-detail="openUsageDialog"
        @retry-usage="retryUsage"
      />
    </el-drawer>

    <el-drawer
      v-model="activityDrawerOpen"
      class="workspace-activity-drawer"
      direction="rtl"
      size="min(420px, 100vw)"
      :with-header="false"
      aria-label="全部动态"
      :aria-labelledby="undefined"
    >
      <div class="workspace-activity-drawer__body" data-testid="activity-drawer">
        <header class="workspace-activity-drawer__header">
          <div>
            <span>团队上下文</span>
            <strong>全部动态</strong>
          </div>
          <button
            data-testid="activity-drawer-close"
            class="workspace-activity-drawer__close"
            type="button"
            aria-label="关闭全部动态"
            @click="activityDrawerOpen = false"
          >
            <el-icon><Close /></el-icon>
          </button>
        </header>

        <div class="workspace-activity-drawer__actions">
          <el-button
            v-if="activityUnread > 0 && !activityMuted"
            data-testid="activity-drawer-mark-read"
            size="small"
            @click="markActivityRead"
          >
            标记全部已读
          </el-button>
          <el-button
            data-testid="activity-drawer-mute"
            size="small"
            plain
            @click="toggleActivityMute"
          >
            {{ activityMuted ? '恢复提醒' : '关闭提醒' }}
          </el-button>
        </div>

        <el-skeleton v-if="activityDrawerLoading && !activityDrawerItems.length" :rows="6" animated />

        <div
          v-else-if="activityDrawerError && !activityDrawerItems.length"
          data-testid="activity-drawer-error"
          class="workspace-activity-drawer__error"
        >
          <p>动态加载失败</p>
          <el-button @click="loadActivityPage()">重试</el-button>
        </div>

        <el-empty v-else-if="!activityDrawerItems.length" description="暂无团队动态" />

        <div v-else-if="activityDrawerItems.length" class="workspace-activity-drawer__list">
          <article
            v-for="row in activityDrawerRows"
            :key="row.id"
            data-testid="activity-drawer-row"
            class="workspace-activity-drawer__row"
          >
            <p>{{ row.description }}</p>
            <time :datetime="row.occurredAt">{{ row.time }}</time>
          </article>
        </div>

        <!--
          分页脚与列表分开渲染：只要服务端还给了游标就必然给出「加载更多」出口，
          因此空首页带游标时不会出现「有游标却无处可点」的死角；首页加载后若条目
          为空则游标已被清空，这里也不会承诺还有更多。
        -->
        <div
          v-if="!activityDrawerLoading && !activityDrawerError && (activityDrawerItems.length > 0 || activityDrawerCursor)"
          class="workspace-activity-drawer__pager"
        >
          <el-button
            v-if="activityDrawerCursor"
            data-testid="activity-drawer-load-more"
            :loading="activityDrawerLoadingMore"
            @click="loadMoreActivity"
          >
            加载更多
          </el-button>
          <span v-else data-testid="activity-drawer-end">已加载全部</span>
        </div>
      </div>
    </el-drawer>

    <template v-if="isTeam">
      <WorkspaceMemberDialog
        v-model:open="memberDialogOpen"
        :workspace-id="workspace.id"
        :workspace-name="workspace.name"
        :current-user-role="currentUserRole"
        :members="workspaceMembers"
        :agent-members="agentMembers"
        :load-agent-members="false"
        :archived="isArchived"
        @refresh="refreshTeamMembers"
        @start-conversation="startAgentConversation"
      />

      <WorkspaceSettingsDialog
        v-model:open="settingsDialogOpen"
        :workspace-id="workspace.id"
        :workspace-name="workspace.name"
        :workspace-description="workspace.description"
        :workspace-status="workspace.status"
        :current-user-role="currentUserRole"
        :members="workspaceMembers"
        @saved="onWorkspaceSettingsSaved"
        @archive-changed="onWorkspaceStatusChanged"
        @transferred="refreshTeamMembers"
        @exited="router.push('/workspaces')"
      />

      <!--
        版本列表与历史下载属读取轨：归档空间仍可打开；「引用此版本」随执行轨
        （归档隐藏）。个人空间不渲染本组件，因此没有任何版本请求路径（AC-23）。
      -->
      <WorkspaceFileVersionsDialog
        v-if="versionDialogFile"
        v-model:open="versionDialogOpen"
        :workspace-id="workspace.id"
        :logical-file-id="versionDialogFile.logicalFileId"
        :file-name="versionDialogFile.name"
        :can-reference="canReferenceFileVersion"
        @reference="referenceFileVersion"
      />

      <!--
        空间用量详情（4-T2）：只在负责人/管理员时挂载，普通成员／只读成员与角色未
        解析时连组件都不存在（零请求）；个人空间外层 isTeam 已排除（AC-30 / AC-23）。
      -->
      <WorkspaceUsageDialog
        v-if="canViewUsage"
        v-model:open="usageDialogOpen"
        :workspace-id="workspace.id"
        :workspace-name="workspace.name"
      />
    </template>

    <!-- 成果预览属读取轨，个人空间与归档空间同样可用，因此不放在 isTeam 分支里。 -->
    <ArtifactPreviewDialog
      v-if="previewArtifact"
      v-model:open="previewOpen"
      :artifact="previewArtifact"
    />
  </div>
</template>

<style scoped>
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.workspace-context-state {
  min-height: 100vh;
  padding: 80px 10%;
  background: #fff;
}

.workspace-context-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  height: 100vh;
  overflow: hidden;
  background: #fff;
}

.workspace-context-page--collapsed {
  grid-template-columns: minmax(0, 1fr);
}

.workspace-context-page__main {
  display: flex;
  min-width: 0;
  height: 100vh;
  flex-direction: column;
  overflow: hidden;
}

.workspace-context-page__header {
  position: relative;
  z-index: 6;
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  border-bottom: 1px solid #e5e7e4;
  background: rgb(255 255 255 / 96%);
  box-shadow: 0 4px 18px rgb(31 40 35 / 3%);
  backdrop-filter: blur(10px);
}

.workspace-context-page__header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 0 18px 0 8px;
}

.workspace-context-page__panel-open,
.workspace-context-page__mobile-info {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid #e3e5e2;
  border-radius: 8px;
  color: #626762;
  background: #fff;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
}

.workspace-context-page__panel-open:hover,
.workspace-context-page__mobile-info:hover {
  border-color: #cbd5d0;
  color: #244d40;
  background: #f8fbf9;
}

.workspace-context-page__mobile-info {
  display: none;
}

.workspace-context-tabs {
  display: flex;
  min-width: 0;
  height: 52px;
  flex: 1;
  align-items: stretch;
  gap: 3px;
  padding: 0 18px;
  overflow-x: auto;
  scrollbar-width: none;
}

.workspace-context-tabs::-webkit-scrollbar {
  display: none;
}

.workspace-context-tabs__item {
  position: relative;
  display: inline-flex;
  min-width: 118px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 13px;
  border: 0;
  color: #777c77;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
  transition: color 140ms ease, background 140ms ease;
}

.workspace-context-tabs__item::after {
  position: absolute;
  right: 12px;
  bottom: -1px;
  left: 12px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: transparent;
  content: '';
}

.workspace-context-tabs__item:hover {
  color: #2b3b35;
  background: #f7f9f7;
}

.workspace-context-tabs__item:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: -3px;
  border-radius: 8px 8px 0 0;
}

.workspace-context-tabs__item.is-active {
  color: #205f4d;
  font-weight: 650;
}

.workspace-context-tabs__item.is-active::after {
  background: #2e8b70;
}

.workspace-context-tabs__item .el-icon {
  font-size: var(--dsh-font-size-subheading);
}

.workspace-context-tabs__item small {
  min-width: 20px;
  padding: 2px 5px;
  border-radius: 999px;
  color: #8b908c;
  background: #f0f2ef;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.workspace-context-tabs__item.is-active small {
  color: #296c59;
  background: #e8f4ef;
}

.workspace-context-page__content {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: #fff;
}

/* 归档只读提示条（design §2.7）：页头下、内容之上，负责人可在条内恢复空间。 */
.workspace-context-page__archive {
  flex: 0 0 auto;
  margin: 10px 20px 0;
  border-radius: 10px;
}

.workspace-context-page__archive :deep(.el-alert__title) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--dsh-font-size-caption);
}

.workspace-context-page__archive-text {
  min-width: 0;
}

.workspace-conversation-pane {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  background: #fff;
}

.workspace-conversation-pane__viewbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  min-height: 40px;
  margin: 12px 20px 0;
  padding: 4px;
  border-radius: 10px;
  box-shadow: none;
}

.workspace-conversation-pane__view {
  display: inline-flex;
  min-width: 92px;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  padding: 0 14px;
  border: 0;
  border-radius: 7px;
  color: #626762;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
  transition: color 140ms ease, background 140ms ease;
}

.workspace-conversation-pane__view:hover {
  color: #244d40;
  background: #f0f5f2;
}

.workspace-conversation-pane__view:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: -2px;
}

.workspace-conversation-pane__view.is-active {
  color: #1c5f4a;
  background: #e8f4ef;
  font-weight: 650;
}

.workspace-conversation-pane__body {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.workspace-context-page__aside {
  min-width: 0;
  height: 100vh;
  overflow: hidden;
  border-left: 1px solid #e5e7e4;
  box-shadow: -8px 0 28px rgb(32 42 36 / 3%);
}

.workspace-tab-pane {
  width: 100%;
  height: 100%;
  padding: 30px 32px 48px;
  overflow-y: auto;
  background: #f8faf8;
}

.workspace-tab-pane__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  width: 100%;
  gap: 24px;
  margin-bottom: 20px;
}

.workspace-tab-pane__eyebrow {
  color: #2d8068;
  font-size: var(--dsh-font-size-micro);
  font-weight: 750;
  letter-spacing: 0.1em;
}

.workspace-tab-pane__header h1 {
  margin: 5px 0 0;
  color: #202420;
  font-size: var(--dsh-font-size-page-title);
  font-weight: 680;
  letter-spacing: -0.025em;
}

.workspace-tab-pane__header p {
  margin: 7px 0 0;
  color: #737a75;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.workspace-tab-pane__count {
  flex: 0 0 auto;
  padding-bottom: 4px;
  color: #8b918c;
  font-size: var(--dsh-font-size-badge);
}

.workspace-file-list {
  width: 100%;
  overflow: hidden;
  box-shadow: none;
}

.workspace-file-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 64px auto;
  align-items: center;
  gap: 13px;
  min-height: 74px;
  padding: 12px 15px;
  border-bottom: 1px solid #e8ebe8;
  background: #fff;
}

.workspace-file-row:last-child {
  border-bottom: 0;
}

.workspace-file-row__icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 10px;
  color: #23715b;
  background: #eaf6f1;
  font-size: var(--dsh-font-size-section);
}

.workspace-file-row__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.workspace-file-row__copy strong {
  overflow: hidden;
  color: #303530;
  font-size: var(--dsh-font-size-caption);
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-file-row__meta {
  margin-top: 5px;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
}

.workspace-file-row__name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  overflow: hidden;
}

.workspace-file-row__name-text {
  overflow: hidden;
  min-width: 0;
  color: #303530;
  font-size: var(--dsh-font-size-caption);
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-file-row__version {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  color: #155e4b;
  background: #e7f4ee;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.workspace-file-row__error {
  overflow-wrap: anywhere;
  color: #8c3226;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.workspace-file-row__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.workspace-file-row__type {
  justify-self: center;
  padding: 3px 7px;
  border-radius: 5px;
  color: #66706b;
  background: #f0f2f0;
  font-size: var(--dsh-font-size-micro);
  font-weight: 700;
}

.workspace-artifact-grid {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(auto-fit, minmax(390px, 1fr));
  gap: 12px;
}

:deep(.workspace-context-drawer .el-drawer__body) {
  padding: 0;
}

/* 「查看全部」动态抽屉（design §2.9）：不占第四个主内容页签。 */
.workspace-activity-drawer__body {
  display: flex;
  height: 100%;
  flex-direction: column;
  background: #fafbf9;
}

.workspace-activity-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid #e5e8e4;
}

.workspace-activity-drawer__header > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.workspace-activity-drawer__header span {
  color: #969b97;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
  letter-spacing: 0.08em;
}

.workspace-activity-drawer__header strong {
  margin-top: 3px;
  color: #252825;
  font-size: var(--dsh-font-size-body);
  font-weight: 650;
}

.workspace-activity-drawer__close {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: #747a75;
  background: transparent;
  cursor: pointer;
}

.workspace-activity-drawer__close:hover {
  color: #202420;
  background: #eceeeb;
}

.workspace-activity-drawer__close:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: -2px;
}

.workspace-activity-drawer__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px 0;
}

.workspace-activity-drawer__list {
  min-height: 0;
  flex: 1;
  margin: 12px 18px 18px;
  overflow-y: auto;
  border: 1px solid #e6e8e5;
  border-radius: 11px;
  background: #fff;
}

.workspace-activity-drawer__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-bottom: 1px solid #eef0ed;
}

.workspace-activity-drawer__row:last-of-type {
  border-bottom: 0;
}

.workspace-activity-drawer__row p {
  margin: 0;
  color: #454a46;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
  /* 文件名可能极长：必须就地折行，不能把抽屉撑破。 */
  overflow-wrap: anywhere;
  word-break: break-word;
}

.workspace-activity-drawer__row time {
  color: #9ba09c;
  font-size: var(--dsh-font-size-micro);
}

.workspace-activity-drawer__pager {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 54px;
  border-top: 1px solid #eef0ed;
}

.workspace-activity-drawer__pager span {
  color: #909691;
  font-size: var(--dsh-font-size-micro);
}

.workspace-activity-drawer__error {
  padding: 24px 18px;
  text-align: center;
}

.workspace-activity-drawer__error p {
  margin: 0 0 12px;
  color: #747a75;
  font-size: var(--dsh-font-size-caption);
}

:deep(.workspace-activity-drawer .el-drawer__body) {
  padding: 0;
}

@media (max-width: 640px) {
  .workspace-activity-drawer__actions {
    flex-wrap: wrap;
    padding: 12px 14px 0;
  }

  .workspace-activity-drawer__list {
    margin: 12px 14px 14px;
  }
}

@media (max-width: 1180px) {
  .workspace-context-page,
  .workspace-context-page--collapsed {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace-context-page__aside,
  .workspace-context-page__panel-open {
    display: none;
  }

  .workspace-context-page__mobile-info {
    display: inline-flex;
  }
}

@media (max-width: 640px) {
  .workspace-context-tabs {
    padding: 0 8px;
  }

  .workspace-context-page__header-actions {
    padding-right: 10px;
    padding-left: 4px;
  }

  .workspace-context-tabs__item {
    min-width: 104px;
    padding: 0 8px;
  }

  .workspace-tab-pane {
    padding: 24px 14px 38px;
  }

  .workspace-conversation-pane__viewbar {
    margin: 10px 14px 0;
  }

  .workspace-tab-pane__header {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }

  .workspace-file-row {
    grid-template-columns: 42px minmax(0, 1fr) auto;
  }

  .workspace-file-row__type {
    display: none;
  }

  .workspace-file-row__actions {
    grid-column: 2 / -1;
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .workspace-artifact-grid {
    grid-template-columns: 1fr;
  }

}

@media (max-width: 520px) {
  .workspace-context-page__mobile-info span {
    display: none;
  }

  .workspace-context-page__mobile-info {
    width: 30px;
    padding: 0;
    justify-content: center;
  }

  .workspace-context-tabs__item small {
    display: none;
  }
}
</style>
