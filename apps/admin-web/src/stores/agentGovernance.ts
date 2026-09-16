import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { adminApi } from '../api/client'
import type {
  AgentCapabilityRef,
  AgentCheckItem,
  AgentCheckStatus,
  AgentDefinition,
  AgentEvalCase,
  AgentPackageInspection,
  AgentPlanItem,
  AgentReleaseCandidate,
  AgentReleaseState,
  AgentSubmissionStatus,
  AgentSubmissionSummary,
  AgentTrialRun,
  AgentTrialStep,
  AgentTrialStepStatus,
  AgentVersionEvidence,
} from '../types/domain'
import { useContentStore } from './content'

/**
 * Agent 发布治理 store：候选修订、检查、试运行与证据全部由服务端
 * agent-release 接口族持久化，本 store 只做加载、合并与视图兼容映射。
 */

export type SubmissionStatus = AgentSubmissionStatus
export type EvidenceKind = AgentVersionEvidence['kind']
export type EvidenceRef = AgentVersionEvidence
export type CheckStatus = AgentCheckStatus
export type CheckItem = AgentCheckItem
export type PlanAction = AgentPlanItem['action']
export type DeploymentPlanItem = AgentPlanItem
export type TrialStepStatus = AgentTrialStepStatus
export type TrialRunStep = AgentTrialStep
export type TrialRunStatus = AgentTrialRun['status']
export type TrialRun = AgentTrialRun
export type CapabilityRef = AgentCapabilityRef
export type EvalCase = AgentEvalCase
export type ZipInspection = AgentPackageInspection

export interface AgentCandidate extends AgentReleaseCandidate {
  /** 试运行列表并入候选，保持视图原有 candidate.trialRuns 访问方式。 */
  trialRuns: AgentTrialRun[]
}

export interface VersionGovernance {
  bindingRevision: string
  evidence: EvidenceRef[]
  revoked: boolean
  published?: boolean
}

export interface AgentOverlay {
  candidate?: AgentCandidate
  /** key = 版本号字符串，如 '1.2.0'。 */
  versions: Record<string, VersionGovernance>
}

export const useAgentGovernanceStore = defineStore('agent-governance', () => {
  const contentStore = useContentStore()
  /** 已加载的发布状态（含候选、试运行、版本证据），key = agentId。 */
  const states = ref<Record<string, AgentReleaseState>>({})
  /** 进行中提交的索引（管理页徽标），key = agentId。 */
  const submissions = ref<Record<string, AgentSubmissionSummary>>({})
  /** 全量版本证据索引：agentId → version → evidence。 */
  const evidenceIndex = ref<Record<string, Record<string, EvidenceRef[]>>>({})
  const busy = ref('')
  const inFlight = new Map<string, Promise<AgentReleaseState>>()

  function isVersionPublished(agentId: string, version: string) {
    return contentStore.agentVersions.some(
      item => item.agentId === agentId && item.version === version && item.status === 'published',
    )
  }

  function stubCandidate(summary: AgentSubmissionSummary): AgentCandidate {
    return {
      id: '',
      agentId: summary.agentId,
      agentVersionId: '',
      version: '',
      revision: summary.revision,
      status: summary.status,
      source: summary.source,
      cases: [],
      packageRefs: { skills: [], tools: [] },
      missingDeps: { skills: [], tools: [] },
      checks: [],
      plan: [],
      trialRuns: [],
    }
  }

  /**
   * 视图兼容层：候选（含试运行）与版本证据映射回 overlay 形态。
   * 详情以 states 为准；submission 索引只提供未加载详情前的占位徽标数据。
   */
  const overlays = computed<Record<string, AgentOverlay>>(() => {
    const result: Record<string, AgentOverlay> = {}
    const ensure = (agentId: string) => (result[agentId] ??= { versions: {} })
    for (const summary of Object.values(submissions.value)) {
      ensure(summary.agentId).candidate ??= stubCandidate(summary)
    }
    for (const [agentId, byVersion] of Object.entries(evidenceIndex.value)) {
      const overlay = ensure(agentId)
      for (const [version, evidence] of Object.entries(byVersion)) {
        overlay.versions[version] ??= {
          bindingRevision: '—',
          evidence,
          revoked: false,
          published: isVersionPublished(agentId, version),
        }
      }
    }
    for (const [agentId, state] of Object.entries(states.value)) {
      const overlay = ensure(agentId)
      if (state.candidate) overlay.candidate = { ...state.candidate, trialRuns: state.trialRuns }
      for (const [version, evidence] of Object.entries(state.evidence)) {
        overlay.versions[version] = {
          bindingRevision: '—',
          evidence,
          revoked: false,
          published: isVersionPublished(agentId, version),
        }
      }
    }
    return result
  })

  async function loadSubmissionIndex() {
    const { items } = await adminApi.getAgentReleaseSubmissions()
    submissions.value = Object.fromEntries(items.map(item => [item.agentId, item]))
  }

  async function loadEvidenceIndex() {
    const { items } = await adminApi.getAgentVersionEvidence()
    const index: Record<string, Record<string, EvidenceRef[]>> = {}
    for (const entry of items) {
      ;(index[entry.agentId] ??= {})[entry.version] = entry.evidence
    }
    evidenceIndex.value = index
  }

  function loadReleaseState(agentId: string): Promise<AgentReleaseState> {
    const pending = inFlight.get(agentId)
    if (pending) return pending
    const request = adminApi.getAgentReleaseState(agentId)
      .then((state) => {
        states.value = { ...states.value, [agentId]: state }
        return state
      })
      .finally(() => inFlight.delete(agentId))
    inFlight.set(agentId, request)
    return request
  }

  function mergeState(agentId: string, state: AgentReleaseState) {
    states.value = { ...states.value, [agentId]: state }
    if (state.candidate) {
      const { candidate } = state
      submissions.value = {
        ...submissions.value,
        [agentId]: { agentId, revision: candidate.revision, status: candidate.status, source: candidate.source },
      }
    }
  }

  /**
   * 建立/同步进行中候选（POST）：草稿存在时确保有活跃 submission，
   * 指纹漂移时推进修订并作废检查/封存。GET 为只读，不写库。
   */
  async function ensureCandidate(agentId: string): Promise<AgentReleaseState> {
    const state = await adminApi.ensureAgentReleaseCandidate(agentId)
    mergeState(agentId, state)
    return state
  }

  /** 兼容旧调用：确保该 Agent 的发布状态已发起加载。 */
  function ensureOverlay(agentId: string): AgentOverlay {
    if (!states.value[agentId]) void loadReleaseState(agentId).catch(() => undefined)
    return overlays.value[agentId] ?? { versions: {} }
  }

  /**
   * 有候选详情则返回；有草稿/提交但未加载详情时触发加载并返回占位（加载完成后 overlays 重算）。
   * 无草稿且无提交时返回 undefined。
   */
  function candidateFor(agentId: string, draftVersion?: string): AgentCandidate | undefined {
    const overlay = overlays.value[agentId]
    if (overlay?.candidate?.id) return overlay.candidate
    const expected = Boolean(draftVersion) || Boolean(submissions.value[agentId])
    if (!expected) return undefined
    if (!states.value[agentId]) void loadReleaseState(agentId).catch(() => undefined)
    return overlay?.candidate
  }

  function versionGovernance(agentId: string, version: string): VersionGovernance {
    return overlays.value[agentId]?.versions[version] ?? {
      bindingRevision: '—',
      evidence: [],
      revoked: false,
      published: isVersionPublished(agentId, version),
    }
  }

  /**
   * 草稿已保存：走 mutation 端点同步候选——服务端按定义指纹推进修订并作废既有
   * 检查/封存/试运行结论，合并返回的新状态后旧 checks、sealedRevision 与
   * 可发布状态立即失效（GET 只读，不会推进修订）。
   */
  async function noteDraftSaved(agentId: string) {
    try {
      await ensureCandidate(agentId)
    } catch {
      await loadReleaseState(agentId).catch(() => undefined)
    }
  }

  /** 只读发布状态（含 definitionChanged 漂移标记），供视图做禁行保护。 */
  function releaseStateFor(agentId: string): AgentReleaseState | undefined {
    return states.value[agentId]
  }

  /* ---------- 检查、试运行、发布 ---------- */

  async function runChecks(agentId: string): Promise<CheckItem[]> {
    busy.value = 'checks'
    try {
      const state = await adminApi.runAgentReleaseChecks(agentId)
      mergeState(agentId, state)
      return state.candidate?.checks ?? []
    } finally {
      busy.value = ''
    }
  }

  /** 案例更新仍保留接口（当前界面不开放编辑，供后续恢复或测试使用）。 */
  async function updateCases(agentId: string, cases: EvalCase[]) {
    const state = await adminApi.updateAgentReleaseCases(agentId, cases)
    mergeState(agentId, state)
  }

  async function removeMissingDependency(agentId: string, kind: 'skills' | 'tools', reference: string) {
    const state = await adminApi.removeAgentReleaseDependency(agentId, { kind, reference })
    mergeState(agentId, state)
  }

  async function startTrialRun(agentId: string): Promise<string | undefined> {
    busy.value = 'trial'
    try {
      const state = await adminApi.startAgentReleaseTrial(agentId)
      mergeState(agentId, state)
      return state.trialRuns[0]?.id
    } finally {
      busy.value = ''
    }
  }

  async function cancelTrialRun(agentId: string, trialId: string) {
    const state = await adminApi.cancelAgentReleaseTrial(agentId, trialId)
    mergeState(agentId, state)
  }

  /** 逐项确认试运行案例结论：全部通过才记为 passed，服务端合并返回最新状态。 */
  async function confirmTrialRun(agentId: string, trialId: string, verdicts: Array<{ caseId: string; verdict: 'passed' | 'failed'; note?: string }>) {
    const state = await adminApi.confirmAgentReleaseTrial(agentId, trialId, verdicts)
    mergeState(agentId, state)
  }

  /** 提交审核：要求当前修订已有逐项确认通过的封存试运行；提交后内容封存。 */
  async function submitCandidate(agentId: string) {
    busy.value = 'submit'
    try {
      const state = await adminApi.submitAgentRelease(agentId)
      mergeState(agentId, state)
      await loadSubmissionIndex()
    } finally {
      busy.value = ''
    }
  }

  /** 退回修改：仅 submitted 可退回，必须登记审核意见。 */
  async function requestCandidateChanges(agentId: string, note: string) {
    busy.value = 'submit'
    try {
      const state = await adminApi.requestAgentReleaseChanges(agentId, note)
      mergeState(agentId, state)
      await loadSubmissionIndex()
    } finally {
      busy.value = ''
    }
  }

  /** 撤回候选：进行中提交转 withdrawn 终态，历史保留；再次同步会创建新候选。 */
  async function withdrawCandidate(agentId: string) {
    busy.value = 'submit'
    try {
      const state = await adminApi.withdrawAgentRelease(agentId)
      mergeState(agentId, state)
      await loadSubmissionIndex()
    } finally {
      busy.value = ''
    }
  }

  /**
   * 审核并发布：服务端校验「候选已提交审核 + 最新通过试运行与封存修订一致」，
   * 通过 publishDraft 既有门禁完成发布并写入版本证据。
   */
  async function reviewAndPublish(agentId: string, _version: string, _publishedBy: string, note: string) {
    busy.value = 'submit'
    try {
      const state = await adminApi.publishAgentRelease(agentId, note)
      mergeState(agentId, state)
      await Promise.all([loadSubmissionIndex(), contentStore.load(true)])
    } finally {
      busy.value = ''
    }
  }

  /* ---------- ZIP 导入 ---------- */

  function inspectPackage(file: File): Promise<ZipInspection> {
    return adminApi.inspectAgentPackage(file)
  }

  /** 上传并导入发布包：服务端解析、落草稿/候选、登记包资产。返回导入后的 Agent。 */
  async function importPackage(file: File): Promise<{ agent: AgentDefinition }> {
    busy.value = 'import'
    try {
      const state = await adminApi.importAgentPackage(file)
      const agentId = state.candidate?.agentId
      if (agentId) mergeState(agentId, state)
      await Promise.all([loadSubmissionIndex(), contentStore.load(true)])
      const agent = contentStore.agents.find(item => item.id === agentId)
      if (!agent) throw new Error('导入完成但未能读取 Agent 记录，请刷新列表')
      return { agent }
    } finally {
      busy.value = ''
    }
  }

  return {
    overlays,
    submissions,
    busy,
    loadSubmissionIndex,
    loadEvidenceIndex,
    loadReleaseState,
    ensureCandidate,
    ensureOverlay,
    candidateFor,
    versionGovernance,
    noteDraftSaved,
    releaseStateFor,
    confirmTrialRun,
    submitCandidate,
    requestCandidateChanges,
    withdrawCandidate,
    runChecks,
    updateCases,
    removeMissingDependency,
    startTrialRun,
    cancelTrialRun,
    reviewAndPublish,
    inspectPackage,
    importPackage,
  }
})
