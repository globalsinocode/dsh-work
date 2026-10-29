<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { AlarmClock, Calendar, CaretRight, Clock, Folder, MoreFilled, Plus, User } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { workbenchApi } from '@/api/client'
import PageHeader from '@/components/PageHeader.vue'
import { useContentStore } from '@/stores/content'
import type {
  Automation,
  AgentRoutineResult,
  AutomationExecution,
  AutomationLastExecution,
  AutomationSchedule,
  AutomationStatus,
  TaskResultOutcome,
} from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

type TagType = 'success' | 'warning' | 'info' | 'danger' | 'primary'

const router = useRouter()
const contentStore = useContentStore()

const automations = ref<Automation[]>([])
const agentResults = ref<AgentRoutineResult[]>([])
const agentResultsError = ref('')
const agentResultsLoading = ref(false)
const loading = ref(false)
const loadError = ref('')

const activeTab = ref<'mine' | 'agent-results'>('mine')
const statusFilter = ref<'all' | AutomationStatus>('all')

const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 星期按钮从周一排到周日；值仍是 0=周日 … 6=周六。 */
const weekdayButtons = [1, 2, 3, 4, 5, 6, 0].map(value => ({ value, label: weekdayLabels[value]!.slice(1) }))

const statusMeta: Record<string, { label: string; type: TagType }> = {
  draft: { label: '草稿', type: 'info' },
  enabled: { label: '已启用', type: 'success' },
  paused: { label: '已暂停', type: 'warning' },
  disabled: { label: '已停用', type: 'danger' },
}

const kindLabels: Record<string, string> = {
  scheduled: '定时触发',
  manual: '手动触发',
  missed: '停机补记',
}

const admissionLabels: Record<string, string> = {
  accepted: '已受理',
  skipped: '已跳过',
  interrupted: '已中断',
}

const runStatusLabels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting: '待审批',
  cancel_requested: '取消中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  awaiting_approval: '待审批',
}

const runStatusTypes: Record<string, TagType> = {
  queued: 'info',
  running: 'primary',
  waiting: 'warning',
  awaiting_approval: 'warning',
  cancel_requested: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'info',
}

/** I-06：业务结果核验状态（task-result/v1 outcome），与受理状态、Run 状态独立展示。 */
const outcomeMeta: Record<TaskResultOutcome, { label: string; type: TagType }> = {
  pending: { label: '结果生成中', type: 'info' },
  achieved: { label: '目标已达成', type: 'success' },
  unverified: { label: '结果待核验', type: 'warning' },
  not_achieved: { label: '目标未达成', type: 'danger' },
}

const reasonLabels: Record<string, string> = {
  overlap: '上一次执行未结束，本次跳过',
  subject_invalid: '账号状态不可用',
  authorization_denied: '当前权限已不满足执行条件',
  user_pending_limit: '你的排队定时任务过多',
  global_pending_limit: '平台定时任务容量已满',
  slot_expired: '计划槽位已过期',
  task_paused: '任务已暂停',
  task_disabled: '任务已停用',
  schedule_changed: '调度规则已变更',
  dispatch_interrupted: '受理后派发中断',
  duplicate_request: '重复请求',
}

/** 常用时区给中文名；其余 IANA 标识原样显示，也可在表单中直接输入。 */
const timezoneOptions = [
  { value: 'Asia/Shanghai', label: '北京时间' },
  { value: 'Asia/Hong_Kong', label: '香港' },
  { value: 'Asia/Taipei', label: '台北' },
  { value: 'Asia/Tokyo', label: '东京' },
  { value: 'Asia/Singapore', label: '新加坡' },
  { value: 'Europe/London', label: '伦敦' },
  { value: 'Europe/Berlin', label: '柏林' },
  { value: 'America/New_York', label: '纽约' },
  { value: 'America/Los_Angeles', label: '洛杉矶' },
  { value: 'UTC', label: '协调世界时' },
]
const timezoneNames = new Map(timezoneOptions.map(option => [option.value, option.label]))
const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'

const workspaceNameById = computed(() => {
  const map = new Map<string, string>()
  for (const workspace of contentStore.workspaces) map.set(workspace.id, workspace.name)
  return map
})

const selectableWorkspaces = computed(() =>
  contentStore.workspaces.filter((workspace) => workspace.status === 'active'),
)

const statusCounts = computed(() => {
  const counts: Record<string, number> = { all: automations.value.length, enabled: 0, paused: 0, draft: 0 }
  for (const item of automations.value) counts[item.status] = (counts[item.status] ?? 0) + 1
  return counts
})

const statusFilters = computed(() => ([
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '已启用' },
  { value: 'paused', label: '已暂停' },
  { value: 'draft', label: '草稿' },
] as const).map(option => ({ ...option, count: statusCounts.value[option.value] ?? 0 })))

const visibleAutomations = computed(() =>
  statusFilter.value === 'all'
    ? automations.value
    : automations.value.filter(item => item.status === statusFilter.value),
)

function timezoneLabel(timezone: string): string {
  return timezoneNames.get(timezone) ?? timezone
}

function scheduleSummary(schedule: AutomationSchedule): string {
  if (schedule.kind === 'manual') return '仅手动触发'
  const time = schedule.timeOfDay ?? '--:--'
  const timezone = schedule.timezone ? ` · ${timezoneLabel(schedule.timezone)}` : ''
  if (schedule.kind === 'daily') return `每天 ${time}${timezone}`
  const days = (schedule.weekdays ?? [])
    .slice()
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((day) => weekdayLabels[day] ?? String(day))
    .join('、')
  return `每${days || '周'} ${time}${timezone}`
}

interface ZonedParts { year: number; month: number; day: number; weekday: number; time: string }

const weekdayCodes = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 按指定时区取墙钟时间；时区无效时退回浏览器时区。 */
function zonedParts(date: Date, timeZone?: string): ZonedParts {
  let formatter: Intl.DateTimeFormat
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }
  try { formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone }) }
  catch { formatter = new Intl.DateTimeFormat('en-US', options) }
  const parts = formatter.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    weekday: weekdayCodes.indexOf(part('weekday')),
    time: `${part('hour')}:${part('minute')}`,
  }
}

/**
 * 简短表达：今天/明天/昨天 HH:mm，其余带月日与星期。传入任务时区时按该时区
 * 的墙钟显示，与“每天 09:00 · 纽约”这类规则描述保持一致。
 */
function formatMoment(iso: string | null, timeZone?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const target = zonedParts(date, timeZone)
  const today = zonedParts(new Date(), timeZone)
  const dayDiff = Math.round(
    (Date.UTC(target.year, target.month - 1, target.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000,
  )
  if (dayDiff === 0) return `今天 ${target.time}`
  if (dayDiff === 1) return `明天 ${target.time}`
  if (dayDiff === -1) return `昨天 ${target.time}`
  const year = target.year === today.year ? '' : `${target.year}年`
  return `${year}${target.month}月${target.day}日 ${weekdayLabels[target.weekday] ?? ''} ${target.time}`
}

/** 与浏览器时区不同时注明，避免把纽约 09:00 误读成本地 09:00。 */
function timezoneNote(timezone: string): string {
  if (!timezone || timezone === defaultTimezone) return ''
  const label = timezoneNames.get(timezone)
  return `（${label ? (label.endsWith('时间') ? label : `${label}时间`) : timezone}）`
}

function relativeFuture(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(diff)) return ''
  if (diff < 60_000) return '即将运行'
  if (diff < 3_600_000) return `约 ${Math.round(diff / 60_000)} 分钟后`
  if (diff < 86_400_000) return `约 ${Math.round(diff / 3_600_000)} 小时后`
  return `${Math.round(diff / 86_400_000)} 天后`
}

function nextRun(item: Automation): { text: string; hint: string } {
  if (item.status === 'paused') return { text: '—', hint: '已暂停，启用后恢复' }
  if (item.schedule.kind === 'manual') return { text: '—', hint: '仅手动触发' }
  if (item.status === 'draft') return { text: '—', hint: '启用后开始按计划执行' }
  if (!item.nextSlotUtc) return { text: '—', hint: '暂无后续计划' }
  return { text: formatMoment(item.nextSlotUtc, item.schedule.timezone), hint: relativeFuture(item.nextSlotUtc) }
}

function executionMoment(
  execution: Pick<AutomationExecution, 'kind' | 'plannedSlotUtc' | 'missedFromUtc' | 'missedToUtc' | 'createdAt'>,
  timeZone?: string,
): string {
  if (execution.kind === 'missed' && execution.missedFromUtc && execution.missedToUtc
    && execution.missedFromUtc !== execution.missedToUtc) {
    return `${formatMoment(execution.missedFromUtc, timeZone)} – ${formatMoment(execution.missedToUtc, timeZone)}`
  }
  return formatMoment(execution.plannedSlotUtc ?? execution.createdAt, timeZone)
}

/** 最近一次的单一结论：未受理看受理结果，已受理先看 Run 再看业务结果。 */
function lastSummary(last: AutomationLastExecution, timeZone: string): { label: string; type: TagType; detail: string } {
  const moment = `${executionMoment(last, timeZone)} · ${kindLabels[last.kind] ?? last.kind}`
  const reason = last.reasonCode ? reasonLabels[last.reasonCode] ?? last.reasonCode : ''
  if (last.admissionStatus !== 'accepted') {
    return {
      label: admissionLabels[last.admissionStatus] ?? last.admissionStatus,
      type: last.admissionStatus === 'interrupted' ? 'danger' : 'warning',
      detail: reason || moment,
    }
  }
  if (last.runStatus === 'succeeded' && last.resultOutcome && last.resultOutcome !== 'pending') {
    const outcome = outcomeMeta[last.resultOutcome]
    return { label: outcome.label, type: outcome.type, detail: moment }
  }
  if (last.runStatus === 'failed') return { label: '执行失败', type: 'danger', detail: `${moment} · 不会自动重试` }
  const status = last.runStatus ?? 'queued'
  return { label: runStatusLabels[status] ?? status, type: runStatusTypes[status] ?? 'info', detail: moment }
}

function describeExecution(execution: AutomationExecution): string {
  if (execution.admissionStatus === 'accepted') {
    return runStatusLabels[execution.runStatus ?? ''] ?? execution.runStatus ?? '排队中'
  }
  return admissionLabels[execution.admissionStatus] ?? execution.admissionStatus
}

function executionType(execution: AutomationExecution): TagType {
  if (execution.admissionStatus === 'interrupted') return 'danger'
  if (execution.admissionStatus === 'skipped') return 'warning'
  return runStatusTypes[execution.runStatus ?? 'queued'] ?? 'info'
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    automations.value = await workbenchApi.getAutomations()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '定时任务加载失败'
  } finally {
    loading.value = false
  }
}

// ---- 创建 / 编辑 ----

interface AutomationForm {
  id: string | null
  name: string
  agentId: string
  workspaceId: string
  kind: 'manual' | 'daily' | 'weekly'
  timeOfDay: string
  weekdays: number[]
  timezone: string
  prompt: string
}

const dialogVisible = ref(false)
const saving = ref(false)
const form = reactive<AutomationForm>({
  id: null,
  name: '',
  agentId: '',
  workspaceId: '',
  kind: 'daily',
  timeOfDay: '09:00',
  weekdays: [1],
  timezone: defaultTimezone,
  prompt: '',
})

const formValid = computed(() =>
  Boolean(
    form.name.trim()
      && form.agentId
      && form.workspaceId
      && form.prompt.trim()
      && (form.kind === 'manual' || /^\d{2}:\d{2}$/.test(form.timeOfDay))
      && (form.kind !== 'weekly' || form.weekdays.length > 0)
      && form.timezone.trim(),
  ),
)

const timezoneChoices = computed(() =>
  timezoneOptions.some(option => option.value === form.timezone) || !form.timezone
    ? timezoneOptions
    : [{ value: form.timezone, label: form.timezone }, ...timezoneOptions],
)

const selectedAgentVersion = computed(() =>
  contentStore.agents.find(agent => agent.id === form.agentId)?.version ?? '',
)

function openCreate() {
  form.id = null
  form.name = ''
  form.agentId = ''
  form.workspaceId = contentStore.personalWorkspace?.id ?? ''
  form.kind = 'daily'
  form.timeOfDay = '09:00'
  form.weekdays = [1]
  form.timezone = defaultTimezone
  form.prompt = ''
  dialogVisible.value = true
}

function openEdit(automation: Automation) {
  form.id = automation.id
  form.name = automation.name
  form.agentId = automation.agentId ?? ''
  form.workspaceId = automation.workspaceId
  form.kind = automation.schedule.kind
  form.timeOfDay = automation.schedule.timeOfDay ?? '09:00'
  form.weekdays = automation.schedule.weekdays ?? [1]
  form.timezone = automation.schedule.timezone || 'Asia/Shanghai'
  form.prompt = automation.inputTemplate.prompt
  dialogVisible.value = true
}

function toggleWeekday(value: number) {
  form.weekdays = form.weekdays.includes(value)
    ? form.weekdays.filter(day => day !== value)
    : [...form.weekdays, value]
}

function buildSchedule(): AutomationSchedule {
  if (form.kind === 'manual') return { kind: 'manual', timezone: form.timezone.trim() }
  if (form.kind === 'daily') {
    return { kind: 'daily', timezone: form.timezone.trim(), timeOfDay: form.timeOfDay }
  }
  return {
    kind: 'weekly',
    timezone: form.timezone.trim(),
    timeOfDay: form.timeOfDay,
    weekdays: form.weekdays.slice().sort((a, b) => a - b),
  }
}

// ---- 下一次运行预览：服务端与调度共用日历，前端不另算 ----

const preview = ref<{ state: 'idle' | 'loading' | 'ready' | 'error'; slots: string[]; message: string }>({
  state: 'idle',
  slots: [],
  message: '',
})
let previewTimer: ReturnType<typeof setTimeout> | undefined
let previewSequence = 0

function schedulePreview() {
  clearTimeout(previewTimer)
  if (!dialogVisible.value || form.kind === 'manual'
    || !/^\d{2}:\d{2}$/.test(form.timeOfDay) || !form.timezone.trim()
    || (form.kind === 'weekly' && form.weekdays.length === 0)) {
    preview.value = { state: 'idle', slots: [], message: '' }
    return
  }
  preview.value = { ...preview.value, state: 'loading' }
  const sequence = ++previewSequence
  previewTimer = setTimeout(async () => {
    try {
      const result = await workbenchApi.previewAutomationSchedule(buildSchedule())
      if (sequence !== previewSequence) return
      preview.value = { state: 'ready', slots: result.nextSlotsUtc, message: '' }
    } catch (error) {
      if (sequence !== previewSequence) return
      preview.value = {
        state: 'error',
        slots: [],
        message: error instanceof Error ? error.message : '暂时无法预览运行时间',
      }
    }
  }, 250)
}

watch(
  () => [dialogVisible.value, form.kind, form.timeOfDay, form.timezone, form.weekdays.join(',')],
  schedulePreview,
)
onBeforeUnmount(() => clearTimeout(previewTimer))

const previewText = computed(() => {
  if (form.kind === 'weekly' && form.weekdays.length === 0) return '请至少选择一天'
  if (preview.value.state === 'error') return `暂时无法预览运行时间：${preview.value.message}`
  if (preview.value.state !== 'ready') return '正在计算下一次运行时间…'
  if (!preview.value.slots.length) return '按此规则近期没有可运行的时间'
  const slots = preview.value.slots.map(slot => formatMoment(slot, form.timezone)).join('、')
  return `启用后接下来将在 ${slots} 运行${timezoneNote(form.timezone)}`
})

async function save() {
  if (!formValid.value || saving.value) return
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      agentId: form.agentId,
      workspaceId: form.workspaceId,
      schedule: buildSchedule(),
      inputTemplate: { prompt: form.prompt.trim() },
    }
    if (form.id) {
      await workbenchApi.updateAutomation(form.id, payload)
      ElMessage.success('定时任务已更新')
    } else {
      await workbenchApi.createAutomation(payload)
      ElMessage.success('定时任务已创建，启用后开始按规则执行')
    }
    dialogVisible.value = false
    await load()
  } catch (error) {
    notifyActionFailure(form.id ? '更新定时任务' : '创建定时任务', form.name, error)
  } finally {
    saving.value = false
  }
}

// ---- 生命周期操作 ----

const actingId = ref<string>()

async function runAction(action: () => Promise<unknown>, label: string, item: Automation) {
  if (actingId.value) return
  actingId.value = item.id
  try {
    await action()
    ElMessage.success(`${label}成功`)
    await load()
    if (drawerAutomationId.value) await loadExecutions()
  } catch (error) {
    notifyActionFailure(label, item.name, error)
  } finally {
    actingId.value = undefined
  }
}

/** 受理结果反馈：skipped/interrupted 不是成功，按 reasonCode 提示真实结果。 */
async function admitAction(action: () => Promise<AutomationExecution>, label: string, item: Automation) {
  if (actingId.value) return
  actingId.value = item.id
  try {
    const execution = await action()
    if (execution.admissionStatus === 'accepted') {
      ElMessage.success(`${label}成功，已受理`)
    } else {
      const reason = execution.reasonCode
        ? (reasonLabels[execution.reasonCode] ?? execution.reasonCode)
        : '未满足执行条件'
      ElMessage.warning(`${label}未受理：${reason}`)
    }
    await load()
    if (drawerAutomationId.value) await loadExecutions()
  } catch (error) {
    notifyActionFailure(label, item.name, error)
  } finally {
    actingId.value = undefined
  }
}

async function enable(item: Automation) {
  try {
    await ElMessageBox.confirm(
      '启用后任务将按规则自动执行：服务停机期间错过的时间点只记录不补跑，执行失败不会自动重试。执行权限以启用时的授权范围为上限。',
      `启用定时任务“${item.name}”？`,
      {
        confirmButtonText: '启用',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  await runAction(() => workbenchApi.enableAutomation(item.id), '启用', item)
}
const pause = (item: Automation) =>
  runAction(() => workbenchApi.pauseAutomation(item.id), '暂停', item)
const runNow = (item: Automation) =>
  admitAction(() => workbenchApi.runAutomationNow(item.id, crypto.randomUUID()), '立即运行', item)
const trialRun = (item: Automation) =>
  admitAction(() => workbenchApi.trialRunAutomation(item.id, crypto.randomUUID()), '试运行', item)

async function disable(item: Automation) {
  try {
    await ElMessageBox.confirm(
      '停用后任务及其历史执行记录将不再显示，也不会再产生新的执行；已开始的执行不受影响。只想暂时不运行，请使用“暂停”。',
      `停用并移除定时任务“${item.name}”？`,
      {
        confirmButtonText: '停用并移除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }
  await runAction(() => workbenchApi.disableAutomation(item.id), '停用', item)
}

function handleMore(command: 'edit' | 'disable', item: Automation) {
  if (command === 'edit') openEdit(item)
  else void disable(item)
}

// ---- 执行记录抽屉 ----

const drawerVisible = ref(false)
const drawerAutomationId = ref('')
const drawerTitle = ref('')
const drawerTimezone = ref('')
const executions = ref<AutomationExecution[]>([])
const executionsLoading = ref(false)

async function loadExecutions() {
  executionsLoading.value = true
  try {
    executions.value = await workbenchApi.listAutomationExecutions(drawerAutomationId.value)
  } catch (error) {
    notifyActionFailure('加载执行记录', drawerTitle.value, error)
  } finally {
    executionsLoading.value = false
  }
}

function openExecutions(item: Automation) {
  drawerAutomationId.value = item.id
  drawerTitle.value = item.name
  drawerTimezone.value = item.schedule.timezone
  executions.value = []
  drawerVisible.value = true
  void loadExecutions()
}

function openConversation(execution: AutomationExecution) {
  if (execution.runId) void router.push(`/conversations/${execution.runId}`)
}

const cancellableRunStatuses = new Set(['queued', 'running', 'waiting', 'cancel_requested'])

async function cancelExecution(execution: AutomationExecution) {
  if (!execution.runId || actingId.value) return
  actingId.value = execution.id
  try {
    await workbenchApi.cancelRun(execution.runId)
    ElMessage.success('已请求取消该次执行')
    await loadExecutions()
  } catch (error) {
    notifyActionFailure('取消执行', drawerTitle.value, error)
  } finally {
    actingId.value = undefined
  }
}

// ---- AI 同事主动任务结果 ----

const expandedResults = ref(new Set<string>())

function toggleResult(executionId: string) {
  const next = new Set(expandedResults.value)
  if (next.has(executionId)) next.delete(executionId)
  else next.add(executionId)
  expandedResults.value = next
}

async function loadAgentResults() {
  agentResultsError.value = ''
  agentResultsLoading.value = true
  try { agentResults.value = await workbenchApi.getAgentRoutineResults() }
  catch (error) { agentResultsError.value = error instanceof Error ? error.message : 'AI 同事主动任务结果加载失败' }
  finally { agentResultsLoading.value = false }
}

onMounted(() => {
  void contentStore.load()
  void load()
  void loadAgentResults()
})
</script>

<template>
  <PageHeader title="我的定时任务">
    <template #actions>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建定时任务</el-button>
    </template>
  </PageHeader>

  <div class="page-container automations-page">
    <el-tabs v-model="activeTab" class="automations-tabs">
      <el-tab-pane name="mine">
        <template #label>我创建的<span class="automations-tabs__count">{{ automations.length }}</span></template>

        <el-alert
          v-if="loadError"
          class="automations-error"
          type="error"
          :title="`定时任务加载失败：${loadError}`"
          show-icon
          :closable="false"
        >
          <el-button size="small" @click="load">重试</el-button>
        </el-alert>

        <div v-if="loading && !automations.length" class="automation-list">
          <div v-for="index in 3" :key="index" class="automation-skeleton panel">
            <el-skeleton :rows="2" animated />
          </div>
        </div>

        <el-empty v-else-if="!automations.length && !loadError" description="还没有定时任务">
          <el-button type="primary" :icon="Plus" @click="openCreate">新建定时任务</el-button>
        </el-empty>

        <template v-else-if="automations.length">
          <div class="automation-filters" role="group" aria-label="按状态筛选">
            <button
              v-for="option in statusFilters"
              :key="option.value"
              type="button"
              class="automation-filter"
              :class="{ 'is-active': statusFilter === option.value }"
              :aria-pressed="statusFilter === option.value"
              @click="statusFilter = option.value"
            >{{ option.label }} {{ option.count }}</button>
          </div>

          <div class="automation-list">
            <section
              v-for="item in visibleAutomations"
              :key="item.id"
              class="automation-card panel"
              :aria-label="`定时任务：${item.name}`"
            >
              <div class="automation-card__main">
                <div class="automation-card__title">
                  <span class="automation-card__icon" aria-hidden="true"><el-icon><AlarmClock /></el-icon></span>
                  <strong>{{ item.name }}</strong>
                  <el-tag size="small" :type="statusMeta[item.status]?.type ?? 'info'" disable-transitions>
                    {{ statusMeta[item.status]?.label ?? item.status }}
                  </el-tag>
                </div>
                <div class="automation-card__meta">
                  <span><el-icon aria-hidden="true"><Calendar /></el-icon>{{ scheduleSummary(item.schedule) }}</span>
                  <span>
                    <el-icon aria-hidden="true"><User /></el-icon>{{ item.agentName ?? '已删除的 AI 同事' }}<template v-if="item.agentVersion"> · v{{ item.agentVersion }}</template>
                  </span>
                  <span><el-icon aria-hidden="true"><Folder /></el-icon>{{ workspaceNameById.get(item.workspaceId) ?? '空间' }}</span>
                </div>
                <p v-if="item.status === 'draft'" class="automation-card__hint">草稿：可先试运行确认效果，再启用。</p>
              </div>

              <dl class="automation-card__status">
                <div>
                  <dt>下次运行</dt>
                  <dd class="automation-card__value">{{ nextRun(item).text }}</dd>
                  <dd class="automation-card__sub" :title="nextRun(item).hint">{{ nextRun(item).hint }}</dd>
                </div>
                <div>
                  <dt>最近一次</dt>
                  <template v-if="item.lastExecution">
                    <dd>
                      <el-tag size="small" :type="lastSummary(item.lastExecution, item.schedule.timezone).type" disable-transitions>
                        {{ lastSummary(item.lastExecution, item.schedule.timezone).label }}
                      </el-tag>
                    </dd>
                    <dd class="automation-card__sub" :title="lastSummary(item.lastExecution, item.schedule.timezone).detail">
                      {{ lastSummary(item.lastExecution, item.schedule.timezone).detail }}
                    </dd>
                  </template>
                  <dd v-else class="automation-card__sub">尚未执行</dd>
                </div>
              </dl>

              <div class="automation-card__actions">
                <template v-if="item.status === 'enabled'">
                  <el-button
                    size="small"
                    type="primary"
                    :icon="CaretRight"
                    :disabled="actingId === item.id"
                    @click="runNow(item)"
                  >立即运行</el-button>
                  <el-button size="small" :disabled="actingId === item.id" @click="pause(item)">暂停</el-button>
                </template>
                <template v-if="item.status === 'draft' || item.status === 'paused'">
                  <el-button size="small" type="primary" :disabled="actingId === item.id" @click="enable(item)">启用</el-button>
                  <el-button size="small" :disabled="actingId === item.id" @click="trialRun(item)">试运行</el-button>
                </template>
                <el-button size="small" text type="primary" @click="openExecutions(item)">执行记录</el-button>
                <el-dropdown trigger="click" @command="(command: 'edit' | 'disable') => handleMore(command, item)">
                  <el-button
                    size="small"
                    class="automation-card__more"
                    :icon="MoreFilled"
                    :disabled="actingId === item.id"
                    :aria-label="`${item.name} 的更多操作`"
                  />
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item v-if="item.status === 'draft' || item.status === 'paused'" command="edit">编辑</el-dropdown-item>
                      <el-dropdown-item v-else disabled>暂停后可编辑</el-dropdown-item>
                      <el-dropdown-item command="disable" class="automation-card__danger">停用并移除…</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </section>

            <p v-if="!visibleAutomations.length" class="automation-list__empty">此状态下没有定时任务</p>
          </div>
        </template>
      </el-tab-pane>

      <el-tab-pane name="agent-results">
        <template #label>AI 同事主动任务结果<span class="automations-tabs__count">{{ agentResults.length }}</span></template>
        <section class="agent-results" aria-label="AI 同事主动任务结果">
          <div class="agent-results__header">
            <p>来自管理员批准的 AI 同事主动任务；你是结果接收人，不是执行身份。</p>
            <el-button text type="primary" :loading="agentResultsLoading" @click="loadAgentResults">刷新</el-button>
          </div>
          <el-alert v-if="agentResultsError" type="error" :closable="false" :title="agentResultsError" />
          <el-empty v-else-if="!agentResults.length" description="暂无可查看的主动任务结果" />
          <div v-else class="agent-results__list">
            <article v-for="result in agentResults" :key="result.executionId" class="agent-results__item panel">
              <div class="agent-results__title">
                <h3>{{ result.routineName }}</h3>
                <div class="agent-results__tags">
                  <el-tag size="small" :type="runStatusTypes[result.runStatus] ?? 'info'" disable-transitions>
                    {{ runStatusLabels[result.runStatus] ?? result.runStatus }}
                  </el-tag>
                  <el-tag
                    v-if="result.resultOutcome"
                    size="small"
                    :type="outcomeMeta[result.resultOutcome as TaskResultOutcome]?.type ?? 'info'"
                    disable-transitions
                  >{{ outcomeMeta[result.resultOutcome as TaskResultOutcome]?.label ?? result.resultOutcome }}</el-tag>
                </div>
              </div>
              <p class="agent-results__meta">
                {{ result.agentName }} · {{ workspaceNameById.get(result.workspaceId) ?? '空间' }} · {{ formatMoment(result.createdAt) }}
              </p>
              <template v-if="result.answer">
                <div
                  class="agent-results__answer"
                  :class="{ 'is-collapsed': !expandedResults.has(result.executionId) }"
                >{{ result.answer }}</div>
                <el-button text type="primary" size="small" @click="toggleResult(result.executionId)">
                  {{ expandedResults.has(result.executionId) ? '收起' : '展开全文' }}
                </el-button>
              </template>
            </article>
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>
  </div>

  <el-dialog
    v-model="dialogVisible"
    :title="form.id ? '编辑定时任务' : '新建定时任务'"
    width="600px"
    :close-on-click-modal="false"
    class="automation-dialog"
  >
    <el-form label-position="top" class="automation-form">
      <h3 class="automation-form__group">做什么</h3>
      <el-form-item label="任务名称" required>
        <el-input v-model="form.name" maxlength="60" placeholder="例如：每周一的销售周报" />
      </el-form-item>
      <el-form-item label="执行的 AI 同事" required>
        <el-select v-model="form.agentId" placeholder="选择 AI 同事" class="form-field">
          <el-option
            v-for="agent in contentStore.agents"
            :key="agent.id"
            :label="`${agent.name} · v${agent.version}`"
            :value="agent.id"
          />
        </el-select>
        <p class="automation-form__help">
          固定使用<template v-if="selectedAgentVersion">当前已发布的 v{{ selectedAgentVersion }}</template><template v-else>当前已发布版本</template>；AI 同事之后升级不影响这个任务。
        </p>
      </el-form-item>
      <el-form-item label="任务内容" required>
        <el-input
          v-model="form.prompt"
          type="textarea"
          :rows="4"
          maxlength="4000"
          placeholder="例如：汇总本周销售数据并生成周报"
        />
        <p class="automation-form__help">每次执行都使用这段内容。</p>
      </el-form-item>

      <h3 class="automation-form__group">什么时候</h3>
      <el-form-item label="执行规则" required>
        <el-radio-group v-model="form.kind">
          <el-radio-button value="manual">仅手动</el-radio-button>
          <el-radio-button value="daily">每天</el-radio-button>
          <el-radio-button value="weekly">每周</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="form.kind === 'weekly'" label="每周哪几天" required>
        <div class="weekday-picker" role="group" aria-label="每周哪几天">
          <button
            v-for="day in weekdayButtons"
            :key="day.value"
            type="button"
            class="weekday-picker__day"
            :class="{ 'is-active': form.weekdays.includes(day.value) }"
            :aria-pressed="form.weekdays.includes(day.value)"
            :aria-label="weekdayLabels[day.value]"
            @click="toggleWeekday(day.value)"
          >{{ day.label }}</button>
        </div>
      </el-form-item>
      <div v-if="form.kind !== 'manual'" class="automation-form__row">
        <el-form-item label="时间" required>
          <el-time-picker
            v-model="form.timeOfDay"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="选择时间"
            class="form-field"
          />
        </el-form-item>
        <el-form-item label="时区" required>
          <el-select v-model="form.timezone" filterable allow-create default-first-option class="form-field" placeholder="选择或输入 IANA 时区">
            <el-option
              v-for="option in timezoneChoices"
              :key="option.value"
              :label="option.label === option.value ? option.value : `${option.label}（${option.value}）`"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
      </div>
      <p v-if="form.kind !== 'manual'" class="automation-form__preview" :class="{ 'is-error': preview.state === 'error' }" role="status">
        <el-icon aria-hidden="true"><Clock /></el-icon>{{ previewText }}
      </p>
      <p v-else class="automation-form__preview is-muted">不会自动执行，需要时在列表中点“立即运行”。</p>

      <h3 class="automation-form__group">结果放在哪</h3>
      <el-form-item label="结果归属空间" required>
        <el-select v-model="form.workspaceId" placeholder="选择空间" class="form-field">
          <el-option
            v-for="workspace in selectableWorkspaces"
            :key="workspace.id"
            :label="workspace.type === 'personal' ? `${workspace.name}（个人空间）` : workspace.name"
            :value="workspace.id"
          />
        </el-select>
        <p class="automation-form__help">每次执行都会在这里生成一个独立会话。</p>
      </el-form-item>
    </el-form>
    <template #footer>
      <div class="automation-dialog__footer">
        <span>{{ form.id ? '保存后需重新启用才会按新规则运行。' : '创建后为草稿，可先试运行，确认后再启用。' }}</span>
        <div>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :disabled="!formValid || saving" :loading="saving" @click="save">
            {{ form.id ? '保存' : '创建' }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>

  <el-drawer v-model="drawerVisible" :title="`执行记录 · ${drawerTitle}`" size="520px">
    <div v-loading="executionsLoading" class="execution-timeline">
      <el-empty v-if="!executionsLoading && !executions.length" description="暂无执行记录" />
      <ol v-else>
        <li v-for="row in executions" :key="row.id" class="execution-timeline__item">
          <span class="execution-timeline__dot" :class="`is-${executionType(row)}`" aria-hidden="true" />
          <div class="execution-timeline__body">
            <div class="execution-timeline__head">
              <strong>{{ executionMoment(row, drawerTimezone) }}</strong>
              <span>{{ kindLabels[row.kind] ?? row.kind }}</span>
            </div>
            <div class="execution-timeline__tags">
              <el-tag size="small" :type="executionType(row)" disable-transitions>{{ describeExecution(row) }}</el-tag>
              <el-tag
                v-if="row.resultOutcome"
                size="small"
                :type="outcomeMeta[row.resultOutcome as TaskResultOutcome]?.type ?? 'info'"
                disable-transitions
              >{{ outcomeMeta[row.resultOutcome as TaskResultOutcome]?.label ?? row.resultOutcome }}</el-tag>
            </div>
            <p v-if="row.reasonCode" class="execution-timeline__reason">{{ reasonLabels[row.reasonCode] ?? row.reasonCode }}</p>
            <div v-if="row.runId" class="execution-timeline__actions">
              <el-button size="small" text type="primary" @click="openConversation(row)">查看会话</el-button>
              <el-button
                v-if="row.admissionStatus === 'accepted' && cancellableRunStatuses.has(row.runStatus ?? '')"
                size="small"
                text
                type="danger"
                :disabled="actingId === row.id"
                @click="cancelExecution(row)"
              >取消</el-button>
            </div>
          </div>
        </li>
      </ol>
    </div>
  </el-drawer>
</template>

<style scoped>
.automations-page { max-width: 1200px; padding-top: 12px; }

.automations-tabs__count {
  margin-left: 6px;
  color: var(--dsh-color-subtle);
  font-variant-numeric: tabular-nums;
}

.automations-tabs :deep(.el-tabs__item.is-active) .automations-tabs__count { color: var(--dsh-color-brand); }

.automations-error { margin-bottom: 14px; }

.automation-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.automation-filter {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dsh-color-border);
  border-radius: 15px;
  background: var(--dsh-color-panel);
  color: var(--dsh-color-text);
  font: inherit;
  font-size: var(--dsh-font-size-caption);
  cursor: pointer;
}

.automation-filter.is-active {
  border-color: var(--dsh-color-brand);
  background: var(--dsh-color-brand-soft);
  color: var(--dsh-color-brand-dark);
  font-weight: 600;
}

.automation-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.automation-list__empty {
  margin: 0;
  padding: 32px;
  border: 1px dashed var(--dsh-color-border-strong);
  border-radius: var(--dsh-radius-md);
  color: var(--dsh-color-muted);
  text-align: center;
}

.automation-card {
  display: grid;
  /* 操作列定宽，各卡片的“下次运行 / 最近一次”上下对齐。 */
  grid-template-columns: minmax(0, 1.3fr) minmax(240px, 1fr) 256px;
  align-items: center;
  gap: 16px 24px;
  padding: 16px 20px;
}

.automation-card__main { display: flex; min-width: 0; flex-direction: column; gap: 8px; }

.automation-card__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-title);
}

.automation-card__icon {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-brand-soft);
  color: var(--dsh-color-brand);
  font-size: var(--dsh-font-size-subheading);
}

.automation-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.automation-card__meta span { display: inline-flex; align-items: center; gap: 5px; }

.automation-card__hint { margin: 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }

.automation-card__status {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-canvas);
}

.automation-card__status > div { min-width: 0; }
.automation-card__status dt { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
.automation-card__status dd { margin: 4px 0 0; }
.automation-card__value { color: var(--dsh-color-ink); font-size: var(--dsh-font-size-caption); font-weight: 600; }

.automation-card__sub {
  overflow: hidden;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.automation-card__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.automation-card__actions .el-button + .el-button { margin-left: 0; }
.automation-card__more { width: 28px; padding: 0; }
:global(.automation-card__danger:not(.is-disabled)) { color: var(--dsh-color-danger); }

.automation-skeleton { padding: 18px 20px; }

.agent-results__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.agent-results__header p { margin: 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
.agent-results__list { display: grid; gap: 12px; }
.agent-results__item { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 16px 20px; }
.agent-results__title { display: flex; width: 100%; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.agent-results__title h3 { margin: 0; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-title); }
.agent-results__tags { display: flex; gap: 6px; }
.agent-results__meta { margin: 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }

.agent-results__answer {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 14px;
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-canvas);
  color: var(--dsh-color-text);
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.agent-results__answer.is-collapsed {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.form-field { width: 100%; }

.automation-form__group {
  margin: 4px 0 12px;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-caption);
  font-weight: 700;
}

.automation-form__group:not(:first-child) { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--dsh-color-border); }

.automation-form__help { margin: 4px 0 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); line-height: 1.5; }

.automation-form__row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }

.automation-form__preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  padding: 10px 12px;
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-brand-soft);
  color: var(--dsh-color-brand-dark);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.5;
}

.automation-form__preview.is-error { background: var(--dsh-color-warning-soft); color: var(--dsh-color-warning); }
.automation-form__preview.is-muted { background: var(--dsh-color-canvas); color: var(--dsh-color-muted); }

.weekday-picker { display: flex; flex-wrap: wrap; gap: 6px; }

.weekday-picker__day {
  width: 44px;
  height: 34px;
  border: 1px solid var(--dsh-color-border-strong);
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-panel);
  color: var(--dsh-color-text);
  font: inherit;
  cursor: pointer;
}

.weekday-picker__day.is-active {
  border-color: var(--dsh-color-brand);
  background: var(--dsh-color-brand-soft);
  color: var(--dsh-color-brand-dark);
  font-weight: 600;
}

.automation-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.automation-dialog__footer > span { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); text-align: left; }

.execution-timeline { min-height: 120px; }
.execution-timeline ol { margin: 0; padding: 0; list-style: none; }

.execution-timeline__item {
  position: relative;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 14px;
  padding-bottom: 20px;
}

.execution-timeline__item:not(:last-child)::before {
  position: absolute;
  top: 16px;
  bottom: 0;
  left: 5px;
  width: 1px;
  background: var(--dsh-color-border);
  content: '';
}

.execution-timeline__dot {
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--dsh-color-subtle);
}

.execution-timeline__dot.is-success { background: var(--dsh-color-success); }
.execution-timeline__dot.is-warning { background: var(--dsh-color-warning); }
.execution-timeline__dot.is-danger { background: var(--dsh-color-danger); }
.execution-timeline__dot.is-primary { background: var(--dsh-color-brand); }

.execution-timeline__body { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.execution-timeline__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.execution-timeline__head strong { color: var(--dsh-color-ink); font-size: var(--dsh-font-size-body); }
.execution-timeline__head span { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
.execution-timeline__tags { display: flex; flex-wrap: wrap; gap: 6px; }
.execution-timeline__reason { margin: 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
.execution-timeline__actions { display: flex; gap: 4px; margin-left: -8px; }

@media (max-width: 1080px) {
  .automation-card { grid-template-columns: minmax(0, 1fr) minmax(220px, 1fr); }
  .automation-card__actions { grid-column: 1 / -1; justify-content: flex-start; }
}

@media (max-width: 720px) {
  .automation-card { grid-template-columns: minmax(0, 1fr); }
  .automation-form__row { grid-template-columns: minmax(0, 1fr); }
}
</style>
