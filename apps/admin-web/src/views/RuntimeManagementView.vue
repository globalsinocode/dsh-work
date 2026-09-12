<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Cpu, Refresh, Search, Setting, View } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { RuntimeDefinition } from '@/types/domain'

interface RuntimeConfigurationForm {
  maxConcurrentWorkers: number
  attemptTimeoutMinutes: number
  schedulingStatus: RuntimeDefinition['schedulingStatus']
}

const authStore = useAuthStore()
const contentStore = useContentStore()
const query = ref('')
const environmentFilter = ref('all')
const statusFilter = ref('all')
const schedulingFilter = ref('all')
const selectedRuntime = ref<RuntimeDefinition>()
const configuringRuntime = ref<RuntimeDefinition>()
const drawerOpen = ref(false)
const configurationDialogOpen = ref(false)
const configurationFormRef = ref<FormInstance>()
const checkingId = ref('')
const savingConfiguration = ref(false)
const configurationForm = reactive<RuntimeConfigurationForm>({
  maxConcurrentWorkers: 1,
  attemptTimeoutMinutes: 30,
  schedulingStatus: 'accepting',
})
const configurationRules: FormRules<RuntimeConfigurationForm> = {
  maxConcurrentWorkers: [
    { required: true, message: '请输入最大并发 Worker 数', trigger: 'change' },
    { type: 'number', min: 1, max: 128, message: '请输入 1～128 之间的整数', trigger: 'change' },
  ],
  attemptTimeoutMinutes: [
    { required: true, message: '请输入单次执行超时时间', trigger: 'change' },
    { type: 'number', min: 1, max: 60, message: '请输入 1～60 分钟', trigger: 'change' },
  ],
  schedulingStatus: [{ required: true, message: '请选择调度状态', trigger: 'change' }],
}

const environments = computed(() =>
  [...new Set(contentStore.runtimes.map((runtime) => runtime.environment))].sort(),
)
const filteredRuntimes = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.runtimes.filter((runtime) => {
    const matchesQuery = !keyword || `${runtime.name} ${runtime.id} ${runtime.endpoint} ${runtime.version}`.toLowerCase().includes(keyword)
    const matchesEnvironment = environmentFilter.value === 'all' || runtime.environment === environmentFilter.value
    const matchesStatus = statusFilter.value === 'all' || runtime.status === statusFilter.value
    const matchesScheduling = schedulingFilter.value === 'all' || runtime.schedulingStatus === schedulingFilter.value
    return matchesQuery && matchesEnvironment && matchesStatus && matchesScheduling
  })
})
const healthyCount = computed(() => contentStore.runtimes.filter((runtime) => runtime.status === 'healthy').length)
const totalCapacity = computed(() => contentStore.runtimes.reduce((sum, runtime) => sum + runtime.maxConcurrentWorkers, 0))
const activeWorkers = computed(() => contentStore.runtimes.reduce((sum, runtime) => sum + runtime.activeWorkers, 0))
const queuedRuns = computed(() => contentStore.runtimes.reduce((sum, runtime) => sum + runtime.queuedRuns, 0))

function schedulingLabel(status: RuntimeDefinition['schedulingStatus']) {
  return {
    accepting: '接收任务',
    draining: '排空中',
    disabled: '已停用',
  }[status]
}

function schedulingTone(status: RuntimeDefinition['schedulingStatus']) {
  return {
    accepting: 'healthy',
    draining: 'warning',
    disabled: 'disabled',
  }[status]
}

function inspect(runtime: RuntimeDefinition) {
  selectedRuntime.value = runtime
  drawerOpen.value = true
}

function openConfiguration(runtime: RuntimeDefinition) {
  configuringRuntime.value = runtime
  configurationForm.maxConcurrentWorkers = runtime.maxConcurrentWorkers
  configurationForm.attemptTimeoutMinutes = runtime.attemptTimeoutMinutes
  configurationForm.schedulingStatus = runtime.schedulingStatus
  configurationDialogOpen.value = true
}

async function check(runtime: RuntimeDefinition) {
  checkingId.value = runtime.id
  try {
    const result = await contentStore.checkRuntime(runtime.id)
    if (selectedRuntime.value?.id === result.id) selectedRuntime.value = result
    if (configuringRuntime.value?.id === result.id) configuringRuntime.value = result
    if (result.status === 'offline') ElMessage.warning(result.healthMessage)
    else ElMessage.success(`${result.name} 健康检查完成`)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Runtime 检查失败')
  } finally {
    checkingId.value = ''
  }
}

async function saveConfiguration() {
  if (!configuringRuntime.value || !configurationFormRef.value) return
  const valid = await configurationFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (configurationForm.maxConcurrentWorkers < configuringRuntime.value.activeWorkers) {
    ElMessage.warning(`最大并发 Worker 数不能小于当前活动 Worker 数 ${configuringRuntime.value.activeWorkers}`)
    return
  }
  if (
    configuringRuntime.value.schedulingStatus !== 'disabled'
    && configurationForm.schedulingStatus === 'disabled'
  ) {
    try {
      await ElMessageBox.confirm(
        '停用后 Runtime 将不再接收新任务，当前执行不会被强制终止。确认继续吗？',
        '确认停用调度',
        { confirmButtonText: '确认停用', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
  }

  savingConfiguration.value = true
  try {
    const result = await contentStore.updateRuntimeConfiguration({
      runtimeId: configuringRuntime.value.id,
      maxConcurrentWorkers: configurationForm.maxConcurrentWorkers,
      attemptTimeoutMinutes: configurationForm.attemptTimeoutMinutes,
      schedulingStatus: configurationForm.schedulingStatus,
    })
    configuringRuntime.value = result
    if (selectedRuntime.value?.id === result.id) selectedRuntime.value = result
    configurationDialogOpen.value = false
    ElMessage.success(`${result.name} 配置已保存`)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Runtime 配置保存失败')
  } finally {
    savingConfiguration.value = false
  }
}

async function refresh() {
  await contentStore.load(true)
  ElMessage.success('Runtime 状态已刷新')
}

onMounted(() => contentStore.load())
</script>

<template>
  <div class="ops-page runtime-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />
    <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，只能查看 Runtime 配置及健康状态。" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索 Runtime 名称、标识、地址或版本" />
        <el-select v-model="environmentFilter" aria-label="筛选 Runtime 环境">
          <el-option label="全部环境" value="all" />
          <el-option v-for="environment in environments" :key="environment" :label="environment" :value="environment" />
        </el-select>
        <el-select v-model="statusFilter" aria-label="筛选 Runtime 健康状态">
          <el-option label="全部健康状态" value="all" />
          <el-option label="正常" value="healthy" />
          <el-option label="性能下降" value="degraded" />
          <el-option label="离线" value="offline" />
        </el-select>
        <el-select v-model="schedulingFilter" aria-label="筛选 Runtime 调度状态">
          <el-option label="全部调度状态" value="all" />
          <el-option label="接收任务" value="accepting" />
          <el-option label="排空中" value="draining" />
          <el-option label="已停用" value="disabled" />
        </el-select>
        <span class="filter-bar__meta">{{ filteredRuntimes.length }} 个 Runtime</span>
        <el-button @click="$router.push('/assistant?context=operations')">交给管理助手</el-button>
        <el-button :icon="Refresh" :loading="contentStore.loading" data-action="refresh-runtimes" @click="refresh">刷新状态</el-button>
      </div>
    </section>

    <section v-loading="contentStore.loading" class="metric-grid">
      <article class="metric-card"><div class="metric-label">登记 Runtime</div><div class="metric-value">{{ contentStore.runtimes.length }}</div><div class="metric-detail">{{ healthyCount }} 个当前健康</div></article>
      <article class="metric-card"><div class="metric-label">最大并发 Worker</div><div class="metric-value">{{ totalCapacity }}</div><div class="metric-detail">所有 Runtime 配置容量之和</div></article>
      <article class="metric-card"><div class="metric-label">活动 Worker</div><div class="metric-value">{{ activeWorkers }}</div><div class="metric-detail">正在执行 Attempt 的子进程</div></article>
      <article class="metric-card"><div class="metric-label">排队运行</div><div class="metric-value">{{ queuedRuns }}</div><div class="metric-detail">等待可用 Worker 槽位</div></article>
    </section>

    <section class="content-panel content-panel--flush runtime-table">
      <el-table class="data-table" v-loading="contentStore.loading" :data="filteredRuntimes" empty-text="暂无匹配的 Runtime" @row-click="inspect">
        <el-table-column label="Runtime" min-width="205">
          <template #default="scope"><div class="runtime-cell"><span><el-icon><Cpu /></el-icon></span><div><strong>{{ scope.row.name }}</strong><small class="mono">{{ scope.row.id }}</small></div></div></template>
        </el-table-column>
        <el-table-column prop="environment" label="环境" min-width="105" />
        <el-table-column label="健康" width="92"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column label="调度" width="105"><template #default="scope"><StatusTag :status="schedulingTone(scope.row.schedulingStatus)" :label="schedulingLabel(scope.row.schedulingStatus)" /></template></el-table-column>
        <el-table-column prop="version" label="版本" min-width="105" />
        <el-table-column label="Worker 负载" width="122"><template #default="scope">{{ scope.row.activeWorkers }} / {{ scope.row.maxConcurrentWorkers }} · 排队 {{ scope.row.queuedRuns }}</template></el-table-column>
        <el-table-column prop="lastHeartbeat" label="心跳" width="88" />
        <el-table-column label="操作" width="128" fixed="right">
          <template #default="scope">
            <el-button link type="primary" :icon="View" data-action="view-runtime" @click.stop="inspect(scope.row)">查看</el-button>
            <el-button v-if="authStore.canManage" link type="primary" :icon="Setting" data-action="configure-runtime" @click.stop="openConfiguration(scope.row)">配置</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="drawerOpen" size="min(590px, 100vw)" title="Runtime 详情">
      <template v-if="selectedRuntime">
        <div class="runtime-detail__hero"><span><el-icon><Cpu /></el-icon></span><div><h2>{{ selectedRuntime.name }}</h2><p class="mono">{{ selectedRuntime.id }}</p></div><StatusTag :status="selectedRuntime.status" /></div>
        <el-alert :type="selectedRuntime.status === 'offline' ? 'warning' : 'info'" :closable="false" show-icon :title="selectedRuntime.healthMessage" />
        <dl class="runtime-detail__rows">
          <div><dt>运行环境</dt><dd>{{ selectedRuntime.environment }}</dd></div>
          <div><dt>健康状态</dt><dd><StatusTag :status="selectedRuntime.status" /></dd></div>
          <div><dt>调度状态</dt><dd><StatusTag :status="schedulingTone(selectedRuntime.schedulingStatus)" :label="schedulingLabel(selectedRuntime.schedulingStatus)" /></dd></div>
          <div><dt>Runtime 版本</dt><dd>{{ selectedRuntime.version }}</dd></div>
          <div><dt>服务地址</dt><dd class="mono">{{ selectedRuntime.endpoint }}</dd></div>
          <div><dt>Worker 容量</dt><dd>{{ selectedRuntime.activeWorkers }} / {{ selectedRuntime.maxConcurrentWorkers }}</dd></div>
          <div><dt>单次执行超时</dt><dd>{{ selectedRuntime.attemptTimeoutMinutes }} 分钟</dd></div>
          <div><dt>排队运行</dt><dd>{{ selectedRuntime.queuedRuns }}</dd></div>
          <div><dt>最后心跳</dt><dd>{{ selectedRuntime.lastHeartbeat }}</dd></div>
          <div><dt>检查时间</dt><dd>{{ selectedRuntime.checkedAt }}</dd></div>
        </dl>
        <section class="runtime-detail__section"><h3>运行能力</h3><div class="runtime-chip-list"><span v-for="capability in selectedRuntime.capabilities" :key="capability">{{ capability }}</span></div></section>
        <div class="runtime-detail__actions">
          <el-button v-if="authStore.canManage" :icon="Setting" data-action="configure-runtime-detail" @click="openConfiguration(selectedRuntime)">配置 Runtime</el-button>
          <el-button v-if="authStore.canManage" type="primary" :loading="checkingId === selectedRuntime.id" data-action="check-runtime" @click="check(selectedRuntime)">执行健康检查</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="configurationDialogOpen" :title="`配置 Runtime：${configuringRuntime?.name ?? ''}`" width="620px" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon title="这里只配置 Runtime 的执行资源和调度行为；Agent、Skill、工具及数据权限仍在各自模块中管理。" />
      <el-form ref="configurationFormRef" class="runtime-configuration-form" :model="configurationForm" :rules="configurationRules" label-position="top">
        <el-form-item label="最大并发 Worker 数" prop="maxConcurrentWorkers">
          <el-input-number v-model="configurationForm.maxConcurrentWorkers" class="configuration-number" :min="1" :max="128" :step="1" controls-position="right" aria-label="最大并发 Worker 数" />
          <p class="field-help">控制该 Runtime 同时运行的 DSH Worker 子进程数量，不能低于当前活动 Worker 数。</p>
        </el-form-item>
        <el-form-item label="单次执行超时时间" prop="attemptTimeoutMinutes">
          <el-input-number v-model="configurationForm.attemptTimeoutMinutes" class="configuration-number" :min="1" :max="60" :step="5" controls-position="right" aria-label="单次执行超时时间（分钟）" />
          <p class="field-help">这是 Runtime 硬上限；若 Agent 超时更短则取较短值，超过后系统将终止当前 Attempt。</p>
        </el-form-item>
        <el-form-item label="调度状态" prop="schedulingStatus">
          <el-radio-group v-model="configurationForm.schedulingStatus" aria-label="Runtime 调度状态">
            <el-radio-button value="accepting">接收任务</el-radio-button>
            <el-radio-button value="draining">排空</el-radio-button>
            <el-radio-button value="disabled">停用</el-radio-button>
          </el-radio-group>
          <div class="scheduling-help" aria-live="polite">
            <strong>{{ schedulingLabel(configurationForm.schedulingStatus) }}</strong>
            <span v-if="configurationForm.schedulingStatus === 'accepting'">允许调度新的 Attempt。</span>
            <span v-else-if="configurationForm.schedulingStatus === 'draining'">不再接收新任务，等待当前 Worker 自然结束后下线。</span>
            <span v-else>不接收新任务，但不会强制终止当前 Worker。</span>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="configurationDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="savingConfiguration" data-action="save-runtime-configuration" @click="saveConfiguration">保存配置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 280px; }
.filter-bar .el-select { width: 142px; }
.runtime-cell { display: flex; min-width: 0; align-items: center; gap: 10px; cursor: pointer; }
.runtime-cell > span,
.runtime-detail__hero > span { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-header); }
.runtime-cell > div { display: flex; min-width: 0; flex-direction: column; }
.runtime-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.runtime-cell small { margin-top: 3px; }
.runtime-detail__hero { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 12px; margin-bottom: 14px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.runtime-detail__hero > span { width: 44px; height: 44px; }
.runtime-detail__hero h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.runtime-detail__hero p { margin: 4px 0 0; }
.runtime-detail__rows { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 22px; margin: 18px 0; }
.runtime-detail__rows div { padding: 11px 0; border-bottom: 1px solid var(--color-border); }
.runtime-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.runtime-detail__rows dd { margin: 5px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); overflow-wrap: anywhere; }
.runtime-detail__section h3 { margin: 0 0 9px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.runtime-chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.runtime-chip-list span { padding: 4px 7px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); }
.runtime-detail__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
.runtime-configuration-form { margin-top: 20px; }
.configuration-number { width: 100%; }
.field-help { width: 100%; margin: 6px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.5; }
.scheduling-help { display: flex; width: 100%; gap: 6px; margin-top: 10px; padding: 10px 12px; border-radius: var(--radius-button); color: var(--color-text-secondary); background: var(--color-bg-subtle); font-size: var(--font-size-badge); }
.scheduling-help strong { color: var(--color-text-heading); }
@media (max-width: 760px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
