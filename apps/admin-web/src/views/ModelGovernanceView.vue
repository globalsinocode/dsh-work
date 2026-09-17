<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, Plus, Refresh, SetUp } from '@element-plus/icons-vue'

import { adminApi } from '@/api/client'
import { useListPagination } from '@/composables/use-list-pagination'
import { useAuthStore } from '@/stores/auth'
import type { ModelProvider, ModelRoute, ModelRoutePurpose } from '@/types/domain'

const authStore = useAuthStore()
const providers = ref<ModelProvider[]>([])
const routes = ref<ModelRoute[]>([])
const activeTab = ref<'providers' | 'routes'>('providers')
const loading = ref(false)
const error = ref('')
const providerDialogOpen = ref(false)
const modelDialogOpen = ref(false)
const credentialDialogOpen = ref(false)
const routeDialogOpen = ref(false)
const selectedProvider = ref<ModelProvider | null>(null)

const providerForm = reactive({ key: '', name: '', providerType: 'openai-compatible', baseUrl: '' })
const modelForm = reactive({ modelKey: '', displayName: '', capabilities: ['text'] as string[] })
const credentialForm = reactive({ backend: 'dsh-managed' as const, externalRef: '', status: 'configured' as const })
const routeForm = reactive({ key: '', name: '', purpose: 'default' as ModelRoutePurpose, providerModelId: '', priority: 100, enabled: true })

const activeProviderCount = computed(() => providers.value.filter((item) => item.status === 'active').length)
const modelCount = computed(() => providers.value.reduce((sum, item) => sum + item.models.length, 0))
const configuredCredentialCount = computed(() => providers.value.filter((item) => item.credential?.status === 'configured').length)
const modelOptions = computed(() => providers.value.flatMap((provider) => provider.models.map((model) => ({
  value: model.id,
  label: `${provider.name} / ${model.displayName}`,
  disabled: provider.status !== 'active' || model.status !== 'active',
}))))
const { currentPage: providerPage, pagedItems: pagedProviders } = useListPagination(providers)
const { currentPage: routePage, pagedItems: pagedRoutes } = useListPagination(routes)

async function load() {
  loading.value = true
  error.value = ''
  try {
    ;[providers.value, routes.value] = await Promise.all([
      adminApi.getModelProviders(),
      adminApi.getModelRoutes(),
    ])
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '模型治理数据加载失败'
  } finally {
    loading.value = false
  }
}

function openProviderDialog() {
  Object.assign(providerForm, { key: '', name: '', providerType: 'openai-compatible', baseUrl: '' })
  providerDialogOpen.value = true
}

function openModelDialog(provider: ModelProvider) {
  selectedProvider.value = provider
  Object.assign(modelForm, { modelKey: '', displayName: '', capabilities: ['text'] })
  modelDialogOpen.value = true
}

function openCredentialDialog(provider: ModelProvider) {
  selectedProvider.value = provider
  Object.assign(credentialForm, {
    backend: 'dsh-managed',
    externalRef: provider.credential?.externalRef ?? '',
    status: provider.credential?.status ?? 'configured',
  })
  credentialDialogOpen.value = true
}

function openRouteDialog() {
  Object.assign(routeForm, {
    key: '',
    name: '',
    purpose: 'default',
    providerModelId: modelOptions.value.find((item) => !item.disabled)?.value ?? '',
    priority: 100,
    enabled: true,
  })
  routeDialogOpen.value = true
}

async function createProvider() {
  try {
    await adminApi.createModelProvider({ ...providerForm })
    providerDialogOpen.value = false
    ElMessage.success('Provider 已创建')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Provider 创建失败')
  }
}

async function createModel() {
  if (!selectedProvider.value) return
  try {
    await adminApi.createProviderModel({
      providerId: selectedProvider.value.id,
      ...modelForm,
    })
    modelDialogOpen.value = false
    ElMessage.success('模型已添加')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '模型添加失败')
  }
}

async function saveCredentialReference() {
  if (!selectedProvider.value) return
  try {
    await adminApi.updateCredentialReference({
      providerId: selectedProvider.value.id,
      ...credentialForm,
    })
    credentialDialogOpen.value = false
    ElMessage.success('密钥引用已更新；密钥正文未进入 dsh-work')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '密钥引用更新失败')
  }
}

async function createRoute() {
  try {
    await adminApi.createModelRoute({ ...routeForm })
    routeDialogOpen.value = false
    ElMessage.success('模型路由已创建')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '模型路由创建失败')
  }
}

async function toggleProvider(provider: ModelProvider) {
  const status = provider.status === 'active' ? 'disabled' : 'active'
  try {
    if (status === 'disabled') {
      await ElMessageBox.confirm('停用后，新 Run 不再解析到该 Provider。已启动 Attempt 不受影响。', `停用 ${provider.name}`, { type: 'warning' })
    }
    await adminApi.setModelProviderStatus({ providerId: provider.id, status })
    ElMessage.success(status === 'active' ? 'Provider 已启用' : 'Provider 已停用')
    await load()
  } catch (cause) {
    if (cause !== 'cancel') ElMessage.error(cause instanceof Error ? cause.message : '状态更新失败')
  }
}

function credentialStatusLabel(provider: ModelProvider) {
  if (!provider.credential) return '未登记'
  return { configured: '已配置', missing: '缺失', revoked: '已撤销' }[provider.credential.status]
}

function credentialStatusType(provider: ModelProvider) {
  if (provider.credential?.status === 'configured') return 'success'
  if (provider.credential?.status === 'revoked') return 'danger'
  return 'warning'
}

function purposeLabel(purpose: ModelRoutePurpose) {
  return { default: '默认', chat: '对话', analysis: '分析', fallback: '降级' }[purpose]
}

onMounted(() => void load())
</script>

<template>
  <div class="ops-page model-governance-page">
    <div class="page-heading-row">
      <p class="page-note">集中管理 Provider、可用模型、平台路由和密钥引用；Agent 不单独配置模型。</p>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert type="info" :closable="false" show-icon title="当前默认模型继承 DSH 配置。dsh-work 只保存密钥引用与状态，不能读取、回显或导出密钥正文。" />

    <section class="metric-grid">
      <article class="metric-card"><div class="metric-label">启用 Provider</div><div class="metric-value">{{ activeProviderCount }}</div><div class="metric-detail">共 {{ providers.length }} 个</div></article>
      <article class="metric-card"><div class="metric-label">可治理模型</div><div class="metric-value">{{ modelCount }}</div><div class="metric-detail">按 Provider 注册</div></article>
      <article class="metric-card"><div class="metric-label">凭据已配置</div><div class="metric-value">{{ configuredCredentialCount }}</div><div class="metric-detail">仅记录引用状态</div></article>
      <article class="metric-card"><div class="metric-label">启用路由</div><div class="metric-value">{{ routes.filter((item) => item.enabled).length }}</div><div class="metric-detail">运行前解析并快照</div></article>
    </section>

    <section class="content-panel content-panel--flush">
      <div class="governance-toolbar">
        <el-tabs v-model="activeTab" class="governance-tabs"><el-tab-pane label="Provider 与模型" name="providers" /><el-tab-pane label="模型路由" name="routes" /></el-tabs>
        <el-button v-if="authStore.canManage" type="primary" :icon="Plus" @click="activeTab === 'providers' ? openProviderDialog() : openRouteDialog()">{{ activeTab === 'providers' ? '新建 Provider' : '新建路由' }}</el-button>
      </div>

      <el-table v-if="activeTab === 'providers'" v-loading="loading" class="data-table" :data="pagedProviders" empty-text="暂无 Provider">
        <el-table-column label="Provider" min-width="210"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.name }}</strong><span>{{ scope.row.key }} · {{ scope.row.providerType }}</span></div></template></el-table-column>
        <el-table-column label="服务地址" min-width="210"><template #default="scope"><span class="mono-value">{{ scope.row.baseUrl }}</span></template></el-table-column>
        <el-table-column label="模型数" width="80"><template #default="scope">{{ scope.row.models.length }} 个</template></el-table-column>
        <el-table-column label="密钥引用" min-width="200"><template #default="scope"><div class="stack-cell"><el-tag :type="credentialStatusType(scope.row)" effect="plain">{{ credentialStatusLabel(scope.row) }}</el-tag><span>{{ scope.row.credential ? `${scope.row.credential.backend} / ${scope.row.credential.externalRef}` : '尚未登记' }}</span></div></template></el-table-column>
        <el-table-column label="状态" width="84"><template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'" effect="plain">{{ scope.row.status === 'active' ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="240" fixed="right"><template #default="scope"><el-button link type="primary" @click="openModelDialog(scope.row)">添加模型</el-button><el-button link type="primary" @click="openCredentialDialog(scope.row)">密钥引用</el-button><el-button link :type="scope.row.status === 'active' ? 'danger' : 'primary'" @click="toggleProvider(scope.row)">{{ scope.row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
        <el-table-column type="expand" width="48"><template #default="scope"><div class="model-expansion"><h3>已注册模型</h3><el-empty v-if="scope.row.models.length === 0" description="尚未添加模型" :image-size="54" /><div v-else class="model-card-grid"><article v-for="model in scope.row.models" :key="model.id"><div><strong>{{ model.displayName }}</strong><span>{{ model.modelKey }}</span></div><el-tag effect="plain">{{ model.status === 'active' ? '启用' : '停用' }}</el-tag><p>{{ model.capabilities.join(' · ') || '未声明能力' }}</p></article></div></div></template></el-table-column>
      </el-table>

      <el-table v-else v-loading="loading" class="data-table" :data="pagedRoutes" empty-text="暂无模型路由">
        <el-table-column label="路由" min-width="230"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.name }}</strong><span>{{ scope.row.key }}</span></div></template></el-table-column>
        <el-table-column label="用途" width="110"><template #default="scope"><el-tag effect="plain">{{ purposeLabel(scope.row.purpose) }}</el-tag></template></el-table-column>
        <el-table-column label="路由目标" min-width="280"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.modelName }}</strong><span>{{ scope.row.providerName }} / {{ scope.row.modelKey }}</span></div></template></el-table-column>
        <el-table-column prop="priority" label="优先级" width="100" />
        <el-table-column label="状态" width="110"><template #default="scope"><el-tag :type="scope.row.enabled ? 'success' : 'info'" effect="plain">{{ scope.row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="更新于" min-width="180"><template #default="scope">{{ new Date(scope.row.updatedAt).toLocaleString('zh-CN') }}</template></el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-if="activeTab === 'providers'" v-model:current-page="providerPage" background layout="prev, pager, next" :total="providers.length" :page-size="10" /><el-pagination v-else v-model:current-page="routePage" background layout="prev, pager, next" :total="routes.length" :page-size="10" /></div>
    </section>

    <el-dialog v-model="providerDialogOpen" title="新建 Provider" width="620px" destroy-on-close>
      <el-form label-position="top" :model="providerForm"><div class="form-grid"><el-form-item label="Provider 名称" required><el-input v-model="providerForm.name" placeholder="例如：DeepSeek 官方" /></el-form-item><el-form-item label="Provider 标识" required><el-input v-model="providerForm.key" placeholder="例如：deepseek-official" /></el-form-item></div><el-form-item label="协议类型" required><el-select v-model="providerForm.providerType"><el-option label="OpenAI 兼容" value="openai-compatible" /></el-select></el-form-item><el-form-item label="服务地址" required><el-input v-model="providerForm.baseUrl" placeholder="https://api.example.com" /></el-form-item></el-form>
      <template #footer><el-button @click="providerDialogOpen = false">取消</el-button><el-button type="primary" :icon="Connection" @click="createProvider">创建 Provider</el-button></template>
    </el-dialog>

    <el-dialog v-model="modelDialogOpen" :title="`为 ${selectedProvider?.name ?? ''} 添加模型`" width="600px" destroy-on-close>
      <el-form label-position="top" :model="modelForm"><div class="form-grid"><el-form-item label="模型名称" required><el-input v-model="modelForm.displayName" placeholder="例如：DeepSeek V4 Pro" /></el-form-item><el-form-item label="模型标识" required><el-input v-model="modelForm.modelKey" placeholder="例如：deepseek-v4-pro" /></el-form-item></div><el-form-item label="能力"><el-select v-model="modelForm.capabilities" multiple allow-create filterable><el-option label="文本" value="text" /><el-option label="深度思考" value="thinking" /><el-option label="工具调用" value="tool-calling" /></el-select></el-form-item></el-form>
      <template #footer><el-button @click="modelDialogOpen = false">取消</el-button><el-button type="primary" @click="createModel">添加模型</el-button></template>
    </el-dialog>

    <el-dialog v-model="credentialDialogOpen" :title="`配置 ${selectedProvider?.name ?? ''} 的密钥引用`" width="620px" destroy-on-close>
      <el-alert type="warning" :closable="false" show-icon title="这里只登记引用，不输入密钥正文。当前 DSH 管理的密钥请继续在 DSH Credentials Provider 中更新。" />
      <el-form class="dialog-form" label-position="top" :model="credentialForm"><el-form-item label="密钥后端" required><el-select v-model="credentialForm.backend"><el-option label="DSH 受管凭据" value="dsh-managed" /></el-select></el-form-item><el-form-item label="外部引用" required><el-input v-model="credentialForm.externalRef" placeholder="例如：DEEPSEEK_API_KEY" /></el-form-item><el-form-item label="配置状态" required><el-radio-group v-model="credentialForm.status"><el-radio value="configured">已配置</el-radio><el-radio value="missing">缺失</el-radio><el-radio value="revoked">已撤销</el-radio></el-radio-group></el-form-item></el-form>
      <template #footer><el-button @click="credentialDialogOpen = false">取消</el-button><el-button type="primary" :icon="SetUp" @click="saveCredentialReference">保存引用</el-button></template>
    </el-dialog>

    <el-dialog v-model="routeDialogOpen" title="新建模型路由" width="640px" destroy-on-close>
      <el-form label-position="top" :model="routeForm"><div class="form-grid"><el-form-item label="路由名称" required><el-input v-model="routeForm.name" placeholder="例如：平台默认模型路由" /></el-form-item><el-form-item label="路由标识" required><el-input v-model="routeForm.key" placeholder="例如：default" /></el-form-item></div><div class="form-grid"><el-form-item label="用途" required><el-select v-model="routeForm.purpose"><el-option label="默认" value="default" /><el-option label="对话" value="chat" /><el-option label="分析" value="analysis" /><el-option label="降级" value="fallback" /></el-select></el-form-item><el-form-item label="优先级" required><el-input-number v-model="routeForm.priority" :min="0" :max="10000" controls-position="right" /></el-form-item></div><el-form-item label="目标模型" required><el-select v-model="routeForm.providerModelId" filterable><el-option v-for="option in modelOptions" :key="option.value" :label="option.label" :value="option.value" :disabled="option.disabled" /></el-select></el-form-item><el-form-item><el-checkbox v-model="routeForm.enabled">创建后立即启用</el-checkbox></el-form-item></el-form>
      <template #footer><el-button @click="routeDialogOpen = false">取消</el-button><el-button type="primary" @click="createRoute">创建路由</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-heading-row, .governance-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.governance-toolbar { min-height: 56px; padding: 0 14px; border-bottom: 1px solid var(--color-border); }
.governance-tabs { min-width: 300px; }
.governance-tabs :deep(.el-tabs__header) { margin: 0; }
.governance-tabs :deep(.el-tabs__nav-wrap::after) { display: none; }
.stack-cell { display: flex; min-width: 0; flex-direction: column; align-items: flex-start; gap: 4px; }
.stack-cell strong { color: var(--color-text-heading); }
.stack-cell span, .mono-value { color: var(--color-text-secondary); font-size: var(--font-size-caption); overflow-wrap: anywhere; }
.mono-value { display: block; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.model-expansion { padding: 12px 56px 24px; background: var(--color-bg-page); }
.model-expansion h3 { margin: 0 0 12px; font-size: var(--font-size-body); }
.model-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.model-card-grid article { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-base); }
.model-card-grid article div { display: flex; flex-direction: column; }
.model-card-grid article span, .model-card-grid article p { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.model-card-grid article p { grid-column: 1 / -1; margin: 0; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.dialog-form { margin-top: 18px; }
.form-grid :deep(.el-select), .form-grid :deep(.el-input-number), .dialog-form :deep(.el-select), :deep(.el-form-item .el-select) { width: 100%; }
@media (max-width: 1100px) { .metric-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
