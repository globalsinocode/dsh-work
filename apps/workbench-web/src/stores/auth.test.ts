import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerVisibilityAuthRefresh } from '../utils/visibility-auth-refresh'

const api = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../api/client', () => ({ workbenchApi: api, WorkbenchApiError: class WorkbenchApiError extends Error {
  status: number
  code: string
  constructor(payload: { code?: string }, status: number, message: string) {
    super(message)
    this.status = status
    this.code = payload.code ?? 'request_failed'
  }
} }))

describe('workbench auth store', () => {
  const oldSession = {
    identityProvider: 'prototype-sso' as const,
    apiAudience: 'workbench' as const,
    user: {
      id: 'U00001', name: '员工', title: '', department: '—',
      avatarText: '员', role: 'employee' as const, dataScopes: ['region:east'],
    },
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    api.getSession.mockResolvedValue(oldSession)
  })

  it('refreshes role and dataScopes after visibility returns', async () => {
    api.getSession.mockResolvedValueOnce(oldSession).mockResolvedValueOnce({
      ...oldSession,
      user: { ...oldSession.user, dataScopes: [] },
    })
    const { useAuthStore } = await import('./auth')
    const store = useAuthStore()
    await store.load()
    expect(store.user.dataScopes).toEqual(['region:east'])

    const removeListener = registerVisibilityAuthRefresh(() => store.refresh())
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(store.user.dataScopes).toEqual([]))
    removeListener()
  })
})
