<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Connection, Cpu, DataBoard, Files, Refresh, Service } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'

const contentStore = useContentStore()
const healthyCount = computed(() => contentStore.health.filter((item) => item.status === 'healthy').length)
const offlineCount = computed(() => contentStore.health.filter((item) => item.status === 'offline').length)
const warningCount = computed(() => contentStore.health.filter((item) => item.status === 'warning').length)
const summaryState = computed(() => offlineCount.value > 0 ? 'offline' : warningCount.value > 0 ? 'warning' : 'healthy')
const summaryTitle = computed(() => {
  if (summaryState.value === 'offline') return '系统存在离线组件'
  if (summaryState.value === 'warning') return '系统处于降级状态'
  return '系统运行正常'
})

const icons = {
  'health-app': Service,
  'health-worker': Cpu,
  'health-model': Connection,
  'health-connector': Connection,
  'health-postgres': DataBoard,
  'health-storage': Files,
} as const

async function refresh() {
  await contentStore.load(true)
  ElMessage.success('系统状态已刷新')
}

onMounted(() => contentStore.load())
</script>

<template>
  <div class="ops-page health-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-button @click="$router.push('/assistant?context=operations')">交给管理助手</el-button>
        <el-button class="refresh-button" :icon="Refresh" :loading="contentStore.loading" data-action="refresh-health" @click="refresh">立即刷新</el-button>
      </div>
    </section>

    <section class="health-summary content-panel">
      <div class="health-summary__status" :class="`health-summary__status--${summaryState}`"><span><i></i></span><div><strong>{{ summaryTitle }}</strong><p>{{ healthyCount }} / {{ contentStore.health.length }} 个组件健康，{{ warningCount }} 个降级，{{ offlineCount }} 个离线</p></div></div>
    </section>

    <section v-loading="contentStore.loading" class="health-grid">
      <el-empty v-if="!contentStore.loading && !contentStore.health.length" description="暂无组件健康数据" />
      <template v-else>
        <article v-for="component in contentStore.health" :key="component.id" class="health-card content-panel" :class="`health-card--${component.status}`">
          <div class="health-card__top"><span class="health-card__icon"><el-icon><component :is="icons[component.id as keyof typeof icons] ?? Service" /></el-icon></span><StatusTag :status="component.status" dot /></div>
          <h2>{{ component.name }}</h2>
          <p>{{ component.message }}</p>
          <dl><div><dt>当前状态</dt><dd>{{ component.detail }}</dd></div></dl>
          <footer><span>{{ component.category === 'application' ? 'dsh-work 应用' : component.category === 'runtime' ? '独立执行进程' : '外部/共享依赖' }}</span><small>{{ component.checkedAt }}</small></footer>
        </article>
      </template>
    </section>

  </div>
</template>

<style scoped>
.refresh-button { margin-left: auto; }
.health-summary { display: flex; align-items: center; gap: 30px; padding: 18px 20px; }
.health-summary__status { display: flex; align-items: center; gap: 13px; }
.health-summary__status > span { display: grid; width: 44px; height: 44px; place-items: center; border-radius: 50%; background: var(--color-success-light); }
.health-summary__status i { width: 16px; height: 16px; border: 4px solid var(--color-success); border-radius: 50%; }
.health-summary__status strong { color: var(--color-success-strong); font-size: var(--font-size-title); }
.health-summary__status--warning > span { background: var(--color-warning-light); }
.health-summary__status--warning i { border-color: var(--color-warning); }
.health-summary__status--warning strong { color: var(--color-warning-strong); }
.health-summary__status--offline > span { background: var(--color-danger-light); }
.health-summary__status--offline i { border-color: var(--color-danger); }
.health-summary__status--offline strong { color: var(--color-danger); }
.health-summary__status p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.health-grid { display: grid; min-height: 160px; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.health-grid > .el-empty { grid-column: 1 / -1; }
.health-card { position: relative; overflow: hidden; padding: 17px; }
.health-card::before { position: absolute; top: 0; right: 0; left: 0; height: 3px; background: var(--color-success); content: ''; }
.health-card--warning::before { background: var(--color-warning); }
.health-card--offline::before { background: var(--color-danger); }
.health-card__top { display: flex; align-items: center; justify-content: space-between; }
.health-card__icon { display: grid; width: 36px; height: 36px; place-items: center; border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-header); }
.health-card h2 { margin: 15px 0 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.health-card > p { min-height: 31px; margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.55; }
.health-card dl { display: grid; grid-template-columns: 1fr; margin: 15px 0 0; padding: 11px 0; border-top: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); }
.health-card dl div { display: flex; flex-direction: column; }
.health-card dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.health-card dd { margin: 4px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.health-card footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 12px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.health-card footer small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
@media (max-width: 960px) { .health-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 640px) { .health-grid { grid-template-columns: 1fr; } }
</style>
