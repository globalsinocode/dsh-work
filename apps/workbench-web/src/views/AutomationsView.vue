<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlarmClock, Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type {
  Automation,
  AutomationExecution,
  AutomationSchedule,
  TaskResultOutcome,
} from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

const router = useRouter()
const contentStore = useContentStore()

const automations = ref<Automation[]>([])
const loading = ref(false)
const loadError = ref('')

const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const statusMeta: Record<string, { label: string; type: 'success' | 'warning' | 'info' | 'danger' }> = {
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

/** I-06：业务结果核验状态（task-result/v1 outcome），与受理状态、Run 状态独立展示。 */
const outcomeMeta: Record<TaskResultOutcome, { label: string; type: 'success' | 'warning' | 'info' | 'danger' }> = {
  pending: { label: '结果生成中', type: 'info' },
  achieved: { label: '目标已达成', type: 'success' },
  unverified: { label: '结果待核验', type: 'warning' },
  not_achieved: { label: '目标未达成', type: 'danger' },
}

const reasonLabels: Record<string, string> = {
  overlap: '上一次执行未结束，本次跳过',
  subject_invalid: '账号状态不可用',
  authorization_denied: '当前权限已不满足执行条件',
  user_pending_limit: '你的排队自动任务过多',
  global_pending_limit: '平台自动任务容量已满',
  slot_expired: '计划槽位已过期',
  task_paused: '任务已暂停',
  task_disabled: '任务已停用',
  schedule_changed: '调度规则已变更',
  dispatch_interrupted: '受理后派发中断',
  duplicate_request: '重复请求',
}

const workspaceNameById = computed(() => {
  const map = new Map<string, string>()
  for (const workspace of contentStore.workspaces) map.set(workspace.id, workspace.name)
  return map
})

const selectableWorkspaces = computed(() =>
  contentStore.workspaces.filter((workspace) => workspace.status === 'active'),
)

function scheduleSummary(schedule: AutomationSchedule): string {
  const timezone = schedule.timezone ? `（${schedule.timezone}）` : ''
  if (schedule.kind === 'manual') return '仅手动触发'
  if (schedule.kind === 'daily') return `每天 ${schedule.timeOfDay ?? '--:--'}${timezone}`
  const days = (schedule.weekdays ?? [])
    .slice()
    .sort((a, b) => a - b)
    .map((day) => weekdayLabels[day] ?? String(day))
    .join('、')
  return `每${days || '周'} ${schedule.timeOfDay ?? '--:--'}${timezone}`
}

function formatInstant(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

function describeExecution(execution: AutomationExecution): string {
  if (execution.admissionStatus === 'accepted') {
    return runStatusLabels[execution.runStatus ?? ''] ?? execution.runStatus ?? '排队中'
  }
  return admissionLabels[execution.admissionStatus] ?? execution.admissionStatus
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    automations.value = await workbenchApi.getAutomations()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '自动任务加载失败'
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
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
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

function openCreate() {
  form.id = null
  form.name = ''
  form.agentId = ''
  form.workspaceId = contentStore.personalWorkspace?.id ?? ''
  form.kind = 'daily'
  form.timeOfDay = '09:00'
  form.weekdays = [1]
  form.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
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

function buildSchedule(): AutomationSchedule {
  if (form.kind === 'manual') return { kind: 'manual', timezone: form.timezone.trim() }
  if (form.kind === 'daily') {
    return { kind: 'daily', timezone: form.timezone.trim(), timeOfDay: form.timeOfDay }
  }
  return {
    kind: 'weekly',
    timezone: form.timezone.trim(),
    timeOfDay: form.timeOfDay,
    weekdays: form.weekdays,
  }
}

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
      ElMessage.success('自动任务已更新')
    } else {
      await workbenchApi.createAutomation(payload)
      ElMessage.success('自动任务已创建，启用后开始按规则执行')
    }
    dialogVisible.value = false
    await load()
  } catch (error) {
    notifyActionFailure(form.id ? '更新自动任务' : '创建自动任务', form.name, error)
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
      '启用后任务将按规则自动执行：服务停机期间错过的槽位只记录不补跑，执行失败不会自动重试。执行权限以启用时的授权范围为上限。',
      `启用自动任务“${item.name}”？`,
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
      '停用后任务不再出现在列表中（历史执行记录也随之不再展示），且不再产生新的执行。已开始的执行不受影响。',
      `停用自动任务“${item.name}”？`,
      {
        confirmButtonText: '停用',
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

// ---- 执行记录抽屉 ----

const drawerVisible = ref(false)
const drawerAutomationId = ref('')
const drawerTitle = ref('')
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

onMounted(() => {
  void contentStore.load()
  void load()
})
</script>

<template>
  <div class="page-container automations-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">我的自动任务</h1>
        <p class="page-description">
          让 Agent 按固定版本与固定输入定期自动执行，结果以独立会话落到所选工作空间。
          任务钉住创建时的已发布版本，不会跟随 Agent 后续升级。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建自动任务</el-button>
    </header>

    <el-alert
      v-if="loadError"
      class="automations-error"
      type="error"
      :title="`自动任务加载失败：${loadError}`"
      show-icon
      :closable="false"
    >
      <el-button size="small" @click="load">重试</el-button>
    </el-alert>

    <div v-if="loading" class="automation-list">
      <div v-for="index in 3" :key="index" class="automation-skeleton panel">
        <el-skeleton :rows="2" animated />
      </div>
    </div>

    <el-empty v-else-if="!automations.length && !loadError" description="还没有自动任务">
      <el-button type="primary" :icon="Plus" @click="openCreate">新建自动任务</el-button>
    </el-empty>

    <div v-else class="automation-list">
      <section
        v-for="item in automations"
        :key="item.id"
        class="automation-card panel"
        :aria-label="`自动任务：${item.name}`"
      >
        <div class="automation-card__main">
          <div class="automation-card__title">
            <el-icon class="automation-card__icon"><AlarmClock /></el-icon>
            <strong>{{ item.name }}</strong>
            <el-tag size="small" :type="statusMeta[item.status]?.type ?? 'info'">
              {{ statusMeta[item.status]?.label ?? item.status }}
            </el-tag>
          </div>
          <p class="automation-card__meta">
            {{ item.agentName ?? '已删除的 Agent' }}<template v-if="item.agentVersion"> · v{{ item.agentVersion }}</template>
            · 结果落到 {{ workspaceNameById.get(item.workspaceId) ?? '工作空间' }}
          </p>
          <p class="automation-card__meta">
            {{ scheduleSummary(item.schedule) }}
            <template v-if="item.nextSlotUtc"> · 下次运行 {{ formatInstant(item.nextSlotUtc) }}</template>
          </p>
        </div>
        <div class="automation-card__actions">
          <el-button
            v-if="item.status === 'draft' || item.status === 'paused'"
            size="small"
            type="primary"
            :disabled="actingId === item.id"
            @click="enable(item)"
          >启用</el-button>
          <el-button
            v-if="item.status === 'enabled'"
            size="small"
            :disabled="actingId === item.id"
            @click="pause(item)"
          >暂停</el-button>
          <el-button
            v-if="item.status === 'enabled'"
            size="small"
            type="success"
            plain
            :disabled="actingId === item.id"
            @click="runNow(item)"
          >立即运行</el-button>
          <el-button
            v-if="item.status === 'draft' || item.status === 'paused'"
            size="small"
            :disabled="actingId === item.id"
            @click="openEdit(item)"
          >编辑</el-button>
          <el-button
            v-if="item.status === 'draft' || item.status === 'paused'"
            size="small"
            :disabled="actingId === item.id"
            @click="trialRun(item)"
          >试运行</el-button>
          <el-button size="small" text @click="openExecutions(item)">执行记录</el-button>
          <el-button
            size="small"
            text
            type="danger"
            :disabled="actingId === item.id"
            @click="disable(item)"
          >停用</el-button>
        </div>
      </section>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="form.id ? '编辑自动任务' : '新建自动任务'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <el-form-item label="任务名称" required>
          <el-input v-model="form.name" maxlength="60" placeholder="例如：每周一的销售周报" />
        </el-form-item>
        <el-form-item label="执行 Agent（固定为当前已发布版本）" required>
          <el-select v-model="form.agentId" placeholder="选择 Agent" class="form-field">
            <el-option
              v-for="agent in contentStore.agents"
              :key="agent.id"
              :label="`${agent.name} · v${agent.version}`"
              :value="agent.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="结果归属工作空间" required>
          <el-select v-model="form.workspaceId" placeholder="选择工作空间" class="form-field">
            <el-option
              v-for="workspace in selectableWorkspaces"
              :key="workspace.id"
              :label="workspace.type === 'personal' ? `${workspace.name}（个人空间）` : workspace.name"
              :value="workspace.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="执行规则" required>
          <el-radio-group v-model="form.kind">
            <el-radio-button value="manual">仅手动</el-radio-button>
            <el-radio-button value="daily">每天</el-radio-button>
            <el-radio-button value="weekly">每周</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.kind === 'weekly'" label="星期" required>
          <el-select v-model="form.weekdays" multiple class="form-field" placeholder="选择星期">
            <el-option
              v-for="(label, index) in weekdayLabels"
              :key="index"
              :label="label"
              :value="index"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.kind !== 'manual'" label="时间" required>
          <el-time-picker
            v-model="form.timeOfDay"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="选择时间"
            class="form-field"
          />
        </el-form-item>
        <el-form-item label="时区（IANA）" required>
          <el-input v-model="form.timezone" placeholder="例如 Asia/Shanghai" />
        </el-form-item>
        <el-form-item label="任务内容（每次执行固定使用）" required>
          <el-input
            v-model="form.prompt"
            type="textarea"
            :rows="4"
            maxlength="4000"
            placeholder="例如：汇总本周销售数据并生成周报"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!formValid || saving" :loading="saving" @click="save">
          {{ form.id ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="drawerVisible" :title="`执行记录 · ${drawerTitle}`" size="560px">
      <el-table v-loading="executionsLoading" :data="executions" empty-text="暂无执行记录">
        <el-table-column label="触发" width="100">
          <template #default="{ row }">{{ kindLabels[row.kind] ?? row.kind }}</template>
        </el-table-column>
        <el-table-column label="计划/创建时间" min-width="150">
          <template #default="{ row }">
            {{ formatInstant(row.plannedSlotUtc ?? row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="受理/执行" min-width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.admissionStatus === 'accepted' ? 'success' : 'info'">
              {{ describeExecution(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="业务结果" min-width="110">
          <template #default="{ row }">
            <el-tag v-if="row.resultOutcome" size="small" :type="outcomeMeta[row.resultOutcome as TaskResultOutcome]?.type ?? 'info'">
              {{ outcomeMeta[row.resultOutcome as TaskResultOutcome]?.label ?? row.resultOutcome }}
            </el-tag>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="说明" min-width="150">
          <template #default="{ row }">
            {{ row.reasonCode ? (reasonLabels[row.reasonCode] ?? row.reasonCode) : '—' }}
          </template>
        </el-table-column>
        <el-table-column width="150">
          <template #default="{ row }">
            <el-button v-if="row.runId" size="small" text type="primary" @click="openConversation(row)">
              查看会话
            </el-button>
            <el-button
              v-if="row.runId && row.admissionStatus === 'accepted' && cancellableRunStatuses.has(row.runStatus ?? '')"
              size="small"
              text
              type="danger"
              :disabled="actingId === row.id"
              @click="cancelExecution(row)"
            >
              取消
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>
  </div>
</template>

<style scoped>
.automations-error { margin-bottom: 14px; }

.automation-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.automation-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 20px;
}

.automation-card__main { min-width: 0; flex: 1; }

.automation-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--dsh-color-ink);
}

.automation-card__icon { color: #315dc4; font-size: var(--dsh-font-size-section); }

.automation-card__meta {
  margin: 5px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.automation-card__actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}

.automation-card__actions .el-button + .el-button { margin-left: 0; }

.automation-skeleton { padding: 18px 20px; }

.form-field { width: 100%; }
</style>
