/**
 * 内置工具注册表：DSH 原生工具与 dsh-work 平台工具的唯一来源。
 *
 * 内置工具不是可管理的数据。准入、约束与装配方式随代码发布；运行时按本表生成
 * DSH_ALLOWED_TOOLS_JSON，表中没有的 DSH 工具一律不放行。开放新工具必须同时补齐
 * dsh-work-tool-policy.js 中的约束与本表条目。平台工具的输入输出契约见
 * platform-tool-contracts.ts。
 */

/** 内置工具引用沿用 name@version 写法；版本固定，随代码发布。 */
export const BUILTIN_TOOL_VERSION = '1.0.0'

export type BuiltinToolAssembly =
  /** 每个 Agent 运行都装配。 */
  | 'always'
  /** Agent 版本显式开启才装配（联网搜索）。 */
  | 'agent-opt-in'
  /** 由 Skill 或运行内容触发：激活 Skill、Python 执行、经验申请。 */
  | 'runtime'
  /** 按管理运行用途注入。 */
  | 'purpose'
  /** 项目空间运行：Agent 版本开启“项目任务管理”且由团队空间的人发起时装配（S6）。 */
  | 'workspace'

export interface BuiltinTool {
  name: string
  label: string
  source: 'dsh' | 'platform'
  effect: 'read' | 'write'
  risk: 'low' | 'medium'
  assembly: BuiltinToolAssembly
  constraints: readonly string[]
}

const workspace = '只访问当前 Run 工作区'
const outputOnly = '创建和修改限于 output 目录中的 Markdown、TXT 与 CSV 成果'
const projectOnly = '只访问本次运行所在项目空间的任务'
const actorLimited = '按发起成员的任务权限执行，定时执行不装配'

export const builtinTools: readonly BuiltinTool[] = [
  { name: 'read', label: '读取文本文件', source: 'dsh', effect: 'read', risk: 'low', assembly: 'always', constraints: [workspace] },
  { name: 'glob', label: '查找文件', source: 'dsh', effect: 'read', risk: 'low', assembly: 'always', constraints: [workspace] },
  { name: 'grep', label: '搜索文件内容', source: 'dsh', effect: 'read', risk: 'low', assembly: 'always', constraints: [workspace] },
  { name: 'read_image', label: '读取图片', source: 'dsh', effect: 'read', risk: 'low', assembly: 'always', constraints: [workspace, '只读取图片文件'] },
  { name: 'write', label: '生成文本文件', source: 'dsh', effect: 'write', risk: 'low', assembly: 'always', constraints: [workspace, outputOnly] },
  { name: 'edit', label: '编辑文本文件', source: 'dsh', effect: 'write', risk: 'low', assembly: 'always', constraints: [workspace, outputOnly] },
  { name: 'str_replace_editor', label: '查看与编辑文本文件', source: 'dsh', effect: 'write', risk: 'low', assembly: 'always', constraints: [workspace, outputOnly] },
  { name: 'todo_write', label: '任务进度清单', source: 'dsh', effect: 'write', risk: 'low', assembly: 'always', constraints: ['只记录本次会话的进度清单'] },
  { name: 'web_search', label: '联网搜索', source: 'dsh', effect: 'read', risk: 'medium', assembly: 'agent-opt-in', constraints: ['每次 1～4 个非空查询', '查询内容会发送到外部搜索服务'] },
  { name: 'activate_skill', label: '激活 Skill', source: 'platform', effect: 'read', risk: 'low', assembly: 'runtime', constraints: ['只读取本次固定版本的 Skill 资源'] },
  { name: 'python_execute', label: 'Python 执行', source: 'platform', effect: 'write', risk: 'medium', assembly: 'runtime', constraints: ['仅在平台沙箱中执行 Skill 自带脚本', '无网络、限时、限额'] },
  { name: 'propose_memory', label: '提出经验申请', source: 'platform', effect: 'write', risk: 'low', assembly: 'runtime', constraints: ['只生成待管理员审核的申请'] },
  { name: 'project_tasks_list', label: '查看项目任务', source: 'platform', effect: 'read', risk: 'low', assembly: 'workspace', constraints: [projectOnly, '不返回任务对话内容'] },
  { name: 'project_task_get', label: '查看任务详情', source: 'platform', effect: 'read', risk: 'low', assembly: 'workspace', constraints: [projectOnly, '不返回任务对话内容'] },
  { name: 'project_task_create', label: '新建项目任务', source: 'platform', effect: 'write', risk: 'medium', assembly: 'workspace', constraints: [projectOnly, actorLimited, 'Agent 任务执行规则为手动，不自动执行'] },
  { name: 'project_task_update', label: '修改项目任务', source: 'platform', effect: 'write', risk: 'medium', assembly: 'workspace', constraints: [projectOnly, actorLimited, '不能移除任务'] },
  { name: 'prepare_skill_installation', label: '准备 Skill 安装', source: 'platform', effect: 'read', risk: 'low', assembly: 'purpose', constraints: ['仅管理端安装助手'] },
  { name: 'inspect_admin_state', label: '查看平台状态', source: 'platform', effect: 'read', risk: 'low', assembly: 'purpose', constraints: ['仅管理助手'] },
  { name: 'propose_admin_task', label: '提出管理任务', source: 'platform', effect: 'write', risk: 'low', assembly: 'purpose', constraints: ['仅管理助手', '只生成待确认任务'] },
  { name: 'prepare_admin_action', label: '准备管理动作', source: 'platform', effect: 'write', risk: 'low', assembly: 'purpose', constraints: ['仅管理助手', '只生成待确认动作'] },
]

const byName = new Map(builtinTools.map(tool => [tool.name, tool]))

export function builtinTool(name: string): BuiltinTool | undefined {
  return byName.get(name)
}

/** Runtime 配置可以紧急停用的工具：DSH 原生工具。 */
export function isDshBuiltinTool(name: string): boolean {
  return byName.get(name)?.source === 'dsh'
}

export function builtinToolReference(name: string): string {
  return `${name}@${BUILTIN_TOOL_VERSION}`
}

/** 解析 name@version 形式的内置工具引用；不是注册表中的工具时返回 undefined。 */
export function parseBuiltinToolReference(reference: string): BuiltinTool | undefined {
  const separator = reference.lastIndexOf('@')
  const name = separator > 0 ? reference.slice(0, separator) : reference
  const version = separator > 0 ? reference.slice(separator + 1) : BUILTIN_TOOL_VERSION
  return version === BUILTIN_TOOL_VERSION ? byName.get(name) : undefined
}

/** 项目任务工具（S6）：读取与写入分开，定时执行只装配读取。 */
export const projectTaskReadTools = ['project_tasks_list', 'project_task_get'] as const
export const projectTaskWriteTools = ['project_task_create', 'project_task_update'] as const

/**
 * 本次运行装配的项目任务工具：Agent 版本未开启、不在团队空间或不是人发起的运行时为空；
 * 定时执行（无人在场）只装配读取工具。
 */
export function projectTaskToolNames(input: { enabled: boolean; mode: 'none' | 'read' | 'read-write' }): string[] {
  if (!input.enabled || input.mode === 'none') return []
  return input.mode === 'read' ? [...projectTaskReadTools] : [...projectTaskReadTools, ...projectTaskWriteTools]
}

/** Agent 运行装配的 DSH 工具名称：默认工具，加上 Agent 开启的联网搜索；去掉 Runtime 停用的工具。 */
export function agentBuiltinToolNames(input: {
  webSearchEnabled: boolean
  disabledTools?: readonly string[]
}): string[] {
  const disabled = new Set(input.disabledTools ?? [])
  return builtinTools
    .filter(tool => tool.assembly === 'always' || (tool.assembly === 'agent-opt-in' && input.webSearchEnabled))
    .map(tool => tool.name)
    .filter(name => !disabled.has(name))
}

/**
 * SKILL.md `allowed-tools` 的名称匹配：忽略大小写与下划线（`Read` → `read`、
 * `WebSearch` → `web_search`）。只识别 Agent 可装配的 DSH 工具。
 */
export function skillToolName(value: string): string | undefined {
  const key = value.trim().toLowerCase().replace(/[_\s-]/g, '')
  return builtinTools.find(tool => tool.source === 'dsh' && tool.assembly !== 'purpose'
    && tool.name.replace(/_/g, '') === key)?.name
}

/**
 * Skill 依赖的工具在该 Agent 上是否可用。返回不可用的引用及原因；空数组表示通过。
 * 平台运行工具（activate_skill、python_execute）由运行内容装配，始终视为可用。
 */
export function unavailableSkillTools(references: readonly string[], agent: { webSearchEnabled: boolean }): string[] {
  const problems: string[] = []
  for (const reference of new Set(references)) {
    const tool = parseBuiltinToolReference(reference)
    if (!tool || tool.assembly === 'purpose' || tool.assembly === 'workspace') problems.push(`${reference}（平台不提供该工具）`)
    else if (tool.assembly === 'agent-opt-in' && !agent.webSearchEnabled) problems.push(`${reference}（Agent 未开启联网搜索）`)
  }
  return problems
}

/** Skill 可声明的工具引用：Agent 可装配的 DSH 工具，以及激活 Skill、Python 执行。返回不合法的引用。 */
export function invalidSkillToolReferences(references: readonly string[]): string[] {
  return [...new Set(references)].filter(reference => {
    const tool = parseBuiltinToolReference(reference)
    return !tool || tool.assembly === 'purpose' || tool.assembly === 'workspace' || tool.name === 'propose_memory'
  })
}

/** Runtime 配置的停用清单：去重、排序，只接受 DSH 原生工具。 */
export function normalizeDisabledTools(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError('停用工具清单格式无效')
  const names = [...new Set(value.map(item => item.trim()))].sort()
  const unknown = names.filter(name => !isDshBuiltinTool(name))
  if (unknown.length) throw new TypeError(`只能停用 DSH 内置工具：${unknown.join('、')}`)
  return names
}

/** 管理端 Runtime 详情的只读展示：注册表、当前停用清单与启动时的目录比对。 */
export interface BuiltinToolStatus {
  tools: readonly BuiltinTool[]
  disabledTools: string[]
  catalog: { checkedAt: string; missingTools: string[] } | { checkedAt: string; error: string } | null
}

/** 启动时比对 DSH 当前工具目录：注册表中的 DSH 工具在目录里缺失时报告。 */
export function missingDshBuiltinTools(catalogToolNames: readonly string[]): string[] {
  const present = new Set(catalogToolNames)
  return builtinTools.filter(tool => tool.source === 'dsh' && !present.has(tool.name)).map(tool => tool.name)
}
