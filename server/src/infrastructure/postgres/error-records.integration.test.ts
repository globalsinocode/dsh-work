import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'

import { fingerprintOf, parseClientErrorBatch, type ErrorRecordInput } from '../../modules/observability/client-error-report.ts'
import { PostgresErrorRecordsService } from '../../modules/observability/postgres-error-records-service.ts'
import { serverFailureRecord } from '../../modules/observability/server-failure-records.ts'
import { NEW_GROUPS_PER_HOUR } from '../../domain/error-records.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

/**
 * 错误记录（OBS-E2E-02、OBS-E2E-03 的 PostgreSQL 部分）：归并、去重、统计、链路编号与运行的关联、
 * 运行问题、新增问题组上限与清理。
 */
const tenantId = 'tenant-dsh-work'
let throwaway: ThrowawayDatabase
let database: DatabaseClient
let records: PostgresErrorRecordsService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_error_records', maxConnections: 4 })
  database = throwaway.client
  records = new PostgresErrorRecordsService(database, {
    resolveStack: async stack => ({ stack: stack.replace('index-aaaaaaaa.js:1:5', 'src/views/ConversationView.vue:312:9'), resolved: true }),
  })
})

after(async () => {
  await throwaway.dispose()
})

beforeEach(async () => {
  await database`delete from error_groups where tenant_id = ${tenantId}`
})

function clientRecord(overrides: Partial<ErrorRecordInput> = {}): ErrorRecordInput {
  const { reports: [report] } = parseClientErrorBatch({ app: 'workbench', reports: [{
    kind: 'render', message: overrides.message ?? "Cannot read properties of undefined (reading 'artifacts')",
    stack: overrides.stack === null ? undefined : overrides.stack ?? '    at render (https://w/assets/index-aaaaaaaa.js:1:5)', route: 'conversation', release: '2026.11.26-01',
  }] })
  return { ...report!, source: 'workbench', client: 'Chrome 131 / macOS', userId: 'U00001', ...overrides } as ErrorRecordInput
}

async function seedRun(input: { status: 'succeeded' | 'failed' | 'cancelled'; errorCode?: string; answer?: string; daysAgo?: number }) {
  const runId = `run-err-${randomUUID()}`
  const attemptId = `attempt-err-${randomUUID()}`
  const sessionId = `session-err-${randomUUID()}`
  const createdAt = database`now() - make_interval(days => ${input.daysAgo ?? 0})`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, 'ws-personal-U00001', 'U00001', 'agent-version-dsh-work-assistant-1', '错误记录测试', 'active')
  `
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, created_at, updated_at)
    values (${runId}, ${tenantId}, ${sessionId}, 'U00001', ${`idem-${runId}`}, ${input.status}, ${createdAt}, ${createdAt})
  `
  await database`
    insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status, error_code)
    values (${attemptId}, ${tenantId}, ${runId}, 1, ${database.json({ agent_version_id: 'agent-version-dsh-work-assistant-1' })}, 'sha256-test',
            ${database.json({ routeKey: 'default' })}, ${input.status}, ${input.errorCode ?? null})
  `
  await database`update runs set current_attempt_id = ${attemptId} where tenant_id = ${tenantId} and id = ${runId}`
  if (input.answer !== undefined) {
    await database`
      insert into messages (id, tenant_id, session_id, run_id, role, content)
      values (${`msg-${randomUUID()}`}, ${tenantId}, ${sessionId}, ${runId}, 'assistant', ${input.answer})
    `
  }
  return { runId, attemptId }
}

async function toolEvent(runId: string, attemptId: string, sequence: number, tool: string, errorCode: string) {
  await database`
    insert into run_events (id, tenant_id, run_id, attempt_id, sequence, event_type, safe_metadata, trace_id, occurred_at)
    values (${`evt-${randomUUID()}`}, ${tenantId}, ${runId}, ${attemptId}, ${sequence}, 'tool.completed',
            ${database.json({ tool_name: tool, status: 'failed', error_code: errorCode })}, ${`trace-${runId}`}, now())
  `
}

test('reports of the same problem merge, repeats within a minute only add to the count', async () => {
  await records.record(clientRecord({ count: 2 }))
  await records.record(clientRecord({ message: "Cannot read properties of undefined (reading 'files')" }))
  await records.record(clientRecord({ userId: 'U00002' }))
  await records.record(clientRecord({ userId: null }))

  const list = await records.listGroups({ range: '7d', includeNotice: false, sort: 'recent' })
  assert.equal(list.items.length, 1)
  const [group] = list.items
  assert.equal(group!.count, 5)
  assert.equal(group!.people, 2)
  assert.equal(group!.anonymous, true)
  assert.equal(group!.route, 'conversation')
  assert.deepEqual(list.releases, ['2026.11.26-01'])

  const samples = await database<{ repeatCount: number }[]>`
    select repeat_count as "repeatCount" from error_occurrences where tenant_id = ${tenantId} order by repeat_count desc`
  assert.deepEqual(samples.map(row => row.repeatCount), [3, 1, 1])

  const detail = await records.getGroup(group!.id, '7d')
  assert.equal(detail!.samples.length, 3)
  assert.equal(detail!.stackResolved, true)
  assert.match(detail!.stack!, /ConversationView\.vue:312:9/)
  assert.equal(detail!.samples.find(sample => sample.userId === 'U00001')?.userName !== undefined, true)
  assert.equal(detail!.count, 5)
  assert.equal(detail!.totalCount, 5)
  assert.equal(await records.getGroup('err-missing', '7d'), null)
  // 详情的次数与列表同一周期口径，累计次数另给。
  await database`update error_occurrences set occurred_at = now() - interval '10 days' where tenant_id = ${tenantId} and repeat_count = 3`
  const week = await records.getGroup(group!.id, '7d')
  assert.deepEqual([week!.count, week!.totalCount, week!.people], [2, 5, 1])
  assert.equal((await records.getGroup(group!.id, '30d'))!.count, 5)
})

test('filters: notices are hidden by default, source and sort apply', async () => {
  const { reports: [notice] } = parseClientErrorBatch({ app: 'workbench', reports: [{ kind: 'notice', code: 'forbidden', template: 'project.open', route: 'project-space' }] })
  await records.record({ ...notice!, source: 'workbench', client: null, userId: 'U00001' })
  await records.record(clientRecord())
  await records.record(serverFailureRecord({ traceId: 'trace-http-11111111-2222-3333-4444-555555555555', method: 'GET',
    routePath: '/api/workbench/v1/runs/:runId/events', status: 500, code: 'operation_failed', errorMessage: 'db down', params: {}, userId: 'U00001' }, null))

  const defaults = await records.listGroups({ range: '7d', includeNotice: false, sort: 'recent' })
  assert.equal(defaults.items.length, 2)
  assert.ok(defaults.items.every(item => item.kind !== 'notice'))
  const withNotice = await records.listGroups({ range: '7d', includeNotice: true, sort: 'count' })
  assert.equal(withNotice.items.length, 3)
  const server = await records.listGroups({ range: '7d', source: 'server', includeNotice: true, sort: 'recent' })
  assert.deepEqual(server.items.map(item => item.source), ['server'])
  assert.equal(server.items[0]!.route, 'GET /api/workbench/v1/runs/:runId/events')
})

test('trace and run lookup link server failures, browser reports and the run only through the sample run id', async () => {
  const { runId } = await seedRun({ status: 'failed', errorCode: 'RUN_TIMEOUT' })
  const traceId = 'trace-http-7c1e9d20-0f3b-4a8e-9b61-5d2c88e4b42a'
  await records.record(serverFailureRecord({ traceId, method: 'GET', routePath: '/api/workbench/v1/runs/:runId/events',
    status: 500, code: 'operation_failed', errorMessage: 'boom', params: { runId }, userId: 'U00001' }, '2026.11.26-01'))
  await records.record(clientRecord({ kind: 'api', traceId, stack: null, fingerprint: fingerprintOf(['api-test']) }))

  const byTrace = await records.lookup(traceId)
  assert.equal(byTrace.kind, 'trace')
  assert.equal(byTrace.serverFailures.length, 1)
  assert.equal(byTrace.clientReports.length, 1)
  assert.deepEqual(byTrace.runs.map(run => [run.runId, run.status, run.errorCode]), [[runId, 'failed', 'RUN_TIMEOUT']])

  for (const query of [runId, `trace-${runId}`]) {
    const byRun = await records.lookup(query)
    assert.equal(byRun.kind, 'run')
    assert.equal(byRun.runs[0]!.runId, runId)
    assert.equal(byRun.serverFailures.length, 1)
  }

  // 没有运行编号的接口失败只显示接口与浏览器两侧。
  const unlinked = 'trace-http-99999999-2222-3333-4444-555555555555'
  await records.record(serverFailureRecord({ traceId: unlinked, method: 'GET', routePath: '/api/workbench/v1/sessions',
    status: 500, code: 'operation_failed', errorMessage: 'x', params: {}, userId: null }, null))
  assert.deepEqual((await records.lookup(unlinked)).runs, [])
  assert.equal((await records.lookup('run-does-not-exist')).kind, 'unknown')
  assert.equal((await records.lookup("x'; drop table runs; --")).kind, 'unknown')
})

test('run problems count failures, timeouts, cancellations, empty answers and tool failures', async () => {
  // 其他用例也会写入运行：按差值断言。
  const before = await records.runProblems('7d')
  const before90 = await records.runProblems('90d')
  const reasonRuns = (summary: typeof before, code: string) => summary.reasons.find(reason => reason.code === code)?.runs ?? 0
  const toolCounts = (summary: typeof before, tool: string) => {
    const row = summary.tools.find(item => item.tool === tool)
    return [row?.failed ?? 0, row?.denied ?? 0]
  }
  await seedRun({ status: 'failed', errorCode: 'RUN_TIMEOUT' })
  await seedRun({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
  await seedRun({ status: 'cancelled' })
  await seedRun({ status: 'succeeded', answer: '   ' })
  await seedRun({ status: 'succeeded', answer: '正常回答' })
  await seedRun({ status: 'failed', errorCode: 'RUN_TIMEOUT', daysAgo: 40 })
  const tooled = await seedRun({ status: 'succeeded', answer: '有回答' })
  await toolEvent(tooled.runId, tooled.attemptId, 1, 'bash', 'TOOL_TIMEOUT')
  await toolEvent(tooled.runId, tooled.attemptId, 2, 'bash', 'TOOL_PERMISSION_DENIED')
  await toolEvent(tooled.runId, tooled.attemptId, 3, 'web_fetch', 'TOOL_PERMISSION_DENIED')

  const summary = await records.runProblems('7d')
  assert.equal(summary.totalRuns - before.totalRuns, 6)
  assert.equal(summary.failed - before.failed, 2)
  assert.equal(summary.timedOut - before.timedOut, 1)
  assert.equal(summary.cancelled - before.cancelled, 1)
  assert.equal(summary.emptyAnswer - before.emptyAnswer, 1)
  for (const code of ['RUN_TIMEOUT', 'RUNTIME_UNAVAILABLE', 'CANCELLED', 'EMPTY_ANSWER']) {
    assert.equal(reasonRuns(summary, code) - reasonRuns(before, code), 1, code)
  }
  assert.equal(summary.reasons.find(reason => reason.code === 'EMPTY_ANSWER')!.label, '成功但没有回答')
  assert.deepEqual(toolCounts(summary, 'bash').map((value, index) => value - toolCounts(before, 'bash')[index]!), [1, 1])
  assert.deepEqual(toolCounts(summary, 'web_fetch').map((value, index) => value - toolCounts(before, 'web_fetch')[index]!), [0, 1])
  assert.equal((await records.runProblems('90d')).timedOut - before90.timedOut, 2)
})

test('server failures are never folded by the browser new-group cap, and each browser source has its own cap', async () => {
  await database`
    insert into error_groups (id, tenant_id, fingerprint, source, kind, message)
    select 'err-wb-' || n, ${tenantId}, 'wb-' || n, 'workbench', 'script', 'bulk'
      from generate_series(1, ${NEW_GROUPS_PER_HOUR}) as n
  `
  await records.record(serverFailureRecord({ traceId: 'trace-http-11111111-2222-3333-4444-666666666666', method: 'POST',
    routePath: '/api/workbench/v1/sessions', status: 500, code: 'operation_failed', errorMessage: 'x', params: {}, userId: null }, null))
  await records.record({ ...clientRecord({ fingerprint: 'admin-new', message: 'admin' }), source: 'admin' })
  const rows = await database<{ source: string; kind: string }[]>`
    select source, kind from error_groups where tenant_id = ${tenantId} and source in ('server', 'admin') order by source`
  assert.deepEqual([...rows], [{ source: 'admin', kind: 'render' }, { source: 'server', kind: 'http' }])
})

test('concurrent new browser problems do not exceed the per-hour cap', async () => {
  await database`
    insert into error_groups (id, tenant_id, fingerprint, source, kind, message)
    select 'err-near-' || n, ${tenantId}, 'near-' || n, 'workbench', 'script', 'bulk'
      from generate_series(1, ${NEW_GROUPS_PER_HOUR - 2}) as n
  `
  await Promise.all(Array.from({ length: 6 }, (_, index) => records.record(clientRecord({ fingerprint: `race-${index}`, message: `race ${index}` }))))
  const [{ created }] = await database<{ created: number }[]>`
    select count(*)::integer as created from error_groups where tenant_id = ${tenantId} and source = 'workbench' and kind <> 'overflow'`
  assert.equal(created, NEW_GROUPS_PER_HOUR)
})

test('too many new problems per hour fold into one overflow group', async () => {
  await database`
    insert into error_groups (id, tenant_id, fingerprint, source, kind, message)
    select 'err-bulk-' || n, ${tenantId}, 'bulk-' || n, 'workbench', 'script', 'bulk'
      from generate_series(1, ${NEW_GROUPS_PER_HOUR}) as n
  `
  await records.record(clientRecord({ fingerprint: 'new-a', message: 'a' }))
  await records.record(clientRecord({ fingerprint: 'new-b', message: 'b', userId: 'U00002' }))
  const overflow = await database<{ kind: string; occurrenceCount: number }[]>`
    select kind, occurrence_count as "occurrenceCount" from error_groups
     where tenant_id = ${tenantId} and fingerprint in ('new-a', 'new-b', ${fingerprintOf(['overflow', 'workbench'])})`
  assert.deepEqual([...overflow], [{ kind: 'overflow', occurrenceCount: 2 }])
  // 已有问题不受上限影响。
  await records.record(clientRecord({ fingerprint: 'bulk-1' }))
  const [bulk] = await database<{ occurrenceCount: number }[]>`
    select occurrence_count as "occurrenceCount" from error_groups where tenant_id = ${tenantId} and fingerprint = 'bulk-1'`
  assert.equal(bulk!.occurrenceCount, 1)
})

test('retention removes samples older than 90 days and then their empty groups', async () => {
  await records.record(clientRecord())
  await records.record(clientRecord({ fingerprint: 'old-problem', message: 'old' }))
  await database`
    update error_occurrences set occurred_at = now() - interval '91 days'
     where tenant_id = ${tenantId} and group_id = (select id from error_groups where tenant_id = ${tenantId} and fingerprint = 'old-problem')`
  await database`update error_groups set last_seen_at = now() - interval '91 days' where tenant_id = ${tenantId} and fingerprint = 'old-problem'`
  const result = await records.purgeExpired()
  assert.equal(result.removed, 1)
  const remaining = await database<{ fingerprint: string }[]>`select fingerprint from error_groups where tenant_id = ${tenantId}`
  assert.equal(remaining.length, 1)
  assert.notEqual(remaining[0]!.fingerprint, 'old-problem')
})
