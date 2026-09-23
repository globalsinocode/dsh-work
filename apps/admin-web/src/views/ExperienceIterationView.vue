<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Search, View } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import { useListPagination } from '@/composables/use-list-pagination'
import { useAuthStore } from '@/stores/auth'
import type { ExperienceIterationAgentSummary, ExperienceIterationApplication } from '@/types/domain'

const auth = useAuthStore()
const agents = ref<ExperienceIterationAgentSummary[]>([])
const applications = ref<ExperienceIterationApplication[]>([])
const query = ref('')
const agentFilter = ref('all')
const loadingAgents = ref(false)
const loadingApplications = ref(false)
const error = ref('')
const filter = ref<'all' | ExperienceIterationApplication['status']>('pending')
const selected = ref<ExperienceIterationApplication | null>(null)
const detailOpen = ref(false)

const statusLabels: Record<ExperienceIterationApplication['status'], string> = {
  pending: '待审核', approved: '已发布', rejected: '已拒绝',
}
const filteredApplications = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return applications.value.filter(item => !keyword || [
    item.agentName,
    item.title,
    item.content,
    item.sourceRunId,
    item.sourceAttemptId,
  ].some(value => value.toLowerCase().includes(keyword)))
})
const { currentPage, pagedItems } = useListPagination(filteredApplications, {
  resetOn: [query, agentFilter, filter],
})

async function loadAgents() {
  loadingAgents.value = true
  error.value = ''
  try {
    agents.value = await adminApi.getExperienceIterationAgents()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loadingAgents.value = false
  }
}

async function loadApplications() {
  loadingApplications.value = true
  error.value = ''
  try {
    applications.value = await adminApi.getExperienceIterationApplications(
      agentFilter.value === 'all' ? undefined : agentFilter.value,
      filter.value === 'all' ? undefined : filter.value,
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loadingApplications.value = false
  }
}

async function refresh() {
  await Promise.all([loadAgents(), loadApplications()])
}

function openDetail(item: ExperienceIterationApplication) {
  selected.value = item
  detailOpen.value = true
}

async function review(item: ExperienceIterationApplication, decision: 'approved' | 'rejected') {
  const verb = decision === 'approved' ? '批准并发布' : '拒绝'
  await ElMessageBox.confirm(
    `${verb}“${item.title}”？批准后将创建当前 Agent 的不可变经验版本，仅作为非权威参考。`,
    `${verb}经验迭代申请`,
    { confirmButtonText: verb, cancelButtonText: '取消', type: decision === 'approved' ? 'warning' : 'error' },
  )
  try {
    await adminApi.reviewExperienceIterationApplication(item.id, {
      decision,
      resolutionKey: `admin:${item.id}:${decision}`,
      comment: decision === 'approved'
        ? '已核对来源 Run/Attempt、Agent 归属和非权威经验边界'
        : '该申请不适合作为 Agent 可复用经验',
    })
    ElMessage.success(decision === 'approved' ? '已发布 Agent 经验版本' : '已拒绝经验迭代申请')
    detailOpen.value = false
    await refresh()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : String(cause))
  }
}

function formatTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—'
}

function statusTagStatus(value: ExperienceIterationApplication['status']) {
  return value === 'approved' ? 'published' : value === 'pending' ? 'awaiting_approval' : value
}

watch([agentFilter, filter], loadApplications)
onMounted(refresh)
</script>

<template>
  <div class="ops-page iteration-page">
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索 Agent、申请标题、内容或来源 Run" />
        <el-select v-model="agentFilter" :loading="loadingAgents" filterable aria-label="筛选 Agent">
          <el-option label="全部 Agent" value="all" />
          <el-option v-for="agent in agents" :key="agent.agentId" :label="`${agent.agentName} · v${agent.agentVersion}`" :value="agent.agentId" />
        </el-select>
        <el-select v-model="filter" aria-label="筛选经验迭代申请状态">
          <el-option label="全部状态" value="all" />
          <el-option v-for="(label, status) in statusLabels" :key="status" :label="label" :value="status" />
        </el-select>
        <span class="filter-bar__meta">{{ filteredApplications.length }} 条申请</span>
        <el-button :icon="Refresh" :loading="loadingAgents || loadingApplications" @click="refresh">刷新</el-button>
      </div>
    </section>

    <main class="content-panel content-panel--flush application-panel">
        <el-table class="data-table" v-loading="loadingApplications" :data="pagedItems" empty-text="暂无符合条件的经验迭代申请">
          <el-table-column label="Agent" min-width="190">
            <template #default="{ row }"><div class="primary-cell"><strong>{{ row.agentName }}</strong><small class="mono">{{ row.agentId }}</small></div></template>
          </el-table-column>
          <el-table-column label="申请" min-width="280">
            <template #default="{ row }"><div class="primary-cell"><strong>{{ row.title }}</strong><small>{{ row.content }}</small></div></template>
          </el-table-column>
          <el-table-column label="来源版本" width="110"><template #default="{ row }">v{{ row.sourceAgentVersion }}</template></el-table-column>
          <el-table-column label="来源 Run" min-width="170" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ row.sourceRunId }}</span></template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="statusTagStatus(row.status)" :label="statusLabels[row.status as ExperienceIterationApplication['status']]" dot /></template></el-table-column>
          <el-table-column label="申请时间" min-width="155"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="操作" fixed="right" width="220">
            <template #default="{ row }">
              <el-button link :icon="View" @click="openDetail(row)">查看</el-button>
              <template v-if="row.status === 'pending' && auth.canManage">
                <el-button link type="primary" @click="review(row, 'approved')">批准发布</el-button>
                <el-button link type="danger" @click="review(row, 'rejected')">拒绝</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
        <div class="table-footer table-footer--pager"><el-pagination v-model:current-page="currentPage" background layout="prev, pager, next" :total="filteredApplications.length" :page-size="10" /></div>
    </main>

    <el-dialog v-model="detailOpen" title="经验迭代申请详情" width="min(720px, 92vw)">
      <template v-if="selected">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="Agent">{{ selected.agentName }}</el-descriptions-item>
          <el-descriptions-item label="来源版本">v{{ selected.sourceAgentVersion }}</el-descriptions-item>
          <el-descriptions-item label="来源 Run" :span="2">{{ selected.sourceRunId }}</el-descriptions-item>
          <el-descriptions-item label="来源 Attempt" :span="2">{{ selected.sourceAttemptId }}</el-descriptions-item>
          <el-descriptions-item label="申请标题" :span="2">{{ selected.title }}</el-descriptions-item>
          <el-descriptions-item label="内容摘要" :span="2"><code>{{ selected.contentDigest }}</code></el-descriptions-item>
          <el-descriptions-item label="经验内容" :span="2"><p class="experience-content">{{ selected.content }}</p></el-descriptions-item>
          <el-descriptions-item v-if="selected.reviewComment" label="审核说明" :span="2">{{ selected.reviewComment }}</el-descriptions-item>
          <el-descriptions-item v-if="selected.publishedVersionId" label="经验版本" :span="2">{{ selected.publishedVersionId }}</el-descriptions-item>
        </el-descriptions>
      </template>
      <template #footer>
        <el-button @click="detailOpen = false">关闭</el-button>
        <template v-if="selected?.status === 'pending' && auth.canManage">
          <el-button type="danger" plain @click="review(selected, 'rejected')">拒绝</el-button>
          <el-button type="primary" @click="review(selected, 'approved')">批准并发布</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 330px; }
.filter-bar .el-select { width: 180px; }
.application-panel { min-width: 0; }
.primary-cell { display: flex; min-width: 0; flex-direction: column; }
.primary-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.primary-cell small { max-width: 440px; margin-top: 4px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.experience-content { margin: 0; white-space: pre-wrap; line-height: 1.65; }
code { overflow-wrap: anywhere; color: var(--color-text-secondary); font-family: var(--font-family-mono); font-size: var(--font-size-badge); }
@media (max-width: 760px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
