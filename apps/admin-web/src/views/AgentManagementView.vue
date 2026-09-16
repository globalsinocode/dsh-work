<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, View } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import AgentDraftDialog from '@/components/AgentDraftDialog.vue'
import {
  useAgentGovernanceStore,
  type EvidenceRef,
  type SubmissionStatus,
} from '@/stores/agentGovernance'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentReleaseRecord, AgentVersionRecord } from '@/types/domain'

const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const governance = useAgentGovernanceStore()
const query = ref('')
const statusFilter = ref('all')
const selectedAgentId = ref('')
const drawerOpen = ref(false)
const editorOpen = ref(false)
const editingAgent = ref<AgentDefinition>()
const activeDetailTab = ref<'overview' | 'versions' | 'releases'>('overview')
const actionLoading = ref('')
const workspaceJoinSaving = ref(false)
const joinedWorkspacesLoading = ref(false)
const agentRoleLabels: Record<string, string> = {
  'role-platform-admin': '平台管理员',
  'role-employee': '试点员工',
  'role-supply': '供应链分析人员',
  'role-manager': '部门负责人',
  'role-auditor': '安全审计员',
}
const submissionLabel: Record<SubmissionStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  changes_requested: '已退回',
  published: '已发布',
  withdrawn: '已撤回',
}
const evidenceLabel: Record<EvidenceRef['kind'], string> = {
  configuration_checked: '配置检查',
  runtime_verified: '真实试运行',
  business_accepted: '业务确认',
}

const allAgents = computed(() => contentStore.agents)
const selectedAgent = computed(() =>
  allAgents.value.find((agent) => agent.id === selectedAgentId.value),
)
const selectedVersions = computed(() =>
  contentStore.agentVersions.filter((version) => version.agentId === selectedAgentId.value),
)
const selectedReleases = computed(() =>
  contentStore.agentReleaseRecords.filter((record) => record.agentId === selectedAgentId.value),
)
const selectedGovernance = computed(() =>
  selectedAgent.value
    ? governance.versionGovernance(selectedAgent.value.id, selectedAgent.value.version)
    : undefined,
)

const filteredAgents = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return allAgents.value.filter((agent) => {
    const matchesQuery = !keyword || `${agent.name} ${agent.description} ${agent.owner}`.toLowerCase().includes(keyword)
    const matchesStatus = statusFilter.value === 'all' || agent.status === statusFilter.value
    return matchesQuery && matchesStatus
  })
})

function draftVersionOf(agentId: string) {
  return contentStore.agentVersions.find(
    (version) => version.agentId === agentId && version.status === 'draft',
  )
}

function candidateOf(agentId: string) {
  return governance.overlays[agentId]?.candidate
}

function versionGov(version: AgentVersionRecord) {
  return selectedAgent.value
    ? governance.versionGovernance(selectedAgent.value.id, version.version)
    : { bindingRevision: 'binding-rev-3', evidence: [], revoked: false }
}

function availabilityTag(agent: AgentDefinition): { status: string; label: string } {
  if (agent.status === 'published') return { status: 'published', label: '已启用' }
  if (agent.status === 'disabled') return { status: 'disabled', label: '已停用' }
  return { status: 'draft', label: '未发布' }
}

// 草稿版本出现/消失时同步候选叠加，避免在渲染期间懒建。
watch(() => contentStore.agentVersions, () => {
  for (const agent of contentStore.agents) {
    governance.candidateFor(agent.id, draftVersionOf(agent.id)?.version)
  }
}, { deep: true })

function inspect(agent: AgentDefinition) {
  selectedAgentId.value = agent.id
  activeDetailTab.value = 'overview'
  drawerOpen.value = true
  void loadJoinedWorkspaces(agent.id)
}

function openCandidate(agent: AgentDefinition) {
  void router.push(`/agents/${encodeURIComponent(agent.id)}/release/definition`)
}

async function loadJoinedWorkspaces(agentId: string) {
  if (authStore.identityProvider === 'prototype-sso') return
  joinedWorkspacesLoading.value = true
  try {
    await contentStore.loadAgentJoinedWorkspaces(agentId)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    joinedWorkspacesLoading.value = false
  }
}

/**
 * 平台治理开关（convergence §1）：关闭后该 Agent 不再出现在团队空间「添加 Agent」
 * 搜索结果，也不能被加入；已加入的空间与既有授权不受影响。
 */
async function toggleWorkspaceJoin(next: boolean) {
  const agent = selectedAgent.value
  if (!agent) return
  try {
    await ElMessageBox.confirm(
      next
        ? '开启后该 Agent 会重新出现在团队空间的「添加 Agent」搜索结果中。'
        : '关闭后该 Agent 不再出现在团队空间的「添加 Agent」搜索结果中，也不能被加入；已加入的成员关联与既有授权不受影响。',
      `${next ? '开启' : '关闭'}「允许加入团队空间」“${agent.name}”？`,
      { confirmButtonText: `确认${next ? '开启' : '关闭'}`, cancelButtonText: '取消', type: 'warning' },
    )
    workspaceJoinSaving.value = true
    await contentStore.setAgentWorkspaceJoin(agent.id, next)
    ElMessage.success(`已${next ? '开启' : '关闭'}「允许加入团队空间」，操作已写入审计`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    workspaceJoinSaving.value = false
  }
}

function openCreate() {
  editingAgent.value = undefined
  editorOpen.value = true
}

function openEdit(agent: AgentDefinition) {
  editingAgent.value = agent
  editorOpen.value = true
}

async function handleDraftSaved(agent: AgentDefinition, source: 'config' | 'zip') {
  if (source === 'config') {
    governance.ensureOverlay(agent.id)
    // 等待候选同步完成（修订推进 + 旧检查/封存作废），再允许后续试运行/发布操作
    await governance.noteDraftSaved(agent.id)
  }
}

function evidenceName(evidence: EvidenceRef) {
  return evidenceLabel[evidence.kind]
}

function agentRoleNames(agent: AgentDefinition) {
  return agent.roleIds
    .map((roleId) => agentRoleLabels[roleId] ?? roleId)
    .join('、')
}

function formatUpdatedAt(value: string) {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : value
}

async function changeAvailability(agent: AgentDefinition) {
  const disabling = agent.status === 'published'
  const nextStatus = disabling ? 'disabled' : 'published'
  const actionLabel = disabling ? '停用' : '启用'
  try {
    await ElMessageBox.confirm(
      disabling
        ? '停用后拒绝新的 Run，已开始的 Attempt 允许排空；不影响已加入空间的历史记录。'
        : '启用后将恢复当前版本的员工可见范围。',
      `${actionLabel}“${agent.name}”？`,
      { confirmButtonText: `确认${actionLabel}`, cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `status:${agent.id}`
    await contentStore.setAgentStatus(agent.id, nextStatus)
    ElMessage.success(`Agent 已${actionLabel}，操作已写入发布记录`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

async function rollback(version: AgentVersionRecord) {
  const agent = selectedAgent.value
  if (!agent) return
  try {
    await ElMessageBox.confirm(
      `活动版本将从 v${agent.version} 切换为已发布的 v${version.version}。历史版本不会被修改。`,
      `回滚“${agent.name}”？`,
      { confirmButtonText: '确认回滚', cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `rollback:${version.id}`
    await contentStore.rollbackAgent(agent.id, version.version)
    activeDetailTab.value = 'releases'
    ElMessage.success(`已回滚到 v${version.version}，发布记录已生成`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

function releaseActionLabel(record: AgentReleaseRecord) {
  return {
    published: '发布版本',
    enabled: '启用 Agent',
    disabled: '停用 Agent',
    rollback: '版本回滚',
  }[record.action]
}

onMounted(async () => {
  await contentStore.load()
  void Promise.allSettled([governance.loadSubmissionIndex(), governance.loadEvidenceIndex()])
})
</script>

<template>
  <div class="ops-page agent-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />
    <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，仅可查看 Agent 配置、版本和发布记录。" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索 Agent 名称、说明或负责人" />
        <el-select v-model="statusFilter" aria-label="筛选 Agent 状态">
          <el-option label="全部状态" value="all" />
          <el-option label="已发布" value="published" />
          <el-option label="草稿" value="draft" />
          <el-option label="已停用" value="disabled" />
        </el-select>
        <span class="filter-bar__meta">{{ filteredAgents.length }} 个 Agent</span>
        <el-button @click="$router.push('/assistant?context=agents')">交给管理助手</el-button>
        <el-button v-if="authStore.canManage" class="create-button" type="primary" :icon="Plus" data-action="create-agent" @click="openCreate">创建 Agent</el-button>
      </div>
    </section>

    <section class="content-panel content-panel--flush agent-table">
      <el-table class="data-table" v-loading="contentStore.loading" :data="filteredAgents" empty-text="暂无匹配的 Agent" @row-click="inspect">
        <el-table-column label="Agent" min-width="300"><template #default="scope"><div class="agent-cell"><span class="agent-cell__mark">d</span><div><strong>{{ scope.row.name }}</strong><small>{{ scope.row.description }}</small></div></div></template></el-table-column>
        <el-table-column label="发布版本" width="130">
          <template #default="scope">
            <template v-if="scope.row.status !== 'draft'">
              <span class="code-text mono">v{{ scope.row.version }}</span>
              <small class="cell-sub">{{ governance.versionGovernance(scope.row.id, scope.row.version).bindingRevision }}</small>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="可用性" width="105"><template #default="scope"><StatusTag v-bind="availabilityTag(scope.row)" /></template></el-table-column>
        <el-table-column label="候选 / 提交" width="140">
          <template #default="scope">
            <button
              v-if="candidateOf(scope.row.id)"
              type="button"
              class="candidate-tag"
              data-action="open-candidate"
              @click.stop="openCandidate(scope.row)"
            >rev {{ candidateOf(scope.row.id)?.revision ?? 1 }} · {{ submissionLabel[candidateOf(scope.row.id)?.status ?? 'draft'] }}</button>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="owner" label="负责人" min-width="140" />
        <el-table-column prop="visibility" label="可见范围" min-width="150" />
        <el-table-column label="更新时间" width="170">
          <template #default="scope">{{ formatUpdatedAt(scope.row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="scope">
            <el-button link type="primary" :icon="View" data-action="view-agent" @click.stop="inspect(scope.row)">查看</el-button>
            <el-button v-if="authStore.canManage" link type="primary" data-action="edit-agent" @click.stop="openEdit(scope.row)">{{ scope.row.status === 'draft' ? '编辑' : '创建新版本' }}</el-button>
            <el-button v-if="authStore.canManage && (candidateOf(scope.row.id) || draftVersionOf(scope.row.id))" link type="primary" data-action="open-candidate" @click.stop="openCandidate(scope.row)">试运行与发布</el-button>
            <el-button v-if="authStore.canManage && scope.row.status !== 'draft'" link type="primary" :loading="actionLoading === `status:${scope.row.id}`" :data-action="scope.row.status === 'published' ? 'disable-agent' : 'enable-agent'" @click.stop="changeAvailability(scope.row)">{{ scope.row.status === 'published' ? '停用' : '启用' }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="drawerOpen" size="min(1040px, 100vw)">
      <template #header>
        <span class="drawer-title">Agent 治理详情</span>
      </template>
      <template v-if="selectedAgent">
        <div class="agent-detail__hero"><span class="agent-detail__mark">d</span><div><h2>{{ selectedAgent.name }}</h2><p>{{ selectedAgent.description }}</p></div><StatusTag v-bind="availabilityTag(selectedAgent)" /></div>

        <div class="status-tabs agent-detail__tabs" role="tablist" aria-label="Agent 详情类型">
          <button class="status-tab" :class="{ active: activeDetailTab === 'overview' }" type="button" role="tab" :aria-selected="activeDetailTab === 'overview'" @click="activeDetailTab = 'overview'">概览与生命周期</button>
          <button class="status-tab" :class="{ active: activeDetailTab === 'versions' }" type="button" role="tab" :aria-selected="activeDetailTab === 'versions'" @click="activeDetailTab = 'versions'">版本历史 <span class="tab-count">{{ selectedVersions.length }}</span></button>
          <button class="status-tab" :class="{ active: activeDetailTab === 'releases' }" type="button" role="tab" :aria-selected="activeDetailTab === 'releases'" @click="activeDetailTab = 'releases'">发布记录 <span class="tab-count">{{ selectedReleases.length }}</span></button>
        </div>

        <template v-if="activeDetailTab === 'overview'">
          <section class="agent-detail__section governance-status">
            <h3>治理状态</h3>
            <dl class="agent-detail__meta">
              <div><dt>发布版本</dt><dd class="mono">{{ selectedAgent.status === 'draft' ? '—' : `v${selectedAgent.version}` }}</dd></div>
              <div><dt>绑定修订</dt><dd class="mono">{{ selectedGovernance?.bindingRevision ?? '—' }}</dd></div>
              <div><dt>可用性</dt><dd><StatusTag v-bind="availabilityTag(selectedAgent)" /></dd></div>
              <div>
                <dt>证据</dt>
                <dd class="evidence-chips">
                  <el-tag v-for="item in selectedGovernance?.evidence ?? []" :key="item.kind + item.at" size="small" type="success" effect="plain" :title="`${item.summary} · ${item.by}`">{{ evidenceName(item) }}</el-tag>
                  <span v-if="!selectedGovernance?.evidence.length" class="muted">暂无运行证据</span>
                </dd>
              </div>
            </dl>
          </section>
          <dl class="agent-detail__meta">
            <div><dt>Agent 标识</dt><dd class="mono">{{ selectedAgent.id }}</dd></div><div><dt>活动版本</dt><dd class="mono">v{{ selectedAgent.version }}</dd></div><div><dt>负责人</dt><dd>{{ selectedAgent.owner }}</dd></div><div><dt>归属部门</dt><dd>{{ selectedAgent.department }}</dd></div><div><dt>可见范围</dt><dd>{{ selectedAgent.visibility }}</dd></div><div><dt>可见角色</dt><dd>{{ agentRoleNames(selectedAgent) }}</dd></div><div><dt>运行限制</dt><dd>{{ selectedAgent.maxTokens.toLocaleString() }} Token · {{ selectedAgent.timeoutSeconds }} 秒</dd></div>
          </dl>
          <section class="agent-detail__section"><h3>员工使用体验</h3><div class="experience-card"><strong>欢迎语</strong><p>{{ selectedAgent.welcomeMessage }}</p><strong>示例问题</strong><div class="chip-list"><span v-for="prompt in selectedAgent.examplePrompts" :key="prompt">{{ prompt }}</span></div></div></section>
          <section class="agent-detail__section"><h3>System Prompt</h3><pre class="prompt-preview">{{ selectedAgent.systemPrompt }}</pre></section>
          <section class="agent-detail__section"><h3>Skill 引用</h3><div class="chip-list"><span v-for="skill in selectedAgent.skills" :key="skill">{{ skill }}</span></div></section>
          <section class="agent-detail__section"><h3>工具允许列表</h3><div class="chip-list chip-list--code"><span v-for="tool in selectedAgent.tools" :key="tool">{{ tool }}</span></div></section>
          <section class="agent-detail__section"><h3>业务数据范围</h3><div class="chip-list"><span v-for="scope in selectedAgent.dataScopes" :key="scope">{{ scope }}</span></div></section>
          <section class="agent-detail__section">
            <h3>团队空间治理</h3>
            <div class="governance-row">
              <div>
                <strong>允许加入团队空间</strong>
                <p>关闭后该 Agent 不再出现在团队空间的「添加 Agent」搜索结果中，也不能被加入；已加入的空间、成员关联与既有授权不受影响。</p>
              </div>
              <el-switch
                v-if="authStore.canManage"
                :model-value="selectedAgent.allowWorkspaceJoin"
                :loading="workspaceJoinSaving"
                active-text="允许"
                inactive-text="禁止"
                data-action="toggle-agent-workspace-join"
                @change="(value: string | number | boolean) => toggleWorkspaceJoin(value === true)"
              />
              <StatusTag v-else :status="selectedAgent.allowWorkspaceJoin ? 'published' : 'disabled'" :label="selectedAgent.allowWorkspaceJoin ? '允许加入' : '禁止加入'" />
            </div>
            <div class="joined-workspaces">
              <h4>已加入空间 <span class="tab-count">{{ (contentStore.agentJoinedWorkspaces[selectedAgent.id] ?? []).length }}</span></h4>
              <el-table
                v-loading="joinedWorkspacesLoading"
                class="data-table"
                :data="contentStore.agentJoinedWorkspaces[selectedAgent.id] ?? []"
                empty-text="该 Agent 尚未加入任何团队空间"
              >
                <el-table-column prop="workspaceName" label="空间" min-width="180" />
                <el-table-column label="固定版本" width="100"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span></template></el-table-column>
                <el-table-column label="成员状态" width="110"><template #default="scope"><StatusTag :status="scope.row.memberStatus === 'available' ? 'published' : 'disabled'" :label="scope.row.memberStatus === 'available' ? '可用' : '已停用'" /></template></el-table-column>
                <el-table-column prop="addedBy" label="加入人" min-width="120" />
                <el-table-column label="加入时间" width="165"><template #default="scope">{{ formatUpdatedAt(scope.row.createdAt) }}</template></el-table-column>
              </el-table>
              <el-alert type="info" :closable="false" show-icon title="停用或移出某个空间前，先确认该 Agent 的固定版本与成员状态，避免影响仍在使用它的团队会话。" />
            </div>
          </section>
          <section class="agent-detail__section"><h3>版本策略</h3><el-alert type="info" :closable="false" show-icon title="创建运行时锁定活动版本；已发布版本不可原地修改，回滚只切换活动版本指针。" /></section>
        </template>


        <section v-else-if="activeDetailTab === 'versions'" class="agent-detail__table">
          <el-table class="data-table" :data="selectedVersions" empty-text="暂无版本记录">
            <el-table-column label="版本" width="120"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span><small v-if="scope.row.version === selectedAgent?.version" class="current-version">当前</small><small class="cell-sub mono">{{ versionGov(scope.row).bindingRevision }}</small></template></el-table-column>
            <el-table-column label="变更说明" min-width="200"><template #default="scope"><div class="version-summary"><strong>{{ scope.row.summary }}</strong><small>{{ scope.row.createdBy }} · {{ formatUpdatedAt(scope.row.createdAt) }}</small></div></template></el-table-column>
            <el-table-column label="状态" width="95"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
            <el-table-column label="证据" min-width="160">
              <template #default="scope">
                <div v-if="versionGov(scope.row).evidence.length" class="evidence-chips">
                  <el-tag v-for="item in versionGov(scope.row).evidence" :key="item.kind + item.at" size="small" effect="plain" :title="item.summary">{{ evidenceName(item) }}</el-tag>
                </div>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="170" fixed="right">
              <template #default="scope">
                <el-button v-if="authStore.canManage && scope.row.status !== 'draft' && scope.row.version !== selectedAgent?.version" link type="primary" :loading="actionLoading === `rollback:${scope.row.id}`" data-action="rollback-agent" @click="rollback(scope.row)">回滚至此</el-button>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section v-else class="agent-detail__releases">
          <el-empty v-if="!selectedReleases.length" description="暂无发布记录" />
          <el-timeline v-else><el-timeline-item v-for="record in selectedReleases" :key="record.id" :timestamp="formatUpdatedAt(record.time)" placement="top"><article class="release-record"><div><strong>{{ releaseActionLabel(record) }} · v{{ record.version }}</strong><StatusTag :status="record.action === 'disabled' ? 'disabled' : 'published'" :label="releaseActionLabel(record)" /></div><p>{{ record.note }}</p><small>操作人：{{ record.actor }}</small></article></el-timeline-item></el-timeline>
        </section>

        <div v-if="authStore.canManage" class="agent-detail__footer">
          <el-button @click="openEdit(selectedAgent)">{{ selectedAgent.status === 'draft' ? '编辑 Agent' : '创建新版本' }}</el-button>
          <el-button v-if="candidateOf(selectedAgent.id) || draftVersionOf(selectedAgent.id)" type="primary" @click="openCandidate(selectedAgent)">前往发布工作台</el-button>
          <el-button v-if="selectedAgent.status !== 'draft'" :type="selectedAgent.status === 'published' ? 'danger' : 'primary'" :loading="actionLoading === `status:${selectedAgent.id}`" @click="changeAvailability(selectedAgent)">{{ selectedAgent.status === 'published' ? '停用 Agent' : '启用 Agent' }}</el-button>
        </div>
      </template>
    </el-drawer>

    <AgentDraftDialog
      v-model="editorOpen"
      :agent="editingAgent"
      @saved="handleDraftSaved"
      @continue-release="openCandidate"
    />
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 300px; }
.filter-bar .el-select { width: 140px; }
.create-button { margin-left: 0; }
.muted { color: var(--color-text-muted); }
.mono { font-family: monospace; }
.cell-sub { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.candidate-tag { padding: 3px 9px; border: 1px solid var(--color-primary); border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); cursor: pointer; font-size: var(--font-size-badge); }
.candidate-tag:hover, .candidate-tag:focus-visible { color: var(--color-bg-base); background: var(--color-primary); outline: none; }
.agent-cell { display: flex; min-width: 0; align-items: center; gap: 10px; cursor: pointer; }
.agent-cell__mark,
.agent-detail__mark { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border-radius: var(--radius-button); color: var(--color-bg-base); background: var(--color-primary); font-size: var(--font-size-heading); font-weight: var(--font-weight-heading); font-style: italic; }
.agent-cell > div { display: flex; min-width: 0; flex-direction: column; }
.agent-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.agent-cell small { max-width: 440px; margin-top: 4px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.agent-table code { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.drawer-title { display: inline-flex; align-items: center; gap: 8px; color: var(--color-text-heading); font-size: var(--font-size-body); font-weight: var(--font-weight-title); }
.agent-detail__hero { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.agent-detail__mark { width: 43px; height: 43px; border-radius: var(--radius-card); }
.agent-detail__hero h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.agent-detail__hero p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.5; }
.agent-detail__tabs { margin: 18px 0 4px; }
.agent-detail__meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 24px; margin: 12px 0 0; }
.agent-detail__meta div { padding: 10px 0; border-bottom: 1px solid var(--color-border); }
.agent-detail__meta dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.agent-detail__meta dd { margin: 4px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-badge); }
.agent-detail__section { margin-top: 24px; }
.agent-detail__section h3 { margin: 0 0 9px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.governance-status { margin-top: 14px; }
.governance-status .agent-detail__meta { margin-top: 0; }
.evidence-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-list { display: flex; flex-wrap: wrap; gap: 7px; }
.chip-list span { padding: 6px 9px; border: 1px solid var(--color-border); border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); }
.chip-list--code span { color: var(--color-text-secondary); background: var(--color-bg-subtle); font-family: monospace; }
.experience-card { padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-subtle); }
.experience-card strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.experience-card p { margin: 5px 0 12px; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.6; }
.prompt-preview { max-height: 220px; margin: 0; padding: 14px; overflow: auto; border: 1px solid var(--color-border); border-radius: var(--radius-button); color: var(--color-text-primary); background: var(--color-bg-subtle); font-family: inherit; font-size: var(--font-size-caption); line-height: 1.65; white-space: pre-wrap; }
.agent-detail__table { margin-top: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-card); overflow: hidden; }
.current-version { display: inline-flex; margin-left: 5px; padding: 2px 5px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-micro); }
.version-summary { display: flex; flex-direction: column; }
.version-summary strong { color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-badge); }
.version-summary small { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.agent-detail__releases { margin-top: 18px; }
.governance-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-subtle); }
.governance-row strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.governance-row p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.6; }
.joined-workspaces { margin-top: 16px; }
.joined-workspaces h4 { margin: 0 0 9px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.joined-workspaces .data-table { margin-bottom: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-card); overflow: hidden; }
.release-record { padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-base); }
.release-record > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.release-record strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.release-record p { margin: 7px 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.5; }
.release-record small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.agent-detail__footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--color-border); }
@media (max-width: 700px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } .agent-detail__meta { grid-template-columns: 1fr; } }
</style>
