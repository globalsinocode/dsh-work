import { randomUUID } from 'node:crypto'

import { assertRuntimeModelRequirements } from '../../runtime/execution-capabilities.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { compileRuntimeManifest } from '../../runtime/manifest-compiler.ts'
import { toManifestToolBinding } from '../../../domain/tool-binding.ts'
import { agentRecommendationToolNames, builtinToolReference, executionToolNames, projectTaskToolNames, skillCreationToolNames } from '../../runtime/builtin-tools.ts'
import type { RuntimeAuthorizationDecision } from '../../authorization/postgres-authorization-service.ts'
import type { PreparedRuntimeFile } from '../../runtime/runtime-types.ts'
import { authorizationDenied } from '../../../domain/authorization-errors.ts'
import { invalidRequest } from '../../../domain/request-errors.ts'
import type { JsonObject, RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { AttemptScheduler } from './attempt-scheduler.ts'
import { agentDataToolRefs, toCapabilityReference, toRuntimeManifestSkill } from './manifest-helpers.ts'
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

  /** Builds the Agent Manifest for an employee, Task, automation, routine or delegated Run and submits it. */
  async dispatch(run: RunRecord, input: {
    prompt: string
    /** manifest 输入消息的重写（如续写指令）；缺省时使用 prompt。 */
    message?: string
    workspaceId: string
    agentVersionId: string
    workspaceAgentMemberId?: string
    userId: string
    fileIds: string[]
    preparedFiles?: PreparedRuntimeFile[]
    authorization?: RuntimeAuthorizationDecision
    additionalSkillReferences?: string[]
    /**
     * 会话级指定 Skill 的 `id@version`。与 additionalSkillReferences 不同：后者是授权用的
     * "额外能力引用集合"，这里只表达"用户指定了哪一个"，用于在 Manifest 里出现 selected_skill。
     */
    selectedSkillReference?: string
    history?: RuntimeManifest['input']['conversation_history']
    /** EX-02 summary of the conversation between the first message and the recent history. */
    conversationSummary?: RuntimeManifest['input']['conversation_summary'] | null
    /** AG-03/管理侧 purpose；缺省为员工交互运行（无 purpose 字段）。 */
    purpose?: RuntimeManifest['purpose']
    /** 确定性 Attempt ID（自动任务 = attempt-<executionId>），缺省随机。 */
    attemptId?: string
    /** 任务预算对 limits 的上限钳制（AG-03 budget）。 */
    limits?: { timeoutSeconds?: number; maxToolCalls?: number; maxOutputBytes?: number }
    /** PF-06 immutable parent/root lineage. */
    delegation?: NonNullable<RuntimeManifest['delegation_context']>
    /** 项目空间 S6：任务工具读/写模式（定时触发等场景）。 */
    projectTaskToolMode?: 'none' | 'read' | 'read-write'
    /**
     * 推荐方案 R3：个人空间中由员工发起的交互运行。仍须 Agent 版本开启“可推荐其他 AI 同事”；
     * 有 purpose 的运行（发布试运行、定时与主动任务、系统与管理运行）不装配。
     */
    personalConversation?: boolean
    /** 项目任务受理时固定的简报/档案版本，不在调度后重新读取。 */
    projectContext?: RuntimeManifest['project_context'] | null
    /** 员工时区：用于 Manifest 相对日期说明（定时任务等）。 */
    timezone?: string
  }) {
    const runtimePolicy = await this.deps.operations?.getRuntimePolicy(runtimeId)
    const agent = this.deps.agents
      ? await this.deps.agents.getRuntimeSnapshot(input.agentVersionId, input.additionalSkillReferences, undefined, input.userId)
      : {
          versionId: input.agentVersionId,
          modelRequirements: [],
          systemPrompt: '你是 dsh-work 企业员工助手。请给出准确、简洁、可执行的中文回答。',
          skills: [],
          skillInstructions: [],
          tools: [],
          coveringSkills: [],
          unavailableSkills: [],
          runtimeTools: [],
          toolBindings: [],
          skillCreationEnabled: false,
          mcpConnections: [],
          approvalMode: 'risk_based' as const,
          roleIds: ['role-employee'],
          dataScopes: ['enterprise:authorized'],
          maxOutputBytes: 65536,
          maxToolCalls: 20,
          timeoutSeconds: 300,
          projectTasksEnabled: false,
          agentRecommendationEnabled: false,
          delegationPolicy: { allowedAgentVersionIds: [], maxDepth: 1, maxParallel: 1, timeoutSeconds: 120 },
        }
    const delegationPolicy = agent.delegationPolicy ?? {
      allowedAgentVersionIds: [],
      maxDepth: 1,
      maxParallel: 1,
      timeoutSeconds: 120,
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
    const effectiveDataScopes = authorization?.dataScopes ?? agent.dataScopes
    // 企业知识（weknora-knowledge-plan 5.7）：一期只在个人空间的员工对话中检索，且只检索会话所选、
    // 员工当前可见的知识库。团队空间、定时任务、主动任务、验证运行与系统运行都不调用（2.1）。
    const knowledge = this.deps.knowledge && !input.purpose && input.personalConversation === true && run.sessionId
      ? await this.deps.knowledge.resolveContext({
          sessionId: run.sessionId,
          userId: input.userId,
          agentVersionId: input.agentVersionId,
          query: knowledgeQuery(input.prompt, input.history),
        })
      : null
    if (knowledge?.status === 'unavailable') {
      await this.deps.operations?.appendAudit(
        input.userId, 'knowledge.retrieve.unavailable', run.id, 'failed', `trace-${run.id}`,
        `企业知识库不可用，本次执行未注入知识（${knowledge.failureReason ?? 'unknown'}）`,
      )
    }
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
    // 工作簿内嵌图片：贴在文本挂载之外，单独计量、单独给出读取路径。
    const attachments = preparedFiles.flatMap(file => file.attachments)
    const attemptId = input.attemptId ?? `attempt-${randomUUID()}`
    const limits = {
      timeout_seconds: Math.min(agent.timeoutSeconds, runtimePolicy?.timeoutSeconds ?? agent.timeoutSeconds, input.limits?.timeoutSeconds ?? Number.POSITIVE_INFINITY),
      max_output_bytes: Math.min(agent.maxOutputBytes, 1024 * 1024, input.limits?.maxOutputBytes ?? Number.POSITIVE_INFINITY),
      max_tool_calls: Math.min(agent.maxToolCalls, input.limits?.maxToolCalls ?? Number.POSITIVE_INFINITY),
    }
    // 平台内置 Skill 排在 Agent 固定与会话选择的 Skill 之后；被覆盖或紧急停用的记录在 Manifest 中。
    // 内置 Skill 不经 Skill 授权或空间授权，执行前复核也不把它们当作附加 Skill（builtin-skills-plan 5.3）。
    const builtin = this.deps.builtinSkills?.resolve({
      disabled: runtimePolicy?.disabledBuiltinSkills ?? [],
      covering: agent.coveringSkills,
    }) ?? { skills: [], exclusions: [] }
    const skillInstructions = [...agent.skillInstructions, ...builtin.skills]
    const disabledTools = new Set(runtimePolicy?.disabledTools ?? [])
    const toolIdOf = (reference: string) => {
      const separator = reference.lastIndexOf('@')
      return separator > 0 ? reference.slice(0, separator) : reference
    }
    // 内置工具按注册表装配，去掉 Runtime 配置紧急停用的工具。
    // 项目任务工具按运行场景装配（S6），不进入 Agent 快照的默认 runtimeTools。
    // bash 始终装配（执行容器为必需，执行隔离方案 4.9；不可用时 Runtime 拒绝运行）；本方法只服务员工侧 Agent 运行，
    // 系统与管理运行（会话摘要、项目档案员、管理助手、Skill 安装与试运行）另行编译 Manifest。
    const toolNames = [
      ...agent.runtimeTools.map(toolIdOf),
      ...executionToolNames(),
      ...(skillInstructions.length ? ['activate_skill'] : []),
      ...(delegationPolicy.allowedAgentVersionIds.length ? ['delegate_agent'] : []),
      ...(this.deps.memory && input.purpose !== 'agent-routine' ? ['propose_memory'] : []),
      ...(!input.purpose
        ? projectTaskToolNames({
            enabled: Boolean(this.deps.projectTasks) && agent.projectTasksEnabled === true,
            mode: input.projectTaskToolMode ?? 'none',
          })
        : []),
      ...(!input.purpose
        ? agentRecommendationToolNames({
            enabled: agent.agentRecommendationEnabled === true,
            personalConversation: input.personalConversation === true,
          })
        : []),
      ...agentDataToolRefs(agent).map(tool => tool.id),
      ...(!input.purpose
        ? skillCreationToolNames({
            enabled: agent.skillCreationEnabled === true,
            personalConversation: input.personalConversation === true,
            bashAvailable: !disabledTools.has('bash'),
          })
        : []),
    ].filter(name => !disabledTools.has(name))
    // 执行隔离 2b-4：有解析文本的输入照常挂文本；装配了 bash 时另挂原始文件。二进制成果没有解析文本，
    // bash 被 Runtime 紧急停用时无法使用，在创建 Attempt 之前拒绝并说明原因。
    const withBash = toolNames.includes('bash')
    for (const file of preparedFiles) {
      if (!file.mount && !(withBash && file.original)) {
        throw invalidRequest(`“${file.sourceName}”需要运行命令的能力才能处理，本次运行不可用；请联系管理员确认 bash 未被停用`)
      }
    }
    const originalMounts = withBash ? preparedFiles.flatMap(file => file.original ? [file.original] : []) : []
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
      ...(input.workspaceAgentMemberId ? { workspace_agent_member_id: input.workspaceAgentMemberId } : {}),
      // 会话级指定 Skill：授权与快照固定在前置环节已完成，这里只把"指定"语义
      // 带进 Manifest（未指定时不出现该键），由提示词渲染让模型优先使用它。
      ...(input.selectedSkillReference ? { selected_skill: input.selectedSkillReference } : {}),
      agent_configuration: {
        system_prompt: agent.systemPrompt,
        skill_instructions: skillInstructions.map(toRuntimeManifestSkill),
      },
      user_context: {
        user_id: input.userId,
        tenant_id: tenantId,
        role_ids: authorization?.roleIds ?? agent.roleIds,
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
      skills: [...agent.skills, ...builtin.skills.map(skill => `${skill.id}@${skill.version}`)].map(toCapabilityReference),
      ...(agent.unavailableSkills?.length ? {
        unavailable_skills: agent.unavailableSkills.map(item => ({ skill: item.reference, name: item.name, reason: 'python_dependency_missing' as const, missing: item.missing })),
      } : {}),
      ...(builtin.exclusions.length ? {
        builtin_skill_exclusions: builtin.exclusions.map(item => ({
          skill: item.skill,
          reason: item.reason,
          ...(item.coveredBy ? { covered_by: item.coveredBy } : {}),
        })),
      } : {}),
      tools: [...new Set(toolNames)].map(name => {
        const pinned = agent.runtimeTools.find(reference => toolIdOf(reference) === name)
        return toCapabilityReference(pinned ?? builtinToolReference(name))
      }),
      // B-03/I-04：Attempt 固定本次解析的平台绑定修订；执行复核据此验证当前授权。
      ...(agent.toolBindings.length ? { tool_bindings: agent.toolBindings.map(toManifestToolBinding) } : {}),
      ...(agent.mcpConnections?.length ? { mcp_connections: agent.mcpConnections } : {}),
      data_scopes: effectiveDataScopes,
      knowledge_context: knowledge?.documents ?? [],
      ...(knowledge && knowledge.status !== 'not_applicable' ? { knowledge_status: knowledge.status } : {}),
      ...(knowledge?.skippedBases.length ? { knowledge_skipped_bases: knowledge.skippedBases } : {}),
      ...(memoryContext.length ? { memory_context: memoryContext.map(memory => ({
        memoryVersionId: memory.memoryVersionId,
        title: memory.title,
        version: memory.version,
        kind: memory.kind,
        visibility: memory.visibility,
        contentDigest: memory.contentDigest,
        excerpt: memory.excerpt,
      })) } : {}),
      ...(delegationPolicy.allowedAgentVersionIds.length ? {
        delegation_policy: {
          allowed_agent_version_ids: [...delegationPolicy.allowedAgentVersionIds],
          max_depth: delegationPolicy.maxDepth,
          max_parallel: delegationPolicy.maxParallel,
          timeout_seconds: delegationPolicy.timeoutSeconds,
        },
      } : {}),
      ...(input.delegation ? { delegation_context: input.delegation } : {}),
      ...(input.projectContext ? { project_context: input.projectContext } : {}),
      model_route_id: route.routeId,
      input: {
        message: (input.message ?? input.prompt).trim(),
        file_mounts: preparedFiles.flatMap(file => file.mount ? [file.mount] : []),
        ...(attachments.length ? { attachments } : {}),
        ...(originalMounts.length ? { original_mounts: originalMounts } : {}),
        ...(input.history?.length ? { conversation_history: input.history } : {}),
        ...(input.history?.length && input.conversationSummary ? { conversation_summary: input.conversationSummary } : {}),
      },
      budget: await this.budget.manifest(run, limits),
      limits,
      created_at: new Date().toISOString(),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      trace_id: `trace-${run.id}-${attemptId}`,
    }
    await this.submit(run, manifest, route, {
      knowledgeCitations: knowledge?.citations ?? [],
      memorySources: memoryContext.map(memory => ({
        memoryVersionId: memory.memoryVersionId,
        relevanceScore: memory.relevanceScore,
        excerpt: memory.excerpt,
      })),
      inputFiles: preparedFiles.map(file => ({
        fileId: file.fileId,
        extractionId: file.extractionId,
        mountPath: file.mount?.mount_path ?? file.original!.mount_path,
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
    sources: Pick<Parameters<OrchestrationDependencies['runs']['createAttempt']>[0], 'knowledgeCitations' | 'memorySources' | 'inputFiles'> = {},
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

/** 上一条员工提问的末尾最多 500 字（4.3）。 */
const previousQuestionChars = 500

/**
 * 检索查询词（WK4、4.3）：同一会话中员工的上一条提问加本次提问，让“那第二条呢”这类追问也能
 * 检索到。由平台拼接，不调用模型改写。
 */
export function knowledgeQuery(
  prompt: string,
  history: RuntimeManifest['input']['conversation_history'] | undefined,
): string {
  const current = prompt.trim()
  const previous = [...(history ?? [])].reverse()
    .find(message => message.role === 'user' && message.content.trim() && message.content.trim() !== current)
    ?.content.trim()
  if (!previous) return current
  return `${previous.length > previousQuestionChars ? previous.slice(-previousQuestionChars) : previous}\n${current}`
}
