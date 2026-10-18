import { randomUUID } from 'node:crypto'

import {
  buildConversationContext,
  defaultConversationBudget,
  summaryDigest,
  summaryRunPrompt,
  type SummaryRequest,
} from '../../../domain/conversation-context.ts'
import { sha256 } from '../../runtime/canonical-json.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import type { RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { AttemptDispatcher } from './attempt-dispatcher.ts'
import { runtimeId, tenantId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/** Summary runs: no tools, short answer, bounded time. */
const summaryLimits = { timeout_seconds: 120, max_output_bytes: 32_768, max_tool_calls: 0 }

/**
 * EX-02: keeps long workbench conversations within the turn budget. After a
 * conversation Run finishes, decides whether the middle of the Session needs a
 * (new) summary and, if so, starts one `session-summary` Run through the normal
 * dispatcher → scheduler → Runtime Adapter → DSH chain. The Run has no Session of
 * its own, so its answer never becomes a chat message; it is stored as the
 * Session's summary when the Run succeeds. Failures only mean the next turns fall
 * back to trimming.
 */
export class SessionSummaryEntry {
  private readonly deps: OrchestrationDependencies
  private readonly dispatcher: AttemptDispatcher
  private readonly budget: AttemptBudget

  constructor(deps: OrchestrationDependencies, dispatcher: AttemptDispatcher, budget: AttemptBudget) {
    this.deps = deps
    this.dispatcher = dispatcher
    this.budget = budget
  }

  /** Called after a conversation Run completed; never throws. */
  async scheduleAfterRun(run: RunRecord): Promise<void> {
    if (!run.sessionId) return
    const sessionId = run.sessionId
    try {
      const workspaceId = await this.deps.conversations.summarizableSessionWorkspace(sessionId)
      if (!workspaceId) return
      const [messages, summary] = await Promise.all([
        this.deps.conversations.getConversationMessages(sessionId, null),
        this.deps.conversations.getCurrentConversationSummary(sessionId),
      ])
      const request = buildConversationContext(messages, summary).summaryRequest
      if (!request) return
      const summaryId = await this.deps.conversations.beginConversationSummary({
        sessionId,
        coverThrough: request.coverThrough,
        coveredMessageCount: request.coveredMessageCount,
      })
      if (!summaryId) return
      try {
        const summaryRun = await this.deps.runs.createRun({
          tenantId,
          sessionId: null,
          workspaceId,
          requestedBy: run.requestedBy,
          idempotencyKey: summaryId,
          taskSourceType: 'system',
          taskSourceRef: `session-summary:${sessionId}`,
          taskCorrelationKey: summaryId,
          taskRequestDigest: sha256(JSON.stringify(['session-summary/v1', sessionId, request.coverThrough, request.coveredMessageCount])),
        })
        // 关联摘要与派发同属“未派发 Run”的保护范围：任一失败都收敛该 Run，避免留下孤儿 queued Run。
        await this.dispatcher.failUndispatchedRun(summaryRun, async () => {
          await this.deps.conversations.attachConversationSummaryRun(summaryId, summaryRun.id)
          await this.dispatch(summaryRun, sessionId, request)
        })
      } catch (error) {
        await this.deps.conversations.abandonConversationSummary(summaryId, error instanceof Error ? error.message : String(error))
        throw error
      }
    } catch (error) {
      console.warn('conversation summary was not started', sessionId, error instanceof Error ? error.message : error)
    }
  }

  /** Stores the outcome of a summary Run; returns false when the Run was not a summary Run. */
  async onRunTerminal(run: RunRecord, status: 'succeeded' | 'failed' | 'cancelled', output: string): Promise<boolean> {
    if (run.sessionId) return false
    const content = output.trim().slice(0, defaultConversationBudget.summaryChars)
    if (status === 'succeeded' && content) {
      return this.deps.conversations.finishConversationSummary(run.id, { content, sha256: summaryDigest(content) })
    }
    return this.deps.conversations.finishConversationSummary(run.id, {
      failure: status === 'succeeded' ? 'empty summary' : `summary run ${status}`,
    })
  }

  private async dispatch(run: RunRecord, sessionId: string, request: SummaryRequest) {
    const prompt = summaryRunPrompt(request)
    const route = await this.deps.models.resolveRoute('default')
    const runtimePolicy = await this.deps.operations?.getRuntimePolicy(runtimeId)
    const limits = {
      ...summaryLimits,
      timeout_seconds: Math.min(summaryLimits.timeout_seconds, runtimePolicy?.timeoutSeconds ?? summaryLimits.timeout_seconds),
    }
    const manifest: RuntimeManifest = {
      manifest_version: '1.0',
      purpose: 'session-summary',
      summary_target: { session_id: sessionId, covered_through_message_id: request.coverThrough.id },
      run_id: run.id,
      attempt_id: `attempt-${randomUUID()}`,
      task_id: run.taskId,
      session_id: null,
      workspace_id: '',
      agent_version_id: null,
      // feature-rules 第 12 条：每个执行的 Manifest 必须带时区，系统运行也按平台时区理解“今天/本周”。
      timezone: this.deps.timezone,
      agent_configuration: { system_prompt: prompt.systemPrompt, skill_instructions: [] },
      user_context: { user_id: run.requestedBy, tenant_id: tenantId, role_ids: [] },
      principal_context: await this.dispatcher.principalContextForRun(run, `principal-system-${tenantId}`, 1),
      permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'deny' },
      skills: [],
      tools: [],
      data_scopes: [],
      knowledge_context: [],
      model_route_id: route.routeId,
      input: { message: prompt.message, file_mounts: [] },
      budget: await this.budget.manifest(run, limits),
      limits,
      created_at: new Date().toISOString(),
      trace_id: `trace-${run.id}-summary`,
    }
    await this.dispatcher.submit(run, manifest, route)
  }
}
