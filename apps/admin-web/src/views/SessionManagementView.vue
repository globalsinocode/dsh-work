<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Search, View } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import { usePagedList } from '@/composables/use-paged-list'
import type { SessionDefinition, SessionListPage } from '@/types/domain'

const router = useRouter()
const query = ref('')
const statusFilter = ref('all')
const workspaceFilter = ref('all')
const selectedSession = ref<SessionDefinition>()
const drawerOpen = ref(false)

const {
  items: sessions,
  total: sessionTotal,
  currentPage: sessionPage,
  pageSize: sessionPageSize,
  loading: sessionsLoading,
  error: sessionsError,
  result: sessionResult,
  reload: reloadSessions,
  changePage: changeSessionPage,
} = usePagedList<SessionDefinition, SessionListPage>({
  fetch: (page, pageSize) => adminApi.getSessions({
    query: query.value,
    status: statusFilter.value,
    workspace: workspaceFilter.value,
    page,
    pageSize,
  }),
})
const workspaces = computed(() => sessionResult.value?.facets.workspaces ?? [])
const summary = computed(() => sessionResult.value?.summary)

function inspect(session: SessionDefinition) {
  selectedSession.value = session
  drawerOpen.value = true
}

function openAudit(session: SessionDefinition) {
  drawerOpen.value = false
  void router.push({ path: '/audit', query: { trace: session.traceId } })
}

function formatTokens(value: number) {
  return value ? value.toLocaleString() : '—'
}

onMounted(() => reloadSessions())
</script>

<template>
  <div class="ops-page session-page">
    <el-alert v-if="sessionsError" :title="sessionsError" type="error" show-icon @close="sessionsError = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索 Session、用户、Agent、运行或链路编号" @keyup.enter="reloadSessions(true)" @clear="reloadSessions(true)" />
        <el-select v-model="workspaceFilter" aria-label="筛选工作空间" @change="reloadSessions(true)"><el-option label="全部工作空间" value="all" /><el-option v-for="workspace in workspaces" :key="workspace.id" :label="workspace.name" :value="workspace.id" /></el-select>
        <el-select v-model="statusFilter" aria-label="筛选 Session 状态" @change="reloadSessions(true)"><el-option label="全部状态" value="all" /><el-option label="排队中" value="queued" /><el-option label="执行中" value="running" /><el-option label="等待确认" value="awaiting_approval" /><el-option label="已完成" value="succeeded" /><el-option label="失败" value="failed" /><el-option label="已停止" value="cancelled" /></el-select>
        <el-button :icon="Search" @click="reloadSessions(true)">查询</el-button>
        <span class="filter-bar__meta">{{ sessionTotal }} 个 Session</span>
      </div>
    </section>

    <el-alert type="info" :closable="false" show-icon title="本页用于运行治理，只展示 Session、用户、工作空间、Agent、Token 和链路等元数据；消息正文需要专项审计授权。" />

    <section v-loading="sessionsLoading" class="metric-grid">
      <article class="metric-card"><div class="metric-label">Session 总数</div><div class="metric-value">{{ summary?.total ?? 0 }}</div><div class="metric-detail">全部治理记录</div></article>
      <article class="metric-card"><div class="metric-label">活动 Session</div><div class="metric-value">{{ summary?.active ?? 0 }}</div><div class="metric-detail">执行中或排队中</div></article>
      <article class="metric-card"><div class="metric-label">等待确认</div><div class="metric-value">{{ summary?.awaitingApproval ?? 0 }}</div><div class="metric-detail">服务端自动确认处理中</div></article>
      <article class="metric-card"><div class="metric-label">失败 Session</div><div class="metric-value">{{ summary?.failed ?? 0 }}</div><div class="metric-detail">需要检查运行或依赖</div></article>
    </section>

    <section class="content-panel content-panel--flush session-table">
      <el-table class="data-table" v-loading="sessionsLoading" :data="sessions" empty-text="暂无匹配的 Session" @row-click="inspect">
        <el-table-column label="Session" min-width="235"><template #default="scope"><div class="session-cell"><strong>{{ scope.row.title }}</strong><small class="mono">{{ scope.row.id }}</small></div></template></el-table-column>
        <el-table-column label="用户与空间" min-width="180"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.user }}</strong><span>{{ scope.row.workspaceName }}</span></div></template></el-table-column>
        <el-table-column label="Agent" min-width="150"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.agentName }}</strong><span>v{{ scope.row.agentVersion }}</span></div></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column label="用量" width="130"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.messageCount }} 条消息</strong><span>{{ formatTokens(scope.row.tokenUsage) }} Token</span></div></template></el-table-column>
        <el-table-column prop="updatedAt" label="最近活动" width="115" />
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-session" @click.stop="inspect(scope.row)">查看</el-button></template></el-table-column>
      </el-table>
      <div class="table-footer session-footer"><span>默认只读，不提供删除 Session 或修改运行结果</span><el-pagination v-model:current-page="sessionPage" background layout="prev, pager, next" :total="sessionTotal" :page-size="sessionPageSize" @current-change="changeSessionPage" /></div>
    </section>

    <el-drawer v-model="drawerOpen" size="min(620px, 100vw)" title="Session 治理详情">
      <template v-if="selectedSession">
        <div class="session-detail__hero"><div><small class="mono">{{ selectedSession.id }}</small><h2>{{ selectedSession.title }}</h2></div><StatusTag :status="selectedSession.status" /></div>
        <dl class="session-detail__rows">
          <div><dt>发起用户</dt><dd>{{ selectedSession.user }}</dd></div>
          <div><dt>工作空间</dt><dd>{{ selectedSession.workspaceName }}</dd></div>
          <div><dt>使用 Agent</dt><dd>{{ selectedSession.agentName }} · v{{ selectedSession.agentVersion }}</dd></div>
          <div><dt>运行编号</dt><dd class="mono">{{ selectedSession.runId }}</dd></div>
          <div><dt>链路编号</dt><dd class="mono">{{ selectedSession.traceId }}</dd></div>
          <div><dt>运行次数</dt><dd>{{ selectedSession.runCount }}</dd></div>
          <div><dt>消息数量</dt><dd>{{ selectedSession.messageCount }}</dd></div>
          <div><dt>Token</dt><dd>{{ formatTokens(selectedSession.tokenUsage) }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ selectedSession.createdAt }}</dd></div>
          <div><dt>最近活动</dt><dd>{{ selectedSession.updatedAt }}</dd></div>
        </dl>
        <el-alert type="info" :closable="false" show-icon title="平台管理员默认不能查看消息正文；需要排障时应通过审计流程获取最小必要信息。" />
        <div class="session-detail__actions"><el-button type="primary" data-action="view-session-audit" @click="openAudit(selectedSession)">查看审计链路</el-button></div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 330px; }
.filter-bar .el-select { width: 155px; }
.session-cell { display: flex; min-width: 0; flex-direction: column; cursor: pointer; }
.session-table :deep(.el-table__header .cell) { white-space: nowrap; }
.session-cell strong,
.stack-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.session-cell small { margin-top: 4px; }
.stack-cell span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.session-footer { margin: 0; padding: 14px 16px; }
.session-footer span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.session-detail__hero { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.session-detail__hero h2 { margin: 4px 0 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.session-detail__hero small { color: var(--color-text-muted); }
.session-detail__rows { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 22px; margin: 18px 0; }
.session-detail__rows div { padding: 11px 0; border-bottom: 1px solid var(--color-border); }
.session-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.session-detail__rows dd { margin: 5px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.55; overflow-wrap: anywhere; }
.session-detail__actions { display: flex; justify-content: flex-end; margin-top: 22px; }
@media (max-width: 760px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
