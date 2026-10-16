import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { requirePlatformAdminActor } from '../authorization/platform-admin-actor.ts'
import type { PostgresSkillService } from '../skill/postgres-skill-service.ts'
import type { PostgresToolConnectorService } from '../tool/postgres-tool-connector-service.ts'
import type { PostgresAgentService } from './postgres-agent-service.ts'
import type { ReleaseTrialResult, ReleaseTrialRunner } from './release-trial-runner.ts'
import type { AgentDataCollectionRequirement } from './agent-spec.ts'
import { bindingBasisKey, toManifestToolBinding, type ManifestToolBinding } from '../../domain/tool-binding.ts'
import { DSH_WORK_EXECUTION_TOOL_REFS } from '../../domain/tool-category.ts'
import type { AgentMcpScope } from '../../domain/types.ts'
import { canonicalJson, sha256 } from '../runtime/canonical-json.ts'
import { RequestError, dependencyUnavailable, invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'

const tenantId = 'tenant-dsh-work'
const MAX_TEST_CASES = 20
const MAX_TEST_CASE_CHARS = 2000
/** Answers are kept in full for review up to this size. */
const MAX_OUTPUT_CHARS = 64 * 1024
const SKILL_EXECUTION_TOOLS = new Set(['activate_skill@1.0.0', 'python_execute@1.0.0'])

export type ValidationCaseSource = 'example' | 'routine' | 'custom'
export type ValidationCaseStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled'
export type ValidationStatus = 'running' | 'completed' | 'superseded' | 'published'

/** The three fixed machine checks. A case cannot be judged passed unless all hold. */
export interface ValidationChecks {
  runRecorded: boolean
  executionSucceeded: boolean
  outputNonEmpty: boolean
}

export interface ValidationCase {
  id: string
  position: number
  source: ValidationCaseSource
  sourceRef: string | null
  prompt: string
  status: ValidationCaseStatus
  runId: string | null
  attemptId: string | null
  runCount: number
  checks: ValidationChecks | null
  output: string
  error: string | null
  verdict: 'passed' | 'failed' | null
  verdictNote: string | null
  verdictBy: string | null
  verdictAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface AgentValidation {
  id: string
  agentId: string
  agentVersionId: string
  version: string
  status: ValidationStatus
  createdBy: string
  createdAt: string
  completedAt: string | null
  cases: ValidationCase[]
  /** Every case finished and judged passed: the candidate can be published. */
  publishable: boolean
}

export interface ReleaseCheck {
  id: 'audience' | 'principal' | 'dependencies' | 'authorization' | 'mcp' | 'data' | 'cases' | 'bindings'
  label: string
  passed: boolean
  detail: string
}

export interface PlannedCase {
  source: ValidationCaseSource
  sourceRef: string | null
  prompt: string
}

export interface AgentReleaseOverview {
  agentId: string
  activeVersion: { id: string; version: string } | null
  /** The editable working version (a draft, or the frozen candidate when nothing was edited since). */
  draft: { id: string; version: string; status: 'draft' | 'candidate' } | null
  /** The frozen version under validation, if any. */
  candidate: { id: string; version: string } | null
  /** A newer draft exists than the candidate under validation. */
  draftChanged: boolean
  testCases: Array<{ id: string; prompt: string }>
  /** Cases the next validation would run, from the working version. */
  plannedCases: PlannedCase[]
  /** Checks of the working version; a validation starts only when all pass. */
  checks: ReleaseCheck[]
  /** MCP calls are not executed in validation runs. */
  usesMcp: boolean
  validation: AgentValidation | null
}

export interface AgentVersionHistoryItem {
  id: string
  version: string
  status: 'draft' | 'candidate' | 'published' | 'disabled'
  summary: string
  createdAt: string
  createdBy: string
  publishedAt: string | null
  publishedBy: string | null
  active: boolean
}

interface VersionShape {
  id: string
  agentId: string
  version: string
  status: 'draft' | 'candidate' | 'published' | 'disabled'
  skills: string[]
  tools: string[]
  examplePrompts: string[]
  mcpScope: AgentMcpScope | null
  bindingRefs: ManifestToolBinding[]
  dataCollections: AgentDataCollectionRequirement[]
}

interface CaseRow {
  id: string
  validationId: string
  position: number
  source: ValidationCaseSource
  sourceRef: string | null
  prompt: string
  status: ValidationCaseStatus
  runId: string | null
  attemptId: string | null
  runCount: number
  checks: Partial<ValidationChecks>
  output: string
  error: string | null
  verdict: 'passed' | 'failed' | null
  verdictNote: string | null
  verdictBy: string | null
  verdictAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
}

interface ValidationRow {
  id: string
  agentId: string
  agentVersionId: string
  version: string
  sessionId: string
  status: ValidationStatus
  createdBy: string
  createdAt: Date
  completedAt: Date | null
}

function validationBlocked(message: string) {
  return new RequestError(409, 'validation_blocked', message)
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

/**
 * S3 验证与发布：点「验证」时草稿原地冻结为不可变的 candidate，案例（示例问题、主动任务
 * 提示词、自定义测试问题）在后台经 Run/Attempt → Runtime Adapter → DSH 并行执行；
 * 每个案例留下固定三项机器检查，管理员逐项判定，全部通过后发布。验证结论只绑定
 * 不可变的版本 ID，不再需要指纹、候选修订或封存修订。
 */
export class PostgresAgentValidationService {
  private readonly database: DatabaseClient
  private readonly agents: PostgresAgentService
  private readonly skills?: PostgresSkillService
  private readonly tools?: PostgresToolConnectorService
  private readonly runner?: ReleaseTrialRunner

  constructor(
    database: DatabaseClient,
    agents: PostgresAgentService,
    skills?: PostgresSkillService,
    tools?: PostgresToolConnectorService,
    runner?: ReleaseTrialRunner,
  ) {
    this.database = database
    this.agents = agents
    this.skills = skills
    this.tools = tools
    this.runner = runner
  }

  /* ---------- Reading ---------- */

  async getOverview(agentId: string): Promise<AgentReleaseOverview> {
    const [agent] = await this.database<{
      activeVersionId: string | null; activeVersion: string | null
      draftVersionId: string | null; draftVersion: string | null; draftStatus: VersionShape['status'] | null
    }[]>`
      select a.active_version_id as "activeVersionId", active.version as "activeVersion",
             a.draft_version_id as "draftVersionId", draft.version as "draftVersion", draft.status as "draftStatus"
        from agents a
        left join agent_versions active on active.tenant_id = a.tenant_id and active.id = a.active_version_id
        left join agent_versions draft on draft.tenant_id = a.tenant_id and draft.id = a.draft_version_id
       where a.tenant_id = ${tenantId} and a.id = ${agentId}
    `
    if (!agent) throw notFound(`Agent 不存在：${agentId}`)
    const validation = await this.latestValidation(agentId)
    const working = agent.draftVersionId ? await this.loadVersion(agent.draftVersionId) : null
    const candidate = working?.status === 'candidate'
      ? { id: working.id, version: working.version }
      : validation && ['running', 'completed'].includes(validation.status)
        ? { id: validation.agentVersionId, version: validation.version }
        : null
    return {
      agentId,
      activeVersion: agent.activeVersionId ? { id: agent.activeVersionId, version: agent.activeVersion ?? '' } : null,
      draft: working && (working.status === 'draft' || working.status === 'candidate')
        ? { id: working.id, version: working.version, status: working.status }
        : null,
      candidate,
      draftChanged: Boolean(candidate && working?.status === 'draft'),
      testCases: await this.listTestCases(agentId),
      plannedCases: working ? await this.plannedCases(agentId, working) : [],
      checks: working ? await this.checkVersion(agentId, working) : [],
      usesMcp: Boolean(working && working.mcpScope?.mode !== 'none'),
      validation,
    }
  }

  async getValidation(agentId: string, validationId: string): Promise<AgentValidation> {
    const row = await this.requireValidation(agentId, validationId)
    await this.reconcile(row.id)
    return this.toValidation((await this.requireValidation(agentId, validationId)))
  }

  async listVersions(agentId: string): Promise<AgentVersionHistoryItem[]> {
    const rows = await this.database<(Omit<AgentVersionHistoryItem, 'createdAt' | 'publishedAt'> & {
      createdAt: Date; publishedAt: Date | null
    })[]>`
      select av.id, av.version, av.status, av.change_summary as summary,
             av.created_at as "createdAt", creator.display_name as "createdBy",
             av.published_at as "publishedAt", publisher.display_name as "publishedBy",
             (a.active_version_id = av.id) as active
        from agent_versions av
        join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
        left join users creator on creator.tenant_id = av.tenant_id and creator.id = av.created_by
        left join users publisher on publisher.tenant_id = av.tenant_id and publisher.id = av.published_by
       where av.tenant_id = ${tenantId} and av.agent_id = ${agentId}
       order by split_part(av.version, '.', 1)::integer desc,
                split_part(av.version, '.', 2)::integer desc,
                split_part(av.version, '.', 3)::integer desc
    `
    return rows.map(row => ({
      ...row,
      createdBy: row.createdBy ?? '',
      createdAt: row.createdAt.toISOString(),
      publishedAt: iso(row.publishedAt),
      publishedBy: row.publishedBy ?? null,
      active: Boolean(row.active),
    }))
  }

  /* ---------- Custom test questions ---------- */

  async replaceTestCases(agentId: string, userId: string, prompts: unknown): Promise<AgentReleaseOverview> {
    const actor = await requirePlatformAdminActor(this.database, userId)
    if (!Array.isArray(prompts) || prompts.length > MAX_TEST_CASES
      || prompts.some(item => typeof item !== 'string' || !item.trim() || item.length > MAX_TEST_CASE_CHARS)) {
      throw invalidRequest(`自定义测试问题最多 ${MAX_TEST_CASES} 条，每条 1～${MAX_TEST_CASE_CHARS} 字`)
    }
    const values = (prompts as string[]).map(item => item.trim())
    await this.database.begin(async tx => {
      const [agent] = await tx`select id from agents where tenant_id = ${tenantId} and id = ${agentId} for update`
      if (!agent) throw notFound(`Agent 不存在：${agentId}`)
      await tx`delete from agent_test_cases where tenant_id = ${tenantId} and agent_id = ${agentId}`
      for (const [position, prompt] of values.entries()) {
        await tx`
          insert into agent_test_cases (id, tenant_id, agent_id, position, prompt, created_by)
          values (${`agent-test-case-${randomUUID()}`}, ${tenantId}, ${agentId}, ${position}, ${prompt}, ${actor.id})
        `
      }
    })
    await this.audit(actor.id, 'agent.validation.test-cases', agentId, `自定义测试问题 ${values.length} 条`)
    return this.getOverview(agentId)
  }

  /* ---------- Validation ---------- */

  /**
   * Freezes the working version (unless it is already a frozen candidate), snapshots the
   * cases and starts them in the background. Returns as soon as the cases are queued.
   */
  async startValidation(agentId: string, userId: string): Promise<AgentReleaseOverview> {
    const actor = await requirePlatformAdminActor(this.database, userId)
    const [agent] = await this.database<{ draftVersionId: string | null }[]>`
      select draft_version_id as "draftVersionId" from agents where tenant_id = ${tenantId} and id = ${agentId}
    `
    if (!agent) throw notFound(`Agent 不存在：${agentId}`)
    if (!agent.draftVersionId) throw stateConflict('当前 Agent 没有待验证的草稿；先编辑配置生成新版本')
    const working = await this.loadVersion(agent.draftVersionId)
    if (!working || (working.status !== 'draft' && working.status !== 'candidate')) {
      throw stateConflict('当前 Agent 没有待验证的草稿；先编辑配置生成新版本')
    }
    const checks = await this.checkVersion(agentId, working)
    const failed = checks.filter(check => !check.passed)
    if (failed.length) throw validationBlocked(`验证前检查未通过：${failed.map(check => `${check.label}（${check.detail}）`).join('；')}`)
    const cases = await this.plannedCases(agentId, working)
    // Pins are resolved before the lock: binding resolution may materialize revisions.
    const pins = await this.resolvePins(agentId, working, actor.id)
    // A frozen candidate whose tool bindings changed since freezing can never be published;
    // validating again freezes a fresh copy of the same content as a new version.
    const refreeze = working.status === 'candidate' && bindingBasisKey(pins) !== bindingBasisKey(working.bindingRefs)

    const supersededRuns: string[] = []
    const { validationId, versionId, version } = await this.database.begin(async tx => {
      const [locked] = await tx<{ draftVersionId: string | null }[]>`
        select draft_version_id as "draftVersionId" from agents
         where tenant_id = ${tenantId} and id = ${agentId} for update
      `
      if (locked?.draftVersionId !== working.id) throw stateConflict('草稿已变化，请刷新后重新验证')
      let target = { id: working.id, version: working.version }
      if (refreeze) {
        target = await this.cloneAsCandidate(tx, agentId, working, pins, actor.id)
      } else if (working.status === 'draft') {
        const frozen = await tx`
          update agent_versions set status = 'candidate', binding_refs = ${tx.json(pins as never)}
           where tenant_id = ${tenantId} and id = ${working.id} and status = 'draft'
          returning id
        `
        if (!frozen.length) throw stateConflict('草稿已变化，请刷新后重新验证')
      }
      const live = await tx<{ id: string }[]>`
        update agent_validations set status = 'superseded', completed_at = coalesce(completed_at, now())
         where tenant_id = ${tenantId} and agent_id = ${agentId} and status in ('running', 'completed')
        returning id
      `
      if (live.length) {
        const pending = await tx<{ runId: string }[]>`
          update agent_validation_cases set status = 'cancelled', finished_at = now(),
                 error = coalesce(error, '已开始新的验证')
           where tenant_id = ${tenantId} and validation_id = any(${live.map(item => item.id)})
             and status in ('queued', 'running')
          returning run_id as "runId"
        `
        supersededRuns.push(...pending.map(item => item.runId).filter(Boolean))
      }
      const sessionId = `admin-session-${randomUUID()}`
      await tx`
        insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
        values (${sessionId}, ${tenantId}, ${actor.id}, ${`验证 ${agentId} v${target.version}`}, 'active', 'admin', null, null)
      `
      const id = `agent-validation-${randomUUID()}`
      await tx`
        insert into agent_validations (id, tenant_id, agent_id, agent_version_id, session_id, status, created_by)
        values (${id}, ${tenantId}, ${agentId}, ${target.id}, ${sessionId}, 'running', ${actor.id})
      `
      for (const [position, item] of cases.entries()) {
        await tx`
          insert into agent_validation_cases (id, tenant_id, validation_id, position, source, source_ref, prompt)
          values (${`agent-validation-case-${randomUUID()}`}, ${tenantId}, ${id}, ${position},
                  ${item.source}, ${item.sourceRef}, ${item.prompt})
        `
      }
      return { validationId: id, versionId: target.id, version: target.version }
    })
    for (const runId of supersededRuns) {
      await this.runner?.systemCancelRun(runId, 'system_revoke', '已开始新的验证，取消旧验证中未完成的案例').catch(() => undefined)
    }
    await this.audit(actor.id, 'agent.validation.start', agentId,
      `验证 v${version}（${versionId}），${cases.length} 个案例${refreeze ? '；工具绑定已变化，重新冻结为新版本' : ''}`)
    const rows = await this.caseRows(validationId)
    for (const row of rows) await this.startCase(validationId, row, actor.id)
    return this.getOverview(agentId)
  }

  async rerunCase(agentId: string, validationId: string, caseId: string, userId: string): Promise<AgentValidation> {
    const actor = await requirePlatformAdminActor(this.database, userId)
    const validation = await this.requireLiveValidation(agentId, validationId)
    await this.reconcile(validation.id)
    const row = (await this.caseRows(validation.id)).find(item => item.id === caseId)
    if (!row) throw notFound(`验证案例不存在：${caseId}`)
    if (row.status === 'queued' || row.status === 'running') throw stateConflict('该案例仍在运行，结束后才能重跑')
    await this.database`
      update agent_validations set status = 'running', completed_at = null
       where tenant_id = ${tenantId} and id = ${validation.id} and status in ('running', 'completed')
    `
    await this.startCase(validation.id, row, actor.id)
    await this.audit(actor.id, 'agent.validation.rerun', agentId, `重跑案例 ${row.position + 1}`)
    return this.getValidation(agentId, validation.id)
  }

  async setVerdict(
    agentId: string, validationId: string, caseId: string, userId: string,
    input: { verdict: unknown; note?: unknown },
  ): Promise<AgentValidation> {
    const actor = await requirePlatformAdminActor(this.database, userId)
    if (input.verdict !== 'passed' && input.verdict !== 'failed') throw invalidRequest('判定只能是 passed 或 failed')
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (note.length > 2000) throw invalidRequest('判定说明最多 2000 字')
    if (input.verdict === 'failed' && !note) throw invalidRequest('判为不通过时必须填写原因')
    const validation = await this.requireLiveValidation(agentId, validationId)
    await this.reconcile(validation.id)
    const row = (await this.caseRows(validation.id)).find(item => item.id === caseId)
    if (!row) throw notFound(`验证案例不存在：${caseId}`)
    if (row.status === 'queued' || row.status === 'running') throw stateConflict('案例尚未运行结束，不能判定')
    if (input.verdict === 'passed' && !allChecksPassed(row)) {
      throw stateConflict('机器检查未全部通过（留下运行记录、执行成功、回答非空），不能判为通过')
    }
    const updated = await this.database`
      update agent_validation_cases
         set verdict = ${input.verdict}, verdict_note = ${note || null}, verdict_by = ${actor.id}, verdict_at = now()
       where tenant_id = ${tenantId} and id = ${caseId} and validation_id = ${validation.id}
         and status not in ('queued', 'running') and run_count = ${row.runCount}
      returning id
    `
    if (!updated.length) throw stateConflict('案例已重新运行，请刷新后再判定')
    await this.audit(actor.id, 'agent.validation.verdict', agentId,
      `案例 ${row.position + 1} 判为${input.verdict === 'passed' ? '通过' : `不通过：${note}`}`)
    return this.getValidation(agentId, validation.id)
  }

  /**
   * Publishes the validated candidate. All checks run again under the Agent and principal
   * locks; publication moves the current-version pointer and never changes the version.
   */
  async publish(agentId: string, userId: string, input: { validationId: unknown; note?: unknown }): Promise<AgentReleaseOverview> {
    const actor = await requirePlatformAdminActor(this.database, userId)
    if (typeof input.validationId !== 'string' || !input.validationId) throw invalidRequest('缺少验证标识')
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 2000) : ''
    const validation = await this.requireLiveValidation(agentId, input.validationId)
    await this.reconcile(validation.id)
    const candidate = await this.loadVersion(validation.agentVersionId)
    if (!candidate || candidate.status !== 'candidate') throw stateConflict('待发布版本已变化，请重新验证')
    const checks = (await this.checkVersion(agentId, candidate)).filter(check => check.id !== 'cases')
    const failed = checks.filter(check => !check.passed)
    if (failed.length) throw validationBlocked(`发布前检查未通过：${failed.map(check => `${check.label}（${check.detail}）`).join('；')}`)

    const version = await this.database.begin(async tx => {
      const [agent] = await tx<{ draftVersionId: string | null; activeVersionId: string | null }[]>`
        select draft_version_id as "draftVersionId", active_version_id as "activeVersionId"
          from agents where tenant_id = ${tenantId} and id = ${agentId} for update
      `
      if (!agent) throw notFound(`Agent 不存在：${agentId}`)
      const [locked] = await tx<{ status: ValidationStatus; agentVersionId: string }[]>`
        select status, agent_version_id as "agentVersionId" from agent_validations
         where tenant_id = ${tenantId} and id = ${validation.id} for update
      `
      if (!locked || locked.status !== 'completed') throw stateConflict('验证尚未完成或已被新的验证取代')
      const cases = await tx<{ status: ValidationCaseStatus; verdict: string | null; checks: Partial<ValidationChecks> }[]>`
        select status, verdict, checks from agent_validation_cases
         where tenant_id = ${tenantId} and validation_id = ${validation.id}
      `
      if (!cases.length) throw stateConflict('验证没有案例，不能发布')
      if (cases.some(item => item.verdict !== 'passed' || !allChecksPassed(item))) {
        throw stateConflict('全部案例判定通过后才能发布')
      }
      await tx`
        select id from execution_principals where tenant_id = ${tenantId} and kind = 'agent'
          and agent_id = ${agentId} for update
      `
      await this.assertPublishable(tx, agentId, candidate)
      const published = await tx`
        update agent_versions set status = 'published', published_at = now(), published_by = ${actor.id}
         where tenant_id = ${tenantId} and id = ${candidate.id} and status = 'candidate'
        returning id
      `
      if (!published.length) throw stateConflict('待发布版本已变化，请刷新后重试')
      // Publication does not re-enable a disabled Agent; that stays a separate action.
      await tx`
        update agents a
           set active_version_id = av.id, name = av.name, description = av.description,
               welcome_message = av.welcome_message,
               draft_version_id = case when a.draft_version_id = av.id then null else a.draft_version_id end,
               status = case when a.status = 'disabled' then 'disabled' else 'published' end,
               updated_at = now()
          from agent_versions av
         where a.tenant_id = ${tenantId} and a.id = ${agentId}
           and av.tenant_id = a.tenant_id and av.id = ${candidate.id}
      `
      await tx`
        update agent_validations set status = 'published', completed_at = coalesce(completed_at, now())
         where tenant_id = ${tenantId} and id = ${validation.id}
      `
      return candidate.version
    })
    await this.audit(actor.id, 'agent.release.publish', agentId,
      `发布 v${version}（验证 ${validation.id}）${note ? `：${note}` : ''}`)
    return this.getOverview(agentId)
  }

  /** Startup: cases queued before a crash never got a Run; mark them interrupted. */
  async recoverInterruptedValidations(): Promise<{ interrupted: number }> {
    const rows = await this.database<{ validationId: string }[]>`
      update agent_validation_cases
         set status = 'interrupted', error = '服务重启中断', finished_at = now(),
             checks = ${this.database.json({ runRecorded: false, executionSucceeded: false, outputNonEmpty: false })}
       where tenant_id = ${tenantId} and status = 'queued' and run_id is null
      returning validation_id as "validationId"
    `
    for (const validationId of new Set(rows.map(row => row.validationId))) await this.finishIfDone(validationId)
    return { interrupted: rows.length }
  }

  /* ---------- Case execution ---------- */

  private async startCase(validationId: string, row: CaseRow, actorId: string): Promise<void> {
    const runCount = row.runCount + 1
    const claimed = await this.database<{ sessionId: string; agentVersionId: string }[]>`
      update agent_validation_cases c
         set status = 'queued', run_id = null, attempt_id = null, run_count = ${runCount},
             checks = '{}'::jsonb, output = '', error = null, verdict = null, verdict_note = null,
             verdict_by = null, verdict_at = null, started_at = now(), finished_at = null
        from agent_validations v
       where c.tenant_id = ${tenantId} and c.id = ${row.id} and c.run_count = ${row.runCount}
         and v.tenant_id = c.tenant_id and v.id = c.validation_id
      returning v.session_id as "sessionId", v.agent_version_id as "agentVersionId"
    `
    const target = claimed[0]
    if (!target) return
    if (!this.runner) {
      await this.failCase(row.id, runCount, '验证执行链路未接入：缺少 Run/Attempt 编排服务')
      await this.finishIfDone(validationId)
      return
    }
    try {
      const { runId } = await this.runner.startReleaseTrialCase({
        userId: actorId,
        sessionId: target.sessionId,
        agentVersionId: target.agentVersionId,
        message: row.prompt,
        idempotencyKey: `${row.id}-${runCount}`,
      })
      await this.database`
        update agent_validation_cases set status = 'running', run_id = ${runId}
         where tenant_id = ${tenantId} and id = ${row.id} and run_count = ${runCount} and status = 'queued'
      `
    } catch (error) {
      await this.failCase(row.id, runCount, error instanceof Error ? error.message : String(error))
      await this.finishIfDone(validationId)
    }
  }

  private async failCase(caseId: string, runCount: number, message: string) {
    await this.database`
      update agent_validation_cases
         set status = 'failed', error = ${message.slice(0, 2000)}, finished_at = now(),
             checks = ${this.database.json({ runRecorded: false, executionSucceeded: false, outputNonEmpty: false })}
       where tenant_id = ${tenantId} and id = ${caseId} and run_count = ${runCount} and status in ('queued', 'running')
    `
  }

  /** Folds finished case Runs into their case rows. Safe to call repeatedly and concurrently. */
  private async reconcile(validationId: string): Promise<void> {
    if (!this.runner) return
    const running = (await this.caseRows(validationId)).filter(row => row.status === 'running' && row.runId)
    for (const row of running) {
      const result = await this.runner.getReleaseTrialResult(row.runId!)
      if (!result) {
        await this.failCase(row.id, row.runCount, '验证案例的执行记录不存在')
        continue
      }
      const outcome = caseOutcome(result)
      if (!outcome) continue
      await this.database`
        update agent_validation_cases
           set status = ${outcome.status}, attempt_id = ${result.attemptId},
               checks = ${this.database.json(outcome.checks as never)},
               output = ${result.output.slice(0, MAX_OUTPUT_CHARS)}, error = ${outcome.error},
               finished_at = now()
         where tenant_id = ${tenantId} and id = ${row.id} and run_id = ${row.runId}
           and run_count = ${row.runCount} and status = 'running'
      `
    }
    await this.finishIfDone(validationId)
  }

  private async finishIfDone(validationId: string) {
    await this.database`
      update agent_validations v set status = 'completed', completed_at = now()
       where v.tenant_id = ${tenantId} and v.id = ${validationId} and v.status = 'running'
         and not exists (
           select 1 from agent_validation_cases c
            where c.tenant_id = v.tenant_id and c.validation_id = v.id and c.status in ('queued', 'running')
         )
    `
  }

  /* ---------- Checks ---------- */

  /** Checks of one version against the Agent's current access, dependencies and data grants. */
  private async checkVersion(agentId: string, version: VersionShape): Promise<ReleaseCheck[]> {
    const [agent] = await this.database<{ visibleRoleIds: string[] }[]>`
      select visible_role_ids as "visibleRoleIds" from agents where tenant_id = ${tenantId} and id = ${agentId}
    `
    const audience = agent?.visibleRoleIds ?? []
    const activeAudience = audience.length ? await this.database<{ id: string }[]>`
      select id from roles where tenant_id = ${tenantId} and status = 'active' and id = any(${audience})
    ` : []
    const principal = await this.agents.getAgentExecutionPrincipal(agentId)
    const missing: string[] = []
    for (const reference of version.skills) {
      try { await this.skills?.assertPublishedReferences([reference]) } catch { missing.push(reference) }
    }
    for (const reference of version.tools) {
      try { await this.tools?.assertAvailableReferences([reference]) } catch { missing.push(reference) }
    }
    let authorizationError: string | undefined
    try {
      await this.tools?.assertAuthorizationCompatibility(version.tools, principal.roleIds, principal.dataScopes)
      if (this.skills && !missing.length) {
        const runtimeSkills = await this.skills.resolveRuntimeSkills(version.skills)
        const declared = new Set(version.tools)
        const absent = [...new Set(runtimeSkills.flatMap(skill => skill.tools))]
          .filter(reference => !SKILL_EXECUTION_TOOLS.has(reference) && !declared.has(reference))
        if (absent.length) authorizationError = `所选 Skill 依赖的工具未声明：${absent.join('、')}`
      }
    } catch (error) {
      authorizationError = error instanceof Error ? error.message : String(error)
    }
    let mcpError: string | undefined
    if (version.mcpScope?.mode === 'selected') {
      try {
        if (!this.tools) throw new Error('MCP Connector 服务未接入')
        await this.tools.resolveMcpConnectionsForAgentVersion(version.id)
      } catch (error) {
        mcpError = error instanceof Error ? error.message : String(error)
      }
    }
    let dataError: string | undefined
    if (version.dataCollections.length) {
      try {
        await this.database.begin(tx => this.assertDataRequirements(tx, version.id, agentId))
      } catch (error) {
        dataError = error instanceof Error ? error.message : String(error)
      }
    }
    const examples = version.examplePrompts.filter(item => item.trim())
    const audienceError = !audience.length ? '请在岗位权限中选择至少一个可见角色'
      : activeAudience.length !== audience.length ? '可见角色包含不存在或已停用的角色' : undefined
    return [
      { id: 'audience', label: '可见角色', passed: !audienceError, detail: audienceError ?? `${audience.length} 个当前有效角色可以请求工作` },
      {
        id: 'principal', label: '执行身份', passed: principal.status === 'active',
        detail: principal.status === 'active' ? '执行身份有效' : '执行身份已停用',
      },
      {
        id: 'dependencies', label: '能力依赖', passed: !missing.length,
        detail: missing.length ? `不可用：${missing.join('、')}` : '所有 Skill 与工具均为可用的已发布版本',
      },
      {
        id: 'authorization', label: '能力所需授权', passed: !authorizationError,
        detail: authorizationError ?? '已声明的能力都已获授权',
      },
      {
        id: 'mcp', label: 'MCP 范围', passed: !mcpError,
        detail: mcpError ?? (version.mcpScope?.mode === 'none' ? '不使用 MCP' : '可用；验证中不执行 MCP 调用'),
      },
      {
        id: 'data', label: '工作数据', passed: !dataError,
        detail: dataError ?? (version.dataCollections.length ? '声明的集合与当前授权兼容' : '未声明工作数据集合'),
      },
      {
        id: 'cases', label: '验证案例', passed: examples.length > 0,
        detail: examples.length ? `${examples.length} 条示例问题` : '至少需要 1 条员工端示例问题',
      },
    ]
  }

  /** Publication gate inside the locked transaction: current access and frozen bindings. */
  private async assertPublishable(tx: DatabaseTransaction, agentId: string, candidate: VersionShape) {
    const [agent] = await tx<{ visibleRoleIds: string[] }[]>`
      select visible_role_ids as "visibleRoleIds" from agents where tenant_id = ${tenantId} and id = ${agentId}
    `
    const audience = agent?.visibleRoleIds ?? []
    if (!audience.length) throw validationBlocked('发布前必须在岗位权限中配置可见角色')
    const activeAudience = await tx<{ id: string }[]>`
      select id from roles where tenant_id = ${tenantId} and status = 'active' and id = any(${audience})
    `
    if (activeAudience.length !== audience.length) throw validationBlocked('可见角色已失效，请在岗位权限中更新')
    const principal = await this.agents.getAgentExecutionPrincipal(agentId, tx)
    if (principal.status !== 'active') throw validationBlocked('Agent 执行身份已停用')
    await this.tools?.assertAuthorizationCompatibility(candidate.tools, principal.roleIds, principal.dataScopes)
    // Widening grants keeps the candidate's frozen default tools; narrowing that withdraws a
    // frozen tool, or a binding that drifted since freezing, fails closed.
    const declared = candidate.tools.filter(reference => !DSH_WORK_EXECUTION_TOOL_REFS.has(reference))
    const defaults = this.tools
      ? await this.tools.resolvePlatformDefaultToolReferences(principal.roleIds, principal.dataScopes)
      : []
    const allowed = new Set([...declared, ...defaults])
    const withdrawn = candidate.bindingRefs.filter(pin => !allowed.has(pin.tool)).map(pin => pin.tool)
    if (withdrawn.length) throw validationBlocked(`岗位权限收窄后不再获准的工具：${withdrawn.join('、')}，请重新验证`)
    if (declared.some(reference => !candidate.bindingRefs.some(pin => pin.tool === reference))) {
      throw validationBlocked('待发布版本缺少工具的固定绑定，请重新验证')
    }
    if (candidate.bindingRefs.length) {
      if (!this.tools) throw new Error('工具绑定复核服务未接入')
      try {
        await this.tools.assertActiveToolBindings(candidate.bindingRefs, tx)
      } catch (error) {
        throw validationBlocked(`固定的工具绑定已失效，请重新验证：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (candidate.mcpScope?.mode === 'selected') {
      if (!this.tools) throw new Error('MCP Connector 服务未接入')
      await this.tools.resolveMcpConnectionsForAgentVersion(candidate.id)
    }
    await this.assertDataRequirements(tx, candidate.id, agentId)
  }

  /** Copies a candidate's content into a new frozen version with current bindings. */
  private async cloneAsCandidate(
    tx: DatabaseTransaction, agentId: string, source: VersionShape, pins: ManifestToolBinding[], actorId: string,
  ): Promise<{ id: string; version: string }> {
    const [latest] = await tx<{ version: string }[]>`
      select version from agent_versions
       where tenant_id = ${tenantId} and agent_id = ${agentId}
       order by split_part(version, '.', 1)::integer desc,
                split_part(version, '.', 2)::integer desc,
                split_part(version, '.', 3)::integer desc
       limit 1
    `
    const [major = 0, minor = 0] = (latest?.version ?? source.version).split('.').map(Number)
    const version = `${major}.${minor + 1}.0`
    const id = `agent-version-${randomUUID()}`
    await tx`
      insert into agent_versions
      select (jsonb_populate_record(null::agent_versions, to_jsonb(av) || jsonb_build_object(
        'id', ${id}::text, 'version', ${version}::text, 'status', 'candidate',
        'binding_refs', ${tx.json(pins as never)}::jsonb, 'source_version', av.version,
        'created_by', ${actorId}::text, 'created_at', now(), 'published_at', null, 'published_by', null,
        'change_summary', '工具绑定变化后重新冻结',
        'agent_spec', case when av.agent_spec is null then null
          else jsonb_set(av.agent_spec, '{metadata,version}', to_jsonb(${version}::text)) end
      ))).*
        from agent_versions av
       where av.tenant_id = ${tenantId} and av.id = ${source.id}
    `
    await tx`
      update agents set draft_version_id = ${id}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${agentId}
    `
    return { id, version }
  }

  private async resolvePins(agentId: string, version: VersionShape, actorId: string): Promise<ManifestToolBinding[]> {
    if (!this.tools) return []
    const principal = await this.agents.getAgentExecutionPrincipal(agentId)
    try {
      const defaults = await this.tools.resolvePlatformDefaultToolReferences(principal.roleIds, principal.dataScopes)
      const bindings = await this.tools.resolveToolBindings([...new Set([...version.tools, ...defaults])], actorId)
      return bindings.map(toManifestToolBinding)
    } catch (error) {
      throw validationBlocked(`工具绑定解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async assertDataRequirements(tx: DatabaseTransaction, agentVersionId: string, agentId: string): Promise<void> {
    const [definition] = await tx<{ collections: AgentDataCollectionRequirement[] }[]>`
      select coalesce(agent_spec #> '{data,collections}', '[]'::jsonb) as collections
        from agent_versions where tenant_id = ${tenantId} and id = ${agentVersionId}
    `
    if (!definition) throw dependencyUnavailable('Agent 数据声明不可用')
    const grants = await tx<{ scopeValue: string }[]>`
      select g.scope_value as "scopeValue" from agent_principal_scope_grants g
        join execution_principals p on p.tenant_id = g.tenant_id and p.id = g.principal_id
       where g.tenant_id = ${tenantId} and p.agent_id = ${agentId} and p.status = 'active'
    `
    const currentScopes = new Set(grants.map(item => item.scopeValue))
    for (const requirement of definition.collections) {
      const neededScope = requirement.scope === 'tenant' ? 'enterprise:authorized'
        : requirement.scope === 'workspace' ? 'workspace:authorized' : null
      if (neededScope && !currentScopes.has(neededScope)) {
        throw stateConflict(`集合 ${requirement.key} 所需的数据范围 ${neededScope} 未授予 Agent 身份`)
      }
      const [bound] = await tx<{ scope: string; version: number; schema: Record<string, unknown>; actions: string[] }[]>`
        select c.access_scope as scope, c.schema_version as version, c.schema_json as schema, g.actions
          from agent_data_collections c
          join agent_data_collection_grants g on g.tenant_id = c.tenant_id and g.collection_id = c.id
          join agent_installations i on i.tenant_id = g.tenant_id and i.id = g.agent_installation_id
         where c.tenant_id = ${tenantId} and c.collection_key = ${requirement.key}
           and c.status = 'active' and i.agent_id = ${agentId}
         for share of c, g
      `
      if (!bound || bound.scope !== requirement.scope || bound.version !== requirement.schemaVersion
        || requirement.actions.some(action => !bound.actions.includes(action))
        || (requirement.schema && sha256(canonicalJson(requirement.schema.body)) !== sha256(canonicalJson(bound.schema)))) {
        throw stateConflict(`集合 ${requirement.key} 未发布、版本不兼容或缺少当前授权`)
      }
    }
  }

  /* ---------- Queries ---------- */

  private async plannedCases(agentId: string, version: VersionShape): Promise<PlannedCase[]> {
    const examples = version.examplePrompts.map(prompt => prompt.trim()).filter(Boolean)
      .map(prompt => ({ source: 'example' as const, sourceRef: null, prompt }))
    const routines = await this.database<{ id: string; prompt: string | null }[]>`
      select id, input_template->>'prompt' as prompt from agent_routines
       where tenant_id = ${tenantId} and agent_id = ${agentId} and status <> 'disabled'
       order by created_at
    `
    const custom = await this.listTestCases(agentId)
    return [
      ...examples,
      ...routines.filter(item => item.prompt?.trim())
        .map(item => ({ source: 'routine' as const, sourceRef: item.id, prompt: item.prompt!.trim() })),
      ...custom.map(item => ({ source: 'custom' as const, sourceRef: item.id, prompt: item.prompt })),
    ]
  }

  private async listTestCases(agentId: string) {
    return this.database<{ id: string; prompt: string }[]>`
      select id, prompt from agent_test_cases
       where tenant_id = ${tenantId} and agent_id = ${agentId} order by position
    `
  }

  private async loadVersion(versionId: string): Promise<VersionShape | undefined> {
    const [row] = await this.database<VersionShape[]>`
      select id, agent_id as "agentId", version, status, skill_refs as skills, tool_refs as tools,
             example_prompts as "examplePrompts", mcp_scope as "mcpScope",
             coalesce(binding_refs, '[]'::jsonb) as "bindingRefs",
             coalesce(agent_spec #> '{data,collections}', '[]'::jsonb) as "dataCollections"
        from agent_versions where tenant_id = ${tenantId} and id = ${versionId}
    `
    return row
  }

  private async latestValidation(agentId: string): Promise<AgentValidation | null> {
    const [row] = await this.database<{ id: string }[]>`
      select id from agent_validations where tenant_id = ${tenantId} and agent_id = ${agentId}
       order by (status in ('running', 'completed')) desc, created_at desc limit 1
    `
    if (!row) return null
    await this.reconcile(row.id)
    const validation = await this.validationRow(row.id)
    return validation ? this.toValidation(validation) : null
  }

  private async requireValidation(agentId: string, validationId: string): Promise<ValidationRow> {
    const row = await this.validationRow(validationId)
    if (!row || row.agentId !== agentId) throw notFound(`验证不存在：${validationId}`)
    return row
  }

  private async requireLiveValidation(agentId: string, validationId: string): Promise<ValidationRow> {
    const row = await this.requireValidation(agentId, validationId)
    if (row.status !== 'running' && row.status !== 'completed') throw stateConflict('该验证已被新的验证取代或已发布')
    return row
  }

  private async validationRow(validationId: string): Promise<ValidationRow | undefined> {
    const [row] = await this.database<ValidationRow[]>`
      select v.id, v.agent_id as "agentId", v.agent_version_id as "agentVersionId", av.version,
             v.session_id as "sessionId", v.status, coalesce(u.display_name, v.created_by) as "createdBy",
             v.created_at as "createdAt", v.completed_at as "completedAt"
        from agent_validations v
        join agent_versions av on av.tenant_id = v.tenant_id and av.id = v.agent_version_id
        left join users u on u.tenant_id = v.tenant_id and u.id = v.created_by
       where v.tenant_id = ${tenantId} and v.id = ${validationId}
    `
    return row
  }

  private async caseRows(validationId: string): Promise<CaseRow[]> {
    return this.database<CaseRow[]>`
      select c.id, c.validation_id as "validationId", c.position, c.source, c.source_ref as "sourceRef",
             c.prompt, c.status, c.run_id as "runId", c.attempt_id as "attemptId", c.run_count as "runCount",
             c.checks, c.output, c.error, c.verdict, c.verdict_note as "verdictNote",
             coalesce(u.display_name, c.verdict_by) as "verdictBy", c.verdict_at as "verdictAt",
             c.started_at as "startedAt", c.finished_at as "finishedAt"
        from agent_validation_cases c
        left join users u on u.tenant_id = c.tenant_id and u.id = c.verdict_by
       where c.tenant_id = ${tenantId} and c.validation_id = ${validationId}
       order by c.position
    `
  }

  private async toValidation(row: ValidationRow): Promise<AgentValidation> {
    const cases = (await this.caseRows(row.id)).map(toCase)
    return {
      id: row.id,
      agentId: row.agentId,
      agentVersionId: row.agentVersionId,
      version: row.version,
      status: row.status,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      completedAt: iso(row.completedAt),
      cases,
      publishable: row.status === 'completed' && cases.length > 0
        && cases.every(item => item.verdict === 'passed' && item.checks !== null
          && item.checks.runRecorded && item.checks.executionSucceeded && item.checks.outputNonEmpty),
    }
  }

  private async audit(actorId: string, action: string, agentId: string, summary: string) {
    await this.database`
      insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
      values (${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actorId}, ${action}, 'agent', ${agentId}, 'success',
              ${`trace-${randomUUID()}`}, ${this.database.json({ summary })})
    `
  }
}

function allChecksPassed(row: { checks: Partial<ValidationChecks>; status?: string }) {
  return row.checks.runRecorded === true && row.checks.executionSucceeded === true && row.checks.outputNonEmpty === true
}

function caseOutcome(result: ReleaseTrialResult): {
  status: Extract<ValidationCaseStatus, 'succeeded' | 'failed' | 'interrupted' | 'cancelled'>
  checks: ValidationChecks
  error: string | null
} | undefined {
  if (result.status !== 'succeeded' && result.status !== 'failed' && result.status !== 'cancelled') return undefined
  const checks = {
    runRecorded: Boolean(result.attemptId),
    executionSucceeded: result.status === 'succeeded',
    outputNonEmpty: result.output.trim().length > 0,
  }
  if (result.status === 'succeeded') return { status: 'succeeded', checks, error: null }
  if (result.status === 'cancelled') return { status: 'cancelled', checks, error: '执行已取消' }
  if (result.errorCode === 'SERVICE_RESTARTED') return { status: 'interrupted', checks, error: '服务重启中断' }
  return { status: 'failed', checks, error: result.errorCode ? `执行失败（${result.errorCode}）` : '执行失败' }
}

function toCase(row: CaseRow): ValidationCase {
  const finished = !['queued', 'running'].includes(row.status)
  return {
    id: row.id,
    position: row.position,
    source: row.source,
    sourceRef: row.sourceRef,
    prompt: row.prompt,
    status: row.status,
    runId: row.runId,
    attemptId: row.attemptId,
    runCount: row.runCount,
    checks: finished ? {
      runRecorded: row.checks.runRecorded === true,
      executionSucceeded: row.checks.executionSucceeded === true,
      outputNonEmpty: row.checks.outputNonEmpty === true,
    } : null,
    output: row.output,
    error: row.error,
    verdict: row.verdict,
    verdictNote: row.verdictNote,
    verdictBy: row.verdictBy,
    verdictAt: iso(row.verdictAt),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  }
}
