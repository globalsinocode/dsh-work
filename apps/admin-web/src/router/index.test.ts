import { describe, expect, it, vi } from 'vitest'

import router, { resolveAdminProtectedRouteTarget } from './index'

describe('admin authentication routes', () => {
  it('registers one protected management assistant page', () => {
    const route = router.resolve('/assistant')
    expect(route.name).toBe('assistant')
    expect(route.meta.title).toBe('管理助手')
    expect(route.meta.requiredPermission).toBe('adminRead')
    expect(route.meta.requiresAdmin).toBe(true)
  })
  it('serves login errors outside the backend auth proxy', () => {
    const route = router.resolve('/login-error')

    expect(route.name).toBe('auth-error')
    expect(route.meta.public).toBe(true)
  })

  it('registers local employee and authorization administration', () => {
    const route = router.resolve('/identity')

    expect(route.name).toBe('identity')
    expect(route.meta.title).toBe('员工与权限')
    expect(route.meta.requiredPermission).toBe('adminRead')
    expect(route.meta.requiresManagedIdentity).toBe(true)
  })

  it('serves local login and mandatory password changes without an authenticated session', () => {
    expect(router.resolve('/login').meta.public).toBe(true)
    expect(router.resolve('/change-password').meta.public).toBe(true)
  })

  it('registers the about page for every authenticated management user', () => {
    const route = router.resolve('/about')

    expect(route.name).toBe('about')
    expect(route.meta.title).toBe('关于 dsh-work')
    expect(route.meta.requiresAdmin).toBe(true)
    expect(route.meta.requiredPermission).toBeUndefined()
  })

  it('refreshes before protected navigation and redirects to the first allowed page', async () => {
    const auth = {
      refresh: vi.fn().mockResolvedValue(undefined),
      canManage: false,
      canReadAudit: true,
      canReadAdmin: false,
      canAccessAdmin: true,
      identityAdministrationAvailable: true,
    }
    const result = resolveAdminProtectedRouteTarget(
      { meta: { requiresAdmin: true, requiredPermission: 'adminRead' } },
      auth,
    )
    expect(result).toEqual({ name: 'audit' })
  })

  it('uses the existing forbidden route when no admin permission remains', async () => {
    const protectedRoute = { meta: { requiresAdmin: true, requiredPermission: 'adminRead' } }
    const result = resolveAdminProtectedRouteTarget(protectedRoute, {
      canAccessAdmin: false,
      canReadAdmin: false,
      canReadAudit: false,
      identityAdministrationAvailable: false,
    })
    expect(result).toEqual({ name: 'forbidden' })
  })

  it('publishes the experience iteration context as a topbar subtitle', () => {
    const route = router.resolve('/experience-iterations')

    expect(route.meta.title).toBe('经验迭代')
    expect(route.meta.subtitle).toContain('按稳定 Agent 归属')
    expect(route.meta.subtitle).toContain('不会自动修改 Soul、Skill、Tool 或权限')
  })
})
