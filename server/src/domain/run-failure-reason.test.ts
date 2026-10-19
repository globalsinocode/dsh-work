import assert from 'node:assert/strict'
import test from 'node:test'

import { enrichTaskRunError, extractRunFailureReason } from './run-failure-reason.ts'
import type { TaskRunError } from './types.ts'

const baseError: TaskRunError = {
  code: 'RUNTIME_EXECUTION_FAILED',
  message: '本轮执行失败',
  object: '运行 run-1',
  reason: 'DSH 运行时未能正常完成当前执行尝试。',
  suggestion: '可重新执行。',
  retryable: true,
}

test('extractRunFailureReason reads the latest terminal failure metadata', () => {
  const reason = extractRunFailureReason([
    { eventType: 'run.started', displayMessage: '开始', safeMetadata: {} },
    {
      eventType: 'run.failed',
      displayMessage: '任务执行失败',
      safeMetadata: { error_code: 'RUNTIME_EXECUTION_FAILED', reason: 'Invalid token' },
    },
  ])
  assert.equal(reason, 'Invalid token')
})

test('enrichTaskRunError replaces generic runtime failure copy with telemetry reason', () => {
  const enriched = enrichTaskRunError(baseError, [
    {
      eventType: 'run.failed',
      displayMessage: '任务执行失败',
      safeMetadata: { error_code: 'RUNTIME_EXECUTION_FAILED', reason: 'quota is not enough' },
    },
  ])
  assert.equal(enriched.reason, 'quota is not enough')
})

test('enrichTaskRunError appends detail for specific catalog reasons', () => {
  const enriched = enrichTaskRunError({
    ...baseError,
    code: 'RUN_TIMEOUT',
    reason: '执行时间超过当前 Agent 与运行时配置中的较短时限。',
  }, [
    {
      eventType: 'run.failed',
      displayMessage: '任务执行失败',
      safeMetadata: { error_code: 'RUN_TIMEOUT', reason: 'Runtime execution timed out' },
    },
  ])
  assert.match(enriched.reason, /Runtime execution timed out/)
})
