<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, Search, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useRoute } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import { usePagedList } from '@/composables/use-paged-list'
import { useContentStore } from '@/stores/content'
import type { AuditEvent } from '@/types/domain'

const contentStore = useContentStore()
const route = useRoute()
const query = ref('')
const statusFilter = ref('all')
const categoryFilter = ref('all')
const selectedEvent = ref<AuditEvent>()
const relatedEvents = ref<AuditEvent[]>([])
const relatedLoading = ref(false)
const drawerOpen = ref(false)

const {
  items: events,
  total: eventTotal,
  currentPage,
  pageSize,
  loading: eventsLoading,
  error: eventsError,
  reload: reloadEvents,
  changePage: changeEventPage,
} = usePagedList<AuditEvent>({
  fetch: (page, pageSize) => adminApi.getAuditEvents({
    query: query.value,
    status: statusFilter.value,
    category: categoryFilter.value,
    page,
    pageSize,
  }),
})

const summary = computed(() => contentStore.operationsSummary)

const categoryLabels: Record<AuditEvent['category'], string> = {
  management: '管理操作',
  security: '安全授权',
  run: '运行事件',
  model: '模型调用',
  tool: '工具调用',
  artifact: '成果事件',
}

const objectTypeLabels: Record<string, string> = {
  agent: 'Agent', skill: 'Skill', tool: '工具', connector: '连接器', runtime: '运行时',
  run: '运行', model: '模型', artifact: '成果', authorization: '授权',
  model_governance: '模型治理', workspace: '工作空间', platform: '平台',
}

const actionLabels: Record<string, string> = {
  'run.create': '创建运行', 'run.queued': '运行排队', 'run.started': '开始运行',
  'run.completed': '完成运行', 'run.failed': '运行失败', 'run.cancel_requested': '请求取消',
  'run.cancel.request': '请求取消运行', 'run.cancelled': '运行已取消', 'run.retry': '重试运行',
  'assistant.delta': '回答生成中', 'assistant.completed': '生成回答', 'attempt.started': '执行尝试开始',
  'approval.required': '请求工具授权', 'approval.resolved': '完成工具授权',
  'model.invoke': '模型调用', 'tool.permission.resolve': '工具权限决策', 'artifact.version.created': '生成成果版本',
  'runtime.health.check': '检查运行时', 'runtime.configuration.update': '更新运行时配置',
  'authorization.runtime': '运行授权', 'authorization.workbench': '工作台授权',
  'agent.create': '创建 Agent', 'agent.draft.update': '更新 Agent 草稿', 'agent.test': '测试 Agent',
  'agent.publish': '发布 Agent', 'agent.enable': '启用 Agent', 'agent.disable': '停用 Agent', 'agent.rollback': '回滚 Agent',
  'skill.create': '创建 Skill', 'skill.draft.update': '更新 Skill 草稿', 'skill.test': '测试 Skill',
  'skill.publish': '发布 Skill', 'skill.enable': '启用 Skill', 'skill.disable': '停用 Skill', 'skill.rollback': '回滚 Skill',
  'tool.create': '添加工具', 'tool.catalog.sync': '同步 DSH 工具目录', 'tool.permissions.update': '更新工具权限', 'connector.health.check': '检查连接器',
  'model_provider.create': '创建模型服务商', 'model_provider.credential_ref.update': '更新密钥引用',
  'provider_model.create': '注册模型', 'model_route.create': '创建模型路由',
  'agent.configuration.update': '更新 Agent 配置',
}

function categoryLabel(category: AuditEvent['category']) {
  return categoryLabels[category]
}

function actionLabel(action: string) {
  if (actionLabels[action]) return actionLabels[action]
  const [prefix, ...rest] = action.split('.')
  const prefixLabel = objectTypeLabels[prefix ?? ''] ?? prefix
  return `${prefixLabel} · ${rest.join('.') || '操作'}`
}

function objectLabel(event: AuditEvent) {
  return `${objectTypeLabels[event.objectType] ?? event.objectType} · ${event.objectId}`
}

function formattedDetail(event: AuditEvent) {
  try {
    return JSON.stringify(JSON.parse(event.detail), null, 2)
  } catch {
    return event.detail
  }
}

async function inspect(event: AuditEvent) {
  selectedEvent.value = event
  relatedEvents.value = []
  drawerOpen.value = true
  if (!event.runId) return
  relatedLoading.value = true
  try {
    relatedEvents.value = await adminApi.getRunOperations(event.runId)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '运行链路加载失败')
  } finally {
    relatedLoading.value = false
  }
}

async function exportAudit() {
  const all: AuditEvent[] = []
  let page = 1
  for (;;) {
    const result = await adminApi.getAuditEvents({
      query: query.value,
      status: statusFilter.value,
      category: categoryFilter.value,
      page,
      pageSize: 500,
    })
    all.push(...result.items)
    if (!result.items.length || all.length >= result.total) break
    page += 1
  }
  const content = JSON.stringify(all, null, 2)
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `dsh-work-运营事件-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
  ElMessage.success(`已导出 ${all.length} 条脱敏运营事件`)
}

onMounted(() => {
  if (typeof route.query.trace === 'string') query.value = route.query.trace
  void contentStore.load()
  void reloadEvents()
})
</script>

<template>
  <div class="ops-page audit-page">
    <el-alert v-if="eventsError || contentStore.error" :title="eventsError || contentStore.error" type="error" show-icon @close="eventsError = ''; contentStore.error = ''" />

    <section v-loading="contentStore.loading" class="metric-grid audit-metrics">
      <article class="metric-card"><div class="metric-label">近 24 小时运行</div><div class="metric-value">{{ summary?.runs24h ?? 0 }}</div><div class="metric-detail">成功 {{ summary?.successfulRuns24h ?? 0 }} · 失败 {{ summary?.failedRuns24h ?? 0 }}</div></article>
      <article class="metric-card"><div class="metric-label">模型 Token</div><div class="metric-value">{{ (summary?.modelTokens24h ?? 0).toLocaleString() }}</div><div class="metric-detail">仅记录用量，不记录提示词正文</div></article>
      <article class="metric-card"><div class="metric-label">工具与成果</div><div class="metric-value">{{ (summary?.toolCalls24h ?? 0) + (summary?.artifacts24h ?? 0) }}</div><div class="metric-detail">工具 {{ summary?.toolCalls24h ?? 0 }} · 成果 {{ summary?.artifacts24h ?? 0 }}</div></article>
      <article class="metric-card"><div class="metric-label">需关注事件</div><div class="metric-value is-attention">{{ summary?.attentionEvents24h ?? 0 }}</div><div class="metric-detail">失败与已阻止事件</div></article>
    </section>

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索用户、对象、运行、链路编号或摘要" @keyup.enter="reloadEvents(true)" @clear="reloadEvents(true)" />
        <el-select v-model="categoryFilter" aria-label="筛选运营事件类型" @change="reloadEvents(true)"><el-option label="全部类型" value="all" /><el-option v-for="(label, value) in categoryLabels" :key="value" :label="label" :value="value" /></el-select>
        <el-select v-model="statusFilter" aria-label="筛选审计结果" @change="reloadEvents(true)"><el-option label="全部结果" value="all" /><el-option label="成功" value="success" /><el-option label="失败" value="failed" /><el-option label="已阻止" value="blocked" /></el-select>
        <el-button :icon="Search" @click="reloadEvents(true)">查询</el-button>
        <span class="filter-bar__meta">{{ eventTotal }} 条事件</span>
        <el-button :icon="Download" :disabled="!eventTotal" @click="exportAudit">导出当前结果</el-button>
      </div>
    </section>

    <section class="content-panel content-panel--flush audit-panel">
      <el-table class="data-table" v-loading="eventsLoading" :data="events" empty-text="没有匹配的审计记录" @row-click="inspect">
        <el-table-column prop="time" label="时间" width="164" />
        <el-table-column label="类型" width="115"><template #default="scope"><el-tag effect="plain" size="small">{{ categoryLabel(scope.row.category) }}</el-tag></template></el-table-column>
        <el-table-column label="操作者" min-width="150"><template #default="scope"><div class="actor-cell"><strong>{{ scope.row.actor }}</strong><small>{{ scope.row.department }}</small></div></template></el-table-column>
        <el-table-column label="事件" min-width="145"><template #default="scope">{{ actionLabel(scope.row.action) }}</template></el-table-column>
        <el-table-column label="对象" min-width="250"><template #default="scope"><span class="object-cell mono">{{ objectLabel(scope.row) }}</span></template></el-table-column>
        <el-table-column label="结果" width="105"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column label="链路编号" min-width="150"><template #default="scope"><code>{{ scope.row.traceId }}</code></template></el-table-column>
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-audit" @click.stop="inspect(scope.row)">详情</el-button></template></el-table-column>
      </el-table>
      <div class="table-footer audit-footer"><span>审计数据默认只读，管理端不提供删除能力</span><el-pagination v-model:current-page="currentPage" background layout="prev, pager, next" :total="eventTotal" :page-size="pageSize" @current-change="changeEventPage" /></div>
    </section>

    <el-drawer v-model="drawerOpen" size="min(570px, 100vw)" title="审计事件详情">
      <template v-if="selectedEvent">
        <div class="audit-detail__hero"><span :class="`is-${selectedEvent.status}`"></span><div><small>{{ categoryLabel(selectedEvent.category) }} · {{ actionLabel(selectedEvent.action) }}</small><h2>{{ objectLabel(selectedEvent) }}</h2></div><StatusTag :status="selectedEvent.status" /></div>
        <dl class="audit-detail__rows">
          <div><dt>发生时间</dt><dd>{{ selectedEvent.time }}</dd></div>
          <div><dt>操作者</dt><dd>{{ selectedEvent.actor }} · {{ selectedEvent.department }}</dd></div>
          <div><dt>链路编号</dt><dd class="mono">{{ selectedEvent.traceId }}</dd></div>
          <div><dt>事件对象</dt><dd class="mono">{{ objectLabel(selectedEvent) }}</dd></div>
          <div v-if="selectedEvent.runId"><dt>运行编号</dt><dd class="mono">{{ selectedEvent.runId }}</dd></div>
          <div v-if="selectedEvent.attemptId"><dt>执行尝试编号</dt><dd class="mono">{{ selectedEvent.attemptId }}</dd></div>
          <div class="audit-detail__wide"><dt>脱敏摘要</dt><dd><pre>{{ formattedDetail(selectedEvent) }}</pre></dd></div>
        </dl>
        <el-alert type="info" :closable="false" show-icon title="身份上下文、授权结果和业务对象标识由后端记录；模型无法修改这些字段。" />
        <template v-if="selectedEvent.runId">
          <el-divider content-position="left">同一运行链路</el-divider>
          <div v-loading="relatedLoading" class="related-events">
            <article v-for="event in relatedEvents" :key="`${event.category}-${event.id}`">
              <span :class="`is-${event.status}`"></span>
              <div><strong>{{ actionLabel(event.action) }}</strong><small>{{ event.time }} · {{ categoryLabel(event.category) }}</small></div>
              <StatusTag :status="event.status" />
            </article>
            <el-empty v-if="!relatedLoading && !relatedEvents.length" :image-size="64" description="暂无关联事件" />
          </div>
        </template>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 300px; }
.filter-bar .el-select { width: 145px; }
.actor-cell { display: flex; flex-direction: column; }
.actor-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.actor-cell small { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.object-cell { display: block; overflow: hidden; color: var(--color-text-primary); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.audit-panel code { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.audit-footer { margin: 0; padding: 14px 16px; }
.audit-footer span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.audit-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.metric-value.is-attention { color: var(--color-danger-strong); }
.audit-detail__hero { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.audit-detail__hero > span { width: 8px; height: 36px; border-radius: 4px; background: var(--color-success); }
.audit-detail__hero > span.is-failed { background: var(--color-danger); }
.audit-detail__hero > span.is-blocked { background: var(--color-warning); }
.audit-detail__hero small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.audit-detail__hero h2 { margin: 4px 0 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.audit-detail__rows { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 22px; margin: 18px 0; }
.audit-detail__rows div { padding: 11px 0; border-bottom: 1px solid var(--color-border); }
.audit-detail__wide { grid-column: 1 / -1; }
.audit-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.audit-detail__rows dd { margin: 5px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.6; }
.audit-detail__rows pre { overflow-wrap: anywhere; margin: 0; white-space: pre-wrap; }
.related-events { min-height: 80px; }
.related-events article { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 2px; border-bottom: 1px solid var(--color-border); }
.related-events article > span { width: 7px; height: 7px; border-radius: 50%; background: var(--color-success); }
.related-events article > span.is-failed { background: var(--color-danger); }
.related-events article > span.is-blocked { background: var(--color-warning); }
.related-events article div { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.related-events strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.related-events small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
@media (max-width: 1080px) { .audit-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } .audit-metrics { grid-template-columns: 1fr; } }
</style>
