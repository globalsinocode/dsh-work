import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService, type RuntimeAuthorizationDecision } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresAgentDelegationService } from '../../modules/run/postgres-agent-delegation-service.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type { JsonObject, RunRecord } from '../../modules/run/run-types.ts'
import { compileRuntimeManifest } from '../../modules/runtime/manifest-compiler.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import { PostgresTaskQueryService } from '../../modules/task/postgres-task-query-service.ts'
import { PostgresTaskRepository } from '../../modules/task/postgres-task-repository.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'

const tenantId = 'tenant-dsh-work'
const targetAgentVersionId = 'agent-version-dsh-work-assistant-1'
let database: DatabaseClient
let throwaway: ThrowawayDatabase
let runs: PostgresRunRepository
let tasks: PostgresTaskRepository
let authorization: PostgresAuthorizationService
let taskQueries: PostgresTaskQueryService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_pf06_delegation', maxConnections: 8 })
  database = throwaway.client
  runs = new PostgresRunRepository(database)
  tasks = new PostgresTaskRepository(database)
  authorization = new PostgresAuthorizationService(database)
  taskQueries = new PostgresTaskQueryService(database, tasks, runs)
})

after(async () => { await throwaway.dispose() })

test('PF-06 stores a versioned allow-list and rejects unpublished delegation targets', async () => {
  const agents = new PostgresAgentService(database)
  const id = `agent-delegation-${randomUUID().slice(0, 8)}`
  const created = await agents.createAgent({
    id, name: '受控委派测试助手', description: '验证委派目标以精确发布版本保存，并由平台配置控制。',
    owner: 'ignored', department: 'ignored', visibility: '全体试点员工',
    roleIds: ['role-employee'], dataScopes: ['enterprise:authorized'], welcomeMessage: '',
    examplePrompts: ['请拆分一个边界明确的子任务'],
    systemPrompt: '你是受控委派测试助手，只在必要时委派边界明确的子任务，并核对子任务结构化结果。',
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: ['skill-document@1.0.0'], tools: ['tool-runtime-file-read@1.0.0'],
    delegationPolicy: { allowedAgentVersionIds: [targetAgentVersionId], maxDepth: 2, maxParallel: 2, timeoutSeconds: 90 },
    changeSummary: '配置精确版本委派策略', actor: 'U00008',
  })
  assert.deepEqual(created.agent.delegationPolicy, {
    allowedAgentVersionIds: [targetAgentVersionId], maxDepth: 2, maxParallel: 2, timeoutSeconds: 90,
  })
  assert.deepEqual((await agents.getRuntimeSnapshot(created.version.id)).delegationPolicy, created.agent.delegationPolicy)

  await assert.rejects(
    agents.updateAgent({
      agentId: id, name: created.agent.name, description: created.agent.description,
      owner: created.agent.owner, department: created.agent.department, visibility: created.agent.visibility,
      roleIds: created.agent.roleIds, dataScopes: created.agent.dataScopes,
      welcomeMessage: created.agent.welcomeMessage, examplePrompts: created.agent.examplePrompts,
      systemPrompt: created.agent.systemPrompt, maxOutputBytes: created.agent.maxOutputBytes,
      maxToolCalls: created.agent.maxToolCalls, timeoutSeconds: created.agent.timeoutSeconds,
      skills: created.agent.skills, tools: created.agent.tools,
      delegationPolicy: { allowedAgentVersionIds: ['agent-version-not-published'], maxDepth: 1, maxParallel: 1, timeoutSeconds: 30 },
      changeSummary: '非法目标不得保存', actor: 'U00008',
    }),
    /委派目标必须是当前已发布的固定 Agent Version/,
  )
})

test('PF-06 creates one sessionless child on the root budget and returns only evidence-backed outcomes', async () => {
  const parent = await runningParent('result-contract', { max_parallel: 1 })
  const dispatched: Array<{ manifest: RuntimeManifest; authorization: RuntimeAuthorizationDecision }> = []
  let dispatches = 0
  let receiptMode: 'none' | 'completed' | 'mixed' | 'failed' = 'none'
  const service = delegationService(async input => {
    dispatches += 1
    const manifest = await startChild(input)
    dispatched.push({ manifest, authorization: input.authorization })
    await runs.appendSystemEvent({
      tenantId, runId: input.run.id, attemptId: manifest.attempt_id,
      eventType: 'assistant.completed', displayMessage: '子任务已给出文本答复。', traceId: manifest.trace_id!,
    })
    if (receiptMode !== 'none') {
      const operation = await tasks.acceptOperation({
        tenantId, taskId: input.run.taskId, runId: input.run.id, attemptId: manifest.attempt_id,
        operationKey: `delegated-operation-${randomUUID()}`, actionType: 'test-write', actionRef: 'test://verified',
        parameterDigest: 'a'.repeat(64), receipt: { accepted: true },
      })
      await tasks.resolveOperation({
        tenantId, operationId: operation.operation.id, status: 'completed', receipt: { completed: true },
      })
      if (receiptMode === 'mixed' || receiptMode === 'failed') {
        const unresolved = await tasks.acceptOperation({
          tenantId, taskId: input.run.taskId, runId: input.run.id, attemptId: manifest.attempt_id,
          operationKey: `delegated-unresolved-${randomUUID()}`, actionType: 'test-write',
          actionRef: receiptMode === 'mixed' ? 'test://unknown' : 'test://failed',
          parameterDigest: 'b'.repeat(64), receipt: { accepted: true },
        })
        await tasks.resolveOperation({
          tenantId, operationId: unresolved.operation.id,
          status: receiptMode === 'mixed' ? 'unknown' : 'failed',
          receipt: receiptMode === 'mixed' ? { unknown: true } : { failed: true },
          errorCode: receiptMode === 'failed' ? 'TEST_ACTION_FAILED' : null,
        })
      }
    }
    await runs.transitionAttempt(tenantId, manifest.attempt_id, 'succeeded')
    await runs.transitionRun(tenantId, input.run.id, 'succeeded')
  })

  const firstInput = { targetAgentVersionId, task: '形成只包含文本的分析结论', context: '只提供必要输入。' }
  const first = await service.delegate(firstInput, parent.manifest, new AbortController().signal)
  assert.equal(first.execution, 'succeeded')
  assert.equal(first.outcome, 'unverified', 'a model answer alone is not proof that the delegated goal was achieved')
  assert.deepEqual(first.receipts, [])
  assert.equal(dispatched[0]?.manifest.session_id, null)
  assert.equal(dispatched[0]?.manifest.budget.scope_task_id, parent.manifest.task_id)
  assert.deepEqual(dispatched[0]?.manifest.delegation_context?.role_ceiling, ['role-employee'])
  assert.deepEqual(dispatched[0]?.manifest.delegation_context?.data_scope_ceiling, ['enterprise:authorized', 'workspace:authorized'])
  assert.deepEqual(dispatched[0]?.authorization.roleIds, ['role-employee'])
  assert.deepEqual(dispatched[0]?.authorization.dataScopes, ['enterprise:authorized', 'workspace:authorized'])
  const childTask = await tasks.getTask(tenantId, first.childTaskId)
  assert.equal(childTask?.sourceType, 'delegation')
  assert.equal(childTask?.budgetScopeTaskId, parent.manifest.task_id)
  assert.equal(childTask?.sessionId, null)

  const replay = await service.delegate(firstInput, parent.manifest, new AbortController().signal)
  assert.deepEqual(replay, first)
  assert.equal(dispatches, 1, 'the same parent Attempt and request digest must not dispatch twice')

  receiptMode = 'completed'
  const verified = await service.delegate({
    targetAgentVersionId, task: '执行并登记一个可核验动作', context: '只提供动作所需参数。',
  }, parent.manifest, new AbortController().signal)
  assert.equal(verified.outcome, 'achieved')
  assert.ok(verified.receipts.some(receipt => receipt.kind === 'tool' && receipt.status === 'completed'))

  receiptMode = 'mixed'
  const unresolved = await service.delegate({
    targetAgentVersionId, task: '执行两个动作，其中一个结果仍未知', context: '只提供动作所需参数。',
  }, parent.manifest, new AbortController().signal)
  assert.equal(unresolved.outcome, 'unverified', 'one completed receipt must not hide an unresolved required action')
  assert.ok(unresolved.receipts.some(receipt => receipt.status === 'completed'))
  assert.ok(unresolved.receipts.some(receipt => receipt.status === 'unknown'))

  receiptMode = 'failed'
  const failed = await service.delegate({
    targetAgentVersionId, task: '执行两个动作，其中一个明确失败', context: '只提供动作所需参数。',
  }, parent.manifest, new AbortController().signal)
  assert.equal(failed.outcome, 'not_achieved', 'a failed required action must prevent achieved even with other completed evidence')
  assert.ok(failed.receipts.some(receipt => receipt.status === 'failed'))
  await finishRun(parent.run, 'cancelled')
})

test('PF-06 enforces target, depth, capacity and parent liveness and propagates cancellation', async () => {
  const parent = await runningParent('boundaries', { max_depth: 1, max_parallel: 1 })
  const started = deferred<RuntimeManifest>()
  const cancelled: string[] = []
  let activeAttemptId = ''
  const service = delegationService(async input => {
    const manifest = await startChild(input)
    activeAttemptId = manifest.attempt_id
    started.resolve(manifest)
  }, async runId => {
    cancelled.push(runId)
    const run = await runs.getRun(tenantId, runId)
    if (!run || !run.currentAttemptId || ['succeeded', 'failed', 'cancelled'].includes(run.status)) return
    await runs.transitionAttempt(tenantId, run.currentAttemptId, 'cancelled')
    await runs.transitionRun(tenantId, run.id, 'cancelled')
  })

  await assert.rejects(
    service.delegate({ targetAgentVersionId: 'agent-version-other', task: '越权目标' }, parent.manifest, new AbortController().signal),
    (error: unknown) => hasCode(error, 'permission_denied'),
  )
  const tooDeep = structuredClone(parent.manifest)
  tooDeep.delegation_context = {
    delegation_id: 'delegation-parent', root_task_id: parent.manifest.task_id,
    parent_task_id: 'task-grandparent', parent_run_id: 'run-grandparent', parent_attempt_id: 'attempt-grandparent',
    depth: 1, max_depth: 1, role_ceiling: ['role-employee'], data_scope_ceiling: ['enterprise:authorized', 'workspace:authorized'],
  }
  await assert.rejects(
    service.delegate({ targetAgentVersionId, task: '超过深度' }, tooDeep, new AbortController().signal),
    (error: unknown) => hasCode(error, 'DELEGATION_DEPTH_EXCEEDED'),
  )

  const pending = service.delegate({ targetAgentVersionId, task: '等待父任务取消' }, parent.manifest, new AbortController().signal)
  const childManifest = await started.promise
  await assert.rejects(
    service.delegate({ targetAgentVersionId, task: '并行上限内不能再创建第二个活动子任务' }, parent.manifest, new AbortController().signal),
    (error: unknown) => hasCode(error, 'DELEGATION_PARALLEL_LIMIT'),
  )
  await runs.transitionAttempt(tenantId, parent.manifest.attempt_id, 'failed', 'PARENT_FAILED')
  await runs.transitionRun(tenantId, parent.run.id, 'failed')
  await assert.rejects(service.assertActiveDelegation(childManifest), (error: unknown) => hasCode(error, 'permission_denied'))
  await service.cancelActiveDescendants(parent.manifest.task_id, '父任务已失败')
  const result = await pending
  assert.equal(result.outcome, 'not_achieved')
  assert.equal(result.execution, 'cancelled')
  assert.equal(cancelled.length, 1)
  assert.ok(activeAttemptId)

  const capacityParent = await runningParent('capacity')
  await database`update runtimes set capacity = 1 where tenant_id = ${tenantId} and id = 'runtime-local-01'`
  const capacityService = delegationService(async () => { throw new Error('must not dispatch') })
  await assert.rejects(
    capacityService.delegate({ targetAgentVersionId, task: '容量不足时不得创建子任务' }, capacityParent.manifest, new AbortController().signal),
    (error: unknown) => hasCode(error, 'DELEGATION_UNAVAILABLE'),
  )
  const [count] = await database<{ value: number }[]>`
    select count(*)::integer as value from task_delegations
     where tenant_id = ${tenantId} and parent_task_id = ${capacityParent.manifest.task_id}
  `
  assert.equal(count?.value, 0)
  await finishRun(capacityParent.run, 'cancelled')

  const firstFullParent = await runningParent('full-runtime-a')
  const secondFullParent = await runningParent('full-runtime-b')
  await database`update runtimes set capacity = 2 where tenant_id = ${tenantId} and id = 'runtime-local-01'`
  await assert.rejects(
    capacityService.delegate({ targetAgentVersionId, task: '两个父任务已占满容量时不得同步委派' }, firstFullParent.manifest, new AbortController().signal),
    (error: unknown) => hasCode(error, 'DELEGATION_UNAVAILABLE'),
  )
  await finishRun(firstFullParent.run, 'cancelled')
  await finishRun(secondFullParent.run, 'cancelled')
})

test('PF-06 reserves an admitted child slot from ordinary scheduler claims', async () => {
  const parent = await runningParent('reserved-child-slot')
  await database`update runtimes set capacity = 2 where tenant_id = ${tenantId} and id = 'runtime-local-01'`
  const queued = deferred<RuntimeManifest>()
  const service = delegationService(async input => {
    queued.resolve(await queueChild(input))
  })
  const pending = service.delegate(
    { targetAgentVersionId, task: '保留一个可领取的子任务席位' },
    parent.manifest,
    new AbortController().signal,
  )
  const child = await queued.promise
  const unrelated = await queuedStandaloneTask('must-not-steal-delegation-slot')

  assert.equal(await runs.isBlockedByDelegationReservation(tenantId, 'runtime-local-01'), true)
  assert.equal(
    await runs.claimAttempt(tenantId, unrelated.manifest.attempt_id, 'runtime-local-01'),
    false,
    'ordinary queued work must not consume a slot reserved for a synchronous delegated child',
  )
  assert.equal(await runs.claimAttempt(tenantId, child.attempt_id, 'runtime-local-01'), true)
  assert.equal(await runs.isBlockedByDelegationReservation(tenantId, 'runtime-local-01'), false,
    'a fully occupied Runtime is not a reservation-only scheduling block')
  await runs.transitionAttempt(tenantId, child.attempt_id, 'succeeded')
  await runs.transitionRun(tenantId, child.run_id, 'succeeded')
  assert.equal((await pending).execution, 'succeeded')
  await finishRun(parent.run, 'cancelled')
  await finishRun(unrelated.run, 'cancelled')
})

test('PF-06 scheduler scans past an ordinary queue head to start its reserved child', async () => {
  const parent = await runningParent('scheduler-reserved-child')
  await database`update runtimes set capacity = 2 where tenant_id = ${tenantId} and id = 'runtime-local-01'`
  const queued = deferred<RuntimeManifest>()
  const service = delegationService(async input => { queued.resolve(await queueChild(input)) })
  const pending = service.delegate(
    { targetAgentVersionId, task: '必须从队列第二位领取的子任务' }, parent.manifest, new AbortController().signal,
  )
  const child = await queued.promise
  const childRun = await runs.getRun(tenantId, child.run_id)
  assert.ok(childRun)
  const ordinary = await queuedStandaloneTask('ordinary-before-reserved-child')
  const executed: string[] = []
  const runtime: AgentRuntimePort = {
    async execute(manifest) {
      executed.push(manifest.run_id)
      const now = new Date().toISOString()
      return {
        runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now,
        done: Promise.resolve({
          runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'completed',
          acceptedAt: now, startedAt: now, endedAt: now, manifestSha256: 'test',
          attemptDirectory: '/tmp/test', errorCode: null, errorMessage: null,
        }),
      }
    },
    subscribe() { return () => undefined },
    async cancel() { return { accepted: false } },
    status() { return undefined },
    async health() { return {
      status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio', message: 'test',
    } },
    async close() {},
  }
  const orchestration = new RunOrchestrationService(
    runs, new PostgresConversationRepository(database),
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime, undefined, undefined, undefined, undefined, authorization, { tasks },
  )
  orchestration.setDelegationService(service)
  try {
    // Both entries are enqueued synchronously, so the actual scheduler pump sees
    // the ordinary Attempt first and must continue scanning after its failed claim.
    orchestration.enqueueResumedAttempt(ordinary.run, ordinary.manifest)
    orchestration.enqueueResumedAttempt(childRun, child)
    await waitUntil(async () => executed.includes(child.run_id), 'reserved child to reach Runtime')
    assert.deepEqual(executed, [child.run_id])
    assert.equal((await runs.getAttempt(tenantId, ordinary.manifest.attempt_id))?.status, 'queued')
    assert.equal((await runs.getAttempt(tenantId, child.attempt_id))?.status, 'running')
  } finally {
    await orchestration.close()
    await finishRun(childRun, 'cancelled')
    await pending
    await finishRun(ordinary.run, 'cancelled')
    await finishRun(parent.run, 'cancelled')
  }
})

test('PF-06 restart reconciliation cancels an orphan child whose parent Attempt is no longer active', async () => {
  const parent = await runningParent('restart-reconciliation')
  const started = deferred<RuntimeManifest>()
  const controller = new AbortController()
  const cancelled: string[] = []
  const service = delegationService(async input => {
    started.resolve(await startChild(input))
  }, async runId => {
    cancelled.push(runId)
    const run = await runs.getRun(tenantId, runId)
    if (!run?.currentAttemptId || ['succeeded', 'failed', 'cancelled'].includes(run.status)) return
    await runs.transitionAttempt(tenantId, run.currentAttemptId, 'cancelled')
    await runs.transitionRun(tenantId, run.id, 'cancelled')
  })

  const pending = service.delegate({ targetAgentVersionId, task: '等待服务恢复对账' }, parent.manifest, controller.signal)
  const child = await started.promise
  await runs.transitionAttempt(tenantId, parent.manifest.attempt_id, 'failed', 'SERVICE_RESTART')
  await runs.transitionRun(tenantId, parent.run.id, 'failed')

  const recovery = await service.reconcileAfterRestart()
  assert.deepEqual(recovery, { cancelled: 1, finalized: 0 })
  assert.deepEqual(cancelled, [child.run_id])
  const result = await pending
  assert.equal(result.execution, 'cancelled')
  assert.equal(result.outcome, 'not_achieved')
})

type DispatchInput = Parameters<NonNullable<Parameters<PostgresAgentDelegationService['setExecutor']>[0]['dispatchChild']>>[0]

function delegationService(
  dispatchChild: (input: DispatchInput) => Promise<void>,
  cancelRun: (runId: string, reason: string) => Promise<void> = async () => undefined,
) {
  const service = new PostgresAgentDelegationService(database, runs, tasks, authorization, taskQueries)
  service.setExecutor({ dispatchChild, cancelRun })
  return service
}

async function runningParent(label: string, policy: Partial<NonNullable<RuntimeManifest['delegation_policy']>> = {}) {
  await database`update runtimes set capacity = 4, scheduling_status = 'accepting' where tenant_id = ${tenantId} and id = 'runtime-local-01'`
  const unique = `${label}-${randomUUID()}`
  const task = await tasks.createTask({
    tenantId, requestedBy: 'U00001', sourceType: 'api', correlationKey: unique,
    workspaceId: 'ws-personal-U00001',
  })
  const run = await runs.createRun({
    tenantId, taskId: task.id, sessionId: null, workspaceId: task.workspaceId,
    requestedBy: task.requestedBy, idempotencyKey: unique,
  })
  const manifest = baseManifest(run, task.id, {
    allowed_agent_version_ids: [targetAgentVersionId], max_depth: 2, max_parallel: 2, timeout_seconds: 30,
    ...policy,
  })
  await createAttempt(run, manifest)
  return { run, manifest }
}

async function startChild(input: DispatchInput): Promise<RuntimeManifest> {
  const manifest = childManifest(input)
  await createAttempt(input.run, manifest)
  return manifest
}

async function queueChild(input: DispatchInput): Promise<RuntimeManifest> {
  const manifest = childManifest(input)
  await createQueuedAttempt(input.run, manifest)
  return manifest
}

function childManifest(input: DispatchInput): RuntimeManifest {
  return {
    manifest_version: '1.0', run_id: input.run.id, attempt_id: `attempt-${randomUUID()}`,
    task_id: input.run.taskId, session_id: null, workspace_id: input.workspaceId,
    agent_version_id: input.targetAgentVersionId,
    agent_configuration: { system_prompt: 'You are a bounded delegated child agent.', skill_instructions: [] },
    user_context: { user_id: input.userId, tenant_id: tenantId, role_ids: input.authorization.roleIds },
    permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [], tools: [], data_scopes: input.authorization.dataScopes, knowledge_context: [],
    delegation_context: input.delegation,
    input: { message: input.context ? `${input.prompt}\n${input.context}` : input.prompt, file_mounts: [] },
    budget: budget(input.delegation.root_task_id),
    limits: { timeout_seconds: 30, max_tool_calls: 2, max_output_bytes: 4096 },
    created_at: new Date().toISOString(), trace_id: `trace-${randomUUID()}`,
  }
}

async function queuedStandaloneTask(label: string) {
  const unique = `${label}-${randomUUID()}`
  const task = await tasks.createTask({
    tenantId, requestedBy: 'U00001', sourceType: 'api', correlationKey: unique,
    workspaceId: 'ws-personal-U00001',
  })
  const run = await runs.createRun({
    tenantId, taskId: task.id, sessionId: null, workspaceId: task.workspaceId,
    requestedBy: task.requestedBy, idempotencyKey: unique,
  })
  const manifest = baseManifest(run, task.id, {
    allowed_agent_version_ids: [], max_depth: 1, max_parallel: 1, timeout_seconds: 30,
  })
  manifest.tools = []
  delete manifest.delegation_policy
  await createQueuedAttempt(run, manifest)
  return { run, manifest }
}

function baseManifest(run: RunRecord, taskId: string, policy: NonNullable<RuntimeManifest['delegation_policy']>): RuntimeManifest {
  return {
    manifest_version: '1.0', run_id: run.id, attempt_id: `attempt-${randomUUID()}`,
    task_id: taskId, session_id: null, workspace_id: 'ws-personal-U00001',
    agent_version_id: targetAgentVersionId,
    agent_configuration: { system_prompt: 'You are a governed parent agent.', skill_instructions: [] },
    user_context: { user_id: 'U00001', tenant_id: tenantId, role_ids: ['role-employee'] },
    permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [], tools: [{ id: 'delegate_agent', version: '1.0.0' }],
    data_scopes: ['enterprise:authorized', 'workspace:authorized'], knowledge_context: [], delegation_policy: policy,
    input: { message: 'Delegate a bounded task.', file_mounts: [] },
    budget: budget(taskId), limits: { timeout_seconds: 30, max_tool_calls: 2, max_output_bytes: 4096 },
    created_at: new Date().toISOString(), trace_id: `trace-${randomUUID()}`,
  }
}

function budget(scopeTaskId: string): RuntimeManifest['budget'] {
  return {
    scope_task_id: scopeTaskId,
    cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
    reservation: { duration_ms: 30_000, tool_calls: 2, output_bytes: 4096 },
    enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
  }
}

async function createAttempt(run: RunRecord, manifest: RuntimeManifest) {
  await createQueuedAttempt(run, manifest)
  await runs.transitionAttempt(tenantId, manifest.attempt_id, 'running')
  await runs.transitionRun(tenantId, run.id, 'running')
}

async function createQueuedAttempt(run: RunRecord, manifest: RuntimeManifest) {
  const compiled = compileRuntimeManifest(manifest)
  await runs.createAttempt({
    attemptId: manifest.attempt_id, tenantId, runId: run.id, runtimeId: 'runtime-local-01',
    manifest: JSON.parse(compiled.canonicalJson) as JsonObject, manifestSha256: compiled.sha256,
    modelRouteSnapshot: {},
  })
}

async function finishRun(run: RunRecord, status: 'failed' | 'cancelled') {
  const current = await runs.getRun(tenantId, run.id)
  if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return
  if (current.currentAttemptId) {
    const attempt = await runs.getAttempt(tenantId, current.currentAttemptId)
    if (attempt && !['succeeded', 'failed', 'cancelled'].includes(attempt.status)) {
      await runs.transitionAttempt(tenantId, attempt.id, status, status === 'failed' ? 'TEST_FAILURE' : undefined)
    }
  }
  await runs.transitionRun(tenantId, current.id, status)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function waitUntil(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待 ${description} 超时`)
}

function hasCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
