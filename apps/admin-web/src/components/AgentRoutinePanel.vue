<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi } from '@/api/client'
import type { AgentPrincipalGovernance, AgentRoutine, AgentRoutineExecution, AgentRoutineSchedule,
  AgentVersionRecord, IdentityUserSummary, ManagedWorkspaceDefinition } from '@/types/domain'

const props = defineProps<{
  agentId: string
  versions: AgentVersionRecord[]
  principal?: AgentPrincipalGovernance
  canManage: boolean
}>()

const loading = ref(false)
const saving = ref(false)
const routines = ref<AgentRoutine[]>([])
const workspaces = ref<ManagedWorkspaceDefinition[]>([])
const recipients = ref<IdentityUserSummary[]>([])
const editorOpen = ref(false)
const approvalOpen = ref(false)
const executionsOpen = ref(false)
const selected = ref<AgentRoutine>()
const executions = ref<AgentRoutineExecution[]>([])
const approvedRoleIds = ref<string[]>([])
const approvedDataScopes = ref<string[]>([])
const name = ref('')
const versionId = ref('')
const workspaceId = ref('')
const recipientUserId = ref('')
const prompt = ref('')
const scheduleKind = ref<AgentRoutineSchedule['kind']>('manual')
const timezone = ref('Asia/Shanghai')
const timeOfDay = ref('09:00')
const weekdays = ref<number[]>([1, 2, 3, 4, 5])
const eventType = ref('')
const timeoutSeconds = ref<number | undefined>()
const maxToolCalls = ref<number | undefined>()
const maxOutputBytes = ref<number | undefined>()
const publishedVersions = computed(() => props.versions.filter(version => version.status === 'published'))
const versionLabel = (id: string) => {
  const version = props.versions.find(item => item.id === id)
  return version ? `v${version.version}` : id
}
const schedule = computed<AgentRoutineSchedule>(() => scheduleKind.value === 'event'
  ? { kind: 'event', timezone: timezone.value, eventType: eventType.value.trim() }
  : scheduleKind.value === 'manual'
    ? { kind: 'manual', timezone: timezone.value }
    : { kind: scheduleKind.value, timezone: timezone.value, timeOfDay: timeOfDay.value,
      ...(scheduleKind.value === 'weekly' ? { weekdays: weekdays.value } : {}) })

function labelForSchedule(value: AgentRoutineSchedule): string {
  if (value.kind === 'manual') return '手动触发'
  if (value.kind === 'event') return `事件 · ${value.eventType}`
  return `${value.kind === 'daily' ? '每天' : '每周'} ${value.timeOfDay} · ${value.timezone}`
}
function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}
function statusLabel(value: AgentRoutine['status']): string {
  return { draft: '草稿', enabled: '已启用', paused: '已暂停', disabled: '已停用' }[value]
}
function reasonLabel(reason: string | null): string {
  return ({ slot_expired: '错过执行窗口', overlap: '已有执行未结束', authorization_denied: '当前授权不足',
    agent_pending_limit: 'Agent 并发已满', global_pending_limit: '全局容量已满',
    routine_inactive: '规则已停用', dispatch_interrupted: '派发中断' } as Record<string, string>)[reason ?? ''] ?? reason ?? '—'
}

async function load() {
  const agentId = props.agentId
  loading.value = true
  try {
    const [records, spaces, users] = await Promise.allSettled([
      adminApi.getAgentRoutines(agentId), adminApi.getWorkspaces(),
      adminApi.getIdentityUsers({ status: 'active', pageSize: 100 }),
    ])
    if (props.agentId !== agentId) return
    if (records.status === 'rejected') throw records.reason
    routines.value = records.value
    workspaces.value = spaces.status === 'fulfilled' ? spaces.value : []
    recipients.value = users.status === 'fulfilled' ? users.value.items : []
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '主动任务加载失败')
  } finally {
    if (props.agentId === agentId) loading.value = false
  }
}

watch(() => props.agentId, () => { void load() }, { immediate: true })

function openEditor(routine?: AgentRoutine) {
  selected.value = routine
  name.value = routine?.name ?? ''
  versionId.value = routine?.agentVersionId ?? publishedVersions.value.at(-1)?.id ?? ''
  workspaceId.value = routine?.workspaceId ?? ''
  recipientUserId.value = routine?.recipientUserId ?? ''
  prompt.value = routine?.inputTemplate.prompt ?? ''
  scheduleKind.value = routine?.schedule.kind ?? 'manual'
  timezone.value = routine?.schedule.timezone ?? 'Asia/Shanghai'
  timeOfDay.value = routine?.schedule.kind === 'daily' || routine?.schedule.kind === 'weekly'
    ? routine.schedule.timeOfDay : '09:00'
  weekdays.value = routine?.schedule.kind === 'weekly' ? routine.schedule.weekdays ?? [] : [1, 2, 3, 4, 5]
  eventType.value = routine?.schedule.kind === 'event' ? routine.schedule.eventType : ''
  timeoutSeconds.value = routine?.inputTemplate.budget.timeoutSeconds
  maxToolCalls.value = routine?.inputTemplate.budget.maxToolCalls
  maxOutputBytes.value = routine?.inputTemplate.budget.maxOutputBytes
  editorOpen.value = true
}

async function save() {
  if (!name.value.trim() || !versionId.value || !workspaceId.value || !recipientUserId.value || !prompt.value.trim()) {
    ElMessage.warning('请填写名称、版本、空间、接收人和输入模板')
    return
  }
  saving.value = true
  try {
    const input = { name: name.value.trim(), agentVersionId: versionId.value,
      workspaceId: workspaceId.value, recipientUserId: recipientUserId.value,
      schedule: schedule.value, inputTemplate: { prompt: prompt.value,
        budget: { ...(timeoutSeconds.value ? { timeoutSeconds: timeoutSeconds.value } : {}),
          ...(maxToolCalls.value ? { maxToolCalls: maxToolCalls.value } : {}),
          ...(maxOutputBytes.value ? { maxOutputBytes: maxOutputBytes.value } : {}) } } }
    if (selected.value) await adminApi.updateAgentRoutine(props.agentId, selected.value.id, {
      ...input, expectedRevision: selected.value.revision,
    })
    else await adminApi.createAgentRoutine(props.agentId, input)
    editorOpen.value = false
    ElMessage.success('主动任务草稿已保存；启用前仍需确认授权上限')
    await load()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally { saving.value = false }
}

function openApproval(routine: AgentRoutine) {
  selected.value = routine
  approvedRoleIds.value = routine.approvedRoleIds.length ? [...routine.approvedRoleIds] : [...(props.principal?.roleIds ?? [])]
  approvedDataScopes.value = routine.approvedDataScopes.length ? [...routine.approvedDataScopes] : [...(props.principal?.dataScopes ?? [])]
  approvalOpen.value = true
}
async function enable() {
  if (!selected.value || !approvedRoleIds.value.length) {
    ElMessage.warning('请选择至少一个执行角色')
    return
  }
  saving.value = true
  try {
    await adminApi.enableAgentRoutine(props.agentId, selected.value.id, {
      expectedRevision: selected.value.revision,
      roleIds: approvedRoleIds.value, dataScopes: approvedDataScopes.value,
    })
    approvalOpen.value = false
    ElMessage.success('授权上限已确认，主动任务已启用')
    await load()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '启用失败') }
  finally { saving.value = false }
}
async function changeStatus(routine: AgentRoutine, status: 'paused' | 'disabled') {
  try {
    await ElMessageBox.confirm(status === 'paused' ? '暂停后不再受理新触发，活动执行将在下次授权复核时停止。'
      : '停用后不能重新启用；仍保留执行与审计记录。', '确认修改主动任务状态？',
    { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' })
    await adminApi.setAgentRoutineStatus(props.agentId, routine.id, status)
    await load()
  } catch (error) { if (error instanceof Error && error.message !== 'cancel') ElMessage.error(error.message) }
}
async function runNow(routine: AgentRoutine) {
  try {
    const execution = await adminApi.runAgentRoutineNow(props.agentId, routine.id, crypto.randomUUID())
    ElMessage[execution.admissionStatus === 'accepted' ? 'success' : 'warning'](
      execution.admissionStatus === 'accepted' ? '已创建 Agent Run' : `未受理：${reasonLabel(execution.reasonCode)}`)
    await showExecutions(routine)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '触发失败') }
}
async function showExecutions(routine: AgentRoutine) {
  selected.value = routine
  executionsOpen.value = true
  try { executions.value = await adminApi.getAgentRoutineExecutions(props.agentId, routine.id) }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '执行记录加载失败') }
}
</script>

<template>
  <section v-loading="loading" class="routine-panel">
    <div class="routine-panel__header"><div><h3>Agent 主动任务</h3><p>规则由 AI 员工拥有，接收人只决定结果披露；每次执行仍使用固定 Agent Version 和 DSH Run/Attempt。</p></div>
      <el-button v-if="canManage" type="primary" :disabled="!publishedVersions.length" @click="openEditor()">创建规则</el-button></div>
    <el-table class="data-table" :data="routines" empty-text="尚无主动任务；创建 Agent 不会自动开启巡检">
      <el-table-column prop="name" label="名称" min-width="150" />
      <el-table-column label="固定版本" width="100"><template #default="scope">{{ versionLabel(scope.row.agentVersionId) }}</template></el-table-column>
      <el-table-column label="触发" min-width="180"><template #default="scope">{{ labelForSchedule(scope.row.schedule) }}</template></el-table-column>
      <el-table-column label="状态" width="95"><template #default="scope">{{ statusLabel(scope.row.status) }}</template></el-table-column>
      <el-table-column label="最近受理" min-width="130"><template #default="scope"><span v-if="scope.row.lastReasonCode" class="routine-warning">{{ reasonLabel(scope.row.lastReasonCode) }}</span><span v-else>{{ scope.row.lastAdmissionStatus === 'accepted' ? '已受理' : '—' }}</span></template></el-table-column>
      <el-table-column label="下次执行" min-width="160"><template #default="scope">{{ formatTime(scope.row.nextSlotUtc) }}</template></el-table-column>
      <el-table-column label="操作" min-width="265"><template #default="scope">
        <el-button link @click="showExecutions(scope.row)">执行记录</el-button>
        <template v-if="canManage">
          <el-button v-if="scope.row.status === 'draft' || scope.row.status === 'paused'" link @click="openEditor(scope.row)">编辑</el-button>
          <el-button v-if="scope.row.status === 'draft' || scope.row.status === 'paused'" link type="primary" @click="openApproval(scope.row)">确认并启用</el-button>
          <el-button v-if="scope.row.status === 'enabled'" link @click="runNow(scope.row)">立即运行</el-button>
          <el-button v-if="scope.row.status === 'enabled'" link @click="changeStatus(scope.row, 'paused')">暂停</el-button>
          <el-button v-if="scope.row.status !== 'disabled'" link type="danger" @click="changeStatus(scope.row, 'disabled')">停用</el-button>
        </template>
      </template></el-table-column>
    </el-table>

    <el-dialog v-model="editorOpen" :title="selected ? '编辑主动任务' : '创建主动任务'" width="680px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="规则名称"><el-input v-model="name" maxlength="120" show-word-limit /></el-form-item>
        <el-form-item label="固定 Agent Version"><el-select v-model="versionId" style="width:100%"><el-option v-for="version in publishedVersions" :key="version.id" :value="version.id" :label="`v${version.version}`" /></el-select></el-form-item>
        <el-form-item label="工作空间"><el-select v-model="workspaceId" filterable allow-create default-first-option placeholder="选择团队空间，或输入已授权个人空间 ID" style="width:100%"><el-option v-for="space in workspaces" :key="space.id" :value="space.id" :label="space.name" /></el-select></el-form-item>
        <el-form-item label="结果接收人"><el-select v-model="recipientUserId" filterable allow-create default-first-option placeholder="选择员工，或输入员工 ID" style="width:100%"><el-option v-for="user in recipients" :key="user.id" :value="user.id" :label="`${user.name} · ${user.id}`" /></el-select></el-form-item>
        <el-form-item label="触发方式"><el-select v-model="scheduleKind" style="width:100%"><el-option label="手动" value="manual" /><el-option label="每天" value="daily" /><el-option label="每周" value="weekly" /><el-option label="事件" value="event" /></el-select></el-form-item>
        <el-form-item label="时区"><el-input v-model="timezone" placeholder="例如 Asia/Shanghai" /></el-form-item>
        <el-form-item v-if="scheduleKind === 'daily' || scheduleKind === 'weekly'" label="当地时间"><el-time-select v-model="timeOfDay" start="00:00" step="00:15" end="23:45" /></el-form-item>
        <el-form-item v-if="scheduleKind === 'weekly'" label="星期"><el-select v-model="weekdays" multiple style="width:100%"><el-option v-for="day in [{ id: 1, name: '周一' }, { id: 2, name: '周二' }, { id: 3, name: '周三' }, { id: 4, name: '周四' }, { id: 5, name: '周五' }, { id: 6, name: '周六' }, { id: 0, name: '周日' }]" :key="day.id" :value="day.id" :label="day.name" /></el-select></el-form-item>
        <el-form-item v-if="scheduleKind === 'event'" label="受控事件类型"><el-input v-model="eventType" placeholder="例如 inventory.changed" /></el-form-item>
        <el-form-item label="固定输入模板"><el-input v-model="prompt" type="textarea" :rows="5" maxlength="20000" show-word-limit /></el-form-item>
        <div class="routine-budget"><el-form-item label="最长运行（秒）"><el-input-number v-model="timeoutSeconds" :min="1" /></el-form-item><el-form-item label="最多工具调用"><el-input-number v-model="maxToolCalls" :min="1" /></el-form-item><el-form-item label="最大输出（字节）"><el-input-number v-model="maxOutputBytes" :min="1" /></el-form-item></div>
      </el-form>
      <template #footer><el-button @click="editorOpen = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存草稿</el-button></template>
    </el-dialog>

    <el-dialog v-model="approvalOpen" title="确认 Agent 主动任务授权上限" width="540px" append-to-body>
      <p>执行只使用下列批准范围与 Agent 当前授权的交集；Agent 停用、收权或空间撤权会阻断后续执行。</p>
      <el-form label-position="top"><el-form-item label="批准角色"><el-select v-model="approvedRoleIds" multiple style="width:100%"><el-option v-for="role in principal?.roleIds ?? []" :key="role" :value="role" :label="role" /></el-select></el-form-item>
        <el-form-item label="批准数据范围"><el-select v-model="approvedDataScopes" multiple style="width:100%"><el-option v-for="scope in principal?.dataScopes ?? []" :key="scope" :value="scope" :label="scope" /></el-select></el-form-item></el-form>
      <template #footer><el-button @click="approvalOpen = false">取消</el-button><el-button type="primary" :loading="saving" @click="enable">确认并启用</el-button></template>
    </el-dialog>

    <el-dialog v-model="executionsOpen" :title="`${selected?.name ?? ''} · 执行记录`" width="850px" append-to-body>
      <el-table :data="executions" empty-text="暂无执行记录"><el-table-column label="触发时间" width="170"><template #default="scope">{{ formatTime(scope.row.plannedSlotUtc ?? scope.row.createdAt) }}</template></el-table-column>
        <el-table-column prop="kind" label="类型" width="95" /><el-table-column label="受理" width="95"><template #default="scope">{{ scope.row.admissionStatus }}</template></el-table-column>
        <el-table-column label="原因/结果" min-width="160"><template #default="scope">{{ scope.row.reasonCode ? reasonLabel(scope.row.reasonCode) : scope.row.resultOutcome ?? scope.row.runStatus ?? '—' }}</template></el-table-column>
        <el-table-column prop="runId" label="Run ID" min-width="200" /></el-table>
      <template #footer><el-button @click="executionsOpen = false">关闭</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.routine-panel { margin-top: 18px; }
.routine-panel__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
.routine-panel__header h3 { margin: 0; color: var(--color-text-heading); }
.routine-panel__header p { margin: 8px 0 0; color: var(--color-text-muted); line-height: 1.5; }
.routine-budget { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.routine-warning { color: var(--color-warning); }
@media (max-width: 640px) { .routine-panel__header, .routine-budget { display: block; } }
</style>
