import { randomUUID } from 'node:crypto'

import { assertRuntimeModelRequirements } from '../../runtime/execution-capabilities.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { toManifestToolBinding } from '../../../domain/tool-binding.ts'
import { invalidRequest } from '../../../domain/request-errors.ts'
import type { ReleaseTrialResult, ReleaseTrialRunner } from '../../agent/release-trial-runner.ts'
import type { RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { AttemptDispatcher } from './attempt-dispatcher.ts'
import type { RunCancellation } from './run-cancellation.ts'
import { toCapabilityReference, toRuntimeManifestSkill } from './manifest-helpers.ts'
import { tenantId, runtimeId, type OrchestrationDependencies } from './orchestration-dependencies.ts'


/**
 * Entry point for Agent validation (S3): one validation case through the real Runtime path.
 * Starting a case only creates and queues the Run; the case Attempt waits in the
 * `agent-release-trial` lane (at most two at a time, always leaving one Worker for
 * interactive work). The validation service reads the outcome later.
 */
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

  /** ReleaseTrialRunner port: validation cancels a case through the same system cancellation. */
  systemCancelRun(runId: string, cause: 'system_revoke', reason?: string) {
    return this.cancellation.systemCancelRun(runId, cause, reason)
  }

  /** Creates the case Run in the validation Session and queues its Attempt; does not wait. */
  async startReleaseTrialCase(input: {
    userId: string
    sessionId: string
    agentVersionId: string
    message: string
    idempotencyKey: string
  }): Promise<{ runId: string }> {
    if (!this.deps.agents) throw invalidRequest('验证执行链路未接入：缺少 Agent 运行时服务')
    const run = await this.deps.runs.createRun({
      tenantId, sessionId: input.sessionId, requestedBy: input.userId, idempotencyKey: input.idempotencyKey,
    })
    if (!run.currentAttemptId && run.status === 'queued') {
      await this.deps.conversations.appendMessage({
        sessionId: run.sessionId!, runId: run.id, role: 'user', content: input.message, messageId: `message-user-${run.id}`,
      })
      await this.dispatcher.failUndispatchedRun(run, () => this.dispatchTrialAttempt(
        run, input.userId, input.agentVersionId, input.message,
      ))
    }
    return { runId: run.id }
  }

  async getReleaseTrialResult(runId: string): Promise<ReleaseTrialResult | null> {
    const run = await this.deps.runs.getRun(tenantId, runId)
    if (!run) return null
    const attempt = run.currentAttemptId ? await this.deps.runs.getAttempt(tenantId, run.currentAttemptId) : null
    const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
    const outputs = terminal ? await this.deps.conversations.getRunAssistantOutputs(run.id) : []
    return {
      status: run.status,
      attemptId: run.currentAttemptId ?? null,
      errorCode: attempt?.errorCode ?? null,
      output: outputs.map(output => output.content).join('\n'),
    }
  }

  private async dispatchTrialAttempt(run: RunRecord, userId: string, agentVersionId: string, message: string) {
    const runtimePolicy = await this.deps.operations?.getRuntimePolicy(runtimeId)
    const agent = await this.deps.agents!.getRuntimeSnapshot(agentVersionId, [])
    // The Agent works with its own current grants, exactly as when an employee asks it.
    const trialScope = await this.deps.authorization?.resolveAgentPrincipalTrialScope(agentVersionId)
      ?? { roleIds: [], dataScopes: [] }
    await this.deps.authorization?.assertAgentPrincipalSnapshot(agentVersionId, trialScope.roleIds, trialScope.dataScopes)
    const route = await this.deps.models.resolveRoute('default', agent.modelRequirements)
    await assertRuntimeModelRequirements(this.deps.runtime, agent.modelRequirements, route)
    // Knowledge is retrieved as in production. Memory needs a workspace and is not
    // injected into validation runs.
    const knowledgeContext = this.deps.knowledge
      ? await this.deps.knowledge.resolveContext({
          query: message, userId, workspaceId: null, dataScopes: trialScope.dataScopes, roleIds: trialScope.roleIds,
        })
      : []
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
      agent_version_id: agentVersionId,
      agent_configuration: {
        system_prompt: agent.systemPrompt,
        skill_instructions: agent.skillInstructions.map(toRuntimeManifestSkill),
      },
      user_context: { user_id: userId, tenant_id: tenantId, role_ids: trialScope.roleIds },
      ...(agent.principalId && agent.principalAuthorizationVersion ? {
        principal_context: await this.dispatcher.principalContextForRun(run, agent.principalId, agent.principalAuthorizationVersion),
      } : {}),
      // Same permission policy and tool set as employee execution. External effects are
      // isolated by purpose: approval-gated calls are refused, MCP and platform writes
      // return trial_only.
      permission_policy: {
        approval_mode: agent.approvalMode,
        network_policy: agent.mcpConnections?.length ? 'allowlist' : 'deny',
        write_policy: 'workspace_only',
      },
      skills: agent.skills.map(toCapabilityReference),
      tools: [...agent.runtimeTools.map(toCapabilityReference),
        ...(agent.skillInstructions.length ? [{ id: 'activate_skill', version: '1.0.0' }] : []),
        ...(this.deps.memory ? [{ id: 'propose_memory', version: '1.0.0' }] : [])],
      // The candidate's frozen bindings; publication rechecks them for drift.
      ...(agent.toolBindings.length ? { tool_bindings: agent.toolBindings.map(toManifestToolBinding) } : {}),
      ...(agent.mcpConnections?.length ? { mcp_connections: agent.mcpConnections } : {}),
      data_scopes: trialScope.dataScopes,
      knowledge_context: knowledgeContext.map(document => ({
        documentId: document.documentId,
        title: document.title,
        version: document.version,
        effectiveDate: document.effectiveDate,
        dataScope: document.dataScope,
        contentChecksum: document.contentChecksum,
        excerpt: document.excerpt,
      })),
      model_route_id: route.routeId,
      input: { message, file_mounts: [] },
      budget: await this.budget.manifest(run, limits),
      limits,
      created_at: new Date().toISOString(),
      trace_id: `trace-${run.id}-trial`,
    }
    await this.dispatcher.submit(run, manifest, route, {
      knowledgeSources: knowledgeContext.map(document => ({
        documentId: document.documentId,
        relevanceScore: document.relevanceScore,
        excerpt: document.excerpt,
      })),
    })
  }
}
