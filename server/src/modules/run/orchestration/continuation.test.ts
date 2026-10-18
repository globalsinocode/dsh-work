import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PostgresConversationRepository } from '../../workbench/application/postgres-conversation-repository.ts'
import { withContinuationOutputs, type ContinuationBounds } from './continuation.ts'

function port(outputs: string[]): Pick<PostgresConversationRepository, 'getRunAssistantOutputs'> {
  return {
    getRunAssistantOutputs: async () => outputs.map(content => ({ role: 'assistant' as const, content })),
  }
}

function bounds(maxChars: number, maxMessages = 50): ContinuationBounds {
  return { maxMessages, maxChars, keepFirst: true }
}

const message = (role: 'user' | 'assistant', content: string) => ({ role, content })

test('续写超预算时先淘汰最旧的部分回答，保留摘要后的完整历史（P2-26）', async () => {
  const history = [
    message('user', '第一条消息'),
    message('assistant', 'A'.repeat(30)),
    message('user', 'B'.repeat(30)),
  ]
  // 历史 + 问题 = 67 字，加 40 字部分回答会到 107，超过 100 的预算。
  const result = await withContinuationOutputs(port(['C'.repeat(40)]), history, 'run-1', '继续', bounds(100))
  // 历史原样保留，不出现“摘要后从中间开始”的空档；问题由 input.message 单独携带。
  assert.deepEqual(result.history, history)
  // 部分回答全部被淘汰后不能再声称“从断点续写”，回退为原始问题。
  assert.equal(result.message, '继续')
})

test('预算足够时保留部分回答并返回续写指令', async () => {
  const history = [message('user', '第一条消息'), message('assistant', 'A'.repeat(10))]
  const result = await withContinuationOutputs(port(['C'.repeat(20)]), history, 'run-1', '继续', bounds(100))
  assert.deepEqual(result.history, [...history, message('user', '继续'), message('assistant', 'C'.repeat(20))])
  assert.match(result.message, /断点处继续/)
})

test('历史与问题本身超限时才淘汰历史，且保留首条消息（EX-02）', async () => {
  const history = [
    message('user', '第一条消息'),
    message('assistant', 'A'.repeat(40)),
    message('user', 'B'.repeat(40)),
  ]
  const result = await withContinuationOutputs(port([]), history, 'run-1', '继续', bounds(60))
  assert.deepEqual(result.history, [history[0], history[2]])
  assert.equal(result.message, '继续')
})

test('多个部分回答从最旧开始淘汰，保留较新的输出', async () => {
  const history = [message('user', '第一条消息'), message('assistant', 'A'.repeat(10))]
  // 历史 + 问题 = 17 字；两个 30 字输出共 60 → 77，超过 50。
  const result = await withContinuationOutputs(port(['C'.repeat(30), 'D'.repeat(30)]), history, 'run-1', '继续', bounds(50))
  assert.deepEqual(result.history, [...history, message('user', '继续'), message('assistant', 'D'.repeat(30))])
  assert.match(result.message, /断点处继续/)
})
