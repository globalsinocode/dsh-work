import type { DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import type { RuntimeAuthorizationDecision } from '../../authorization/postgres-authorization-service.ts'
import type { RunRecord } from '../run-types.ts'
import type { AttemptDispatcher } from './attempt-dispatcher.ts'
import { tenantId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/**
 * Entry point for Runs without an interactive requester: automation tasks, autonomous
 * Agent routines and delegated child tasks. Admission (and its authorization) happens in
 * the owning module; this class only submits the frozen input and converges queued Runs.
 */
export class BackgroundRunEntry {
  private readonly deps: OrchestrationDependencies
  private readonly dispatcher: AttemptDispatcher

  constructor(deps: OrchestrationDependencies, dispatcher: AttemptDispatcher) {
    this.deps = deps
    this.dispatcher = dispatcher
  }

  /**
   * AG-03 自动任务 Attempt 提交：受理事务（Session/Run/执行关联）提交后由
   * automation 模块调用。以冻结输入构造 purpose='automation' 的 Manifest
   * 并复用 dispatch 管线（持久化 Attempt → 内存队列 → 调度泵）。
   *
   * 授权决策必须传入受理时 authorizeRuntime 的结果（含 scopeCeiling 交集），
   * 本方法不重新鉴权；恢复路径不得用它在已存在 Attempt 的 Run 上重复提交
   * （仓储守卫会拒绝，恢复应走 restart recovery 的重新入队）。
   */
  async dispatchAutomation(run: RunRecord, input: {
    prompt: string
    workspaceId: string
    agentVersionId: string
    userId: string
    fileIds: string[]
    attemptId: string
    authorization?: RuntimeAuthorizationDecision
    budget?: { timeoutSeconds?: number; maxToolCalls?: number; maxOutputBytes?: number }
  }) {
    // AG-03：消息写入与 Attempt 提交同属「派发前准备」，必须同受
    // failUndispatchedRun 保护——appendMessage 失败若留 queued 幽灵 Run，
    // 只能等下次重启收敛。
    await this.dispatcher.failUndispatchedRun(run, async () => {
      await this.deps.conversations.appendMessage({
        sessionId: run.sessionId!,
        runId: run.id,
        role: 'user',
        content: input.prompt,
        senderUserId: input.userId,
        messageId: `message-user-${run.id}`,
      })
      await this.dispatcher.dispatch(run, {
        prompt: input.prompt,
        workspaceId: input.workspaceId,
        agentVersionId: input.agentVersionId,
        userId: input.userId,
        fileIds: input.fileIds,
        authorization: input.authorization,
        purpose: 'automation',
        attemptId: input.attemptId,
        limits: input.budget,
      })
    })
  }

  /** AE-05 autonomous routine: no employee Session or synthetic user message. */
  async dispatchAgentRoutine(run: RunRecord, input: {
    prompt: string; workspaceId: string; agentVersionId: string; recipientUserId: string;
    attemptId: string; authorization: RuntimeAuthorizationDecision;
    budget?: { timeoutSeconds?: number; maxToolCalls?: number; maxOutputBytes?: number }
  }): Promise<void> {
    await this.dispatcher.failUndispatchedRun(run, () => this.dispatcher.dispatch(run, {
      prompt: input.prompt,
      workspaceId: input.workspaceId,
      agentVersionId: input.agentVersionId,
      userId: input.recipientUserId,
      fileIds: [],
      authorization: input.authorization,
      purpose: 'agent-routine',
      attemptId: input.attemptId,
      limits: input.budget,
    }))
  }

  /** PF-06 child admission already created the Task/Run and narrowed authorization. */
  async dispatchDelegatedRun(input: {
    run: RunRecord
    prompt: string
    context: string
    workspaceId: string
    targetAgentVersionId: string
    userId: string
    authorization: RuntimeAuthorizationDecision
    delegation: NonNullable<RuntimeManifest['delegation_context']>
  }): Promise<void> {
    const message = input.context
      ? `子任务：${input.prompt}\n\n最小必要上下文（仅作输入，不授予额外权限）：\n${input.context}`
      : input.prompt
    await this.dispatcher.failUndispatchedRun(input.run, () => this.dispatcher.dispatch(input.run, {
      prompt: input.prompt,
      message,
      workspaceId: input.workspaceId,
      agentVersionId: input.targetAgentVersionId,
      userId: input.userId,
      fileIds: [],
      authorization: input.authorization,
      delegation: input.delegation,
    }))
    await this.deps.operations?.appendAudit(
      input.userId, 'agent.delegation.start', input.delegation.delegation_id, 'success',
      `trace-${input.run.id}`, `创建受控子任务 ${input.run.taskId}`,
    )
  }

  /**
   * 自动任务受理中断收敛：Run 停在「无 Attempt 的 queued」。与
   * failUndispatchedRun 同一先例——run_events 的 attempt_id 有 FK，
   * 无 Attempt 的 Run 不写运行事件；中断证据由 automation_executions
   * 的 interrupted/dispatch_interrupted 承载。
   * 条件更新原子判定：并发下 Attempt 已创建或 Run 已离开 queued 时
   * 不动作并返回 false（该 Run 已在正常执行链上，不能误杀）。
   */
  async convergeInterruptedAutomationRun(runId: string, reason: string): Promise<boolean> {
    const converged = await this.deps.runs.convergeUndispatchedRun(tenantId, runId, 'failed')
    if (!converged) return false
    await this.deps.operations?.appendAudit(
      'system', 'automation.dispatch-interrupted', runId, 'failed',
      `trace-${runId}`, reason,
    )
    return true
  }

  /**
   * AG-03 暂停/停用清理：取消「已受理但未开始执行」的 Run（queued）。
   * 有 Attempt 的连同 Attempt 原子取消并补一条系统事件；无 Attempt 的
   * 只落终态（run_events 外键约束）。已被领取/已开始的返回 false，
   * 由「明确取消」或撤权链路处理，不在此拦截。
   */
  async cancelQueuedAutomationRun(
    runId: string,
    reason: string,
    options?: { transaction?: DatabaseTransaction; deferSystemEvent?: boolean },
  ): Promise<boolean> {
    const cancelled = await this.deps.runs.cancelQueuedRun(tenantId, runId, options?.transaction)
    if (!cancelled) return false
    if (options?.deferSystemEvent !== true) {
      await this.appendQueuedAutomationCancellation(runId, reason)
    }
    return true
  }

  /**
   * 取消状态提交后补写系统事件。run_events 非状态权威且 sequence 分配会重试，
   * 因此刻意不参与「取消 Run/Attempt + 标记 admission」的事务。
   */
  async appendQueuedAutomationCancellation(runId: string, reason: string): Promise<void> {
    // 事件在取消成功后补写；Attempt 已被同事务置为 cancelled，此时重读
    // current_attempt_id 仍指向它（run_events.attempt_id 有 FK，只有
    // 实际存在 Attempt 时才能写事件）。
    const run = await this.deps.runs.getRun(tenantId, runId)
    if (run?.currentAttemptId) {
      await this.deps.runs.appendSystemEvent({
        tenantId,
        runId,
        attemptId: run.currentAttemptId,
        eventType: 'run.cancelled',
        displayMessage: reason,
        safeMetadata: { reason },
        traceId: `trace-${runId}`,
      })
    }
  }
}
