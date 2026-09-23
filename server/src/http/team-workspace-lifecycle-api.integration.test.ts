import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { testAttemptManifest } from '../infrastructure/postgres/test-attempt-manifest.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../modules/model/postgres-model-governance-repository.ts'
import { PostgresRunRepository } from '../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../modules/run/run-orchestration-service.ts'
import type { AgentRuntimePort, RuntimeExecutionHandle, RuntimeExecutionSnapshot, RuntimeManifest } from '../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresWorkspaceLifecycleService } from '../modules/workbench/application/postgres-workspace-lifecycle-service.ts'
import { PostgresWorkspaceMemberService } from '../modules/workbench/application/postgres-workspace-member-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { Router } from './router.ts'
import { registerContentRoutes } from './workbench/content-routes.ts'
import { registerWorkspaceLifecycleRoutes } from './workbench/workspace-lifecycle-routes.ts'
import { registerWorkspaceMemberRoutes } from './workbench/workspace-member-routes.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const runtimeId = 'runtime-local-01'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let storageRoot: string
let authorization: PostgresAuthorizationService
let content: PostgresContentService
let lifecycle: PostgresWorkspaceLifecycleService
let members: PostgresWorkspaceMemberService
let agentMembers: PostgresWorkspaceAgentMemberService
let conversations: PostgresConversationRepository
let runs: PostgresRunRepository
let orchestration: RunOrchestrationService
let runtime: FakeRuntime
let server: Server
let baseUrl = ''

interface MemberRow {
  userId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_lifecycle_api_test', maxConnections: 12 })
  database = throwaway.client
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-lifecycle-'))
  // 并发用例会留下 running 的 attempt（FakeRuntime 不自动完成），默认容量 2 会跨用例
  // 耗尽，使「领取」因容量而非归档判断失败，用例失去鉴别力。给测试 runtime 充足容量。
  await database`
    update runtimes set capacity = 32
     where tenant_id = ${tenantId} and id = ${runtimeId}
  `

  authorization = new PostgresAuthorizationService(database)
  content = new PostgresContentService(database, storageRoot, authorization)
  lifecycle = new PostgresWorkspaceLifecycleService(database)
  members = new PostgresWorkspaceMemberService(database, authorization)
  // TW-10：团队会话 startRun 必须经 Agent 成员关联解析固定版本。
  agentMembers = new PostgresWorkspaceAgentMemberService(
    database,
    authorization,
    undefined as unknown as PostgresAgentService,
  )
  conversations = new PostgresConversationRepository(database)
  runs = new PostgresRunRepository(database)
  runtime = new FakeRuntime()
  orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    authorization,
    { agentMembers },
  )

  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerContentRoutes(router, content, authorization)
  registerWorkspaceLifecycleRoutes(router, lifecycle, authorization)
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
  if (orchestration) await orchestration.close()
  await throwaway.dispose()
  await rm(storageRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 归档：负责人、状态与审计
// ---------------------------------------------------------------------------

test('负责人归档：写入 archived_at 与审计事实，恢复清空归档时间', async () => {
  const ws = uniqueWorkspace('archive')
  const ownerId = `${ws}-owner`
  await seedUser(ownerId, '归档负责人')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }])

  const archived = await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: ownerId })
  assert.equal(archived.status, 200)
  const archivedData = archived.body.data as { id: string; status: string; archivedAt: string | null }
  assert.equal(archivedData.status, 'archived')
  assert.ok(archivedData.archivedAt, '归档必须写入 archived_at')

  const row = await workspaceRow(ws)
  assert.equal(row.status, 'archived')
  assert.ok(row.archivedAt)
  const audits = await auditRows(ws)
  const archiveAudit = audits.find(item => item.action === 'workspace.archive')
  assert.ok(archiveAudit, '归档必须写审计事实')
  assert.equal(archiveAudit.actorId, ownerId)
  assert.equal(archiveAudit.objectType, 'workspace')
  assert.equal(archiveAudit.result, 'success')
  assert.equal(archiveAudit.safeContext.detail, '负责人归档团队空间（只读保留）')

  const restored = await api('POST', `/api/workbench/v1/workspaces/${ws}/restore`, { as: ownerId })
  assert.equal(restored.status, 200)
  const restoredData = restored.body.data as { status: string; archivedAt: string | null }
  assert.equal(restoredData.status, 'active')
  assert.equal(restoredData.archivedAt, null)
  const restoredRow = await workspaceRow(ws)
  assert.equal(restoredRow.status, 'active')
  assert.equal(restoredRow.archivedAt, null)
  const restoreAudit = (await auditRows(ws)).find(item => item.action === 'workspace.restore')
  assert.ok(restoreAudit, '恢复必须写审计事实')
  assert.equal(restoreAudit.actorId, ownerId)
  assert.equal(restoreAudit.safeContext.detail, '负责人恢复团队空间')
})

test('有排队/运行中/等待审批/取消中的任务时拒绝归档，任务终态后允许归档', async () => {
  const ws = uniqueWorkspace('busy')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '忙碌负责人')
  await seedUser(userId, '忙碌成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSessionRow(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ runId, sessionId, userId, status: 'queued', agentVersionId: versionId })

  for (const status of ['queued', 'running', 'waiting', 'cancel_requested'] as const) {
    await setRunStatus(runId, status)
    const blocked = await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: ownerId })
    assert.equal(blocked.status, 409, `${status} 必须阻止归档`)
    assert.match(errorMessage(blocked), /排队|运行中/)
    assert.match(errorMessage(blocked), /等待|取消/, '错误必须提示等待或取消')
    assert.equal((await workspaceRow(ws)).status, 'active')
  }

  await setRunStatus(runId, 'succeeded')
  const allowed = await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: ownerId })
  assert.equal(allowed.status, 200, '任务终态后必须允许归档')
  assert.equal((await workspaceRow(ws)).status, 'archived')
})

test('非负责人（管理员/成员/只读/非成员）不能归档或恢复', async () => {
  const ws = uniqueWorkspace('roles')
  const ownerId = `${ws}-owner`
  const adminId = `${ws}-admin`
  const memberId = `${ws}-member`
  const viewerId = `${ws}-viewer`
  const outsiderId = `${ws}-outsider`
  await seedUser(ownerId, '角色负责人')
  await seedUser(adminId, '角色管理员')
  await seedUser(memberId, '角色成员')
  await seedUser(viewerId, '角色只读')
  await seedUser(outsiderId, '角色外部')
  await createTeamWorkspace(ws, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])

  for (const actor of [adminId, memberId, viewerId, outsiderId]) {
    const denied = await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: actor })
    assert.equal(denied.status, 403, `${actor} 不得归档`)
  }
  assert.equal((await workspaceRow(ws)).status, 'active', '拒绝归档不得改状态')

  const archived = await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: ownerId })
  assert.equal(archived.status, 200)
  for (const actor of [adminId, memberId, viewerId, outsiderId]) {
    const denied = await api('POST', `/api/workbench/v1/workspaces/${ws}/restore`, { as: actor })
    assert.equal(denied.status, 403, `${actor} 不得恢复`)
  }
  assert.equal((await workspaceRow(ws)).status, 'archived', '拒绝恢复不得改状态')
})

test('个人空间不可归档，一律按团队专用接口拒绝（AC-23）', async () => {
  const userId = `user-${randomUUID().slice(0, 8)}`
  await seedUser(userId, '个人空间用户')
  const personalId = `ws-personal-${userId}`

  const denied = await api('POST', `/api/workbench/v1/workspaces/${personalId}/archive`, { as: userId })
  assert.equal(denied.status, 422)
  assert.match(errorMessage(denied), /团队/)
  assert.equal((await workspaceRow(personalId)).status, 'active', '个人空间状态必须保持不变')

  const restore = await api('POST', `/api/workbench/v1/workspaces/${personalId}/restore`, { as: userId })
  assert.equal(restore.status, 422)
})

// ---------------------------------------------------------------------------
// 恢复语义：不恢复已移除成员、不扩大授权
// ---------------------------------------------------------------------------

test('恢复不重新添加已移除成员，也不扩大授权', async () => {
  const ws = uniqueWorkspace('restore')
  const ownerId = `${ws}-owner`
  const memberId = `${ws}-member`
  await seedUser(ownerId, '恢复负责人')
  await seedUser(memberId, '恢复成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])

  await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: ownerId })

  // 治理例外：归档空间仍必须能紧急收权（移除成员）。
  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${ws}/members/${memberId}`, { as: ownerId })
  assert.equal(removed.status, 200, '归档空间必须仍允许撤销访问')

  await api('POST', `/api/workbench/v1/workspaces/${ws}/restore`, { as: ownerId })

  const roster = await api('GET', `/api/workbench/v1/workspaces/${ws}/members`, { as: ownerId })
  assert.equal(roster.status, 200)
  const items = (roster.body.data as { items: Array<{ userId: string }> }).items
  assert.deepEqual(items.map(item => item.userId), [ownerId], '恢复不得重新添加已移除成员')

  // 已移除成员恢复后仍无权读取，授权未被扩大。
  const denied = await api('GET', `/api/workbench/v1/workspaces/${ws}/members`, { as: memberId })
  assert.equal(denied.status, 403)
})

test('归档空间对现任成员只读可访问，且仍允许收权与负责人转交（治理例外）', async () => {
  const ws = uniqueWorkspace('governance')
  const ownerId = `${ws}-owner`
  const memberId = `${ws}-member`
  await seedUser(ownerId, '治理负责人')
  await seedUser(memberId, '治理成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])

  await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: ownerId })

  // 读取轨：名册与共享文件列表对现任成员放行。
  const roster = await api('GET', `/api/workbench/v1/workspaces/${ws}/members`, { as: memberId })
  assert.equal(roster.status, 200, '归档空间的现任成员仍可读取成员名册')
  const files = await api('GET', `/api/workbench/v1/workspaces/${ws}/files`, { as: memberId })
  assert.equal(files.status, 200, '归档空间的现任成员仍可读取共享文件列表')

  // 治理例外：负责人转交。
  const transferred = await api('POST', `/api/workbench/v1/workspaces/${ws}/owner-transfer`, {
    as: ownerId,
    body: { toUserId: memberId },
  })
  assert.equal(transferred.status, 200, '归档空间必须仍允许负责人转交')

  // 收权（移除原负责人以外的新负责人不可被移除；用管理员场景收权已验证）。这里验证
  // 归档 + 转交后新负责人仍是 owner 且旧的授权未被扩大。
  const roles = new Map((await memberRoles(ws)).map(item => [item.userId, item.role]))
  assert.equal(roles.get(ownerId), 'member')
  assert.equal(roles.get(memberId), 'owner')
})

test('归档空间仍允许移除成员（紧急收权）', async () => {
  const ws = uniqueWorkspace('revoke')
  const ownerId = `${ws}-owner`
  const memberId = `${ws}-member`
  await seedUser(ownerId, '收权负责人')
  await seedUser(memberId, '收权成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  await api('POST', `/api/workbench/v1/workspaces/${ws}/archive`, { as: ownerId })

  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${ws}/members/${memberId}`, { as: ownerId })
  assert.equal(removed.status, 200)
  assert.deepEqual(await memberRoles(ws), [{ userId: ownerId, role: 'owner' }])
})

// ---------------------------------------------------------------------------
// GET /workspaces：status / archivedAt / 当前负责人 / 筛选
// ---------------------------------------------------------------------------

test('并发互斥：归档先提交时，正在等待锁的空间设置改写不得穿透（锁内状态复核）', async () => {
  // 与成员变更同理（验证代理 D4）：设置写入声称靠空间行锁防 TOCTOU，必须有判别性用例。
  const ws = uniqueWorkspace('race-archive-settings')
  const ownerId = `${ws}-owner`
  await seedUser(ownerId, '设置锁负责人')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }])

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

  const archivePromise = lifecycle.archiveWorkspace(ws, ownerId)
  await waitForWorkspaceLockWaiters(1, '归档进入空间行锁等待队列')
  const patchPromise = content.updateWorkspace(ws, { description: '归档后不应写入' }, ownerId)
  await waitForWorkspaceLockWaiters(2, '空间设置改写排在归档之后等待同一行锁')
  releaseLock()
  await holder

  const archived = await archivePromise
  assert.equal(archived.status, 'archived')
  const patchError = await patchPromise.then(() => null, (error: unknown) => (
    error instanceof Error ? error.message : String(error)
  ))
  assert.ok(patchError !== null, '归档提交后等待锁的设置改写必须被拒绝')
  assert.match(patchError!, /已归档|不可访问/)

  const [row] = await database<{ description: string }[]>`
    select description from workspaces where tenant_id = ${tenantId} and id = ${ws}
  `
  assert.notEqual(row?.description, '归档后不应写入', '归档空间不得被改写说明')
})

test('空间设置：仅负责人可改名称/说明，说明可显式清空，归档空间拒绝', async () => {
  const ws = uniqueWorkspace('settings-patch')
  const ownerId = `${ws}-owner`
  const memberId = `${ws}-member`
  await seedUser(ownerId, '设置负责人')
  await seedUser(memberId, '设置成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])

  const renamed = await api('PATCH', `/api/workbench/v1/workspaces/${ws}`, {
    as: ownerId,
    body: { name: '新名称', description: '新说明' },
  })
  assert.equal(renamed.status, 200, `PATCH 失败：${JSON.stringify(renamed.body)}`)
  assert.equal((renamed.body.data as { name: string; description: string }).name, '新名称')
  assert.equal((renamed.body.data as { description: string }).description, '新说明')

  // 清空说明必须显式传 null（方案 3.3），而不是被当作「未提供」。
  const cleared = await api('PATCH', `/api/workbench/v1/workspaces/${ws}`, {
    as: ownerId,
    body: { description: null },
  })
  assert.equal(cleared.status, 200)
  assert.equal((cleared.body.data as { description: string }).description, '')

  // 非负责人被拒；名称长度校验为 422。
  const asMember = await api('PATCH', `/api/workbench/v1/workspaces/${ws}`, {
    as: memberId,
    body: { name: '成员改名' },
  })
  assert.equal(asMember.status, 403, '仅负责人可修改空间设置')
  const tooShort = await api('PATCH', `/api/workbench/v1/workspaces/${ws}`, {
    as: ownerId,
    body: { name: 'a' },
  })
  assert.equal(tooShort.status, 422, '名称长度不符必须是 422 而不是 500')

  // 空请求体与超长名称同样必须是 422（契约声明 200/403/422）；此前裸 Error
  // 会被文案分类成 500（符合性评审 F2）。
  const empty = await api('PATCH', `/api/workbench/v1/workspaces/${ws}`, { as: ownerId, body: {} })
  assert.equal(empty.status, 422, '空请求体必须是 422')
  const tooLong = await api('PATCH', `/api/workbench/v1/workspaces/${ws}`, {
    as: ownerId,
    body: { name: 'x'.repeat(61) },
  })
  assert.equal(tooLong.status, 422, '名称超过 60 字符必须是 422')

  // 归档后设置不可改（执行轨）。
  await archiveViaSql(ws)
  const afterArchive = await api('PATCH', `/api/workbench/v1/workspaces/${ws}`, {
    as: ownerId,
    body: { name: '归档后改名' },
  })
  assert.equal(afterArchive.status, 403, '归档空间不得修改设置')
})

test('GET /workspaces 返回 status、archivedAt 且 owner 为转交后的当前负责人', async () => {
  const ws = uniqueWorkspace('list-owner')
  const ownerId = `${ws}-owner`
  const nextOwnerId = `${ws}-next`
  await seedUser(ownerId, '原负责人')
  await seedUser(nextOwnerId, '新负责人')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: nextOwnerId, role: 'member' }])

  const before = await workspaceFromList(ownerId, ws)
  assert.equal(before.owner, '原负责人', '转交前展示当前负责人')
  assert.equal(before.status, 'active')
  assert.equal(before.archivedAt, null)

  await api('POST', `/api/workbench/v1/workspaces/${ws}/owner-transfer`, {
    as: ownerId,
    body: { toUserId: nextOwnerId },
  })

  const after = await workspaceFromList(nextOwnerId, ws)
  assert.equal(after.owner, '新负责人', 'owner 必须是 workspace_members 的当前负责人，而非创建者')
})

test('默认返回全部（含归档）且只含有权访问的空间；筛选按状态收敛', async () => {
  const callerId = `user-${randomUUID().slice(0, 8)}`
  const otherId = `user-${randomUUID().slice(0, 8)}`
  await seedUser(callerId, '列表调用者')
  await seedUser(otherId, '列表他人')

  const activeTeam = uniqueWorkspace('list-active')
  const archivedTeam = uniqueWorkspace('list-archived')
  const inaccessible = uniqueWorkspace('list-inaccessible')
  await createTeamWorkspace(activeTeam, [{ userId: callerId, role: 'owner' }])
  await createTeamWorkspace(archivedTeam, [{ userId: callerId, role: 'owner' }])
  await createTeamWorkspace(inaccessible, [{ userId: otherId, role: 'owner' }])
  await archiveViaSql(archivedTeam)
  await archiveViaSql(inaccessible)

  // 默认 all：设计 §2.1/§6 确认「默认全部；个人空间恒显」——归档空间必须在默认视图可发现。
  const defaultList = await api('GET', '/api/workbench/v1/workspaces', { as: callerId })
  assert.equal(defaultList.status, 200)
  const defaultIds = (defaultList.body.data as Array<{ id: string }>).map(item => item.id)
  assert.ok(defaultIds.includes(activeTeam), '默认包含活动团队空间')
  assert.ok(defaultIds.includes(archivedTeam), '默认包含有权访问的归档空间（默认 all）')
  assert.ok(defaultIds.includes(`ws-personal-${callerId}`), '默认包含个人空间')
  assert.ok(!defaultIds.includes(inaccessible), '默认不含无权访问的空间')
  assert.ok(!defaultIds.includes(`ws-personal-${otherId}`), '不得看到他人个人空间')

  const activeList = await api('GET', '/api/workbench/v1/workspaces?status=active', { as: callerId })
  const activeIds = (activeList.body.data as Array<{ id: string }>).map(item => item.id)
  assert.ok(activeIds.includes(activeTeam) && !activeIds.includes(archivedTeam), 'status=active 只含活动空间')

  const archivedList = await api('GET', '/api/workbench/v1/workspaces?status=archived', { as: callerId })
  assert.equal(archivedList.status, 200)
  const archivedItems = archivedList.body.data as Array<{ id: string; status: string; archivedAt: string | null }>
  assert.deepEqual(archivedItems.map(item => item.id), [archivedTeam], '归档筛选只返回有权访问的归档空间')
  assert.equal(archivedItems[0]?.status, 'archived')
  assert.ok(archivedItems[0]?.archivedAt)
  assert.ok(!archivedItems.some(item => item.id === `ws-personal-${callerId}`), '归档筛选不返回个人空间')
  assert.ok(!archivedItems.some(item => item.id === inaccessible), '非成员归档空间不可枚举')

  const allList = await api('GET', '/api/workbench/v1/workspaces?status=all', { as: callerId })
  const allIds = (allList.body.data as Array<{ id: string }>).map(item => item.id)
  assert.ok(allIds.includes(activeTeam))
  assert.ok(allIds.includes(archivedTeam))
  assert.ok(!allIds.includes(inaccessible))

  const invalid = await api('GET', '/api/workbench/v1/workspaces?status=bogus', { as: callerId })
  assert.equal(invalid.status, 422)
})

// ---------------------------------------------------------------------------
// 并发：归档 vs 开跑 / 领取
// ---------------------------------------------------------------------------

test('并发互斥：归档与开跑最多一方成功，归档空间内不得存在活动 Run', async () => {
  const { ws, ownerId, userId, sessionId, agentMemberId } = await seedRunnableWorkspace('race-start')

  const [archiveResult, startResult] = await Promise.allSettled([
    lifecycle.archiveWorkspace(ws, ownerId),
    orchestration.startRun({
      userId,
      sessionId,
      prompt: '并发开跑',
      idempotencyKey: `${ws}-race-start`,
      workspaceAgentMemberId: agentMemberId,
    }),
  ])
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.equal(
    [archiveResult.status, startResult.status].filter(status => status === 'fulfilled').length,
    1,
    `归档与开跑必须恰好一方成功（archive=${archiveResult.status}, start=${startResult.status}）`,
  )

  const row = await workspaceRow(ws)
  const nonTerminal = (await sessionRuns(sessionId)).filter(item => ['queued', 'running', 'waiting', 'cancel_requested'].includes(item.status))
  if (row.status === 'archived') {
    assert.equal(archiveResult.status, 'fulfilled')
    assert.equal(nonTerminal.length, 0, '归档空间内不得存在排队或运行中的 Run')
  } else {
    assert.equal(archiveResult.status, 'rejected', '活动空间归档必须因存在活动 Run 被拒绝')
    assert.equal(startResult.status, 'fulfilled')
    assert.ok(nonTerminal.length > 0, '开跑成功时应有活动 Run')
  }
})

test('并发互斥：归档先提交时，正在等待锁的成员变更不得穿透（锁内状态复核）', async () => {
  // 此前成员变更只在事务外检查空间状态：归档若在其等待行锁期间提交，变更仍会成功
  // （验证代理 D4 强制时序实测 8/8）。现在状态复核在行锁内，必须拒绝。
  const ws = uniqueWorkspace('race-archive-add')
  const ownerId = `${ws}-owner`
  const newMemberId = `${ws}-new`
  await seedUser(ownerId, '锁内复核负责人')
  await seedUser(newMemberId, '锁内复核新成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }])

  // ① 外部事务先持有空间行锁，模拟「成员变更已取锁但尚未提交」的窗口。
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

  // ② 先确认归档进入等待队列，再让新增成员排在它之后等待同一把锁。
  const archivePromise = lifecycle.archiveWorkspace(ws, ownerId)
  await waitForWorkspaceLockWaiters(1, '归档进入空间行锁等待队列')
  const addPromise = members.addMember(ws, newMemberId, 'member', ownerId)
  await waitForWorkspaceLockWaiters(2, '新增成员排在归档之后等待同一行锁')

  // ③ 释放锁：两者按取得锁的顺序串行，归档先提交则新增必须被拒绝。
  releaseLock()
  await holder
  const archiveResult = await archivePromise
  assert.equal(archiveResult.status, 'archived')

  const addError = await addPromise.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  assert.ok(addError !== null, '归档提交后，等待锁的新增成员必须被拒绝而不是穿透')
  assert.match(addError!, /已归档|不可访问/)

  const [member] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_members
     where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${newMemberId}
  `
  assert.equal(member?.count, 0, '归档空间不得新增成员（锁内复核必须生效）')
})

test('并发互斥：转交与移除成员不得因锁序相反而死锁（3-T2 统一锁序）', async () => {
  // 此前 transferWorkspaceOwner（先锁 workspaces 再改成员）与 removeMember（先改成员、
  // 最后才 update workspaces）锁序相反，并发时 PostgreSQL 报 40P01，并被 HTTP 分类成 500。
  // 统一锁序后同一场景必须两个操作都能收敛（允许业务性失败，但不得是死锁）。
  for (let round = 0; round < 8; round += 1) {
    const ws = uniqueWorkspace(`race-lockorder-${round}`)
    const ownerId = `${ws}-owner`
    const targetId = `${ws}-target`
    await seedUser(ownerId, '锁序负责人')
    await seedUser(targetId, '锁序目标')
    await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: targetId, role: 'member' }])

    const results = await Promise.allSettled([
      members.transferWorkspaceOwner(ws, targetId, ownerId),
      members.removeMember(ws, targetId, ownerId),
    ])
    for (const result of results) {
      if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        assert.doesNotMatch(message, /deadlock/i, `第 ${round} 轮出现死锁：${message}`)
      }
    }
    assert.equal(results.some(result => result.status === 'fulfilled'), true, `第 ${round} 轮必须至少一方成功`)
  }
})

test('并发互斥：开跑必须先取得空间行锁（外部持锁时不得推进）', async () => {
  // 这条用例专门区分「有没有行锁」：删掉 `for update of w` 但保留归档状态判断时，
  // 其他并发用例仍然全绿（评审实测 14/14），因为它们只证明状态判断存在。
  // 这里由外部事务持有 workspaces 行锁：开跑若真的取同一把锁就必须阻塞。
  const { ws, userId, sessionId } = await seedRunnableWorkspace('race-lock')

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

  let startSettled = false
  const startPromise = runs.createRun({
    tenantId,
    sessionId,
    requestedBy: userId,
    idempotencyKey: `${ws}-lock-order`,
  }).then(
    value => { startSettled = true; return value },
    error => { startSettled = true; throw error },
  )

  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(startSettled, false, '外部持有空间行锁时开跑不得推进（否则说明没有取行锁）')

  releaseLock()
  await holder
  await startPromise
  assert.equal((await sessionRuns(sessionId)).length, 1, '释放锁后开跑应正常落库')
})

test('并发互斥：归档先提交时，随后创建 Run 必须被拒绝且不落库', async () => {
  const { ws, ownerId, userId, sessionId, agentMemberId } = await seedRunnableWorkspace('race-archive-first')

  let reachedCreateRun = false
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const gatedRuns = new Proxy(runs, {
    get(target, property, receiver) {
      if (property === 'createRun') {
        return async (input: Parameters<PostgresRunRepository['createRun']>[0]) => {
          reachedCreateRun = true
          await gate
          return target.createRun(input)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as PostgresRunRepository
  const gatedOrchestration = new RunOrchestrationService(
    gatedRuns,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    new FakeRuntime(),
    undefined,
    undefined,
    undefined,
    undefined,
    authorization,
    { agentMembers },
  )

  try {
    const startPromise = gatedOrchestration.startRun({
      userId,
      sessionId,
      prompt: '归档后不得开跑',
      idempotencyKey: `${ws}-archive-first`,
      workspaceAgentMemberId: agentMemberId,
    })
    await waitFor(() => reachedCreateRun, '开跑到达创建 Run 的临界点')

    const archived = await lifecycle.archiveWorkspace(ws, ownerId)
    assert.equal(archived.status, 'archived')
    release()

    await assert.rejects(startPromise, /已归档|不可访问|无权/)
    assert.equal((await sessionRuns(sessionId)).length, 0, '归档提交后不得创建 Run')
  } finally {
    release()
    await gatedOrchestration.close()
  }
})

test('并发互斥：归档先提交时，领取排队任务必须失败且不进入运行', async () => {
  const { ws, userId, sessionId } = await seedRunnableWorkspace('race-claim')
  const runId = `${ws}-run`
  const attemptId = `${runId}-attempt`
  await createRunWithAttempt({ runId, sessionId, userId, status: 'queued', agentVersionId: `${ws}-version` })
  // 用 SQL 直接落归档态（模拟历史数据 / 绕过 API），验证领取侧的兜底锁。
  await archiveViaSql(ws)

  const claimed = await runs.claimAttempt(tenantId, attemptId, runtimeId)
  assert.equal(claimed, false, '归档空间中的排队任务不得被领取')
  assert.equal((await runStatus(runId)), 'queued')
  assert.equal(await attemptStatus(attemptId), 'queued')
})

test('并发互斥：排队期间空间被归档的遗留任务必须收敛为终态，不被无限重排', async () => {
  const { ws, userId, sessionId } = await seedRunnableWorkspace('race-archived-queued')
  const runId = `${ws}-run`
  const attemptId = `${runId}-attempt`
  await createRunWithAttempt({ runId, sessionId, userId, status: 'queued', agentVersionId: `${ws}-version` })
  // 绕过 API 直接落归档态（模拟历史/迁移数据或外部写入）：这是唯一能产生
  // 「已归档空间里还有 queued attempt」的途径（API 会因活动 Run 拒绝归档）。
  await archiveViaSql(ws)

  // 重启恢复会把这个 queued attempt 塞回待执行队列；泵必须把它收敛为终态，
  // 而不是每 500ms 重试一次永不结束（质量评审 F3 实测 2.6s 内重试 6 次）。
  await orchestration.recoverAfterServiceRestart()
  await new Promise(resolve => setTimeout(resolve, 1_500))

  assert.notEqual(await attemptStatus(attemptId), 'queued', '归档空间的遗留排队任务必须离开 queued')
  assert.ok(['failed', 'cancelled', 'succeeded'].includes(await runStatus(runId)), 'Run 必须收敛为终态')
})

test('并发互斥：归档与领取排队任务不会死锁，且绝不会在归档空间内开跑', async () => {
  const { ws, ownerId, userId, sessionId } = await seedRunnableWorkspace('race-claim-2')
  const runId = `${ws}-run`
  const attemptId = `${runId}-attempt`
  await createRunWithAttempt({ runId, sessionId, userId, status: 'queued', agentVersionId: `${ws}-version` })

  const results = await Promise.allSettled([
    lifecycle.archiveWorkspace(ws, ownerId),
    runs.claimAttempt(tenantId, attemptId, runtimeId),
  ])
  assert.equal(results.length, 2, '两个操作都必须收敛，不得死锁')

  const archived = (await workspaceRow(ws)).status === 'archived'
  const claimed = results[1]?.status === 'fulfilled' && results[1].value === true
  assert.equal(archived && claimed, false, '不得出现「空间已归档且任务已进入运行」的组合')

  if (claimed) {
    // 领取先成功：空间仍活动，归档因存在活动 Run 被拒绝。
    assert.equal((await workspaceRow(ws)).status, 'active')
    assert.equal(results[0]?.status, 'rejected')
  } else {
    // 归档先提交：领取未成功，Run 保排队但不进入运行。
    assert.equal((await runStatus(runId)), 'queued')
  }
})

test('并发互斥：归档后重试（创建 Attempt）必须被拒绝', async () => {
  const { ws, ownerId, userId, sessionId } = await seedRunnableWorkspace('race-retry')
  const runId = `${ws}-run`
  await createRunWithAttempt({ runId, sessionId, userId, status: 'failed', agentVersionId: `${ws}-version` })

  // failed 是终态：允许归档。
  const archived = await lifecycle.archiveWorkspace(ws, ownerId)
  assert.equal(archived.status, 'archived')

  await assert.rejects(
    runs.createAttempt({
      tenantId,
      runId,
      runtimeId,
      manifest: testAttemptManifest(`task-${runId}`, runId, { manifest_version: '1.0', attempt_id: `${runId}-attempt-2` }),
      manifestSha256: 'lifecycle-test',
      modelRouteSnapshot: {},
    }),
    /已归档|不可访问/,
    '归档空间不得通过重试复活 Run',
  )
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

function uniqueWorkspace(prefix: string) {
  return `ws-t2-${prefix}-${randomUUID().slice(0, 8)}`
}

async function seedUser(id: string, displayName: string) {
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status,
      identity_provider, business_user
    ) values (
      ${id}, ${tenantId}, ${`directory:${id}`}, ${displayName},
      null, 'active', 'ai-hub', true
    )
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local')
    on conflict do nothing
  `
}

async function createTeamWorkspace(workspaceId: string, members: MemberRow[]) {
  const ownerId = members[0]?.userId ?? 'U00001'
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'T2 归档测试团队空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

async function seedAgent(workspacePrefix: string, versionId: string) {
  const agentId = `${workspacePrefix}-agent`
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
      status, active_version_id, allow_workspace_join
    ) values (
      ${agentId}, ${tenantId}, 'T2 归档测试 Agent', 'T2 归档测试。',
      '', 'U00008', 'U00008', 'published', null, true
    )
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_output_bytes, max_tool_calls,
      timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${agentId}, '1.0.0', 'T2 归档测试 Agent', 'T2 归档测试版本。',
      '', ${database.json([] as string[])}, '你是 T2 集成测试 Agent。',
      ${database.json(['role-employee'] as string[])}, ${database.json(['enterprise:authorized'] as string[])},
      65536, 20, 300, ${database.json([] as string[])}, ${database.json([] as string[])},
      'published', 'U00008', 'T2 测试版本'
    )
  `
  await database`
    update agents set active_version_id = ${versionId}
     where tenant_id = ${tenantId} and id = ${agentId}
  `
  await database`
    insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
    values (${tenantId}, ${`principal-agent-${agentId}`}, 'role-employee')
  `
  await database`
    insert into agent_principal_scope_grants (tenant_id, principal_id, scope_value)
    values (${tenantId}, ${`principal-agent-${agentId}`}, 'enterprise:authorized')
  `
}

async function grantAgentVersion(workspaceId: string, versionId: string) {
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, ${workspaceId}, 'agent', ${versionId})
    on conflict do nothing
  `
}

async function createSessionRow(sessionId: string, workspaceId: string, userId: string, agentVersionId: string) {
  await database`
    insert into sessions (
      id, tenant_id, workspace_id, created_by, agent_version_id, title, status
    ) values (
      ${sessionId}, ${tenantId}, ${workspaceId}, ${userId}, ${agentVersionId},
      'T2 归档测试会话', 'active'
    )
  `
}

async function createRunWithAttempt(input: {
  runId: string
  sessionId: string
  userId: string
  status: 'queued' | 'running' | 'waiting' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled'
  agentVersionId: string
}) {
  const attemptId = `${input.runId}-attempt`
  const [session] = await database<{ workspaceId: string }[]>`
    select workspace_id as "workspaceId" from sessions
     where tenant_id = ${tenantId} and id = ${input.sessionId}
  `
  if (!session) throw new Error(`测试 Session 不存在：${input.sessionId}`)
  const taskId = `task-${input.runId}`
  const manifest = {
    manifest_version: '1.0',
    run_id: input.runId,
    task_id: taskId,
    attempt_id: attemptId,
    session_id: input.sessionId,
    workspace_id: session.workspaceId,
    agent_version_id: input.agentVersionId,
    agent_configuration: { system_prompt: 'Team workspace lifecycle integration fixture.', skill_instructions: [] },
    user_context: { user_id: input.userId, tenant_id: tenantId, role_ids: [] },
    permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [],
    tools: [],
    data_scopes: [],
    knowledge_context: [],
    input: { message: 'Lifecycle integration fixture.', file_mounts: [] },
    budget: {
      scope_task_id: taskId,
      cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
      reservation: { duration_ms: 300_000, tool_calls: 8, output_bytes: 65_536 },
      enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
    },
    limits: { timeout_seconds: 300, max_tool_calls: 8, max_output_bytes: 65_536 },
    created_at: new Date().toISOString(),
    trace_id: `trace-${input.runId}`,
  }
  await database.begin(async transaction => {
    await transaction`
      insert into runs (
        id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id
      ) values (
        ${input.runId}, ${tenantId}, ${input.sessionId}, ${input.userId},
        ${`idem-${input.runId}`}, ${input.status}, ${attemptId}
      )
    `
    await transaction`
      insert into run_attempts (
        id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256,
        model_route_snapshot, status
      ) values (
        ${attemptId}, ${tenantId}, ${input.runId}, 1, ${runtimeId},
        ${transaction.json(manifest)}, 'lifecycle-test', ${transaction.json({})}, ${input.status}
      )
    `
  })
  return { attemptId }
}

async function seedRunnableWorkspace(prefix: string) {
  const ws = uniqueWorkspace(prefix)
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, `${prefix} 负责人`)
  await seedUser(userId, `${prefix} 成员`)
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId, role: 'member' }])
  await seedAgent(ws, versionId)
  // TW-10：经真实加入路径写 Agent 成员——同事务落 workspace_agent_members +
  // agent_member 授权来源 + workspace_capability_grants，与生产授权模型一致；
  // 直接插行会缺 grant source，测不到派发前复核依赖的授权链路。
  const member = await agentMembers.addAgentMember(ws, `${ws}-agent`, ownerId, ['role-employee'])
  const sessionId = `${ws}-session`
  await createSessionRow(sessionId, ws, userId, versionId)
  return { ws, ownerId, userId, versionId, sessionId, agentMemberId: member.id }
}

async function archiveViaSql(workspaceId: string) {
  await database`
    update workspaces set status = 'archived', archived_at = now()
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
}

async function setRunStatus(runId: string, status: string) {
  await database`
    update runs set status = ${status} where tenant_id = ${tenantId} and id = ${runId}
  `
  await database`
    update run_attempts set status = ${status} where tenant_id = ${tenantId} and id = ${`${runId}-attempt`}
  `
}

async function workspaceRow(workspaceId: string) {
  const [row] = await database<{ status: string; archivedAt: Date | null }[]>`
    select status, archived_at as "archivedAt" from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
  if (!row) throw new Error(`工作空间不存在：${workspaceId}`)
  return row
}

async function runStatus(runId: string) {
  const [row] = await database<{ status: string }[]>`
    select status from runs where tenant_id = ${tenantId} and id = ${runId}
  `
  return row?.status
}

async function attemptStatus(attemptId: string) {
  const [row] = await database<{ status: string }[]>`
    select status from run_attempts where tenant_id = ${tenantId} and id = ${attemptId}
  `
  return row?.status
}

async function sessionRuns(sessionId: string) {
  const rows = await database<{ id: string; status: string }[]>`
    select id, status from runs
     where tenant_id = ${tenantId} and session_id = ${sessionId}
     order by created_at asc
  `
  return rows
}

async function auditRows(workspaceId: string) {
  const rows = await database<{
    action: string
    actorId: string
    objectType: string
    result: string
    safeContext: Record<string, unknown>
  }[]>`
    select action, actor_id as "actorId", object_type as "objectType",
           result, safe_context as "safeContext"
      from audit_events
     where tenant_id = ${tenantId} and object_id = ${workspaceId}
     order by occurred_at asc
  `
  return rows
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

async function workspaceFromList(actorUserId: string, workspaceId: string) {
  const result = await api('GET', '/api/workbench/v1/workspaces', { as: actorUserId })
  assert.equal(result.status, 200)
  const match = (result.body.data as Array<{ id: string }>).find(item => item.id === workspaceId)
  if (!match) throw new Error(`列表中不存在工作空间：${workspaceId}`)
  return match as { id: string; owner: string; status: string; archivedAt: string | null }
}

async function api(method: string, path: string, options: { as?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.as) headers['x-test-user-id'] = options.as
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json().catch(() => null) as {
    data?: unknown
    error?: { code: string; message: string }
  }
  return { status: response.status, body }
}

function errorMessage(result: { body: { error?: { message: string } } }): string {
  return result.body.error?.message ?? ''
}

async function waitFor(condition: () => Promise<boolean> | boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${label}`)
}

async function waitForWorkspaceLockWaiters(minimum: number, label: string) {
  await waitFor(async () => {
    const [row] = await database<{ count: number }[]>`
      select count(*)::integer as count
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and state = 'active'
         and wait_event_type = 'Lock'
         and query ilike '%from workspaces%'
    `
    return (row?.count ?? 0) >= minimum
  }, label)
}

class FakeRuntime implements AgentRuntimePort {
  holdCompletions = true
  private readonly executions = new Map<string, { terminal: boolean; resolveDone: (snapshot: RuntimeExecutionSnapshot) => void; snapshot: RuntimeExecutionSnapshot }>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      status: 'queued',
      acceptedAt: now,
      startedAt: null,
      endedAt: null,
      manifestSha256: 'lifecycle-test',
      attemptDirectory: '/tmp/lifecycle-test',
      errorCode: null,
      errorMessage: null,
    }
    this.executions.set(manifest.run_id, { terminal: false, resolveDone, snapshot })
    setTimeout(() => {
      const execution = this.executions.get(manifest.run_id)
      if (!execution || execution.terminal) return
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      if (!this.holdCompletions) {
        execution.terminal = true
        execution.snapshot.status = 'completed'
        execution.snapshot.endedAt = new Date().toISOString()
        execution.resolveDone(structuredClone(execution.snapshot))
      }
    }, 5)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe() {
    return () => undefined
  }

  async cancel(runId: string) {
    const execution = this.executions.get(runId)
    if (execution && !execution.terminal) {
      execution.terminal = true
      execution.snapshot.status = 'cancelled'
      execution.snapshot.endedAt = new Date().toISOString()
      execution.resolveDone(structuredClone(execution.snapshot))
    }
    return { accepted: false }
  }

  status(runId: string) {
    const snapshot = this.executions.get(runId)?.snapshot
    return snapshot === undefined ? undefined : structuredClone(snapshot)
  }

  async health() {
    return {
      status: 'healthy' as const,
      runtimeId,
      activeExecutions: 0,
      acceptingRuns: true,
      dshRepository: '/tmp',
      transport: 'acp-stdio' as const,
      message: '测试 Runtime 正在接收任务',
    }
  }

  async close() {
    for (const execution of this.executions.values()) {
      if (!execution.terminal) {
        execution.terminal = true
        execution.snapshot.status = 'cancelled'
        execution.resolveDone(structuredClone(execution.snapshot))
      }
    }
  }
}
