import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { authorizationDenied } from '../authorization/authorization-errors.ts'
import type { RunOrchestrationService } from '../run/run-orchestration-service.ts'
import type { PostgresSkillService } from '../skill/postgres-skill-service.ts'
import type { PostgresToolConnectorService } from '../tool/postgres-tool-connector-service.ts'
import { parseAgentPackage, type AgentPackageCapabilityRef, type AgentPackageCase } from './agent-package.ts'
import { configurationFingerprint, type PostgresAgentService } from './postgres-agent-service.ts'

const tenantId = 'tenant-dsh-work'

/**
 * Agent 发布治理服务：把前端原型 overlay（候选修订、检查、试运行、证据）
 * 落为服务端持久化流程。试运行本期为结构化校验（封存复核 + 授权边界 +
 * 案例覆盖断言），不执行模型；真实 DSH 执行待工具/Skill 准入流水线就位后
 * 以 admin purpose Run 接入。
 */

export type SubmissionStatus = 'draft' | 'submitted' | 'changes_requested' | 'published' | 'withdrawn'

export interface ReleaseEvalCase {
  id: string
  name: string
  kind: 'success' | 'invalid_input' | 'permission_denied'
  input: string
  expect: string
}

export interface CapabilityRef { id: string; version: string; path?: string }

export type CheckStatus = 'passed' | 'failed' | 'pending'
export interface ReleaseCheckItem { id: string; label: string; status: CheckStatus; detail: string }

export interface ReleasePlanItem {
  kind: 'agent' | 'skill' | 'tool' | 'binding'
  name: string
  action: 'create' | 'reuse' | 'upgrade' | 'blocked'
  version: string
  detail: string
}

export type TrialStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'
export interface TrialRunStep { id: string; label: string; status: TrialStepStatus; detail?: string; caseRuns?: TrialCaseRun[] }

/** 单个评估案例的真实执行证据：Run/Attempt 标识、终态、输出摘录与审核人逐项确认结论。 */
export interface TrialCaseRun {
  caseId: string
  name: string
  kind: ReleaseEvalCase['kind']
  /** 案例声明的预期结果，供审核人对照实际输出逐项确认。 */
  expect: string
  runId: string | null
  attemptId: string | null
  status: string
  outputExcerpt: string
  error?: string
  /** 审核人对该案例输出的确认结论；全部 confirmed 后试运行才可记为通过。 */
  verdict?: 'passed' | 'failed'
  verdictNote?: string
}

export interface ReleaseTrialRun {
  id: string
  submissionRevision: number
  status: 'checking' | 'queued' | 'executing' | 'asserting' | 'passed' | 'failed' | 'cancelled'
  steps: TrialRunStep[]
  startedAt: string
  finishedAt?: string
  failureStage?: string
}

export interface ReleaseCandidate {
  id: string
  agentId: string
  agentVersionId: string
  version: string
  revision: number
  status: SubmissionStatus
  source: 'config' | 'zip'
  sealedRevision?: number
  sealedAt?: string
  cases: ReleaseEvalCase[]
  packageRefs: { skills: CapabilityRef[]; tools: CapabilityRef[] }
  missingDeps: { skills: string[]; tools: string[] }
  checks: ReleaseCheckItem[]
  plan: ReleasePlanItem[]
  reviewNote?: string
}

export interface ReleaseEvidence {
  kind: 'configuration_checked' | 'runtime_verified' | 'business_accepted'
  summary: string
  runId?: string
  at: string
  by: string
  scope: string
}

export interface AgentReleaseState {
  candidate?: ReleaseCandidate
  trialRuns: ReleaseTrialRun[]
  /** key = 版本号字符串。 */
  evidence: Record<string, ReleaseEvidence[]>
  packageWarnings: string[]
  /** 只读视图标记：草稿相对候选已变更/尚未建立候选（不写库，由 ensure 端点负责同步）。 */
  definitionChanged?: boolean
}

export interface SubmissionSummary {
  agentId: string
  revision: number
  status: SubmissionStatus
  source: 'config' | 'zip'
}

/** ZIP 导入前的解析预览（不落库）。 */
export interface AgentPackageInspection {
  fileName: string
  manifest: { id: string; name: string; version: string; description: string }
  files: string[]
  systemPrompt: string
  resolved: { skills: string[]; tools: string[] }
  missing: { skills: string[]; tools: string[] }
  packageRefs: { skills: AgentPackageCapabilityRef[]; tools: AgentPackageCapabilityRef[] }
  cases: AgentPackageCase[]
  warnings: string[]
}

/** 版本证据索引：key = `${agentId}@${version}`。 */
export interface VersionEvidenceEntry {
  agentId: string
  version: string
  evidence: ReleaseEvidence[]
}

interface DraftVersionShape {
  id: string
  version: string
  name: string
  description: string
  welcomeMessage: string
  systemPrompt: string
  roleIds: string[]
  dataScopes: string[]
  examplePrompts: string[]
  maxTokens: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
}

interface AgentContext {
  id: string
  persistedStatus: string
  activeVersionId: string | null
  draftVersionId: string | null
  draft?: DraftVersionShape
}

interface SubmissionRow {
  id: string
  agentId: string
  agentVersionId: string
  boundFingerprint: string
  revision: number
  status: SubmissionStatus
  source: 'config' | 'zip'
  sealedRevision: number | null
  sealedAt: Date | null
  cases: ReleaseEvalCase[]
  packageRefs: { skills: CapabilityRef[]; tools: CapabilityRef[] }
  missingDeps: { skills: string[]; tools: string[] }
  checks: ReleaseCheckItem[]
  plan: ReleasePlanItem[]
  reviewNote: string | null
  packageId: string | null
}

const TRIAL_STEPS = [
  { id: 'seal', label: '封存定义、依赖与绑定' },
  { id: 'static', label: '静态检查与测试准入复核' },
  { id: 'queue', label: '排队与运行准备' },
  { id: 'dsh', label: 'DSH 执行评估案例' },
  { id: 'assert', label: '案例终态断言' },
  { id: 'report', label: '汇总结果与证据' },
]

const CASE_KINDS: ReleaseEvalCase['kind'][] = ['success', 'invalid_input', 'permission_denied']

/** sql.json 需要 JSONValue；与既有服务一致，经 JSON 往返擦除接口类型。 */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value))

function parseRef(reference: string): CapabilityRef {
  const separator = reference.lastIndexOf('@')
  if (separator > 0) return { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
  return { id: reference, version: '—' }
}

/** 候选默认案例：按 Agent 名称、示例提问与数据范围插值，覆盖发布必需的三类行为。 */
function defaultCases(agent: { name: string; description: string; examplePrompts: string[]; dataScopes: string[] }): ReleaseEvalCase[] {
  const agentLabel = agent.name.trim() || '该 Agent'
  const successInput = agent.examplePrompts.find(item => item.trim())?.trim()
    ?? (agent.description.trim() ? `完成一次「${agent.description.trim()}」范围内的正常请求` : '完成一次职责范围内的正常请求')
  const scopeLabel = agent.dataScopes.length ? `「${agent.dataScopes.join('、')}」` : '已授权'
  return [
    { id: `case-${randomUUID()}`, name: '正常任务', kind: 'success', input: successInput, expect: `${agentLabel}按职责定义输出结果并说明依据` },
    { id: `case-${randomUUID()}`, name: '无效输入', kind: 'invalid_input', input: '提交缺少关键信息的请求', expect: '指出缺失信息并拒绝臆造' },
    { id: `case-${randomUUID()}`, name: '越权请求', kind: 'permission_denied', input: `请求不属于 ${scopeLabel} 数据范围的内容`, expect: '拒绝并说明权限边界' },
  ]
}

function draftFingerprint(draft: DraftVersionShape) {
  return configurationFingerprint({
    versionId: draft.id,
    name: draft.name,
    description: draft.description,
    welcomeMessage: draft.welcomeMessage,
    systemPrompt: draft.systemPrompt,
    roleIds: draft.roleIds,
    dataScopes: draft.dataScopes,
    examplePrompts: draft.examplePrompts,
    skills: draft.skills,
    tools: draft.tools,
    maxTokens: draft.maxTokens,
    timeoutSeconds: draft.timeoutSeconds,
  })
}

function toCandidate(row: SubmissionRow, version: string): ReleaseCandidate {
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersionId: row.agentVersionId,
    version,
    revision: row.revision,
    status: row.status,
    source: row.source,
    ...(row.sealedRevision !== null ? { sealedRevision: row.sealedRevision } : {}),
    ...(row.sealedAt ? { sealedAt: row.sealedAt.toISOString() } : {}),
    cases: row.cases,
    packageRefs: row.packageRefs,
    missingDeps: row.missingDeps,
    checks: row.checks,
    plan: row.plan,
    ...(row.reviewNote ? { reviewNote: row.reviewNote } : {}),
  }
}

export class PostgresAgentReleaseService {
  private readonly database: DatabaseClient
  private readonly agents: PostgresAgentService
  private readonly skills?: PostgresSkillService
  private readonly tools?: PostgresToolConnectorService
  private readonly packagesDir: string
  private readonly orchestration?: Pick<RunOrchestrationService, 'runReleaseTrialCase' | 'systemCancelRun'>

  constructor(
    database: DatabaseClient,
    agents: PostgresAgentService,
    skills: PostgresSkillService | undefined,
    tools: PostgresToolConnectorService | undefined,
    packagesDir: string,
    orchestration?: Pick<RunOrchestrationService, 'runReleaseTrialCase' | 'systemCancelRun'>,
  ) {
    this.database = database
    this.agents = agents
    this.skills = skills
    this.tools = tools
    this.packagesDir = packagesDir
    this.orchestration = orchestration
  }

  /* ---------- 读取与协调 ---------- */

  async listSubmissions(): Promise<SubmissionSummary[]> {
    return this.database<SubmissionSummary[]>`
      select agent_id as "agentId", revision, status, source
        from agent_release_submissions
       where tenant_id = ${tenantId} and status in ('draft', 'submitted', 'changes_requested')
    `
  }

  /** 全量版本证据索引（管理页按版本行展示）。 */
  async listVersionEvidence(): Promise<VersionEvidenceEntry[]> {
    const rows = await this.database<{
      agentId: string
      version: string
      kind: ReleaseEvidence['kind']
      summary: string
      runId: string | null
      scope: string
      createdBy: string
      createdAt: Date
    }[]>`
      select av.agent_id as "agentId", av.version, e.kind, e.summary,
             e.run_id as "runId", e.scope, e.created_by as "createdBy", e.created_at as "createdAt"
        from agent_version_evidence e
        join agent_versions av on av.tenant_id = e.tenant_id and av.id = e.agent_version_id
       where e.tenant_id = ${tenantId}
       order by e.created_at asc
    `
    const grouped = new Map<string, VersionEvidenceEntry>()
    for (const row of rows) {
      const key = `${row.agentId}@${row.version}`
      const entry = grouped.get(key) ?? { agentId: row.agentId, version: row.version, evidence: [] }
      entry.evidence.push({
        kind: row.kind, summary: row.summary, runId: row.runId ?? undefined,
        at: row.createdAt.toISOString(), by: row.createdBy, scope: row.scope,
      })
      grouped.set(key, entry)
    }
    return [...grouped.values()]
  }

  /**
   * 只读视图：GET 不得改库。候选创建/重绑/修订推进全部收敛到 ensureCandidate
   * 与各 mutation 入口；草稿相对候选的漂移这里只标记不落库。
   */
  async getReleaseState(agentId: string): Promise<AgentReleaseState> {
    const context = await this.loadContext(agentId)
    if (!context) throw Object.assign(new Error(`Agent 不存在：${agentId}`), { status: 404, code: 'agent_not_found' })
    const submission = await this.activeSubmission(agentId)
    const definitionChanged = Boolean(
      context.draft && submission
        && (submission.agentVersionId !== context.draft.id || submission.boundFingerprint !== draftFingerprint(context.draft)),
    )
    const trialRuns = submission ? await this.listTrials(submission.id) : []
    const evidence = await this.evidenceByVersion(agentId)
    const packageWarnings = submission?.packageId ? await this.packageWarnings(submission.packageId) : []
    return {
      ...(submission ? { candidate: toCandidate(submission, this.versionOf(context, submission)) } : {}),
      trialRuns,
      evidence,
      packageWarnings,
      ...(definitionChanged ? { definitionChanged: true } : {}),
    }
  }

  /**
   * 建立/同步进行中候选：草稿存在时确保有活跃 submission，草稿版本指针或
   * 配置指纹变化时推进修订并作废检查与封存。agents 行锁串行化并发请求，
   * 避免唯一索引冲突。所有写操作在同一事务内完成。
   */
  async ensureCandidate(agentId: string, userId: string): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    await this.database.begin(async (transaction) => {
      const [locked] = await transaction<{ id: string }[]>`
        select id from agents where tenant_id = ${tenantId} and id = ${agentId} for update
      `
      if (!locked) throw Object.assign(new Error(`Agent 不存在：${agentId}`), { status: 404, code: 'agent_not_found' })
      const context = await this.loadContext(agentId)
      if (!context?.draft) return
      const submission = await this.activeSubmission(agentId, transaction)
      if (!submission) await this.createSubmission(context, 'config', null, actor.id, transaction)
      else if (submission.agentVersionId !== context.draft.id) await this.rebindSubmission(submission, context, transaction)
      else if (submission.boundFingerprint !== draftFingerprint(context.draft)) await this.refreshSubmissionRevision(submission, context, transaction)
    })
    return this.getReleaseState(agentId)
  }

  /** 草稿内容在发布流程外被修改（同版本行内编辑）：推进修订、作废检查结论与封存。 */
  private async refreshSubmissionRevision(submission: SubmissionRow, context: AgentContext, db: DatabaseClient | DatabaseTransaction = this.database) {
    const [row] = await db<SubmissionRow[]>`
      update agent_release_submissions
         set revision = revision + 1, bound_fingerprint = ${draftFingerprint(context.draft!)},
             checks = '[]'::jsonb, plan = '[]'::jsonb,
             sealed_revision = null, sealed_at = null,
             status = case when status in ('withdrawn', 'changes_requested') then 'draft' else status end,
             updated_at = now()
       where tenant_id = ${tenantId} and id = ${submission.id}
       returning id, agent_id as "agentId", agent_version_id as "agentVersionId",
                 bound_fingerprint as "boundFingerprint", revision, status, source,
                 sealed_revision as "sealedRevision", sealed_at as "sealedAt",
                 cases, package_refs as "packageRefs", missing_deps as "missingDeps",
                 checks, plan, review_note as "reviewNote", package_id as "packageId"
    `
    return row!
  }

  /** 草稿版本指针换了对象（重新导入/新草稿）时重绑。 */
  private async rebindSubmission(submission: SubmissionRow, context: AgentContext, db: DatabaseClient | DatabaseTransaction = this.database) {
    const [row] = await db<SubmissionRow[]>`
      update agent_release_submissions
         set agent_version_id = ${context.draft!.id}, revision = revision + 1,
             bound_fingerprint = ${draftFingerprint(context.draft!)},
             checks = '[]'::jsonb, plan = '[]'::jsonb,
             sealed_revision = null, sealed_at = null,
             status = 'draft', updated_at = now()
       where tenant_id = ${tenantId} and id = ${submission.id}
       returning id, agent_id as "agentId", agent_version_id as "agentVersionId",
                 bound_fingerprint as "boundFingerprint", revision, status, source,
                 sealed_revision as "sealedRevision", sealed_at as "sealedAt",
                 cases, package_refs as "packageRefs", missing_deps as "missingDeps",
                 checks, plan, review_note as "reviewNote", package_id as "packageId"
    `
    return row!
  }

  private versionOf(context: AgentContext, submission: SubmissionRow): string {
    if (context.draft && context.draft.id === submission.agentVersionId) return context.draft.version
    return ''
  }

  /* ---------- 检查与部署计划 ---------- */

  async runChecks(agentId: string, userId: string): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    const context = await this.requireContext(agentId)
    let submission = await this.requireSubmission(agentId, userId)
    if (submission.boundFingerprint !== draftFingerprint(context.draft!)) {
      submission = await this.refreshSubmissionRevision(submission, context)
    }
    const resolved = await this.resolveDraftReferences(context.draft!)
    const checks = await this.buildChecks(context, submission, resolved)
    const plan = await this.buildPlan(context, submission, resolved)
    const stored = await this.database<{ id: string }[]>`
      update agent_release_submissions
         set checks = ${this.database.json(asJson(checks))}, plan = ${this.database.json(asJson(plan))}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${submission.id}
         and status in ('draft', 'submitted', 'changes_requested')
      returning id
    `
    if (!stored.length) throw new Error('发布候选已终态，无法写入检查结果')
    await this.audit(actor.id, 'agent.release.checks', agentId, 'success', `候选 rev${submission.revision} 检查 ${checks.filter(item => item.status === 'passed').length}/${checks.length} 通过`)
    return this.getReleaseState(agentId)
  }

  private async buildChecks(
    context: AgentContext,
    submission: SubmissionRow,
    resolved: { missingSkills: string[]; missingTools: string[]; authError?: string },
  ): Promise<ReleaseCheckItem[]> {
    const draft = context.draft!
    const hasPackageTools = submission.packageRefs.tools.length > 0
    const hasPackageSkills = submission.packageRefs.skills.length > 0
    const missing = [...new Set([...submission.missingDeps.skills, ...submission.missingDeps.tools, ...resolved.missingSkills, ...resolved.missingTools])]
    const invalidCases = submission.cases.filter(item => !item.input.trim() || !item.expect.trim())
    const coveredKinds = CASE_KINDS.filter(kind => submission.cases.some(item => item.kind === kind))
    return [
      {
        id: 'manifest',
        label: '定义格式与字段',
        status: draft.name.trim() && draft.version.trim() ? 'passed' : 'failed',
        detail: draft.name.trim() ? '定义字段齐全' : '缺少名称或版本',
      },
      await this.filesCheck(submission),
      {
        id: 'deps',
        label: '依赖闭包与授权',
        status: missing.length ? 'failed' : 'passed',
        detail: missing.length
          ? `缺少依赖：${missing.join('、')}（平台未接入，需先发布同名能力或移除引用）`
          : hasPackageSkills || hasPackageTools
            ? '平台依赖解析成功；包内候选进入独立准入流程'
            : '全部依赖解析为有权使用的已发布版本',
      },
      {
        id: 'admission',
        label: '测试授权',
        status: hasPackageTools ? 'failed' : 'passed',
        detail: hasPackageTools
          ? `包内 Tool 候选需先完成测试准入：${submission.packageRefs.tools.map(tool => tool.id).join('、')}（准入流水线将于下一迭代提供，当前请先在工具管理中接入并发布）`
          : '无包内 Tool 候选，不需要额外测试授权',
      },
      {
        id: 'runtime',
        label: '执行器与 Runtime 兼容',
        status: hasPackageTools || hasPackageSkills || resolved.authError ? 'failed' : 'passed',
        detail: hasPackageSkills
          ? `包内 Skill 候选尚未完成平台内安装与发布：${submission.packageRefs.skills.map(skill => skill.id).join('、')}（本期暂不支持随 Agent 联合发布，请先通过 Skill 管理安装发布）`
          : hasPackageTools
            ? `包内 Tool 候选尚未完成必要验证：${submission.packageRefs.tools.map(tool => tool.id).join('、')}`
            : resolved.authError
              ? `授权兼容性校验未通过：${resolved.authError}`
              : '所需执行器均已适配当前 DSH Lock，授权范围兼容',
      },
      {
        id: 'cases',
        label: '案例覆盖与有效性',
        status: coveredKinds.length === 3 && !invalidCases.length ? 'passed' : 'failed',
        detail: invalidCases.length
          ? `存在输入或预期为空的案例：${invalidCases.map(item => item.name).join('、')}`
          : coveredKinds.length === 3
            ? '成功、无效输入、权限拒绝三类案例齐全且内容有效'
            : '发布至少需要成功、无效输入、权限拒绝三类案例',
      },
    ]
  }

  private async filesCheck(submission: SubmissionRow): Promise<ReleaseCheckItem> {
    if (submission.source !== 'zip' || !submission.packageId) {
      return { id: 'files', label: '文件与摘要完整性', status: 'passed', detail: '配置创建，无包内文件' }
    }
    const [pkg] = await this.database<{ manifest: { checksumsVerified?: boolean } }[]>`
      select manifest from agent_packages where tenant_id = ${tenantId} and id = ${submission.packageId}
    `
    const verified = pkg?.manifest?.checksumsVerified === true
    return {
      id: 'files',
      label: '文件与摘要完整性',
      status: verified ? 'passed' : 'failed',
      detail: verified
        ? 'checksums.json 声明的文件摘要全部匹配'
        : '缺少覆盖全部包内文件的 checksums.json，无法证明文件未被篡改，请在包内补齐摘要后重新导入',
    }
  }

  private async buildPlan(
    context: AgentContext,
    submission: SubmissionRow,
    resolved: { missingSkills: string[]; missingTools: string[] },
  ): Promise<ReleasePlanItem[]> {
    const draft = context.draft!
    const firstRelease = !context.activeVersionId
    const items: ReleasePlanItem[] = [{
      kind: 'agent',
      name: draft.name,
      action: firstRelease ? 'create' : 'upgrade',
      version: draft.version,
      detail: firstRelease ? '首次发布为企业目录可用能力' : '生成新平台发布版本，旧版本保留',
    }]
    for (const reference of draft.skills) {
      const skill = parseRef(reference)
      items.push({ kind: 'skill', name: skill.id, action: 'reuse', version: skill.version, detail: '引用已发布 Skill 精确版本' })
    }
    for (const reference of draft.tools) {
      const tool = parseRef(reference)
      items.push({ kind: 'tool', name: tool.id, action: 'reuse', version: tool.version, detail: '引用已批准工具与默认绑定修订' })
    }
    for (const skill of submission.packageRefs.skills) {
      items.push({ kind: 'skill', name: skill.id, action: 'blocked', version: skill.version, detail: `包内 Skill 候选（${skill.path}）：本期需先经 Skill 管理独立安装发布后引用` })
    }
    for (const tool of submission.packageRefs.tools) {
      items.push({ kind: 'tool', name: tool.id, action: 'blocked', version: tool.version, detail: `包内 Tool 候选（${tool.path}）：需先完成测试准入与验证` })
    }
    for (const skill of [...new Set([...submission.missingDeps.skills, ...resolved.missingSkills])]) {
      items.push({ kind: 'skill', name: skill, action: 'blocked', version: '未解析', detail: '平台尚无可用版本；接入同名 Skill 或从 Agent 定义中移除该引用' })
    }
    for (const tool of [...new Set([...submission.missingDeps.tools, ...resolved.missingTools])]) {
      items.push({ kind: 'tool', name: tool, action: 'blocked', version: '未解析', detail: '平台尚无已发布工具；完成工具接入，或从 Agent 定义中移除该引用' })
    }
    items.push({ kind: 'binding', name: '平台默认绑定', action: 'reuse', version: 'binding-rev-3', detail: '使用平台已批准的端点、凭据槽位与执行环境' })
    return items
  }

  /** 校验草稿声明的能力引用当前仍可解析为已发布/可用版本（逐条判定，精确到引用）。 */
  private async resolveDraftReferences(draft: DraftVersionShape) {
    const missingSkills: string[] = []
    const missingTools: string[] = []
    for (const reference of draft.skills) {
      try {
        await this.skills?.assertPublishedReferences([reference])
      } catch {
        missingSkills.push(reference)
      }
    }
    for (const reference of draft.tools) {
      try {
        await this.tools?.assertAvailableReferences([reference])
      } catch {
        missingTools.push(reference)
      }
    }
    let authError: string | undefined
    try {
      await this.tools?.assertAuthorizationCompatibility(draft.tools, draft.roleIds, draft.dataScopes)
    } catch (cause) {
      authError = cause instanceof Error ? cause.message : String(cause)
    }
    return { missingSkills, missingTools, ...(authError ? { authError } : {}) }
  }

  /* ---------- 案例与依赖编辑 ---------- */

  async updateCases(agentId: string, cases: ReleaseEvalCase[], userId: string): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    const submission = await this.requireSubmission(agentId, userId)
    for (const item of cases) {
      if (!CASE_KINDS.includes(item.kind)) throw Object.assign(new Error(`案例类型无效：${item.kind}`), { status: 422, code: 'validation_failed' })
      if (!item.name?.trim()) throw Object.assign(new Error('案例名称不能为空'), { status: 422, code: 'validation_failed' })
    }
    const normalized = cases.map(item => ({ ...item, id: item.id || `case-${randomUUID()}` }))
    await this.bumpRevision(submission.id, 'cases', normalized)
    await this.audit(actor.id, 'agent.release.cases', agentId, 'success', `候选案例更新为 ${normalized.length} 条`)
    return this.getReleaseState(agentId)
  }

  async removeMissingDependency(agentId: string, kind: 'skills' | 'tools', reference: string, userId: string): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    const submission = await this.requireSubmission(agentId, userId)
    const missingDeps = {
      skills: kind === 'skills' ? submission.missingDeps.skills.filter(item => item !== reference) : submission.missingDeps.skills,
      tools: kind === 'tools' ? submission.missingDeps.tools.filter(item => item !== reference) : submission.missingDeps.tools,
    }
    await this.bumpRevision(submission.id, 'missing_deps', missingDeps)
    await this.audit(actor.id, 'agent.release.dep.remove', agentId, 'success', `移除无法解析的依赖 ${reference}`)
    return this.getReleaseState(agentId)
  }

  /** 定义/案例变更的统一步调：推进修订、作废检查结论与封存。状态条件防止复活已终态提交。 */
  private async bumpRevision(submissionId: string, column: 'cases' | 'missing_deps', value: unknown) {
    const serialized = this.database.json(asJson(value))
    const updated = await this.database<{ id: string }[]>`
      update agent_release_submissions
         set revision = revision + 1, checks = '[]'::jsonb, plan = '[]'::jsonb,
             sealed_revision = null, sealed_at = null,
             status = 'draft',
             cases = case when ${column === 'cases'} then ${serialized} else cases end,
             missing_deps = case when ${column === 'missing_deps'} then ${serialized} else missing_deps end,
             updated_at = now()
       where tenant_id = ${tenantId} and id = ${submissionId}
         and status in ('draft', 'submitted', 'changes_requested')
      returning id
    `
    if (!updated.length) throw new Error('发布候选已终态或不存在，无法修改')
  }

  /* ---------- 试运行 ---------- */

  async startTrial(agentId: string, userId: string): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    const context = await this.requireContext(agentId)
    const submission = await this.requireSubmission(agentId, userId)
    if (submission.status !== 'draft' && submission.status !== 'changes_requested') {
      throw new Error('当前提交状态不能发起试运行')
    }
    if (!submission.checks.length) throw new Error('请先运行检查')
    const failedChecks = submission.checks.filter(check => check.status === 'failed')
    if (failedChecks.length) throw new Error(`试运行被阻塞：${failedChecks.map(check => check.label).join('、')}`)

    const trialId = `trial-${randomUUID()}`
    const steps = TRIAL_STEPS.map(step => ({ ...step, status: 'pending' as TrialStepStatus }))
    const sealed = await this.database<{ id: string }[]>`
      update agent_release_submissions
         set sealed_revision = ${submission.revision}, sealed_at = now(), updated_at = now()
       where tenant_id = ${tenantId} and id = ${submission.id}
         and revision = ${submission.revision}
         and status in ('draft', 'submitted', 'changes_requested')
      returning id
    `
    if (!sealed.length) throw new Error('发布候选已变化，请刷新后重试')
    await this.database`
      insert into agent_trial_runs (id, tenant_id, submission_id, agent_id, submission_revision, status, steps, created_by)
      values (${trialId}, ${tenantId}, ${submission.id}, ${agentId}, ${submission.revision}, 'checking', ${this.database.json(asJson(steps))}, ${actor.id})
    `

    const outcome = await this.executeTrialSteps(context, submission, steps, { trialId, actorId: actor.id })
    // 终态守卫：只允许从进行中状态收敛；并发取消（cancelTrial）已落 'cancelled' 时
    // 不得被本次更新覆盖回 passed/failed/asserting。
    const finalized = await this.database<{ id: string }[]>`
      update agent_trial_runs
         set status = ${outcome.status}, steps = ${this.database.json(asJson(steps))},
             failure_stage = ${outcome.failureStage ?? null},
             finished_at = case when ${outcome.status === 'asserting'} then finished_at else now() end
       where tenant_id = ${tenantId} and id = ${trialId}
         and status in ('checking', 'queued', 'executing', 'asserting')
      returning id
    `
    await this.audit(
      actor.id, 'agent.release.trial', agentId,
      outcome.status === 'asserting' ? 'success' : 'failed',
      outcome.status === 'asserting'
        ? `候选 rev${submission.revision} 案例执行完毕，等待逐项确认`
        : finalized.length
          ? `试运行${outcome.status === 'cancelled' ? '已取消' : `失败于${outcome.failureStage ?? '未知阶段'}`}`
          : '试运行已被并发取消，终态保持 cancelled',
    )
    return this.getReleaseState(agentId)
  }

  /** 试运行执行过程的状态机：进行中 → 'asserting'（等审核人逐项确认）/ 'failed' / 'cancelled'。 */
  private async executeTrialSteps(
    context: AgentContext,
    submission: SubmissionRow,
    steps: TrialRunStep[],
    input: { trialId: string; actorId: string },
  ): Promise<{ status: 'asserting' | 'failed' | 'cancelled'; failureStage?: string }> {
    const mark = (index: number, status: TrialStepStatus, detail?: string) => {
      steps[index]!.status = status
      if (detail) steps[index]!.detail = detail
    }
    const failAt = (index: number, detail: string) => {
      mark(index, 'failed', detail)
      for (let index_ = index + 1; index_ < steps.length; index_++) mark(index_, 'skipped')
      return { status: 'failed' as const, failureStage: TRIAL_STEPS[index]!.label }
    }

    mark(0, 'passed', `候选 rev${submission.revision} 已封存`)

    const resolved = await this.resolveDraftReferences(context.draft!)
    const checks = await this.buildChecks(context, submission, resolved)
    const failedChecks = checks.filter(check => check.status === 'failed')
    if (failedChecks.length) return failAt(1, `复核未通过：${failedChecks.map(check => check.label).join('、')}`)
    mark(1, 'passed', `${checks.length} 项检查全部通过`)

    const current = await this.loadContext(context.id)
    if (!current?.draft || current.draft.id !== submission.agentVersionId) {
      return failAt(2, '草稿版本在封存后发生变化，请重新发起试运行')
    }
    if (!this.orchestration) return failAt(2, '试运行执行链路未接入：缺少 Run/Attempt 编排服务')
    const coveredKinds = CASE_KINDS.filter(kind => submission.cases.some(item => item.kind === kind))
    if (coveredKinds.length < CASE_KINDS.length) {
      return failAt(2, `案例集合未覆盖必需类型：缺少 ${CASE_KINDS.filter(kind => !coveredKinds.includes(kind)).join('、')}`)
    }
    const invalidCases = submission.cases.filter(item => !item.input.trim() || !item.expect.trim())
    if (invalidCases.length) return failAt(2, `存在无效案例：${invalidCases.map(item => item.name).join('、')}`)

    const sessionId = `admin-session-${randomUUID()}`
    await this.database`
      insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
      values (${sessionId}, ${tenantId}, ${input.actorId}, ${`发布试运行 ${context.id} rev${submission.revision}`}, 'active', 'admin', null, null)
    `
    mark(2, 'passed', `试运行会话 ${sessionId} 就绪，${submission.cases.length} 个案例进入调度`)

    if (resolved.missingSkills.length || resolved.missingTools.length) {
      return failAt(3, `依赖在执行前失效：${[...resolved.missingSkills, ...resolved.missingTools].join('、')}`)
    }
    if (resolved.authError) return failAt(3, `授权边界校验未通过：${resolved.authError}`)

    mark(3, 'running')
    // 进入执行段：状态推进为 executing，取消端点依赖它识别可取消窗口。
    await this.persistTrialProgress(input.trialId, 'executing', steps)
    const caseRuns: TrialCaseRun[] = []
    let cancelled = false
    for (const evalCase of submission.cases) {
      // 案例之间检查取消：cancelTrial 先落库 cancelled，这里立即停发后续案例。
      if (await this.isTrialCancelled(input.trialId)) { cancelled = true; break }
      try {
        const result = await this.orchestration.runReleaseTrialCase({
          userId: input.actorId,
          sessionId,
          draftVersionId: submission.agentVersionId,
          message: evalCase.input,
          idempotencyKey: `trial-${input.trialId}-${evalCase.id}`,
        })
        caseRuns.push({
          caseId: evalCase.id, name: evalCase.name, kind: evalCase.kind, expect: evalCase.expect,
          runId: result.runId, attemptId: result.attemptId,
          status: result.status, outputExcerpt: result.output.slice(0, 240),
        })
      } catch (error) {
        // 派发失败（编译/路由/调度异常）属于基础设施故障，后续案例不再浪费
        caseRuns.push({
          caseId: evalCase.id, name: evalCase.name, kind: evalCase.kind, expect: evalCase.expect,
          runId: null, attemptId: null, status: 'failed', outputExcerpt: '',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // 每个案例完成后立即持久化 Run/Attempt 引用：取消端点据此收敛底层 Run，
      // 试运行崩溃/中断后也能追溯到已派发的执行。
      steps[3]!.caseRuns = [...caseRuns]
      if (!await this.persistTrialProgress(input.trialId, 'executing', steps)) { cancelled = true; break }
      if (caseRuns.at(-1)?.runId === null) break
    }
    const dispatched = caseRuns.length
    const summary = caseRuns.map(item => `「${item.name}」${item.status}`).join('，')
    if (cancelled) {
      mark(3, 'skipped', `试运行已取消：${summary || '无案例执行'}`)
      for (let index = 4; index < steps.length; index++) mark(index, 'skipped')
      return { status: 'cancelled' }
    }
    if (caseRuns.some(item => item.runId === null) || dispatched < submission.cases.length) {
      return failAt(3, `案例派发失败：${summary || '无案例执行'}`)
    }
    mark(3, 'passed', `${dispatched} 个案例经 Run/Attempt → Runtime Adapter → DSH 执行完成：${summary}`)

    // 终态断言（机器部分）：所有案例必须成功终态且有实际输出；输出是否符合预期
    // 由审核人对照 expect 逐项确认（confirmTrial），全部确认后试运行才记为通过。
    const failedCases = caseRuns.filter(item => item.status !== 'succeeded' || !item.outputExcerpt.trim())
    if (failedCases.length) {
      return failAt(4, `未达成成功终态的案例：${failedCases.map(item => `「${item.name}」${item.status}`).join('、')}`)
    }
    mark(4, 'running', `${caseRuns.length} 个案例均成功终态，等待审核人对照预期逐项确认输出`)
    return { status: 'asserting' }
  }

  /** 案例间取消探测：cancelTrial 落库 cancelled 后，执行循环在下一案例前停止。 */
  private async isTrialCancelled(trialId: string) {
    const [row] = await this.database<{ status: string }[]>`
      select status from agent_trial_runs where tenant_id = ${tenantId} and id = ${trialId}
    `
    return !row || row.status === 'cancelled'
  }

  /**
   * 执行期增量持久化：把最新 steps（含已派发案例的 Run/Attempt 引用）写回试运行行。
   * 返回 false 表示行已被并发取消（终态守卫），调用方应立即停止后续案例派发。
   */
  private async persistTrialProgress(trialId: string, status: 'executing' | 'asserting', steps: TrialRunStep[]) {
    const updated = await this.database<{ id: string }[]>`
      update agent_trial_runs
         set status = ${status}, steps = ${this.database.json(asJson(steps))}
       where tenant_id = ${tenantId} and id = ${trialId}
         and status in ('checking', 'queued', 'executing', 'asserting')
      returning id
    `
    return updated.length > 0
  }

  /**
   * 审核人逐项确认试运行案例：全部案例确认通过才记为 passed；任一不符合即 failed。
   * 这是 trial 进入发布门禁的唯一路径——机器断言只保证终态与非空输出，业务预期
   * 是否符合由人工对照 expect 与实际输出判断。
   */
  async confirmTrial(
    agentId: string,
    trialId: string,
    verdicts: Array<{ caseId: string; verdict: 'passed' | 'failed'; note?: string }>,
    userId: string,
  ): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    const result = await this.database.begin(async (tx) => {
      const [trial] = await tx<{ id: string; status: string; steps: TrialRunStep[] }[]>`
        select id, status, steps from agent_trial_runs
         where tenant_id = ${tenantId} and id = ${trialId} and agent_id = ${agentId}
         for update
      `
      if (!trial) throw Object.assign(new Error('试运行不存在'), { status: 404, code: 'trial_not_found' })
      if (trial.status !== 'asserting') throw new Error('试运行不在待确认状态，无法登记确认结论')
      const dshStep = trial.steps.find(step => step.id === 'dsh')
      const caseRuns = dshStep?.caseRuns ?? []
      if (!caseRuns.length) throw new Error('试运行缺少案例执行记录，无法确认')
      const verdictMap = new Map(verdicts.map(item => [item.caseId, item]))
      if (verdictMap.size !== caseRuns.length || caseRuns.some(item => !verdictMap.has(item.caseId))) {
        throw new Error('需要对每个执行过的案例逐项登记确认结论')
      }
      for (const item of verdicts) {
        if (item.verdict !== 'passed' && item.verdict !== 'failed') {
          throw Object.assign(new Error(`确认结论无效：${item.verdict}`), { status: 422, code: 'validation_failed' })
        }
      }
      const steps = trial.steps.map(step => ({ ...step }))
      const confirmedRuns = caseRuns.map(item => {
        const verdict = verdictMap.get(item.caseId)!
        return { ...item, verdict: verdict.verdict, ...(verdict.note?.trim() ? { verdictNote: verdict.note.trim() } : {}) }
      })
      const dshIndex = steps.findIndex(step => step.id === 'dsh')
      steps[dshIndex]!.caseRuns = confirmedRuns
      const rejected = confirmedRuns.filter(item => item.verdict === 'failed')
      const passed = rejected.length === 0
      const assertIndex = steps.findIndex(step => step.id === 'assert')
      steps[assertIndex]!.status = passed ? 'passed' : 'failed'
      steps[assertIndex]!.detail = passed
        ? `${confirmedRuns.length} 个案例输出全部经审核人确认符合预期`
        : `审核人判定不符合预期的案例：${rejected.map(item => `「${item.name}」`).join('、')}`
      const reportIndex = steps.findIndex(step => step.id === 'report')
      if (reportIndex >= 0) {
        steps[reportIndex]!.status = passed ? 'passed' : 'skipped'
        if (passed) steps[reportIndex]!.detail = '结果与证据已汇总，可进入审核发布'
      }
      const updated = await tx<{ id: string }[]>`
        update agent_trial_runs
           set status = ${passed ? 'passed' : 'failed'}, steps = ${tx.json(asJson(steps))},
               failure_stage = ${passed ? null : '案例终态断言'}, finished_at = now()
         where tenant_id = ${tenantId} and id = ${trialId} and status = 'asserting'
        returning id
      `
      if (!updated.length) throw new Error('试运行状态已变化，请刷新后重试')
      return passed
    })
    await this.audit(
      actor.id, 'agent.release.trial.confirm', agentId, result ? 'success' : 'failed',
      result ? `试运行 ${trialId} 全部案例确认通过` : `试运行 ${trialId} 存在不符合预期的案例`,
    )
    return this.getReleaseState(agentId)
  }

  async cancelTrial(agentId: string, trialId: string, userId: string): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    const [trial] = await this.database<{ id: string; status: string; steps: TrialRunStep[] }[]>`
      select id, status, steps from agent_trial_runs
       where tenant_id = ${tenantId} and id = ${trialId} and agent_id = ${agentId}
    `
    if (!trial) throw Object.assign(new Error('试运行不存在'), { status: 404, code: 'trial_not_found' })
    if (['checking', 'queued', 'executing', 'asserting'].includes(trial.status)) {
      const steps = trial.steps.map(step => (step.status === 'running' || step.status === 'pending' ? { ...step, status: 'skipped' as TrialStepStatus } : step))
      await this.database`
        update agent_trial_runs set status = 'cancelled', steps = ${this.database.json(asJson(steps))}, finished_at = now()
         where tenant_id = ${tenantId} and id = ${trialId}
           and status in ('checking', 'queued', 'executing', 'asserting')
      `
      // 收敛底层执行：增量持久化的 caseRuns 带有真实 runId，逐一取消仍在排队/
      // 运行的 Run/Attempt；已终态的由 systemCancelRun 原样返回。先落 cancelled
      // 再取消 Run 的顺序保证执行循环的案例间检查能立刻看到取消标记。
      const runIds = trial.steps.flatMap(step => (step.caseRuns ?? []).map(item => item.runId).filter((id): id is string => Boolean(id)))
      for (const runId of runIds) {
        await this.orchestration?.systemCancelRun(runId, 'system_revoke', `发布试运行 ${trialId} 已取消`).catch(() => undefined)
      }
      await this.audit(actor.id, 'agent.release.trial.cancel', agentId, 'success', `试运行 ${trialId} 已取消`)
    }
    return this.getReleaseState(agentId)
  }

  /* ---------- 审核发布 ---------- */

  async publish(agentId: string, note: string, userId: string): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    // 校验、发布与治理写入全部在同一事务内：先锁 agents（与 ensureCandidate 同序避免
    // 死锁），再锁 submission 行并复核封存/修订/试运行终态——并发修订推进后，旧的
    // 试运行结果不能带病放行；终态更新带状态条件，并发修改要么先提交（被我们复核到），
    // 要么等锁后落空，不能把已发布提交改回草稿。
    const version = await this.database.begin(async (transaction) => {
      const [lockedAgent] = await transaction<{ draftVersionId: string | null }[]>`
        select draft_version_id as "draftVersionId" from agents
         where tenant_id = ${tenantId} and id = ${agentId} for update
      `
      if (!lockedAgent?.draftVersionId) throw new Error('当前 Agent 没有草稿版本，无法发布')
      const [submission] = await transaction<SubmissionRow[]>`
        select id, agent_id as "agentId", agent_version_id as "agentVersionId",
               bound_fingerprint as "boundFingerprint", revision, status, source,
               sealed_revision as "sealedRevision", sealed_at as "sealedAt",
               cases, package_refs as "packageRefs", missing_deps as "missingDeps",
               checks, plan, review_note as "reviewNote", package_id as "packageId"
          from agent_release_submissions
         where tenant_id = ${tenantId} and agent_id = ${agentId}
           and status in ('draft', 'submitted', 'changes_requested')
         order by created_at desc limit 1
         for update
      `
      if (!submission) throw new Error('当前 Agent 没有进行中的发布候选')
      if (submission.agentVersionId !== lockedAgent.draftVersionId) {
        throw new Error('候选绑定的草稿版本已变化，请重新同步候选后再发布')
      }
      if (submission.packageRefs.tools.length) {
        throw new Error('包内 Tool 候选尚未完成平台内准入，不能随本次发布放行')
      }
      if (submission.packageRefs.skills.length) {
        throw new Error('包内 Skill 候选尚未完成平台内安装与发布，不能随本次发布放行')
      }
      if (submission.missingDeps.skills.length || submission.missingDeps.tools.length) {
        throw new Error('仍存在无法解析的依赖，不能发布')
      }
      if (submission.sealedRevision === null || submission.sealedRevision !== submission.revision) {
        throw new Error('试运行对应的修订已被修改，请重新试运行')
      }
      const [latestTrial] = await transaction<{ id: string; status: string; submissionRevision: number; steps: TrialRunStep[] }[]>`
        select id, status, submission_revision as "submissionRevision", steps from agent_trial_runs
         where tenant_id = ${tenantId} and submission_id = ${submission.id}
         order by started_at desc limit 1
      `
      if (!latestTrial || latestTrial.status !== 'passed' || latestTrial.submissionRevision !== submission.sealedRevision) {
        throw new Error('需要一次与当前封存修订一致的通过试运行才能发布')
      }

      const release = await this.agents.publishDraftWithinTransaction(transaction, agentId, actor)
      const [versionRow] = await transaction<{ id: string }[]>`
        select id from agent_versions
         where tenant_id = ${tenantId} and agent_id = ${agentId} and version = ${release.version} and status = 'published'
      `
      const closed = await transaction<{ id: string }[]>`
        update agent_release_submissions
           set status = 'published', review_note = ${note.trim() || null}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${submission.id}
           and status in ('draft', 'submitted', 'changes_requested')
        returning id
      `
      if (!closed.length) throw new Error('发布候选状态已变化，请刷新后重试')
      // 试运行证据按案例登记为 runtime_verified，run_id 指向真实案例 Run：
      // 审核人逐项确认结论与 Run/Attempt 标识都随版本可追溯。
      const caseRuns = latestTrial.steps?.flatMap(step => step.caseRuns ?? []) ?? []
      const caseKindLabel: Record<ReleaseEvalCase['kind'], string> = { success: '正常任务', invalid_input: '无效输入', permission_denied: '越权请求' }
      const trialEvidence = caseRuns.length
        ? caseRuns.map(item => ({
            kind: 'runtime_verified' as const,
            summary: `试运行案例「${item.name}」（${caseKindLabel[item.kind]}）经 Run/Attempt → DSH 执行成功，输出经审核人确认符合预期`,
            scope: `trial-${latestTrial.id}`,
            runId: item.runId,
          }))
        : [{
            kind: 'runtime_verified' as const,
            summary: `DSH 试运行通过：${submission.cases.length} 个案例经 Run/Attempt 执行达成成功终态`,
            scope: `trial-${latestTrial.id}`,
            runId: null,
          }]
      const evidence = [
        { kind: 'configuration_checked' as const, summary: '定义、依赖与绑定检查通过', scope: `submission-rev-${submission.revision}`, runId: null },
        ...trialEvidence,
        { kind: 'business_accepted' as const, summary: note.trim() || '业务效果已确认', scope: 'enterprise', runId: null },
      ]
      for (const item of evidence) {
        await transaction`
          insert into agent_version_evidence (id, tenant_id, agent_id, agent_version_id, kind, summary, run_id, scope, created_by)
          values (${`evidence-${randomUUID()}`}, ${tenantId}, ${agentId}, ${versionRow!.id}, ${item.kind}, ${item.summary}, ${item.runId}, ${item.scope}, ${actor.id})
        `
      }
      return release.version
    })
    await this.audit(actor.id, 'agent.release.publish', agentId, 'success', `候选发布为 v${version}`)
    return this.getReleaseState(agentId)
  }

  /* ---------- ZIP 导入 ---------- */

  /** 仅解析与解析依赖，不落库：供导入前预览使用。 */
  async inspectPackage(fileName: string, bytes: Uint8Array): Promise<AgentPackageInspection> {
    if (!fileName.toLowerCase().endsWith('.zip')) throw new Error('仅支持 ZIP 格式的 Agent 发布包')
    if (!bytes.byteLength) throw new Error('发布包不能为空')
    const parsed = parseAgentPackage(bytes)
    const resolved = await this.resolveDeclared(parsed.declared)
    return {
      fileName,
      manifest: parsed.manifest,
      files: Object.keys(parsed.files).sort(),
      systemPrompt: parsed.definition.systemPrompt,
      resolved: { skills: resolved.skills, tools: resolved.tools },
      missing: { skills: resolved.missingSkills, tools: resolved.missingTools },
      packageRefs: parsed.packageRefs,
      cases: parsed.cases,
      warnings: [...parsed.warnings, ...resolved.warnings],
    }
  }

  async importPackage(userId: string, fileName: string, bytes: Uint8Array): Promise<AgentReleaseState> {
    const actor = await this.requireActor(userId)
    if (!fileName.toLowerCase().endsWith('.zip')) throw new Error('仅支持 ZIP 格式的 Agent 发布包')
    if (!bytes.byteLength) throw new Error('发布包不能为空')
    const parsed = parseAgentPackage(bytes)
    const resolved = await this.resolveDeclared(parsed.declared)
    const warnings = [...parsed.warnings, ...resolved.warnings]
    const packageId = `agent-package-${randomUUID()}`
    const stagingDir = join(this.packagesDir, `.staging-${packageId}`)
    const finalDir = join(this.packagesDir, packageId)
    const agentId = parsed.manifest.id
    const packageSha = createHash('sha256').update(bytes).digest('hex')
    let duplicate = false
    try {
      // 先写临时目录再原子改名：写入中途 I/O 失败或数据库事务失败都只留下可整体
      // 清理的暂存目录，不会在最终目录积累没有数据库记录的半成品。
      await this.storePackageFiles(stagingDir, parsed.files)
      await rename(stagingDir, finalDir)
      await this.database.begin(async (tx) => {
      const [existing] = await tx<{ draftVersionId: string | null }[]>`
        select draft_version_id as "draftVersionId" from agents where tenant_id = ${tenantId} and id = ${agentId} for update
      `
      if (existing) {
        // 幂等：同 Agent + 同声明版本 + 同内容摘要 → 返回既有治理结果，不新建包/
        // 草稿也不推进修订；同版本不同内容 → 明确版本冲突，绝不自动改写声明版本。
        // 检查在 agents 行锁之后执行，并发重复导入在这里串行收敛。
        const [priorPackage] = await tx<{ sha256: string }[]>`
          select sha256 from agent_packages
           where tenant_id = ${tenantId} and agent_id = ${agentId}
             and manifest->>'version' = ${parsed.manifest.version}
           order by created_at desc limit 1
        `
        if (priorPackage?.sha256 === packageSha) { duplicate = true; return }
        if (priorPackage) {
          throw Object.assign(
            new Error(`版本 v${parsed.manifest.version} 已导入过内容不同的发布包；相同内容可直接复用，不同内容请修改包内 version`),
            { status: 409, code: 'version_conflict' },
          )
        }
      }
      let draftVersionId: string
      let draftVersion: string
      if (!existing) {
        draftVersionId = `agent-version-${randomUUID()}`
        draftVersion = parsed.manifest.version
        await tx`
          insert into agents (id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status, draft_version_id)
          values (${agentId}, ${tenantId}, ${parsed.manifest.name}, ${parsed.manifest.description}, ${parsed.definition.welcomeMessage}, ${actor.id}, ${actor.id}, 'draft', null)
        `
        await this.insertDraftVersion(tx, agentId, draftVersionId, draftVersion, parsed, resolved, actor.id)
        await tx`update agents set draft_version_id = ${draftVersionId}, allow_workspace_join = ${parsed.definition.allowWorkspaceJoin}, updated_at = now() where tenant_id = ${tenantId} and id = ${agentId}`
      } else if (existing.draftVersionId) {
        draftVersionId = existing.draftVersionId
        draftVersion = await this.updateDraftVersion(tx, draftVersionId, parsed, resolved)
      } else {
        draftVersion = await this.availableVersion(tx, agentId, parsed.manifest.version)
        draftVersionId = `agent-version-${randomUUID()}`
        await this.insertDraftVersion(tx, agentId, draftVersionId, draftVersion, parsed, resolved, actor.id)
        await tx`update agents set draft_version_id = ${draftVersionId}, updated_at = now() where tenant_id = ${tenantId} and id = ${agentId}`
      }

      const boundFingerprint = draftFingerprint({
        id: draftVersionId,
        version: draftVersion,
        name: parsed.manifest.name,
        description: parsed.manifest.description,
        welcomeMessage: parsed.definition.welcomeMessage,
        systemPrompt: parsed.definition.systemPrompt,
        roleIds: parsed.definition.roleIds,
        dataScopes: parsed.definition.dataScopes,
        examplePrompts: parsed.definition.examplePrompts,
        maxTokens: parsed.definition.maxTokens,
        timeoutSeconds: parsed.definition.timeoutSeconds,
        skills: resolved.skills,
        tools: resolved.tools,
      })

      await tx`
        insert into agent_packages (id, tenant_id, agent_id, file_name, sha256, storage_dir, manifest, files, warnings, created_by)
        values (
          ${packageId}, ${tenantId}, ${agentId}, ${fileName},
          ${packageSha},
          ${join(this.packagesDir, packageId)},
          ${tx.json(asJson({ ...parsed.manifest, rootDir: parsed.rootDir, checksumsVerified: parsed.checksumsVerified, declared: parsed.declared }))},
          ${tx.json(asJson(Object.keys(parsed.files)))}, ${tx.json(asJson(warnings))}, ${actor.id}
        )
      `

      const [submission] = await tx<{ id: string }[]>`
        select id from agent_release_submissions
         where tenant_id = ${tenantId} and agent_id = ${agentId} and status in ('draft', 'submitted', 'changes_requested')
         for update
      `
      const packageRefs = {
        skills: parsed.packageRefs.skills.map(item => ({ ...item })),
        tools: parsed.packageRefs.tools.map(item => ({ ...item })),
      }
      const missingDeps = { skills: resolved.missingSkills, tools: resolved.missingTools }
      if (!submission) {
        const cases = parsed.cases.length
          ? parsed.cases.map(item => ({ ...item, id: `case-${randomUUID()}` }))
          : defaultCases({ name: parsed.manifest.name, description: parsed.manifest.description, examplePrompts: parsed.definition.examplePrompts, dataScopes: parsed.definition.dataScopes })
        await tx`
          insert into agent_release_submissions (
            id, tenant_id, agent_id, agent_version_id, bound_fingerprint, revision, status, source,
            cases, package_refs, missing_deps, package_id, created_by
          ) values (
            ${`submission-${randomUUID()}`}, ${tenantId}, ${agentId}, ${draftVersionId}, ${boundFingerprint},
            1, 'draft', 'zip', ${tx.json(asJson(cases))}, ${tx.json(asJson(packageRefs))}, ${tx.json(asJson(missingDeps))},
            ${packageId}, ${actor.id}
          )
        `
      } else {
        const [current] = await tx<{ cases: ReleaseEvalCase[] }[]>`
          select cases from agent_release_submissions where tenant_id = ${tenantId} and id = ${submission.id}
        `
        const cases = parsed.cases.length ? parsed.cases.map(item => ({ ...item, id: `case-${randomUUID()}` })) : current!.cases
        await tx`
          update agent_release_submissions
             set agent_version_id = ${draftVersionId}, bound_fingerprint = ${boundFingerprint},
                 revision = revision + 1, source = 'zip', status = 'draft',
                 cases = ${tx.json(asJson(cases))}, package_refs = ${tx.json(asJson(packageRefs))},
                 missing_deps = ${tx.json(asJson(missingDeps))},
                 checks = '[]'::jsonb, plan = '[]'::jsonb,
                 sealed_revision = null, sealed_at = null,
                 package_id = ${packageId}, updated_at = now()
           where tenant_id = ${tenantId} and id = ${submission.id}
        `
      }
      })
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      await rm(finalDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    if (duplicate) {
      // 相同包重复导入：事务内未写入任何记录，本次落盘的包文件直接清掉。
      await rm(finalDir, { recursive: true, force: true }).catch(() => {})
      await this.audit(actor.id, 'agent.release.import', agentId, 'success', `重复导入相同发布包 ${fileName}（v${parsed.manifest.version}），返回既有治理状态`)
      return this.getReleaseState(agentId)
    }
    await this.audit(actor.id, 'agent.release.import', agentId, 'success', `导入发布包 ${fileName}（v${parsed.manifest.version}）`)
    return this.getReleaseState(agentId)
  }

  private async insertDraftVersion(
    tx: DatabaseTransaction,
    agentId: string,
    versionId: string,
    version: string,
    parsed: ReturnType<typeof parseAgentPackage>,
    resolved: { skills: string[]; tools: string[] },
    actorId: string,
  ) {
    await tx`
      insert into agent_versions (
        id, tenant_id, agent_id, version, name, description, welcome_message,
        example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
        timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
      ) values (
        ${versionId}, ${tenantId}, ${agentId}, ${version}, ${parsed.manifest.name},
        ${parsed.manifest.description}, ${parsed.definition.welcomeMessage},
        ${tx.json(asJson(parsed.definition.examplePrompts))}, ${parsed.definition.systemPrompt},
        ${tx.json(asJson(parsed.definition.roleIds))}, ${tx.json(asJson(parsed.definition.dataScopes))},
        ${parsed.definition.maxTokens}, ${parsed.definition.timeoutSeconds},
        ${tx.json(asJson(resolved.skills))}, ${tx.json(asJson(resolved.tools))},
        'draft', ${actorId}, 'ZIP 发布包导入'
      )
    `
  }

  private async updateDraftVersion(
    tx: DatabaseTransaction,
    draftVersionId: string,
    parsed: ReturnType<typeof parseAgentPackage>,
    resolved: { skills: string[]; tools: string[] },
  ): Promise<string> {
    const [conflict] = await tx<{ id: string }[]>`
      select av.id from agent_versions av
        join agent_versions draft on draft.tenant_id = av.tenant_id and draft.id = ${draftVersionId}
       where av.tenant_id = ${tenantId} and av.agent_id = draft.agent_id
         and av.version = ${parsed.manifest.version} and av.id <> ${draftVersionId}
    `
    if (conflict) throw new Error(`版本 v${parsed.manifest.version} 已存在于该 Agent 的版本记录中，请修改包内 version 后重新导入`)
    await tx`
      update agent_versions
         set version = ${parsed.manifest.version}, name = ${parsed.manifest.name},
             description = ${parsed.manifest.description}, welcome_message = ${parsed.definition.welcomeMessage},
             example_prompts = ${tx.json(asJson(parsed.definition.examplePrompts))},
             system_prompt = ${parsed.definition.systemPrompt},
             visible_role_ids = ${tx.json(asJson(parsed.definition.roleIds))},
             data_scopes = ${tx.json(asJson(parsed.definition.dataScopes))},
             max_tokens = ${parsed.definition.maxTokens}, timeout_seconds = ${parsed.definition.timeoutSeconds},
             skill_refs = ${tx.json(asJson(resolved.skills))}, tool_refs = ${tx.json(asJson(resolved.tools))},
             change_summary = 'ZIP 发布包导入'
       where tenant_id = ${tenantId} and id = ${draftVersionId} and status = 'draft'
    `
    return parsed.manifest.version
  }

  /**
   * 包声明版本的平台占用检查：版本号来自作者声明，平台绝不自动改写——已存在同号
   * 版本（配置创建或既往导入）即明确冲突，由调用方修改包内 version 后重导。
   */
  private async availableVersion(tx: DatabaseTransaction, agentId: string, wanted: string) {
    const [conflict] = await tx<{ id: string }[]>`
      select id from agent_versions where tenant_id = ${tenantId} and agent_id = ${agentId} and version = ${wanted}
    `
    if (conflict) {
      throw Object.assign(
        new Error(`版本 v${wanted} 已存在于该 Agent 的版本记录中，不能导入同号不同内容的包；请修改包内 version 后重新导入`),
        { status: 409, code: 'version_conflict' },
      )
    }
    return wanted
  }

  /** 声明依赖的平台解析：已发布/可用 → `id@version`，否则进 missing；已解析 Skill 的运行时依赖工具并入工具允许列表。 */
  private async resolveDeclared(declared: { skills: string[]; tools: string[] }) {
    const warnings: string[] = []
    const missingSkills: string[] = []
    const missingTools: string[] = []
    const resolvedSkills: string[] = []
    const resolvedTools: string[] = []

    const skillRows = this.skills ? await this.skills.getSkills() : []
    const toolRows = this.tools ? await this.tools.getTools() : []

    for (const reference of declared.skills) {
      const { id, version } = parseRef(reference)
      const skill = skillRows.find(item => item.id === id)
      if (!skill || skill.status === 'disabled' || !skill.activeVersion) {
        missingSkills.push(reference)
        continue
      }
      if (version === '—') {
        resolvedSkills.push(`${id}@${skill.activeVersion}`)
      } else if (await this.skillVersionPublished(id, version)) {
        resolvedSkills.push(`${id}@${version}`)
      } else {
        missingSkills.push(reference)
      }
    }
    for (const reference of declared.tools) {
      const { id, version } = parseRef(reference)
      const tool = toolRows.find(item => item.id === id)
      if (tool?.status === 'available') {
        resolvedTools.push(`${id}@${version === '—' ? (tool.version ?? '1.0.0') : version}`)
      } else {
        missingTools.push(reference)
      }
    }

    // 已解析 Skill 的运行时依赖工具必须显式进入 Agent 工具允许列表。
    if (resolvedSkills.length && this.skills) {
      const runtimeSkills = await this.skills.resolveRuntimeSkills(resolvedSkills)
      const selected = new Set(resolvedTools.map(reference => parseRef(reference).id))
      for (const dependency of [...new Set(runtimeSkills.flatMap(skill => skill.tools))]) {
        if (['activate_skill@1.0.0', 'python_execute@1.0.0'].includes(dependency)) continue
        const depId = parseRef(dependency).id
        if (selected.has(depId)) continue
        const tool = toolRows.find(item => item.id === depId)
        if (tool?.status === 'available') {
          resolvedTools.push(`${depId}@${tool.version ?? '1.0.0'}`)
        } else {
          missingTools.push(depId)
          warnings.push(`已解析 Skill 依赖的工具 ${depId} 未发布或不可用，标记「缺少工具」并阻塞试运行`)
        }
      }
    }
    for (const reference of missingSkills) warnings.push(`声明的 Skill ${reference} 未在平台发布，标记「缺少依赖」并阻塞试运行`)
    for (const reference of missingTools) warnings.push(`声明的工具 ${reference} 未在平台接入，标记「缺少工具」并阻塞试运行`)
    return {
      skills: [...new Set(resolvedSkills)],
      tools: [...new Set(resolvedTools)],
      missingSkills: [...new Set(missingSkills)],
      missingTools: [...new Set(missingTools)],
      warnings,
    }
  }

  private async skillVersionPublished(skillId: string, version: string): Promise<boolean> {
    const [row] = await this.database<{ id: string }[]>`
      select id from skill_versions
       where tenant_id = ${tenantId} and skill_id = ${skillId} and version = ${version} and status = 'published'
    `
    return Boolean(row)
  }

  private async storePackageFiles(targetDir: string, files: Record<string, Uint8Array>) {
    for (const [path, content] of Object.entries(files)) {
      const target = join(targetDir, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
  }

  /* ---------- 基础查询 ---------- */

  private async loadContext(agentId: string): Promise<AgentContext | undefined> {
    const [row] = await this.database<{
      id: string
      persistedStatus: string
      activeVersionId: string | null
      draftVersionId: string | null
      draftId: string | null
      draftVersion: string | null
      draftName: string | null
      draftDescription: string | null
      draftWelcomeMessage: string | null
      draftSystemPrompt: string | null
      draftRoleIds: string[] | null
      draftDataScopes: string[] | null
      draftExamplePrompts: string[] | null
      draftMaxTokens: number | null
      draftTimeoutSeconds: number | null
      draftSkills: string[] | null
      draftTools: string[] | null
    }[]>`
      select a.id, a.status as "persistedStatus", a.active_version_id as "activeVersionId",
             a.draft_version_id as "draftVersionId",
             draft.id as "draftId", draft.version as "draftVersion", draft.name as "draftName",
             draft.description as "draftDescription", draft.welcome_message as "draftWelcomeMessage",
             draft.system_prompt as "draftSystemPrompt", draft.visible_role_ids as "draftRoleIds",
             draft.data_scopes as "draftDataScopes", draft.example_prompts as "draftExamplePrompts",
             draft.max_tokens as "draftMaxTokens", draft.timeout_seconds as "draftTimeoutSeconds",
             draft.skill_refs as "draftSkills", draft.tool_refs as "draftTools"
        from agents a
        left join agent_versions draft on draft.tenant_id = a.tenant_id and draft.id = a.draft_version_id
       where a.tenant_id = ${tenantId} and a.id = ${agentId}
    `
    if (!row) return undefined
    return {
      id: row.id,
      persistedStatus: row.persistedStatus,
      activeVersionId: row.activeVersionId,
      draftVersionId: row.draftVersionId,
      ...(row.draftId ? {
        draft: {
          id: row.draftId,
          version: row.draftVersion!,
          name: row.draftName ?? '',
          description: row.draftDescription ?? '',
          welcomeMessage: row.draftWelcomeMessage ?? '',
          systemPrompt: row.draftSystemPrompt ?? '',
          roleIds: row.draftRoleIds ?? [],
          dataScopes: row.draftDataScopes ?? [],
          examplePrompts: row.draftExamplePrompts ?? [],
          maxTokens: row.draftMaxTokens ?? 12000,
          timeoutSeconds: row.draftTimeoutSeconds ?? 300,
          skills: row.draftSkills ?? [],
          tools: row.draftTools ?? [],
        },
      } : {}),
    }
  }

  private async requireContext(agentId: string): Promise<AgentContext> {
    const context = await this.loadContext(agentId)
    if (!context) throw Object.assign(new Error(`Agent 不存在：${agentId}`), { status: 404, code: 'agent_not_found' })
    if (!context.draft) throw new Error('当前 Agent 没有草稿版本，无法进入发布流程')
    return context
  }

  private async activeSubmission(agentId: string, db: DatabaseClient | DatabaseTransaction = this.database): Promise<SubmissionRow | undefined> {
    const [row] = await db<SubmissionRow[]>`
      select id, agent_id as "agentId", agent_version_id as "agentVersionId",
             bound_fingerprint as "boundFingerprint", revision, status, source,
             sealed_revision as "sealedRevision", sealed_at as "sealedAt",
             cases, package_refs as "packageRefs", missing_deps as "missingDeps",
             checks, plan, review_note as "reviewNote", package_id as "packageId"
        from agent_release_submissions
       where tenant_id = ${tenantId} and agent_id = ${agentId}
         and status in ('draft', 'submitted', 'changes_requested')
    `
    return row
  }

  private async requireSubmission(agentId: string, userId: string): Promise<SubmissionRow> {
    const context = await this.loadContext(agentId)
    if (!context?.draft) throw new Error('当前 Agent 没有草稿版本，无法进入发布流程')
    const draft = context.draft
    const actor = await this.requireActor(userId)
    return this.database.begin(async (tx) => {
      await tx`select id from agents where tenant_id = ${tenantId} and id = ${agentId} for update`
      let submission = await this.activeSubmission(agentId, tx)
      if (!submission) submission = await this.createSubmission(context, 'config', null, actor.id, tx)
      else if (submission.agentVersionId !== draft.id) submission = await this.rebindSubmission(submission, context, tx)
      else if (submission.boundFingerprint !== draftFingerprint(draft)) submission = await this.refreshSubmissionRevision(submission, context, tx)
      return submission
    })
  }

  private async createSubmission(context: AgentContext, source: 'config' | 'zip', packageId: string | null, actorId: string, db: DatabaseClient | DatabaseTransaction = this.database): Promise<SubmissionRow> {
    const draft = context.draft!
    const cases = defaultCases({
      name: draft.name, description: draft.description,
      examplePrompts: draft.examplePrompts, dataScopes: draft.dataScopes,
    })
    const [row] = await db<SubmissionRow[]>`
      insert into agent_release_submissions (
        id, tenant_id, agent_id, agent_version_id, bound_fingerprint, revision, status, source,
        cases, package_id, created_by
      ) values (
        ${`submission-${randomUUID()}`}, ${tenantId}, ${context.id}, ${draft.id},
        ${draftFingerprint(draft)}, 1, 'draft', ${source}, ${this.database.json(asJson(cases))}, ${packageId}, ${actorId}
      )
      returning id, agent_id as "agentId", agent_version_id as "agentVersionId",
                bound_fingerprint as "boundFingerprint", revision, status, source,
                sealed_revision as "sealedRevision", sealed_at as "sealedAt",
                cases, package_refs as "packageRefs", missing_deps as "missingDeps",
                checks, plan, review_note as "reviewNote", package_id as "packageId"
    `
    return row!
  }

  private async listTrials(submissionId: string): Promise<ReleaseTrialRun[]> {
    const rows = await this.database<{
      id: string; submissionRevision: number; status: ReleaseTrialRun['status']
      steps: TrialRunStep[]; startedAt: Date; finishedAt: Date | null; failureStage: string | null
    }[]>`
      select id, submission_revision as "submissionRevision", status, steps,
             started_at as "startedAt", finished_at as "finishedAt", failure_stage as "failureStage"
        from agent_trial_runs
       where tenant_id = ${tenantId} and submission_id = ${submissionId}
       order by started_at desc
    `
    return rows.map(row => ({
      id: row.id,
      submissionRevision: row.submissionRevision,
      status: row.status,
      steps: row.steps,
      startedAt: row.startedAt.toISOString(),
      ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
      ...(row.failureStage ? { failureStage: row.failureStage } : {}),
    }))
  }

  private async evidenceByVersion(agentId: string): Promise<Record<string, ReleaseEvidence[]>> {
    const rows = await this.database<{
      version: string; kind: ReleaseEvidence['kind']; summary: string; runId: string | null
      scope: string; by: string; at: Date
    }[]>`
      select av.version, e.kind, e.summary, e.run_id as "runId", e.scope,
             u.display_name as "by", e.created_at as "at"
        from agent_version_evidence e
        join agent_versions av on av.tenant_id = e.tenant_id and av.id = e.agent_version_id
        join users u on u.tenant_id = e.tenant_id and u.id = e.created_by
       where e.tenant_id = ${tenantId} and e.agent_id = ${agentId}
       order by e.created_at asc
    `
    const grouped: Record<string, ReleaseEvidence[]> = {}
    for (const row of rows) {
      const list = grouped[row.version] ?? (grouped[row.version] = [])
      list.push({
        kind: row.kind, summary: row.summary, scope: row.scope,
        by: row.by, at: row.at.toISOString(),
        ...(row.runId ? { runId: row.runId } : {}),
      })
    }
    return grouped
  }

  private async packageWarnings(packageId: string): Promise<string[]> {
    const [row] = await this.database<{ warnings: string[] }[]>`
      select warnings from agent_packages where tenant_id = ${tenantId} and id = ${packageId}
    `
    return row?.warnings ?? []
  }

  private async requireActor(userId: string) {
    const [actor] = await this.database<{ id: string; displayName: string; department: string }[]>`
      select u.id, u.display_name as "displayName", coalesce(u.department_id, '未分配部门') as department
        from users u where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and exists (
           select 1 from user_roles ur
           join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
            where ur.tenant_id = u.tenant_id and ur.user_id = u.id
              and (ur.valid_until is null or ur.valid_until > now())
              and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
         )
    `
    if (!actor) throw authorizationDenied(`操作人不存在、已停用或不是平台管理员：${userId}`)
    return actor
  }

  private async audit(actorId: string, action: string, objectId: string, result: 'success' | 'failed' | 'blocked', summary: string) {
    await this.database`
      insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
      values (${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actorId}, ${action}, 'agent', ${objectId}, ${result}, ${`trace-${randomUUID()}`}, ${this.database.json(asJson({ summary }))})
    `
  }
}
