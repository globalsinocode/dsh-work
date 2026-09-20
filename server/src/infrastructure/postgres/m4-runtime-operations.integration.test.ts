import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type { JsonObject } from '../../modules/run/run-types.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let runtime: OperationalRuntime
let operations: PostgresOperationsService
let conversations: PostgresConversationRepository
let runs: PostgresRunRepository
let orchestration: RunOrchestrationService

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_runtime_test', maxConnections: 6 })
  database = throwaway.client
  runtime = new OperationalRuntime()
  const authorization = new PostgresAuthorizationService(database)
  operations = new PostgresOperationsService(database, runtime, authorization)
  const tools = new PostgresToolConnectorService(database, runtime, operations)
  const skills = new PostgresSkillService(database, operations, tools)
  const agents = new PostgresAgentService(database, operations, skills, tools)
  conversations = new PostgresConversationRepository(database)
  runs = new PostgresRunRepository(database)
  orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    undefined,
    operations,
    agents,
    undefined,
    authorization,
    // B-03/I-04：Attempt 固定的绑定修订在执行前复核真实绑定服务。
    { toolBindings: tools },
  )
})

after(async () => {
  try {
    if (database) {
      await database.begin(async transaction => {
        await transaction`
          insert into runtime_configurations (
            tenant_id, runtime_id, revision, concurrency_limit, timeout_seconds, sandbox_policy, updated_by
          ) select 'tenant-dsh-work', 'runtime-local-01', coalesce(max(revision), 0) + 1,
                   2, 300, '{"network":"deny","write":"workspace_only","approval":"risk_based"}', 'U00008'
              from runtime_configurations
             where tenant_id = 'tenant-dsh-work' and runtime_id = 'runtime-local-01'
        `
        await transaction`
          update runtimes set capacity = 2, scheduling_status = 'accepting'
           where tenant_id = 'tenant-dsh-work' and id = 'runtime-local-01'
        `
      })
    }
  } finally {
    if (orchestration) await orchestration.close()
    if (throwaway) await throwaway.dispose()
  }
})

test('Runtime configuration controls timeout, capacity and scheduling with versioned audit history', async () => {
  await assert.rejects(
    operations.updateRuntimeConfiguration({
      runtimeId: 'runtime-local-01',
      maxConcurrentWorkers: 2,
      attemptTimeoutMinutes: 2,
      schedulingStatus: 'accepting',
      actor: '林岚',
    }),
    /不是平台管理员/,
  )

  const accepting = await operations.updateRuntimeConfiguration({
    runtimeId: 'runtime-local-01',
    maxConcurrentWorkers: 2,
    attemptTimeoutMinutes: 2,
    schedulingStatus: 'accepting',
    actor: 'U00008',
  })
  assert.equal(accepting?.maxConcurrentWorkers, 2)
  assert.equal(accepting?.attemptTimeoutMinutes, 2)
  assert.equal(runtime.acceptingRuns, true)

  const policy = await operations.getRuntimePolicy('runtime-local-01')
  assert.equal(policy.timeoutSeconds, 120)
  assert.equal(policy.concurrencyLimit, 2)
  assert.equal(policy.schedulingStatus, 'accepting')

  const session = await orchestration.createSession({
    userId: 'U00001',
    title: 'Runtime 超时策略验证',
    workspaceId: 'ws-supply',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  const created = await orchestration.startRun({
    userId: 'U00001',
    sessionId: session.id,
    prompt: '验证 Runtime 超时配置进入运行清单',
    idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  await waitForRun(created.id)
  const captured = runtime.manifest(created.id)
  assert.equal(captured?.limits.timeout_seconds, 120)

  const first = await createQueuedAttempt(captured)
  const second = await createQueuedAttempt(captured)
  assert.equal(await runs.claimAttempt('tenant-dsh-work', first.attemptId, 'runtime-local-01'), true)
  assert.equal(await runs.claimAttempt('tenant-dsh-work', second.attemptId, 'runtime-local-01'), true)
  await assert.rejects(
    operations.updateRuntimeConfiguration({
      runtimeId: 'runtime-local-01',
      maxConcurrentWorkers: 1,
      attemptTimeoutMinutes: 2,
      schedulingStatus: 'accepting',
      actor: 'U00008',
    }),
    /不能小于当前活动 Worker 数/,
  )
  await completeAttempt(first)
  await completeAttempt(second)

  const draining = await operations.updateRuntimeConfiguration({
    runtimeId: 'runtime-local-01',
    maxConcurrentWorkers: 2,
    attemptTimeoutMinutes: 3,
    schedulingStatus: 'draining',
    actor: 'U00008',
  })
  assert.equal(draining?.schedulingStatus, 'draining')
  assert.equal(runtime.acceptingRuns, false)
  const queued = await createQueuedAttempt(captured)
  assert.equal(await runs.claimAttempt('tenant-dsh-work', queued.attemptId, 'runtime-local-01'), false)

  await operations.updateRuntimeConfiguration({
    runtimeId: 'runtime-local-01',
    maxConcurrentWorkers: 2,
    attemptTimeoutMinutes: 3,
    schedulingStatus: 'accepting',
    actor: 'U00008',
  })
  assert.equal(runtime.acceptingRuns, true)
  assert.equal(await runs.claimAttempt('tenant-dsh-work', queued.attemptId, 'runtime-local-01'), true)
  await completeAttempt(queued)

  const disabled = await operations.updateRuntimeConfiguration({
    runtimeId: 'runtime-local-01',
    maxConcurrentWorkers: 2,
    attemptTimeoutMinutes: 3,
    schedulingStatus: 'disabled',
    actor: 'U00008',
  })
  assert.equal(disabled?.schedulingStatus, 'disabled')
  assert.equal(runtime.acceptingRuns, false)

  const checked = await operations.checkRuntime({ runtimeId: 'runtime-local-01', actor: 'U00008' })
  assert.equal(checked?.status, 'healthy')
  const [history] = await database<{ revisions: number; audits: number }[]>`
    select
      (select count(*)::integer from runtime_configurations
        where tenant_id = 'tenant-dsh-work' and runtime_id = 'runtime-local-01') as revisions,
      (select count(*)::integer from audit_events
        where tenant_id = 'tenant-dsh-work' and action like 'runtime.%') as audits
  `
  assert.ok((history?.revisions ?? 0) >= 5)
  assert.ok((history?.audits ?? 0) >= 5)
})

async function createQueuedAttempt(source: RuntimeManifest | undefined) {
  if (!source) throw new Error('缺少已捕获的 Runtime Manifest')
  const session = await conversations.createSession({
    userId: 'U00001',
    title: 'Runtime 调度队列验证',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: session.id,
    requestedBy: 'U00001',
    idempotencyKey: randomUUID(),
  })
  const attemptId = `attempt-runtime-ops-${randomUUID()}`
  await runs.createAttempt({
    attemptId,
    tenantId: 'tenant-dsh-work',
    runId: run.id,
    runtimeId: 'runtime-local-01',
    manifest: JSON.parse(JSON.stringify({ ...source, run_id: run.id, attempt_id: attemptId })) as JsonObject,
    manifestSha256: randomUUID().replaceAll('-', ''),
    modelRouteSnapshot: {},
  })
  return { runId: run.id, attemptId }
}

async function completeAttempt(input: { runId: string; attemptId: string }) {
  await runs.transitionAttempt('tenant-dsh-work', input.attemptId, 'succeeded')
  await runs.transitionRun('tenant-dsh-work', input.runId, 'succeeded')
}

async function waitForRun(runId: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, 'U00001')
    if (task?.status === 'succeeded') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等待 Runtime 运维测试 Run 完成超时')
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  done: Promise<RuntimeExecutionSnapshot>
  resolveDone: (snapshot: RuntimeExecutionSnapshot) => void
}

class OperationalRuntime implements AgentRuntimePort {
  readonly executions = new Map<string, Execution>()
  acceptingRuns = true

  async configureScheduling(status: 'accepting' | 'draining' | 'disabled') {
    this.acceptingRuns = status === 'accepting'
  }

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
      manifestSha256: 'runtime-operations-test',
      attemptDirectory: '/tmp/runtime-operations-test',
      errorCode: null,
      errorMessage: null,
    }
    const execution = { manifest, events: [], listeners: new Set<RuntimeEventListener>(), snapshot, done, resolveDone }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '已进入 Runtime 队列')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', 'Runtime 开始执行')
      this.emit(execution, 'assistant.completed', 'Runtime 运维策略验证完成。')
      execution.snapshot.status = 'completed'
      execution.snapshot.endedAt = new Date().toISOString()
      this.emit(execution, 'run.completed', 'Runtime 执行完成')
      execution.resolveDone(structuredClone(execution.snapshot))
    }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('Run not found')
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => execution.listeners.delete(listener)
  }

  async cancel() { return { accepted: false } }
  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() {
    return {
      status: 'healthy' as const,
      runtimeId: 'runtime-local-01',
      activeExecutions: [...this.executions.values()].filter(item => item.snapshot.status === 'running').length,
      acceptingRuns: this.acceptingRuns,
      dshRepository: '/tmp',
      transport: 'acp-stdio' as const,
      message: this.acceptingRuns ? '测试 Runtime 正在接收任务' : '测试 Runtime 已暂停接收任务',
    }
  }
  async close() { this.acceptingRuns = false }
  manifest(runId: string) { return this.executions.get(runId)?.manifest }

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], displayMessage: string) {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: execution.manifest.run_id,
      attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      display_message: displayMessage,
      safe_metadata: {},
      trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => listener(event))
  }
}
