<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'

import AgentDraftDialog from '@/components/AgentDraftDialog.vue'
import {
  useAgentGovernanceStore,
  type TrialRunStatus,
} from '@/stores/agentGovernance'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentEvalCase, AgentTrialRun } from '@/types/domain'
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
/** 逐项确认选择：key = `${trialId}:${caseId}` → 审核人对该案例输出的判定。 */
const caseVerdicts = ref<Record<string, 'passed' | 'failed'>>({})
const confirmingTrial = ref(false)
const editableCases = ref<AgentEvalCase[]>([])
const activeCaseId = ref('')

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
const currentTrial = computed(() => latestTrial.value?.submissionRevision === candidate.value?.revision
  ? latestTrial.value : undefined)
const currentCaseRuns = computed(() => currentTrial.value ? trialCaseRuns(currentTrial.value) : [])
const activeCase = computed(() => editableCases.value.find(item => item.id === activeCaseId.value))
const activeCaseIndex = computed(() => editableCases.value.findIndex(item => item.id === activeCaseId.value))
const activeCaseRun = computed(() => currentCaseRuns.value.find(item => item.caseId === activeCaseId.value))
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
const candidateLocked = computed(() => candidate.value?.status === 'submitted')
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
const casesChanged = computed(() => JSON.stringify(editableCases.value) !== JSON.stringify(candidate.value?.cases ?? []))
const casesValid = computed(() => ['success', 'invalid_input', 'permission_denied', 'prompt_injection', 'capability_failure'].every(
  kind => editableCases.value.some(item => item.kind === kind),
)
  && editableCases.value.length >= 5
  && editableCases.value.every(item => item.evaluationApiVersion === 'dsh-work.ai/evaluation/v1'
    && item.input.trim() && item.manualReview.rubric.trim()
    && item.automatedAssertions.length === 3
    && ['run_attempt_recorded', 'execution_succeeded', 'output_non_empty'].every(assertion =>
      item.automatedAssertions.includes(assertion as AgentEvalCase['automatedAssertions'][number]))))
const canEditActiveCase = computed(() => authStore.canManage
  && !candidateLocked.value && !definitionChanged.value && !trialExecuting.value
  && activeCaseIndex.value === nextRunnableCaseIndex.value)
const canRunActiveCase = computed(() => authStore.canManage
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
  && !definitionChanged.value)
const canFinalize = computed(() => canPublish.value
  && ['draft', 'changes_requested', 'submitted'].includes(candidate.value?.status ?? ''))
function syncEditableCases(cases: AgentEvalCase[]) {
  editableCases.value = cases.map(item => ({
    ...item,
    automatedAssertions: [...(item.automatedAssertions ?? [])],
    manualReview: { required: true, rubric: item.manualReview?.rubric ?? '' },
  }))
}
watch(() => `${candidate.value?.id ?? ''}:${candidate.value?.revision ?? ''}`, () => {
  syncEditableCases(candidate.value?.cases ?? [])
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
  if (currentTrial.value?.status === 'failed' && index === currentCaseRuns.value.length) {
    return { label: '失败', tone: 'danger' as const }
  }
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
  }
}

function verdictKey(trialId: string, caseId: string) {
  return `${trialId}:${caseId}`
}

async function confirmCase(trial: AgentTrialRun) {
  const run = activeCaseRun.value
  if (!run || run.verdict || !hasV1CaseEvidence(run)) return
  const verdict = caseVerdicts.value[verdictKey(trial.id, run.caseId)]
  if (!verdict) return
  confirmingTrial.value = true
  try {
    await governance.confirmTrialRun(agentId.value, trial.id, [{ caseId: run.caseId, verdict }])
    if (verdict === 'passed') {
      activeCaseId.value = editableCases.value[activeCaseIndex.value + 1]?.id ?? run.caseId
      ElMessage.success('本项已通过，可以继续验证下一项')
    } else {
      ElMessage.warning('本项未通过，本轮验证已结束；调整后需重新开始')
    }
  } catch (cause) {
    fail(cause)
  } finally {
    confirmingTrial.value = false
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
      <div class="stage-page">
        <template v-if="activeStep === 'trial'">
          <section class="content-panel workbench-card">
            <div class="card-head">
              <div class="card-head__title"><h2>验证案例</h2><span>{{ agent.name }}</span></div>
              <div class="case-card-actions">
                <el-button v-if="authStore.canManage" size="small" :disabled="candidateLocked" @click="openEdit">编辑配置</el-button>
                <el-button v-if="authStore.canManage && currentTrial && ['checking', 'queued', 'executing', 'asserting'].includes(currentTrial.status)" size="small" text type="danger" @click="governance.cancelTrialRun(agentId, currentTrial.id)">取消本轮验证</el-button>
              </div>
            </div>
            <p v-if="candidateLocked" class="hint">已提交候选内容已封存；修改前请先退回或撤回。</p>
            <p v-if="!currentTrial" class="section-intro">逐项运行并确认结果，通过后继续下一项。</p>
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
                  <p v-if="index !== nextRunnableCaseIndex && !currentCaseRuns.some(run => run.caseId === testCase.id)" class="hint">请先完成前一项验证；此页可预览，轮到本项时再填写。</p>
                  <el-form-item label="测试输入">
                    <el-input v-model="testCase.input" type="textarea" :rows="2" :maxlength="4000" :disabled="activeCaseId !== testCase.id || !canEditActiveCase" :aria-label="`${testCase.name}测试输入`" />
                  </el-form-item>
                  <el-form-item label="人工判定标准">
                    <el-input v-model="testCase.manualReview.rubric" type="textarea" :rows="2" :maxlength="2000" :disabled="activeCaseId !== testCase.id || !canEditActiveCase" :aria-label="`${testCase.name}人工判定标准`" />
                  </el-form-item>

                  <div v-if="activeCaseRun && currentTrial" class="case-run case-run--current">
                    <div class="case-run__head">
                      <strong>{{ activeCaseRun.status === 'succeeded' ? '实际输出' : '执行详情' }}</strong>
                      <el-tag v-if="activeCaseRun.verdict" size="small" :type="activeCaseRun.verdict === 'passed' ? 'success' : 'danger'">{{ activeCaseRun.verdict === 'passed' ? '已确认符合预期' : '判定不符合预期' }}</el-tag>
                    </div>
                    <el-alert v-if="!hasV1CaseEvidence(activeCaseRun)" type="warning" :closable="false" show-icon title="旧版评测证据不可用于发布" description="请撤回并重建候选后重新运行五类案例。" />
                    <div v-if="activeCaseRun.status === 'succeeded'" class="case-run__output" role="region" :aria-label="`${testCase.name}的实际输出`" tabindex="0">{{ activeCaseRun.outputExcerpt || '（无输出）' }}</div>
                    <details class="case-run__details">
                      <summary>查看运行与自动检查</summary>
                      <dl class="case-run__io">
                        <div><dt>自动检查</dt><dd>{{ automatedAssertionSummary(activeCaseRun) || '旧版证据不可用' }}</dd></div>
                        <div v-if="activeCaseRun.runId"><dt>Run</dt><dd class="mono">{{ activeCaseRun.runId }}</dd></div>
                        <div v-if="activeCaseRun.attemptId"><dt>Attempt</dt><dd class="mono">{{ activeCaseRun.attemptId }}</dd></div>
                        <div v-if="activeCaseRun.status !== 'succeeded' && (activeCaseRun.outputExcerpt || activeCaseRun.error)"><dt>执行返回</dt><dd>{{ activeCaseRun.outputExcerpt || activeCaseRun.error }}</dd></div>
                      </dl>
                    </details>
                    <div v-if="currentTrial.status === 'asserting' && !activeCaseRun.verdict && authStore.canManage && hasV1CaseEvidence(activeCaseRun)" class="case-run__verdict">
                      <el-radio-group v-model="caseVerdicts[verdictKey(currentTrial.id, testCase.id)]" size="small" :aria-label="`${testCase.name}人工结论`">
                        <el-radio-button value="passed">符合预期</el-radio-button>
                        <el-radio-button value="failed">不符合预期</el-radio-button>
                      </el-radio-group>
                      <el-button type="primary" size="small" :loading="confirmingTrial" :disabled="!caseVerdicts[verdictKey(currentTrial.id, testCase.id)]" @click="confirmCase(currentTrial)">确认本项结论</el-button>
                    </div>
                  </div>
                  <div v-if="authStore.canManage" class="case-actions">
                    <el-button v-if="index === nextRunnableCaseIndex" type="primary" :loading="governance.busy === 'trial'" :disabled="!canRunActiveCase" @click="runActiveCase">{{ currentTrial && ['failed', 'cancelled'].includes(currentTrial.status) ? '重新运行第一项' : '运行本项' }}</el-button>
                    <el-button v-if="index !== 0 && (currentTrial?.status === 'failed' || currentTrial?.status === 'cancelled')" @click="activeCaseId = editableCases[0]?.id ?? ''">返回第一项重新验证</el-button>
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
            <div class="card-head"><h2>确认发布</h2></div>
            <p class="side-note">核对候选版本与试运行证据后，一次确认即审核通过并发布不可变平台版本。发布时会重新检查修订、依赖和绑定。</p>
            <el-input v-model="submitNote" type="textarea" :rows="3" placeholder="审核意见（业务效果确认、注意事项）" />
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
.case-run--current { margin-top: 16px; }
.case-run__verdict { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
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
@media (max-width: 620px) { .meta-grid { grid-template-columns: 1fr; } .meta-grid__wide { grid-column: auto; } }
</style>
