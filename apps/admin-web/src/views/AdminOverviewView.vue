<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'

const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()

const maxRuns = computed(() => Math.max(...contentStore.usage.map((item) => item.runs), 1))
const totalRuns = computed(() => contentStore.usage.reduce((sum, item) => sum + item.runs, 0))
const totalTokens = computed(() => contentStore.usage.reduce((sum, item) => sum + item.tokens, 0))
const successRate = computed(() => {
  const finished = contentStore.tasks.filter((task) => ['succeeded', 'failed'].includes(task.status))
  if (!finished.length) return '—'
  return `${Math.round((finished.filter((task) => task.status === 'succeeded').length / finished.length) * 100)}%`
})
const statusCounts = computed(() => ({
  succeeded: contentStore.tasks.filter((task) => task.status === 'succeeded').length,
  running: contentStore.tasks.filter((task) => task.status === 'running').length,
  queued: contentStore.tasks.filter((task) => ['queued', 'cancel_requested'].includes(task.status)).length,
  failed: contentStore.tasks.filter((task) => ['failed', 'cancelled'].includes(task.status)).length,
}))
const currentRunCount = computed(() => Object.values(statusCounts.value).reduce((sum, count) => sum + count, 0))
const attentionEvents = computed(() => contentStore.auditEvents.filter((event) => event.status !== 'success').slice(0, 3))
const donutStyle = computed(() => {
  const total = Math.max(currentRunCount.value, 1)
  const successEnd = (statusCounts.value.succeeded / total) * 100
  const runningEnd = successEnd + (statusCounts.value.running / total) * 100
  const queuedEnd = runningEnd + (statusCounts.value.queued / total) * 100
  return {
    background: `conic-gradient(var(--color-success) 0 ${successEnd}%, var(--color-primary) ${successEnd}% ${runningEnd}%, var(--color-warning) ${runningEnd}% ${queuedEnd}%, var(--color-danger) ${queuedEnd}% 100%)`,
  }
})

function percent(count: number) {
  return currentRunCount.value ? `${((count / currentRunCount.value) * 100).toFixed(1)}%` : '0%'
}

onMounted(() => contentStore.load())
</script>

<template>
  <div class="ops-page admin-overview-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <p class="page-note">查看对话与运行、模型用量、工具可用性和需关注事件。</p>
        <div class="overview-time"><span></span>数据更新于刚刚</div>
      </div>
    </section>

    <section v-loading="contentStore.loading" class="content-panel overview-strip" aria-label="运营概况">
      <dl class="overview-strip__stats">
        <div class="overview-stat"><dt>近 7 日运行</dt><dd><strong class="overview-stat__value">{{ totalRuns }}</strong></dd></div>
        <div class="overview-stat"><dt>运行成功率</dt><dd><strong class="overview-stat__value">{{ successRate }}</strong><small>不含取消与排队运行</small></dd></div>
        <div class="overview-stat"><dt>模型 Token</dt><dd><strong class="overview-stat__value">{{ totalTokens.toLocaleString() }}</strong><small><button class="overview-stat__link" type="button" @click="router.push('/model-usage')">查看用量明细</button></small></dd></div>
        <div v-if="authStore.canReadAudit" class="overview-stat"><dt>近 24 小时需关注</dt><dd><strong class="overview-stat__value">{{ contentStore.operationsSummary?.attentionEvents24h ?? 0 }}</strong><small><button class="overview-stat__link" type="button" @click="router.push('/audit')">查看失败与阻止事件</button></small></dd></div>
      </dl>
    </section>

    <section class="overview-main-grid">
      <div class="content-panel content-panel--flush usage-panel">
        <div class="panel-header">
          <div><h2 class="panel-title">运行趋势</h2><p class="panel-subtitle">近 7 日创建运行数量</p></div>
          <el-radio-group model-value="runs" size="small"><el-radio-button value="runs">运行</el-radio-button><el-radio-button value="tokens">Token</el-radio-button></el-radio-group>
        </div>
        <div v-loading="contentStore.loading" class="usage-chart" aria-label="近七日运行趋势柱状图">
          <div v-for="point in contentStore.usage" :key="point.day" class="usage-bar">
            <span class="usage-bar__value">{{ point.runs }}</span>
            <div class="usage-bar__track"><i :style="{ height: `${(point.runs / maxRuns) * 100}%` }"></i></div>
            <span class="usage-bar__day">{{ point.day }}</span>
          </div>
        </div>
      </div>

      <aside class="content-panel content-panel--flush status-panel">
        <div class="panel-header"><div><h2 class="panel-title">当前运行状态</h2><p class="panel-subtitle">最近 100 条运行分布</p></div></div>
        <div class="status-donut-wrap">
          <div class="status-donut" :style="donutStyle"><div><strong>{{ currentRunCount }}</strong><span>运行</span></div></div>
          <div class="status-legend">
            <div><span class="is-success"></span><label>已完成</label><strong>{{ statusCounts.succeeded }}</strong><small>{{ percent(statusCounts.succeeded) }}</small></div>
            <div><span class="is-running"></span><label>执行中</label><strong>{{ statusCounts.running }}</strong><small>{{ percent(statusCounts.running) }}</small></div>
            <div><span class="is-waiting"></span><label>排队或取消中</label><strong>{{ statusCounts.queued }}</strong><small>{{ percent(statusCounts.queued) }}</small></div>
            <div><span class="is-failed"></span><label>失败或已取消</label><strong>{{ statusCounts.failed }}</strong><small>{{ percent(statusCounts.failed) }}</small></div>
          </div>
        </div>
      </aside>
    </section>

    <section v-if="authStore.canReadAudit" class="overview-bottom-grid">
      <div class="content-panel content-panel--flush attention-panel">
        <div class="panel-header">
          <div><h2 class="panel-title">需关注事项</h2><p class="panel-subtitle">系统、权限与运行风险</p></div>
          <el-button text @click="router.push('/health')">查看系统健康</el-button>
        </div>
        <div class="attention-list">
          <article v-for="event in attentionEvents" :key="event.id">
            <span class="attention-icon" :class="event.status === 'failed' ? 'attention-icon--blocked' : 'attention-icon--warning'">{{ event.status === 'failed' ? '错' : '阻' }}</span>
            <div><strong>{{ event.action }} · {{ event.object }}</strong><p>{{ event.actor }} · {{ event.time }} · {{ event.traceId }}</p></div>
            <StatusTag :status="event.status" />
          </article>
          <el-empty v-if="!contentStore.loading && !attentionEvents.length" :image-size="54" description="当前没有失败或已阻止事件" />
        </div>
      </div>

      <div class="content-panel content-panel--flush audit-summary-panel">
        <div class="panel-header">
          <div><h2 class="panel-title">最近审计事件</h2><p class="panel-subtitle">关键调用与策略结果</p></div>
          <el-button text @click="router.push('/audit')">查看全部</el-button>
        </div>
        <div class="audit-summary-list">
          <article v-for="event in contentStore.auditEvents.slice(0, 4)" :key="event.id">
            <span class="audit-summary-list__dot" :class="`is-${event.status}`"></span>
            <div><strong>{{ event.action }} · {{ event.object }}</strong><p>{{ event.actor }} · {{ event.time }}</p></div>
            <StatusTag :status="event.status" />
          </article>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overview-time {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
}

.overview-time span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-success);
}


.overview-main-grid,
.overview-bottom-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(320px, 0.7fr);
  gap: 14px;
}

.overview-bottom-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.usage-panel,
.status-panel,
.attention-panel,
.audit-summary-panel {
  overflow: hidden;
}

.usage-chart {
  display: flex;
  align-items: stretch;
  height: 260px;
  gap: 12px;
  padding: 25px 22px 18px;
  border-bottom: 1px solid transparent;
  background: linear-gradient(to bottom, transparent 24%, var(--color-bg-subtle) 25%, transparent 25.5%, transparent 49%, var(--color-bg-subtle) 50%, transparent 50.5%, transparent 74%, var(--color-bg-subtle) 75%, transparent 75.5%);
}

.usage-bar {
  display: grid;
  min-width: 0;
  flex: 1;
  grid-template-rows: 18px 1fr 20px;
  align-items: end;
  text-align: center;
}

.usage-bar__value {
  align-self: start;
  color: var(--color-text-secondary);
  font-size: var(--font-size-badge);
  opacity: 0;
  transition: opacity 150ms ease;
}

.usage-bar:hover .usage-bar__value {
  opacity: 1;
}

.usage-bar__track {
  display: flex;
  width: min(42px, 78%);
  height: 100%;
  align-items: end;
  justify-self: center;
}

.usage-bar__track i {
  display: block;
  width: 100%;
  min-height: 8px;
  border-radius: 5px 5px 2px 2px;
  background: var(--color-primary);
}

.usage-bar__day {
  align-self: end;
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
}

.status-donut-wrap {
  display: grid;
  grid-template-columns: 142px 1fr;
  align-items: center;
  gap: 20px;
  padding: 29px 21px;
}

.status-donut {
  display: grid;
  width: 140px;
  height: 140px;
  place-items: center;
  border-radius: 50%;
  background: var(--color-bg-subtle);
}

.status-donut::before {
  position: absolute;
  width: 94px;
  height: 94px;
  border-radius: 50%;
  background: var(--color-bg-base);
  content: '';
}

.status-donut div {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  text-align: center;
}

.status-donut strong {
  color: var(--color-text-heading);
  font-size: var(--font-size-metric);
}

.status-donut span {
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
}

.status-legend {
  display: grid;
  gap: 13px;
}

.status-legend > div {
  display: grid;
  grid-template-columns: 8px 1fr auto;
  align-items: center;
  gap: 7px;
}

.status-legend > div > span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-success);
}

.status-legend .is-running { background: var(--color-primary); }
.status-legend .is-waiting { background: var(--color-warning); }
.status-legend .is-failed { background: var(--color-danger); }
.status-legend label { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.status-legend strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.status-legend small { grid-column: 2 / -1; color: var(--color-text-muted); font-size: var(--font-size-badge); }

.attention-list,
.audit-summary-list {
  padding: 4px 0;
}

.attention-list article,
.audit-summary-list article {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  min-height: 68px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--color-border);
}

.attention-list article:last-child,
.audit-summary-list article:last-child {
  border-bottom: 0;
}

.attention-icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: var(--radius-button);
  color: var(--color-warning-strong);
  background: var(--color-warning-light);
  font-size: var(--font-size-badge);
  font-weight: var(--font-weight-heading);
}

.attention-icon--blocked { color: var(--color-danger-strong); background: var(--color-danger-light); }
.attention-icon--info { color: var(--color-primary); background: var(--color-primary-light); }
.attention-list strong,
.audit-summary-list strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.attention-list p,
.audit-summary-list p { margin: 4px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.45; }

.audit-summary-list article {
  grid-template-columns: 8px minmax(0, 1fr) auto;
}

.audit-summary-list__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-success);
}

.audit-summary-list__dot.is-failed { background: var(--color-danger); }
.audit-summary-list__dot.is-blocked { background: var(--color-warning); }

@media (max-width: 1180px) {
  .overview-main-grid { grid-template-columns: 1fr; }
}

@media (max-width: 860px) {
  .overview-bottom-grid { grid-template-columns: 1fr; }
}

@media (max-width: 600px) {
  .status-donut-wrap { grid-template-columns: 1fr; justify-items: center; }
  .status-legend { width: 100%; }
}
</style>
