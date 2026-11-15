import type { ApiAuthenticator } from '../modules/identity/types.ts'

/**
 * Test-only identities for integration tests and the P0 browser smoke server.
 * Never imported by the application entry point: production always authenticates
 * with password or AI Hub sessions. The users U00001 and U00008 come from the
 * PostgreSQL seed migrations.
 */

/**
 * P0 冒烟的管理端模块权限测试身份（管理端模块权限方案 AMP-S2）：浏览器带 `dsh_test_admin_identity`
 * Cookie 时切换为模块管理员或只读管理员，用于验证菜单、落地页与只读提示。只存在于测试代码。
 */
const TEST_ADMIN_VARIANTS: Record<string, { name: string; avatarText: string; title: string; role: 'business_admin' | 'auditor'; permissions: string[] }> = {
  'knowledge-admin': { name: '周宁', avatarText: '周', title: '知识库管理员', role: 'business_admin', permissions: ['admin:knowledge:write', 'workbench:use', 'knowledge:bases'] },
  reader: { name: '王悦', avatarText: '王', title: '安全审计员', role: 'auditor', permissions: ['admin:read', 'audit:read'] },
}

function adminVariant(request: Parameters<ApiAuthenticator>[0]) {
  const cookie = request.headers.cookie ?? ''
  const match = /(?:^|;\s*)dsh_test_admin_identity=([a-z-]+)/.exec(cookie)
  return match ? TEST_ADMIN_VARIANTS[match[1]!] : undefined
}

export const testApiAuthenticator: ApiAuthenticator = async (request, audience) => {
  if (audience === 'workbench') {
    return {
      audience,
      applicationId: 'prototype-workbench',
      sessionHash: 'prototype-workbench-session',
      userId: 'U00001',
      subject: 'bootstrap:mvp-employee',
      profile: {
        id: 'U00001',
        name: '林岚',
        title: '生产计划专员',
        department: '供应链中心',
        avatarText: '林',
        role: 'employee',
        dataScopes: ['enterprise:authorized', 'workspace:authorized'],
      },
      roleIds: ['role-employee'],
      permissions: ['workbench:use'],
      dataScopes: ['enterprise:authorized', 'workspace:authorized'],
      authorizationVersion: 1,
      identityProvider: 'prototype-sso',
    }
  }
  const variant = adminVariant(request)
  if (variant) {
    return {
      audience,
      applicationId: 'prototype-admin',
      sessionHash: `prototype-admin-session-${variant.role}`,
      userId: 'U00008',
      subject: 'bootstrap:platform-admin',
      profile: {
        id: 'U00008', name: variant.name, title: variant.title, department: '数字化中心', avatarText: variant.avatarText,
        role: variant.role, dataScopes: ['enterprise:authorized'],
      },
      roleIds: [],
      permissions: variant.permissions,
      dataScopes: ['enterprise:authorized'],
      authorizationVersion: 1,
      identityProvider: 'prototype-sso',
    }
  }
  return {
    audience,
    applicationId: 'prototype-admin',
    sessionHash: 'prototype-admin-session',
    userId: 'U00008',
    subject: 'bootstrap:platform-admin',
    profile: {
      id: 'U00008',
      name: '陈默',
      title: 'AI 平台管理员',
      department: '数字化中心',
      avatarText: '陈',
      role: 'platform_admin',
      dataScopes: ['enterprise:authorized', 'workspace:authorized'],
    },
    roleIds: ['role-platform-admin'],
    permissions: ['admin:*', 'admin:read', 'admin:write', 'audit:read', 'workbench:use'],
    dataScopes: ['enterprise:authorized', 'workspace:authorized'],
    authorizationVersion: 1,
    identityProvider: 'prototype-sso',
  }
}
