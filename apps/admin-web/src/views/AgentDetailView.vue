<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import AgentAccessPanel from '@/components/AgentAccessPanel.vue'
import AgentRoutinePanel from '@/components/AgentRoutinePanel.vue'
import AgentCapabilitySection from '@/components/agent-detail/AgentCapabilitySection.vue'
import AgentExperiencePanel from '@/components/agent-detail/AgentExperiencePanel.vue'
import AgentProfileSection from '@/components/agent-detail/AgentProfileSection.vue'
import AgentReleasePanel from '@/components/agent-detail/AgentReleasePanel.vue'
import AgentRunsPanel from '@/components/agent-detail/AgentRunsPanel.vue'
import AgentWorkspaceGovernance from '@/components/agent-detail/AgentWorkspaceGovernance.vue'
import { provideAgentDraftEditor } from '@/composables/use-agent-draft'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'

const sections = [
  { id: 'profile', label: '职责与人格' },
  { id: 'capabilities', label: '能力' },
  { id: 'access', label: '岗位权限' },
  { id: 'routines', label: '主动任务' },
  { id: 'experience', label: '经验' },
  { id: 'release', label: '验证与发布' },
  { id: 'runs', label: '运行记录' },
] as const
type SectionId = typeof sections[number]['id']

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const ready = ref(false)
const statusSaving = ref(false)

const agentId = computed(() => String(route.params.agentId ?? ''))
const agent = computed(() => contentStore.agents.find(item => item.id === agentId.value))
const versions = computed(() => contentStore.agentVersions.filter(version => version.agentId === agentId.value))
const pendingVersion = computed(() => versions.value.find(version => version.status === 'draft' || version.status === 'candidate'))
const activeSection = computed<SectionId>(() => {
  const value = String(route.query.section ?? '')
  return sections.some(section => section.id === value) ? value as SectionId : 'profile'
})
const canManage = computed(() => authStore.canManage)
const editor = provideAgentDraftEditor(agent, { canEdit: canManage })

const saveStatus = computed(() => {
  switch (editor.state.value) {
    case 'pending': return { type: 'info', text: '有未保存的修改' }
    case 'saving': return { type: 'info', text: '保存中…' }
    case 'invalid': return { type: 'warning', text: '内容不完整，未保存' }
    case 'conflict': return { type: 'danger', text: '已被其他操作修改' }
    case 'error': return { type: 'danger', text: '保存失败' }
    default: return { type: 'success', text: editor.savedAt.value ? '已保存' : '草稿与服务端一致' }
  }
})

function availability(status: string) {
  if (status === 'published') return { status: 'published', label: '已启用' }
  if (status === 'disabled') return { status: 'disabled', label: '已停用' }
  return { status: 'draft', label: '未发布' }
}

/** 当前版本指针；从未发布时为空，只有草稿的 Agent 不能启停。 */
const activeVersion = computed(() => agent.value?.activeVersion
  ?? (agent.value && agent.value.status !== 'draft' ? agent.value.version : null))
const hasActiveVersion = computed(() => Boolean(activeVersion.value))
const displayStatus = computed(() => {
  if (agent.value?.status === 'disabled') return availability('disabled')
  return hasActiveVersion.value ? availability('published') : availability('draft')
})
const activeVersionLabel = computed(() => activeVersion.value ? `v${activeVersion.value}` : '未发布')

async function openSection(id: SectionId) {
  if (id === activeSection.value) return
  await router.replace({ query: { ...route.query, section: id } })
}

async function reloadDraft() {
  await contentStore.load(true)
  editor.reload()
}

async function changeAvailability() {
  const current = agent.value
  if (!current) return
  const disabling = current.status !== 'disabled'
  const label = disabling ? '停用' : '启用'
  try {
    await ElMessageBox.confirm(
      disabling
        ? '停用后拒绝新的 Run，已开始的 Attempt 允许排空；不影响已加入空间的历史记录。'
        : '启用后将恢复当前版本的员工可见范围。',
      `${label}“${current.name}”？`,
      { confirmButtonText: `确认${label}`, cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  statusSaving.value = true
  try {
    await contentStore.setAgentStatus(current.id, disabling ? 'disabled' : 'published')
    ElMessage.success(`Agent 已${label}，操作已写入审计`)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : `${label}失败`)
  } finally {
    statusSaving.value = false
  }
}

function warnBeforeUnload(event: BeforeUnloadEvent) {
  if (editor.hasUnsavedChanges.value) event.preventDefault()
}

/** 离开详情页或切换 Agent 前先保存；内容不合法时确认是否放弃。 */
async function guardLeave() {
  await editor.flush()
  if (editor.state.value !== 'invalid' && editor.state.value !== 'error') return true
  try {
    await ElMessageBox.confirm(
      editor.state.value === 'invalid' ? '有内容不符合要求，离开后这些修改不会保存。' : '最近的修改保存失败，离开后不会保存。',
      '放弃未保存的修改？',
      { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' },
    )
    return true
  } catch {
    return false
  }
}

onBeforeRouteLeave(guardLeave)
onBeforeRouteUpdate(async (to, from) => (to.params.agentId === from.params.agentId ? true : guardLeave()))

watch(activeSection, async (_next, previous) => {
  // 切到验证与发布前先把草稿保存下来，让检查与案例基于最新内容。
  if (previous === 'profile' || previous === 'capabilities') await editor.flush()
})

onMounted(async () => {
  window.addEventListener('beforeunload', warnBeforeUnload)
  await contentStore.load()
  ready.value = true
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', warnBeforeUnload))
</script>

<template>
  <div class="ops-page agent-detail-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section v-if="!ready || (contentStore.loading && !agent)" class="content-panel detail-placeholder">
      <el-skeleton :rows="6" animated />
    </section>

    <section v-else-if="!agent" class="content-panel detail-placeholder">
      <el-result icon="warning" title="未找到 Agent" sub-title="该 Agent 可能已被移除。">
        <template #extra><el-button type="primary" @click="router.push('/agents')">返回 Agent 管理</el-button></template>
      </el-result>
    </section>

    <template v-else>
      <header class="content-panel detail-hero">
        <span class="detail-hero__mark" aria-hidden="true">d</span>
        <div class="detail-hero__title">
          <h2>{{ agent.name }}</h2>
          <p>
            <StatusTag v-bind="displayStatus" />
            <span>当前版本 <span class="mono">{{ activeVersionLabel }}</span></span>
            <span v-if="pendingVersion">· 待发布 <span class="mono">v{{ pendingVersion.version }}</span>（{{ pendingVersion.status === 'candidate' ? '验证中' : '草稿' }}）</span>
            <span>· 负责人 {{ agent.owner }}</span>
          </p>
        </div>
        <div class="detail-hero__actions">
          <span v-if="canManage" class="save-status" :class="`save-status--${saveStatus.type}`" data-testid="draft-save-status" role="status" aria-live="polite">{{ saveStatus.text }}</span>
          <el-button v-if="editor.state.value === 'conflict'" size="small" @click="reloadDraft">重新载入</el-button>
          <el-button v-if="canManage && hasActiveVersion" :type="agent.status === 'disabled' ? 'primary' : 'danger'" plain :loading="statusSaving" :data-action="agent.status === 'disabled' ? 'enable-agent' : 'disable-agent'" @click="changeAvailability">{{ agent.status === 'disabled' ? '启用 Agent' : '停用 Agent' }}</el-button>
          <el-button @click="router.push('/agents')">返回列表</el-button>
        </div>
      </header>
      <el-alert v-if="canManage && editor.message.value && (editor.state.value === 'conflict' || editor.state.value === 'error' || editor.state.value === 'invalid')" class="save-alert" :type="editor.state.value === 'invalid' ? 'warning' : 'error'" :closable="false" show-icon :title="editor.message.value" />
      <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，只能查看，不能修改。" />

      <nav class="status-tabs detail-tabs" role="tablist" aria-label="Agent 详情分区">
        <button
          v-for="section in sections"
          :key="section.id"
          class="status-tab"
          :class="{ active: activeSection === section.id }"
          type="button"
          role="tab"
          :aria-selected="activeSection === section.id"
          @click="openSection(section.id)"
        >{{ section.label }}</button>
      </nav>

      <div class="detail-body" role="tabpanel" :aria-label="sections.find(section => section.id === activeSection)?.label">
        <div v-show="activeSection === 'profile'" class="content-panel detail-card"><AgentProfileSection /></div>
        <div v-show="activeSection === 'capabilities'" class="content-panel detail-card"><AgentCapabilitySection /></div>
        <template v-if="activeSection === 'access'">
          <div class="content-panel detail-card">
            <section class="detail-section">
              <header class="detail-section__head"><div><h3>岗位权限</h3><p>谁可以向它请求工作、它持有哪些岗位角色、能接触哪些数据。属于 Agent 而非版本，修改立即生效并写审计，不需要重新验证。</p></div></header>
              <AgentAccessPanel :agent-id="agent.id" :can-manage="canManage" @updated="contentStore.load(true)" />
            </section>
          </div>
          <AgentWorkspaceGovernance :agent="agent" :can-manage="canManage" />
        </template>
        <div v-else-if="activeSection === 'routines'" class="content-panel detail-card">
          <section class="detail-section" aria-label="主动任务">
            <header class="detail-section__head"><div><h3>主动任务</h3><p>按时间或事件主动工作，结果交给接收人。规则启用时固定当时的发布版本；启用中的任务提示词会自动列入验证案例。</p></div></header>
            <AgentRoutinePanel :agent-id="agent.id" :versions="versions" :can-manage="canManage" />
          </section>
        </div>
        <div v-else-if="activeSection === 'experience'" class="content-panel detail-card"><AgentExperiencePanel :agent-id="agent.id" :can-manage="canManage" /></div>
        <AgentReleasePanel v-else-if="activeSection === 'release'" :agent-id="agent.id" @open-access="openSection('access')" @edit="openSection('profile')" />
        <div v-else-if="activeSection === 'runs'" class="content-panel detail-card"><AgentRunsPanel :agent-id="agent.id" /></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.agent-detail-page { width: 100%; gap: 10px; }
.detail-placeholder { min-height: 320px; padding: 24px; }
.detail-hero { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 16px 18px; }
.detail-hero__mark { display: grid; width: 44px; height: 44px; place-items: center; border-radius: var(--radius-card); color: var(--color-bg-base); background: var(--color-primary); font-size: var(--font-size-heading); font-weight: var(--font-weight-heading); font-style: italic; }
.detail-hero__title { min-width: 0; }
.detail-hero__title h2 { margin: 0; overflow: hidden; color: var(--color-text-heading); font-size: var(--font-size-title); text-overflow: ellipsis; white-space: nowrap; }
.detail-hero__title p { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.detail-hero__actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.save-status { font-size: var(--font-size-badge); }
.save-status--success { color: var(--color-success); }
.save-status--info { color: var(--color-text-muted); }
.save-status--warning { color: var(--color-warning, var(--color-text-secondary)); }
.save-status--danger { color: var(--color-danger); }
.detail-tabs { flex-wrap: wrap; }
.detail-card { padding: 18px; }
.mono { font-family: monospace; }
@media (max-width: 760px) {
  .detail-hero { grid-template-columns: 1fr; }
  .detail-hero__mark { display: none; }
  .detail-hero__actions { justify-content: flex-start; }
}
</style>

<style>
/* 详情页各分区共用的标题样式（子组件不带作用域前缀）。 */
.agent-detail-page .detail-section__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.agent-detail-page .detail-section__head h3 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-heading); }
.agent-detail-page .detail-section__head p { max-width: 760px; margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.6; }
</style>
