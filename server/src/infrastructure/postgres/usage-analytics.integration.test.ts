import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresUsageAnalyticsService } from '../../modules/observability/postgres-usage-analytics-service.ts'
import { PostgresTaskRepository } from '../../modules/task/postgres-task-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

/**
 * 运营概览的使用情况（OBS-E2E-04、05 的 PostgreSQL 部分）：活动口径、入口、部门筛选、按人明细、
 * 期间内未使用、页面访问去重与清理。用两个只属于本用例的部门，避免读到种子员工。
 */
const tenantId = 'tenant-dsh-work'
const timezone = 'Asia/Shanghai'
const salesDept = `用量测试销售部-${randomUUID().slice(0, 6)}`
const financeDept = `用量测试财务部-${randomUUID().slice(0, 6)}`
let throwaway: ThrowawayDatabase
let database: DatabaseClient
let usage: PostgresUsageAnalyticsService
const users = { alice: 'U-usage-alice', bob: 'U-usage-bob', carol: 'U-usage-carol', dave: 'U-usage-dave' }
let teamWorkspace = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_usage_analytics', maxConnections: 4 })
  database = throwaway.client
  usage = new PostgresUsageAnalyticsService(database, timezone)
  for (const [key, id] of Object.entries(users)) {
    await database`
      insert into users (id, tenant_id, external_subject, display_name, department_id, status, created_at)
      values (${id}, ${tenantId}, ${`usage-${key}`}, ${key}, ${key === 'dave' ? financeDept : key === 'carol' ? financeDept : salesDept}, 'active',
              now() - interval '200 days')
    `
    // 个人空间由触发器随员工创建（ws-personal-<id>）。
  }
  teamWorkspace = `ws-usage-${randomUUID()}`
  await database`
    insert into workspaces (id, tenant_id, name, workspace_type, created_by, status)
    values (${teamWorkspace}, ${tenantId}, '用量测试项目', 'team', ${users.alice}, 'active')
  `
})

after(async () => {
  await throwaway.dispose()
})

async function seedRun(input: {
  userId: string; daysAgo?: number; status?: 'succeeded' | 'failed' | 'cancelled'; errorCode?: string
  workspace?: string | null; automation?: boolean; trial?: boolean; tokens?: number; adminSession?: boolean
}) {
  const runId = `run-usage-${randomUUID()}`
  const attemptId = `attempt-usage-${randomUUID()}`
  const createdAt = database`now() - make_interval(days => ${input.daysAgo ?? 0})`
  let sessionId: string | null = null
  let taskId: string | null = null
  if (input.automation) {
    const task = await new PostgresTaskRepository(database).createTask({
      tenantId, requestedBy: input.userId, sourceType: 'automation', correlationKey: `usage-${randomUUID()}`,
    })
    taskId = task.id
  } else {
    sessionId = `session-usage-${randomUUID()}`
    await database`
      insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status, created_at, audience)
      values (${sessionId}, ${tenantId}, ${input.adminSession ? null : input.workspace ?? `ws-personal-${input.userId}`}, ${input.userId},
              ${input.adminSession ? null : 'agent-version-dsh-work-assistant-1'},
              '标题不应出现在用量里', 'active', ${createdAt}, ${input.adminSession ? 'admin' : 'workbench'})
    `
  }
  await database`
    insert into runs (id, tenant_id, task_id, session_id, requested_by, idempotency_key, status, created_at, updated_at)
    values (${runId}, ${tenantId}, ${taskId}, ${sessionId}, ${input.userId}, ${`idem-${runId}`}, ${input.status ?? 'succeeded'}, ${createdAt}, ${createdAt})
  `
  await database`
    insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status, error_code)
    values (${attemptId}, ${tenantId}, ${runId}, 1,
            ${database.json({ agent_version_id: 'agent-version-dsh-work-assistant-1', ...(input.trial ? { purpose: 'agent-release-trial' } : {}) })},
            'sha256-test', ${database.json({ routeKey: 'default' })}, ${input.status ?? 'succeeded'}, ${input.errorCode ?? null})
  `
  await database`update runs set current_attempt_id = ${attemptId} where tenant_id = ${tenantId} and id = ${runId}`
  if (input.tokens) {
    await database`
      insert into model_usage_events (id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens, latency_ms,
        cost_amount, cost_currency, status, trace_id, estimated, occurred_at, endpoint, measurement)
      values (${`usage-${attemptId}`}, ${tenantId}, ${runId}, ${attemptId}, 'deepseek-official', 'deepseek-v4-pro', ${input.tokens}, 0, 1000,
        0, 'CNY', 'success', ${`trace-${attemptId}`}, false, ${createdAt}, 'chat', 'gateway')
    `
  }
}

async function view(userId: string, page: string, daysAgo = 0, inDingtalk = false) {
  await database`
    insert into product_events (tenant_id, user_id, app, page, in_dingtalk, occurred_at)
    values (${tenantId}, ${userId}, 'workbench', ${page}, ${inDingtalk}, now() - make_interval(days => ${daysAgo}))
  `
}

test('usage counts only employee-side activity, by entry, department and person', async () => {
  // alice：个人对话 2 次（1 次失败），项目空间 1 次，定时任务 1 次；另有一次发布试运行与一次管理助手对话，不计入。
  await seedRun({ userId: users.alice, tokens: 1_000 })
  await seedRun({ userId: users.alice, status: 'failed', errorCode: 'RUN_TIMEOUT', daysAgo: 1 })
  await seedRun({ userId: users.alice, workspace: teamWorkspace, daysAgo: 2 })
  await seedRun({ userId: users.alice, automation: true, daysAgo: 3, tokens: 500 })
  await seedRun({ userId: users.alice, trial: true })
  await seedRun({ userId: users.alice, adminSession: true })
  // bob：只看了页面（在钉钉内），没有运行。
  await view(users.bob, 'knowledge', 0, true)
  await view(users.bob, 'knowledge', 1, true)
  // carol：40 天前用过，近 30 天未使用；dave 从未使用。
  await seedRun({ userId: users.carol, daysAgo: 40 })

  const sales = await usage.overview({ range: '30d', department: salesDept })
  assert.equal(sales.totals.employees, 2)
  assert.equal(sales.totals.activeEmployees, 2)
  assert.equal(sales.totals.runs, 4)
  assert.equal(sales.totals.succeededRuns, 3)
  assert.equal(sales.totals.finishedRuns, 4)
  assert.equal(sales.totals.newConversations, 3)
  assert.equal(sales.totals.tokens, 1_500)
  assert.equal(sales.totals.dingtalkEmployees, 1)
  assert.equal(sales.daily.length, 30)
  assert.equal(sales.daily.at(-1)!.activeEmployees, 2)
  assert.deepEqual(Object.fromEntries(sales.entries.map(item => [item.entry, item.runs])), { personal: 2, project: 1, automation: 1 })
  assert.deepEqual([...sales.failures], [{ code: 'RUN_TIMEOUT', runs: 1 }])
  assert.deepEqual([...sales.pages], [{ page: 'knowledge', people: 1, views: 2 }])
  assert.deepEqual(sales.departments.map(item => [item.name, item.employees, item.activeEmployees]), [[salesDept, 2, 2]])
  assert.ok(sales.departmentOptions.includes(financeDept))
  assert.equal(sales.agents.reduce((sum, item) => sum + item.runs, 0), 4)

  const finance = await usage.overview({ range: '30d', department: financeDept })
  assert.deepEqual([finance.totals.employees, finance.totals.activeEmployees], [2, 0])
  assert.equal((await usage.overview({ range: '90d', department: financeDept })).totals.activeEmployees, 1)

  const people = await usage.people({ range: '30d', department: salesDept })
  const alice = people.active.find(person => person.userId === users.alice)!
  assert.deepEqual([alice.runs, alice.succeededRuns, alice.conversations, alice.tokens, alice.activeDays], [4, 3, 3, 1_500, 4])
  assert.ok(alice.topAgent)
  const bob = people.active.find(person => person.userId === users.bob)!
  assert.deepEqual([bob.runs, bob.topPage, bob.activeDays], [0, 'knowledge', 2])
  assert.deepEqual(people.idle, [])

  const idle = await usage.people({ range: '30d', department: financeDept })
  assert.deepEqual(idle.active, [])
  assert.deepEqual(idle.idle.map(person => [person.userId, person.lastActiveAt === null]), [[users.dave, true], [users.carol, false]])

  const detail = await usage.person(users.alice, '7d')
  assert.equal(detail!.daily.length, 7)
  assert.equal(detail!.daily.reduce((sum, item) => sum + item.runs, 0), 4)
  assert.deepEqual(Object.fromEntries(detail!.entries.map(item => [item.entry, item.runs])), { personal: 2, project: 1, automation: 1 })
  assert.equal(await usage.person(users.dave, '7d'), null)
  // 返回内容不含对话标题。
  assert.ok(!JSON.stringify({ sales, people, detail }).includes('标题不应出现在用量里'))
})

test('page views dedupe within 30 minutes and are purged after 180 days', async () => {
  const recorded = await usage.recordPageViews(users.dave, 'workbench', [
    { page: 'workbench', inDingtalk: false }, { page: 'workbench', inDingtalk: false }, { page: 'skills', inDingtalk: true },
  ])
  assert.equal(recorded, 2)
  assert.equal(await usage.recordPageViews(users.dave, 'admin', [{ page: 'workbench', inDingtalk: false }]), 1)
  await database`
    update product_events set occurred_at = now() - interval '181 days' where tenant_id = ${tenantId} and user_id = ${users.dave} and page = 'skills'`
  const result = await usage.purgeExpired()
  assert.equal(result.removed, 1)
  const remaining = await database<{ page: string; app: string }[]>`
    select page, app from product_events where tenant_id = ${tenantId} and user_id = ${users.dave} order by app`
  assert.deepEqual([...remaining], [{ page: 'workbench', app: 'admin' }, { page: 'workbench', app: 'workbench' }])
})

test('idle list uses only pre-period employee activity for the last active time; unknown departments are rejected', async () => {
  const eve = 'U-usage-eve'
  const dept = `用量测试空闲部-${randomUUID().slice(0, 6)}`
  await database`
    insert into users (id, tenant_id, external_subject, display_name, department_id, status, created_at)
    values (${eve}, ${tenantId}, 'usage-eve', 'eve', ${dept}, 'active', now() - interval '200 days')
  `
  // 期间内只有一次发布试运行（不算使用），期间之前有一次真实对话。
  await seedRun({ userId: eve, trial: true })
  await seedRun({ userId: eve, daysAgo: 45 })
  const result = await usage.people({ range: '30d', department: dept })
  assert.deepEqual(result.active, [])
  const [idle] = result.idle
  assert.equal(idle!.userId, eve)
  const lastActive = Date.parse(idle!.lastActiveAt!)
  assert.ok(Date.now() - lastActive > 44 * 86_400_000, 'last active must be the pre-period conversation, not the trial run')

  await assert.rejects(usage.overview({ range: '30d', department: '不存在的部门' }), /不存在或没有在职员工/)
  await assert.rejects(usage.people({ range: '30d', department: '不存在的部门' }), /不存在或没有在职员工/)
})

test('concurrent page views of the same page are recorded once', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    usage.recordPageViews(users.carol, 'workbench', [{ page: 'concurrent-page', inDingtalk: false }])))
  assert.equal(results.reduce((sum, count) => sum + count, 0), 1)
})

