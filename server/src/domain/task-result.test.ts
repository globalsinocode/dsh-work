import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveTaskResult,
  TASK_RESULT_VERSION,
  type TaskResultEvidence,
} from './task-result.ts'
import type { Artifact, TaskSource } from './types.ts'
import type { JsonObject } from '../modules/run/run-types.ts'

const occurredAt = new Date('2026-09-20T10:00:00.000Z')
const updatedAt = new Date('2026-09-20T10:00:05.000Z')

function evidence(overrides: Partial<TaskResultEvidence> = {}): TaskResultEvidence {
  return {
    run: { id: 'run-001', status: 'succeeded', updatedAt },
    attemptId: 'attempt-001',
    events: [],
    committedMessageIds: new Set(),
    artifacts: [],
    sources: [],
    toolAudits: [],
    runError: null,
    ...overrides,
  }
}

function event(id: string, eventType: string, safeMetadata: JsonObject = {}) {
  return { id, eventType, displayMessage: null, safeMetadata, occurredAt }
}

function artifact(id: string): TaskResultEvidence['artifacts'][number] {
  const value: Artifact = {
    id,
    name: `${id}.xlsx`,
    type: 'xlsx',
    version: 1,
    size: '12 KB',
    createdAt: '2026-09-20 10:00',
    runId: 'run-001',
    workspaceId: 'ws-1',
    summary: '本轮成果',
  }
  return { artifact: value, artifactVersionId: `artifact-version-${id}` }
}

const source: TaskSource = {
  id: 'doc-1',
  type: 'knowledge',
  title: '库存安全水位管理规范',
  description: '摘要',
}

test('non-terminal runs project a pending outcome without inventing results', () => {
  const result = deriveTaskResult(evidence({ run: { id: 'run-001', status: 'running', updatedAt } }))

  assert.equal(result.version, TASK_RESULT_VERSION)
  assert.equal(result.execution, 'running')
  assert.equal(result.outcome, 'pending')
  assert.equal(result.completedAt, null)
  assert.equal(result.primaryOutput, null)
})

test('succeeded run with committed answer and registered artifacts is achieved', () => {
  const result = deriveTaskResult(evidence({
    events: [
      event('e1', 'assistant.completed'),
      event('e2', 'run.completed', { artifact_count: 1, stop_reason: 'end_turn', tool_call_count: 2 }),
    ],
    committedMessageIds: new Set(['message-assistant-e1']),
    artifacts: [artifact('artifact-1')],
    sources: [source],
  }))

  assert.equal(result.outcome, 'achieved')
  assert.equal(result.primaryOutput?.messageId, 'message-assistant-e1')
  assert.equal(result.receipts.some(receipt => receipt.kind === 'answer' && receipt.status === 'completed'), true)
  assert.equal(result.receipts.some(receipt => receipt.kind === 'artifact' && receipt.ref === 'artifact-version-artifact-1'), true)
  assert.equal(result.pendingItems.length, 0)
  assert.equal(result.evidence.artifactsClaimed, 1)
  assert.equal(result.evidence.artifactsRegistered, 1)
  assert.equal(result.completedAt, occurredAt.toISOString())
})

test('model self-report does not verify the goal when declared artifacts are missing', () => {
  // 关键验收：模型自述「已完成并生成 4 个成果」，登记只有 3 个 → 不显示已达成。
  const result = deriveTaskResult(evidence({
    events: [
      event('e1', 'assistant.completed'),
      event('e2', 'run.completed', { artifact_count: 4 }),
    ],
    committedMessageIds: new Set(['message-assistant-e1']),
    artifacts: [artifact('a1'), artifact('a2'), artifact('a3')],
  }))

  assert.equal(result.outcome, 'unverified')
  assert.equal(result.pendingItems.some(item => item.kind === 'artifact_registration_gap'), true)
  assert.equal(result.receipts.some(receipt => receipt.status === 'missing'), true)
})

test('succeeded run without any committed deliverable is unverified', () => {
  const result = deriveTaskResult(evidence({
    events: [event('e2', 'run.completed')],
  }))

  assert.equal(result.outcome, 'unverified')
  assert.equal(result.pendingItems.some(item => item.kind === 'no_deliverable'), true)
})

test('a committed answer alone is content registration, not goal achievement', () => {
  // P1 回归：回答内容为「缺少必要数据，无法完成任务」也曾被判 achieved——
  // 登记只证明落库；没有可核验业务交付物（成果）时必须保持 unverified。
  const result = deriveTaskResult(evidence({
    events: [
      event('e1', 'assistant.completed'),
      event('e2', 'run.completed', { artifact_count: 0, stop_reason: 'end_turn' }),
    ],
    committedMessageIds: new Set(['message-assistant-e1']),
  }))

  assert.equal(result.outcome, 'unverified')
  assert.equal(result.primaryOutput?.messageId, 'message-assistant-e1')
  assert.equal(result.receipts.some(receipt => receipt.kind === 'answer' && receipt.status === 'completed'), true)
  assert.equal(result.pendingItems.some(item => item.kind === 'no_verified_deliverable'), true)
  assert.match(result.summary, /未验证/)
})

test('assistant.completed without persisted message registration is unverified', () => {
  // appendEvent 成功但 appendMessage 缺失：事件文本不作为已登记回答采信。
  const result = deriveTaskResult(evidence({
    events: [
      event('e1', 'assistant.completed'),
      event('e2', 'run.completed'),
    ],
    committedMessageIds: new Set(),
  }))

  assert.equal(result.outcome, 'unverified')
  assert.equal(result.pendingItems.some(item => item.kind === 'answer_uncommitted'), true)
  assert.equal(result.receipts.some(receipt => receipt.kind === 'answer' && receipt.status === 'missing'), true)
})

test('truncated or interrupted output keeps the result unverified', () => {
  const result = deriveTaskResult(evidence({
    events: [
      event('e1', 'assistant.completed', { output_truncated: true, interrupted: 'timeout' }),
      event('e2', 'run.completed'),
    ],
    committedMessageIds: new Set(['message-assistant-e1']),
  }))

  assert.equal(result.outcome, 'unverified')
  assert.equal(result.pendingItems.some(item => item.kind === 'output_truncated'), true)
  assert.equal(result.pendingItems.some(item => item.kind === 'output_interrupted'), true)
})

test('failed and cancelled runs project not_achieved with the structured error', () => {
  const error = {
    code: 'RUN_TIMEOUT', message: '本轮执行超时', object: '运行 run-001',
    reason: '超时', suggestion: '重新执行', retryable: true,
  }
  const failed = deriveTaskResult(evidence({
    run: { id: 'run-001', status: 'failed', updatedAt },
    events: [event('e9', 'run.failed', { error_code: 'RUN_TIMEOUT' })],
    runError: error,
  }))
  assert.equal(failed.outcome, 'not_achieved')
  assert.equal(failed.error?.code, 'RUN_TIMEOUT')

  const cancelled = deriveTaskResult(evidence({
    run: { id: 'run-001', status: 'cancelled', updatedAt },
    events: [event('e9', 'run.cancelled')],
  }))
  assert.equal(cancelled.outcome, 'not_achieved')
  assert.equal(cancelled.error, null)
})

test('tool approval records are accepted/rejected receipts, never completions', () => {
  // P2 回归：approval.resolved 在执行前写入 result=success 的审计行——
  // 授权通过不等于操作完成，decision 非空的行一律不算 completed。
  const result = deriveTaskResult(evidence({
    events: [
      event('e1', 'assistant.completed'),
      event('e2', 'run.completed'),
    ],
    committedMessageIds: new Set(['message-assistant-e1']),
    toolAudits: [
      { id: 'tal-1', toolName: 'read_file', decision: 'allow_once', result: 'success', occurredAt },
      { id: 'tal-2', toolName: 'write_erp', decision: 'reject_once', result: 'blocked', occurredAt },
      { id: 'tal-3', toolName: 'read_file', decision: null, result: 'failed', occurredAt },
      { id: 'tal-4', toolName: 'read_file', decision: null, result: 'success', occurredAt },
    ],
  }))

  const byRef = new Map(result.receipts.map(receipt => [receipt.ref, receipt.status]))
  assert.equal(byRef.get('tal-1'), 'accepted')
  assert.equal(byRef.get('tal-2'), 'rejected')
  assert.equal(byRef.get('tal-3'), 'failed')
  // 无 decision 的行是执行回执：success 才可投影为 completed。
  assert.equal(byRef.get('tal-4'), 'completed')
  const approved = result.receipts.find(receipt => receipt.ref === 'tal-1')
  assert.equal(approved?.label, '工具操作已获授权：read_file')
  // 存在被拒绝的工具动作仍是已核验的失败证据，不阻断 achieved 口径——
  // 阻断性授权拒绝会让 Run 走向 failed/not_achieved，由执行状态表达。
})

test('a granted tool approval does not stand in for a missing deliverable', () => {
  // P2 回归：仅有审批通过记录、没有回答与成果的 Run 不得视为有交付。
  const result = deriveTaskResult(evidence({
    events: [event('e2', 'run.completed')],
    toolAudits: [
      { id: 'tal-1', toolName: 'write_erp', decision: 'allow_once', result: 'success', occurredAt },
    ],
  }))

  assert.equal(result.outcome, 'unverified')
  assert.equal(result.pendingItems.some(item => item.kind === 'no_deliverable'), true)
  assert.equal(result.receipts.every(receipt => receipt.status !== 'completed'), true)
})

test('a completed tool action is a verifiable deliverable for a tool-only task', () => {
  const result = deriveTaskResult(evidence({
    events: [event('e2', 'run.completed', { tool_call_count: 1, tool_result_count: 1 })],
    toolAudits: [
      { id: 'tal-completed', toolName: 'write_erp', decision: null, result: 'success', occurredAt },
    ],
  }))

  assert.equal(result.outcome, 'achieved')
  assert.equal(result.receipts.some(receipt =>
    receipt.kind === 'tool' && receipt.status === 'completed' && receipt.ref === 'tal-completed'), true)
  assert.equal(result.pendingItems.length, 0)
})

test('the projection is deterministic and idempotent for repeated evidence', () => {
  const input = evidence({
    events: [
      event('e1', 'assistant.completed'),
      event('e2', 'run.completed', { artifact_count: 1 }),
      event('e2', 'run.completed', { artifact_count: 1 }),
    ],
    committedMessageIds: new Set(['message-assistant-e1']),
    artifacts: [artifact('artifact-1')],
  })

  const first = deriveTaskResult(input)
  const second = deriveTaskResult(input)
  assert.deepEqual(first, second)
})
