<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, View } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import AgentCreateDialog from '@/components/agent-detail/AgentCreateDialog.vue'
import { useListPagination } from '@/composables/use-list-pagination'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition } from '@/types/domain'
import { activeVersionOf, availabilityOf, draftEntryStep, pendingVersionOf as pendingOf, type AgentDraftStep } from '@/utils/agent-status'

const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const query = ref('')
const statusFilter = ref('all')
const createOpen = ref(false)
const actionLoading = ref('')

const filteredAgents = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.agents.filter((agent) => {
    const matchesQuery = !keyword || `${agent.name} ${agent.description} ${agent.owner}`.toLowerCase().includes(keyword)
    const matchesStatus = statusFilter.value === 'all' || agent.status === statusFilter.value
    return matchesQuery && matchesStatus
  })
})
const { currentPage: agentPage, pagedItems: pagedAgents } =
  useListPagination(filteredAgents, { resetOn: [query, statusFilter] })

function pendingVersionOf(agentId: string) {
  return pendingOf(contentStore.agents.find(agent => agent.id === agentId), contentStore.agentVersions)
}

function availabilityTag(agent: AgentDefinition) {
  return availabilityOf(agent)
}

/** 详情页只读查看与运维。 */
function openDetail(agent: AgentDefinition) {
  void router.push({ path: `/agents/${encodeURIComponent(agent.id)}` })
}

/** 草稿编辑流程：已冻结待发布时直接进入验证与发布，否则从职责与人格开始。 */
function openDraft(agent: AgentDefinition, step?: AgentDraftStep) {
  void router.push({
    path: `/agents/${encodeURIComponent(agent.id)}/draft`,
    query: { step: step ?? draftEntryStep(pendingVersionOf(agent.id)) },
  })
}

function formatUpdatedAt(value: string) {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : value
}

async function changeAvailability(agent: AgentDefinition) {
  const disabling = agent.status !== 'disabled'
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
    await contentStore.setAgentStatus(agent.id, disabling ? 'disabled' : 'published')
    ElMessage.success(`Agent 已${actionLabel}，操作已写入审计`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

onMounted(async () => {
  await contentStore.load()
})
</script>

<template>
  <div class="ops-page agent-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />
    <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，仅可查看 Agent 配置与版本；发布、回滚和启停记录见审计日志。" />

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
        <el-button v-if="authStore.canManage" class="create-button" type="primary" :icon="Plus" data-action="create-agent" @click="createOpen = true">创建 Agent</el-button>
      </div>
    </section>

    <section class="content-panel content-panel--flush agent-table">
      <el-table class="data-table" v-loading="contentStore.loading" :data="pagedAgents" empty-text="暂无匹配的 Agent" @row-click="(row: AgentDefinition) => openDetail(row)">
        <el-table-column label="Agent" min-width="300"><template #default="scope"><div class="agent-cell"><span class="agent-cell__mark">d</span><div><strong>{{ scope.row.name }}</strong><small>{{ scope.row.description }}</small></div></div></template></el-table-column>
        <el-table-column label="当前版本" width="120">
          <template #default="scope">
            <span v-if="activeVersionOf(scope.row)" class="code-text mono">v{{ activeVersionOf(scope.row) }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="可用性" width="105"><template #default="scope"><StatusTag v-bind="availabilityTag(scope.row)" /></template></el-table-column>
        <el-table-column label="待发布" width="140">
          <template #default="scope">
            <button
              v-if="pendingVersionOf(scope.row.id)"
              type="button"
              class="candidate-tag"
              data-action="open-release"
              @click.stop="openDraft(scope.row, 'release')"
            >v{{ pendingVersionOf(scope.row.id)?.version }} · {{ pendingVersionOf(scope.row.id)?.status === 'candidate' ? '已冻结' : '草稿' }}</button>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="owner" label="负责人" min-width="140" />
        <el-table-column prop="visibility" label="可见范围" min-width="150" />
        <el-table-column label="更新时间" width="170">
          <template #default="scope">{{ formatUpdatedAt(scope.row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="scope">
            <el-button link type="primary" :icon="View" data-action="view-agent" @click.stop="openDetail(scope.row)">查看</el-button>
            <el-button v-if="authStore.canManage" link type="primary" data-action="edit-agent-draft" @click.stop="openDraft(scope.row)">{{ pendingVersionOf(scope.row.id) ? '继续编辑' : '编辑配置' }}</el-button>
            <el-button v-if="authStore.canManage && activeVersionOf(scope.row)" link type="primary" :loading="actionLoading === `status:${scope.row.id}`" :data-action="scope.row.status === 'disabled' ? 'enable-agent' : 'disable-agent'" @click.stop="changeAvailability(scope.row)">{{ scope.row.status === 'disabled' ? '启用' : '停用' }}</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-model:current-page="agentPage" background layout="prev, pager, next" :total="filteredAgents.length" :page-size="10" /></div>
    </section>

    <AgentCreateDialog v-model="createOpen" @created="(agent: AgentDefinition) => openDraft(agent, 'profile')" />
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
.agent-cell__mark { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border-radius: var(--radius-button); color: var(--color-bg-base); background: var(--color-primary); font-size: var(--font-size-heading); font-weight: var(--font-weight-heading); font-style: italic; }
.agent-cell > div { display: flex; min-width: 0; flex-direction: column; }
.agent-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.agent-cell small { max-width: 440px; margin-top: 4px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.agent-table code { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
@media (max-width: 700px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
