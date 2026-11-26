/**
 * 管理端模块权限（功能规则第 13 节）的唯一定义。
 *
 * 路由入口、会话层、服务层 SQL 判定与授权子集校验都从这里取模块清单与“哪些权限码满足某模块的某级别”，
 * 不再各自写 `admin:*` / `admin:write` 的组合。纯函数，不访问数据库。
 */

export const ADMIN_MODULES = ['agent', 'skill', 'connector', 'model', 'dlp', 'knowledge', 'org', 'identity', 'dingtalk', 'ops'] as const
export type AdminModule = typeof ADMIN_MODULES[number]
export type AdminLevel = 'read' | 'write'

export const PLATFORM_ADMIN_PERMISSION = 'admin:*'
export const ALL_MODULES_READ_PERMISSION = 'admin:read'
export const ALL_MODULES_WRITE_PERMISSION = 'admin:write'
export const AUDIT_READ_PERMISSION = 'audit:read'
export const DATA_PROTECTION_TERMS_PERMISSION = 'data-protection:terms'

/** 只有查看级别的模块：其写权限码不存在，也不会被任何检查要求。 */
const READ_ONLY_MODULES: ReadonlySet<AdminModule> = new Set(['ops'])

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

export function adminModulePermission(module: AdminModule, level: AdminLevel) {
  return `admin:${module}:${level}`
}

/** 全部模块权限码（含只读模块的查看码），用于权限目录与“持有任一管理权限”的判定。 */
export function allAdminModulePermissions(): string[] {
  return ADMIN_MODULES.flatMap(module => READ_ONLY_MODULES.has(module)
    ? [adminModulePermission(module, 'read')]
    : [adminModulePermission(module, 'read'), adminModulePermission(module, 'write')])
}

/** 满足“模块 m 的 level 级别”的全部权限码：write 包含 read，`admin:write` / `admin:read` 为全部模块。 */
export function acceptedAdminPermissions(module: AdminModule, level: AdminLevel): string[] {
  if (level === 'write') {
    return [PLATFORM_ADMIN_PERMISSION, ALL_MODULES_WRITE_PERMISSION, adminModulePermission(module, 'write')]
  }
  return [
    PLATFORM_ADMIN_PERMISSION, ALL_MODULES_READ_PERMISSION, ALL_MODULES_WRITE_PERMISSION,
    adminModulePermission(module, 'read'), adminModulePermission(module, 'write'),
  ]
}

/** 能进入管理端模块页面或管理助手的权限码（不含只用于审计或词表的权限）。 */
export function moduleAdministrationPermissions(): string[] {
  return [PLATFORM_ADMIN_PERMISSION, ALL_MODULES_READ_PERMISSION, ALL_MODULES_WRITE_PERMISSION, ...allAdminModulePermissions()]
}

/** 能登录管理端的权限码：模块管理权限或审计读取。只持 `data-protection:terms` 不构成准入。 */
export function adminAudiencePermissions(): string[] {
  return [...moduleAdministrationPermissions(), AUDIT_READ_PERMISSION]
}

function toSet(permissions: Iterable<string>) {
  return permissions instanceof Set ? permissions as Set<string> : new Set(permissions)
}

export function hasAdminModuleAccess(permissions: Iterable<string>, module: AdminModule, level: AdminLevel) {
  const granted = toSet(permissions)
  return acceptedAdminPermissions(module, level).some(code => granted.has(code))
}

export function isPlatformAdmin(permissions: Iterable<string>) {
  return toSet(permissions).has(PLATFORM_ADMIN_PERMISSION)
}

export function hasModuleAdministrationAccess(permissions: Iterable<string>) {
  const granted = toSet(permissions)
  return moduleAdministrationPermissions().some(code => granted.has(code))
}

export function hasAdminAudienceAccess(permissions: Iterable<string>) {
  const granted = toSet(permissions)
  return adminAudiencePermissions().some(code => granted.has(code))
}

export function hasAuditAccess(permissions: Iterable<string>) {
  const granted = toSet(permissions)
  return granted.has(PLATFORM_ADMIN_PERMISSION) || granted.has(AUDIT_READ_PERMISSION)
}

/** 管理类权限码（功能规则第 13 节）：不能经部门授予，非平台管理员不能授给 Agent。 */
export function isManagementPermission(code: string) {
  return code.startsWith('admin:') || code.startsWith('audit:') || code.startsWith('data-protection:')
}

export const MANAGEMENT_PERMISSION_PREFIXES = ['admin:', 'audit:', 'data-protection:'] as const

/** 每个模块的可用级别，供会话接口返回摘要（前端只用于展示）。 */
export function adminModuleSummary(permissions: Iterable<string>): Record<AdminModule, AdminLevel | 'none'> {
  const granted = toSet(permissions)
  return Object.fromEntries(ADMIN_MODULES.map(module => [
    module,
    !READ_ONLY_MODULES.has(module) && hasAdminModuleAccess(granted, module, 'write')
      ? 'write'
      : hasAdminModuleAccess(granted, module, 'read') ? 'read' : 'none',
  ])) as Record<AdminModule, AdminLevel | 'none'>
}

/**
 * 权限码之间的包含关系（功能规则第 13 节“子集判定的粒度”）：持有左侧即视为持有右侧全部。
 * `admin:*` 覆盖全部管理权限，由 `expandPermissions` 单独处理。
 */
const IMPLIED_PERMISSIONS: Record<string, string[]> = {
  [ALL_MODULES_WRITE_PERMISSION]: [ALL_MODULES_READ_PERMISSION, ...allAdminModulePermissions()],
  [ALL_MODULES_READ_PERMISSION]: ADMIN_MODULES.map(module => adminModulePermission(module, 'read')),
  ...Object.fromEntries(ADMIN_MODULES.filter(module => !READ_ONLY_MODULES.has(module))
    .map(module => [adminModulePermission(module, 'write'), [adminModulePermission(module, 'read')]])),
  'knowledge:bases': ['knowledge:docs', 'knowledge:view'],
  'knowledge:docs': ['knowledge:view'],
}

/** 展开包含关系后的权限集合。 */
export function expandPermissions(permissions: Iterable<string>): Set<string> {
  const expanded = new Set<string>()
  const queue = [...permissions]
  while (queue.length) {
    const code = queue.pop()!
    if (expanded.has(code)) continue
    expanded.add(code)
    for (const implied of IMPLIED_PERMISSIONS[code] ?? []) queue.push(implied)
  }
  return expanded
}

/**
 * 授出不超过自身（功能规则第 13 节）：`granted` 中展开后仍不被 `held` 覆盖的权限码。
 * `held` 含 `admin:*` 时视为全部覆盖（平台管理员不受子集约束，调用方通常已提前放行）。
 */
export function missingPermissions(granted: Iterable<string>, held: Iterable<string>): string[] {
  const heldSet = toSet(held)
  if (heldSet.has(PLATFORM_ADMIN_PERMISSION)) return []
  const heldExpanded = expandPermissions(heldSet)
  return [...new Set(granted)].filter(code => !heldExpanded.has(code)).sort()
}

/** 数据范围按值逐项比较；返回操作人没有的范围值。 */
export function missingDataScopes(granted: Iterable<string>, held: Iterable<string>): string[] {
  const heldSet = toSet(held)
  return [...new Set(granted)].filter(scope => !heldSet.has(scope)).sort()
}

/** 管理端专用 Run 的用途与所需模块写权限（功能规则第 13 节）。`admin-assistant` 只需能使用管理助手。 */
export const ADMIN_RUN_PURPOSE_MODULES = {
  'admin-skill-install': 'skill',
  'admin-skill-test': 'skill',
  'agent-release-trial': 'agent',
  'admin-agent-manage': 'agent',
  'admin-platform-operations': 'connector',
} as const satisfies Record<string, AdminModule>

export type AdminDelegatedPurpose = keyof typeof ADMIN_RUN_PURPOSE_MODULES

export function adminModuleForPurpose(purpose: string): AdminModule | null {
  return (ADMIN_RUN_PURPOSE_MODULES as Record<string, AdminModule>)[purpose] ?? null
}

/** 管理助手操作计划类型所属模块。 */
export const ADMIN_ACTION_MODULES = {
  'agent-update-draft': 'agent',
  'agent-set-status': 'agent',
  'runtime-update-configuration': 'connector',
} as const satisfies Record<string, AdminModule>

export function adminModuleForAction(actionType: string): AdminModule | null {
  return (ADMIN_ACTION_MODULES as Record<string, AdminModule>)[actionType] ?? null
}

/**
 * 管理端路由对照表（功能规则第 13 节）。按 `/api/admin/v1/` 之后的第一段路径匹配；
 * 未登记的路径一律拒绝（默认拒绝）。
 */
export type AdminRouteRule =
  /** `writePlatformOnly`：查看按模块，修改只限平台管理员（钉钉应用配置，功能规则第 13 节）。 */
  | { kind: 'module'; module: AdminModule; writePlatformOnly?: boolean }
  | { kind: 'session' }
  | { kind: 'any-admin-read' }
  | { kind: 'platform-only' }
  | { kind: 'audit' }
  | { kind: 'assistant' }
  | { kind: 'data-protection-terms' }

const ROUTE_SEGMENT_RULES: Record<string, AdminRouteRule> = {
  session: { kind: 'session' },
  agents: { kind: 'module', module: 'agent' },
  'agent-versions': { kind: 'module', module: 'agent' },
  'experience-iterations': { kind: 'module', module: 'agent' },
  approvals: { kind: 'module', module: 'agent' },
  skills: { kind: 'module', module: 'skill' },
  'skill-versions': { kind: 'module', module: 'skill' },
  'skill-release-records': { kind: 'module', module: 'skill' },
  'skill-submissions': { kind: 'module', module: 'skill' },
  'skill-installations': { kind: 'module', module: 'skill' },
  connectors: { kind: 'module', module: 'connector' },
  runtimes: { kind: 'module', module: 'connector' },
  'grant-sources': { kind: 'module', module: 'connector' },
  'task-executions': { kind: 'module', module: 'connector' },
  'model-providers': { kind: 'module', module: 'model' },
  'provider-models': { kind: 'module', module: 'model' },
  'model-routes': { kind: 'module', module: 'model' },
  'model-usage': { kind: 'module', module: 'model' },
  'data-protection': { kind: 'module', module: 'dlp' },
  knowledge: { kind: 'module', module: 'knowledge' },
  organization: { kind: 'module', module: 'org' },
  sessions: { kind: 'module', module: 'ops' },
  workspaces: { kind: 'module', module: 'ops' },
  tasks: { kind: 'module', module: 'ops' },
  usage: { kind: 'module', module: 'ops' },
  // 错误记录（错误记录方案 OB11）：安全与运维下的只读页面。
  'error-records': { kind: 'module', module: 'ops' },
  // 系统健康（含知识库检索、执行容器等组件状态）供各模块页面提示可用性，任一模块管理员可读。
  health: { kind: 'any-admin-read' },
  'platform-status': { kind: 'module', module: 'ops' },
  'audit-events': { kind: 'audit' },
  operations: { kind: 'audit' },
  identity: { kind: 'module', module: 'identity' },
  dingtalk: { kind: 'module', module: 'dingtalk' },
  assistant: { kind: 'assistant' },
}

export const ADMIN_API_PREFIX = '/api/admin/v1/'

export function adminRouteRule(path: string): AdminRouteRule | null {
  if (!path.startsWith(ADMIN_API_PREFIX)) return null
  const rest = path.slice(ADMIN_API_PREFIX.length)
  const [segment, second] = rest.split('/')
  if (segment === 'data-protection' && (second === 'terms' || second === 'allowlist')) {
    return { kind: 'data-protection-terms' }
  }
  // 钉钉应用配置（CorpId、AppKey、AppSecret）：查看为钉钉集成查看级，保存与清除只限平台管理员（功能规则第 13 节）。
  if (segment === 'dingtalk' && second === 'settings') return { kind: 'module', module: 'dingtalk', writePlatformOnly: true }
  // 员工的钉钉绑定（查看、代绑、解绑、解锁）属于钉钉集成模块（功能规则第 13 节）。
  if (segment === 'identity' && /^identity\/users\/[^/]+\/dingtalk-binding(\/|$)/.test(rest)) {
    return { kind: 'module', module: 'dingtalk' }
  }
  return ROUTE_SEGMENT_RULES[segment ?? ''] ?? null
}

/** 已登记的一级路径段，供覆盖测试断言 OpenAPI 每条路径都有归属。 */
export function registeredAdminRouteSegments(): string[] {
  return Object.keys(ROUTE_SEGMENT_RULES)
}

/**
 * 跨模块选择器（功能规则第 13 节）：持有下列模块权限时，可读取表单需要的其他模块候选列表，
 * 不需另授对方模块的查看权限；处理函数按 `view: 'selector'` 只返回精简字段。
 */
const SELECTOR_PATHS: ReadonlyMap<string, ReadonlyArray<readonly [AdminModule, AdminLevel]>> = new Map([
  // Agent 草稿的能力步骤
  [`${ADMIN_API_PREFIX}skills`, [['agent', 'write']]],
  [`${ADMIN_API_PREFIX}skills/builtin`, [['agent', 'write']]],
  [`${ADMIN_API_PREFIX}connectors`, [['agent', 'write']]],
  // Agent 能力与 Skill 所需工具
  [`${ADMIN_API_PREFIX}runtimes/builtin-tools`, [['agent', 'write'], ['skill', 'read']]],
  // Skill 可见范围、Skill 审核选择可见角色
  [`${ADMIN_API_PREFIX}identity/roles`, [['skill', 'write']]],
  // 主动任务选择接收人
  [`${ADMIN_API_PREFIX}identity/users`, [['agent', 'write']]],
])

export type AdminRouteView = 'full' | 'selector'

export type AdminRouteDecision = { allowed: true; view: AdminRouteView } | { allowed: false; message: string }

const ALLOW: AdminRouteDecision = { allowed: true, view: 'full' }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 任一管理权限都可以对自己的管理助手对话执行的命令（功能规则第 13 节）；确认类命令由服务层按模块复核。 */
function isAssistantConversationCommand(path: string) {
  const rest = path.slice(`${ADMIN_API_PREFIX}assistant`.length)
  return rest === '/messages'
    || /^\/runs\/[^/]+\/(cancel|retry|confirm)$/.test(rest)
    || /^\/(task-proposals|action-plans)\/[^/]+\/(cancel|confirm)$/.test(rest)
}

/** 路由入口的模块权限判定（功能规则第 13 节）。 */
export function decideAdminRouteAccess(permissions: Iterable<string>, path: string, method: string | undefined): AdminRouteDecision {
  const granted = toSet(permissions)
  const rule = adminRouteRule(path)
  if (!rule) return { allowed: false, message: '该管理接口未登记权限归属' }
  const write = !SAFE_METHODS.has((method ?? 'GET').toUpperCase())
  switch (rule.kind) {
    case 'session':
      return ALLOW
    case 'any-admin-read':
      if (write) return { allowed: false, message: '该管理接口只提供查看' }
      return hasModuleAdministrationAccess(granted) ? ALLOW : { allowed: false, message: '当前用户没有管理读取权限' }
    case 'platform-only':
      return isPlatformAdmin(granted) ? ALLOW : { allowed: false, message: '只有平台管理员可以执行该操作' }
    case 'audit':
      if (write) return isPlatformAdmin(granted) ? ALLOW : { allowed: false, message: '当前用户没有管理写权限' }
      return hasAuditAccess(granted) ? ALLOW : { allowed: false, message: '当前用户没有审计读取权限' }
    case 'assistant':
      if (!write || isAssistantConversationCommand(path)) {
        return hasModuleAdministrationAccess(granted) ? ALLOW : { allowed: false, message: '当前用户不能使用管理助手' }
      }
      return { allowed: false, message: '该管理助手接口未登记权限归属' }
    case 'data-protection-terms':
      // 词表与白名单：路由层要求数据防护模块权限，路由内再要求 data-protection:terms（两者同时满足）。
      return hasAdminModuleAccess(granted, 'dlp', write ? 'write' : 'read')
        ? ALLOW
        : { allowed: false, message: write ? '当前用户没有数据防护的修改权限' : '当前用户没有数据防护的查看权限' }
    case 'module': {
      if (write && READ_ONLY_MODULES.has(rule.module)) return { allowed: false, message: `${ADMIN_MODULE_LABELS[rule.module]}只提供查看` }
      if (write && rule.writePlatformOnly) {
        return isPlatformAdmin(granted) ? ALLOW : { allowed: false, message: `${ADMIN_MODULE_LABELS[rule.module]}的应用配置只有平台管理员可以修改` }
      }
      const level: AdminLevel = write ? 'write' : 'read'
      if (hasAdminModuleAccess(granted, rule.module, level)) return ALLOW
      if (!write && (SELECTOR_PATHS.get(path) ?? []).some(([module, needed]) => hasAdminModuleAccess(granted, module, needed))) {
        return { allowed: true, view: 'selector' }
      }
      return { allowed: false, message: `当前用户没有${ADMIN_MODULE_LABELS[rule.module]}的${write ? '修改' : '查看'}权限` }
    }
  }
}
