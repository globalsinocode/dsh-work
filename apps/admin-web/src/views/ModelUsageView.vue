<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Search, View } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import { usePagedList } from '@/composables/use-paged-list'
import type { EmployeeModelUsageSummary, ModelUsagePage, ModelUsageRecord } from '@/types/domain'

const router = useRouter()
const viewMode = ref<'records' | 'employees'>('records')
const query = ref('')
const employeeFilter = ref('all')
const providerFilter = ref('all')
const statusFilter = ref('all')
const selectedRecord = ref<ModelUsageRecord>()
const drawerOpen = ref(false)

function usageInput(page: number, pageSize: number) {
  return {
    query: query.value,
    employee: employeeFilter.value,
    provider: providerFilter.value,
    status: statusFilter.value,
    page,
    pageSize,
  }
}

const recordsList = usePagedList<ModelUsageRecord, ModelUsagePage>({
  fetch: (page, pageSize) => adminApi.getModelUsage(usageInput(page, pageSize)),
})
const employeesList = usePagedList<EmployeeModelUsageSummary>({
  fetch: (page, pageSize) => adminApi.getModelUsageEmployees(usageInput(page, pageSize)),
})
const {
  items: recordItems, total: recordTotal, currentPage: recordPage, pageSize: recordPageSize,
  loading: recordsLoading, error: recordsError, changePage: changeRecordPage,
} = recordsList
const {
  items: employeeItems, total: employeeTotal, currentPage: employeePage, pageSize: employeePageSize,
  loading: employeesLoading, error: employeesError, changePage: changeEmployeePage,
} = employeesList

const summary = computed(() => recordsList.result.value?.summary)
const providers = computed(() => recordsList.result.value?.facets.providers ?? [])
const employees = computed(() => recordsList.result.value?.facets.employees ?? [])
const pageError = computed(() => recordsError.value || employeesError.value)

function applyFilters() {
  void recordsList.reload(true)
  void employeesList.reload(true)
}

function switchView(mode: 'records' | 'employees') {
  viewMode.value = mode
  void (mode === 'records' ? recordsList.reload() : employeesList.reload())
}

function clearError() {
  recordsError.value = ''
  employeesError.value = ''
}

function inspect(record: ModelUsageRecord) {
  selectedRecord.value = record
  drawerOpen.value = true
}

function showEmployeeRecords(employee: EmployeeModelUsageSummary) {
  employeeFilter.value = employee.employeeId
  viewMode.value = 'records'
  applyFilters()
}

function openAudit() {
  if (!selectedRecord.value) return
  drawerOpen.value = false
  void router.push({ path: '/audit', query: { trace: selectedRecord.value.traceId } })
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatLatency(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`
}

function formatRate(value: number) {
  return `${Math.round(value * 100)}%`
}

onMounted(() => {
  void recordsList.reload()
  void employeesList.reload()
})
</script>

<template>
  <div class="ops-page model-usage-page">
    <el-alert v-if="pageError" :title="pageError" type="error" show-icon @close="clearError" />

    <section v-loading="recordsLoading" class="metric-grid">
      <article class="metric-card"><div class="metric-label">模型调用</div><div class="metric-value">{{ summary?.callCount ?? 0 }}</div><div class="metric-detail">涉及 {{ summary?.employeeCount ?? 0 }} 名员工</div></article>
      <article class="metric-card"><div class="metric-label">Token 用量</div><div class="metric-value">{{ formatTokens(summary?.totalTokens ?? 0) }}</div><div class="metric-detail">输入与输出 Token 合计</div></article>
      <article class="metric-card"><div class="metric-label">平均模型延迟</div><div class="metric-value">{{ formatLatency(summary?.averageLatencyMs ?? 0) }}</div><div class="metric-detail">只统计成功调用</div></article>
    </section>

    <section class="content-panel filter-panel usage-filter-panel">
      <div class="status-tabs" role="tablist" aria-label="模型用量查看维度">
        <button class="status-tab" :class="{ active: viewMode === 'records' }" type="button" role="tab" :aria-selected="viewMode === 'records'" @click="switchView('records')">调用明细 <span class="tab-count">{{ recordTotal }}</span></button>
        <button class="status-tab" :class="{ active: viewMode === 'employees' }" type="button" role="tab" :aria-selected="viewMode === 'employees'" @click="switchView('employees')">员工统计 <span class="tab-count">{{ employeeTotal }}</span></button>
      </div>
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索员工、模型、运行或链路编号" @keyup.enter="applyFilters" @clear="applyFilters" />
        <el-select v-model="employeeFilter" class="employee-filter" filterable aria-label="筛选员工" @change="applyFilters">
          <el-option label="全部员工" value="all" />
          <el-option v-for="employee in employees" :key="employee.employeeId" :label="`${employee.employeeName} · ${employee.employeeId}`" :value="employee.employeeId" />
        </el-select>
        <el-select v-model="providerFilter" class="provider-filter" aria-label="筛选模型提供方" @change="applyFilters">
          <el-option label="全部提供方" value="all" />
          <el-option v-for="provider in providers" :key="provider" :label="provider" :value="provider" />
        </el-select>
        <el-select v-model="statusFilter" class="status-filter" aria-label="筛选调用结果" @change="applyFilters">
          <el-option label="全部结果" value="all" />
          <el-option label="成功" value="success" />
          <el-option label="失败" value="failed" />
          <el-option label="已阻止" value="blocked" />
        </el-select>
        <el-button :icon="Search" @click="applyFilters">查询</el-button>
        <span class="filter-bar__meta">{{ recordTotal }} 条调用 · {{ employeeTotal }} 名员工</span>
      </div>
    </section>

    <section class="content-panel content-panel--flush model-usage-table">
      <el-table v-if="viewMode === 'records'" class="data-table" v-loading="recordsLoading" :data="recordItems" empty-text="暂无匹配的模型调用" @row-click="inspect">
        <el-table-column prop="time" label="时间" width="164" />
        <el-table-column label="员工" min-width="170">
          <template #default="scope"><div class="employee-cell"><span>{{ scope.row.employeeName.slice(0, 1) }}</span><div><strong>{{ scope.row.employeeName }}</strong><small>{{ scope.row.employeeId }}</small></div></div></template>
        </el-table-column>
        <el-table-column label="模型" min-width="190">
          <template #default="scope"><div class="model-cell"><strong>{{ scope.row.model }}</strong><small>{{ scope.row.provider }} · {{ scope.row.modelRoute }}</small></div></template>
        </el-table-column>
        <el-table-column label="运行 / Agent" min-width="210">
          <template #default="scope"><div class="stack-cell"><span class="mono">{{ scope.row.runId }}</span><span>{{ scope.row.agentId }}</span></div></template>
        </el-table-column>
        <el-table-column prop="department" label="部门" min-width="125" />
        <el-table-column label="Token" width="110"><template #default="scope">{{ formatTokens(scope.row.totalTokens) }}</template></el-table-column>
        <el-table-column label="延迟" width="95"><template #default="scope">{{ formatLatency(scope.row.latencyMs) }}</template></el-table-column>
        <el-table-column label="结果" width="100"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-model-usage" @click.stop="inspect(scope.row)">详情</el-button></template></el-table-column>
      </el-table>

      <el-table v-else class="data-table" v-loading="employeesLoading" :data="employeeItems" empty-text="当前筛选范围内暂无员工用量" @row-click="showEmployeeRecords">
        <el-table-column label="员工" min-width="210">
          <template #default="scope"><div class="employee-cell"><span>{{ scope.row.employeeName.slice(0, 1) }}</span><div><strong>{{ scope.row.employeeName }}</strong><small>{{ scope.row.employeeId }} · 最近 {{ scope.row.lastUsedAt }}</small></div></div></template>
        </el-table-column>
        <el-table-column prop="department" label="部门" min-width="120" />
        <el-table-column label="调用情况" min-width="180">
          <template #default="scope"><div class="usage-count-cell"><strong>{{ scope.row.callCount }} 次</strong><small>成功 {{ scope.row.successCount }} · 失败 {{ scope.row.failedCount }} · 阻止 {{ scope.row.blockedCount }}</small></div></template>
        </el-table-column>
        <el-table-column label="成功率" width="85"><template #default="scope"><span class="rate-value">{{ formatRate(scope.row.successRate) }}</span></template></el-table-column>
        <el-table-column label="Token 用量" min-width="160">
          <template #default="scope"><div class="token-cell"><strong>{{ formatTokens(scope.row.totalTokens) }}</strong><small>输入 {{ formatTokens(scope.row.promptTokens) }} · 输出 {{ formatTokens(scope.row.completionTokens) }}</small></div></template>
        </el-table-column>
        <el-table-column label="平均延迟" min-width="140"><template #default="scope"><div class="usage-metric-cell"><strong>{{ scope.row.successCount ? formatLatency(scope.row.averageLatencyMs) : '—' }}</strong><small>只统计成功调用</small></div></template></el-table-column>
        <el-table-column label="操作" width="100" fixed="right"><template #default="scope"><el-button link type="primary" data-action="view-employee-model-usage" @click.stop="showEmployeeRecords(scope.row)">查看明细</el-button></template></el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-if="viewMode === 'records'" v-model:current-page="recordPage" background layout="prev, pager, next" :total="recordTotal" :page-size="recordPageSize" @current-change="changeRecordPage" /><el-pagination v-else v-model:current-page="employeePage" background layout="prev, pager, next" :total="employeeTotal" :page-size="employeePageSize" @current-change="changeEmployeePage" /></div>
    </section>

    <el-drawer v-model="drawerOpen" size="min(580px, 100vw)" title="模型调用详情">
      <template v-if="selectedRecord">
        <div class="model-detail__hero">
          <div><small>{{ selectedRecord.provider }}</small><h2>{{ selectedRecord.model }}</h2><p>{{ selectedRecord.modelRoute }}</p></div>
          <StatusTag :status="selectedRecord.status" />
        </div>
        <dl class="model-detail__rows">
          <div><dt>调用时间</dt><dd>{{ selectedRecord.time }}</dd></div>
          <div><dt>员工</dt><dd>{{ selectedRecord.employeeName }}（{{ selectedRecord.employeeId }}）</dd></div>
          <div><dt>运行</dt><dd class="mono">{{ selectedRecord.runId }}</dd></div>
          <div><dt>Agent</dt><dd class="mono">{{ selectedRecord.agentId }}</dd></div>
          <div><dt>部门</dt><dd>{{ selectedRecord.department }}</dd></div>
          <div><dt>输入 Token</dt><dd>{{ formatTokens(selectedRecord.promptTokens) }}</dd></div>
          <div><dt>输出 Token</dt><dd>{{ formatTokens(selectedRecord.completionTokens) }}</dd></div>
          <div><dt>总 Token</dt><dd>{{ formatTokens(selectedRecord.totalTokens) }}</dd></div>
          <div><dt>模型延迟</dt><dd>{{ formatLatency(selectedRecord.latencyMs) }}</dd></div>
          <div><dt>链路编号</dt><dd class="mono">{{ selectedRecord.traceId }}</dd></div>
        </dl>
        <el-alert type="info" :closable="false" show-icon title="模型未返回精确计量时，Token 由服务端按文本长度估算。" />
        <div class="model-detail__footer"><el-button type="primary" @click="openAudit">查看关联审计</el-button></div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.usage-filter-panel { gap: 0; }
.usage-filter-panel .filter-bar { padding-top: 10px; }
.filter-bar .el-input { width: 300px; }
.filter-bar .el-select { width: 150px; }
.filter-bar .employee-filter { width: 200px; }
.filter-bar .provider-filter { width: 170px; }
.filter-bar .status-filter { width: 140px; }
.employee-cell { display: flex; min-width: 0; align-items: center; gap: 10px; cursor: pointer; }
.employee-cell > span { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border-radius: 50%; color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); font-weight: var(--font-weight-title); }
.employee-cell div, .usage-count-cell, .token-cell, .usage-metric-cell { display: flex; min-width: 0; flex-direction: column; }
.employee-cell strong, .usage-count-cell strong, .token-cell strong, .usage-metric-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.employee-cell small, .usage-count-cell small, .token-cell small, .usage-metric-cell small { margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.model-cell { display: flex; min-width: 0; flex-direction: column; cursor: pointer; }
.model-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.model-cell small { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.rate-value { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
.model-detail__hero { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.model-detail__hero small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.model-detail__hero h2 { margin: 4px 0 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.model-detail__hero p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.model-detail__rows { margin: 16px 0; }
.model-detail__rows div { display: grid; grid-template-columns: 120px 1fr; gap: 14px; padding: 10px 2px; border-bottom: 1px solid var(--color-border); }
.model-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.model-detail__rows dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); }
.model-detail__footer { margin-top: 18px; text-align: right; }
@media (max-width: 720px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
