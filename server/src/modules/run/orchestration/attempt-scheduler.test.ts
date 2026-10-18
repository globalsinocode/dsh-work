import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import type { RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { OrchestrationDependencies } from './orchestration-dependencies.ts'
import { AttemptScheduler } from './attempt-scheduler.ts'
import { ExecutionAuthorizationGate } from './execution-authorization-gate.ts'
import { RunEventRecorder } from './run-event-recorder.ts'

/** 未列出的依赖方法一律是无操作的异步函数。 */
function permissive<T extends object>(overrides: Partial<Record<string, unknown>> = {}): T {
  return new Proxy(overrides, {
    get: (target, key) => key in target ? target[key as string] : async () => undefined,
  }) as T
}

const run: RunRecord = {
  id: 'run-summary-1', tenantId: 'tenant-dsh-work', taskId: 'task-1', sessionId: null, requestedBy: 'U00001',
  idempotencyKey: 'key-1', status: 'queued', currentAttemptId: 'attempt-1',
  createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z',
}

const manifest: RuntimeManifest = {
  manifest_version: '1.0',
  purpose: 'session-summary',
  summary_target: { session_id: 'session-1', covered_through_message_id: 'message-1' },
  run_id: run.id,
  attempt_id: 'attempt-1',
  task_id: run.taskId,
  session_id: null,
  workspace_id: '',
  agent_version_id: null,
  agent_configuration: { system_prompt: '摘要', skill_instructions: [] },
  user_context: { user_id: run.requestedBy, tenant_id: run.tenantId, role_ids: [] },
  permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'deny' },
  skills: [],
  tools: [],
  data_scopes: [],
  knowledge_context: [],
  input: { message: '生成摘要', file_mounts: [] },
  budget: {
    scope_task_id: 'task-1',
    cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
    reservation: { duration_ms: 0, tool_calls: 0, output_bytes: 0 },
    enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
  },
  limits: { timeout_seconds: 120, max_output_bytes: 32768, max_tool_calls: 0 },
  created_at: '2026-10-18T00:00:00.000Z',
  trace_id: 'trace-summary-1',
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${message}`)
}

test('后台车道容量不足：以 BACKGROUND_CAPACITY_EXHAUSTED 收敛并立即结束系统运行（P2-4）', async () => {
  const transitions: string[] = []
  const events: Array<{ displayMessage: string; safeMetadata: Record<string, unknown> }> = []
  const finalized: string[] = []
  const deps = permissive<OrchestrationDependencies>({
    runs: permissive({
      claimAttempt: async () => false,
      getAttempt: async () => ({ id: 'attempt-1', status: 'queued' }),
      getRun: async () => ({ ...run, status: 'queued' }),
      backgroundLaneUsage: async () => ({ allowed: 0, running: 0, exists: true, accepting: true, backgroundFull: false }),
      transitionAttempt: async (_tenant: string, _id: string, status: string, errorCode?: string) => {
        transitions.push(`attempt:${status}:${errorCode}`)
      },
      transitionRun: async (_tenant: string, _id: string, status: string) => { transitions.push(`run:${status}`) },
      appendSystemEvent: async (input: { displayMessage: string; safeMetadata: Record<string, unknown> }) => {
        events.push(input)
      },
    }),
    projectArchivist: permissive({
      onRunTerminal: async () => { finalized.push('archivist'); return true },
    }),
    sessionSummaries: permissive({
      onRunTerminal: async () => { finalized.push('summary'); return true },
    }),
    runtime: permissive({}),
    automationMaxConcurrent: 2,
    timezone: 'Asia/Shanghai',
  })
  const scheduler = new AttemptScheduler(deps, new ExecutionAuthorizationGate(deps), new RunEventRecorder(deps, permissive<AttemptBudget>()))
  try {
    scheduler.enqueue(run, manifest)
    await waitFor(() => transitions.length >= 2 && finalized.length > 0, '容量失败收敛')
  } finally {
    await scheduler.close()
  }

  assert.deepEqual(transitions, ['attempt:failed:BACKGROUND_CAPACITY_EXHAUSTED', 'run:failed'])
  assert.equal(events.length, 1)
  assert.equal(events[0]?.safeMetadata['error_code'], 'BACKGROUND_CAPACITY_EXHAUSTED')
  assert.match(events[0]?.displayMessage ?? '', /容量不足以在保留交互余量的同时生成摘要/)
  assert.deepEqual(finalized, ['archivist'], '无 Session 的系统运行直接交给对应的终结入口')
})

test('后台车道容量不足不额外终结有 Session 的验证运行（P2-4）', async () => {
  const transitions: string[] = []
  const finalized: string[] = []
  const deps = permissive<OrchestrationDependencies>({
    runs: permissive({
      claimAttempt: async () => false,
      getAttempt: async () => ({ id: 'attempt-1', status: 'queued' }),
      getRun: async () => ({ ...run, sessionId: 'validation-session', status: 'queued' }),
      backgroundLaneUsage: async () => ({ allowed: 0, running: 0, exists: true, accepting: true, backgroundFull: false }),
      transitionAttempt: async () => { transitions.push('attempt') },
      transitionRun: async () => { transitions.push('run') },
      appendSystemEvent: async () => undefined,
    }),
    projectArchivist: permissive({ onRunTerminal: async () => { finalized.push('archivist'); return true } }),
    sessionSummaries: permissive({ onRunTerminal: async () => { finalized.push('summary'); return true } }),
    runtime: permissive({}),
    automationMaxConcurrent: 2,
    timezone: 'Asia/Shanghai',
  })
  const trialRun: RunRecord = { ...run, sessionId: 'validation-session' }
  const trialManifest: RuntimeManifest = { ...manifest, purpose: 'agent-release-trial', summary_target: undefined }
  const scheduler = new AttemptScheduler(deps, new ExecutionAuthorizationGate(deps), new RunEventRecorder(deps, permissive<AttemptBudget>()))
  try {
    scheduler.enqueue(trialRun, trialManifest)
    await waitFor(() => transitions.length >= 2, '验证运行容量失败收敛')
    // 终结器是异步调用；给调度器一个拍确认没有额外调用。
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    await scheduler.close()
  }
  assert.deepEqual(transitions, ['attempt', 'run'])
  assert.deepEqual(finalized, [], '验证运行由案例轮询收敛，不由系统终结器处理')
})
