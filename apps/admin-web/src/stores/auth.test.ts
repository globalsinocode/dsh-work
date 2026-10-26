import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../api/client', () => ({
  adminApi: api,
  AdminApiError: class AdminApiError extends Error {
    status: number
    code: string
    constructor(payload: { code?: string }, status: number, message: string) {
      super(message)
      this.status = status
      this.code = payload.code ?? 'request_failed'
    }
  },
}))

describe('admin auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.getSession.mockResolvedValue({
      identityProvider: 'prototype-sso',
      apiAudience: 'admin',
      permissions: ['admin:*', 'admin:read', 'admin:write', 'audit:read'],
      user: {
        id: 'U00008', name: '平台管理员', title: '管理员', department: '数字化中心',
        avatarText: '管', role: 'platform_admin', dataScopes: ['平台配置'],
      },
    })
  })

  it('derives write visibility from the server session role', async () => {
    const { useAuthStore } = await import('./auth')
    const store = useAuthStore()
    await store.load()
    expect(store.canManage).toBe(true)
    expect(store.canManageIdentity).toBe(true)
    expect(store.canReadAdmin).toBe(true)
    expect(store.canReadAudit).toBe(true)
    expect(store.identityAdministrationAvailable).toBe(false)
    expect(store.user.id).toBe('U00008')

    expect(store.isAuditor).toBe(false)
  })

  it('keeps an auditor session read-only', async () => {
    api.getSession.mockResolvedValueOnce({
      identityProvider: 'prototype-sso',
      apiAudience: 'admin',
      permissions: ['audit:read'],
      user: {
        id: 'U00019', name: '安全审计员', title: '审计员', department: '信息安全部',
        avatarText: '审', role: 'auditor', dataScopes: ['审计记录'],
      },
    })
    const { useAuthStore } = await import('./auth')
    const store = useAuthStore()
    await store.load()
    expect(store.isAuditor).toBe(true)
    expect(store.canManage).toBe(false)
    expect(store.canManageIdentity).toBe(false)
    expect(store.canReadAdmin).toBe(false)
    expect(store.canReadAudit).toBe(true)
    expect(store.user.id).toBe('U00019')
  })

  it('does not expose identity writes to a regular admin writer', async () => {
    api.getSession.mockResolvedValueOnce({
      identityProvider: 'ai-hub-oidc',
      apiAudience: 'admin',
      permissions: ['admin:read', 'admin:write'],
      user: {
        id: 'user-writer', name: '业务管理员', title: '管理员', department: '业务部',
        avatarText: '业', role: 'business_admin', dataScopes: [],
      },
    })
    const { useAuthStore } = await import('./auth')
    const store = useAuthStore()
    await store.load()
    expect(store.canManage).toBe(true)
    expect(store.canManageIdentity).toBe(false)
    expect(store.canReadAdmin).toBe(true)
    expect(store.identityAdministrationAvailable).toBe(true)
  })

  it('coalesces concurrent refresh calls and replaces permissions', async () => {
    let resolve!: (value: unknown) => void
    api.getSession.mockReturnValue(new Promise(value => { resolve = value }))
    const { useAuthStore } = await import('./auth')
    const store = useAuthStore()
    const first = store.refresh()
    const second = store.refresh()
    expect(api.getSession).toHaveBeenCalledTimes(1)
    resolve({
      identityProvider: 'prototype-sso',
      apiAudience: 'admin',
      permissions: ['audit:read'],
      user: {
        id: 'U00019', name: '安全审计员', title: '审计员', department: '信息安全部',
        avatarText: '审', role: 'auditor', dataScopes: ['审计记录'],
      },
    })
    await Promise.all([first, second])
    expect(store.permissions).toEqual(['audit:read'])
  })

  it('clears access when refreshed Session is no longer authorized', async () => {
    const { AdminApiError } = await import('../api/client')
    api.getSession.mockRejectedValue(new AdminApiError({}, 403, 'forbidden'))
    const { useAuthStore } = await import('./auth')
    const store = useAuthStore()
    await expect(store.refresh()).rejects.toBeDefined()
    expect(store.canAccessAdmin).toBe(false)
  })

  it('enables account administration for a local platform administrator', async () => {
    api.getSession.mockResolvedValueOnce({
      identityProvider: 'local-password',
      apiAudience: 'admin',
      permissions: ['admin:*', 'admin:read', 'admin:write', 'audit:read'],
      user: {
        id: 'local-admin', name: '本地管理员', title: '管理员', department: '',
        avatarText: '本', role: 'platform_admin', dataScopes: [],
      },
    })
    const { useAuthStore } = await import('./auth')
    const store = useAuthStore()
    await store.load()
    expect(store.identityAdministrationAvailable).toBe(true)
    expect(store.canManageIdentity).toBe(true)
  })
})
