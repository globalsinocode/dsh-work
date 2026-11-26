<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { adminApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { UsageEntry, UsageIdlePerson, UsageOverview, UsagePerson, UsagePersonDetail, UsageRange } from '@/types/domain'

/**
 * 运营概览（使用情况，错误记录与使用情况方案 6.5，OBS-S2）：一段时间内谁在用、用了什么、运行是否顺利。
 * 只显示使用量与功能分布，不显示对话标题、消息正文或附件名称。
 */
const contentStore = useContentStore()
const range = ref<UsageRange>('30d')
const department = ref('')
const overview = ref<UsageOverview>()
const active = ref<UsagePerson[]>([])
const idle = ref<UsageIdlePerson[]>([])
const tab = ref<'active' | 'idle'>('active')
const search = ref('')
const loading = ref(false)
const drawerOpen = ref(false)
const detail = ref<UsagePersonDetail>()
const detailLoading = ref(false)
let request = 0

const rangeOptions: Array<{ value: UsageRange; label: string }> = [
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
]
const entryLabels: Record<UsageEntry, string> = { personal: '个人对话', project: '项目空间', automation: '定时任务', routine: '主动任务' }
/** 员工端路由名 → 页面名称（只用于展示；未登记的显示路由名）。 */
const pageLabels: Record<string, string> = {
  workbench: '新对话', conversation: '对话', 'session-detail': '对话', history: '历史对话', agents: 'AI 同事',
  'collab-agents': 'AI 同事', 'collab-agent': 'AI 同事', 'collab-agent-chat': '对话', 'collab-chats': '对话',
  'collab-groups': '群组', 'collab-group': '群组', 'collab-group-chat': '群组', 'collab-group-conversation': '群组',
  'collab-group-task': '群组任务', 'collab-group-task-thread': '群组任务', workspaces: '项目空间', 'workspace-detail': '项目空间',
  'workspace-conversation': '项目空间', 'workspace-task': '项目任务', 'workspace-task-thread': '项目任务',
  knowledge: '知识库', 'knowledge-detail': '知识库', automations: '定时任务', skills: 'Skill 广场', 'my-files': '我的文件',
  artifacts: '我的文件', settings: '设置',
}
const failureLabels: Record<string, string> = {
  RUN_TIMEOUT: '运行超时', EXECUTION_CONTAINER_UNAVAILABLE: '执行容器不可用', MODEL_CREDENTIAL_INVALID: '模型凭据无效',
  RUNTIME_UNAVAILABLE: '运行时不可用', MODEL_ROUTE_UNAVAILABLE: '模型路由不可用', SERVICE_RESTARTED: '服务重启中断', UNKNOWN: '未记录原因',
}

const totals = computed(() => overview.value?.totals)
const metrics = computed(() => {
  const value = totals.value
  if (!value) return []
  const coverage = value.employees ? Math.round(value.activeEmployees / value.employees * 100) : 0
  const success = value.finishedRuns ? `${(value.succeededRuns / value.finishedRuns * 100).toFixed(1)}%` : '—'
  return [
    { label: '活跃员工', value: String(value.activeEmployees), sub: `共 ${value.employees} 个账号，覆盖 ${coverage}%` },
    { label: '日均活跃', value: String(value.averageDailyActive), sub: `钉钉内访问 ${value.dingtalkEmployees} 人` },
    { label: '新建对话', value: number(value.newConversations), sub: value.activeEmployees ? `人均 ${(value.newConversations / value.activeEmployees).toFixed(1)}` : '—' },
    { label: '运行数', value: number(value.runs), sub: `成功率 ${success}` },
    { label: 'Token 消耗', value: compact(value.tokens), sub: '详见模型用量' },
  ]
})
const maxDaily = computed(() => Math.max(1, ...(overview.value?.daily ?? []).flatMap(item => [item.activeEmployees, item.runs / 10])))
const maxAgentRuns = computed(() => Math.max(1, ...(overview.value?.agents ?? []).map(item => item.runs)))
const maxPagePeople = computed(() => Math.max(1, ...(overview.value?.pages ?? []).map(item => item.people)))
const totalEntryRuns = computed(() => (overview.value?.entries ?? []).reduce((sum, item) => sum + item.runs, 0))
const filteredActive = computed(() => filterByName(active.value))
const filteredIdle = computed(() => filterByName(idle.value))
const maxDetailRuns = computed(() => Math.max(1, ...(detail.value?.daily ?? []).map(item => item.runs)))

function filterByName<T extends { name: string }>(list: T[]) {
  const keyword = search.value.trim()
  return keyword ? list.filter(item => item.name.includes(keyword)) : list
}

function number(value: number) {
  return value.toLocaleString('zh-CN')
}

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function percent(part: number, whole: number) {
  return whole ? `${Math.round(part / whole * 100)}%` : '0%'
}

function successText(person: UsagePerson) {
  return person.finishedRuns ? `${person.runs}（${Math.round(person.succeededRuns / person.finishedRuns * 100)}%）` : String(person.runs)
}

function time(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  const pad = (item: number) => String(item).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function day(value: string) {
  return value.slice(5)
}

function pageName(page: string | null) {
  return page ? pageLabels[page] ?? page : '—'
}

async function load() {
  const current = ++request
  loading.value = true
  try {
    const dept = department.value || undefined
    const [summary, people] = await Promise.all([
      adminApi.getUsageOverview(range.value, dept),
      adminApi.getUsagePeople(range.value, dept),
    ])
    if (current !== request) return
    overview.value = summary
    active.value = people.active
    idle.value = people.idle
  } catch (cause) {
    if (current === request) contentStore.error = cause instanceof Error ? cause.message : '使用情况加载失败'
  } finally {
    if (current === request) loading.value = false
  }
}

async function openPerson(person: UsagePerson) {
  drawerOpen.value = true
  detail.value = undefined
  detailLoading.value = true
  try {
    detail.value = await adminApi.getUsagePerson(person.userId, range.value)
  } catch (cause) {
    drawerOpen.value = false
    contentStore.error = cause instanceof Error ? cause.message : '员工详情加载失败'
  } finally {
    detailLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="ops-page admin-overview-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="content-panel filter-panel" aria-label="筛选">
      <div class="filter-bar">
        <p class="page-note">一段时间内谁在用、用了什么、运行是否顺利。只统计使用量与功能，不显示对话内容。</p>
        <div class="overview-filters">
          <el-radio-group v-model="range" aria-label="统计周期" @change="load">
            <el-radio-button v-for="option in rangeOptions" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
          </el-radio-group>
          <el-select v-model="department" class="overview-filters__select" clearable placeholder="全部部门" aria-label="筛选部门" @change="load">
            <el-option v-for="name in overview?.departmentOptions ?? []" :key="name" :label="name" :value="name" />
          </el-select>
        </div>
      </div>
    </section>

    <section v-loading="loading" class="content-panel overview-strip" aria-label="核心指标">
      <dl class="overview-strip__stats">
        <div v-for="metric in metrics" :key="metric.label" class="overview-stat">
          <dt>{{ metric.label }}</dt>
          <dd><strong class="overview-stat__value">{{ metric.value }}</strong><small>{{ metric.sub }}</small></dd>
        </div>
      </dl>
    </section>

    <section class="content-panel usage-panel" aria-label="每日趋势">
      <div class="panel-header">
        <div><h2 class="panel-title">每日活跃员工与运行数</h2><p class="panel-subtitle">{{ overview ? `${overview.from} 至 ${overview.to}` : '' }}</p></div>
        <ul class="usage-legend"><li><span class="usage-legend__swatch usage-legend__swatch--active" />活跃员工</li><li><span class="usage-legend__swatch usage-legend__swatch--runs" />运行数（÷10）</li></ul>
      </div>
      <div class="usage-chart" role="img" :aria-label="`每日活跃员工与运行数，共 ${overview?.daily.length ?? 0} 天`">
        <div v-for="point in overview?.daily ?? []" :key="point.day" class="usage-chart__day" :title="`${point.day}：活跃 ${point.activeEmployees} 人，运行 ${point.runs} 次`">
          <span class="usage-chart__bar usage-chart__bar--active" :style="{ height: `${point.activeEmployees / maxDaily * 100}%` }" />
          <span class="usage-chart__bar usage-chart__bar--runs" :style="{ height: `${point.runs / 10 / maxDaily * 100}%` }" />
        </div>
      </div>
    </section>

    <section class="usage-grid">
      <div class="content-panel usage-panel" aria-label="AI 同事使用排行" role="region">
        <h2 class="panel-title">AI 同事使用排行</h2>
        <p v-if="!overview?.agents.length" class="page-note">本周期没有运行</p>
        <div v-for="item in overview?.agents ?? []" :key="item.name" class="usage-rank">
          <div class="usage-rank__row"><span>{{ item.name }}</span><small>{{ number(item.runs) }} 次 · {{ item.people }} 人</small></div>
          <div class="usage-rank__track"><span :style="{ width: `${item.runs / maxAgentRuns * 100}%` }" /></div>
        </div>
      </div>
      <div class="content-panel usage-panel" aria-label="页面访问排行" role="region">
        <h2 class="panel-title">页面访问排行</h2>
        <p v-if="!overview?.pages.length" class="page-note">本周期没有页面访问记录</p>
        <div v-for="item in overview?.pages ?? []" :key="item.page" class="usage-rank">
          <div class="usage-rank__row"><span>{{ pageName(item.page) }}</span><small>{{ item.people }} 人访问</small></div>
          <div class="usage-rank__track"><span :style="{ width: `${item.people / maxPagePeople * 100}%` }" /></div>
        </div>
      </div>
      <div class="content-panel usage-panel" aria-label="入口分布与失败原因" role="region">
        <h2 class="panel-title">入口分布</h2>
        <div v-for="item in overview?.entries ?? []" :key="item.entry" class="usage-kv"><span>{{ entryLabels[item.entry] }}</span><strong>{{ percent(item.runs, totalEntryRuns) }}</strong></div>
        <div class="usage-kv"><span>钉钉内访问</span><strong>{{ totals?.dingtalkEmployees ?? 0 }} 人</strong></div>
        <h2 class="panel-title usage-panel__subtitle">运行失败原因</h2>
        <p v-if="!overview?.failures.length" class="page-note">本周期没有失败的运行</p>
        <div v-for="item in overview?.failures ?? []" :key="item.code" class="usage-kv"><span>{{ failureLabels[item.code] ?? item.code }}</span><strong class="is-danger">{{ item.runs }} 次</strong></div>
        <router-link class="usage-link" to="/error-records">在错误记录中查看运行问题 →</router-link>
      </div>
    </section>

    <section class="content-panel usage-panel" aria-label="部门覆盖">
      <h2 class="panel-title">部门覆盖</h2>
      <el-table class="data-table" :data="overview?.departments ?? []" empty-text="没有部门数据">
        <el-table-column prop="name" label="部门" min-width="160" />
        <el-table-column prop="employees" label="有账号" min-width="90" />
        <el-table-column prop="activeEmployees" label="期间活跃" min-width="100" />
        <el-table-column label="覆盖率" min-width="260">
          <template #default="scope">
            <div class="usage-coverage">
              <div class="usage-rank__track"><span :class="{ 'is-low': scope.row.activeEmployees / Math.max(scope.row.employees, 1) < 0.5 }" :style="{ width: percent(scope.row.activeEmployees, scope.row.employees) }" /></div>
              <span>{{ percent(scope.row.activeEmployees, scope.row.employees) }}</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="content-panel content-panel--flush" aria-label="员工明细">
      <div class="usage-people-head">
        <div class="status-tabs" role="tablist" aria-label="员工明细">
          <button class="status-tab" :class="{ active: tab === 'active' }" type="button" role="tab" :aria-selected="tab === 'active'" @click="tab = 'active'">按人明细<span class="tab-count">{{ active.length }}</span></button>
          <button class="status-tab" :class="{ active: tab === 'idle' }" type="button" role="tab" :aria-selected="tab === 'idle'" @click="tab = 'idle'">期间内未使用<span class="tab-count">{{ idle.length }}</span></button>
        </div>
        <el-input v-model="search" class="usage-search" clearable placeholder="按姓名搜索" aria-label="按姓名搜索员工" />
      </div>
      <el-table v-if="tab === 'active'" v-loading="loading" class="data-table" :data="filteredActive" empty-text="本周期没有活跃员工" @row-click="openPerson">
        <el-table-column label="员工" min-width="110">
          <template #default="scope"><el-button link type="primary" :aria-label="`查看 ${scope.row.name} 的使用详情`" @click.stop="openPerson(scope.row)">{{ scope.row.name }}</el-button></template>
        </el-table-column>
        <el-table-column prop="department" label="部门" min-width="120" />
        <el-table-column label="最近活跃" min-width="120"><template #default="scope">{{ time(scope.row.lastActiveAt) }}</template></el-table-column>
        <el-table-column prop="activeDays" label="活跃天数" min-width="90" />
        <el-table-column prop="conversations" label="对话" min-width="70" />
        <el-table-column label="运行（成功率）" min-width="130"><template #default="scope">{{ successText(scope.row) }}</template></el-table-column>
        <el-table-column label="Token" min-width="90"><template #default="scope">{{ compact(scope.row.tokens) }}</template></el-table-column>
        <el-table-column label="常用 AI 同事" min-width="140"><template #default="scope">{{ scope.row.topAgent ?? '—' }}</template></el-table-column>
        <el-table-column label="常访问页面" min-width="110"><template #default="scope">{{ pageName(scope.row.topPage) }}</template></el-table-column>
      </el-table>
      <template v-else>
        <p class="page-note usage-idle-note">组织中有账号、但本周期内没有任何会话、运行或页面访问的员工。</p>
        <el-table v-loading="loading" class="data-table" :data="filteredIdle" empty-text="本周期所有员工都用过">
          <el-table-column prop="name" label="员工" min-width="110" />
          <el-table-column prop="department" label="部门" min-width="120" />
          <el-table-column label="账号创建" min-width="120"><template #default="scope">{{ time(scope.row.createdAt) }}</template></el-table-column>
          <el-table-column label="最近一次活跃" min-width="120"><template #default="scope">{{ scope.row.lastActiveAt ? time(scope.row.lastActiveAt) : '从未使用' }}</template></el-table-column>
        </el-table>
      </template>
    </section>

    <el-drawer v-model="drawerOpen" size="min(480px, 100vw)" title="员工使用详情">
      <div v-loading="detailLoading" class="usage-detail">
        <template v-if="detail">
          <div>
            <h2>{{ detail.name }}</h2>
            <p class="page-note">{{ detail.department }} · 最近活跃 {{ time(detail.lastActiveAt) }}</p>
          </div>
          <dl class="usage-detail__grid">
            <div><dt>活跃天数</dt><dd>{{ detail.activeDays }}</dd></div>
            <div><dt>对话</dt><dd>{{ detail.conversations }}</dd></div>
            <div><dt>运行</dt><dd>{{ successText(detail) }}</dd></div>
            <div><dt>Token</dt><dd>{{ compact(detail.tokens) }}</dd></div>
          </dl>
          <section aria-label="每日运行">
            <h3>每日运行</h3>
            <div class="usage-chart usage-chart--small" role="img" :aria-label="`每日运行，共 ${detail.daily.length} 天`">
              <div v-for="point in detail.daily" :key="point.day" class="usage-chart__day" :title="`${day(point.day)}：${point.runs} 次`">
                <span class="usage-chart__bar usage-chart__bar--active" :style="{ height: `${point.runs / maxDetailRuns * 100}%` }" />
              </div>
            </div>
          </section>
          <section aria-label="功能分布">
            <h3>功能分布</h3>
            <div v-for="item in detail.entries" :key="item.entry" class="usage-kv"><span>{{ entryLabels[item.entry] }}</span><strong>{{ item.runs }} 次运行</strong></div>
            <div v-for="item in detail.pages" :key="item.page" class="usage-kv"><span>{{ pageName(item.page) }}</span><strong>{{ item.views }} 次访问</strong></div>
          </section>
          <router-link class="usage-link" to="/sessions">前往 Session 列表查看该员工的会话</router-link>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.overview-filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.overview-filters__select { width: 180px; }
.usage-panel { display: flex; flex-direction: column; gap: 12px; }
.usage-panel__subtitle { margin-top: 8px; }
.usage-legend { display: flex; gap: 14px; margin: 0; padding: 0; list-style: none; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.usage-legend li { display: flex; gap: 6px; align-items: center; }
.usage-legend__swatch { width: 10px; height: 10px; border-radius: 2px; }
.usage-legend__swatch--active, .usage-chart__bar--active { background: var(--color-primary); }
.usage-legend__swatch--runs, .usage-chart__bar--runs { background: var(--color-chart-2); }
.usage-chart { display: flex; align-items: flex-end; gap: 3px; height: 160px; border-bottom: 1px solid var(--color-border); }
.usage-chart--small { height: 72px; }
.usage-chart__day { display: flex; flex: 1 1 0; align-items: flex-end; gap: 1px; height: 100%; }
.usage-chart__bar { flex: 1; min-height: 1px; border-radius: 2px 2px 0 0; }
.usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.usage-rank { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-size-caption); }
.usage-rank__row { display: flex; justify-content: space-between; gap: 8px; }
.usage-rank__row small { color: var(--color-text-secondary); }
.usage-rank__track { height: 6px; border-radius: 3px; background: var(--color-primary-light); }
.usage-coverage .usage-rank__track { flex: 1; }
.usage-rank__track span { display: block; height: 100%; border-radius: 3px; background: var(--color-primary); }
.usage-rank__track span.is-low { background: var(--color-warning); }
.usage-coverage { display: flex; gap: 8px; align-items: center; }
.usage-coverage > span { width: 44px; text-align: right; }
.usage-kv { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--color-border); font-size: var(--font-size-caption); }
.usage-kv strong { color: var(--color-text-heading); }
.usage-kv strong.is-danger { color: var(--color-danger); }
.usage-link { color: var(--color-primary); font-size: var(--font-size-caption); }
.usage-people-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding-right: 16px; }
.usage-search { width: 200px; }
.usage-idle-note { padding: 12px 16px 0; }
.usage-detail { display: flex; flex-direction: column; gap: 16px; min-height: 120px; }
.usage-detail h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-section); }
.usage-detail h3 { margin: 0 0 8px; color: var(--color-text-heading); font-size: var(--font-size-title); }
.usage-detail__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; }
.usage-detail__grid div { padding: 10px; border-radius: 8px; background: var(--color-bg-subtle); }
.usage-detail__grid dt { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.usage-detail__grid dd { margin: 4px 0 0; color: var(--color-text-heading); font-size: var(--font-size-subheading); font-weight: 600; }
.admin-overview-page :deep(.el-table th .cell) { white-space: nowrap; }
</style>
