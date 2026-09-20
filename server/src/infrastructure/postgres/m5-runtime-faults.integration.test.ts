import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type { JsonObject, RunRecord, StoredRunEvent } from '../../modules/run/run-types.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

let throwaway: ThrowawayDatabase

let database: DatabaseClient
let runs: PostgresRunRepository
let conversations: PostgresConversationRepository
let models: ModelGovernanceService

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据干扰断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m5_faults_test', maxConnections: 6 })
  database = throwaway.client
  runs = new PostgresRunRepository(database)
  conversations = new PostgresConversationRepository(database)
  models = new ModelGovernanceService(new PostgresModelGovernanceRepository(database))
})

after(async () => {
  await throwaway.dispose()
})

test('service restart fails orphaned active Attempts, resumes queued work and preserves the event cursor', async () => {
  const session = await conversations.createSession({ userId: 'U00001', title: 'M5 服务重启恢复' })
  const interrupted = await createPersistedAttempt(session.id, 'running')
  const cursorEvent: StoredRunEvent = {
    id: `event-before-restart-${randomUUID()}`,
    tenantId: 'tenant-dsh-work',
    runId: interrupted.run.id,
    attemptId: interrupted.attemptId,
    sequence: 1,
    eventType: 'run.started',
    displayMessage: 'Worker 已启动',
    safeMetadata: {},
    traceId: `trace-${interrupted.run.id}`,
    occurredAt: new Date().toISOString(),
  }
  await runs.appendEvent(cursorEvent)
  const queued = await createPersistedAttempt(session.id, 'queued')

  const runtime = new FaultInjectionRuntime()
  const orchestration = new RunOrchestrationService(runs, conversations, models, runtime)
  try {
    const result = await orchestration.recoverAfterServiceRestart()
    assert.deepEqual(result, { failed: 1, resumedQueued: 1 })

    const failedAttempt = await runs.getAttempt('tenant-dsh-work', interrupted.attemptId)
    assert.equal(failedAttempt?.status, 'failed')
    assert.equal(failedAttempt?.errorCode, 'SERVICE_RESTARTED')
    const failedTask = await conversations.getTask(interrupted.run.id, 'U00001')
    assert.equal(failedTask?.status, 'failed')
    assert.equal(failedTask?.result.error?.code, 'SERVICE_RESTARTED')

    const resumedEvents = await runs.readEventsAfterEvent(
      'tenant-dsh-work',
      interrupted.run.id,
      cursorEvent.id,
    )
    assert.deepEqual(resumedEvents.map(event => event.eventType), ['run.failed'])
    assert.equal(resumedEvents[0]?.safeMetadata['error_code'], 'SERVICE_RESTARTED')

    await waitForRun(queued.run.id, 'succeeded')
    assert.equal(runtime.executedAttemptIds.includes(queued.attemptId), true)
  } finally {
    await orchestration.close()
  }
})

test('model, Tool timeout and network failures retain actionable error codes in PostgreSQL', async () => {
  const runtime = new FaultInjectionRuntime()
  const orchestration = new RunOrchestrationService(runs, conversations, models, runtime)
  try {
    const scenarios = [
      ['[model-failure] 验证模型失败', 'MODEL_INVOCATION_FAILED'],
      ['[tool-timeout] 验证 Tool 超时', 'TOOL_TIMEOUT'],
      ['[network-failure] 验证断网', 'NETWORK_UNAVAILABLE'],
    ] as const

    for (const [prompt, errorCode] of scenarios) {
      const session = await orchestration.createSession({ userId: 'U00001', title: `M5 ${errorCode}` })
      const run = await orchestration.startRun({
        userId: 'U00001',
        sessionId: session.id,
        prompt,
        idempotencyKey: randomUUID(),
      })
      assert.ok(run)
      const task = await waitForRun(run.id, 'failed')
      assert.equal(task.result.error?.code, errorCode)
      assert.equal(task.result.error?.retryable, true)
      const events = await runs.readEventsAfterEvent('tenant-dsh-work', run.id)
      assert.equal(events.at(-1)?.eventType, 'run.failed')
      assert.equal(events.at(-1)?.safeMetadata['error_code'], errorCode)
    }
  } finally {
    await orchestration.close()
  }
})

async function createPersistedAttempt(sessionId: string, status: 'queued' | 'running') {
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId,
    requestedBy: 'U00001',
    idempotencyKey: randomUUID(),
  })
  const attemptId = `attempt-m5-fault-${randomUUID()}`
  const manifest = runtimeManifest(run, attemptId, `恢复 ${status} Attempt`)
  await runs.createAttempt({
    attemptId,
    tenantId: 'tenant-dsh-work',
    runId: run.id,
    runtimeId: 'runtime-local-01',
    manifest: JSON.parse(JSON.stringify(manifest)) as JsonObject,
    manifestSha256: randomUUID().replaceAll('-', ''),
    modelRouteSnapshot: { routeId: 'dsh-default' },
  })
  if (status === 'running') {
    assert.equal(await runs.claimAttempt('tenant-dsh-work', attemptId, 'runtime-local-01'), true)
  }
  const currentRun = await runs.getRun('tenant-dsh-work', run.id)
  assert.ok(currentRun)
  return { run: currentRun, attemptId }
}

async function waitForRun(runId: string, expected: 'succeeded' | 'failed') {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, 'U00001')
    if (task?.status === expected) return task
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`等待 Run ${runId} 进入 ${expected} 超时`)
}

function runtimeManifest(run: RunRecord, attemptId: string, message: string): RuntimeManifest {
  return {
    manifest_version: '1.0',
    run_id: run.id,
    attempt_id: attemptId,
    session_id: run.sessionId,
    workspace_id: 'ws-personal-U00001',
    agent_version_id: 'agent-version-dsh-work-assistant-1',
    agent_configuration: { system_prompt: 'M5 故障注入测试', skill_instructions: [] },
    user_context: { user_id: 'U00001', tenant_id: 'tenant-dsh-work', role_ids: ['role-employee'] },
    permission_policy: { approval_mode: 'risk_based', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [],
    tools: [],
    data_scopes: ['enterprise:authorized'],
    knowledge_context: [],
    model_route_id: 'dsh-default',
    input: { message, file_mounts: [] },
    limits: { timeout_seconds: 30, max_output_bytes: 64 * 1024, max_tool_calls: 10 },
    created_at: new Date().toISOString(),
    trace_id: `trace-${run.id}-${attemptId}`,
  }
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  done: Promise<RuntimeExecutionSnapshot>
  resolve: (snapshot: RuntimeExecutionSnapshot) => void
}

class FaultInjectionRuntime implements AgentRuntimePort {
  readonly executedAttemptIds: string[] = []
  private readonly executions = new Map<string, Execution>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      status: 'queued',
      acceptedAt: now,
      startedAt: null,
      endedAt: null,
      manifestSha256: 'm5-fault-test',
      attemptDirectory: '/tmp/dsh-work-m5-fault-test',
      errorCode: null,
      errorMessage: null,
    }
    const execution = { manifest, events: [], listeners: new Set<RuntimeEventListener>(), snapshot, done, resolve: resolveDone }
    this.executions.set(manifest.run_id, execution)
    this.executedAttemptIds.push(manifest.attempt_id)
    this.emit(execution, 'run.queued', '已恢复到 Runtime 队列')
    setTimeout(() => { this.complete(execution) }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error(`Run not found: ${runId}`)
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => { execution.listeners.delete(listener) }
  }

  async cancel() { return { accepted: false } }
  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() {
    return {
      status: 'healthy' as const,
      runtimeId: 'runtime-local-01',
      activeExecutions: 0,
      acceptingRuns: true,
      dshRepository: '/tmp',
      transport: 'acp-stdio' as const,
      message: 'M5 fault test',
    }
  }
  async close() { return undefined }

  private complete(execution: Execution) {
    execution.snapshot.status = 'running'
    execution.snapshot.startedAt = new Date().toISOString()
    this.emit(execution, 'run.started', 'Worker 已启动')
    const failure = faultCode(execution.manifest.input.message)
    if (failure) {
      execution.snapshot.status = 'failed'
      execution.snapshot.errorCode = failure
      execution.snapshot.errorMessage = failure
      this.emit(execution, 'run.failed', '故障注入执行失败', { error_code: failure })
    } else {
      this.emit(execution, 'assistant.completed', '排队任务已在重启后恢复执行')
      execution.snapshot.status = 'completed'
      this.emit(execution, 'run.completed', '执行完成')
    }
    execution.snapshot.endedAt = new Date().toISOString()
    execution.resolve(structuredClone(execution.snapshot))
  }

  private emit(
    execution: Execution,
    eventType: RuntimeEvent['event_type'],
    displayMessage: string,
    safeMetadata: Record<string, unknown> = {},
  ) {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: execution.manifest.run_id,
      attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      display_message: displayMessage,
      safe_metadata: safeMetadata,
      trace_id: execution.manifest.trace_id ?? execution.manifest.run_id,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => { listener(event) })
  }
}

function faultCode(message: string) {
  if (message.includes('[model-failure]')) return 'MODEL_INVOCATION_FAILED'
  if (message.includes('[tool-timeout]')) return 'TOOL_TIMEOUT'
  if (message.includes('[network-failure]')) return 'NETWORK_UNAVAILABLE'
  return null
}
