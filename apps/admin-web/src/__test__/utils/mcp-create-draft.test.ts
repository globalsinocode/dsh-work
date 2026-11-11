import { afterEach, describe, expect, it } from 'vitest'

import { clearMcpCreateDraft, loadMcpCreateDraft, saveMcpCreateDraft } from '@/utils/mcp-create-draft'

const storage = new Map<string, string>()

function installMockSessionStorage() {
  const prior = globalThis.sessionStorage
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
      clear: () => { storage.clear() },
      key: () => null,
      length: 0,
    } satisfies Storage,
  })
  return () => {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: prior })
    storage.clear()
  }
}

describe('mcp create draft', () => {
  let restore: (() => void) | undefined

  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it('round-trips form fields and test error', () => {
    restore = installMockSessionStorage()
    clearMcpCreateDraft()
    saveMcpCreateDraft({
      form: {
        name: 'demo',
        endpoint: 'http://localhost/mcp',
        authType: 'user_oauth',
        bearerToken: '',
        scopeDescription: 'x',
        authorizationEndpoint: 'http://localhost/a',
        tokenEndpoint: 'http://localhost/t',
        clientId: 'c',
        clientSecret: 's',
        scopesText: 'mcp:read',
        resource: 'http://localhost/mcp',
      },
      testError: { title: 'err', description: 'detail' },
    })
    const loaded = loadMcpCreateDraft()
    expect(loaded?.form.name).toBe('demo')
    expect(loaded?.testError?.description).toBe('detail')
  })
})
