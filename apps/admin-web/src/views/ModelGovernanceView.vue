<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, Plus, Refresh, SetUp } from '@element-plus/icons-vue'

import { adminApi } from '@/api/client'
import { useListPagination } from '@/composables/use-list-pagination'
import { useAuthStore } from '@/stores/auth'
import type { ModelProvider, ModelRoute, ProviderModel, ProviderTrustLevel, ProviderType } from '@/types/domain'

const authStore = useAuthStore()
const providers = ref<ModelProvider[]>([])
const routes = ref<ModelRoute[]>([])
const activeTab = ref<'providers' | 'routes'>('providers')
const loading = ref(false)
const error = ref('')
const providerDialogOpen = ref(false)
const providerEditDialogOpen = ref(false)
const modelDialogOpen = ref(false)
const credentialDialogOpen = ref(false)
const routeDialogOpen = ref(false)
const selectedProvider = ref<ModelProvider | null>(null)
const editingRoute = ref<ModelRoute | null>(null)

const providerTypeOptions: { value: ProviderType; label: string; disabled: boolean }[] = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions 兼容', disabled: false },
  { value: 'openai-responses', label: 'OpenAI Responses（暂未开放）', disabled: true },
  { value: 'anthropic-messages', label: 'Anthropic Messages（暂未开放）', disabled: true },
]

const providerForm = reactive({ key: '', name: '', providerType: 'openai-completions' as ProviderType, trustLevel: '' as ProviderTrustLevel | '', baseUrl: '', apiKey: '' })
const providerEditForm = reactive({ name: '', baseUrl: '', trustLevel: 'external' as ProviderTrustLevel })
const modelForm = reactive({ modelKey: '', displayName: '', capabilities: ['text'] as string[] })
// 厂商模型目录：只是输入建议；拉取失败或厂商不支持时仍可手动输入。
const catalogKeys = ref<string[]>([])
const catalogLoading = ref(false)
const catalogMessage = ref('')
let catalogRequest = 0
let autoDisplayName = ''
const existingModelKeys = computed(() => new Set(selectedProvider.value?.models.map((model) => model.modelKey) ?? []))
const apiKeyInput = ref('')
const routeForm = reactive({ key: '', name: '', providerModelId: '', enabled: true })

const activeProviderCount = computed(() => providers.value.filter((item) => item.status === 'active').length)
const modelCount = computed(() => providers.value.reduce((sum, item) => sum + item.models.length, 0))
// 模型路由方案 4.5：只有平台加密保存的密钥能被模型网关使用；DSH 受管等外部引用不计为已配置。
const configuredCredentialCount = computed(() => providers.value.filter((item) => usableCredential(item)).length)
const enabledRoute = computed(() => routes.value.find((item) => item.enabled) ?? null)
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
  Object.assign(providerForm, { key: '', name: '', providerType: 'openai-completions', trustLevel: '', baseUrl: '', apiKey: '' })
  providerDialogOpen.value = true
}

function openProviderEditDialog(provider: ModelProvider) {
  selectedProvider.value = provider
  Object.assign(providerEditForm, { name: provider.name, baseUrl: provider.baseUrl, trustLevel: provider.trustLevel })
  providerEditDialogOpen.value = true
}

function openModelDialog(provider: ModelProvider) {
  selectedProvider.value = provider
  Object.assign(modelForm, { modelKey: '', displayName: '', capabilities: ['text'] })
  autoDisplayName = ''
  modelDialogOpen.value = true
  void loadModelCatalog()
}

function providerHasPlatformKey(provider: ModelProvider | null) {
  return provider?.credential?.backend === 'postgres-encrypted' && provider.credential.status === 'configured'
}

async function loadModelCatalog() {
  const provider = selectedProvider.value
  const request = ++catalogRequest
  catalogKeys.value = []
  if (!provider || !providerHasPlatformKey(provider)) {
    catalogLoading.value = false
    catalogMessage.value = '该 Provider 尚未录入 API Key，无法获取模型列表，请手动填写模型标识'
    return
  }
  catalogLoading.value = true
  catalogMessage.value = ''
  try {
    const result = await adminApi.listProviderModelCatalog({ providerId: provider.id })
    if (request !== catalogRequest) return
    catalogKeys.value = result.modelKeys
    const addable = result.modelKeys.filter((key) => !existingModelKeys.value.has(key)).length
    catalogMessage.value = result.modelKeys.length
      ? `已从厂商获取 ${result.modelKeys.length} 个模型（${addable} 个未添加），点击输入框可搜索选择，也可直接输入`
      : '厂商没有返回可用模型，请手动填写模型标识'
  } catch (cause) {
    if (request !== catalogRequest) return
    catalogMessage.value = `未能获取模型列表：${cause instanceof Error ? cause.message : '请求失败'}`
  } finally {
    if (request === catalogRequest) catalogLoading.value = false
  }
}

/** 输入框建议：厂商返回且尚未添加的模型，按输入内容过滤（不区分大小写），最多 200 条。 */
function suggestModelKeys(query: string, callback: (items: Array<{ value: string }>) => void) {
  const keyword = (query ?? '').trim().toLowerCase()
  callback(catalogKeys.value
    .filter((key) => !existingModelKeys.value.has(key) && (!keyword || key.toLowerCase().includes(keyword)))
    .slice(0, 200)
    .map((value) => ({ value })))
}

function onModelKeySelect(item: Record<string, unknown>) {
  const value = typeof item['value'] === 'string' ? item['value'] : ''
  // 名称为空或仍是上次自动填的值时，跟随所选模型标识。
  if (!modelForm.displayName.trim() || modelForm.displayName === autoDisplayName) {
    modelForm.displayName = value
    autoDisplayName = value
  }
}

function openCredentialDialog(provider: ModelProvider) {
  selectedProvider.value = provider
  apiKeyInput.value = ''
  credentialDialogOpen.value = true
}

function openRouteDialog(route?: ModelRoute) {
  editingRoute.value = route ?? null
  Object.assign(routeForm, route
    ? { key: route.key, name: route.name, providerModelId: route.providerModelId, enabled: route.enabled }
    : { key: '', name: '', providerModelId: modelOptions.value.find((item) => !item.disabled)?.value ?? '', enabled: true })
  routeDialogOpen.value = true
}

async function createProvider() {
  if (!providerForm.trustLevel) {
    ElMessage.error('请选择信任级别')
    return
  }
  try {
    const { apiKey, ...provider } = providerForm
    await adminApi.createModelProvider({ ...provider, trustLevel: providerForm.trustLevel, ...(apiKey ? { apiKey } : {}) })
    providerForm.apiKey = ''
    providerDialogOpen.value = false
    ElMessage.success(apiKey ? 'Provider 已创建，密钥已加密保存' : 'Provider 已创建')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Provider 创建失败')
  }
}

async function updateProvider() {
  if (!selectedProvider.value) return
  try {
    await adminApi.updateModelProvider({ providerId: selectedProvider.value.id, ...providerEditForm })
    providerEditDialogOpen.value = false
    ElMessage.success('Provider 已更新')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Provider 更新失败')
  }
}

async function createModel() {
  if (!selectedProvider.value) return
  try {
    await adminApi.createProviderModel({
      providerId: selectedProvider.value.id,
      ...modelForm,
      modelKey: (modelForm.modelKey ?? '').trim(),
      displayName: (modelForm.displayName ?? '').trim(),
    })
    modelDialogOpen.value = false
    ElMessage.success('模型已添加')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '模型添加失败')
  }
}

async function toggleModel(model: ProviderModel) {
  const status = model.status === 'active' ? 'disabled' : 'active'
  try {
    if (status === 'disabled' && enabledRoute.value?.providerModelId === model.id) {
      await ElMessageBox.confirm('当前启用的默认路由指向该模型。停用后没有可用的默认路由，新运行会被拒绝；已启动的运行不受影响。', `停用 ${model.displayName}`, { type: 'warning' })
    }
    await adminApi.setProviderModelStatus({ modelId: model.id, status })
    ElMessage.success(status === 'active' ? '模型已启用' : '模型已停用')
    await load()
  } catch (cause) {
    if (cause !== 'cancel') ElMessage.error(cause instanceof Error ? cause.message : '模型状态更新失败')
  }
}

async function saveCredential() {
  if (!selectedProvider.value) return
  try {
    if (!apiKeyInput.value) {
      ElMessage.error('请输入密钥')
      return
    }
    await adminApi.setModelProviderApiKey({ providerId: selectedProvider.value.id, apiKey: apiKeyInput.value })
    apiKeyInput.value = ''
    ElMessage.success('密钥已加密保存')
    credentialDialogOpen.value = false
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '密钥保存失败')
  }
}

async function saveRoute() {
  const target = modelOptions.value.find((item) => item.value === routeForm.providerModelId)
  if (routeForm.enabled && target?.disabled) {
    ElMessage.error('目标模型或其 Provider 已停用，不能设为默认路由')
    return
  }
  const current = enabledRoute.value
  try {
    if (editingRoute.value?.enabled && !routeForm.enabled) {
      await ElMessageBox.confirm('停用后没有启用的默认路由，新运行会被拒绝；已启动的运行不受影响。', `停用 ${editingRoute.value.name}`, { type: 'warning' })
    } else if (routeForm.enabled && current && current.id !== editingRoute.value?.id) {
      await ElMessageBox.confirm(`保存后将同时停用当前的默认路由“${current.name}”，之后新建的运行使用该路由。`, '设为默认路由', { type: 'warning' })
    }
  } catch {
    return
  }
  try {
    if (editingRoute.value) {
      await adminApi.updateModelRoute({ routeId: editingRoute.value.id, name: routeForm.name, providerModelId: routeForm.providerModelId, enabled: routeForm.enabled })
      ElMessage.success('模型路由已更新')
    } else {
      await adminApi.createModelRoute({ ...routeForm })
      ElMessage.success('模型路由已创建')
    }
    routeDialogOpen.value = false
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '模型路由保存失败')
  }
}

async function toggleRoute(route: ModelRoute) {
  const enabled = !route.enabled
  try {
    if (!enabled) {
      await ElMessageBox.confirm('停用后没有启用的默认路由，新运行会被拒绝；已启动的运行不受影响。', `停用 ${route.name}`, { type: 'warning' })
    } else if (enabledRoute.value && enabledRoute.value.id !== route.id) {
      await ElMessageBox.confirm(`启用后将同时停用当前的默认路由“${enabledRoute.value.name}”，之后新建的运行使用该路由。`, `设为默认路由`, { type: 'warning' })
    }
    await adminApi.updateModelRoute({ routeId: route.id, name: route.name, providerModelId: route.providerModelId, enabled })
    ElMessage.success(enabled ? '已设为默认路由' : '模型路由已停用')
    await load()
  } catch (cause) {
    if (cause !== 'cancel') ElMessage.error(cause instanceof Error ? cause.message : '状态更新失败')
  }
}

async function toggleProvider(provider: ModelProvider) {
  const status = provider.status === 'active' ? 'disabled' : 'active'
  try {
    if (status === 'disabled') {
      await ElMessageBox.confirm('停用后，指向该 Provider 的默认路由不可用；没有可用的默认路由时，新运行会被拒绝。已启动的运行使用启动时固定的路由，不受影响。', `停用 ${provider.name}`, { type: 'warning' })
    }
    await adminApi.setModelProviderStatus({ providerId: provider.id, status })
    ElMessage.success(status === 'active' ? 'Provider 已启用' : 'Provider 已停用')
    await load()
  } catch (cause) {
    if (cause !== 'cancel') ElMessage.error(cause instanceof Error ? cause.message : '状态更新失败')
  }
}

function usableCredential(provider: ModelProvider) {
  return provider.credential?.backend === 'postgres-encrypted' && provider.credential.status === 'configured'
}

function credentialStatusLabel(provider: ModelProvider) {
  if (!provider.credential) return '未登记'
  if (provider.credential.backend !== 'postgres-encrypted') return '需录入 API Key'
  return { configured: '已配置', missing: '缺失', revoked: '已撤销' }[provider.credential.status]
}

function credentialStatusType(provider: ModelProvider) {
  if (usableCredential(provider)) return 'success'
  if (provider.credential?.status === 'revoked') return 'danger'
  return 'warning'
}

function providerTypeLabel(type: ProviderType) {
  return { 'openai-completions': 'OpenAI Chat Completions 兼容', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' }[type]
}

function credentialSummary(provider: ModelProvider) {
  const credential = provider.credential
  if (!credential) return '尚未配置'
  if (credential.backend === 'postgres-encrypted') return credential.hint ? `平台加密保存 · 末尾 ${credential.hint}` : '平台加密保存'
  return `${credential.backend} / ${credential.externalRef}（已不生效，请录入 API Key）`
}

function trustLevelLabel(level: ProviderTrustLevel) {
  return level === 'internal' ? '内部部署' : '外部厂商'
}

onMounted(() => void load())
</script>

<template>
  <div class="ops-page model-governance-page">
    <div class="page-heading-row">
      <p class="page-note">登记 Provider、可用模型、平台默认路由和密钥引用；Agent 不单独配置模型。</p>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
    <el-alert class="route-effect-notice" type="info" :closable="false" show-icon title="默认路由决定新运行使用的模型，经平台模型网关调用" description="每次运行开始时固定当时启用的默认路由；更换默认路由只影响之后新建的运行，员工重新执行即使用新路由。模型请求经平台模型网关、用这里录入的厂商密钥转发，执行环境不持有厂商密钥；密钥缺失或无效（包括显示“需录入 API Key”的旧引用）时运行会失败并提示管理员处理。没有可用的默认路由（未启用、Provider 或模型已停用）时，新运行会被拒绝。厂商密钥以平台主密钥加密保存，不能读取、回显或导出。联网搜索只在默认路由为 DeepSeek 官方时可用。" />

    <section class="content-panel overview-strip" aria-label="模型治理概况">
      <dl class="overview-strip__stats">
        <div class="overview-stat"><dt>启用 Provider</dt><dd><strong class="overview-stat__value">{{ activeProviderCount }}</strong><small>共 {{ providers.length }} 个</small></dd></div>
        <div class="overview-stat"><dt>可治理模型</dt><dd><strong class="overview-stat__value">{{ modelCount }}</strong><small>按 Provider 注册</small></dd></div>
        <div class="overview-stat"><dt>凭据已配置</dt><dd><strong class="overview-stat__value">{{ configuredCredentialCount }}</strong><small>已录入厂商密钥的 Provider</small></dd></div>
        <div class="overview-stat"><dt>默认路由</dt><dd><strong class="overview-stat__value overview-stat__value--text">{{ enabledRoute?.name ?? '未启用' }}</strong><small>新运行使用的模型</small></dd></div>
      </dl>
    </section>

    <section class="content-panel content-panel--flush">
      <div class="governance-toolbar">
        <el-tabs v-model="activeTab" class="governance-tabs"><el-tab-pane label="Provider 与模型" name="providers" /><el-tab-pane label="模型路由" name="routes" /></el-tabs>
        <el-button v-if="authStore.canManage" type="primary" :icon="Plus" @click="activeTab === 'providers' ? openProviderDialog() : openRouteDialog()">{{ activeTab === 'providers' ? '新建 Provider' : '新建路由' }}</el-button>
      </div>

      <el-table v-if="activeTab === 'providers'" v-loading="loading" class="data-table" :data="pagedProviders" empty-text="暂无 Provider">
        <el-table-column label="Provider" min-width="220"><template #default="scope"><div class="stack-cell"><div class="provider-title"><strong>{{ scope.row.name }}</strong><el-tag size="small" :type="scope.row.trustLevel === 'internal' ? 'success' : 'warning'" effect="plain">{{ trustLevelLabel(scope.row.trustLevel) }}</el-tag></div><span>{{ scope.row.key }} · {{ providerTypeLabel(scope.row.providerType) }}</span></div></template></el-table-column>
        <el-table-column label="服务地址" min-width="150"><template #default="scope"><span class="mono-value">{{ scope.row.baseUrl }}</span></template></el-table-column>
        <el-table-column label="模型数" width="72"><template #default="scope">{{ scope.row.models.length }} 个</template></el-table-column>
        <el-table-column label="密钥" min-width="180"><template #default="scope"><div class="stack-cell"><el-tag :type="credentialStatusType(scope.row)" effect="plain">{{ credentialStatusLabel(scope.row) }}</el-tag><span>{{ credentialSummary(scope.row) }}</span></div></template></el-table-column>
        <el-table-column label="状态" width="80"><template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'" effect="plain">{{ scope.row.status === 'active' ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column v-if="authStore.canManage" label="操作" width="260" fixed="right"><template #default="scope"><el-button link type="primary" @click="openProviderEditDialog(scope.row)">编辑</el-button><el-button link type="primary" @click="openModelDialog(scope.row)">添加模型</el-button><el-button link type="primary" @click="openCredentialDialog(scope.row)">密钥</el-button><el-button link :type="scope.row.status === 'active' ? 'danger' : 'primary'" @click="toggleProvider(scope.row)">{{ scope.row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
        <el-table-column type="expand" width="48"><template #default="scope"><div class="model-expansion"><h3>已注册模型</h3><el-empty v-if="scope.row.models.length === 0" description="尚未添加模型" :image-size="54" /><div v-else class="model-card-grid"><article v-for="model in scope.row.models" :key="model.id"><div><strong>{{ model.displayName }}</strong><span>{{ model.modelKey }}</span></div><el-tag :type="model.status === 'active' ? 'success' : 'info'" effect="plain">{{ model.status === 'active' ? '启用' : '停用' }}</el-tag><p>{{ model.capabilities.join(' · ') || '未声明能力' }}</p><el-button v-if="authStore.canManage" class="model-card__action" link :type="model.status === 'active' ? 'danger' : 'primary'" @click="toggleModel(model)">{{ model.status === 'active' ? '停用模型' : '启用模型' }}</el-button></article></div></div></template></el-table-column>
      </el-table>

      <el-table v-else v-loading="loading" class="data-table" :data="pagedRoutes" empty-text="暂无模型路由">
        <el-table-column label="路由" min-width="230"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.name }}</strong><span>{{ scope.row.key }}</span></div></template></el-table-column>
        <el-table-column label="路由目标" min-width="280"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.modelName }}</strong><span>{{ scope.row.providerName }} / {{ scope.row.modelKey }}</span></div></template></el-table-column>
        <el-table-column label="状态" width="120"><template #default="scope"><el-tag :type="scope.row.enabled ? 'success' : 'info'" effect="plain">{{ scope.row.enabled ? '当前默认' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="更新于" min-width="180"><template #default="scope">{{ new Date(scope.row.updatedAt).toLocaleString('zh-CN') }}</template></el-table-column>
        <el-table-column v-if="authStore.canManage" label="操作" width="180" fixed="right"><template #default="scope"><el-button link type="primary" @click="openRouteDialog(scope.row)">编辑</el-button><el-button link :type="scope.row.enabled ? 'danger' : 'primary'" @click="toggleRoute(scope.row)">{{ scope.row.enabled ? '停用' : '设为默认' }}</el-button></template></el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-if="activeTab === 'providers'" v-model:current-page="providerPage" background layout="prev, pager, next" :total="providers.length" :page-size="10" /><el-pagination v-else v-model:current-page="routePage" background layout="prev, pager, next" :total="routes.length" :page-size="10" /></div>
    </section>

    <el-dialog v-model="providerDialogOpen" title="新建 Provider" width="620px" destroy-on-close>
      <el-form label-position="top" :model="providerForm"><div class="form-grid"><el-form-item label="Provider 名称" required><el-input v-model="providerForm.name" placeholder="例如：DeepSeek 官方" /></el-form-item><el-form-item label="Provider 标识" required><el-input v-model="providerForm.key" placeholder="例如：deepseek-official" /></el-form-item></div><el-form-item label="协议类型" required><el-select v-model="providerForm.providerType"><el-option v-for="option in providerTypeOptions" :key="option.value" :label="option.label" :value="option.value" :disabled="option.disabled" /></el-select></el-form-item><el-form-item label="信任级别" required><el-radio-group v-model="providerForm.trustLevel" aria-label="信任级别"><el-radio value="internal">内部部署</el-radio><el-radio value="external">外部厂商</el-radio></el-radio-group><p class="field-hint">内部部署指数据不出企业网络的模型服务；其余一律选外部厂商。后续数据防护按此级别处理发往模型的请求。</p></el-form-item><el-form-item label="服务地址" required><el-input v-model="providerForm.baseUrl" placeholder="https://api.example.com" /></el-form-item><el-form-item label="API Key"><el-input v-model="providerForm.apiKey" type="password" show-password autocomplete="new-password" placeholder="可稍后在“密钥”中填写" /><p class="field-hint">平台加密保存，只能写入、不能读出，保存后只显示末尾 4 位。网关上线前，执行仍使用 DSH 中配置的凭据，此处的密钥届时生效。</p></el-form-item></el-form>
      <template #footer><el-button @click="providerDialogOpen = false">取消</el-button><el-button type="primary" :icon="Connection" @click="createProvider">创建 Provider</el-button></template>
    </el-dialog>

    <el-dialog v-model="providerEditDialogOpen" :title="`编辑 ${selectedProvider?.name ?? ''}`" width="620px" destroy-on-close>
      <el-form label-position="top" :model="providerEditForm"><el-form-item label="Provider 名称" required><el-input v-model="providerEditForm.name" /></el-form-item><el-form-item label="信任级别" required><el-radio-group v-model="providerEditForm.trustLevel" aria-label="信任级别"><el-radio value="internal">内部部署</el-radio><el-radio value="external">外部厂商</el-radio></el-radio-group></el-form-item><el-form-item label="服务地址" required><el-input v-model="providerEditForm.baseUrl" /></el-form-item></el-form>
      <template #footer><el-button @click="providerEditDialogOpen = false">取消</el-button><el-button type="primary" @click="updateProvider">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="modelDialogOpen" :title="`为 ${selectedProvider?.name ?? ''} 添加模型`" width="600px" destroy-on-close>
      <el-form label-position="top" :model="modelForm"><div class="form-grid"><el-form-item label="模型标识" required>
        <div class="catalog-field">
          <el-autocomplete v-model="modelForm.modelKey" class="catalog-select" :fetch-suggestions="suggestModelKeys" clearable placeholder="选择或输入，例如：deepseek-v4-pro" aria-label="模型标识" @select="onModelKeySelect" />
          <el-button :icon="Refresh" :loading="catalogLoading" :disabled="!providerHasPlatformKey(selectedProvider)" aria-label="重新获取模型列表" @click="loadModelCatalog" />
        </div>
        <div class="catalog-hint" role="status">{{ catalogLoading ? '正在从厂商获取模型列表…' : catalogMessage }}</div>
      </el-form-item><el-form-item label="模型名称" required><el-input v-model="modelForm.displayName" placeholder="例如：DeepSeek V4 Pro" /></el-form-item></div><el-form-item label="能力"><el-select v-model="modelForm.capabilities" multiple allow-create filterable><el-option label="文本" value="text" /><el-option label="深度思考" value="thinking" /><el-option label="工具调用" value="tool-calling" /></el-select></el-form-item></el-form>
      <template #footer><el-button @click="modelDialogOpen = false">取消</el-button><el-button type="primary" @click="createModel">添加模型</el-button></template>
    </el-dialog>

    <el-dialog v-model="credentialDialogOpen" :title="`配置 ${selectedProvider?.name ?? ''} 的密钥`" width="620px" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon title="密钥以平台主密钥加密保存，只能写入、不能读出，保存后只显示末尾 4 位。模型请求经平台模型网关用此密钥转发，执行环境不持有厂商密钥。" />
      <el-alert v-if="selectedProvider?.credential && selectedProvider.credential.backend !== 'postgres-encrypted'" class="credential-legacy" type="warning" :closable="false" show-icon :title="`当前登记的是外部引用 ${selectedProvider.credential.externalRef}，模型网关无法使用；录入 API Key 后才能运行。`" />
      <el-form class="dialog-form" label-position="top"><el-form-item label="API Key" required><el-input v-model="apiKeyInput" type="password" show-password autocomplete="new-password" :placeholder="selectedProvider?.credential?.backend === 'postgres-encrypted' ? '已保存，填写新密钥即替换' : '粘贴厂商提供的 API Key'" /></el-form-item></el-form>
      <template #footer><el-button @click="credentialDialogOpen = false">取消</el-button><el-button type="primary" :icon="SetUp" @click="saveCredential">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="routeDialogOpen" :title="editingRoute ? `编辑 ${editingRoute.name}` : '新建默认路由'" width="640px" destroy-on-close>
      <el-alert type="info" :closable="false" show-icon title="每个租户只有一条启用的默认路由，启用一条会自动停用其余路由。新运行使用启用的默认路由，进行中的运行不受影响。" />
      <el-form class="dialog-form" label-position="top" :model="routeForm"><div class="form-grid"><el-form-item label="路由名称" required><el-input v-model="routeForm.name" placeholder="例如：平台默认模型路由" /></el-form-item><el-form-item label="路由标识" required><el-input v-model="routeForm.key" :disabled="Boolean(editingRoute)" placeholder="例如：primary-model" /></el-form-item></div><el-form-item label="目标模型" required><el-select v-model="routeForm.providerModelId" filterable><el-option v-for="option in modelOptions" :key="option.value" :label="option.label" :value="option.value" :disabled="option.disabled" /></el-select></el-form-item><el-form-item><el-checkbox v-model="routeForm.enabled">{{ editingRoute ? '启用为默认路由' : '创建后立即设为默认路由' }}</el-checkbox></el-form-item></el-form>
      <template #footer><el-button @click="routeDialogOpen = false">取消</el-button><el-button type="primary" @click="saveRoute">{{ editingRoute ? '保存' : '创建路由' }}</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-heading-row, .governance-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.governance-toolbar { min-height: 56px; padding: 0 14px; border-bottom: 1px solid var(--color-border); }
.governance-tabs { min-width: 300px; }
.governance-tabs :deep(.el-tabs__header) { margin: 0; }
.governance-tabs :deep(.el-tabs__nav-wrap::after) { display: none; }
.stack-cell { display: flex; min-width: 0; flex-direction: column; align-items: flex-start; gap: 4px; }
.stack-cell strong { color: var(--color-text-heading); }
.provider-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.stack-cell span, .mono-value { color: var(--color-text-secondary); font-size: var(--font-size-caption); overflow-wrap: anywhere; }
.mono-value { display: block; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.overview-stat__value--text { font-size: var(--font-size-body); overflow-wrap: anywhere; }
.model-expansion { padding: 12px 56px 24px; background: var(--color-bg-page); }
.model-expansion h3 { margin: 0 0 12px; font-size: var(--font-size-body); }
.model-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.model-card-grid article { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-base); }
.model-card-grid article div { display: flex; flex-direction: column; }
.model-card-grid article span, .model-card-grid article p { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.model-card-grid article p { grid-column: 1 / -1; margin: 0; }
.model-card__action { grid-column: 1 / -1; justify-self: start; }
.credential-legacy { margin-top: 10px; }
.field-hint { margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.5; }
.catalog-field { display: flex; gap: 8px; width: 100%; }
.catalog-field .catalog-select { flex: 1; min-width: 0; }
.catalog-hint { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--color-text-secondary); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.dialog-form { margin-top: 18px; }
.form-grid :deep(.el-select), .form-grid :deep(.el-input-number), .dialog-form :deep(.el-select), :deep(.el-form-item .el-select) { width: 100%; }
</style>
