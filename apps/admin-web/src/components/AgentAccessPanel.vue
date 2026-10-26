<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { adminApi } from '@/api/client'
import type { AgentAccess, AgentRoutineSchedule } from '@/types/domain'

/**
 * S2 岗位权限：Agent 作为 AI 员工，与人类员工一样由管理员授权。
 * 可见角色（谁可以向它请求工作）、岗位角色（以什么身份执行）、数据范围（能接触哪些数据）
 * 都属于 Agent 而非版本，保存后立即生效，不需要重新验证。
 */
const props = defineProps<{
  agentId: string
  canManage: boolean
  /**
   * 嵌入草稿编辑流程的一步：不显示自己的保存按钮，由流程在“下一步”时调用 save 保存，
   * 避免同一页面出现两个前进/保存入口。
   */
  embedded?: boolean
}>()
const emit = defineEmits<{ updated: [access: AgentAccess] }>()

const access = ref<AgentAccess>()
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const form = reactive({
  visibleRoleIds: [] as string[],
  roleIds: [] as string[],
  dataScopes: [] as string[],
  principalStatus: 'active' as 'active' | 'disabled',
})

const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function sorted(values: string[]) {
  return [...values].sort()
}
function sameSet(left: string[], right: string[]) {
  return sorted(left).join('\n') === sorted(right).join('\n')
}

const activeRoles = computed(() => access.value?.roleOptions.filter(role => role.status === 'active') ?? [])
function roleName(id: string) {
  return access.value?.roleOptions.find(role => role.id === id)?.name ?? id
}
/** 岗位角色选项：含管理权限的角色排在最后，其余按原顺序。 */
const jobRoleOptions = computed(() => {
  const options = access.value?.roleOptions ?? []
  const rank = (role: { privileged?: boolean }) => (role.privileged ? 1 : 0)
  return [...options].sort((left, right) => rank(left) - rank(right))
})
const privilegedSelected = computed(() => (access.value?.roleOptions ?? [])
  .filter(role => role.privileged && form.roleIds.includes(role.id)).map(role => role.name))

function roleSelectable(id: string, selected: string[]) {
  return activeRoles.value.some(role => role.id === id) || selected.includes(id)
}

const dirty = computed(() => Boolean(access.value && (
  !sameSet(form.visibleRoleIds, access.value.visibleRoleIds)
  || !sameSet(form.roleIds, access.value.roleIds)
  || !sameSet(form.dataScopes, access.value.dataScopes)
  || form.principalStatus !== access.value.principalStatus
)))

/**
 * 草稿流程（embedded）：可见角色与岗位角色必填，数据范围选填，全部由管理员手动选择，不预填、不自动授予。
 */
const attempted = ref(false)
const requiredErrors = computed(() => ({
  visibleRoleIds: form.visibleRoleIds.length ? '' : '请选择可以使用它的员工角色',
  roleIds: form.roleIds.length ? '' : '请选择它持有的岗位角色',
}))
const complete = computed(() => !requiredErrors.value.visibleRoleIds && !requiredErrors.value.roleIds)

/** 前进到下一步前调用：缺必填项时显示字段错误并返回 false。 */
function validateRequired() {
  attempted.value = true
  return complete.value
}

const scopeOptions = computed(() => [...new Set([...(access.value?.scopeOptions ?? []), ...form.dataScopes])].sort())

function scheduleText(schedule: Partial<AgentRoutineSchedule>) {
  if (schedule.kind === 'daily') return `每天 ${schedule.timeOfDay ?? ''}`.trim()
  if (schedule.kind === 'weekly') {
    const days = (schedule.weekdays ?? []).map(day => weekdayLabels[day] ?? String(day)).join('、')
    return `每${days || '周'} ${schedule.timeOfDay ?? ''}`.trim()
  }
  if (schedule.kind === 'event') return `收到事件 ${schedule.eventType ?? ''} 时`.trim()
  return '手动触发时'
}

/** 权限总览：用一句话回答“谁可以请求、它能做什么、能接触哪些数据、会主动做什么”。 */
const overview = computed(() => {
  const current = access.value
  if (!current) return []
  const lines: string[] = []
  lines.push(current.visibleRoleIds.length
    ? `${current.visibleRoleIds.map(roleName).join('、')}可以向它请求工作`
    : '尚未设置可见角色，员工暂时无法使用')
  lines.push(current.roleIds.length ? `持有岗位角色 ${current.roleIds.map(roleName).join('、')}` : '未持有岗位角色')
  lines.push(current.dataScopes.length ? `可访问数据范围 ${current.dataScopes.join('、')}` : '未授予平台数据范围')
  for (const routine of current.routines) {
    lines.push(`${scheduleText(routine.schedule)}，向${routine.recipientName}交付「${routine.name}」${routine.status === 'active' ? '' : '（已暂停）'}`)
  }
  if (current.principalStatus !== 'active') lines.push('执行身份已停用，不能执行任何任务')
  return lines
})

function resetForm(value: AgentAccess) {
  form.visibleRoleIds = sorted(value.visibleRoleIds)
  form.roleIds = sorted(value.roleIds)
  form.dataScopes = sorted(value.dataScopes)
  form.principalStatus = value.principalStatus
}

async function load() {
  const agentId = props.agentId
  if (!agentId) return
  loading.value = true
  loadError.value = ''
  try {
    const value = await adminApi.getAgentAccess(agentId)
    if (props.agentId !== agentId) return
    access.value = value
    resetForm(value)
  } catch (cause) {
    if (props.agentId !== agentId) return
    access.value = undefined
    loadError.value = cause instanceof Error ? cause.message : '无法读取岗位权限'
  } finally {
    if (props.agentId === agentId) loading.value = false
  }
}

/**
 * 保存岗位权限，返回是否已与服务端一致（没有修改也视为成功）。
 * confirm=false 用于草稿流程从未发布的 Agent：员工尚不可见，不再额外确认。
 */
async function save({ confirm = true }: { confirm?: boolean } = {}): Promise<boolean> {
  const current = access.value
  if (!current) return !loadError.value
  if (!dirty.value) return true
  if (saving.value) return false
  const narrowing = current.roleIds.some(role => !form.roleIds.includes(role))
    || current.dataScopes.some(scope => !form.dataScopes.includes(scope))
    || current.visibleRoleIds.some(role => !form.visibleRoleIds.includes(role))
    || (current.principalStatus === 'active' && form.principalStatus === 'disabled')
  if (confirm) {
    try {
      await ElMessageBox.confirm(
        narrowing
          ? '保存后立即生效：被撤销的角色、数据范围或可见范围会阻止排队中和后续的执行。'
          : '保存后立即生效，不需要重新验证。',
        '确认更新岗位权限？',
        { confirmButtonText: '确认更新', cancelButtonText: '取消', type: narrowing ? 'warning' : 'info' },
      )
    } catch {
      return false
    }
  }
  saving.value = true
  try {
    const updated = await adminApi.updateAgentAccess(current.agentId, {
      expectedRevision: current.revision,
      visibleRoleIds: form.visibleRoleIds,
      roleIds: form.roleIds,
      dataScopes: form.dataScopes,
      principalStatus: form.principalStatus,
    })
    access.value = updated
    resetForm(updated)
    emit('updated', updated)
    ElMessage.success('岗位权限已更新')
    return true
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '岗位权限保存失败')
    // 修订冲突等失败后重新读取，避免基于过期数据继续编辑。
    await load()
    return false
  } finally {
    saving.value = false
  }
}

function discard() {
  if (access.value) resetForm(access.value)
}

watch(() => props.agentId, () => { void load() }, { immediate: true })
defineExpose({ reload: load, access, dirty, save, complete, validateRequired })
</script>

<template>
  <section class="agent-access" v-loading="loading" aria-label="岗位权限">
    <el-alert v-if="loadError" type="error" :closable="false" :title="loadError">
      <el-button link type="primary" @click="load">重新读取</el-button>
    </el-alert>

    <!-- 草稿流程「角色与权限」：可见角色、岗位角色必填，数据范围选填；不预填，不自动授予，执行身份不在这里管理。 -->
    <template v-if="access && embedded">
      <el-form label-position="top" class="agent-access__form">
        <el-form-item label="谁可以使用它" required :error="attempted ? requiredErrors.visibleRoleIds : ''">
          <el-select v-model="form.visibleRoleIds" multiple filterable aria-label="可见角色" placeholder="选择可以使用该 Agent 的员工角色" :disabled="!canManage">
            <el-option v-for="role in access.roleOptions" :key="role.id" :label="role.status === 'active' ? role.name : `${role.name}（已停用）`" :value="role.id" :disabled="!roleSelectable(role.id, form.visibleRoleIds)" />
          </el-select>
        </el-form-item>
        <el-form-item label="岗位角色" required :error="attempted ? requiredErrors.roleIds : ''">
          <el-select v-model="form.roleIds" multiple filterable aria-label="岗位角色" placeholder="选择它持有的岗位角色，决定它以什么身份执行" :disabled="!canManage">
            <el-option v-for="role in jobRoleOptions" :key="role.id" :label="role.status === 'active' ? role.name : `${role.name}（已停用）`" :value="role.id" :disabled="!roleSelectable(role.id, form.roleIds)">
              <span class="agent-access__option">
                <span>{{ role.status === 'active' ? role.name : `${role.name}（已停用）` }}</span>
                <el-tag v-if="role.privileged" size="small" type="warning" effect="plain" data-testid="role-privileged-tag">含管理权限</el-tag>
              </span>
            </el-option>
          </el-select>
          <p v-if="privilegedSelected.length" class="agent-access__risk" data-testid="role-privileged-warning">{{ privilegedSelected.join('、') }} 含管理权限。Agent 通常只需要业务角色，非必要请改选不含管理权限的角色。</p>
        </el-form-item>
        <el-form-item label="数据范围（选填）">
          <el-select v-model="form.dataScopes" multiple filterable allow-create default-first-option aria-label="数据范围" placeholder="不需要企业数据时可留空" :disabled="!canManage">
            <el-option v-for="scope in scopeOptions" :key="scope" :label="scope" :value="scope" />
          </el-select>
        </el-form-item>
      </el-form>

    </template>

    <template v-else-if="access">
      <div class="agent-access__overview" data-testid="agent-access-overview">
        <strong>权限总览</strong>
        <ul><li v-for="line in overview" :key="line">{{ line }}</li></ul>
      </div>

      <el-form label-position="top" class="agent-access__form">
        <el-form-item label="谁可以向它请求工作（可见角色）">
          <el-select v-model="form.visibleRoleIds" multiple filterable aria-label="可见角色" placeholder="选择可以使用该 Agent 的员工角色" :disabled="!canManage">
            <el-option v-for="role in access.roleOptions" :key="role.id" :label="role.status === 'active' ? role.name : `${role.name}（已停用）`" :value="role.id" :disabled="!roleSelectable(role.id, form.visibleRoleIds)" />
          </el-select>
          <p class="field-help">只决定员工能否选择它，不授予它任何执行权限。</p>
        </el-form-item>
        <el-form-item label="它持有的岗位角色">
          <el-select v-model="form.roleIds" multiple filterable aria-label="岗位角色" placeholder="选择它持有的岗位角色" :disabled="!canManage">
            <el-option v-for="role in jobRoleOptions" :key="role.id" :label="role.status === 'active' ? role.name : `${role.name}（已停用）`" :value="role.id" :disabled="!roleSelectable(role.id, form.roleIds)">
              <span class="agent-access__option">
                <span>{{ role.status === 'active' ? role.name : `${role.name}（已停用）` }}</span>
                <el-tag v-if="role.privileged" size="small" type="warning" effect="plain" data-testid="role-privileged-tag">含管理权限</el-tag>
              </span>
            </el-option>
          </el-select>
          <p v-if="privilegedSelected.length" class="agent-access__risk" data-testid="role-privileged-warning">{{ privilegedSelected.join('、') }} 含管理权限。Agent 通常只需要业务角色，非必要请改选不含管理权限的角色。</p>
        </el-form-item>
        <el-form-item label="它能接触的数据范围">
          <el-select v-model="form.dataScopes" multiple filterable allow-create default-first-option aria-label="数据范围" placeholder="不需要企业数据时可留空" :disabled="!canManage">
            <el-option v-for="scope in scopeOptions" :key="scope" :label="scope" :value="scope" />
          </el-select>
          <p class="field-help">员工请求时，交给该员工的结果不超过员工本人可见的数据范围。</p>
        </el-form-item>
        <el-form-item label="执行身份">
          <el-switch v-model="form.principalStatus" active-value="active" inactive-value="disabled" active-text="启用" inactive-text="停用" :disabled="!canManage" />
          <p class="field-help">紧急止损用：停用后它不能执行任何任务，排队中的执行也会被拒绝。日常上下线请用页头的“停用 Agent”。</p>
        </el-form-item>
      </el-form>

      <div v-if="canManage" class="agent-access__actions">
        <el-button :disabled="!dirty || saving" @click="discard">放弃修改</el-button>
        <el-button type="primary" :loading="saving" :disabled="!dirty" data-action="save-agent-access" @click="save()">保存岗位权限</el-button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.agent-access { display: flex; flex-direction: column; gap: 18px; min-height: 80px; }
.agent-access__overview { padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.agent-access__overview strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.agent-access__overview ul { margin: 8px 0 0; padding-left: 18px; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.75; }
.agent-access__form :deep(.el-select) { width: 100%; }
.field-help { margin: 6px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.5; }
.agent-access__actions { display: flex; justify-content: flex-end; gap: 10px; }
.agent-access__option { display: inline-flex; align-items: center; gap: 6px; }
.agent-access__risk { margin: 6px 0 0; color: var(--color-warning-strong, var(--color-warning)); font-size: var(--font-size-badge); line-height: 1.5; }
</style>
