<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Cpu, DataLine, Plus } from '@element-plus/icons-vue'

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

/**
 * 项目空间 S1：任务页签（docs/design/project-space-plan.md 第 5 节）。
 * 员工任务手动推进；Agent 任务即任务线程——启动后在线程里回复即可续接，状态由最近一次执行推算。
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
  /** 任务信息卡片的传送目标（右栏中的元素选择器）；为空时卡片在主区就地显示。 */
  taskInfoTarget?: string | null
}>()

const emit = defineEmits<{
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
  failed: '执行失败',
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

const listPath = computed(() => `/workspaces/${props.workspaceId}`)

function taskPath(taskId: string) {
  return `/workspaces/${props.workspaceId}/tasks/${taskId}`
}

/** 任务对话（会话视图：全部发言、执行记录与系统记录）；没有任务对话的旧任务为 null。 */
function threadPath(task: ProjectTask) {
  return task.sessionId ? `${taskPath(task.id)}/thread/${task.sessionId}` : null
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
    if (path && route.name === 'workspace-task' && props.detailTaskId === task.id) await router.replace(path)
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
  detailTask.value?.assignee.type === 'agent' && detailTask.value.status === 'in_progress' && Boolean(detailTask.value.latestRunId))

/** 执行详情：最近一次执行的步骤、工具调用与成果核验。 */
function openRunDetail() {
  const task = detailTask.value
  if (!task?.latestRunId) return
  void router.push(`${taskPath(task.id)}/thread/${task.latestRunId}`)
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
}>({ open: false, taskId: null, title: '', description: '', assignee: '', inputFileIds: [], dueDate: null })
const saving = ref(false)

/** 承接者选项：非只读员工成员 + 可用 Agent 成员；值编码为 `employee:<id>` / `agent:<id>`。 */
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
  editor.value = { open: true, taskId: null, title: '', description: '', assignee: '', inputFileIds: [], dueDate: null }
}

function openEdit(task: ProjectTask) {
  editor.value = {
    open: true,
    taskId: task.id,
    title: task.title,
    description: task.description,
    assignee: task.assignee.type === 'agent' ? `agent:${task.assignee.agentMemberId}` : `employee:${task.assignee.userId}`,
    inputFileIds: task.inputFiles.map(file => file.fileObjectId),
    dueDate: task.dueDate,
  }
}

async function saveTask() {
  if (saving.value) return
  const title = editor.value.title.trim()
  if (!title) {
    ElMessage.warning('请填写任务标题')
    return
  }
  const [type, id] = editor.value.assignee.split(/:(.*)/s)
  if ((type !== 'employee' && type !== 'agent') || !id) {
    ElMessage.warning('请选择承接者')
    return
  }
  const input = {
    title,
    description: editor.value.description.trim(),
    assignee: { type, id } as const,
    inputFileIds: type === 'agent' ? editor.value.inputFileIds : [],
    dueDate: editor.value.dueDate || null,
  }
  saving.value = true
  try {
    if (editor.value.taskId) await workbenchApi.updateProjectTask(props.workspaceId, editor.value.taskId, input)
    else await workbenchApi.createProjectTask(props.workspaceId, input)
    ElMessage.success(editor.value.taskId ? '任务已更新' : '任务已创建')
    editor.value.open = false
    await refresh()
  } catch (error) {
    // 保存失败保留表单输入。
    notifyActionFailure(editor.value.taskId ? '更新任务' : '创建任务', `项目空间“${props.workspaceName}”`, error, '检查承接者与引用文件后重试。')
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
    notifyActionFailure('启动任务', `任务“${task.title}”`, error, '确认承接的 Agent 仍可用后重试。')
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
              <th class="project-tasks__col-assignee" scope="col">承接人</th>
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
              <td class="project-tasks__col-creator project-task__muted">{{ task.createdBy.displayName }}</td>
              <td class="project-tasks__col-due project-task__muted">{{ task.dueDate || '—' }}</td>
              <td class="project-tasks__col-actions">
                <div class="project-task__actions">
                  <el-button
                    v-if="can(task, 'start')"
                    type="primary"
                    size="small"
                    :loading="busyTaskId === task.id"
                    @click="startTask(task)"
                  >
                    交给 Agent 执行
                  </el-button>
                  <template v-if="can(task, 'set_status')">
                    <el-button
                      v-if="task.status === 'todo'"
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
        <header class="project-task-detail" data-testid="project-task-detail">
          <h1 class="project-task-detail__title">{{ detailTask.title }}</h1>
          <div class="project-task-detail__header-actions">
            <el-button v-if="detailTask.latestRunId" data-testid="project-task-run-detail" :icon="DataLine" @click="openRunDetail">执行详情</el-button>
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
          </div>
        </header>

        <!-- 任务信息卡片：右栏可见时传送到右栏顶部，否则就地显示在标题下方。 -->
        <Teleport defer :to="taskInfoTarget || 'body'" :disabled="!taskInfoTarget">
          <section class="project-task-info" :class="{ 'project-task-info--inline': !taskInfoTarget }" aria-label="任务属性" data-testid="project-task-info">
            <dl class="project-task-info__facts">
              <dt>状态</dt>
              <dd>
                <span class="project-task__status" :class="`project-task__status--${detailTask.status}`" data-testid="project-task-detail-status">
                  {{ statusLabels[detailTask.status] }}
                </span>
              </dd>
              <dt>承接人</dt>
              <dd>
                <span class="project-task__person">
                  <span class="project-task__avatar" :class="{ 'project-task__avatar--agent': detailTask.assignee.type === 'agent' }" aria-hidden="true">
                    <el-icon v-if="detailTask.assignee.type === 'agent'"><Cpu /></el-icon>
                    <template v-else>{{ assigneeInitial(detailTask) }}</template>
                  </span>
                  <span class="project-task__person-name">{{ assigneeLabel(detailTask) }}</span>
                </span>
              </dd>
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
            <div v-if="can(detailTask, 'edit') || can(detailTask, 'remove') || (can(detailTask, 'set_status') && detailTask.status === 'done')" class="project-task-info__actions">
              <el-button v-if="can(detailTask, 'set_status') && detailTask.status === 'done'" :loading="busyTaskId === detailTask.id" @click="setStatus(detailTask, 'in_progress')">重新打开</el-button>
              <el-button v-if="can(detailTask, 'edit')" @click="openEdit(detailTask)">编辑</el-button>
              <el-button v-if="can(detailTask, 'remove')" class="project-task-info__remove" @click="removeTask(detailTask)">移除</el-button>
            </div>
          </section>
        </Teleport>

        <div class="project-task-detail__thread">
          <RouterView v-if="route.name === 'workspace-task-thread'" />
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
      <form class="project-tasks__form" @submit.prevent="saveTask">
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
          <span>承接者</span>
          <el-select v-model="editor.assignee" class="project-field__control" data-testid="project-task-assignee" placeholder="选择同事或 Agent" aria-label="承接者">
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
        <p v-if="editor.taskId && editorAssigneeIsAgent" class="project-tasks__muted">改派给其他 Agent 后会从新的任务线程开始。</p>
      </form>
      <template #footer>
        <el-button @click="editor.open = false">取消</el-button>
        <el-button type="primary" data-testid="project-task-save" :loading="saving" @click="saveTask">保存</el-button>
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

.project-task__status--failed {
  background: var(--dsh-color-danger-soft);
  color: var(--dsh-color-danger);
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
