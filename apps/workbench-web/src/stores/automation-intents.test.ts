import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAutomationIntentStore } from './automation-intents'

describe('automation-intents store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    let counter = 0
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => `key-${++counter}`),
    })
  })

  it('reuses run-now key after an uncertain failure and rotates for explicit run again', () => {
    const store = useAutomationIntentStore()
    const first = store.begin('automation-1', 'run-now')
    store.markUncertain('automation-1', 'run-now', first)
    expect(store.begin('automation-1', 'run-now')).toBe(first)
    store.complete('automation-1', 'run-now', first)
    expect(store.begin('automation-1', 'run-now')).not.toBe(first)
  })
})
