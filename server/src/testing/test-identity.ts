import type { ApiAuthenticator } from '../modules/identity/types.ts'

/**
 * Test-only identities for integration tests and the P0 browser smoke server.
 * Never imported by the application entry point: production always authenticates
 * with password or AI Hub sessions. The users U00001 and U00008 come from the
 * PostgreSQL seed migrations.
 */

export const testApiAuthenticator: ApiAuthenticator = async (_request, audience) => {
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
