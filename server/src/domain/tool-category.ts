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
 * 参与**运行时普通工具解析**的连接器范围（显式配置）。
 *
 * 管理面（`DSH 工具管理`、`listToolBindings`、目录同步）始终只认
 * `connector-dsh-workspace`；这里放宽的只是"Agent 引用的工具能否解析/执行"。
 * 默认值与上游源码一致（只含 DSH 运行时连接器），站点如需放行已准入的业务
 * 连接器，必须在部署配置里显式列出——取值属站点信息，不写进源码或仓库文档。
 */
export const ALLOWED_TOOL_CONNECTOR_IDS_ENV = 'DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS'

const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * 解析 `DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS`（逗号分隔）。DSH 运行时连接器
 * 恒在范围内，避免配置漏写把平台自身工具挡在门外；非法标识直接失败而不是静默丢弃，
 * 否则一个错别字会表现成"工具莫名不可用"。
 */
export function resolveAllowedToolConnectorIds(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configured = (env[ALLOWED_TOOL_CONNECTOR_IDS_ENV] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0)
  const malformed = configured.filter(value => !CONNECTOR_ID_PATTERN.test(value))
  if (malformed.length > 0) {
    throw new Error(`${ALLOWED_TOOL_CONNECTOR_IDS_ENV} 含非法连接器标识：${malformed.join('、')}`)
  }
  return [...new Set([DSH_RUNTIME_CONNECTOR_ID, ...configured])]
}

/**
 * dsh-work 内置执行工具由 Manifest 直接声明，不进入普通 Tool Binding。
 * 它们仍通过 DSH 发起调用并经过 Platform Tool Bridge 执行。
 */
export const DSH_WORK_EXECUTION_TOOL_REFS = new Set([
  'activate_skill@1.0.0',
  'python_execute@1.0.0',
  'propose_memory@1.0.0',
])
