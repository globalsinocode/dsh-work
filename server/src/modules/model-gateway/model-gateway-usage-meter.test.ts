import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MemoryModelGatewayRequestLog } from './model-gateway-request-log.ts'
import { ModelGatewayUsageMeter, summarizeGatewayRequests } from './model-gateway-usage-meter.ts'
import type { ModelGatewayRequestRecord } from './model-gateway-types.ts'

let sequence = 0
function record(overrides: Partial<ModelGatewayRequestRecord>): ModelGatewayRequestRecord {
  sequence += 1
  return {
    id: `req-${sequence}`, tenantId: 'tenant-dsh-work', runId: 'run-1', attemptId: 'attempt-1', routeId: 'route-default',
    providerKey: 'deepseek-official', modelKey: 'deepseek-v4-pro', endpoint: 'chat', origin: 'upstream', outcome: 'succeeded',
    httpStatus: 200, errorCode: null, inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: null,
    startedAt: `2026-11-08T10:00:${String(sequence).padStart(2, '0')}.000Z`, finishedAt: `2026-11-08T10:00:${String(sequence).padStart(2, '0')}.500Z`,
    ...overrides,
  }
}

describe('模型网关用量汇总（MR-S3）', () => {
  it('重试后成功：请求次数含重试，失败次数只计失败，token 只计返回了用量的请求', () => {
    const lines = summarizeGatewayRequests([
      record({ outcome: 'failed', httpStatus: 429, errorCode: 'rate_limit', inputTokens: null, outputTokens: null, cacheReadTokens: null }),
      record({ outcome: 'failed', httpStatus: 429, errorCode: 'rate_limit', inputTokens: null, outputTokens: null, cacheReadTokens: null }),
      record({ inputTokens: 1000, outputTokens: 80, cacheReadTokens: 600 }),
      record({ inputTokens: 1200, outputTokens: 90, cacheReadTokens: 700 }),
    ])
    assert.deepEqual(lines, [{
      endpoint: 'chat', providerKey: 'deepseek-official', modelKey: 'deepseek-v4-pro', requests: 4, failedRequests: 2,
      succeededRequests: 2, usageReported: true, inputTokens: 2200, outputTokens: 170, cacheReadTokens: 1300, cacheWriteTokens: null,
    }])
  })

  it('返回用量的请求里有一次没带缓存数据时，缓存记为 null 而不是部分求和', () => {
    const [line] = summarizeGatewayRequests([
      record({ cacheReadTokens: 50 }),
      record({ cacheReadTokens: null }),
    ])
    assert.equal(line?.cacheReadTokens, null)
    assert.equal(line?.inputTokens, 200)
  })

  it('联网搜索单独一行；实际模型取厂商成功的请求，不取网关拒绝时记录的请求模型', () => {
    const lines = summarizeGatewayRequests([
      record({ origin: 'gateway', outcome: 'failed', httpStatus: 403, modelKey: 'wrong-model', inputTokens: null, outputTokens: null, cacheReadTokens: null }),
      record({ modelKey: 'deepseek-v4-pro' }),
      record({ endpoint: 'search', modelKey: 'deepseek-v4-flash', inputTokens: 800, outputTokens: 200, cacheReadTokens: null }),
    ])
    assert.deepEqual(lines.map(line => [line.endpoint, line.modelKey, line.requests]), [
      ['chat', 'deepseek-v4-pro', 2],
      ['search', 'deepseek-v4-flash', 1],
    ])
    assert.equal(lines[1]?.cacheReadTokens, null)
  })

  it('全部失败或中止：token 记 0，中止不计入失败', () => {
    const [line] = summarizeGatewayRequests([
      record({ outcome: 'failed', httpStatus: 503, inputTokens: null, outputTokens: null, cacheReadTokens: null, modelKey: 'qwen3.8-flash', providerKey: 'bailian' }),
      record({ outcome: 'aborted', httpStatus: 200, inputTokens: null, outputTokens: null, cacheReadTokens: null, modelKey: 'qwen3.8-flash', providerKey: 'bailian' }),
    ])
    assert.deepEqual(line, {
      endpoint: 'chat', providerKey: 'bailian', modelKey: 'qwen3.8-flash', requests: 2, failedRequests: 1,
      succeededRequests: 0, usageReported: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null,
    })
  })

  it('没有成功请求时，实际模型取发到厂商的请求，而不是网关拒绝时记录的请求模型', () => {
    const [line] = summarizeGatewayRequests([
      record({ outcome: 'failed', httpStatus: 503, modelKey: 'qwen3.8-flash', inputTokens: null, outputTokens: null, cacheReadTokens: null }),
      record({ origin: 'gateway', outcome: 'failed', httpStatus: 403, modelKey: 'wrong-model', inputTokens: null, outputTokens: null, cacheReadTokens: null }),
    ])
    assert.equal(line?.modelKey, 'qwen3.8-flash')
  })

  it('取消后先等待网关写入被中止请求的记录再汇总', async () => {
    const log = new MemoryModelGatewayRequestLog()
    const meter = new ModelGatewayUsageMeter(log, { cancelSettleMs: 50 })
    const pending = meter.summarizeAttempt('tenant-dsh-work', 'attempt-late', { afterCancel: true })
    await log.record(record({ attemptId: 'attempt-late', outcome: 'aborted', inputTokens: null, outputTokens: null, cacheReadTokens: null }))
    assert.equal((await pending)[0]?.requests, 1)
  })

  it('没有网关记录时返回空数组（调用方沿用会话日志或估算）', async () => {
    const log = new MemoryModelGatewayRequestLog()
    await log.record(record({ attemptId: 'other-attempt' }))
    const meter = new ModelGatewayUsageMeter(log)
    assert.deepEqual(await meter.summarizeAttempt('tenant-dsh-work', 'attempt-1'), [])
    assert.equal((await meter.summarizeAttempt('tenant-dsh-work', 'other-attempt')).length, 1)
  })
})
