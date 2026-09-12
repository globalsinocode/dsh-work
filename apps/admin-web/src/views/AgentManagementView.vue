<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, View } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import AgentDraftDialog from '@/components/AgentDraftDialog.vue'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentReleaseRecord, AgentVersionRecord } from '@/types/domain'

const authStore = useAuthStore()
const contentStore = useContentStore()
const query = ref('')
const statusFilter = ref('all')
const selectedAgentId = ref('')
const drawerOpen = ref(false)
const editorOpen = ref(false)
const editingAgent = ref<AgentDefinition>()
const activeDetailTab = ref<'config' | 'versions' | 'releases'>('config')
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

const selectedAgent = computed(() =>
  contentStore.agents.find((agent) => agent.id === selectedAgentId.value),
)
const selectedVersions = computed(() =>
  contentStore.agentVersions.filter((version) => version.agentId === selectedAgentId.value),
)
const selectedReleases = computed(() =>
  contentStore.agentReleaseRecords.filter((record) => record.agentId === selectedAgentId.value),
)

const filteredAgents = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.agents.filter((agent) => {
    const matchesQuery = !keyword || `${agent.name} ${agent.description} ${agent.owner}`.toLowerCase().includes(keyword)
    const matchesStatus = statusFilter.value === 'all' || agent.status === statusFilter.value
    return matchesQuery && matchesStatus
  })
})

function inspect(agent: AgentDefinition) {
  selectedAgentId.value = agent.id
  activeDetailTab.value = 'config'
  drawerOpen.value = true
  void loadJoinedWorkspaces(agent.id)
}

async function loadJoinedWorkspaces(agentId: string) {
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

function handleDraftSaved(agent: AgentDefinition) {
  selectedAgentId.value = agent.id
  activeDetailTab.value = 'config'
  drawerOpen.value = true
  void loadJoinedWorkspaces(agent.id)
}

function agentRoleNames(agent: AgentDefinition) {
  return agent.roleIds
    .map((roleId) => agentRoleLabels[roleId] ?? roleId)
    .join('、')
}

async function publish(agent: AgentDefinition) {
  try {
    await ElMessageBox.confirm(
      `发布后版本 ${agent.version} 的提示词、Skill、工具和权限配置将锁定，后续变更需要创建新版本。`,
      `发布“${agent.name}”版本 ${agent.version}？`,
      { confirmButtonText: '确认发布', cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `publish:${agent.id}`
    const test = await contentStore.testAgent(
      agent.id,
      agent.examplePrompts[0] ?? '请介绍你能提供哪些帮助',
    )
    if (test.status !== 'passed') throw new Error(test.resultSummary)
    await contentStore.setAgentStatus(agent.id, 'published')
    ElMessage.success('服务端配置校验通过，Agent 版本已发布')
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

async function changeAvailability(agent: AgentDefinition) {
  const disabling = agent.status === 'published'
  const nextStatus = disabling ? 'disabled' : 'published'
  const actionLabel = disabling ? '停用' : '启用'
  try {
    await ElMessageBox.confirm(
      disabling
        ? '停用后员工不能再用此 Agent 创建新运行，已开始的运行不受影响。'
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

onMounted(() => contentStore.load())
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
        <el-table-column prop="version" label="活动版本" width="110"><template #default="scope"><span class="code-text">v{{ scope.row.version }}</span></template></el-table-column>
        <el-table-column label="状态" width="105"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
        <el-table-column prop="owner" label="负责人" min-width="140" />
        <el-table-column prop="visibility" label="可见范围" min-width="150" />
        <el-table-column prop="updatedAt" label="更新时间" width="156" />
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="scope">
            <el-button link type="primary" :icon="View" data-action="view-agent" @click.stop="inspect(scope.row)">查看</el-button>
            <el-button v-if="authStore.canManage" link type="primary" data-action="edit-agent" @click.stop="openEdit(scope.row)">{{ scope.row.status === 'draft' ? '编辑' : '创建新版本' }}</el-button>
            <el-button v-if="authStore.canManage && scope.row.status === 'draft'" link type="primary" :loading="actionLoading === `publish:${scope.row.id}`" data-action="publish-agent" @click.stop="publish(scope.row)">发布</el-button>
            <el-button v-if="authStore.canManage && scope.row.status !== 'draft'" link type="primary" :loading="actionLoading === `status:${scope.row.id}`" :data-action="scope.row.status === 'published' ? 'disable-agent' : 'enable-agent'" @click.stop="changeAvailability(scope.row)">{{ scope.row.status === 'published' ? '停用' : '启用' }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="drawerOpen" size="min(780px, 100vw)" title="Agent 治理详情">
      <template v-if="selectedAgent">
        <div class="agent-detail__hero"><span class="agent-detail__mark">d</span><div><h2>{{ selectedAgent.name }}</h2><p>{{ selectedAgent.description }}</p></div><StatusTag :status="selectedAgent.status" /></div>

        <div class="status-tabs agent-detail__tabs" role="tablist" aria-label="Agent 详情类型">
          <button class="status-tab" :class="{ active: activeDetailTab === 'config' }" type="button" role="tab" :aria-selected="activeDetailTab === 'config'" @click="activeDetailTab = 'config'">配置详情</button>
          <button class="status-tab" :class="{ active: activeDetailTab === 'versions' }" type="button" role="tab" :aria-selected="activeDetailTab === 'versions'" @click="activeDetailTab = 'versions'">版本历史 <span class="tab-count">{{ selectedVersions.length }}</span></button>
          <button class="status-tab" :class="{ active: activeDetailTab === 'releases' }" type="button" role="tab" :aria-selected="activeDetailTab === 'releases'" @click="activeDetailTab = 'releases'">发布记录 <span class="tab-count">{{ selectedReleases.length }}</span></button>
        </div>

        <template v-if="activeDetailTab === 'config'">
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
                <p>关闭后该 Agent 不再出现在团队空间「添加 Agent」搜索结果中，也不能被加入；已加入的空间、成员关联与既有授权不受影响。</p>
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
                <el-table-column prop="createdAt" label="加入时间" width="120" />
              </el-table>
              <el-alert type="info" :closable="false" show-icon title="停用或移出某个空间前，先确认该 Agent 的固定版本与成员状态，避免影响仍在使用它的团队会话。" />
            </div>
          </section>
          <section class="agent-detail__section"><h3>版本策略</h3><el-alert type="info" :closable="false" show-icon title="创建运行时锁定活动版本；已发布版本不可原地修改，回滚只切换活动版本指针。" /></section>
        </template>

        <section v-else-if="activeDetailTab === 'versions'" class="agent-detail__table">
          <el-table class="data-table" :data="selectedVersions" empty-text="暂无版本记录">
            <el-table-column label="版本" width="100"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span><small v-if="scope.row.version === selectedAgent?.version" class="current-version">当前</small></template></el-table-column>
            <el-table-column label="变更说明" min-width="230"><template #default="scope"><div class="version-summary"><strong>{{ scope.row.summary }}</strong><small>{{ scope.row.createdBy }} · {{ scope.row.createdAt }}</small></div></template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
            <el-table-column label="操作" width="105" fixed="right"><template #default="scope"><el-button v-if="authStore.canManage && scope.row.status !== 'draft' && scope.row.version !== selectedAgent?.version" link type="primary" :loading="actionLoading === `rollback:${scope.row.id}`" data-action="rollback-agent" @click="rollback(scope.row)">回滚至此</el-button><span v-else class="muted">—</span></template></el-table-column>
          </el-table>
        </section>

        <section v-else class="agent-detail__releases">
          <el-empty v-if="!selectedReleases.length" description="暂无发布记录" />
          <el-timeline v-else><el-timeline-item v-for="record in selectedReleases" :key="record.id" :timestamp="record.time" placement="top"><article class="release-record"><div><strong>{{ releaseActionLabel(record) }} · v{{ record.version }}</strong><StatusTag :status="record.action === 'disabled' ? 'disabled' : 'published'" :label="releaseActionLabel(record)" /></div><p>{{ record.note }}</p><small>操作人：{{ record.actor }}</small></article></el-timeline-item></el-timeline>
        </section>

        <div v-if="authStore.canManage" class="agent-detail__footer"><el-button @click="openEdit(selectedAgent)">{{ selectedAgent.status === 'draft' ? '编辑 Agent' : '创建新版本' }}</el-button><el-button v-if="selectedAgent.status === 'draft'" type="primary" @click="publish(selectedAgent)">校验并发布当前版本</el-button><el-button v-else :type="selectedAgent.status === 'published' ? 'danger' : 'primary'" @click="changeAvailability(selectedAgent)">{{ selectedAgent.status === 'published' ? '停用 Agent' : '启用 Agent' }}</el-button></div>
      </template>
    </el-drawer>

    <AgentDraftDialog v-model="editorOpen" :agent="editingAgent" @saved="handleDraftSaved" />
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 300px; }
.filter-bar .el-select { width: 140px; }
.create-button { margin-left: 0; }
.agent-cell { display: flex; min-width: 0; align-items: center; gap: 10px; cursor: pointer; }
.agent-cell__mark,
.agent-detail__mark { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border-radius: var(--radius-button); color: var(--color-bg-base); background: var(--color-primary); font-size: var(--font-size-heading); font-weight: var(--font-weight-heading); font-style: italic; }
.agent-cell > div { display: flex; min-width: 0; flex-direction: column; }
.agent-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.agent-cell small { max-width: 440px; margin-top: 4px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.agent-table code { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
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
.agent-detail__footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--color-border); text-align: right; }
@media (max-width: 700px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } .agent-detail__meta { grid-template-columns: 1fr; } }
</style>
