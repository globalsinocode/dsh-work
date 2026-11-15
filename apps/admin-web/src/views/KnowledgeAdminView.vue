<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from 'vue'
import { Plus, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { KnowledgeAdminBase, KnowledgeAdminBaseList, KnowledgeAdminDepartment, KnowledgeAdminOverview } from '@/types/knowledge'

/**
 * 管理端“企业知识库”（weknora-knowledge-plan 第 9 节，WK-S3）：连接配置与健康状态、全部知识库与跨部门授权、
 * 归属部门、新建与删除。平台管理员可以授给任意部门（含全公司）并撤销任何授权；文档由归属部门的员工在员工端维护。
 */
const authStore = useAuthStore()
const canManage = computed(() => authStore.canWrite('knowledge'))

const overview = ref<KnowledgeAdminOverview | null>(null)
const baseList = ref<KnowledgeAdminBaseList>({ items: [], statsAvailable: true })
const departments = ref<KnowledgeAdminDepartment[]>([])
const loading = ref(true)
const error = ref('')
const saving = ref(false)
const activeTab = ref<'bases' | 'connection'>('bases')
const query = ref('')
const filter = ref<'all' | 'attention'>('all')

const failureLabels: Record<string, string> = {
  timeout: '超时', network: '连接失败', auth: '认证失败', rate_limited: '限流', server: '服务错误',
  protocol: '响应格式不符', request_rejected: '请求被拒绝', not_configured: '尚未配置',
  api_key_required: '更换地址须重新填写 API Key',
}

/** WeKnora 重排序结果（meta.rerank.outcome，优化方案 O5）；模型不可用与调用失败表示检索已降级为不重排。 */
const rerankLabels: Record<string, string> = {
  ok: '正常', threshold_degraded: '正常（已放宽门槛）', fallback_top1: '正常（只保留首条）', all_below_threshold: '正常（全部低于门槛）',
  no_candidates: '正常（没有候选）', no_model: '未配置重排序模型', disabled: '未启用',
  model_unavailable: '模型不可用，已降级为不重排', model_error: '调用失败，已降级为不重排',
}
const rerankDegraded = (outcome: string | null | undefined) => outcome === 'model_unavailable' || outcome === 'model_error'
/** WeKnora 的模型 ID 是 UUID；不是这个形状时多半填成了模型名称（优化方案 O8）。 */
const modelIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const connection = computed(() => overview.value?.connection)
const attentionOf = (base: KnowledgeAdminBase) => !base.ownerDepartmentActive || base.grants.length === 0 || base.needsRebuild
  || base.status === 'unavailable' || base.summaryModelConfigured === true
const activeBases = computed(() => baseList.value.items.filter(base => base.status === 'active'))
const activeBaseCount = computed(() => activeBases.value.length)
// 分项只统计有效的知识库：“原连接已更换”的单列一项，不再重复计入其他分项（PR 116 评审）。
const counts = computed(() => ({
  noGrant: activeBases.value.filter(base => base.grants.length === 0).length,
  ownerDeleted: activeBases.value.filter(base => !base.ownerDepartmentActive).length,
  rebuild: activeBases.value.filter(base => base.needsRebuild).length,
  moved: baseList.value.items.filter(base => base.status === 'unavailable').length,
  summary: activeBases.value.filter(base => base.summaryModelConfigured === true).length,
  attention: baseList.value.items.filter(attentionOf).length,
  documents: baseList.value.items.reduce((sum, base) => sum + (base.documentCount ?? 0), 0),
}))
const visibleBases = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return baseList.value.items
    .filter(base => filter.value === 'all' || attentionOf(base))
    .filter(base => !keyword || `${base.name} ${base.ownerDepartmentName}`.toLowerCase().includes(keyword))
})
const unavailableBanner = computed(() => {
  const value = connection.value
  if (!value?.enabled || !value.lastFailureAt) return ''
  if (value.lastSuccessAt && value.lastSuccessAt > value.lastFailureAt) return ''
  return `知识库服务暂不可用（${failureLabels[value.lastFailureReason ?? ''] ?? '未知原因'}，${formatDateTime(value.lastFailureAt)}）。员工的对话照常回答，并注明“企业知识库暂不可用”。`
})

function formatDateTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 到期日按本地零点保存（见 saveConnection），回显也按本地日期，避免东八区等时区回显早一天。 */
function formatLocalDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function grantLabel(grant: KnowledgeAdminBase['grants'][number]) {
  return grant.departmentName + (grant.includeDescendants && grant.departmentName !== '全公司' ? '（含下级）' : '')
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [nextOverview, nextBases, nextDepartments] = await Promise.all([
      adminApi.getKnowledgeOverview(),
      adminApi.listKnowledgeBases(),
      adminApi.listKnowledgeDepartments(),
    ])
    overview.value = nextOverview
    baseList.value = nextBases
    departments.value = nextDepartments
    resetConnectionForm()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '企业知识库读取失败'
  } finally {
    loading.value = false
  }
}

async function run<T>(action: () => Promise<T>, success: string): Promise<T | undefined> {
  saving.value = true
  try {
    const result = await action()
    ElMessage.success(success)
    return result
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '操作失败')
    return undefined
  } finally {
    saving.value = false
  }
}

// —— 可见部门 ——
const grantDialog = reactive({ open: false, baseId: '', departmentId: '', includeDescendants: true })
const grantBase = computed(() => baseList.value.items.find(base => base.id === grantDialog.baseId))
function openGrants(base: KnowledgeAdminBase) {
  Object.assign(grantDialog, { open: true, baseId: base.id, departmentId: '', includeDescendants: true })
}
async function addGrant() {
  if (!grantDialog.departmentId) return
  const result = await run(() => adminApi.addKnowledgeGrant(grantDialog.baseId, {
    departmentId: grantDialog.departmentId, includeDescendants: grantDialog.includeDescendants,
  }), '已添加可见部门')
  if (result) {
    baseList.value = result
    grantDialog.departmentId = ''
  }
}
async function revokeGrant(grantId: string) {
  const result = await run(() => adminApi.revokeKnowledgeGrant(grantDialog.baseId, grantId), '已撤销')
  if (result) baseList.value = result
}

// —— 归属部门 ——
const ownerDialog = reactive({ open: false, baseId: '', departmentId: '' })
const ownerOptions = computed(() => departments.value.filter(item => !item.root))
function openOwner(base: KnowledgeAdminBase) {
  Object.assign(ownerDialog, { open: true, baseId: base.id, departmentId: base.ownerDepartmentActive ? base.ownerDepartmentId : '' })
}
async function saveOwner() {
  if (!ownerDialog.departmentId) return
  const result = await run(() => adminApi.updateKnowledgeBaseOwner(ownerDialog.baseId, ownerDialog.departmentId), '归属部门已修改')
  if (result) {
    baseList.value = result
    ownerDialog.open = false
  }
}

// —— 新建 ——
const createDialog = reactive({ open: false, name: '', description: '', ownerDepartmentId: '' })
function openCreate() {
  Object.assign(createDialog, { open: true, name: '', description: '', ownerDepartmentId: '' })
}
async function confirmCreate() {
  if (!createDialog.name.trim() || !createDialog.ownerDepartmentId) return
  const result = await run(() => adminApi.createKnowledgeBase({
    name: createDialog.name.trim(), description: createDialog.description.trim(), ownerDepartmentId: createDialog.ownerDepartmentId,
  }), '知识库已创建')
  if (result) {
    baseList.value = result
    createDialog.open = false
  }
}

// —— 恢复（优化方案 O9） ——
async function restoreBase(base: KnowledgeAdminBase) {
  const result = await run(() => adminApi.restoreKnowledgeBase(base.id), `已恢复“${base.name}”`)
  if (result) baseList.value = result
}

// —— 删除 ——
async function removeBase(base: KnowledgeAdminBase) {
  try {
    await ElMessageBox.prompt(
      `知识库中的${base.documentCount === null ? '' : ` ${base.documentCount} 篇`}文档将一并删除，所有对话不再检索它，已添加它的对话会提示已无权查看。已有回答中的引用记录保留。此操作不能撤销。请输入知识库名称确认。`,
      `删除“${base.name}”`,
      {
        confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
        inputPlaceholder: base.name,
        inputValidator: (text: string) => text.trim() === base.name || '请输入知识库名称确认',
      },
    )
  } catch {
    return
  }
  const result = await run(() => adminApi.deleteKnowledgeBase(base.id), `已删除“${base.name}”`)
  if (result) baseList.value = result
}

// —— 连接配置 ——
const connectionForm = reactive({ baseUrl: '', apiKey: '', editingKey: false, credentialExpiresAt: '', embeddingModelId: '', enabled: true })
const testResult = ref<{ ok: boolean; reason: string | null } | null>(null)
/** 与服务端规范化一致：去掉末尾斜杠与 /api/v1（WeKnora 文档常带），比较时两边同样处理。 */
function comparableBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '').replace(/(\/api\/v1)+\/*$/i, '').replace(/\/+$/, '')
}
/** 已保存的 Key 只发往已保存的地址：改了地址就必须重新填写 Key。 */
const addressChanged = computed(() => Boolean(connection.value?.configured)
  && comparableBaseUrl(connectionForm.baseUrl) !== comparableBaseUrl(connection.value?.baseUrl ?? ''))
watch(addressChanged, changed => { if (changed) connectionForm.editingKey = true })
const modelChanged = computed(() => Boolean(connection.value?.configured)
  && (connectionForm.embeddingModelId.trim() || null) !== (connection.value?.embeddingModelId ?? null))
function resetConnectionForm() {
  const value = connection.value
  Object.assign(connectionForm, {
    baseUrl: value?.baseUrl ?? '',
    apiKey: '',
    editingKey: !value?.configured,
    credentialExpiresAt: formatLocalDate(value?.credentialExpiresAt ?? null),
    embeddingModelId: value?.embeddingModelId ?? '',
    enabled: value?.configured ? value.enabled : true,
  })
  testResult.value = null
}
async function testConnection() {
  testResult.value = null
  const apiKey = connectionForm.editingKey ? connectionForm.apiKey.trim() || undefined : undefined
  const testsSaved = !apiKey && !addressChanged.value
  const result = await run(async () => {
    const tested = await adminApi.testKnowledgeConnection({ baseUrl: connectionForm.baseUrl.trim() || undefined, apiKey })
    // 测试已保存的连接成功时服务端记录成功时间：在同一操作内刷新概览，“暂不可用”提示随之消失，
    // 刷新期间保存按钮仍不可用，避免旧概览覆盖刚保存的配置。
    if (tested.ok && testsSaved) overview.value = await adminApi.getKnowledgeOverview().catch(() => overview.value)
    return tested
  }, '测试已完成')
  if (result) testResult.value = result
}
async function confirmConnectionChanges(): Promise<boolean> {
  const modelId = connectionForm.embeddingModelId.trim()
  const notices: string[] = []
  if (modelId && !modelIdPattern.test(modelId)) {
    notices.push(`“${modelId}”看起来不是 WeKnora 的模型 ID（应为 UUID，不是模型名称）。填错时新建知识库仍会成功，但上传的文档会解析失败。`)
  }
  if (addressChanged.value && activeBaseCount.value > 0) {
    notices.push(`现有 ${activeBaseCount.value} 个知识库属于原地址，更换后将标为“原连接已更换”，不再参与检索、员工端不显示；确认新地址中有这些知识库时可以逐个恢复。`)
  }
  if (!notices.length) return true
  try {
    const message = h('div', { class: 'knowledge-admin__confirm' }, notices.map(text => h('p', text)))
    await ElMessageBox.confirm(message, '确认保存连接配置', { confirmButtonText: '仍然保存', cancelButtonText: '返回修改', type: 'warning' })
    return true
  } catch {
    return false
  }
}
async function saveConnection() {
  if (!await confirmConnectionChanges()) return
  const result = await run(() => adminApi.updateKnowledgeConnection({
    baseUrl: connectionForm.baseUrl.trim(),
    enabled: connectionForm.enabled,
    embeddingModelId: connectionForm.embeddingModelId.trim() || null,
    credentialExpiresAt: connectionForm.credentialExpiresAt ? new Date(`${connectionForm.credentialExpiresAt}T00:00:00`).toISOString() : null,
    ...(connectionForm.editingKey && connectionForm.apiKey.trim() ? { apiKey: connectionForm.apiKey.trim() } : {}),
  }), '连接配置已保存')
  if (result) {
    overview.value = result
    resetConnectionForm()
    baseList.value = await adminApi.listKnowledgeBases().catch(() => baseList.value)
  }
}

onMounted(load)
</script>

<template>
  <div class="ops-page knowledge-admin-page">
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="知识库只按部门授权。员工只能授给自己所属的部门；授给其他部门或全公司在这里操作。WeKnora 的问答与 Agent 不使用，回答始终由 DSH 生成。"
    />
    <el-alert
      v-if="connection?.enabled && !connection.credentialReadable"
      type="error"
      :closable="false"
      show-icon
      title="API Key 无法读取：企业知识库实际不可用，员工端已隐藏入口、对话不检索。"
      description="请检查服务的凭据主密钥 DSH_CREDENTIAL_MASTER_KEY 是否更换或缺失，然后在连接配置中重新填写 API Key。"
    />
    <el-alert v-if="connection?.enabled && rerankDegraded(connection.lastRerankOutcome)" type="warning" :closable="false" show-icon
      :title="`重排序${rerankLabels[connection.lastRerankOutcome ?? '']}（${formatDateTime(connection.lastRerankAt)}）。检索照常进行，但结果没有经过重排序，最低相关度门槛可能不再合适。`"
      description="请检查 WeKnora 中重排序模型的地址与网络访问（包括 SSRF 白名单）。" />
    <el-alert v-if="unavailableBanner" type="error" :closable="false" show-icon :title="unavailableBanner">
      <template #default>请检查连接配置；知识库与授权仍可查看和调整。</template>
    </el-alert>

    <section class="content-panel overview-strip" aria-label="企业知识库概况">
      <dl class="overview-strip__stats">
        <div class="overview-stat">
          <dt>连接状态</dt>
          <dd><strong class="overview-stat__value">{{ !connection?.configured ? '未配置' : !connection.enabled ? '已停用' : connection.credentialReadable ? '已启用' : 'Key 不可读' }}</strong><small>最近成功 {{ formatDateTime(connection?.lastSuccessAt ?? null) }}</small></dd>
        </div>
        <div class="overview-stat">
          <dt>知识库</dt>
          <dd><strong class="overview-stat__value">{{ baseList.items.length }}</strong><small>{{ baseList.statsAvailable ? `共 ${counts.documents} 篇文档` : '文档数暂不可读' }}</small></dd>
        </div>
        <div class="overview-stat" :class="{ 'overview-stat--attention': counts.attention > 0 }">
          <dt>需要处理</dt>
          <dd><strong class="overview-stat__value">{{ counts.attention }}</strong><small>无可见部门 {{ counts.noGrant }} · 归属部门已删除 {{ counts.ownerDeleted }} · 需重建 {{ counts.rebuild }}<template v-if="counts.moved"> · 原连接已更换 {{ counts.moved }}</template><template v-if="counts.summary"> · 已配置摘要模型 {{ counts.summary }}</template></small></dd>
        </div>
        <div class="overview-stat">
          <dt>最近 24 小时检索</dt>
          <dd><strong class="overview-stat__value">{{ overview?.health.retrievals24h ?? 0 }} 次</strong><small>不可用 {{ overview?.health.unavailable24h ?? 0 }} 次<template v-if="connection?.lastFailureAt"> · 最近失败 {{ formatDateTime(connection.lastFailureAt) }}（{{ failureLabels[connection.lastFailureReason ?? ''] ?? '未知' }}）</template></small></dd>
        </div>
      </dl>
    </section>

    <section class="content-panel">
      <el-tabs v-model="activeTab" class="knowledge-admin__tabs">
        <el-tab-pane label="全部知识库" name="bases">
          <div class="filter-bar">
            <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索知识库名称或归属部门" aria-label="搜索知识库名称或归属部门" />
            <el-radio-group v-model="filter" size="small" aria-label="筛选">
              <el-radio-button value="all">全部</el-radio-button>
              <el-radio-button value="attention">需要处理</el-radio-button>
            </el-radio-group>
            <el-button v-if="canManage" class="knowledge-admin__create" type="primary" :icon="Plus" :disabled="!connection?.enabled" @click="openCreate">新建知识库</el-button>
          </div>
          <el-table v-loading="loading" :data="visibleBases" empty-text="没有知识库">
            <el-table-column label="知识库" min-width="180">
              <template #default="{ row }">
                <strong class="knowledge-admin__name">{{ row.name }}</strong>
                <span class="knowledge-admin__desc">{{ row.description || '暂无说明' }}</span>
                <div v-if="row.status === 'unavailable' || row.summaryModelConfigured" class="knowledge-admin__tags">
                  <el-tag v-if="row.status === 'unavailable'" type="danger" size="small">原连接已更换</el-tag>
                  <el-tag v-if="row.summaryModelConfigured" type="danger" size="small" title="文档入库时 WeKnora 会把内容发给该对话模型生成摘要">已配置摘要模型</el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="归属部门" min-width="120">
              <template #default="{ row }">
                {{ row.ownerDepartmentName }}
                <el-tag v-if="!row.ownerDepartmentActive" type="danger" size="small">已删除</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="可见部门" min-width="200">
              <template #default="{ row }">
                <div class="knowledge-admin__tags">
                  <el-tag v-for="grant in row.grants" :key="grant.id" :type="grant.grantedVia === 'admin' ? 'primary' : 'info'" size="small" effect="plain">{{ grantLabel(grant) }}</el-tag>
                  <el-tag v-if="!row.grants.length" type="warning" size="small">无可见部门</el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="文档" width="70">
              <template #default="{ row }">{{ row.documentCount ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="嵌入模型" min-width="140">
              <template #default="{ row }">
                {{ row.embeddingModelId ?? '—' }}
                <el-tag v-if="row.needsRebuild" type="warning" size="small" title="仍按建库时的模型检索；该模型从 WeKnora 删除后失效">需重建</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="150">
              <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
            </el-table-column>
            <el-table-column v-if="canManage" label="操作" width="300">
              <template #default="{ row }">
                <el-button v-if="row.status === 'unavailable'" link type="primary" :disabled="!connection?.enabled || saving" @click="restoreBase(row)">恢复</el-button>
                <el-button link type="primary" @click="openGrants(row)">可见部门</el-button>
                <el-button link type="primary" @click="openOwner(row)">归属部门</el-button>
                <el-button link type="danger" :disabled="!connection?.enabled" @click="removeBase(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <ul class="knowledge-admin__legend">
            <li>“需重建”：知识库建库时的嵌入模型与当前连接配置不同。WeKnora 按每个知识库自己的嵌入模型检索，它仍可正常使用；但原模型从 WeKnora 删除后将无法检索，计划下线原模型前请通知归属部门新建知识库并重新上传文档。</li>
            <li>“原连接已更换”：更换 WeKnora 地址后，原有知识库不再参与检索；确认新地址中有该知识库时点“恢复”。</li>
            <li>“已配置摘要模型”：有人在 WeKnora 中为该知识库设置了摘要模型，文档入库时内容会发给该对话模型，须确认它在内网运行，或在 WeKnora 中清除。</li>
            <li v-if="!baseList.statsAvailable">知识库服务暂不可用，文档数与更新时间显示为“—”。</li>
          </ul>
        </el-tab-pane>

        <el-tab-pane label="连接配置" name="connection">
          <div class="knowledge-connection">
            <el-form label-position="top" class="knowledge-connection__form" :disabled="!canManage" @submit.prevent="saveConnection">
              <el-form-item label="WeKnora 地址" required>
                <el-input v-model="connectionForm.baseUrl" placeholder="https://weknora.internal.example.com" aria-label="WeKnora 地址" />
                <span v-if="addressChanged" class="knowledge-admin__hint knowledge-admin__hint--warn">更换地址须重新填写 API Key：已保存的 Key 不会发往新地址。<template v-if="activeBaseCount"> 现有 {{ activeBaseCount }} 个知识库将标为“原连接已更换”。</template></span>
                <span class="knowledge-admin__hint">只开放平台服务端到 WeKnora 后端 API 的访问，员工浏览器不直接访问。</span>
              </el-form-item>
              <el-form-item label="API Key" :required="!connection?.configured">
                <template v-if="connectionForm.editingKey">
                  <el-input v-model="connectionForm.apiKey" type="password" show-password placeholder="粘贴新的 API Key" aria-label="新的 API Key" />
                  <span class="knowledge-admin__hint">需具备 retrieve、ingest、manage_kbs 能力，不设知识库白名单。保存后加密存储，只显示末四位。</span>
                </template>
                <div v-else class="knowledge-connection__key">
                  <code>•••• {{ connection?.credentialHint ?? '????' }}</code>
                  <span class="knowledge-admin__hint">{{ connection?.credentialSource === 'deployment' ? '来自部署配置' : '已加密保存' }}</span>
                  <el-button size="small" @click="connectionForm.editingKey = true">更换</el-button>
                </div>
              </el-form-item>
              <el-form-item label="API Key 到期日期">
                <el-date-picker v-model="connectionForm.credentialExpiresAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" aria-label="API Key 到期日期" />
              </el-form-item>
              <el-form-item label="统一嵌入模型 ID">
                <el-input v-model="connectionForm.embeddingModelId" placeholder="例如 00000000-0000-4000-8000-000000000000" aria-label="统一嵌入模型 ID" />
                <span v-if="connectionForm.embeddingModelId.trim() && !modelIdPattern.test(connectionForm.embeddingModelId.trim())" class="knowledge-admin__hint knowledge-admin__hint--warn">这看起来不是 WeKnora 的模型 ID（应为 UUID，不是模型名称）。</span>
                <span class="knowledge-admin__hint">WeKnora 模型管理中嵌入模型的 ID（UUID），不是模型名称；查看方法见部署手册。新建知识库时自动带上，员工不选择。须是在内网运行的模型。</span>
              </el-form-item>
              <el-alert v-if="modelChanged" type="warning" :closable="false" show-icon
                :title="`更换嵌入模型只影响之后新建的知识库。现有 ${activeBaseCount} 个知识库仍按原模型检索，将标为“需重建”；原模型从 WeKnora 删除前它们都能正常使用。`" />
              <el-form-item>
                <el-checkbox v-model="connectionForm.enabled">启用企业知识库</el-checkbox>
              </el-form-item>
              <el-alert v-if="!connectionForm.enabled" type="error" :closable="false" show-icon
                title="停用后：员工端不显示“知识库”与“添加知识库”，对话不再检索企业知识；知识库与授权保留。" />
              <div v-if="canManage" class="knowledge-connection__actions">
                <el-button :loading="saving" @click="testConnection">测试连接</el-button>
                <el-button type="primary" :loading="saving" native-type="submit">保存</el-button>
              </div>
              <el-alert v-if="testResult" :type="testResult.ok ? 'success' : 'error'" :closable="false" show-icon
                :title="testResult.ok ? '连接正常：地址与 API Key 可用。' : `连接失败：${failureLabels[testResult.reason ?? ''] ?? testResult.reason}`" />
            </el-form>
            <aside class="knowledge-connection__health" aria-label="健康状态">
              <h3>健康状态</h3>
              <dl>
                <div><dt>最近成功</dt><dd>{{ formatDateTime(connection?.lastSuccessAt ?? null) }}</dd></div>
                <div><dt>最近失败</dt><dd>{{ formatDateTime(connection?.lastFailureAt ?? null) }}</dd></div>
                <div><dt>失败原因</dt><dd>{{ failureLabels[connection?.lastFailureReason ?? ''] ?? '—' }}</dd></div>
                <div><dt>24 小时检索</dt><dd>{{ overview?.health.retrievals24h ?? 0 }} 次</dd></div>
                <div><dt>24 小时不可用</dt><dd>{{ overview?.health.unavailable24h ?? 0 }} 次</dd></div>
                <div><dt>最近重排序</dt><dd>{{ connection?.lastRerankOutcome ? `${rerankLabels[connection.lastRerankOutcome] ?? connection.lastRerankOutcome}（${formatDateTime(connection.lastRerankAt)}）` : '—' }}</dd></div>
              </dl>
              <p class="knowledge-admin__hint">失败原因只记录分类（超时、连接失败、认证失败、限流、服务错误），不含 API Key 与请求正文。</p>
            </aside>
          </div>
        </el-tab-pane>
      </el-tabs>
    </section>

    <el-dialog v-model="grantDialog.open" :title="`可见部门 · ${grantBase?.name ?? ''}`" width="560px" append-to-body>
      <p class="knowledge-admin__hint">平台管理员可以授给任意部门（含全公司）并撤销任何授权，包括员工授予的。</p>
      <ul class="knowledge-grant-list">
        <li v-for="grant in grantBase?.grants ?? []" :key="grant.id">
          <span class="knowledge-grant-list__name">{{ grantLabel(grant) }}</span>
          <el-tag :type="grant.grantedVia === 'admin' ? 'primary' : 'info'" size="small">{{ grant.grantedVia === 'admin' ? '管理员授予' : '员工授予' }}</el-tag>
          <el-button link type="danger" :disabled="saving" :aria-label="`撤销${grantLabel(grant)}`" @click="revokeGrant(grant.id)">撤销</el-button>
        </li>
      </ul>
      <el-alert v-if="grantBase && !grantBase.grants.length" type="warning" :closable="false" show-icon title="没有任何可见部门：员工都看不到这个知识库。" />
      <div class="knowledge-grant-add">
        <el-select v-model="grantDialog.departmentId" filterable placeholder="选择部门" aria-label="添加部门">
          <el-option v-for="department in departments" :key="department.id" :value="department.id" :label="department.root ? '全公司（根部门）' : department.label" />
        </el-select>
        <el-checkbox v-model="grantDialog.includeDescendants">包含下级</el-checkbox>
        <el-button :disabled="!grantDialog.departmentId || saving" @click="addGrant">添加</el-button>
      </div>
      <template #footer>
        <el-button type="primary" @click="grantDialog.open = false">完成</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="ownerDialog.open" title="修改归属部门" width="480px" append-to-body>
      <p class="knowledge-admin__hint">归属部门里具备文档管理或知识库管理权限的员工可以维护这个知识库。修改归属部门不改变可见部门。</p>
      <el-select v-model="ownerDialog.departmentId" filterable placeholder="选择部门" aria-label="归属部门" style="width: 100%">
        <el-option v-for="department in ownerOptions" :key="department.id" :value="department.id" :label="department.label" />
      </el-select>
      <template #footer>
        <el-button @click="ownerDialog.open = false">取消</el-button>
        <el-button type="primary" :disabled="!ownerDialog.departmentId" :loading="saving" @click="saveOwner">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="createDialog.open" title="新建知识库" width="520px" append-to-body>
      <el-form label-position="top" @submit.prevent="confirmCreate">
        <el-form-item label="名称" required>
          <el-input v-model="createDialog.name" maxlength="60" show-word-limit placeholder="例如：全员安全制度" aria-label="名称" />
        </el-form-item>
        <el-form-item label="说明（选填）">
          <el-input v-model="createDialog.description" maxlength="200" placeholder="这个知识库放哪些文档" aria-label="说明" />
        </el-form-item>
        <el-form-item label="归属部门" required>
          <el-select v-model="createDialog.ownerDepartmentId" filterable placeholder="选择部门" aria-label="归属部门" style="width: 100%">
            <el-option v-for="department in ownerOptions" :key="department.id" :value="department.id" :label="department.label" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert type="warning" :closable="false" show-icon
        :title="`默认授给归属部门并包含下级，创建后可在“可见部门”中调整。嵌入模型使用当前配置（${connection?.embeddingModelId ?? '未配置'}）。管理端不上传文档，文档由归属部门的员工在员工端维护。`" />
      <template #footer>
        <el-button @click="createDialog.open = false">取消</el-button>
        <el-button type="primary" :disabled="!createDialog.name.trim() || !createDialog.ownerDepartmentId" :loading="saving" @click="confirmCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.knowledge-admin__tabs { width: 100%; }
.knowledge-admin__tabs :deep(.el-tab-pane) { display: flex; flex-direction: column; gap: 12px; }
.knowledge-admin__create { margin-left: auto; }
.knowledge-admin__name { display: block; color: var(--color-text-heading); font-weight: 600; }
.knowledge-admin__desc { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.knowledge-admin__tags { display: flex; flex-wrap: wrap; gap: 4px; }
/* 警示提示须在通用提示之后声明，否则同等优先级下颜色被覆盖。 */
.knowledge-admin__hint { margin: 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.6; }
.knowledge-admin__hint--warn { color: var(--color-warning-strong); }
:global(.knowledge-admin__confirm p) { margin: 0 0 8px; line-height: 1.6; }
.knowledge-admin__legend { margin: 0; padding-left: 18px; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.6; }
.knowledge-connection { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
.knowledge-connection__form { display: flex; flex: 2 1 420px; flex-direction: column; gap: 4px; max-width: 640px; }
.knowledge-connection__form :deep(.el-form-item__content) { flex-direction: column; align-items: flex-start; gap: 4px; }
.knowledge-connection__key { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.knowledge-connection__key code { padding: 4px 10px; border-radius: 6px; background: var(--color-bg-subtle); }
.knowledge-connection__actions { display: flex; gap: 8px; margin: 8px 0; }
.knowledge-connection__health { flex: 1 1 260px; padding: var(--spacing-card); border: 1px solid var(--color-border); border-radius: var(--radius-card); }
.knowledge-connection__health h3 { margin: 0 0 6px; font-size: var(--font-size-title); }
.knowledge-connection__health dl { margin: 0 0 8px; }
.knowledge-connection__health dl div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--color-border); font-size: var(--font-size-caption); }
.knowledge-connection__health dt { color: var(--color-text-secondary); }
.knowledge-connection__health dd { margin: 0; }
.knowledge-grant-list { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; padding: 0; list-style: none; }
.knowledge-grant-list li { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border: 1px solid var(--color-border); border-radius: 8px; }
.knowledge-grant-list__name { flex: 1; }
.knowledge-grant-add { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.knowledge-grant-add .el-select { flex: 1 1 220px; }
@media (max-width: 900px) { .knowledge-admin__create { margin-left: 0; } }
</style>
