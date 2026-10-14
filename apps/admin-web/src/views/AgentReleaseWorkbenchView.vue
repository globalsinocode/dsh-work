<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'

import AgentDraftDialog from '@/components/AgentDraftDialog.vue'
import { adminApi } from '@/api/client'
import {
  useAgentGovernanceStore,
  type TrialRunStatus,
} from '@/stores/agentGovernance'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type {
  AgentDefinition,
  AgentEvalCase,
  AgentMcpScope,
  AgentPrincipalGovernance,
  AgentPrincipalRoleOption,
  AgentTrialRun,
  AgentVersionRecord,
} from '@/types/domain'
import {
  automatedAssertionSummary,
  hasV1CaseEvidence,
  trialCaseRuns,
  trialHasPublishableV1Evidence,
} from '@/utils/agent-evaluation-evidence'

type ReleaseStep = 'trial' | 'review'

const routeStepByName: Record<string, ReleaseStep> = {
  'agent-release-trial': 'trial',
  'agent-release-review': 'review',
}

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const governance = useAgentGovernanceStore()

const editorOpen = ref(false)
const submitNote = ref('')
const publishedVersion = ref('')
const releaseReady = ref(false)
/** 正在填写不通过原因的案例：key = `${trialId}:${caseId}`。 */
const rejectingCaseKey = ref('')
const rejectNote = ref('')
const confirmingTrial = ref(false)
const savingCases = ref(false)
const editableCases = ref<AgentEvalCase[]>([])
const activeCaseId = ref('')
const publicationRoleIds = ref<string[]>([])
const publicationDataScopes = ref<string[]>([])
const publicationSaving = ref(false)
const publicationScopeOpen = ref(false)
const principal = ref<AgentPrincipalGovernance>()
const availableRoles = ref<AgentPrincipalRoleOption[]>([])
const publicationAuthorizationError = ref('')
const runningCaseId = ref('')
const progressLoadError = ref(false)
let progressPollTimer: ReturnType<typeof setTimeout> | undefined
let progressPollEpoch = 0

const agentId = computed(() => String(route.params.agentId ?? ''))
const agent = computed(() => contentStore.agents.find(item => item.id === agentId.value))
const scopeOptions = computed(() => [...new Set([
  'enterprise:authorized', 'workspace:authorized',
  ...contentStore.agents.flatMap(item => item.dataScopes),
  ...contentStore.tools.flatMap(item => item.dataScopes),
])])
const publicationScopeDirty = computed(() => Boolean(agent.value && (
  JSON.stringify([...publicationRoleIds.value].sort()) !== JSON.stringify([...agent.value.roleIds].sort())
  || JSON.stringify([...publicationDataScopes.value].sort()) !== JSON.stringify([...agent.value.dataScopes].sort())
)))
const missingAuthorization = computed(() => {
  const current = agent.value
  const identity = principal.value
  if (!current || !identity) return []
  const missing: string[] = []
  if (identity.status !== 'active') missing.push('独立执行身份已停用')
  for (const scope of current.dataScopes.filter(scope => !identity.dataScopes.includes(scope))) {
    missing.push(`平台数据范围 ${scope}`)
  }
  for (const reference of current.tools) {
    const tool = contentStore.tools.find(item => `${item.id}@${item.version}` === reference || item.id === reference)
    if (!tool) continue
    if (tool.agentRunLocalDefault) continue
    if (!tool.allowedRoleIds?.some(roleId => identity.roleIds.includes(roleId))) missing.push(`工具 ${tool.name} 的执行角色`)
    for (const scope of tool.dataScopes.filter(value => !identity.dataScopes.includes(value) || !current.dataScopes.includes(value))) {
      missing.push(`工具 ${tool.name} 的平台数据范围 ${scope}`)
    }
  }
  return [...new Set(missing)]
})
const overlay = computed(() => governance.overlays[agentId.value])
const draftVersion = computed(() => contentStore.agentVersions.find(
  version => version.agentId === agentId.value && version.status === 'draft',
))
const candidate = computed(() => overlay.value?.candidate)
const completedVersion = computed(() =>
  publishedVersion.value || (candidate.value?.status === 'published' ? candidate.value.version : ''),
)
const latestTrial = computed(() => candidate.value?.trialRuns[0])
const releaseState = computed(() => governance.releaseStateFor(agentId.value))
/** 草稿已改但候选尚未同步完成：禁止发起试运行与发布，防止用旧证据放行。 */
const definitionChanged = computed(() => releaseState.value?.definitionChanged ?? false)
const candidateVersion = computed(() => draftVersion.value?.version ?? candidate.value?.version ?? '—')
const currentTrial = computed(() => latestTrial.value?.submissionRevision === candidate.value?.revision
  ? latestTrial.value : undefined)
const currentCaseRuns = computed(() => currentTrial.value ? trialCaseRuns(currentTrial.value) : [])
const activeCase = computed(() => editableCases.value.find(item => item.id === activeCaseId.value))
const activeCaseIndex = computed(() => editableCases.value.findIndex(item => item.id === activeCaseId.value))
const activeCaseRun = computed(() => caseRunFor(activeCaseId.value))
function caseRunFor(caseId: string) {
  return currentCaseRuns.value.find(item => item.caseId === caseId)
}
const progressCaseId = computed(() => currentTrial.value?.steps.find(step => step.id === 'dsh')?.currentCaseId
  ?? currentTrial.value?.progress?.caseId
  ?? (trialExecuting.value
    ? editableCases.value[currentCaseRuns.value.length]?.id
    : currentCaseRuns.value.at(-1)?.caseId))
const activeCaseExecuting = computed(() => Boolean(activeCaseId.value && (
  runningCaseId.value === activeCaseId.value
  || (trialExecuting.value && progressCaseId.value === activeCaseId.value)
)))
const showCaseProcess = computed(() => activeCaseExecuting.value
  || Boolean(activeCaseId.value && progressCaseId.value === activeCaseId.value
    && (activeCaseRun.value || currentTrial.value?.status === 'failed')))
const caseProcessSteps = computed(() => {
  if (!currentTrial.value || progressCaseId.value !== activeCaseId.value
    || (runningCaseId.value && !trialExecuting.value)) return []
  return currentTrial.value.steps.filter(step => step.status !== 'pending' && step.status !== 'skipped')
})
const caseProcessEvents = computed(() => progressCaseId.value === activeCaseId.value
  && !(runningCaseId.value && !trialExecuting.value)
  ? currentTrial.value?.progress?.events ?? [] : [])
const nextRunnableCaseIndex = computed(() => {
  const trial = currentTrial.value
  if (!trial || ['failed', 'cancelled'].includes(trial.status)) return 0
  if (trial.status === 'asserting' && currentCaseRuns.value.every(run => run.verdict === 'passed')) {
    return currentCaseRuns.value.length
  }
  return -1
})
const activeStep = computed<ReleaseStep>(() => routeStepByName[String(route.name)] ?? 'trial')
const trialExecuting = computed(() => Boolean(currentTrial.value
  && ['checking', 'queued', 'executing'].includes(currentTrial.value.status)))
const pollProgress = computed(() => activeStep.value === 'trial' && releaseReady.value
  && (Boolean(runningCaseId.value) || trialExecuting.value))
const candidateLocked = computed(() => candidate.value?.status === 'submitted')
const publicationScopeLocked = computed(() => trialExecuting.value
  || currentTrial.value?.status === 'asserting' || candidateLocked.value)
const failedChecks = computed(() => candidate.value?.checks.filter(check => check.status === 'failed') ?? [])
const trialFailureDetail = computed(() => failedChecks.value.length
  ? failedChecks.value.map(check => `${check.label}：${check.detail}`).join('；')
  : currentCaseRuns.value.find(run => run.error)?.error
    || currentCaseRuns.value.find(run => run.status !== 'succeeded' && run.outputExcerpt?.trim())?.outputExcerpt
    || currentTrial.value?.steps.find(step => step.status === 'failed')?.detail
    || currentTrial.value?.failureStage
    || '请检查当前案例结果，调整后从第一项重新验证。')
const checksPassed = computed(() => Boolean(candidate.value?.checks.length)
  && Boolean(candidate.value?.checks.every(check => check.status === 'passed')))
const casesChanged = computed(() => {
  const savedCases = candidate.value?.cases ?? []
  // 本页只编辑输入和判定标准；JSONB 对象字段的顺序不代表内容变化。
  return editableCases.value.length !== savedCases.length || editableCases.value.some((item, index) => {
    const saved = savedCases[index]
    return !saved || item.id !== saved.id || item.input !== saved.input
      || item.manualReview.rubric !== saved.manualReview?.rubric
  })
})
const casesValid = computed(() => ['success', 'invalid_input', 'permission_denied', 'prompt_injection', 'capability_failure'].every(
  kind => editableCases.value.some(item => item.kind === kind),
)
  && editableCases.value.length >= 5
  && editableCases.value.every(item => item.evaluationApiVersion === 'dsh-work.ai/evaluation/v1'
    && item.input.trim() && item.manualReview.rubric.trim()
    && item.automatedAssertions.length === 3
    && ['run_attempt_recorded', 'execution_succeeded', 'output_non_empty'].every(assertion =>
      item.automatedAssertions.includes(assertion as AgentEvalCase['automatedAssertions'][number]))))
/** 本轮尚未开始（或上一轮已失败/取消）：五项案例都可编辑并一次保存。 */
const trialNotStarted = computed(() => !currentTrial.value || ['failed', 'cancelled'].includes(currentTrial.value.status))
const canEditCases = computed(() => authStore.canManage
  && !candidateLocked.value && !definitionChanged.value && !trialExecuting.value)
function canEditCase(index: number) {
  return canEditCases.value && (trialNotStarted.value || index === nextRunnableCaseIndex.value)
}
const canEditActiveCase = computed(() => canEditCases.value
  && activeCaseIndex.value === nextRunnableCaseIndex.value)
const canSaveCases = computed(() => canEditCases.value && trialNotStarted.value
  && casesChanged.value && governance.busy !== 'trial')
const canRunActiveCase = computed(() => authStore.canManage
  && Boolean(agent.value?.roleIds.length) && Boolean(principal.value)
  && !publicationScopeDirty.value && !publicationSaving.value
  && !missingAuthorization.value.length
  && Boolean(activeCase.value?.input.trim() && activeCase.value?.manualReview.rubric.trim())
  && (!currentTrial.value || currentTrial.value.status === 'failed' || currentTrial.value.status === 'cancelled'
    ? casesValid.value : true)
  && canEditActiveCase.value
  && governance.busy !== 'trial'
)
const canPublish = computed(() => latestTrial.value?.status === 'passed'
  && trialHasPublishableV1Evidence(latestTrial.value)
  && checksPassed.value
  && candidate.value?.sealedRevision === candidate.value?.revision
  && !casesChanged.value
  && principal.value?.status === 'active' && !missingAuthorization.value.length
  && !publicationScopeDirty.value
  && !definitionChanged.value)
watch(agent, current => {
  publicationRoleIds.value = [...(current?.roleIds ?? [])]
  publicationDataScopes.value = [...(current?.dataScopes ?? [])]
  if (current && !current.roleIds.length) publicationScopeOpen.value = true
}, { immediate: true })

async function loadPublicationAuthorization() {
  const id = agentId.value
  const [roles, identity] = await Promise.allSettled([
    adminApi.getAgentPrincipalRoleOptions(), adminApi.getAgentPrincipal(id),
  ])
  availableRoles.value = roles.status === 'fulfilled' ? roles.value : []
  principal.value = identity.status === 'fulfilled' ? identity.value : undefined
  publicationAuthorizationError.value = roles.status === 'rejected' || identity.status === 'rejected'
    ? '无法读取当前角色或 Agent 执行身份，请重新读取后再试运行。' : ''
}

async function savePublicationScope() {
  if (!agent.value || !publicationRoleIds.value.length || publicationSaving.value) return
  publicationSaving.value = true
  // F-09：可见角色是发布属性，不作废试运行证据；只有平台数据范围上限属于 Agent 定义。
  const dataScopesChanged = [...publicationDataScopes.value].sort().join('\n') !== [...agent.value.dataScopes].sort().join('\n')
  try {
    await adminApi.updateAgentPublicationScope(agent.value.id, {
      roleIds: publicationRoleIds.value, dataScopes: publicationDataScopes.value,
    })
    await contentStore.load(true)
    await governance.ensureCandidate(agentId.value)
    await loadPublicationAuthorization()
    publicationScopeOpen.value = false
    ElMessage.success(dataScopesChanged
      ? '发布范围已保存；平台数据范围已变化，如已有试运行证据，需从第一项重新验证'
      : '发布范围已保存；仅调整可见角色，已有试运行证据继续有效')
  } catch (cause) {
    fail(cause)
  } finally {
    publicationSaving.value = false
  }
}
const canFinalize = computed(() => canPublish.value
  && ['draft', 'changes_requested', 'submitted'].includes(candidate.value?.status ?? ''))

/* ---------- 发布确认：相对来源版本的变化与案例结论 ---------- */

type ReviewSource = Pick<AgentVersionRecord, 'systemPrompt' | 'workInstructions'
  | 'skills' | 'tools' | 'mcpScope' | 'timeoutSeconds' | 'maxToolCalls' | 'maxOutputBytes'
  | 'roleIds' | 'dataScopes' | 'delegationPolicy'>
interface ReviewChange { key: string; label: string; before?: string; after: string; changed: boolean; long?: boolean }

const baselineVersion = computed(() => {
  const source = draftVersion.value?.sourceVersion
  return source
    ? contentStore.agentVersions.find(item => item.agentId === agentId.value && item.version === source && item.status !== 'draft')
    : undefined
})
function roleLabel(roleIds: string[]) {
  return roleIds.length
    ? [...roleIds].sort().map(id => availableRoles.value.find(role => role.id === id)?.name ?? id).join('、')
    : '未设置'
}
function mcpLabel(scope: AgentMcpScope | undefined) {
  if (!scope || scope.mode === 'all') return '全部可用 MCP'
  if (scope.mode === 'none') return '不使用 MCP'
  const names = scope.connectorIds.map(id => contentStore.connectors.find(item => item.id === id)?.name ?? id)
  return `仅选定：${names.join('、')}`
}
function listLabel(values: string[], empty = '无') {
  return values.length ? [...values].sort().join('、') : empty
}
function reviewFields(source: ReviewSource): Array<{ key: string; label: string; value: string; long?: boolean }> {
  return [
    { key: 'soul', label: 'SOUL.md', value: source.systemPrompt, long: true },
    { key: 'instructions', label: 'AGENTS.md 工作规程', value: source.workInstructions?.trim() || '未填写', long: Boolean(source.workInstructions?.trim()) },
    { key: 'skills', label: 'Skill', value: listLabel(source.skills) },
    { key: 'tools', label: '声明的平台工具', value: listLabel(source.tools, '无（仅平台默认工具）') },
    { key: 'mcp', label: 'MCP 范围', value: mcpLabel(source.mcpScope) },
    { key: 'limits', label: '运行限制', value: `超时 ${source.timeoutSeconds}s · 工具调用 ${source.maxToolCalls} 次 · 输出 ${Math.round(source.maxOutputBytes / 1024)} KB` },
    { key: 'delegation', label: '委派目标', value: listLabel(source.delegationPolicy?.allowedAgentVersionIds ?? []) },
    { key: 'audience', label: '员工可见角色', value: roleLabel(source.roleIds) },
    { key: 'scopes', label: '平台数据范围上限', value: listLabel(source.dataScopes, '未设置') },
  ]
}
const reviewChanges = computed<ReviewChange[]>(() => {
  const current = draftVersion.value ?? agent.value
  if (!current) return []
  const before = baselineVersion.value ? reviewFields(baselineVersion.value) : undefined
  return reviewFields(current).map((field, index) => {
    const previous = before?.[index]?.value
    return {
      key: field.key, label: field.label, after: field.value, long: field.long,
      ...(before ? { before: previous } : {}),
      changed: before ? previous !== field.value : true,
    }
  })
})
const changedReviewItems = computed(() => reviewChanges.value.filter(item => item.changed))
const unchangedReviewLabels = computed(() => reviewChanges.value.filter(item => !item.changed).map(item => item.label))
const reviewCaseRows = computed(() => {
  const runs = latestTrial.value ? trialCaseRuns(latestTrial.value) : []
  return (candidate.value?.cases ?? []).map(item => {
    const run = runs.find(entry => entry.caseId === item.id)
    return { id: item.id, kind: item.kind, input: item.input, verdict: run?.verdict, note: run?.verdictNote }
  })
})
function syncEditableCases(cases: AgentEvalCase[]) {
  editableCases.value = cases.map(item => ({
    ...item,
    automatedAssertions: [...(item.automatedAssertions ?? [])],
    manualReview: { required: true, rubric: item.manualReview?.rubric ?? '' },
  }))
}
watch(() => `${candidate.value?.id ?? ''}:${candidate.value?.revision ?? ''}`, () => {
  syncEditableCases(candidate.value?.cases ?? [])
  // 开始前保存案例会推进修订：保留当前编辑的页签，不跳回第一项。
  if (trialNotStarted.value && candidate.value?.cases.some(item => item.id === activeCaseId.value)) return
  const completed = new Set(currentCaseRuns.value.filter(run => run.verdict === 'passed').map(run => run.caseId))
  activeCaseId.value = candidate.value?.cases.find(item => !completed.has(item.id))?.id
    ?? candidate.value?.cases[0]?.id ?? ''
}, { immediate: true })

const trialStatusLabel: Record<TrialRunStatus, string> = {
  checking: '检查中',
  queued: '排队中',
  executing: '执行中',
  asserting: '待逐项确认',
  passed: '试运行通过',
  failed: '已失败',
  cancelled: '已取消',
}
const stepStatusLabel = { pending: '等待中', running: '进行中', passed: '已完成', failed: '失败', skipped: '已跳过' } as const
const caseProcessStatus = computed(() => runningCaseId.value && !trialExecuting.value
  ? '正在提交并检查本项'
  : currentTrial.value ? trialStatusLabel[currentTrial.value.status] : '正在检查配置与授权')
function progressTime(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function clearProgressPoll() {
  if (progressPollTimer) clearTimeout(progressPollTimer)
  progressPollTimer = undefined
}
function scheduleProgressPoll(agentKey: string, epoch: number, delay = 1000) {
  clearProgressPoll()
  progressPollTimer = setTimeout(async () => {
    if (epoch !== progressPollEpoch || !pollProgress.value || agentId.value !== agentKey) return
    try {
      await governance.loadReleaseState(agentKey)
      progressLoadError.value = false
    } catch {
      progressLoadError.value = true
    }
    if (epoch === progressPollEpoch && pollProgress.value && agentId.value === agentKey) {
      scheduleProgressPoll(agentKey, epoch)
    }
  }, delay)
}
watch([agentId, pollProgress], ([id, active]) => {
  progressPollEpoch += 1
  clearProgressPoll()
  if (active) scheduleProgressPoll(id, progressPollEpoch, 250)
}, { immediate: true })
onBeforeUnmount(() => {
  progressPollEpoch += 1
  clearProgressPoll()
})
const caseKindLabel = {
  success: '正常任务',
  invalid_input: '无效输入',
  permission_denied: '越权请求',
  prompt_injection: '提示注入',
  capability_failure: '能力不可用',
} as const
function caseProgress(caseId: string, index: number) {
  const run = currentCaseRuns.value.find(item => item.caseId === caseId)
  if (run?.verdict === 'passed') return { label: '已通过', tone: 'success' as const }
  if (run?.verdict === 'failed' || (run && currentTrial.value?.status === 'failed')) {
    return { label: '失败', tone: 'danger' as const }
  }
  if (run) return { label: '待确认', tone: 'warning' as const }
  if (trialExecuting.value && index === currentCaseRuns.value.length) {
    return { label: '运行中', tone: 'warning' as const }
  }
  if (index === nextRunnableCaseIndex.value) return { label: '待运行', tone: 'info' as const }
  return { label: '未开始', tone: 'info' as const }
}
watch([activeStep, candidate, canPublish, completedVersion], ([step, current, reviewReady, completed]) => {
  if (current && !completed && step === 'review' && !reviewReady) {
    void router.replace(stepPath('trial'))
  }
}, { immediate: true })

function fail(cause: unknown) {
  if (cause instanceof Error) ElMessage.error(cause.message)
}

function returnToAgents() {
  void router.push('/agents')
}

function stepPath(step: ReleaseStep, id = agentId.value) {
  return `/agents/${encodeURIComponent(id)}/release/${step}`
}

function canVisitStep(step: ReleaseStep) {
  return step === 'trial' || canPublish.value
}

function goToStep(step: ReleaseStep) {
  if (!canVisitStep(step)) return
  void router.push(stepPath(step))
}

function openEdit() {
  if (!agent.value) return
  editorOpen.value = true
}

function handleDraftSaved(saved: AgentDefinition) {
  governance.noteDraftSaved(saved.id)
  if (saved.id !== agentId.value) void router.replace(stepPath('trial', saved.id))
}

async function runActiveCase() {
  const testCase = activeCase.value
  if (!agent.value || !testCase || !canRunActiveCase.value) return
  runningCaseId.value = testCase.id
  progressLoadError.value = false
  try {
    if (!currentTrial.value || ['failed', 'cancelled'].includes(currentTrial.value.status)) {
      if (casesChanged.value) await governance.updateCases(agent.value.id, editableCases.value)
      await governance.startTrialRun(agent.value.id, testCase.id)
    } else {
      await governance.continueTrialCase(agent.value.id, currentTrial.value.id, {
        caseId: testCase.id, input: testCase.input, rubric: testCase.manualReview.rubric,
      })
      // 后续案例可单独编辑，服务端会修剪首尾空白且不推进候选修订。
      // 此时 revision watcher 不会触发，必须以保存后的案例覆盖本地表单。
      if (candidate.value) syncEditableCases(candidate.value.cases)
    }
  } catch (cause) {
    await governance.loadReleaseState(agent.value.id).catch(() => undefined)
    fail(cause)
  } finally {
    runningCaseId.value = ''
  }
}

function verdictKey(trialId: string, caseId: string) {
  return `${trialId}:${caseId}`
}

function startReject(trial: AgentTrialRun, caseId: string) {
  rejectingCaseKey.value = verdictKey(trial.id, caseId)
  rejectNote.value = ''
}

function cancelReject() {
  rejectingCaseKey.value = ''
  rejectNote.value = ''
}

async function confirmCase(trial: AgentTrialRun, caseId: string, verdict: 'passed' | 'failed') {
  const run = caseRunFor(caseId)
  if (!run || run.verdict || !hasV1CaseEvidence(run)) return
  const note = rejectNote.value.trim()
  if (verdict === 'failed' && !note) return
  confirmingTrial.value = true
  try {
    await governance.confirmTrialRun(agentId.value, trial.id, [{ caseId, verdict, ...(verdict === 'failed' ? { note } : {}) }])
    cancelReject()
    if (verdict === 'passed') {
      const index = editableCases.value.findIndex(item => item.id === caseId)
      const next = editableCases.value[index + 1]
      activeCaseId.value = next?.id ?? caseId
      ElMessage.success(next ? '本项已通过，可以继续验证下一项' : '五项均已通过，可以进入发布确认')
    } else {
      ElMessage.warning('本项未通过，本轮验证已结束；根据原因调整后需从第一项重新开始')
    }
  } catch (cause) {
    fail(cause)
  } finally {
    confirmingTrial.value = false
  }
}

async function saveCases() {
  if (!agent.value || !canSaveCases.value || !casesValid.value) return
  savingCases.value = true
  try {
    await governance.updateCases(agent.value.id, editableCases.value)
    ElMessage.success('五项案例已保存')
  } catch (cause) {
    fail(cause)
  } finally {
    savingCases.value = false
  }
}

async function requestChanges() {
  if (!agent.value) return
  try {
    const { value } = await ElMessageBox.prompt('退回修改必须填写审核意见，说明需要调整的内容。', '退回修改', {
      confirmButtonText: '退回',
      cancelButtonText: '取消',
      inputPlaceholder: '审核意见',
      inputValidator: (input: string) => Boolean(input?.trim()) || '审核意见不能为空',
    })
    await governance.requestCandidateChanges(agent.value.id, String(value ?? '').trim())
    ElMessage.success('已退回修改，候选解除封存')
  } catch (cause) {
    fail(cause)
  }
}

async function withdrawCandidate() {
  if (!agent.value) return
  try {
    await ElMessageBox.confirm(
      '撤回后本次候选进入终态并保留历史记录；再次进入发布流程将创建新候选。',
      '撤回候选',
      { confirmButtonText: '确认撤回', cancelButtonText: '取消', type: 'warning' },
    )
    await governance.withdrawCandidate(agent.value.id)
    await governance.ensureCandidate(agent.value.id)
    ElMessage.success('候选已撤回')
  } catch (cause) {
    fail(cause)
  }
}

async function reviewAndPublish() {
  const currentAgent = agent.value
  const version = candidateVersion.value
  if (!currentAgent || version === '—') return
  try {
    await ElMessageBox.confirm(
      '确认后即表示审核通过，系统会把封存定义、精确依赖与绑定修订发布为不可变版本，并记录本次检查与试运行证据。',
      '确认发布',
      { confirmButtonText: '确认发布', cancelButtonText: '取消', type: 'warning' },
    )
    await governance.reviewAndPublish(currentAgent.id, submitNote.value.trim())
    submitNote.value = ''
    publishedVersion.value = version
    ElMessage.success(`已发布 v${version}，证据已记录`)
  } catch (cause) {
    fail(cause)
  }
}

onMounted(async () => {
  await contentStore.load()
  await loadPublicationAuthorization()
  // GET 只读：有管理权限时先经 POST 同步候选（创建/重绑/修订推进），只读用户直接拉取现状
  const sync = authStore.canManage ? governance.ensureCandidate : governance.loadReleaseState
  await sync(agentId.value).catch(() => undefined)
  releaseReady.value = true
})
</script>

<template>
  <div class="ops-page release-workbench">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section v-if="completedVersion" class="content-panel release-result">
      <el-result icon="success" title="发布完成" :sub-title="`Agent v${completedVersion} 已发布为不可变版本，配置检查、试运行证据及填写的业务确认已随版本记录。`">
        <template #extra>
          <el-button type="primary" @click="returnToAgents">返回 Agent 管理</el-button>
        </template>
      </el-result>
    </section>

    <section v-else-if="!releaseReady" class="content-panel release-result">
      <el-skeleton :rows="5" animated />
    </section>

    <section v-else-if="!agent" class="content-panel release-result">
      <el-result icon="warning" title="未找到 Agent" sub-title="该 Agent 可能已被移除。">
        <template #extra><el-button type="primary" @click="returnToAgents">返回 Agent 管理</el-button></template>
      </el-result>
    </section>

    <section v-else-if="!candidate" class="content-panel release-result">
      <el-empty description="当前没有待处理的候选修订" :image-size="72">
        <el-button v-if="authStore.canManage" type="primary" @click="openEdit">创建新版本</el-button>
        <el-button @click="returnToAgents">返回 Agent 管理</el-button>
      </el-empty>
    </section>

    <template v-else-if="agent && candidate">
      <div class="stage-page">
        <template v-if="activeStep === 'trial'">
          <section class="content-panel workbench-card" aria-label="发布范围">
            <div class="card-head">
              <div class="card-head__title"><h2>发布范围</h2><span>{{ agent.roleIds.length ? `${agent.roleIds.length} 个可见角色 · ${agent.dataScopes.length} 个平台数据范围` : '发布前设置员工可见角色' }}</span></div>
              <el-button v-if="authStore.canManage && agent.roleIds.length" size="small" :disabled="publicationScopeLocked" @click="publicationScopeOpen = !publicationScopeOpen">{{ publicationScopeOpen ? '收起' : '调整' }}</el-button>
            </div>
            <template v-if="publicationScopeOpen">
              <div class="publication-scope-grid">
                <el-form-item label="员工可见角色（必选）">
                  <el-select v-model="publicationRoleIds" multiple filterable aria-label="员工可见角色" placeholder="选择发布后可使用 Agent 的员工角色" :disabled="publicationScopeLocked">
                    <el-option v-for="role in availableRoles.filter(item => item.status === 'active')" :key="role.id" :label="role.name" :value="role.id" />
                  </el-select>
                </el-form-item>
                <el-form-item label="平台数据范围上限（按需）">
                  <el-select v-model="publicationDataScopes" multiple filterable allow-create default-first-option aria-label="平台数据范围上限" placeholder="基础 Agent 可留空" :disabled="publicationScopeLocked">
                    <el-option v-for="scope in scopeOptions" :key="scope" :label="scope" :value="scope" />
                  </el-select>
                </el-form-item>
              </div>
              <p class="hint">可见角色只控制员工选择 Agent；版本数据范围只是上限，不会授予执行身份权限。实际授权在 Agent 独立身份中设置，仅约束 dsh-work 受控能力，不过滤 MCP 上游数据。</p>
              <el-button v-if="authStore.canManage" type="primary" size="small" :loading="publicationSaving" :disabled="!publicationRoleIds.length || !publicationScopeDirty || publicationScopeLocked" @click="savePublicationScope">保存发布范围</el-button>
            </template>
            <p v-if="currentTrial?.status === 'asserting'" class="hint">调整发布范围前，请先取消本轮验证。只调整可见角色不影响试运行证据；平台数据范围变化后须从第一项重新试运行。</p>
            <p v-if="!agent.roleIds.length" class="hint">先保存员工可见范围，再逐项试运行；无需企业业务数据时，平台数据范围和 Agent 业务授权均可留空。</p>
            <el-alert v-if="publicationAuthorizationError" type="error" :closable="false" :title="publicationAuthorizationError">
              <el-button link type="primary" @click="loadPublicationAuthorization">重新读取</el-button>
            </el-alert>
            <el-alert v-if="missingAuthorization.length" type="warning" :closable="false" :title="`试运行前还需授权：${missingAuthorization.join('、')}`" description="请在 Agent 管理详情的独立执行身份中授予所需能力；可见角色和创建者权限不会自动转为执行授权。" />
            <p v-else-if="agent.roleIds.length && principal?.status === 'active' && !agent.tools.length && !agent.dataScopes.length" class="hint">独立执行身份有效，基础文本试运行无需业务角色或平台数据授权。</p>
          </section>
          <section class="content-panel workbench-card">
            <div class="card-head">
              <div class="card-head__title"><h2>验证案例</h2><span>{{ agent.name }}</span></div>
              <div class="case-card-actions">
                <el-button v-if="authStore.canManage" size="small" :disabled="candidateLocked" @click="openEdit">编辑配置</el-button>
                <el-button v-if="authStore.canManage && currentTrial && ['checking', 'queued', 'executing', 'asserting'].includes(currentTrial.status)" size="small" text type="danger" @click="governance.cancelTrialRun(agentId, currentTrial.id)">取消本轮验证</el-button>
              </div>
            </div>
            <p v-if="candidateLocked" class="hint">已提交候选内容已封存；修改前请先退回或撤回。</p>
            <p v-if="trialNotStarted" class="section-intro">开始前可在各页签中一次填写五项案例；运行时逐项执行并确认结果，通过后继续下一项。</p>
            <el-alert v-if="definitionChanged" type="warning" :closable="false" show-icon title="草稿已变更" description="候选同步完成前不能发起试运行或发布。" />
            <el-alert v-if="failedChecks.length || currentTrial?.status === 'failed'" class="case-feedback" type="error" :closable="false" show-icon :title="failedChecks.length ? '自动检查未通过' : '验证失败'" :description="trialFailureDetail" />
            <el-alert v-if="!casesValid" type="warning" :closable="false" show-icon title="案例不完整，无法试运行" description="需要五种案例且每条具有输入和人工判定标准。旧版候选可撤回并重建。" />
            <el-button v-if="!casesValid && authStore.canManage" size="small" type="warning" plain @click="withdrawCandidate">撤回并重建候选</el-button>
            <el-tabs v-model="activeCaseId" class="case-tabs" aria-label="五类逐项验证案例">
              <el-tab-pane v-for="(testCase, index) in editableCases" :key="testCase.id" :name="testCase.id">
                <template #label>
                  <span class="case-tab-label">{{ index + 1 }}. {{ caseKindLabel[testCase.kind] }}
                    <el-tag size="small" :type="caseProgress(testCase.id, index).tone" effect="plain">{{ caseProgress(testCase.id, index).label }}</el-tag>
                  </span>
                </template>
                <div class="case-editor">
                  <strong v-if="testCase.name !== caseKindLabel[testCase.kind]" class="case-editor__name">{{ testCase.name }}</strong>
                  <p v-if="!canEditCase(index) && !caseRunFor(testCase.id)
                    && !(trialExecuting && progressCaseId === testCase.id)" class="hint">本轮验证进行中；轮到本项时可调整输入和判定标准。</p>
                  <el-form-item label="测试输入">
                    <el-input v-model="testCase.input" type="textarea" :rows="2" :maxlength="4000" :disabled="!canEditCase(index)" :aria-label="`${testCase.name}测试输入`" />
                  </el-form-item>
                  <el-form-item label="人工判定标准">
                    <el-input v-model="testCase.manualReview.rubric" type="textarea" :rows="2" :maxlength="2000" :disabled="!canEditCase(index)" :aria-label="`${testCase.name}人工判定标准`" />
                  </el-form-item>

                  <details v-if="testCase.id === activeCaseId && showCaseProcess" :key="`${currentTrial?.id ?? 'starting'}:${testCase.id}`" class="case-process" :open="activeCaseExecuting || undefined">
                    <summary>{{ activeCaseExecuting ? `运行过程 · ${caseProcessStatus}` : '查看运行过程' }}</summary>
                    <div class="case-process__body" role="status" aria-live="polite" aria-atomic="false">
                      <p v-if="!caseProcessSteps.length" class="hint">正在检查配置、授权和案例，请稍候…</p>
                      <ol v-else class="case-process__steps">
                        <li v-for="step in caseProcessSteps" :key="step.id" :class="`case-process__step--${step.status}`">
                          <span>{{ step.label }}</span><small>{{ stepStatusLabel[step.status] }}</small>
                        </li>
                      </ol>
                      <ul v-if="caseProcessEvents.length" class="case-process__events" aria-label="DSH 运行事件">
                        <li v-for="event in caseProcessEvents" :key="event.type"><time :datetime="event.occurredAt">{{ progressTime(event.occurredAt) }}</time>{{ event.label }}</li>
                      </ul>
                      <p v-if="progressLoadError && activeCaseExecuting" class="hint">进度暂时无法更新，正在重试读取。</p>
                    </div>
                  </details>

                  <div v-if="caseRunFor(testCase.id) && currentTrial" class="case-run case-run--current">
                    <div class="case-run__head">
                      <strong>{{ caseRunFor(testCase.id)!.status === 'succeeded' ? '实际输出' : '执行详情' }}</strong>
                      <el-tag v-if="caseRunFor(testCase.id)!.verdict" size="small" :type="caseRunFor(testCase.id)!.verdict === 'passed' ? 'success' : 'danger'">{{ caseRunFor(testCase.id)!.verdict === 'passed' ? '已确认通过' : '判定不通过' }}</el-tag>
                    </div>
                    <el-alert v-if="!hasV1CaseEvidence(caseRunFor(testCase.id)!)" type="warning" :closable="false" show-icon title="旧版评测证据不可用于发布" description="请撤回并重建候选后重新运行五类案例。" />
                    <div v-if="caseRunFor(testCase.id)!.status === 'succeeded'" class="case-run__output" role="region" :aria-label="`${testCase.name}的实际输出`" tabindex="0">{{ caseRunFor(testCase.id)!.outputExcerpt || '（无输出）' }}</div>
                    <p v-if="caseRunFor(testCase.id)!.verdict === 'failed' && caseRunFor(testCase.id)!.verdictNote" class="case-run__reject-note">不通过原因：{{ caseRunFor(testCase.id)!.verdictNote }}</p>
                    <details class="case-run__details">
                      <summary>查看运行与自动检查</summary>
                      <dl class="case-run__io">
                        <div><dt>自动检查</dt><dd>{{ automatedAssertionSummary(caseRunFor(testCase.id)!) || '旧版证据不可用' }}</dd></div>
                        <div v-if="caseRunFor(testCase.id)!.runId"><dt>Run</dt><dd class="mono">{{ caseRunFor(testCase.id)!.runId }}</dd></div>
                        <div v-if="caseRunFor(testCase.id)!.attemptId"><dt>Attempt</dt><dd class="mono">{{ caseRunFor(testCase.id)!.attemptId }}</dd></div>
                        <div v-if="caseRunFor(testCase.id)!.status !== 'succeeded' && (caseRunFor(testCase.id)!.outputExcerpt || caseRunFor(testCase.id)!.error)"><dt>执行返回</dt><dd>{{ caseRunFor(testCase.id)!.outputExcerpt || caseRunFor(testCase.id)!.error }}</dd></div>
                      </dl>
                    </details>
                    <div v-if="currentTrial.status === 'asserting' && !caseRunFor(testCase.id)!.verdict && authStore.canManage && hasV1CaseEvidence(caseRunFor(testCase.id)!)" class="case-run__verdict" role="group" :aria-label="`${testCase.name}人工结论`">
                      <template v-if="rejectingCaseKey !== verdictKey(currentTrial.id, testCase.id)">
                        <el-button type="success" size="small" :loading="confirmingTrial" @click="confirmCase(currentTrial, testCase.id, 'passed')">通过</el-button>
                        <el-button type="danger" plain size="small" :disabled="confirmingTrial" @click="startReject(currentTrial, testCase.id)">不通过</el-button>
                      </template>
                      <div v-else class="case-run__reject">
                        <el-input v-model="rejectNote" type="textarea" :rows="2" :maxlength="1000" show-word-limit placeholder="说明哪里不符合判定标准，修改配置后据此重新验证" :aria-label="`${testCase.name}不通过原因`" />
                        <div class="case-run__reject-actions">
                          <el-button type="danger" size="small" :loading="confirmingTrial" :disabled="!rejectNote.trim()" @click="confirmCase(currentTrial, testCase.id, 'failed')">确认不通过</el-button>
                          <el-button size="small" :disabled="confirmingTrial" @click="cancelReject">取消</el-button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="authStore.canManage" class="case-actions">
                    <el-button v-if="index === nextRunnableCaseIndex" type="primary" :loading="governance.busy === 'trial'" :disabled="!canRunActiveCase" @click="runActiveCase">{{ currentTrial && ['failed', 'cancelled'].includes(currentTrial.status) ? '重新运行第一项' : '运行本项' }}</el-button>
                    <el-button v-if="index !== 0 && (currentTrial?.status === 'failed' || currentTrial?.status === 'cancelled')" @click="activeCaseId = editableCases[0]?.id ?? ''">返回第一项重新验证</el-button>
                    <el-button v-if="canSaveCases" :loading="savingCases" :disabled="!casesValid" @click="saveCases">保存全部案例</el-button>
                  </div>
                </div>
              </el-tab-pane>
            </el-tabs>
          </section>

          <footer v-if="canPublish" class="stage-footer stage-footer--forward">
            <el-button type="primary" @click="goToStep('review')">验证通过，确认发布</el-button>
          </footer>
        </template>

        <template v-else>
          <section class="content-panel workbench-card review-summary">
            <div class="card-head"><div class="card-head__title"><h2>发布确认摘要</h2><span>{{ agent.name }}</span></div></div>
            <p class="review-version">
              将发布 <strong class="mono">v{{ candidateVersion }}</strong>
              <template v-if="baselineVersion">，对比来源版本 <span class="mono">v{{ baselineVersion.version }}</span></template>
              <template v-else>，首次发布，无对比基线</template>
            </p>
          </section>

          <section class="content-panel workbench-card" aria-label="本次变化">
            <div class="card-head"><div class="card-head__title"><h2>{{ baselineVersion ? '本次变化' : '发布配置' }}</h2><span>{{ baselineVersion ? `${changedReviewItems.length} 项有变化` : '首次发布的完整配置' }}</span></div></div>
            <p v-if="baselineVersion && !changedReviewItems.length" class="hint">与来源版本相比没有配置变化。</p>
            <ul class="review-changes">
              <li v-for="item in changedReviewItems" :key="item.key" class="review-change">
                <span class="review-change__label">{{ item.label }}</span>
                <template v-if="item.long">
                  <details class="review-change__long">
                    <summary>{{ baselineVersion ? '已修改，展开对比' : '展开查看' }}</summary>
                    <div :class="baselineVersion ? 'review-change__compare' : ''">
                      <div v-if="baselineVersion"><small>来源版本</small><pre>{{ item.before }}</pre></div>
                      <div><small v-if="baselineVersion">本次</small><pre>{{ item.after }}</pre></div>
                    </div>
                  </details>
                </template>
                <span v-else class="review-change__value">
                  <template v-if="baselineVersion"><del>{{ item.before }}</del><span aria-hidden="true"> → </span></template>{{ item.after }}
                </span>
              </li>
            </ul>
            <p v-if="baselineVersion && unchangedReviewLabels.length" class="hint">未变化：{{ unchangedReviewLabels.join('、') }}</p>
          </section>

          <section class="content-panel workbench-card" aria-label="验证结论">
            <div class="card-head"><div class="card-head__title"><h2>验证结论</h2><span>{{ reviewCaseRows.filter(row => row.verdict === 'passed').length }}/{{ reviewCaseRows.length }} 项人工确认通过</span></div></div>
            <ul class="review-cases">
              <li v-for="row in reviewCaseRows" :key="row.id">
                <strong>{{ caseKindLabel[row.kind] }}</strong>
                <span class="review-cases__input">{{ row.input }}</span>
                <el-tag size="small" :type="row.verdict === 'passed' ? 'success' : row.verdict === 'failed' ? 'danger' : 'info'">{{ row.verdict === 'passed' ? '通过' : row.verdict === 'failed' ? '不通过' : '未确认' }}</el-tag>
                <small v-if="row.note" class="review-cases__note">{{ row.note }}</small>
              </li>
            </ul>
            <details class="review-technical">
              <summary>技术详情</summary>
              <dl class="meta-grid">
                <div><dt>候选修订</dt><dd class="mono">rev {{ candidate.revision }}</dd></div>
                <div><dt>封存修订</dt><dd class="mono">rev {{ candidate.sealedRevision ?? '—' }}</dd></div>
                <div><dt>试运行编号</dt><dd class="mono">{{ latestTrial?.id ?? '—' }}</dd></div>
                <div><dt>平台工具绑定修订</dt><dd class="mono">{{ candidate.bindingRefs.length ? candidate.bindingRefs.map(pin => `${pin.tool}#rev${pin.revision}`).join('、') : '无' }}</dd></div>
              </dl>
            </details>
          </section>

          <section v-if="authStore.canManage" class="content-panel workbench-card submit-card">
            <div class="card-head"><h2>确认发布</h2></div>
            <p class="side-note">核对候选版本与试运行证据后，一次确认即审核通过并发布不可变平台版本。发布时会重新检查修订、依赖和绑定。</p>
            <el-input v-model="submitNote" type="textarea" :rows="3" aria-label="业务确认意见" placeholder="业务确认意见（选填）：说明按哪些业务场景确认了输出" />
            <small class="submit-hint">填写后作为业务确认记入版本证据；留空则只记录配置检查与试运行证据。</small>
            <div class="submit-actions">
              <el-button type="primary" :loading="governance.busy === 'submit'" :disabled="!canFinalize" data-action="publish-agent" @click="reviewAndPublish">确认发布</el-button>
              <el-button v-if="candidate.status === 'submitted'" :loading="governance.busy === 'submit'" @click="requestChanges">退回修改</el-button>
              <el-button text type="danger" :loading="governance.busy === 'submit'" @click="withdrawCandidate">撤回候选</el-button>
            </div>
            <small v-if="!canFinalize" class="submit-hint">需要一次通过的封存试运行，且封存修订与当前修订一致。</small>
          </section>
          <footer class="stage-footer">
            <el-button @click="goToStep('trial')">上一步：试运行</el-button>
          </footer>
        </template>
      </div>
    </template>

    <AgentDraftDialog v-model="editorOpen" :agent="agent" @saved="handleDraftSaved" />
  </div>
</template>

<style scoped>
.release-workbench { width: 100%; gap: 8px; }
.release-result { min-height: 360px; }
.release-result .el-alert { max-width: 680px; margin: 0 auto 24px; }
.stage-page { width: 100%; }
.stage-footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 6px; padding: 16px 18px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-base); }
.stage-footer--forward { justify-content: flex-end; }
.stage-footer > span, .stage-footer > div > span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.stage-footer > div { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
.workbench-card { margin-bottom: 14px; padding: 18px; }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.card-head h2 { margin: 2px 0 0; color: var(--color-text-heading); font-size: var(--font-size-body); }
.card-head__title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; min-width: 0; }
.card-head__title span { color: var(--color-text-muted); font-size: var(--font-size-badge); overflow-wrap: anywhere; }
.publication-scope-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.case-run__details summary { width: fit-content; cursor: pointer; }
.meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; margin: 0; }
.meta-grid--compact > div { padding: 7px 0; }
.meta-grid > div { padding: 9px 0; border-bottom: 1px solid var(--color-border); }
.meta-grid__wide { grid-column: 1 / -1; }
.meta-grid dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.meta-grid dd { margin: 3px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); overflow-wrap: anywhere; }
.muted, .hint, .submit-hint, .side-note { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.hint { margin: 7px 0 0; }
.side-note { margin: 0; line-height: 1.55; }
.mono { font-family: monospace; }
.section-intro { margin: 3px 0 10px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.case-feedback { margin-bottom: 10px; }
.case-tabs { margin-top: 12px; }
.case-card-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.case-tab-label { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.case-editor__name { display: block; margin-top: 10px; color: var(--color-text-heading); font-size: var(--font-size-badge); }
.case-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.case-process { margin-top: 14px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-subtle); color: var(--color-text-primary); font-size: var(--font-size-badge); }
.case-process summary { width: fit-content; cursor: pointer; font-weight: 600; }
.case-process__body { padding: 6px 0 2px 16px; }
.case-process__steps, .case-process__events { margin: 6px 0 0; padding-left: 16px; }
.case-process__steps li { padding: 3px 0; }
.case-process__steps small { margin-left: 10px; color: var(--color-text-muted); }
.case-process__step--running small { color: var(--color-primary); }
.case-process__step--failed small { color: var(--color-danger); }
.case-process__events { border-top: 1px solid var(--color-border); padding-top: 8px; list-style: none; }
.case-process__events li { display: flex; gap: 10px; padding: 3px 0; }
.case-process__events time { color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.case-run--current { margin-top: 16px; }
.case-run__verdict { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
.case-run__reject { display: grid; gap: 8px; width: 100%; }
.case-run__reject-actions { display: flex; gap: 8px; }
.case-run__reject-note { margin: 8px 0 0; color: var(--color-danger); font-size: var(--font-size-badge); white-space: pre-wrap; }
.review-version { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); }
.review-changes, .review-cases { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.review-change { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--color-border); font-size: var(--font-size-caption); }
.review-change__label { color: var(--color-text-muted); }
.review-change__value { color: var(--color-text-primary); overflow-wrap: anywhere; }
.review-change__value del { color: var(--color-text-muted); }
.review-change__long summary { width: fit-content; cursor: pointer; color: var(--color-primary); }
.review-change__compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.review-change__long small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.review-change__long pre { max-height: 240px; margin: 4px 0 0; padding: 8px 10px; overflow: auto; border-radius: var(--radius-button); background: var(--color-bg-subtle); font-family: inherit; font-size: var(--font-size-badge); white-space: pre-wrap; overflow-wrap: anywhere; }
.review-cases li { display: grid; grid-template-columns: 90px minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 9px 0; border-bottom: 1px solid var(--color-border); font-size: var(--font-size-caption); }
.review-cases__input { overflow: hidden; color: var(--color-text-secondary); text-overflow: ellipsis; white-space: nowrap; }
.review-cases__note { grid-column: 2 / -1; color: var(--color-danger); }
.review-technical { margin-top: 12px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.review-technical summary { width: fit-content; cursor: pointer; }
.case-run { padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-subtle); }
.case-editor :deep(.el-form-item) { margin: 10px 0; }
.case-run__head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.case-run__head strong { color: var(--color-text-heading); font-size: var(--font-size-badge); }
.case-run__details { margin-top: 8px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.case-run__io { display: grid; gap: 6px; margin: 8px 0 0; }
.case-run__io > div { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
.case-run__io dt { color: var(--color-text-muted); font-size: var(--font-size-micro); }
.case-run__io dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-badge); overflow-wrap: anywhere; white-space: pre-wrap; }
.case-run__output { max-height: 360px; margin-top: 8px; overflow-y: auto; overflow-wrap: anywhere; white-space: pre-wrap; color: var(--color-text-primary); font-size: var(--font-size-badge); }
.submit-card { display: flex; flex-direction: column; gap: 10px; }
.submit-card .card-head { margin-bottom: 0; }
.submit-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
@media (max-width: 620px) { .meta-grid, .publication-scope-grid, .review-change, .review-change__compare { grid-template-columns: 1fr; } .meta-grid__wide { grid-column: auto; } }
</style>
