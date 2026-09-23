<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import { ArrowDown, Check, Clock, Close, Connection, Delete, DocumentCopy, Key, Loading, Plus, Refresh, Search, SwitchButton, View } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import SkillInstallationPanel from '@/components/SkillInstallationPanel.vue'
import { useListPagination } from '@/composables/use-list-pagination'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useToolGovernanceStore } from '@/stores/toolGovernance'
import type { ConnectorDefinition, McpConnectionTestResult, SkillDefinition, SkillReleaseRecord, SkillTestRunProgress, SkillVersionRecord, ToolCatalogCandidate, ToolDefinition } from '@/types/domain'

type CapabilityTab = 'skills' | 'install' | 'tools' | 'connectors'

const authStore = useAuthStore()
const contentStore = useContentStore()
const toolStore = useToolGovernanceStore()
const router = useRouter()
const route = useRoute()
const activeTab = computed<CapabilityTab>(() => {
  if (route.path === '/skills/install') return authStore.canManage ? 'install' : 'skills'
  if (route.path === '/tools') return 'tools'
  if (route.path === '/connectors') return 'connectors'
  return 'skills'
})
const managedSkills = computed(() => contentStore.skills.filter(skill => skill.installationRole !== 'dependency'))
const tabs = computed<Array<{ id: CapabilityTab; label: string; count?: number }>>(() => [
  { id: 'skills', label: 'Skill 列表', count: managedSkills.value.length },
  ...(authStore.canManage ? [{ id: 'install' as const, label: '新增 Skill' }] : []),
])
const skillSection = computed(() => activeTab.value === 'skills' || activeTab.value === 'install')
const query = ref('')
const detailOpen = ref(false)
const detailTitle = ref('')
const detailRows = ref<Array<{ label: string; value: string }>>([])
const detailType = ref<'skill' | 'tool' | 'connector'>('skill')
const detailTargetId = ref('')
const skillDetailTab = ref<'config' | 'versions' | 'releases'>('config')
const actionLoading = ref('')
const healthRefreshing = ref(false)
const mcpCreateDialogOpen = ref(false)
const mcpTesting = ref(false)
const mcpCreating = ref(false)
const mcpTestResult = ref<McpConnectionTestResult | null>(null)
const mcpTestError = ref<{ title: string; description: string } | null>(null)
const testedMcpSignature = ref('')
const mcpToolsDialogOpen = ref(false)
const selectedMcpToolsConnectorId = ref('')
const mcpCredentialDialogOpen = ref(false)
const selectedMcpCredentialConnectorId = ref('')
const mcpCredentialToken = ref('')
const mcpCredentialRotating = ref(false)
const mcpCreateForm = reactive({
  name: '', endpoint: '', authType: 'none' as 'none' | 'bearer', bearerToken: '', scopeDescription: '',
})
const mcpConnectionSignature = computed(() => JSON.stringify({
  name: mcpCreateForm.name.trim(),
  endpoint: mcpCreateForm.endpoint.trim(),
  authType: mcpCreateForm.authType,
  bearerToken: mcpCreateForm.authType === 'bearer' ? mcpCreateForm.bearerToken : '',
}))
const mcpConnectionInputReady = computed(() => Boolean(
  mcpCreateForm.name.trim()
  && mcpCreateForm.endpoint.trim()
  && (mcpCreateForm.authType !== 'bearer' || mcpCreateForm.bearerToken),
))
const mcpCanRegister = computed(() => Boolean(
  mcpConnectionInputReady.value
  && mcpCreateForm.scopeDescription.trim()
  && mcpTestResult.value
  && testedMcpSignature.value === mcpConnectionSignature.value,
))
watch(mcpConnectionSignature, (signature) => {
  if (testedMcpSignature.value && signature !== testedMcpSignature.value) {
    mcpTestResult.value = null
    mcpTestError.value = null
    testedMcpSignature.value = ''
  }
})
const toolCatalogDialogOpen = ref(false)
const toolCatalogQuery = ref('')
const toolCatalogFilter = ref<'ready' | 'all'>('ready')
const selectedToolCandidate = ref<ToolCatalogCandidate | null>(null)
const toolAdding = ref(false)
const toolCreateForm = reactive({
  allowedRoles: [] as string[],
  dataScopes: [] as string[],
  approvalPolicy: 'none' as ToolDefinition['approvalPolicy'],
})
const skillActionFeedback = ref<{
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  description: string
} | null>(null)
const skillTestDialogOpen = ref(false)
const skillTestTarget = ref<SkillDefinition | null>(null)
const skillTestProgress = ref<SkillTestRunProgress | null>(null)
const skillTestStarting = ref(false)
const skillTestPublishing = ref(false)
const skillTestPublished = ref(false)
const skillTestError = ref('')
let skillTestPollTimer: ReturnType<typeof setTimeout> | undefined
let skillTestPollEpoch = 0

const skillTestActive = computed(() => ['queued', 'running', 'waiting', 'cancel_requested'].includes(skillTestProgress.value?.status ?? ''))
const skillTestResultTitle = computed(() => skillTestProgress.value?.status === 'passed' ? '可以发布' : '暂不能发布')
const skillTestResultDescription = computed(() => {
  const progress = skillTestProgress.value
  if (!progress) return ''
  if (progress.status !== 'passed') return compactResultSummary(progress.resultSummary ?? '试运行未通过，请检查失败步骤后重试。')
  const skillCount = progress.steps.filter(step => step.id.startsWith('activation:')).length
  const pythonCount = progress.steps.filter(step => step.id.startsWith('python:')).length
  const details = [`${skillCount || 1} 个 Skill 已验证`]
  if (pythonCount) details.push(`${pythonCount} 个 Python 入口执行成功`)
  details.push('DSH 已返回有效结果')
  return `${details.join('，')}。`
})

const selectedSkill = computed(() => contentStore.skills.find((item) => item.id === detailTargetId.value))
const selectedSkillVersions = computed(() => contentStore.skillVersions.filter((item) => item.skillId === detailTargetId.value))
const selectedSkillReleases = computed(() => contentStore.skillReleaseRecords.filter((item) => item.skillId === detailTargetId.value))

const filteredSkills = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return managedSkills.value.filter((item) => !keyword || `${item.name} ${item.description} ${item.owner} ${item.id} ${(item.dependencies ?? []).map(dependency => `${dependency.name} ${dependency.id}`).join(' ')}`.toLowerCase().includes(keyword))
})
const filteredTools = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.tools
    .filter((item) => !keyword || `${item.name} ${item.id} ${item.system} ${item.description}`.toLowerCase().includes(keyword))
})
const detailToolGovernance = computed(() =>
  detailType.value === 'tool'
    ? toolStore.governanceOf(detailTargetId.value)
    : undefined,
)
const toolReferences = computed(() =>
  detailType.value === 'tool'
    ? toolStore.referencesOf(detailTargetId.value, contentStore.agents, contentStore.agentVersions)
    : [],
)
const filteredConnectors = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.connectors
    .filter(item => item.protocol === 'mcp')
    .filter((item) => !keyword || `${item.name} ${item.id} ${item.mcp?.serverName ?? ''}`.toLowerCase().includes(keyword))
})
const selectedMcpToolsConnector = computed(() => contentStore.connectors.find(item => item.id === selectedMcpToolsConnectorId.value))
const selectedMcpCredentialConnector = computed(() => contentStore.connectors.find(item => item.id === selectedMcpCredentialConnectorId.value))
const toolRoleOptions = computed(() => [...new Set([
  ...contentStore.tools.flatMap(tool => tool.allowedRoles),
  ...contentStore.toolCatalog.flatMap(tool => tool.defaultAllowedRoles),
  ...toolCreateForm.allowedRoles,
])].sort((left, right) => left.localeCompare(right, 'zh-CN')))
const toolScopeOptions = computed(() => [...new Set([
  ...contentStore.tools.flatMap(tool => tool.dataScopes),
  ...contentStore.toolCatalog.flatMap(tool => tool.defaultDataScopes),
  ...toolCreateForm.dataScopes,
])])
const readyToolCandidateCount = computed(() => contentStore.toolCatalog.filter(tool => tool.status === 'ready').length)
const filteredToolCatalog = computed(() => {
  const keyword = toolCatalogQuery.value.trim().toLowerCase()
  return contentStore.toolCatalog.filter((candidate) => {
    if (toolCatalogFilter.value === 'ready' && candidate.status !== 'ready') return false
    return !keyword || `${candidate.name} ${candidate.id} ${candidate.description}`.toLowerCase().includes(keyword)
  })
})
const { currentPage: skillPage, pagedItems: pagedSkills } =
  useListPagination(filteredSkills, { resetOn: query })
const { currentPage: toolPage, pagedItems: pagedTools } =
  useListPagination(filteredTools, { resetOn: query })
const { currentPage: connectorPage, pagedItems: pagedConnectors } =
  useListPagination(filteredConnectors, { resetOn: query })
const { currentPage: toolCatalogPage, pagedItems: pagedToolCatalog } =
  useListPagination(filteredToolCatalog, { resetOn: [toolCatalogQuery, toolCatalogFilter] })
const { currentPage: skillVersionPage, pagedItems: pagedSkillVersions } =
  useListPagination(selectedSkillVersions, { resetOn: detailTargetId })
const { currentPage: skillReleasePage, pagedItems: pagedSkillReleases } =
  useListPagination(selectedSkillReleases, { resetOn: detailTargetId })
const { currentPage: toolReferencePage, pagedItems: pagedToolReferences } =
  useListPagination(toolReferences, { resetOn: detailTargetId })
function switchTab(tab: CapabilityTab) {
  query.value = ''
  const paths: Record<CapabilityTab, string> = {
    skills: '/skills',
    install: '/skills/install',
    tools: '/tools',
    connectors: '/connectors',
  }
  void router.push(paths[tab])
}

function navigateTabs(event: KeyboardEvent) {
  const supported = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!supported.includes(event.key)) return
  event.preventDefault()
  const index = tabs.value.findIndex(tab => tab.id === activeTab.value)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.value.length) % tabs.value.length
  const tab = tabs.value[next]
  if (!tab) return
  switchTab(tab.id)
  document.getElementById(`capability-tab-${tab.id}`)?.focus()
}

async function refreshInstalledSkills() {
  await contentStore.load(true)
}

function inspectSkill(skill: SkillDefinition) {
  skillDetailTab.value = 'config'
  showDetail(skill.name, [
    { label: 'Skill 标识', value: skill.id },
    { label: '版本', value: `v${skill.version}` },
    { label: '分类', value: skill.category },
    { label: '负责人', value: skill.owner },
    { label: '说明', value: skill.description },
    ...(skill.installationRole === 'root' ? [{ label: '安装类型', value: '入口 Skill' }] : skill.installationRole === 'dependency' ? [{ label: '安装类型', value: '依赖 Skill（员工端不单独展示）' }] : []),
    ...(skill.dependencies?.length ? [{ label: '依赖 Skill', value: skill.dependencies.map(item => `${item.name}@${item.version}`).join('、') }] : []),
    { label: '执行指令', value: skill.instructions },
    { label: '引用工具', value: toolNames(skill.toolIds) },
    { label: '典型问题', value: skill.testPrompt },
  ], 'skill', skill.id)
}

function inspectSkillDependency(skillId: string) {
  const dependency = contentStore.skills.find(skill => skill.id === skillId)
  if (dependency) inspectSkill(dependency)
}

function inspectTool(tool: ToolDefinition) {
  const connector = contentStore.connectors.find((item) => item.id === tool.connectorId)
  showDetail(tool.name, [
    { label: '工具标识', value: tool.id },
    { label: '工具说明', value: tool.description },
    { label: '所属系统', value: tool.system },
    { label: '绑定连接器', value: connector?.name ?? '平台内置能力' },
    { label: '操作模式', value: tool.mode === 'read' ? '只读' : '写入' },
    { label: '风险等级', value: riskLabel(tool.risk) },
    { label: '授权角色', value: tool.allowedRoles.join('、') },
    { label: '数据范围', value: tool.dataScopes.join('、') },
    { label: '审批策略', value: approvalLabel(tool.approvalPolicy) },
    { label: '调用超时', value: `${tool.timeoutSeconds} 秒` },
    { label: '结果校验', value: tool.outputValidation === 'unavailable' ? '平台不可验证' : tool.outputValidation === 'platform' ? '平台校验' : 'Runtime 校验' },
    { label: '重试策略', value: tool.retryPolicy === 'safe' ? '可安全重试' : tool.retryPolicy === 'verify-first' ? '核对结果后重试' : '不可自动重试' },
    { label: '并发策略', value: tool.concurrencyPolicy === 'concurrent' ? '允许并发' : '串行执行' },
    { label: '完成语义', value: tool.completionSemantics === 'completed' ? '同步完成' : '仅表示已受理' },
    { label: '输入 Schema', value: tool.inputSchema },
    { label: '输出 Schema', value: tool.outputSchema },
  ], 'tool', tool.id)
}

async function inspectConnector(connector: ConnectorDefinition) {
  let invocationSummary = ''
  if (connector.mcp) {
    try {
      const invocations = await contentStore.getMcpInvocationAudits(connector.id)
      invocationSummary = invocations.map(item => `${item.capabilityName}（${item.result}，执行者 ${item.executorPrincipalId ?? '历史记录未归因'}，${new Date(item.occurredAt).toLocaleString('zh-CN')}）`).join('；') || '暂无调用审计'
    } catch {
      invocationSummary = '调用审计加载失败，请稍后重试'
    }
  }
  showDetail(connector.name, [
    { label: '连接器标识', value: connector.id },
    ...(connector.mcp ? [] : [{ label: '企业系统', value: connector.system }]),
    { label: '协议', value: protocolLabel(connector.protocol) },
    { label: '服务地址', value: connector.endpoint },
    { label: '认证方式', value: connector.authType },
    { label: '认证凭据', value: connector.credentialRef },
    { label: '数据范围', value: connector.scopeDescription },
    { label: '提供工具', value: `${connector.toolCount} 个` },
    { label: '当前延迟', value: connector.latency },
    ...(connector.mcp ? [
      { label: 'MCP 命名空间', value: connector.mcp.serverName },
      { label: '能力状态', value: connector.mcp.capabilityDigest === connector.mcp.approvedDigest ? '已同步生效' : '待重新检查' },
      { label: '能力摘要', value: connector.mcp.capabilityDigest ?? '尚未发现' },
      { label: 'Tool 描述与输入 Schema', value: formatMcpCapabilities(connector) },
      { label: '适用 Agent', value: '全部 Agent' },
      { label: '最近调用', value: invocationSummary },
    ] : []),
  ], 'connector', connector.id)
}

function showDetail(title: string, rows: Array<{ label: string; value: string }>, type: 'skill' | 'tool' | 'connector', targetId: string) {
  detailTitle.value = title
  detailRows.value = rows
  detailType.value = type
  detailTargetId.value = targetId
  detailOpen.value = true
}

async function copySkillIdentifier(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    ElMessage.success('Skill 标识已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择标识')
  }
}

function openToolPermissions(toolId = detailTargetId.value) {
  detailOpen.value = false
  void router.push({ path: '/permissions', query: { tool: toolId } })
}

function openToolCatalog() {
  toolCatalogQuery.value = ''
  toolCatalogFilter.value = contentStore.toolCatalog.some(item => item.status === 'ready') ? 'ready' : 'all'
  const candidate = contentStore.toolCatalog.find(item => item.status === 'ready')
    ?? contentStore.toolCatalog[0]
    ?? null
  selectToolCandidate(candidate)
  toolCatalogDialogOpen.value = true
}

function selectToolCandidate(candidate: ToolCatalogCandidate | null) {
  selectedToolCandidate.value = candidate
  toolCreateForm.allowedRoles = candidate ? [...candidate.defaultAllowedRoles] : []
  toolCreateForm.dataScopes = candidate ? [...candidate.defaultDataScopes] : []
  toolCreateForm.approvalPolicy = candidate?.defaultApprovalPolicy ?? 'none'
}

async function addSelectedTool() {
  const candidate = selectedToolCandidate.value
  if (!candidate || candidate.status !== 'ready') return
  if (!toolCreateForm.allowedRoles.length || !toolCreateForm.dataScopes.length) {
    ElMessage.warning('请配置至少一个授权角色和数据范围')
    return
  }
  toolAdding.value = true
  try {
    await contentStore.addTool({
      catalogId: candidate.id,
      allowedRoles: [...toolCreateForm.allowedRoles],
      dataScopes: [...toolCreateForm.dataScopes],
      approvalPolicy: toolCreateForm.approvalPolicy,
    })
    toolCatalogDialogOpen.value = false
    ElMessage.success(`工具“${candidate.name}”已添加`)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '工具添加失败')
  } finally {
    toolAdding.value = false
  }
}

async function changeSkillStatus(skill: SkillDefinition) {
  if (skill.status === 'draft' && skill.packageSha256) {
    openStrictSkillTest(skill)
    return
  }
  const disabling = skill.status === 'published'
  const nextStatus = disabling ? 'disabled' : 'published'
  const action = disabling ? '停用' : skill.status === 'draft' ? '发布' : '启用'
  try {
    await ElMessageBox.confirm(
      disabling ? '停用后，新建 Agent 不能再引用此 Skill；已有版本不会被改写。' : '发布后当前版本不可原地编辑，只能作为稳定版本被 Agent 引用。',
      `${action}“${skill.name}”？`,
      { confirmButtonText: `确认${action}`, cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `skill:${skill.id}`
    if (skill.status === 'draft') {
      skillActionFeedback.value = {
        type: 'info',
        title: `正在严格试运行“${skill.name}”`,
        description: '平台已启动 DSH 试运行，将检查根 Skill、递归依赖的激活证据及 Python 沙箱执行结果。完成前请勿重复提交。',
      }
      const test = await contentStore.testSkill(skill.id, skill.testPrompt)
      if (test.status !== 'passed') throw new Error(test.resultSummary)
      skillActionFeedback.value = {
        type: 'warning',
        title: `“${skill.name}”试运行通过，等待确认发布`,
        description: test.resultSummary,
      }
    }
    const updated = await contentStore.setSkillStatus(skill.id, nextStatus)
    if (detailOpen.value && detailTargetId.value === skill.id) inspectSkill(updated)
    const successMessage = skill.status === 'draft' ? (skill.packageSha256 ? '真实试运行已确认，Skill 已发布' : '服务端配置校验通过，Skill 已发布') : `Skill 已${action}`
    skillActionFeedback.value = {
      type: 'success',
      title: `“${skill.name}”${successMessage}`,
      description: skill.status === 'draft' ? `v${updated.version} 已成为可供 Agent 固定引用的活动版本。` : '状态已更新，相关运行将按最新状态进行权限检查。',
    }
    ElMessage.success(successMessage)
  } catch (cause) {
    if (cause instanceof Error) {
      skillActionFeedback.value = {
        type: 'error',
        title: `“${skill.name}”${action}失败`,
        description: `${cause.message} 请检查 Runtime、工具授权和 Skill 配置后重试。`,
      }
      ElMessage.error(cause.message)
    }
  } finally {
    actionLoading.value = ''
  }
}

function openStrictSkillTest(skill: SkillDefinition) {
  skillTestPollEpoch++
  clearSkillTestPoll()
  skillTestTarget.value = skill
  skillTestProgress.value = null
  skillTestError.value = ''
  skillTestPublished.value = false
  skillTestDialogOpen.value = true
  void startStrictSkillTest(skill, skillTestPollEpoch)
}

async function startStrictSkillTest(skill: SkillDefinition, epoch: number) {
  skillTestStarting.value = true
  actionLoading.value = `skill:${skill.id}`
  try {
    const progress = await contentStore.startSkillTestRun(skill.id, skill.testPrompt)
    if (epoch !== skillTestPollEpoch) return
    skillTestProgress.value = progress
    syncSkillTestFeedback(skill, progress)
    if (isActiveTestStatus(progress.status)) scheduleSkillTestPoll(skill, progress.runId, epoch)
    else actionLoading.value = ''
  } catch (cause) {
    if (epoch !== skillTestPollEpoch) return
    skillTestError.value = cause instanceof Error ? cause.message : '严格试运行启动失败'
    actionLoading.value = ''
  } finally {
    if (epoch === skillTestPollEpoch) skillTestStarting.value = false
  }
}

function scheduleSkillTestPoll(skill: SkillDefinition, runId: string, epoch: number) {
  clearSkillTestPoll()
  skillTestPollTimer = setTimeout(async () => {
    try {
      const progress = await contentStore.getSkillTestRun(skill.id, runId)
      if (epoch !== skillTestPollEpoch) return
      skillTestProgress.value = progress
      syncSkillTestFeedback(skill, progress)
      if (isActiveTestStatus(progress.status)) scheduleSkillTestPoll(skill, runId, epoch)
      else actionLoading.value = ''
    } catch (cause) {
      if (epoch !== skillTestPollEpoch) return
      skillTestError.value = cause instanceof Error ? cause.message : '试运行进度读取失败'
      actionLoading.value = ''
    }
  }, 1000)
}

function clearSkillTestPoll() {
  if (skillTestPollTimer) clearTimeout(skillTestPollTimer)
  skillTestPollTimer = undefined
}

function isActiveTestStatus(status: SkillTestRunProgress['status']) {
  return ['queued', 'running', 'waiting', 'cancel_requested'].includes(status)
}

function syncSkillTestFeedback(skill: SkillDefinition, progress: SkillTestRunProgress) {
  if (progress.status === 'passed') {
    skillActionFeedback.value = { type: 'warning', title: `“${skill.name}”试运行通过，等待确认发布`, description: '请在试运行窗口确认结果后发布。' }
  } else if (progress.status === 'failed' || progress.status === 'cancelled') {
    skillActionFeedback.value = { type: 'error', title: `“${skill.name}”严格试运行未通过`, description: '请在试运行窗口查看失败步骤和处理建议。' }
  } else {
    skillActionFeedback.value = { type: 'info', title: `正在严格试运行“${skill.name}”`, description: `Run ${progress.runId} 正在执行，具体进度可在弹窗中查看。` }
  }
}

async function publishTestedSkill() {
  const skill = skillTestTarget.value
  if (!skill || skillTestProgress.value?.status !== 'passed') return
  skillTestPublishing.value = true
  try {
    const updated = await contentStore.setSkillStatus(skill.id, 'published')
    if (detailOpen.value && detailTargetId.value === skill.id) inspectSkill(updated)
    skillTestPublished.value = true
    skillActionFeedback.value = { type: 'success', title: `“${skill.name}”真实试运行已确认，Skill 已发布`, description: `v${updated.version} 已成为可供 Agent 固定引用的活动版本。` }
    ElMessage.success('真实试运行已确认，Skill 已发布')
  } catch (cause) {
    skillTestError.value = cause instanceof Error ? cause.message : 'Skill 发布失败'
  } finally {
    skillTestPublishing.value = false
  }
}

function retryStrictSkillTest() {
  const skill = skillTestTarget.value
  if (!skill) return
  openStrictSkillTest(skill)
}

function skillTestStatusLabel(status?: SkillTestRunProgress['status']) {
  return { queued: '等待调度', running: '试运行中', waiting: '等待动作审批', cancel_requested: '正在停止', passed: '试运行通过', failed: '试运行失败', cancelled: '已取消' }[status ?? 'queued']
}

function skillTestStepIcon(status: SkillTestRunProgress['steps'][number]['status']) {
  return status === 'completed' ? Check : status === 'failed' ? Close : status === 'running' ? Loading : Clock
}

function skillTestStepDescription(step: SkillTestRunProgress['steps'][number]) {
  if (step.id === 'worker') {
    if (step.status === 'completed') return 'Worker 已启动并加载固定运行清单'
    if (step.status === 'failed') return 'Worker 启动失败'
    return step.status === 'running' ? '正在启动 Worker' : '等待可用 Worker'
  }
  if (step.id === 'result') {
    if (step.status === 'completed') return '全部发布条件均已通过'
    if (step.status === 'failed') return '存在未通过的发布条件'
    return step.status === 'running' ? '正在核验运行结果与执行证据' : '等待前置步骤完成'
  }
  return compactResultSummary(step.description, 120)
}

function compactResultSummary(summary: string, maxLength = 240) {
  const compact = summary
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact
}

async function rollbackSkill(version: SkillVersionRecord) {
  const skill = selectedSkill.value
  if (!skill) return
  try {
    await ElMessageBox.confirm(
      `活动版本将切换为已发布的 v${version.version}，历史版本不会被修改。`,
      `回滚“${skill.name}”？`,
      { confirmButtonText: '确认回滚', cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `skill-rollback:${version.id}`
    const updated = await contentStore.rollbackSkill(skill.id, version.version)
    inspectSkill(updated)
    skillDetailTab.value = 'releases'
    ElMessage.success(`Skill 已回滚到 v${version.version}`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

function releaseActionLabel(record: SkillReleaseRecord) {
  return {
    published: '发布版本',
    enabled: '启用 Skill',
    disabled: '停用 Skill',
    rollback: '版本回滚',
  }[record.action]
}

async function changeToolStatus(tool: ToolDefinition) {
  const disabling = tool.status !== 'disabled'
  const nextStatus = disabling ? 'disabled' : 'available'
  const action = disabling ? '停用' : '启用'
  try {
    await ElMessageBox.confirm(
      disabling ? '停用后，Agent 运行将不能再调用此工具；已有审计记录保留。' : '启用前请确认连接器、Schema 和权限配置仍然有效。',
      `${action}“${tool.name}”？`,
      { confirmButtonText: `确认${action}`, cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `tool:${tool.id}`
    await contentStore.setToolStatus(tool.id, nextStatus)
    ElMessage.success(`工具已${action}`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

async function checkConnector(connector: ConnectorDefinition) {
  actionLoading.value = `connector:${connector.id}`
  try {
    const updated = await contentStore.checkConnector(connector.id)
    if (updated.status === 'offline') ElNotification.error({
      title: `连接器异常：${connector.name}`,
      message: connectorRecoveryMessage(updated, '健康检查结果为离线'),
      duration: 8000,
    })
    else if (updated.status === 'disabled') ElMessage.info(`${connector.name}检查完成，仍保持人工停用；需要恢复时请显式启用`)
    else if (updated.status === 'healthy') ElMessage.success(`${connector.name}检查通过，${updated.mcp?.capabilityCount ?? 0} 个 Tool 已同步生效`)
    else ElNotification.error({
      title: `连接器异常：${connector.name}`,
      message: connectorRecoveryMessage(updated, '健康检查结果为性能下降'),
      duration: 8000,
    })
  } catch (cause) {
    const failure = cause as Error & { object?: string; suggestion?: string; traceId?: string }
    ElNotification.error({
      title: `连接器检查失败：${failure.object ?? connector.name}`,
      message: `原因：${failure.message ?? '健康检查未完成'}。下一步：${failure.suggestion ?? '检查连接器配置和系统健康后重试。'}${failure.traceId && failure.traceId !== '—' ? ` 链路编号：${failure.traceId}` : ''}`,
      duration: 8000,
    })
  } finally {
    actionLoading.value = ''
  }
}

function connectorRecoveryMessage(connector: ConnectorDefinition, fallback: string) {
  const reason = (connector.lastHealthMessage?.trim() || fallback).replace(/[。.!！]+$/, '')
  return `原因：${reason}。下一步：检查 ${connector.endpoint}、凭据和 DSH Runtime 状态，恢复后重新检查。`
}

async function registerMcpConnector() {
  if (!mcpCanRegister.value) {
    ElMessage.warning('请先完成连通测试，且测试后不要修改连接信息')
    return
  }
  mcpCreating.value = true
  try {
    const connector = await contentStore.registerMcpConnector({
      name: mcpCreateForm.name.trim(),
      endpoint: mcpCreateForm.endpoint.trim(),
      authType: mcpCreateForm.authType,
      scopeDescription: mcpCreateForm.scopeDescription.trim(),
      ...(mcpCreateForm.authType === 'bearer' ? { bearerToken: mcpCreateForm.bearerToken } : {}),
    })
    mcpCreateDialogOpen.value = false
    resetMcpCreateForm()
    ElMessage.success(`MCP Connector 已添加，${connector.mcp?.capabilityCount ?? 0} 个 Tool 已自动生效`)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'MCP Connector 登记失败')
  } finally {
    mcpCreating.value = false
  }
}

async function testMcpConnection() {
  if (!mcpConnectionInputReady.value) return
  const testedSignature = mcpConnectionSignature.value
  mcpTesting.value = true
  mcpTestResult.value = null
  mcpTestError.value = null
  try {
    const result = await contentStore.testMcpConnection({
      name: mcpCreateForm.name.trim(),
      endpoint: mcpCreateForm.endpoint.trim(),
      authType: mcpCreateForm.authType,
      ...(mcpCreateForm.authType === 'bearer' ? { bearerToken: mcpCreateForm.bearerToken } : {}),
    })
    if (testedSignature !== mcpConnectionSignature.value) return
    mcpTestResult.value = result
    testedMcpSignature.value = testedSignature
    ElMessage.success(`连通测试成功，发现 ${result.capabilityCount} 个 Tool`)
  } catch (cause) {
    if (testedSignature !== mcpConnectionSignature.value) return
    const code = cause instanceof Error && 'code' in cause ? String(cause.code) : ''
    mcpTestError.value = {
      title: code === 'MCP_AUTHENTICATION_REQUIRED' || code === 'MCP_AUTHENTICATION_FAILED' ? '认证失败' : '连通测试失败',
      description: cause instanceof Error ? cause.message : 'MCP 连通测试失败',
    }
  } finally {
    mcpTesting.value = false
  }
}

function resetMcpCreateForm() {
  Object.assign(mcpCreateForm, { name: '', endpoint: '', authType: 'none', bearerToken: '', scopeDescription: '' })
  mcpTestResult.value = null
  mcpTestError.value = null
  testedMcpSignature.value = ''
}

function openMcpCredentialRotation(connector: ConnectorDefinition) {
  selectedMcpCredentialConnectorId.value = connector.id
  mcpCredentialToken.value = ''
  mcpCredentialDialogOpen.value = true
}

function mcpCredentialActionLabel(connector: ConnectorDefinition | undefined) {
  return connector?.credentialRef === 'Bearer Token 需要重新录入' ? '录入 Token' : '轮换 Token'
}

function clearMcpTokenForNoAuth() {
  if (mcpCreateForm.authType === 'none') mcpCreateForm.bearerToken = ''
}

async function rotateMcpCredential() {
  const connector = selectedMcpCredentialConnector.value
  if (!connector || !mcpCredentialToken.value) return
  mcpCredentialRotating.value = true
  try {
    await contentStore.rotateMcpCredential(connector.id, mcpCredentialToken.value)
    mcpCredentialDialogOpen.value = false
    ElMessage.success('Bearer Token 已轮换，正在重新检查连接器')
    await checkConnector(contentStore.connectors.find(item => item.id === connector.id) ?? connector)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Bearer Token 轮换失败')
  } finally {
    mcpCredentialToken.value = ''
    mcpCredentialRotating.value = false
  }
}

function formatMcpInputSchema(schema: Record<string, unknown>) {
  return JSON.stringify(schema, null, 2)
}

function formatConnectorDateTime(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function openMcpTools(connector: ConnectorDefinition) {
  selectedMcpToolsConnectorId.value = connector.id
  mcpToolsDialogOpen.value = true
}

function formatMcpCapabilities(connector: ConnectorDefinition) {
  return connector.mcp?.capabilities.map(capability => [
    capability.name,
    capability.description || '无描述',
    `输入 Schema：\n${formatMcpInputSchema(capability.inputSchema)}`,
  ].join('\n')).join('\n\n') || '尚未发现'
}

async function toggleMcpConnector(connector: ConnectorDefinition) {
  const disabling = connector.status !== 'disabled'
  try {
    await ElMessageBox.confirm(
      disabling ? '停用后，所有 Agent 的新运行和在途调用都会被拒绝。' : '仅能力摘要仍与当前发现记录一致时才能重新启用。',
      `${disabling ? '停用' : '启用'}“${connector.name}”？`,
      { confirmButtonText: `确认${disabling ? '停用' : '启用'}`, cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `mcp-status:${connector.id}`
    await contentStore.setMcpConnectorStatus(connector.id, disabling ? 'disabled' : 'enabled')
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

async function deleteMcpConnector(connector: ConnectorDefinition) {
  try {
    await ElMessageBox.confirm(
      '删除后会立即停止所有 Agent 使用该连接器，并销毁该连接器独占的 Bearer 凭据；能力快照和调用审计继续保留。此操作不能从管理页面恢复。',
      `删除“${connector.name}”？`,
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `mcp-delete:${connector.id}`
    await contentStore.deleteMcpConnector(connector.id)
    if (detailType.value === 'connector' && detailTargetId.value === connector.id) detailOpen.value = false
    ElMessage.success('MCP Connector 已删除，所有 Agent 已停止使用')
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

function handleMcpMoreCommand(command: string, connector: ConnectorDefinition) {
  if (command === 'credential') openMcpCredentialRotation(connector)
  else if (command === 'status') void toggleMcpConnector(connector)
  else if (command === 'delete') void deleteMcpConnector(connector)
}

async function refreshHealth() {
  healthRefreshing.value = true
  try {
    const results = await Promise.all(contentStore.connectors.map((connector) => contentStore.checkConnector(connector.id)))
    const unavailable = results.filter(connectorNeedsRecovery)
    const disabledCount = results.filter(connector => connector.status === 'disabled').length
    if (unavailable.length) ElNotification.error({
      title: `${unavailable.length} 个连接器异常`,
      message: `对象：${unavailable.map((connector) => connector.name).join('、')}。下一步：逐项检查端点、凭据引用和依赖状态。`,
      duration: 8000,
    })
    else ElMessage.success(`检查完成：${results.length - disabledCount} 个连接器健康${disabledCount ? `，${disabledCount} 个保持人工停用` : ''}`)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '批量健康检查失败')
  } finally {
    healthRefreshing.value = false
  }
}

function toolNames(references: string[]) {
  return references.map((reference) => {
    const separator = reference.lastIndexOf('@')
    const id = separator > 0 ? reference.slice(0, separator) : reference
    return contentStore.tools.find((tool) => tool.id === id)?.name ?? reference
  }).join('、')
}

function riskLabel(risk: ToolDefinition['risk']) {
  return { low: '低风险', medium: '中风险', high: '高风险' }[risk]
}

function approvalLabel(policy: ToolDefinition['approvalPolicy']) {
  return { none: '无需审批', sensitive: '敏感范围审批', always: '每次审批' }[policy]
}

function protocolLabel(protocol: ConnectorDefinition['protocol']) {
  return { runtime: 'Runtime', rest: 'REST API', openapi: 'OpenAPI', mcp: 'MCP', database: '数据库代理' }[protocol]
}

function connectorStatusLabel(connector: ConnectorDefinition) {
  return { healthy: '已生效', degraded: '待重新检查', offline: '离线', disabled: '已停用' }[connector.status]
}

function connectorNeedsRecovery(connector: ConnectorDefinition) {
  return connector.status === 'offline' || connector.status === 'degraded'
}

onMounted(() => {
  void contentStore.load()
  // B-03/I-04：工具绑定修订为服务端真实记录（/tools/bindings）。
  void toolStore.loadBindings()
})
onUnmounted(() => clearSkillTestPoll())
</script>

<template>
  <div class="ops-page capabilities-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />
    <el-alert v-if="toolStore.bindingsError" :title="`平台绑定修订加载失败：${toolStore.bindingsError}`" type="warning" show-icon @close="toolStore.bindingsError = ''" />
    <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，仅可查看 Skill、工具与连接器配置。" />
    <el-alert
      v-if="skillActionFeedback && activeTab === 'skills'"
      class="skill-action-feedback"
      :type="skillActionFeedback.type"
      :title="skillActionFeedback.title"
      :description="skillActionFeedback.description"
      :closable="!actionLoading"
      show-icon
      data-testid="skill-action-feedback"
      @close="skillActionFeedback = null"
    />

    <section class="content-panel filter-panel capability-filters">
      <div v-if="skillSection" class="status-tabs" role="tablist" aria-label="Skill 管理" @keydown="navigateTabs">
        <button v-for="tab in tabs" :id="`capability-tab-${tab.id}`" :key="tab.id" class="status-tab" :class="{ active: activeTab === tab.id }" type="button" role="tab" :aria-selected="activeTab === tab.id" :aria-controls="`capability-panel-${tab.id}`" :tabindex="activeTab === tab.id ? 0 : -1" @click="switchTab(tab.id)">{{ tab.label }} <span v-if="tab.count !== undefined" class="tab-count">{{ tab.count }}</span></button>
      </div>
      <div v-if="activeTab !== 'install'" class="filter-bar capability-toolbar">
        <el-input v-model="query" :prefix-icon="Search" clearable :placeholder="activeTab === 'skills' ? '搜索 Skill 名称、说明或负责人' : activeTab === 'tools' ? '搜索 DSH 内置工具名称、标识或说明' : '搜索 MCP 名称、标识或 serverName'" />
        <div v-if="activeTab === 'skills'" class="capability-toolbar__legend"><span>版本发布后不可变</span></div>
        <div v-if="activeTab === 'tools'" class="capability-toolbar__legend"><span>仅管理 DSH 内置工具；MCP 工具随连接器清单自动同步</span></div>
        <el-button v-if="activeTab === 'skills'" @click="router.push('/assistant?context=skills')">交给管理助手</el-button>
        <div v-if="authStore.canManage && activeTab === 'tools'" class="capability-toolbar__actions">
          <el-button type="primary" :icon="Plus" data-action="add-tool" @click="openToolCatalog">添加工具</el-button>
        </div>
        <div v-if="authStore.canManage && activeTab === 'connectors'" class="capability-toolbar__actions">
          <el-button type="primary" :icon="Plus" data-action="add-mcp-connector" @click="mcpCreateDialogOpen = true">新增 MCP</el-button>
          <el-button :icon="Refresh" :loading="healthRefreshing" data-action="refresh-connectors" @click="refreshHealth">全部检查</el-button>
        </div>
      </div>
    </section>

    <div v-if="authStore.canManage" v-show="activeTab === 'install'" id="capability-panel-install" role="tabpanel" aria-labelledby="capability-tab-install">
      <SkillInstallationPanel @back="switchTab('skills')" @assistant="router.push('/assistant?context=skills')" @installed="refreshInstalledSkills" />
    </div>

    <section v-if="activeTab !== 'install'" :id="`capability-panel-${activeTab}`" class="content-panel content-panel--flush capability-panel" role="tabpanel" :aria-labelledby="skillSection ? `capability-tab-${activeTab}` : undefined" :aria-label="activeTab === 'tools' ? 'DSH 内置工具列表' : activeTab === 'connectors' ? 'MCP 连接器列表' : undefined">
      <template v-if="activeTab === 'skills'">
      <el-table class="data-table" v-loading="contentStore.loading" :data="pagedSkills" empty-text="暂无匹配的 Skill">
        <el-table-column label="Skill" min-width="360">
          <template #default="scope">
            <div class="primary-cell skill-primary-cell">
              <div class="skill-primary-cell__name">
                <strong>{{ scope.row.name }}</strong>
                <span v-if="scope.row.installationRole === 'root'" class="skill-entry-label">入口 Skill</span>
              </div>
              <small>{{ scope.row.description }}</small>
              <div v-if="scope.row.dependencies?.length" class="skill-dependencies" aria-label="依赖 Skill">
                <span class="skill-dependencies__label">依赖 {{ scope.row.dependencies.length }}</span>
                <button
                  v-for="dependency in scope.row.dependencies"
                  :key="`${dependency.id}@${dependency.version}`"
                  type="button"
                  class="skill-dependency-chip"
                  :title="`查看 ${dependency.name}@${dependency.version}`"
                  data-action="view-skill-dependency"
                  @click="inspectSkillDependency(dependency.id)"
                >
                  <span>{{ dependency.name }}</span>
                  <code>v{{ dependency.version }}</code>
                  <StatusTag :status="dependency.status" />
                </button>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="125"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span><small v-if="scope.row.activeVersion && scope.row.activeVersion !== scope.row.version" class="active-version-hint">活动 v{{ scope.row.activeVersion }}</small></template></el-table-column>
        <el-table-column prop="category" label="分类" width="110" />
        <el-table-column label="工具" width="90"><template #default="scope">{{ scope.row.toolIds.length }} 个</template></el-table-column>
        <el-table-column prop="owner" label="负责人" min-width="140" />
        <el-table-column label="状态" width="108"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
        <el-table-column prop="updatedAt" label="更新时间" width="120" />
        <el-table-column label="操作" width="210" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-skill" @click="inspectSkill(scope.row)">查看</el-button><el-button v-if="authStore.canManage" link type="primary" :loading="actionLoading === `skill:${scope.row.id}`" :data-action="scope.row.status === 'published' ? 'disable-skill' : 'publish-skill'" @click="changeSkillStatus(scope.row)">{{ scope.row.status === 'published' ? '停用' : scope.row.status === 'draft' ? (scope.row.packageSha256 ? '试运行并发布' : '校验并发布') : '启用' }}</el-button></template></el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-model:current-page="skillPage" background layout="prev, pager, next" :total="filteredSkills.length" :page-size="10" /></div>
      </template>

      <template v-else-if="activeTab === 'tools'">
      <el-table class="data-table" v-loading="contentStore.loading" :data="pagedTools" empty-text="暂无匹配的 DSH 内置工具">
        <el-table-column label="工具" min-width="290"><template #default="scope"><div class="primary-cell"><strong>{{ scope.row.name }}</strong><small>{{ scope.row.description }}</small><code>{{ scope.row.id }}</code></div></template></el-table-column>
        <el-table-column prop="system" label="所属系统" min-width="130" />
        <el-table-column label="模式" width="90"><template #default="scope"><span class="mode-label" :class="`mode-label--${scope.row.mode}`">{{ scope.row.mode === 'read' ? '只读' : '写入' }}</span></template></el-table-column>
        <el-table-column label="风险" width="100"><template #default="scope"><StatusTag :status="scope.row.risk" /></template></el-table-column>
        <el-table-column label="状态" width="115"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column label="授权角色" min-width="190"><template #default="scope"><span class="role-text">{{ scope.row.allowedRoles.join('、') }}</span></template></el-table-column>
        <el-table-column label="绑定修订" min-width="190"><template #default="scope"><span class="mono">{{ toolStore.governanceOf(scope.row.id).bindingRevision.id }}</span></template></el-table-column>
        <el-table-column prop="lastCheckedAt" label="检查时间" width="110" />
        <el-table-column label="操作" width="210" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-tool" @click="inspectTool(scope.row)">查看</el-button><el-button v-if="authStore.canManage" link type="primary" data-action="configure-tool-permissions" @click="openToolPermissions(scope.row.id)">权限</el-button><el-button v-if="authStore.canManage" link type="primary" :loading="actionLoading === `tool:${scope.row.id}`" :data-action="scope.row.status === 'disabled' ? 'enable-tool' : 'disable-tool'" @click="changeToolStatus(scope.row)">{{ scope.row.status === 'disabled' ? '启用' : '停用' }}</el-button></template></el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-model:current-page="toolPage" background layout="prev, pager, next" :total="filteredTools.length" :page-size="10" /></div>
      </template>

      <template v-else>
      <el-table class="data-table" v-loading="contentStore.loading" :data="pagedConnectors" empty-text="暂无匹配的 MCP 连接器">
        <el-table-column label="名称" min-width="180"><template #default="scope"><strong class="mcp-name">{{ scope.row.name }}</strong></template></el-table-column>
        <el-table-column label="Endpoint" min-width="280"><template #default="scope"><code class="mcp-endpoint">{{ scope.row.endpoint }}</code></template></el-table-column>
        <el-table-column label="认证方式" width="120"><template #default="scope">{{ scope.row.authType === 'bearer' ? 'Bearer Token' : '无认证' }}</template></el-table-column>
        <el-table-column label="工具数量" width="130" align="center" header-align="center"><template #default="scope"><el-button link type="primary" data-action="view-mcp-tools" @click="openMcpTools(scope.row)">{{ scope.row.mcp?.capabilityCount ?? 0 }} 个</el-button></template></el-table-column>
        <el-table-column label="状态" width="115"><template #default="scope"><StatusTag :status="scope.row.status" :label="connectorStatusLabel(scope.row)" dot /></template></el-table-column>
        <el-table-column label="更新时间" width="175"><template #default="scope">{{ formatConnectorDateTime(scope.row.updatedAt) }}</template></el-table-column>
        <el-table-column label="添加时间" width="175"><template #default="scope">{{ formatConnectorDateTime(scope.row.createdAt) }}</template></el-table-column>
        <el-table-column label="添加人员" width="130" align="center" header-align="center"><template #default="scope">{{ scope.row.createdBy || '—' }}</template></el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="scope">
            <div class="mcp-row-actions">
              <el-button link type="primary" :icon="View" data-action="view-connector" @click="inspectConnector(scope.row)">查看</el-button>
              <el-button v-if="authStore.canManage" link type="primary" :loading="actionLoading === `connector:${scope.row.id}`" data-action="check-connector" @click="checkConnector(scope.row)">检查</el-button>
              <el-dropdown v-if="authStore.canManage && scope.row.mcp" trigger="click" placement="bottom-end" popper-class="mcp-more-dropdown" @command="handleMcpMoreCommand(String($event), scope.row)">
                <el-button link type="primary" data-action="mcp-more"><span>更多</span><el-icon><ArrowDown /></el-icon></el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-if="scope.row.authType === 'bearer'" command="credential" :icon="Key" data-action="rotate-mcp-credential">{{ mcpCredentialActionLabel(scope.row) }}</el-dropdown-item>
                    <el-dropdown-item command="status" :icon="SwitchButton" :disabled="actionLoading === `mcp-status:${scope.row.id}`">{{ scope.row.status === 'disabled' ? '启用' : '停用' }}</el-dropdown-item>
                    <el-dropdown-item command="delete" :icon="Delete" divided :disabled="actionLoading === `mcp-delete:${scope.row.id}`" class="mcp-more-dropdown__danger" data-action="delete-mcp-connector">删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div class="table-footer table-footer--pager"><el-pagination v-model:current-page="connectorPage" background layout="prev, pager, next" :total="filteredConnectors.length" :page-size="10" /></div>
      </template>
    </section>

    <el-dialog v-model="mcpToolsDialogOpen" :title="`工具清单 · ${selectedMcpToolsConnector?.name ?? ''}`" width="min(760px, calc(100vw - 32px))" destroy-on-close>
      <div class="mcp-tool-list" aria-label="MCP 工具清单">
        <article v-for="capability in selectedMcpToolsConnector?.mcp?.capabilities ?? []" :key="capability.name" class="mcp-tool-item">
          <code>{{ capability.name }}</code>
          <p>{{ capability.description || '无描述' }}</p>
          <strong>输入 Schema</strong>
          <pre>{{ formatMcpInputSchema(capability.inputSchema) }}</pre>
        </article>
        <el-empty v-if="!(selectedMcpToolsConnector?.mcp?.capabilities.length)" description="当前未发现工具" :image-size="64" />
      </div>
      <template #footer><el-button type="primary" @click="mcpToolsDialogOpen = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog v-model="mcpCreateDialogOpen" title="新增 MCP Connector" width="min(640px, calc(100vw - 32px))" destroy-on-close @closed="resetMcpCreateForm">
      <el-form label-position="top" :model="mcpCreateForm">
        <el-form-item label="连接器名称" required><el-input v-model="mcpCreateForm.name" placeholder="例如：ERP 只读查询 MCP" /></el-form-item>
        <el-form-item label="Streamable HTTP 地址" required><el-input v-model="mcpCreateForm.endpoint" class="mono" placeholder="https://erp.example.internal/mcp" /></el-form-item>
        <el-form-item label="认证方式" required><el-radio-group v-model="mcpCreateForm.authType" @change="clearMcpTokenForNoAuth"><el-radio value="none">无认证</el-radio><el-radio value="bearer">Bearer Token</el-radio></el-radio-group></el-form-item>
        <el-form-item v-if="mcpCreateForm.authType === 'bearer'" label="Bearer Token" required><el-input v-model="mcpCreateForm.bearerToken" type="password" autocomplete="new-password" placeholder="输入 MCP 服务签发的 Token" /><small>Token 使用 AES-256-GCM 加密后存入数据库，保存后不再回显。</small></el-form-item>
        <el-form-item label="整体权限范围" required><el-input v-model="mcpCreateForm.scopeDescription" type="textarea" :rows="3" placeholder="说明该 MCP 内全部 Tool 共同适用的系统、数据范围和只读边界" /></el-form-item>
      </el-form>
      <el-alert v-if="mcpTestResult" type="success" :closable="false" show-icon :title="`连通测试成功：${mcpTestResult.latencyMs} ms，发现 ${mcpTestResult.capabilityCount} 个 Tool`" />
      <el-alert v-else-if="mcpTestError" type="error" :closable="false" show-icon :title="mcpTestError.title" :description="mcpTestError.description" />
      <el-alert v-else type="info" :closable="false" show-icon title="先通过 DSH 测试 Streamable HTTP 连通性并发现 Tool；登记复核成功后连接器与 Tool 清单立即生效，并对全部 Agent 开放。" />
      <template #footer><el-button @click="mcpCreateDialogOpen = false">取消</el-button><el-button :loading="mcpTesting" :disabled="!mcpConnectionInputReady || mcpCreating" data-action="test-mcp-connection" @click="testMcpConnection">测试连接</el-button><el-button type="primary" :loading="mcpCreating" :disabled="!mcpCanRegister || mcpTesting" data-action="confirm-add-mcp-connector" @click="registerMcpConnector">添加 MCP</el-button></template>
    </el-dialog>

    <el-dialog v-model="mcpCredentialDialogOpen" :title="`轮换 Bearer Token · ${selectedMcpCredentialConnector?.name ?? ''}`" width="min(520px, calc(100vw - 32px))" destroy-on-close @closed="mcpCredentialToken = ''">
      <el-form label-position="top">
        <el-form-item label="新 Bearer Token" required><el-input v-model="mcpCredentialToken" type="password" autocomplete="new-password" placeholder="输入新的 Token" /><small>提交后将覆盖旧 Token；密文写入数据库，明文不会回显。</small></el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" show-icon title="轮换后连接器会重新检查。人工停用状态不会被自动解除。" />
      <template #footer><el-button @click="mcpCredentialDialogOpen = false">取消</el-button><el-button type="primary" :loading="mcpCredentialRotating" :disabled="!mcpCredentialToken" data-action="confirm-rotate-mcp-credential" @click="rotateMcpCredential">轮换并检查</el-button></template>
    </el-dialog>

    <el-dialog v-model="toolCatalogDialogOpen" title="添加 DSH 工具" width="min(920px, calc(100vw - 32px))" destroy-on-close>
      <div class="tool-catalog-toolbar">
        <el-input v-model="toolCatalogQuery" :prefix-icon="Search" clearable placeholder="搜索当前 DSH Profile 已加载的工具" />
        <el-radio-group v-model="toolCatalogFilter" size="small">
          <el-radio-button value="ready">可添加 {{ readyToolCandidateCount }}</el-radio-button>
          <el-radio-button value="all">全部 {{ contentStore.toolCatalog.length }}</el-radio-button>
        </el-radio-group>
      </div>
      <div class="tool-catalog-layout">
        <div class="tool-catalog-column">
        <div class="tool-catalog-list" aria-label="可添加工具">
          <button
            v-for="candidate in pagedToolCatalog"
            :key="candidate.id"
            type="button"
            class="tool-catalog-card"
            :class="{ 'is-selected': selectedToolCandidate?.id === candidate.id }"
            :aria-pressed="selectedToolCandidate?.id === candidate.id"
            @click="selectToolCandidate(candidate)"
          >
            <span class="tool-catalog-card__header">
              <strong>{{ candidate.name }}</strong>
              <el-tag v-if="candidate.status === 'ready'" type="success" effect="plain">可添加</el-tag>
              <el-tag v-else-if="candidate.status === 'installed'" type="info" effect="plain">已添加</el-tag>
              <el-tag v-else type="warning" effect="plain">暂不可用</el-tag>
            </span>
            <small>{{ candidate.id }}@{{ candidate.version }}</small>
            <p>{{ candidate.description }}</p>
          </button>
          <el-empty
            v-if="!filteredToolCatalog.length"
            :description="toolCatalogFilter === 'ready' ? '当前没有可添加的工具，可切换到“全部”查看' : '当前 DSH Profile 没有可展示的工具'"
            :image-size="72"
          />
        </div>
        <el-pagination v-model:current-page="toolCatalogPage" class="list-pagination" background hide-on-single-page layout="prev, pager, next" :total="filteredToolCatalog.length" :page-size="10" />
        </div>

        <div v-if="selectedToolCandidate" class="tool-catalog-config">
          <div class="tool-catalog-summary">
            <strong>{{ selectedToolCandidate.name }}</strong>
            <span :class="`tool-catalog-summary__status--${selectedToolCandidate.status}`">{{ selectedToolCandidate.availabilityMessage }}</span>
            <p>运行要求：{{ selectedToolCandidate.requirements.join('、') }}</p>
            <p>执行契约：{{ selectedToolCandidate.outputValidation === 'unavailable' ? '输出不可由平台验证' : '输出已校验' }} · {{ selectedToolCandidate.retryPolicy === 'safe' ? '可安全重试' : selectedToolCandidate.retryPolicy === 'verify-first' ? '先核对后重试' : '不可自动重试' }} · {{ selectedToolCandidate.completionSemantics === 'completed' ? '同步完成' : '仅已受理' }}</p>
          </div>
          <el-form label-position="top" :disabled="selectedToolCandidate.status !== 'ready'">
            <el-form-item label="授权角色" required>
              <el-select v-model="toolCreateForm.allowedRoles" multiple filterable allow-create default-first-option>
                <el-option v-for="role in toolRoleOptions" :key="role" :label="role" :value="role" />
              </el-select>
            </el-form-item>
            <el-form-item label="数据范围" required>
              <el-select v-model="toolCreateForm.dataScopes" multiple filterable allow-create default-first-option>
                <el-option v-for="scope in toolScopeOptions" :key="scope" :label="scope" :value="scope" />
              </el-select>
            </el-form-item>
            <el-form-item label="审批策略">
              <span class="tool-catalog-fixed-policy">{{ approvalLabel(toolCreateForm.approvalPolicy) }}（平台安全策略固定）</span>
            </el-form-item>
          </el-form>
          <el-alert type="info" :closable="false" show-icon title="添加后还需在 Agent 版本中显式授权，工具不会自动扩大现有 Agent 权限。" />
        </div>
      </div>
      <template #footer>
        <el-button @click="toolCatalogDialogOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="toolAdding"
          :disabled="selectedToolCandidate?.status !== 'ready'"
          data-action="confirm-add-tool"
          @click="addSelectedTool"
        >添加到工具目录</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="skillTestDialogOpen"
      class="skill-test-dialog"
      width="min(680px, calc(100vw - 32px))"
      :close-on-click-modal="!skillTestPublishing"
      :close-on-press-escape="!skillTestPublishing"
      :show-close="!skillTestPublishing"
      destroy-on-close
    >
      <template #header>
        <div class="skill-test-dialog__header">
          <div>
            <span>严格试运行</span>
            <h2>{{ skillTestTarget?.name }}</h2>
          </div>
          <StatusTag v-if="skillTestProgress" :status="skillTestProgress.status === 'passed' ? 'succeeded' : skillTestProgress.status" :label="skillTestStatusLabel(skillTestProgress.status)" dot />
        </div>
      </template>

      <el-alert v-if="skillTestError" :title="skillTestError" type="error" :closable="false" show-icon />
      <el-alert v-else-if="skillTestPublished" title="Skill 已发布" type="success" description="严格试运行结果已确认，当前版本已成为活动版本。" :closable="false" show-icon />
      <div v-else-if="skillTestStarting && !skillTestProgress" class="skill-test-dialog__starting" role="status">
        <el-icon class="is-loading"><Loading /></el-icon>
        <div><strong>正在创建 DSH 严格试运行</strong><p>平台正在锁定 Skill 版本、依赖图与 Runtime Manifest。</p></div>
      </div>

      <template v-if="skillTestProgress">
        <div class="skill-test-dialog__run-meta">
          <span>版本 <code>v{{ skillTestProgress.version }}</code></span>
          <span>Run <code>{{ skillTestProgress.runId }}</code></span>
        </div>
        <div class="skill-test-progress" aria-live="polite">
          <article v-for="step in skillTestProgress.steps" :key="step.id" :class="`is-${step.status}`">
            <span class="skill-test-progress__icon"><el-icon :class="{ 'is-loading': step.status === 'running' }"><component :is="skillTestStepIcon(step.status)" /></el-icon></span>
            <div>
              <strong>{{ step.title }}</strong>
              <p>{{ skillTestStepDescription(step) }}</p>
              <time v-if="step.occurredAt">{{ new Date(step.occurredAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</time>
            </div>
          </article>
        </div>
        <section v-if="!skillTestActive" class="skill-test-dialog__result" :class="`is-${skillTestProgress.status}`">
          <span class="skill-test-dialog__result-icon"><el-icon><component :is="skillTestProgress.status === 'passed' ? Check : Close" /></el-icon></span>
          <div>
            <h3>{{ skillTestResultTitle }}</h3>
            <p>{{ skillTestResultDescription }}</p>
          </div>
        </section>
      </template>

      <template #footer>
        <span v-if="skillTestActive" class="skill-test-dialog__hint">关闭窗口不会终止后台试运行</span>
        <el-button @click="skillTestDialogOpen = false">{{ skillTestPublished ? '完成' : '关闭' }}</el-button>
        <el-button v-if="skillTestProgress?.status === 'failed' || skillTestProgress?.status === 'cancelled' || skillTestError" :loading="skillTestStarting" @click="retryStrictSkillTest">重新试运行</el-button>
        <el-button v-if="skillTestProgress?.status === 'passed' && !skillTestPublished" type="primary" :loading="skillTestPublishing" @click="publishTestedSkill">确认结果并发布</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailOpen" size="min(620px, 100vw)" :title="detailTitle">
      <div v-if="detailType === 'skill'" class="capability-detail__notice"><el-icon><Connection /></el-icon><p>Skill 发布后当前版本不可原地编辑，Agent 引用时锁定具体版本。</p></div>
      <div v-if="detailType === 'skill'" class="status-tabs capability-detail__tabs" role="tablist" aria-label="Skill 详情类型">
        <button class="status-tab" :class="{ active: skillDetailTab === 'config' }" type="button" role="tab" :aria-selected="skillDetailTab === 'config'" @click="skillDetailTab = 'config'">配置详情</button>
        <button class="status-tab" :class="{ active: skillDetailTab === 'versions' }" type="button" role="tab" :aria-selected="skillDetailTab === 'versions'" @click="skillDetailTab = 'versions'">版本历史 <span class="tab-count">{{ selectedSkillVersions.length }}</span></button>
        <button class="status-tab" :class="{ active: skillDetailTab === 'releases' }" type="button" role="tab" :aria-selected="skillDetailTab === 'releases'" @click="skillDetailTab = 'releases'">发布记录 <span class="tab-count">{{ selectedSkillReleases.length }}</span></button>
      </div>
      <dl v-if="detailType !== 'skill' || skillDetailTab === 'config'" class="capability-detail__rows">
        <div v-for="row in detailRows" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd :class="{ 'capability-detail__code': row.label.includes('Schema') }">
            <span v-if="row.label === 'Skill 标识'" class="capability-detail__identifier">
              <code>{{ row.value }}</code>
              <el-button link type="primary" :icon="DocumentCopy" aria-label="复制 Skill 标识" @click="copySkillIdentifier(row.value)">复制</el-button>
            </span>
            <template v-else>{{ row.value }}</template>
          </dd>
        </div>
      </dl>
      <section v-else-if="detailType === 'skill' && skillDetailTab === 'versions'" class="capability-detail__table">
        <el-table class="data-table" :data="pagedSkillVersions" empty-text="暂无版本记录">
          <el-table-column label="版本" width="95"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span></template></el-table-column>
          <el-table-column label="变更说明" min-width="210"><template #default="scope"><div class="version-summary"><strong>{{ scope.row.summary }}</strong><small>{{ scope.row.createdBy }} · {{ scope.row.createdAt }}</small></div></template></el-table-column>
          <el-table-column label="状态" width="95"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
          <el-table-column label="操作" width="100" fixed="right"><template #default="scope"><el-button v-if="authStore.canManage && scope.row.status === 'published' && scope.row.version !== selectedSkill?.activeVersion" link type="primary" :loading="actionLoading === `skill-rollback:${scope.row.id}`" @click="rollbackSkill(scope.row)">回滚至此</el-button><span v-else class="muted">—</span></template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="skillVersionPage" class="list-pagination" background hide-on-single-page layout="prev, pager, next" :total="selectedSkillVersions.length" :page-size="10" />
      </section>
      <section v-else-if="detailType === 'skill'" class="capability-detail__releases">
        <el-empty v-if="!selectedSkillReleases.length" description="暂无发布记录" />
        <template v-else>
          <el-timeline><el-timeline-item v-for="record in pagedSkillReleases" :key="record.id" :timestamp="record.time" placement="top"><article class="release-record"><strong>{{ releaseActionLabel(record) }} · v{{ record.version }}</strong><p>{{ record.note }}</p><small>操作人：{{ record.actor }}</small></article></el-timeline-item></el-timeline>
          <el-pagination v-model:current-page="skillReleasePage" class="list-pagination" background hide-on-single-page layout="prev, pager, next" :total="selectedSkillReleases.length" :page-size="10" />
        </template>
      </section>
      <template v-if="detailType === 'tool'">
        <template v-if="detailToolGovernance">
          <section class="tool-gov-section">
            <h3>绑定修订</h3>
            <dl class="capability-detail__rows capability-detail__rows--compact">
              <div><dt>修订</dt><dd class="mono">{{ detailToolGovernance.bindingRevision.id }}</dd></div>
              <div><dt>端点</dt><dd class="mono">{{ detailToolGovernance.bindingRevision.endpoint }}</dd></div>
              <div><dt>执行器</dt><dd class="mono">{{ detailToolGovernance.bindingRevision.executor }}</dd></div>
              <div><dt>凭据槽位</dt><dd class="mono">{{ detailToolGovernance.bindingRevision.credentialSlot }}</dd></div>
              <div><dt>过滤策略</dt><dd>{{ detailToolGovernance.bindingRevision.filterPolicy }}</dd></div>
              <div><dt>封存时间</dt><dd>{{ detailToolGovernance.bindingRevision.sealedAt }}</dd></div>
            </dl>
            <p class="tool-gov-note">包数据不能改写端点、凭据槽位、执行器与权限范围。</p>
          </section>
        </template>
        <section class="tool-gov-section">
          <h3>引用方</h3>
          <el-table v-if="toolReferences.length" class="data-table" :data="pagedToolReferences" size="small">
            <el-table-column prop="agentName" label="Agent" min-width="160" />
            <el-table-column label="版本" min-width="150"><template #default="scope"><span class="mono">{{ scope.row.versions.map((v: string) => `v${v}`).join('、') }}</span></template></el-table-column>
          </el-table>
          <el-pagination v-if="toolReferences.length" v-model:current-page="toolReferencePage" class="list-pagination" background hide-on-single-page layout="prev, pager, next" :total="toolReferences.length" :page-size="10" />
          <p v-else class="tool-gov-note">暂无 Agent 引用</p>
        </section>
      </template>
      <div v-if="authStore.canManage" class="capability-detail__actions"><template v-if="detailType === 'skill' && selectedSkill"><el-button :type="selectedSkill.status === 'published' ? 'danger' : 'primary'" :loading="actionLoading === `skill:${selectedSkill.id}`" @click="changeSkillStatus(selectedSkill)">{{ selectedSkill.status === 'published' ? '停用 Skill' : selectedSkill.status === 'draft' ? (selectedSkill.packageSha256 ? '试运行并发布' : '校验并发布') : '启用 Skill' }}</el-button></template><template v-if="detailType === 'tool'"><el-button type="primary" @click="openToolPermissions()">配置权限与数据范围</el-button></template></div>
    </el-drawer>

  </div>
</template>

<style scoped>
:global(body:has(#capability-tab-install[aria-selected="true"])) { min-width: 0; }
.capability-filters { gap: 0; }
.skill-action-feedback { margin-bottom: 14px; }
.skill-action-feedback :deep(.el-alert__description) { line-height: 1.65; white-space: pre-wrap; }
.skill-test-dialog__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-right: 20px; }
.skill-test-dialog__header span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.skill-test-dialog__header h2 { margin: 4px 0 0; color: var(--color-text-heading); font-size: var(--dsh-font-size-section); }
.skill-test-dialog__starting { display: flex; align-items: center; gap: 12px; min-height: 110px; padding: 18px; border-radius: var(--radius-card); color: var(--color-primary); background: var(--color-primary-light); }
.skill-test-dialog__starting > .el-icon { font-size: 24px; }
.skill-test-dialog__starting strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.skill-test-dialog__starting p { margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.skill-test-dialog__run-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-bottom: 16px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.skill-test-dialog__run-meta code { margin-left: 4px; color: var(--color-text-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.skill-test-progress { padding: 4px 0; }
.skill-test-progress article { position: relative; display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 10px; min-height: 70px; }
.skill-test-progress article:not(:last-child)::after { position: absolute; top: 27px; bottom: 3px; left: 14px; width: 1px; background: var(--color-border); content: ''; }
.skill-test-progress__icon { z-index: 1; display: grid; width: 29px; height: 29px; place-items: center; border: 1px solid var(--color-border); border-radius: 50%; color: var(--color-text-muted); background: var(--color-bg-base); }
.skill-test-progress article.is-completed .skill-test-progress__icon { border-color: var(--color-success); color: var(--color-success); background: var(--color-success-light); }
.skill-test-progress article.is-running .skill-test-progress__icon { border-color: var(--color-primary); color: var(--color-primary); background: var(--color-primary-light); }
.skill-test-progress article.is-failed .skill-test-progress__icon { border-color: var(--color-danger); color: var(--color-danger); background: var(--color-danger-light); }
.skill-test-progress strong { display: block; padding-top: 3px; color: var(--color-text-heading); font-size: var(--font-size-caption); }
.skill-test-progress p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.55; }
.skill-test-progress time { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-micro); }
.skill-test-dialog__result { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 10px; margin-top: 4px; padding: 13px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-subtle); }
.skill-test-dialog__result.is-passed { border-color: var(--color-success); background: var(--color-success-light); }
.skill-test-dialog__result.is-failed, .skill-test-dialog__result.is-cancelled { border-color: var(--color-danger); background: var(--color-danger-light); }
.skill-test-dialog__result-icon { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 50%; color: var(--color-text-muted); background: var(--color-bg-base); }
.skill-test-dialog__result.is-passed .skill-test-dialog__result-icon { color: var(--color-success); }
.skill-test-dialog__result.is-failed .skill-test-dialog__result-icon, .skill-test-dialog__result.is-cancelled .skill-test-dialog__result-icon { color: var(--color-danger); }
.skill-test-dialog__result h3 { margin: 2px 0 0; color: var(--color-text-heading); font-size: var(--font-size-caption); }
.skill-test-dialog__result p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.6; }
.skill-test-dialog__hint { margin-right: auto; color: var(--color-text-muted); font-size: var(--font-size-micro); }
.skill-test-dialog :deep(.el-dialog__footer) { display: flex; align-items: center; }
.skill-test-dialog :deep(.el-dialog__body) { max-height: calc(100vh - 220px); overflow-y: auto; }
.capability-toolbar { justify-content: space-between; padding-top: 10px; }
.capability-toolbar .el-input { width: 330px; }
.capability-toolbar__legend { margin-left: auto; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.capability-toolbar__actions { display: flex; gap: 8px; align-items: center; }
.capability-toolbar__legend span { display: inline-flex; align-items: center; gap: 6px; }
.capability-panel :deep(.el-table__header .cell) { white-space: nowrap; }
.primary-cell { display: flex; min-width: 0; flex-direction: column; }
.primary-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.primary-cell small { max-width: 440px; margin-top: 4px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.primary-cell code { margin-top: 4px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.skill-primary-cell { gap: 4px; padding: 3px 0; }
.skill-primary-cell__name { display: flex; min-width: 0; align-items: center; gap: 8px; }
.skill-entry-label { flex: none; padding: 2px 6px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-micro); font-weight: var(--font-weight-badge); }
.skill-dependencies { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 5px; }
.skill-dependencies__label { color: var(--color-text-muted); font-size: var(--font-size-micro); }
.skill-dependency-chip { display: inline-flex; max-width: 230px; align-items: center; gap: 5px; padding: 3px 7px; border: 1px solid var(--color-border); border-radius: var(--radius-tag); color: var(--color-text-secondary); background: var(--color-bg-base); cursor: pointer; }
.skill-dependency-chip:hover, .skill-dependency-chip:focus-visible { border-color: var(--color-primary); color: var(--color-primary); outline: none; }
.skill-dependency-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-dependency-chip code { margin: 0; color: inherit; font-size: var(--font-size-micro); }
.skill-dependency-chip :deep(.status-tag) { font-size: var(--font-size-micro); }
.active-version-hint { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-micro); }
.mode-label { display: inline-flex; padding: 3px 7px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); font-weight: var(--font-weight-badge); }
.mode-label--write { color: var(--color-warning-strong); background: var(--color-warning-light); }
.role-text { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.mcp-name { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.mcp-endpoint { display: block; overflow: hidden; color: var(--color-text-primary); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.mcp-row-actions { display: flex; align-items: center; gap: 12px; white-space: nowrap; }
.mcp-row-actions :deep(.el-button) { margin-left: 0; }
.mcp-row-actions :deep(.el-dropdown .el-button) { display: inline-flex; align-items: center; gap: 4px; }
:global(.mcp-more-dropdown) { min-width: 150px; }
:global(.mcp-more-dropdown .mcp-more-dropdown__danger) { color: var(--color-danger); }
.mcp-tool-list { display: flex; max-height: min(560px, calc(100vh - 240px)); flex-direction: column; gap: 10px; overflow-y: auto; }
.mcp-tool-item { padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.mcp-tool-item > code { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.mcp-tool-item p { margin: 8px 0 12px; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.55; }
.mcp-tool-item strong { color: var(--color-text-secondary); font-size: var(--font-size-micro); }
.mcp-tool-item pre { max-height: 220px; margin: 6px 0 0; padding: 10px; overflow: auto; border-radius: var(--radius-button); color: var(--color-text-primary); background: var(--color-bg-base); font-size: var(--font-size-micro); line-height: 1.5; white-space: pre-wrap; }
.mcp-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.tool-catalog-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.tool-catalog-toolbar .el-input { max-width: 420px; }
.tool-catalog-toolbar .el-radio-group { flex: none; }
.tool-catalog-layout { display: grid; grid-template-columns: minmax(280px, 0.9fr) minmax(360px, 1.1fr); gap: var(--spacing-section); }
.tool-catalog-column { display: flex; min-width: 0; flex-direction: column; }
.tool-catalog-list { display: flex; flex: 1; flex-direction: column; gap: 8px; max-height: 480px; overflow-y: auto; }
.tool-catalog-card { width: 100%; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); color: var(--color-text-primary); background: var(--color-bg-base); text-align: left; cursor: pointer; }
.tool-catalog-card:hover, .tool-catalog-card.is-selected { border-color: var(--color-primary); background: var(--color-primary-light); }
.tool-catalog-card:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.tool-catalog-card__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tool-catalog-card small { display: block; margin-top: 4px; color: var(--color-text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.tool-catalog-card p { display: -webkit-box; margin: 8px 0 0; overflow: hidden; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.tool-catalog-config { min-width: 0; }
.tool-catalog-config .el-select { width: 100%; }
.tool-catalog-fixed-policy { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.tool-catalog-summary { margin-bottom: var(--spacing-section); padding: 14px; border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.tool-catalog-summary strong, .tool-catalog-summary span { display: block; }
.tool-catalog-summary span { margin-top: 5px; font-size: var(--font-size-badge); }
.tool-catalog-summary__status--ready { color: var(--color-success); }
.tool-catalog-summary__status--installed { color: var(--color-text-secondary); }
.tool-catalog-summary__status--unavailable { color: var(--color-warning); }
.tool-catalog-summary p { margin: 8px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.55; }
@media (max-width: 720px) { .tool-catalog-toolbar { align-items: stretch; flex-direction: column; } .tool-catalog-toolbar .el-input { max-width: none; } .tool-catalog-layout { grid-template-columns: 1fr; } }
.capability-detail__notice { display: flex; align-items: flex-start; gap: 9px; padding: 13px; border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); }
.capability-detail__notice p { margin: 0; font-size: var(--font-size-badge); line-height: 1.6; }
.capability-detail__rows { margin: 18px 0 0; }
.capability-detail__tabs { margin-top: 16px; }
.capability-detail__rows div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; padding: 12px 2px; border-bottom: 1px solid var(--color-border); }
.capability-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.capability-detail__rows dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
.capability-detail__identifier { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.capability-detail__identifier code { color: var(--color-text-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-size-badge); }
.capability-detail__code { padding: 9px; border-radius: var(--radius-button); background: var(--color-bg-subtle); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-size-badge) !important; }
.capability-detail__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
.tool-gov-section { margin-top: 22px; }
.tool-gov-section h3 { margin: 0 0 10px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.capability-detail__rows--compact { margin-top: 0; }
.tool-gov-note { margin: 8px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-size-badge); }
.cell-sub { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.muted { color: var(--color-text-muted); }
.capability-detail__table { margin-top: 14px; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-card); }
.capability-detail__releases { margin-top: 18px; }
.version-summary { display: flex; flex-direction: column; gap: 4px; }
.version-summary small,
.release-record small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.release-record p { margin: 6px 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.5; }
@media (max-width: 760px) { .capability-toolbar { align-items: stretch; flex-direction: column; } .capability-toolbar .el-input { width: 100%; } .capability-toolbar__legend { margin-left: 0; } .mcp-form-grid { grid-template-columns: 1fr; } }
</style>
