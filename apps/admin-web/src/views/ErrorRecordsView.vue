<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'

import { adminApi } from '@/api/client'
import type {
  ErrorGroupDetail,
  ErrorGroupSummary,
  ErrorKind,
  ErrorLookupResult,
  ErrorRange,
  ErrorSource,
  RunProblemSummary,
} from '@/types/domain'

/**
 * 错误记录（错误记录方案 6.5，OBS-S1）：员工端、管理端与服务端的错误按问题归并；运行问题读取已有运行记录；
 * 按员工报来的链路编号或运行编号查询。只读，不显示请求体、对话正文或查询参数。
 */
type ViewMode = 'issues' | 'runs'

const view = ref<ViewMode>('issues')
const range = ref<ErrorRange>('7d')
const source = ref<ErrorSource | 'all'>('all')
const includeNotice = ref(false)
const release = ref('')
const sort = ref<'recent' | 'count'>('recent')
const groups = ref<ErrorGroupSummary[]>([])
const releases = ref<string[]>([])
const runProblems = ref<RunProblemSummary>()
const loading = ref(false)
const error = ref('')
const drawerOpen = ref(false)
const detail = ref<ErrorGroupDetail>()
const detailLoading = ref(false)
const lookupQuery = ref('')
const lookup = ref<ErrorLookupResult>()
const lookupLoading = ref(false)
let listRequest = 0

const rangeOptions: Array<{ value: ErrorRange; label: string }> = [
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
]
const sourceOptions: Array<{ value: ErrorSource | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'workbench', label: '员工端' },
  { value: 'admin', label: '管理端' },
  { value: 'server', label: '服务端' },
]
const sourceLabels: Record<ErrorSource, string> = { workbench: '员工端', admin: '管理端', server: '服务端', process: '服务进程' }
const kindLabels: Record<ErrorKind, string> = {
  render: '渲染', script: '脚本', promise: '未处理异常', api: '接口', notice: '提示', load: '加载',
  stream: '实时流', http: 'HTTP', uncaught: '进程异常', overflow: '汇总',
}
const runStatusLabels: Record<string, string> = {
  queued: '排队中', running: '执行中', cancel_requested: '取消中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

const runCards = computed(() => {
  const summary = runProblems.value
  if (!summary) return []
  const share = (value: number) => summary.totalRuns ? `占全部运行 ${(value / summary.totalRuns * 100).toFixed(1)}%` : '本周期没有运行'
  return [
    { label: '失败', value: summary.failed, sub: share(summary.failed) },
    { label: '超时', value: summary.timedOut, sub: '运行时长达到上限' },
    { label: '取消', value: summary.cancelled, sub: share(summary.cancelled) },
    { label: '成功但没有回答', value: summary.emptyAnswer, sub: '运行完成、回答为空' },
  ]
})

function tagType(item: Pick<ErrorGroupSummary, 'source' | 'kind'>) {
  if (item.kind === 'notice') return 'info'
  if (item.source === 'server' || item.source === 'process') return 'warning'
  return item.source === 'admin' ? 'primary' : 'danger'
}

function sourceText(item: Pick<ErrorGroupSummary, 'source' | 'kind'>) {
  return `${sourceLabels[item.source]} · ${kindLabels[item.kind]}`
}

function time(value: string) {
  const date = new Date(value)
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function peopleText(item: ErrorGroupSummary) {
  if (item.people === 0 && item.anonymous) return '未登录'
  return item.anonymous ? `${item.people}（另有未登录）` : String(item.people)
}

function sampleUser(sample: { userName: string | null; userId: string | null }) {
  return sample.userName ?? sample.userId ?? '未登录'
}

async function loadGroups() {
  const current = ++listRequest
  loading.value = true
  try {
    const result = await adminApi.getErrorGroups({
      range: range.value,
      ...(source.value === 'all' ? {} : { source: source.value }),
      includeNotice: includeNotice.value,
      ...(release.value ? { release: release.value } : {}),
      sort: sort.value,
    })
    if (current !== listRequest) return
    groups.value = result.items
    releases.value = result.releases
  } catch (cause) {
    if (current === listRequest) error.value = cause instanceof Error ? cause.message : '错误记录加载失败'
  } finally {
    if (current === listRequest) loading.value = false
  }
}

async function loadRunProblems() {
  loading.value = true
  try {
    runProblems.value = await adminApi.getRunProblems(range.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '运行问题加载失败'
  } finally {
    loading.value = false
  }
}

function reload() {
  void (view.value === 'issues' ? loadGroups() : loadRunProblems())
}

function switchView(mode: ViewMode) {
  view.value = mode
  reload()
}

async function openGroup(item: ErrorGroupSummary) {
  drawerOpen.value = true
  detail.value = undefined
  detailLoading.value = true
  try {
    detail.value = await adminApi.getErrorGroup(item.id, range.value)
  } catch (cause) {
    drawerOpen.value = false
    error.value = cause instanceof Error ? cause.message : '问题详情加载失败'
  } finally {
    detailLoading.value = false
  }
}

async function runLookup() {
  const query = lookupQuery.value.trim()
  if (!query) return
  lookupLoading.value = true
  try {
    lookup.value = await adminApi.lookupErrorRecords(query)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '查询失败'
  } finally {
    lookupLoading.value = false
  }
}

const lookupEmpty = computed(() => lookup.value
  && !lookup.value.serverFailures.length && !lookup.value.clientReports.length && !lookup.value.runs.length)

onMounted(reload)
</script>

<template>
  <div class="ops-page error-records-page">
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />

    <section class="content-panel error-lookup" aria-label="编号查询">
      <form class="error-lookup__form" @submit.prevent="runLookup">
        <label for="error-lookup-input">编号查询</label>
        <el-input
          id="error-lookup-input"
          v-model="lookupQuery"
          class="error-lookup__input mono"
          placeholder="链路编号（trace-http-…）或运行编号"
          clearable
          @clear="lookup = undefined"
        />
        <el-button type="primary" native-type="submit" :icon="Search" :loading="lookupLoading">查询</el-button>
      </form>
      <p class="error-hint">员工端报错提示里的“链路编号”可以直接粘贴到这里。接口与运行之间只通过记录中的运行编号关联。</p>
      <div v-if="lookup" class="error-lookup__result" aria-label="查询结果" role="region">
        <p v-if="lookupEmpty" class="error-hint">没有找到与“{{ lookup.query }}”相关的记录。</p>
        <div v-else class="error-lookup__columns">
          <section aria-label="服务端失败">
            <h3>服务端失败</h3>
            <p v-if="!lookup.serverFailures.length" class="error-hint">无</p>
            <div v-for="item in lookup.serverFailures" :key="`${item.groupId}-${item.occurredAt}`" class="error-card">
              <strong>{{ item.message }}</strong>
              <small>{{ time(item.occurredAt) }} · {{ item.route }}</small>
              <small>{{ sampleUser(item) }}{{ item.release ? ` · ${item.release}` : '' }}</small>
            </div>
          </section>
          <section aria-label="浏览器上报">
            <h3>浏览器上报</h3>
            <p v-if="!lookup.clientReports.length" class="error-hint">无</p>
            <div v-for="item in lookup.clientReports" :key="`${item.groupId}-${item.occurredAt}`" class="error-card">
              <strong>{{ item.message }}</strong>
              <small>{{ time(item.occurredAt) }} · {{ sampleUser(item) }} · {{ sourceLabels[item.source] }} / {{ item.route ?? '—' }}</small>
              <small>{{ item.client ?? '—' }}</small>
            </div>
          </section>
          <section aria-label="关联运行">
            <h3>关联运行</h3>
            <p v-if="!lookup.runs.length" class="error-hint">没有记录运行编号</p>
            <div v-for="run in lookup.runs" :key="run.runId" class="error-card">
              <strong class="mono">{{ run.runId }}</strong>
              <small>{{ run.agentName ?? '—' }} · {{ run.requestedBy ?? '—' }} · {{ time(run.createdAt) }}</small>
              <small :class="{ 'is-danger': run.status === 'failed' }">{{ runStatusLabels[run.status] ?? run.status }}{{ run.errorCode ? ` · ${run.errorCode}` : '' }}</small>
              <router-link class="error-link" :to="{ path: '/sessions' }">前往 Session 列表</router-link>
            </div>
          </section>
        </div>
      </div>
    </section>

    <section class="content-panel content-panel--flush" aria-label="错误记录">
      <div class="status-tabs" role="tablist" aria-label="视图">
        <button class="status-tab" :class="{ active: view === 'issues' }" type="button" role="tab" :aria-selected="view === 'issues'" @click="switchView('issues')">问题</button>
        <button class="status-tab" :class="{ active: view === 'runs' }" type="button" role="tab" :aria-selected="view === 'runs'" @click="switchView('runs')">运行问题</button>
      </div>

      <div class="error-filters">
        <el-radio-group v-model="range" aria-label="时间范围" @change="reload">
          <el-radio-button v-for="option in rangeOptions" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
        </el-radio-group>
        <template v-if="view === 'issues'">
          <el-radio-group v-model="source" aria-label="来源" @change="loadGroups">
            <el-radio-button v-for="option in sourceOptions" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
          </el-radio-group>
          <el-checkbox v-model="includeNotice" @change="loadGroups">显示“提示”类（员工看到的失败提示）</el-checkbox>
          <span class="error-filters__spacer" />
          <el-select v-model="release" class="error-filters__select" clearable placeholder="全部版本" aria-label="筛选版本" @change="loadGroups">
            <el-option v-for="item in releases" :key="item" :label="item" :value="item" />
          </el-select>
          <el-select v-model="sort" class="error-filters__select" aria-label="排序" @change="loadGroups">
            <el-option label="最近发生" value="recent" />
            <el-option label="次数最多" value="count" />
          </el-select>
        </template>
      </div>

      <template v-if="view === 'issues'">
        <el-table v-loading="loading" class="data-table" :data="groups" empty-text="当前筛选范围内没有错误记录" @row-click="openGroup">
          <el-table-column label="问题" min-width="320">
            <template #default="scope">
              <div class="stack-cell">
                <el-button link class="error-title" :aria-label="`查看问题详情：${scope.row.message}`" @click.stop="openGroup(scope.row)">{{ scope.row.message }}</el-button>
                <small>{{ scope.row.route ?? '—' }}</small>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="来源 · 类型" width="150">
            <template #default="scope"><el-tag :type="tagType(scope.row)" effect="light">{{ sourceText(scope.row) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="次数" width="90"><template #default="scope"><strong>{{ scope.row.count }}</strong></template></el-table-column>
          <el-table-column label="影响人数" width="130"><template #default="scope">{{ peopleText(scope.row) }}</template></el-table-column>
          <el-table-column label="首次 / 最近" width="150">
            <template #default="scope"><div class="stack-cell nowrap"><small>首次 {{ time(scope.row.firstSeenAt) }}</small><small>最近 {{ time(scope.row.lastSeenAt) }}</small></div></template>
          </el-table-column>
          <el-table-column label="最近版本" width="150"><template #default="scope"><span class="nowrap">{{ scope.row.lastRelease ?? '—' }}</span></template></el-table-column>
        </el-table>
      </template>

      <template v-else>
        <div v-loading="loading" class="run-problems">
          <div class="run-problems__cards" aria-label="运行问题概况" role="region">
            <div v-for="card in runCards" :key="card.label" class="run-problems__card">
              <span>{{ card.label }}</span>
              <strong>{{ card.value }}</strong>
              <small>{{ card.sub }}</small>
            </div>
          </div>
          <div class="run-problems__tables">
            <section aria-label="按原因">
              <h3>按原因</h3>
              <el-table class="data-table" :data="runProblems?.reasons ?? []" empty-text="本周期没有运行问题">
                <el-table-column label="原因" min-width="200"><template #default="scope"><div class="stack-cell"><span>{{ scope.row.label }}</span><small class="mono">{{ scope.row.code }}</small></div></template></el-table-column>
                <el-table-column prop="runs" label="运行数" min-width="90" />
                <el-table-column prop="people" label="员工" min-width="80" />
                <el-table-column label="最近" min-width="120"><template #default="scope">{{ time(scope.row.lastAt) }}</template></el-table-column>
              </el-table>
            </section>
            <section aria-label="工具调用失败或被拒绝">
              <h3>工具调用失败或被拒绝</h3>
              <el-table class="data-table" :data="runProblems?.tools ?? []" empty-text="本周期没有工具调用失败">
                <el-table-column label="工具" min-width="140"><template #default="scope"><span class="mono">{{ scope.row.tool }}</span></template></el-table-column>
                <el-table-column prop="failed" label="失败" min-width="80" />
                <el-table-column prop="denied" label="被拒绝" min-width="90" />
                <el-table-column label="主要原因" min-width="160"><template #default="scope"><span class="mono">{{ scope.row.topReason }}</span></template></el-table-column>
              </el-table>
            </section>
          </div>
        </div>
      </template>
    </section>

    <el-drawer v-model="drawerOpen" size="min(560px, 100vw)" title="问题详情">
      <div v-loading="detailLoading" class="error-detail">
        <template v-if="detail">
          <div class="error-detail__hero">
            <el-tag :type="tagType(detail)" effect="light">{{ sourceText(detail) }}</el-tag>
            <h2>{{ detail.message }}</h2>
            <p>{{ rangeOptions.find(option => option.value === range)?.label }} {{ detail.count }} 次 · {{ peopleText(detail) }} 人 · 累计 {{ detail.totalCount }} 次 · 首次 {{ time(detail.firstSeenAt) }} · 最近 {{ time(detail.lastSeenAt) }}</p>
          </div>
          <section aria-label="最近样本">
            <h3>最近样本</h3>
            <div v-for="sample in detail.samples" :key="`${sample.occurredAt}-${sample.traceId}`" class="error-card">
              <div class="error-card__row"><span>{{ time(sample.occurredAt) }} · {{ sampleUser(sample) }}</span><small>{{ sample.client ?? '' }}</small></div>
              <small>{{ sample.route ?? '—' }}{{ sample.release ? ` · ${sample.release}` : '' }}{{ sample.repeatCount > 1 ? ` · 1 分钟内重复 ${sample.repeatCount} 次` : '' }}</small>
              <small v-if="sample.traceId || sample.runId" class="mono">{{ [sample.traceId, sample.runId].filter(Boolean).join(' · ') }}</small>
              <router-link v-if="sample.runId" class="error-link" :to="{ path: '/sessions' }">前往 Session 列表查看该运行</router-link>
            </div>
          </section>
          <section v-if="detail.stack" aria-label="堆栈">
            <h3>堆栈 <small :class="detail.stackResolved ? 'is-success' : 'is-muted'">{{ detail.stackResolved ? '已按源码映射还原' : '未还原（缺少该版本的源码映射）' }}</small></h3>
            <pre class="error-stack">{{ detail.stack }}</pre>
          </section>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.error-records-page { display: flex; flex-direction: column; gap: var(--space-4, 16px); }
.error-lookup { display: flex; flex-direction: column; gap: 8px; }
.error-lookup__form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.error-lookup__form label { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.error-lookup__input { width: min(420px, 100%); }
.error-lookup__columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.error-lookup__columns h3, .run-problems h3, .error-detail h3 { margin: 0 0 8px; font-size: var(--font-size-title); color: var(--color-text-heading); }
.error-hint { margin: 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.error-card { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 8px; margin-bottom: 8px; font-size: var(--font-size-caption); }
.error-card small { color: var(--color-text-secondary); word-break: break-all; }
.error-card__row { display: flex; justify-content: space-between; gap: 8px; }
.error-filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--color-border); }
.error-filters__spacer { flex: 1; }
.error-filters__select { width: 160px; }
.error-title { white-space: normal; text-align: left; height: auto; font-weight: 600; color: var(--color-text-heading); }
.stack-cell { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
.stack-cell small { color: var(--color-text-secondary); }
.nowrap { white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.error-card .is-danger, .is-danger { color: var(--color-danger); }
.error-link { color: var(--color-primary); font-size: var(--font-size-caption); }
.error-records-page :deep(.el-table th .cell) { white-space: nowrap; }
.is-success { color: var(--color-success); font-weight: 400; }
.is-muted { color: var(--color-text-secondary); font-weight: 400; }
.run-problems { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
.run-problems__cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.run-problems__card { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border: 1px solid var(--color-border); border-radius: 12px; }
.run-problems__card span, .run-problems__card small { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.run-problems__card strong { font-size: var(--font-size-metric, 30px); color: var(--color-text-heading); font-weight: 600; }
.run-problems__tables { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
.error-detail { display: flex; flex-direction: column; gap: 16px; min-height: 120px; }
.error-detail__hero h2 { margin: 8px 0 4px; font-size: var(--font-size-section); color: var(--color-text-heading); word-break: break-word; }
.error-detail__hero p { margin: 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.error-stack { margin: 0; padding: 12px; border-radius: 8px; background: var(--color-bg-subtle); color: var(--color-text-primary); border: 1px solid var(--color-border); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
</style>
