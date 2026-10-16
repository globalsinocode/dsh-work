import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import type { DatabaseClient } from './database.ts'
import { AgentRoutineService } from '../../modules/automation/agent-routine-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresTaskRepository } from '../../modules/task/postgres-task-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { AgentRuntimePort, RuntimeExecutionHandle, RuntimeExecutionSnapshot, RuntimeHealth, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import { assertCurrentExecutionAuthorization } from '../../modules/run/current-execution-authorization.ts'

const tenantId = 'tenant-dsh-work'
const agentId = 'agent-dsh-work-assistant'
const versionId = 'agent-version-dsh-work-assistant-1'
let throwaway: ThrowawayDatabase
let database: DatabaseClient
let service: AgentRoutineService
let authorization: PostgresAuthorizationService
let orchestration: RunOrchestrationService
let runs: PostgresRunRepository

class HoldingRuntime implements AgentRuntimePort {
  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    return { runId: manifest.run_id, attemptId: manifest.attempt_id,
      acceptedAt: new Date().toISOString(), done: new Promise(() => undefined) }
  }
  subscribe() { return () => undefined }
  async cancel() { return { accepted: false } }
  status(): RuntimeExecutionSnapshot | undefined { return undefined }
  async health(): Promise<RuntimeHealth> {
    return { status: 'healthy', runtimeId: 'runtime-agent-routine-test', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio', message: 'test' }
  }
  async close() {}
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_routine', maxConnections: 8 })
  database = throwaway.client
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values ('U00002', ${tenantId}, 'directory:routine-recipient-U00002', '主动任务新接收人', 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, 'U00002', 'role-employee', 'local')
  `
  authorization = new PostgresAuthorizationService(database)
  runs = new PostgresRunRepository(database)
  const conversations = new PostgresConversationRepository(database)
  orchestration = new RunOrchestrationService(runs, conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    new HoldingRuntime(), undefined, undefined, new PostgresAgentService(database),
    undefined, authorization, { tasks: new PostgresTaskRepository(database) })
  service = new AgentRoutineService(database, authorization, runs, orchestration, conversations)
})
after(async () => { await throwaway?.dispose() })

test('AE-05 Agent routine pins Agent initiator, recipient, version and budget without a Session', async () => {
  const [workspace] = await database<{ id: string }[]>`
    select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = 'U00001'
  `
  assert.ok(workspace)
  const routine = await service.create('U00008', {
    agentId, agentVersionId: versionId, workspaceId: workspace.id, recipientUserId: 'U00001',
    name: 'Agent 日常巡检', schedule: { kind: 'manual', timezone: 'Asia/Shanghai' },
    inputTemplate: { prompt: '核对今日事项', budget: { maxToolCalls: 3 } },
  })
  assert.equal(routine.status, 'draft')
  await assert.rejects(service.runNow('U00008', agentId, routine.id, 'before-enable'),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'state_conflict')
  await assert.rejects(service.enable('U00008', agentId, routine.id, {
    expectedRevision: routine.revision, roleIds: ['role-not-granted'], dataScopes: ['enterprise:authorized', 'workspace:authorized'],
  }))
  const enabled = await service.enable('U00008', agentId, routine.id, {
    expectedRevision: routine.revision, roleIds: ['role-employee'], dataScopes: ['enterprise:authorized', 'workspace:authorized'],
  })
  assert.equal(enabled.status, 'enabled')
  const first = await service.runNow('U00008', agentId, routine.id, 'trigger-1')
  assert.equal(first.admissionStatus, 'accepted')
  assert.ok(first.runId)
  assert.deepEqual(await service.runNow('U00008', agentId, routine.id, 'trigger-1'), first)
  const overlap = await service.runNow('U00008', agentId, routine.id, 'trigger-2')
  assert.equal(overlap.admissionStatus, 'skipped')
  assert.equal(overlap.reasonCode, 'overlap')
  const [row] = await database<{
    initiatedBy: string; executedAs: string; requestedBy: string; sessionId: string | null;
    sourceType: string; manifest: RuntimeManifest
  }[]>`
    select task.initiated_by_principal_id as "initiatedBy", task.executed_as_principal_id as "executedAs",
      task.requested_by as "requestedBy", task.source_type as "sourceType", run.session_id as "sessionId",
      attempt.manifest
      from runs run join tasks task on task.tenant_id = run.tenant_id and task.id = run.task_id
      join run_attempts attempt on attempt.tenant_id = run.tenant_id and attempt.run_id = run.id
     where run.tenant_id = ${tenantId} and run.id = ${first.runId}
  `
  assert.equal(row?.initiatedBy, row?.executedAs)
  assert.notEqual(row?.initiatedBy, 'principal-human-U00001')
  assert.equal(row?.requestedBy, 'U00001')
  assert.equal(row?.sourceType, 'agent_routine')
  assert.equal(row?.sessionId, null)
  assert.equal(row?.manifest.purpose, 'agent-routine')
  assert.equal(row?.manifest.agent_version_id, versionId)
  await assertCurrentExecutionAuthorization(authorization, undefined, row!.manifest)
  await service.setStatus('U00008', agentId, routine.id, 'paused')
  await assert.rejects(assertCurrentExecutionAuthorization(authorization, undefined, row!.manifest))
  await service.setStatus('U00008', agentId, routine.id, 'disabled')
  const run = await runs.getRun(tenantId, first.runId!)
  assert.ok(run?.currentAttemptId)
  await runs.transitionAttempt(tenantId, run.currentAttemptId, 'cancelled')
  await runs.transitionRun(tenantId, run.id, 'cancelled')
  await assert.rejects(orchestration.retry(run.id, 'U00001'),
    /Agent 主动任务不支持通用重试/)
  const [attemptCount] = await database<{ count: number }[]>`
    select count(*)::integer as count from run_attempts where tenant_id = ${tenantId} and run_id = ${run.id}
  `
  assert.equal(attemptCount?.count, 1)
  await assert.rejects(service.enable('U00008', agentId, routine.id, {
    expectedRevision: routine.revision, roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized', 'workspace:authorized'],
  }))
})

test('AE-05 event replay is idempotent and historical results stay with the original recipient', async () => {
  const [workspace] = await database<{ id: string }[]>`
    select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = 'U00001'
  `
  const draft = await service.create('U00008', {
    agentId, agentVersionId: versionId, workspaceId: workspace!.id, recipientUserId: 'U00001',
    name: '事件处理', schedule: { kind: 'event', eventType: 'inventory.changed', timezone: 'Asia/Shanghai' },
    inputTemplate: { prompt: '处理库存变化' },
  })
  await service.enable('U00008', agentId, draft.id, {
    expectedRevision: draft.revision, roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized', 'workspace:authorized'],
  })
  await assert.rejects(service.triggerEvent('U00008', agentId, draft.id, {
    eventType: 'wrong.event', source: 'test', eventId: '1',
  }))
  const first = await service.triggerEvent('U00008', agentId, draft.id, {
    eventType: 'inventory.changed', source: 'test', eventId: '1',
  })
  assert.equal(first.admissionStatus, 'accepted')
  assert.deepEqual(first.triggerEvidence, {
    actorUserId: 'U00008', eventType: 'inventory.changed', source: 'test', eventId: '1',
  })
  const replay = await service.triggerEvent('U00008', agentId, draft.id, {
    eventType: 'inventory.changed', source: 'test', eventId: '1',
  })
  assert.deepEqual(replay, first)
  const [concurrentA, concurrentB] = await Promise.all([
    service.triggerEvent('U00008', agentId, draft.id, {
      eventType: 'inventory.changed', source: 'test', eventId: 'concurrent',
    }),
    service.triggerEvent('U00008', agentId, draft.id, {
      eventType: 'inventory.changed', source: 'test', eventId: 'concurrent',
    }),
  ])
  assert.deepEqual(concurrentA, concurrentB)
  assert.equal(concurrentA.reasonCode, 'overlap')
  assert.equal((await service.recipientResults('U00001')).some(result => result.runId === first.runId), true)
  assert.equal((await service.recipientResults('U00002')).some(result => result.runId === first.runId), false)
  const [attempt] = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts where tenant_id = ${tenantId} and run_id = ${first.runId}
  `
  await database`
    insert into run_events (id, tenant_id, run_id, attempt_id, sequence, event_type,
      display_message, trace_id, occurred_at)
    values (${`event-${first.id}`}, ${tenantId}, ${first.runId}, ${attempt!.manifest.attempt_id}, 1,
      'assistant.completed', '已完成测试巡检', ${`trace-${first.runId}`}, now())
  `
  assert.equal((await service.recipientResults('U00001')).find(item => item.runId === first.runId)?.answer,
    '已完成测试巡检')
  await database`update roles set status = 'disabled' where tenant_id = ${tenantId} and id = 'role-employee'`
  try {
    assert.equal((await service.recipientResults('U00001')).some(item => item.runId === first.runId), false)
  } finally {
    await database`update roles set status = 'active' where tenant_id = ${tenantId} and id = 'role-employee'`
  }
  await database`update execution_principals set status = 'disabled'
    where tenant_id = ${tenantId} and agent_id = ${agentId} and kind = 'agent'`
  try {
    await assert.rejects(assertCurrentExecutionAuthorization(authorization, undefined, attempt!.manifest))
    const skipped = await service.triggerEvent('U00008', agentId, draft.id, {
      eventType: 'inventory.changed', source: 'test', eventId: '2',
    })
    assert.equal(skipped.reasonCode, 'overlap')
  } finally {
    await database`update execution_principals set status = 'active'
      where tenant_id = ${tenantId} and agent_id = ${agentId} and kind = 'agent'`
  }
  const [newWorkspace] = await database<{ id: string }[]>`
    select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = 'U00002'
  `
  assert.ok(newWorkspace)
  const paused = await service.setStatus('U00008', agentId, draft.id, 'paused')
  await service.update('U00008', agentId, draft.id, {
    expectedRevision: paused.revision, recipientUserId: 'U00002', workspaceId: newWorkspace.id,
  })
  assert.equal((await service.recipientResults('U00002')).some(item => item.runId === first.runId), false)
  const original = (await service.recipientResults('U00001')).find(item => item.runId === first.runId)
  assert.equal(original?.workspaceId, workspace!.id)
  assert.equal(original?.answer, '已完成测试巡检')
})

test('AE-05 old scheduled slots are recorded as missed and never backfilled', async () => {
  const [workspace] = await database<{ id: string }[]>`
    select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = 'U00001'
  `
  const draft = await service.create('U00008', {
    agentId, agentVersionId: versionId, workspaceId: workspace!.id, recipientUserId: 'U00001',
    name: '定时巡检', schedule: { kind: 'daily', timezone: 'Asia/Shanghai', timeOfDay: '09:00' },
    inputTemplate: { prompt: '检查事项' },
  })
  const unchangedSchedule = await service.update('U00008', agentId, draft.id, {
    expectedRevision: draft.revision,
    schedule: { timezone: 'Asia/Shanghai', timeOfDay: '09:00', kind: 'daily' },
  })
  assert.equal(unchangedSchedule.scheduleRevision, draft.scheduleRevision)
  await service.enable('U00008', agentId, draft.id, {
    expectedRevision: unchangedSchedule.revision, roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized', 'workspace:authorized'],
  })
  const stale = new Date(Date.now() - 48 * 60 * 60 * 1000)
  await database`update agent_routines set next_slot_utc = ${stale} where id = ${draft.id}`
  await service.processDue(new Date())
  const executions = await service.executions('U00008', agentId, draft.id)
  assert.equal(executions.some(item => item.kind === 'missed' && item.reasonCode === 'slot_expired'), true)
  assert.equal(executions.some(item => item.admissionStatus === 'accepted'), false)
})
