import { MAX_MCP_CONNECTIONS_PER_ATTEMPT } from '../runtime/runtime-types.ts'
import type { AgentMcpScope } from '../../domain/types.ts'

export const DEFAULT_AGENT_MCP_SCOPE: AgentMcpScope = { mode: 'all', connectorIds: [] }

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { status: 422, code: 'validation_failed' })
}

/** Configuration is versioned, but endpoint and credentials remain Connector-owned. */
export function normalizeAgentMcpScope(value: unknown): AgentMcpScope {
  if (value === undefined || value === null) return { ...DEFAULT_AGENT_MCP_SCOPE, connectorIds: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('MCP 使用范围格式无效')
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some(key => key !== 'mode' && key !== 'connectorIds')) invalid('MCP 使用范围存在未知字段')
  const { mode, connectorIds } = candidate
  if (!['all', 'selected', 'none'].includes(mode as string) || !Array.isArray(connectorIds)
    || connectorIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
    invalid('MCP 模式或连接器标识无效')
  }
  const ids = [...new Set(connectorIds as string[])].sort()
  if (mode === 'selected') {
    if (!ids.length || ids.length > MAX_MCP_CONNECTIONS_PER_ATTEMPT) {
      invalid(`选定模式必须选择 1～${MAX_MCP_CONNECTIONS_PER_ATTEMPT} 个 MCP Connector`)
    }
    return { mode: 'selected', connectorIds: ids }
  }
  if (ids.length) invalid('全部或不使用模式不能保留选定连接器')
  return { mode: mode as 'all' | 'none', connectorIds: [] }
}
