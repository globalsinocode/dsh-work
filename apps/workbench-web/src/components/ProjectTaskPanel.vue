<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'

import { WorkbenchApiError, workbenchApi } from '@/api/client'
import type {
  ProjectTask,
  ProjectTaskAction,
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
 */
const props = defineProps<{
  workspaceId: string
  workspaceName: string
  /** 非只读成员且空间未归档。 */
  canWrite: boolean
  members: WorkspaceMember[]
  agentMembers: WorkspaceAgentMember[]
  files: WorkspaceFile[]
}>()

const emit = defineEmits<{
  count: [value: number]
  /** 写入被拒绝（如空间已在别处归档、角色变化）：宿主据此刷新空间状态与角色。 */
  stale: []
}>()

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
  void load()
  emit('stale')
}

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
  void load()
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
    await load()
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

async function startTask(task: ProjectTask) {
  if (busyTaskId.value) return
  busyTaskId.value = task.id
  try {
    const started = await workbenchApi.startProjectTask(props.workspaceId, task.id, `project-task-start-${task.id}-${crypto.randomUUID()}`)
    ElMessage.success(`已交给“${task.assignee.type === 'agent' ? task.assignee.name : ''}”执行`)
    await load()
    openThread(started)
  } catch (error) {
    notifyActionFailure('启动任务', `任务“${task.title}”`, error, '确认承接的 Agent 仍可用后重试。')
    onWriteFailed(error)
  } finally {
    busyTaskId.value = ''
  }
}

function openThread(task: ProjectTask) {
  const target = task.latestRunId ?? task.sessionId
  if (!target) return
  void router.push(`/workspaces/${props.workspaceId}/conversations/${target}`)
}

async function setStatus(task: ProjectTask, status: 'todo' | 'in_progress') {
  if (busyTaskId.value) return
  busyTaskId.value = task.id
  try {
    await workbenchApi.setProjectTaskStatus(props.workspaceId, task.id, { status })
    await load()
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
    await load()
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
    await load()
  } catch (error) {
    notifyActionFailure('移除任务', `任务“${task.title}”`, error, 'Agent 正在执行时请等待完成或先停止。')
    onWriteFailed(error)
  }
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
    role="tabpanel"
    aria-labelledby="workspace-tab-tasks"
  >
    <header class="project-tasks__header">
      <div>
        <span class="project-tasks__eyebrow">项目协作</span>
        <h1>任务</h1>
        <p>把项目拆成任务交给同事或 Agent。Agent 任务会开一个任务线程，在线程里回复即可继续交代，无需 @。</p>
      </div>
      <el-button v-if="canWrite" data-testid="project-task-create" type="primary" :icon="Plus" @click="openCreate">
        新建任务
      </el-button>
    </header>

    <p v-if="loading && !tasks.length" class="project-tasks__muted">正在加载任务…</p>
    <el-alert v-else-if="loadError" type="error" :closable="false" show-icon title="任务加载失败">
      <el-button size="small" @click="load">重试</el-button>
    </el-alert>
    <template v-else-if="tasks.length">
      <ul class="project-tasks__list" aria-label="项目任务">
        <li v-for="task in tasks" :key="task.id" class="project-task" data-testid="project-task-row">
          <div class="project-task__main">
            <div class="project-task__title">
              <strong>{{ task.title }}</strong>
              <span class="project-task__status" :class="`project-task__status--${task.status}`" data-testid="project-task-status">
                {{ statusLabels[task.status] }}
              </span>
            </div>
            <p v-if="task.description" class="project-task__description">{{ task.description }}</p>
            <p class="project-task__meta">
              承接：{{ assigneeLabel(task) }} · 创建：{{ task.createdBy.displayName }}
              <template v-if="task.dueDate"> · 截止 {{ task.dueDate }}</template>
            </p>
            <p v-if="task.inputFiles.length" class="project-task__meta">
              引用文件：{{ task.inputFiles.map(file => `${file.name}（V${file.versionNo}）`).join('、') }}
            </p>
            <p v-if="task.completionNote" class="project-task__note" data-testid="project-task-note">完成说明：{{ task.completionNote }}</p>
            <p v-if="task.deliverableFiles.length" class="project-task__meta">
              交付文件：{{ task.deliverableFiles.map(file => file.name).join('、') }}
            </p>
          </div>
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
            <el-button v-if="task.sessionId" size="small" @click="openThread(task)">打开任务线程</el-button>
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
        </li>
      </ul>
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
        <el-button type="primary" :icon="Plus" @click="openCreate">新建任务</el-button>
      </template>
    </el-empty>

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
  width: 100%;
  height: 100%;
  padding: 30px 32px 48px;
  overflow-y: auto;
  background: var(--dsh-color-canvas);
}

.project-tasks__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
}

.project-tasks__eyebrow {
  color: var(--dsh-color-brand);
  font-size: var(--dsh-font-size-micro);
  font-weight: 750;
  letter-spacing: 0.1em;
}

.project-tasks__header h1 {
  margin: 5px 0 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-page-title);
  font-weight: 680;
}

.project-tasks__header p {
  margin: 7px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.project-tasks__muted {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.project-tasks__more {
  justify-self: center;
  margin-top: 4px;
}

.project-tasks__list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.project-task {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-md);
  background: var(--dsh-color-panel);
}

.project-task__main {
  min-width: 0;
}

.project-task__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.project-task__title strong {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-body);
  font-weight: 650;
  overflow-wrap: anywhere;
}

.project-task__status {
  padding: 1px 8px;
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-subtle);
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.project-task__status--in_progress {
  background: var(--dsh-color-brand-soft);
  color: var(--dsh-color-brand-dark);
}

.project-task__status--done {
  background: var(--dsh-color-success-soft);
  color: var(--dsh-color-success);
}

.project-task__status--failed {
  background: var(--dsh-color-danger-soft);
  color: var(--dsh-color-danger);
}

.project-task__description,
.project-task__note {
  margin: 6px 0 0;
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.project-task__meta {
  margin: 6px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
  overflow-wrap: anywhere;
}

.project-task__actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 6px;
  max-width: 280px;
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
    padding: 20px 16px 40px;
  }

  .project-tasks__header,
  .project-task {
    flex-direction: column;
    align-items: stretch;
  }

  .project-task__actions {
    justify-content: flex-start;
    max-width: none;
  }
}

/* 下拉与日期控件在网格表单中显式撑满：宽度由内容决定时，Element Plus 的尺寸计算会在视口变化后反复抖动。 */
.project-field__control {
  width: 100%;
}
</style>
