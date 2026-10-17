import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_PLATFORM_TIMEZONE, formatExecutionTime, isValidTimezone, resolvePlatformTimezone } from './execution-time.ts'

test('formats the execution time as the local wall clock of the timezone', () => {
  // 07:32 on Saturday in Taipei is still Friday in UTC: the routine date bug in P2.
  assert.equal(formatExecutionTime('2026-10-16T23:32:00.000Z', 'Asia/Taipei'), '2026-10-17 星期六 07:32（Asia/Taipei，UTC+08:00）')
  assert.equal(formatExecutionTime('2026-10-16T23:32:00.000Z', 'UTC'), '2026-10-16 星期五 23:32（UTC，UTC+00:00）')
  assert.equal(formatExecutionTime('2026-10-16T23:32:00.000Z', 'America/New_York'), '2026-10-16 星期五 19:32（America/New_York，UTC-04:00）')
})

test('the platform timezone defaults to Asia/Shanghai and rejects invalid values at startup', () => {
  assert.equal(resolvePlatformTimezone(undefined), DEFAULT_PLATFORM_TIMEZONE)
  assert.equal(resolvePlatformTimezone('  '), DEFAULT_PLATFORM_TIMEZONE)
  assert.equal(resolvePlatformTimezone('Asia/Taipei'), 'Asia/Taipei')
  assert.throws(() => resolvePlatformTimezone('Mars/Base'), /DSH_WORK_TIMEZONE 不是有效的 IANA 时区/)
  assert.equal(isValidTimezone(''), false)
  assert.equal(isValidTimezone(42), false)
})
