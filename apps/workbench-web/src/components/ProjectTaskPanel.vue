<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { spaceView, useSpaceRoutes } from '@/composables/space-routes'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Cpu, MoreFilled, Plus } from '@element-plus/icons-vue'

import { WorkbenchApiError, workbenchApi } from '@/api/client'
import { projectTaskDetailKey } from '@/composables/project-task-detail'
import type {
  ProjectTask,
  ProjectTaskAction,
  ProjectTaskEvent,
  ProjectTaskStatus,
  WorkspaceAgentMember,
  WorkspaceFile,
  WorkspaceMember,
} from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
import {
  defaultScheduleDraft,
  draftFromSchedule,
  formatRunMoment,
  isActiveRunStatus,
  runOutcomeLabel,
  runOutcomeTone,
  scheduleInputFromDraft,
  scheduleLabel,
  scheduleModeLabels,
  scheduleReasonLabel,
  weekdayOptions,
  type ScheduleDraft,
  type ScheduleMode,
} from '@/utils/project-task-schedule'

/**
 * 项目空间 S1：任务页签（docs/design/project-space-plan.md 第 5 节）。
 * S4（第 11 节）：两类任务都由人推进状态、标记完成；Agent 任务另有执行规则（手动 / 每天 / 工作日 / 每周），
 * 单次执行的结果只作为“最近执行”展示，不改任务状态。
 * 写入口按服务端返回的 allowedActions 渲染，服务端仍是最终裁决。
 *
 * 传入 detailTaskId 时展示任务详情（/workspaces/:id/tasks/:taskId，S3 设计稿）：主区是任务标题与
 * 任务对话（子路由 .../thread/:conversationId，两类任务都有），任务信息卡片传送到右栏顶部
 * （右栏不可见时就地显示）。任务对话经 projectTaskDetailKey 读取任务、事件并请求写动作。
 */
const props = defineProps<{
  workspaceId: string
  workspaceName: string
  /** 非只读成员且空间未归档。 */
  canWrite: boolean
  members: WorkspaceMember[]
  agentMembers: WorkspaceAgentMember[]
  files: WorkspaceFile[]
  /** 任务详情模式：当前查看的任务；为空时展示任务表格。 */
  detailTaskId?: string | null
  /** 任务信息卡片的传送目标（右栏中已挂载的元素）；为空时卡片在主区就地显示。 */
  taskInfoTarget?: HTMLElement | null
  /**
   * 协作模式（D37）：编辑、标记完成、移除收进标题行的操作菜单；没有右栏时显示一行任务摘要，
   * 任务信息另含任务说明。
   */
  collab?: boolean
  /** 协作模式：宿主能打开信息栏（宽屏）时，摘要的“显示任务信息”请宿主打开，否则就地展开。 */
  canOpenInfo?: boolean
}>()

const emit = defineEmits<{
  /** 协作模式：请宿主打开信息栏并切到任务信息。 */
  'open-info': []
  count: [value: number]
  /** 任务详情的标题（面包屑使用）；离开详情或读取失败时为空。 */
  'detail-title': [value: string]
  /** 写入被拒绝（如空间已在别处归档、角色变化）：宿主据此刷新空间状态与角色。 */
  stale: []
}>()

const route = useRoute()
const router = useRouter()
const tasks = ref<ProjectTask[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const loadError = ref(false)
const busyTaskId = ref('')
let requestSeq = 0

const statusLabels: Record<ProjectTaskStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  done: '已完成',
}

async function load() {
  const workspaceId = props.workspaceId
  if (!workspaceId) return
  const seq = ++requestSeq
  loading.value = true
  loadError.value = false
  try {
    const page = await workbenchApi.listProjectTasks(workspaceId)
    if (seq !== requestSeq) return
    tasks.value = page.items
    nextCursor.value = page.nextCursor
    emit('count', page.total)
  } catch {
    if (seq !== requestSeq) return
    loadError.value = true
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/** 加载下一页；游标由服务端给出，失败保留已加载内容并允许重试。 */
async function loadMore() {
  const workspaceId = props.workspaceId
  const cursor = nextCursor.value
  if (!workspaceId || !cursor || loadingMore.value) return
  const seq = requestSeq
  loadingMore.value = true
  try {
    const page = await workbenchApi.listProjectTasks(workspaceId, { cursor })
    // 加载期间切换了空间或列表已重新加载：丢弃这一页，避免把旧列表的任务追加进来。
    if (seq !== requestSeq) return
    tasks.value = [...tasks.value, ...page.items]
    nextCursor.value = page.nextCursor
  } catch {
    if (seq !== requestSeq) return
    ElMessage.error('加载更多任务失败，请重试')
  } finally {
    loadingMore.value = false
  }
}

/**
 * 写入失败后的收敛：页面不实时推送空间状态，停留在旧页面时（如空间已被负责人归档）
 * 写入会被服务端拒绝；此时重新拉取列表并通知宿主刷新空间，写入口随之隐藏（人工验收 7.2）。
 */
function onWriteFailed(error: unknown) {
  if (!(error instanceof WorkbenchApiError) || (error.status !== 403 && error.status !== 409)) return
  void refresh()
  emit('stale')
}

// ---------------------------------------------------------------------------
// 任务详情
// ---------------------------------------------------------------------------

const detailTask = ref<ProjectTask | null>(null)
const detailEvents = ref<ProjectTaskEvent[]>([])
const detailLoading = ref(false)
const detailError = ref('')
const stopping = ref(false)
let detailSeq = 0

const spaceRoutes = useSpaceRoutes()
const listPath = computed(() => spaceRoutes.tasks(props.workspaceId))

function taskPath(taskId: string) {
  return spaceRoutes.task(props.workspaceId, taskId)
}

/** 任务对话（会话视图：全部发言、执行记录与系统记录）；没有任务对话的旧任务为 null。 */
function threadPath(task: ProjectTask) {
  return task.sessionId ? spaceRoutes.taskThread(props.workspaceId, task.id, task.sessionId) : null
}

/**
 * 读取详情；停在详情根路径的 Agent 任务若已有线程，直接替换到线程子路由，
 * 使“打开任务”即看到线程（不依赖是哪一次读取：角色加载后的刷新会取代首次读取）。
 * 已在线程子路由上时只刷新任务信息。
 */
async function loadDetail() {
  const taskId = props.detailTaskId
  if (!taskId || !props.workspaceId) return
  const seq = ++detailSeq
  detailLoading.value = true
  detailError.value = ''
  try {
    const [task, events] = await Promise.all([
      workbenchApi.getProjectTask(props.workspaceId, taskId),
      workbenchApi.listProjectTaskEvents(props.workspaceId, taskId).catch(() => [] as ProjectTaskEvent[]),
    ])
    if (seq !== detailSeq) return
    detailTask.value = task
    detailEvents.value = events
    emit('detail-title', task.title)
    const path = threadPath(task)
    if (path && spaceView(route) === 'task' && props.detailTaskId === task.id) await router.replace(path)
  } catch (error) {
    if (seq !== detailSeq) return
    detailTask.value = null
    detailEvents.value = []
    emit('detail-title', '')
    // 只有服务端明确判定任务不存在时才这样提示；其他失败（含接口缺失）一律按加载失败处理。
    detailError.value = error instanceof WorkbenchApiError && error.code === 'project_task_not_found'
      ? '任务不存在或已被移除'
      : '任务加载失败'
  } finally {
    if (seq === detailSeq) detailLoading.value = false
  }
}

/** 写动作后的统一刷新：列表（页签计数）始终刷新，详情模式另刷新当前任务。 */
async function refresh() {
  await Promise.all([load(), props.detailTaskId ? loadDetail() : Promise.resolve()])
}

watch(() => props.detailTaskId, (taskId) => {
  detailTask.value = null
  detailEvents.value = []
  detailError.value = ''
  emit('detail-title', '')
  if (taskId) void loadDetail()
}, { immediate: true })

/** 当前任务对话里是否有执行中的 Agent 执行（停止入口）。 */
const detailRunning = computed(() =>
  detailTask.value?.assignee.type === 'agent' && isActiveRunStatus(detailTask.value.latestRunStatus))

/** “最近执行”进入该次执行详情：步骤、工具调用与成果核验。 */
function latestRunPath(task: ProjectTask) {
  return spaceRoutes.taskThread(props.workspaceId, task.id, task.latestRunId ?? '')
}

/** 协作模式没有右栏时，摘要下就地展开的完整任务信息；换任务时收起。 */
const inlineInfoOpen = ref(false)
watch(() => props.detailTaskId, () => { inlineInfoOpen.value = false })

type DetailCommand = 'edit' | 'complete' | 'reopen' | 'remove'
/** 协作模式的操作菜单：按权限列出，与工作模式卡片按钮和对话中的“标记完成”同一套写动作。 */
const detailMenuItems = computed(() => {
  const task = detailTask.value
  if (!task) return []
  const items: Array<{ command: DetailCommand; label: string }> = []
  if (can(task, 'edit')) items.push({ command: 'edit', label: '编辑任务' })
  if (can(task, 'complete') && task.status !== 'done') items.push({ command: 'complete', label: '标记完成' })
  if (can(task, 'set_status') && task.status === 'done') items.push({ command: 'reopen', label: '重新打开' })
  if (can(task, 'remove')) items.push({ command: 'remove', label: '移除任务' })
  return items
})

function onDetailCommand(command: DetailCommand) {
  const task = detailTask.value
  if (!task) return
  if (command === 'edit') openEdit(task)
  else if (command === 'complete') openComplete(task)
  else if (command === 'reopen') void setStatus(task, 'in_progress')
  else void removeTask(task)
}

async function stopRun() {
  const task = detailTask.value
  if (!task?.latestRunId || stopping.value) return
  stopping.value = true
  try {
    await workbenchApi.cancelRun(task.latestRunId)
    ElMessage.success('已请求停止执行')
    await refresh()
  } catch (error) {
    notifyActionFailure('停止执行', `任务“${task.title}”`, error, '稍后重试。')
  } finally {
    stopping.value = false
  }
}

provide(projectTaskDetailKey, {
  task: detailTask,
  events: detailEvents,
  can: (action) => Boolean(detailTask.value && can(detailTask.value, action)),
  start: async (prompt) => {
    const task = detailTask.value
    if (!task) return false
    return startTask(task, prompt)
  },
  openComplete: () => {
    if (detailTask.value) openComplete(detailTask.value)
  },
  refresh: () => refresh(),
  completeInMenu: Boolean(props.collab),
})

// 任务线程里续接、重试会切换到新的 Run：任务状态随之变化，重新读取。
watch(() => route.params.conversationId, (next, previous) => {
  if (props.detailTaskId && next && previous && next !== previous) void loadDetail()
}, { flush: 'post' })

watch(() => props.workspaceId, () => {
  tasks.value = []
  void load()
}, { immediate: true })

// 空间归档或本人角色变化后，已加载任务的 allowedActions 已过期：先按 canWrite 收起写入口，再重新拉取。
watch(() => props.canWrite, (writable) => {
  if (!writable) {
    editor.value.open = false
    completion.value.open = false
  }
  void refresh()
})

/** 写动作同时要求服务端允许与当前仍可写（归档、降为只读后立即隐藏，不等重新加载）。 */
function can(task: ProjectTask, action: ProjectTaskAction) {
  return props.canWrite && task.allowedActions.includes(action)
}

// ---------------------------------------------------------------------------
// 新建 / 编辑
// ---------------------------------------------------------------------------

const editor = ref<{
  open: boolean
  taskId: string | null
  title: string
  description: string
  assignee: string
  inputFileIds: string[]
  dueDate: string | null
  /** S4：Agent 任务的执行规则。 */
  schedule: ScheduleDraft
}>({ open: false, taskId: null, title: '', description: '', assignee: '', inputFileIds: [], dueDate: null, schedule: defaultScheduleDraft() })
const saving = ref(false)

/** 负责人选项：非只读员工成员 + 可用 Agent 成员；值编码为 `employee:<id>` / `agent:<id>`。 */
const employeeOptions = computed(() => props.members
  .filter(member => member.role !== 'viewer')
  .map(member => ({ value: `employee:${member.userId}`, label: member.displayName })))
const agentOptions = computed(() => props.agentMembers
  .filter(member => member.status === 'available')
  .map(member => ({ value: `agent:${member.id}`, label: member.name })))
const editorAssigneeIsAgent = computed(() => editor.value.assignee.startsWith('agent:'))
/** Agent 任务可引用已解析成功的共享文件（当前展示版本）。 */
const referenceableFiles = computed(() => props.files.filter(file => file.canReference === true))

function openCreate() {
  editor.value = {
    open: true, taskId: null, title: '', description: '', assignee: '', inputFileIds: [], dueDate: null,
    schedule: defaultScheduleDraft(),
  }
}

const scheduleModes = Object.entries(scheduleModeLabels).map(([value, label]) => ({ value: value as ScheduleMode, label }))

function openEdit(task: ProjectTask) {
  editor.value = {
    open: true,
    taskId: task.id,
    title: task.title,
    description: task.description,
    assignee: task.assignee.type === 'agent' ? `agent:${task.assignee.agentMemberId}` : `employee:${task.assignee.userId}`,
    inputFileIds: task.inputFiles.map(file => file.fileObjectId),
    dueDate: task.dueDate,
    schedule: draftFromSchedule(task.schedule),
  }
}

/** 保存任务；新建 Agent 任务时可“保存并立即执行”。 */
async function saveTask(startNow = false) {
  if (saving.value) return
  const title = editor.value.title.trim()
  if (!title) {
    ElMessage.warning('请填写任务标题')
    return
  }
  const [type, id] = editor.value.assignee.split(/:(.*)/s)
  if ((type !== 'employee' && type !== 'agent') || !id) {
    ElMessage.warning('请选择负责人')
    return
  }
  const input = {
    title,
    description: editor.value.description.trim(),
    assignee: { type, id } as const,
    inputFileIds: type === 'agent' ? editor.value.inputFileIds : [],
    dueDate: editor.value.dueDate || null,
    ...(type === 'agent' ? { schedule: scheduleInputFromDraft(editor.value.schedule) } : {}),
  }
  if (type === 'agent' && editor.value.schedule.mode === 'weekly' && !editor.value.schedule.weekdays.length) {
    ElMessage.warning('请选择每周执行的星期')
    return
  }
  saving.value = true
  try {
    if (editor.value.taskId) {
      await workbenchApi.updateProjectTask(props.workspaceId, editor.value.taskId, input)
      ElMessage.success('任务已更新')
      editor.value.open = false
      await refresh()
    } else {
      const created = await workbenchApi.createProjectTask(props.workspaceId, { ...input, ...(startNow ? { startNow: true } : {}) })
      ElMessage.success(startNow ? '任务已创建并开始执行' : '任务已创建')
      editor.value.open = false
      await refresh()
      if (startNow) openThread(created)
    }
  } catch (error) {
    // 保存失败保留表单输入。
    notifyActionFailure(editor.value.taskId ? '更新任务' : '创建任务', `项目空间“${props.workspaceName}”`, error, '检查负责人与引用文件后重试。')
    onWriteFailed(error)
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------------------
// 任务动作
// ---------------------------------------------------------------------------

async function startTask(task: ProjectTask, prompt?: string): Promise<boolean> {
  if (busyTaskId.value) return false
  busyTaskId.value = task.id
  try {
    const started = await workbenchApi.startProjectTask(props.workspaceId, task.id, `project-task-start-${task.id}-${crypto.randomUUID()}`, prompt)
    ElMessage.success(`已交给“${task.assignee.type === 'agent' ? task.assignee.name : ''}”执行`)
    await load()
    if (props.detailTaskId === started.id) {
      detailTask.value = started
      void loadDetail()
    } else {
      openThread(started)
    }
    return true
  } catch (error) {
    notifyActionFailure('启动任务', `任务“${task.title}”`, error, '确认负责的 Agent 仍可用后重试。')
    onWriteFailed(error)
    return false
  } finally {
    busyTaskId.value = ''
  }
}

/** 在任务详情内打开任务线程（不跳到“对话”页签）。 */
function openThread(task: ProjectTask) {
  const path = threadPath(task)
  if (!path) return
  if (props.detailTaskId === task.id) void router.replace(path)
  else void router.push(path)
}

/** S4：恢复因连续失败或规则设置人失效而暂停的定时执行。 */
async function resumeSchedule(task: ProjectTask) {
  if (busyTaskId.value) return
  busyTaskId.value = task.id
  try {
    await workbenchApi.resumeProjectTaskSchedule(props.workspaceId, task.id)
    ElMessage.success('已恢复定时执行')
    await refresh()
  } catch (error) {
    notifyActionFailure('恢复定时执行', `任务“${task.title}”`, error, '刷新后重试。')
    onWriteFailed(error)
  } finally {
    busyTaskId.value = ''
  }
}

/** 执行列 / 任务信息：规则状态（暂停、停止）与原因。 */
function scheduleStateText(task: ProjectTask): string {
  if (task.scheduleState === 'paused') return '已暂停'
  if (task.scheduleState === 'stopped' && task.schedule?.kind !== 'manual') return task.scheduleReason === 'completed' ? '已结束' : '已停止'
  return ''
}

async function setStatus(task: ProjectTask, status: 'todo' | 'in_progress') {
  if (busyTaskId.value) return
  busyTaskId.value = task.id
  try {
    await workbenchApi.setProjectTaskStatus(props.workspaceId, task.id, { status })
    await refresh()
  } catch (error) {
    notifyActionFailure('更新任务状态', `任务“${task.title}”`, error, '刷新后重试。')
    onWriteFailed(error)
  } finally {
    busyTaskId.value = ''
  }
}

const completion = ref<{ open: boolean; task: ProjectTask | null; note: string; fileIds: string[] }>({
  open: false, task: null, note: '', fileIds: [],
})
const completing = ref(false)
const deliverableFiles = computed(() => props.files.filter(file => file.canDownload !== false))

function openComplete(task: ProjectTask) {
  completion.value = { open: true, task, note: task.completionNote ?? '', fileIds: task.deliverableFiles.map(file => file.fileObjectId) }
}

async function completeTask() {
  const task = completion.value.task
  if (!task || completing.value) return
  completing.value = true
  try {
    await workbenchApi.setProjectTaskStatus(props.workspaceId, task.id, {
      status: 'done',
      completionNote: completion.value.note.trim(),
      deliverableFileIds: completion.value.fileIds,
    })
    completion.value.open = false
    ElMessage.success('任务已完成')
    await refresh()
  } catch (error) {
    notifyActionFailure('完成任务', `任务“${task.title}”`, error, '检查交付文件后重试。')
    onWriteFailed(error)
  } finally {
    completing.value = false
  }
}

async function removeTask(task: ProjectTask) {
  try {
    await ElMessageBox.confirm(
      '移除后任务不再出现在列表中；已有的任务线程与成果保留，可在历史对话与成果中查看。',
      `移除任务“${task.title}”？`,
      { confirmButtonText: '移除任务', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return
  }
  try {
    await workbenchApi.removeProjectTask(props.workspaceId, task.id)
    ElMessage.success('任务已移除')
    if (props.detailTaskId === task.id) void router.push(listPath.value)
    await load()
  } catch (error) {
    notifyActionFailure('移除任务', `任务“${task.title}”`, error, 'Agent 正在执行时请等待完成或先停止。')
    onWriteFailed(error)
  }
}

function assigneeInitial(task: ProjectTask) {
  return task.assignee.type === 'agent' ? '' : (task.assignee.displayName.trim().charAt(0) || '?').toUpperCase()
}

function assigneeLabel(task: ProjectTask) {
  return task.assignee.type === 'agent' ? `Agent · ${task.assignee.name}` : task.assignee.displayName
}

defineExpose({ reload: load })
</script>

<template>
  <section
    id="workspace-panel-tasks"
    class="project-tasks"
    :class="{ 'project-tasks--detail': detailTaskId }"
    role="tabpanel"
    aria-labelledby="workspace-tab-tasks"
  >
    <template v-if="!detailTaskId">
    <!-- 列表为空时由空状态提供“新建任务”，工具栏只在有任务时出现，不重复创建入口。 -->
    <header v-if="canWrite && tasks.length" class="project-tasks__toolbar">
      <el-button data-testid="project-task-create" :icon="Plus" @click="openCreate">
        新建任务
      </el-button>
    </header>

    <p v-if="loading && !tasks.length" class="project-tasks__muted">正在加载任务…</p>
    <el-alert v-else-if="loadError" type="error" :closable="false" show-icon title="任务加载失败">
      <el-button size="small" @click="load">重试</el-button>
    </el-alert>
    <template v-else-if="tasks.length">
      <div class="project-tasks__table-wrap">
        <table class="project-tasks__table" aria-label="项目任务">
          <thead>
            <tr>
              <th class="project-tasks__col-index" scope="col"><span class="visually-hidden">序号</span></th>
              <th scope="col">标题</th>
              <th class="project-tasks__col-status" scope="col">状态</th>
              <th class="project-tasks__col-assignee" scope="col">负责人</th>
              <th class="project-tasks__col-schedule" scope="col">执行</th>
              <th class="project-tasks__col-creator" scope="col">创建人</th>
              <th class="project-tasks__col-due" scope="col">截止</th>
              <th class="project-tasks__col-actions" scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(task, index) in tasks" :key="task.id" class="project-task" data-testid="project-task-row">
              <td class="project-tasks__col-index">{{ index + 1 }}</td>
              <td class="project-task__main">
                <RouterLink class="project-task__title" data-testid="project-task-open" :to="taskPath(task.id)">{{ task.title }}</RouterLink>
                <p v-if="task.description" class="project-task__description">{{ task.description }}</p>
                <p v-if="task.inputFiles.length" class="project-task__meta">
                  引用文件：{{ task.inputFiles.map(file => `${file.name}（V${file.versionNo}）`).join('、') }}
                </p>
                <p v-if="task.completionNote" class="project-task__note" data-testid="project-task-note">完成说明：{{ task.completionNote }}</p>
                <p v-if="task.deliverableFiles.length" class="project-task__meta">
                  交付文件：{{ task.deliverableFiles.map(file => file.name).join('、') }}
                </p>
              </td>
              <td class="project-tasks__col-status">
                <span class="project-task__status" :class="`project-task__status--${task.status}`" data-testid="project-task-status">
                  {{ statusLabels[task.status] }}
                </span>
              </td>
              <td class="project-tasks__col-assignee">
                <span class="project-task__person" data-testid="project-task-assignee-cell">
                  <span class="project-task__avatar" :class="{ 'project-task__avatar--agent': task.assignee.type === 'agent' }" aria-hidden="true">
                    <el-icon v-if="task.assignee.type === 'agent'"><Cpu /></el-icon>
                    <template v-else>{{ assigneeInitial(task) }}</template>
                  </span>
                  <span class="project-task__person-name">{{ assigneeLabel(task) }}</span>
                </span>
              </td>
              <td class="project-tasks__col-schedule" data-testid="project-task-schedule-cell">
                <template v-if="task.assignee.type === 'agent'">
                  <span class="project-task__schedule">
                    <span v-if="scheduleStateText(task)" class="project-task__schedule-state" :class="`project-task__schedule-state--${task.scheduleState}`">{{ scheduleStateText(task) }}</span>
                    {{ scheduleLabel(task.schedule) }}
                  </span>
                  <span v-if="task.scheduleState === 'paused' || (task.scheduleState === 'stopped' && task.scheduleReason !== 'completed' && task.schedule?.kind !== 'manual')" class="project-task__schedule-sub project-task__schedule-sub--danger">
                    {{ scheduleReasonLabel(task.scheduleReason) }}
                  </span>
                  <span v-else-if="task.latestRunStatus" class="project-task__schedule-sub" :class="`project-task__schedule-sub--${runOutcomeTone(task.latestRunStatus)}`">
                    上次{{ runOutcomeLabel(task.latestRunStatus) }} · {{ formatRunMoment(task.latestRunAt) }}
                  </span>
                  <span v-else class="project-task__schedule-sub">尚未执行</span>
                </template>
                <span v-else class="project-task__muted">—</span>
              </td>
              <td class="project-tasks__col-creator project-task__muted">{{ task.createdBy.displayName }}</td>
              <td class="project-tasks__col-due project-task__muted">{{ task.dueDate || '—' }}</td>
              <td class="project-tasks__col-actions">
                <div class="project-task__actions">
                  <el-button
                    v-if="can(task, 'resume')"
                    size="small"
                    :loading="busyTaskId === task.id"
                    @click="resumeSchedule(task)"
                  >
                    恢复
                  </el-button>
                  <el-button
                    v-if="can(task, 'start') && !isActiveRunStatus(task.latestRunStatus)"
                    size="small"
                    :loading="busyTaskId === task.id"
                    @click="startTask(task)"
                  >
                    立即执行
                  </el-button>
                  <template v-if="can(task, 'set_status')">
                    <el-button
                      v-if="task.status === 'todo' && task.assignee.type === 'employee'"
                      size="small"
                      :loading="busyTaskId === task.id"
                      @click="setStatus(task, 'in_progress')"
                    >
                      开始处理
                    </el-button>
                    <el-button
                      v-if="task.status === 'done'"
                      size="small"
                      :loading="busyTaskId === task.id"
                      @click="setStatus(task, 'in_progress')"
                    >
                      重新打开
                    </el-button>
                  </template>
                  <el-button
                    v-if="can(task, 'complete') && task.status !== 'done'"
                    size="small"
                    type="success"
                    plain
                    @click="openComplete(task)"
                  >
                    完成
                  </el-button>
                  <el-button v-if="can(task, 'edit')" size="small" text @click="openEdit(task)">编辑</el-button>
                  <el-button v-if="can(task, 'remove')" size="small" text type="danger" @click="removeTask(task)">移除</el-button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <el-button
        v-if="nextCursor"
        class="project-tasks__more"
        :loading="loadingMore"
        data-testid="project-task-more"
        @click="loadMore"
      >
        加载更多任务
      </el-button>
    </template>
    <el-empty v-else description="还没有任务">
      <template v-if="canWrite">
        <p class="project-tasks__muted">从简报出发拆出第一项任务，交给同事或 Agent。</p>
        <el-button data-testid="project-task-create" type="primary" :icon="Plus" @click="openCreate">新建任务</el-button>
      </template>
    </el-empty>
    </template>

    <template v-else>
      <p v-if="detailLoading && !detailTask" class="project-task-detail__state project-tasks__muted">正在加载任务…</p>
      <div v-else-if="detailError && !detailTask" class="project-task-detail__state">
        <el-alert type="error" :closable="false" show-icon :title="detailError">
          <el-button size="small" @click="loadDetail()">重试</el-button>
        </el-alert>
      </div>

      <template v-else-if="detailTask">
        <header class="project-task-detail" :class="{ 'project-task-detail--collab': collab }" data-testid="project-task-detail">
          <h1 class="project-task-detail__title">{{ detailTask.title }}</h1>
          <div class="project-task-detail__header-actions">
            <el-button
              v-if="can(detailTask, 'start') && !detailRunning"
              data-testid="project-task-run-now"
              type="primary"
              :loading="busyTaskId === detailTask.id"
              @click="startTask(detailTask)"
            >
              立即执行
            </el-button>
            <el-button
              v-if="detailRunning && canWrite"
              data-testid="project-task-stop"
              type="danger"
              plain
              :loading="stopping"
              @click="stopRun"
            >
              停止
            </el-button>
            <!-- 协作模式（D37）：编辑、标记完成 / 重新打开、移除收进一个菜单，任务信息只做展示。 -->
            <el-dropdown v-if="collab && detailMenuItems.length" trigger="click" @command="onDetailCommand">
              <el-button data-testid="project-task-more" aria-label="更多任务操作" :icon="MoreFilled" />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item
                    v-for="item in detailMenuItems"
                    :key="item.command"
                    :command="item.command"
                    :class="{ 'project-task-menu__danger': item.command === 'remove' }"
                  >
                    {{ item.label }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </header>

        <!-- 协作模式没有右栏（收起或窄屏）时：一行任务摘要，可展开完整任务信息或请宿主打开信息栏。 -->
        <div v-if="collab && !taskInfoTarget" class="project-task-summary" data-testid="project-task-summary">
          <span class="project-task__status" :class="`project-task__status--${detailTask.status}`">{{ statusLabels[detailTask.status] }}</span>
          <span>{{ assigneeLabel(detailTask) }}</span>
          <template v-if="detailTask.assignee.type === 'agent'">
            <span class="project-task-summary__sep" aria-hidden="true">|</span>
            <span>{{ scheduleLabel(detailTask.schedule) }}</span>
            <template v-if="detailTask.latestRunStatus && detailTask.latestRunId">
              <span class="project-task-summary__sep" aria-hidden="true">|</span>
              <RouterLink class="project-task-summary__run" :to="latestRunPath(detailTask)" title="查看这次执行的详情">
                <span class="project-task__run-dot" :class="`project-task__run-dot--${runOutcomeTone(detailTask.latestRunStatus)}`" aria-hidden="true"></span>
                最近{{ runOutcomeLabel(detailTask.latestRunStatus) }} · {{ formatRunMoment(detailTask.latestRunAt) }}
              </RouterLink>
            </template>
          </template>
          <template v-else-if="detailTask.dueDate">
            <span class="project-task-summary__sep" aria-hidden="true">|</span>
            <span>截止 {{ detailTask.dueDate }}</span>
          </template>
          <el-button
            class="project-task-summary__toggle"
            link
            type="primary"
            data-testid="project-task-summary-toggle"
            :aria-expanded="canOpenInfo ? undefined : inlineInfoOpen"
            @click="canOpenInfo ? emit('open-info') : (inlineInfoOpen = !inlineInfoOpen)"
          >
            {{ canOpenInfo ? '显示任务信息' : inlineInfoOpen ? '收起任务信息' : '全部任务信息' }}
          </el-button>
        </div>

        <!-- 任务信息卡片：右栏可见时传送到右栏顶部，否则就地显示在标题下方（协作模式就地时按摘要展开）。 -->
        <Teleport defer :to="taskInfoTarget || 'body'" :disabled="!taskInfoTarget">
          <section
            v-if="taskInfoTarget || !collab || inlineInfoOpen"
            class="project-task-info"
            :class="{ 'project-task-info--inline': !taskInfoTarget }"
            aria-label="任务属性"
            data-testid="project-task-info"
          >
            <dl class="project-task-info__facts">
              <dt>状态</dt>
              <dd>
                <span class="project-task__status" :class="`project-task__status--${detailTask.status}`" data-testid="project-task-detail-status">
                  {{ statusLabels[detailTask.status] }}
                </span>
              </dd>
              <dt>负责人</dt>
              <dd>
                <span class="project-task__person">
                  <span class="project-task__avatar" :class="{ 'project-task__avatar--agent': detailTask.assignee.type === 'agent' }" aria-hidden="true">
                    <el-icon v-if="detailTask.assignee.type === 'agent'"><Cpu /></el-icon>
                    <template v-else>{{ assigneeInitial(detailTask) }}</template>
                  </span>
                  <span class="project-task__person-name">{{ assigneeLabel(detailTask) }}</span>
                </span>
              </dd>
              <template v-if="detailTask.assignee.type === 'agent'">
                <dt>执行规则</dt>
                <dd class="project-task-info__schedule" data-testid="project-task-schedule">
                  <span>
                    <span v-if="scheduleStateText(detailTask)" class="project-task__schedule-state" :class="`project-task__schedule-state--${detailTask.scheduleState}`">{{ scheduleStateText(detailTask) }}</span>
                    {{ scheduleLabel(detailTask.schedule) }}
                  </span>
                  <el-button v-if="can(detailTask, 'edit')" link type="primary" size="small" data-testid="project-task-schedule-edit" @click="openEdit(detailTask)">修改</el-button>
                </dd>
                <template v-if="detailTask.scheduleState === 'paused' || (detailTask.scheduleState === 'stopped' && detailTask.schedule?.kind !== 'manual' && detailTask.scheduleReason !== 'completed')">
                  <dt>定时</dt>
                  <dd class="project-task-info__schedule" data-testid="project-task-schedule-reason">
                    <span class="project-task__schedule-sub--danger">{{ scheduleReasonLabel(detailTask.scheduleReason) }}</span>
                    <el-button v-if="can(detailTask, 'resume')" link type="primary" size="small" data-testid="project-task-schedule-resume" :loading="busyTaskId === detailTask.id" @click="resumeSchedule(detailTask)">恢复</el-button>
                  </dd>
                </template>
                <template v-else-if="detailTask.schedule?.kind !== 'manual' && detailTask.nextRunAt">
                  <dt>下次执行</dt>
                  <dd data-testid="project-task-next-run">{{ formatRunMoment(detailTask.nextRunAt) }}</dd>
                </template>
                <dt>最近执行</dt>
                <dd :class="{ 'project-task-info__empty': !detailTask.latestRunStatus }" data-testid="project-task-latest-run">
                  <!-- “最近执行”进入该次执行详情（取代标题栏的“执行详情”按钮，D37）。 -->
                  <RouterLink
                    v-if="detailTask.latestRunStatus && detailTask.latestRunId"
                    class="project-task-info__run-link"
                    data-testid="project-task-latest-run-link"
                    :to="latestRunPath(detailTask)"
                    title="查看这次执行的详情"
                  >
                    <span class="project-task__run-dot" :class="`project-task__run-dot--${runOutcomeTone(detailTask.latestRunStatus)}`" aria-hidden="true"></span>
                    {{ runOutcomeLabel(detailTask.latestRunStatus) }} · {{ formatRunMoment(detailTask.latestRunAt) }}
                  </RouterLink>
                  <template v-else-if="detailTask.latestRunStatus">
                    <span class="project-task__run-dot" :class="`project-task__run-dot--${runOutcomeTone(detailTask.latestRunStatus)}`" aria-hidden="true"></span>
                    {{ runOutcomeLabel(detailTask.latestRunStatus) }} · {{ formatRunMoment(detailTask.latestRunAt) }}
                  </template>
                  <template v-else>尚未执行</template>
                </dd>
              </template>
              <dt>创建人</dt>
              <dd>{{ detailTask.createdBy.displayName }}</dd>
              <dt>截止</dt>
              <dd :class="{ 'project-task-info__empty': !detailTask.dueDate }">{{ detailTask.dueDate || '未设置' }}</dd>
              <template v-if="detailTask.assignee.type === 'agent'">
                <dt>引用文件</dt>
                <dd :class="{ 'project-task-info__empty': !detailTask.inputFiles.length }">
                  {{ detailTask.inputFiles.length ? detailTask.inputFiles.map(file => `${file.name}（V${file.versionNo}）`).join('、') : '无' }}
                </dd>
              </template>
              <template v-else>
                <dt>交付文件</dt>
                <dd :class="{ 'project-task-info__empty': !detailTask.deliverableFiles.length }">
                  {{ detailTask.deliverableFiles.length ? detailTask.deliverableFiles.map(file => file.name).join('、') : detailTask.status === 'done' ? '无' : '完成时附上' }}
                </dd>
              </template>
            </dl>
            <div v-if="collab && detailTask.description" class="project-task-info__description" data-testid="project-task-description">
              <h2>任务说明</h2>
              <p>{{ detailTask.description }}</p>
            </div>
            <div
              v-if="!collab && (can(detailTask, 'edit') || can(detailTask, 'remove') || (can(detailTask, 'set_status') && detailTask.status === 'done'))"
              class="project-task-info__actions"
            >
              <el-button v-if="can(detailTask, 'set_status') && detailTask.status === 'done'" :loading="busyTaskId === detailTask.id" @click="setStatus(detailTask, 'in_progress')">重新打开</el-button>
              <el-button v-if="can(detailTask, 'edit')" @click="openEdit(detailTask)">编辑</el-button>
              <el-button v-if="can(detailTask, 'remove')" class="project-task-info__remove" @click="removeTask(detailTask)">移除</el-button>
            </div>
          </section>
        </Teleport>

        <div class="project-task-detail__thread">
          <RouterView v-if="spaceView(route) === 'task-thread'" />
          <p v-else-if="!detailTask.sessionId" class="project-task-detail__placeholder project-tasks__muted">
            这个任务还没有任务对话。
          </p>
        </div>
      </template>
    </template>

    <el-dialog
      v-model="editor.open"
      :title="editor.taskId ? '编辑任务' : '新建任务'"
      width="min(560px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      :append-to-body="false"
    >
      <form class="project-tasks__form" @submit.prevent="saveTask()">
        <div class="project-tasks__field">
          <span>任务标题</span>
          <el-input v-model="editor.title" data-testid="project-task-title" maxlength="120" show-word-limit aria-label="任务标题" />
        </div>
        <div class="project-tasks__field">
          <span>任务说明（可选）</span>
          <el-input
            v-model="editor.description"
            data-testid="project-task-description"
            type="textarea"
            :rows="4"
            maxlength="4000"
            placeholder="期望的交付物、注意事项"
            aria-label="任务说明"
          />
        </div>
        <div class="project-tasks__field">
          <span>负责人</span>
          <el-select v-model="editor.assignee" class="project-field__control" data-testid="project-task-assignee" placeholder="选择同事或 Agent" aria-label="负责人">
            <el-option-group v-if="employeeOptions.length" label="同事">
              <el-option v-for="option in employeeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-option-group>
            <el-option-group v-if="agentOptions.length" label="Agent">
              <el-option v-for="option in agentOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-option-group>
          </el-select>
        </div>
        <div v-if="editorAssigneeIsAgent" class="project-tasks__field">
          <span>引用共享文件（可选，最多 5 个）</span>
          <el-select
            class="project-field__control"
            v-model="editor.inputFileIds"
            multiple
            :multiple-limit="5"
            placeholder="选择已解析成功的共享文件"
            aria-label="引用共享文件"
          >
            <el-option
              v-for="file in referenceableFiles"
              :key="file.id"
              :label="file.versionNo ? `${file.name}（V${file.versionNo}）` : file.name"
              :value="file.id"
            />
          </el-select>
        </div>
        <div class="project-tasks__field">
          <span>截止时间（可选）</span>
          <el-date-picker v-model="editor.dueDate" class="project-field__control" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" clearable aria-label="截止时间" />
        </div>
        <fieldset v-if="editorAssigneeIsAgent" class="project-tasks__schedule" data-testid="project-task-schedule-editor">
          <legend>执行规则</legend>
          <el-radio-group v-model="editor.schedule.mode" aria-label="执行频率" data-testid="project-task-schedule-mode">
            <el-radio-button v-for="option in scheduleModes" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
          </el-radio-group>
          <el-checkbox-group v-if="editor.schedule.mode === 'weekly'" v-model="editor.schedule.weekdays" aria-label="每周执行的星期">
            <el-checkbox-button v-for="day in weekdayOptions" :key="day.value" :value="day.value">{{ day.label }}</el-checkbox-button>
          </el-checkbox-group>
          <div v-if="editor.schedule.mode !== 'manual'" class="project-tasks__schedule-time">
            <span>执行时间</span>
            <el-time-select
              v-model="editor.schedule.timeOfDay"
              start="00:00"
              step="00:30"
              end="23:30"
              :clearable="false"
              aria-label="执行时间"
              data-testid="project-task-schedule-time"
            />
          </div>
          <p class="project-tasks__muted">
            任何规则下都可以随时“立即执行”。任务标记完成、过了截止日期或连续失败 3 次时，定时执行会停止或暂停。
          </p>
        </fieldset>
        <p v-if="editor.taskId && editorAssigneeIsAgent" class="project-tasks__muted">改派给其他 Agent 后会从新的任务对话开始。</p>
      </form>
      <template #footer>
        <el-button @click="editor.open = false">取消</el-button>
        <el-button
          :type="!editor.taskId && editorAssigneeIsAgent ? 'default' : 'primary'"
          data-testid="project-task-save"
          :loading="saving"
          @click="saveTask()"
        >
          保存
        </el-button>
        <el-button
          v-if="!editor.taskId && editorAssigneeIsAgent"
          type="primary"
          data-testid="project-task-save-run"
          :loading="saving"
          @click="saveTask(true)"
        >
          保存并立即执行
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="completion.open"
      :title="`完成任务“${completion.task?.title ?? ''}”`"
      width="min(520px, calc(100vw - 32px))"
      :append-to-body="false"
    >
      <form class="project-tasks__form" @submit.prevent="completeTask">
        <div class="project-tasks__field">
          <span>完成说明（可选）</span>
          <el-input
            v-model="completion.note"
            data-testid="project-task-completion-note"
            type="textarea"
            :rows="4"
            maxlength="4000"
            aria-label="完成说明"
          />
        </div>
        <div class="project-tasks__field">
          <span>交付文件（可选，从共享文件中选择）</span>
          <el-select v-model="completion.fileIds" class="project-field__control" multiple :multiple-limit="5" placeholder="选择共享文件" aria-label="交付文件">
            <el-option v-for="file in deliverableFiles" :key="file.id" :label="file.name" :value="file.id" />
          </el-select>
        </div>
      </form>
      <template #footer>
        <el-button @click="completion.open = false">取消</el-button>
        <el-button type="primary" data-testid="project-task-complete-confirm" :loading="completing" @click="completeTask">确认完成</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.project-tasks {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  padding: 16px 24px 40px;
  overflow-y: auto;
  background: #fff;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* 工具栏：右侧创建入口。 */
.project-tasks__toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  margin-bottom: 14px;
}

.project-tasks__muted {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.project-tasks__more {
  align-self: center;
  margin-top: 14px;
}

.project-tasks__table-wrap {
  overflow-x: auto;
  border: 1px solid #e6e7e9;
  border-radius: 10px;
}

/* 列宽按内容分配：除标题外各列不换行，标题列保底宽度；放不下时整表横向滚动。 */
.project-tasks__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--dsh-font-size-body);
}

.project-tasks__table th,
.project-tasks__table td {
  padding: 12px 14px;
  border-bottom: 1px solid #ececee;
  text-align: left;
  vertical-align: middle;
}

.project-tasks__table th + th,
.project-tasks__table td + td {
  border-left: 1px solid #ececee;
}

.project-tasks__table th {
  color: #3a3d3b;
  background: #fafafb;
  font-weight: 600;
}

.project-tasks__table tbody tr:last-child td {
  border-bottom: 0;
}

.project-tasks__table tbody tr:hover td {
  background: #fafbfc;
}

.project-tasks__table th:not(.project-task__main):not(:nth-child(2)),
.project-tasks__table td:not(.project-task__main) {
  white-space: nowrap;
}

.project-tasks__col-index {
  width: 44px;
  color: #8a8e8b;
  text-align: center !important;
}

.project-tasks__table th:nth-child(2),
.project-task__main {
  min-width: 160px;
}

.project-task__title {
  display: block;
  color: var(--dsh-color-ink);
  font-weight: 500;
  overflow-wrap: anywhere;
  text-decoration: none;
}

.project-task__title:hover {
  color: #2f6bdc;
  text-decoration: underline;
}

.project-task__title:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: 2px;
  border-radius: 4px;
}

/* 任务详情（S3 设计稿）：主区只有任务标题与任务对话；任务信息卡片在右栏顶部。 */
.project-tasks--detail {
  padding: 0;
  overflow: hidden;
}

.project-task-detail {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
  padding: 18px 32px 12px;
}

.project-task-detail__title {
  min-width: 0;
  flex: 1 1 auto;
  margin: 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-heading);
  font-weight: 650;
  overflow-wrap: anywhere;
}

.project-task-detail__header-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.project-task-detail__header-actions .el-button + .el-button {
  margin-left: 0;
}

.project-task-detail__state {
  padding: 24px 32px;
}

.project-task-detail__thread {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.project-task-detail__placeholder {
  margin: 0;
  padding: 32px;
}

.project-task-info {
  padding: 6px 16px 14px;
  border: 1px solid #ebecee;
  border-radius: 14px;
  background: #fff;
}

.project-task-info--inline {
  margin: 0 32px 12px;
}

/* 协作模式（D37）：标题行在群组页签之下，与任务对话之间以细线分隔。 */
.project-task-detail--collab {
  padding: 12px 20px;
  border-bottom: 1px solid #f0f1f3;
}

.project-task-detail--collab .project-task-detail__title {
  font-size: var(--dsh-font-size-section);
}

.project-task-summary {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin: 12px 20px 0;
  padding: 8px 14px;
  border: 1px solid #ebecee;
  border-radius: 12px;
  background: #fafbfc;
  color: #3d403e;
  font-size: var(--dsh-font-size-caption);
}

.project-task-summary__sep {
  color: #d0d5dd;
}

.project-task-summary__run,
.project-task-info__run-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: inherit;
  text-decoration: underline;
  text-decoration-color: #d0d5dd;
  text-underline-offset: 3px;
}

.project-task-summary__run:hover,
.project-task-info__run-link:hover {
  color: var(--dsh-color-brand);
  text-decoration-color: currentColor;
}

.project-task-summary__toggle {
  margin-left: auto;
}

.project-task-info__description {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #f0f1f3;
}

.project-task-info__description h2 {
  margin: 0 0 6px;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.project-task-info__description p {
  margin: 0;
  color: #5f6461;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

:global(.project-task-menu__danger) {
  color: var(--dsh-color-danger) !important;
}

.project-task-summary + .project-task-info--inline {
  margin: 8px 20px 0;
}

.project-task-info__facts {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  margin: 0;
  font-size: var(--dsh-font-size-caption);
}

.project-task-info__facts dt,
.project-task-info__facts dd {
  display: flex;
  min-width: 0;
  align-items: center;
  min-height: 40px;
  margin: 0;
  border-top: 1px solid #f1f2f3;
  overflow-wrap: anywhere;
}

.project-task-info__facts dt {
  color: #8a8e8b;
}

.project-task-info__facts dd {
  color: #2c2f2d;
  line-height: 1.5;
}

.project-task-info__facts dt:first-of-type,
.project-task-info__facts dd:first-of-type {
  border-top: 0;
}

.project-task-info__empty {
  color: #8a8e8b !important;
}

.project-task-info__actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.project-task-info__actions .el-button {
  flex: 1 1 0;
  margin-left: 0;
}

.project-task-info__remove {
  color: var(--dsh-color-danger);
}

.project-task__muted {
  color: #5f6360;
}

.project-task__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: 8px;
  background: #f1f2f3;
  color: #4b4f4c;
  font-size: var(--dsh-font-size-caption);
  white-space: nowrap;
}

.project-task__status::before {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border: 2px solid currentcolor;
  border-radius: 50%;
  content: '';
}

.project-task__status--in_progress {
  background: #eef4ff;
  color: #2f6bdc;
}

.project-task__status--in_progress::before {
  background: linear-gradient(90deg, transparent 50%, currentcolor 50%);
}

.project-task__status--done {
  background: var(--dsh-color-success-soft);
  color: var(--dsh-color-success);
}

.project-task__status--done::before {
  background: currentcolor;
}

/* S4：执行列与任务信息中的执行规则、最近执行。 */
.project-tasks__col-schedule {
  min-width: 132px;
}

.project-task__schedule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.project-task__schedule-state {
  padding: 0 6px;
  border-radius: 5px;
  background: #f1f2f3;
  color: #4b4f4c;
  font-size: var(--dsh-font-size-badge);
  line-height: 18px;
}

.project-task__schedule-state--paused {
  background: #fff3e6;
  color: #a2520b;
}

.project-task__schedule-sub {
  display: block;
  margin-top: 2px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.project-task__schedule-sub--success {
  color: var(--dsh-color-success);
}

.project-task__schedule-sub--danger {
  color: var(--dsh-color-danger);
}

.project-task__schedule-sub--active {
  color: #2459c2;
}

.project-task-info__schedule {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.project-task__run-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 4px;
  border-radius: 50%;
  background: var(--dsh-color-muted);
  vertical-align: middle;
}

.project-task__run-dot--success {
  background: var(--dsh-color-success);
}

.project-task__run-dot--danger {
  background: var(--dsh-color-danger);
}

.project-task__run-dot--active {
  background: #2459c2;
}

.project-tasks__schedule {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid #e6e8ea;
  border-radius: 12px;
}

.project-tasks__schedule legend {
  padding: 0 6px;
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-caption);
}

.project-tasks__schedule-time {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-caption);
}

.project-tasks__schedule .project-tasks__muted {
  margin: 0;
}

.project-task__person {
  display: inline-flex;
  max-width: 150px;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 4px;
  border-radius: 8px;
  background: #f4f5f6;
  color: #2c2f2d;
}

.project-task__person-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-task__avatar {
  display: grid;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: #f29d38;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.project-task__avatar--agent {
  color: #176750;
  background: #e1f1eb;
}

.project-task__description,
.project-task__note {
  margin: 4px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.project-task__note {
  color: var(--dsh-color-text);
}

.project-task__meta {
  margin: 4px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
  overflow-wrap: anywhere;
}

.project-task__actions {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
}

.project-task__actions .el-button + .el-button {
  margin-left: 0;
}

.project-tasks__form {
  display: grid;
  gap: 16px;
}

.project-tasks__field {
  display: grid;
  gap: 6px;
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-caption);
}

@media (max-width: 720px) {
  .project-tasks {
    padding: 14px 16px 40px;
  }

  .project-tasks--detail {
    padding: 0;
  }

  .project-task-detail {
    padding: 14px 16px 10px;
  }

  .project-task-info--inline {
    margin: 0 16px 10px;
  }
}

/* 下拉与日期控件在网格表单中显式撑满：宽度由内容决定时，Element Plus 的尺寸计算会在视口变化后反复抖动。 */
.project-field__control {
  width: 100%;
}
</style>
