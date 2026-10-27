import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
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
import { bindTestWorkspaceNotificationRecipients } from './workspace-notification-recipient-test-fixture.ts'

let throwaway: ThrowawayDatabase
let unbindNotificationRecipients: (() => void) | undefined

interface CapacityResult {
  scenario: string
  runs: number
  configuredConcurrency: number
  peakActive: number
  peakQueued: number
  acceptanceP95Ms: number
  completionP95Ms: number
  wallMs: number
  throughputRunsPerSecond: number
  failureRate: number
  cpuPercent: number
  rssPeakMiB: number
  diskBytes: number
}

let database: DatabaseClient
let runs: PostgresRunRepository
let conversations: PostgresConversationRepository
let models: ModelGovernanceService
const runtimeRoots: string[] = []

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据影响容量基线。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m5_capacity_test', maxConnections: 16 })
  database = throwaway.client
  unbindNotificationRecipients = bindTestWorkspaceNotificationRecipients(database)
  runs = new PostgresRunRepository(database)
  conversations = new PostgresConversationRepository(database)
  models = new ModelGovernanceService(new PostgresModelGovernanceRepository(database))
})

after(async () => {
  unbindNotificationRecipients?.()
  unbindNotificationRecipients = undefined
  await throwaway.dispose()
  await Promise.all(runtimeRoots.map(root => rm(root, { recursive: true, force: true })))
})

test('PostgreSQL scheduler enforces 1, 3 and 5 concurrent Run limits', async () => {
  const results: CapacityResult[] = []
  for (const concurrency of [1, 3, 5]) {
    results.push(await runCapacityScenario({
      scenario: `concurrency-${concurrency}`,
      concurrency,
      runCount: concurrency,
      expectedQueued: 0,
    }))
  }

  assert.deepEqual(results.map(result => result.peakActive), [1, 3, 5])
  assert.ok(results.every(result => result.failureRate === 0))
  assert.ok(results.every(result => result.acceptanceP95Ms < 2000))
  console.log(`M5_CAPACITY_RESULT ${JSON.stringify(results)}`)
})

test('50 Run burst keeps five active, queues the remainder and drains without loss', async () => {
  const result = await runCapacityScenario({
    scenario: 'queue-50',
    concurrency: 5,
    runCount: 50,
    expectedQueued: 45,
  })

  assert.equal(result.peakActive, 5)
  assert.equal(result.peakQueued, 45)
  assert.equal(result.failureRate, 0)
  assert.ok(result.acceptanceP95Ms < 3000)
  assert.ok(result.wallMs < 30_000)
  console.log(`M5_CAPACITY_RESULT ${JSON.stringify([result])}`)
})

async function runCapacityScenario(input: {
  scenario: string
  concurrency: number
  runCount: number
  expectedQueued: number
}): Promise<CapacityResult> {
  await database`
    update runtimes
       set capacity = ${input.concurrency}, scheduling_status = 'accepting'
     where tenant_id = 'tenant-dsh-work' and id = 'runtime-local-01'
  `
  const runtimeRoot = await mkdtemp(join(tmpdir(), `dsh-work-m5-capacity-${input.scenario}-`))
  runtimeRoots.push(runtimeRoot)
  const runtime = new InstrumentedCapacityRuntime(runtimeRoot)
  const orchestration = new RunOrchestrationService(runs, conversations, models, runtime)
  const session = await orchestration.createSession({
    userId: 'U00001',
    title: `M5 容量测试 ${input.scenario}`,
  })

  const startedAt = performance.now()
  const cpuStarted = process.cpuUsage()
  let rssPeak = process.memoryUsage().rss
  const memorySampler = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
  }, 5)
  const acceptanceLatencies: number[] = []
  const completionStarted = new Map<string, number>()
  const created = await Promise.all(Array.from({ length: input.runCount }, async (_value, index) => {
    const acceptedAt = performance.now()
    const run = await orchestration.startRun({
      userId: 'U00001',
      sessionId: session.id,
      prompt: `容量场景 ${input.scenario}，任务 ${index + 1}`,
      idempotencyKey: randomUUID(),
    })
    if (!run) throw new Error('容量测试 Run 创建失败')
    acceptanceLatencies.push(performance.now() - acceptedAt)
    completionStarted.set(run.id, acceptedAt)
    return run
  }))

  await waitForActive(runtime, input.concurrency)
  const [state] = await database<{ active: number; queued: number }[]>`
    select count(*) filter (where a.status = 'running')::integer as active,
           count(*) filter (where a.status = 'queued')::integer as queued
      from run_attempts a
      join runs r on r.tenant_id = a.tenant_id and r.id = a.run_id
     where a.tenant_id = 'tenant-dsh-work' and a.runtime_id = 'runtime-local-01'
       and r.session_id = ${session.id}
  `
  assert.equal(state?.active, input.concurrency)
  assert.equal(state?.queued, input.expectedQueued)
  runtime.release()

  const completionLatencies: number[] = []
  let failures = 0
  await Promise.all(created.map(async run => {
    const status = await waitForTerminal(run.id)
    completionLatencies.push(performance.now() - (completionStarted.get(run.id) ?? startedAt))
    if (status !== 'succeeded') failures += 1
  }))
  clearInterval(memorySampler)
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
  const wallMs = performance.now() - startedAt
  const cpu = process.cpuUsage(cpuStarted)
  await orchestration.close()

  assert.ok(runtime.peakActive <= input.concurrency)
  assert.equal(runtime.active, 0)
  return {
    scenario: input.scenario,
    runs: input.runCount,
    configuredConcurrency: input.concurrency,
    peakActive: runtime.peakActive,
    peakQueued: state?.queued ?? 0,
    acceptanceP95Ms: round(percentile(acceptanceLatencies, 0.95)),
    completionP95Ms: round(percentile(completionLatencies, 0.95)),
    wallMs: round(wallMs),
    throughputRunsPerSecond: round(input.runCount / (wallMs / 1000)),
    failureRate: failures / input.runCount,
    cpuPercent: round(((cpu.user + cpu.system) / 1000 / wallMs) * 100),
    rssPeakMiB: round(rssPeak / 1024 / 1024),
    diskBytes: runtime.diskBytesWritten,
  }
}

async function waitForActive(runtime: InstrumentedCapacityRuntime, expected: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (runtime.active === expected) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`等待活动 Worker 达到 ${expected} 超时，当前 ${runtime.active}`)
}

async function waitForTerminal(runId: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const run = await runs.getRun('tenant-dsh-work', runId)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run.status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待容量测试 Run ${runId} 完成超时`)
}

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  done: Promise<RuntimeExecutionSnapshot>
  resolve: (snapshot: RuntimeExecutionSnapshot) => void
}

class InstrumentedCapacityRuntime implements AgentRuntimePort {
  active = 0
  peakActive = 0
  diskBytesWritten = 0
  private holding = true
  private readonly executions = new Map<string, Execution>()
  private readonly runtimeRoot: string

  constructor(runtimeRoot: string) {
    this.runtimeRoot = runtimeRoot
  }

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const attemptDirectory = join(this.runtimeRoot, manifest.attempt_id)
    await mkdir(attemptDirectory, { recursive: true })
    const serialized = JSON.stringify(manifest)
    await writeFile(join(attemptDirectory, 'manifest.json'), serialized)
    this.diskBytesWritten += Buffer.byteLength(serialized)
    const execution: Execution = {
      manifest,
      events: [],
      listeners: new Set(),
      snapshot: {
        runId: manifest.run_id,
        attemptId: manifest.attempt_id,
        status: 'running',
        acceptedAt: now,
        startedAt: now,
        endedAt: null,
        manifestSha256: 'm5-capacity',
        attemptDirectory,
        errorCode: null,
        errorMessage: null,
      },
      done,
      resolve: resolveDone,
    }
    this.executions.set(manifest.run_id, execution)
    this.active += 1
    this.peakActive = Math.max(this.peakActive, this.active)
    this.emit(execution, 'run.queued', '容量测试任务已排队')
    this.emit(execution, 'run.started', '容量测试 Worker 已启动')
    if (!this.holding) setTimeout(() => { this.finish(execution) }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error(`Run not found: ${runId}`)
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => { execution.listeners.delete(listener) }
  }

  release() {
    this.holding = false
    for (const execution of this.executions.values()) {
      if (!execution.snapshot.endedAt) setTimeout(() => { this.finish(execution) }, 10)
    }
  }

  async cancel() { return { accepted: false } }
  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() {
    return {
      status: 'healthy' as const,
      runtimeId: 'runtime-local-01',
      activeExecutions: this.active,
      acceptingRuns: true,
      dshRepository: this.runtimeRoot,
      transport: 'acp-stdio' as const,
      message: 'M5 capacity test runtime',
    }
  }
  async close() {
    this.release()
    await Promise.all([...this.executions.values()].map(execution => execution.done))
  }

  private finish(execution: Execution) {
    if (execution.snapshot.endedAt) return
    this.emit(execution, 'assistant.completed', '容量测试完成')
    this.emit(execution, 'run.completed', '容量测试执行完成', {
      input_tokens: 16,
      output_tokens: 4,
    })
    execution.snapshot.status = 'completed'
    execution.snapshot.endedAt = new Date().toISOString()
    this.active -= 1
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
