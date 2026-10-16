import assert from 'node:assert/strict'
import { test } from 'node:test'

import { summarizeToolCalls, toolCallDisplayMessage, toolFailureReason } from './tool-call-summary.ts'

test('EX-01 session log calls are enriched with platform bridge failure codes', () => {
  const summaries = summarizeToolCalls([
    { callId: 'c1', toolName: 'read', status: 'succeeded' },
    { callId: 'c2', toolName: 'python_execute', status: 'failed' },
    { callId: 'c3', toolName: 'propose_memory', status: 'succeeded' },
    { callId: 'c4', toolName: 'bash', status: 'failed' },
    { callId: 'c5', toolName: 'web_fetch', status: 'unknown' },
  ], [
    { toolName: 'python_execute', callId: 'c2', errorCode: 'TOOL_INPUT_INVALID' },
    // Matched by name when DSH did not send the call id; the bridge error wins over the log.
    { toolName: 'propose_memory', callId: null, errorCode: 'TOOL_PERMISSION_DENIED' },
  ])
  assert.deepEqual(summaries, [
    { call_id: 'c1', tool_name: 'read', status: 'succeeded', error_code: null },
    { call_id: 'c2', tool_name: 'python_execute', status: 'failed', error_code: 'TOOL_INPUT_INVALID' },
    { call_id: 'c3', tool_name: 'propose_memory', status: 'failed', error_code: 'TOOL_PERMISSION_DENIED' },
    { call_id: 'c4', tool_name: 'bash', status: 'failed', error_code: null },
    { call_id: 'c5', tool_name: 'web_fetch', status: 'unknown', error_code: null },
  ])
  assert.deepEqual(summaries.map(toolCallDisplayMessage), [
    'read：调用成功',
    'python_execute：调用失败，调用参数不符合工具要求',
    'propose_memory：调用失败，工具未获授权，或本次执行已结束',
    'bash：调用失败，工具返回失败',
    'web_fetch：未收到调用结果',
  ])
})

test('EX-01 without a session log the bridge outcomes are the only evidence', () => {
  assert.deepEqual(summarizeToolCalls(undefined, [
    { toolName: 'activate_skill', callId: null, errorCode: null },
    { toolName: 'python_execute', callId: 'x', errorCode: 'TOOL_TIMEOUT' },
  ]), [
    { call_id: 'platform-1', tool_name: 'activate_skill', status: 'succeeded', error_code: null },
    { call_id: 'x', tool_name: 'python_execute', status: 'failed', error_code: 'TOOL_TIMEOUT' },
  ])
})

test('EX-01 unknown codes fall back to a fixed reason instead of echoing tool text', () => {
  assert.equal(toolFailureReason('CRM_SECRET_LEAKED: token=abc'), '工具返回失败')
  assert.equal(toolFailureReason(null), '工具返回失败')
  assert.equal(toolFailureReason('TOOL_CALL_LIMIT_EXCEEDED'), '已达到本次执行的工具调用次数上限')
})
