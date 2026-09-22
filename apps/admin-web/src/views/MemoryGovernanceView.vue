<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, View } from '@element-plus/icons-vue'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { ControlledMemoryCandidate } from '@/types/domain'

const auth = useAuthStore()
const candidates = ref<ControlledMemoryCandidate[]>([])
const loading = ref(false)
const error = ref('')
const filter = ref<'all' | ControlledMemoryCandidate['status']>('pending')
const selected = ref<ControlledMemoryCandidate | null>(null)
const detailOpen = ref(false)
const visible = computed(() => filter.value === 'all' ? candidates.value : candidates.value.filter(item => item.status === filter.value))

const statusLabels: Record<ControlledMemoryCandidate['status'], string> = {
  pending: '待审核', approved: '已发布', rejected: '已拒绝', withdrawn: '已撤回',
}
const statusTypes: Record<ControlledMemoryCandidate['status'], 'warning' | 'success' | 'danger' | 'info'> = {
  pending: 'warning', approved: 'success', rejected: 'danger', withdrawn: 'info',
}
const kindLabels = { preference: '稳定偏好', experience: '可复用经验' } as const
const visibilityLabels = { private: '仅本人', workspace: '工作空间', organization: '组织范围' } as const

async function load() {
  loading.value = true
  error.value = ''
  try { candidates.value = await adminApi.getMemoryCandidates() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loading.value = false }
}

function openDetail(item: ControlledMemoryCandidate) {
  selected.value = item
  detailOpen.value = true
}

async function review(item: ControlledMemoryCandidate, decision: 'approved' | 'rejected') {
  const verb = decision === 'approved' ? '发布' : '拒绝'
  await ElMessageBox.confirm(
    `${verb}“${item.title}”？发布后只按已声明范围和 Agent Version 检索，不能作为权威业务事实。`,
    `${verb}记忆候选`,
    { confirmButtonText: verb, cancelButtonText: '取消', type: decision === 'approved' ? 'warning' : 'error' },
  )
  try {
    await adminApi.reviewMemoryCandidate(item.id, {
      decision,
      resolutionKey: `admin:${item.id}:${decision}`,
      comment: decision === 'approved' ? '已确认来源、范围、可使用期限和非权威边界' : '内容不适合作为受控记忆',
    })
    ElMessage.success(decision === 'approved' ? '已发布受控记忆版本' : '已拒绝记忆候选')
    detailOpen.value = false
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : String(cause))
  }
}

function formatTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—'
}

onMounted(load)
</script>

<template>
  <div class="ops-page memory-page">
    <el-alert
      title="受控记忆仅保存经用户明确授权、管理员审核的稳定偏好或经验。业务事实、文档原文和聊天历史不进入此处。"
      type="info"
      show-icon
      :closable="false"
    />
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-select v-model="filter" aria-label="记忆候选状态" style="width: 150px">
          <el-option label="全部状态" value="all" />
          <el-option v-for="(label, status) in statusLabels" :key="status" :label="label" :value="status" />
        </el-select>
        <el-button class="refresh-button" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </section>

    <section class="content-panel content-panel--flush">
      <el-table v-loading="loading" :data="visible" empty-text="暂无受控记忆候选">
        <el-table-column prop="title" label="标题" min-width="190" show-overflow-tooltip />
        <el-table-column label="类型" width="110"><template #default="{ row }">{{ kindLabels[row.kind as ControlledMemoryCandidate['kind']] }}</template></el-table-column>
        <el-table-column label="使用范围" width="115"><template #default="{ row }">{{ visibilityLabels[row.visibility as ControlledMemoryCandidate['visibility']] }}</template></el-table-column>
        <el-table-column prop="submittedBy" label="提交人" min-width="120" />
        <el-table-column label="可使用至" min-width="155"><template #default="{ row }">{{ formatTime(row.retentionUntil) }}</template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusTypes[row.status as ControlledMemoryCandidate['status']]">{{ statusLabels[row.status as ControlledMemoryCandidate['status']] }}</el-tag></template></el-table-column>
        <el-table-column label="提交时间" min-width="155"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
        <el-table-column label="操作" fixed="right" width="190">
          <template #default="{ row }">
            <el-button link :icon="View" @click="openDetail(row)">查看</el-button>
            <template v-if="row.status === 'pending' && auth.canManage">
              <el-button link type="primary" @click="review(row, 'approved')">发布</el-button>
              <el-button link type="danger" @click="review(row, 'rejected')">拒绝</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="detailOpen" title="记忆候选详情" width="min(680px, 92vw)">
      <template v-if="selected">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="标题" :span="2">{{ selected.title }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ kindLabels[selected.kind] }}</el-descriptions-item>
          <el-descriptions-item label="范围">{{ visibilityLabels[selected.visibility] }}</el-descriptions-item>
          <el-descriptions-item label="来源授权">{{ selected.consentId }}</el-descriptions-item>
          <el-descriptions-item label="可使用至">{{ formatTime(selected.retentionUntil) }}</el-descriptions-item>
          <el-descriptions-item label="内容摘要" :span="2"><code>{{ selected.contentDigest }}</code></el-descriptions-item>
          <el-descriptions-item label="候选内容" :span="2"><p class="memory-content">{{ selected.content }}</p></el-descriptions-item>
        </el-descriptions>
      </template>
      <template #footer>
        <el-button @click="detailOpen = false">关闭</el-button>
        <template v-if="selected?.status === 'pending' && auth.canManage">
          <el-button type="danger" plain @click="review(selected, 'rejected')">拒绝</el-button>
          <el-button type="primary" @click="review(selected, 'approved')">发布</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.memory-page { display: grid; gap: var(--space-4); }
.refresh-button { margin-left: auto; }
.memory-content { margin: 0; white-space: pre-wrap; line-height: 1.65; }
code { overflow-wrap: anywhere; color: var(--color-text-secondary); font-family: var(--font-family-mono); font-size: var(--font-size-badge); }
</style>
