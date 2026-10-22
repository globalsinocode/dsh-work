import type { RuntimeEvent, RuntimeManifest } from '../../runtime/runtime-types.ts'
import type { JsonObject, RunRecord, StoredRunEvent } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import { tenantId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/**
 * Persists Runtime events first, then applies their consequences: Run/Attempt state,
 * assistant messages with citations, budget settlement, model usage, audit and
 * delegation bookkeeping. Events of one Run are written strictly in order.
 */
export class RunEventRecorder {
  private readonly eventWrites = new Map<string, Promise<void>>()
  private readonly assistantOutputs = new Map<string, string>()
  private readonly deps: OrchestrationDependencies
  private readonly budget: AttemptBudget

  constructor(deps: OrchestrationDependencies, budget: AttemptBudget) {
    this.deps = deps
    this.budget = budget
  }

  /** Waits until every event queued so far for the Run has been written. */
  async flush(runId: string): Promise<void> {
    await this.eventWrites.get(runId)
  }

  /**
   * Drops the in-memory traces of a finished Attempt once its event chain settled.
   * eventWrites is keyed by Run and serializes all its Attempts: a retry started right
   * after a cancel appends to the same key, so only the chain tail this call observed
   * may be removed; a newer chain must stay or the new Attempt's writes are cut off.
   */
  async release(runId: string, attemptId: string): Promise<void> {
    const settledEventWrites = this.eventWrites.get(runId)
    await settledEventWrites
    if (settledEventWrites !== undefined && this.eventWrites.get(runId) === settledEventWrites) {
      this.eventWrites.delete(runId)
    }
    this.assistantOutputs.delete(attemptId)
  }

  /** Waits for every pending event write (service shutdown). */
  async drain(): Promise<void> {
    await Promise.all(this.eventWrites.values())
  }

  /** Queues a Runtime event; writes for one Run are applied strictly in order. */
  record(run: RunRecord, event: RuntimeEvent) {
    const previous = this.eventWrites.get(run.id) ?? Promise.resolve()
    const next = previous.then(() => this.persistEvent(run, event)).catch((error: unknown) => {
      console.error('persist runtime event failed', error)
    })
    this.eventWrites.set(run.id, next)
  }

  private async persistEvent(run: RunRecord, event: RuntimeEvent) {
    const stored: StoredRunEvent = {
      id: event.event_id,
      tenantId,
      runId: event.run_id,
      attemptId: event.attempt_id,
      sequence: event.sequence,
      eventType: event.event_type,
      displayMessage: event.display_message,
      safeMetadata: JSON.parse(JSON.stringify(event.safe_metadata)) as JsonObject,
      traceId: event.trace_id,
      occurredAt: event.occurred_at,
    }
    await this.deps.runs.appendEvent(stored)
    const eventRun = await this.deps.runs.getRun(tenantId, run.id)
    if (eventRun?.currentAttemptId !== event.attempt_id) return
    if (event.event_type === 'run.started') {
      await this.deps.runs.transitionAttempt(tenantId, event.attempt_id, 'running')
      await this.deps.runs.transitionRun(tenantId, run.id, 'running')
      await this.deps.delegation?.markChildRunning(run.id)
    } else if (event.event_type === 'run.waiting') {
      const approvalId = event.safe_metadata['approval_id']
      if (this.deps.persistentWait && typeof approvalId === 'string') {
        const activated = await this.deps.persistentWait.activateWaiting({
          approvalId, runId: run.id, attemptId: event.attempt_id,
        })
        if (!activated) return
      } else {
        await this.deps.runs.transitionAttempt(tenantId, event.attempt_id, 'waiting')
        await this.deps.runs.transitionRun(tenantId, run.id, 'waiting')
      }
      await this.deps.operations?.appendAudit(run.requestedBy, 'run.waiting', run.id, 'success', event.trace_id, 'Worker 已释放，等待动作审批')
    } else if (event.event_type === 'assistant.completed' && event.display_message) {
      let assistantContent = this.deps.knowledge
        ? await this.deps.knowledge.addCitationFooter(event.attempt_id, event.display_message)
        : event.display_message
      if (this.deps.memory) assistantContent = await this.deps.memory.addCitationFooter(event.attempt_id, assistantContent)
      this.assistantOutputs.set(event.attempt_id, assistantContent)
      if (run.sessionId) {
        await this.deps.conversations.appendMessage({
          sessionId: run.sessionId,
          runId: run.id,
          role: 'assistant',
          content: assistantContent,
          messageId: `message-assistant-${event.event_id}`,
        })
      }
    } else if (event.event_type === 'run.cancel_requested') {
      await this.transitionIfNeeded(run.id, event.attempt_id, 'cancel_requested')
    } else if (event.event_type === 'run.cancelled') {
      await this.budget.settle(event, 'cancelled', this.assistantOutputs.get(event.attempt_id) ?? '')
      await this.transitionIfNeeded(run.id, event.attempt_id, 'cancelled')
      await this.deps.persistentWait?.cancelPreparingForAttempt({ runId: run.id, attemptId: event.attempt_id })
      await this.deps.delegation?.cancelActiveDescendants(run.taskId, '父任务已取消，终止所有活动子任务')
      await this.deps.delegation?.observeChildTerminal(run.id)
    } else if (event.event_type === 'run.failed') {
      const code = typeof event.safe_metadata['error_code'] === 'string'
        ? event.safe_metadata['error_code']
        : 'RUNTIME_EXECUTION_FAILED'
      await this.budget.settle(event, 'failed', this.assistantOutputs.get(event.attempt_id) ?? '')
      await this.deps.runs.transitionAttempt(tenantId, event.attempt_id, 'failed', code)
      await this.deps.runs.transitionRun(tenantId, run.id, 'failed')
      await this.deps.persistentWait?.cancelPreparingForAttempt({ runId: run.id, attemptId: event.attempt_id })
      const attempt = await this.deps.runs.getAttempt(tenantId, event.attempt_id)
      if (attempt) await this.deps.operations?.recordModelUsage({
        run,
        attempt,
        prompt: await this.getRunPrompt(run, event.attempt_id),
        output: this.assistantOutputs.get(event.attempt_id) ?? '',
        status: 'failed',
        traceId: event.trace_id,
      })
      await this.deps.operations?.appendAudit('system', 'run.failed', run.id, 'failed', event.trace_id, code)
      await this.deps.delegation?.cancelActiveDescendants(run.taskId, '父任务失败，终止所有活动子任务')
      await this.deps.delegation?.observeChildTerminal(run.id)
      if (run.sessionId) {
        await this.deps.conversations.writeRunTerminalNotificationIfTeam({
          sessionId: run.sessionId,
          runId: run.id,
          requestedBy: run.requestedBy,
          kind: 'run_failed',
          dedupeKey: `run-terminal:${event.event_id}`,
        })
      }
    } else if (event.event_type === 'run.completed') {
      const attempt = await this.deps.runs.getAttempt(tenantId, event.attempt_id)
      const assistantOutput = this.assistantOutputs.get(event.attempt_id) ?? ''
      await this.budget.settle(event, 'succeeded', assistantOutput)
      await this.deps.runs.transitionAttempt(tenantId, event.attempt_id, 'succeeded')
      await this.deps.runs.transitionRun(tenantId, run.id, 'succeeded')
      await this.deps.persistentWait?.cancelPreparingForAttempt({ runId: run.id, attemptId: event.attempt_id })
      if (attempt) await this.deps.operations?.recordModelUsage({
        run,
        attempt,
        prompt: await this.getRunPrompt(run, event.attempt_id),
        output: assistantOutput,
        status: 'success',
        traceId: event.trace_id,
        inputTokens: event.safe_metadata['token_usage_source'] === 'dsh-session-log'
          && typeof event.safe_metadata['input_tokens'] === 'number' ? event.safe_metadata['input_tokens'] : undefined,
        outputTokens: event.safe_metadata['token_usage_source'] === 'dsh-session-log'
          && typeof event.safe_metadata['output_tokens'] === 'number' ? event.safe_metadata['output_tokens'] : undefined,
      })
      await this.deps.operations?.appendAudit('system', 'run.completed', run.id, 'success', event.trace_id, 'DSH Runtime 执行完成')
      await this.deps.delegation?.cancelActiveDescendants(run.taskId, '父任务已结束，终止未收敛的活动子任务')
      await this.deps.delegation?.observeChildTerminal(run.id)
      if (run.sessionId) {
        await this.deps.conversations.writeRunTerminalNotificationIfTeam({
          sessionId: run.sessionId,
          runId: run.id,
          requestedBy: run.requestedBy,
          kind: 'run_completed',
          dedupeKey: `run-terminal:${event.event_id}`,
        })
      }
      this.assistantOutputs.delete(event.attempt_id)
    } else if (event.event_type === 'approval.resolved') {
      if (event.safe_metadata['tool_name'] === 'prepare_skill_installation') {
        await this.deps.operations?.appendAudit(run.requestedBy, 'skill.installation.tool.approval', run.id, event.safe_metadata['decision'] === 'allow_once' ? 'success' : 'blocked', event.trace_id, '安装预览工具权限检查；此授权不代表确认安装')
        return
      }
      if (['activate_skill', 'python_execute'].includes(String(event.safe_metadata['tool_name'] ?? ''))) {
        await this.deps.operations?.appendAudit(run.requestedBy, `skill.runtime.${event.safe_metadata['tool_name']}`, run.id, event.safe_metadata['decision'] === 'allow_once' ? 'success' : 'blocked', event.trace_id, '平台内置 Skill 运行工具审批')
        return
      }
      if (['inspect_admin_state', 'propose_admin_task', 'prepare_admin_action'].includes(String(event.safe_metadata['tool_name'] ?? ''))) {
        await this.deps.operations?.appendAudit(run.requestedBy, `admin.assistant.${event.safe_metadata['tool_name']}`, run.id, event.safe_metadata['decision'] === 'allow_once' ? 'success' : 'blocked', event.trace_id, '平台内置管理助手工具审批；工具本身不执行待确认写入')
        return
      }
      const decision = event.safe_metadata['decision']
      await this.deps.operations?.recordToolAudit({
        runId: run.id,
        attemptId: event.attempt_id,
        traceId: event.trace_id,
        metadata: event.safe_metadata,
        result: decision === 'allow_once' ? 'success' : 'blocked',
      })
    }
  }

  private async transitionIfNeeded(runId: string, attemptId: string, state: 'cancel_requested' | 'cancelled') {
    const attempt = await this.deps.runs.getAttempt(tenantId, attemptId)
    const run = await this.deps.runs.getRun(tenantId, runId)
    if (attempt && attempt.status !== state) await this.deps.runs.transitionAttempt(tenantId, attemptId, state)
    if (run && run.status !== state) await this.deps.runs.transitionRun(tenantId, runId, state)
  }

  private async getRunPrompt(run: RunRecord, attemptId: string): Promise<string> {
    if (run.sessionId) return this.deps.conversations.getRunPrompt(run.id)
    const attempt = await this.deps.runs.getAttempt(tenantId, attemptId)
    const manifest = attempt?.manifest as RuntimeManifest | undefined
    if (!manifest?.input?.message) throw new Error(`Run 没有关联的输入：${run.id}`)
    return manifest.input.message
  }
}
