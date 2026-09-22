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
])
