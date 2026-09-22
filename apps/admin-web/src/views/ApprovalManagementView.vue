<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'

import { adminApi } from '@/api/client'
import type { PersistentApproval } from '@/types/domain'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const approvals = ref<PersistentApproval[]>([])
const loading = ref(false)
const error = ref('')
const filter = ref<'all' | PersistentApproval['status']>('pending')
const visible = computed(() => filter.value === 'all' ? approvals.value : approvals.value.filter(item => item.status === filter.value))

const statusLabels: Record<PersistentApproval['status'], string> = {
  pending: '待审批', approved: '已批准', rejected: '已拒绝', expired: '已过期', cancelled: '已取消',
}
const statusTypes: Record<PersistentApproval['status'], 'warning' | 'success' | 'danger' | 'info'> = {
  pending: 'warning', approved: 'success', rejected: 'danger', expired: 'info', cancelled: 'info',
}

async function load() {
  loading.value = true
  error.value = ''
  try { approvals.value = await adminApi.getApprovals() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loading.value = false }
}

async function resolve(item: PersistentApproval, decision: 'approved' | 'rejected') {
  const verb = decision === 'approved' ? '批准' : '拒绝'
  await ElMessageBox.confirm(
    `${verb}动作“${item.actionName}”？本次决定只绑定当前参数摘要、资源和数据版本。`,
    `${verb}动作`,
    { confirmButtonText: verb, cancelButtonText: '取消', type: decision === 'approved' ? 'warning' : 'error' },
  )
  try {
    await adminApi.resolveApproval(item.id, {
      decision,
      resolutionKey: `admin:${item.id}:${decision}`,
      comment: decision === 'approved' ? '管理员确认当前动作快照' : '管理员拒绝当前动作快照',
    })
    ElMessage.success(decision === 'approved' ? '已批准并创建恢复 Attempt' : '已拒绝，Run 已结束')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : String(cause))
  }
}

function formatTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—'
}
function statusLabel(value: PersistentApproval['status']) { return statusLabels[value] }
function statusType(value: PersistentApproval['status']) { return statusTypes[value] }

onMounted(load)
</script>

<template>
  <div class="ops-page approval-page">
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />
    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-select v-model="filter" aria-label="审批状态" style="width: 150px">
          <el-option label="全部状态" value="all" />
          <el-option v-for="(label, status) in statusLabels" :key="status" :label="label" :value="status" />
        </el-select>
        <el-button class="refresh-button" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </section>

    <section class="content-panel content-panel--flush">
      <el-table v-loading="loading" :data="visible" empty-text="暂无持久化动作审批">
        <el-table-column prop="actionName" label="动作" min-width="170" />
        <el-table-column prop="resourceRef" label="资源" min-width="180" show-overflow-tooltip />
        <el-table-column label="参数摘要" min-width="145"><template #default="{ row }"><code>{{ row.parameterDigest.slice(0, 12) }}</code></template></el-table-column>
        <el-table-column prop="executionIdentity" label="执行身份" min-width="130" />
        <el-table-column prop="dataVersion" label="数据版本" min-width="145" show-overflow-tooltip />
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
        <el-table-column label="申请时间" min-width="165"><template #default="{ row }">{{ formatTime(row.requestedAt) }}</template></el-table-column>
        <el-table-column label="有效期" min-width="165"><template #default="{ row }">{{ formatTime(row.expiresAt) }}</template></el-table-column>
        <el-table-column label="操作" fixed="right" width="150">
          <template #default="{ row }">
            <template v-if="row.status === 'pending' && auth.canManage">
              <el-button link type="primary" @click="resolve(row, 'approved')">批准</el-button>
              <el-button link type="danger" @click="resolve(row, 'rejected')">拒绝</el-button>
            </template>
            <span v-else>{{ row.status === 'pending' ? '仅平台管理员可处理' : '已处理' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<style scoped>
.refresh-button { margin-left: auto; }
code { color: var(--color-text-secondary); font-family: var(--font-family-mono); font-size: var(--font-size-badge); }
</style>
