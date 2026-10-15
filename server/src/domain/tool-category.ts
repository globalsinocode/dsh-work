/** dsh-work 工具来源分类及对应的治理路径。 */
export type ToolCategory =
  | 'dsh_builtin'
  | 'dsh_work_execution'
  | 'dsh_work_platform'
  | 'mcp_external'

export type ToolGovernanceMode =
  | 'tool_binding'
  | 'manifest_intrinsic'
  | 'purpose_scoped'
  | 'connector_grant'

export const DSH_RUNTIME_CONNECTOR_ID = 'connector-dsh-workspace'

/**
 * dsh-work 内置执行工具由 Manifest 直接声明，不进入普通 Tool Binding。
 * 它们仍通过 DSH 发起调用并经过 Platform Tool Bridge 执行。
 */
export const DSH_WORK_EXECUTION_TOOL_REFS = new Set([
  'activate_skill@1.0.0',
  'python_execute@1.0.0',
  'propose_memory@1.0.0',
])

/** These tools are confined to the current Attempt's isolated workspace/session. */
const runLocalAgentToolNames = new Set([
  'read', 'write', 'edit', 'read_image', 'todo_write',
])

/**
 * The seeded role/scope policy predates independent Agent identities. Only
 * the unchanged default policy has an Agent-side run-local exemption: changing
 * either policy dimension restores the ordinary explicit-grant requirement.
 * Availability, bindings, input mounts and the DSH workspace guard still apply.
 */
export function isDefaultRunLocalAgentTool(tool: {
  connectorId: string
  dshToolName: string | null
  allowedRoleIds: readonly string[]
  dataScopes: readonly string[]
}): boolean {
  return tool.connectorId === DSH_RUNTIME_CONNECTOR_ID
    && tool.dshToolName !== null
    && runLocalAgentToolNames.has(tool.dshToolName)
    && tool.allowedRoleIds.length === 2
    && tool.allowedRoleIds.includes('role-employee')
    && tool.allowedRoleIds.includes('role-platform-admin')
    && tool.dataScopes.length === 1
    && tool.dataScopes[0] === 'workspace:authorized'
}
