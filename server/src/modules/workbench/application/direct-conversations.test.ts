import assert from 'node:assert/strict'
import test from 'node:test'

import { RequestError } from '../../../domain/request-errors.ts'
import { directMessageMaxLength, directPair, requireDirectContent } from './direct-conversations.ts'

test('配对键按用户 id 字符串升序，相同 id 拒绝', () => {
  assert.deepEqual(directPair('user-b', 'user-a'), { userLow: 'user-a', userHigh: 'user-b' })
  assert.deepEqual(directPair('user-a', 'user-b'), { userLow: 'user-a', userHigh: 'user-b' })
  assert.throws(() => directPair('user-a', 'user-a'), (error: unknown) => error instanceof RequestError && error.status === 422)
  assert.throws(() => directPair('  ', 'user-a'), (error: unknown) => error instanceof RequestError && error.status === 422)
})

test('私聊正文去空白，空内容和超长拒绝', () => {
  assert.equal(requireDirectContent('  你好  '), '你好')
  assert.equal(requireDirectContent('a'.repeat(directMessageMaxLength)).length, directMessageMaxLength)
  assert.throws(() => requireDirectContent('   '), (error: unknown) => error instanceof RequestError && error.status === 422)
  assert.throws(() => requireDirectContent('a'.repeat(directMessageMaxLength + 1)), (error: unknown) => error instanceof RequestError && error.status === 422)
  assert.throws(() => requireDirectContent(1), (error: unknown) => error instanceof RequestError && error.status === 422)
})
