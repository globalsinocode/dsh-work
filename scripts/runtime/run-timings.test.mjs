import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatSummary, percentile, summarizeTimings } from './run-timings-summary.ts'

const sample = (attemptId, outcome, metrics, errorCode = null) => ({ attemptId, purpose: null, outcome, errorCode, metrics })

test('EX-00 percentiles use the nearest rank', () => {
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([10], 0.95), 10)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
})

test('EX-00 summary counts failures, keeps missing stages apart and never fills zeros', () => {
  const summary = summarizeTimings([
    sample('a1', 'completed', { worker_spawn_ms: 100, execution_ms: 2000, queue_wait_ms: 5 }),
    sample('a2', 'completed', { worker_spawn_ms: 300, execution_ms: 4000, queue_wait_ms: 15 }),
    sample('a3', 'failed', { worker_spawn_ms: 200, execution_ms: null, queue_wait_ms: 10 }, 'RUN_TIMEOUT'),
    sample('a4', 'cancelled', { worker_spawn_ms: null }),
  ])
  assert.deepEqual(summary.outcomes, { completed: 2, failed: 1, cancelled: 1, unfinished: 0 })
  assert.equal(summary.failureRate, 1 / 3)
  assert.deepEqual(summary.errorCodes, [{ code: 'RUN_TIMEOUT', count: 1 }])
  const spawn = summary.stages.find(stage => stage.key === 'worker_spawn_ms')
  assert.deepEqual(spawn, { key: 'worker_spawn_ms', label: 'Worker 进程启动', samples: 3, missing: 1, p50: 200, p95: 300, max: 300 })
  const collect = summary.stages.find(stage => stage.key === 'artifact_collect_ms')
  assert.deepEqual([collect?.samples, collect?.p50], [0, null])
  assert.match(formatSummary(summary), /\| Worker 进程启动 \| 3 \| 1 \| 200 \| 300 \| 300 \|/)
  assert.match(formatSummary(summary), /\| 成果收集 \| 0 \| 4 \| — \| — \| — \|/)
})

test('EX-00 the command line is validated', async () => {
  const { parseArguments } = await import('./run-timings.ts')
  const now = new Date('2026-10-16T00:00:00Z')
  assert.equal(parseArguments([], now).since, '2026-10-09T00:00:00.000Z')
  assert.deepEqual(parseArguments(['--', '--purpose', 'all', '--run', 'run-1', '--json'], now).runIds, ['run-1'])
  assert.throws(() => parseArguments(['--since', 'yesterday']), /不是有效时间/)
  assert.throws(() => parseArguments(['--bogus']), /未知参数/)
})
