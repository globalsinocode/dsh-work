import type { AgentDefinition, UpdateAgentDraftInput, UpdateRuntimeConfigurationInput } from '../../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { redactSensitiveText } from '../../../security/safe-observability.ts'
import { assertDraftCopyFields, assertDraftCopyPlan, DRAFT_COPY_POLICY } from '../../agent/agent-draft-copy-policy.ts'
import { authorizationDenied, requestInvalid } from '../../authorization/authorization-errors.ts'
import type { PostgresAgentService } from '../../agent/postgres-agent-service.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { canonicalJson, sha256 } from '../../runtime/canonical-json.ts'
import type { RunOrchestrationService } from '../../run/run-orchestration-service.ts'
import type { AdminSkillInstallationService } from '../../skill/admin-skill-installation-service.ts'
import type { PostgresSkillService } from '../../skill/postgres-skill-service.ts'
import { continueSkillSource, parseSkillSource, type SkillSource } from '../../skill/skill-source.ts'
import type { PostgresOperationsService } from './postgres-operations-service.ts'

const tenantId = 'tenant-dsh-work'

export type AdminTaskKind = 'skill-install' | 'agent-management' | 'platform-operations'
export type AdminActionType = 'agent-update-draft' | 'agent-set-status' | 'runtime-update-configuration'

export interface AdminTaskProposal {
  id: string
  runId: string
  kind: AdminTaskKind
  title: string
  assistantName: string
  purpose: 'admin-skill-install' | 'admin-agent-manage' | 'admin-platform-operations'
  request: string
  impact: string
  proposalSha256: string
  status: 'pending' | 'confirmed' | 'cancelled'
  delegatedRunId: string | null
}

export interface AdminActionPlan {
  id: string
  runId: string
  actionType: AdminActionType
  summary: string
  confirmationMode: 'single' | 'delegated'
  before: Record<string, unknown>
  after: Record<string, unknown>
  planSha256: string
  status: 'pending' | 'executing' | 'executed' | 'cancelled' | 'failed'
  resultSummary: string | null
}

interface ActionConfirmation {
  policy: typeof DRAFT_COPY_POLICY
  mode: 'single' | 'delegated'
  attemptId: string
  requestedFields: string[]
}

export type StoredActionPlan = (
  | { actionType: 'agent-update-draft'; before: AgentSnapshot; after: Omit<UpdateAgentDraftInput, 'actor'> }
  | { actionType: 'agent-set-status'; before: AgentStatusSnapshot; after: { agentId: string; status: 'published' | 'disabled' } }
  | { actionType: 'runtime-update-configuration'; before: RuntimeSnapshot; after: Omit<UpdateRuntimeConfigurationInput, 'actor'> & { revision: number } }
) & { confirmation?: ActionConfirmation }

interface ProposalRow {
  id: string
  sessionId: string
  runId: string
  kind: AdminTaskKind
  purpose: AdminTaskProposal['purpose']
  request: string
  summary: string
  impact: string
  source: SkillSource | null
  proposalSha256: string
  status: AdminTaskProposal['status']
  delegatedRunId: string | null
}

interface ActionRow {
  id: string
  sessionId: string
  runId: string
  actionType: AdminActionType
  summary: string
  plan: StoredActionPlan
  planSha256: string
  status: AdminActionPlan['status']
  resultSummary: string | null
  createdBy: string
}

type AgentSnapshot = Pick<AgentDefinition,
  'id' | 'name' | 'description' | 'owner' | 'department' | 'visibility' | 'roleIds' | 'dataScopes'
  | 'welcomeMessage' | 'examplePrompts' | 'systemPrompt' | 'maxOutputBytes' | 'maxToolCalls' | 'timeoutSeconds' | 'skills' | 'tools'
  | 'status' | 'version'
> & { revision: string }

interface AgentStatusSnapshot {
  id: string
  status: AgentDefinition['status']
  version: string
  revision: string
}

interface RuntimeSnapshot {
  runtimeId: string
  maxConcurrentWorkers: number
  attemptTimeoutMinutes: number
  schedulingStatus: 'accepting' | 'draining' | 'disabled'
  revision: number
}

export class AdminAssistantService {
  private readonly database: DatabaseClient
  private readonly orchestration: RunOrchestrationService
  private readonly authorization: PostgresAuthorizationService
  private readonly installation: AdminSkillInstallationService
  private readonly skills: PostgresSkillService
  private readonly agents: PostgresAgentService
  private readonly operations: PostgresOperationsService

  constructor(
    database: DatabaseClient,
    orchestration: RunOrchestrationService,
    authorization: PostgresAuthorizationService,
    installation: AdminSkillInstallationService,
    skills: PostgresSkillService,
    agents: PostgresAgentService,
    operations: PostgresOperationsService,
  ) {
    this.database = database
    this.orchestration = orchestration
    this.authorization = authorization
    this.installation = installation
    this.skills = skills
    this.agents = agents
    this.operations = operations
  }

  async list(userId: string) {
    await this.authorization.requireAdminReader(userId)
    return this.installation.list(userId)
  }

  async detail(userId: string, sessionId: string) {
    await this.authorization.requireAdminReader(userId)
    const conversation = await this.installation.detail(userId, sessionId)
    const [proposals, actions] = await Promise.all([
      this.readProposals(sessionId),
      this.readActions(sessionId),
    ])
    return {
      ...conversation,
      proposals: proposals.map(toTaskProposal),
      actions: actions.map(toActionPlan),
    }
  }

  async send(userId: string, input: { sessionId: string; message: string; requestId: string }) {
    await this.authorization.requireAdminReader(userId)
    assertMessageInput(input)
    // Validate before persistence so credential-bearing sources never enter conversation history.
    let source = parseSkillSource(input.message)
    await this.database`
      insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
      values (${input.sessionId}, ${tenantId}, ${userId}, ${input.message.slice(0, 80)}, 'active', 'admin', null, null)
      on conflict (tenant_id, id) do nothing
    `
    await this.requireSession(userId, input.sessionId)
    const history = await this.conversationHistory(input.sessionId)
    if (!source) {
      const [previous] = await this.database<{ source: SkillSource | null }[]>`
        select source from admin_assistant_task_proposals
         where tenant_id = ${tenantId} and session_id = ${input.sessionId} and source is not null
         order by created_at desc, id desc limit 1
      `
      source = continueSkillSource(input.message, previous?.source ?? null)
    }
    await this.orchestration.startAdminRun({
      userId,
      sessionId: input.sessionId,
      prompt: input.message,
      idempotencyKey: input.requestId,
      source: source ? JSON.stringify(source) : '',
      purpose: 'admin-assistant',
      history,
    })
    return this.detail(userId, input.sessionId)
  }

  async inspectState(input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) {
    signal.throwIfAborted()
    await this.requireManifestAuthorization(manifest)
    await this.requireActiveAttempt(manifest)
    const domain = readEnum(input, 'domain', ['overview', 'skills', 'agents', 'operations'] as const)
    const query = readOptionalString(input, 'query', 200)
    if (domain === 'skills') {
      const { items, ...snapshot } = selectAdminItems(await this.skills.getSkills(), query, 50)
      return { domain, ...snapshot, items: items.map(item => ({ id: item.id, name: item.name, status: item.status, version: item.version, category: item.category, toolIds: item.toolIds, updatedAt: item.updatedAt })) }
    }
    if (domain === 'agents') {
      const { items, ...snapshot } = selectAdminItems(await this.agents.getAgents(), query, 50)
      return { domain, ...snapshot, items: items.map(agent => omitKeys(agentSnapshot(agent, ''), ['revision'])) }
    }
    if (domain === 'operations') {
      const { items: runtimes, ...snapshot } = selectAdminItems(await this.operations.getRuntimes(), query, 20)
      return { domain, ...snapshot, runtimes, recentTasks: (await this.operations.getTaskSummaries()).slice(0, 30) }
    }
    const [skills, agents, runtimes, tasks] = await Promise.all([
      this.skills.getSkills(),
      this.agents.getAgents(),
      this.operations.getRuntimes(),
      this.operations.getTaskSummaries(),
    ])
    return {
      domain,
      skills: summarizeStatuses(skills),
      agents: summarizeStatuses(agents),
      runtimes: runtimes.map(item => ({ id: item.id, status: item.status, schedulingStatus: item.schedulingStatus, activeWorkers: item.activeWorkers, queuedRuns: item.queuedRuns })),
      recentTasks: tasks.slice(0, 20),
    }
  }

  async proposeTask(input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) {
    signal.throwIfAborted()
    if (manifest.purpose !== 'admin-assistant') throw new Error('当前 Run 不能创建管理任务提案')
    await this.authorization.requireAdminReader(manifest.user_context.user_id)
    await this.requireActiveAttempt(manifest)
    const kind = readEnum(input, 'kind', ['skill-install', 'agent-management', 'platform-operations'] as const)
    const summary = readString(input, 'summary', 4, 240)
    const impact = readString(input, 'impact', 4, 500)
    const purpose = purposeFor(kind)
    const source = kind === 'skill-install' ? parseManifestSource(manifest.installation_source) : null
    if (kind === 'skill-install' && !source) throw new Error('安装 Skill 前必须由管理员提供有效来源')
    const immutable = { kind, purpose, request: manifest.input.message, summary, impact, source }
    const digest = sha256(canonicalJson(immutable))
    const id = `admin-proposal-${manifest.run_id}`
    await this.database`
      insert into admin_assistant_task_proposals (
        id, tenant_id, session_id, run_id, created_by, task_kind, target_purpose,
        request_text, summary, impact, source, proposal_sha256
      ) values (
        ${id}, ${tenantId}, ${manifest.session_id}, ${manifest.run_id}, ${manifest.user_context.user_id},
        ${kind}, ${purpose}, ${manifest.input.message}, ${summary}, ${impact},
        ${source ? this.database.json(JSON.parse(JSON.stringify(source))) : null}, ${digest}
      ) on conflict (tenant_id, run_id) do nothing
    `
    const proposal = (await this.readProposals(manifest.session_id)).find(item => item.runId === manifest.run_id)
    if (!proposal) throw new Error('管理任务提案保存失败')
    return toTaskProposal(proposal)
  }

  async confirmProposal(userId: string, proposalId: string, proposalSha256: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const proposal = await this.requireProposal(userId, proposalId)
    if (proposal.proposalSha256 !== proposalSha256) throw new Error('任务提案不存在或已变化，请重新查看')
    if (proposal.status === 'cancelled') throw new Error('任务提案已取消，请重新发起')
    if (proposal.status === 'confirmed' && proposal.delegatedRunId) {
      await this.recordDelegationReply(proposal, proposal.delegatedRunId)
      return this.detail(userId, proposal.sessionId)
    }
    const [origin] = await this.database<{ status: string }[]>`
      select status from runs where tenant_id = ${tenantId} and id = ${proposal.runId}
    `
    if (origin?.status !== 'succeeded') throw new Error('管理助手尚未成功完成，请等待或重试')
    const delegated = await this.orchestration.startAdminRun({
      userId,
      sessionId: proposal.sessionId,
      prompt: proposal.request,
      idempotencyKey: `delegate-${proposal.id}`,
      source: proposal.source ? JSON.stringify(proposal.source) : '',
      purpose: proposal.purpose,
      history: await this.conversationHistory(proposal.sessionId),
    })
    await this.database`
      update admin_assistant_task_proposals
         set status = 'confirmed', delegated_run_id = ${delegated.id}, resolved_at = now()
       where tenant_id = ${tenantId} and id = ${proposal.id} and status = 'pending'
    `
    await this.recordDelegationReply(proposal, delegated.id)
    await this.operations.appendAudit(userId, 'admin.assistant.delegate', proposal.id, 'success', `trace-${delegated.id}`, `管理员确认调用 ${assistantNameFor(proposal.kind)}；专用 Run ${delegated.id}`).catch(() => undefined)
    return this.detail(userId, proposal.sessionId)
  }

  async cancelProposal(userId: string, proposalId: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const proposal = await this.requireProposal(userId, proposalId)
    if (proposal.status === 'confirmed') throw new Error('专用助手已经启动，不能再取消任务提案')
    await this.database`
      update admin_assistant_task_proposals set status = 'cancelled', resolved_at = now()
       where tenant_id = ${tenantId} and id = ${proposal.id} and status = 'pending'
    `
    await this.operations.appendAudit(userId, 'admin.assistant.delegate.cancel', proposal.id, 'success', `trace-${proposal.runId}`, `管理员取消调用 ${assistantNameFor(proposal.kind)}`).catch(() => undefined)
    await this.recordReply(proposal.sessionId, proposal.runId, `message-${proposal.id}-cancelled`, `已取消调用“${assistantNameFor(proposal.kind)}”，未启动专用助手，也未修改平台数据。`)
    return this.detail(userId, proposal.sessionId)
  }

  async prepareAction(input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) {
    signal.throwIfAborted()
    assertOnlyKeys(input, ['actionType', 'target', 'summary', 'changes'])
    const single = manifest.purpose === 'admin-assistant'
    if (!single && manifest.purpose !== 'admin-agent-manage' && manifest.purpose !== 'admin-platform-operations') throw authorizationDenied('当前 Run 不能创建管理操作计划')
    await this.authorization.requirePlatformAdmin(manifest.user_context.user_id)
    await this.requireActiveAttempt(manifest)
    const actionType = readEnum(input, 'actionType', ['agent-update-draft', 'agent-set-status', 'runtime-update-configuration'] as const)
    const changes = readRecord(input, 'changes')
    if (single) {
      if (actionType !== 'agent-update-draft') throw authorizationDenied('权限、发布和 Runtime 操作必须经过专用助手的两次确认')
      assertDraftCopyFields(changes)
    }
    if (manifest.purpose === 'admin-agent-manage' && !actionType.startsWith('agent-')) throw authorizationDenied('Agent 管理助手不能创建运维计划')
    if (manifest.purpose === 'admin-platform-operations' && actionType !== 'runtime-update-configuration') throw authorizationDenied('平台运维助手不能创建 Agent 计划')
    const target = readString(input, 'target', 1, 160)
    const summary = readString(input, 'summary', 4, 300)
    const plan = await this.buildActionPlan(actionType, target, summary, changes)
    if (single && plan.actionType === 'agent-update-draft') assertDraftCopyPlan(plan.before, plan.after)
    plan.confirmation = { policy: DRAFT_COPY_POLICY, mode: single ? 'single' : 'delegated',
      attemptId: manifest.attempt_id, requestedFields: Object.keys(changes).sort() }
    const digest = sha256(canonicalJson(plan))
    const id = `admin-action-${manifest.run_id}`
    await this.database.begin(async transaction => {
      // Run lock prevents a late tool result from creating a live plan after cancel/retry.
      await this.requireActiveAttempt(manifest, transaction, true)
      signal.throwIfAborted()
      await transaction`
        insert into admin_assistant_action_plans (
          id, tenant_id, session_id, run_id, created_by, action_type, summary, plan, plan_sha256
        ) values (
          ${id}, ${tenantId}, ${manifest.session_id}, ${manifest.run_id}, ${manifest.user_context.user_id},
          ${actionType}, ${summary}, ${transaction.json(JSON.parse(JSON.stringify(plan)))}, ${digest}
        ) on conflict (tenant_id, run_id) do nothing
      `
    })
    const action = (await this.readActions(manifest.session_id)).find(item => item.runId === manifest.run_id)
    if (!action || action.planSha256 !== digest) throw requestInvalid('本次 Run 已有不同计划，请先取消后重新生成')
    return toActionPlan(action)
  }

  async confirmAction(userId: string, actionId: string, planSha256: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const action = await this.requireAction(userId, actionId)
    if (action.planSha256 !== planSha256 || sha256(canonicalJson(action.plan)) !== planSha256) throw new Error('操作计划不存在或已变化，请重新查看')
    if (action.status === 'executed') return this.detail(userId, action.sessionId)
    if (action.status !== 'pending') throw actionConflict(action.status === 'executing' ? '操作计划正在执行，请稍后刷新' : '操作计划已取消或失败，请重新生成')
    const [run] = await this.database<{ status: string }[]>`select status from runs where tenant_id = ${tenantId} and id = ${action.runId}`
    if (run?.status !== 'succeeded') throw new Error('管理助手尚未成功完成，请等待或重试')
    await this.assertConfirmationBoundary(action)
    try {
      await this.assertActionPrecondition(action.plan)
    } catch (cause) {
      const reason = redactSensitiveText(cause instanceof Error ? cause.message : '目标状态已变化')
      await this.database`
        update admin_assistant_action_plans
           set status = 'failed', result_summary = ${reason}, resolved_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and id = ${action.id} and status = 'pending'
      `
      await this.recordReply(action.sessionId, action.runId, `message-${action.id}-precondition-failed`, `操作计划已失效：${reason}\n本次未执行平台写入，请刷新状态并重新生成计划。`).catch(() => undefined)
      throw actionConflict(reason)
    }
    const started = await this.database`
      update admin_assistant_action_plans set status = 'executing', updated_at = now()
       where tenant_id = ${tenantId} and id = ${action.id} and status = 'pending'
       returning id
    `
    if (!started.length) throw actionConflict('操作计划状态已变化，请刷新')
    try {
      const resultSummary = await this.executeAction(action.plan, userId)
      const completed = await this.database`
        update admin_assistant_action_plans
           set status = 'executed', result_summary = ${resultSummary}, resolved_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and id = ${action.id} and status = 'executing'
         returning id
      `
      if (!completed.length) throw new Error('操作已经执行，但计划完成状态未能持久化；服务重启恢复将核对最终状态')
      await this.recordReply(action.sessionId, action.runId, `message-${action.id}-executed`, `${resultSummary}\n操作已按管理员确认的计划执行。`)
      await this.operations.appendAudit(userId, 'admin.assistant.action.confirm', action.id, 'success', `trace-${action.runId}`, resultSummary).catch(() => undefined)
    } catch (cause) {
      const reason = redactSensitiveText(cause instanceof Error ? cause.message : '执行失败')
      await this.database`
        update admin_assistant_action_plans
           set status = 'failed', result_summary = ${reason}, resolved_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and id = ${action.id} and status = 'executing'
      `
      await this.recordReply(action.sessionId, action.runId, `message-${action.id}-failed`, `操作计划执行失败：${reason}\n请刷新平台状态并重新生成计划，系统不会自动重试。`).catch(() => undefined)
      throw cause
    }
    return this.detail(userId, action.sessionId)
  }

  async recoverInterruptedActions() {
    const rows = await this.database<ActionRow[]>`
      select id, session_id as "sessionId", run_id as "runId", action_type as "actionType",
             summary, plan, plan_sha256 as "planSha256", status, result_summary as "resultSummary",
             created_by as "createdBy"
        from admin_assistant_action_plans
       where tenant_id = ${tenantId} and status = 'executing'
       order by updated_at, id
    `
    let recoveredExecuted = 0
    let failed = 0
    for (const action of rows) {
      const state = await this.classifyInterruptedAction(action.plan).catch(() => 'diverged' as const)
      if (state === 'after') {
        const resultSummary = actionResultSummary(action.plan)
        const resolved = await this.database`
          update admin_assistant_action_plans
             set status = 'executed', result_summary = ${resultSummary}, resolved_at = now(), updated_at = now()
           where tenant_id = ${tenantId} and id = ${action.id} and status = 'executing'
           returning id
        `
        if (!resolved.length) continue
        recoveredExecuted += 1
        await this.recordReply(action.sessionId, action.runId, `message-${action.id}-recovered-executed`, `${resultSummary}\n服务重启后已核对目标最终状态，并将操作计划恢复为已执行。`).catch(() => undefined)
        await this.operations.appendAudit(action.createdBy, 'admin.assistant.action.recover', action.id, 'success', `trace-${action.runId}`, '服务重启后核对目标状态，操作已执行').catch(() => undefined)
        continue
      }
      const reason = state === 'before'
        ? '服务重启中断了操作，目标仍处于执行前状态；系统未自动重试，请重新生成并确认计划。'
        : '服务重启后目标状态与计划前后状态均不一致；计划已失效，请人工核对后重新生成。'
      const resolved = await this.database`
        update admin_assistant_action_plans
           set status = 'failed', result_summary = ${reason}, resolved_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and id = ${action.id} and status = 'executing'
         returning id
      `
      if (!resolved.length) continue
      failed += 1
      await this.recordReply(action.sessionId, action.runId, `message-${action.id}-recovered-failed`, reason).catch(() => undefined)
      await this.operations.appendAudit(action.createdBy, 'admin.assistant.action.recover', action.id, 'failed', `trace-${action.runId}`, reason).catch(() => undefined)
    }
    return { inspected: rows.length, recoveredExecuted, failed }
  }

  async cancelAction(userId: string, actionId: string) {
    await this.authorization.requirePlatformAdmin(userId)
    const action = await this.requireAction(userId, actionId)
    if (action.status === 'executing' || action.status === 'executed') throw new Error('操作已经开始或完成，不能取消')
    await this.database`
      update admin_assistant_action_plans set status = 'cancelled', resolved_at = now(), updated_at = now()
       where tenant_id = ${tenantId} and id = ${action.id} and status in ('pending', 'failed')
    `
    await this.operations.appendAudit(userId, 'admin.assistant.action.cancel', action.id, 'success', `trace-${action.runId}`, '管理员取消待执行操作计划').catch(() => undefined)
    await this.recordReply(action.sessionId, action.runId, `message-${action.id}-cancelled`, '已取消操作计划，未按该计划修改平台数据。')
    return this.detail(userId, action.sessionId)
  }

  confirmInstallation(userId: string, runId: string, planSha256: string) {
    return this.installation.confirm(userId, runId, planSha256)
  }

  async cancel(userId: string, runId: string) {
    const owned = await this.requireRun(userId, runId)
    if (owned.purpose === 'admin-skill-install') return this.installation.cancel(userId, runId)
    if (owned.purpose === 'admin-assistant') await this.authorization.requireAdminReader(userId)
    else await this.authorization.requirePlatformAdmin(userId)
    await this.orchestration.cancelAdminRun(runId, userId)
    await this.database`update admin_assistant_task_proposals set status = 'cancelled', resolved_at = now() where tenant_id = ${tenantId} and run_id = ${runId} and status = 'pending'`
    await this.database`update admin_assistant_action_plans set status = 'cancelled', resolved_at = now(), updated_at = now() where tenant_id = ${tenantId} and run_id = ${runId} and status = 'pending'`
    await this.recordReply(owned.sessionId, runId, `message-${runId}-admin-cancelled`, '管理助手任务已取消，未执行待确认的管理操作。')
    return this.detail(userId, owned.sessionId)
  }

  async retry(userId: string, runId: string) {
    const owned = await this.requireRun(userId, runId)
    if (owned.purpose === 'admin-skill-install') return this.installation.retry(userId, runId)
    if (owned.purpose === 'admin-assistant') await this.authorization.requireAdminReader(userId)
    else await this.authorization.requirePlatformAdmin(userId)
    await this.database`delete from admin_assistant_task_proposals where tenant_id = ${tenantId} and run_id = ${runId} and status <> 'confirmed'`
    await this.database`delete from admin_assistant_action_plans where tenant_id = ${tenantId} and run_id = ${runId} and status <> 'executed'`
    await this.orchestration.retryAdminRun(runId, userId)
    return this.detail(userId, owned.sessionId)
  }

  private async buildActionPlan(actionType: AdminActionType, target: string, summary: string, changes: Record<string, unknown>): Promise<StoredActionPlan> {
    if (actionType === 'runtime-update-configuration') {
      assertOnlyKeys(changes, ['maxConcurrentWorkers', 'attemptTimeoutMinutes', 'schedulingStatus'])
      const runtime = findUnique(await this.operations.getRuntimes(), target, 'Runtime')
      const before: RuntimeSnapshot = await this.operations.getRuntimeMutationSnapshot(runtime.id)
      const after = {
        ...before,
        ...(changes['maxConcurrentWorkers'] === undefined ? {} : { maxConcurrentWorkers: readInteger(changes, 'maxConcurrentWorkers', 1, 1000) }),
        ...(changes['attemptTimeoutMinutes'] === undefined ? {} : { attemptTimeoutMinutes: readInteger(changes, 'attemptTimeoutMinutes', 1, 60) }),
        ...(changes['schedulingStatus'] === undefined ? {} : { schedulingStatus: readEnum(changes, 'schedulingStatus', ['accepting', 'draining', 'disabled'] as const) }),
        revision: before.revision + 1,
      }
      if (canonicalJson(omitKeys(before, ['revision'])) === canonicalJson(omitKeys(after, ['revision']))) throw new Error('Runtime 操作计划没有实际变更')
      return { actionType, before, after }
    }

    const matchedAgent = findUnique(await this.agents.getAgents(), target, 'Agent')
    const mutation = await this.agents.getMutationSnapshot(matchedAgent.id)
    const agent = mutation.agent
    if (actionType === 'agent-set-status') {
      assertOnlyKeys(changes, ['status'])
      const status = readEnum(changes, 'status', ['published', 'disabled'] as const)
      if (agent.status === status) throw new Error('Agent 已处于目标状态')
      return {
        actionType,
        before: { id: agent.id, status: agent.status, version: agent.version, revision: mutation.revision },
        after: { agentId: agent.id, status },
      }
    }

    const allowed = ['name', 'description', 'visibility', 'roleIds', 'dataScopes', 'welcomeMessage', 'examplePrompts', 'systemPrompt', 'maxOutputBytes', 'maxToolCalls', 'timeoutSeconds', 'skills', 'tools', 'changeSummary']
    assertOnlyKeys(changes, allowed)
    const before = agentSnapshot(agent, mutation.revision)
    const after: Omit<UpdateAgentDraftInput, 'actor'> = {
      agentId: agent.id,
      name: readChangedString(changes, 'name', agent.name, 1, 120),
      description: readChangedString(changes, 'description', agent.description, 1, 1000),
      owner: agent.owner,
      department: agent.department,
      visibility: readChangedString(changes, 'visibility', agent.visibility, 1, 120),
      roleIds: readChangedStringArray(changes, 'roleIds', agent.roleIds, 100),
      dataScopes: readChangedStringArray(changes, 'dataScopes', agent.dataScopes, 100),
      welcomeMessage: readChangedString(changes, 'welcomeMessage', agent.welcomeMessage, 1, 2000),
      examplePrompts: readChangedStringArray(changes, 'examplePrompts', agent.examplePrompts, 20),
      systemPrompt: readChangedString(changes, 'systemPrompt', agent.systemPrompt, 20, 20000),
      maxOutputBytes: changes['maxOutputBytes'] === undefined ? agent.maxOutputBytes : readInteger(changes, 'maxOutputBytes', 1, 10_000_000),
      maxToolCalls: changes['maxToolCalls'] === undefined ? agent.maxToolCalls : readInteger(changes, 'maxToolCalls', 1, 10_000),
      timeoutSeconds: changes['timeoutSeconds'] === undefined ? agent.timeoutSeconds : readInteger(changes, 'timeoutSeconds', 1, 3600),
      skills: readChangedStringArray(changes, 'skills', agent.skills, 100),
      tools: readChangedStringArray(changes, 'tools', agent.tools, 100),
      changeSummary: readChangedString(changes, 'changeSummary', summary, 1, 1000),
    }
    const comparableAfter = { ...after, id: after.agentId, status: agent.status, version: agent.version }
    delete (comparableAfter as Partial<typeof comparableAfter>)['agentId']
    delete (comparableAfter as Partial<typeof comparableAfter>)['changeSummary']
    if (canonicalJson(omitKeys(before, ['revision'])) === canonicalJson(comparableAfter)) throw new Error('Agent 操作计划没有实际变更')
    return { actionType, before, after }
  }

  private async assertActionPrecondition(plan: StoredActionPlan) {
    if (plan.actionType === 'runtime-update-configuration') {
      const snapshot = await this.operations.getRuntimeMutationSnapshot(plan.before.runtimeId)
      if (canonicalJson(snapshot) !== canonicalJson(plan.before)) throw new Error('Runtime 状态已变化，请重新生成操作计划')
      return
    }
    const current = await this.agents.getMutationSnapshot(plan.before.id)
    const snapshot = plan.actionType === 'agent-set-status'
      ? { id: current.agent.id, status: current.agent.status, version: current.agent.version, revision: current.revision }
      : agentSnapshot(current.agent, current.revision)
    if (canonicalJson(snapshot) !== canonicalJson(plan.before)) throw new Error('Agent 配置已变化，请重新生成操作计划')
  }

  private async executeAction(plan: StoredActionPlan, userId: string) {
    if (plan.actionType === 'runtime-update-configuration') {
      await this.operations.updateRuntimeConfiguration({
        runtimeId: plan.after.runtimeId,
        maxConcurrentWorkers: plan.after.maxConcurrentWorkers,
        attemptTimeoutMinutes: plan.after.attemptTimeoutMinutes,
        schedulingStatus: plan.after.schedulingStatus,
        actor: userId,
      }, plan.before)
      return actionResultSummary(plan)
    }
    if (plan.actionType === 'agent-set-status') {
      await this.agents.setStatus({ ...plan.after, actor: userId }, plan.before.revision)
      return actionResultSummary(plan)
    }
    await this.agents.updateAgent({ ...plan.after, actor: userId }, plan.before.revision, { draftCopyOnly: plan.confirmation?.mode === 'single' })
    return actionResultSummary(plan)
  }

  private async classifyInterruptedAction(plan: StoredActionPlan): Promise<'before' | 'after' | 'diverged'> {
    if (plan.actionType === 'runtime-update-configuration') {
      const current = await this.operations.getRuntimeMutationSnapshot(plan.before.runtimeId)
      if (canonicalJson(current) === canonicalJson(plan.before)) return 'before'
      if (canonicalJson(current) === canonicalJson(plan.after)) return 'after'
      return 'diverged'
    }
    const current = await this.agents.getMutationSnapshot(plan.before.id)
    const before = plan.actionType === 'agent-set-status'
      ? { id: current.agent.id, status: current.agent.status, version: current.agent.version, revision: current.revision }
      : agentSnapshot(current.agent, current.revision)
    if (canonicalJson(before) === canonicalJson(plan.before)) return 'before'
    if (plan.actionType === 'agent-set-status') return current.agent.status === plan.after.status ? 'after' : 'diverged'
    return agentDraftMatchesPlan(current.agent, plan.after) ? 'after' : 'diverged'
  }

  private async requireManifestAuthorization(manifest: RuntimeManifest) {
    if (manifest.purpose === 'admin-assistant') return this.authorization.requireAdminReader(manifest.user_context.user_id)
    if (manifest.purpose === 'admin-agent-manage' || manifest.purpose === 'admin-platform-operations') return this.authorization.requirePlatformAdmin(manifest.user_context.user_id)
    throw new Error('当前 Run 不能查询管理状态')
  }

  private async requireSession(userId: string, sessionId: string) {
    const [row] = await this.database<{ id: string }[]>`
      select id from sessions
       where tenant_id = ${tenantId} and id = ${sessionId} and created_by = ${userId} and audience = 'admin' and status = 'active'
    `
    if (!row) throw new Error('管理对话不存在或不可访问')
    return row
  }

  private async requireRun(userId: string, runId: string) {
    const [row] = await this.database<{ sessionId: string; purpose: RuntimeManifest['purpose'] }[]>`
      select r.session_id as "sessionId", ra.manifest->>'purpose' as purpose
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
       where r.tenant_id = ${tenantId} and r.id = ${runId} and r.requested_by = ${userId}
         and s.created_by = ${userId} and s.audience = 'admin'
    `
    if (!row) throw new Error('管理助手运行不存在或不可访问')
    return row
  }

  private async requireActiveAttempt(manifest: RuntimeManifest, sql: DatabaseClient | DatabaseTransaction = this.database, lock = false) {
    const [row] = await sql<{ id: string }[]>`
      select r.id from runs r
      join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
      join run_attempts a on a.tenant_id = r.tenant_id and a.id = r.current_attempt_id and a.run_id = r.id
       where r.tenant_id = ${tenantId} and r.id = ${manifest.run_id} and r.current_attempt_id = ${manifest.attempt_id}
         and r.requested_by = ${manifest.user_context.user_id} and r.status = 'running'
         and s.id = ${manifest.session_id} and s.created_by = r.requested_by and s.audience = 'admin' and s.status = 'active'
         and a.status = 'running' and a.manifest->>'purpose' = ${manifest.purpose ?? ''}
      ${lock ? sql`for update of r` : sql``}
    `
    if (!row) throw authorizationDenied('Attempt 已结束、取消或被新 Attempt 替代')
  }

  private async assertConfirmationBoundary(action: ActionRow) {
    const [run] = await this.database<{ attemptId: string; purpose: RuntimeManifest['purpose'] }[]>`
      select r.current_attempt_id as "attemptId", a.manifest->>'purpose' as purpose
        from runs r join run_attempts a on a.tenant_id = r.tenant_id and a.id = r.current_attempt_id and a.run_id = r.id
       where r.tenant_id = ${tenantId} and r.id = ${action.runId} and r.session_id = ${action.sessionId}
         and r.requested_by = ${action.createdBy} and r.status = 'succeeded' and a.status = 'succeeded'
    `
    const receipt = action.plan.confirmation
    if (!run || (receipt && (receipt.policy !== DRAFT_COPY_POLICY || receipt.attemptId !== run.attemptId))) {
      throw authorizationDenied('计划的 Attempt 已变化，请重新生成并确认')
    }
    if (receipt?.mode === 'single') {
      if (run.purpose !== 'admin-assistant' || action.plan.actionType !== 'agent-update-draft') throw authorizationDenied('一次确认计划类型不符')
      assertDraftCopyFields(Object.fromEntries(receipt.requestedFields.map(field => [field, true])))
      assertDraftCopyPlan(action.plan.before, action.plan.after)
      return
    }
    // Legacy plans remain delegated. No missing receipt can downgrade to single confirmation.
    const purpose = action.plan.actionType === 'runtime-update-configuration' ? 'admin-platform-operations' : 'admin-agent-manage'
    if (run.purpose !== purpose) throw authorizationDenied('专用助手受众不匹配，必须重新确认委派')
    const [proposal] = await this.database`
      select p.id from admin_assistant_task_proposals p
       where p.tenant_id = ${tenantId} and p.session_id = ${action.sessionId} and p.created_by = ${action.createdBy}
         and p.delegated_run_id = ${action.runId} and p.status = 'confirmed' and p.target_purpose = ${purpose}
    `
    if (!proposal) throw authorizationDenied('专用助手缺少第一次委派确认，不能执行计划')
  }

  private async requireProposal(userId: string, proposalId: string) {
    const [row] = await this.database<ProposalRow[]>`
      select p.id, p.session_id as "sessionId", p.run_id as "runId", p.task_kind as kind,
             p.target_purpose as purpose, p.request_text as request, p.summary, p.impact, p.source,
             p.proposal_sha256 as "proposalSha256", p.status, p.delegated_run_id as "delegatedRunId"
        from admin_assistant_task_proposals p
        join sessions s on s.tenant_id = p.tenant_id and s.id = p.session_id
       where p.tenant_id = ${tenantId} and p.id = ${proposalId} and p.created_by = ${userId}
         and s.created_by = ${userId} and s.audience = 'admin' and s.status = 'active'
    `
    if (!row) throw new Error('管理任务提案不存在或不可访问')
    return row
  }

  private async requireAction(userId: string, actionId: string) {
    const [row] = await this.database<ActionRow[]>`
      select a.id, a.session_id as "sessionId", a.run_id as "runId", a.action_type as "actionType",
             a.summary, a.plan, a.plan_sha256 as "planSha256", a.status, a.result_summary as "resultSummary",
             a.created_by as "createdBy"
        from admin_assistant_action_plans a
        join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
       where a.tenant_id = ${tenantId} and a.id = ${actionId} and a.created_by = ${userId}
         and s.created_by = ${userId} and s.audience = 'admin' and s.status = 'active'
    `
    if (!row) throw new Error('管理操作计划不存在或不可访问')
    return row
  }

  private readProposals(sessionId: string) {
    return this.database<ProposalRow[]>`
      select id, session_id as "sessionId", run_id as "runId", task_kind as kind,
             target_purpose as purpose, request_text as request, summary, impact, source,
             proposal_sha256 as "proposalSha256", status, delegated_run_id as "delegatedRunId"
        from admin_assistant_task_proposals
       where tenant_id = ${tenantId} and session_id = ${sessionId}
       order by created_at, id
    `
  }

  private readActions(sessionId: string) {
    return this.database<ActionRow[]>`
      select id, session_id as "sessionId", run_id as "runId", action_type as "actionType",
             summary, plan, plan_sha256 as "planSha256", status, result_summary as "resultSummary",
             created_by as "createdBy"
        from admin_assistant_action_plans
       where tenant_id = ${tenantId} and session_id = ${sessionId}
       order by created_at, id
    `
  }

  private async conversationHistory(sessionId: string) {
    const recent = await this.database<{ role: 'user' | 'assistant'; content: string }[]>`
      select role, left(content, 24000) as content from messages
       where tenant_id = ${tenantId} and session_id = ${sessionId} and role in ('user', 'assistant')
       order by created_at desc, id desc limit 12
    `
    let remaining = 24000
    return recent.map(message => {
      const bounded = remaining > 0 ? message.content.slice(-remaining) : ''
      remaining -= bounded.length
      return { role: message.role, content: bounded }
    }).filter(message => message.content).reverse()
  }

  private async recordReply(sessionId: string, runId: string, id: string, content: string) {
    await this.database.begin(async transaction => {
      await transaction`
        insert into messages (id, tenant_id, session_id, run_id, role, content)
        values (${id}, ${tenantId}, ${sessionId}, ${runId}, 'assistant', ${content})
        on conflict (id) do nothing
      `
      await transaction`update sessions set last_active_at = now() where tenant_id = ${tenantId} and id = ${sessionId}`
    })
  }

  private recordDelegationReply(proposal: ProposalRow, delegatedRunId: string) {
    return this.recordReply(
      proposal.sessionId,
      proposal.runId,
      `message-${proposal.id}-confirmed`,
      `已确认调用“${assistantNameFor(proposal.kind)}”，专用任务 ${delegatedRunId} 已创建。具体平台写入仍需核对结构化计划并再次确认。`,
    )
  }
}

function assertMessageInput(input: { sessionId: string; message: string; requestId: string }) {
  if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000) throw Object.assign(new Error('消息长度必须为 1～20000 个字符'), { status: 422, code: 'invalid_message' })
  if (!/^admin-session-[a-f0-9-]{36}$/.test(input.sessionId) || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw new Error('请求标识无效')
}

function purposeFor(kind: AdminTaskKind): AdminTaskProposal['purpose'] {
  if (kind === 'skill-install') return 'admin-skill-install'
  if (kind === 'agent-management') return 'admin-agent-manage'
  return 'admin-platform-operations'
}

function assistantNameFor(kind: AdminTaskKind) {
  if (kind === 'skill-install') return 'Skill 安装助手'
  if (kind === 'agent-management') return 'Agent 管理助手'
  return '平台运维助手'
}

function titleFor(kind: AdminTaskKind) {
  if (kind === 'skill-install') return '安装已有 Skill'
  if (kind === 'agent-management') return '准备 Agent 管理任务'
  return '准备平台运维任务'
}

function toTaskProposal(row: ProposalRow): AdminTaskProposal {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    title: row.summary || titleFor(row.kind),
    assistantName: assistantNameFor(row.kind),
    purpose: row.purpose,
    request: row.request,
    impact: row.impact,
    proposalSha256: row.proposalSha256,
    status: row.status,
    delegatedRunId: row.delegatedRunId,
  }
}

function toActionPlan(row: ActionRow): AdminActionPlan {
  const presented = presentActionPlan(row.plan)
  return {
    id: row.id,
    runId: row.runId,
    actionType: row.actionType,
    summary: row.summary,
    confirmationMode: row.plan.confirmation?.mode === 'single' ? 'single' : 'delegated',
    before: presented.before,
    after: presented.after,
    planSha256: row.planSha256,
    status: row.status,
    resultSummary: row.resultSummary,
  }
}

function presentActionPlan(plan: StoredActionPlan): { before: Record<string, unknown>; after: Record<string, unknown> } {
  if (plan.actionType === 'runtime-update-configuration') {
    return { before: omitKeys(plan.before, ['revision']), after: omitKeys(plan.after, ['revision']) }
  }
  if (plan.actionType === 'agent-set-status') {
    return {
      before: { agentId: plan.before.id, status: plan.before.status },
      after: { ...plan.after },
    }
  }
  return {
    before: { agentId: plan.before.id, ...omitKeys(plan.before, ['id', 'status', 'version', 'revision']) },
    after: omitKeys(plan.after, ['changeSummary']),
  }
}

function parseManifestSource(value: string | undefined) {
  if (!value) return null
  try { return JSON.parse(value) as SkillSource }
  catch { throw new Error('Skill 来源快照无效') }
}

function agentSnapshot(agent: AgentDefinition, revision: string): AgentSnapshot {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    owner: agent.owner,
    department: agent.department,
    visibility: agent.visibility,
    roleIds: [...agent.roleIds],
    dataScopes: [...agent.dataScopes],
    welcomeMessage: agent.welcomeMessage,
    examplePrompts: [...agent.examplePrompts],
    systemPrompt: agent.systemPrompt,
    maxOutputBytes: agent.maxOutputBytes,
    maxToolCalls: agent.maxToolCalls,
    timeoutSeconds: agent.timeoutSeconds,
    skills: [...agent.skills],
    tools: [...agent.tools],
    status: agent.status,
    version: agent.version,
    revision,
  }
}

function agentDraftMatchesPlan(agent: AgentDefinition, after: Extract<StoredActionPlan, { actionType: 'agent-update-draft' }>['after']) {
  return agent.status === 'draft'
    && agent.id === after.agentId
    && agent.name === after.name
    && agent.description === after.description
    && agent.owner === after.owner
    && agent.department === after.department
    && agent.visibility === after.visibility
    && canonicalJson(agent.roleIds) === canonicalJson(after.roleIds)
    && canonicalJson(agent.dataScopes) === canonicalJson(after.dataScopes)
    && agent.welcomeMessage === after.welcomeMessage
    && canonicalJson(agent.examplePrompts) === canonicalJson(after.examplePrompts)
    && agent.systemPrompt === after.systemPrompt
    && agent.maxOutputBytes === after.maxOutputBytes
    && agent.maxToolCalls === after.maxToolCalls
    && agent.timeoutSeconds === after.timeoutSeconds
    && canonicalJson(agent.skills) === canonicalJson(after.skills)
    && canonicalJson(agent.tools) === canonicalJson(after.tools)
}

function actionResultSummary(plan: StoredActionPlan) {
  if (plan.actionType === 'runtime-update-configuration') {
    return `Runtime“${plan.after.runtimeId}”配置已更新为 ${plan.after.schedulingStatus}，最大并发 ${plan.after.maxConcurrentWorkers}，Attempt 超时 ${plan.after.attemptTimeoutMinutes} 分钟。`
  }
  if (plan.actionType === 'agent-set-status') return `Agent“${plan.after.agentId}”状态已更新为 ${plan.after.status}。`
  return `Agent“${plan.after.agentId}”的待发布草稿已按确认计划更新。`
}

function summarizeStatuses(items: Array<{ status: string }>) {
  return items.reduce<Record<string, number>>((summary, item) => {
    summary[item.status] = (summary[item.status] ?? 0) + 1
    return summary
  }, { total: items.length })
}

function matchesQuery(item: { id: string; name?: string }, query: string) {
  const normalized = query.toLocaleLowerCase('zh-CN')
  return !normalized || `${item.id} ${item.name ?? ''}`.toLocaleLowerCase('zh-CN').includes(normalized)
}

function selectAdminItems<T extends { id: string; name?: string }>(items: T[], query: string, limit: number) {
  const matches = query ? items.filter(item => matchesQuery(item, query)) : items
  const usedUnfilteredFallback = Boolean(query && matches.length === 0 && items.length > 0)
  const selected = (usedUnfilteredFallback ? items : matches).slice(0, limit)
  return {
    totalCount: items.length,
    filter: query || null,
    matchedCount: matches.length,
    returnedCount: selected.length,
    items: selected,
    ...(usedUnfilteredFallback ? { filterWarning: 'query 未匹配任何明确名称或 ID；items 已返回未筛选的平台快照。只有 totalCount 为 0 才表示平台没有该类对象。' } : {}),
  }
}

function findUnique<T extends { id: string; name?: string }>(items: T[], target: string, label: string): T {
  const normalized = target.trim().toLocaleLowerCase('zh-CN')
  const exact = items.filter(item => item.id.toLocaleLowerCase('zh-CN') === normalized || item.name?.toLocaleLowerCase('zh-CN') === normalized)
  if (exact.length !== 1) throw new Error(exact.length ? `${label} 目标不唯一：${target}` : `${label} 不存在：${target}`)
  return exact[0]!
}

function readRecord(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} 必须是对象`)
  return value as Record<string, unknown>
}

function readString(input: Record<string, unknown>, key: string, minimum: number, maximum: number) {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum) throw new Error(`${key} 长度必须为 ${minimum}～${maximum} 个字符`)
  return value.trim()
}

function readOptionalString(input: Record<string, unknown>, key: string, maximum: number) {
  if (input[key] === undefined) return ''
  return readString(input, key, 1, maximum)
}

function readEnum<const T extends readonly string[]>(input: Record<string, unknown>, key: string, values: T): T[number] {
  const value = input[key]
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`${key} 必须是 ${values.join('、')} 之一`)
  return value as T[number]
}

function readInteger(input: Record<string, unknown>, key: string, minimum: number, maximum: number) {
  const value = input[key]
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${key} 必须是 ${minimum}～${maximum} 的整数`)
  return value as number
}

function readChangedString(input: Record<string, unknown>, key: string, fallback: string, minimum: number, maximum: number) {
  return input[key] === undefined ? fallback : readString(input, key, minimum, maximum)
}

function readChangedStringArray(input: Record<string, unknown>, key: string, fallback: string[], maximum: number) {
  const value = input[key]
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${key} 必须是最多 ${maximum} 个非空字符串`)
  return [...new Set(value.map(item => (item as string).trim()))]
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: string[]) {
  const unexpected = Object.keys(input).filter(key => !allowed.includes(key))
  if (unexpected.length) throw new Error(`操作计划包含未支持字段：${unexpected.join('、')}`)
  if (!Object.keys(input).length) throw new Error('操作计划没有提供变更字段')
}

function omitKeys(input: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)))
}

function actionConflict(message: string) {
  return Object.assign(new Error(message), { status: 409, code: 'state_conflict' })
}
