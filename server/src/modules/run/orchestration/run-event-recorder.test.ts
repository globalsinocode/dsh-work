import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RuntimeEvent } from '../../runtime/runtime-types.ts'
import type { RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { OrchestrationDependencies } from './orchestration-dependencies.ts'
import { RunEventRecorder } from './run-event-recorder.ts'

const run: RunRecord = {
  id: 'run-1', tenantId: 'tenant-dsh-work', taskId: 'task-1', sessionId: 'session-1', requestedBy: 'U00001',
  idempotencyKey: 'key-1', status: 'running', currentAttemptId: 'attempt-1',
  createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z',
}

/** 未列出的依赖方法一律是无操作的异步函数。 */
function permissive<T extends object>(overrides: Partial<Record<string, unknown>> = {}): T {
  return new Proxy(overrides, {
    get: (target, key) => key in target ? target[key as string] : async () => undefined,
  }) as T
}

function event(sequence: number, eventType: string, displayMessage = ''): RuntimeEvent {
  return {
    event_id: `event-${sequence}`, run_id: run.id, attempt_id: 'attempt-1', sequence, event_type: eventType,
    display_message: displayMessage, safe_metadata: {}, trace_id: 'trace-1', occurred_at: '2026-10-17T00:00:00.000Z',
  } as RuntimeEvent
}

test('任务线程的成果交给档案员时不带平台追加的知识与记忆引用页脚（人工验收 6.2）', async () => {
  const archived: string[] = []
  const messages: string[] = []
  const deps = permissive<OrchestrationDependencies>({
    runs: permissive({
      getRun: async () => run,
      getAttempt: async () => ({ id: 'attempt-1', status: 'running' }),
    }),
    conversations: permissive({
      appendMessage: async (input: { content: string }) => { messages.push(input.content) },
      getRunPrompt: async () => '分析缺货原因',
    }),
    knowledge: permissive({ addCitationFooter: async (_attempt: string, answer: string) => `${answer}\n\n知识引用\n- 【K1】库存口径` }),
    memory: permissive({ addCitationFooter: async (_attempt: string, answer: string) => `${answer}\n\n受控记忆参考（非权威业务事实）\n- 【M1】经验 v1（组织范围）` }),
    operations: undefined,
    sessionSummaries: undefined,
    persistentWait: undefined,
    projectArchivist: permissive({ afterTaskRun: async (_run: RunRecord, output: string) => { archived.push(output) } }),
  })
  const recorder = new RunEventRecorder(deps, permissive<AttemptBudget>())

  recorder.record(run, event(1, 'assistant.completed', '缺货集中在饮料类目。'))
  recorder.record(run, event(2, 'run.completed'))
  await recorder.flush(run.id)

  assert.match(messages[0]!, /受控记忆参考/, '读者看到的回复仍带引用页脚')
  assert.match(messages[0]!, /知识引用/)
  assert.deepEqual(archived, ['缺货集中在饮料类目。'])
})

test('迟到的终态事件标记为 late 落库，不改变 Run 状态也不写回复（P1-8）', async () => {
  const stored: Array<{ eventType: string; safeMetadata: Record<string, unknown> }> = []
  const transitions: string[] = []
  const messages: string[] = []
  const deps = permissive<OrchestrationDependencies>({
    runs: permissive({
      getRun: async () => ({ ...run, status: 'failed' }),
      getAttempt: async () => ({ id: 'attempt-1', status: 'failed' }),
      appendEvent: async (input: { id: string; eventType: string; safeMetadata: Record<string, unknown> }) => { stored.push(input); return input },
      transitionAttempt: async (_tenant: string, _id: string, to: string) => { transitions.push(`attempt:${to}`) },
      transitionRun: async (_tenant: string, _id: string, to: string) => { transitions.push(`run:${to}`) },
      markEventLate: async () => { throw new Error('已在写入时标记，不应再补标') },
    }),
    conversations: permissive({ appendMessage: async (input: { content: string }) => { messages.push(input.content) } }),
    operations: undefined,
    sessionSummaries: undefined,
    persistentWait: undefined,
  })
  const recorder = new RunEventRecorder(deps, permissive<AttemptBudget>())

  recorder.record(run, event(1, 'tool.started'))
  recorder.record(run, event(2, 'assistant.completed', '迟到的回答'))
  recorder.record(run, event(3, 'run.completed'))
  await recorder.flush(run.id)

  assert.deepEqual(stored.map(item => [item.eventType, item.safeMetadata['late'] === true]), [
    ['tool.started', false], ['assistant.completed', true], ['run.completed', true],
  ])
  assert.deepEqual(transitions, [])
  assert.deepEqual(messages, [])
})

test('写入期间 Attempt 被平台结束时补标 late（P1-8）', async () => {
  let attemptStatus = 'running'
  const marked: string[] = []
  const transitions: string[] = []
  const deps = permissive<OrchestrationDependencies>({
    runs: permissive({
      getRun: async () => run,
      getAttempt: async () => ({ id: 'attempt-1', status: attemptStatus }),
      appendEvent: async (input: { id: string }) => { attemptStatus = 'cancelled'; return input },
      markEventLate: async (_tenant: string, eventId: string) => { marked.push(eventId) },
      transitionAttempt: async (_tenant: string, _id: string, to: string) => { transitions.push(`attempt:${to}`) },
      transitionRun: async (_tenant: string, _id: string, to: string) => { transitions.push(`run:${to}`) },
    }),
    operations: undefined,
    sessionSummaries: undefined,
    persistentWait: undefined,
  })
  const recorder = new RunEventRecorder(deps, permissive<AttemptBudget>())

  recorder.record(run, event(1, 'run.completed'))
  await recorder.flush(run.id)

  assert.deepEqual(marked, ['event-1'])
  assert.deepEqual(transitions, [])
})

test('MR-S3：网关计量同时交给预算与用量；取消的运行有网关记录时也记用量，汇总失败时退回原计量', async () => {
  const line = {
    endpoint: 'chat' as const, providerKey: 'deepseek-official', modelKey: 'deepseek-v4-pro', requests: 2, failedRequests: 0,
    succeededRequests: 2, usageReported: true, inputTokens: 500, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: null,
  }
  const usage: Array<{ status: string; gatewayUsage?: unknown }> = []
  const settled: unknown[] = []
  let meterFails = false
  const afterCancelFlags: unknown[] = []
  const deps = permissive<OrchestrationDependencies>({
    runs: permissive({
      getRun: async () => run,
      getAttempt: async () => ({ id: 'attempt-1', status: 'running' }),
    }),
    conversations: permissive({ getRunPrompt: async () => '提示' }),
    operations: permissive({ recordModelUsage: async (input: { status: string; gatewayUsage?: unknown }) => { usage.push(input) } }),
    modelUsage: { summarizeAttempt: async (_tenant: string, _attempt: string, options?: { afterCancel?: boolean }) => {
      afterCancelFlags.push(options?.afterCancel)
      if (meterFails) throw new Error('数据库不可用')
      return [line]
    } },
    sessionSummaries: undefined,
    persistentWait: undefined,
    projectArchivist: undefined,
  })
  const budget = permissive<AttemptBudget>({ settle: async (...args: unknown[]) => { settled.push(args[3]) } })
  const recorder = new RunEventRecorder(deps, budget)

  recorder.record(run, event(1, 'run.cancelled'))
  await recorder.flush(run.id)
  assert.deepEqual(usage.map(item => [item.status, item.gatewayUsage]), [['cancelled', [line]]])
  assert.deepEqual(settled, [[line]], '预算用同一组网关数字')
  assert.deepEqual(afterCancelFlags, [true], '取消时请计量方等待被中止请求的记录')

  meterFails = true
  recorder.record(run, event(2, 'run.completed'))
  await recorder.flush(run.id)
  assert.deepEqual(usage.at(-1)?.gatewayUsage, [], '汇总失败不影响收尾，按会话日志或估算记录')
})

test('MR-S3：有请求成功却都没带回用量时退回会话日志或估算；全部失败时按网关记 0', async () => {
  const usage: Array<{ gatewayUsage?: unknown }> = []
  let lines: unknown[] = []
  const deps = permissive<OrchestrationDependencies>({
    runs: permissive({ getRun: async () => run, getAttempt: async () => ({ id: 'attempt-1', status: 'running' }) }),
    conversations: permissive({ getRunPrompt: async () => '提示' }),
    operations: permissive({ recordModelUsage: async (input: { gatewayUsage?: unknown }) => { usage.push(input) } }),
    modelUsage: { summarizeAttempt: async () => lines },
    sessionSummaries: undefined,
    persistentWait: undefined,
    projectArchivist: undefined,
  })
  const recorder = new RunEventRecorder(deps, permissive<AttemptBudget>())
  const base = { endpoint: 'chat', providerKey: 'p', modelKey: 'm', cacheReadTokens: null, cacheWriteTokens: null, inputTokens: 0, outputTokens: 0 }

  lines = [{ ...base, requests: 1, failedRequests: 0, succeededRequests: 1, usageReported: false }]
  recorder.record(run, event(1, 'run.completed'))
  await recorder.flush(run.id)
  assert.deepEqual(usage.at(-1)?.gatewayUsage, [])

  lines = [{ ...base, requests: 3, failedRequests: 3, succeededRequests: 0, usageReported: false }]
  recorder.record(run, event(2, 'run.failed'))
  await recorder.flush(run.id)
  assert.deepEqual(usage.at(-1)?.gatewayUsage, lines)
})
