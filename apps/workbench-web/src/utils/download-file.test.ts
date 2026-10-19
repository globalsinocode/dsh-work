import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runGuardedDownload } from './download-file'

describe('runGuardedDownload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('merges concurrent downloads for the same key', async () => {
    const action = vi.fn(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    })
    const first = runGuardedDownload('file-concurrent', action)
    const second = runGuardedDownload('file-concurrent', action)
    await vi.runAllTimersAsync()
    await Promise.all([first, second])
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('ignores a repeat trigger within the debounce window after completion', async () => {
    const action = vi.fn(async () => {})
    await runGuardedDownload('file-debounce', action)
    await runGuardedDownload('file-debounce', action)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('allows another download after the debounce window', async () => {
    const action = vi.fn(async () => {})
    await runGuardedDownload('file-later', action)
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    await runGuardedDownload('file-later', action)
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('runs independent downloads for different keys', async () => {
    const action = vi.fn(async () => {})
    await Promise.all([
      runGuardedDownload('file-a', action),
      runGuardedDownload('file-b', action),
    ])
    expect(action).toHaveBeenCalledTimes(2)
  })
})
