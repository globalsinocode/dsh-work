import { describe, expect, it } from 'vitest'

import { createIntentRegistry } from './idempotent-intent'

describe('idempotent intent registry', () => {
  it('reuses a key after an uncertain failure and rotates after success', () => {
    const keys = ['key-1', 'key-2']
    const registry = createIntentRegistry(() => keys.shift()!)
    const first = registry.begin('run:session-1', 'fingerprint-a')
    registry.markUncertain('run:session-1', first.key)
    expect(registry.begin('run:session-1', 'fingerprint-a').key).toBe('key-1')
    registry.complete('run:session-1', first.key)
    expect(registry.begin('run:session-1', 'fingerprint-a').key).toBe('key-2')
  })

  it('rejects key reuse when the request fingerprint changes', () => {
    const registry = createIntentRegistry(() => 'key-1')
    registry.begin('message:session-1', 'body-a')
    expect(() => registry.begin('message:session-1', 'body-b')).toThrow('意图内容已变化')
  })
})
