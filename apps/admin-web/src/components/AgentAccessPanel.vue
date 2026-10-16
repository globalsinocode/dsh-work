<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { adminApi } from '@/api/client'
import type { AgentAccess, AgentRoutineSchedule } from '@/types/domain'

/**
 * S2 岗位权限：Agent 作为 AI 员工，与人类员工一样由管理员授权。
 * 可见角色（谁可以向它请求工作）、岗位角色（能用哪些能力）、数据范围（能接触哪些数据）
 * 都属于 Agent 而非版本，保存后立即生效，不需要重新验证。
 */
const props = defineProps<{
  agentId: string
  canManage: boolean
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
function roleSelectable(id: string, selected: string[]) {
  return activeRoles.value.some(role => role.id === id) || selected.includes(id)
}

const dirty = computed(() => Boolean(access.value && (
  !sameSet(form.visibleRoleIds, access.value.visibleRoleIds)
  || !sameSet(form.roleIds, access.value.roleIds)
  || !sameSet(form.dataScopes, access.value.dataScopes)
  || form.principalStatus !== access.value.principalStatus
)))

/** 按表单中的授权实时判断每项能力是否可用，不必保存后才发现缺口。 */
const capabilityRows = computed(() => (access.value?.capabilities ?? []).map(item => {
  const missingRole = item.requiredRoleIds.length > 0
    && !item.requiredRoleIds.some(role => form.roleIds.includes(role))
  const missingScopes = item.requiredScopes.filter(scope => !form.dataScopes.includes(scope))
  return { ...item, missingRole, missingScopes, usable: !missingRole && !missingScopes.length }
}))
const blockedCapabilities = computed(() => capabilityRows.value.filter(item => !item.usable))
const declaredBlocked = computed(() => blockedCapabilities.value.filter(item => item.source === 'declared'))

function requirementText(item: { requiredRoleIds: string[]; requiredScopes: string[] }) {
  const parts: string[] = []
  if (item.requiredRoleIds.length) parts.push(`角色：${item.requiredRoleIds.map(roleName).join(' 或 ')}`)
  if (item.requiredScopes.length) parts.push(`数据范围：${item.requiredScopes.join('、')}`)
  return parts.join('；') || '无需额外授权'
}
function gapText(item: { missingRole: boolean; requiredRoleIds: string[]; missingScopes: string[] }) {
  const parts: string[] = []
  if (item.missingRole) parts.push(`角色 ${item.requiredRoleIds.map(roleName).join(' 或 ')}`)
  if (item.missingScopes.length) parts.push(`数据范围 ${item.missingScopes.join('、')}`)
  return `缺少${parts.join('、')}，暂不可用`
}

/** 一键补齐：每项缺角色的能力补一个当前有效的所需角色，并补齐缺少的数据范围。 */
function fillGaps() {
  const roles = new Set(form.roleIds)
  const scopes = new Set(form.dataScopes)
  for (const item of blockedCapabilities.value) {
    if (item.missingRole) {
      const candidate = item.requiredRoleIds.find(role => activeRoles.value.some(option => option.id === role))
      if (candidate) roles.add(candidate)
    }
    for (const scope of item.missingScopes) scopes.add(scope)
  }
  form.roleIds = sorted([...roles])
  form.dataScopes = sorted([...scopes])
}
const gapsFillable = computed(() => blockedCapabilities.value.some(item => item.missingScopes.length
  || (item.missingRole && item.requiredRoleIds.some(role => activeRoles.value.some(option => option.id === role)))))

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

async function save() {
  const current = access.value
  if (!current || !dirty.value || saving.value) return
  const narrowing = current.roleIds.some(role => !form.roleIds.includes(role))
    || current.dataScopes.some(scope => !form.dataScopes.includes(scope))
    || current.visibleRoleIds.some(role => !form.visibleRoleIds.includes(role))
    || (current.principalStatus === 'active' && form.principalStatus === 'disabled')
  try {
    await ElMessageBox.confirm(
      narrowing
        ? '保存后立即生效：被撤销的角色、数据范围或可见范围会阻止排队中和后续的执行。'
        : '保存后立即生效，不需要重新验证。',
      '确认更新岗位权限？',
      { confirmButtonText: '确认更新', cancelButtonText: '取消', type: narrowing ? 'warning' : 'info' },
    )
  } catch {
    return
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
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '岗位权限保存失败')
    // 修订冲突等失败后重新读取，避免基于过期数据继续编辑。
    await load()
  } finally {
    saving.value = false
  }
}

function discard() {
  if (access.value) resetForm(access.value)
}

watch(() => props.agentId, () => { void load() }, { immediate: true })
defineExpose({ reload: load, access })
</script>

<template>
  <section class="agent-access" v-loading="loading" aria-label="岗位权限">
    <el-alert v-if="loadError" type="error" :closable="false" :title="loadError">
      <el-button link type="primary" @click="load">重新读取</el-button>
    </el-alert>
    <template v-if="access">
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
          <el-select v-model="form.roleIds" multiple filterable aria-label="岗位角色" placeholder="按能力需要授予" :disabled="!canManage">
            <el-option v-for="role in access.roleOptions" :key="role.id" :label="role.status === 'active' ? role.name : `${role.name}（已停用）`" :value="role.id" :disabled="!roleSelectable(role.id, form.roleIds)" />
          </el-select>
        </el-form-item>
        <el-form-item label="它能接触的数据范围">
          <el-select v-model="form.dataScopes" multiple filterable allow-create default-first-option aria-label="数据范围" placeholder="不需要企业数据时可留空" :disabled="!canManage">
            <el-option v-for="scope in scopeOptions" :key="scope" :label="scope" :value="scope" />
          </el-select>
          <p class="field-help">员工请求时，交给该员工的结果不超过员工本人可见的数据范围。</p>
        </el-form-item>
        <el-form-item label="执行身份">
          <el-switch v-model="form.principalStatus" active-value="active" inactive-value="disabled" active-text="启用" inactive-text="停用" :disabled="!canManage" />
        </el-form-item>
      </el-form>

      <div class="agent-access__capabilities">
        <div class="agent-access__heading">
          <strong>能力所需授权</strong>
          <el-button v-if="canManage && gapsFillable" size="small" data-action="fill-access-gaps" @click="fillGaps">一键补齐</el-button>
        </div>
        <p v-if="!capabilityRows.length" class="field-help">当前能力都无需额外角色或数据范围。</p>
        <ul v-else>
          <li v-for="item in capabilityRows" :key="item.reference" :class="{ 'is-blocked': !item.usable }">
            <div>
              <span class="agent-access__name">{{ item.name }}</span>
              <el-tag size="small" effect="plain" :type="item.source === 'declared' ? 'primary' : 'info'">{{ item.source === 'declared' ? '已声明' : '平台默认' }}</el-tag>
            </div>
            <small>{{ requirementText(item) }}</small>
            <small v-if="!item.usable" class="agent-access__gap">{{ gapText(item) }}</small>
          </li>
        </ul>
        <p v-if="declaredBlocked.length" class="agent-access__warning">已声明的能力缺少授权时，验证和员工任务都会被拒绝。</p>
      </div>

      <div v-if="canManage" class="agent-access__actions">
        <el-button :disabled="!dirty || saving" @click="discard">放弃修改</el-button>
        <el-button type="primary" :loading="saving" :disabled="!dirty" data-action="save-agent-access" @click="save">保存岗位权限</el-button>
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
.agent-access__heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.agent-access__heading strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.agent-access__capabilities ul { display: flex; flex-direction: column; gap: 8px; margin: 10px 0 0; padding: 0; list-style: none; }
.agent-access__capabilities li { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-base); }
.agent-access__capabilities li > div { display: flex; align-items: center; gap: 8px; }
.agent-access__capabilities li.is-blocked { border-color: var(--color-warning); }
.agent-access__name { color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-badge); }
.agent-access__capabilities small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.agent-access__capabilities small.agent-access__gap { color: var(--color-warning); }
.agent-access__warning { margin: 10px 0 0; color: var(--color-warning); font-size: var(--font-size-badge); }
.agent-access__actions { display: flex; justify-content: flex-end; gap: 10px; }
</style>
