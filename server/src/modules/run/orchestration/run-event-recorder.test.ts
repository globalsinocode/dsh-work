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
