import { createHash } from 'node:crypto'

import type { DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { AuthorizationCheckUnavailableError } from './current-execution-authorization.ts'
import type { ModelGovernanceService } from '../model/model-governance-service.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../runtime/runtime-types.ts'
import { compileRuntimeManifest } from '../runtime/manifest-compiler.ts'
import { normalizePersistedRuntimeManifest } from '../runtime/runtime-manifest-compatibility.ts'
import type { PostgresConversationRepository } from '../workbench/application/postgres-conversation-repository.ts'
import type { PostgresContentService } from '../workbench/application/postgres-content-service.ts'
import type { RunOperationsPort } from './run-operations-port.ts'
import type { PostgresAgentService } from '../agent/postgres-agent-service.ts'
import type { PostgresKnowledgeService } from '../knowledge/postgres-knowledge-service.ts'
import type { PostgresControlledMemoryService } from '../memory/postgres-controlled-memory-service.ts'
import type {
  PostgresAuthorizationService,
  SessionAuthorizationContext,
} from '../authorization/postgres-authorization-service.ts'
import { authorizationDenied, requestInvalid } from '../../domain/authorization-errors.ts'
import type { PostgresWorkspaceAgentMemberService } from '../workbench/application/postgres-workspace-agent-member-service.ts'
import type { RunRepository } from './run-repository.ts'
import type { JsonObject, RunRecord } from './run-types.ts'
import type { TaskRepository } from '../task/task-repository.ts'
import type { TaskSourceType } from '../task/task-types.ts'
import { normalizeTaskBudget, type TaskBudgetInput } from '../task/task-budget-types.ts'
import { accessDenied, invalidRequest, stateConflict } from '../../domain/request-errors.ts'
import { AdminRunEntry } from './orchestration/admin-run-entry.ts'
import { AttemptBudget } from './orchestration/attempt-budget.ts'
import { AttemptDispatcher } from './orchestration/attempt-dispatcher.ts'
import { AttemptScheduler } from './orchestration/attempt-scheduler.ts'
import { BackgroundRunEntry } from './orchestration/background-run-entry.ts'
import { withContinuationOutputs } from './orchestration/continuation.ts'
import { ExecutionAuthorizationGate } from './orchestration/execution-authorization-gate.ts'
import { assertPrompt, attemptLimitsForBudget, manifestLimitsForRetry } from './orchestration/manifest-helpers.ts'
import {
  runtimeId,
  tenantId,
  type DelegationPort,
  type OrchestrationDependencies,
  type PersistentWaitPort,
  type ToolBindingCheckPort,
} from './orchestration/orchestration-dependencies.ts'
import { ReleaseTrialEntry } from './orchestration/release-trial-entry.ts'
import { RunCancellation } from './orchestration/run-cancellation.ts'
import { RunEventRecorder } from './orchestration/run-event-recorder.ts'

/**
 * Run orchestration facade and the employee entry point (conversation Runs and API/event
 * Tasks). Other scenarios have their own entry classes under ./orchestration/, which share
 * the dispatcher (Manifest → Attempt), the scheduler, the event recorder, the budget and
 * the execution authorization gate. The facade keeps the public API stable for callers.
 */
export class RunOrchestrationService {
  private readonly deps: OrchestrationDependencies
  private readonly gate: ExecutionAuthorizationGate
  private readonly scheduler: AttemptScheduler
  private readonly dispatcher: AttemptDispatcher
  private readonly cancellation: RunCancellation
  private readonly admin: AdminRunEntry
  private readonly trials: ReleaseTrialEntry
  private readonly background: BackgroundRunEntry

  constructor(
    runs: RunRepository,
    conversations: PostgresConversationRepository,
    models: ModelGovernanceService,
    runtime: AgentRuntimePort,
    content?: PostgresContentService,
    operations?: RunOperationsPort,
    agents?: PostgresAgentService,
    knowledge?: PostgresKnowledgeService,
    authorization?: PostgresAuthorizationService,
    options?: {
      automationMaxConcurrent?: number
      /** TW-10：团队会话 @Agent 触发时按成员关联解析固定版本。 */
      agentMembers?: PostgresWorkspaceAgentMemberService
      /**
       * AG-03 执行前复核兜底：按 run_id 反查所属自动任务当前状态。
       * 暂停/停用后仍排在队列里的 Attempt 在领取后、调用 Runtime 前
       * 在此被拦下；未接线（测试替身等）时跳过该检查。
       */
      automationStatusLookup?: (runId: string) => Promise<{ status: string; trial: boolean } | null>
      /** B-03/I-04：Attempt 固定绑定修订的执行期复核端口；未接线且 Manifest 带 pin 时 fail-closed。 */
      toolBindings?: ToolBindingCheckPort
      /** PF-01 stable Task ownership for non-conversation execution. */
      tasks?: TaskRepository
      memory?: PostgresControlledMemoryService
    },
  ) {
    this.deps = {
      runs, conversations, models, runtime, content, operations, agents, knowledge, authorization,
      agentMembers: options?.agentMembers,
      automationMaxConcurrent: options?.automationMaxConcurrent ?? 2,
      automationStatusLookup: options?.automationStatusLookup,
      toolBindings: options?.toolBindings,
      tasks: options?.tasks,
      memory: options?.memory,
    }
    const budget = new AttemptBudget(this.deps)
    const events = new RunEventRecorder(this.deps, budget)
    this.gate = new ExecutionAuthorizationGate(this.deps)
    this.scheduler = new AttemptScheduler(this.deps, this.gate, events)
    this.dispatcher = new AttemptDispatcher(this.deps, budget, this.scheduler)
    this.cancellation = new RunCancellation(this.deps)
    this.admin = new AdminRunEntry(this.deps, this.dispatcher, this.scheduler, budget, this.cancellation)
    this.trials = new ReleaseTrialEntry(this.deps, this.dispatcher, budget, this.cancellation)
    this.background = new BackgroundRunEntry(this.deps, this.dispatcher)
  }

  setPersistentWaitService(service: PersistentWaitPort): void {
    this.deps.persistentWait = service
  }

  setDelegationService(service: DelegationPort): void {
    this.deps.delegation = service
  }

  enqueueResumedAttempt(run: RunRecord, manifest: RuntimeManifest): void {
    this.scheduler.enqueue(run, manifest)
  }

  // Admin assistant, Skill installation and Skill test Runs.
  startAdminRun(input: Parameters<AdminRunEntry['startAdminRun']>[0]) { return this.admin.startAdminRun(input) }
  cancelAdminRun(runId: string, userId: string) { return this.admin.cancelAdminRun(runId, userId) }
  retryAdminRun(runId: string, userId: string) { return this.admin.retryAdminRun(runId, userId) }

  // Agent release trials.
  runReleaseTrialCase(input: Parameters<ReleaseTrialEntry['runReleaseTrialCase']>[0]) { return this.trials.runReleaseTrialCase(input) }

  // Automation, Agent routines and delegated child tasks.
  dispatchAutomation(run: RunRecord, input: Parameters<BackgroundRunEntry['dispatchAutomation']>[1]) { return this.background.dispatchAutomation(run, input) }
  dispatchAgentRoutine(run: RunRecord, input: Parameters<BackgroundRunEntry['dispatchAgentRoutine']>[1]) { return this.background.dispatchAgentRoutine(run, input) }
  dispatchDelegatedRun(input: Parameters<BackgroundRunEntry['dispatchDelegatedRun']>[0]) { return this.background.dispatchDelegatedRun(input) }
  convergeInterruptedAutomationRun(runId: string, reason: string) { return this.background.convergeInterruptedAutomationRun(runId, reason) }
  cancelQueuedAutomationRun(runId: string, reason: string, options?: { transaction?: DatabaseTransaction; deferSystemEvent?: boolean }) {
    return this.background.cancelQueuedAutomationRun(runId, reason, options)
  }
  appendQueuedAutomationCancellation(runId: string, reason: string) { return this.background.appendQueuedAutomationCancellation(runId, reason) }

  // System cancellation (revocation pipeline).
  systemCancelRun(runId: string, cause: 'system_revoke', reason?: string) { return this.cancellation.systemCancelRun(runId, cause, reason) }

  // Execution-time authorization shared with the Runtime, tool bridge and approvals.
  assertCurrentRunAuthorization(manifest: RuntimeManifest, toolBindingsChecked = false) { return this.gate.assertCurrentRunAuthorization(manifest, toolBindingsChecked) }
  assertWaitingRunAuthorization(manifest: RuntimeManifest) { return this.gate.assertWaitingRunAuthorization(manifest) }

  close() { return this.scheduler.close() }

  async createSession(input: {
    userId: string
    title: unknown
    workspaceId?: string
    /** TW-10：团队讨论会话传 null（首次 @Agent 前不绑定 Agent）。 */
    agentVersionId?: string | null
    selectedSkillVersionId?: string
    selectedSkillReference?: string
    clientIntentId?: string
    authorizationContext?: SessionAuthorizationContext
  }) {
    const title = assertPrompt(input.title)
    const workspaceId = await this.deps.conversations.resolveWorkspaceId(input.workspaceId, input.userId)
    if (this.deps.authorization && input.agentVersionId) {
      await this.deps.authorization.authorizeRuntime({
        userId: input.userId,
        workspaceId,
        agentVersionId: input.agentVersionId,
        additionalSkillReferences: input.selectedSkillReference ? [input.selectedSkillReference] : [],
        ...input.authorizationContext,
      })
    } else {
      await this.deps.authorization?.authorizeWorkbench({
        userId: input.userId,
        workspaceId,
        ...input.authorizationContext,
      })
    }
    return this.deps.conversations.createSession({
      userId: input.userId,
      title,
      workspaceId,
      agentVersionId: input.agentVersionId,
      selectedSkillVersionId: input.selectedSkillVersionId,
      clientIntentId: input.clientIntentId,
    })
  }

  /**
   * Session access shared by read/write paths (TW-10). Team sessions are shared
   * discussions: any current member may read; only non-viewer members may write
   * (send messages, trigger runs). Archived team workspaces keep read access
   * (3-T1 read track) while writes stay fail-closed. Personal/standalone
   * sessions keep the creator-only gate.
   */
  private async requireSessionAccess(sessionId: string, userId: string, mode: 'read' | 'write') {
    const session = await this.deps.conversations.findSessionRow(sessionId)
    if (!session) throw authorizationDenied(`Session 不存在或不可访问：${sessionId}`)
    if (mode === 'write' && session.workspaceStatus !== 'active') {
      throw authorizationDenied('工作空间不存在、已归档或当前用户不是成员')
    }
    if (session.workspaceType === 'team' && this.deps.authorization) {
      await this.deps.authorization.requireTeamRole(
        session.workspaceId,
        userId,
        mode === 'write' ? ['owner', 'admin', 'member'] : ['owner', 'admin', 'member', 'viewer'],
        mode === 'read' ? { purpose: 'read' } : {},
      )
    } else if (session.createdBy !== userId) {
      throw authorizationDenied(`Session 不存在或不可访问：${sessionId}`)
    }
    return session
  }

  /**
   * Shared session detail (TW-10): any current team member reads the whole
   * discussion thread (message sender + triggering requester + Agent
   * attribution); personal sessions remain creator-only.
   */
  async getSessionThread(sessionId: string, userId: string, before?: string) {
    const session = await this.requireSessionAccess(sessionId, userId, 'read')
    const thread = await this.deps.conversations.getSessionThread(sessionId, before ? { before } : undefined)
    if (!thread) throw authorizationDenied(`Session 不存在或不可访问：${sessionId}`)
    // 附带调用者的当前成员角色（读轨）：前端据此对只读成员禁用输入框；
    // 个人会话恒为 null，可写性由 createdBy === userId 判断。
    const currentUserRole = this.deps.authorization
      ? await this.deps.authorization.teamRoleOf(session.workspaceId, userId)
      : null
    return { ...thread, currentUserRole }
  }

  /**
   * Discussion message without a Run (TW-10): the message is persisted with
   * sender attribution and run_id=null; it never invokes a model. Only
   * non-viewer members of an active team workspace may post.
   */
  async postDiscussionMessage(input: {
    userId: string
    sessionId: string
    content: unknown
    /** Client-supplied dedupe key; absent keys fall back to a fresh message id. */
    idempotencyKey?: string | null
    mentionedUserIds?: string[]
  }) {
    if (typeof input.content !== 'string') throw requestInvalid('消息内容必须是字符串')
    const content = input.content.trim()
    if (!content) throw requestInvalid('消息内容不能为空')
    if (content.length > 20_000) throw requestInvalid('消息长度必须为 1～20000 个字符')
    const session = await this.requireSessionAccess(input.sessionId, input.userId, 'write')
    if (session.workspaceType !== 'team') throw requestInvalid('仅团队空间会话支持讨论消息')
    // 幂等键必须显式提供且非空白（与路由强制一致）：空白退化随机 ID 等于
    // 没有幂等保护。键做完整哈希而非截断拼接——前缀相同的过长键不会被
    // 人为合并；会话 ID 入键，同键跨会话不会误命中别人的消息（评审中1）。
    const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
    if (!key) throw requestInvalid('idempotencyKey 必须是非空字符串')
    // 哈希前用结构化编码而非字符串拼接（M-R2）：拼接无法区分
    // (userId='a', key='bc') 与 (userId='ab', key='c')，不同二元组会得到
    // 同一原始输入。JSON 数组编码对各段长度无歧义。
    const keyHash = createHash('sha256')
      .update(JSON.stringify([tenantId, session.id, input.userId, key]))
      .digest('hex').slice(0, 32)
    const messageId = `message-discussion-${session.id}-${keyHash}`
    const mentionedUserIds = normalizeMentionedUserIds(input.mentionedUserIds)
    const committed = await this.deps.conversations.appendDiscussionMessage({
      sessionId: session.id,
      userId: input.userId,
      content,
      messageId,
      mentionedUserIds,
    })
    if (committed.created) await this.deps.conversations.activateSession(session.id)
    return { messageId: committed.messageId, sessionId: session.id, created: committed.created }
  }

  async startRun(input: {
    userId: string
    sessionId: string
    prompt: unknown
    idempotencyKey: string
    fileIds?: string[]
    /**
     * TW-10：团队会话按消息绑定 Agent 成员（@ 触发），成员固定版本即本次
     * 执行的 Agent 版本；个人/独立会话忽略此字段，沿用会话绑定版本。
     */
    workspaceAgentMemberId?: string
    cumulativeBudget?: TaskBudgetInput
    authorizationContext?: SessionAuthorizationContext
  }) {
    const prompt = assertPrompt(input.prompt)
    const normalizedBudget = normalizeTaskBudget(input.cumulativeBudget)
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw requestInvalid('idempotencyKey 必须是非空字符串')
    }
    if (input.workspaceAgentMemberId !== undefined && typeof input.workspaceAgentMemberId !== 'string') {
      throw requestInvalid('workspaceAgentMemberId 必须是字符串')
    }
    if (input.fileIds !== undefined && (!Array.isArray(input.fileIds) || input.fileIds.some(id => typeof id !== 'string'))) {
      throw requestInvalid('fileIds 必须是文件标识数组')
    }
    const session = await this.requireSessionAccess(input.sessionId, input.userId, 'write')
    let agentVersionId = session.agentVersionId
    const teamAgentMemberId = session.workspaceType === 'team' ? input.workspaceAgentMemberId : undefined
    if (session.workspaceType === 'team') {
      // TW-10 @ 触发：团队会话每次执行都必须显式绑定当前可用的 Agent 成员；
      // 不再回退到会话级 agentVersionId，避免历史绑定绕过成员状态复核。
      if (!input.workspaceAgentMemberId || !this.deps.agentMembers) {
        throw requestInvalid('团队空间对话必须通过 @Agent 成员发起执行')
      }
      agentVersionId = (
        await this.deps.agentMembers.requireAvailableAgentMemberVersion(session.workspaceId, input.workspaceAgentMemberId)
      ).agentVersionId
    }
    if (!agentVersionId) throw requestInvalid('Session 未绑定 Agent，无法发起执行')
    const additionalSkillReferences = session.selectedSkillReference
      ? [session.selectedSkillReference]
      : []
    // 受理授权与执行前复核分工不变：此处只取能力交集（成员写轨与 Agent
    // 成员状态已由 requireSessionAccess / requireAvailableAgentMemberVersion
    // 在上方校验）；成员/授权在受理后被撤销的情形由调度前的
    // authorizeTeamRunExecution 复核兜底。
    const authorization = await this.deps.authorization?.authorizeRuntime({
      userId: input.userId,
      workspaceId: session.workspaceId,
      agentVersionId,
      additionalSkillReferences,
      ...input.authorizationContext,
    })
    await this.deps.runtime.assertAvailable?.()
    const preparedFiles = this.deps.content
      ? await this.deps.content.prepareRuntimeFiles({
          sessionId: session.id,
          fileIds: input.fileIds ?? [],
          userId: input.userId,
        })
      : []
    const run = await this.deps.runs.createRun({
      tenantId,
      sessionId: session.id,
      requestedBy: input.userId,
      idempotencyKey: input.idempotencyKey,
      taskBudget: input.cumulativeBudget,
    })
    await this.deps.conversations.activateSession(session.id)
    if (run.currentAttemptId || run.status !== 'queued') return run
    await this.deps.conversations.appendMessage({
      sessionId: session.id,
      runId: run.id,
      role: 'user',
      content: prompt,
      senderUserId: input.userId,
      messageId: `message-user-${run.id}`,
    })
    await this.dispatcher.failUndispatchedRun(run, async () => {
      const history = await this.deps.conversations.getConversationHistory(session.id, run.id)
      await this.dispatcher.dispatch(run, {
        prompt,
        workspaceId: session.workspaceId,
        agentVersionId,
        workspaceAgentMemberId: teamAgentMemberId,
        userId: input.userId,
        fileIds: input.fileIds ?? [],
        preparedFiles,
        authorization,
        additionalSkillReferences,
        selectedSkillReference: session.selectedSkillReference ?? undefined,
        history,
        limits: attemptLimitsForBudget(normalizedBudget),
      })
    })
    await this.deps.operations?.appendAudit(input.userId, 'run.create', run.id, 'success', `trace-${run.id}`, '员工创建真实 Run')
    return this.deps.runs.getRun(tenantId, run.id)
  }

  /** PF-01 entry for API/event work that has no product-conversation semantics. */
  async startTaskExecution(input: {
    userId: string
    workspaceId: string
    agentVersionId: string
    prompt: unknown
    correlationKey: string
    sourceType: Extract<TaskSourceType, 'api' | 'event' | 'system'>
    sourceRef?: string | null
    cumulativeBudget?: TaskBudgetInput
    authorizationContext?: SessionAuthorizationContext
  }) {
    if (!this.deps.tasks) throw new Error('Task 仓储未接线')
    if (!this.deps.authorization) throw new AuthorizationCheckUnavailableError()
    const prompt = assertPrompt(input.prompt)
    const normalizedBudget = normalizeTaskBudget(input.cumulativeBudget)
    const correlationKey = input.correlationKey?.trim()
    if (!correlationKey) throw requestInvalid('correlationKey 必须是非空字符串')
    const workspaceType = await this.deps.authorization.workspaceTypeOf(input.workspaceId)
    if (!workspaceType) throw authorizationDenied('工作空间不存在或已归档')
    const authorization = workspaceType === 'team'
      ? await this.deps.authorization.authorizeTeamRunExecution({
          userId: input.userId,
          workspaceId: input.workspaceId,
          agentVersionId: input.agentVersionId,
          requireAgentMember: true,
          ...input.authorizationContext,
        })
      : await this.deps.authorization.authorizeRuntime({
          userId: input.userId,
          workspaceId: input.workspaceId,
          agentVersionId: input.agentVersionId,
          ...input.authorizationContext,
        })
    await this.deps.runtime.assertAvailable?.()
    const run = await this.deps.runs.createRun({
      tenantId,
      sessionId: null,
      workspaceId: input.workspaceId,
      requestedBy: input.userId,
      idempotencyKey: correlationKey,
      taskSourceType: input.sourceType,
      taskSourceRef: input.sourceRef,
      taskCorrelationKey: correlationKey,
      taskRequestDigest: input.cumulativeBudget === undefined
        ? createHash('sha256').update(`${input.agentVersionId}\0${prompt}`).digest('hex')
        : createHash('sha256').update(JSON.stringify([
            'task-contract/v2', input.agentVersionId, prompt, normalizedBudget,
          ])).digest('hex'),
      taskBudget: input.cumulativeBudget,
    })
    if (run.currentAttemptId || run.status !== 'queued') return run
    await this.dispatcher.failUndispatchedRun(run, () => this.dispatcher.dispatch(run, {
      prompt,
      workspaceId: input.workspaceId,
      agentVersionId: input.agentVersionId,
      userId: input.userId,
      fileIds: [],
      preparedFiles: [],
      authorization,
      limits: attemptLimitsForBudget(normalizedBudget),
    }))
    await this.deps.operations?.appendAudit(input.userId, 'task.run.create', run.taskId, 'success', `trace-${run.id}`, `${input.sourceType} Task 创建真实 Run`)
    return this.deps.runs.getRun(tenantId, run.id)
  }

  async cancel(runId: string, userId: string, authorizationContext?: SessionAuthorizationContext) {
    await this.deps.authorization?.authorizeWorkbench({ userId, ...authorizationContext })
    const run = await this.requireWritableRun(runId, userId)
    await this.deps.delegation?.cancelActiveDescendants(run.taskId, '父任务已取消，终止所有活动子任务')
    if (run.status === 'waiting') {
      if (!this.deps.persistentWait) throw new Error('持久化等待服务未接线')
      await this.deps.persistentWait.cancelRun(run.id, userId)
      await this.deps.operations?.appendAudit(userId, 'run.wait.cancel', runId, 'success', `trace-${runId}`, '员工取消等待中的审批')
      return this.deps.runs.getRun(tenantId, runId)
    }
    if (!['queued', 'running', 'cancel_requested'].includes(run.status)) return run
    const result = await this.deps.runtime.cancel(runId, userId)
    await this.deps.operations?.appendAudit(userId, 'run.cancel.request', runId, 'success', `trace-${runId}`, '员工请求取消当前 Attempt')
    if (!result.accepted && run.status === 'queued') {
      if (run.currentAttemptId) await this.deps.runs.transitionAttempt(tenantId, run.currentAttemptId, 'cancelled')
      return this.deps.runs.transitionRun(tenantId, runId, 'cancelled')
    }
    return this.deps.runs.getRun(tenantId, runId)
  }

  async retry(runId: string, userId: string, authorizationContext?: SessionAuthorizationContext) {
    const run = await this.requireWritableRun(runId, userId)
    if (!['failed', 'cancelled'].includes(run.status)) throw stateConflict('只有失败或已取消的 Run 可以重试')
    if (run.sessionId === null) {
      if (!this.deps.tasks) throw requestInvalid('Task 重试服务未接线')
      const task = await this.deps.tasks.getTask(tenantId, run.taskId)
      if (!task) throw requestInvalid('原 Task 不存在，无法重试')
      // PF-06 子任务的安全边界来自持久化父子关系、父 Attempt 活性、深度和
      // 权限上限。通用 retry 只会重建普通 Manifest，无法合法延续这些约束；
      // 因此必须由仍在运行的父 Agent 重新发起委派，而不是脱离父任务重跑。
      if (task.sourceType === 'delegation') {
        throw requestInvalid('委派子任务不支持通用重试；请由仍在运行的父 Agent 重新发起委派')
      }
      // 主动任务重跑必须重新经过规则状态、触发去重和已批准授权上限。
      // Task 来源不可变，不能依赖可能缺失或在重试后丢失的 Manifest purpose。
      if (task.sourceType === 'agent_routine') {
        throw requestInvalid('Agent 主动任务不支持通用重试；请由主动任务规则重新触发')
      }
    }
    // AG-03：自动任务的重跑语义是「新的触发 + 新 Session/Run」，通用 retry
    // 会在原 Run 上叠加 Attempt，绕过触发去重与任务状态/重叠检查，必须拒绝。
    const lastAttempt = run.currentAttemptId ? await this.deps.runs.getAttempt(tenantId, run.currentAttemptId) : null
    const mcpConnections = (lastAttempt?.manifest as unknown as RuntimeManifest | undefined)?.mcp_connections ?? []
    if (lastAttempt && (
      await this.deps.conversations.hasUnresolvedExternalEffects(run.id, lastAttempt.id)
      // Run 终态可能先于 DSH Worker 关闭和最终 MCP 审计落库；缺失完成标记
      // （含升级前 Attempt、审计失败和进程崩溃）必须保守拒绝通用重试。
      || (mcpConnections.length > 0
        && !await this.deps.conversations.isMcpInvocationAuditFinalized(run.id, lastAttempt.id))
    )) {
      throw requestInvalid('原 Attempt 的外部操作结果可能未确定；请先核对权威回执，再明确发起新任务，不要直接重试')
    }
    if ((lastAttempt?.manifest as RuntimeManifest | undefined)?.purpose === 'automation') {
      throw invalidRequest('自动任务运行不支持在此重试；请在自动任务详情页使用「再次运行」')
    }
    if (run.sessionId === null) {
      const manifest = lastAttempt?.manifest as RuntimeManifest | undefined
      if (!manifest?.workspace_id || !manifest.agent_version_id) throw requestInvalid('原 Task 缺少固定执行上下文，无法重试')
      const workspaceType = await this.deps.authorization?.workspaceTypeOf(manifest.workspace_id)
      const authorization = workspaceType === 'team'
        ? await this.deps.authorization?.authorizeTeamRunExecution({
            userId,
            workspaceId: manifest.workspace_id,
            agentVersionId: manifest.agent_version_id,
            requireAgentMember: true,
            ...authorizationContext,
          })
        : await this.deps.authorization?.authorizeRuntime({
            userId,
            workspaceId: manifest.workspace_id,
            agentVersionId: manifest.agent_version_id,
            ...authorizationContext,
          })
      await this.dispatcher.dispatch(run, {
        prompt: manifest.input.message,
        workspaceId: manifest.workspace_id,
        agentVersionId: manifest.agent_version_id,
        userId,
        fileIds: [],
        preparedFiles: [],
        authorization,
        limits: manifestLimitsForRetry(manifest),
      })
      await this.deps.operations?.appendAudit(userId, 'task.run.retry', run.id, 'success', `trace-${run.id}`, 'Task 创建新的不可变 Attempt')
      return this.deps.runs.getRun(tenantId, run.id)
    }
    const session = await this.deps.conversations.findSessionRow(run.sessionId)
    if (!session) throw authorizationDenied(`Session 不存在或不可访问：${run.sessionId}`)
    const workspaceType = this.deps.authorization
      ? await this.deps.authorization.workspaceTypeOf(session.workspaceId)
      : null
    // TW-10：共享会话按消息绑定 Agent——重试必须沿用原 Attempt Manifest 记录的
    // 固定版本（requireWritableRun 已完成写轨校验）。会话级绑定对未绑定讨论串
    // 恒为 null、对已绑定会话也可能与触发时成员版本漂移，不能回落；缺失即拒绝。
    const manifest = lastAttempt?.manifest as RuntimeManifest | undefined
    let agentVersionId = workspaceType === 'team'
      ? manifest?.agent_version_id ?? null
      : session.agentVersionId
    if (workspaceType === 'team') {
      if (!agentVersionId) {
        agentVersionId = await this.deps.runs.findPinnedAgentVersionIdForRun(tenantId, run.id)
      }
      if (!agentVersionId) {
        const memberId = manifest?.workspace_agent_member_id
          ?? await this.deps.runs.findWorkspaceAgentMemberIdForRun(tenantId, run.id)
        if (memberId && this.deps.agentMembers) {
          agentVersionId = (
            await this.deps.agentMembers.requireAvailableAgentMemberVersion(session.workspaceId, memberId)
          ).agentVersionId
        }
      }
      if (!agentVersionId) {
        throw requestInvalid(
          run.currentAttemptId
            ? '原运行缺少 Agent 版本记录，无法重试；请在下方输入框重新 @Agent 发起执行'
            : '原运行未完成派发，无法重试；请在下方输入框重新 @Agent 发起执行',
        )
      }
    } else if (!agentVersionId) {
      throw requestInvalid('Session 未绑定 Agent，无法重试')
    }
    const additionalSkillReferences = session.selectedSkillReference
      ? [session.selectedSkillReference]
      : []
    const authorization = workspaceType === 'team'
      ? await this.deps.authorization?.authorizeTeamRunExecution({
          userId,
          workspaceId: session.workspaceId,
          agentVersionId,
          additionalSkillReferences,
          ...authorizationContext,
        })
      : await this.deps.authorization?.authorizeRuntime({
          userId,
          workspaceId: session.workspaceId,
          agentVersionId,
          additionalSkillReferences,
          ...authorizationContext,
        })
    const prompt = await this.deps.conversations.getRunPrompt(run.id)
    // 输入文件固定到已校验的来源 Attempt，而不是可变 current 指针（评审中2）。
    const fileIds = this.deps.content ? await this.deps.content.getRunInputFileIds(run.id, run.currentAttemptId) : []
    // TW-10：他人重试 = 发起人变更。执行身份契约要求
    // run.requested_by === manifest.user_context.user_id（assertCurrentRunAuthorization
    // 与成果发布共用），因此跨成员「重新运行」不在原 Run 上叠加 Attempt，
    // 而是在同一共享会话中创建属于当前操作者的新 Run：沿用原 Run 的提问与
    // 固定 Agent 版本，授权、审计、成果归因全部以当前操作者为准。
    // 幂等键绑定来源 Run + 当前 Attempt 代际（评审中2）：同一次逻辑重试的
    // 重放返回同一个新 Run；来源 Run 产生新 Attempt 后再重试必须创建新的
    // child，而不是静默返回上一代已结束的结果。
    if (run.requestedBy !== userId) {
      const retried = await this.deps.runs.createRun({
        tenantId,
        sessionId: session.id,
        requestedBy: userId,
        idempotencyKey: `retry-of-${run.id}-${run.currentAttemptId ?? 'none'}`,
      })
      if (retried.currentAttemptId || retried.status !== 'queued') return retried
      await this.dispatcher.failUndispatchedRun(retried, async () => {
        // 新 Run 的用户消息：成果归因、getRunPrompt 与共享线程展示都依赖它；
        // 发送者是本次操作者，不是原 Run 发起人。
        await this.deps.conversations.appendMessage({
          sessionId: session.id,
          runId: retried.id,
          role: 'user',
          content: prompt,
          senderUserId: userId,
          messageId: `message-user-${retried.id}`,
        })
        const history = await this.deps.conversations.getConversationHistory(session.id, retried.id)
        await this.dispatcher.dispatch(retried, {
          prompt,
          workspaceId: session.workspaceId,
          agentVersionId,
          userId,
          fileIds,
          authorization,
          additionalSkillReferences,
          selectedSkillReference: session.selectedSkillReference ?? undefined,
          history,
        })
      })
      await this.deps.operations?.appendAudit(userId, 'run.retry', retried.id, 'success', `trace-${retried.id}`, `员工重新发起共享运行（来源 ${run.id}）`)
      return this.deps.runs.getRun(tenantId, retried.id)
    }
    const continued = await withContinuationOutputs(
      this.deps.conversations,
      await this.deps.conversations.getConversationHistory(session.id, run.id),
      run.id,
      prompt,
    )
    await this.dispatcher.dispatch(run, {
      prompt,
      message: continued.message,
      workspaceId: session.workspaceId,
      agentVersionId,
      userId,
      fileIds,
      authorization,
      additionalSkillReferences,
      selectedSkillReference: session.selectedSkillReference ?? undefined,
      history: continued.history,
      limits: lastAttempt?.manifest
        ? manifestLimitsForRetry(lastAttempt.manifest as unknown as RuntimeManifest)
        : undefined,
    })
    await this.deps.operations?.appendAudit(userId, 'run.retry', runId, 'success', `trace-${runId}`, '员工创建新的不可变 Attempt')
    return this.deps.runs.getRun(tenantId, run.id)
  }

  async recoverAfterServiceRestart() {
    const recovery = await this.deps.runs.recoverAfterRestart(tenantId, runtimeId)
    for (const item of recovery.failed) {
      await this.deps.operations?.appendAudit(
        'system',
        'run.recovered-after-restart',
        item.runId,
        'failed',
        `trace-recovery-${item.runId}`,
        `Attempt ${item.attemptId} 因服务重启终止`,
      )
    }
    for (const item of recovery.queued) {
      const persisted = item.attempt.manifest as unknown as RuntimeManifest
      const manifest = normalizePersistedRuntimeManifest(persisted)
      if (!persisted.budget) {
        const compiled = compileRuntimeManifest(manifest)
        await this.deps.runs.upgradeQueuedAttemptManifest(
          tenantId,
          item.attempt.id,
          JSON.parse(compiled.canonicalJson) as JsonObject,
          compiled.sha256,
        )
      }
      this.scheduler.enqueue(item.run, manifest)
    }
    return { failed: recovery.failed.length, resumedQueued: recovery.queued.length }
  }

  /**
   * Write-track gate for run mutations (cancel/retry). TW-10 shared sessions
   * treat a Run as part of the shared discussion: any member with write-track
   * role (owner/admin/member) may cancel or retry it — not only the original
   * requester. requireSessionAccess('write') enforces the team role set and
   * rejects viewers, removed members and archived workspaces; for
   * personal/standalone sessions it still requires the session creator, so
   * the personal-space contract is unchanged.
   */
  private async requireWritableRun(runId: string, userId: string) {
    const run = await this.deps.runs.getRun(tenantId, runId)
    if (!run) throw accessDenied(`Run 不存在或不可访问：${runId}`)
    if (run.sessionId) await this.requireSessionAccess(run.sessionId, userId, 'write')
    else {
      if (!this.deps.tasks || !this.deps.authorization) throw new AuthorizationCheckUnavailableError()
      const task = await this.deps.tasks.getTask(tenantId, run.taskId)
      if (!task || task.requestedBy !== userId || !task.workspaceId) throw authorizationDenied('Task 不存在或不可访问')
      await this.deps.authorization.authorizeWorkbench({ userId, workspaceId: task.workspaceId })
    }
    return run
  }
}

function normalizeMentionedUserIds(raw: string[] | undefined): string[] {
  if (!raw) return []
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string')) {
    throw requestInvalid('mentionedUserIds 必须是字符串数组')
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of raw) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}
