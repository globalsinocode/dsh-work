import { describe, expect, it } from 'vitest'

import { isGenericRunFailureReason, runFailureDetailReason } from './run-error-display'

describe('run-error-display', () => {
  it('treats catalog placeholder copy as non-detail', () => {
    expect(isGenericRunFailureReason('DSH 运行时未能正常完成当前执行尝试。')).toBe(true)
    expect(isGenericRunFailureReason('Runtime 成果目录无效')).toBe(false)
  })

  it('returns telemetry reason for the failure notice', () => {
    expect(runFailureDetailReason({
      code: 'RUNTIME_EXECUTION_FAILED',
      message: '本轮执行失败',
      object: '运行 run-1',
      reason: 'Runtime 成果目录无效',
      suggestion: '重试',
      retryable: true,
    })).toBe('Runtime 成果目录无效')
  })
})
