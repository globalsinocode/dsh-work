import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTHORIZATION_CHECK_SLOW_MS,
  AUTHORIZATION_CHECK_TIMEOUT_MS,
  authorizationCheckLogEntry,
  authorizationToolProbeTimeoutMs,
  resolveAuthorizationCheckTimeoutMs,
} from './authorization-check.ts'

test('默认硬超时为 10 秒、慢日志为 5 秒', () => {
  assert.equal(AUTHORIZATION_CHECK_TIMEOUT_MS, 10_000)
  assert.equal(AUTHORIZATION_CHECK_SLOW_MS, 5_000)
  assert.equal(resolveAuthorizationCheckTimeoutMs(undefined), 10_000)
  assert.equal(resolveAuthorizationCheckTimeoutMs(''), 10_000)
})

test('环境值必须是 7000–30000 的原始十进制整数毫秒', () => {
  assert.equal(resolveAuthorizationCheckTimeoutMs('15000'), 15_000)
  for (const value of [' ', '0', '-1', '6000', '6999', '30001', 'abc', '1.5', ' 10000 ']) {
    assert.throws(() => resolveAuthorizationCheckTimeoutMs(value), /DSH_WORK_AUTHORIZATION_CHECK_TIMEOUT_MS/)
  }
})

test('工具探测预算覆盖容器静止、授权硬超时和余量', () => {
  assert.equal(authorizationToolProbeTimeoutMs(10_000), 15_000)
  assert.equal(authorizationToolProbeTimeoutMs(15_000), 20_000)
})

test('授权日志条目是稳定 JSON，含 run/attempt/phase/耗时', () => {
  const entry = authorizationCheckLogEntry({
    level: 'warn',
    runId: 'run-1',
    attemptId: 'attempt-1',
    phase: 'pre_start',
    outcome: 'timeout',
    durationMs: 10_002,
    slowMs: 5_000,
    timeoutMs: 10_000,
    error: Object.assign(new Error('授权检查超时'), { code: 'AUTHORIZATION_CHECK_UNAVAILABLE' }),
  })
  assert.equal(entry.event, 'authorization.check')
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(entry.run_id, 'run-1')
  assert.equal(entry.attempt_id, 'attempt-1')
  assert.equal(entry.phase, 'pre_start')
  assert.equal(entry.outcome, 'timeout')
  assert.equal(entry.duration_ms, 10_002)
  assert.equal(entry.error_code, 'AUTHORIZATION_CHECK_UNAVAILABLE')
})
