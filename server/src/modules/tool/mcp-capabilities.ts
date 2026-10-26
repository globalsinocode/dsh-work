import { canonicalJson, mcpToolSchemaDigest, sha256 } from '../runtime/canonical-json.ts'
import { invalidRequest } from '../../domain/request-errors.ts'

export interface McpCapability {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** 整个清单的摘要（名称、描述、输入 Schema），用于 Attempt 固定与并发确认。 */
export function mcpCapabilityDigest(capabilities: readonly McpCapability[]): string {
  return sha256(canonicalJson(capabilities))
}

export function normalizeMcpCapabilities(capabilities: readonly McpCapability[]): McpCapability[] {
  const names = new Set<string>()
  return capabilities.map(capability => {
    const name = capability.name.trim()
    if (!name || name.length > 200 || names.has(name)) throw invalidRequest(`MCP 返回了无效或重复的 Tool 名称：${name || '空名称'}`)
    names.add(name)
    return {
      name,
      description: capability.description.trim().slice(0, 2000),
      inputSchema: JSON.parse(JSON.stringify(capability.inputSchema ?? {})) as Record<string, unknown>,
    }
  }).sort((left, right) => left.name.localeCompare(right.name))
}

const toolKey = (capability: McpCapability) => `${capability.name}\u0000${mcpToolSchemaDigest(capability.inputSchema)}`

/**
 * 发现结果与生效清单合并：名称与输入 Schema 都未变的 Tool 继续生效并采用最新描述；
 * 远端删除的 Tool 随之下线；新增或 Schema 变化的 Tool 进入待确认，不生效。
 */
export function mergeMcpCapabilities(approved: readonly McpCapability[], discovered: readonly McpCapability[]): {
  effective: McpCapability[]
  pending: McpCapability[]
} {
  const discoveredByKey = new Map(discovered.map(capability => [toolKey(capability), capability]))
  const effective = approved.flatMap(capability => {
    const current = discoveredByKey.get(toolKey(capability))
    return current ? [current] : []
  }).sort((left, right) => left.name.localeCompare(right.name))
  return { effective, pending: pendingMcpCapabilities(effective, discovered) }
}

/** 已发现但未生效的 Tool：新增的，或输入 Schema 与生效版本不同的。 */
export function pendingMcpCapabilities(
  effective: readonly McpCapability[],
  discovered: readonly McpCapability[],
): McpCapability[] {
  const effectiveKeys = new Set(effective.map(toolKey))
  return discovered.filter(capability => !effectiveKeys.has(toolKey(capability)))
}
