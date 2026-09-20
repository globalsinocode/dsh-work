import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { AuthorizationDeniedError } from '../modules/authorization/authorization-errors.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { runMigrations } from '../infrastructure/postgres/migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import {
  PostgresWorkspaceActivityService,
  type WorkspaceActivityItem,
} from '../modules/workbench/application/postgres-workspace-activity-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { PostgresWorkspaceLifecycleService } from '../modules/workbench/application/postgres-workspace-lifecycle-service.ts'
import { PostgresWorkspaceMemberService } from '../modules/workbench/application/postgres-workspace-member-service.ts'
import { PostgresWorkspaceService } from '../modules/workbench/application/postgres-workspace-service.ts'
import { Router } from './router.ts'
import { registerContentRoutes } from './workbench/content-routes.ts'
import { registerWorkspaceActivityRoutes } from './workbench/workspace-activity-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './workbench/workspace-agent-member-routes.ts'
import { registerWorkspaceLifecycleRoutes } from './workbench/workspace-lifecycle-routes.ts'
import { registerWorkspaceMemberRoutes } from './workbench/workspace-member-routes.ts'

const tenantId = 'tenant-dsh-work'
const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
const migrationsDirectory = resolve(import.meta.dirname, '../../migrations')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let authorization: PostgresAuthorizationService
let workspaces: PostgresWorkspaceService
let activity: PostgresWorkspaceActivityService
let server: ReturnType<typeof createServer>
let baseUrl = ''
let storageRoot = ''

interface ActivityRow {
  id: string
  kind: string
  actorUserId: string
  objectType: string
  objectId: string
  metadata: Record<string, unknown>
  dedupeKey: string
  occurredAt: Date
}

before(async () => {
  throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_activity_api_test',
    maxConnections: 10,
  })
  database = throwaway.client

  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-activity-'))
  authorization = new PostgresAuthorizationService(database)
  workspaces = new PostgresWorkspaceService(database)
  activity = new PostgresWorkspaceActivityService(database, workspaces)
  const content = new PostgresContentService(database, storageRoot, authorization)
  const workspaceMembers = new PostgresWorkspaceMemberService(database, authorization)
  const workspaceLifecycle = new PostgresWorkspaceLifecycleService(database)
  const agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, new PostgresAgentService(database))

  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerContentRoutes(router, content, authorization)
  registerWorkspaceMemberRoutes(router, workspaceMembers, authorization)
  registerWorkspaceLifecycleRoutes(router, workspaceLifecycle, authorization)
  registerWorkspaceAgentMemberRoutes(router, agentMembers, authorization)
  registerWorkspaceActivityRoutes(router, activity, authorization)
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
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  await throwaway.dispose()
})

// ---------------------------------------------------------------------------
// 迁移 0026
// ---------------------------------------------------------------------------

test('迁移 0026：建立动态事实与通知状态表，可重复执行且不回填历史（AC-17）', async () => {
  const eventColumns = await tableColumns('workspace_activity_events')
  assert.deepEqual(eventColumns, [
    'id', 'tenant_id', 'workspace_id', 'kind', 'actor_user_id', 'object_type',
    'object_id', 'safe_metadata', 'dedupe_key', 'occurred_at',
  ])
  const stateColumns = await tableColumns('workspace_notification_states')
  assert.deepEqual(stateColumns, ['tenant_id', 'workspace_id', 'user_id', 'last_read_at', 'muted_at'])

  const constraints = await database<{ name: string }[]>`
    select conname as name from pg_constraint
     where conrelid = 'workspace_activity_events'::regclass and contype = 'u'
     order by conname
  `
  assert.ok(
    constraints.some(row => row.name.includes('tenant_id_workspace_id_dedupe_key')),
    '必须有 (tenant_id, workspace_id, dedupe_key) 唯一键',
  )
  const indexes = await database<{ name: string }[]>`
    select indexname as name from pg_indexes
     where schemaname = 'public' and tablename = 'workspace_activity_events'
     order by indexname
  `
  assert.ok(indexes.some(row => row.name === 'workspace_activity_events_feed'), '必须有 feed 查询索引')

  // 迁移不做任何回填：历史动态不得被发明出来。
  const [count] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_activity_events
  `
  assert.equal(count?.count, 0, '0026 不得回填历史动态')

  // 幂等：迁移链已应用后再跑一次不得有任何变更。
  const results = await runMigrations(database, migrationsDirectory)
  assert.equal(results.filter(result => result.applied).length, 0, '重复执行迁移不得应用任何迁移')

  // 0025 的教训：删除记账后重放整个迁移文件也必须幂等（if not exists 全覆盖）。
  const replaySql = await readFile(resolve(migrationsDirectory, '0026_workspace_activity.sql'), 'utf8')
  await database.unsafe(replaySql)
  await database.unsafe(replaySql)
  assert.deepEqual(await tableColumns('workspace_activity_events'), eventColumns)
})

// ---------------------------------------------------------------------------
// 成员事件
// ---------------------------------------------------------------------------

test('成员添加写入一条 member_added 动态，重复添加不再产生（AC-15）', async () => {
  const ws = uniqueWorkspace('member-add')
  const owner = `${ws}-owner`
  const target = `${ws}-target`
  await seedUser(owner, '添加负责人')
  await seedUser(target, '被添加成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  const first = await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, {
    as: owner,
    body: { userId: target, role: 'member' },
  })
  assert.equal(first.status, 201)

  const rows = await activityRows(ws)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.kind, 'member_added')
  assert.equal(rows[0]?.actorUserId, owner)
  assert.equal(rows[0]?.objectType, 'member')
  assert.equal(rows[0]?.objectId, target)
  assert.deepEqual(rows[0]?.metadata, { userId: target, role: 'member' })

  // 重复提交同一业务动作：业务幂等，动态也必须保持一条。
  const replay = await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, {
    as: owner,
    body: { userId: target, role: 'member' },
  })
  assert.equal(replay.status, 200)
  assert.equal((await activityRows(ws)).length, 1, '重复添加不得产生第二条动态')
})

test('成员添加→移除→重新添加产生三条互不相同且有序的动态', async () => {
  const ws = uniqueWorkspace('member-cycle')
  const owner = `${ws}-owner`
  const target = `${ws}-target`
  await seedUser(owner, '循环负责人')
  await seedUser(target, '循环成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: target, role: 'member' } })
  await api('DELETE', `/api/workbench/v1/workspaces/${ws}/members/${target}`, { as: owner })
  await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: target, role: 'viewer' } })

  const rows = await activityRows(ws)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(row => row.kind), ['member_added', 'member_removed', 'member_added'])
  assert.equal(new Set(rows.map(row => row.id)).size, 3, '三次真实变更必须是三条不同的动态')
  assert.equal(new Set(rows.map(row => row.dedupeKey)).size, 3, '去重键必须区分成员代际，不能折叠重加事件')

  const feed = await activity.listActivity({ workspaceId: ws, actorUserId: owner, limit: 20 })
  assert.deepEqual(feed.items.map(item => item.kind), ['member_added', 'member_removed', 'member_added'], '最新优先')
  assert.equal(feed.items[2]?.safeMetadata['role'], 'member', '最早一条是首次加入（member）')
  assert.equal(feed.items[0]?.safeMetadata['role'], 'viewer', '最新一条是重新加入（viewer）')
  assert.ok(feed.items[0]!.occurredAt >= feed.items[2]!.occurredAt, '时间必须单调')
})

test('角色变更、负责人转交与主动退出各写入对应动态，重复/无变化不产生（AC-15）', async () => {
  const ws = uniqueWorkspace('member-kinds')
  const owner = `${ws}-owner`
  const memberA = `${ws}-a`
  const memberB = `${ws}-b`
  await seedUser(owner, '动态种类负责人')
  await seedUser(memberA, '动态种类甲')
  await seedUser(memberB, '动态种类乙')
  await seedTeamWorkspace(ws, [
    { userId: owner, role: 'owner' },
    { userId: memberA, role: 'member' },
    { userId: memberB, role: 'member' },
  ])

  const changed = await api('PATCH', `/api/workbench/v1/workspaces/${ws}/members/${memberA}`, {
    as: owner,
    body: { role: 'viewer' },
  })
  assert.equal(changed.status, 200)
  const noop = await api('PATCH', `/api/workbench/v1/workspaces/${ws}/members/${memberA}`, {
    as: owner,
    body: { role: 'viewer' },
  })
  assert.equal(noop.status, 200, '同角色重复变更保持幂等')

  const transfer = await api('POST', `/api/workbench/v1/workspaces/${ws}/owner-transfer`, {
    as: owner,
    body: { toUserId: memberB },
  })
  assert.equal(transfer.status, 200)

  const exit = await api('POST', `/api/workbench/v1/workspaces/${ws}/exit`, { as: memberA })
  assert.equal(exit.status, 200, '降级为只读后的成员仍可主动退出')

  const rows = await activityRows(ws)
  assert.deepEqual(rows.map(row => row.kind), ['role_changed', 'owner_transferred', 'member_exit'])
  assert.deepEqual(rows[0]?.metadata, { userId: memberA, from: 'member', to: 'viewer' })
  assert.deepEqual(rows[1]?.metadata, { fromUserId: owner, toUserId: memberB })
  assert.equal(rows[1]?.objectId, memberB)
  assert.deepEqual(rows[2]?.metadata, { userId: memberA })
  assert.equal((await activityRows(ws)).filter(row => row.kind === 'role_changed').length, 1, '同角色重复变更不得再写动态')
})

test('并发改角色时动态的 from/to 必须构成真实链路，不得写锁外过期快照（评审 F2/D5）', async () => {
  // 判别设计：两个改角色请求都在**取空间行锁之前**做角色快照，然后串行执行。
  // 修复前第二条动态的 from 取自过期快照，链路断裂（评审实测两条都写 from=member）。
  // 只靠 Promise.all 不稳定（第二个请求常常在第一个提交之后才读快照，实测削弱实现
  // 时该用例仍全绿），因此用外部事务显式持有空间行锁，强制两个请求在锁外读完快照后
  // 一起排队。
  const ws = uniqueWorkspace('role-chain')
  const owner = `${ws}-owner`
  const member = `${ws}-member`
  await seedUser(owner, '链路负责人')
  await seedUser(member, '链路成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }, { userId: member, role: 'member' }])

  let releaseLock: () => void = () => undefined
  let lockHeld: () => void = () => undefined
  const held = new Promise<void>(resolve => { lockHeld = resolve })
  const release = new Promise<void>(resolve => { releaseLock = resolve })
  const holder = database.begin(async transaction => {
    await transaction`
      select id from workspaces
       where tenant_id = ${tenantId} and id = ${ws}
       for update
    `
    lockHeld()
    await release
  })
  await held

  const pending = Promise.all([
    api('PATCH', `/api/workbench/v1/workspaces/${ws}/members/${member}`, { as: owner, body: { role: 'admin' } }),
    api('PATCH', `/api/workbench/v1/workspaces/${ws}/members/${member}`, { as: owner, body: { role: 'viewer' } }),
  ])
  await new Promise(resolve => setTimeout(resolve, 250))
  releaseLock()
  await holder
  const [first, second] = await pending
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)

  const rows = (await activityRows(ws)).filter(row => row.kind === 'role_changed')
  assert.equal(rows.length, 2, '两次真实角色转换各留一条动态')
  const transitions = rows.map(row => ({ from: row.metadata['from'], to: row.metadata['to'] }))
  // 两条动态谁先谁后取决于两个请求谁先拿到锁，因此按「链路」而不是按行序断言：
  // 恰好一条从初始角色出发，另一条的 from 必须接上它的 to，且终点是数据库里的最终角色。
  // 削弱实现（from 用锁外快照）时两条都会写 from=member，链无法衔接。
  const starts = transitions.filter(item => item.from === 'member')
  assert.equal(starts.length, 1, `恰好一条动态从初始角色出发，实际链路 ${JSON.stringify(transitions)}`)
  const rest = transitions.filter(item => item !== starts[0])
  assert.equal(rest.length, 1)
  assert.equal(rest[0]?.from, starts[0]?.to, `链路必须衔接，实际 ${JSON.stringify(transitions)}`)
  const [final] = await database<{ role: string }[]>`
    select member_role as role from workspace_members
     where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${member}
  `
  assert.equal(rest[0]?.to, final?.role, '链路终点必须是数据库里的最终角色')
  assert.deepEqual(
    transitions.map(item => item.to).sort(),
    ['admin', 'viewer'],
    '两个并发目标角色都必须各自留下一次真实转换',
  )

  // 撤销事件的 payload 同样不得写过期 from（同一处修复）。
  const revocation = await database<{ payload: { from?: string } }[]>`
    select payload from workspace_revocation_events
     where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${member} and kind = 'role_changed'
  `
  const revocationFrom = revocation.map(row => row.payload.from).sort()
  assert.deepEqual(
    revocationFrom,
    ['member', String(starts[0]?.to)].sort(),
    '撤销事件的 from 也必须来自事务内读取',
  )
})


test('被拒绝的成员变更不产生动态（业务成功才写动态）', async () => {
  const ws = uniqueWorkspace('member-fail')
  const owner = `${ws}-owner`
  const outsider = `${ws}-outsider`
  await seedUser(owner, '失败负责人')
  await seedUser(outsider, '目录外成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  // 让目标员工不在可添加目录内（停用）。
  await database`update users set status = 'disabled' where tenant_id = ${tenantId} and id = ${outsider}`

  const denied = await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, {
    as: owner,
    body: { userId: outsider, role: 'member' },
  })
  assert.ok(denied.status >= 400, '停用员工不得被添加')
  assert.equal((await activityRows(ws)).length, 0, '失败的成员变更不得留下动态')

  const removeOutsider = await api('DELETE', `/api/workbench/v1/workspaces/${ws}/members/${outsider}`, { as: owner })
  assert.equal(removeOutsider.status, 404)
  assert.equal((await activityRows(ws)).length, 0)
})

test('Agent 加入与移出各写入一条动态', async () => {
  const ws = uniqueWorkspace('agent')
  const owner = `${ws}-owner`
  const agentId = `agent-activity-${suffix}`
  await seedUser(owner, 'Agent 动态负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await createPublishedAgent(agentId)

  const added = await api('POST', `/api/workbench/v1/workspaces/${ws}/agent-members`, {
    as: owner,
    body: { agentId },
  })
  assert.equal(added.status, 201)
  const memberId = (added.body.data as { id: string }).id

  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${ws}/agent-members/${memberId}`, { as: owner })
  assert.equal(removed.status, 200)

  const rows = await activityRows(ws)
  assert.deepEqual(rows.map(row => row.kind), ['agent_member_added', 'agent_member_removed'])
  assert.deepEqual(rows[0]?.metadata, { agentMemberId: memberId, agentId })
  assert.equal(rows[0]?.objectType, 'agent_member')
  assert.equal(rows[0]?.objectId, memberId)
})

// ---------------------------------------------------------------------------
// 文件事件
// ---------------------------------------------------------------------------

test('文件上传/新版本/移除写入动态，且不泄露文件名或正文（AC-15）', async () => {
  const ws = uniqueWorkspace('file')
  const owner = `${ws}-owner`
  await seedUser(owner, '文件动态负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  const secretName = `并购底稿-${suffix}.txt`
  const secretBody = `绝密正文-${suffix}`
  const uploaded = await api('POST', `/api/workbench/v1/workspaces/${ws}/files`, {
    as: owner,
    raw: Buffer.from(secretBody),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(secretName) },
  })
  assert.equal(uploaded.status, 201)
  const logicalFileId = (uploaded.body.data as { logicalFileId: string }).logicalFileId

  const version = await api('POST', `/api/workbench/v1/workspaces/${ws}/files/${logicalFileId}/versions`, {
    as: owner,
    raw: Buffer.from(secretBody),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(`v2-${secretName}`) },
  })
  assert.equal(version.status, 201)

  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${ws}/files/${logicalFileId}`, { as: owner })
  assert.equal(removed.status, 200)

  const rows = await activityRows(ws)
  assert.deepEqual(rows.map(row => row.kind), ['file_uploaded', 'file_version_added', 'file_removed'])
  assert.deepEqual(rows[0]?.metadata, { logicalFileId, versionNo: 1 })
  assert.deepEqual(rows[1]?.metadata, { logicalFileId, versionNo: 2 })
  assert.deepEqual(rows[2]?.metadata, { logicalFileId })
  assert.equal(rows[0]?.objectType, 'file')

  // 动态载荷不得携带文件名、更新说明或正文。
  const serialized = JSON.stringify(rows)
  assert.equal(serialized.includes(secretName), false, '动态不得泄露共享文件名')
  assert.equal(serialized.includes(secretBody), false, '动态不得泄露文件正文')

  // 再次移除同一逻辑文件不得产生第二条动态。
  await api('DELETE', `/api/workbench/v1/workspaces/${ws}/files/${logicalFileId}`, { as: owner })
  assert.equal((await activityRows(ws)).filter(row => row.kind === 'file_removed').length, 1)
})

test('会话附件上传不进入团队动态（私有内容边界）', async () => {
  const ws = uniqueWorkspace('private')
  const owner = `${ws}-owner`
  await seedUser(owner, '私有边界负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  const sessionId = await seedSession(ws, owner)

  const attachmentName = `私密附件-${suffix}.txt`
  const module = await import('../modules/workbench/application/postgres-content-service.ts')
  const content = new module.PostgresContentService(database, storageRoot, authorization)
  await content.storeSessionFile(sessionId, attachmentName, 'text/plain', Buffer.from(`私有正文-${suffix}`), owner)

  const rows = await activityRows(ws)
  assert.equal(rows.length, 0, '会话附件属于私有内容，不得产生团队动态')
  assert.equal(JSON.stringify(rows).includes(attachmentName), false)
})

// ---------------------------------------------------------------------------
// 归档 / 恢复
// ---------------------------------------------------------------------------

test('归档与恢复写入动态；重复归档不重复写；归档→恢复→归档仍是两条不同动态', async () => {
  const ws = uniqueWorkspace('lifecycle')
  const owner = `${ws}-owner`
  await seedUser(owner, '生命周期负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  assert.equal((await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: owner })).status, 200)
  assert.equal((await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: owner })).status, 200)
  assert.equal((await api('POST', `/api/workbench/v1/workspaces/${ws}/restore`, { as: owner })).status, 200)
  assert.equal((await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: owner })).status, 200)

  const rows = await activityRows(ws)
  assert.deepEqual(rows.map(row => row.kind), ['workspace_archived', 'workspace_restored', 'workspace_archived'])
  assert.equal(new Set(rows.map(row => row.dedupeKey)).size, 3, '状态重复出现时必须用事务令牌区分')
  assert.equal(rows[0]?.objectType, 'workspace')
  assert.deepEqual(rows[0]?.metadata, {})
})

// ---------------------------------------------------------------------------
// Feed 可见性、分页、归档可读
// ---------------------------------------------------------------------------

test('`standalone` 哨兵与空白 id 一样被拒绝，且读接口不得创建个人空间（批次 4 质量评审 P2 顺带修复 3-T7）', async () => {
  // 与 4-T1 同源：`normalizeWorkspaceId` 把 '' 与 'standalone' 都归一为 null，
  // resolveReadableWorkspace 的 null 回退会 `ensurePersonalWorkspace()` 写库，于是
  // 一个 GET 会凭空建出调用者的个人空间。`users` 上的触发器会在用户插入时自动建
  // 个人空间，因此先临时停用它来构造「没有个人空间」的调用者。
  const actor = `user-activity-standalone-${randomUUID().replaceAll('-', '').slice(0, 8)}`
  await database`alter table users disable trigger users_personal_workspace_provisioning`
  try {
    await seedUser(actor, '哨兵动态调用者')
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

  // `standalone` 会被 normalizeWorkspaceId 归一为 null 从而**穿过**路由前置守卫，
  // 必须由服务层拒绝（422）；空白 id 则在路由守卫处按「不是成员」拒绝（403，既有
  // 行为）。两者都不得产生写副作用——这才是本条的关键。
  const standalone = await api('GET', '/api/workbench/v1/workspaces/standalone/activity', { as: actor })
  assert.equal(standalone.status, 422, 'standalone 哨兵必须类型化 422')
  assert.equal(await personalCount(), 0, 'standalone 不得触发个人空间创建（读接口无写副作用）')

  for (const rawId of [' ', '   ']) {
    const response = await api('GET', `/api/workbench/v1/workspaces/${encodeURIComponent(rawId)}/activity`, { as: actor })
    assert.equal(response.status, 403, `${rawId} 由路由守卫按非成员拒绝（既有行为）`)
    assert.equal(await personalCount(), 0, `${rawId} 不得触发个人空间创建（读接口无写副作用）`)
  }
})

test('动态仅成员可读；非成员与不存在空间返回完全一致的拒绝（不可枚举）', async () => {
  const ws = uniqueWorkspace('feed-access')
  const owner = `${ws}-owner`
  const stranger = `${ws}-stranger`
  await seedUser(owner, '动态可读负责人')
  await seedUser(stranger, '动态非成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: stranger, role: 'member' } })
  await api('DELETE', `/api/workbench/v1/workspaces/${ws}/members/${stranger}`, { as: owner })

  const memberRead = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity`, { as: owner })
  assert.equal(memberRead.status, 200)
  assert.ok((memberRead.body.data as { items: unknown[] }).items.length >= 1)

  const nonMember = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity`, { as: stranger })
  const missing = await api('GET', `/api/workbench/v1/workspaces/${ws}-missing/activity`, { as: stranger })
  assert.equal(nonMember.status, missing.status, '非成员与不存在空间状态码必须一致')
  // traceId 每次不同、object 会回显调用者自己传入的 id，这两项不构成枚举面；
  // 其余（状态码/错误码/文案/建议）必须逐字一致。
  for (const field of ['code', 'message', 'suggestion'] as const) {
    assert.equal(errorOf(nonMember)?.[field], errorOf(missing)?.[field], `非成员与不存在空间的 ${field} 必须一致，不能枚举`)
  }

  for (const path of ['notifications', 'activity']) {
    const denied = await api('GET', `/api/workbench/v1/workspaces/${ws}/${path}`, { as: stranger })
    assert.equal(denied.status, 403)
  }
})

test('归档空间的动态仍可读（读取轨），不因归档而消失', async () => {
  const ws = uniqueWorkspace('feed-archived')
  const owner = `${ws}-owner`
  const target = `${ws}-target`
  await seedUser(owner, '归档动态负责人')
  await seedUser(target, '归档动态成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: target, role: 'member' } })
  assert.equal((await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: owner })).status, 200)

  const feed = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity`, { as: target })
  assert.equal(feed.status, 200, '归档空间的现任成员仍可读取动态')
  const items = (feed.body.data as { items: WorkspaceActivityItem[] }).items
  assert.deepEqual(items.map(item => item.kind), ['workspace_archived', 'member_added'])

  const notifications = await api('GET', `/api/workbench/v1/workspaces/${ws}/notifications`, { as: target })
  assert.equal(notifications.status, 200)
})

test('动态 feed 按 (occurred_at, id) 最新优先做 keyset 分页，无重复无遗漏', async () => {
  const ws = uniqueWorkspace('feed-page')
  const owner = `${ws}-owner`
  await seedUser(owner, '分页负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  const targets = ['a', 'b', 'c'].map(index => `${ws}-${index}`)
  for (const target of targets) await seedUser(target, `分页成员-${target}`)
  for (const target of targets) {
    await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: target, role: 'member' } })
  }
  await api('PATCH', `/api/workbench/v1/workspaces/${ws}/members/${targets[0]}`, { as: owner, body: { role: 'viewer' } })
  await api('POST', `/api/workbench/v1/workspaces/${ws}/files`, {
    as: owner,
    raw: Buffer.from('分页正文'),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(`分页-${suffix}.txt`) },
  })

  const collected: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10; page += 1) {
    const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2'
    const response = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity${query}`, { as: owner })
    assert.equal(response.status, 200)
    const data = response.body.data as { items: WorkspaceActivityItem[]; nextCursor: string | null }
    collected.push(...data.items.map(item => item.id))
    cursor = data.nextCursor
    if (!cursor) break
  }
  assert.equal(collected.length, 5, '五条动态必须全部翻到且不重复')
  assert.equal(new Set(collected).size, 5)

  const all = await activity.listActivity({ workspaceId: ws, actorUserId: owner, limit: 20 })
  assert.deepEqual(collected, all.items.map(item => item.id), '分页顺序必须与一次性读取一致（最新优先）')

  const badCursor = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity?cursor=not-a-cursor`, { as: owner })
  assert.equal(badCursor.status, 422, '畸形游标必须是类型化 422')

  const badLimit = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity?limit=999`, { as: owner })
  assert.equal(badLimit.status, 422)
})

test('动态分页游标保留微秒精度：同一毫秒内的两条动态不会重复或遗漏', async () => {
  // 判别设计：两条动态的 occurred_at 只差微秒（同一毫秒），若游标用毫秒精度的
  // JS Date 回填，第二页会把 (occurred_at, id) < (截断后的时间, id) 判错，导致
  // 更旧那条被跳过。游标必须回填数据库的完整文本时间戳。
  const ws = uniqueWorkspace('feed-precision')
  const owner = `${ws}-owner`
  await seedUser(owner, '微秒分页负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await database`
    insert into workspace_activity_events (
      id, tenant_id, workspace_id, kind, actor_user_id, object_type, object_id,
      safe_metadata, dedupe_key, occurred_at
    ) values
      (${`wact-prec-newer-${suffix}`}, ${tenantId}, ${ws}, 'file_uploaded', ${owner}, 'file', 'wfile-a',
       ${database.json({ logicalFileId: 'wfile-a', versionNo: 1 })}, ${`file_uploaded:prec-newer:${suffix}`},
       '2026-01-01 00:00:00.123456+00'),
      (${`wact-prec-older-${suffix}`}, ${tenantId}, ${ws}, 'file_uploaded', ${owner}, 'file', 'wfile-b',
       ${database.json({ logicalFileId: 'wfile-b', versionNo: 1 })}, ${`file_uploaded:prec-older:${suffix}`},
       '2026-01-01 00:00:00.123001+00')
  `

  const firstPage = await activity.listActivity({ workspaceId: ws, actorUserId: owner, limit: 1 })
  assert.equal(firstPage.items[0]?.objectId, 'wfile-a', '最新（微秒更大）的一条先出')
  assert.ok(firstPage.nextCursor)
  const secondPage = await activity.listActivity({
    workspaceId: ws,
    actorUserId: owner,
    limit: 1,
    cursor: firstPage.nextCursor,
  })
  assert.equal(secondPage.items.length, 1, '第二页不得漏掉同一毫秒内更旧的一条')
  assert.equal(secondPage.items[0]?.objectId, 'wfile-b')
  assert.equal(secondPage.nextCursor, null)
})

test('构造型畸形游标一律类型化 422，绝不落 500（评审 F1/D1）', async () => {
  // 判别设计：这些游标 base64 与 JSON 都合法，只有 t 的值不是时间戳（或 i 含 NUL）。
  // 修复前它们会直达 SQL 的 `(($n::text)::timestamptz)`，PostgreSQL 报 22007/22021，
  // 被路由器分类成 500 operation_failed —— 任何成员都能制造 500 与告警噪音。
  const ws = uniqueWorkspace('bad-cursor')
  const owner = `${ws}-owner`
  await seedUser(owner, '畸形游标负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  const cursorOf = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const invalid: Array<[string, string]> = [
    ['非时间戳文本', cursorOf({ t: 'garbage', i: 'wact-x' })],
    ['空字符串', cursorOf({ t: '', i: '' })],
    ['不可能日期', cursorOf({ t: '2026-13-45 99:99:99', i: 'wact-x' })],
    ['NUL 字符', cursorOf({ t: '2026-01-01 00:00:00+00', i: 'bad\u0000id' })],
    ['数字 t', cursorOf({ t: 1, i: 'wact-x' })],
    ['超长 t', cursorOf({ t: 'x'.repeat(65), i: 'wact-x' })],
  ]
  for (const [label, cursor] of invalid) {
    for (const path of ['activity', 'notifications']) {
      const response = await api('GET', `/api/workbench/v1/workspaces/${ws}/${path}?cursor=${encodeURIComponent(cursor)}`, { as: owner })
      assert.equal(response.status, 422, `${label} 游标在 /${path} 上必须 422，实际 ${response.status}`)
      assert.equal(errorOf(response)?.code, 'invalid_request', `${label} 游标在 /${path} 上必须是类型化校验错误`)
    }
  }

  // 合法但已过期的游标仍然可用（时间戳合法就不该被误判为畸形）。
  const valid = await api(
    'GET',
    `/api/workbench/v1/workspaces/${ws}/activity?cursor=${encodeURIComponent(cursorOf({ t: '2026-01-01 00:00:00+00', i: 'wact-x' }))}`,
    { as: owner },
  )
  assert.equal(valid.status, 200, '合法时间戳游标不得被误拒绝')
})

test('limit 只接受 1..100 的十进制整数（拒绝 0x10 / 1e2 / 1.5 等 Number() 会放行的写法）', async () => {
  const ws = uniqueWorkspace('bad-limit')
  const owner = `${ws}-owner`
  await seedUser(owner, '畸形 limit 负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  // Number('0x10') === 16、Number('1e2') === 100 都能通过服务层的整数检查，
  // 必须在路由层按十进制形状拒绝。
  for (const raw of ['0x10', '1e2', '1.5', '-1', '+3', 'abc', '101', '0007']) {
    const response = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity?limit=${encodeURIComponent(raw)}`, { as: owner })
    assert.equal(response.status, 422, `limit=${raw} 必须 422，实际 ${response.status}`)
  }
  for (const raw of ['1', '3', '100']) {
    const response = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity?limit=${raw}`, { as: owner })
    assert.equal(response.status, 200, `limit=${raw} 必须 200`)
  }
  const omitted = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity`, { as: owner })
  assert.equal(omitted.status, 200, '缺省 limit 用默认值')
})

test('拒绝后的成员不能再用旧动态 id 读取（接收与点击都重新校验成员资格，AC-15）', async () => {
  const ws = uniqueWorkspace('revoke')
  const owner = `${ws}-owner`
  const member = `${ws}-member`
  await seedUser(owner, '收权负责人')
  await seedUser(member, '收权成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: member, role: 'member' } })

  const feed = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity`, { as: member })
  assert.equal(feed.status, 200)
  const activityId = (feed.body.data as { items: WorkspaceActivityItem[] }).items[0]!.id

  const before = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity/${activityId}`, { as: member })
  assert.equal(before.status, 200, '成员点击动态必须可读')

  assert.equal((await api('DELETE', `/api/workbench/v1/workspaces/${ws}/members/${member}`, { as: owner })).status, 200)

  const afterClick = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity/${activityId}`, { as: member })
  assert.equal(afterClick.status, 403, '失权成员不得通过旧动态 id 读取')
  const afterFeed = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity`, { as: member })
  assert.equal(afterFeed.status, 403)
  const afterNotifications = await api('GET', `/api/workbench/v1/workspaces/${ws}/notifications`, { as: member })
  assert.equal(afterNotifications.status, 403)
  const afterRead = await api('POST', `/api/workbench/v1/workspaces/${ws}/notifications/read`, { as: member })
  assert.equal(afterRead.status, 403)

  // 服务层同样在每次读取时重新校验（路由闸门之外的第二道门）。
  const serviceDenial = await activity.getActivityItem({ workspaceId: ws, activityId, actorUserId: member })
    .then(() => null, (error: unknown) => error)
  assert.ok(serviceDenial instanceof AuthorizationDeniedError, `服务层必须拒绝，实际：${String(serviceDenial)}`)
  assert.equal((serviceDenial as AuthorizationDeniedError).status, 403)
})

// ---------------------------------------------------------------------------
// 通知未读 / 标记已读 / 关闭提醒
// ---------------------------------------------------------------------------

test('未读数等于 last_read_at 之后的动态；标记已读后归零，新动态重新计入', async () => {
  const ws = uniqueWorkspace('unread')
  const owner = `${ws}-owner`
  const member = `${ws}-member`
  const second = `${ws}-second`
  await seedUser(owner, '未读负责人')
  await seedUser(member, '未读成员')
  await seedUser(second, '未读成员二')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: member, role: 'member' } })
  await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: second, role: 'member' } })

  const initial = await api('GET', `/api/workbench/v1/workspaces/${ws}/notifications`, { as: member })
  assert.equal(initial.status, 200)
  assert.equal((initial.body.data as { unreadCount: number }).unreadCount, 2, '未读等于 last_read_at 之后的动态条数')
  assert.equal((initial.body.data as { items: unknown[] }).items.length, 2)
  assert.equal((initial.body.data as { muted: boolean }).muted, false)

  const read = await api('POST', `/api/workbench/v1/workspaces/${ws}/notifications/read`, { as: member })
  assert.equal(read.status, 200)
  assert.equal((read.body.data as { unreadCount: number }).unreadCount, 0)
  assert.ok((read.body.data as { lastReadAt: string }).lastReadAt)

  const afterRead = await api('GET', `/api/workbench/v1/workspaces/${ws}/notifications`, { as: member })
  assert.equal((afterRead.body.data as { unreadCount: number }).unreadCount, 0)
  assert.equal((afterRead.body.data as { items: unknown[] }).items.length, 0)

  await api('POST', `/api/workbench/v1/workspaces/${ws}/files`, {
    as: owner,
    raw: Buffer.from('新动态正文'),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(`新动态-${suffix}.txt`) },
  })
  const afterNew = await api('GET', `/api/workbench/v1/workspaces/${ws}/notifications`, { as: member })
  assert.equal((afterNew.body.data as { unreadCount: number }).unreadCount, 1, '标记已读后的新动态必须重新计入未读')

  // 未读状态按用户隔离：负责人从未标记已读，未读数不同。
  const ownerView = await api('GET', `/api/workbench/v1/workspaces/${ws}/notifications`, { as: owner })
  assert.equal((ownerView.body.data as { unreadCount: number }).unreadCount, 3)
})

test('按空间关闭提醒后不再计数，但动态 feed 仍可见；重新开启后恢复计数', async () => {
  const ws = uniqueWorkspace('mute')
  const owner = `${ws}-owner`
  const member = `${ws}-member`
  await seedUser(owner, '提醒负责人')
  await seedUser(member, '提醒成员')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])
  await api('POST', `/api/workbench/v1/workspaces/${ws}/members`, { as: owner, body: { userId: member, role: 'member' } })

  const muted = await api('POST', `/api/workbench/v1/workspaces/${ws}/notifications/mute`, { as: member })
  assert.equal(muted.status, 200)
  assert.equal((muted.body.data as { muted: boolean }).muted, true)
  assert.equal((muted.body.data as { unreadCount: number }).unreadCount, 0, '关闭提醒后不计未读')

  const view = await api('GET', `/api/workbench/v1/workspaces/${ws}/notifications`, { as: member })
  assert.equal((view.body.data as { muted: boolean }).muted, true)
  assert.equal((view.body.data as { unreadCount: number }).unreadCount, 0)
  assert.equal((view.body.data as { items: unknown[] }).items.length, 1, '关闭提醒不隐藏未读条目')

  const feed = await api('GET', `/api/workbench/v1/workspaces/${ws}/activity`, { as: member })
  assert.equal(feed.status, 200, '动态 feed 不受提醒开关影响')
  assert.equal((feed.body.data as { items: unknown[] }).items.length, 1)

  const unmuted = await api('POST', `/api/workbench/v1/workspaces/${ws}/notifications/unmute`, { as: member })
  assert.equal(unmuted.status, 200)
  assert.equal((unmuted.body.data as { muted: boolean }).muted, false)
  assert.equal((unmuted.body.data as { unreadCount: number }).unreadCount, 1, '重新开启提醒后恢复未读计数')
})

test('标记已读不得把 last_read_at 往回拨（并发/时钟回退下的单调性，评审 F4）', async () => {
  // 判别设计：先把 last_read_at 预置到未来，再调用「标记全部已读」。修复前
  // `do update set last_read_at = now()` 会把它覆盖成当前时间，未读计数随之复活——
  // 即已读状态可以倒退。修复后取 greatest(现值, now())。
  const ws = uniqueWorkspace('monotonic')
  const owner = `${ws}-owner`
  await seedUser(owner, '单调性负责人')
  await seedTeamWorkspace(ws, [{ userId: owner, role: 'owner' }])

  await database`
    insert into workspace_notification_states (tenant_id, workspace_id, user_id, last_read_at, muted_at)
    values (${tenantId}, ${ws}, ${owner}, '2099-01-01 00:00:00+00', null)
  `
  const read = await api('POST', `/api/workbench/v1/workspaces/${ws}/notifications/read`, { as: owner })
  assert.equal(read.status, 200)
  assert.ok(
    (read.body.data as { lastReadAt: string }).lastReadAt.startsWith('2099-01-01'),
    `last_read_at 不得倒退，实际 ${(read.body.data as { lastReadAt: string }).lastReadAt}`,
  )
  // 后台状态同样不得倒退。
  const [state] = await database<{ lastReadAt: Date }[]>`
    select last_read_at as "lastReadAt" from workspace_notification_states
     where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${owner}
  `
  assert.equal(state?.lastReadAt.toISOString().slice(0, 10), '2099-01-01')

  // 反向：正常向前推进仍然生效。
  await database`
    update workspace_notification_states set last_read_at = '2000-01-01 00:00:00+00'
     where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${owner}
  `
  const advanced = await api('POST', `/api/workbench/v1/workspaces/${ws}/notifications/read`, { as: owner })
  assert.equal((advanced.body.data as { lastReadAt: string }).lastReadAt.startsWith('2000-01-01'), false, '落后于当前时间的已读位置必须被推进')
})


// ---------------------------------------------------------------------------
// AC-23：个人空间没有动态与通知面
// ---------------------------------------------------------------------------

test('个人空间拒绝动态与通知接口，且不产生任何动态（AC-23）', async () => {
  const owner = `user-activity-personal-${suffix}`
  await seedUser(owner, '个人空间用户')
  const personalWorkspaceId = `ws-personal-${owner}`

  const calls: Array<[string, string]> = [
    ['GET', `/api/workbench/v1/workspaces/${personalWorkspaceId}/activity`],
    ['GET', `/api/workbench/v1/workspaces/${personalWorkspaceId}/activity/wact-anything`],
    ['GET', `/api/workbench/v1/workspaces/${personalWorkspaceId}/notifications`],
    ['POST', `/api/workbench/v1/workspaces/${personalWorkspaceId}/notifications/read`],
    ['POST', `/api/workbench/v1/workspaces/${personalWorkspaceId}/notifications/mute`],
    ['POST', `/api/workbench/v1/workspaces/${personalWorkspaceId}/notifications/unmute`],
  ]
  for (const [method, path] of calls) {
    const response = await api(method, path, { as: owner })
    assert.equal(response.status, 422, `${method} ${path} 在个人空间必须 422（团队专用）`)
  }

  const [count] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_activity_events
     where tenant_id = ${tenantId} and workspace_id = ${personalWorkspaceId}
  `
  assert.equal(count?.count, 0, '个人空间不得有任何动态')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueWorkspace(label: string) {
  return `ws-activity-${label}-${suffix}`
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
  options: { as?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.as) headers['x-test-user-id'] = options.as
  let body: string | Uint8Array | undefined
  if (options.raw !== undefined) body = new Uint8Array(options.raw)
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body as BodyInit | undefined })
  const text = await response.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: response.status, body: parsed as { data?: unknown; error?: { code: string; message: string; suggestion?: string } }, text }
}

function errorOf(result: { body: { error?: { code: string; message: string; suggestion?: string } } }) {
  return result.body.error
}

async function activityRows(workspaceId: string): Promise<ActivityRow[]> {
  return database<ActivityRow[]>`
    select id, kind, actor_user_id as "actorUserId", object_type as "objectType",
           object_id as "objectId", safe_metadata as metadata, dedupe_key as "dedupeKey",
           occurred_at as "occurredAt"
      from workspace_activity_events
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by occurred_at asc, id asc
  `
}

async function tableColumns(table: string): Promise<string[]> {
  const rows = await database<{ columnName: string }[]>`
    select column_name as "columnName" from information_schema.columns
     where table_schema = 'public' and table_name = ${table}
     order by ordinal_position
  `
  return rows.map(row => row.columnName)
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
) {
  const ownerId = members[0]?.userId ?? 'U00001'
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '3-T7 团队动态测试空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

async function seedSession(workspaceId: string, userId: string) {
  const sessionId = `session-${randomUUID()}`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, ${workspaceId}, ${userId}, 'agent-version-dsh-work-assistant-1', '动态私有边界会话', 'active')
  `
  return sessionId
}

async function createPublishedAgent(agentId: string) {
  const versionId = `agent-version-${agentId}-1-0-0`
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
      status, active_version_id, allow_workspace_join
    ) values (
      ${agentId}, ${tenantId}, '动态测试 Agent', '3-T7 Agent 成员动态。', '',
      'U00008', 'U00008', 'published', null, true
    )
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_output_bytes, max_tool_calls,
      timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${agentId}, '1.0.0', '动态测试 Agent', '3-T7 Agent 成员动态。',
      '', ${database.json(['测试'] as string[])}, '你是动态测试 Agent。',
      ${database.json(['role-employee'] as string[])}, ${database.json(['enterprise:authorized'] as string[])},
      65536, 20, 300, ${database.json([] as string[])}, ${database.json([] as string[])},
      'published', 'U00008', '3-T7 测试版本'
    )
  `
  await database`
    update agents set active_version_id = ${versionId}
     where tenant_id = ${tenantId} and id = ${agentId}
  `
  return versionId
}
