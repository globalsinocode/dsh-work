import { randomUUID } from 'node:crypto'

import { assertRuntimeModelRequirements } from '../../runtime/execution-capabilities.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { compileRuntimeManifest } from '../../runtime/manifest-compiler.ts'
import { builtinToolReference, executionToolNames, projectTaskToolNames } from '../../runtime/builtin-tools.ts'
import type { PreparedRuntimeFile } from '../../workbench/application/postgres-content-service.ts'
import type { RuntimeAuthorizationDecision } from '../../authorization/postgres-authorization-service.ts'
import { authorizationDenied } from '../../../domain/authorization-errors.ts'
import type { JsonObject, RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { AttemptScheduler } from './attempt-scheduler.ts'
import { toCapabilityReference, toRuntimeManifestSkill } from './manifest-helpers.ts'
import { tenantId, runtimeId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/** Turns an accepted request into a persisted, queued Attempt with an immutable Manifest. */
export class AttemptDispatcher {
  private readonly deps: OrchestrationDependencies
  private readonly budget: AttemptBudget
  private readonly scheduler: AttemptScheduler

  constructor(deps: OrchestrationDependencies, budget: AttemptBudget, scheduler: AttemptScheduler) {
    this.deps = deps
    this.budget = budget
    this.scheduler = scheduler
  }

  /** Runs a pre-dispatch step; a failure before an Attempt exists fails the Run instead of leaving it queued. */
  async failUndispatchedRun(run: RunRecord, dispatch: () => Promise<void>) {
    try {
      await dispatch()
    } catch (error) {
      // Compilation/model routing can fail before an Attempt exists. Do not leave a ghost queue entry.
      await this.deps.runs.convergeUndispatchedRun(tenantId, run.id, 'failed')
      throw error
    }
  }

  /**
   * The single Agent Manifest builder: employee, Task, automation, routine and release-trial
   * Runs all go through here so validation runs exactly what employees will get. Callers
   * differ only in the authorization decision they pass (whose grants bound the run), the
   * purpose (which isolates external effects) and whether there is a workspace.
   */
  async dispatch(run: RunRecord, input: {
    prompt: string
    /** manifest 输入消息的重写（如续写指令）；缺省时使用 prompt。 */
    message?: string
    workspaceId: string
    agentVersionId: string
    userId: string
    fileIds: string[]
    preparedFiles?: PreparedRuntimeFile[]
    authorization?: RuntimeAuthorizationDecision
    additionalSkillReferences?: string[]
    history?: RuntimeManifest['input']['conversation_history']
    /** EX-02 summary of the conversation between the first message and the recent history. */
    conversationSummary?: RuntimeManifest['input']['conversation_summary'] | null
    /** AG-03/管理侧 purpose；缺省为员工交互运行（无 purpose 字段）。 */
    purpose?: RuntimeManifest['purpose']
    /** 确定性 Attempt ID（自动任务 = attempt-<executionId>），缺省随机。 */
    attemptId?: string
    /** 任务预算对 limits 的上限钳制（AG-03 budget）。 */
    limits?: { timeoutSeconds?: number; maxToolCalls?: number; maxOutputBytes?: number }
    /** IANA timezone for the run's "now" (routine/automation schedule); defaults to the platform's. */
    timezone?: string
    /**
     * 项目空间 S6：本运行是否装配项目任务工具。
     * `read-write` = 团队空间由人发起；`read` = 定时执行（无人在场）；缺省或 `none` = 不装配。
     * 仍须 Agent 版本开启 projectTasksEnabled；有 purpose 的系统/管理运行不得装配。
     */
    projectTaskToolMode?: 'none' | 'read' | 'read-write'
  }) {
    const runtimePolicy = await this.deps.operations?.getRuntimePolicy(runtimeId)
    const disabledTools = new Set(runtimePolicy?.disabledTools ?? [])
    const agent = this.deps.agents
      ? await this.deps.agents.getRuntimeSnapshot(input.agentVersionId, input.additionalSkillReferences)
      : {
          versionId: input.agentVersionId,
          modelRequirements: [],
          systemPrompt: '你是 dsh-work 企业员工助手。请给出准确、简洁、可执行的中文回答。',
          skills: [],
          skillInstructions: [],
          runtimeTools: [],
          projectTasksEnabled: false,
          mcpConnections: [],
          approvalMode: 'risk_based' as const,
          roleIds: ['role-employee'],
          maxOutputBytes: 65536,
          maxToolCalls: 20,
          timeoutSeconds: 300,
        }
    const route = await this.deps.models.resolveRoute('default', agent.modelRequirements)
    await assertRuntimeModelRequirements(this.deps.runtime, agent.modelRequirements, route)
    // Whose grants bound the run is the one thing entry points choose: employees run within
    // their own access, release trials within the Agent's own grants.
    const trial = input.purpose === 'agent-release-trial'
    const authorization = input.authorization ?? (trial
      ? await this.deps.authorization?.authorizeReleaseTrial({ userId: input.userId, agentVersionId: input.agentVersionId })
      : await this.deps.authorization?.authorizeRuntime({
          userId: input.userId,
          workspaceId: input.workspaceId,
          agentVersionId: input.agentVersionId,
          additionalSkillReferences: input.additionalSkillReferences,
        }))
    const effectiveDataScopes = authorization?.dataScopes ?? (trial ? [] : ['enterprise:authorized'])
    const knowledgeContext = this.deps.knowledge && input.purpose !== 'agent-routine'
      ? await this.deps.knowledge.resolveContext({
          query: input.prompt,
          userId: input.userId,
          workspaceId: input.workspaceId || null,
          dataScopes: effectiveDataScopes,
          roleIds: authorization?.roleIds,
        })
      : []
    // Experience is retrieved per person, workspace or organization. Runs without a
    // workspace (release trials) get none by design: validation checks SOUL.md, skills,
    // tools and access, not experience that differs per employee.
    const memoryContext = this.deps.memory && input.purpose !== 'agent-routine' && input.workspaceId
      ? await this.deps.memory.resolveContext({
          query: input.prompt,
          userId: input.userId,
          workspaceId: input.workspaceId,
          agentVersionId: input.agentVersionId,
          roleIds: authorization?.roleIds ?? agent.roleIds,
        })
      : []
    const preparedFiles = input.preparedFiles ?? (this.deps.content && run.sessionId
      ? await this.deps.content.prepareRuntimeFiles({
          sessionId: run.sessionId,
          fileIds: input.fileIds,
          userId: input.userId,
        })
      : [])
    // 项目空间 S1：任务线程的员工交互执行固定当时的项目简报版本。
    const thread = run.sessionId && !input.purpose && this.deps.projectTasks
      ? await this.deps.projectTasks.resolveTaskThread(run.sessionId)
      : null
    const attemptId = input.attemptId ?? `attempt-${randomUUID()}`
    const limits = {
      timeout_seconds: Math.min(agent.timeoutSeconds, runtimePolicy?.timeoutSeconds ?? agent.timeoutSeconds, input.limits?.timeoutSeconds ?? Number.POSITIVE_INFINITY),
      max_output_bytes: Math.min(agent.maxOutputBytes, 1024 * 1024, input.limits?.maxOutputBytes ?? Number.POSITIVE_INFINITY),
      max_tool_calls: Math.min(agent.maxToolCalls, input.limits?.maxToolCalls ?? Number.POSITIVE_INFINITY),
    }
    const manifest: RuntimeManifest = {
      manifest_version: '1.0',
      ...(input.purpose ? { purpose: input.purpose } : {}),
      model_requirements: agent.modelRequirements,
      run_id: run.id,
      attempt_id: attemptId,
      task_id: run.taskId,
      session_id: run.sessionId,
      workspace_id: input.workspaceId,
      agent_version_id: input.agentVersionId,
      agent_configuration: {
        system_prompt: agent.systemPrompt,
        skill_instructions: agent.skillInstructions.map(toRuntimeManifestSkill),
      },
      user_context: {
        user_id: input.userId,
        tenant_id: tenantId,
        role_ids: authorization?.roleIds ?? (trial ? [] : agent.roleIds),
      },
      ...((authorization?.executorPrincipalId ?? agent.principalId) ? {
        principal_context: await this.principalContextForRun(
          run,
          (authorization?.executorPrincipalId ?? agent.principalId)!,
          authorization?.executorAuthorizationVersion ?? agent.principalAuthorizationVersion ?? 1,
        ),
      } : {}),
      permission_policy: {
        approval_mode: agent.approvalMode,
        network_policy: agent.mcpConnections?.length ? 'allowlist' : 'deny',
        write_policy: 'workspace_only',
      },
      skills: agent.skills.map(toCapabilityReference),
      // 内置工具按注册表装配，去掉 Runtime 配置紧急停用的工具。
      // 项目任务工具按运行场景装配（S6），不进入 Agent 快照的默认 runtimeTools。
      // bash 只在本次启动的执行容器可用时装配（执行隔离阶段 2）；本方法只服务员工侧 Agent 运行，
      // 系统与管理运行（会话摘要、项目档案员、管理助手、Skill 安装与试运行）另行编译 Manifest。
      tools: [
        ...agent.runtimeTools,
        ...executionToolNames(this.deps.executionContainerAvailable),
        ...(agent.skillInstructions.length ? ['activate_skill'] : []),
        ...(this.deps.memory && input.purpose !== 'agent-routine' ? ['propose_memory'] : []),
        ...(!input.purpose
          ? projectTaskToolNames({
              enabled: agent.projectTasksEnabled,
              mode: input.projectTaskToolMode ?? 'none',
            })
          : []),
      ].filter(name => !disabledTools.has(name)).map(name => toCapabilityReference(builtinToolReference(name))),
      ...(agent.mcpConnections?.length ? { mcp_connections: agent.mcpConnections } : {}),
      data_scopes: effectiveDataScopes,
      knowledge_context: knowledgeContext.map(document => ({
        documentId: document.documentId,
        title: document.title,
        version: document.version,
        effectiveDate: document.effectiveDate,
        dataScope: document.dataScope,
        contentChecksum: document.contentChecksum,
        excerpt: document.excerpt,
      })),
      ...(memoryContext.length ? { memory_context: memoryContext.map(memory => ({
        memoryVersionId: memory.memoryVersionId,
        title: memory.title,
        version: memory.version,
        kind: memory.kind,
        visibility: memory.visibility,
        contentDigest: memory.contentDigest,
        excerpt: memory.excerpt,
      })) } : {}),
      ...(thread?.projectContext ? { project_context: thread.projectContext } : {}),
      model_route_id: route.routeId,
      input: {
        message: (input.message ?? input.prompt).trim(),
        file_mounts: preparedFiles.map(file => file.mount),
        ...(input.history?.length ? { conversation_history: input.history } : {}),
        ...(input.history?.length && input.conversationSummary ? { conversation_summary: input.conversationSummary } : {}),
      },
      budget: await this.budget.manifest(run, limits),
      limits,
      created_at: new Date().toISOString(),
      timezone: input.timezone ?? this.deps.timezone,
      trace_id: `trace-${run.id}-${attemptId}`,
    }
    await this.submit(run, manifest, route, {
      knowledgeSources: knowledgeContext.map(document => ({
        documentId: document.documentId,
        relevanceScore: document.relevanceScore,
        excerpt: document.excerpt,
      })),
      memorySources: memoryContext.map(memory => ({
        memoryVersionId: memory.memoryVersionId,
        relevanceScore: memory.relevanceScore,
        excerpt: memory.excerpt,
      })),
      inputFiles: preparedFiles.map(file => ({
        fileId: file.fileId,
        extractionId: file.extractionId,
        mountPath: file.mount.mount_path,
      })),
    })
  }

  /**
   * Common tail of every entry point: checks the fixed identity, asks the Runtime whether
   * it can run this Manifest, persists the compiled Attempt and queues it.
   */
  async submit(
    run: RunRecord,
    manifest: RuntimeManifest,
    route: unknown,
    sources: Pick<Parameters<OrchestrationDependencies['runs']['createAttempt']>[0], 'knowledgeSources' | 'memorySources' | 'inputFiles'> = {},
  ): Promise<void> {
    this.assertPrincipalContextForDispatch(manifest)
    await this.deps.runtime.assertAvailable?.(manifest)
    const compiled = compileRuntimeManifest(manifest)
    await this.deps.runs.createAttempt({
      attemptId: manifest.attempt_id,
      tenantId,
      runId: run.id,
      runtimeId,
      manifest: JSON.parse(compiled.canonicalJson) as JsonObject,
      manifestSha256: compiled.sha256,
      modelRouteSnapshot: JSON.parse(JSON.stringify(route)) as JsonObject,
      ...sources,
    })
    this.scheduler.enqueue(run, manifest)
  }

  async principalContextForRun(
    run: RunRecord,
    executorPrincipalId: string,
    executorAuthorizationVersion: number,
  ): Promise<NonNullable<RuntimeManifest['principal_context']>> {
    const task = await this.deps.tasks?.getTask(tenantId, run.taskId)
    if (this.deps.tasks && !task) throw authorizationDenied('Task 身份记录不存在')
    if (task && task.requestedBy !== run.requestedBy) throw authorizationDenied('Task 披露用户与 Run 不一致')
    return {
      initiated_by: task?.initiatedByPrincipalId ?? `principal-human-${run.requestedBy}`,
      executed_as: executorPrincipalId,
      disclosure_user_id: run.requestedBy,
      executor_authorization_version: executorAuthorizationVersion,
    }
  }

  assertPrincipalContextForDispatch(manifest: RuntimeManifest): void {
    // The production Task repository is the authoritative origin. Test and
    // Prototype ports may omit it; they cannot create a persisted Agent run.
    if (this.deps.tasks && !manifest.principal_context) {
      throw authorizationDenied('执行清单缺少独立 Principal 身份')
    }
  }
}
