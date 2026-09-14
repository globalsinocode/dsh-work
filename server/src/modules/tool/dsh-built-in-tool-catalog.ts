import type { ToolCatalogCandidate, ToolDefinition } from '../../domain/types.ts'
import type { RuntimeToolDescriptor } from '../runtime/runtime-types.ts'

export type CatalogEntry = Omit<ToolCatalogCandidate, 'status' | 'availabilityMessage'> & {
  inputSchemaObject: Record<string, unknown>
  outputSchemaObject: Record<string, unknown>
  platformSupported: boolean
  unsupportedReason?: string
}

interface ToolPolicyMetadata {
  name: string
  mode: ToolDefinition['mode']
  risk: ToolDefinition['risk']
  timeoutSeconds: number
  approvalPolicy: ToolDefinition['approvalPolicy']
  roles?: string[]
  requirements?: string[]
  platformSupported?: boolean
  unsupportedReason?: string
}

const toolPolicies: Record<string, ToolPolicyMetadata> = {
  read: { name: '读取文本文件', mode: 'read', risk: 'low', timeoutSeconds: 30, approvalPolicy: 'none' },
  glob: { name: '查找文件', mode: 'read', risk: 'low', timeoutSeconds: 30, approvalPolicy: 'none' },
  grep: { name: '搜索文件内容', mode: 'read', risk: 'low', timeoutSeconds: 30, approvalPolicy: 'none' },
  write: { name: '生成文本文件', mode: 'write', risk: 'low', timeoutSeconds: 30, approvalPolicy: 'none', requirements: ['当前 Run 工作区', '仅允许 output 目录中的 Markdown、TXT 和 CSV 成果'] },
  edit: { name: '编辑文本文件', mode: 'write', risk: 'low', timeoutSeconds: 30, approvalPolicy: 'none', requirements: ['当前 Run 工作区', '仅允许 output 目录中的 Markdown、TXT 和 CSV 成果'] },
  todo_write: { name: '任务进度清单', mode: 'write', risk: 'low', timeoutSeconds: 10, approvalPolicy: 'none' },
  create_goal: { name: '创建持续目标', mode: 'write', risk: 'low', timeoutSeconds: 10, approvalPolicy: 'none' },
  get_goal: { name: '查看持续目标', mode: 'read', risk: 'low', timeoutSeconds: 10, approvalPolicy: 'none' },
  update_goal: { name: '更新持续目标', mode: 'write', risk: 'low', timeoutSeconds: 10, approvalPolicy: 'none' },
  job_list: { name: '查看后台任务', mode: 'read', risk: 'low', timeoutSeconds: 10, approvalPolicy: 'none' },
  job_output: { name: '读取后台任务输出', mode: 'read', risk: 'low', timeoutSeconds: 30, approvalPolicy: 'none' },
  job_kill: {
    name: '停止后台任务', mode: 'write', risk: 'medium', timeoutSeconds: 10, approvalPolicy: 'sensitive',
    platformSupported: false,
    unsupportedReason: '平台尚未接入可持久化的管理员逐次审批，暂不允许授权停止后台任务',
  },
  bash: {
    name: '执行 Shell 命令',
    mode: 'write',
    risk: 'high',
    timeoutSeconds: 60,
    approvalPolicy: 'always',
    roles: ['平台管理员'],
    requirements: ['DSH Shell 工具包', '当前 Run 工作区', '每次调用需要管理员确认'],
    platformSupported: false,
    unsupportedReason: 'MVP 不开放任意 Shell；可持久化的管理员逐次审批和命令约束尚未接入',
  },
}

const fallbackSchemas: RuntimeToolDescriptor[] = [
  {
    id: 'edit',
    description: '在当前 Run 的成果目录中精确替换已有文本，适合继续修改已经生成的文档。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要编辑的工作区文件路径。' },
        old_string: { type: 'string', description: '必须精确匹配的原文本。' },
        new_string: { type: 'string', description: '用于替换的新文本。' },
        replace_all: { type: 'boolean', description: '是否替换全部匹配项，默认 false。' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    id: 'todo_write',
    description: '记录并更新当前会话的结构化任务清单，让长任务的执行进度可追踪。',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
]

export const dshBuiltInToolCatalog: readonly CatalogEntry[] = fallbackSchemas.map(runtimeToolToCatalogEntry)

export function runtimeToolToCatalogEntry(tool: RuntimeToolDescriptor): CatalogEntry {
  const policy = toolPolicies[tool.id]
  const platformSupported = policy !== undefined && policy.platformSupported !== false
  return {
    id: tool.id,
    version: '1.0.0',
    name: policy?.name ?? tool.id,
    system: 'DSH Runtime',
    description: tool.description,
    connectorId: 'connector-dsh-workspace',
    risk: policy?.risk ?? 'high',
    mode: policy?.mode ?? 'write',
    timeoutSeconds: policy?.timeoutSeconds ?? 30,
    defaultAllowedRoles: policy?.roles ?? ['普通员工', '平台管理员'],
    defaultDataScopes: ['workspace:authorized'],
    defaultApprovalPolicy: policy?.approvalPolicy ?? 'always',
    requirements: policy?.requirements ?? ['DSH Runtime 当前 Profile', '当前 Run 工作区'],
    inputSchemaObject: tool.inputSchema,
    outputSchemaObject: {},
    platformSupported,
    ...(!platformSupported ? { unsupportedReason: policy?.unsupportedReason ?? 'DSH 已加载，但平台尚未接入该工具的权限和运行结果投影' } : {}),
  }
}

export function requiredDshToolApprovalPolicy(toolName: string): ToolDefinition['approvalPolicy'] | undefined {
  const policy = toolPolicies[toolName]
  return policy?.platformSupported === false ? undefined : policy?.approvalPolicy
}

export function assertDshToolApprovalPolicy(entry: CatalogEntry, approvalPolicy: ToolDefinition['approvalPolicy']) {
  if (approvalPolicy !== entry.defaultApprovalPolicy) {
    throw new Error(`工具“${entry.name}”的审批策略由平台固定为“${approvalPolicyLabel(entry.defaultApprovalPolicy)}”`)
  }
}

export function publicCatalogCandidate(
  entry: CatalogEntry,
  status: ToolCatalogCandidate['status'],
  availabilityMessage: string,
): ToolCatalogCandidate {
  return {
    id: entry.id,
    version: entry.version,
    name: entry.name,
    system: entry.system,
    description: entry.description,
    connectorId: entry.connectorId,
    risk: entry.risk,
    mode: entry.mode,
    timeoutSeconds: entry.timeoutSeconds,
    defaultAllowedRoles: [...entry.defaultAllowedRoles],
    defaultDataScopes: [...entry.defaultDataScopes],
    defaultApprovalPolicy: entry.defaultApprovalPolicy,
    requirements: [...entry.requirements],
    status,
    availabilityMessage,
  }
}

function approvalPolicyLabel(policy: ToolDefinition['approvalPolicy']) {
  if (policy === 'always') return '每次审批'
  if (policy === 'sensitive') return '敏感操作审批'
  return '无需审批'
}

export function catalogEntryToToolDefinition(
  entry: CatalogEntry,
  policy?: {
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  },
): ToolDefinition {
  return {
    id: entry.id,
    version: entry.version,
    name: entry.name,
    system: entry.system,
    description: entry.description,
    connectorId: entry.connectorId,
    risk: entry.risk,
    mode: entry.mode,
    status: 'available',
    inputSchema: JSON.stringify(entry.inputSchemaObject, null, 2),
    outputSchema: JSON.stringify(entry.outputSchemaObject, null, 2),
    timeoutSeconds: entry.timeoutSeconds,
    allowedRoles: policy?.allowedRoles ?? [...entry.defaultAllowedRoles],
    dataScopes: policy?.dataScopes ?? [...entry.defaultDataScopes],
    approvalPolicy: policy?.approvalPolicy ?? entry.defaultApprovalPolicy,
    lastCheckedAt: '刚刚',
  }
}

export function normalizeToolPolicyInput(input: {
  allowedRoles: unknown
  dataScopes: unknown
  approvalPolicy: unknown
}) {
  if (!Array.isArray(input.allowedRoles)
    || input.allowedRoles.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('授权角色格式无效')
  }
  if (!Array.isArray(input.dataScopes)
    || input.dataScopes.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('数据范围格式无效')
  }
  const allowedRoles = [...new Set(input.allowedRoles.map(value => value.trim()))]
  const dataScopes = [...new Set(input.dataScopes.map(value => value.trim()))]
  if (!allowedRoles.length || !dataScopes.length) throw new Error('工具必须配置授权角色和数据范围')
  if (!['none', 'sensitive', 'always'].includes(String(input.approvalPolicy))) throw new Error('审批策略无效')
  return {
    allowedRoles,
    dataScopes,
    approvalPolicy: input.approvalPolicy as ToolDefinition['approvalPolicy'],
  }
}
