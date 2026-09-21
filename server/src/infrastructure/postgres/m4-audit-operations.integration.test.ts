import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { AuthorizationDeniedError } from '../../modules/authorization/authorization-errors.ts'
import { classifyHttpError } from '../../http/router.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { testAttemptManifest } from './test-attempt-manifest.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let operations: PostgresOperationsService
let runId = ''
let attemptId = ''

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_audit_test', maxConnections: 4 })
  database = throwaway.client
  operations = new PostgresOperationsService(database)

  const conversations = new PostgresConversationRepository(database)
  const runs = new PostgresRunRepository(database)
  const session = await conversations.createSession({
    userId: 'U00001',
    title: 'M4 审计运营验证',
    workspaceId: 'ws-supply',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: session.id,
    requestedBy: 'U00001',
    idempotencyKey: randomUUID(),
  })
  runId = run.id
  attemptId = `attempt-audit-${randomUUID()}`
  await runs.createAttempt({
    attemptId,
    tenantId: 'tenant-dsh-work',
    runId,
    runtimeId: 'runtime-local-01',
    manifest: testAttemptManifest(run.taskId, run.id),
    manifestSha256: randomUUID().replaceAll('-', ''),
    modelRouteSnapshot: { providerKey: 'dsh-default', modelKey: 'dsh-default' },
  })

  await database`
    insert into run_events (
      id, tenant_id, run_id, attempt_id, sequence, event_type, display_message,
      safe_metadata, trace_id, occurred_at
    ) values (
      ${`event-${randomUUID()}`}, 'tenant-dsh-work', ${runId}, ${attemptId}, 1,
      'run.failed', '不得进入运营投影的回答正文',
      ${database.json({ error_code: 'SYNTHETIC_FAILURE' })}, ${`trace-${runId}`}, now()
    )
  `
  await database`
    insert into model_usage_events (
      id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
      latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
    ) values (
      ${`usage-${randomUUID()}`}, 'tenant-dsh-work', ${runId}, ${attemptId},
      'dsh-default', 'dsh-default', 12, 8, 120, 0, 'CNY', 'failed',
      ${`trace-${runId}`}, true, now()
    )
  `
  await operations.recordToolAudit({
    runId,
    attemptId,
    traceId: `trace-${runId}`,
    metadata: { tool_name: 'read', parameter_kind: 'workspace_path' },
    result: 'blocked',
  })

  const fileId = `file-audit-${randomUUID()}`
  const artifactId = `artifact-audit-${randomUUID()}`
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name,
      mime_type, size_bytes, sha256, scan_status, uploaded_by
    ) values (
      ${fileId}, 'tenant-dsh-work', 'ws-supply', ${session.id}, ${`audit/${fileId}`},
      '运营验证.txt', 'text/plain', 16, ${randomUUID().replaceAll('-', '')}, 'clean', 'U00008'
    )
  `
  await database`
    insert into artifacts (id, tenant_id, workspace_id, session_id, name, artifact_type, created_by)
    values (${artifactId}, 'tenant-dsh-work', 'ws-supply', ${session.id}, '运营验证成果', 'text', 'U00001')
  `
  await database`
    insert into artifact_versions (
      id, tenant_id, artifact_id, version_no, file_object_id, source_run_id
    ) values (
      ${`artifact-version-${randomUUID()}`}, 'tenant-dsh-work', ${artifactId}, 1, ${fileId}, ${runId}
    )
  `
  await runs.transitionAttempt('tenant-dsh-work', attemptId, 'failed', 'SYNTHETIC_FAILURE')
  await runs.transitionRun('tenant-dsh-work', runId, 'failed')
})

after(async () => {
  await throwaway.dispose()
})

test('unified operations projection includes every MVP event source without content bodies', async () => {
  await operations.appendAudit(
    'U00008',
    'agent.configuration.update',
    'agent-dsh-work-assistant',
    'success',
    'trace-agent-audit-test',
    '仅允许安全配置摘要',
  )

  const events = await operations.getAuditEvents()
  const categories = new Set(events.items.map((event) => event.category))
  assert.ok(categories.has('management'))
  assert.ok(categories.has('run'))
  assert.ok(categories.has('model'))
  assert.ok(categories.has('tool'))
  assert.ok(categories.has('artifact'))

  const agentEvent = events.items.find((event) => event.action === 'agent.configuration.update')
  assert.equal(agentEvent?.objectType, 'agent')

  const serialized = JSON.stringify(events.items)
  assert.doesNotMatch(serialized, /不得进入运营投影的回答正文/)
  assert.match(serialized, /SYNTHETIC_FAILURE/)
})

test('run drill-down is scoped to one run and exposes traceable safe metadata', async () => {
  const events = await operations.getRunOperations(runId)
  assert.ok(events.length >= 4)
  assert.ok(events.every((event) => event.runId === runId))
  assert.ok(events.some((event) => event.attemptId === attemptId && event.category === 'model'))
  assert.ok(events.some((event) => event.status === 'blocked' && event.category === 'tool'))
  const [toolAudit] = await database<{ toolVersionId: string }[]>`
    select tool_version_id as "toolVersionId" from tool_audit_logs
     where tenant_id = 'tenant-dsh-work' and run_id = ${runId} and attempt_id = ${attemptId}
     order by occurred_at desc limit 1
  `
  assert.equal(toolAudit?.toolVersionId, 'tool-version-read-1')
  await assert.rejects(operations.getRunOperations('run-does-not-exist'), /Run 不存在/)
})

test('24-hour operations summary is calculated from persisted facts', async () => {
  const summary = await operations.getOperationsSummary()
  assert.ok(summary.runs24h >= 1)
  assert.ok(summary.modelTokens24h >= 20)
  assert.ok(summary.toolCalls24h >= 1)
  assert.ok(summary.artifacts24h >= 1)
  assert.ok(summary.attentionEvents24h >= 3)
})

test('5-T4 管理操作人校验类型化：仍映射为 403 permission_denied', async () => {
  // 本套件的 operations 未注入 authorization，因此走的是它自己的 requirePlatformAdmin 分支。
  const denial = await operations.updateRuntimeConfiguration({
    runtimeId: 'runtime-local-01',
    maxConcurrentWorkers: 2,
    attemptTimeoutMinutes: 2,
    schedulingStatus: 'accepting',
    actor: 'U00001',
  }).then(() => null, (error: unknown) => error)

  assert.ok(denial instanceof AuthorizationDeniedError, `必须是类型化授权拒绝，实际：${String(denial)}`)
  assert.equal(denial.status, 403)
  assert.equal(denial.code, 'permission_denied')
  assert.match(denial.message, /不是平台管理员/)
  const mapped = classifyHttpError(denial, '/api/admin/v1/runtimes/runtime-local-01/check')
  assert.equal(mapped.status, 403)
  assert.equal(mapped.error.code, 'permission_denied')
})

test('admin list endpoints paginate and filter on the server', async () => {
  const sessionPage = await operations.getSessions({ page: 1, pageSize: 1 })
  assert.ok(sessionPage.total >= 1)
  assert.equal(sessionPage.items.length, 1)
  assert.ok(sessionPage.summary.total >= sessionPage.total)
  assert.ok(sessionPage.facets.workspaces.some((workspace) => workspace.id === 'ws-supply'))

  const byTrace = await operations.getSessions({ query: `trace-${runId}` })
  assert.ok(byTrace.items.some((session) => session.runId === runId))
  const empty = await operations.getSessions({ query: `trace-${runId}`, status: 'succeeded' })
  assert.ok(empty.items.every((session) => session.status === 'succeeded'))

  const auditPage = await operations.getAuditEvents({ page: 2, pageSize: 2 })
  assert.ok(auditPage.total >= 4)
  assert.equal(auditPage.items.length, 2)
  const firstPage = await operations.getAuditEvents({ page: 1, pageSize: 2 })
  assert.ok(firstPage.items.every((item) => auditPage.items.every((other) => other.id !== item.id)))
  const filtered = await operations.getAuditEvents({ query: `trace-${runId}` })
  assert.ok(filtered.items.some((event) => event.runId === runId))
  assert.ok(filtered.total <= auditPage.total)

  const usagePage = await operations.getModelUsage({ status: 'failed' })
  assert.ok(usagePage.items.some((record) => record.runId === runId))
  assert.ok(usagePage.items.every((record) => record.status === 'failed'))
  assert.ok(usagePage.summary.callCount >= 1)
  assert.ok(usagePage.facets.employees.some((employee) => employee.employeeId === 'U00001'))

  const employeePage = await operations.getModelUsageEmployees({ page: 1, pageSize: 10 })
  const owner = employeePage.items.find((item) => item.employeeId === 'U00001')
  assert.ok(owner && owner.failedCount >= 1 && owner.callCount >= owner.failedCount)
})
