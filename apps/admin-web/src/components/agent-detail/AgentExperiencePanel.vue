<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import type { ExperienceIterationApplication } from '@/types/domain'

type Status = ExperienceIterationApplication['status']

const props = defineProps<{ agentId: string; canManage: boolean }>()

const statusLabels: Record<Status, string> = { pending: '待审核', approved: '已发布', rejected: '已拒绝' }
const filters: Array<{ id: 'all' | Status; label: string }> = [
  { id: 'pending', label: '待审核' },
  { id: 'approved', label: '已发布' },
  { id: 'rejected', label: '已拒绝' },
  { id: 'all', label: '全部' },
]

const applications = ref<ExperienceIterationApplication[]>([])
const filter = ref<'all' | Status>('pending')
const loading = ref(false)
const loadError = ref('')
const selected = ref<ExperienceIterationApplication | null>(null)
const detailOpen = ref(false)
const comment = ref('')
const reviewing = ref<'' | 'approved' | 'rejected'>('')
const rejectAttempted = ref(false)

const counts = computed(() => {
  const result: Record<'all' | Status, number> = { all: applications.value.length, pending: 0, approved: 0, rejected: 0 }
  for (const item of applications.value) result[item.status] += 1
  return result
})
const visible = computed(() => filter.value === 'all'
  ? applications.value
  : applications.value.filter(item => item.status === filter.value))
const rejectNoteMissing = computed(() => rejectAttempted.value && !comment.value.trim())

async function load() {
  loading.value = true
  try {
    applications.value = await adminApi.getExperienceIterationApplications(props.agentId)
    loadError.value = ''
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : '无法读取经验申请'
  } finally {
    loading.value = false
  }
}

function open(item: ExperienceIterationApplication) {
  selected.value = item
  comment.value = ''
  rejectAttempted.value = false
  detailOpen.value = true
}

/** 批准只创建不可变经验版本；拒绝必须写明原因，随申请保存。 */
async function review(decision: 'approved' | 'rejected') {
  const item = selected.value
  if (!item) return
  if (decision === 'rejected') {
    rejectAttempted.value = true
    if (!comment.value.trim()) return
  }
  reviewing.value = decision
  try {
    await adminApi.reviewExperienceIterationApplication(item.id, {
      decision,
      resolutionKey: `admin:${item.id}:${decision}`,
      comment: comment.value.trim() || (decision === 'approved'
        ? '已核对来源 Run/Attempt、Agent 归属和非权威经验边界' : undefined),
    })
    ElMessage.success(decision === 'approved' ? '已发布 Agent 经验版本' : '已拒绝经验申请')
    detailOpen.value = false
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '审核失败')
  } finally {
    reviewing.value = ''
  }
}

function formatTime(value: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : value
}

function tagStatus(value: Status) {
  return value === 'approved' ? 'published' : value === 'pending' ? 'awaiting_approval' : value
}

watch(() => props.agentId, load)
onMounted(load)
</script>

<template>
  <section class="detail-section" aria-label="经验">
    <header class="detail-section__head">
      <div>
        <h3>经验</h3>
        <p>Agent 在成功的运行中提出可复用的做法，经你审核后发布为不可变经验版本，供后续运行检索参考。经验不会修改 SOUL.md、Skill、工具或权限，也不是业务事实的来源。</p>
      </div>
      <div class="experience-head__actions">
        <router-link class="global-link" to="/experience-iterations">所有 Agent 的经验审核</router-link>
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </header>

    <div class="status-tabs experience-tabs" role="tablist" aria-label="经验申请状态">
      <button v-for="item in filters" :key="item.id" class="status-tab" :class="{ active: filter === item.id }" type="button" role="tab" :aria-selected="filter === item.id" @click="filter = item.id">
        {{ item.label }} <span class="tab-count">{{ counts[item.id] }}</span>
      </button>
    </div>

    <el-alert v-if="loadError" type="error" :closable="false" :title="loadError">
      <el-button link type="primary" @click="load">重新读取</el-button>
    </el-alert>
    <el-table v-else v-loading="loading" class="data-table" :data="visible" :empty-text="filter === 'pending' ? '没有待审核的经验申请' : '暂无经验申请'">
      <el-table-column label="申请" min-width="260">
        <template #default="{ row }"><div class="primary-cell"><strong>{{ row.title }}</strong><small>{{ row.content }}</small></div></template>
      </el-table-column>
      <el-table-column label="来源版本" width="100"><template #default="{ row }"><span class="mono">v{{ row.sourceAgentVersion }}</span></template></el-table-column>
      <el-table-column label="来源 Run" min-width="160" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ row.sourceRunId }}</span></template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="tagStatus(row.status)" :label="statusLabels[row.status as Status]" /></template></el-table-column>
      <el-table-column label="申请时间" width="165"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" data-action="open-experience" @click="open(row)">{{ row.status === 'pending' && canManage ? '审核' : '查看' }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="detailOpen" title="经验申请" width="min(720px, 92vw)" append-to-body>
      <template v-if="selected">
        <dl class="meta-grid">
          <div><dt>来源版本</dt><dd class="mono">v{{ selected.sourceAgentVersion }}</dd></div>
          <div><dt>状态</dt><dd>{{ statusLabels[selected.status] }}</dd></div>
          <div class="meta-grid__wide"><dt>来源 Run / Attempt</dt><dd class="mono">{{ selected.sourceRunId }} / {{ selected.sourceAttemptId }}</dd></div>
          <div class="meta-grid__wide"><dt>内容摘要</dt><dd class="mono">{{ selected.contentDigest }}</dd></div>
        </dl>
        <h4 class="experience-title">{{ selected.title }}</h4>
        <p class="experience-content">{{ selected.content }}</p>
        <p v-if="selected.reviewComment" class="hint">审核说明：{{ selected.reviewComment }}</p>
        <p v-if="selected.publishedVersionId" class="hint">经验版本：<span class="mono">{{ selected.publishedVersionId }}</span></p>
        <el-form v-if="selected.status === 'pending' && canManage" label-position="top" class="review-form" @submit.prevent>
          <el-form-item label="审核说明">
            <el-input v-model="comment" type="textarea" :rows="2" :maxlength="1000" show-word-limit aria-label="审核说明" placeholder="批准时选填；拒绝时说明为什么不适合作为可复用经验" />
            <p v-if="rejectNoteMissing" class="field-error" role="alert">拒绝时必须填写原因</p>
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="detailOpen = false">关闭</el-button>
        <template v-if="selected?.status === 'pending' && canManage">
          <el-button type="danger" plain :loading="reviewing === 'rejected'" :disabled="reviewing !== ''" @click="review('rejected')">拒绝</el-button>
          <el-button type="primary" :loading="reviewing === 'approved'" :disabled="reviewing !== ''" @click="review('approved')">批准并发布</el-button>
        </template>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.experience-head__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.global-link { color: var(--color-primary); font-size: var(--font-size-badge); white-space: nowrap; }
.experience-tabs { margin-bottom: 12px; flex-wrap: wrap; }
.primary-cell { display: flex; min-width: 0; flex-direction: column; }
.primary-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.primary-cell small { max-width: 440px; margin-top: 4px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: monospace; overflow-wrap: anywhere; }
.meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; margin: 0 0 12px; }
.meta-grid > div { padding: 7px 0; border-bottom: 1px solid var(--color-border); }
.meta-grid__wide { grid-column: 1 / -1; }
.meta-grid dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.meta-grid dd { margin: 3px 0 0; font-size: var(--font-size-caption); }
.experience-title { margin: 12px 0 6px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.experience-content { margin: 0; padding: 10px 12px; border-radius: var(--radius-button); background: var(--color-bg-subtle); font-size: var(--font-size-caption); line-height: 1.65; white-space: pre-wrap; }
.hint { margin: 8px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.review-form { margin-top: 14px; }
.field-error { width: 100%; margin: 5px 0 0; color: var(--color-danger); font-size: var(--font-size-badge); }
@media (max-width: 640px) { .meta-grid { grid-template-columns: 1fr; } }
</style>
