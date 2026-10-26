<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import AgentAccessPanel from '@/components/AgentAccessPanel.vue'
import AgentRoutinePanel from '@/components/AgentRoutinePanel.vue'
import AgentExperiencePanel from '@/components/agent-detail/AgentExperiencePanel.vue'
import AgentOverviewSection from '@/components/agent-detail/AgentOverviewSection.vue'
import AgentRunsPanel from '@/components/agent-detail/AgentRunsPanel.vue'
import AgentVersionsPanel from '@/components/agent-detail/AgentVersionsPanel.vue'
import AgentWorkspaceGovernance from '@/components/agent-detail/AgentWorkspaceGovernance.vue'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { activeVersionOf, availabilityOf, draftEntryStep, pendingVersionOf } from '@/utils/agent-status'

/**
 * Agent 详情：只读查看与运维。版本内容（职责与人格、能力）只在草稿编辑流程中修改，
 * 这里只保留属于 Agent、立即生效的设置（岗位权限、主动任务）以及经验、版本与运行查看。
 */
const sections = [
  { id: 'overview', label: '概览' },
  { id: 'access', label: '岗位权限' },
  { id: 'routines', label: '主动任务' },
  { id: 'experience', label: '经验' },
  { id: 'versions', label: '版本历史' },
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
const pendingVersion = computed(() => pendingVersionOf(agent.value, contentStore.agentVersions))
const activeSection = computed<SectionId>(() => {
  const value = String(route.query.section ?? '')
  return sections.some(section => section.id === value) ? value as SectionId : 'overview'
})
// 分区首次访问后保持挂载（v-show 切换）：岗位权限的未保存输入不会因切分区丢失。
const visitedSections = ref(new Set<SectionId>([activeSection.value]))
watch(activeSection, id => visitedSections.value.add(id), { immediate: true })
const loadFailed = computed(() => Boolean(contentStore.error) && !agent.value)
const canManage = computed(() => authStore.canManage)

const activeVersion = computed(() => activeVersionOf(agent.value))
const hasActiveVersion = computed(() => Boolean(activeVersion.value))
const displayStatus = computed(() => availabilityOf(agent.value))
const activeVersionLabel = computed(() => activeVersion.value ? `v${activeVersion.value}` : '未发布')
/** 管理员的主操作：编辑配置或继续未完成的草稿；审计员只能查看待发布版本。 */
const draftAction = computed(() => {
  const pending = pendingVersion.value
  if (canManage.value) return pending ? `继续编辑 v${pending.version}` : '编辑配置'
  return pending ? `查看待发布 v${pending.version}` : ''
})

async function openSection(id: SectionId) {
  if (id === activeSection.value) return
  await router.replace({ query: { ...route.query, section: id } })
}

function openDraft() {
  void router.push({
    name: 'agent-draft',
    params: { agentId: agentId.value },
    query: { step: draftEntryStep(pendingVersion.value) },
  })
}

/** WAI-ARIA tabs 键盘导航：方向键循环、Home/End 到首尾，并移动焦点。 */
function onTabKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? sections.length - 1
      : ['ArrowLeft', 'ArrowUp'].includes(event.key)
        ? (index - 1 + sections.length) % sections.length
        : (index + 1) % sections.length
  const target = sections[next]!
  void openSection(target.id)
  void nextTick(() => document.getElementById(`agent-detail-tab-${target.id}`)?.focus())
}

async function reloadDetail() {
  contentStore.error = ''
  await contentStore.load(true)
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

onMounted(async () => {
  await contentStore.load()
  ready.value = true
})
</script>

<template>
  <div class="ops-page agent-detail-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section v-if="!ready || (contentStore.loading && !agent)" class="content-panel detail-placeholder">
      <el-skeleton :rows="6" animated />
    </section>

    <section v-else-if="loadFailed" class="content-panel detail-placeholder">
      <el-result icon="error" title="Agent 加载失败" :sub-title="contentStore.error || '管理数据暂时无法读取。'">
        <template #extra>
          <el-button type="primary" @click="reloadDetail">重试</el-button>
          <el-button @click="router.push('/agents')">返回 Agent 管理</el-button>
        </template>
      </el-result>
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
            <span v-if="pendingVersion">· 待发布 <span class="mono">v{{ pendingVersion.version }}</span>（{{ pendingVersion.status === 'candidate' ? '已冻结' : '草稿' }}）</span>
            <span>· 负责人 {{ agent.owner }}</span>
          </p>
        </div>
        <div class="detail-hero__actions">
          <el-button v-if="draftAction" :type="canManage ? 'primary' : 'default'" data-action="edit-agent-draft" @click="openDraft">{{ draftAction }}</el-button>
          <el-button v-if="canManage && hasActiveVersion" :type="agent.status === 'disabled' ? 'primary' : 'danger'" plain :loading="statusSaving" :data-action="agent.status === 'disabled' ? 'enable-agent' : 'disable-agent'" @click="changeAvailability">{{ agent.status === 'disabled' ? '启用 Agent' : '停用 Agent' }}</el-button>
          <el-button @click="router.push('/agents')">返回列表</el-button>
        </div>
      </header>
      <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，只能查看，不能修改。" />

      <nav class="status-tabs detail-tabs" role="tablist" aria-label="Agent 详情分区">
        <button
          v-for="(section, index) in sections"
          :id="`agent-detail-tab-${section.id}`"
          :key="section.id"
          class="status-tab"
          :class="{ active: activeSection === section.id }"
          type="button"
          role="tab"
          :aria-selected="activeSection === section.id"
          :aria-controls="`agent-detail-panel-${section.id}`"
          :tabindex="activeSection === section.id ? 0 : -1"
          @click="openSection(section.id)"
          @keydown="onTabKeydown($event, index)"
        >{{ section.label }}</button>
      </nav>

      <div class="detail-body">
        <div
          v-if="activeSection === 'overview'"
          id="agent-detail-panel-overview"
          role="tabpanel"
          aria-labelledby="agent-detail-tab-overview"
          class="content-panel detail-card"
        ><AgentOverviewSection :agent="agent" :active-version="activeVersion" :pending-version="pendingVersion" :can-manage="canManage" @edit="openDraft" /></div>
        <div
          v-if="visitedSections.has('access')"
          v-show="activeSection === 'access'"
          id="agent-detail-panel-access"
          role="tabpanel"
          aria-labelledby="agent-detail-tab-access"
        >
          <div class="content-panel detail-card">
            <section class="detail-section">
              <header class="detail-section__head"><div><h3>岗位权限</h3><p>谁可以向它请求工作、它持有哪些岗位角色、能接触哪些数据。属于 Agent 而非版本，修改立即生效并写审计，不需要重新验证。</p></div></header>
              <AgentAccessPanel :agent-id="agent.id" :can-manage="canManage" @updated="contentStore.load(true)" />
            </section>
          </div>
          <AgentWorkspaceGovernance :agent="agent" :can-manage="canManage" />
        </div>
        <div
          v-if="activeSection === 'routines'"
          id="agent-detail-panel-routines"
          role="tabpanel"
          aria-labelledby="agent-detail-tab-routines"
          class="content-panel detail-card"
        >
          <section class="detail-section" aria-label="主动任务">
            <header class="detail-section__head"><div><h3>主动任务</h3><p>按时间或事件主动工作，结果交给接收人。属于 Agent，修改立即生效；规则启用时固定当时的发布版本，启用中的任务提示词会自动列入验证案例。</p></div></header>
            <AgentRoutinePanel :agent-id="agent.id" :versions="versions" :can-manage="canManage" />
          </section>
        </div>
        <div
          v-if="activeSection === 'experience'"
          id="agent-detail-panel-experience"
          role="tabpanel"
          aria-labelledby="agent-detail-tab-experience"
          class="content-panel detail-card"
        ><AgentExperiencePanel :agent-id="agent.id" :can-manage="canManage" /></div>
        <div
          v-if="activeSection === 'versions'"
          id="agent-detail-panel-versions"
          role="tabpanel"
          aria-labelledby="agent-detail-tab-versions"
          class="content-panel detail-card"
        ><AgentVersionsPanel :agent-id="agent.id" :can-manage="canManage" /></div>
        <div
          v-if="activeSection === 'runs'"
          id="agent-detail-panel-runs"
          role="tabpanel"
          aria-labelledby="agent-detail-tab-runs"
          class="content-panel detail-card"
        ><AgentRunsPanel :agent-id="agent.id" /></div>
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
