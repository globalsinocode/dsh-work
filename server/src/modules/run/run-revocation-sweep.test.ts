import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isAuthorizationDenial, AuthorizationDeniedError, authorizationDenied } from '../authorization/authorization-errors.ts'

/**
 * Locks the authorization-denial classifier (1A-T5). The authorization service
 * throws plain Errors, so if one of its denial messages is reworded this test
 * fails instead of the sweep silently refusing to cancel revoked runs.
 */
test('isAuthorizationDenial ignores wording: a plain Error is never a denial', () => {
  const denials = [
    '当前用户没有员工工作台使用权限',
    '当前用户不存在、已停用或所属企业不可用',
    '当前用户角色不可使用所选 Agent',
    '当前用户角色不可调用工具：tool-x',
    '当前用户已不是该团队空间成员',
    '当前用户角色为只读，不能继续执行任务',
    '工作空间不存在、已归档或当前用户不是成员',
    '工作空间不存在或已归档',
    '工作空间未配置Agent授权',
    '工作空间未授权Skill：skill-x',
    'Agent Version 不存在、未发布或所属 Agent 已停用',
    'Skill 不存在、未发布或已停用：skill-x',
    '工具不存在、未发布、不可用或不符合一期只读策略：tool-x',
    'Agent 必须显式授权所选 Skill 依赖的工具：tool-x',
    'Agent要求未授权的数据范围：scope-x',
  ]
  for (const message of denials) {
    // Wording alone must not cancel runs; only the typed denial does.
    assert.equal(isAuthorizationDenial(new Error(message)), false, `普通 Error 不应判定为授权拒绝：${message}`)
    assert.equal(isAuthorizationDenial(new AuthorizationDeniedError(message)), true, message)
  }
})

test('isAuthorizationDenial recognizes the typed denial regardless of message', () => {
  // 类型化错误：文案改动或新文案都不会漏判（这是 P1-2 的根因）。
  assert.equal(isAuthorizationDenial(new AuthorizationDeniedError('任意新文案')), true)
  assert.equal(isAuthorizationDenial(authorizationDenied('Agent 成员已停用或已移出该团队空间，不能继续执行任务')), true)
})

test('isAuthorizationDenial never classifies infrastructure failures as revocations', () => {
  const failures = [
    new Error('connect ECONNREFUSED 127.0.0.1:15433'),
    new Error('Connection terminated unexpectedly'),
    new Error('timeout exceeded when trying to connect'),
    new Error('canceling statement due to statement timeout'),
    Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505' }),
    new Error('未知的内部错误'),
    'not an error object',
    undefined,
    null,
  ]
  for (const error of failures) {
    assert.equal(isAuthorizationDenial(error), false, `不得判定为授权拒绝：${String(error)}`)
  }
})
