import { describe, expect, it } from 'vitest'

import { RUN_QUIET_THRESHOLD_MS, runQuietLabel, runQuietMs } from './run-quiet'

describe('run quiet hint', () => {
  it('measures quiet time only while the task is running', () => {
    expect(runQuietMs({ status: 'running', lastActivityAt: 1_000 }, 41_000)).toBe(40_000)
    expect(runQuietMs({ status: 'queued', lastActivityAt: 1_000 }, 41_000)).toBe(0)
    expect(runQuietMs({ status: 'awaiting_approval', lastActivityAt: 1_000 }, 41_000)).toBe(0)
    expect(runQuietMs({ status: 'running' }, 41_000)).toBe(0)
    expect(runQuietMs({ status: 'running', lastActivityAt: 50_000 }, 41_000)).toBe(0)
    expect(runQuietMs(null, 41_000)).toBe(0)
  })

  it('stays silent below the threshold and then reports seconds or minutes', () => {
    expect(runQuietLabel(RUN_QUIET_THRESHOLD_MS - 1)).toBeNull()
    expect(runQuietLabel(RUN_QUIET_THRESHOLD_MS)).toBe('30 秒')
    expect(runQuietLabel(119_999)).toBe('119 秒')
    expect(runQuietLabel(150_000)).toBe('2 分钟')
  })
})
