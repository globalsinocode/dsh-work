import { randomUUID } from 'node:crypto'

import { assertRuntimeModelRequirements } from '../../runtime/execution-capabilities.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { toManifestToolBinding } from '../../../domain/tool-binding.ts'
import { invalidRequest } from '../../../domain/request-errors.ts'
import { extractRunFailureReason } from '../../../domain/run-failure-reason.ts'
import type { ReleaseTrialResult, ReleaseTrialRunner } from '../../agent/release-trial-runner.ts'
import type { RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { AttemptDispatcher } from './attempt-dispatcher.ts'
import type { RunCancellation } from './run-cancellation.ts'
import { agentDataToolRefs, toCapabilityReference, toRuntimeManifestSkill } from './manifest-helpers.ts'
import { tenantId, runtimeId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

const TRIAL_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
/** 试运行治理等待在 Attempt 超时之外预留的排队与启动余量。 */
const TRIAL_WAIT_GRACE_SECONDS = 60
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Entry point for Agent release trials: one evaluation case through the real Runtime path. */
export class ReleaseTrialEntry implements ReleaseTrialRunner {
  private readonly deps: OrchestrationDependencies
  private readonly dispatcher: AttemptDispatcher
  private readonly budget: AttemptBudget
  private readonly cancellation: RunCancellation

  constructor(deps: OrchestrationDependencies, dispatcher: AttemptDispatcher, budget: AttemptBudget, cancellation: RunCancellation) {
    this.deps = deps
    this.dispatcher = dispatcher
    this.budget = budget
    this.cancellation = cancellation
  }

  /** ReleaseTrialRunner port: governance cancels a trial through the same system cancellation. */
  systemCancelRun(runId: string, cause: 'system_revoke', reason?: string) {
    return this.cancellation.systemCancelRun(runId, cause, reason)
  }

  async startReleaseTrialCase(input: {
    userId: string
    sessionId: string
    agentVersionId: string
    message: string
    idempotencyKey: string
    timezone?: string
  }): Promise<{ runId: string }> {
    if (!this.deps.agents) throw invalidRequest('验证执行链路未接入：缺少 Agent 运行时服务')
    const run = await this.deps.runs.createRun({
      tenantId, sessionId: input.sessionId, requestedBy: input.userId, idempotencyKey: input.idempotencyKey,
    })
    if (!run.currentAttemptId && run.status === 'queued') {
      await this.dispatcher.failUndispatchedRun(run, async () => {
        await this.deps.conversations!.appendMessage({
          sessionId: run.sessionId!, runId: run.id, role: 'user', content: input.message, messageId: `message-user-${run.id}`,
        })
        await this.dispatcher.dispatch(run, {
          prompt: input.message,
          workspaceId: '',
          agentVersionId: input.agentVersionId,
          userId: input.userId,
          fileIds: [],
          preparedFiles: [],
          purpose: 'agent-release-trial',
          timezone: input.timezone,
        })
      })
    }
    return { runId: run.id }
  }

  async getReleaseTrialResult(runId: string): Promise<ReleaseTrialResult | null> {
    const run = await this.deps.runs.getRun(tenantId, runId)
    if (!run) return null
    const attempt = run.currentAttemptId ? await this.deps.runs.getAttempt(tenantId, run.currentAttemptId) : null
    const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
    const outputs = terminal && this.deps.conversations
      ? await this.deps.conversations.getRunAssistantOutputs(run.id)
      : []
    return {
      status: run.status,
      attemptId: run.currentAttemptId ?? null,
      errorCode: attempt?.errorCode ?? null,
      output: outputs.map(output => output.content).join('\n'),
    }
  }

  /**
   * 发布试运行：以草稿版本的完整运行时配置经 Run/Attempt → Runtime Adapter → DSH
   * 真实执行一个评估案例，等待终态并返回输出。治理证据只允许来自这条链路。
   */
  async runReleaseTrialCase(input: {
    userId: string
    sessionId: string
    draftVersionId: string
    expectedDefinitionFingerprint?: string
    message: string
    idempotencyKey: string
    deadlineMs?: number
  }): Promise<{ runId: string; attemptId: string | null; status: string; output: string; failureReason?: string }> {
    if (!this.deps.agents) throw invalidRequest('试运行执行链路未接入：缺少 Agent 运行时服务')
    const run = await this.deps.runs.createRun({
      tenantId, sessionId: input.sessionId, requestedBy: input.userId, idempotencyKey: input.idempotencyKey,
    })
    if (!run.currentAttemptId && run.status === 'queued') {
      await this.deps.conversations.appendMessage({
        sessionId: run.sessionId!, runId: run.id, role: 'user', content: input.message, messageId: `message-user-${run.id}`,
      })
      await this.dispatcher.failUndispatchedRun(run, () => this.dispatchTrialAttempt(
        run, input.userId, input.draftVersionId, input.message, input.expectedDefinitionFingerprint,
      ))
    }
    // F-02：治理等待与生产一致，以本次 Attempt 实际生效的超时（Agent timeoutSeconds 受 Runtime 策略上限约束）
    // 为准，再留出排队与启动余量；不再固定 150 秒，避免长任务被治理侧提前判失败。
    let current = await this.deps.runs.getRun(tenantId, run.id)
    const attempt = current?.currentAttemptId ? await this.deps.runs.getAttempt(tenantId, current.currentAttemptId) : null
    const attemptTimeoutSeconds = Number((attempt?.manifest as { limits?: { timeout_seconds?: unknown } } | undefined)?.limits?.timeout_seconds)
    const deadline = Date.now() + (input.deadlineMs ?? (Number.isFinite(attemptTimeoutSeconds) && attemptTimeoutSeconds > 0
      ? (attemptTimeoutSeconds + TRIAL_WAIT_GRACE_SECONDS) * 1000
      : 150_000))
    while (current && !TRIAL_TERMINAL_STATUSES.has(current.status) && Date.now() < deadline) {
      await delay(200)
      current = await this.deps.runs.getRun(tenantId, run.id)
    }
    // 治理等待超时不能留 Run 继续执行：主动收敛为 cancelled，避免治理侧已放弃
    // 等待后底层 DSH 仍跑完并留下与试运行记录不一致的执行痕迹。
    if (current && !TRIAL_TERMINAL_STATUSES.has(current.status)) {
      await this.cancellation.systemCancelRun(run.id, 'system_revoke', '试运行等待超时，取消仍在运行的执行').catch(() => undefined)
      current = await this.deps.runs.getRun(tenantId, run.id)
    }
    const outputs = await this.deps.conversations.getRunAssistantOutputs(run.id)
    const status = current && TRIAL_TERMINAL_STATUSES.has(current.status) ? current.status : 'failed'
    // 运行时失败（区别于派发前被拒）此前不留任何原因：Run 有终态、Attempt 有 error_code，
    // 但试运行卡片只写 status=failed / outputExcerpt=''，审核人看到的是一个空白失败。
    // 真实原因在 run_events 的遥测里（如 RUNTIME_EXECUTION_FAILED 的 reason），这里取回来。
    const failureReason = status === 'failed' ? await this.readRunFailureReason(run.id) : undefined
    return {
      runId: run.id,
      attemptId: current?.currentAttemptId ?? null,
      status,
      output: outputs.map(output => output.content).join('\n'),
      ...(failureReason ? { failureReason } : {}),
    }
  }

  /** 取该 Run 最近一条失败事件的遥测原因，供治理侧展示；没有则返回 undefined。 */
  private async readRunFailureReason(runId: string): Promise<string | undefined> {
    const events = await this.deps.runs.readEvents(tenantId, runId).catch(() => [])
    return extractRunFailureReason(events.map(event => ({
      eventType: event.eventType,
      displayMessage: event.displayMessage,
      safeMetadata: event.safeMetadata,
    })))
  }

  private async dispatchTrialAttempt(run: RunRecord, userId: string, draftVersionId: string, message: string, expectedDefinitionFingerprint?: string) {
    const runtimePolicy = await this.deps.operations?.getRuntimePolicy(runtimeId)
    const agent = await this.deps.agents!.getRuntimeSnapshot(draftVersionId, [], expectedDefinitionFingerprint, userId)
    const trialScope = await this.deps.authorization?.resolveAgentPrincipalTrialScope(draftVersionId)
      ?? { roleIds: agent.roleIds, dataScopes: agent.dataScopes }
    await this.deps.authorization?.assertAgentPrincipalSnapshot(draftVersionId, trialScope.roleIds, trialScope.dataScopes)
    const route = await this.deps.models.resolveRoute('default', agent.modelRequirements)
    await assertRuntimeModelRequirements(this.deps.runtime, agent.modelRequirements, route)
    const delegationPolicy = agent.delegationPolicy ?? {
      allowedAgentVersionIds: [], maxDepth: 1, maxParallel: 1, timeoutSeconds: 120,
    }
    const limits = {
      timeout_seconds: Math.min(agent.timeoutSeconds, runtimePolicy?.timeoutSeconds ?? agent.timeoutSeconds),
      max_output_bytes: Math.min(agent.maxOutputBytes, 1024 * 1024),
      max_tool_calls: agent.maxToolCalls,
    }
    const manifest: RuntimeManifest = {
      manifest_version: '1.0',
      purpose: 'agent-release-trial',
      model_requirements: agent.modelRequirements,
      run_id: run.id,
      attempt_id: `attempt-${randomUUID()}`,
      task_id: run.taskId,
      session_id: run.sessionId,
      workspace_id: '',
      agent_version_id: draftVersionId,
      agent_configuration: {
        system_prompt: agent.systemPrompt,
        skill_instructions: agent.skillInstructions.map(toRuntimeManifestSkill),
      },
      user_context: { user_id: userId, tenant_id: tenantId, role_ids: trialScope.roleIds },
      ...(agent.principalId && agent.principalAuthorizationVersion ? {
        principal_context: await this.dispatcher.principalContextForRun(run, agent.principalId, agent.principalAuthorizationVersion),
      } : {}),
      // F-02：与员工执行使用同一权限策略与工具集，评测结论才能代表线上行为。
      // F-01：外部效果按 purpose 隔离——需审批的工具调用直接拒绝（不创建审批等待），
      // MCP 调用由 DSH 策略返回 trial_only，平台写工具/数据/记忆/委派各自返回 trial_only 或拒绝。
      permission_policy: {
        approval_mode: agent.approvalMode,
        network_policy: agent.mcpConnections?.length ? 'allowlist' : 'deny',
        write_policy: 'workspace_only',
      },
      skills: agent.skills.map(toCapabilityReference),
      tools: [...agent.runtimeTools.map(toCapabilityReference),
        ...(agent.skillInstructions.length ? [{ id: 'activate_skill', version: '1.0.0' }] : []),
        ...(delegationPolicy.allowedAgentVersionIds.length ? [{ id: 'delegate_agent', version: '1.0.0' }] : []),
        ...(this.deps.memory ? [{ id: 'propose_memory', version: '1.0.0' }] : []),
        ...agentDataToolRefs(agent)],
      ...(delegationPolicy.allowedAgentVersionIds.length ? {
        delegation_policy: {
          allowed_agent_version_ids: [...delegationPolicy.allowedAgentVersionIds],
          max_depth: delegationPolicy.maxDepth,
          max_parallel: delegationPolicy.maxParallel,
          timeout_seconds: delegationPolicy.timeoutSeconds,
        },
      } : {}),
      // B-03/I-04：试运行证据与实际执行同一绑定修订集；后续发布据此复核漂移。
      ...(agent.toolBindings.length ? { tool_bindings: agent.toolBindings.map(toManifestToolBinding) } : {}),
      ...(agent.mcpConnections?.length ? { mcp_connections: agent.mcpConnections } : {}),
      data_scopes: trialScope.dataScopes,
      knowledge_context: [],
      model_route_id: route.routeId,
      input: { message, file_mounts: [] },
      budget: await this.budget.manifest(run, limits),
      limits,
      created_at: new Date().toISOString(),
      trace_id: `trace-${run.id}-trial`,
    }
    await this.dispatcher.submit(run, manifest, route)
  }
}
