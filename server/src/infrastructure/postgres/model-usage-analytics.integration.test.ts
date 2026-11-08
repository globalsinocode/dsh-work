import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresModelUsageService } from '../../modules/admin/application/postgres-model-usage-service.ts'
import { PostgresTaskRepository } from '../../modules/task/postgres-task-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

/**
 * 模型用量页查询（管理端）：全部运行计入（含无会话的定时任务），平台时区划分时间，
 * 对话与联网搜索两行合并为一次执行，缓存命中率只按返回了缓存数据的行计算。
 */
const tenantId = 'tenant-dsh-work'
const timezone = 'Asia/Shanghai'
let throwaway: ThrowawayDatabase
let database: DatabaseClient
let usage: PostgresModelUsageService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_model_usage_analytics', maxConnections: 3 })
  database = throwaway.client
  usage = new PostgresModelUsageService(database, timezone)
  await database`update users set department_id = '华东销售部' where tenant_id = ${tenantId} and id = 'U00001'`
})

after(async () => {
  await throwaway.dispose()
})

interface Line {
  endpoint?: 'chat' | 'search'
  provider?: string
  model?: string
  input: number
  output: number
  cacheRead?: number | null
  requests?: number | null
  failed?: number | null
  measurement?: 'gateway' | 'session-log' | 'estimated'
}

/** 一次执行：会话运行或无会话的定时任务运行，按“平台时区 N 天前”的时刻写入用量行。 */
async function seedExecution(input: {
  userId?: string
  daysAgo?: number
  automation?: boolean
  status?: 'success' | 'failed' | 'cancelled'
  /** 早期运行的 Manifest 没有 agent_version_id。 */
  legacyManifest?: boolean
  lines: Line[]
}) {
  const userId = input.userId ?? 'U00001'
  const runId = `run-mu-${randomUUID()}`
  const attemptId = `attempt-mu-${randomUUID()}`
  if (input.automation) {
    const task = await new PostgresTaskRepository(database).createTask({
      tenantId, requestedBy: userId, sourceType: 'automation', correlationKey: `mu-${randomUUID()}`,
    })
    await database`
      insert into runs (id, tenant_id, task_id, session_id, requested_by, idempotency_key, status)
      values (${runId}, ${tenantId}, ${task.id}, null, ${userId}, ${`idem-${runId}`}, 'succeeded')
    `
  } else {
    const sessionId = `session-mu-${randomUUID()}`
    await database`
      insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
      values (${sessionId}, ${tenantId}, ${`ws-personal-${userId}`}, ${userId}, 'agent-version-dsh-work-assistant-1', '用量页测试', 'active')
    `
    await database`
      insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
      values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${`idem-${runId}`}, 'succeeded')
    `
  }
  await database`
    insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (
      ${attemptId}, ${tenantId}, ${runId}, 1,
      ${database.json(input.legacyManifest ? {} : { agent_version_id: 'agent-version-dsh-work-assistant-1' })}, 'sha256-test',
      ${database.json({ routeId: 'route-default', routeKey: 'default', providerKey: 'deepseek-official', modelKey: 'deepseek-v4-pro' })},
      'succeeded'
    )
  `
  // 平台时区当天正午往前推 N 天，避免落在日界附近。
  const daysAgo = input.daysAgo ?? 0
  for (const line of input.lines) {
    const endpoint = line.endpoint ?? 'chat'
    await database`
      insert into model_usage_events (
        id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens, latency_ms,
        cost_amount, cost_currency, status, trace_id, estimated, occurred_at,
        endpoint, measurement, cache_read_tokens, cache_write_tokens, request_count, failed_request_count
      ) values (
        ${endpoint === 'chat' ? `usage-${attemptId}` : `usage-${attemptId}-search`}, ${tenantId}, ${runId}, ${attemptId},
        ${line.provider ?? 'deepseek-official'}, ${line.model ?? 'deepseek-v4-pro'}, ${line.input}, ${line.output}, 12000,
        0, 'CNY', ${input.status ?? 'success'}, ${`trace-${attemptId}`}, ${(line.measurement ?? 'gateway') === 'estimated'},
        (date_trunc('day', now() at time zone ${timezone}) + interval '12 hours' - make_interval(days => ${daysAgo})) at time zone ${timezone},
        ${endpoint}, ${line.measurement ?? 'gateway'}, ${line.cacheRead ?? null}, null, ${line.requests ?? null}, ${line.failed ?? null}
      )
    `
  }
  return { runId, attemptId }
}

test('概况：全部运行计入（含无会话的定时任务），缓存命中率只按返回缓存的行，估算单独计', async () => {
  const conversation = await seedExecution({ lines: [
    { input: 1000, output: 100, cacheRead: 600, requests: 2, failed: 1 },
    { endpoint: 'search', model: 'deepseek-v4-flash', input: 200, output: 50, requests: 1, failed: 0 },
  ] })
  const automation = await seedExecution({ automation: true, lines: [
    { provider: 'bailian', model: 'qwen3.8-flash', input: 500, output: 40, cacheRead: null, requests: 1, failed: 0 },
  ] })
  await seedExecution({ daysAgo: 25, lines: [{ input: 3000, output: 300, measurement: 'estimated' }] })

  const today = await usage.getOverview({ range: 'today' })
  assert.equal(today.granularity, 'hour')
  assert.equal(today.trend.length, 24)
  assert.deepEqual({
    totalTokens: today.totals.totalTokens, executions: today.totals.executions, requests: today.totals.requests,
    failedRequests: today.totals.failedRequests, cacheReadTokens: today.totals.cacheReadTokens,
    cacheInputTokens: today.totals.cacheInputTokens, estimatedTokens: today.totals.estimatedTokens,
  }, {
    totalTokens: 1890, executions: 2, requests: 4, failedRequests: 1, cacheReadTokens: 600, cacheInputTokens: 1000, estimatedTokens: 0,
  })
  assert.ok(today.facets.sources.includes('automation'), '无会话的定时任务运行也计入')

  const month = await usage.getOverview({ range: '30d' })
  assert.equal(month.trend.length, 30)
  assert.equal(month.totals.estimatedTokens, 3300)
  assert.equal(month.trend.at(-1)?.bucket, month.to)
  const noon = month.trend.at(-1)!.models.find(item => item.model === 'deepseek-v4-pro')
  assert.equal(noon?.tokens, 1100)

  const seven = await usage.getOverview({ range: '7d' })
  assert.equal(seven.totals.estimatedTokens, 0, '25 天前的估算数据不在近 7 天内')

  // 明细：对话与联网搜索合并为一次执行；定时任务来源正确
  const executions = await usage.getExecutions({ range: 'today' }, 1, 20)
  const merged = executions.items.find(item => item.runId === conversation.runId)
  assert.equal(merged?.totalTokens, 1350)
  assert.deepEqual(merged?.search, { model: 'deepseek-v4-flash', inputTokens: 200, outputTokens: 50, requests: 1 })
  assert.equal(merged?.routeName, '平台默认模型路由')
  assert.equal(merged?.department, '华东销售部')
  assert.equal(merged?.agentName, 'dsh-work 助手')
  const scheduled = executions.items.find(item => item.runId === automation.runId)
  assert.equal(scheduled?.source, 'automation')
  assert.equal(scheduled?.cacheReadTokens, null)
  assert.equal(executions.total, 2)
})

test('按维度统计与下钻：模型、来源、部门、员工、Agent；模型筛选只取对应行', async () => {
  const byModel = await usage.getBreakdown({ range: 'today' }, 'model')
  assert.deepEqual(byModel.map(row => row.key), ['deepseek-v4-pro', 'qwen3.8-flash', 'deepseek-v4-flash'])
  assert.match(byModel.find(row => row.key === 'deepseek-v4-flash')!.sub, /联网搜索/)
  assert.equal(byModel.find(row => row.key === 'qwen3.8-flash')!.cacheInputTokens, 0, '厂商未返回缓存时不计入命中率分母')

  const bySource = await usage.getBreakdown({ range: 'today' }, 'source')
  assert.deepEqual(bySource.map(row => [row.key, row.executions]).sort(), [['automation', 1], ['conversation', 1]])

  const byDepartment = await usage.getBreakdown({ range: 'today' }, 'department')
  assert.deepEqual(byDepartment.map(row => row.key), ['华东销售部'])

  const byAgent = await usage.getBreakdown({ range: 'today' }, 'agent')
  assert.equal(byAgent[0]?.label, 'dsh-work 助手')

  const searchOnly = await usage.getOverview({ range: 'today', model: 'deepseek-v4-flash' })
  assert.equal(searchOnly.totals.totalTokens, 250)
  const searchExecutions = await usage.getExecutions({ range: 'today', model: 'deepseek-v4-flash' }, 1, 20)
  assert.equal(searchExecutions.total, 1)
  assert.equal(searchExecutions.items[0]?.search?.model, 'deepseek-v4-flash', '下钻到搜索模型时仍展示整次执行')

  const scheduled = await usage.getExecutions({ range: 'today', source: 'automation' }, 1, 20)
  assert.deepEqual(scheduled.items.map(item => item.model), ['qwen3.8-flash'])
  const employee = await usage.getBreakdown({ range: 'today', department: '华东销售部' }, 'employee')
  assert.equal(employee[0]?.key, 'U00001')
  assert.equal(employee[0]?.sub, '华东销售部')
})

test('分页：按最近时间倒序，total 按执行去重', async () => {
  const first = await usage.getExecutions({ range: '30d' }, 1, 2)
  const second = await usage.getExecutions({ range: '30d' }, 2, 2)
  assert.equal(first.total, 3)
  assert.equal(first.items.length, 2)
  assert.equal(second.items.length, 1)
  assert.equal(second.items[0]?.measurement, 'estimated')
})

test('早期运行的 Manifest 没有 Agent 版本时，按会话固定的版本归属 Agent，不落到“系统”', async () => {
  const legacy = await seedExecution({ daysAgo: 2, legacyManifest: true, lines: [{ input: 10, output: 1 }] })
  const page = await usage.getExecutions({ range: '7d' }, 1, 50)
  const row = page.items.find(item => item.runId === legacy.runId)
  assert.equal(row?.agentName, 'dsh-work 助手')
  assert.equal(row?.agentId, 'agent-dsh-work-assistant')
})
