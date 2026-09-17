<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { FolderOpened, Search, View } from '@element-plus/icons-vue'

import { useListPagination } from '@/composables/use-list-pagination'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { GrantSourceReconciliationItem, ManagedWorkspaceDefinition } from '@/types/domain'

const authStore = useAuthStore()
const contentStore = useContentStore()
const query = ref('')
const selectedWorkspace = ref<ManagedWorkspaceDefinition>()
const drawerOpen = ref(false)
const reconcilingSourceId = ref('')
const reconcilingWorkspaceId = ref('')

const filteredWorkspaces = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.workspaces.filter((workspace) =>
    !keyword || `${workspace.name} ${workspace.id} ${workspace.description} ${workspace.creator}`.toLowerCase().includes(keyword),
  )
})
const memberTotal = computed(() => contentStore.workspaces.reduce((sum, workspace) => sum + workspace.memberCount, 0))
const sessionTotal = computed(() => contentStore.workspaces.reduce((sum, workspace) => sum + workspace.sessionCount, 0))
const artifactTotal = computed(() => contentStore.workspaces.reduce((sum, workspace) => sum + workspace.artifactCount, 0))
const unresolvedItems = computed(() => contentStore.grantReconciliation?.items ?? [])
const unresolvedWorkspaceCount = computed(() => contentStore.grantReconciliation?.workspaceSummary.length ?? 0)
const { currentPage: workspacePage, pagedItems: pagedWorkspaces } =
  useListPagination(filteredWorkspaces, { resetOn: query })
const { currentPage: reconcilePage, pagedItems: pagedUnresolvedItems } =
  useListPagination(unresolvedItems)

const capabilityTypeLabels: Record<GrantSourceReconciliationItem['capabilityType'], string> = {
  agent: 'Agent 版本',
  skill: 'Skill 版本',
  tool: '工具版本',
}

function inspect(workspace: ManagedWorkspaceDefinition) {
  selectedWorkspace.value = workspace
  drawerOpen.value = true
}

function possibleAgentLabel(item: GrantSourceReconciliationItem) {
  return item.possibleAgents.map(agent => `${agent.agentName} v${agent.version}`).join('、') || '—'
}

function capabilityTypeLabel(value: string) {
  return capabilityTypeLabels[value as GrantSourceReconciliationItem['capabilityType']] ?? value
}

function workspaceUnresolvedCount(workspaceId: string) {
  return unresolvedItems.value.filter(item => item.workspaceId === workspaceId).length
}

/**
 * 对账完成（convergence §2）：把 legacy 来源改写为 manual 并记审计；不自动回填为某个
 * Agent 所有。对账完成前，涉及该来源的 Agent 移出/停用会被服务端拒绝。
 */
async function reconcile(sourceIds: string[], scopeLabel: string) {
  // 确认对话框与接口调用分开处理：用户点「取消」时 Element Plus 会 reject，
  // 不应把它当作失败而弹出错误提示。
  try {
    await ElMessageBox.confirm(
      '对账完成后这些历史授权来源会改写为「明确人工授权」并记录审计；不会自动归属到某个 Agent，也不会改变当前有效授权集合。完成前涉及的 Agent 移出/停用会被拒绝。',
      `确认完成对账：${scopeLabel}？`,
      { confirmButtonText: '确认对账完成', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    reconcilingSourceId.value = ''
    reconcilingWorkspaceId.value = ''
    return
  }
  try {
    const result = await contentStore.reconcileGrantSources(sourceIds)
    ElMessage.success(`已对账 ${result.reconciled} 条授权来源，操作已写入审计`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    reconcilingSourceId.value = ''
    reconcilingWorkspaceId.value = ''
  }
}

async function reconcileItem(item: GrantSourceReconciliationItem) {
  reconcilingSourceId.value = item.sourceId
  await reconcile([item.sourceId], item.capabilityLabel)
}

async function reconcileWorkspace(workspaceId: string, workspaceName: string) {
  const ids = unresolvedItems.value.filter(item => item.workspaceId === workspaceId).map(item => item.sourceId)
  if (!ids.length) return
  reconcilingWorkspaceId.value = workspaceId
  await reconcile(ids, `${workspaceName} 的 ${ids.length} 条来源`)
}

onMounted(async () => {
  await contentStore.load()
  try {
    await contentStore.loadGrantSourceReconciliation()
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  }
})
</script>

<template>
  <div class="ops-page workspace-admin-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索工作空间、标识或创建人" />
        <span class="filter-bar__meta">{{ filteredWorkspaces.length }} 个团队工作空间</span>
      </div>
    </section>

    <section v-loading="contentStore.loading" class="metric-grid">
      <article class="metric-card"><div class="metric-label">团队工作空间</div><div class="metric-value">{{ contentStore.workspaces.length }}</div><div class="metric-detail">个人空间由系统自动维护</div></article>
      <article class="metric-card"><div class="metric-label">成员席位</div><div class="metric-value">{{ memberTotal }}</div><div class="metric-detail">按工作空间成员关系累计</div></article>
      <article class="metric-card"><div class="metric-label">空间内 Session</div><div class="metric-value">{{ sessionTotal }}</div><div class="metric-detail">继承工作空间上下文</div></article>
      <article class="metric-card"><div class="metric-label">空间成果</div><div class="metric-value">{{ artifactTotal }}</div><div class="metric-detail">团队可复用交付物</div></article>
    </section>

    <section class="content-panel content-panel--flush workspace-table">
      <el-table class="data-table" v-loading="contentStore.loading" :data="pagedWorkspaces" empty-text="暂无匹配的工作空间" @row-click="inspect">
        <el-table-column label="工作空间" min-width="280"><template #default="scope"><div class="workspace-cell"><span><el-icon><FolderOpened /></el-icon></span><div><strong>{{ scope.row.name }}</strong><small>{{ scope.row.description }}</small><code>{{ scope.row.id }}</code></div></div></template></el-table-column>
        <el-table-column label="创建人" min-width="150" prop="creator" />
        <el-table-column label="规模" min-width="180"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.memberCount }} 名成员 · {{ scope.row.sessionCount }} 个 Session</strong><span>{{ scope.row.fileCount }} 个文件 · {{ scope.row.artifactCount }} 个成果</span></div></template></el-table-column>
        <el-table-column label="待对账授权" width="120"><template #default="scope"><span :class="{ 'reconcile-count--attention': workspaceUnresolvedCount(scope.row.id) > 0 }" class="reconcile-count" data-field="unresolved-count">{{ workspaceUnresolvedCount(scope.row.id) }}</span></template></el-table-column>
        <el-table-column prop="updatedAt" label="最近更新" width="120" />
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-workspace" @click.stop="inspect(scope.row)">查看</el-button></template></el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-model:current-page="workspacePage" background layout="prev, pager, next" :total="filteredWorkspaces.length" :page-size="10" /></div>
    </section>

    <!-- 1A-T7 授权来源对账清单（convergence §2 / plan 6.3）：legacy 来源与可能归属 Agent，仅提示不自动回填。 -->
    <section class="content-panel reconcile-panel" data-panel="grant-source-reconciliation">
      <header class="reconcile-panel__header">
        <div>
          <h2>授权来源对账清单</h2>
          <p>升级时无法判断归属的历史授权（<code>legacy_unresolved</code>）。对账完成前，涉及这些来源的 Agent 移出/停用会被拒绝；可能归属仅作提示，不会自动回填。</p>
        </div>
        <span class="filter-bar__meta">{{ unresolvedItems.length }} 条 · {{ unresolvedWorkspaceCount }} 个空间</span>
      </header>
      <el-table class="data-table" :data="pagedUnresolvedItems" empty-text="没有待对账的历史授权来源">
        <el-table-column label="空间" min-width="170"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.workspaceName }}</strong><code>{{ scope.row.workspaceId }}</code></div></template></el-table-column>
        <el-table-column label="能力类型" width="110"><template #default="scope">{{ capabilityTypeLabel(scope.row.capabilityType) }}</template></el-table-column>
        <el-table-column label="能力版本" min-width="200"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.capabilityLabel }}</strong><code>{{ scope.row.capabilityVersionId }}</code></div></template></el-table-column>
        <el-table-column label="可能归属 Agent（仅提示）" min-width="180"><template #default="scope">{{ possibleAgentLabel(scope.row) }}</template></el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="scope">
            <el-button
              v-if="authStore.canManage"
              link
              type="primary"
              :loading="reconcilingSourceId === scope.row.sourceId"
              data-action="reconcile-source"
              @click="reconcileItem(scope.row)"
            >对账完成</el-button>
            <span v-else class="muted">只读</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-model:current-page="reconcilePage" background hide-on-single-page layout="prev, pager, next" :total="unresolvedItems.length" :page-size="10" /></div>
    </section>

    <el-drawer v-model="drawerOpen" size="min(610px, 100vw)" title="工作空间详情">
      <template v-if="selectedWorkspace">
        <div class="workspace-detail__hero"><span><el-icon><FolderOpened /></el-icon></span><div><h2>{{ selectedWorkspace.name }}</h2><p>{{ selectedWorkspace.description }}</p></div></div>
        <dl class="workspace-detail__rows">
          <div><dt>工作空间标识</dt><dd class="mono">{{ selectedWorkspace.id }}</dd></div>
          <div><dt>空间类型</dt><dd>团队工作空间</dd></div>
          <div><dt>创建人</dt><dd>{{ selectedWorkspace.creator }}</dd></div>
          <div><dt>成员数量</dt><dd>{{ selectedWorkspace.memberCount }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ selectedWorkspace.createdAt }}</dd></div>
          <div><dt>Session / 文件</dt><dd>{{ selectedWorkspace.sessionCount }} / {{ selectedWorkspace.fileCount }}</dd></div>
          <div><dt>成果数量</dt><dd>{{ selectedWorkspace.artifactCount }}</dd></div>
          <div><dt>待对账授权来源</dt><dd>{{ workspaceUnresolvedCount(selectedWorkspace.id) }}</dd></div>
        </dl>
        <div v-if="authStore.canManage && workspaceUnresolvedCount(selectedWorkspace.id) > 0" class="workspace-detail__reconcile">
          <el-alert type="warning" :closable="false" show-icon title="该空间存在待对账的历史授权来源，完成对账前不能移除或停用 Agent 成员。" />
          <el-button
            type="primary"
            :loading="reconcilingWorkspaceId === selectedWorkspace.id"
            data-action="reconcile-workspace"
            @click="reconcileWorkspace(selectedWorkspace.id, selectedWorkspace.name)"
          >完成本空间全部对账</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 320px; }
.filter-bar .el-select { width: 155px; }
.workspace-cell { display: flex; min-width: 0; align-items: center; gap: 11px; cursor: pointer; }
.workspace-cell > span,
.workspace-detail__hero > span { display: grid; width: 38px; height: 38px; flex: 0 0 auto; place-items: center; border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-header); }
.workspace-cell > div { display: flex; min-width: 0; flex-direction: column; }
.workspace-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.workspace-cell small { max-width: 390px; margin-top: 3px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.workspace-cell code { margin-top: 3px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.workspace-detail__hero { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.workspace-detail__hero > span { width: 44px; height: 44px; }
.workspace-detail__hero h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.workspace-detail__hero p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.5; }
.workspace-detail__rows { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 22px; margin: 18px 0; }
.workspace-detail__rows div { padding: 11px 0; border-bottom: 1px solid var(--color-border); }
.workspace-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.workspace-detail__rows dd { margin: 5px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); }
.workspace-detail__reconcile { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; margin-top: 16px; }
.reconcile-panel { margin-top: var(--spacing-section); }
.reconcile-panel__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 14px; }
.reconcile-panel__header h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.reconcile-panel__header p { max-width: 720px; margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.6; }
.reconcile-panel__header code { font-family: monospace; }
.reconcile-panel .data-table { border: 1px solid var(--color-border); border-radius: var(--radius-card); overflow: hidden; }
.reconcile-count { display: inline-flex; min-width: 28px; justify-content: center; padding: 2px 7px; border-radius: var(--radius-tag); color: var(--color-text-secondary); background: var(--color-bg-subtle); font-size: var(--font-size-badge); }
.reconcile-count--attention { color: var(--color-warning-strong); background: var(--color-warning-light); font-weight: var(--font-weight-badge); }
@media (max-width: 760px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
