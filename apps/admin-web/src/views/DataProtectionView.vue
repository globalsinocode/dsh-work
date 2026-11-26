<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type {
  DataProtectionAllowRecord,
  DataProtectionOverview,
  DataProtectionPreview,
  DataProtectionRecord,
  DataProtectionTermRecord,
  ModelProvider,
  ModelUsageRange,
  RunSource,
} from '@/types/domain'
import { decodeCsv, parseTermsCsv } from './data-protection-csv'

type TabName = 'records' | 'rules' | 'terms' | 'allow' | 'preview'

const auth = useAuthStore()
const activeTab = ref<TabName>('records')
const error = ref('')
const pageSize = 20

const rangeOptions: { value: ModelUsageRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
]
const sourceLabels: Record<RunSource, string> = {
  conversation: '员工对话', automation: '定时任务', routine: '主动任务', validation: '发布试运行',
  api: 'API 调用', event: '事件触发', delegation: '委派', system: '系统',
}
const entryLabels: Record<string, string> = {
  conversation: '对话', 'task-execution': 'API 调用', 'automation-save': '定时任务（保存时）', 'automation-trigger': '定时任务（触发时）', 'routine-save': '主动任务（保存时）', 'routine-trigger': '主动任务（触发时）',
}

const range = ref<ModelUsageRange>('7d')
const category = ref('')
const action = ref('')
const employee = ref('')
const page = ref(1)
const overview = ref<DataProtectionOverview | null>(null)
const records = ref<DataProtectionRecord[]>([])
const total = ref(0)
const recordsLoading = ref(false)
const expanded = ref<string[]>([])
let recordsRequest = 0

const stats = computed(() => {
  const value = overview.value
  if (!value) return []
  return [
    { label: '外部厂商请求', value: value.externalRequests },
    { label: '有遮盖的请求', value: value.maskedRequests },
    { label: '被拦截的消息', value: value.blockedMessages, danger: value.blockedMessages > 0 },
    { label: '密钥', value: value.secret },
    { label: '个人信息', value: value.personal },
    { label: '保密词表', value: value.term },
    { label: '含图片的请求', value: value.imageRequests },
  ]
})

function fail(cause: unknown, fallback: string) {
  error.value = cause instanceof Error ? cause.message : fallback
}

let overviewRequest = 0

/** 概况只随时间范围变化；翻页和其他筛选不重新请求。 */
async function loadOverview() {
  const request = ++overviewRequest
  try {
    const next = await adminApi.getDataProtectionOverview({ range: range.value })
    if (request === overviewRequest) overview.value = next
  } catch (cause) {
    if (request === overviewRequest) fail(cause, '命中概况加载失败')
  }
}

async function loadRecords() {
  error.value = ''
  const request = ++recordsRequest
  const filter = {
    range: range.value,
    ...(category.value ? { category: category.value } : {}),
    ...(action.value ? { action: action.value } : {}),
    ...(employee.value.trim() ? { employee: employee.value.trim() } : {}),
  }
  recordsLoading.value = true
  try {
    const nextRecords = await adminApi.getDataProtectionRecords(filter, page.value, pageSize)
    if (request !== recordsRequest) return
    records.value = nextRecords.items
    total.value = nextRecords.total
    expanded.value = []
  } catch (cause) {
    if (request === recordsRequest) fail(cause, '命中记录加载失败')
  } finally {
    if (request === recordsRequest) recordsLoading.value = false
  }
}

function reloadFromFirstPage() {
  page.value = 1
  void loadRecords()
}

function onRangeChange() {
  void loadOverview()
  reloadFromFirstPage()
}

function toggleRow(row: DataProtectionRecord) {
  expanded.value = expanded.value.includes(row.id) ? expanded.value.filter(id => id !== row.id) : [...expanded.value, row.id]
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function hitTags(row: DataProtectionRecord) {
  return [
    { label: '密钥', count: row.secret, tone: 'danger' },
    { label: '个人信息', count: row.personal, tone: 'info' },
    { label: '保密词表', count: row.term, tone: 'neutral' },
  ].filter(item => item.count > 0)
}

function recordDetails(row: DataProtectionRecord) {
  if (row.action === 'blocked') {
    return [
      { label: '入口', value: entryLabels[row.entry ?? ''] ?? row.entry ?? '—' },
      { label: '会话', value: row.sessionId ?? '—' },
      { label: '是否创建运行', value: '否' },
    ]
  }
  return [
    { label: '运行', value: row.runId ?? '—' },
    { label: '执行', value: row.attemptId ?? '—' },
    { label: 'Provider', value: row.providerName ?? '—' },
    { label: '请求类型', value: row.endpoint === 'search' ? '联网搜索' : '对话' },
    { label: '信任级别', value: row.trustLevel === 'internal' ? '内部部署' : '外部厂商' },
    { label: '含图片', value: row.hasImage ? '是' : '否' },
  ]
}

const rules = [
  { category: '密钥', what: 'API Key、私钥、JWT、Bearer Token、连接串密码、“密码为 / token:”等字段', from: '内置', message: '拦截', messageTone: 'danger', other: '遮盖', otherTone: 'warning' },
  { category: '个人信息', what: '手机号、身份证号、银行卡号、邮箱', from: '内置', message: '遮盖', messageTone: 'warning', other: '遮盖', otherTone: 'warning' },
  { category: '保密词表', what: '项目代号、客户名、内部域名等', from: '管理员维护', message: '遮盖', messageTone: 'warning', other: '遮盖', otherTone: 'warning' },
  { category: '图片与扫描件', what: '不识别图中文字', from: '—', message: '放行并记录', messageTone: 'neutral', other: '放行并记录', otherTone: 'neutral' },
]
const providers = ref<ModelProvider[]>([])

async function loadProviders() {
  try {
    providers.value = await adminApi.getModelProviders()
  } catch (cause) {
    fail(cause, 'Provider 加载失败')
  }
}

const terms = ref<DataProtectionTermRecord[]>([])
const allowlist = ref<DataProtectionAllowRecord[]>([])
const termsLoading = ref(false)
const allowLoading = ref(false)
const termSearch = ref('')
const termPage = ref(1)
const termPageSize = 20
let termsRequest = 0
let allowRequest = 0

const matchedTerms = computed(() => {
  const keyword = termSearch.value.trim().toLowerCase()
  return keyword ? terms.value.filter(term => term.value.toLowerCase().includes(keyword)) : terms.value
})
const visibleTerms = computed(() => matchedTerms.value.slice((termPage.value - 1) * termPageSize, termPage.value * termPageSize))
const termDraft = ref('')
const draftCase = ref(false)
const draftWhole = ref(false)
const allowDraft = ref('')
const fileInput = ref<HTMLInputElement>()

async function loadTerms() {
  const request = ++termsRequest
  termsLoading.value = true
  try {
    const next = await adminApi.getDataProtectionTerms()
    if (request !== termsRequest) return
    terms.value = next
    // 删除后当前页可能已经不存在。
    termPage.value = Math.min(termPage.value, Math.max(1, Math.ceil(matchedTerms.value.length / termPageSize)))
  } catch (cause) {
    if (request === termsRequest) fail(cause, '保密词表加载失败')
  } finally {
    if (request === termsRequest) termsLoading.value = false
  }
}

async function loadAllowlist() {
  const request = ++allowRequest
  allowLoading.value = true
  try {
    const next = await adminApi.getDataProtectionAllowlist()
    if (request === allowRequest) allowlist.value = next
  } catch (cause) {
    if (request === allowRequest) fail(cause, '白名单加载失败')
  } finally {
    if (request === allowRequest) allowLoading.value = false
  }
}

async function addTerm() {
  const value = termDraft.value.trim()
  if (!value) return
  error.value = ''
  try {
    const result = await adminApi.addDataProtectionTerms([{ value, caseSensitive: draftCase.value, wholeWord: draftWhole.value }])
    if (result.added === 0) {
      ElMessage.warning('词条已存在，没有重复添加')
      return
    }
    termDraft.value = ''
    draftCase.value = false
    draftWhole.value = false
    ElMessage.success('已添加，立即对之后的请求生效')
    await loadTerms()
  } catch (cause) {
    fail(cause, '添加失败')
  }
}

async function importCsv(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = ''
  try {
    const parsed = parseTermsCsv(decodeCsv(await file.arrayBuffer()))
    if (parsed.length === 0) {
      ElMessage.warning('文件里没有词条')
      return
    }
    const result = await adminApi.addDataProtectionTerms(parsed)
    ElMessage.success(`CSV 导入完成：新增 ${result.added} 条，跳过 ${result.skipped} 条重复`)
    await loadTerms()
  } catch (cause) {
    fail(cause, '导入失败')
  }
}

async function confirmRemove(subject: string) {
  try {
    await ElMessageBox.confirm(`确定删除${subject}吗？删除后立即对之后的请求生效。`, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    return true
  } catch {
    return false
  }
}

async function removeTerm(row: DataProtectionTermRecord) {
  if (!(await confirmRemove('这个词条'))) return
  error.value = ''
  try {
    await adminApi.removeDataProtectionTerm(row.id)
    ElMessage.success('已删除')
    await loadTerms()
  } catch (cause) {
    fail(cause, '删除失败')
  }
}

async function addAllow() {
  const value = allowDraft.value.trim()
  if (!value) return
  error.value = ''
  try {
    const result = await adminApi.addDataProtectionAllow(value)
    allowDraft.value = ''
    if (result.added) ElMessage.success('已添加到白名单')
    else ElMessage.warning('白名单里已有这个值')
    await loadAllowlist()
  } catch (cause) {
    fail(cause, '添加失败')
  }
}

async function removeAllow(row: DataProtectionAllowRecord) {
  if (!(await confirmRemove('这个放行值'))) return
  error.value = ''
  try {
    await adminApi.removeDataProtectionAllow(row.id)
    ElMessage.success('已从白名单删除')
    await loadAllowlist()
  } catch (cause) {
    fail(cause, '删除失败')
  }
}

const previewText = ref('')
const previewResult = ref<DataProtectionPreview | null>(null)
const previewing = ref(false)

const previewVerdict = computed(() => {
  const result = previewResult.value
  if (!result) return ''
  if (result.wouldBlock) return '员工作为消息发送时会被拦截：这段文字包含密钥。出现在文件或工具结果里时只遮盖，不拦截。'
  return result.secret + result.personal + result.term > 0 ? '可以发送，命中的内容会被遮盖。' : '没有命中，内容原样发送。'
})

async function runPreview() {
  if (!previewText.value.trim()) return
  previewing.value = true
  error.value = ''
  try {
    previewResult.value = await adminApi.previewDataProtection(previewText.value)
  } catch (cause) {
    fail(cause, '检测失败')
  } finally {
    previewing.value = false
  }
}

function onTabChange(name: string | number) {
  error.value = ''
  if (name === 'rules') void loadProviders()
  if (name === 'terms' && auth.canAccessDataProtectionTerms) void loadTerms()
  if (name === 'allow' && auth.canAccessDataProtectionTerms) void loadAllowlist()
}

onMounted(() => {
  void loadOverview()
  void loadRecords()
})
</script>

<template>
  <div class="ops-page data-protection-page">
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />

    <section class="content-panel data-protection-tabs">
      <el-tabs v-model="activeTab" aria-label="数据防护" @tab-change="onTabChange">
        <el-tab-pane label="命中记录" name="records" />
        <el-tab-pane label="识别规则" name="rules" />
        <el-tab-pane label="保密词表" name="terms" />
        <el-tab-pane label="白名单" name="allow" />
        <el-tab-pane label="检测试用" name="preview" />
      </el-tabs>
    </section>

    <template v-if="activeTab === 'records'">
      <section class="content-panel data-protection-filters" aria-label="筛选">
        <el-radio-group v-model="range" aria-label="时间范围" @change="onRangeChange">
          <el-radio-button v-for="option in rangeOptions" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
        </el-radio-group>
        <el-select v-model="category" class="data-protection-select" clearable placeholder="全部类别" aria-label="类别" @change="reloadFromFirstPage">
          <el-option label="密钥" value="secret" />
          <el-option label="个人信息" value="personal" />
          <el-option label="保密词表" value="term" />
        </el-select>
        <el-select v-model="action" class="data-protection-select" clearable placeholder="全部处理方式" aria-label="处理方式" @change="reloadFromFirstPage">
          <el-option label="已遮盖" value="masked" />
          <el-option label="已拦截" value="blocked" />
        </el-select>
        <el-input v-model="employee" class="data-protection-select" clearable placeholder="员工姓名" aria-label="员工" @change="reloadFromFirstPage" />
        <span class="page-note data-protection-note">按平台时区统计</span>
      </section>

      <section v-loading="recordsLoading" class="content-panel overview-strip" aria-label="命中概况">
        <dl class="overview-strip__stats">
          <div v-for="stat in stats" :key="stat.label" class="overview-stat" :class="{ 'overview-stat--danger': stat.danger }">
            <dt>{{ stat.label }}</dt>
            <dd><strong class="overview-stat__value">{{ stat.value.toLocaleString('zh-CN') }}</strong></dd>
          </div>
        </dl>
      </section>

      <section class="content-panel content-panel--flush" aria-label="命中明细">
        <div class="data-protection-head">
          <h2 class="data-protection-title">命中明细</h2>
          <span class="page-note">每条对应一次发往模型的请求或一次被拦截的消息。为防止二次泄露，不保存命中的原文，只记类别和次数。</span>
        </div>
        <el-table class="data-table data-protection-records" :data="records" row-key="id" :expand-row-keys="expanded" empty-text="当前筛选范围内没有命中记录">
          <el-table-column type="expand" width="1">
            <template #default="{ row }">
              <dl class="data-protection-details">
                <div v-for="item in recordDetails(row)" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
              </dl>
            </template>
          </el-table-column>
          <el-table-column label="时间" width="130"><template #default="{ row }">{{ formatTime(row.time) }}</template></el-table-column>
          <el-table-column label="员工" prop="employeeName" min-width="90" />
          <el-table-column label="部门" prop="department" min-width="100" />
          <el-table-column label="来源" min-width="100"><template #default="{ row }">{{ sourceLabels[row.source as RunSource] }}</template></el-table-column>
          <el-table-column label="模型" min-width="150"><template #default="{ row }">{{ row.model ?? '—' }}</template></el-table-column>
          <el-table-column label="命中" min-width="190">
            <template #default="{ row }">
              <div class="data-protection-hits"><span v-for="hit in hitTags(row)" :key="hit.label" class="status-tag" :class="`status-tag--${hit.tone}`">{{ hit.label }} {{ hit.count }}</span></div>
            </template>
          </el-table-column>
          <el-table-column label="处理" width="90">
            <template #default="{ row }"><span class="status-tag" :class="row.action === 'blocked' ? 'status-tag--danger' : 'status-tag--warning'">{{ row.action === 'blocked' ? '已拦截' : '已遮盖' }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="96">
            <template #default="{ row }"><el-button link type="primary" @click="toggleRow(row)">{{ expanded.includes(row.id) ? '收起' : '详情' }}</el-button></template>
          </el-table-column>
        </el-table>
        <div v-if="total > pageSize" class="data-protection-pager">
          <el-pagination v-model:current-page="page" background layout="prev, pager, next" :total="total" :page-size="pageSize" @current-change="loadRecords" />
        </div>
      </section>
    </template>

    <section v-else-if="activeTab === 'rules'" class="content-panel content-panel--flush" aria-label="识别规则">
      <div class="data-protection-head">
        <h2 class="data-protection-title">识别规则</h2>
        <span class="page-note">内置规则始终生效，不需要配置。内部部署模型不处理。</span>
      </div>
      <el-table class="data-table" :data="rules">
        <el-table-column label="类别" prop="category" width="130" />
        <el-table-column label="识别什么" prop="what" min-width="320" />
        <el-table-column label="来源" prop="from" width="110" />
        <el-table-column label="员工本条消息" width="150"><template #default="{ row }"><span class="status-tag" :class="`status-tag--${row.messageTone}`">{{ row.message }}</span></template></el-table-column>
        <el-table-column label="历史、文件、工具结果" width="200"><template #default="{ row }"><span class="status-tag" :class="`status-tag--${row.otherTone}`">{{ row.other }}</span></template></el-table-column>
      </el-table>
      <div class="data-protection-head data-protection-head--ruled">
        <h2 class="data-protection-title">Provider 信任级别</h2>
        <span class="page-note">在“模型治理”中修改</span>
      </div>
      <div class="data-protection-providers">
        <span v-for="provider in providers" :key="provider.key">{{ provider.name }}
          <span class="status-tag" :class="provider.trustLevel === 'internal' ? 'status-tag--success' : 'status-tag--warning'">{{ provider.trustLevel === 'internal' ? '内部部署' : '外部厂商' }}</span>
        </span>
      </div>
    </section>

    <section v-else-if="(activeTab === 'terms' || activeTab === 'allow') && !auth.canAccessDataProtectionTerms" class="content-panel data-protection-locked">
      <h2 class="data-protection-title">没有查看权限</h2>
      <p class="page-note">词表和白名单是机密内容，需要“数据防护词表”权限。请联系平台管理员授权。</p>
    </section>

    <section v-else-if="activeTab === 'terms'" v-loading="termsLoading" class="content-panel content-panel--flush" aria-label="保密词表">
      <form v-if="auth.canWrite('dlp')" class="data-protection-form" @submit.prevent="addTerm">
        <el-input v-model="termDraft" class="data-protection-input" maxlength="200" placeholder="项目代号、客户名、内部域名等" aria-label="词条" />
        <el-checkbox v-model="draftCase">区分大小写</el-checkbox>
        <el-checkbox v-model="draftWhole">整词匹配</el-checkbox>
        <el-button type="primary" native-type="submit">添加</el-button>
        <el-button @click="fileInput?.click()">导入 CSV</el-button>
        <input ref="fileInput" class="data-protection-file" type="file" accept=".csv,text/csv" aria-label="选择 CSV 文件" @change="importCsv">
        <span class="page-note data-protection-note">{{ terms.length }} / 5000 条</span>
      </form>
      <div class="data-protection-search">
        <el-input v-model="termSearch" class="data-protection-input" clearable placeholder="查找词条" aria-label="查找" @input="termPage = 1" />
      </div>
      <el-table class="data-table" :data="visibleTerms" :empty-text="termSearch.trim() ? '没有匹配的词条' : '还没有词条'">
        <el-table-column label="词条" prop="value" min-width="240" />
        <el-table-column label="区分大小写" width="120"><template #default="{ row }">{{ row.caseSensitive ? '是' : '否' }}</template></el-table-column>
        <el-table-column label="整词匹配" width="120"><template #default="{ row }">{{ row.wholeWord ? '是' : '否' }}</template></el-table-column>
        <el-table-column label="添加时间" width="150"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
        <el-table-column v-if="auth.canWrite('dlp')" label="操作" width="90">
          <template #default="{ row }"><el-button link type="danger" :aria-label="`删除词条 ${row.value}`" @click="removeTerm(row)">删除</el-button></template>
        </el-table-column>
      </el-table>
      <div v-if="matchedTerms.length > termPageSize" class="data-protection-pager">
        <el-pagination v-model:current-page="termPage" background layout="prev, pager, next" :total="matchedTerms.length" :page-size="termPageSize" />
      </div>
      <p class="page-note data-protection-foot">词表命中的内容会被遮盖，不会拦截消息。保存后立即对之后的请求生效。CSV 每行一个词条，可选第二、三列表示区分大小写和整词匹配（是/否）。变更只记谁在何时增删了多少条，不记词条内容。</p>
    </section>

    <section v-else-if="activeTab === 'allow'" v-loading="allowLoading" class="content-panel content-panel--flush" aria-label="白名单">
      <form v-if="auth.canWrite('dlp')" class="data-protection-form" @submit.prevent="addAllow">
        <el-input v-model="allowDraft" class="data-protection-input" maxlength="500" placeholder="例如公司对外客服邮箱" aria-label="放行的值" />
        <el-button type="primary" native-type="submit">添加</el-button>
      </form>
      <el-table class="data-table" :data="allowlist" empty-text="白名单为空">
        <el-table-column label="值" prop="value" min-width="320" />
        <el-table-column label="添加时间" width="150"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
        <el-table-column v-if="auth.canWrite('dlp')" label="操作" width="90">
          <template #default="{ row }"><el-button link type="danger" :aria-label="`删除白名单 ${row.value}`" @click="removeAllow(row)">删除</el-button></template>
        </el-table-column>
      </el-table>
      <p class="page-note data-protection-foot">整值匹配，不区分大小写。白名单里的值不遮盖，消息里出现也不拦截。</p>
    </section>

    <section v-else class="content-panel data-protection-preview" aria-label="检测试用">
      <label class="page-note" for="data-protection-preview-text">输入一段文本，看会被如何处理</label>
      <el-input id="data-protection-preview-text" v-model="previewText" type="textarea" :rows="5" maxlength="20000" />
      <div class="data-protection-preview__actions">
        <el-button type="primary" :loading="previewing" :disabled="!auth.canWrite('dlp')" @click="runPreview">检测</el-button>
        <span class="page-note">{{ auth.canWrite('dlp') ? '只在此页显示结果，不写入审计，也不发给模型。' : '需要管理写权限才能检测。' }}</span>
      </div>
      <template v-if="previewResult">
        <el-alert :title="previewVerdict" :type="previewResult.wouldBlock ? 'error' : 'info'" :closable="false" show-icon />
        <div class="data-protection-hits">
          <span class="status-tag status-tag--neutral">密钥：{{ previewResult.secret }} 处</span>
          <span class="status-tag status-tag--neutral">个人信息：{{ previewResult.personal }} 处</span>
          <span class="status-tag status-tag--neutral">保密词表：{{ previewResult.term }} 处</span>
        </div>
        <div>
          <p class="page-note">外部厂商实际收到的内容</p>
          <pre class="data-protection-masked" data-testid="data-protection-masked">{{ previewResult.maskedText }}</pre>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.data-protection-tabs { padding-block: 0; }
.data-protection-tabs :deep(.el-tabs__header) { margin: 0; }
.data-protection-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.data-protection-select { width: 150px; }
.data-protection-input { width: 300px; }
.data-protection-note { margin-left: auto; }
.data-protection-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; padding: 12px var(--spacing-card); }
.data-protection-head--ruled { border-top: 1px solid var(--color-bg-subtle); }
.data-protection-title { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); font-weight: var(--font-weight-title); }
.data-protection-hits { display: flex; flex-wrap: wrap; gap: 4px; }
.data-protection-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px 20px; margin: 0; padding: 4px var(--spacing-card); font-size: var(--font-size-caption); }
.data-protection-details dt { color: var(--color-text-secondary); }
.data-protection-details dd { margin: 2px 0 0; color: var(--color-text-heading); word-break: break-all; }
.data-protection-records :deep(.el-table__expand-column .cell) { display: none; }
.data-protection-pager { display: flex; justify-content: flex-end; padding: 10px var(--spacing-card); }
.data-protection-providers { display: flex; flex-wrap: wrap; gap: 8px 24px; padding: 0 var(--spacing-card) var(--spacing-card); }
.data-protection-locked { padding-block: 48px; text-align: center; }
.data-protection-form { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: var(--spacing-card); }
.data-protection-search { padding: 0 var(--spacing-card) 12px; }
.data-protection-file { display: none; }
.data-protection-foot { padding: 10px var(--spacing-card); border-top: 1px solid var(--color-bg-subtle); }
.data-protection-preview { display: flex; flex-direction: column; gap: 12px; }
.data-protection-preview__actions { display: flex; align-items: center; gap: 12px; }
.data-protection-masked { margin: 6px 0 0; padding: 8px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-tag); background: var(--color-bg-page); font: inherit; white-space: pre-wrap; word-break: break-all; }
</style>
