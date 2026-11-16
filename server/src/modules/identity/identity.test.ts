import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertApiRouteAccess } from '../../http/router.ts'
import { LOCAL_PERMISSIONS, type RequestIdentity } from './types.ts'
import { hashOpaque, randomOpaque } from './secure-values.ts'

test('admin API read permissions are enforced per route', () => {
  const auditIdentity = adminIdentity([LOCAL_PERMISSIONS.auditRead])
  assert.doesNotThrow(() => assertApiRouteAccess(
    auditIdentity,
    '/api/admin/v1/audit-events',
    'GET',
  ))
  assert.throws(
    () => assertApiRouteAccess(auditIdentity, '/api/admin/v1/agents', 'GET'),
    /没有Agent的查看权限/,
  )

  const adminReadIdentity = adminIdentity([LOCAL_PERMISSIONS.adminRead])
  assert.doesNotThrow(() => assertApiRouteAccess(
    adminReadIdentity,
    '/api/admin/v1/agents',
    'GET',
  ))
  assert.throws(
    () => assertApiRouteAccess(adminReadIdentity, '/api/admin/v1/operations/summary', 'GET'),
    /审计读取权限/,
  )
  assert.throws(
    () => assertApiRouteAccess(adminReadIdentity, '/api/admin/v1/agents', 'POST'),
    /没有Agent的修改权限/,
  )
})

test('business permissions are defined locally', () => {
  assert.deepEqual(Object.values(LOCAL_PERMISSIONS), [
    'workbench:use', 'workbench:manage', 'admin:*', 'admin:read', 'admin:write', 'audit:read',
    'data-protection:terms',
    'knowledge:view', 'knowledge:docs', 'knowledge:bases',
  ])
  assert.equal(Object.values(LOCAL_PERMISSIONS).some(permission => permission.startsWith('dsh_work.')), false)
})

test('opaque values are random and hashed deterministically', () => {
  const opaque = randomOpaque()
  assert.ok(opaque.length >= 32)
  assert.notEqual(randomOpaque(), opaque)
  assert.equal(hashOpaque(opaque), hashOpaque(opaque))
  assert.notEqual(hashOpaque(`${opaque}x`), hashOpaque(opaque))

})

function adminIdentity(permissions: string[]): RequestIdentity {
  return {
    audience: 'admin',
    applicationId: 'dsh-work',
    sessionHash: 'test-session',
    userId: 'user-test',
    subject: 'subject-test',
    profile: {
      id: 'user-test',
      name: '测试用户',
      title: '测试角色',
      department: '测试部门',
      avatarText: '测',
      role: 'auditor',
      dataScopes: [],
    },
    roleIds: ['role-auditor'],
    permissions,
    dataScopes: [],
    authorizationVersion: 1,
    identityProvider: 'local-password',
  }
}
