import { describe, expect, it } from 'vitest'

import router from './index'

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
    expect(route.meta.requiresAiHubIdentity).toBe(true)
  })
})
