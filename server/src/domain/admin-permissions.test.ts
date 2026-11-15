import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ADMIN_MODULE_LABELS,
  ADMIN_MODULES,
  adminModuleForPurpose,
  adminModulePermission,
  adminModuleSummary,
  allAdminModulePermissions,
  adminRouteRule,
  decideAdminRouteAccess,
  hasAdminAudienceAccess,
  hasAdminModuleAccess,
  hasModuleAdministrationAccess,
  isManagementPermission,
  missingDataScopes,
  missingPermissions,
} from './admin-permissions.ts'

const api = (path: string) => `/api/admin/v1/${path}`
const allowed = (permissions: string[], path: string, method = 'GET') => decideAdminRouteAccess(permissions, api(path), method).allowed

test('module codes: write includes read, admin:read/write cover every module, admin:* covers everything', () => {
  assert.ok(hasAdminModuleAccess(['admin:knowledge:write'], 'knowledge', 'read'))
  assert.ok(hasAdminModuleAccess(['admin:knowledge:write'], 'knowledge', 'write'))
  assert.ok(!hasAdminModuleAccess(['admin:knowledge:write'], 'agent', 'read'))
  assert.ok(!hasAdminModuleAccess(['admin:knowledge:read'], 'knowledge', 'write'))
  assert.ok(hasAdminModuleAccess(['admin:read'], 'model', 'read'))
  assert.ok(!hasAdminModuleAccess(['admin:read'], 'model', 'write'))
  assert.ok(hasAdminModuleAccess(['admin:write'], 'org', 'write'))
  assert.ok(hasAdminModuleAccess(['admin:*'], 'connector', 'write'))
  assert.deepEqual(adminModuleSummary(['admin:knowledge:write', 'admin:ops:read']), {
    agent: 'none', skill: 'none', connector: 'none', model: 'none', dlp: 'none', knowledge: 'write', org: 'none', identity: 'none', dingtalk: 'none', ops: 'read',
  })
})

test('audience: module codes and audit:read enter the admin console; terms alone does not', () => {
  assert.ok(hasAdminAudienceAccess(['admin:model:read']))
  assert.ok(hasAdminAudienceAccess(['audit:read']))
  assert.ok(!hasAdminAudienceAccess(['data-protection:terms']))
  assert.ok(!hasAdminAudienceAccess(['workbench:use', 'knowledge:bases']))
  assert.ok(!hasModuleAdministrationAccess(['audit:read']))
})

test('routes: a module admin reaches only their module', () => {
  const knowledgeAdmin = ['admin:knowledge:write']
  assert.ok(allowed(knowledgeAdmin, 'knowledge'))
  assert.ok(allowed(knowledgeAdmin, 'knowledge/bases', 'POST'))
  assert.ok(!allowed(knowledgeAdmin, 'agents'))
  assert.ok(!allowed(knowledgeAdmin, 'model-routes', 'POST'))
  assert.ok(!allowed(knowledgeAdmin, 'audit-events'))
  // 员工与权限是模块（AP11）：没有该模块权限不能查看或修改；防提权由服务层复核。
  assert.ok(!allowed(knowledgeAdmin, 'identity/users'))
  assert.ok(!allowed(knowledgeAdmin, 'identity/users/u1/roles', 'POST'))
  assert.ok(allowed(['admin:identity:read'], 'identity/users'))
  assert.ok(!allowed(['admin:identity:read'], 'identity/roles', 'POST'))
  assert.ok(allowed(['admin:identity:write'], 'identity/roles', 'POST'))
  assert.ok(allowed(['admin:*'], 'identity/roles', 'POST'))
  // 系统健康对任一模块管理员可读。
  assert.ok(allowed(knowledgeAdmin, 'health'))
  assert.ok(!allowed(['audit:read'], 'health'))
  // 运营只读。
  assert.ok(allowed(['admin:ops:read'], 'tasks'))
  assert.ok(!allowed(['admin:write'], 'tasks', 'POST'))
})

test('routes: DingTalk is a module; its application settings stay platform-admin only (AP12)', () => {
  assert.ok(allowed(['admin:dingtalk:read'], 'dingtalk/overview'))
  assert.ok(allowed(['admin:dingtalk:read'], 'dingtalk/settings'))
  assert.ok(!allowed(['admin:dingtalk:read'], 'dingtalk/reminders', 'POST'))
  assert.ok(allowed(['admin:dingtalk:write'], 'dingtalk/reminders', 'POST'))
  assert.ok(!allowed(['admin:dingtalk:write'], 'dingtalk/settings', 'PUT'))
  assert.ok(!allowed(['admin:write'], 'dingtalk/settings', 'DELETE'))
  assert.ok(allowed(['admin:*'], 'dingtalk/settings', 'PUT'))
  assert.ok(!allowed(['admin:knowledge:write'], 'dingtalk/overview'))
  // 员工的钉钉绑定挂在 identity 下，属于钉钉集成模块。
  assert.ok(allowed(['admin:dingtalk:read'], 'identity/users/u1/dingtalk-binding'))
  assert.ok(allowed(['admin:dingtalk:write'], 'identity/users/u1/dingtalk-binding/confirm', 'POST'))
  assert.ok(!allowed(['admin:identity:write'], 'identity/users/u1/dingtalk-binding/confirm', 'POST'))
})

test('routes: audit needs audit:read; terms need the data-protection module (the route adds terms itself)', () => {
  assert.ok(allowed(['audit:read'], 'audit-events'))
  assert.ok(allowed(['audit:read'], 'operations/summary'))
  assert.ok(!allowed(['admin:write'], 'audit-events'))
  assert.ok(!allowed(['data-protection:terms'], 'data-protection/terms'))
  assert.ok(allowed(['admin:dlp:read', 'data-protection:terms'], 'data-protection/terms'))
  assert.ok(!allowed(['admin:dlp:read', 'data-protection:terms'], 'data-protection/terms', 'POST'))
  assert.ok(allowed(['admin:dlp:write'], 'data-protection/allowlist', 'POST'))
})

test('routes: assistant conversation commands need any module permission; confirmation is rechecked by the service', () => {
  assert.ok(allowed(['admin:knowledge:read'], 'assistant/messages', 'POST'))
  assert.ok(allowed(['admin:knowledge:read'], 'assistant/task-proposals/p1/confirm', 'POST'))
  assert.ok(allowed(['admin:knowledge:read'], 'assistant/action-plans/a1/cancel', 'POST'))
  assert.ok(allowed(['admin:knowledge:read'], 'assistant/runs/r1/retry', 'POST'))
  assert.ok(!allowed(['audit:read'], 'assistant/messages', 'POST'))
  assert.ok(!allowed(['admin:*'], 'assistant/unknown', 'POST'))
})

test('routes: unregistered admin paths are denied (default deny)', () => {
  assert.equal(adminRouteRule(api('brand-new-thing')), null)
  assert.ok(!allowed(['admin:*'], 'brand-new-thing'))
})

test('routes: an Agent writer reads candidate lists in selector view only', () => {
  const agentWriter = ['admin:agent:write']
  assert.deepEqual(decideAdminRouteAccess(agentWriter, api('skills'), 'GET'), { allowed: true, view: 'selector' })
  assert.deepEqual(decideAdminRouteAccess(agentWriter, api('connectors'), 'GET'), { allowed: true, view: 'selector' })
  assert.deepEqual(decideAdminRouteAccess(['admin:skill:read'], api('skills'), 'GET'), { allowed: true, view: 'full' })
  assert.ok(!allowed(agentWriter, 'skills', 'POST'))
  assert.deepEqual(decideAdminRouteAccess(agentWriter, api('identity/users'), 'GET'), { allowed: true, view: 'selector' })
  assert.deepEqual(decideAdminRouteAccess(['admin:skill:write'], api('identity/roles'), 'GET'), { allowed: true, view: 'selector' })
  assert.deepEqual(decideAdminRouteAccess(['admin:skill:read'], api('runtimes/builtin-tools'), 'GET'), { allowed: true, view: 'selector' })
  assert.ok(!allowed(agentWriter, 'identity/roles'))
  assert.ok(!allowed(agentWriter, 'skill-versions'))
  assert.ok(!allowed(['admin:agent:read'], 'skills'))
})

test('every documented admin operation has a permission owner', () => {
  const document = JSON.parse(readFileSync(new URL('../../../docs/development/openapi-admin.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> }
  const missing: string[] = []
  for (const [path, operations] of Object.entries(document.paths)) {
    const full = path.startsWith('/api/') ? path : `/api/admin/v1${path}`
    for (const method of Object.keys(operations).filter(key => ['get', 'post', 'put', 'patch', 'delete'].includes(key))) {
      const concrete = full.replace(/\{[^}]+\}/g, 'x')
      if (!decideAdminRouteAccess(['admin:*'], concrete, method.toUpperCase()).allowed) missing.push(`${method.toUpperCase()} ${path}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('grant ceiling: implied codes are expanded before comparing', () => {
  assert.deepEqual(missingPermissions(['knowledge:docs', 'workbench:use'], ['knowledge:bases', 'workbench:use']), [])
  assert.deepEqual(missingPermissions(['admin:agent:read'], ['admin:write']), [])
  assert.deepEqual(missingPermissions(['knowledge:bases'], ['knowledge:docs']), ['knowledge:bases'])
  assert.deepEqual(missingPermissions(['anything'], ['admin:*']), [])
  assert.deepEqual(missingDataScopes(['enterprise:authorized', 'workspace:authorized'], ['enterprise:authorized']), ['workspace:authorized'])
})

test('management prefixes and Run purposes', () => {
  assert.ok(isManagementPermission('admin:knowledge:read'))
  assert.ok(isManagementPermission('audit:read'))
  assert.ok(isManagementPermission('data-protection:terms'))
  assert.ok(!isManagementPermission('knowledge:bases'))
  assert.equal(adminModuleForPurpose('admin-skill-install'), 'skill')
  assert.equal(adminModuleForPurpose('agent-release-trial'), 'agent')
  assert.equal(adminModuleForPurpose('admin-platform-operations'), 'connector')
  assert.equal(adminModuleForPurpose('admin-assistant'), null)
})

// 前端的模块清单与权限包含关系只用于展示，但必须与这里一致，否则按钮可用性与服务端判定不符（评审 #127）。
test('admin-web module helpers stay in sync with the server permission tables', async () => {
  // 用运行时路径导入，避免把前端文件纳入服务端的 tsc rootDir。
  const web = await import(new URL('../../../apps/admin-web/src/utils/admin-modules.ts', import.meta.url).href) as {
    ADMIN_MODULES: readonly string[]
    ADMIN_MODULE_LABELS: Record<string, string>
    READ_ONLY_MODULES: ReadonlySet<string>
    permissionsBeyond: (granted: readonly string[], held: readonly string[]) => string[]
    moduleLevelsOf: (permissions: readonly string[]) => Record<string, string>
  }
  assert.deepEqual([...web.ADMIN_MODULES], [...ADMIN_MODULES])
  assert.deepEqual(web.ADMIN_MODULE_LABELS, ADMIN_MODULE_LABELS)
  assert.deepEqual(
    ADMIN_MODULES.filter(module => web.READ_ONLY_MODULES.has(module)),
    ADMIN_MODULES.filter(module => !allAdminModulePermissions().includes(adminModulePermission(module, 'write'))),
  )
  const codes = ['admin:*', 'admin:read', 'admin:write', ...allAdminModulePermissions(), 'audit:read', 'data-protection:terms', 'knowledge:view', 'knowledge:docs', 'knowledge:bases', 'workbench:use']
  for (const granted of codes) {
    for (const held of codes) {
      assert.deepEqual(web.permissionsBeyond([granted], [held]), missingPermissions([granted], [held]), `${granted} vs ${held}`)
    }
    for (const module of ADMIN_MODULES) {
      assert.equal(web.moduleLevelsOf([granted])[module], adminModuleSummary([granted])[module], `${granted} on ${module}`)
    }
  }
})
