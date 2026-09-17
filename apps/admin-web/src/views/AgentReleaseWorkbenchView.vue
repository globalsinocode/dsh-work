<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, CircleClose, Loading } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'

import AgentDraftDialog from '@/components/AgentDraftDialog.vue'
import { useListPagination } from '@/composables/use-list-pagination'
import {
  useAgentGovernanceStore,
  type CheckStatus,
  type PlanAction,
  type SubmissionStatus,
  type TrialRunStatus,
} from '@/stores/agentGovernance'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentTrialRun } from '@/types/domain'

type ReleaseStep = 'definition' | 'checks' | 'trial' | 'review'

const routeStepByName: Record<string, ReleaseStep> = {
  'agent-release-definition': 'definition',
  'agent-release-checks': 'checks',
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
/** 逐项确认选择：key = `${trialId}:${caseId}` → 审核人对该案例输出的判定。 */
const caseVerdicts = ref<Record<string, 'passed' | 'failed'>>({})
const confirmingTrial = ref(false)

const agentId = computed(() => String(route.params.agentId ?? ''))
const agent = computed(() => contentStore.agents.find(item => item.id === agentId.value))
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
const skillReferences = computed(() => draftVersion.value?.skills ?? [])
const toolReferences = computed(() => draftVersion.value?.tools ?? [])
const candidateDataScopes = computed(() => draftVersion.value?.dataScopes ?? [])
const missingDependencyCount = computed(() => (
  candidate.value?.missingDeps.skills.length ?? 0
) + (
  candidate.value?.missingDeps.tools.length ?? 0
))
type DependencyRow = {
  key: string
  id: string
  kind: 'skill' | 'tool'
  source: 'platform' | 'package' | 'missing'
  status: 'resolved' | 'missing' | 'candidate'
  version: string
  path?: string
}
const dependencyStatusMeta: Record<DependencyRow['status'], { label: string; type: 'success' | 'warning' | 'danger' | 'info' }> = {
  resolved: { label: '已解析', type: 'success' },
  missing: { label: '缺失', type: 'danger' },
  candidate: { label: '候选草稿', type: 'warning' },
}
const dependencySourceLabel: Record<DependencyRow['source'], string> = {
  platform: '平台已发布',
  package: '随包候选',
  missing: '平台未接入',
}
function dependencyStatusMetaOf(status: DependencyRow['status']) {
  return dependencyStatusMeta[status]
}
function dependencySourceText(source: DependencyRow['source']) {
  return dependencySourceLabel[source]
}
function splitRef(reference: string) {
  const separator = reference.lastIndexOf('@')
  return separator > 0
    ? { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
    : { id: reference, version: '—' }
}
function formatTimestamp(value?: string) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : value
}
/** 统一依赖清单：已解析引用 + 缺失引用 + 随包候选；阻塞项排在前面。 */
const dependencyRows = computed<DependencyRow[]>(() => {
  const current = candidate.value
  const rows: DependencyRow[] = []
  for (const reference of skillReferences.value) {
    const { id, version } = splitRef(reference)
    rows.push({ key: `platform:skill:${reference}`, id, kind: 'skill', source: 'platform', status: 'resolved', version })
  }
  for (const reference of toolReferences.value) {
    const { id, version } = splitRef(reference)
    rows.push({ key: `platform:tool:${reference}`, id, kind: 'tool', source: 'platform', status: 'resolved', version })
  }
  for (const reference of current?.missingDeps.skills ?? []) {
    rows.push({ key: `missing:skill:${reference}`, id: reference, kind: 'skill', source: 'missing', status: 'missing', version: '未解析' })
  }
  for (const reference of current?.missingDeps.tools ?? []) {
    rows.push({ key: `missing:tool:${reference}`, id: reference, kind: 'tool', source: 'missing', status: 'missing', version: '未解析' })
  }
  for (const item of current?.packageRefs.skills ?? []) {
    rows.push({ key: `package:skill:${item.id}`, id: item.id, kind: 'skill', source: 'package', status: 'candidate', version: item.version, path: item.path })
  }
  for (const item of current?.packageRefs.tools ?? []) {
    rows.push({ key: `package:tool:${item.id}`, id: item.id, kind: 'tool', source: 'package', status: 'candidate', version: item.version, path: item.path })
  }
  const weight = (row: DependencyRow) => (row.status === 'missing' ? 0 : row.status === 'candidate' ? 1 : 2)
  return rows.sort((a, b) => weight(a) - weight(b))
})
const pendingPackageCount = computed(() => dependencyRows.value.filter(row => row.source === 'package').length)
const candidatePlan = computed(() => candidate.value?.plan ?? [])
const trialRuns = computed(() => candidate.value?.trialRuns ?? [])
const { currentPage: dependencyPage, pagedItems: pagedDependencyRows } =
  useListPagination(dependencyRows, { resetOn: agentId })
const { currentPage: planPage, pagedItems: pagedPlan } =
  useListPagination(candidatePlan, { resetOn: agentId })
const { currentPage: trialPage, pagedItems: pagedTrialRuns } =
  useListPagination(trialRuns, { resetOn: agentId })
const activeStep = computed<ReleaseStep>(() => routeStepByName[String(route.name)] ?? 'definition')
const trialActive = computed(() => Boolean(
  latestTrial.value && ['checking', 'queued', 'executing', 'asserting'].includes(latestTrial.value.status),
))
const candidateLocked = computed(() => candidate.value?.status === 'submitted')
const failedChecks = computed(() => candidate.value?.checks.filter(check => check.status === 'failed') ?? [])
const checksPassed = computed(() => Boolean(candidate.value?.checks.length) && !failedChecks.value.length)
const canStartTrial = computed(() => authStore.canManage
  && Boolean(candidate.value?.checks.length)
  && !failedChecks.value.length
  && !candidateLocked.value
  && !trialActive.value
  && !definitionChanged.value)
const canPublish = computed(() => latestTrial.value?.status === 'passed'
  && candidate.value?.sealedRevision === candidate.value?.revision
  && !definitionChanged.value)
/** 试运行通过且封存一致 → 可提交审核；提交后（submitted）才能确认发布。 */
const canSubmit = computed(() => canPublish.value
  && (candidate.value?.status === 'draft' || candidate.value?.status === 'changes_requested'))
const canFinalize = computed(() => canPublish.value && candidate.value?.status === 'submitted')
const workflowSteps = computed(() => {
  const current = candidate.value
  if (!current) return []
  const missingCount = current.missingDeps.skills.length + current.missingDeps.tools.length
  return [
    { key: 'definition' as const, index: 1, label: '定义与依赖', state: missingCount ? `${missingCount} 项待处理` : '已就绪', tone: missingCount ? 'blocked' : 'ready' },
    { key: 'checks' as const, index: 2, label: '检查与案例', state: !current.checks.length ? `${current.cases.length} 个案例` : checksPassed.value ? '已通过' : '有阻塞项', tone: !current.checks.length ? 'pending' : checksPassed.value ? 'ready' : 'blocked' },
    { key: 'trial' as const, index: 3, label: '试运行', state: latestTrial.value ? trialStatusLabel[latestTrial.value.status] : '未开始', tone: latestTrial.value?.status === 'passed' ? 'ready' : latestTrial.value?.status === 'failed' ? 'blocked' : 'pending' },
    { key: 'review' as const, index: 4, label: '审核发布', state: current.status === 'submitted' ? '待管理员确认发布' : canPublish.value ? '可提交审核' : '等待试运行', tone: canPublish.value ? 'active' : 'pending' },
  ] as const
})

const submissionLabel: Record<SubmissionStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  changes_requested: '已退回',
  published: '已发布',
  withdrawn: '已撤回',
}
const submissionTagType: Record<SubmissionStatus, 'info' | 'warning' | 'danger' | 'success'> = {
  draft: 'info',
  submitted: 'warning',
  changes_requested: 'danger',
  published: 'success',
  withdrawn: 'info',
}
const trialStatusLabel: Record<TrialRunStatus, string> = {
  checking: '检查中',
  queued: '排队中',
  executing: '执行中',
  asserting: '待逐项确认',
  passed: '试运行通过',
  failed: '已失败',
  cancelled: '已取消',
}
const caseKindLabel = { success: '正常任务', invalid_input: '无效输入', permission_denied: '越权请求' } as const
const checkIcon: Record<CheckStatus, string> = { passed: '✓', failed: '✕', pending: '·' }
const planActionLabel = { create: '新建', reuse: '复用', upgrade: '升级', blocked: '阻塞' } as const
const planActionName = (action: PlanAction) => planActionLabel[action]
watch([activeStep, candidate, checksPassed, canPublish, completedVersion], ([step, current, checksReady, reviewReady, completed]) => {
  if (!current || completed) return
  if (step === 'trial' && !checksReady) {
    void router.replace(stepPath('checks'))
  }
  if (step === 'review' && !reviewReady) {
    void router.replace(stepPath(checksReady ? 'trial' : 'checks'))
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
  if (step === 'definition' || step === 'checks') return true
  if (step === 'trial') return checksPassed.value
  return canPublish.value
}

function goToStep(step: ReleaseStep) {
  if (!canVisitStep(step)) return
  void router.push(stepPath(step))
}

function openEdit() {
  if (!agent.value) return
  editorOpen.value = true
}

function handleDraftSaved(saved: AgentDefinition, source: 'config' | 'zip') {
  if (source === 'config') {
    governance.noteDraftSaved(saved.id)
  }
  if (saved.id !== agentId.value) {
    void router.replace(stepPath('definition', saved.id))
  }
}

async function removeMissingDependency(kind: 'skills' | 'tools', reference: string) {
  if (!agent.value) return
  try {
    await governance.removeMissingDependency(agent.value.id, kind, reference)
    ElMessage.success(`已从候选定义移除依赖 ${reference}，请重新运行检查`)
  } catch (cause) {
    fail(cause)
  }
}

async function runCandidateChecks() {
  if (!agent.value) return
  try {
    await governance.runChecks(agent.value.id)
    ElMessage.success('检查完成')
  } catch (cause) {
    fail(cause)
  }
}

async function startTrial() {
  if (!agent.value) return
  try {
    await governance.startTrialRun(agent.value.id)
  } catch (cause) {
    fail(cause)
  }
}

/** 试运行待确认的案例集合（dsh 步骤携带的执行记录）。 */
function trialCaseRuns(trial: AgentTrialRun) {
  return trial.steps.flatMap(step => step.caseRuns ?? [])
}

function verdictKey(trialId: string, caseId: string) {
  return `${trialId}:${caseId}`
}

/** 全部案例都已选择判定后才允许提交逐项确认。 */
function verdictsComplete(trial: AgentTrialRun) {
  const runs = trialCaseRuns(trial)
  return runs.length > 0 && runs.every(run => Boolean(caseVerdicts.value[verdictKey(trial.id, run.caseId)]))
}

async function confirmTrial(trial: AgentTrialRun) {
  if (!verdictsComplete(trial)) return
  confirmingTrial.value = true
  try {
    await governance.confirmTrialRun(
      agentId.value,
      trial.id,
      trialCaseRuns(trial).map(run => ({
        caseId: run.caseId,
        verdict: caseVerdicts.value[verdictKey(trial.id, run.caseId)]!,
      })),
    )
    ElMessage.success('试运行结论已登记')
  } catch (cause) {
    fail(cause)
  } finally {
    confirmingTrial.value = false
  }
}

async function submitForReview() {
  if (!agent.value) return
  try {
    await ElMessageBox.confirm(
      '提交后候选定义、案例与试运行证据封存，审核期间不能修改；如需调整可退回或撤回。',
      '提交审核',
      { confirmButtonText: '提交审核', cancelButtonText: '取消', type: 'warning' },
    )
    await governance.submitCandidate(agent.value.id)
    ElMessage.success('已提交审核，候选内容已封存')
  } catch (cause) {
    fail(cause)
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
      '确认发布将把封存定义、精确依赖与绑定修订登记为不可变平台版本，并写入本次检查与试运行证据。',
      '审核并发布',
      { confirmButtonText: '确认发布', cancelButtonText: '取消', type: 'warning' },
    )
    await governance.reviewAndPublish(currentAgent.id, version, authStore.user.name, submitNote.value.trim())
    submitNote.value = ''
    publishedVersion.value = version
    ElMessage.success(`已发布 v${version}，证据已记录`)
  } catch (cause) {
    fail(cause)
  }
}

onMounted(async () => {
  await contentStore.load()
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
      <el-result icon="success" title="发布完成" :sub-title="`Agent v${completedVersion} 已发布为不可变版本，配置检查、试运行与业务确认证据已随版本记录。`">
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
      <nav aria-label="Agent 候选发布流程">
        <ol class="workflow-steps">
          <li
            v-for="step in workflowSteps"
            :key="step.index"
            :class="['workflow-step', `workflow-step--${step.tone}`, { 'is-current': activeStep === step.key }]"
          >
            <button
              type="button"
              :aria-current="activeStep === step.key ? 'step' : undefined"
              :disabled="!canVisitStep(step.key)"
              @click="goToStep(step.key)"
            >
              <span>{{ step.index }}</span>
              <div><strong>{{ step.label }}</strong><small>{{ step.state }}</small></div>
            </button>
          </li>
        </ol>
      </nav>

      <div class="stage-page">
        <div v-if="activeStep === 'definition'" class="stage-content">
          <section class="content-panel workbench-card definition-card">
            <div class="definition-card__headline">
              <div>
                <strong>{{ agent.name }}</strong>
                <p>{{ agent.description }}</p>
              </div>
              <div class="definition-card__state">
                <el-tag size="small" effect="plain">v{{ candidateVersion }}</el-tag>
                <el-tag size="small" effect="plain">rev {{ candidate.revision }}</el-tag>
                <el-tag size="small" :type="submissionTagType[candidate.status]">{{ submissionLabel[candidate.status] }}</el-tag>
                <el-tag size="small" type="info" effect="plain">{{ candidate.source === 'zip' ? 'ZIP 导入' : '配置创建' }}</el-tag>
                <el-button v-if="authStore.canManage" size="small" :disabled="candidateLocked" @click="openEdit">编辑定义</el-button>
              </div>
            </div>
            <p v-if="candidateLocked" class="hint">已提交审核，内容已封存；如需修改请先在「审核发布」步骤退回或撤回。</p>
            <div class="definition-meta">
              <span class="definition-meta__label">权限</span>
              <el-tag v-for="role in agent.roleIds" :key="`role:${role}`" size="small" type="info" effect="plain">角色 · {{ role }}</el-tag>
              <el-tag v-for="scope in candidateDataScopes" :key="`scope:${scope}`" size="small" type="info" effect="plain">数据 · {{ scope }}</el-tag>
              <small v-if="!agent.roleIds.length && !candidateDataScopes.length">未配置</small>
              <span class="definition-meta__divider" aria-hidden="true" />
              <span class="definition-meta__label">限制</span>
              <strong>{{ (draftVersion?.maxTokens ?? 0).toLocaleString() }} Token · {{ draftVersion?.timeoutSeconds ?? '—' }} 秒</strong>
            </div>
            <el-collapse class="definition-details">
              <el-collapse-item title="版本与变更详情" name="version-details">
                <dl class="meta-grid meta-grid--compact">
                  <div><dt>变更说明</dt><dd>{{ draftVersion?.summary }}</dd></div>
                  <div><dt>封存状态</dt><dd>{{ candidate.sealedRevision ? `已封存 rev ${candidate.sealedRevision}` : '未封存' }}</dd></div>
                  <div v-if="candidate.sealedAt"><dt>封存时间</dt><dd>{{ formatTimestamp(candidate.sealedAt) }}</dd></div>
                  <div v-if="candidate.reviewNote"><dt>审核意见</dt><dd>{{ candidate.reviewNote }}</dd></div>
                </dl>
              </el-collapse-item>
            </el-collapse>
          </section>

          <section class="content-panel workbench-card" :class="{ 'missing-deps-card': missingDependencyCount }">
            <div class="card-head">
              <div><span class="card-kicker">步骤 1</span><h2>依赖状态</h2></div>
              <div class="review-actions">
                <el-tag size="small" effect="plain">{{ dependencyRows.length }} 项能力</el-tag>
                <el-tag v-if="missingDependencyCount" size="small" type="danger">{{ missingDependencyCount }} 项缺失</el-tag>
                <el-tag v-if="pendingPackageCount" size="small" type="warning">{{ pendingPackageCount }} 项候选待准入</el-tag>
                <el-tag v-if="!missingDependencyCount && !pendingPackageCount" size="small" type="success">依赖已就绪</el-tag>
                <el-button v-if="candidate.missingDeps.skills.length" size="small" @click="router.push('/skills')">Skill 管理</el-button>
                <el-button v-if="candidate.missingDeps.tools.length" size="small" @click="router.push('/tools?view=candidates')">工具管理</el-button>
                <el-button v-if="missingDependencyCount" size="small" type="primary" :loading="governance.busy === 'checks'" :disabled="candidateLocked" @click="runCandidateChecks">重新解析</el-button>
              </div>
            </div>
            <el-alert v-if="missingDependencyCount" type="error" :closable="false" show-icon title="缺失依赖会阻止检查和试运行" description="补齐平台能力，或者移除 Agent 不再需要的引用。" />
            <el-table class="data-table dependency-table" :data="pagedDependencyRows" size="small">
              <el-table-column label="依赖" min-width="180">
                <template #default="scope">
                  <strong class="mono" :class="{ 'plan-blocked': scope.row.status === 'missing' }">{{ scope.row.id }}</strong>
                  <small class="cell-sub mono">{{ scope.row.version === '未解析' ? '未解析' : `v${scope.row.version}` }}{{ scope.row.path ? ` · ${scope.row.path}` : '' }}</small>
                </template>
              </el-table-column>
              <el-table-column label="类型" width="76"><template #default="scope"><el-tag size="small" effect="plain">{{ scope.row.kind === 'skill' ? 'Skill' : 'Tool' }}</el-tag></template></el-table-column>
              <el-table-column label="来源" width="104"><template #default="scope"><span class="muted">{{ dependencySourceText(scope.row.source) }}</span></template></el-table-column>
              <el-table-column label="状态" width="104">
                <template #default="scope"><el-tag size="small" :type="dependencyStatusMetaOf(scope.row.status).type">{{ dependencyStatusMetaOf(scope.row.status).label }}</el-tag></template>
              </el-table-column>
              <el-table-column label="操作" width="130" fixed="right">
                <template #default="scope">
                  <el-button v-if="scope.row.status === 'missing'" link type="danger" size="small" :disabled="candidateLocked" @click="removeMissingDependency(scope.row.kind === 'skill' ? 'skills' : 'tools', scope.row.id)">移除引用</el-button>
                  <span v-else-if="scope.row.source === 'package'" class="muted">待准入</span>
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
            </el-table>
            <el-pagination v-model:current-page="dependencyPage" class="list-pagination" background hide-on-single-page layout="prev, pager, next" :total="dependencyRows.length" :page-size="10" />
            <p class="hint">仅已解析引用进入封存；包内候选需先在 Skill / 工具管理中完成安装发布与准入后才可引用。</p>
            <div v-if="!missingDependencyCount && !pendingPackageCount" class="dependency-ready">
              <el-icon><CircleCheck /></el-icon>
              <span>所有声明依赖均已解析，无待处理项。</span>
            </div>
          </section>
          <footer class="stage-footer">
            <span>确认定义与依赖后，在下一页运行发布检查。</span>
            <el-button type="primary" @click="goToStep('checks')">下一步：检查与案例</el-button>
          </footer>
        </div>

        <template v-else-if="activeStep === 'checks'">
          <section class="content-panel workbench-card">
            <div class="card-head">
              <div><span class="card-kicker">步骤 2</span><h2>运行检查</h2></div>
              <el-button v-if="authStore.canManage" size="small" :loading="governance.busy === 'checks'" :disabled="candidateLocked" @click="runCandidateChecks">运行检查</el-button>
            </div>
            <p class="section-intro">候选随附 {{ candidate.cases.length }} 个试运行案例（覆盖成功、无效输入、权限拒绝三类），试运行断言阶段将逐条核对。</p>
            <el-empty v-if="!candidate.checks.length" description="尚未运行检查" :image-size="60" />
            <ul v-else class="check-list">
              <li v-for="check in candidate.checks" :key="check.id" :class="`check--${check.status}`">
                <span class="check-icon" aria-hidden="true">{{ checkIcon[check.status] }}</span>
                <div><strong>{{ check.label }}</strong><small>{{ check.detail }}</small></div>
              </li>
            </ul>
          </section>

          <section v-if="candidate.plan.length" class="content-panel workbench-card">
            <div class="card-head"><div><span class="card-kicker">步骤 2</span><h2>部署计划</h2></div></div>
            <el-table class="data-table" :data="pagedPlan" size="small">
              <el-table-column label="类型" width="76"><template #default="scope"><el-tag size="small" effect="plain">{{ scope.row.kind }}</el-tag></template></el-table-column>
              <el-table-column prop="name" label="对象" min-width="130"><template #default="scope"><strong :class="{ 'plan-blocked': scope.row.action === 'blocked' }">{{ scope.row.name }}</strong><small class="cell-sub mono">{{ scope.row.version }}</small></template></el-table-column>
              <el-table-column label="动作" width="76"><template #default="scope"><el-tag size="small" :type="scope.row.action === 'blocked' ? 'danger' : scope.row.action === 'reuse' ? 'info' : 'success'">{{ planActionName(scope.row.action) }}</el-tag></template></el-table-column>
              <el-table-column prop="detail" label="说明" min-width="180"><template #default="scope"><small class="plan-detail">{{ scope.row.detail }}</small></template></el-table-column>
            </el-table>
            <el-pagination v-model:current-page="planPage" class="list-pagination" background hide-on-single-page layout="prev, pager, next" :total="candidatePlan.length" :page-size="10" />
          </section>
          <footer class="stage-footer">
            <el-button @click="goToStep('definition')">上一步：定义与依赖</el-button>
            <div>
              <span v-if="!checksPassed">全部检查通过后才能进入试运行。</span>
              <el-button type="primary" :disabled="!checksPassed" @click="goToStep('trial')">下一步：试运行</el-button>
            </div>
          </footer>
        </template>

        <template v-else-if="activeStep === 'trial'">
          <section class="content-panel workbench-card">
            <div class="card-head">
              <div><span class="card-kicker">步骤 3</span><h2>试运行 <el-tag size="small" type="info" effect="plain">真实 DSH 执行</el-tag></h2></div>
              <el-button v-if="authStore.canManage" size="small" type="primary" :loading="governance.busy === 'trial'" :disabled="!canStartTrial" @click="startTrial">发起试运行</el-button>
            </div>
            <p v-if="failedChecks.length" class="hint">阻塞项：{{ failedChecks.map(check => check.label).join('、') }}，全部通过后才能发起试运行。</p>
            <p v-if="definitionChanged" class="hint">草稿已变更，候选正在同步——同步完成前不能发起试运行或发布。</p>
            <el-empty v-if="!candidate.trialRuns.length" description="封存候选后逐案例经 Run/Attempt → Runtime Adapter → DSH 真实执行，输出由审核人逐项确认" :image-size="60" />
            <div v-for="trial in pagedTrialRuns" :key="trial.id" class="trial">
              <div class="trial__head">
                <el-tag size="small" :type="trial.status === 'failed' ? 'danger' : trial.status === 'passed' ? 'success' : trial.status === 'cancelled' ? 'info' : 'warning'">{{ trialStatusLabel[trial.status] }}</el-tag>
                <el-tag v-if="trial.submissionRevision !== candidate.revision" size="small" type="info" effect="plain">旧修订</el-tag>
                <span class="trial__meta">封存 rev {{ trial.submissionRevision }} · {{ trial.id }}</span>
                <el-button v-if="['checking', 'queued', 'executing', 'asserting'].includes(trial.status)" size="small" text type="danger" @click="governance.cancelTrialRun(agentId, trial.id)">取消</el-button>
              </div>
              <ol class="trial-steps">
                <li v-for="step in trial.steps" :key="step.id" :class="`step--${step.status}`">
                  <el-icon v-if="step.status === 'running'"><Loading /></el-icon>
                  <el-icon v-else-if="step.status === 'passed'"><CircleCheck /></el-icon>
                  <el-icon v-else-if="step.status === 'failed'"><CircleClose /></el-icon>
                  <span v-else class="step-dot" aria-hidden="true" />
                  <div><span>{{ step.label }}</span><small v-if="step.detail">{{ step.detail }}</small></div>
                </li>
              </ol>
              <div v-if="trialCaseRuns(trial).length" class="case-runs">
                <div v-for="run in trialCaseRuns(trial)" :key="run.caseId" class="case-run">
                  <div class="case-run__head">
                    <strong>{{ run.name }}</strong>
                    <el-tag size="small" effect="plain">{{ caseKindLabel[run.kind] }}</el-tag>
                    <el-tag size="small" :type="run.status === 'succeeded' ? 'success' : run.status === 'cancelled' ? 'info' : 'danger'" effect="plain">{{ run.status }}</el-tag>
                    <el-tag v-if="run.verdict" size="small" :type="run.verdict === 'passed' ? 'success' : 'danger'">{{ run.verdict === 'passed' ? '已确认符合预期' : '判定不符合预期' }}</el-tag>
                    <span v-if="run.runId" class="case-run__meta mono">{{ run.runId }}</span>
                  </div>
                  <dl class="case-run__io">
                    <div><dt>预期</dt><dd>{{ run.expect }}</dd></div>
                    <div><dt>实际输出</dt><dd>{{ run.outputExcerpt || run.error || '（无输出）' }}</dd></div>
                  </dl>
                  <div v-if="trial.status === 'asserting' && authStore.canManage" class="case-run__verdict">
                    <el-radio-group v-model="caseVerdicts[verdictKey(trial.id, run.caseId)]" size="small">
                      <el-radio-button value="passed">符合预期</el-radio-button>
                      <el-radio-button value="failed">不符合预期</el-radio-button>
                    </el-radio-group>
                  </div>
                </div>
                <div v-if="trial.status === 'asserting' && authStore.canManage" class="case-runs__footer">
                  <el-button type="primary" size="small" :loading="confirmingTrial" :disabled="!verdictsComplete(trial)" @click="confirmTrial(trial)">提交逐项确认</el-button>
                  <span class="hint">全部案例确认通过后试运行才记为通过，方可发布。</span>
                </div>
              </div>
            </div>
            <el-pagination v-model:current-page="trialPage" class="list-pagination" background hide-on-single-page layout="prev, pager, next" :total="trialRuns.length" :page-size="10" />
          </section>
          <footer class="stage-footer">
            <el-button @click="goToStep('checks')">上一步：检查与案例</el-button>
            <div>
              <span v-if="!canPublish">试运行通过后才能进入审核发布。</span>
              <el-button type="primary" :disabled="!canPublish" @click="goToStep('review')">下一步：审核发布</el-button>
            </div>
          </footer>
        </template>

        <template v-else>
          <section class="content-panel workbench-card review-summary">
            <div class="card-head"><div><span class="card-kicker">步骤 4</span><h2>发布确认摘要</h2></div></div>
            <dl class="meta-grid">
              <div><dt>候选修订</dt><dd class="mono">rev {{ candidate.revision }}</dd></div>
              <div><dt>目标版本</dt><dd class="mono">v{{ candidateVersion }}</dd></div>
              <div><dt>封存修订</dt><dd class="mono">rev {{ candidate.sealedRevision ?? '—' }}</dd></div>
              <div><dt>试运行</dt><dd>{{ latestTrial ? trialStatusLabel[latestTrial.status] : '未运行' }}</dd></div>
              <div><dt>案例数量</dt><dd>{{ candidate.cases.length }} 个</dd></div>
              <div><dt>运行编号</dt><dd class="mono">{{ latestTrial?.id ?? '—' }}</dd></div>
            </dl>
          </section>

          <section v-if="authStore.canManage" class="content-panel workbench-card submit-card">
            <div class="card-head"><div><span class="card-kicker">步骤 4</span><h2>审核并发布</h2></div></div>
            <template v-if="candidate.status === 'submitted'">
              <p class="side-note">候选已提交审核并封存。确认发布将登记为不可变平台版本并写入证据；如需调整可退回修改或撤回候选。</p>
              <el-input v-model="submitNote" type="textarea" :rows="3" placeholder="审核意见（业务效果确认、注意事项）" />
              <div class="submit-actions">
                <el-button type="primary" :loading="governance.busy === 'submit'" :disabled="!canFinalize" data-action="publish-agent" @click="reviewAndPublish">审核并发布</el-button>
                <el-button :loading="governance.busy === 'submit'" @click="requestChanges">退回修改</el-button>
                <el-button text type="danger" :loading="governance.busy === 'submit'" @click="withdrawCandidate">撤回候选</el-button>
              </div>
              <small v-if="!canFinalize" class="submit-hint">封存修订与当前修订不一致时不能发布，请先退回修改并重新试运行。</small>
            </template>
            <template v-else>
              <p class="side-note">试运行通过且封存一致后提交审核；审核期间候选内容封存，确认发布需在提交后进行。</p>
              <div class="submit-actions">
                <el-button type="primary" :loading="governance.busy === 'submit'" :disabled="!canSubmit" data-action="submit-agent-release" @click="submitForReview">提交审核</el-button>
                <el-button text type="danger" :loading="governance.busy === 'submit'" @click="withdrawCandidate">撤回候选</el-button>
              </div>
              <small v-if="!canSubmit" class="submit-hint">需要一次通过的封存试运行，且封存修订与当前修订一致。</small>
            </template>
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
.workflow-steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.workflow-step { min-width: 0; }
.workflow-step > button { display: grid; width: 100%; grid-template-columns: 22px minmax(0, 1fr); align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-button); color: inherit; background: var(--color-bg-base); cursor: pointer; font: inherit; text-align: left; }
.workflow-step > button:hover:not(:disabled), .workflow-step > button:focus-visible { border-color: var(--color-primary); outline: none; }
.workflow-step > button:disabled { cursor: not-allowed; opacity: .62; }
.workflow-step.is-current > button { border-color: var(--color-primary); box-shadow: inset 0 0 0 1px var(--color-primary); }
.workflow-step > button > span { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 50%; color: var(--color-text-muted); background: var(--color-bg-subtle); font-size: var(--font-size-micro); font-weight: var(--font-weight-title); }
.workflow-step button div { display: flex; min-width: 0; align-items: baseline; gap: 7px; }
.workflow-step strong { color: var(--color-text-heading); font-size: var(--font-size-badge); white-space: nowrap; }
.workflow-step small { overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-micro); text-overflow: ellipsis; white-space: nowrap; }
.workflow-step--ready > button { border-color: var(--color-success); background: var(--color-success-light); }
.workflow-step--ready > button > span { color: var(--color-success-strong); background: var(--color-bg-base); }
.workflow-step--blocked > button { border-color: var(--color-danger); background: var(--color-danger-light); }
.workflow-step--blocked > button > span { color: var(--color-danger-strong); background: var(--color-bg-base); }
.workflow-step--active > button { border-color: var(--color-primary); background: var(--color-primary-light); }
.workflow-step--active > button > span { color: var(--color-primary); background: var(--color-bg-base); }
.stage-page { width: 100%; }
.stage-content { min-width: 0; }
.stage-footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 6px; padding: 16px 18px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-base); }
.stage-footer > span, .stage-footer > div > span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.stage-footer > div { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
.workbench-card { margin-bottom: 14px; padding: 18px; }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.card-head h2 { margin: 2px 0 0; color: var(--color-text-heading); font-size: var(--font-size-body); }
.card-kicker { color: var(--color-primary); font-size: var(--font-size-micro); font-weight: var(--font-weight-title); }
.definition-card__headline { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--color-border); }
.definition-card__headline > div:first-child { min-width: 0; }
.definition-card__headline strong { color: var(--color-text-heading); font-size: var(--font-size-title); }
.definition-card__headline p { max-width: 920px; margin: 4px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.55; }
.definition-card__state { display: flex; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.definition-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 12px; font-size: var(--font-size-badge); }
.definition-meta__label { color: var(--color-text-muted); }
.definition-meta__divider { width: 1px; height: 14px; margin: 0 4px; background: var(--color-border); }
.definition-meta strong { color: var(--color-text-primary); font-weight: var(--font-weight-title); }
.definition-details { margin-top: 10px; }
.definition-details :deep(.el-collapse-item__header) { min-height: 36px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.definition-details :deep(.el-collapse-item__content) { padding-bottom: 8px; }
.meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; margin: 0; }
.meta-grid--compact > div { padding: 7px 0; }
.meta-grid > div { padding: 9px 0; border-bottom: 1px solid var(--color-border); }
.meta-grid__wide { grid-column: 1 / -1; }
.meta-grid dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.meta-grid dd { margin: 3px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); overflow-wrap: anywhere; }
.cell-sub { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.muted, .hint, .submit-hint, .side-note { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.hint { margin: 7px 0 0; }
.side-note { margin: 0; line-height: 1.55; }
.mono { font-family: monospace; }
.missing-deps-card { border-color: var(--color-danger); }
.dependency-table { margin-top: 10px; }
.section-intro { margin: 3px 0 10px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.dependency-ready { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--radius-button); color: var(--color-success-strong); background: var(--color-success-light); font-size: var(--font-size-badge); }
.dependency-ready .el-icon { font-size: var(--font-size-body); }
.review-actions, .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.form-actions { margin-top: 12px; }
.check-list { display: flex; flex-direction: column; gap: 9px; margin: 0; padding: 0; list-style: none; }
.check-list li { display: flex; gap: 9px; align-items: flex-start; }
.check-icon { display: grid; width: 20px; height: 20px; flex: 0 0 auto; place-items: center; border-radius: 50%; font-size: 12px; font-weight: 700; }
.check--passed .check-icon { color: var(--color-bg-base); background: var(--color-success); }
.check--failed .check-icon { color: var(--color-bg-base); background: var(--color-danger); }
.check--pending .check-icon { color: var(--color-text-muted); background: var(--color-bg-subtle); }
.check-list strong { display: block; color: var(--color-text-primary); font-size: var(--font-size-caption); }
.check-list small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.plan-blocked { color: var(--color-danger-strong); }
.plan-detail { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.trial { padding-top: 6px; }
.trial__head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.trial__meta { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.trial-steps { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; color: var(--color-text-muted); font-size: var(--font-size-caption); }
.trial-steps li { display: flex; gap: 9px; align-items: flex-start; }
.trial-steps li.step--passed { color: var(--color-text-primary); }
.trial-steps li.step--failed { color: var(--color-danger-strong); }
.trial-steps .el-icon { margin-top: 2px; }
.step--passed .el-icon { color: var(--color-success); }
.step--failed .el-icon { color: var(--color-danger); }
.step-dot { display: inline-block; width: 8px; height: 8px; margin: 5px 4px 0; border-radius: 50%; background: var(--color-border); }
.trial-steps small { display: block; margin-top: 2px; color: var(--color-danger-strong); }
.case-runs { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--color-border); }
.case-run { padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-subtle); }
.case-run__head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.case-run__head strong { color: var(--color-text-heading); font-size: var(--font-size-badge); }
.case-run__meta { color: var(--color-text-muted); font-size: var(--font-size-micro); }
.case-run__io { display: grid; gap: 6px; margin: 8px 0 0; }
.case-run__io > div { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
.case-run__io dt { color: var(--color-text-muted); font-size: var(--font-size-micro); }
.case-run__io dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-badge); overflow-wrap: anywhere; white-space: pre-wrap; }
.case-run__verdict { margin-top: 8px; }
.case-runs__footer { display: flex; align-items: center; gap: 12px; }
.submit-card { display: flex; flex-direction: column; gap: 10px; }
.submit-card .card-head { margin-bottom: 0; }
.submit-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
@media (max-width: 900px) { .workflow-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .workflow-steps, .meta-grid { grid-template-columns: 1fr; } .meta-grid__wide { grid-column: auto; } .workflow-step button div { justify-content: space-between; } .definition-card__headline { flex-direction: column; } .definition-card__state { justify-content: flex-start; } }
</style>
