<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'

import { AdminApiError, adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { McpReconciliationItem, McpReconciliationPage } from '@/types/domain'

type Status = 'pending' | 'resolved'

const NOTE_LIMIT = 1000

const auth = useAuthStore()
/** 与服务端平台管理员口径（F-04）一致：admin:* 或 admin:write。 */
const canResolve = computed(() => auth.canManage)

const status = ref<Status>('pending')
const connectorId = ref('all')
const page = ref<McpReconciliationPage | null>(null)
const loading = ref(false)
const error = ref('')
let loadToken = 0

const target = ref<McpReconciliationItem | null>(null)
const dialogVisible = ref(false)
const verdict = ref<'success' | 'failed' | ''>('')
const note = ref('')
const submitting = ref(false)
const dialogError = ref('')
const conflicted = ref(false)
const conflictItem = ref<McpReconciliationItem | null>(null)

const dialogOpen = computed({
  get: () => dialogVisible.value,
  set: (open) => { if (open || !submitting.value) dialogVisible.value = open },
})
const scopedConnectors = computed(() => (page.value?.connectors ?? []).filter(item => connectorId.value === 'all' || item.id === connectorId.value))
const pendingCount = computed(() => scopedConnectors.value.reduce((sum, item) => sum + item.pendingCount, 0))
const resolvedCount = computed(() => scopedConnectors.value.reduce((sum, item) => sum + item.resolvedCount, 0))
const items = computed(() => page.value?.items ?? [])
const total = computed(() => status.value === 'pending' ? pendingCount.value : resolvedCount.value)
const truncated = computed(() => total.value > items.value.length)
const noteLength = computed(() => note.value.trim().length)
const noteOver = computed(() => noteLength.value > NOTE_LIMIT)
const noteBlank = computed(() => note.value.length > 0 && noteLength.value === 0)
const submitDisabled = computed(() => submitting.value || !verdict.value || noteLength.value === 0 || noteOver.value)
const emptyText = computed(() => status.value === 'pending' ? '没有待核对的调用' : '还没有登记记录')

async function load() {
  const current = ++loadToken
  loading.value = true
  error.value = ''
  try {
    const result = await adminApi.getMcpReconciliation(status.value, connectorId.value)
    if (current === loadToken) page.value = result
  } catch (cause) {
    if (current !== loadToken) return
    page.value = null
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === loadToken) loading.value = false
  }
}

function openDialog(item: McpReconciliationItem) {
  target.value = item
  dialogVisible.value = true
  verdict.value = ''
  note.value = ''
  dialogError.value = ''
  conflicted.value = false
  conflictItem.value = null
}

async function submit() {
  const item = target.value
  if (!item || !verdict.value || submitDisabled.value) return
  submitting.value = true
  dialogError.value = ''
  try {
    await adminApi.resolveMcpInvocation(item.id, { result: verdict.value, note: note.value.trim() })
    dialogVisible.value = false
    ElMessage.success(`已登记为${verdict.value === 'success' ? '已生效' : '未生效'}。平台没有查询外部系统，也没有发起重试。`)
    if (status.value === 'resolved') await load()
    else status.value = 'resolved'
  } catch (cause) {
    await handleSubmitError(item, cause)
  } finally {
    submitting.value = false
  }
}

async function handleSubmitError(item: McpReconciliationItem, cause: unknown) {
  if (cause instanceof AdminApiError && cause.status === 409) {
    conflicted.value = true
    void load()
    const resolved = await adminApi.getMcpReconciliation('resolved', item.connectorId).catch(() => null)
    conflictItem.value = resolved?.items.find(entry => entry.id === item.id) ?? null
    return
  }
  if (cause instanceof AdminApiError && cause.status === 404) {
    dialogVisible.value = false
    ElMessage.error('这条调用记录不存在，列表已刷新。')
    void load()
    return
  }
  dialogError.value = cause instanceof AdminApiError
    ? `${cause.message}。登记没有保存，已填写的内容仍保留。`
    : '提交失败，登记没有保存。请检查网络后重试，已填写的内容仍保留。'
}

async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value)
    ElMessage.success(`已复制 ${label}`)
  } catch {
    ElMessage.error('复制失败，请手动选择文本')
  }
}

function verdictLabel(value: McpReconciliationItem['resolvedResult']) {
  return value === 'success' ? '已生效' : '未生效'
}
function executorLabel(item: McpReconciliationItem) {
  return item.executorName ?? item.executorPrincipalId ?? '历史记录未归因'
}
function formatTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}
function connectorOptionLabel(item: McpReconciliationPage['connectors'][number]) {
  return `${item.name}${item.deleted ? '（已删除）' : ''}`
}

watch([status, connectorId], load)
onMounted(load)
</script>

<template>
  <div class="ops-page reconciliation-page">
    <el-alert v-if="!canResolve" type="info" show-icon :closable="false" title="当前账号可以查看对账记录。登记结论需要平台管理权限。" />

    <section class="content-panel filter-panel">
      <p class="reconciliation-intro">这些调用已发出但没有等到响应，外部写入可能已经发生。先到外部系统核实，再登记结论。</p>
      <div class="filter-bar">
        <el-select v-model="connectorId" aria-label="按连接器筛选" style="width: 260px">
          <el-option label="全部连接器" value="all" />
          <el-option v-for="item in page?.connectors ?? []" :key="item.id" :label="connectorOptionLabel(item)" :value="item.id" />
        </el-select>
        <el-button class="refresh-button" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
      <div class="status-tabs" role="tablist" aria-label="对账分组">
        <button class="status-tab" :class="{ active: status === 'pending' }" type="button" role="tab" :aria-selected="status === 'pending'" @click="status = 'pending'">待核对 {{ page ? pendingCount : '' }}</button>
        <button class="status-tab" :class="{ active: status === 'resolved' }" type="button" role="tab" :aria-selected="status === 'resolved'" @click="status = 'resolved'">已登记 {{ page ? resolvedCount : '' }}</button>
      </div>
    </section>

    <section class="content-panel content-panel--flush">
      <div v-if="error" class="reconciliation-state" role="alert">
        <strong>调用审计加载失败</strong>
        <p>{{ error }}。暂时无法确认是否有待核对的调用，请不要据此判断没有待办。</p>
        <el-button @click="load">重新加载</el-button>
      </div>
      <el-table v-else v-loading="loading" class="data-table" :data="items" :empty-text="loading ? '加载中' : emptyText">
        <el-table-column label="连接器 / 工具" min-width="220">
          <template #default="{ row }">
            <strong>{{ row.capabilityName }}</strong>
            <div class="reconciliation-muted">{{ row.connectorName }}<el-tag v-if="row.connectorDeleted" size="small" type="info" class="reconciliation-tag">已删除</el-tag></div>
            <code :title="row.parameterDigest">参数摘要 {{ row.parameterDigest.slice(0, 12) }}</code>
          </template>
        </el-table-column>
        <el-table-column label="发起人 / 执行身份" min-width="160">
          <template #default="{ row }">
            <div>{{ row.actorName ?? row.actorUserId }}</div>
            <div class="reconciliation-muted">{{ executorLabel(row) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="Run / Attempt" min-width="220">
          <template #default="{ row }">
            <div class="reconciliation-id"><code :title="row.runId">{{ row.runId }}</code><el-button link type="primary" :aria-label="`复制 Run ID ${row.runId}`" @click="copy(row.runId, 'Run ID')">复制</el-button></div>
            <div class="reconciliation-id"><code :title="row.attemptId">{{ row.attemptId }}</code><el-button link type="primary" :aria-label="`复制 Attempt ID ${row.attemptId}`" @click="copy(row.attemptId, 'Attempt ID')">复制</el-button></div>
          </template>
        </el-table-column>
        <el-table-column label="发生时间" width="170"><template #default="{ row }">{{ formatTime(row.occurredAt) }}</template></el-table-column>
        <el-table-column label="原始结果" width="100"><template #default><el-tag type="warning">结果未知</el-tag></template></el-table-column>
        <template v-if="status === 'resolved'">
          <el-table-column label="核对结论" width="100"><template #default="{ row }"><el-tag :type="row.resolvedResult === 'success' ? 'success' : 'info'">{{ verdictLabel(row.resolvedResult) }}</el-tag></template></el-table-column>
          <el-table-column label="操作人 / 时间" min-width="170">
            <template #default="{ row }">
              <div>{{ row.resolvedByName ?? row.resolvedBy }}</div>
              <div class="reconciliation-muted">{{ formatTime(row.resolvedAt) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="依据" min-width="240"><template #default="{ row }"><span class="reconciliation-note">{{ row.resolutionNote }}</span></template></el-table-column>
        </template>
        <el-table-column v-else label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button v-if="canResolve" link type="primary" @click="openDialog(row)">登记结论</el-button>
            <span v-else class="reconciliation-muted">需要管理权限</span>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="truncated && !error" class="reconciliation-limit">共 {{ total }} 条，这里显示最近 {{ items.length }} 条。登记后刷新可看到更早的记录。</p>
    </section>

    <el-dialog v-model="dialogOpen" title="登记核对结论" width="min(620px, calc(100vw - 32px))" :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" destroy-on-close>
      <template v-if="target">
        <dl class="reconciliation-facts">
          <dt>工具</dt><dd>{{ target.capabilityName }} · {{ target.connectorName }}</dd>
          <dt>发起人</dt><dd>{{ target.actorName ?? target.actorUserId }}</dd>
          <dt>执行身份</dt><dd>{{ executorLabel(target) }}</dd>
          <dt>Run</dt><dd><code>{{ target.runId }} / {{ target.attemptId }}</code></dd>
          <dt>发生时间</dt><dd>{{ formatTime(target.occurredAt) }}</dd>
          <dt>参数摘要</dt><dd><code class="reconciliation-digest">{{ target.parameterDigest }}</code></dd>
        </dl>

        <template v-if="conflicted">
          <el-alert type="error" show-icon :closable="false" title="该调用不是待核对状态">
            <template v-if="conflictItem">
              <p>已由{{ conflictItem.resolvedByName ?? conflictItem.resolvedBy }}于 {{ formatTime(conflictItem.resolvedAt) }} 登记为{{ verdictLabel(conflictItem.resolvedResult) }}，列表已刷新。</p>
              <p>依据：{{ conflictItem.resolutionNote }}</p>
            </template>
            <p v-else>它可能已被其他管理员登记，列表已刷新，请到“已登记”查看。</p>
          </el-alert>
          <p class="reconciliation-muted">你这次填写的依据没有提交，可以复制留存：</p>
          <div class="reconciliation-draft">{{ note }}</div>
        </template>

        <template v-else>
          <el-alert type="info" show-icon :closable="false" title="这里只记录你的核对结论：平台不会查询外部系统，也不会自动重试。请先在外部系统完成核实。提交后不能修改或撤销。" />
          <fieldset class="reconciliation-fieldset">
            <legend>外部系统的实际结果</legend>
            <el-radio-group v-model="verdict" :disabled="submitting">
              <el-radio value="success">已生效：外部系统里能查到这次写入</el-radio>
              <el-radio value="failed">未生效：外部系统里确认没有这次写入</el-radio>
            </el-radio-group>
          </fieldset>
          <el-alert v-if="verdict === 'success'" type="warning" show-icon :closable="false" title="登记后这次 Run 继续禁止重试，防止重复写入。业务上还需要继续时，请发起新任务。" />
          <el-alert v-if="verdict === 'failed'" type="info" show-icon :closable="false" title="登记后平台不再拦截这次 Run 的重试，是否重试由发起人决定。" />
          <div class="reconciliation-note-field">
            <div class="reconciliation-note-head">
              <label for="reconciliation-note">核对依据</label>
              <span :class="{ 'reconciliation-error': noteOver }">{{ noteLength }} / {{ NOTE_LIMIT }}</span>
            </div>
            <el-input id="reconciliation-note" v-model="note" type="textarea" :rows="4" :disabled="submitting" placeholder="例如：外部系统中的回执号、查询到的状态和核对时间" />
            <p :class="noteOver || noteBlank ? 'reconciliation-error' : 'reconciliation-muted'">
              {{ noteOver ? '依据不能超过 1000 字，请精简后再提交。' : noteBlank ? '只有空格不算填写，请写明核对依据。' : '必填，1～1000 字，首尾空格不计入。' }}
            </p>
          </div>
          <el-alert v-if="dialogError" type="error" show-icon :closable="false" :title="dialogError" />
        </template>
      </template>
      <template #footer>
        <el-button v-if="conflicted" @click="dialogOpen = false">关闭</el-button>
        <template v-else>
          <el-button :disabled="submitting" @click="dialogOpen = false">取消</el-button>
          <el-button type="primary" :disabled="submitDisabled" :loading="submitting" @click="submit">确认登记</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.reconciliation-intro { margin: 0 0 12px; color: var(--color-text-secondary); font-size: var(--font-size-body); }
.refresh-button { margin-left: auto; }
.status-tabs { margin-top: 12px; }
code { color: var(--color-text-secondary); font-family: var(--font-family-mono); font-size: var(--font-size-badge); }
.reconciliation-muted { margin: 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.reconciliation-tag { margin-left: 6px; }
.reconciliation-id { display: flex; gap: 8px; align-items: center; }
.reconciliation-id code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reconciliation-note, .reconciliation-draft { white-space: pre-wrap; overflow-wrap: anywhere; }
.reconciliation-limit { margin: 0; padding: 10px 16px; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.reconciliation-state { padding: 48px 16px; text-align: center; }
.reconciliation-state strong { color: var(--color-text-heading); }
.reconciliation-state p { margin: 6px 0 12px; color: var(--color-text-secondary); }
.reconciliation-facts { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 4px 10px; margin: 0 0 12px; padding: 10px 12px; border-radius: var(--radius-button); background: var(--color-bg-page); }
.reconciliation-facts dt { color: var(--color-text-secondary); }
.reconciliation-facts dd { margin: 0; }
.reconciliation-digest { overflow-wrap: anywhere; }
.reconciliation-fieldset { margin: 12px 0; padding: 0; border: 0; }
.reconciliation-fieldset legend { margin-bottom: 6px; padding: 0; color: var(--color-text-heading); font-weight: var(--font-weight-title); }
.reconciliation-fieldset .el-radio-group { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.reconciliation-note-field { margin: 12px 0; }
.reconciliation-note-head { display: flex; justify-content: space-between; margin-bottom: 4px; }
.reconciliation-note-head label { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
.reconciliation-note-field p { margin: 4px 0 0; font-size: var(--font-size-caption); }
.reconciliation-error { color: var(--color-danger-strong); }
.reconciliation-draft { padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-button); }
</style>
