/**
 * 管理端模块（管理端模块权限方案 5.1、AP11、AP12）的前端展示用清单。
 * 服务端逐请求校验权限；这里只决定菜单、路由入口、按钮是否可用和提示文案。
 */
export const ADMIN_MODULES = ['agent', 'skill', 'connector', 'model', 'dlp', 'knowledge', 'org', 'identity', 'dingtalk', 'ops'] as const
export type AdminModule = typeof ADMIN_MODULES[number]
export type AdminModuleLevel = 'none' | 'read' | 'write'
export type AdminModuleLevels = Record<AdminModule, AdminModuleLevel>

/** 路由与菜单的权限归属：模块、任一管理员（any）或审计（audit）。 */
export type AdminRouteOwner = AdminModule | 'any' | 'audit'

export const ADMIN_MODULE_LABELS: Record<AdminModule, string> = {
  agent: 'Agent',
  skill: 'Skill',
  connector: '工具与连接',
  model: '模型',
  dlp: '数据防护',
  knowledge: '企业知识库',
  org: '组织架构',
  identity: '员工与权限',
  dingtalk: '钉钉集成',
  ops: '运营',
}

export const ADMIN_MODULE_DESCRIPTIONS: Record<AdminModule, string> = {
  agent: '含主动任务、经验、动作审批',
  skill: '含审核与安装',
  connector: 'MCP 连接器、调用对账、Runtimes',
  model: '模型治理、模型用量',
  dlp: '命中记录、规则、检测试用',
  knowledge: '管理端：连接与全部知识库',
  org: '部门树、成员与部门授权',
  identity: '员工、角色、数据范围、独立账号',
  dingtalk: '绑定、提醒、离职检查；应用配置仅平台管理员',
  ops: '运营概览、Session、工作空间',
}

/** 只有查看级别的模块。 */
export const READ_ONLY_MODULES: ReadonlySet<AdminModule> = new Set(['ops'])

export function emptyModuleLevels(): AdminModuleLevels {
  return Object.fromEntries(ADMIN_MODULES.map(module => [module, 'none'])) as AdminModuleLevels
}

export function modulePermission(module: AdminModule, level: 'read' | 'write') {
  return `admin:${module}:${level}`
}

/** 角色的模块级别：`admin:*` / `admin:write` / `admin:read` 视为全部模块。 */
export function moduleLevelsOf(permissions: readonly string[]): AdminModuleLevels {
  const granted = new Set(permissions)
  const all = granted.has('admin:*') || granted.has('admin:write') ? 'write' : granted.has('admin:read') ? 'read' : 'none'
  return Object.fromEntries(ADMIN_MODULES.map((module) => {
    const level: AdminModuleLevel = READ_ONLY_MODULES.has(module)
      ? (all !== 'none' || granted.has(modulePermission(module, 'read')) ? 'read' : 'none')
      : all === 'write' || granted.has(modulePermission(module, 'write'))
        ? 'write'
        : all === 'read' || granted.has(modulePermission(module, 'read')) ? 'read' : 'none'
    return [module, level]
  })) as AdminModuleLevels
}

const IMPLIED: Record<string, string[]> = {
  'admin:write': ['admin:read', ...ADMIN_MODULES.flatMap(module => READ_ONLY_MODULES.has(module) ? [modulePermission(module, 'read')] : [modulePermission(module, 'read'), modulePermission(module, 'write')])],
  'admin:read': ADMIN_MODULES.map(module => modulePermission(module, 'read')),
  ...Object.fromEntries(ADMIN_MODULES.filter(module => !READ_ONLY_MODULES.has(module)).map(module => [modulePermission(module, 'write'), [modulePermission(module, 'read')]])),
  'knowledge:bases': ['knowledge:docs', 'knowledge:view'],
  'knowledge:docs': ['knowledge:view'],
}

function expand(permissions: readonly string[]) {
  const result = new Set<string>()
  const queue = [...permissions]
  while (queue.length) {
    const code = queue.pop()!
    if (result.has(code)) continue
    result.add(code)
    queue.push(...(IMPLIED[code] ?? []))
  }
  return result
}

/** 授出不超过自身（方案 AP13 ①）：`granted` 中操作人没有的权限码；操作人是平台管理员时为空。 */
export function permissionsBeyond(granted: readonly string[], held: readonly string[]) {
  if (held.includes('admin:*')) return []
  const heldExpanded = expand(held)
  return [...new Set(granted)].filter(code => !heldExpanded.has(code))
}

/** 角色列表与弹窗里展示的功能权限标签：模块级别优先，其余权限按名称。 */
export function permissionTags(permissions: readonly string[], catalogNames: Record<string, string>) {
  if (permissions.includes('admin:*')) return ['全部权限（admin:*）']
  const levels = moduleLevelsOf(permissions)
  const tags = ADMIN_MODULES
    .filter(module => levels[module] !== 'none')
    .map(module => `${ADMIN_MODULE_LABELS[module]}·${levels[module] === 'write' ? '修改' : '查看'}`)
  const moduleCodes = new Set(['admin:read', 'admin:write', ...Object.keys(IMPLIED).filter(code => code.startsWith('admin:')), ...ADMIN_MODULES.map(module => modulePermission(module, 'read'))])
  for (const code of permissions) {
    if (moduleCodes.has(code)) continue
    tags.push(catalogNames[code] ?? code)
  }
  return tags
}
