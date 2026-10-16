import { isAdminRunPurpose } from '../../runtime/runtime-types.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { assertCurrentExecutionAuthorization, AuthorizationCheckUnavailableError } from '../current-execution-authorization.ts'
import { authorizationDenied, isAuthorizationDenial, RequestValidationError } from '../../../domain/authorization-errors.ts'
import type { RunRecord } from '../run-types.ts'
import { tenantId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/**
 * Execution-time authorization: the shared current-grant gate used by the Runtime, tool
 * calls and approvals, and the per-purpose recheck between claim and Runtime start.
 */
export class ExecutionAuthorizationGate {
  private readonly deps: OrchestrationDependencies

  constructor(deps: OrchestrationDependencies) {
    this.deps = deps
  }

  /** Production Runtime, tool checks and queue dispatch share this current-grant gate. */
  async assertCurrentRunAuthorization(manifest: RuntimeManifest, toolBindingsChecked = false): Promise<void> {
    return this.assertRunAuthorizationInState(manifest, ['running'], toolBindingsChecked)
  }

  async assertWaitingRunAuthorization(manifest: RuntimeManifest): Promise<void> {
    return this.assertRunAuthorizationInState(manifest, ['waiting'], false)
  }

  private async assertRunAuthorizationInState(
    manifest: RuntimeManifest,
    allowedStates: Array<RunRecord['status']>,
    toolBindingsChecked: boolean,
  ): Promise<void> {
    if (!this.deps.authorization) throw new AuthorizationCheckUnavailableError()
    try {
      const run = await this.deps.runs.getRun(tenantId, manifest.run_id)
      if (!run || run.taskId !== manifest.task_id || run.currentAttemptId !== manifest.attempt_id || run.requestedBy !== manifest.user_context.user_id
        || !allowedStates.includes(run.status)) throw authorizationDenied('Attempt 已结束、取消或被替代')
      if (manifest.principal_context && this.deps.tasks) {
        const task = await this.deps.tasks.getTask(tenantId, manifest.task_id)
        if (!task || task.initiatedByPrincipalId !== manifest.principal_context.initiated_by
          || task.executedAsPrincipalId !== manifest.principal_context.executed_as
          || task.requestedBy !== manifest.principal_context.disclosure_user_id) {
          throw authorizationDenied('Task 与 Attempt 固定身份不一致')
        }
      }
      await this.deps.memory?.assertCurrentReferences(manifest)
      // EX-02：摘要运行只读取清单内的对话文本，不带工具；只需确认目标会话仍可摘要。
      if (manifest.purpose === 'session-summary') {
        if (!await this.summarizable(manifest)) throw authorizationDenied('会话已移除或空间已归档，摘要未执行')
        return
      }
      // 管理会话沿用 requireSession 的创建者门禁（workspace_id 为空的 admin
      // 受众走独立查询）；团队会话是共享讨论（TW-10），会话不绑定创建者与
      // Agent——非创建者成员亦可 @ 触发，其成员身份与按 Run 固定的 Agent
      // 成员版本由下方授权复核。分流必须用 isAdminRunPurpose 而非 purpose
      // 真值：purpose='automation' 是绑定工作空间的员工 Run，其会话为
      // workbench 受众，走 admin 门禁会必然失败。
      if (isAdminRunPurpose(manifest.purpose)) {
        if (!manifest.session_id) throw authorizationDenied('管理运行缺少 Session')
        await this.deps.conversations.requireSession(manifest.session_id, manifest.user_context.user_id, 'admin')
      } else if (manifest.session_id) {
        const session = await this.deps.conversations.findSessionRow(manifest.session_id)
        if (!session) throw authorizationDenied(`Session 不存在或不可访问：${manifest.session_id}`)
        if (session.workspaceId !== manifest.workspace_id
          || (session.workspaceType !== 'team'
            && (session.createdBy !== manifest.user_context.user_id || session.agentVersionId !== manifest.agent_version_id))) {
          throw authorizationDenied('会话归属或固定 Agent 已变化')
        }
      } else {
        if (!this.deps.tasks) throw new AuthorizationCheckUnavailableError()
        const task = await this.deps.tasks.getTask(tenantId, manifest.task_id)
        if (!task || task.requestedBy !== manifest.user_context.user_id || task.workspaceId !== manifest.workspace_id) {
          throw authorizationDenied('Task 归属或固定工作空间已变化')
        }
      }
      await assertCurrentExecutionAuthorization(this.deps.authorization, this.deps.content, manifest, this.deps.toolBindings, toolBindingsChecked)
    } catch (error) {
      if (isAuthorizationDenial(error) || error instanceof AuthorizationCheckUnavailableError) throw error
      throw new AuthorizationCheckUnavailableError(error)
    }
  }

  private async summarizable(manifest: RuntimeManifest): Promise<boolean> {
    const target = manifest.summary_target
    return Boolean(target && await this.deps.conversations.summarizableSessionWorkspace(target.session_id))
  }

  /** Decides, after a claim and before the Runtime runs, whether the Attempt may still execute. */
  async recheckExecutionAuthorization(
    run: RunRecord,
    manifest: RuntimeManifest,
  ): Promise<{ denied: false } | { denied: true; reason: string }> {
    // B-03/I-04：Attempt 固定的工具绑定修订对所有 purpose 生效——排队期间绑定
    // 被撤销、取代或语义漂移时，领取后在进入 Runtime 前收敛为授权失败。
    if (manifest.tool_bindings?.length) {
      if (!this.deps.toolBindings) return { denied: true, reason: '工具绑定复核服务不可用' }
      try {
        await this.deps.toolBindings.assertActiveToolBindings(manifest.tool_bindings)
      } catch (error) {
        if (isAuthorizationDenial(error) || error instanceof RequestValidationError) {
          return { denied: true, reason: error instanceof Error ? error.message : String(error) }
        }
        throw error
      }
    }
    if (manifest.mcp_connections?.length) {
      if (!this.deps.toolBindings || !manifest.agent_version_id) return { denied: true, reason: 'MCP Connector 授权复核服务不可用' }
      try {
        await this.deps.toolBindings.assertActiveMcpConnections(manifest.mcp_connections, manifest.agent_version_id)
      } catch (error) {
        if (isAuthorizationDenial(error) || error instanceof RequestValidationError) {
          return { denied: true, reason: error instanceof Error ? error.message : String(error) }
        }
        throw error
      }
    }
    if (manifest.purpose === 'session-summary') {
      return await this.summarizable(manifest)
        ? { denied: false }
        : { denied: true, reason: '会话已移除或空间已归档，摘要未执行' }
    }
    // 管理目的（admin-*）与发布试运行（agent-release-trial）都在执行时复核平台
    // 权限：试运行 Run 无 workspace_id，若只靠入队时校验，排队期间管理员被撤权
    // 仍会进入 DSH 执行。权限失效时 Run/Attempt 在此收敛为 failed。
    if (isAdminRunPurpose(manifest.purpose)) {
      if (!this.deps.authorization) return { denied: true, reason: '管理授权服务不可用' }
      try {
        if (manifest.purpose === 'admin-assistant') await this.deps.authorization.requireAdminReader(manifest.user_context.user_id)
        else await this.deps.authorization.requirePlatformAdmin(manifest.user_context.user_id)
        if (manifest.agent_version_id) await this.deps.authorization.assertAgentPrincipalSnapshot(
          manifest.agent_version_id, manifest.user_context.role_ids, manifest.data_scopes,
        )
        return { denied: false }
      } catch {
        return { denied: true, reason: manifest.purpose === 'admin-assistant' ? '管理读取权限已撤销' : '管理写权限已撤销' }
      }
    }
    if (manifest.purpose === 'agent-routine') {
      if (!this.deps.authorization) return { denied: true, reason: 'Agent 主动任务授权服务不可用' }
      try {
        await this.deps.authorization.assertAgentRoutineRun(manifest)
        return { denied: false }
      } catch (error) {
        if (isAuthorizationDenial(error) || error instanceof RequestValidationError) {
          return { denied: true, reason: error instanceof Error ? error.message : String(error) }
        }
        throw error
      }
    }
    if (!this.deps.authorization) return { denied: false }
    // AG-03：自动任务不分空间类型一律复核（补齐个人/独立空间被跳过的缺口）。
    // 三道：后台主体（目录新鲜度+active）→ 空间当前可执行 → 当前授权仍覆盖
    // Manifest 冻结的范围（受理时已与 scope_ceiling 求交，子集校验等价于
    // 「冻结快照没有越出当前授权」，期间被撤权立即掉出）。
    if (manifest.purpose === 'automation') {
      try {
        await this.deps.authorization.resolveAutomationSubject(manifest.user_context.user_id)
        // 暂停/停用兜底：受理后任务被暂停或停用的，排队中的 Attempt
        // 不得再进入 Runtime（主动清理只覆盖「仍 queued」的 Run，这条
        // 复核兜住「清理与领取竞态」及恢复重建的队列项）。试运行受理允许
        // draft/paused——那是显式用户动作；disabled 一律拒绝。
        if (this.deps.automationStatusLookup) {
          const automation = await this.deps.automationStatusLookup(run.id)
          const allowed = automation !== null
            && automation.status !== 'disabled'
            && (automation.trial || automation.status === 'enabled')
          if (!allowed) {
            // 到达这里：任务为 null / disabled，或非试运行且任务不在 enabled
            // （暂停，或异常落回 draft）。试运行只可能被 disabled 拒绝——
            // 该情形已由第一分支覆盖。
            const reason = !automation || automation.status === 'disabled'
              ? '任务已停用或不存在'
              : automation.status === 'paused'
                ? '任务已暂停'
                : '任务状态已变化'
            return { denied: true, reason }
          }
        }
        const workspaceType = await this.deps.authorization.workspaceTypeOf(manifest.workspace_id)
        if (workspaceType === null) return { denied: true, reason: '工作空间不存在或已归档' }
        const decision = workspaceType === 'team'
          ? await this.deps.authorization.authorizeTeamRunExecution({
              userId: manifest.user_context.user_id,
              workspaceId: manifest.workspace_id,
              agentVersionId: manifest.agent_version_id ?? '',
              requireAgentMember: true,
            })
          : await this.deps.authorization.authorizeRuntime({
              userId: manifest.user_context.user_id,
              workspaceId: manifest.workspace_id,
              agentVersionId: manifest.agent_version_id ?? '',
            })
        const missingScopes = manifest.data_scopes.filter(scope => !decision.dataScopes.includes(scope))
        if (missingScopes.length > 0) {
          return { denied: true, reason: `授权数据范围已收窄：${missingScopes.join('、')}` }
        }
        const missingRoles = manifest.user_context.role_ids.filter(role => !decision.roleIds.includes(role))
        if (missingRoles.length > 0) {
          return { denied: true, reason: `授权角色已收窄：${missingRoles.join('、')}` }
        }
        return { denied: false }
      } catch (error) {
        // 只有授权/校验类失败才收敛为 denied；基础设施错误（DB 抖动等）向上
        // 抛出，走 executeClaimed 的通用失败路径（RUNTIME_DISPATCH_FAILED）——
        // 不把瞬时故障写成「授权已撤销」的永久失败，也不把内部错误文案带进
        // run_events。
        if (isAuthorizationDenial(error) || error instanceof RequestValidationError) {
          return { denied: true, reason: error instanceof Error ? error.message : String(error) }
        }
        throw error
      }
    }
    // 独立运行（无 workspace）沿用既有路径，不做团队复核（AC-23）；必须在类型解析
    // 之前判断，否则 workspaceTypeOf(null|undefined|'standalone') 都返回 null 而被
    // 误判为「空间已归档」。
    if (!manifest.workspace_id) return { denied: false }
    const workspaceType = await this.deps.authorization.workspaceTypeOf(manifest.workspace_id)
    // 类型为 null 说明空间已归档或不存在，不能当作「非团队」跳过复核，否则归档后
    // 排队中的团队运行仍会进入 Runtime（1B-T4 / §6.5-3，与读取侧同一 fail-closed
    // 口径）。批次 1/A2 起个人与团队任务统一走 assertCurrentRunAuthorization 复核：
    // AC-23 约束的是个人空间的产品形态，不是豁免共同执行授权检查。
    if (workspaceType === null) return { denied: true, reason: '工作空间不存在或已归档' }
    try {
      // 绑定 pin 已在本函数顶部复核：此处跳过共享闸门的重复检查。
      await this.assertCurrentRunAuthorization(manifest, true)
      return { denied: false }
    } catch (error) {
      if (!isAuthorizationDenial(error)) throw error
      return { denied: true, reason: '当前身份、固定能力或输入资源授权已撤销' }
    }
  }

  /**
   * Converges a recheck-denied run to failed with a clear run_events note.
   * Defensive against concurrent convergence (systemCancelRun may already
   * have cancelled the run): terminal states are left untouched.
   */
  async failRunForRevokedAuthorization(run: RunRecord, manifest: RuntimeManifest, reason: string) {
    const attempt = await this.deps.runs.getAttempt(tenantId, manifest.attempt_id)
    const currentRun = await this.deps.runs.getRun(tenantId, run.id)
    const attemptId = attempt?.id ?? manifest.attempt_id
    let converged = false
    if (attempt && !['failed', 'cancelled', 'succeeded'].includes(attempt.status)) {
      await this.deps.runs.transitionAttempt(tenantId, attemptId, 'failed', 'AUTHORIZATION_REVOKED')
      converged = true
    }
    if (currentRun && !['failed', 'cancelled', 'succeeded'].includes(currentRun.status)) {
      await this.deps.runs.transitionRun(tenantId, run.id, 'failed')
      converged = true
    }
    // 并发收敛（系统取消等）已落终态时不重复写 run.failed 事件。
    if (!converged) return
    await this.deps.runs.appendSystemEvent({
      tenantId,
      runId: run.id,
      attemptId,
      eventType: 'run.failed',
      displayMessage: '授权已撤销，任务未执行',
      safeMetadata: { error_code: 'AUTHORIZATION_REVOKED', reason },
      traceId: `trace-${run.id}`,
    })
  }
}
