<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { View } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'

import { adminApi } from '@/api/client'
import type {
  ModelUsageBreakdownRow,
  ModelUsageDimension,
  ModelUsageExecution,
  ModelUsageFilter,
  ModelUsageOverview,
  ModelUsageRange,
  RunSource,
} from '@/types/domain'

type ViewMode = ModelUsageDimension | 'executions'
/** 与服务端一致：按维度统计最多返回 200 项。 */
const BREAKDOWN_LIMIT = 200

const router = useRouter()
const range = ref<ModelUsageRange>('7d')
const modelFilter = ref('')
const sourceFilter = ref('')
type DrillDimension = 'agent' | 'employee' | 'department'
/** 从统计表下钻带出的条件（Agent、员工、部门可同时存在）；模型与来源直接写入上方筛选。 */
const drills = ref<Partial<Record<DrillDimension, { key: string; label: string }>>>({})
const drillList = computed(() => (Object.entries(drills.value) as Array<[DrillDimension, { key: string; label: string }]>)
  .map(([dimension, item]) => ({ dimension, ...item })))
/** 请求序号：快速切换筛选时只采用最新一次请求的结果。 */
let overviewRequest = 0
let tableRequest = 0
const viewMode = ref<ViewMode>('model')
const overview = ref<ModelUsageOverview>()
const breakdown = ref<ModelUsageBreakdownRow[]>([])
const executions = ref<ModelUsageExecution[]>([])
const executionTotal = ref(0)
const executionPage = ref(1)
const executionPageSize = 20
const loading = reactive({ overview: false, table: false })
const error = ref('')
const selected = ref<ModelUsageExecution>()
const drawerOpen = ref(false)

const rangeOptions: Array<{ value: ModelUsageRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
]
const sourceLabels: Record<RunSource, string> = {
  conversation: '员工对话',
  automation: '定时任务',
  routine: '主动任务',
  validation: '发布试运行',
  api: 'API 调用',
  event: '事件触发',
  delegation: '委派',
  system: '系统',
}
const dimensionTabs: Array<{ value: ViewMode; label: string }> = [
  { value: 'model', label: '按模型' },
  { value: 'agent', label: '按 Agent' },
  { value: 'employee', label: '按员工' },
  { value: 'department', label: '按部门' },
  { value: 'source', label: '按来源' },
  { value: 'executions', label: '执行明细' },
]
const dimensionLabels: Record<ModelUsageDimension, string> = { model: '模型', agent: 'Agent', employee: '员工', department: '部门', source: '来源' }
const palette = Array.from({ length: 7 }, (_, index) => `var(--color-chart-${index + 1})`)

const filter = computed<ModelUsageFilter>(() => ({
  range: range.value,
  ...(modelFilter.value ? { model: modelFilter.value } : {}),
  ...(sourceFilter.value ? { source: sourceFilter.value } : {}),
  ...Object.fromEntries(drillList.value.map(item => [item.dimension, item.key])),
}))
const totals = computed(() => overview.value?.totals)
/** 已选的模型即使在新范围里没有用量，也保留在选项中。 */
const models = computed(() => {
  const list = overview.value?.facets.models ?? []
  return modelFilter.value && !list.includes(modelFilter.value) ? [modelFilter.value, ...list] : list
})
const sources = computed(() => overview.value?.facets.sources ?? [])
/**
 * 颜色按首次看到时的用量从高到低分配（主力模型用第一种颜色），之后切换筛选不再变动，
 * 新出现的模型依次追加，保证同一模型在本页始终同色。
 */
const colorOrder = ref<string[]>([])
function rememberModelColors(data: ModelUsageOverview) {
  const totalsByModel = new Map<string, number>()
  for (const bucket of data.trend) {
    for (const item of bucket.models) totalsByModel.set(item.model, (totalsByModel.get(item.model) ?? 0) + item.tokens)
  }
  const ranked = [...totalsByModel.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([model]) => model)
  colorOrder.value = [...colorOrder.value, ...ranked.filter(model => !colorOrder.value.includes(model))]
}
const modelColor = (model: string) => palette[Math.max(0, colorOrder.value.indexOf(model)) % palette.length]
const estimatedShare = computed(() => totals.value && totals.value.totalTokens > 0 ? totals.value.estimatedTokens / totals.value.totalTokens : 0)
const rangeNote = computed(() => {
  if (!overview.value) return ''
  return overview.value.from === overview.value.to ? `统计范围：${overview.value.to}（今天）` : `统计范围：${overview.value.from} 至 ${overview.value.to}`
})
const trendModels = computed(() => {
  const present = new Set(overview.value?.trend.flatMap(bucket => bucket.models.map(item => item.model)) ?? [])
  return colorOrder.value.filter(model => present.has(model))
})
const trendBars = computed(() => {
  const trend = overview.value?.trend ?? []
  const peak = Math.max(1, ...trend.map(bucket => bucket.models.reduce((total, item) => total + item.tokens, 0)))
  return trend.map(bucket => {
    const total = bucket.models.reduce((sum, item) => sum + item.tokens, 0)
    const segments = bucket.models.flatMap(item => {
      const exact = item.tokens - item.estimatedTokens
      return [
        ...(exact > 0 ? [{ key: `${item.model}-exact`, height: (exact / peak) * 100, color: modelColor(item.model), estimated: false }] : []),
        ...(item.estimatedTokens > 0 ? [{ key: `${item.model}-estimated`, height: (item.estimatedTokens / peak) * 100, color: modelColor(item.model), estimated: true }] : []),
      ]
    })
    return { bucket: bucket.bucket, label: bucket.label, total, segments: segments.reverse() }
  })
})
const peakBucket = computed(() => trendBars.value.reduce((best, bar) => bar.total > best.total ? bar : best, { label: '', total: 0 }))

async function loadOverview() {
  const request = ++overviewRequest
  loading.overview = true
  try {
    const data = await adminApi.getModelUsageOverview(filter.value)
    if (request !== overviewRequest) return
    rememberModelColors(data)
    overview.value = data
  } catch (cause) {
    if (request === overviewRequest) error.value = cause instanceof Error ? cause.message : '模型用量加载失败'
  } finally {
    if (request === overviewRequest) loading.overview = false
  }
}

async function loadTable() {
  const request = ++tableRequest
  const mode = viewMode.value
  loading.table = true
  try {
    if (mode === 'executions') {
      const page = await adminApi.getModelUsageExecutions(filter.value, executionPage.value, executionPageSize)
      if (request !== tableRequest) return
      executions.value = page.items
      executionTotal.value = page.total
    } else {
      const rows = await adminApi.getModelUsageBreakdown(filter.value, mode)
      if (request !== tableRequest) return
      breakdown.value = rows
    }
  } catch (cause) {
    if (request === tableRequest) error.value = cause instanceof Error ? cause.message : '模型用量加载失败'
  } finally {
    if (request === tableRequest) loading.table = false
  }
}

function reload() {
  error.value = ''
  executionPage.value = 1
  void loadOverview()
  void loadTable()
}

function switchView(mode: ViewMode) {
  viewMode.value = mode
  executionPage.value = 1
  void loadTable()
}

function changeExecutionPage(page: number) {
  executionPage.value = page
  void loadTable()
}

/** 点统计行：带着该条件看执行明细。 */
function drillInto(row: ModelUsageBreakdownRow) {
  const dimension = viewMode.value
  if (dimension === 'model') modelFilter.value = row.key
  else if (dimension === 'source') sourceFilter.value = row.key
  else if (dimension === 'agent' || dimension === 'employee' || dimension === 'department') {
    drills.value = { ...drills.value, [dimension]: { key: row.key, label: `${dimensionLabels[dimension]}：${row.label}` } }
  }
  viewMode.value = 'executions'
  reload()
}

function clearDrill(dimension: DrillDimension) {
  const next = { ...drills.value }
  delete next[dimension]
  drills.value = next
  reload()
}

function rowLabel(row: ModelUsageBreakdownRow) {
  return viewMode.value === 'source' ? sourceLabels[row.key as RunSource] ?? row.label : row.label
}

function inspect(row: ModelUsageExecution) {
  selected.value = row
  drawerOpen.value = true
}

function openAudit() {
  if (!selected.value) return
  drawerOpen.value = false
  void router.push({ path: '/audit', query: { trace: selected.value.traceId } })
}

const numberFormat = new Intl.NumberFormat('zh-CN')
function tokens(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : numberFormat.format(Math.round(value))
}
function compact(value: number) {
  return value >= 10_000 ? `${(value / 10_000).toFixed(1)} 万` : numberFormat.format(Math.round(value))
}
function percent(part: number, whole: number) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—'
}
function hitRate(row: { cacheReadTokens: number; cacheInputTokens: number }) {
  return row.cacheInputTokens > 0 ? percent(row.cacheReadTokens, row.cacheInputTokens) : '未返回'
}
function duration(ms: number) {
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒` : `${Math.round(ms / 1000)} 秒`
}
function requestText(row: ModelUsageExecution) {
  if (row.requests === null) return '—'
  const count = row.requests + (row.search?.requests ?? 0)
  return row.failedRequests ? `${count} 次（失败 ${row.failedRequests}）` : `${count} 次`
}
function statusLabel(status: ModelUsageExecution['status']) {
  return { success: '成功', failed: '失败', blocked: '已阻止', cancelled: '已取消' }[status]
}
function statusType(status: ModelUsageExecution['status']) {
  return ({ success: 'success', failed: 'danger', blocked: 'warning', cancelled: 'info' } as const)[status]
}
function measurementLabel(row: ModelUsageExecution) {
  return { gateway: '网关计量', 'session-log': '会话日志', estimated: '估算' }[row.measurement]
}

onMounted(reload)
</script>

<template>
  <div class="ops-page model-usage-page">
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />

    <section class="content-panel usage-filters" aria-label="筛选">
      <el-radio-group v-model="range" aria-label="时间范围" @change="reload">
        <el-radio-button v-for="option in rangeOptions" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
      </el-radio-group>
      <el-select v-model="modelFilter" class="usage-filters__select" clearable placeholder="全部模型" aria-label="筛选模型" @change="reload">
        <el-option v-for="model in models" :key="model" :label="model" :value="model" />
      </el-select>
      <el-select v-model="sourceFilter" class="usage-filters__select" clearable placeholder="全部来源" aria-label="筛选来源" @change="reload">
        <el-option v-for="source in sources" :key="source" :label="sourceLabels[source]" :value="source" />
      </el-select>
      <el-tag
        v-for="item in drillList"
        :key="item.dimension"
        closable
        type="primary"
        effect="light"
        data-testid="usage-drill"
        @close="clearDrill(item.dimension)"
      >{{ item.label }}</el-tag>
      <span class="usage-filters__note">{{ rangeNote }}</span>
    </section>

    <section v-loading="loading.overview" class="content-panel overview-strip" aria-label="用量概况">
      <dl class="overview-strip__stats">
        <div class="overview-stat"><dt>Token 合计</dt><dd><strong class="overview-stat__value">{{ compact(totals?.totalTokens ?? 0) }}</strong><small>输入 {{ compact(totals?.inputTokens ?? 0) }} · 输出 {{ compact(totals?.outputTokens ?? 0) }}</small></dd></div>
        <div class="overview-stat"><dt>缓存命中率</dt><dd><strong class="overview-stat__value">{{ totals && totals.cacheInputTokens > 0 ? percent(totals.cacheReadTokens, totals.cacheInputTokens) : '—' }}</strong><small title="按厂商返回了缓存数据的请求计算">缓存读取 {{ compact(totals?.cacheReadTokens ?? 0) }}</small></dd></div>
        <div class="overview-stat"><dt>模型请求</dt><dd><strong class="overview-stat__value">{{ totals?.requestsKnown ? tokens(totals.requests) : '—' }}</strong><small>{{ totals?.requestsKnown ? `失败率 ${percent(totals.failedRequests, totals.requests)} · 含重试` : '估算数据没有请求次数' }}</small></dd></div>
        <div class="overview-stat"><dt>执行次数</dt><dd><strong class="overview-stat__value">{{ tokens(totals?.executions ?? 0) }}</strong><small>失败 {{ totals?.failedExecutions ?? 0 }} · 涉及 {{ totals?.employees ?? 0 }} 名员工</small></dd></div>
      </dl>
    </section>

    <el-alert
      v-if="totals && totals.estimatedTokens > 0"
      class="usage-estimated-note"
      type="warning"
      :closable="false"
      show-icon
      :title="`当前范围含 ${percent(totals.estimatedTokens, totals.totalTokens)} 估算数据（模型网关上线前，按文本长度估算），总量仅供参考`"
      description="趋势图中的斜纹柱和明细中的“估算”标签即为这部分。"
    />

    <section v-loading="loading.overview" class="content-panel usage-trend" aria-label="用量趋势">
      <header class="usage-trend__head">
        <h2>Token 趋势（{{ overview?.granularity === 'hour' ? '按小时' : '按天' }}，按模型堆叠）</h2>
        <ul class="usage-trend__legend">
          <li v-for="model in trendModels" :key="model"><span :style="{ background: modelColor(model) }" />{{ model }}</li>
          <li v-if="estimatedShare > 0"><span class="usage-trend__swatch--estimated" />估算</li>
        </ul>
      </header>
      <div class="usage-trend__chart" role="img" :aria-label="`Token 趋势图，共 ${trendBars.length} 个时间段，峰值 ${peakBucket.label} ${tokens(peakBucket.total)} Token`">
        <div v-for="bar in trendBars" :key="bar.bucket" class="usage-trend__bar" :title="`${bar.label}：${tokens(bar.total)} Token`">
          <div
            v-for="segment in bar.segments"
            :key="segment.key"
            class="usage-trend__segment"
            :class="{ 'usage-trend__segment--estimated': segment.estimated }"
            :style="{ height: `${Math.max(segment.height, 1)}%`, '--segment-color': segment.color }"
          />
        </div>
      </div>
      <div class="usage-trend__labels" aria-hidden="true">
        <span v-for="bar in trendBars" :key="bar.bucket">{{ bar.label }}</span>
      </div>
    </section>

    <section class="content-panel content-panel--flush" aria-label="统计">
      <div class="status-tabs usage-tabs" role="tablist" aria-label="统计维度">
        <button
          v-for="tab in dimensionTabs"
          :key="tab.value"
          class="status-tab"
          :class="{ active: viewMode === tab.value }"
          type="button"
          role="tab"
          :aria-selected="viewMode === tab.value"
          @click="switchView(tab.value)"
        >{{ tab.label }}<span v-if="tab.value === 'executions'" class="tab-count">{{ totals?.executions ?? 0 }}</span></button>
      </div>

      <template v-if="viewMode !== 'executions'">
        <p class="usage-hint">点击名称，带着该条件查看执行明细。<template v-if="breakdown.length >= BREAKDOWN_LIMIT">只显示用量最高的 {{ BREAKDOWN_LIMIT }} 项，可先用上方条件缩小范围。</template></p>
        <el-table v-loading="loading.table" class="data-table" :data="breakdown" empty-text="当前筛选范围内没有用量">
          <el-table-column :label="dimensionLabels[viewMode]" min-width="200">
            <template #default="scope">
              <div class="stack-cell">
                <el-button link type="primary" class="usage-drill-link" @click="drillInto(scope.row)">{{ rowLabel(scope.row) }}</el-button>
                <small v-if="scope.row.sub">{{ scope.row.sub }}</small>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="Token 合计" min-width="200">
            <template #default="scope">
              <div class="usage-token-cell">
                <strong>{{ tokens(scope.row.totalTokens) }}</strong>
                <el-tooltip v-if="scope.row.estimatedTokens > 0" :content="`其中 ${percent(scope.row.estimatedTokens, scope.row.totalTokens)} 为估算（模型网关上线前）`">
                  <el-tag size="small" type="warning" effect="light">含估算</el-tag>
                </el-tooltip>
              </div>
              <div class="usage-share"><span :style="{ width: `${Math.max(2, (scope.row.totalTokens / Math.max(1, breakdown[0]?.totalTokens ?? 1)) * 100)}%` }" /></div>
            </template>
          </el-table-column>
          <el-table-column label="输入 / 输出" min-width="150"><template #default="scope">{{ compact(scope.row.inputTokens) }} / {{ compact(scope.row.outputTokens) }}</template></el-table-column>
          <el-table-column label="缓存命中率" width="120"><template #default="scope">{{ hitRate(scope.row) }}</template></el-table-column>
          <el-table-column label="模型请求" min-width="130">
            <template #default="scope">
              <div class="stack-cell"><span>{{ scope.row.requestsKnown ? `${tokens(scope.row.requests)} 次` : '—' }}</span><small>{{ scope.row.requestsKnown ? `失败率 ${percent(scope.row.failedRequests, scope.row.requests)}` : '估算数据无请求次数' }}</small></div>
            </template>
          </el-table-column>
          <el-table-column label="执行次数" width="110"><template #default="scope">{{ tokens(scope.row.executions) }}</template></el-table-column>
        </el-table>
      </template>

      <template v-else>
        <el-table v-loading="loading.table" class="data-table" :data="executions" empty-text="当前筛选范围内没有执行记录" @row-click="inspect">
          <el-table-column prop="time" label="时间" width="120" />
          <el-table-column label="来源 / Agent" min-width="160"><template #default="scope"><div class="stack-cell"><span>{{ scope.row.agentName }}</span><small>{{ sourceLabels[scope.row.source as RunSource] }}</small></div></template></el-table-column>
          <el-table-column label="员工 / 部门" min-width="140"><template #default="scope"><div class="stack-cell"><span>{{ scope.row.employeeName }}</span><small>{{ scope.row.department }}</small></div></template></el-table-column>
          <el-table-column label="实际模型" min-width="190"><template #default="scope"><div class="stack-cell"><span class="mono">{{ scope.row.model }}</span><small>{{ scope.row.routeName }}{{ scope.row.search ? ' · 含联网搜索' : '' }}</small></div></template></el-table-column>
          <el-table-column label="Token" min-width="120">
            <template #default="scope"><div class="stack-cell"><span>{{ tokens(scope.row.totalTokens) }}</span><el-tag size="small" :type="scope.row.measurement === 'estimated' ? 'warning' : 'primary'" effect="light" class="usage-measure">{{ measurementLabel(scope.row) }}</el-tag></div></template>
          </el-table-column>
          <el-table-column label="模型请求" width="120"><template #default="scope">{{ requestText(scope.row) }}</template></el-table-column>
          <el-table-column label="结果" width="90"><template #default="scope"><el-tag :type="statusType(scope.row.status)" effect="light">{{ statusLabel(scope.row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="耗时" width="100"><template #default="scope">{{ duration(scope.row.durationMs) }}</template></el-table-column>
          <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" :aria-label="`查看 ${scope.row.time} ${scope.row.agentName} 的用量详情`" data-action="view-model-usage" @click.stop="inspect(scope.row)">详情</el-button></template></el-table-column>
        </el-table>
        <div class="table-footer table-footer--pager">
          <el-pagination v-model:current-page="executionPage" background layout="prev, pager, next" :total="executionTotal" :page-size="executionPageSize" @current-change="changeExecutionPage" />
        </div>
      </template>
    </section>

    <el-drawer v-model="drawerOpen" size="min(560px, 100vw)" title="执行用量详情">
      <template v-if="selected">
        <div class="usage-detail__hero">
          <div>
            <small>{{ selected.providerName }} · {{ selected.routeName }}</small>
            <h2 class="mono">{{ selected.model }}</h2>
            <p>{{ selected.time }} · {{ sourceLabels[selected.source] }} · {{ selected.agentName }}</p>
          </div>
          <div class="usage-detail__tags">
            <el-tag :type="statusType(selected.status)" effect="light">{{ statusLabel(selected.status) }}</el-tag>
            <el-tag :type="selected.measurement === 'estimated' ? 'warning' : 'primary'" effect="light">{{ measurementLabel(selected) }}</el-tag>
          </div>
        </div>
        <dl class="usage-detail__grid">
          <div><dt>输入</dt><dd>{{ tokens(selected.inputTokens) }}</dd></div>
          <div><dt>其中缓存读取</dt><dd>{{ selected.cacheReadTokens === null ? (selected.measurement === 'gateway' ? '未返回' : '未知') : tokens(selected.cacheReadTokens) }}</dd><small v-if="selected.cacheReadTokens !== null && selected.inputTokens > 0">命中率 {{ percent(selected.cacheReadTokens, selected.inputTokens) }}</small></div>
          <div><dt>输出</dt><dd>{{ tokens(selected.outputTokens) }}</dd></div>
          <div><dt>缓存写入</dt><dd>{{ selected.cacheWriteTokens === null ? (selected.measurement === 'gateway' ? '未返回' : '未知') : tokens(selected.cacheWriteTokens) }}</dd></div>
        </dl>
        <p v-if="selected.search" class="usage-detail__search">联网搜索单独计量：<span class="mono">{{ selected.search.model }}</span> · {{ selected.search.requests ?? '—' }} 次 · 输入 {{ tokens(selected.search.inputTokens) }} / 输出 {{ tokens(selected.search.outputTokens) }}</p>
        <dl class="usage-detail__rows">
          <div><dt>模型请求</dt><dd>{{ selected.requests === null ? '估算数据没有请求次数' : `对话 ${selected.requests} 次${selected.failedRequests ? `（失败 ${selected.failedRequests} 次，含重试）` : ''}` }}</dd></div>
          <div><dt>员工</dt><dd>{{ selected.employeeName }}（{{ selected.employeeId }}）· {{ selected.department }}</dd></div>
          <div><dt>耗时</dt><dd>{{ duration(selected.durationMs) }}（整次执行，含工具调用）</dd></div>
          <div v-if="selected.errorCode"><dt>失败原因</dt><dd class="mono">{{ selected.errorCode }}</dd></div>
          <div><dt>运行</dt><dd class="mono">{{ selected.runId }}</dd></div>
          <div><dt>链路编号</dt><dd class="mono">{{ selected.traceId }}</dd></div>
        </dl>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          :title="selected.measurement === 'gateway'
            ? '用量来自模型网关逐次请求的计量；厂商未返回的项显示“未返回”，不按 0 统计。不展示请求与回复正文。'
            : selected.measurement === 'session-log'
              ? '该执行早于模型网关上线，用量来自 DSH 会话日志，没有缓存与请求次数数据。'
              : '该执行早于模型网关上线，Token 按文本长度估算，没有缓存与请求次数数据。'"
        />
        <div class="usage-detail__footer"><el-button type="primary" @click="openAudit">查看关联审计</el-button></div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.usage-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 16px; }
.usage-filters__select { width: 200px; }
.usage-filters__note { margin-left: auto; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.usage-estimated-note { margin-top: -4px; }
.usage-trend { padding: var(--spacing-card); }
.usage-trend__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.usage-trend__head h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-body); font-weight: var(--font-weight-title); }
.usage-trend__legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 0; padding: 0; list-style: none; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.usage-trend__legend li { display: inline-flex; align-items: center; gap: 6px; }
.usage-trend__legend span { width: 10px; height: 10px; border-radius: 2px; }
.usage-trend__swatch--estimated { background: repeating-linear-gradient(45deg, var(--color-text-muted) 0 2px, var(--color-border) 2px 4px); }
.usage-trend__chart { display: flex; align-items: flex-end; gap: 4px; height: 180px; margin-top: 14px; padding: 0 4px; border-bottom: 1px solid var(--color-border); }
.usage-trend__bar { display: flex; flex: 1; min-width: 0; height: 100%; flex-direction: column; justify-content: flex-end; }
.usage-trend__segment { margin-top: 1px; border-radius: 2px; background: var(--segment-color); }
.usage-trend__segment--estimated { background: repeating-linear-gradient(45deg, var(--segment-color) 0 3px, var(--color-bg-base) 3px 5px); }
.usage-trend__labels { display: flex; gap: 4px; padding: 4px 4px 0; color: var(--color-text-secondary); font-size: 11px; }
.usage-trend__labels span { flex: 1; min-width: 0; overflow: hidden; text-align: center; white-space: nowrap; }
.usage-tabs { padding: 0 12px; border-bottom: 1px solid var(--color-border); overflow-x: auto; }
.usage-hint { margin: 8px 16px 4px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.usage-drill-link { justify-content: flex-start; padding: 0; font-weight: var(--font-weight-title); }
.usage-token-cell { display: flex; align-items: center; gap: 6px; }
.usage-token-cell strong { color: var(--color-text-heading); }
.usage-share { height: 6px; margin-top: 4px; border-radius: 3px; background: var(--color-bg-subtle); }
.usage-share span { display: block; height: 6px; border-radius: 3px; background: var(--color-primary); }
.usage-measure { align-self: flex-start; margin-top: 2px; }
.mono { font-family: monospace; }
.usage-detail__hero { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.usage-detail__hero small, .usage-detail__hero p { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.usage-detail__hero h2 { margin: 4px 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.usage-detail__hero p { margin: 0; }
.usage-detail__tags { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.usage-detail__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 14px 0; }
.usage-detail__grid div { padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-button); }
.usage-detail__grid dt { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.usage-detail__grid dd { margin: 2px 0 0; color: var(--color-text-heading); font-size: var(--font-size-title); font-weight: var(--font-weight-title); }
.usage-detail__grid small { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.usage-detail__search { padding: 10px 12px; border-radius: var(--radius-button); background: var(--color-bg-page); font-size: var(--font-size-caption); }
.usage-detail__rows { margin: 14px 0; }
.usage-detail__rows div { display: grid; grid-template-columns: 100px 1fr; gap: 12px; padding: 9px 2px; border-bottom: 1px solid var(--color-border); }
.usage-detail__rows dt { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.usage-detail__rows dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); overflow-wrap: anywhere; }
.usage-detail__footer { margin-top: 18px; text-align: right; }
@media (max-width: 720px) {
  .usage-filters__select { width: 100%; }
  .usage-filters__note { margin-left: 0; }
}
</style>
