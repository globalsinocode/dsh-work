import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { runMigrations } from './migration-runner.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type { JsonObject } from '../../modules/run/run-types.ts'
import {
  PostgresTaskRepository,
  TaskContractConflictError,
  taskOperationParameterDigest,
} from '../../modules/task/postgres-task-repository.ts'
import { TaskBudgetExceededError, TaskBudgetUnsupportedError } from '../../modules/task/task-budget-types.ts'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let runs: PostgresRunRepository
let tasks: PostgresTaskRepository
const suffix = randomUUID()
const agentId = `agent-m2-${suffix}`
const agentVersionId = `agent-version-m2-${suffix}`
const sessionId = `session-m2-${suffix}`

before(async () => {
  // 一次性库：共享 dev 库的历史累积会让 run/事件断言互相干扰。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m2_repositories_test', maxConnections: 4 })
  database = throwaway.client
  runs = new PostgresRunRepository(database)
  tasks = new PostgresTaskRepository(database)
  await seedRunDependencies(database)
})

after(async () => {
  await throwaway.dispose()
})

test('migrations are idempotent and install the complete M2 table set', async () => {
  const results = await runMigrations(database)
  assert.equal(results.every((result) => !result.applied), true)
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from information_schema.tables
     where table_schema = 'public'
       and table_name in (
         'users', 'agents', 'agent_versions', 'workspaces', 'sessions', 'runs',
         'run_attempts', 'run_events', 'model_providers', 'provider_models',
         'model_routes', 'credential_refs', 'runtimes', 'audit_events'
       )
  `
  assert.equal(row?.count, 14)
})

test('model governance resolves the DSH default route without secret material', async () => {
  const service = new ModelGovernanceService(new PostgresModelGovernanceRepository(database))
  const providers = await service.listProviders()
  const provider = providers.find((item) => item.id === 'provider-deepseek-official')
  assert.equal(provider?.credential?.backend, 'dsh-managed')
  assert.equal(provider?.credential?.externalRef, 'DEEPSEEK_API_KEY')
  assert.equal('secret' in (provider?.credential ?? {}), false)

  const snapshot = await service.resolveRoute('default')
  assert.equal(snapshot.providerKey, 'deepseek-official')
  assert.equal(snapshot.modelKey, 'deepseek-v4-pro')
  assert.equal('secret' in snapshot, false)
})

test('run creation is idempotent and tenant-scoped', async () => {
  const input = {
    tenantId: 'tenant-dsh-work',
    sessionId,
    requestedBy: 'U00001',
    idempotencyKey: 'm2-idempotency-001',
  }
  const first = await runs.createRun(input)
  const repeated = await runs.createRun(input)
  assert.equal(repeated.id, first.id)
  assert.ok(first.taskId)
  const task = await tasks.getTask(first.tenantId, first.taskId!)
  assert.equal(task?.sourceType, 'session')
  assert.equal(task?.sessionId, sessionId)
  assert.equal(task?.workspaceId, 'ws-personal-U00001')
  assert.equal((await runs.getRun('tenant-other', first.id)), null)
  await runs.transitionRun(first.tenantId, first.id, 'failed')
  assert.equal((await tasks.getTask(first.tenantId, first.taskId!))?.status, 'failed')
})

test('PF-01 Task 与外部操作按关联键和参数摘要幂等，未知效果可核对后收敛', async () => {
  const correlationKey = `erp-event-${suffix}`
  const task = await tasks.createTask({
    tenantId: 'tenant-dsh-work',
    requestedBy: 'U00001',
    sourceType: 'event',
    sourceRef: 'erp://delivery/42',
    correlationKey,
    workspaceId: 'ws-personal-U00001',
  })
  const repeatedTask = await tasks.createTask({
    tenantId: 'tenant-dsh-work',
    requestedBy: 'U00001',
    sourceType: 'event',
    sourceRef: 'erp://delivery/42',
    correlationKey,
    workspaceId: 'ws-personal-U00001',
  })
  assert.equal(repeatedTask.id, task.id)
  assert.equal(task.sessionId, null)
  await assert.rejects(
    tasks.createTask({
      tenantId: 'tenant-dsh-work',
      requestedBy: 'U00001',
      sourceType: 'event',
      sourceRef: 'erp://delivery/changed',
      correlationKey,
      workspaceId: 'ws-personal-U00001',
    }),
    TaskContractConflictError,
  )

  const run = await runs.createRun({
    tenantId: task.tenantId,
    taskId: task.id,
    sessionId: null,
    workspaceId: task.workspaceId,
    requestedBy: task.requestedBy,
    idempotencyKey: `event-run-${suffix}`,
  })
  const repeatedRun = await runs.createRun({
    tenantId: task.tenantId,
    taskId: task.id,
    sessionId: null,
    workspaceId: task.workspaceId,
    requestedBy: task.requestedBy,
    idempotencyKey: `event-run-repeated-${suffix}`,
  })
  assert.equal(run.taskId, task.id)
  assert.equal(run.sessionId, null)
  assert.equal(repeatedRun.id, run.id)

  const parameterDigest = taskOperationParameterDigest({ quantity: 5, material: 'A-01' })
  const operation = await tasks.registerOperation({
    tenantId: task.tenantId,
    taskId: task.id,
    runId: run.id,
    operationKey: 'confirm-delivery-42',
    actionType: 'external-write',
    actionRef: 'erp.confirm-delivery@1.0.0',
    parameterDigest,
    receipt: { providerRequestId: 'provider-42' },
  })
  const repeatedOperation = await tasks.registerOperation({
    tenantId: task.tenantId,
    taskId: task.id,
    runId: run.id,
    operationKey: 'confirm-delivery-42',
    actionType: 'external-write',
    actionRef: 'erp.confirm-delivery@1.0.0',
    parameterDigest,
  })
  assert.equal(repeatedOperation.id, operation.id)
  await assert.rejects(
    tasks.registerOperation({
      tenantId: task.tenantId,
      taskId: task.id,
      runId: run.id,
      operationKey: 'confirm-delivery-42',
      actionType: 'external-write',
      actionRef: 'erp.confirm-delivery@1.0.0',
      parameterDigest: taskOperationParameterDigest({ quantity: 6, material: 'A-01' }),
    }),
    TaskContractConflictError,
  )

  const acknowledged = await tasks.resolveOperation({
    tenantId: task.tenantId,
    operationId: operation.id,
    status: 'accepted',
    receipt: { providerRequestId: 'provider-42', providerStatus: 'accepted' },
  })
  assert.equal(acknowledged.status, 'accepted')
  assert.equal(acknowledged.resolvedAt, null)

  const unknown = await tasks.resolveOperation({
    tenantId: task.tenantId,
    operationId: operation.id,
    status: 'unknown',
    receipt: { providerRequestId: 'provider-42', reason: 'timeout_after_send' },
  })
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.resolvedAt, null)
  const completed = await tasks.resolveOperation({
    tenantId: task.tenantId,
    operationId: operation.id,
    status: 'completed',
    receipt: { providerRequestId: 'provider-42', providerStatus: 'completed' },
  })
  assert.equal(completed.status, 'completed')
  assert.ok(completed.resolvedAt)
  assert.equal((await tasks.getOperation('tenant-other', operation.id)), null)
  await assert.rejects(
    tasks.resolveOperation({
      tenantId: task.tenantId,
      operationId: operation.id,
      status: 'failed',
      receipt: { providerStatus: 'failed' },
      errorCode: 'LATE_FAILURE',
    }),
    TaskContractConflictError,
  )
})

test('PF-01 无 Session Task 与 Run 在一次受理事务中创建并按关联键复用', async () => {
  const correlationKey = `api-atomic-${suffix}`
  const first = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: null,
    workspaceId: 'ws-personal-U00001',
    requestedBy: 'U00001',
    idempotencyKey: correlationKey,
    taskSourceType: 'api',
    taskSourceRef: 'api://tests/pf01',
    taskCorrelationKey: correlationKey,
  })
  const repeated = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: null,
    workspaceId: 'ws-personal-U00001',
    requestedBy: 'U00001',
    idempotencyKey: `ignored-after-task-dedupe-${suffix}`,
    taskSourceType: 'api',
    taskSourceRef: 'api://tests/pf01',
    taskCorrelationKey: correlationKey,
  })
  assert.equal(repeated.id, first.id)
  assert.equal(first.sessionId, null)
  assert.equal((await tasks.getTask(first.tenantId, first.taskId))?.sourceType, 'api')
})

test('PF-01 数据库边界拒绝无归属 Run：原生写入也自动固定 Task', async () => {
  const runId = `run-raw-pf01-${suffix}`
  const [row] = await database<{ taskId: string }[]>`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, 'tenant-dsh-work', ${sessionId}, 'U00001', ${`raw-pf01-${suffix}`}, 'queued')
    returning task_id as "taskId"
  `
  assert.equal(row?.taskId, `task-${runId}`)
  const task = await tasks.getTask('tenant-dsh-work', row!.taskId)
  assert.equal(task?.sourceType, 'session')
  assert.equal(task?.sessionId, sessionId)
  await database`update runs set status = 'failed' where tenant_id = 'tenant-dsh-work' and id = ${runId}`
  assert.equal((await tasks.getTask('tenant-dsh-work', row!.taskId))?.status, 'failed')
})

test('retry creates a new immutable Attempt and events are idempotent', async () => {
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId,
    requestedBy: 'U00001',
    idempotencyKey: 'm2-retry-001',
  })
  const route = await new ModelGovernanceService(new PostgresModelGovernanceRepository(database)).resolveRoute()
  const routeSnapshot = JSON.parse(JSON.stringify(route)) as JsonObject
  const first = await runs.createAttempt({
    tenantId: run.tenantId,
    runId: run.id,
    manifest: attemptManifest(run.taskId, run.id, 30, 10, 65536),
    manifestSha256: 'a'.repeat(64),
    modelRouteSnapshot: routeSnapshot,
  })
  await runs.transitionRun(run.tenantId, run.id, 'running')
  await runs.transitionAttempt(run.tenantId, first.id, 'running')
  await runs.transitionAttempt(run.tenantId, first.id, 'failed', 'MODEL_TIMEOUT')
  await runs.transitionRun(run.tenantId, run.id, 'failed')

  const second = await runs.createAttempt({
    tenantId: run.tenantId,
    runId: run.id,
    manifest: attemptManifest(run.taskId, run.id, 30, 10, 65536),
    manifestSha256: 'a'.repeat(64),
    modelRouteSnapshot: routeSnapshot,
  })
  assert.equal(second.attemptNo, 2)
  assert.notEqual(second.id, first.id)
  assert.deepEqual(second.modelRouteSnapshot, first.modelRouteSnapshot)

  const event = {
    id: `event-m2-${suffix}-001`,
    tenantId: run.tenantId,
    runId: run.id,
    attemptId: second.id,
    sequence: 1,
    eventType: 'attempt.started',
    displayMessage: '开始执行',
    safeMetadata: { runtime: 'integration' },
    traceId: 'trace-m2-integration-001',
    occurredAt: new Date().toISOString(),
  }
  const created = await runs.appendEvent(event)
  const repeated = await runs.appendEvent(event)
  assert.equal(repeated.id, created.id)
  assert.equal((await runs.readEvents(run.tenantId, run.id)).length, 1)

  // 1A-T5: the per-attempt sequence is no longer a hard rejection for a
  // different event id — the Runtime adapter numbers its own events while
  // server-authored notes allocate max(sequence)+1, so a concurrent collision
  // must be retried rather than dropped (losing the write also loses that
  // event's state transition). The writer re-allocates a free sequence.
  const reallocated = await runs.appendEvent({ ...event, id: `event-m2-${suffix}-002` })
  assert.equal(reallocated.id, `event-m2-${suffix}-002`)
  assert.notEqual(reallocated.sequence, created.sequence)
  assert.equal((await runs.readEvents(run.tenantId, run.id)).length, 2)
  // The (tenant, attempt, sequence) unique key is still enforced underneath.
  await assert.rejects(
    database`
      insert into run_events (id, tenant_id, run_id, attempt_id, sequence, event_type, display_message, safe_metadata, trace_id, occurred_at)
      values (${`event-m2-${suffix}-dup-seq`}, ${run.tenantId}, ${run.id}, ${second.id}, ${reallocated.sequence}, 'attempt.started', '重复序列', ${database.json({})}, 'trace-dup', now())
    `,
    /duplicate key|unique constraint/i,
  )

  await runs.transitionAttempt(run.tenantId, second.id, 'cancelled')
  await runs.transitionRun(run.tenantId, run.id, 'cancelled')
})

test('Attempt creation rolls back when an immutable input association cannot be persisted', async () => {
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId,
    requestedBy: 'U00001',
    idempotencyKey: `m2-attempt-atomic-${suffix}`,
  })
  const attemptId = `attempt-atomic-${suffix}`
  await assert.rejects(
    runs.createAttempt({
      attemptId,
      tenantId: run.tenantId,
      runId: run.id,
      manifest: attemptManifest(run.taskId, run.id, 30, 10, 65536),
      manifestSha256: 'b'.repeat(64),
      modelRouteSnapshot: {},
      knowledgeSources: [{
        documentId: `missing-document-${suffix}`,
        relevanceScore: 10,
        excerpt: '不可落库的知识快照',
      }],
    }),
    /foreign key|violates/i,
  )

  assert.equal(await runs.getAttempt(run.tenantId, attemptId), null)
  assert.equal((await runs.getRun(run.tenantId, run.id))?.currentAttemptId, null)
})

test('published governance versions reject in-place mutation', async () => {
  await database`
    update agent_versions set status = 'published', published_at = now()
     where tenant_id = 'tenant-dsh-work' and id = ${agentVersionId}
  `
  await assert.rejects(
    database`
      update agent_versions set system_prompt = '不允许覆盖已发布版本'
       where tenant_id = 'tenant-dsh-work' and id = ${agentVersionId}
    `,
    /published versions are immutable/i,
  )
})

test('PF-02 累计预算按 Attempt 预占并按实际用量结算，重放不重复扣减', async () => {
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work', sessionId, requestedBy: 'U00001',
    idempotencyKey: `pf02-settle-${suffix}`,
    taskBudget: { maxDurationMs: 60_000, maxToolCalls: 7, maxOutputBytes: 10_000 },
  })
  const first = await runs.createAttempt({
    tenantId: run.tenantId, runId: run.id,
    manifest: attemptManifest(run.taskId, run.id, 30, 5, 6_000, run.taskId, { maxDurationMs: 60_000, maxToolCalls: 7, maxOutputBytes: 10_000 }),
    manifestSha256: 'c'.repeat(64), modelRouteSnapshot: {},
  })
  let view = await tasks.getBudgetView(run.tenantId, run.taskId)
  assert.deepEqual(view?.reserved, { durationMs: 30_000, toolCalls: 5, outputBytes: 6_000 })
  await tasks.settleAttemptBudget(run.tenantId, first.id, {
    durationMs: 1_200, toolCalls: 2, outputBytes: 800,
    inputTokens: 120, outputTokens: 40, tokenMeasurement: 'reported',
    durationMeasurement: 'runtime', toolMeasurement: 'runtime', outputMeasurement: 'platform',
    terminalStatus: 'failed',
  })
  await runs.transitionAttempt(run.tenantId, first.id, 'failed', 'SYNTHETIC')
  await runs.transitionRun(run.tenantId, run.id, 'failed')
  await tasks.settleAttemptBudget(run.tenantId, first.id, {
    durationMs: 9_999, toolCalls: 7, outputBytes: 9_999,
    inputTokens: 999, outputTokens: 999, tokenMeasurement: 'unavailable',
    durationMeasurement: 'timestamps', toolMeasurement: 'runtime', outputMeasurement: 'platform',
    terminalStatus: 'failed',
  })
  const second = await runs.createAttempt({
    tenantId: run.tenantId, runId: run.id,
    manifest: attemptManifest(run.taskId, run.id, 30, 5, 6_000, run.taskId, { maxDurationMs: 60_000, maxToolCalls: 7, maxOutputBytes: 10_000 }),
    manifestSha256: 'd'.repeat(64), modelRouteSnapshot: {},
  })
  assert.equal(second.attemptNo, 2)
  view = await tasks.getBudgetView(run.tenantId, run.taskId)
  assert.equal(view?.usage.toolCalls, 2)
  assert.equal(view?.usage.inputTokens, 120)
  assert.equal(view?.reserved.toolCalls, 5)
  assert.equal(view?.remaining.toolCalls, 0)
  await tasks.settleAttemptBudget(run.tenantId, second.id, {
    durationMs: 90_000, toolCalls: 99, outputBytes: 90_000,
    inputTokens: null, outputTokens: null, tokenMeasurement: 'unavailable',
    durationMeasurement: 'timestamps', toolMeasurement: 'runtime', outputMeasurement: 'platform',
    terminalStatus: 'succeeded',
  })
  view = await tasks.getBudgetView(run.tenantId, run.taskId)
  assert.deepEqual(view?.usage, {
    durationMs: 31_200, toolCalls: 7, outputBytes: 6_800,
    inputTokens: null, outputTokens: null, tokenMeasurement: 'unavailable',
    costAmount: null, costCurrency: null,
  })
  assert.deepEqual(view?.attempts.find(item => item.attemptId === second.id)?.measurement, {
    tokens: 'unavailable', cost: 'unavailable',
    duration: 'reserved', toolCalls: 'reserved', outputBytes: 'reserved',
  })
})

test('PF-02 共享预算范围串行化并发预占，且未开始的取消只释放一次', async () => {
  const root = await tasks.createTask({
    tenantId: 'tenant-dsh-work', requestedBy: 'U00001', sourceType: 'system',
    correlationKey: `pf02-root-${suffix}`, workspaceId: 'ws-personal-U00001',
    budget: { maxDurationMs: 60_000, maxToolCalls: 10, maxOutputBytes: 20_000 },
  })
  await assert.rejects(tasks.createTask({
    tenantId: root.tenantId, requestedBy: root.requestedBy, sourceType: 'system',
    correlationKey: `pf02-child-redefines-${suffix}`, workspaceId: root.workspaceId,
    budgetScopeTaskId: root.id, budget: { maxToolCalls: 1 },
  }), TaskContractConflictError)
  const children = await Promise.all([1, 2].map(index => tasks.createTask({
    tenantId: root.tenantId, requestedBy: root.requestedBy, sourceType: 'system',
    correlationKey: `pf02-child-${index}-${suffix}`, workspaceId: root.workspaceId,
    budgetScopeTaskId: root.id,
  })))
  const childRuns = await Promise.all(children.map((task, index) => runs.createRun({
    tenantId: task.tenantId, taskId: task.id, sessionId: null, workspaceId: task.workspaceId,
    requestedBy: task.requestedBy, idempotencyKey: `pf02-child-run-${index}-${suffix}`,
  })))
  const reservations = await Promise.allSettled(childRuns.map((run, index) => runs.createAttempt({
    tenantId: run.tenantId, runId: run.id,
    manifest: attemptManifest(run.taskId, run.id, 30, 6, 8_000, root.id, { maxDurationMs: 60_000, maxToolCalls: 10, maxOutputBytes: 20_000 }),
    manifestSha256: String(index + 1).repeat(64), modelRouteSnapshot: {},
  })))
  assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = reservations.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.ok(rejected.reason instanceof TaskBudgetExceededError)
  const accepted = (reservations.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<PostgresRunRepository['createAttempt']>>>).value
  await runs.transitionAttempt(root.tenantId, accepted.id, 'cancelled')
  await runs.transitionAttempt(root.tenantId, accepted.id, 'cancelled')
  const view = await tasks.getBudgetView(root.tenantId, root.id)
  assert.equal(view?.attempts[0]?.status, 'released')
  assert.deepEqual(view?.usage, {
    durationMs: 0, toolCalls: 0, outputBytes: 0,
    inputTokens: null, outputTokens: null, tokenMeasurement: 'unavailable',
    costAmount: null, costCurrency: null,
  })
  assert.deepEqual(view?.reserved, { durationMs: 0, toolCalls: 0, outputBytes: 0 })
})

test('PF-02 precise settlement and queued cancellation use one lock order without deadlock', async () => {
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work', sessionId, requestedBy: 'U00001',
    idempotencyKey: `pf02-lock-order-${suffix}`,
  })
  const attempt = await runs.createAttempt({
    tenantId: run.tenantId, runId: run.id,
    manifest: attemptManifest(run.taskId, run.id, 30, 5, 6_000),
    manifestSha256: 'e'.repeat(64), modelRouteSnapshot: {},
  })
  let releaseAccount: () => void = () => undefined
  let accountLocked: () => void = () => undefined
  const accountLockedSignal = new Promise<void>(resolve => { accountLocked = resolve })
  const releaseAccountSignal = new Promise<void>(resolve => { releaseAccount = resolve })
  const blocker = database.begin(async transaction => {
    await transaction`select 1 from task_budget_accounts
      where tenant_id = ${run.tenantId} and budget_scope_task_id = ${run.taskId} for update`
    accountLocked()
    await releaseAccountSignal
  })
  await accountLockedSignal

  let cancellation: Promise<unknown> | undefined
  let settlement: Promise<unknown> | undefined
  try {
    cancellation = runs.transitionAttempt(run.tenantId, attempt.id, 'cancelled')
    await waitForBlockedTransactions(1)
    settlement = tasks.settleAttemptBudget(run.tenantId, attempt.id, {
      durationMs: 10, toolCalls: 1, outputBytes: 10,
      inputTokens: null, outputTokens: null, tokenMeasurement: 'unavailable',
      durationMeasurement: 'runtime', toolMeasurement: 'runtime', outputMeasurement: 'platform',
      terminalStatus: 'cancelled',
    })
    await waitForBlockedTransactions(2)
    releaseAccount()
    await Promise.all([blocker, cancellation, settlement])
  } finally {
    releaseAccount()
    await Promise.allSettled([blocker, cancellation, settlement].filter((value): value is Promise<unknown> => value !== undefined))
  }

  const view = await tasks.getBudgetView(run.tenantId, run.taskId)
  assert.equal(view?.attempts.find(item => item.attemptId === attempt.id)?.status, 'released')
})

test('PF-02 明确拒绝当前无法可靠执行的 Token 与成本硬预算', async () => {
  await assert.rejects(tasks.createTask({
    tenantId: 'tenant-dsh-work', requestedBy: 'U00001', sourceType: 'api',
    correlationKey: `pf02-token-${suffix}`, workspaceId: 'ws-personal-U00001',
    budget: { maxTokens: 1_000 },
  }), TaskBudgetUnsupportedError)
  await assert.rejects(tasks.createTask({
    tenantId: 'tenant-dsh-work', requestedBy: 'U00001', sourceType: 'api',
    correlationKey: `pf02-cost-${suffix}`, workspaceId: 'ws-personal-U00001',
    budget: { maxCostAmount: 10, costCurrency: 'CNY' },
  }), TaskBudgetUnsupportedError)
})

async function waitForBlockedTransactions(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [row] = await database<{ count: number }[]>`
      select count(*)::integer as count
        from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
    `
    if ((row?.count ?? 0) >= expected) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待 ${expected} 个锁等待事务超时`)
}

function attemptManifest(
  taskId: string,
  runId: string,
  timeoutSeconds: number,
  toolCalls: number,
  outputBytes: number,
  budgetScopeTaskId = taskId,
  cumulative: { maxDurationMs: number | null; maxToolCalls: number | null; maxOutputBytes: number | null } = {
    maxDurationMs: null, maxToolCalls: null, maxOutputBytes: null,
  },
): JsonObject {
  return {
    run_id: runId,
    task_id: taskId,
    limits: {
      timeout_seconds: timeoutSeconds,
      max_tool_calls: toolCalls,
      max_output_bytes: outputBytes,
    },
    budget: {
      scope_task_id: budgetScopeTaskId,
      cumulative_limits: {
        max_duration_ms: cumulative.maxDurationMs,
        max_tool_calls: cumulative.maxToolCalls,
        max_output_bytes: cumulative.maxOutputBytes,
      },
      reservation: { duration_ms: timeoutSeconds * 1000, tool_calls: toolCalls, output_bytes: outputBytes },
      enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
    },
  }
}

async function seedRunDependencies(sql: DatabaseClient) {
  await sql`
    insert into tenants (id, name, status) values ('tenant-other', '其他租户', 'active')
    on conflict (id) do nothing
  `
  await sql`
    insert into agents (
      id, tenant_id, name, description, owner_user_id, created_by, status
    ) values (
      ${agentId}, 'tenant-dsh-work', 'M2 集成 Agent', '用于验证 PostgreSQL 约束',
      'U00008', 'U00008', 'draft'
    ) on conflict (id) do nothing
  `
  await sql`
    insert into agent_versions (
      id, tenant_id, agent_id, version, system_prompt, status
    ) values (
      ${agentVersionId}, 'tenant-dsh-work', ${agentId}, '0.1.0',
      '仅用于 M2 PostgreSQL 集成测试的 System Prompt。', 'draft'
    ) on conflict (id) do nothing
  `
  await sql`
    insert into sessions (
      id, tenant_id, workspace_id, created_by, agent_version_id, title, status
    ) values (
      ${sessionId}, 'tenant-dsh-work', 'ws-personal-U00001', 'U00001', ${agentVersionId},
      'M2 集成 Session', 'active'
    ) on conflict (id) do nothing
  `
}
