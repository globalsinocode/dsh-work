import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import { authorizationDenied, isAuthorizationDenial } from '../../domain/authorization-errors.ts'
import { isAdminRunPurpose } from '../runtime/runtime-types.ts'
import type { McpConnectionSnapshot, RuntimeManifest } from '../runtime/runtime-types.ts'
import { isDshBuiltinTool } from '../runtime/builtin-tools.ts'
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
 * Manifest 固定了 MCP 连接但平台未接线复核端口时的 fail-closed 信号。
 * 区别于一般基础设施不可用：队列认领点把它收敛为任务拒绝（fail 而非无限重排）。
 */
export class ToolCheckUnavailableError extends AuthorizationCheckUnavailableError {
  constructor() {
    super()
    this.name = 'ToolCheckUnavailableError'
  }
}

/** 执行期的工具复核：Runtime 紧急停用的内置工具，以及 Attempt 固定的 MCP 连接。 */
export interface ExecutionToolCheckPort {
  /** Runtime 配置当前停用的内置工具。未接线时视为没有停用：这是运维开关，不是授权。 */
  disabledBuiltinTools?(): Promise<readonly string[]>
  assertPinnedConnections?(pins: readonly McpConnectionSnapshot[]): Promise<void>
}

/** Attempt 固定的内置工具中有被 Runtime 停用的，则拒绝启动、恢复或继续调用。 */
export async function assertBuiltinToolsEnabled(manifest: RuntimeManifest, checks?: ExecutionToolCheckPort): Promise<void> {
  if (!checks?.disabledBuiltinTools) return
  const builtin = manifest.tools.filter(tool => isDshBuiltinTool(tool.id))
  if (!builtin.length) return
  const disabled = new Set(await checks.disabledBuiltinTools())
  const blocked = builtin.filter(tool => disabled.has(tool.id)).map(tool => tool.id)
  if (blocked.length) throw authorizationDenied(`内置工具已被管理员停用：${blocked.join('、')}`)
}

type AuthorizationPort = Pick<PostgresAuthorizationService,
  'workspaceTypeOf' | 'authorizeRuntime' | 'authorizeTeamRunExecution' | 'requireAdminReader' | 'requirePlatformAdmin' | 'requireActiveAgentPrincipal' | 'assertAgentPrincipalSnapshot'>
  & Partial<Pick<PostgresAuthorizationService, 'assertAgentRoutineRun'>>

/** All checks use live grants and pinned versions. This never rewrites the Manifest. */
export async function assertCurrentExecutionAuthorization(
  authorization: AuthorizationPort,
  content: Pick<PostgresContentService, 'recheckRuntimeFiles'> | undefined,
  manifest: RuntimeManifest,
  tools?: ExecutionToolCheckPort,
  toolsChecked = false,
): Promise<void> {
  try {
    // 工具复核在 purpose 分流前统一进行，试运行与管理运行同样适用。
    // 队列认领点已做同一检查时可跳过，避免每次认领重复查询。
    if (!toolsChecked) await assertBuiltinToolsEnabled(manifest, tools)
    if (manifest.mcp_connections?.length) {
      if (!tools?.assertPinnedConnections) throw new ToolCheckUnavailableError()
      await tools.assertPinnedConnections(manifest.mcp_connections)
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
    if (manifest.purpose === 'agent-routine') {
      if (!authorization.assertAgentRoutineRun) throw new AuthorizationCheckUnavailableError()
      await authorization.assertAgentRoutineRun(manifest)
      if (manifest.input.file_mounts.length) throw authorizationDenied('Agent 主动任务暂不接受员工文件输入')
      return
    }
    if (!manifest.workspace_id || !manifest.agent_version_id) {
      throw authorizationDenied('执行清单缺少固定工作空间或 Agent 版本')
    }
    const type = await authorization.workspaceTypeOf(manifest.workspace_id)
    if (type === null) throw authorizationDenied('工作空间不存在或已归档')
    const input = {
      userId: manifest.user_context.user_id,
      workspaceId: manifest.workspace_id,
      agentVersionId: manifest.agent_version_id,
      additionalSkillReferences: (manifest.skills ?? []).map(skill => `${skill.id}@${skill.version}`),
    }
    const current = type === 'team'
      ? await authorization.authorizeTeamRunExecution(input)
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
