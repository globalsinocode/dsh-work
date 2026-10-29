import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { runMigrations } from '../infrastructure/postgres/migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresWorkspaceService } from '../modules/workbench/application/postgres-workspace-service.ts'
import {
  PostgresWorkspaceUsageService,
  type WorkspaceUsageView,
} from '../modules/workbench/application/postgres-workspace-usage-service.ts'
import { Router } from './router.ts'
import { registerWorkspaceUsageRoutes } from './workbench/workspace-usage-routes.ts'

const tenantId = 'tenant-dsh-work'
const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
// 测试文件在 server/src/http，向上两级即 server/，再进 migrations。
const migrationsDirectory = resolve(import.meta.dirname, '../../migrations')
// 5-T3：runs 活动索引 + model_usage_events 每 attempt 唯一索引。
const usageIndexMigration = '0028_runs_and_usage_indexes.sql'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let usage: PostgresWorkspaceUsageService
let server: ReturnType<typeof createServer>
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_usage_api_test',
    maxConnections: 10,
  })
  database = throwaway.client

  const authorization = new PostgresAuthorizationService(database)
  usage = new PostgresWorkspaceUsageService(database, new PostgresWorkspaceService(database), authorization)

  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerWorkspaceUsageRoutes(router, usage, authorization)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
})

// ---------------------------------------------------------------------------
// 角色门禁（AC-30）：负责人/管理员可读，普通成员/只读成员必须类型化 403
// ---------------------------------------------------------------------------

test('负责人与管理员可读空间用量；普通成员与只读成员得到类型化 403（不是 500）', async () => {
  const ws = uniqueWorkspace('roles')
  const owner = `${ws}-owner`
  const admin = `${ws}-admin`
  const member = `${ws}-member`
  const viewer = `${ws}-viewer`
  for (const [id, name] of [[owner, '用量负责人'], [admin, '用量管理员'], [member, '用量普通成员'], [viewer, '用量只读成员']] as const) {
    await seedUser(id, name)
  }
  await seedTeamWorkspace(ws, [
    { userId: owner, role: 'owner' },
    { userId: admin, role: 'admin' },
    { userId: member, role: 'member' },
    { userId: viewer, role: 'viewer' },
  ])

  const forOwner = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage`, { as: owner })
  assert.equal(forOwner.status, 200, '负责人必须可读')
  const forAdmin = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage`, { as: admin })
  assert.equal(forAdmin.status, 200, '管理员必须可读')

  for (const [userId, label] of [[member, '普通成员'], [viewer, '只读成员']] as const) {
    const denied = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage`, { as: userId })
    assert.notEqual(denied.status, 500, `${label}不得落 500（requireTeamRole 的裸 Error 必须被翻译）`)
    assert.equal(denied.status, 403, `${label}必须 403`)
    assert.equal(errorOf(denied)?.code, 'authorization_denied', `${label}必须是员工端收敛后的类型化 403`)
    assert.equal(errorOf(denied)?.message, '仅负责人或管理员可以查看空间用量')
  }
})

test('非成员与不存在空间返回完全一致的拒绝（不可枚举）', async () => {
  const ws = uniqueWorkspace('enum')
  const owner = `${ws}-owner`
  const stranger = `${ws}-stranger`
  await seedUser(owner, '用量负责人')
  await seedUser(stranger, '用量非成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  const nonMember = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=7d`, { as: stranger })
  const missing = await api('GET', `/api/workbench/v1/workspaces/${ws}-missing/usage?range=7d`, { as: stranger })
  assert.equal(nonMember.status, 403)
  assert.equal(missing.status, 403)
  assert.equal(nonMember.status, missing.status, '非成员与不存在空间状态码必须一致')
  for (const field of ['code', 'message', 'suggestion'] as const) {
    assert.equal(errorOf(nonMember)?.[field], errorOf(missing)?.[field], `非成员与不存在空间的 ${field} 必须一致，不能枚举`)
  }
})

test('个人空间返回类型化 422（团队专用），且不写入任何用量事件', async () => {
  const owner = `user-usage-personal-${suffix}`
  await seedUser(owner, '个人空间用户')
  const personalWorkspaceId = `ws-personal-${owner}`

  const response = await api('GET', `/api/workbench/v1/workspaces/${personalWorkspaceId}/usage`, { as: owner })
  assert.equal(response.status, 422, '个人空间必须 422（AC-23）')
  assert.equal(errorOf(response)?.code, 'invalid_request')

  const [count] = await database<{ count: number }[]>`
    select count(*)::integer as count from model_usage_events
     where tenant_id = ${tenantId}
  `
  assert.equal(count?.count, 0, '读用量不得产生任何用量事件')
})

test('归档空间的现任负责人/管理员仍可读取历史用量（读取轨）', async () => {
  const ws = uniqueWorkspace('archived')
  const owner = `${ws}-owner`
  const admin = `${ws}-admin`
  await seedUser(owner, '归档用量负责人')
  await seedUser(admin, '归档用量管理员')
  await seedTeamWorkspace(ws, [
    { userId: owner, role: 'owner' },
    { userId: admin, role: 'admin' },
  ], 'archived')
  await seedUsageEvent({ workspaceId: ws, userId: owner, daysAgo: 1, status: 'success', inputTokens: 7, outputTokens: 3 })

  for (const [userId, label] of [[owner, '负责人'], [admin, '管理员']] as const) {
    const response = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=7d`, { as: userId })
    assert.equal(response.status, 200, `归档空间的${label}仍可读取用量`)
    const view = response.body.data as WorkspaceUsageView
    assert.equal(view.rangeDays, 7)
    assert.equal(view.totals.callCount, 1)
    assert.equal(view.totals.inputTokens, 7)
    assert.equal(view.totals.outputTokens, 3)
  }
})

// ---------------------------------------------------------------------------
// range 口径
// ---------------------------------------------------------------------------

test('range 缺省为 7d；7d/30d 各自返回对应天数；非法值类型化 422', async () => {
  const ws = uniqueWorkspace('range')
  const owner = `${ws}-owner`
  await seedUser(owner, '范围负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  const omitted = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage`, { as: owner })
  assert.equal(omitted.status, 200)
  assert.equal((omitted.body.data as WorkspaceUsageView).range, '7d', '缺省 range 必须是 7d')
  assert.equal((omitted.body.data as WorkspaceUsageView).rangeDays, 7)
  assert.equal((omitted.body.data as WorkspaceUsageView).daily.length, 7)

  const seven = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=7d`, { as: owner })
  assert.equal(seven.status, 200)
  assert.equal((seven.body.data as WorkspaceUsageView).range, '7d')
  assert.equal((seven.body.data as WorkspaceUsageView).daily.length, 7)

  const thirty = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=30d`, { as: owner })
  assert.equal(thirty.status, 200)
  assert.equal((thirty.body.data as WorkspaceUsageView).range, '30d')
  assert.equal((thirty.body.data as WorkspaceUsageView).rangeDays, 30)
  assert.equal((thirty.body.data as WorkspaceUsageView).daily.length, 30)

  for (const invalid of ['14d', 'abc', '', '7', '30D', '1d']) {
    const denied = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=${encodeURIComponent(invalid)}`, { as: owner })
    assert.equal(denied.status, 422, `range=${JSON.stringify(invalid)} 必须 422`)
    assert.equal(errorOf(denied)?.code, 'invalid_request')
  }
})

// ---------------------------------------------------------------------------
// 聚合口径：totals 与 daily 数值必须正确
// ---------------------------------------------------------------------------

test('totals 与 daily 数值正确：多天、多状态、estimated 混排，且只统计本空间会话', async () => {
  const ws = uniqueWorkspace('totals')
  const other = uniqueWorkspace('totals-other')
  const owner = `${ws}-owner`
  const admin = `${ws}-admin`
  const member = `${ws}-member`
  const otherOwner = `${other}-owner`
  for (const [id, name] of [[owner, '汇总负责人'], [admin, '汇总管理员'], [member, '汇总成员'], [otherOwner, '其他空间负责人']] as const) {
    await seedUser(id, name)
  }
  await seedTeamWorkspace(ws, [
    { userId: owner, role: 'owner' },
    { userId: admin, role: 'admin' },
    { userId: member, role: 'member' },
  ])
  await seedTeamWorkspace(other, [{ userId: otherOwner, role: 'owner' }])

  // 会话由普通成员创建：空间用量是空间级聚合，不按成员拆分。
  await seedUsageEvent({ workspaceId: ws, userId: member, daysAgo: 0, status: 'success', inputTokens: 100, outputTokens: 50, estimated: false })
  await seedUsageEvent({ workspaceId: ws, userId: member, daysAgo: 0, status: 'failed', inputTokens: 10, outputTokens: 5, estimated: true })
  await seedUsageEvent({ workspaceId: ws, userId: member, daysAgo: 2, status: 'success', inputTokens: 1000, outputTokens: 500, estimated: true })
  // 另一个空间的 Run 绝不能被计入。
  await seedUsageEvent({ workspaceId: other, userId: otherOwner, daysAgo: 0, status: 'success', inputTokens: 9999, outputTokens: 9999, estimated: false })

  const today = await currentDayLabel()
  for (const [userId, label] of [[owner, '负责人'], [admin, '管理员']] as const) {
    const response = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=7d`, { as: userId })
    assert.equal(response.status, 200)
    const view = response.body.data as WorkspaceUsageView
    assert.equal(view.workspaceId, ws)
    assert.equal(view.range, '7d')
    assert.equal(view.rangeDays, 7)
    assert.equal(view.daily.length, 7, 'daily 长度必须恒为 rangeDays')

    assert.deepEqual(view.totals, {
      callCount: 3,
      successCount: 2,
      failedCount: 1,
      estimatedCount: 2,
      inputTokens: 1110,
      outputTokens: 555,
      totalTokens: 1665,
    }, `${label}读取的汇总必须正确`)

    const todayPoint = view.daily[6]!
    assert.equal(todayPoint.day, today)
    assert.deepEqual(todayPoint, {
      day: today,
      callCount: 2,
      successCount: 1,
      failedCount: 1,
      inputTokens: 110,
      outputTokens: 55,
    })
    assert.deepEqual(view.daily[5], {
      day: await dayLabelAgo(1),
      callCount: 0,
      successCount: 0,
      failedCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    }, '无消耗的日子必须零填充')
    assert.deepEqual(view.daily[4], {
      day: await dayLabelAgo(2),
      callCount: 1,
      successCount: 1,
      failedCount: 0,
      inputTokens: 1000,
      outputTokens: 500,
    })
  }
})

test('零消耗空间仍返回 rangeDays 个零值日，曲线不跳变', async () => {
  const ws = uniqueWorkspace('zero')
  const owner = `${ws}-owner`
  await seedUser(owner, '零消耗负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  const response = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=7d`, { as: owner })
  assert.equal(response.status, 200)
  const view = response.body.data as WorkspaceUsageView
  assert.deepEqual(view.totals, {
    callCount: 0,
    successCount: 0,
    failedCount: 0,
    estimatedCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  })
  assert.equal(view.daily.length, 7)
  for (const point of view.daily) {
    assert.equal(point.callCount, 0)
    assert.equal(point.inputTokens, 0)
    assert.equal(point.outputTokens, 0)
    assert.match(point.day, /^[0-9]{2}-[0-9]{2}$/)
  }
  assert.equal(view.daily[6]!.day, await currentDayLabel())
  assert.equal(view.daily[0]!.day, await dayLabelAgo(6), '日序列必须升序且从窗口起点开始')
})

test('窗口外（超过 rangeDays）的用量事件不计入，且不返回金额等最小必要面之外的字段', async () => {
  const ws = uniqueWorkspace('window')
  const owner = `${ws}-owner`
  await seedUser(owner, '窗口负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await seedUsageEvent({ workspaceId: ws, userId: owner, daysAgo: 0, status: 'success', inputTokens: 1, outputTokens: 1, estimated: false })
  await seedUsageEvent({ workspaceId: ws, userId: owner, daysAgo: 6, status: 'success', inputTokens: 2, outputTokens: 2, estimated: false })
  // 7 天窗口之外：不得计入。
  await seedUsageEvent({ workspaceId: ws, userId: owner, daysAgo: 8, status: 'success', inputTokens: 400, outputTokens: 400, estimated: false })

  const seven = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=7d`, { as: owner })
  assert.equal(seven.status, 200)
  const view = seven.body.data as WorkspaceUsageView
  assert.equal(view.totals.callCount, 2, '窗口外事件不得计入 7 天口径')
  assert.equal(view.totals.inputTokens, 3)
  assert.equal(view.totals.outputTokens, 3)
  assert.equal(view.daily[0]!.inputTokens, 2, '窗口起点当天（6 天前）必须计入')

  const thirty = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=30d`, { as: owner })
  const viewThirty = thirty.body.data as WorkspaceUsageView
  assert.equal(viewThirty.totals.callCount, 3, '30 天口径必须把 8 天前的事件计入')
  assert.equal(viewThirty.totals.inputTokens, 403)

  // 最小必要面：不得出现金额、币种、provider/model、员工身份字段。
  assert.deepEqual(
    Object.keys(view.totals).sort(),
    ['callCount', 'estimatedCount', 'failedCount', 'inputTokens', 'outputTokens', 'successCount', 'totalTokens'],
  )
  assert.deepEqual(
    Object.keys(view).sort(),
    ['daily', 'range', 'rangeDays', 'totals', 'workspaceId'],
  )
  assert.deepEqual(
    Object.keys(view.daily[6]!).sort(),
    ['callCount', 'day', 'failedCount', 'inputTokens', 'outputTokens', 'successCount'],
  )
})

test('跨空间隔离：另一空间（含同一负责人）的会话用量不得混入', async () => {
  const ws = uniqueWorkspace('isolation-a')
  const other = uniqueWorkspace('isolation-b')
  const owner = `${ws}-owner`
  const otherOwner = `${other}-owner`
  await seedUser(owner, '隔离负责人甲')
  await seedUser(otherOwner, '隔离负责人乙')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await seedTeamWorkspace(other, [{ userId: otherOwner, role: 'owner' }])
  await seedUsageEvent({ workspaceId: ws, userId: owner, daysAgo: 0, status: 'success', inputTokens: 5, outputTokens: 5, estimated: false })
  await seedUsageEvent({ workspaceId: other, userId: otherOwner, daysAgo: 0, status: 'success', inputTokens: 12345, outputTokens: 6789, estimated: false })

  const view = (await api('GET', `/api/workbench/v1/workspaces/${ws}/usage`, { as: owner })).body.data as WorkspaceUsageView
  assert.equal(view.totals.callCount, 1)
  assert.equal(view.totals.inputTokens, 5)
  assert.equal(view.totals.outputTokens, 5)
  assert.equal(view.totals.totalTokens, 10)

  const otherView = (await api('GET', `/api/workbench/v1/workspaces/${other}/usage`, { as: otherOwner })).body.data as WorkspaceUsageView
  assert.equal(otherView.totals.callCount, 1)
  assert.equal(otherView.totals.inputTokens, 12345)
})

test('空 workspaceId（仅空白）在任何空间解析/个人空间回退之前类型化 422', async () => {
  const owner = `user-usage-empty-${suffix}`
  await seedUser(owner, '空 id 用户')

  const response = await api('GET', '/api/workbench/v1/workspaces/%20/usage', { as: owner })
  assert.equal(response.status, 422)
  assert.equal(errorOf(response)?.code, 'invalid_request')
})

test('`standalone` 哨兵与空白 id 一样被拒绝，且读接口不得创建个人空间（质量评审 P2）', async () => {
  // `normalizeWorkspaceId` 把 '' 与 'standalone' 都归一为 null，而
  // resolveReadableWorkspace 的 null 回退会 `ensurePersonalWorkspace()` **写库**。
  // 读接口产生写副作用是缺陷：这里断言两者都 422 且不会把调用者的个人空间建出来。
  //
  // 注意 `users` 上的 `users_personal_workspace_provisioning` 触发器会在用户插入时
  // 自动建个人空间，因此必须临时停用它才能构造出「没有个人空间」的调用者。
  const actor = `user-usage-standalone-${randomUUID().replaceAll('-', '').slice(0, 8)}`
  await database`alter table users disable trigger users_personal_workspace_provisioning`
  try {
    await seedUser(actor, '哨兵调用者')
  } finally {
    await database`alter table users enable trigger users_personal_workspace_provisioning`
  }
  const personalWorkspaceId = `ws-personal-${actor}`
  const personalCount = async () => {
    const [row] = await database<{ count: number }[]>`
      select count(*)::integer as count from workspaces
       where tenant_id = ${tenantId} and id = ${personalWorkspaceId}
    `
    return row?.count ?? -1
  }
  assert.equal(await personalCount(), 0, '前置：该用户此刻没有个人空间')

  for (const rawId of ['standalone', ' ', '   ']) {
    const response = await api('GET', `/api/workbench/v1/workspaces/${encodeURIComponent(rawId)}/usage`, { as: actor })
    assert.equal(response.status, 422, `${rawId} 必须类型化 422`)
    assert.equal(errorOf(response)?.code, 'invalid_request')
    assert.equal(await personalCount(), 0, `${rawId} 不得触发个人空间创建（读接口无写副作用）`)
  }

  // 对照：不存在的普通 id 走的是 403 拒绝路径，同样不得建空间。
  const missing = await api('GET', `/api/workbench/v1/workspaces/ws-does-not-exist/usage`, { as: actor })
  assert.equal(missing.status, 403)
  assert.equal(await personalCount(), 0)
})

test('状态口径：callCount 恒等于 success + failed，第三状态（blocked）不计入任何计数（规格评审 S1）', async () => {
  const ws = uniqueWorkspace('status')
  const owner = `${ws}-owner`
  await seedUser(owner, '状态口径负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await seedUsageEvent({ workspaceId: ws, userId: owner, daysAgo: 0, status: 'success', inputTokens: 5, outputTokens: 1 })
  await seedUsageEvent({ workspaceId: ws, userId: owner, daysAgo: 0, status: 'failed', inputTokens: 7, outputTokens: 2 })
  // 0004 的 CHECK 允许 blocked，当前没有写入者；即便将来出现，也不得让「总数与分项
  // 对不上」（contract 示例隐含 callCount = success + failed）。
  await seedRawUsageEvent({ workspaceId: ws, userId: owner, daysAgo: 0, status: 'blocked', inputTokens: 100, outputTokens: 100 })

  const response = await api('GET', `/api/workbench/v1/workspaces/${ws}/usage?range=7d`, { as: owner })
  assert.equal(response.status, 200)
  const view = response.body.data as WorkspaceUsageView
  assert.equal(view.totals.callCount, 2, 'blocked 不得计入调用次数')
  assert.equal(view.totals.successCount, 1)
  assert.equal(view.totals.failedCount, 1)
  assert.equal(
    view.totals.callCount,
    view.totals.successCount + view.totals.failedCount,
    'callCount 必须等于 success + failed',
  )
  assert.equal(view.totals.inputTokens, 12, 'blocked 行的 token 不得计入')
  assert.equal(view.totals.outputTokens, 3)
  const today = view.daily[6]!
  assert.equal(today.callCount, 2)
  assert.equal(today.inputTokens, 12)
})

test('服务层直接调用同样执行完整门禁（防御性：不依赖路由前置守卫）', async () => {
  const ws = uniqueWorkspace('service-gate')
  const owner = `${ws}-owner`
  const member = `${ws}-member`
  await seedUser(owner, '服务门禁负责人')
  await seedUser(member, '服务门禁成员')
  await seedTeamWorkspace(ws, [
    { userId: owner, role: 'owner' },
    { userId: member, role: 'member' },
  ])

  await assert.rejects(
    () => usage.getWorkspaceUsage({ workspaceId: ws, actorUserId: member }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 403
      && (error as { code?: string }).code === 'permission_denied',
    '服务层必须把角色不足翻译成类型化 403',
  )
  await assert.rejects(
    () => usage.getWorkspaceUsage({ workspaceId: `${ws}-missing`, actorUserId: member }),
    (error: unknown) => (error as { status?: number }).status === 403,
  )
  const view = await usage.getWorkspaceUsage({ workspaceId: ws, actorUserId: owner })
  assert.equal(view.rangeDays, 7)
})

// ---------------------------------------------------------------------------
// 迁移 0028：runs 活动索引 + model_usage_events 每 attempt 唯一（5-T3）
// ---------------------------------------------------------------------------

test('0028：两个索引在完整迁移链上存在，且注释写明它服务哪些查询 / 去重策略', async () => {
  const [indexes] = await database<{ runsActive: string | null, usageByAttempt: string | null }[]>`
    select to_regclass('public.runs_active_by_tenant')::text as "runsActive",
           to_regclass('public.model_usage_by_attempt')::text as "usageByAttempt"
  `
  assert.equal(indexes?.runsActive, 'runs_active_by_tenant', 'runs 活动索引必须存在')
  assert.equal(indexes?.usageByAttempt, 'model_usage_by_attempt', '每 attempt 唯一索引必须存在')

  const [comments] = await database<{ runsComment: string | null, usageComment: string | null }[]>`
    select obj_description(to_regclass('public.runs_active_by_tenant'), 'pg_class') as "runsComment",
           obj_description(to_regclass('public.model_usage_by_attempt'), 'pg_class') as "usageComment"
  `
  assert.ok(comments?.runsComment, 'runs 活动索引必须有注释说明它服务哪些查询')
  assert.ok(comments?.usageComment, '每 attempt 唯一索引必须有注释写出去重策略与理由')
})

test('每 attempt 唯一：换 id 的重复 (tenant_id, attempt_id) 插入被 23505 拒绝（4-T3 双计路径）', async () => {
  const ws = uniqueWorkspace('attempt-unique')
  const owner = `${ws}-owner`
  await seedUser(owner, '每 attempt 唯一负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  const { runId, attemptId } = await seedUsageAttempt(database, { workspaceId: ws, userId: owner })

  const countRows = async () => {
    const [row] = await database<{ count: number }[]>`
      select count(*)::integer as count from model_usage_events
       where tenant_id = ${tenantId} and attempt_id = ${attemptId}
    `
    return row?.count ?? -1
  }

  await insertUsageEvent(database, { id: `usage-${attemptId}`, runId, attemptId, occurredAt: new Date() })
  // 第一道防线不变：写入端的确定性 id `usage-<attemptId>` + on conflict (id) do nothing 吸收同 id 重放。
  await database`
    insert into model_usage_events (
      id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
      latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
    ) values (
      ${`usage-${attemptId}`}, ${tenantId}, ${runId}, ${attemptId}, 'dsh-default', 'dsh-default',
      5, 5, 10, 0, 'CNY', 'success', ${`trace-${attemptId}`}, false, now()
    ) on conflict (id) do nothing
  `
  assert.equal(await countRows(), 1, '同 id 重放不得产生第二行')

  // 第二道防线：换一个 id 的同一 attempt 行必须被唯一索引拒绝，否则空间用量与平台运营双计。
  await assert.rejects(
    () => insertUsageEvent(database, {
      id: `usage-${attemptId}-forged`, runId, attemptId, occurredAt: new Date(),
    }),
    (error: unknown) => (error as { code?: string }).code === '23505',
    '换 id 的重复 attempt 行必须被模型用量唯一索引拒绝',
  )
  assert.equal(await countRows(), 1, '被拒的重复行不得留下任何行')
})

test('0028 去重：同一 attempt 保留 occurred_at 最早者、并列取 id 最小者，且可重复执行', async () => {
  // 为什么不在全链库上构造 pre-0028 状态：0028 自己就建唯一索引，重放完整迁移链后两条
  // 重复的 (tenant_id, attempt_id) 根本插不进去——这正是本迁移要保证的性质。所以这里另造
  // 一个只迁移到 0026 的一次性库，先种下重复行，再按 migration-runner 的方式（事务内
  // unsafe）执行 0028 原文，从而让「去重」这一步可判别。
  const preDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-migrations-0028-'))
  const pre = await createThrowawayDatabase({
    namePrefix: 'dsh_work_usage_0028_test',
    maxConnections: 2,
    migrate: false,
  })
  try {
    for (const file of (await readdir(migrationsDirectory)).sort()) {
      if (file < '0027') await copyFile(resolve(migrationsDirectory, file), resolve(preDirectory, file))
    }
    await runMigrations(pre.client, preDirectory)

    const [beforeIndex] = await pre.client<{ index: string | null }[]>`
      select to_regclass('public.model_usage_by_attempt')::text as index
    `
    assert.equal(beforeIndex?.index, null, '前置：0026 基线不得已有 0028 的唯一索引')

    const workspaceId = `ws-usage-0028-${randomUUID().replaceAll('-', '').slice(0, 8)}`
    await pre.client`
      insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
      values (${workspaceId}, ${tenantId}, '5-T3 去重用例空间', '', 'team', 'U00001', 'active')
    `
    const { runId, attemptId } = await seedUsageAttempt(pre.client, { workspaceId, userId: 'U00001' })

    // 三条同一 (tenant_id, attempt_id) 的重复行：
    //   zzz  最早（5 天前，11 tokens）
    //   tie  与 zzz 并列同一时刻（22 tokens）
    //   late 最新（1 天前，33 tokens）
    // id 最小的是 late，因此「只保留最小 id」或「保留最新」都会留下 late，用例可判别。
    const earliest = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    const latest = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await insertUsageEvent(pre.client, { id: `usage-${attemptId}-zzz`, runId, attemptId, occurredAt: earliest, inputTokens: 11 })
    await insertUsageEvent(pre.client, { id: `usage-${attemptId}-tie`, runId, attemptId, occurredAt: earliest, inputTokens: 22 })
    await insertUsageEvent(pre.client, { id: `usage-${attemptId}-late`, runId, attemptId, occurredAt: latest, inputTokens: 33 })

    const survivors = async () => pre.client<{ id: string, occurredAt: Date, inputTokens: number }[]>`
      select id, occurred_at as "occurredAt", input_tokens::integer as "inputTokens"
        from model_usage_events
       where tenant_id = ${tenantId} and attempt_id = ${attemptId}
       order by id
    `
    assert.equal((await survivors()).length, 3, '前置：0026 库上三条重复行都已写入')

    // 并列时「已上报」优先于「平台估算」（对抗性评审 F3）：另起一组同刻重复行，且估算行的 id
    // 更小——只有把 estimated 作为第二排序键才会保留已上报那一行。必须在应用 0028 **之前**种。
    const { runId: estRunId, attemptId: estAttemptId } = await seedUsageAttempt(pre.client, { workspaceId, userId: 'U00001' })
    const sameInstant = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await insertUsageEvent(pre.client, {
      id: `usage-${estAttemptId}-aaa-estimated`, runId: estRunId, attemptId: estAttemptId,
      occurredAt: sameInstant, inputTokens: 7, estimated: true,
    })
    await insertUsageEvent(pre.client, {
      id: `usage-${estAttemptId}-zzz-reported`, runId: estRunId, attemptId: estAttemptId,
      occurredAt: sameInstant, inputTokens: 8, estimated: false,
    })

    await applyUsageIndexMigration(pre.client)

    const [estimatedTie] = await pre.client<{ id: string, estimated: boolean }[]>`
      select id, estimated from model_usage_events
       where tenant_id = ${tenantId} and attempt_id = ${estAttemptId}
    `
    assert.equal(
      estimatedTie?.id,
      `usage-${estAttemptId}-zzz-reported`,
      'occurred_at 并列时必须保留已上报行（estimated=false），而不是 id 更小的估算行',
    )
    assert.equal(estimatedTie?.estimated, false)

    const deduped = await survivors()
    assert.equal(deduped.length, 1, '同一 (tenant_id, attempt_id) 只允许保留一行')
    assert.equal(deduped[0]?.id, `usage-${attemptId}-tie`, '保留 occurred_at 最早者；并列时取 id 最小者')
    assert.equal(deduped[0]?.occurredAt.getTime(), earliest.getTime(), '保留的必须是首次记录时刻')
    assert.equal(deduped[0]?.inputTokens, 22)

    // 唯一索引立刻生效：再插一条换 id 的重复行必须 23505。
    await assert.rejects(
      () => insertUsageEvent(pre.client, {
        id: `usage-${attemptId}-again`, runId, attemptId, occurredAt: new Date(),
      }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    )

    // 可重复执行：重跑 0028 原文是 no-op（不报错、不再删任何行、索引仍在）。
    await applyUsageIndexMigration(pre.client)
    const replayed = await survivors()
    assert.equal(replayed.length, 1, '重放 0028 不得删掉唯一幸存行')
    assert.equal(replayed[0]?.id, `usage-${attemptId}-tie`)
    const [afterIndex] = await pre.client<{ runsActive: string | null, usageByAttempt: string | null }[]>`
      select to_regclass('public.runs_active_by_tenant')::text as "runsActive",
             to_regclass('public.model_usage_by_attempt')::text as "usageByAttempt"
    `
    assert.equal(afterIndex?.runsActive, 'runs_active_by_tenant')
    assert.equal(afterIndex?.usageByAttempt, 'model_usage_by_attempt')
  } finally {
    await pre.dispose()
    await rm(preDirectory, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueWorkspace(label: string) {
  return `ws-usage-${label}-${suffix}`
}

function testApiAuthenticator(request: import('node:http').IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    throw error
  }
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId, name: userId, title: '员工', department: '测试部门', avatarText: '测',
      role: 'employee', dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}

async function api(
  method: string,
  path: string,
  options: { as?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {}
  if (options.as) headers['x-test-user-id'] = options.as
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: options.body === undefined
      ? headers
      : { ...headers, 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return {
    status: response.status,
    body: parsed as { data?: unknown; error?: { code: string; message: string; suggestion?: string } },
    text,
  }
}

function errorOf(result: { body: { error?: { code: string; message: string; suggestion?: string } } }) {
  return result.body.error
}

async function currentDayLabel() {
  const [row] = await database<{ day: string }[]>`select to_char(current_date, 'MM-DD') as day`
  return row?.day ?? ''
}

async function dayLabelAgo(daysAgo: number) {
  const [row] = await database<{ day: string }[]>`
    select to_char(current_date - make_interval(days => ${daysAgo}), 'MM-DD') as day
  `
  return row?.day ?? ''
}

async function seedUser(id: string, displayName: string) {
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user
    ) values (${id}, ${tenantId}, ${`directory:${id}`}, ${displayName}, null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local') on conflict do nothing
  `
}

async function seedTeamWorkspace(
  workspaceId: string,
  members: Array<{ userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>,
  status: 'active' | 'archived' = 'active',
) {
  const ownerId = members[0]?.userId ?? 'U00001'
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status, archived_at)
    values (
      ${workspaceId}, ${tenantId}, '4-T1 空间用量测试空间', '', 'team', ${ownerId}, ${status},
      ${status === 'archived' ? new Date() : null}
    )
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

/**
 * 每次 attempt 一行用量事件（真实写入形状见 postgres-operations-service.ts 的
 * `recordModelUsage`）：会话 → Run → Attempt → 用量事件，`occurred_at` 由数据库时钟
 * 按天偏移生成，避免与库会话时区的按日分桶口径错位。
 */
async function seedUsageEvent(input: {
  workspaceId: string
  userId: string
  daysAgo: number
  status: 'success' | 'failed'
  inputTokens: number
  outputTokens: number
  estimated?: boolean
}) {
  return seedRawUsageEvent(input)
}

/** 允许任意 status（含 0004 CHECK 允许但当前无写入者的 'blocked'）。 */
async function seedRawUsageEvent(input: {
  workspaceId: string
  userId: string
  daysAgo: number
  status: string
  inputTokens: number
  outputTokens: number
  estimated?: boolean
}) {
  const sessionId = `session-usage-${randomUUID()}`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (
      ${sessionId}, ${tenantId}, ${input.workspaceId}, ${input.userId},
      'agent-version-dsh-work-assistant-1', '空间用量测试会话', 'active'
    )
  `
  const runId = `run-usage-${randomUUID()}`
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenantId}, ${sessionId}, ${input.userId}, ${`idem-${runId}`}, 'succeeded')
  `
  const attemptId = `attempt-usage-${randomUUID()}`
  await database`
    insert into run_attempts (
      id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status
    ) values (
      ${attemptId}, ${tenantId}, ${runId}, 1, ${database.json({})}, 'sha256-test',
      ${database.json({ providerKey: 'dsh-default', modelKey: 'dsh-default' })}, 'succeeded'
    )
  `
  await database`
    insert into model_usage_events (
      id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
      latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
    ) values (
      ${`usage-${attemptId}`}, ${tenantId}, ${runId}, ${attemptId}, 'dsh-default', 'dsh-default',
      ${input.inputTokens}, ${input.outputTokens}, 10, 0, 'CNY', ${input.status},
      ${`trace-${attemptId}`}, ${input.estimated ?? false},
      now() - make_interval(days => ${input.daysAgo})
    )
  `
}

/** 只建会话 → Run → Attempt，返回可复用的 attemptId（5-T3 唯一性与去重用例用）。 */
async function seedUsageAttempt(
  client: DatabaseClient,
  input: { workspaceId: string, userId: string },
) {
  const sessionId = `session-usage-${randomUUID()}`
  await client`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (
      ${sessionId}, ${tenantId}, ${input.workspaceId}, ${input.userId},
      'agent-version-dsh-work-assistant-1', '空间用量测试会话', 'active'
    )
  `
  const runId = `run-usage-${randomUUID()}`
  await client`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenantId}, ${sessionId}, ${input.userId}, ${`idem-${runId}`}, 'succeeded')
  `
  const attemptId = `attempt-usage-${randomUUID()}`
  await client`
    insert into run_attempts (
      id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status
    ) values (
      ${attemptId}, ${tenantId}, ${runId}, 1, ${client.json({})}, 'sha256-test',
      ${client.json({ providerKey: 'dsh-default', modelKey: 'dsh-default' })}, 'succeeded'
    )
  `
  return { runId, attemptId }
}

/** 以调用方给定的 id/occurred_at 写一条用量事件（用于构造重复 attempt 行）。 */
async function insertUsageEvent(
  client: DatabaseClient,
  input: { id: string, runId: string, attemptId: string, occurredAt: Date, inputTokens?: number, estimated?: boolean },
) {
  await client`
    insert into model_usage_events (
      id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
      latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
    ) values (
      ${input.id}, ${tenantId}, ${input.runId}, ${input.attemptId}, 'dsh-default', 'dsh-default',
      ${input.inputTokens ?? 1}, 1, 10, 0, 'CNY', 'success', ${`trace-${input.id}`}, ${input.estimated ?? false},
      ${input.occurredAt}
    )
  `
}

/** 与 migration-runner 相同的方式执行 0028 原文：单事务内 unsafe，保证「半升级」不可见。 */
async function applyUsageIndexMigration(client: DatabaseClient) {
  const sqlText = await readFile(resolve(migrationsDirectory, usageIndexMigration), 'utf8')
  await client.begin(async (transaction) => {
    await transaction.unsafe(sqlText)
  })
}
