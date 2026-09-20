import { createHash } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type {
  PostgresAuthorizationService,
  RuntimeAuthorizationDecision,
  RuntimeScopeCeiling,
} from '../authorization/postgres-authorization-service.ts'
import {
  authorizationDenied,
  isAuthorizationDenial,
  RequestValidationError,
} from '../authorization/authorization-errors.ts'
import type { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import type { PostgresAgentService } from '../agent/postgres-agent-service.ts'
import type { RunOrchestrationService } from '../run/run-orchestration-service.ts'
import type { PostgresRunRepository } from '../run/postgres-run-repository.ts'
import type { PostgresContentService } from '../workbench/application/postgres-content-service.ts'
import type { PostgresConversationRepository } from '../workbench/application/postgres-conversation-repository.ts'
import type { RunRecord } from '../run/run-types.ts'
import { nextSlotUtc, normalizeSchedule } from './automation-calendar.ts'
import type { PostgresAutomationRepository } from './postgres-automation-repository.ts'
import {
  AutomationReasonCodes,
  frozenConfigToJson,
  type AutomationExecutionRecord,
  type AutomationInputTemplate,
  type AutomationModuleConfig,
  type AutomationRecord,
  type AutomationSchedule,
  type FrozenExecutionConfig,
} from './automation-types.ts'

const tenantId = 'tenant-dsh-work'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function conflict(message: string, code = 'conflict'): Error {
  return Object.assign(new Error(message), { status: 409, code })
}

function notFound(message = '自动任务不存在或不可访问'): Error {
  return Object.assign(new Error(message), { status: 404, code: 'not_found' })
}

/**
 * 受理期「拒绝」判定：类型化授权拒绝与请求校验失败。其余错误（DB/网络等
 * 基础设施故障）必须向上抛出——后台受理路径的游标保持不动、下个 tick
 * 重试，不能把瞬时故障写成永久 skipped 记录。
 */
function isAdmissionDenial(error: unknown): boolean {
  return isAuthorizationDenial(error) || error instanceof RequestValidationError
}

export interface CreateAutomationInput {
  name: string
  /** 业务 Agent ID；受理时解析为当前已发布版本并钉死（不跟随最新版）。 */
  agentId: string
  workspaceId: string
  schedule: AutomationSchedule
  inputTemplate: AutomationInputTemplate
}

export interface UpdateAutomationInput {
  name?: string
  agentId?: string
  workspaceId?: string
  schedule?: AutomationSchedule
  inputTemplate?: AutomationInputTemplate
}

interface AdmissionRequest {
  automationId: string
  kind: 'scheduled' | 'manual'
  triggerId: string
  plannedSlotUtc: string
  requestFingerprint?: string
  /** scheduled 受理的前置游标/规则期望；manual 不校验。 */
  expectedNextSlotUtc?: string | null
  expectedScheduleRevision?: number
  /** 受理成功后推进到的游标；manual 传 undefined 表示不动游标。 */
  newNextSlotUtc?: string | null
  /** 试运行允许 draft 任务走真实受理链路。 */
  allowDraft?: boolean
}

export class AutomationService {
  private readonly database: DatabaseClient
  private readonly automations: PostgresAutomationRepository
  private readonly conversations: PostgresConversationRepository
  private readonly runs: PostgresRunRepository
  private readonly orchestration: RunOrchestrationService
  private readonly authorization: PostgresAuthorizationService
  private readonly agents: PostgresAgentService
  private readonly content: PostgresContentService
  private readonly operations?: PostgresOperationsService
  private readonly config: AutomationModuleConfig

  constructor(
    database: DatabaseClient,
    automations: PostgresAutomationRepository,
    conversations: PostgresConversationRepository,
    runs: PostgresRunRepository,
    orchestration: RunOrchestrationService,
    authorization: PostgresAuthorizationService,
    agents: PostgresAgentService,
    content: PostgresContentService,
    operations: PostgresOperationsService | undefined,
    config: AutomationModuleConfig,
  ) {
    this.database = database
    this.automations = automations
    this.conversations = conversations
    this.runs = runs
    this.orchestration = orchestration
    this.authorization = authorization
    this.agents = agents
    this.content = content
    this.operations = operations
    this.config = config
  }

  async create(
    ownerUserId: string,
    input: CreateAutomationInput,
    sessionRoleIds?: string[],
  ): Promise<AutomationRecord> {
    const name = normalizeAutomationName(input.name)
    const schedule = normalizeSchedule(input.schedule)
    const template = normalizeInputTemplate(input.inputTemplate)
    // 创建即钉版本：业务 Agent → 当前已发布版本；同时校验对象准入。
    const agentVersionId = await this.agents.resolveWorkbenchAgentVersion(input.agentId, ownerUserId, sessionRoleIds)
    await this.authorizeExecution({
      userId: ownerUserId,
      workspaceId: input.workspaceId,
      agentVersionId,
    })
    return this.automations.create({
      ownerUserId,
      name,
      agentVersionId,
      workspaceId: input.workspaceId,
      schedule,
      nextSlotUtc: null,
      inputTemplate: template,
    })
  }

  async update(
    ownerUserId: string,
    id: string,
    patch: UpdateAutomationInput,
    sessionRoleIds?: string[],
  ): Promise<AutomationRecord> {
    // 先验属主再更新——updateEditable 不携带 owner 谓词，事后比对
    // ownerUserId 会把他人任务的变更先落库再报 404。
    const automation = await this.getMine(ownerUserId, id)
    const name = patch.name !== undefined ? normalizeAutomationName(patch.name) : undefined
    const schedule = patch.schedule ? normalizeSchedule(patch.schedule) : undefined
    const template = patch.inputTemplate ? normalizeInputTemplate(patch.inputTemplate) : undefined
    const agentVersionId = patch.agentId !== undefined
      ? await this.agents.resolveWorkbenchAgentVersion(patch.agentId, ownerUserId, sessionRoleIds)
      : undefined
    if (patch.agentId !== undefined || patch.workspaceId !== undefined) {
      // 团队空间自动任务创建/更新时就绑定到该空间可用的 Agent 成员；不要等
      // enable/runNow 才暴露「配置了不可执行目标」。后续执行前仍会按当前
      // 成员与授权状态复核。
      await this.authorizeExecution({
        userId: ownerUserId,
        workspaceId: patch.workspaceId ?? automation.workspaceId,
        agentVersionId: agentVersionId ?? automation.agentVersionId,
      })
    }
    const next = schedule ? nextSlotUtc(schedule, new Date())?.toISOString() ?? null : undefined
    const updated = await this.automations.updateEditable(id, {
      name,
      agentVersionId,
      workspaceId: patch.workspaceId,
      inputTemplate: template,
      schedule,
      // 调度变更时以当前时间重算游标；enabled 任务不可编辑（updateEditable 已约束），
      // 因此这里算出的 nextSlotUtc 只影响 draft/paused 行的展示。
      nextSlotUtc: schedule ? next : undefined,
    })
    if (!updated || updated.ownerUserId !== ownerUserId) throw notFound('自动任务不存在、不可访问或当前状态不可编辑')
    return updated
  }

  async listMine(ownerUserId: string): Promise<AutomationRecord[]> {
    return this.automations.listByOwner(ownerUserId)
  }

  async getMine(ownerUserId: string, id: string): Promise<AutomationRecord> {
    const automation = await this.automations.getByIdForOwner(id, ownerUserId)
    if (!automation || automation.status === 'disabled') throw notFound()
    return automation
  }

  async listExecutions(ownerUserId: string, automationId: string): Promise<AutomationExecutionRecord[]> {
    await this.getMine(ownerUserId, automationId)
    const executions = await this.automations.listExecutions(automationId)
    // I-06：执行列表附带关联 Run 的业务结果核验状态（task-result/v1），
    // 同一契约投影——自动任务不复制第二份结果状态机，详情仍经会话入口查看。
    const runIds = executions.map(execution => execution.runId).filter((id): id is string => id !== null)
    const outcomes = await this.conversations.getTaskResultOutcomes(runIds)
    return executions.map(execution => ({
      ...execution,
      resultOutcome: execution.runId ? outcomes.get(execution.runId) ?? null : null,
    }))
  }

  /**
   * 启用：当前授权校验 + 授权上限快照 + 配置摘要 + 首槽计算。
   * 授权上限 = 启用时 authorizeRuntime 的完整结果——此后有效权限 =
   * 当前授权 ∩ 上限（后来涨权不扩大旧任务）。
   */
  async enable(ownerUserId: string, id: string): Promise<AutomationRecord> {
    const automation = await this.getMine(ownerUserId, id)
    await this.authorization.resolveAutomationSubject(ownerUserId)
    const decision = await this.authorizeExecution({
      userId: ownerUserId,
      workspaceId: automation.workspaceId,
      agentVersionId: automation.agentVersionId,
    })
    // 启用时输入文件预检：谓词收敛在 content service（与 prepareRuntimeFiles
    // 单一来源），不在此拦截的话配置可启用但首次触发才在 dispatch 失败。
    await this.content.assertRuntimeFileAccess({
      fileIds: automation.inputTemplate.fileIds ?? [],
      userId: ownerUserId,
      workspaceId: automation.workspaceId,
      tenantId,
    })
    const scopeCeiling = { roleIds: decision.roleIds, dataScopes: decision.dataScopes }
    const confirmedConfigRevision = computeConfigRevision(automation, scopeCeiling)
    const next = automation.schedule.kind === 'manual'
      ? null
      : nextSlotUtc(automation.schedule, new Date())?.toISOString() ?? null
    const updated = await this.automations.transitionStatus(id, ['draft', 'paused'], 'enabled', {
      scopeCeiling,
      confirmedConfigRevision,
      nextSlotUtc: next,
    })
    if (!updated) throw conflict('自动任务状态已变化，请刷新后重试', 'state_conflict')
    await this.operations?.appendAudit(ownerUserId, 'automation.enable', id, 'success', `trace-automation-${id}`, '员工启用自动任务')
    return updated
  }

  /**
   * 受理授权的统一入口：团队空间必须走 authorizeTeamRunExecution——成员角色
   * （viewer/被移出）与 Agent 成员关联状态在受理/启用时就拒绝，而不是每次
   * 触发都受理成功、执行前复核才失败。空间不存在或已归档一律拒绝。
   */
  private async authorizeExecution(input: {
    userId: string
    workspaceId: string
    agentVersionId: string
    scopeCeiling?: RuntimeScopeCeiling
  }): Promise<RuntimeAuthorizationDecision> {
    const workspaceType = await this.authorization.workspaceTypeOf(input.workspaceId)
    if (workspaceType === null) {
      // workspaceTypeOf 本身不写授权审计；走完整 authorizeRuntime 让「空间
      // 不存在/已归档/非成员」与其他执行拒绝一样留下 blocked 决策记录。
      try {
        await this.authorization.authorizeRuntime(input)
      } catch {
        throw authorizationDenied('工作空间不存在或已归档')
      }
      throw authorizationDenied('工作空间不存在或已归档')
    }
    return workspaceType === 'team'
      ? this.authorization.authorizeTeamRunExecution({ ...input, requireAgentMember: true })
      : this.authorization.authorizeRuntime(input)
  }

  /** 暂停：停止新触发与未开始执行；活动执行继续，由显式「取消当前」控制。 */
  async pause(ownerUserId: string, id: string): Promise<AutomationRecord> {
    await this.getMine(ownerUserId, id)
    const updated = await this.automations.transitionStatus(id, ['enabled'], 'paused')
    if (!updated) throw conflict('自动任务不在启用状态', 'state_conflict')
    await this.convergeQueuedExecutions(id, '任务已暂停', AutomationReasonCodes.taskPaused)
    await this.operations?.appendAudit(ownerUserId, 'automation.pause', id, 'success', `trace-automation-${id}`, '员工暂停自动任务')
    return updated
  }

  async disable(ownerUserId: string, id: string): Promise<AutomationRecord> {
    await this.getMine(ownerUserId, id)
    const updated = await this.automations.transitionStatus(id, ['draft', 'enabled', 'paused'], 'disabled')
    if (!updated) throw conflict('自动任务状态已变化，请刷新后重试', 'state_conflict')
    await this.convergeQueuedExecutions(id, '任务已停用', AutomationReasonCodes.taskDisabled)
    await this.operations?.appendAudit(ownerUserId, 'automation.disable', id, 'success', `trace-automation-${id}`, '员工停用自动任务')
    return updated
  }

  /**
   * 暂停/停用收敛：把「已受理但 Run 仍 queued（未开始）」的执行取消。
   * 取消原子发生在 Run+Attempt 上；已离开 queued 的（已领取/已运行）
   * 返回 false 不动它——正在运行的执行按设计继续，由「取消当前」控制。
   */
  private async convergeQueuedExecutions(automationId: string, reason: string, reasonCode: string) {
    const pending = await this.automations.listQueuedAcceptedExecutions(automationId)
    for (const execution of pending) {
      if (!execution.runId) continue
      // Run/Attempt 取消与 admission 终态必须同一事务：否则 markAdmission
      // 瞬时失败会留下「Run cancelled + execution accepted」的不一致记录。
      const cancelled = await this.database.begin(async (transaction) => {
        const changed = await this.orchestration.cancelQueuedAutomationRun(execution.runId!, reason, {
          transaction,
          deferSystemEvent: true,
        })
        if (!changed) return false
        await this.automations.markAdmission(execution.id, 'interrupted', reasonCode, transaction)
        return true
      })
      if (cancelled) {
        await this.orchestration.appendQueuedAutomationCancellation(execution.runId, reason)
      }
    }
  }

  /**
   * 立即运行：新请求幂等键 = 新触发；同键重放返回原执行，异请求拒绝。
   * 失败后的「再次运行」走同一入口（新幂等键）。
   */
  async runNow(ownerUserId: string, id: string, idempotencyKey: string): Promise<AutomationExecutionRecord> {
    assertIdempotencyKey(idempotencyKey)
    const automation = await this.getMine(ownerUserId, id)
    if (automation.status !== 'enabled') throw conflict('自动任务未启用，不能立即运行', 'state_conflict')
    const triggerId = sha256(`manual|${id}|${idempotencyKey}`)
    // 指纹覆盖调用方实际请求的形状（而非幂等键本身——键已在 triggerId 中）。
    // 手动请求的可变维度只有「操作类型」：同键跨端点复用（run-now vs
    // 试运行）会命中不同指纹而被拒绝。
    const requestFingerprint = sha256(JSON.stringify({ operation: 'run-now' }))
    const execution = await this.admit({
      automationId: id,
      kind: 'manual',
      triggerId,
      plannedSlotUtc: new Date().toISOString(),
      requestFingerprint,
    })
    if (!execution) throw conflict('触发受理失败：调度状态已变化', 'state_conflict')
    return execution
  }

  /** 可选试运行：draft/paused 任务走同一受理与 DSH 链路，仅放宽状态门禁。 */
  async trialRun(ownerUserId: string, id: string, idempotencyKey: string): Promise<AutomationExecutionRecord> {
    assertIdempotencyKey(idempotencyKey)
    const automation = await this.getMine(ownerUserId, id)
    if (!['draft', 'paused'].includes(automation.status)) {
      throw conflict('只有草稿或暂停的自动任务可以试运行', 'state_conflict')
    }
    const triggerId = sha256(`manual|${id}|${idempotencyKey}`)
    const requestFingerprint = sha256(JSON.stringify({ operation: 'trial-run' }))
    const execution = await this.admit({
      automationId: id,
      kind: 'manual',
      triggerId,
      plannedSlotUtc: new Date().toISOString(),
      requestFingerprint,
      allowDraft: true,
    })
    if (!execution) throw conflict('试运行受理失败：任务状态已变化', 'state_conflict')
    return execution
  }

  /**
   * 触发扫描入口：处理一个到期槽位。游标期望不一致说明规则已改或
   * 另一处理器已受理，直接返回 null（不重复登记）。
   */
  async processScheduledSlot(
    automationId: string,
    slotUtc: Date,
    expectedNextSlotUtc: string,
    newNextSlotUtc: string | null,
  ): Promise<AutomationExecutionRecord | null> {
    const automation = await this.automations.getById(automationId)
    if (!automation || automation.status !== 'enabled') return null
    const triggerId = sha256(`scheduled|${automationId}|${automation.scheduleRevision}|${slotUtc.toISOString()}`)
    return this.admit({
      automationId,
      kind: 'scheduled',
      triggerId,
      plannedSlotUtc: slotUtc.toISOString(),
      expectedNextSlotUtc,
      expectedScheduleRevision: automation.scheduleRevision,
      newNextSlotUtc,
    })
  }

  /** 停机缺口留痕：合并为一条 missed 记录，与游标推进原子提交。 */
  async recordMissedRange(
    automationId: string,
    missedFromUtc: Date,
    missedToUtc: Date,
    expectedNextSlotUtc: string,
    newNextSlotUtc: string | null,
  ): Promise<void> {
    const automation = await this.automations.getById(automationId)
    if (!automation) return
    const triggerId = sha256(
      `missed|${automationId}|${automation.scheduleRevision}|${missedFromUtc.toISOString()}|${missedToUtc.toISOString()}`,
    )
    await this.database.begin(async (transaction) => {
      const task = await this.automations.lockForUpdate(transaction, automationId)
      if (!task || task.status !== 'enabled' || task.nextSlotUtc !== expectedNextSlotUtc) return
      await this.automations.insertExecution(transaction, {
        automationId,
        triggerId,
        kind: 'missed',
        plannedSlotUtc: null,
        missedFromUtc: missedFromUtc.toISOString(),
        missedToUtc: missedToUtc.toISOString(),
        taskRevision: task.revision,
        scheduleRevision: task.scheduleRevision,
        admissionStatus: 'skipped',
        reasonCode: AutomationReasonCodes.slotExpired,
      })
      await this.automations.advanceSlotCursor(
        transaction, automationId, expectedNextSlotUtc, newNextSlotUtc,
      )
    })
  }

  /**
   * 启动恢复：受理已提交但 Attempt 未创建的执行显式收敛为 interrupted。
   * 收敛是条件判定：Run 已离开「无 Attempt 的 queued」（恢复竞态下被正常
   * 派发）时不改写执行终态，交由正常执行链推进，避免出现
   * 「interrupted + succeeded」的矛盾记录。
   */
  async recoverInterruptedPreparations(): Promise<number> {
    let recovered = 0
    for (const execution of await this.automations.listInterruptedPreparations()) {
      const converged = execution.runId
        ? await this.orchestration.convergeInterruptedAutomationRun(
            execution.runId,
            '受理后服务重启，执行准备未完成',
          )
        : true
      if (!converged) continue
      await this.automations.markAdmission(
        execution.id,
        'interrupted',
        AutomationReasonCodes.dispatchInterrupted,
      )
      recovered += 1
    }
    return recovered
  }

  /**
   * 受理核心：任务行锁内完成 去重 → 状态/游标复核 → 重叠 → 配额 →
   * 当前授权 ∩ 上限 → Session/Run/执行关联/游标推进，全部原子提交。
   * 任何一步不通过都落一条带 reason 的终态执行记录（不创建 Run）。
   */
  private async admit(request: AdmissionRequest): Promise<AutomationExecutionRecord | null> {
    const accepted = await this.database.begin(async (transaction) => {
      const task = await this.automations.lockForUpdate(transaction, request.automationId)
      if (!task) throw notFound()

      // 幂等重放：同 trigger_id 直接返回原执行；指纹不一致拒绝。
      const existing = await this.automations.findExecutionByTrigger(
        transaction, request.automationId, request.triggerId,
      )
      if (existing) {
        if (
          request.requestFingerprint
          && existing.requestFingerprint
          && existing.requestFingerprint !== request.requestFingerprint
        ) {
          throw conflict('同一幂等键提交了不同请求', AutomationReasonCodes.duplicateRequest)
        }
        return { kind: 'replay' as const, execution: existing }
      }

      const skip = async (reasonCode: string) => {
        const execution = await this.automations.insertExecution(transaction, {
          automationId: task.id,
          triggerId: request.triggerId,
          kind: request.kind,
          plannedSlotUtc: request.plannedSlotUtc,
          taskRevision: task.revision,
          scheduleRevision: task.scheduleRevision,
          requestFingerprint: request.requestFingerprint ?? null,
          admissionStatus: 'skipped',
          reasonCode,
        })
        await this.advanceCursorInTx(transaction, request, task)
        return { kind: 'recorded' as const, execution }
      }

      const statusOk = task.status === 'enabled' || (request.allowDraft === true && task.status !== 'disabled')
      if (!statusOk) {
        // 试运行受理允许 draft/paused：到达这里的 disabled 是「受理途中被
        // 停用」，reason 应如实记为 task_disabled 而非笼统的 task_paused。
        return skip(
          task.status === 'disabled' ? AutomationReasonCodes.taskDisabled : AutomationReasonCodes.taskPaused,
        )
      }
      if (
        request.kind === 'scheduled'
        && (
          task.scheduleRevision !== request.expectedScheduleRevision
          || task.nextSlotUtc !== request.expectedNextSlotUtc
        )
      ) {
        return { kind: 'stale' as const, execution: null }
      }

      const active = await this.automations.findActiveExecution(transaction, task.id)
      if (active) return skip(AutomationReasonCodes.overlap)
      if (await this.automations.countUserPending(transaction, task.ownerUserId) >= this.config.userPendingLimit) {
        return skip(AutomationReasonCodes.userPendingLimit)
      }
      if (await this.automations.countGlobalPending(transaction) >= this.config.globalPendingLimit) {
        return skip(AutomationReasonCodes.globalPendingLimit)
      }

      // 分类靠错误来源而非文案匹配：主体解析（目录新鲜度/账号有效）失败
      // 记 subject_invalid，授权决策（角色/范围交集）失败记 authorization_denied。
      // 只有「确定的拒绝」才能落成 skipped——基础设施错误向上抛出，游标不动，
      // 下个 tick 重试，不能把瞬时故障写成永久跳过记录。
      try {
        await this.authorization.resolveAutomationSubject(task.ownerUserId)
      } catch (error) {
        if (!isAdmissionDenial(error)) throw error
        return skip(AutomationReasonCodes.subjectInvalid)
      }
      let decision: RuntimeAuthorizationDecision
      try {
        decision = await this.authorizeExecution({
          userId: task.ownerUserId,
          workspaceId: task.workspaceId,
          agentVersionId: task.agentVersionId,
          scopeCeiling: task.scopeCeiling,
        })
      } catch (error) {
        if (!isAdmissionDenial(error)) throw error
        return skip(AutomationReasonCodes.authorizationDenied)
      }

      const frozen: FrozenExecutionConfig = {
        agentVersionId: task.agentVersionId,
        workspaceId: task.workspaceId,
        ownerUserId: task.ownerUserId,
        prompt: task.inputTemplate.prompt,
        fileIds: task.inputTemplate.fileIds ?? [],
        scopeCeiling: task.scopeCeiling,
        decisionRoleIds: decision.roleIds,
        decisionDataScopes: decision.dataScopes,
        budget: task.inputTemplate.budget ?? {},
        trial: request.allowDraft === true,
      }
      const session = await this.conversations.createSession({
        userId: task.ownerUserId,
        title: sessionTitle(task),
        workspaceId: task.workspaceId,
        agentVersionId: task.agentVersionId,
      }, transaction)
      const run = await this.runs.createRun({
        tenantId,
        sessionId: session.id,
        requestedBy: task.ownerUserId,
        idempotencyKey: `automation-${request.triggerId}`,
      }, transaction)
      const execution = await this.automations.insertExecution(transaction, {
        automationId: task.id,
        triggerId: request.triggerId,
        kind: request.kind,
        plannedSlotUtc: request.plannedSlotUtc,
        taskRevision: task.revision,
        scheduleRevision: task.scheduleRevision,
        requestFingerprint: request.requestFingerprint ?? null,
        executionConfig: frozenConfigToJson(frozen),
        sessionId: session.id,
        runId: run.id,
        admissionStatus: 'accepted',
      })
      await this.advanceCursorInTx(transaction, request, task)
      if (!execution) throw new Error('执行记录创建失败')
      return { kind: 'recorded' as const, execution, run, decision }
    })

    if (!accepted || accepted.kind !== 'recorded' || !accepted.execution) return accepted?.execution ?? null
    const { execution, run, decision } = accepted as {
      execution: AutomationExecutionRecord
      run?: RunRecord
      decision?: RuntimeAuthorizationDecision
    }
    if (execution.admissionStatus !== 'accepted') return execution

    const frozen = execution.executionConfig!
    try {
      await this.orchestration.dispatchAutomation(run!, {
        prompt: frozen.prompt,
        workspaceId: frozen.workspaceId,
        agentVersionId: frozen.agentVersionId,
        userId: frozen.ownerUserId,
        fileIds: frozen.fileIds,
        attemptId: `attempt-${execution.id}`,
        authorization: decision,
        budget: frozen.budget,
      })
    } catch (error) {
      // dispatch 失败收敛：Run 仍是「无 Attempt 的 queued」时落 failed
      // （幂等——failUndispatchedRun 已收敛时此处返回 false）。随后以
      // 新鲜状态判定：Attempt 存在说明 Run 已在正常执行链上，不改写执行
      // 终态，避免出现「interrupted + succeeded」矛盾记录。
      await this.orchestration.convergeInterruptedAutomationRun(run!.id, 'dispatch 失败收敛')
      const current = await this.runs.getRun(tenantId, run!.id)
      if (!current?.currentAttemptId) {
        await this.automations.markAdmission(
          execution.id, 'interrupted', AutomationReasonCodes.dispatchInterrupted,
        )
      }
      throw error
    }
    return execution
  }

  private async advanceCursorInTx(
    transaction: DatabaseTransaction,
    request: AdmissionRequest,
    task: AutomationRecord,
  ): Promise<void> {
    if (request.newNextSlotUtc === undefined) return
    const moved = await this.automations.advanceSlotCursor(
      transaction, task.id, request.expectedNextSlotUtc ?? null, request.newNextSlotUtc,
    )
    if (!moved) throw conflict('调度游标已变化，本次触发由另一处理器处理', 'cursor_moved')
  }
}

function normalizeAutomationName(name: string): string {
  const normalized = typeof name === 'string' ? name.trim() : ''
  if (normalized.length < 1 || normalized.length > 120) {
    throw new Error('任务名称长度必须为 1～120 个字符')
  }
  return normalized
}

function normalizeInputTemplate(input: AutomationInputTemplate): AutomationInputTemplate {
  if (!input || typeof input.prompt !== 'string' || input.prompt.trim().length < 1) {
    throw new Error('任务输入不能为空')
  }
  if (input.prompt.length > 20_000) throw new Error('任务输入不能超过 20000 字符')
  const budget = input.budget ?? {}
  for (const key of ['timeoutSeconds', 'maxToolCalls', 'maxOutputBytes'] as const) {
    const value = budget[key]
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`预算 ${key} 必须是正整数`)
    }
  }
  return {
    prompt: input.prompt,
    fileIds: [...new Set(input.fileIds ?? [])],
    budget,
  }
}

function assertIdempotencyKey(key: string) {
  if (typeof key !== 'string' || key.trim().length < 1 || key.length > 128) {
    throw new Error('idempotencyKey 必须是 1～128 字符')
  }
}

function computeConfigRevision(
  automation: AutomationRecord,
  scopeCeiling: { roleIds: string[]; dataScopes: string[] },
): string {
  return sha256(JSON.stringify({
    agentVersionId: automation.agentVersionId,
    workspaceId: automation.workspaceId,
    ownerUserId: automation.ownerUserId,
    inputTemplate: automation.inputTemplate,
    scopeCeiling: {
      roleIds: [...scopeCeiling.roleIds].sort(),
      dataScopes: [...scopeCeiling.dataScopes].sort(),
    },
  }))
}

function sessionTitle(automation: AutomationRecord): string {
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `${automation.name} · ${when}`
}
