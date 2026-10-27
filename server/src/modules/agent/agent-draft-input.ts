import type { CreateAgentDraftInput, UpdateAgentDraftInput } from '../../domain/types.ts'
import { invalidRequest } from '../../domain/request-errors.ts'

/**
 * HTTP 草稿入口的结构校验。只保证后续 `.trim()`、`unique()` 和额度比较不会抛 TypeError。
 * 空白字符串、MCP 范围、委派目标数量与标识格式、深度/并行/超时，以及 AgentSpec 内容仍由既有领域校验决定。
 */
export function parseCreateAgentDraftInput(value: unknown): Omit<CreateAgentDraftInput, 'actor'> {
  const record = requirePlainObject(value)
  return {
    id: requireString(record, 'id'),
    ...readSharedDraft(record),
    ...readExecutionGrants(record),
  }
}

export function parseUpdateAgentDraftInput(value: unknown): Omit<UpdateAgentDraftInput, 'actor'> {
  const record = requirePlainObject(value)
  // 更新类型不包含执行授权，但请求里如果带了，仍要拦住非字符串元素，避免后续 unique() 抛 TypeError。
  readExecutionGrants(record)
  return {
    agentId: requireString(record, 'agentId'),
    ...readSharedDraft(record),
    expectedRevision: requireNonBlankString(record, 'expectedRevision'),
  }
}

function readSharedDraft(record: Record<string, unknown>) {
  const workInstructions = readWorkInstructions(record)
  const visibility = readOptionalString(record, 'visibility')
  const roleIds = readOptionalStringArray(record, 'roleIds')
  const dataScopes = readOptionalStringArray(record, 'dataScopes')
  return {
    name: requireString(record, 'name'),
    description: requireString(record, 'description'),
    owner: compatibilityText(record, 'owner'),
    department: compatibilityText(record, 'department'),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(roleIds !== undefined ? { roleIds } : {}),
    ...(dataScopes !== undefined ? { dataScopes } : {}),
    welcomeMessage: requireString(record, 'welcomeMessage'),
    examplePrompts: requireStringArray(record, 'examplePrompts'),
    systemPrompt: requireString(record, 'systemPrompt'),
    ...(workInstructions !== undefined ? { workInstructions } : {}),
    maxOutputBytes: requirePositiveSafeInteger(record, 'maxOutputBytes'),
    maxToolCalls: requirePositiveSafeInteger(record, 'maxToolCalls'),
    timeoutSeconds: requirePositiveSafeInteger(record, 'timeoutSeconds'),
    skills: requireStringArray(record, 'skills'),
    tools: requireStringArray(record, 'tools'),
    ...domainPassthrough(record),
    changeSummary: requireString(record, 'changeSummary'),
  }
}

function readExecutionGrants(record: Record<string, unknown>) {
  const executionRoleIds = readOptionalStringArray(record, 'executionRoleIds')
  const executionDataScopes = readOptionalStringArray(record, 'executionDataScopes')
  return {
    ...(executionRoleIds !== undefined ? { executionRoleIds } : {}),
    ...(executionDataScopes !== undefined ? { executionDataScopes } : {}),
  }
}

function domainPassthrough(record: Record<string, unknown>): Pick<CreateAgentDraftInput, 'mcpScope' | 'delegationPolicy' | 'data'> {
  return {
    ...(Object.hasOwn(record, 'mcpScope') ? { mcpScope: record.mcpScope as CreateAgentDraftInput['mcpScope'] } : {}),
    ...readDelegationPolicy(record),
    ...(Object.hasOwn(record, 'data') ? { data: record.data as CreateAgentDraftInput['data'] } : {}),
  }
}

/** `unique()` 会在领域校验之前对目标标识调用 `.trim()`。null/undefined 仍交给 `normalizeDelegationPolicy` 取默认值。 */
function readDelegationPolicy(record: Record<string, unknown>): Pick<CreateAgentDraftInput, 'delegationPolicy'> {
  if (!Object.hasOwn(record, 'delegationPolicy')) return {}
  const value = record.delegationPolicy
  if (value === undefined || value === null) {
    return { delegationPolicy: value as CreateAgentDraftInput['delegationPolicy'] }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('delegationPolicy 必须是对象')
  }
  const ids = (value as Record<string, unknown>).allowedAgentVersionIds
  if (!Array.isArray(ids) || ids.some(item => typeof item !== 'string')) {
    throw invalidRequest('allowedAgentVersionIds 必须是字符串数组')
  }
  return { delegationPolicy: value as CreateAgentDraftInput['delegationPolicy'] }
}

function requirePlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest('请求体必须是对象')
  }
  return value as Record<string, unknown>
}

function requireString(record: Record<string, unknown>, field: string): string {
  if (typeof record[field] !== 'string') throw invalidRequest(`${field} 必须是字符串`)
  return record[field]
}

function requireNonBlankString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') throw invalidRequest(`${field} 必须是非空字符串`)
  return value
}

function requireStringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw invalidRequest(`${field} 必须是字符串数组`)
  }
  return value
}

function readOptionalStringArray(record: Record<string, unknown>, field: string): string[] | undefined {
  if (!Object.hasOwn(record, field) || record[field] === undefined || record[field] === null) return undefined
  return requireStringArray(record, field)
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field) || record[field] === undefined || record[field] === null) return undefined
  return requireString(record, field)
}

function readWorkInstructions(record: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(record, 'workInstructions') || record.workInstructions === undefined) return undefined
  if (record.workInstructions === null || typeof record.workInstructions === 'string') return record.workInstructions
  throw invalidRequest('workInstructions 必须是字符串')
}

function requirePositiveSafeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidRequest(`${field} 必须是正整数`)
  }
  return value
}

function compatibilityText(record: Record<string, unknown>, field: 'owner' | 'department'): string {
  return typeof record[field] === 'string' ? record[field] : ''
}
