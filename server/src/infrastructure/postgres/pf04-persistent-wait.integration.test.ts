import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresPersistentWaitService } from '../../modules/run/postgres-persistent-wait-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresTaskRepository } from '../../modules/task/postgres-task-repository.ts'
import { compileRuntimeManifest } from '../../modules/runtime/manifest-compiler.ts'
import { canonicalJson } from '../../modules/runtime/canonical-json.ts'
import type { RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { JsonObject, RunRecord } from '../../modules/run/run-types.ts'

const tenantId = 'tenant-dsh-work'
let database: DatabaseClient
let throwaway: ThrowawayDatabase
let runs: PostgresRunRepository
let tasks: PostgresTaskRepository

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_pf04_wait', maxConnections: 6 })
  database = throwaway.client
  runs = new PostgresRunRepository(database)
  tasks = new PostgresTaskRepository(database)
})

after(async () => { await throwaway.dispose() })

test('PF-04 approval releases the source Attempt and resumes exactly once with a bound checkpoint', async () => {
  const fixture = await runningFixture('approve-once')
  const enqueued: Array<{ run: RunRecord; manifest: RuntimeManifest }> = []
  let authorizationChecks = 0
  const service = new PostgresPersistentWaitService(database, runs, {
    reauthorize: async () => { authorizationChecks += 1 },
    enqueue: (run, manifest) => { enqueued.push({ run, manifest }) },
  }, 'test-runtime-1')

  const requested = permission('erp.update', 'approved-action')
  const wait = await service.decidePermission(fixture.manifest, requested)
  assert.equal(typeof wait, 'object')
  if (typeof wait === 'string') return
  assert.equal((await service.list('pending')).some(item => item.id === wait.approvalId), false)
  await assert.rejects(
    service.resolve({
      approvalId: wait.approvalId, decision: 'rejected', actor: 'U00001',
      resolutionKey: `too-early-${randomUUID()}`,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'APPROVAL_NOT_READY',
  )
  assert.equal(await service.activateWaiting({
    approvalId: wait.approvalId, runId: fixture.run.id, attemptId: fixture.manifest.attempt_id,
  }), true)
  assert.equal((await service.list('pending')).some(item => item.id === wait.approvalId), true)

  const recovered = await runs.recoverAfterRestart(tenantId, 'runtime-local-01')
  assert.equal(recovered.failed.length, 0, 'a durable waiting Attempt survives process restart')
  assert.equal(recovered.queued.length, 0, 'waiting work is not dispatched before approval')
  assert.equal((await runs.getRun(tenantId, fixture.run.id))?.status, 'waiting')

  const resolutionKey = `resolution-${randomUUID()}`
  const loadApproval = Reflect.get(service, 'loadApproval') as (approvalId: string) => Promise<unknown>
  const rejectLoadedApproval = Reflect.get(service, 'reject') as (
    current: unknown,
    input: { actor: string; resolutionKey: string; comment?: string },
  ) => Promise<unknown>
  const staleRejectView = await loadApproval.call(service, wait.approvalId)
  const approved = await service.resolve({
    approvalId: wait.approvalId, decision: 'approved', actor: 'U00001', resolutionKey,
  })
  assert.equal(approved.status, 'approved')
  assert.ok(approved.resumedAttemptId)
  assert.equal(authorizationChecks, 1)
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0]?.manifest.resume?.checkpoint_digest, wait.checkpointDigest)
  assert.equal(enqueued[0]?.manifest.resume?.parameter_digest, requested.parameterDigest)
  assert.deepEqual(enqueued[0]?.manifest.resume?.checkpoint_context, requested.checkpointState)
  assert.equal((await runs.getRun(tenantId, fixture.run.id))?.status, 'queued')
  await assert.rejects(
    rejectLoadedApproval.call(service, staleRejectView, {
      actor: 'U00002', resolutionKey: `concurrent-reject-${randomUUID()}`,
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'APPROVAL_CONFLICT',
  )
  assert.equal((await runs.getRun(tenantId, fixture.run.id))?.status, 'queued')
  assert.equal((await runs.getAttempt(tenantId, fixture.manifest.attempt_id))?.status, 'waiting')
  await runs.transitionAttempt(tenantId, approved.resumedAttemptId!, 'running')
  await runs.transitionRun(tenantId, fixture.run.id, 'running')
  const forgedPermission = permission('erp.delete', 'forged-action')
  const forgedManifest = structuredClone(enqueued[0]!.manifest)
  forgedManifest.resume = { ...forgedManifest.resume!, action_name: 'erp.delete', parameter_digest: forgedPermission.parameterDigest }
  const forged = await service.decidePermission(forgedManifest, forgedPermission)
  assert.notEqual(typeof forged, 'string', 'the approval row must remain authoritative if resume fields are forged')
  await database`
    update run_approval_requests set status = 'cancelled', resolved_at = now(), resolved_by = 'U00001'
     where tenant_id = ${tenantId} and id = ${(forged as { approvalId: string }).approvalId}
  `
  await database`
    update run_checkpoints set status = 'cancelled', resolved_at = now()
     where tenant_id = ${tenantId} and id = ${(forged as { checkpointId: string }).checkpointId}
  `
  assert.equal(await service.decidePermission(enqueued[0]!.manifest, {
    ...requested, toolCallId: 'approved-replay',
  }), 'allow_once', 'the exact approved action may execute once in the resumed Attempt')
  const repeatedAction = await service.decidePermission(enqueued[0]!.manifest, {
    ...requested, toolCallId: 'approved-replay-second',
  })
  assert.notEqual(typeof repeatedAction, 'string', 'the same approval cannot authorize a second action call')
  await database`
    update run_approval_requests set status = 'cancelled', resolved_at = now(), resolved_by = 'U00001'
     where tenant_id = ${tenantId} and id = ${(repeatedAction as { approvalId: string }).approvalId}
  `
  await database`
    update run_checkpoints set status = 'cancelled', resolved_at = now()
     where tenant_id = ${tenantId} and id = ${(repeatedAction as { checkpointId: string }).checkpointId}
  `
  const changed = await service.decidePermission(enqueued[0]!.manifest, {
    ...permission('erp.update', 'changed-parameters'), toolCallId: 'changed-parameters',
  })
  assert.notEqual(typeof changed, 'string', 'changed parameters must create a new approval')

  const duplicate = await service.resolve({
    approvalId: wait.approvalId, decision: 'approved', actor: 'U00001', resolutionKey,
  })
  assert.equal(duplicate.resumedAttemptId, approved.resumedAttemptId)
  assert.equal(enqueued.length, 1, 'duplicate decision must not enqueue another Attempt')
  await assert.rejects(
    service.resolve({ approvalId: wait.approvalId, decision: 'rejected', actor: 'U00001', resolutionKey: `opposite-${randomUUID()}` }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'APPROVAL_CONFLICT',
  )
  await assert.rejects(
    runs.transitionAttempt(tenantId, fixture.manifest.attempt_id, 'succeeded'),
    /非法 Attempt 状态转换/,
  )
})

test('PF-04 blocks resume while a source side effect is unknown', async () => {
  const fixture = await runningFixture('unknown-effect')
  const service = new PostgresPersistentWaitService(database, runs, {
    reauthorize: async () => undefined, enqueue: () => undefined,
  })
  const wait = await service.decidePermission(fixture.manifest, permission('erp.update', 'b'.repeat(64)))
  assert.notEqual(typeof wait, 'string')
  if (typeof wait === 'string') return
  await service.activateWaiting({ approvalId: wait.approvalId, runId: fixture.run.id, attemptId: fixture.manifest.attempt_id })
  const operation = await tasks.acceptOperation({
    tenantId, taskId: fixture.run.taskId, runId: fixture.run.id, attemptId: fixture.manifest.attempt_id,
    operationKey: `unknown-${randomUUID()}`, actionType: 'external-write', actionRef: 'erp.update',
    parameterDigest: 'b'.repeat(64), receipt: { accepted: true },
  })
  await tasks.resolveOperation({ tenantId, operationId: operation.operation.id, status: 'unknown', receipt: { timeout: true } })
  await assert.rejects(
    service.resolve({ approvalId: wait.approvalId, decision: 'approved', actor: 'U00001', resolutionKey: `unknown-${randomUUID()}` }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'TASK_OPERATION_EFFECT_UNKNOWN',
  )
  assert.equal((await service.get(wait.approvalId))?.status, 'pending')
})

test('PF-04 never consumes an approved action after its approval expires', async () => {
  const fixture = await runningFixture('approved-expiry')
  const enqueued: RuntimeManifest[] = []
  const service = new PostgresPersistentWaitService(database, runs, {
    reauthorize: async () => undefined,
    enqueue: (_run, manifest) => { enqueued.push(manifest) },
  })
  const requested = permission('erp.update', 'expires-before-consumption')
  const wait = await service.decidePermission(fixture.manifest, requested)
  if (typeof wait === 'string') throw new Error('expected durable wait')
  await service.activateWaiting({ approvalId: wait.approvalId, runId: fixture.run.id, attemptId: fixture.manifest.attempt_id })
  const approved = await service.resolve({
    approvalId: wait.approvalId,
    decision: 'approved',
    actor: 'U00001',
    resolutionKey: `approved-expiry-${randomUUID()}`,
  })
  assert.ok(approved.resumedAttemptId)
  await runs.transitionAttempt(tenantId, approved.resumedAttemptId!, 'running')
  await runs.transitionRun(tenantId, fixture.run.id, 'running')
  await database`
    update run_approval_requests set expires_at = now() - interval '1 second'
     where tenant_id = ${tenantId} and id = ${wait.approvalId}
  `

  const decision = await service.decidePermission(enqueued[0]!, {
    ...requested,
    toolCallId: 'expired-approved-call',
  })
  assert.notEqual(decision, 'allow_once')
  const [original] = await database<{ actionConsumedAt: Date | null }[]>`
    select action_consumed_at as "actionConsumedAt" from run_approval_requests
     where tenant_id = ${tenantId} and id = ${wait.approvalId}
  `
  assert.equal(original?.actionConsumedAt, null)
})

test('PF-04 abandoned approvals cannot block or terminate a retry Attempt', async () => {
  const service = new PostgresPersistentWaitService(database, runs, {
    reauthorize: async () => undefined, enqueue: () => undefined,
  })

  const blocked = await runningFixture('abandoned-cleanup')
  const abandoned = await service.decidePermission(blocked.manifest, permission('erp.update', 'abandoned-old'))
  if (typeof abandoned === 'string') throw new Error('expected durable wait')
  await runs.transitionAttempt(tenantId, blocked.manifest.attempt_id, 'failed', 'RUNTIME_EXECUTION_FAILED')
  await runs.transitionRun(tenantId, blocked.run.id, 'failed')
  const retryManifest = await startRetryAttempt(blocked.run, blocked.manifest, 'cleanup')
  const retryWait = await service.decidePermission(retryManifest, permission('erp.update', 'retry-action'))
  assert.notEqual(typeof retryWait, 'string', 'a stale active checkpoint must not block the retry approval')
  assert.equal((await service.get(abandoned.approvalId))?.status, 'cancelled')
  const [retiredCheckpoint] = await database<{ status: string }[]>`
    select status from run_checkpoints where tenant_id = ${tenantId} and id = ${abandoned.checkpointId}
  `
  assert.equal(retiredCheckpoint?.status, 'cancelled')
  await service.cancelPreparingForAttempt({ runId: blocked.run.id, attemptId: retryManifest.attempt_id })

  const expiring = await runningFixture('abandoned-expiry')
  const oldWait = await service.decidePermission(expiring.manifest, permission('erp.update', 'expiring-old'))
  if (typeof oldWait === 'string') throw new Error('expected durable wait')
  await runs.transitionAttempt(tenantId, expiring.manifest.attempt_id, 'failed', 'RUNTIME_EXECUTION_FAILED')
  await runs.transitionRun(tenantId, expiring.run.id, 'failed')
  const currentManifest = await startRetryAttempt(expiring.run, expiring.manifest, 'expiry')
  await database`
    update run_approval_requests set expires_at = now() - interval '1 second'
     where tenant_id = ${tenantId} and id = ${oldWait.approvalId}
  `
  await service.expireDue()
  assert.equal((await runs.getRun(tenantId, expiring.run.id))?.status, 'running')
  assert.equal((await runs.getAttempt(tenantId, currentManifest.attempt_id))?.status, 'running')
  assert.equal((await service.get(oldWait.approvalId))?.status, 'expired')
})

test('PF-04 rejection, expiry, cancellation and restart reconciliation converge without a new Attempt', async () => {
  for (const outcome of ['rejected', 'expired', 'cancelled', 'orphaned'] as const) {
    const fixture = await runningFixture(outcome)
    const enqueued: RuntimeManifest[] = []
    const service = new PostgresPersistentWaitService(database, runs, {
      reauthorize: async () => undefined, enqueue: (_run, manifest) => { enqueued.push(manifest) },
    })
    const wait = await service.decidePermission(fixture.manifest, permission('erp.update', 'c'.repeat(64)))
    if (typeof wait === 'string') throw new Error('expected durable wait')
    await service.activateWaiting({ approvalId: wait.approvalId, runId: fixture.run.id, attemptId: fixture.manifest.attempt_id })
    if (outcome === 'rejected') {
      await service.resolve({ approvalId: wait.approvalId, decision: 'rejected', actor: 'U00001', resolutionKey: `reject-${randomUUID()}` })
      assert.equal((await runs.getRun(tenantId, fixture.run.id))?.status, 'failed')
    } else if (outcome === 'expired') {
      await database`update run_approval_requests set expires_at = now() - interval '1 second' where tenant_id = ${tenantId} and id = ${wait.approvalId}`
      await service.expireDue()
      assert.equal((await runs.getRun(tenantId, fixture.run.id))?.status, 'failed')
      await assert.rejects(
        service.resolve({ approvalId: wait.approvalId, decision: 'approved', actor: 'U00001', resolutionKey: `expired-${randomUUID()}` }),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'APPROVAL_EXPIRED',
      )
    } else if (outcome === 'cancelled') {
      assert.equal(await service.cancelRun(fixture.run.id, 'U00001'), true)
      assert.equal((await runs.getRun(tenantId, fixture.run.id))?.status, 'cancelled')
    } else {
      await runs.transitionRun(tenantId, fixture.run.id, 'failed')
      assert.equal(await service.reconcileOrphans(), 1)
      assert.equal((await service.get(wait.approvalId))?.status, 'cancelled')
      const [checkpoint] = await database<{ status: string }[]>`
        select status from run_checkpoints where tenant_id = ${tenantId} and id = ${wait.checkpointId}
      `
      assert.equal(checkpoint?.status, 'cancelled')
    }
    const events = await runs.readEvents(tenantId, fixture.run.id)
    assert.equal(
      events.some(event => event.eventType === (outcome === 'cancelled' ? 'run.cancelled' : 'run.failed')),
      true,
      `${outcome} must emit a terminal Run event`,
    )
    assert.equal(enqueued.length, 0)
  }
})

async function runningFixture(label: string) {
  const unique = `${label}-${randomUUID()}`
  const task = await tasks.createTask({
    tenantId, requestedBy: 'U00001', sourceType: 'api', correlationKey: unique,
    workspaceId: 'ws-personal-U00001',
  })
  const run = await runs.createRun({
    tenantId, taskId: task.id, sessionId: null, workspaceId: task.workspaceId,
    requestedBy: task.requestedBy, idempotencyKey: unique,
  })
  const manifest: RuntimeManifest = {
    manifest_version: '1.0', run_id: run.id, attempt_id: `attempt-${randomUUID()}`,
    task_id: task.id, session_id: null, workspace_id: task.workspaceId!,
    agent_version_id: 'agent-version-dsh-work-assistant-1',
    agent_configuration: { system_prompt: 'You are a controlled test agent for durable waiting.', skill_instructions: [] },
    user_context: { user_id: task.requestedBy, tenant_id: tenantId, role_ids: ['employee'] },
    permission_policy: { approval_mode: 'always', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [], tools: [{ id: 'erp.update', version: '1.0.0' }], data_scopes: [], knowledge_context: [],
    input: { message: 'Perform the approved action safely.', file_mounts: [] },
    budget: {
      scope_task_id: task.id,
      cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
      reservation: { duration_ms: 30_000, tool_calls: 2, output_bytes: 4096 },
      enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
    },
    limits: { timeout_seconds: 30, max_tool_calls: 2, max_output_bytes: 4096 },
    created_at: new Date().toISOString(), trace_id: `trace-${unique}`,
  }
  const compiled = compileRuntimeManifest(manifest)
  await runs.createAttempt({
    attemptId: manifest.attempt_id, tenantId, runId: run.id, runtimeId: 'runtime-local-01',
    manifest: JSON.parse(compiled.canonicalJson) as JsonObject, manifestSha256: compiled.sha256,
    modelRouteSnapshot: {},
  })
  await runs.transitionAttempt(tenantId, manifest.attempt_id, 'running')
  await runs.transitionRun(tenantId, run.id, 'running')
  return { run, manifest }
}

async function startRetryAttempt(run: RunRecord, source: RuntimeManifest, label: string): Promise<RuntimeManifest> {
  const manifest = {
    ...structuredClone(source),
    attempt_id: `attempt-${label}-${randomUUID()}`,
    created_at: new Date().toISOString(),
    trace_id: `trace-${label}-${randomUUID()}`,
  }
  const compiled = compileRuntimeManifest(manifest)
  await runs.createAttempt({
    attemptId: manifest.attempt_id, tenantId, runId: run.id, runtimeId: 'runtime-local-01',
    manifest: JSON.parse(compiled.canonicalJson) as JsonObject,
    manifestSha256: compiled.sha256, modelRouteSnapshot: {},
  })
  await runs.transitionAttempt(tenantId, manifest.attempt_id, 'running')
  await runs.transitionRun(tenantId, run.id, 'running')
  return manifest
}

function permission(toolName: string, marker: string) {
  const actionArguments = { orderId: '42', marker }
  const parameterDigest = createHash('sha256').update(canonicalJson(actionArguments)).digest('hex')
  return {
    toolName, toolCallId: `call-${randomUUID()}`, parameterDigest,
    resourceRef: 'erp://orders/42', dataVersion: 'etag-v1',
    checkpointState: {
      pending_action: { arguments: actionArguments },
      completed_tool_results: [{
        call_id: 'call-read-order', tool_name: 'erp.read',
        parameter_digest: createHash('sha256').update(canonicalJson({ orderId: '42' })).digest('hex'),
        result: { status: 'open', quantity: 3 },
      }],
      workspace_files: [{
        path: 'output/库存报告.md', content: '# Draft\n',
        sha256: createHash('sha256').update('# Draft\n').digest('hex'),
      }],
      assistant_output: '订单已读取，等待更新审批。',
    },
  }
}
