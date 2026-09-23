import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import { authorizationDenied, isAuthorizationDenial } from '../authorization/authorization-errors.ts'
import { isAdminRunPurpose } from '../runtime/runtime-types.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { PostgresToolConnectorService } from '../tool/postgres-tool-connector-service.ts'
import type { PostgresContentService } from '../workbench/application/postgres-content-service.ts'

export class AuthorizationCheckUnavailableError extends Error {
  readonly code = 'AUTHORIZATION_CHECK_UNAVAILABLE'
  readonly status = 503
  constructor(cause?: unknown) {
    super('当前授权检查不可用，任务未获准继续执行', { cause })
    this.name = 'AuthorizationCheckUnavailableError'
  }
}

/**
 * Manifest 声明了工具绑定 pin 但平台未接线绑定复核端口时的 fail-closed 信号。
 * 区别于一般基础设施不可用：队列认领点把它收敛为任务拒绝（fail 而非无限重排）。
 */
export class ToolBindingCheckUnavailableError extends AuthorizationCheckUnavailableError {
  constructor() {
    super()
    this.name = 'ToolBindingCheckUnavailableError'
  }
}

type AuthorizationPort = Pick<PostgresAuthorizationService,
  'workspaceTypeOf' | 'authorizeRuntime' | 'authorizeTeamRunExecution' | 'requireAdminReader' | 'requirePlatformAdmin' | 'requireActiveAgentPrincipal' | 'assertAgentPrincipalSnapshot'>

type ExecutionBindingAuthorizationPort = Partial<Pick<PostgresToolConnectorService,
  'assertActiveToolBindings' | 'assertActiveMcpConnections'>>

/** All checks use live grants and pinned versions. This never rewrites the Manifest. */
export async function assertCurrentExecutionAuthorization(
  authorization: AuthorizationPort,
  content: Pick<PostgresContentService, 'recheckRuntimeFiles'> | undefined,
  manifest: RuntimeManifest,
  bindings?: ExecutionBindingAuthorizationPort,
  toolBindingsChecked = false,
): Promise<void> {
  try {
    // B-03/I-04：Attempt 固定的工具绑定修订在 purpose 分流前统一复核——
    // 试运行与管理运行同样适用；撤销/被取代/语义漂移/行缺失一律拒绝。
    // Manifest 声明了 pin 而复核端口未接线时 fail-closed 为不可用。
    // 队列认领点已做同一检查时可跳过，避免每次认领重复查询。
    if (!toolBindingsChecked && manifest.tool_bindings?.length) {
      if (!bindings?.assertActiveToolBindings) throw new ToolBindingCheckUnavailableError()
      await bindings.assertActiveToolBindings(manifest.tool_bindings)
    }
    if (manifest.mcp_connections?.length) {
      if (!bindings?.assertActiveMcpConnections || !manifest.agent_version_id) throw new ToolBindingCheckUnavailableError()
      await bindings.assertActiveMcpConnections(manifest.mcp_connections, manifest.agent_version_id)
    }
    if (manifest.agent_version_id) await authorization.requireActiveAgentPrincipal(manifest.agent_version_id)
    // 管理目的集合以 isAdminRunPurpose 为准：agent-release-trial 不带 admin-
    // 前缀但同样是管理侧（无工作空间绑定），漏判会落入下方通用分支被
    // 「缺少固定工作空间」误拒；automation 不在集合内，继续走工作空间复核。
    if (isAdminRunPurpose(manifest.purpose)) {
      if (manifest.purpose === 'admin-assistant') await authorization.requireAdminReader(manifest.user_context.user_id)
      else await authorization.requirePlatformAdmin(manifest.user_context.user_id)
      if (manifest.agent_version_id) {
        await authorization.assertAgentPrincipalSnapshot(
          manifest.agent_version_id, manifest.user_context.role_ids, manifest.data_scopes,
        )
      }
      return
    }
    if (!manifest.workspace_id || !manifest.agent_version_id) {
      throw authorizationDenied('执行清单缺少固定工作空间或 Agent 版本')
    }
    const type = await authorization.workspaceTypeOf(manifest.workspace_id)
    if (type === null) throw authorizationDenied('工作空间不存在或已归档')
    const delegationCeiling = manifest.delegation_context
      ? {
          roleIds: manifest.delegation_context.role_ceiling,
          dataScopes: manifest.delegation_context.data_scope_ceiling,
        }
      : undefined
    const input = {
      userId: manifest.user_context.user_id,
      workspaceId: manifest.workspace_id,
      agentVersionId: manifest.agent_version_id,
      additionalSkillReferences: (manifest.skills ?? []).map(skill => `${skill.id}@${skill.version}`),
      ...(delegationCeiling ? { scopeCeiling: delegationCeiling } : {}),
    }
    const current = type === 'team'
      ? await authorization.authorizeTeamRunExecution({ ...input, requireAgentMember: Boolean(manifest.delegation_context) })
      : await authorization.authorizeRuntime(input)
    if (manifest.principal_context && (
      manifest.principal_context.executed_as !== current.executorPrincipalId
      || manifest.principal_context.disclosure_user_id !== manifest.user_context.user_id
    )) {
      throw authorizationDenied('任务快照的执行身份或披露用户已变化')
    }
    const scopes = new Set(current.dataScopes)
    if ((manifest.data_scopes ?? []).some(scope => !scopes.has(scope))) {
      throw authorizationDenied('任务快照包含当前已撤销的数据范围')
    }
    const roles = new Set(current.roleIds)
    if ((manifest.user_context.role_ids ?? []).some(role => !roles.has(role))) {
      throw authorizationDenied('任务快照包含当前已撤销的角色')
    }
    if (manifest.input.file_mounts.length) {
      if (!content) throw new AuthorizationCheckUnavailableError()
      await content.recheckRuntimeFiles(manifest)
    }
  } catch (error) {
    if (isAuthorizationDenial(error)) throw authorizationDenied('当前身份、固定能力或输入资源授权已撤销')
    if (error instanceof AuthorizationCheckUnavailableError) throw error
    throw new AuthorizationCheckUnavailableError(error)
  }
}
