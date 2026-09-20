/**
 * 规范化 Agent 定义（AgentSpec）：管理端配置与 ZIP 发布包共用的唯一语义契约。
 *
 * 边界：
 *   - 定义归属 Agent：metadata、instructions、capabilities、input/output/context、
 *     catalog、catalog 默认值、limits、evaluation、model 能力要求。
 *   - 平台归属：roleIds/dataScopes/allowWorkspaceJoin/owner 等授权与绑定配置
 *     不进入 AgentSpec，由平台配置持久化并随草稿版本指纹固定。
 *   - 默认值在写入草稿时展开并固化到 agent_versions.agent_spec，平台默认值
 *     后续调整不影响已生成版本的定义。
 */

export const AGENT_SPEC_API_VERSION = 'dsh-work.ai/v1'

/** AgentSpec 的版本化格式标识；包清单 kind 为 AgentPackage（交付物），此处为归一化定义。 */
export interface AgentSpecLimits {
  timeoutSeconds: number
  maxToolCalls: number
  maxOutputBytes: number
}

export interface AgentSpec {
  apiVersion: typeof AGENT_SPEC_API_VERSION
  metadata: { id: string; name: string; version: string; description: string }
  /** 指令唯一来源：包内文件路径 + 正文；配置入口的文本归一化为 prompts/system.md 表示。 */
  instructions: { path: string; body: string }
  /** 能力依赖：规范化 `id@x.y.z` 精确引用（含包内候选），不做版本解析或 latest 语义。 */
  capabilities: { skills: string[]; tools: string[] }
  input: { type: 'text' }
  output: { type: 'text' }
  context: { conversationHistory: 'recent' }
  catalog: { welcomeMessage: string; examplePrompts: string[] }
  limits: AgentSpecLimits
  /** 试运行案例文件相对路径；null 表示由平台按定义生成默认案例。 */
  evaluation: { cases: string | null }
  /** 模型能力要求；准备及队列恢复时校验，路由与凭据由平台管理。 */
  model: { requirements: AgentModelRequirement[] }
}

export type AgentModelRequirement = 'long-context' | 'structured-output'

export const AGENT_MODEL_REQUIREMENTS: readonly AgentModelRequirement[] = ['long-context', 'structured-output']

export const AGENT_SPEC_LIMITS_DEFAULT: AgentSpecLimits = {
  timeoutSeconds: 300,
  maxToolCalls: 20,
  maxOutputBytes: 65536,
}

/** 与包 Schema 及配置入口共用同一组边界，避免两处口径漂移。 */
export const AGENT_SPEC_BOUNDS = {
  name: { min: 2, max: 40 },
  description: { min: 10, max: 200 },
  instructions: { min: 20, max: 20000 },
  welcomeMessage: { max: 120 },
  examplePrompts: { max: 8, itemMax: 200 },
  capabilities: { max: 64 },
  timeoutSeconds: { min: 30, max: 600 },
  maxToolCalls: { min: 1, max: 100 },
  maxOutputBytes: { min: 1024, max: 1048576 },
} as const

export const AGENT_SPEC_INSTRUCTIONS_PATH = 'prompts/system.md'

/** 规范化定义的公共内容校验：Schema 未覆盖的正文长度与配置入口共用此关口。 */
export function assertAgentSpecContent(spec: AgentSpec) {
  const { name, description } = spec.metadata
  const bounds = AGENT_SPEC_BOUNDS
  if (name.length < bounds.name.min || name.length > bounds.name.max) {
    throw new Error('Agent 名称长度为 2～40 个字符')
  }
  if (description.length < bounds.description.min || description.length > bounds.description.max) {
    throw new Error('Agent 说明长度为 10～200 个字符')
  }
  const body = spec.instructions.body
  if (body.length < bounds.instructions.min || body.length > bounds.instructions.max) {
    throw new Error('System Prompt 长度必须为 20～20000 个字符')
  }
  if (spec.catalog.welcomeMessage.length > bounds.welcomeMessage.max) {
    throw new Error('欢迎语不能超过 120 个字符')
  }
  assertAgentSpecLimits(spec.limits)
}

export function assertAgentSpecLimits(limits: AgentSpecLimits) {
  const bounds = AGENT_SPEC_BOUNDS
  const { timeoutSeconds, maxToolCalls, maxOutputBytes } = limits
  if (timeoutSeconds < bounds.timeoutSeconds.min || timeoutSeconds > bounds.timeoutSeconds.max) {
    throw new Error(`运行超时必须在 ${bounds.timeoutSeconds.min}～${bounds.timeoutSeconds.max} 秒之间`)
  }
  if (maxToolCalls < bounds.maxToolCalls.min || maxToolCalls > bounds.maxToolCalls.max) {
    throw new Error(`工具调用上限必须在 ${bounds.maxToolCalls.min}～${bounds.maxToolCalls.max} 之间`)
  }
  if (maxOutputBytes < bounds.maxOutputBytes.min || maxOutputBytes > bounds.maxOutputBytes.max) {
    throw new Error(`输出字节上限必须在 ${bounds.maxOutputBytes.min}～${bounds.maxOutputBytes.max} 之间`)
  }
}

/** 配置入口输入：仅定义字段；roleIds/dataScopes 等平台字段不在此结构内。 */
export interface AgentSpecConfiguration {
  id: string
  name: string
  description: string
  systemPrompt: string
  welcomeMessage: string
  examplePrompts: string[]
  skills: string[]
  tools: string[]
  timeoutSeconds: number
  maxToolCalls: number
  maxOutputBytes: number
}

/** 配置新建时展开默认值；编辑/分叉时保留表单未提供的定义及指令文件路径。 */
export function agentSpecFromConfiguration(input: AgentSpecConfiguration, version: string, existing?: AgentSpec | null): AgentSpec {
  return {
    apiVersion: AGENT_SPEC_API_VERSION,
    metadata: { id: input.id, name: input.name, version, description: input.description },
    instructions: { path: existing?.instructions.path ?? AGENT_SPEC_INSTRUCTIONS_PATH, body: input.systemPrompt },
    capabilities: { skills: [...input.skills], tools: [...input.tools] },
    input: existing ? { ...existing.input } : { type: 'text' },
    output: existing ? { ...existing.output } : { type: 'text' },
    context: existing ? { ...existing.context } : { conversationHistory: 'recent' },
    catalog: { welcomeMessage: input.welcomeMessage, examplePrompts: [...input.examplePrompts] },
    limits: {
      timeoutSeconds: input.timeoutSeconds,
      maxToolCalls: input.maxToolCalls,
      maxOutputBytes: input.maxOutputBytes,
    },
    evaluation: { cases: existing?.evaluation.cases ?? null },
    model: { requirements: [...(existing?.model.requirements ?? [])] },
  }
}
