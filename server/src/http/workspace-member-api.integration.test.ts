import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresWorkspaceMemberService } from '../modules/workbench/application/postgres-workspace-member-service.ts'
import { Router } from './router.ts'
import { registerWorkspaceMemberRoutes } from './workbench/workspace-member-routes.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let server: Server
let baseUrl = ''
let authorization: PostgresAuthorizationService
let members: PostgresWorkspaceMemberService

interface MemberRow {
  userId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
}

interface RevocationEventRow {
  userId: string
  kind: string
  payload: Record<string, string>
  payloadHash: string
  status: string
}

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_member_api_test', maxConnections: 8 })
  database = throwaway.client

  authorization = new PostgresAuthorizationService(database)
  members = new PostgresWorkspaceMemberService(database, authorization)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerWorkspaceMemberRoutes(router, members, authorization)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP Server 没有获得端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
})

// ---------------------------------------------------------------------------
// 成员候选人查询
// ---------------------------------------------------------------------------

test('负责人可以分页搜索业务员工目录候选人，仅返回最小字段并排除已有成员', async () => {
  const workspaceId = 'ws-1a-candidates'
  const ownerId = 'user-1a-cand-owner'
  const joinedId = 'user-1a-cand-joined'
  await createDirectoryUser(ownerId, '甄负责人', { department: '总经办' })
  await createDirectoryUser(joinedId, '艾已加入', { department: '供应链中心' })
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: joinedId, role: 'member' },
  ])
  const directory = [
    { id: 'user-1a-cand-a', name: '候选员工1' },
    { id: 'user-1a-cand-b', name: '候选员工2' },
    { id: 'user-1a-cand-c', name: '候选员工3' },
    { id: 'user-1a-cand-d', name: '候选员工4' },
    { id: 'user-1a-cand-e', name: '候选员工5' },
  ]
  for (const item of directory) await createDirectoryUser(item.id, item.name, { department: '数字化中心' })

  const first = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates?limit=2`, { as: ownerId })
  assert.equal(first.status, 200)
  const firstPage = first.body.data as { items: Array<Record<string, unknown>>; nextCursor: string | null }
  assert.equal(firstPage.items.length, 2)
  assert.deepEqual(firstPage.items.map(item => item.id), [directory[0]?.id, directory[1]?.id])
  assert.ok(firstPage.nextCursor)
  for (const item of firstPage.items) {
    assert.deepEqual(Object.keys(item).sort(), ['department', 'displayName', 'id'].sort())
  }

  const second = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`, { as: ownerId })
  assert.equal(second.status, 200)
  const secondPage = second.body.data as { items: Array<Record<string, unknown>>; nextCursor: string | null }
  assert.deepEqual(secondPage.items.map(item => item.id), [directory[2]?.id, directory[3]?.id])
  assert.ok(secondPage.nextCursor)

  const third = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates?limit=2&cursor=${encodeURIComponent(secondPage.nextCursor ?? '')}`, { as: ownerId })
  assert.equal(third.status, 200)
  const thirdPage = third.body.data as { items: Array<Record<string, unknown>>; nextCursor: string | null }
  assert.deepEqual(thirdPage.items.map(item => item.id), [directory[4]?.id])
  assert.equal(thirdPage.nextCursor, null)

  // 分页结果按 display_name 稳定排序，且不包含空间已有成员与不合目录条件的用户。
  const all = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates?limit=100`, { as: ownerId })
  const allPage = all.body.data as { items: Array<Record<string, unknown>> }
  const ids = allPage.items.map(item => item.id)
  assert.deepEqual(ids, [directory[0]?.id, directory[1]?.id, directory[2]?.id, directory[3]?.id, directory[4]?.id])
  assert.ok(!ids.includes(joinedId))
  assert.ok(!ids.includes(ownerId))
})

test('候选人搜索支持按姓名过滤，离职/停用/非业务/无应用访问账户不可选', async () => {
  const workspaceId = 'ws-1a-cand-filter'
  const ownerId = 'user-1a-cand-filter-owner'
  await createDirectoryUser(ownerId, '候选人过滤负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createDirectoryUser('user-1a-filter-match-a', '员工张伟A')
  await createDirectoryUser('user-1a-filter-match-b', '员工张伟B')
  await createDirectoryUser('user-1a-filter-other', '员工李娜')
  await createDirectoryUser('user-1a-filter-disabled', '员工停用张伟', { status: 'disabled' })
  await createDirectoryUser('user-1a-filter-nonbusiness', '员工平台张伟', { business: false })
  await createDirectoryUser('user-1a-filter-no-access', '员工无权张伟', { grantWorkbench: false })
  // 独立账号（本地）员工与 AI Hub 员工同等可选。
  await createDirectoryUser('user-1a-filter-local', '员工本地张伟', { provider: 'local' })

  const search = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates?query=${encodeURIComponent('张伟')}`, { as: ownerId })
  assert.equal(search.status, 200)
  const ids = (search.body.data as { items: Array<{ id: string }> }).items.map(item => item.id)
  assert.deepEqual(ids, ['user-1a-filter-match-a', 'user-1a-filter-match-b', 'user-1a-filter-local'])
  assert.ok(!ids.includes('user-1a-filter-disabled'))
  assert.ok(!ids.includes('user-1a-filter-nonbusiness'))
  assert.ok(!ids.includes('user-1a-filter-no-access'))
  assert.ok(!ids.includes('user-1a-filter-other'))
})

test('候选人搜索仅负责人与管理员可用，成员与只读成员被拒绝', async () => {
  const workspaceId = 'ws-1a-cand-roles'
  const ownerId = 'user-1a-cand-roles-owner'
  const memberId = 'user-1a-cand-roles-member'
  const viewerId = 'user-1a-cand-roles-viewer'
  await createDirectoryUser(ownerId, '候选人角色负责人')
  await createDirectoryUser(memberId, '候选人角色成员')
  await createDirectoryUser(viewerId, '候选人角色只读')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])

  const asMember = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates`, { as: memberId })
  assert.equal(asMember.status, 403)
  assert.match(errorMessage(asMember), /无权执行/)

  const asViewer = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates`, { as: viewerId })
  assert.equal(asViewer.status, 403)
})

test('候选人搜索拒绝无效分页游标与越界 limit', async () => {
  const workspaceId = 'ws-1a-cand-params'
  const ownerId = 'user-1a-cand-params-owner'
  await createDirectoryUser(ownerId, '候选人参数负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const badCursor = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates?cursor=${encodeURIComponent('不是游标')}`, { as: ownerId })
  assert.equal(badCursor.status, 422)
  assert.match(errorMessage(badCursor), /游标无效/)

  const badLimit = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates?limit=0`, { as: ownerId })
  assert.equal(badLimit.status, 422)
  assert.match(errorMessage(badLimit), /limit/)
})

// ---------------------------------------------------------------------------
// 添加成员
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 成员名册读取
// ---------------------------------------------------------------------------

test('任何成员可读取员工名册并拿到自己的角色，非成员被拒绝', async () => {
  const workspaceId = 'ws-1a-roster'
  const ownerId = 'user-1a-roster-owner'
  const adminId = 'user-1a-roster-admin'
  const memberId = 'user-1a-roster-member'
  const viewerId = 'user-1a-roster-viewer'
  const outsiderId = 'user-1a-roster-outsider'
  await createDirectoryUser(ownerId, '名册负责人')
  await createDirectoryUser(adminId, '名册管理员')
  await createDirectoryUser(memberId, '名册成员')
  await createDirectoryUser(viewerId, '名册只读')
  await createDirectoryUser(outsiderId, '名册外部人')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])

  // 每个成员看到同一份名册，但 currentUserRole 是自己的角色。
  const asOwner = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/members`, { as: ownerId })
  assert.equal(asOwner.status, 200)
  const directory = asOwner.body.data as { items: Array<{ userId: string; role: string }>; currentUserRole: string }
  assert.equal(directory.currentUserRole, 'owner')
  assert.deepEqual(
    directory.items.map(item => item.userId),
    [ownerId, adminId, memberId, viewerId],
    '按负责人→管理员→成员→只读排序',
  )
  assert.equal(directory.items.length, 4)

  for (const [userId, role] of [[adminId, 'admin'], [memberId, 'member'], [viewerId, 'viewer']] as const) {
    const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/members`, { as: userId })
    assert.equal(result.status, 200)
    assert.equal((result.body.data as { currentUserRole: string }).currentUserRole, role)
  }

  const outsider = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/members`, { as: outsiderId })
  assert.equal(outsider.status, 403, '非成员不得读取名册')
})

test('员工名册按候选同一口径返回部门，缺省为「未分配部门」（5-T2）', async () => {
  const workspaceId = 'ws-1a-roster-dept'
  const ownerId = 'user-1a-roster-dept-owner'
  const memberId = 'user-1a-roster-dept-member'
  const noDeptId = 'user-1a-roster-dept-none'
  const candidateId = 'user-1a-roster-dept-candidate'
  await createDirectoryUser(ownerId, '部门名册负责人', { department: '供应链中心' })
  await createDirectoryUser(memberId, '部门名册成员', { department: '计划部' })
  await createDirectoryUser(noDeptId, '部门名册无部门', { department: null })
  await createDirectoryUser(candidateId, '部门名册候选无部门', { department: null })
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: noDeptId, role: 'viewer' },
  ])

  const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/members`, { as: ownerId })
  assert.equal(result.status, 200)
  const items = (result.body.data as { items: Array<Record<string, unknown>> }).items
  assert.deepEqual(items.map(item => item.userId), [ownerId, memberId, noDeptId])
  assert.equal(items[0]?.department, '供应链中心', '名册部门与 users.department_id 一致')
  assert.equal(items[1]?.department, '计划部')
  assert.equal(items[2]?.department, '未分配部门', '缺省部门与候选名册同一口径')
  assert.deepEqual(
    Object.keys(items[0] ?? {}).sort(),
    ['department', 'displayName', 'joinedAt', 'role', 'userId'].sort(),
  )

  // 候选名册同一用户的部门口径必须一致。
  const candidates = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates?limit=100`, { as: ownerId })
  assert.equal(candidates.status, 200)
  const candidate = (candidates.body.data as { items: Array<{ id: string; department: string }> }).items
    .find(item => item.id === candidateId)
  assert.equal(candidate?.department, '未分配部门')
})

test('成员名册对个人工作空间被拒绝', async () => {
  const personalId = 'ws-personal-user-1a-roster-personal'
  await createDirectoryUser('user-1a-roster-personal', '名册个人空间用户')
  const result = await api('GET', `/api/workbench/v1/workspaces/${personalId}/members`, { as: 'user-1a-roster-personal' })
  assert.equal(result.status, 422)
  assert.match(errorMessage(result), /仅支持团队工作空间/)
})

test('负责人添加成员成功后写入成员关系、提升团队授权修订号', async () => {
  const workspaceId = 'ws-1a-add'
  const ownerId = 'user-1a-add-owner'
  const targetId = 'user-1a-add-target'
  await createDirectoryUser(ownerId, '添加成员负责人')
  await createDirectoryUser(targetId, '添加目标甲', { department: '供应链中心' })
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const result = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: targetId, role: 'member' },
  })
  assert.equal(result.status, 201)
  assert.deepEqual(result.body.data, {
    userId: targetId,
    displayName: '添加目标甲',
    role: 'member',
    joinedAt: (result.body.data as { joinedAt: string }).joinedAt,
  })
  assert.deepEqual(await memberRoles(workspaceId), [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'member' },
  ])
  assert.equal(await revision(workspaceId), 1)
})

test('重复添加同一成员同一角色保持幂等，不重复写入也不提升修订号', async () => {
  const workspaceId = 'ws-1a-add-idempotent'
  const ownerId = 'user-1a-add-idem-owner'
  const targetId = 'user-1a-add-idem-target'
  await createDirectoryUser(ownerId, '幂等添加负责人')
  await createDirectoryUser(targetId, '幂等添加目标')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const first = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: targetId, role: 'viewer' },
  })
  assert.equal(first.status, 201)
  assert.equal(await revision(workspaceId), 1)

  const replay = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: targetId, role: 'viewer' },
  })
  assert.equal(replay.status, 200)
  assert.equal((replay.body.data as { role: string }).role, 'viewer')
  assert.deepEqual(await memberRoles(workspaceId), [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'viewer' },
  ])
  assert.equal(await revision(workspaceId), 1)
})

test('已有成员以不同角色重复添加被明确拒绝（角色变更走 PATCH）', async () => {
  const workspaceId = 'ws-1a-add-mismatch'
  const ownerId = 'user-1a-add-mm-owner'
  const targetId = 'user-1a-add-mm-target'
  await createDirectoryUser(ownerId, '角色冲突负责人')
  await createDirectoryUser(targetId, '角色冲突目标')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'viewer' },
  ])

  const result = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: targetId, role: 'member' },
  })
  assert.equal(result.status, 409)
  assert.match(errorMessage(result), /已是空间成员/)
})

test('停用、非业务员工、无应用访问资格与未知员工均不能添加；独立账号员工可以添加', async () => {
  const workspaceId = 'ws-1a-add-invalid'
  const ownerId = 'user-1a-add-inv-owner'
  await createDirectoryUser(ownerId, '无效目标负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createDirectoryUser('user-1a-add-inv-disabled', '停用员工', { status: 'disabled' })
  await createDirectoryUser('user-1a-add-inv-nonbusiness', '平台员工', { business: false })
  await createDirectoryUser('user-1a-add-inv-noaccess', '无权员工', { grantWorkbench: false })
  await createDirectoryUser('user-1a-add-inv-local', '本地员工', { provider: 'local' })

  const disabled = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: 'user-1a-add-inv-disabled', role: 'member' },
  })
  assert.equal(disabled.status, 409)
  assert.match(errorMessage(disabled), /已停用/)

  const nonBusiness = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: 'user-1a-add-inv-nonbusiness', role: 'member' },
  })
  assert.equal(nonBusiness.status, 409)
  assert.match(errorMessage(nonBusiness), /业务员工目录/)

  const noAccess = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: 'user-1a-add-inv-noaccess', role: 'member' },
  })
  assert.equal(noAccess.status, 409)
  assert.match(errorMessage(noAccess), /工作台使用权限/)

  const local = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: 'user-1a-add-inv-local', role: 'member' },
  })
  assert.equal(local.status, 201, JSON.stringify(local.body))

  const missing = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: 'user-1a-add-inv-missing', role: 'member' },
  })
  assert.equal(missing.status, 404)
  assert.match(errorMessage(missing), /目标员工不存在/)
})

test('无效角色被拒绝；负责人不能直接添加负责人', async () => {
  const workspaceId = 'ws-1a-add-roles'
  const ownerId = 'user-1a-add-roles-owner'
  const targetId = 'user-1a-add-roles-target'
  await createDirectoryUser(ownerId, '角色范围负责人')
  await createDirectoryUser(targetId, '角色范围目标')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const bogus = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: targetId, role: 'boss' },
  })
  assert.equal(bogus.status, 422)
  assert.match(errorMessage(bogus), /无效的角色/)

  const secondOwner = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: targetId, role: 'owner' },
  })
  assert.equal(secondOwner.status, 409)
  assert.match(errorMessage(secondOwner), /负责人不能直接设置/)
})

test('管理员只能添加成员与只读成员，不能任命管理员', async () => {
  const workspaceId = 'ws-1a-add-admin'
  const ownerId = 'user-1a-add-admin-owner'
  const adminId = 'user-1a-add-admin-admin'
  const memberTargetId = 'user-1a-add-admin-member'
  const adminTargetId = 'user-1a-add-admin-target'
  await createDirectoryUser(ownerId, '管理员添加负责人')
  await createDirectoryUser(adminId, '管理员添加管理员')
  await createDirectoryUser(memberTargetId, '管理员添加成员目标')
  await createDirectoryUser(adminTargetId, '管理员添加管理员目标')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
  ])

  const addMember = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: adminId,
    body: { userId: memberTargetId, role: 'member' },
  })
  assert.equal(addMember.status, 201)

  const addViewer = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: adminId,
    body: { userId: adminTargetId, role: 'viewer' },
  })
  assert.equal(addViewer.status, 201)

  const appointAdmin = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: adminId,
    body: { userId: adminTargetId, role: 'admin' },
  })
  assert.equal(appointAdmin.status, 403)
  assert.match(errorMessage(appointAdmin), /没有权限任命管理员/)
})

test('负责人可以任命管理员', async () => {
  const workspaceId = 'ws-1a-add-appoint'
  const ownerId = 'user-1a-add-appoint-owner'
  const targetId = 'user-1a-add-appoint-target'
  await createDirectoryUser(ownerId, '任命管理员负责人')
  await createDirectoryUser(targetId, '任命管理员目标')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const result = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: targetId, role: 'admin' },
  })
  assert.equal(result.status, 201)
  assert.equal((result.body.data as { role: string }).role, 'admin')
  assert.deepEqual(await memberRoles(workspaceId), [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'admin' },
  ])
})

test('成员与只读成员不能添加成员', async () => {
  const workspaceId = 'ws-1a-add-denied'
  const ownerId = 'user-1a-add-denied-owner'
  const memberId = 'user-1a-add-denied-member'
  const viewerId = 'user-1a-add-denied-viewer'
  const targetId = 'user-1a-add-denied-target'
  await createDirectoryUser(ownerId, '添加拒绝负责人')
  await createDirectoryUser(memberId, '添加拒绝成员')
  await createDirectoryUser(viewerId, '添加拒绝只读')
  await createDirectoryUser(targetId, '添加拒绝目标')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])

  const asMember = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: memberId,
    body: { userId: targetId, role: 'member' },
  })
  assert.equal(asMember.status, 403)
  assert.match(errorMessage(asMember), /无权执行/)

  const asViewer = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: viewerId,
    body: { userId: targetId, role: 'viewer' },
  })
  assert.equal(asViewer.status, 403)
})

// ---------------------------------------------------------------------------
// 角色变更
// ---------------------------------------------------------------------------

test('负责人可以把成员提升为管理员，写入 role_changed 事件并提升修订号', async () => {
  const workspaceId = 'ws-1a-patch-promote'
  const ownerId = 'user-1a-patch-prom-owner'
  const targetId = 'user-1a-patch-prom-target'
  await createDirectoryUser(ownerId, '提升管理员负责人')
  await createDirectoryUser(targetId, '提升管理员目标')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'member' },
  ])

  const result = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${targetId}`, {
    as: ownerId,
    body: { role: 'admin' },
  })
  assert.equal(result.status, 200)
  assert.equal((result.body.data as { role: string }).role, 'admin')
  assert.equal(await revision(workspaceId), 1)

  const events = await revocationEvents(workspaceId)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event?.userId, targetId)
  assert.equal(event?.kind, 'role_changed')
  assert.equal(event?.status, 'pending')
  assert.deepEqual(event?.payload, { from: 'member', to: 'admin', by: ownerId })
  assert.ok(event?.payloadHash && /^[0-9a-f]{32}$/.test(event?.payloadHash ?? ''))
})

test('负责人可以把管理员降级为成员', async () => {
  const workspaceId = 'ws-1a-patch-demote'
  const ownerId = 'user-1a-patch-dem-owner'
  const adminId = 'user-1a-patch-dem-admin'
  await createDirectoryUser(ownerId, '降级管理员负责人')
  await createDirectoryUser(adminId, '降级管理员目标')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
  ])

  const result = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${adminId}`, {
    as: ownerId,
    body: { role: 'member' },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(await memberRoles(workspaceId), [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'member' },
  ])
})

test('管理员只能调整成员与只读成员的角色，不能碰管理员与负责人', async () => {
  const workspaceId = 'ws-1a-patch-admin'
  const ownerId = 'user-1a-patch-adm-owner'
  const adminId = 'user-1a-patch-adm-admin'
  const memberId = 'user-1a-patch-adm-member'
  const otherAdminId = 'user-1a-patch-adm-other'
  await createDirectoryUser(ownerId, '管理员改角色负责人')
  await createDirectoryUser(adminId, '管理员改角色管理员')
  await createDirectoryUser(memberId, '管理员改角色成员')
  await createDirectoryUser(otherAdminId, '管理员改角色另一位管理员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
    { userId: otherAdminId, role: 'admin' },
  ])

  const toViewer = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${memberId}`, {
    as: adminId,
    body: { role: 'viewer' },
  })
  assert.equal(toViewer.status, 200)

  const toAdmin = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${memberId}`, {
    as: adminId,
    body: { role: 'admin' },
  })
  assert.equal(toAdmin.status, 403)
  assert.match(errorMessage(toAdmin), /没有权限任命管理员/)

  const touchAdmin = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${otherAdminId}`, {
    as: adminId,
    body: { role: 'member' },
  })
  assert.equal(touchAdmin.status, 403)
  assert.match(errorMessage(touchAdmin), /没有权限调整管理员的角色/)

  const touchOwner = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${ownerId}`, {
    as: adminId,
    body: { role: 'member' },
  })
  assert.equal(touchOwner.status, 403)
  assert.match(errorMessage(touchOwner), /负责人的角色/)
})

test('任何人都不能通过 PATCH 调整负责人角色；负责人转交是唯一途径', async () => {
  const workspaceId = 'ws-1a-patch-owner'
  const ownerId = 'user-1a-patch-own-owner'
  const memberId = 'user-1a-patch-own-member'
  await createDirectoryUser(ownerId, '负责人角色保护负责人')
  await createDirectoryUser(memberId, '负责人角色保护成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])

  const ownerSelf = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${ownerId}`, {
    as: ownerId,
    body: { role: 'member' },
  })
  assert.equal(ownerSelf.status, 403)
  assert.match(errorMessage(ownerSelf), /负责人的角色/)

  const promoteToOwner = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${memberId}`, {
    as: ownerId,
    body: { role: 'owner' },
  })
  assert.equal(promoteToOwner.status, 409)
  assert.match(errorMessage(promoteToOwner), /负责人不能直接设置/)
})

test('角色变更对非成员目标返回明确错误', async () => {
  const workspaceId = 'ws-1a-patch-missing'
  const ownerId = 'user-1a-patch-mis-owner'
  const outsiderId = 'user-1a-patch-mis-outsider'
  await createDirectoryUser(ownerId, '非成员改角色负责人')
  await createDirectoryUser(outsiderId, '非成员改角色目标')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const result = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${outsiderId}`, {
    as: ownerId,
    body: { role: 'member' },
  })
  assert.equal(result.status, 404)
  assert.match(errorMessage(result), /目标成员不存在于该空间/)
})

test('相同角色的重复变更保持幂等，不重复写入事件', async () => {
  const workspaceId = 'ws-1a-patch-idempotent'
  const ownerId = 'user-1a-patch-idem-owner'
  const targetId = 'user-1a-patch-idem-target'
  await createDirectoryUser(ownerId, '幂等改角色负责人')
  await createDirectoryUser(targetId, '幂等改角色目标')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'member' },
  ])

  const first = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${targetId}`, {
    as: ownerId,
    body: { role: 'viewer' },
  })
  assert.equal(first.status, 200)
  assert.equal(await revision(workspaceId), 1)
  assert.equal((await revocationEvents(workspaceId)).length, 1)

  const replay = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${targetId}`, {
    as: ownerId,
    body: { role: 'viewer' },
  })
  assert.equal(replay.status, 200)
  assert.equal((replay.body.data as { role: string }).role, 'viewer')
  assert.equal(await revision(workspaceId), 1)
  assert.equal((await revocationEvents(workspaceId)).length, 1)
})

test('角色变更事件按去重键幂等：相同 payload 只保留一条', async () => {
  const workspaceId = 'ws-1a-patch-dedupe'
  const ownerId = 'user-1a-patch-ded-owner'
  const targetId = 'user-1a-patch-ded-target'
  await createDirectoryUser(ownerId, '事件去重负责人')
  await createDirectoryUser(targetId, '事件去重目标')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'member' },
  ])

  // member -> viewer（写入事件） -> member -> viewer（payload 相同，去重）
  await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${targetId}`, { as: ownerId, body: { role: 'viewer' } })
  await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${targetId}`, { as: ownerId, body: { role: 'member' } })
  await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${targetId}`, { as: ownerId, body: { role: 'viewer' } })

  const events = await revocationEvents(workspaceId)
  const samePayload = events.filter(event => event.kind === 'role_changed' && event.payload.from === 'member' && event.payload.to === 'viewer')
  assert.equal(samePayload.length, 1)
  assert.equal(events.length, 2)
})

// ---------------------------------------------------------------------------
// 移除成员
// ---------------------------------------------------------------------------

test('负责人移除成员后写入 member_removed 事件并提升修订号，贡献记录不受影响', async () => {
  const workspaceId = 'ws-1a-remove'
  const ownerId = 'user-1a-remove-owner'
  const targetId = 'user-1a-remove-target'
  await createDirectoryUser(ownerId, '移除成员负责人')
  await createDirectoryUser(targetId, '移除成员目标')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'member' },
  ])

  const result = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/members/${targetId}`, { as: ownerId })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.data, { userId: targetId, removed: true })
  assert.deepEqual(await memberRoles(workspaceId), [{ userId: ownerId, role: 'owner' }])
  assert.equal(await revision(workspaceId), 1)

  const events = await revocationEvents(workspaceId)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event?.userId, targetId)
  assert.equal(event?.kind, 'member_removed')
  assert.equal(event?.status, 'pending')
  assert.deepEqual(event?.payload, { by: ownerId })
})

test('管理员可以移除成员与只读成员，不能移除管理员或负责人', async () => {
  const workspaceId = 'ws-1a-remove-admin'
  const ownerId = 'user-1a-rem-adm-owner'
  const adminId = 'user-1a-rem-adm-admin'
  const memberId = 'user-1a-rem-adm-member'
  const otherAdminId = 'user-1a-rem-adm-other'
  await createDirectoryUser(ownerId, '管理员移除负责人')
  await createDirectoryUser(adminId, '管理员移除管理员')
  await createDirectoryUser(memberId, '管理员移除成员')
  await createDirectoryUser(otherAdminId, '管理员移除另一位管理员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
    { userId: otherAdminId, role: 'admin' },
  ])

  const removeMember = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/members/${memberId}`, { as: adminId })
  assert.equal(removeMember.status, 200)

  const removeAdmin = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/members/${otherAdminId}`, { as: adminId })
  assert.equal(removeAdmin.status, 403)
  assert.match(errorMessage(removeAdmin), /没有权限移除管理员或负责人/)

  const removeOwner = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/members/${ownerId}`, { as: adminId })
  assert.equal(removeOwner.status, 403)
  assert.match(errorMessage(removeOwner), /没有权限移除管理员或负责人/)
})

test('负责人不能直接移除自己，必须先转交', async () => {
  const workspaceId = 'ws-1a-remove-owner'
  const ownerId = 'user-1a-rem-own-owner'
  await createDirectoryUser(ownerId, '自移除负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const result = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/members/${ownerId}`, { as: ownerId })
  assert.equal(result.status, 409)
  assert.match(errorMessage(result), /负责人不能直接移除，请先转交负责人/)
  assert.deepEqual(await memberRoles(workspaceId), [{ userId: ownerId, role: 'owner' }])
})

test('移除非成员目标返回明确错误', async () => {
  const workspaceId = 'ws-1a-remove-missing'
  const ownerId = 'user-1a-rem-mis-owner'
  const outsiderId = 'user-1a-rem-mis-outsider'
  await createDirectoryUser(ownerId, '移除非成员负责人')
  await createDirectoryUser(outsiderId, '移除非成员目标')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const result = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/members/${outsiderId}`, { as: ownerId })
  assert.equal(result.status, 404)
  assert.match(errorMessage(result), /目标成员不存在于该空间/)
})

// ---------------------------------------------------------------------------
// 主动退出
// ---------------------------------------------------------------------------

test('普通成员与管理员可以主动退出，写入 member_exit 事件并提升修订号', async () => {
  const workspaceId = 'ws-1a-exit'
  const ownerId = 'user-1a-exit-owner'
  const memberId = 'user-1a-exit-member'
  const adminId = 'user-1a-exit-admin'
  await createDirectoryUser(ownerId, '退出空间负责人')
  await createDirectoryUser(memberId, '退出空间成员')
  await createDirectoryUser(adminId, '退出空间管理员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: adminId, role: 'admin' },
  ])

  const exitMember = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/exit`, { as: memberId })
  assert.equal(exitMember.status, 200)
  assert.deepEqual(exitMember.body.data, { workspaceId, exited: true })
  assert.equal(await revision(workspaceId), 1)

  const exitAdmin = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/exit`, { as: adminId })
  assert.equal(exitAdmin.status, 200)
  assert.equal(await revision(workspaceId), 2)

  assert.deepEqual(await memberRoles(workspaceId), [{ userId: ownerId, role: 'owner' }])
  const events = await revocationEvents(workspaceId)
  assert.equal(events.length, 2)
  assert.deepEqual(events.find(event => event.kind === 'member_exit' && event.userId === memberId)?.payload, { by: memberId })
  assert.deepEqual(events.find(event => event.kind === 'member_exit' && event.userId === adminId)?.payload, { by: adminId })
})

test('负责人必须先转交才能退出空间', async () => {
  const workspaceId = 'ws-1a-exit-owner'
  const ownerId = 'user-1a-exit-own-owner'
  await createDirectoryUser(ownerId, '自退出负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const result = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/exit`, { as: ownerId })
  assert.equal(result.status, 409)
  assert.match(errorMessage(result), /负责人不能直接退出空间，请先转交负责人/)
  assert.deepEqual(await memberRoles(workspaceId), [{ userId: ownerId, role: 'owner' }])
})

// ---------------------------------------------------------------------------
// 负责人转交
// ---------------------------------------------------------------------------

test('负责人转交成功后新旧负责人角色互换，写入两个 role_changed 事件并提升修订号', async () => {
  const workspaceId = 'ws-1a-transfer'
  const ownerId = 'user-1a-transfer-owner'
  const memberId = 'user-1a-transfer-member'
  await createDirectoryUser(ownerId, '转交原负责人')
  await createDirectoryUser(memberId, '转交新负责人')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])

  const result = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/owner-transfer`, {
    as: ownerId,
    body: { toUserId: memberId },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.data, { workspaceId, previousOwnerId: ownerId, newOwnerId: memberId })
  assert.deepEqual(await memberRoles(workspaceId), [
    { userId: ownerId, role: 'member' },
    { userId: memberId, role: 'owner' },
  ])
  assert.equal(await revision(workspaceId), 1)

  const events = await revocationEvents(workspaceId)
  assert.equal(events.length, 2)
  const ownerEvent = events.find(event => event.userId === ownerId)
  assert.equal(ownerEvent?.kind, 'role_changed')
  assert.equal(ownerEvent?.status, 'pending')
  assert.deepEqual(ownerEvent?.payload, { from: 'owner', to: 'member', by: ownerId })
  const targetEvent = events.find(event => event.userId === memberId)
  assert.equal(targetEvent?.kind, 'role_changed')
  assert.equal(targetEvent?.status, 'pending')
  assert.deepEqual(targetEvent?.payload, { from: 'member', to: 'owner', by: ownerId })
})

test('转交目标必须是现有成员，且不能是当前负责人', async () => {
  const workspaceId = 'ws-1a-transfer-invalid'
  const ownerId = 'user-1a-transfer-inv-owner'
  const outsiderId = 'user-1a-transfer-inv-outsider'
  await createDirectoryUser(ownerId, '转交校验负责人')
  await createDirectoryUser(outsiderId, '转交校验非成员')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const toOutsider = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/owner-transfer`, {
    as: ownerId,
    body: { toUserId: outsiderId },
  })
  assert.equal(toOutsider.status, 422)
  assert.match(errorMessage(toOutsider), /转交目标必须是该空间的现有成员/)

  const toSelf = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/owner-transfer`, {
    as: ownerId,
    body: { toUserId: ownerId },
  })
  assert.equal(toSelf.status, 409)
  assert.match(errorMessage(toSelf), /转交目标不能是当前负责人/)
})

test('只有负责人可以发起转交', async () => {
  const workspaceId = 'ws-1a-transfer-denied'
  const ownerId = 'user-1a-transfer-den-owner'
  const adminId = 'user-1a-transfer-den-admin'
  const memberId = 'user-1a-transfer-den-member'
  await createDirectoryUser(ownerId, '转交权限负责人')
  await createDirectoryUser(adminId, '转交权限管理员')
  await createDirectoryUser(memberId, '转交权限成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
  ])

  const asAdmin = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/owner-transfer`, {
    as: adminId,
    body: { toUserId: memberId },
  })
  assert.equal(asAdmin.status, 403)
  assert.match(errorMessage(asAdmin), /无权执行/)

  const asMember = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/owner-transfer`, {
    as: memberId,
    body: { toUserId: adminId },
  })
  assert.equal(asMember.status, 403)
})

test('并发转交只有一次成功，最终恰好保留一名负责人（AC-02）', async () => {
  const workspaceId = 'ws-1a-transfer-concurrent'
  const ownerId = 'user-1a-transfer-conc-owner'
  const firstTargetId = 'user-1a-transfer-conc-a'
  const secondTargetId = 'user-1a-transfer-conc-b'
  await createDirectoryUser(ownerId, '并发转交负责人')
  await createDirectoryUser(firstTargetId, '并发转交目标甲')
  await createDirectoryUser(secondTargetId, '并发转交目标乙')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: firstTargetId, role: 'member' },
    { userId: secondTargetId, role: 'member' },
  ])

  const [toFirst, toSecond] = await Promise.all([
    api('POST', `/api/workbench/v1/workspaces/${workspaceId}/owner-transfer`, {
      as: ownerId,
      body: { toUserId: firstTargetId },
    }),
    api('POST', `/api/workbench/v1/workspaces/${workspaceId}/owner-transfer`, {
      as: ownerId,
      body: { toUserId: secondTargetId },
    }),
  ])

  const successes = [toFirst, toSecond].filter(result => result.status === 200)
  assert.equal(successes.length, 1, `期望恰好一次成功，实际状态：${toFirst.status}/${toSecond.status}`)
  const [success] = successes
  assert.ok(success)
  for (const failed of [toFirst, toSecond].filter(result => result.status !== 200)) {
    assert.ok([403, 409].includes(failed.status), `失败转交状态异常：${failed.status}`)
    assert.match(errorMessage(failed), /无权执行|转交|负责人/)
  }

  const newOwnerId = (success.body.data as { newOwnerId: string }).newOwnerId
  const roles = await memberRoles(workspaceId)
  assert.deepEqual(roles, [
    { userId: ownerId, role: 'member' },
    ...(newOwnerId === firstTargetId
      ? [{ userId: firstTargetId, role: 'owner' as const }, { userId: secondTargetId, role: 'member' as const }]
      : [{ userId: firstTargetId, role: 'member' as const }, { userId: secondTargetId, role: 'owner' as const }]),
  ])
})

// ---------------------------------------------------------------------------
// 并发竞争与操作人降级回归
// ---------------------------------------------------------------------------

test('退出与并发负责人转交竞争：失败方得到友好 409，而不是 500 或原始触发器错误', async () => {
  const workspaceId = 'ws-1a-race-exit'
  const ownerId = 'user-1a-race-exit-owner'
  const targetId = 'user-1a-race-exit-target'
  await createDirectoryUser(ownerId, '竞争退出负责人')
  await createDirectoryUser(targetId, '竞争退出成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: targetId, role: 'member' },
  ])

  // 确定性模拟竞争：退出预检读到旧角色后，代理立刻通过真实连接提交一次
  // 负责人转交，随后退出事务的删除就会命中新负责人，延迟单负责人触发器
  // 在提交时中止事务（真实并发下无法保证时序，且存在死锁窗口）。
  const racyDatabase = commitTransferAfterRoleRead(database, {
    workspaceId,
    actorUserId: targetId,
    previousOwnerId: ownerId,
    newOwnerId: targetId,
  })
  const racyMembers = new PostgresWorkspaceMemberService(racyDatabase, authorization)
  const racyRouter = new Router({ authenticateApi: testApiAuthenticator })
  registerWorkspaceMemberRoutes(racyRouter, racyMembers, authorization)
  const racyServer = createServer((request, response) => void racyRouter.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    racyServer.once('error', reject)
    racyServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = racyServer.address()
  assert.ok(address && typeof address !== 'string')
  const racyBaseUrl = `http://127.0.0.1:${address.port}`
  try {
    const result = await request(racyBaseUrl, 'POST', `/api/workbench/v1/workspaces/${workspaceId}/exit`, {
      as: targetId,
    })
    assert.equal(result.status, 409)
    assert.match(errorMessage(result), /负责人/)
    assert.match(errorMessage(result), /刷新后重试/)
    assert.doesNotMatch(errorMessage(result), /exactly one owner/)

    // 竞争转交保留了下来，最终恰好一名负责人。
    assert.deepEqual(await memberRoles(workspaceId), [
      { userId: ownerId, role: 'member' },
      { userId: targetId, role: 'owner' },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => racyServer.close(error => error ? reject(error) : resolve()))
  }
})

test('操作人在请求处理中被降级后，服务层重新校验并拒绝成员增删改（TOCTOU）', async () => {
  const workspaceId = 'ws-1a-toctou'
  const ownerId = 'user-1a-toctou-owner'
  const demotedAdminId = 'user-1a-toctou-admin'
  const memberId = 'user-1a-toctou-member'
  const candidateId = 'user-1a-toctou-candidate'
  await createDirectoryUser(ownerId, 'TOCTOU 负责人')
  await createDirectoryUser(demotedAdminId, 'TOCTOU 管理员')
  await createDirectoryUser(memberId, 'TOCTOU 成员')
  await createDirectoryUser(candidateId, 'TOCTOU 候选员工')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: demotedAdminId, role: 'admin' },
    { userId: memberId, role: 'member' },
  ])

  // 模拟路由守卫通过后被降级：守卫读到的还是 admin，服务层读到时已是 member。
  await database`
    update workspace_members
       set member_role = 'member'
     where tenant_id = ${tenantId}
       and workspace_id = ${workspaceId}
       and user_id = ${demotedAdminId}
  `

  await assert.rejects(
    () => members.addMember(workspaceId, candidateId, 'member', demotedAdminId),
    /当前用户角色没有权限执行此操作/,
  )
  await assert.rejects(
    () => members.changeMemberRole(workspaceId, memberId, 'viewer', demotedAdminId),
    /当前用户角色没有权限执行此操作/,
  )
  await assert.rejects(
    () => members.removeMember(workspaceId, memberId, demotedAdminId),
    /当前用户角色没有权限执行此操作/,
  )

  // 降级后的操作人走 HTTP 也被路由守卫拒绝（403）。
  const viaHttp = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${memberId}`, {
    as: demotedAdminId,
    body: { role: 'viewer' },
  })
  assert.equal(viaHttp.status, 403)

  // 三次拒绝都没有留下任何变更：候选人未加入，原有角色不变。
  assert.deepEqual(await memberRoles(workspaceId), [
    { userId: ownerId, role: 'owner' },
    { userId: demotedAdminId, role: 'member' },
    { userId: memberId, role: 'member' },
  ])
})

// ---------------------------------------------------------------------------
// 个人工作空间拒绝
// ---------------------------------------------------------------------------

test('所有成员管理端点都拒绝个人工作空间', async () => {
  const personalWorkspaceId = 'ws-personal-U00001'
  const requests = [
    () => api('GET', `/api/workbench/v1/workspaces/${personalWorkspaceId}/member-candidates`, { as: 'U00001' }),
    () => api('POST', `/api/workbench/v1/workspaces/${personalWorkspaceId}/members`, { as: 'U00001', body: { userId: 'U00008', role: 'member' } }),
    () => api('PATCH', `/api/workbench/v1/workspaces/${personalWorkspaceId}/members/U00008`, { as: 'U00001', body: { role: 'member' } }),
    () => api('DELETE', `/api/workbench/v1/workspaces/${personalWorkspaceId}/members/U00008`, { as: 'U00001' }),
    () => api('POST', `/api/workbench/v1/workspaces/${personalWorkspaceId}/exit`, { as: 'U00001' }),
    () => api('POST', `/api/workbench/v1/workspaces/${personalWorkspaceId}/owner-transfer`, { as: 'U00001', body: { toUserId: 'U00008' } }),
  ]
  for (const run of requests) {
    const result = await run()
    assert.equal(result.status, 422)
    assert.equal(result.body.error?.code, 'invalid_request')
    assert.match(errorMessage(result), /仅支持团队工作空间/)
  }
})

test('归档空间：访问撤销与负责人转交仍可执行，成员新增/角色调整/退出仍拒绝（3-T1 治理例外）', async () => {
  const workspaceId = 'ws-3t1-governance'
  const ownerId = 'user-3t1-gov-owner'
  const adminId = 'user-3t1-gov-admin'
  const memberId = 'user-3t1-gov-member'
  const successorId = 'user-3t1-gov-successor'
  const removedId = 'user-3t1-gov-removed'
  await createDirectoryUser(ownerId, '归档治理负责人')
  await createDirectoryUser(adminId, '归档治理管理员')
  await createDirectoryUser(memberId, '归档治理成员')
  await createDirectoryUser(successorId, '归档治理继任者')
  await createDirectoryUser(removedId, '归档治理被移除者')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
    { userId: removedId, role: 'member' },
    { userId: successorId, role: 'member' },
  ])
  await archive(workspaceId)

  const beforeRevocationRevision = await revision(workspaceId)

  // 治理例外：负责人/管理员仍可撤销访问（移出成员），并写入收权事件。
  const removal = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/members/${removedId}`, { as: ownerId })
  assert.equal(removal.status, 200, '归档空间必须仍能撤销成员访问')
  assert.equal((await memberRoles(workspaceId)).some(member => member.userId === removedId), false)
  assert.deepEqual(
    (await revocationEvents(workspaceId)).map(event => [event.userId, event.kind]),
    [[removedId, 'member_removed']],
  )
  assert.equal(await revision(workspaceId), beforeRevocationRevision + 1, '收权必须提升团队授权修订号')

  // 执行轨仍拒绝：新增成员、角色调整、主动退出在归档空间一律拒绝。
  // 归档态由 authorizeWorkbench 的成员/状态门禁先行拒绝（403），
  // 不进入服务层的「仅支持团队空间」校验（422）。
  const addAttempt = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/members`, {
    as: ownerId,
    body: { userId: memberId, role: 'viewer' },
  })
  assert.equal(addAttempt.status, 403, '归档空间不得新增成员')

  const roleAttempt = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/members/${memberId}`, {
    as: ownerId,
    body: { role: 'admin' },
  })
  assert.equal(roleAttempt.status, 403, '归档空间不得调整成员角色')

  const exitAttempt = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/exit`, { as: memberId })
  assert.equal(exitAttempt.status, 403, '归档空间不得主动退出')

  const candidateAttempt = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/member-candidates`, { as: ownerId })
  assert.equal(candidateAttempt.status, 403, '归档空间不得查询成员候选人')

  // 治理例外：负责人转交仍可执行，且恰好保留一名负责人。
  const transfer = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/owner-transfer`, {
    as: ownerId,
    body: { toUserId: successorId },
  })
  assert.equal(transfer.status, 200, '归档空间必须仍能转交负责人')
  const rolesAfterTransfer = await memberRoles(workspaceId)
  assert.deepEqual(
    rolesAfterTransfer.filter(member => member.role === 'owner').map(member => member.userId),
    [successorId],
  )
  assert.equal(rolesAfterTransfer.find(member => member.userId === ownerId)?.role, 'member')

  // 个人空间行为完全不变（AC-23）。
  const personal = await api('DELETE', '/api/workbench/v1/workspaces/ws-personal-U00001/members/U00008', { as: 'U00001' })
  assert.equal(personal.status, 422)
  assert.match(errorMessage(personal), /仅支持团队工作空间/)
})

test('归档空间的成员与 Agent 名册属读取轨，候选与写操作仍拒绝', async () => {
  const workspaceId = 'ws-archived-roster'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await createDirectoryUser(ownerId, '归档名册负责人')
  await createDirectoryUser(memberId, '归档名册成员')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  await database`
    update workspaces set status = 'archived' where tenant_id = ${tenantId} and id = ${workspaceId}
  `

  // 读取轨：归档后现任成员仍可读名册（详情页右栏依赖）。
  for (const userId of [ownerId, memberId]) {
    const members = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/members`, {
      headers: { 'x-test-user-id': userId },
    })
    assert.equal(members.status, 200, `${userId} 应可读取归档空间成员名册`)
  }

  // 执行轨：候选人列表与写操作在归档空间仍拒绝。
  const candidates = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/member-candidates`, {
    headers: { 'x-test-user-id': ownerId },
  })
  assert.equal(candidates.status, 403, '归档空间不应暴露成员候选')

  // 包装器 `requireTeamActor` 的默认必须是执行轨（质量评审指出该默认此前只有代码阅读、
  // 没有判别性测试）：候选人接口不传 allowArchived，归档空间必须被拒（此套件只注册成员路由，
  // Agent 候选端点由 workspace-agent-member-api 套件覆盖）。
  const candidateDenied = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/member-candidates`, {
    headers: { 'x-test-user-id': ownerId },
  })
  assert.equal(candidateDenied.status, 403, 'requireTeamActor 默认（执行轨）必须拒绝归档空间的候选人接口')

  const addMember = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/members`, {
    method: 'POST',
    headers: { 'x-test-user-id': ownerId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: `${workspaceId}-new`, role: 'member' }),
  })
  assert.equal(addMember.status, 403, '归档空间不允许新增成员')

  // 非成员在归档空间同样不得读名册（不可枚举）；且状态码必须与活跃空间一致，
  // 否则可以用状态码区分「已归档」与「不存在/无权」。
  const outsiderId = `${workspaceId}-outsider`
  await createDirectoryUser(outsiderId, '归档名册外部人')
  const outsider = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/members`, {
    headers: { 'x-test-user-id': outsiderId },
  })
  assert.equal(outsider.status, 403, '非成员不得读取归档空间名册')

  const activeWorkspaceId = `${workspaceId}-active`
  await createTeamWorkspace(activeWorkspaceId, [{ userId: ownerId, role: 'owner' }])
  const outsiderOnActive = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${activeWorkspaceId}/members`, {
    headers: { 'x-test-user-id': outsiderId },
  })
  const outsiderOnMissing = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}-missing/members`, {
    headers: { 'x-test-user-id': outsiderId },
  })
  assert.equal(outsiderOnActive.status, outsider.status, '归档与活跃空间对非成员必须同状态码，不得泄露存在性')
  assert.equal(outsiderOnMissing.status, outsider.status, '不存在空间与归档空间对非成员必须同状态码')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      id: userId,
      name: userId,
      title: '员工',
      department: '测试部门',
      avatarText: '测',
      role: 'employee',
      dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}

async function createDirectoryUser(
  id: string,
  displayName: string,
  options: {
    status?: 'active' | 'disabled'
    business?: boolean
    provider?: 'ai-hub' | 'local'
    department?: string | null
    grantWorkbench?: boolean
  } = {},
) {
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status,
      identity_provider, business_user
    ) values (
      ${id}, ${tenantId}, ${`directory:${id}`}, ${displayName},
      ${options.department ?? null}, ${options.status ?? 'active'},
      ${options.provider ?? 'ai-hub'}, ${options.business ?? true}
    )
  `
  if (options.grantWorkbench ?? true) {
    await database`
      insert into user_roles (tenant_id, user_id, role_id, source_key)
      values (${tenantId}, ${id}, 'role-employee', 'local')
      on conflict do nothing
    `
  }
}

/** 3-T2 的归档 API 尚未实现；测试按既有约定直接用 SQL 落归档态。 */
async function archive(workspaceId: string) {
  await database`
    update workspaces set status = 'archived', archived_at = now()
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
}

async function createTeamWorkspace(workspaceId: string, members: MemberRow[]) {
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '1A 成员管理测试团队空间', '', 'team', 'U00001', 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${members[0]?.userId ?? 'U00001'})
    `
  }
}

async function api(method: string, path: string, options: { as?: string; body?: unknown } = {}) {
  return request(baseUrl, method, path, options)
}

async function request(base: string, method: string, path: string, options: { as?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.as) headers['x-test-user-id'] = options.as
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${base}${path}`, init)
  const body = await response.json().catch(() => null) as {
    data?: unknown
    error?: { code: string; message: string }
  }
  return { status: response.status, body }
}

/**
 * 确定性模拟“预检读到旧角色”的竞争：包装数据库客户端，在成员角色读取
 * （memberRoleOf 的查询）完成后立刻通过真实客户端提交一次负责人转交，
 * 再返回读到的旧角色。随后服务端的删除/降级就会命中新负责人，由延迟
 * 单负责人触发器在提交时中止事务。
 */
function commitTransferAfterRoleRead(
  real: DatabaseClient,
  options: {
    workspaceId: string
    actorUserId: string
    previousOwnerId: string
    newOwnerId: string
  },
): DatabaseClient {
  let injected = false
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => Reflect.apply(value, target, args)
    },
    async apply(target, _thisArg, args) {
      const [first] = args as [unknown, ...unknown[]]
      const sqlText = Array.isArray(first) && Array.isArray((first as { raw?: unknown }).raw)
        ? (first as string[]).join('?')
        : ''
      const isActorRoleRead = sqlText.includes('select member_role as role from workspace_members')
        && args.includes(options.actorUserId)
      const result = await Reflect.apply(target, target, args)
      if (!injected && isActorRoleRead) {
        injected = true
        await real`
          update workspace_members
             set member_role = case
               when user_id = ${options.previousOwnerId} then 'member'
               when user_id = ${options.newOwnerId} then 'owner'
             end
           where tenant_id = ${tenantId}
             and workspace_id = ${options.workspaceId}
             and user_id in (${options.previousOwnerId}, ${options.newOwnerId})
        `
      }
      return result
    },
  })
}

function errorMessage(result: { body: { error?: { message: string } } }): string {
  return result.body.error?.message ?? ''
}

async function memberRoles(workspaceId: string): Promise<MemberRow[]> {
  const rows = await database<{ userId: string; role: MemberRow['role'] }[]>`
    select user_id as "userId", member_role as role
      from workspace_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by joined_at asc, user_id asc
  `
  return rows.map(row => ({ userId: row.userId, role: row.role }))
}

async function revision(workspaceId: string): Promise<number> {
  const [row] = await database<{ revision: number }[]>`
    select team_auth_revision as revision from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
  return row?.revision ?? 0
}

async function revocationEvents(workspaceId: string): Promise<RevocationEventRow[]> {
  const rows = await database<{
    userId: string
    kind: string
    payload: Record<string, string>
    payloadHash: string
    status: string
  }[]>`
    select user_id as "userId", kind, payload,
           payload_hash as "payloadHash", status
      from workspace_revocation_events
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by created_at asc, id asc
  `
  return rows
}
