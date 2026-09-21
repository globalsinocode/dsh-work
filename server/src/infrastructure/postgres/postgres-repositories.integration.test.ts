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
    manifest: { runId: run.id, version: 1 },
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
    manifest: { runId: run.id, version: 1 },
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
      manifest: { runId: run.id },
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
