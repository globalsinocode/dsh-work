import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import type { ApiAudience, RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { AuthorizationDeniedError } from '../modules/authorization/authorization-errors.ts'
import { PostgresOperationsService } from '../modules/admin/application/postgres-operations-service.ts'
import { PostgresGrantReconciliationService } from '../modules/admin/application/postgres-grant-reconciliation-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { Router, classifyHttpError } from './router.ts'
import { registerAgentRoutes } from './admin/agent-routes.ts'
import { registerOperationsRoutes } from './admin/operations-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './workbench/workspace-agent-member-routes.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const adminUserId = 'U00008'
const suffix = randomUUID().replaceAll('-', '')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let server: Server
let baseUrl = ''
let reconciliation: PostgresGrantReconciliationService

interface AgentMemberRow {
  id: string
  status: string
}

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_reconciliation_api_test', maxConnections: 8 })
  database = throwaway.client

  const authorization = new PostgresAuthorizationService(database)
  const operations = new PostgresOperationsService(database)
  const agents = new PostgresAgentService(database, operations)
  const agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  reconciliation = new PostgresGrantReconciliationService(database, operations)

  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerWorkspaceAgentMemberRoutes(router, agentMembers, authorization)
  registerAgentRoutes(router, agents)
  registerOperationsRoutes(router, operations, reconciliation)
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
// A. Agent 治理开关 allow_workspace_join
// ---------------------------------------------------------------------------

test('admin 关闭 allow_workspace_join 后 Agent 从候选消失且不能被加入，重新开启恢复', async () => {
  const workspaceId = `ws-t7-join-${suffix}`
  const ownerId = `user-t7-join-${suffix}`
  await createDirectoryUser(ownerId, 'T7 开关负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const agent = await createPublishedAgent({ id: `agent-t7-join-${suffix}`, name: 'T7 开关 Agent', ownerId })

  const before = await candidates(workspaceId, ownerId)
  assert.ok(before.includes(agent.id))

  const disabled = await api('PATCH', `/api/admin/v1/agents/${agent.id}`, {
    as: adminUserId,
    body: { allowWorkspaceJoin: false },
  })
  assert.equal(disabled.status, 200)
  assert.equal((disabled.body.data as { agent: { allowWorkspaceJoin: boolean } }).agent.allowWorkspaceJoin, false)

  const [row] = await database<{ allowWorkspaceJoin: boolean }[]>`
    select allow_workspace_join as "allowWorkspaceJoin" from agents
     where tenant_id = ${tenantId} and id = ${agent.id}
  `
  assert.equal(row?.allowWorkspaceJoin, false)

  const hidden = await candidates(workspaceId, ownerId)
  assert.equal(hidden.includes(agent.id), false)

  const rejected = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(rejected.status, 409)
  assert.match(errorMessage(rejected), /未开放加入/)

  const enabled = await api('PATCH', `/api/admin/v1/agents/${agent.id}`, {
    as: adminUserId,
    body: { allowWorkspaceJoin: true },
  })
  assert.equal(enabled.status, 200)
  assert.equal((enabled.body.data as { agent: { allowWorkspaceJoin: boolean } }).agent.allowWorkspaceJoin, true)
  const restored = await candidates(workspaceId, ownerId)
  assert.ok(restored.includes(agent.id))

  // 审计：每次开关变更写一条 agent.workspace_join.update。
  const [audit] = await database<{ count: number }[]>`
    select count(*)::integer as count from audit_events
     where tenant_id = ${tenantId} and action = 'agent.workspace_join.update' and object_id = ${agent.id}
  `
  assert.equal(audit?.count, 2)
})

test('admin 治理开关校验参数并拒绝不存在的 Agent', async () => {
  const invalid = await api('PATCH', `/api/admin/v1/agents/agent-dsh-work-assistant`, {
    as: adminUserId,
    body: { allowWorkspaceJoin: 'yes' },
  })
  assert.equal(invalid.status, 422)
  assert.match(errorMessage(invalid), /布尔值/)

  const missing = await api('PATCH', `/api/admin/v1/agents/agent-t7-missing-${suffix}`, {
    as: adminUserId,
    body: { allowWorkspaceJoin: false },
  })
  assert.equal(missing.status, 404)
  assert.match(errorMessage(missing), /Agent 不存在/)
})

test('admin Agent 详情返回只读的「已加入空间」清单，已移出成员不再出现', async () => {
  const workspaceId = `ws-t7-joined-${suffix}`
  const ownerId = `user-t7-joined-${suffix}`
  await createDirectoryUser(ownerId, 'T7 已加入空间负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const agent = await createPublishedAgent({ id: `agent-t7-joined-${suffix}`, name: 'T7 已加入空间 Agent', ownerId })

  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201)
  const memberId = (joined.body.data as { id: string }).id

  const listed = await api('GET', `/api/admin/v1/agents/${agent.id}/workspaces`, { as: adminUserId })
  assert.equal(listed.status, 200)
  const items = (listed.body.data as { items: Array<Record<string, unknown>> }).items
  assert.equal(items.length, 1)
  assert.equal(items[0]?.workspaceId, workspaceId)
  assert.equal(items[0]?.workspaceName, '1A Agent 成员测试团队空间')
  assert.equal(items[0]?.memberStatus, 'available')
  assert.equal(items[0]?.version, '1.0.0')
  assert.equal(items[0]?.workspaceType, 'team')

  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${memberId}`, { as: ownerId })
  assert.equal(removed.status, 200)
  const afterRemoval = await api('GET', `/api/admin/v1/agents/${agent.id}/workspaces`, { as: adminUserId })
  assert.equal((afterRemoval.body.data as { items: unknown[] }).items.length, 0)

  const missing = await api('GET', `/api/admin/v1/agents/agent-t7-missing-${suffix}/workspaces`, { as: adminUserId })
  assert.equal(missing.status, 404)
})

// ---------------------------------------------------------------------------
// B. legacy 授权来源对账清单
// ---------------------------------------------------------------------------

test('对账清单列出 legacy 来源与可能归属 Agent，仅提示不自动回填', async () => {
  const view = await api('GET', '/api/admin/v1/grant-sources/unresolved', { as: adminUserId })
  assert.equal(view.status, 200)
  const data = view.body.data as {
    items: Array<{
      sourceId: string
      workspaceId: string
      capabilityType: string
      capabilityVersionId: string
      possibleAgents: Array<{ agentId: string }>
      inferenceNote: string
    }>
    workspaceSummary: Array<{ workspaceId: string, unresolvedCount: number }>
  }

  // 迁移把 0010 种子的 ws-supply/ws-operations grants 各回填一条 legacy 来源。
  const supplyAgent = data.items.find(item =>
    item.workspaceId === 'ws-supply'
    && item.capabilityType === 'agent'
    && item.capabilityVersionId === 'agent-version-dsh-work-assistant-1')
  assert.ok(supplyAgent, '对账清单应包含 ws-supply 的 Agent 版本 legacy 来源')
  assert.deepEqual(supplyAgent.possibleAgents.map(agent => agent.agentId), ['agent-dsh-work-assistant'])
  assert.match(supplyAgent.inferenceNote, /仅提示不自动回填/)

  const supplyTool = data.items.find(item => item.workspaceId === 'ws-supply' && item.capabilityType === 'tool')
  assert.ok(supplyTool)
  assert.deepEqual(supplyTool.possibleAgents, [])

  const supplySummary = data.workspaceSummary.find(entry => entry.workspaceId === 'ws-supply')
  assert.equal(supplySummary?.unresolvedCount, 3)

  // 只列 legacy_unresolved 来源。
  const [legacyCount] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources
     where tenant_id = ${tenantId} and source_type = 'legacy_unresolved' and status = 'active'
  `
  assert.equal(data.items.length, legacyCount?.count)
})

test('对账完成把 legacy 来源改写为 manual、不删除任何行、不改变有效授权集合并记审计', async () => {
  const workspaceId = `ws-t7-reconcile-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: adminUserId, role: 'owner' }])
  const tool = await createTool({ id: `tool-t7-rec-${suffix}` })
  const legacySourceId = await seedLegacySource({
    workspaceId,
    capabilityType: 'tool',
    capabilityVersionId: tool.versionId,
  })
  // 第二个 legacy 来源：覆盖 admin UI 的「按空间批量对账」多 id 路径。
  const secondLegacySourceId = await seedLegacySource({
    workspaceId,
    capabilityType: 'tool',
    capabilityVersionId: tool.versionId,
  })
  // 一条已撤销的来源行，用于验证对账不会物理删除撤销行。
  await database`
    insert into workspace_grant_sources (
      id, tenant_id, workspace_id, capability_type, capability_version_id,
      source_type, source_ref_id, status, created_by, revoked_at
    ) values (
      ${`wgs-t7-revoked-${suffix}`}, ${tenantId}, ${workspaceId}, 'tool', ${tool.versionId},
      'legacy_unresolved', null, 'revoked', 'U00001', now()
    )
  `
  const [before] = await database<{ sources: number; grants: number }[]>`
    select (select count(*)::integer from workspace_grant_sources
             where tenant_id = ${tenantId} and workspace_id = ${workspaceId}) as sources,
           (select count(*)::integer from workspace_capability_grants
             where tenant_id = ${tenantId} and workspace_id = ${workspaceId}) as grants
  `

  const result = await api('POST', '/api/admin/v1/grant-sources/reconcile', {
    as: adminUserId,
    body: { sourceIds: [legacySourceId, secondLegacySourceId] },
  })
  assert.equal(result.status, 200)
  const payload = result.body.data as { reconciled: number, sourceIds: string[], workspaceIds: string[] }
  assert.equal(payload.reconciled, 2)
  assert.deepEqual([...payload.sourceIds].sort(), [legacySourceId, secondLegacySourceId].sort())
  assert.deepEqual(payload.workspaceIds, [workspaceId])

  const rewrittenRows = await database<{ sourceType: string; status: string }[]>`
    select source_type as "sourceType", status from workspace_grant_sources
     where tenant_id = ${tenantId} and id in ${database([legacySourceId, secondLegacySourceId])}
     order by id
  `
  assert.equal(rewrittenRows.length, 2)
  assert.ok(rewrittenRows.every(row => row.sourceType === 'manual' && row.status === 'active'))

  // 撤销行保留，不物理删除；来源与授权行数不变（有效授权集合未变）。
  const [revoked] = await database<{ status: string }[]>`
    select status from workspace_grant_sources
     where tenant_id = ${tenantId} and id = ${`wgs-t7-revoked-${suffix}`}
  `
  assert.equal(revoked?.status, 'revoked')
  const [after] = await database<{ sources: number; grants: number }[]>`
    select (select count(*)::integer from workspace_grant_sources
             where tenant_id = ${tenantId} and workspace_id = ${workspaceId}) as sources,
           (select count(*)::integer from workspace_capability_grants
             where tenant_id = ${tenantId} and workspace_id = ${workspaceId}) as grants
  `
  assert.equal(after?.sources, before?.sources)
  assert.equal(after?.grants, before?.grants)

  const [audit] = await database<{ count: number }[]>`
    select count(*)::integer as count from audit_events
     where tenant_id = ${tenantId} and action = 'workspace.grant_source.reconcile'
       and object_id = ${workspaceId}
  `
  assert.equal(audit?.count, 1)

  // 幂等/冲突与参数校验。
  const again = await api('POST', '/api/admin/v1/grant-sources/reconcile', {
    as: adminUserId,
    body: { sourceIds: [legacySourceId] },
  })
  assert.equal(again.status, 409)
  assert.match(errorMessage(again), /不能重复对账/)

  const missing = await api('POST', '/api/admin/v1/grant-sources/reconcile', {
    as: adminUserId,
    body: { sourceIds: [`wgs-t7-missing-${suffix}`] },
  })
  assert.equal(missing.status, 404)
  assert.match(errorMessage(missing), /不存在/)

  const empty = await api('POST', '/api/admin/v1/grant-sources/reconcile', {
    as: adminUserId,
    body: { sourceIds: [] },
  })
  assert.equal(empty.status, 422)
})

test('对账接口按管理权限保护：非管理员不能完成对账', async () => {
  const forbidden = await api('POST', '/api/admin/v1/grant-sources/reconcile', {
    as: 'U00001',
    body: { sourceIds: ['wgs-anything'] },
  })
  assert.equal(forbidden.status, 403)

  // 5-T4：服务层的平台管理员校验同样类型化，HTTP 仍是 403 permission_denied。
  const denial = await reconciliation.reconcile({ sourceIds: ['wgs-anything'], actor: 'U00001' })
    .then(() => null, (error: unknown) => error)
  assert.ok(denial instanceof AuthorizationDeniedError, `必须是类型化授权拒绝，实际：${String(denial)}`)
  assert.equal(denial.status, 403)
  assert.equal(denial.code, 'permission_denied')
  assert.equal(
    classifyHttpError(denial, '/api/admin/v1/grant-sources/reconcile').error.code,
    'permission_denied',
  )
})

// ---------------------------------------------------------------------------
// B. 对账完成前的破坏性调整门禁（方案 6.3）
// ---------------------------------------------------------------------------

test('存在 legacy 来源时移除或停用 Agent 被拒绝并提示先对账，对账完成后放行', async () => {
  const workspaceId = `ws-t7-gate-${suffix}`
  const ownerId = `user-t7-gate-${suffix}`
  await createDirectoryUser(ownerId, 'T7 门禁负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const tool = await createTool({ id: `tool-t7-gate-${suffix}` })
  const legacySourceId = await seedLegacySource({
    workspaceId,
    capabilityType: 'tool',
    capabilityVersionId: tool.versionId,
  })
  const agent = await createPublishedAgent({
    id: `agent-t7-gate-${suffix}`,
    name: 'T7 门禁 Agent',
    ownerId,
    toolRefs: [`tool-t7-gate-${suffix}@1.0.0`],
  })

  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201, '加入不受门禁限制（非破坏性调整）')
  const memberId = (joined.body.data as { id: string }).id

  const blockedDisable = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${memberId}`, {
    as: ownerId,
    body: { action: 'disable' },
  })
  assert.equal(blockedDisable.status, 409)
  assert.match(errorMessage(blockedDisable), /待对账的历史授权来源/)
  assert.match(errorMessage(blockedDisable), /完成对账前不能停用 Agent 成员/)

  const blockedRemove = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${memberId}`, { as: ownerId })
  assert.equal(blockedRemove.status, 409)
  assert.match(errorMessage(blockedRemove), /完成对账前不能移除 Agent 成员/)

  // 被拒绝后成员状态与 agent_member 来源保持原样。
  const [member] = await database<AgentMemberRow[]>`
    select id, status from workspace_agent_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${memberId}
  `
  assert.equal(member?.status, 'available')
  const [activeAgentSources] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
       and source_type = 'agent_member' and source_ref_id = ${memberId} and status = 'active'
  `
  assert.ok((activeAgentSources?.count ?? 0) > 0)

  // 对账完成 → 门禁解除。
  const reconciled = await api('POST', '/api/admin/v1/grant-sources/reconcile', {
    as: adminUserId,
    body: { sourceIds: [legacySourceId] },
  })
  assert.equal(reconciled.status, 200)

  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${memberId}`, { as: ownerId })
  assert.equal(removed.status, 200)
  const [afterMember] = await database<AgentMemberRow[]>`
    select id, status from workspace_agent_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${memberId}
  `
  assert.equal(afterMember?.status, 'removed')

  // legacy 来源对账后成为 manual 并保持 active，因此该工具授权不因移出 Agent 被删除。
  const [legacyToolSource] = await database<{ sourceType: string; status: string }[]>`
    select source_type as "sourceType", status from workspace_grant_sources
     where tenant_id = ${tenantId} and id = ${legacySourceId}
  `
  assert.equal(legacyToolSource?.sourceType, 'manual')
  assert.equal(legacyToolSource?.status, 'active')
  const [preservedGrant] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_capability_grants
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
       and capability_type = 'tool' and capability_version_id = ${tool.versionId}
  `
  assert.equal(preservedGrant?.count, 1, '来源不明的存量授权不能因移出 Agent 顺带删除')
})

test('并发「对账 + 移出 Agent 成员」按同一锁序串行化，不死锁', async () => {
  const workspaceId = `ws-t7-deadlock-${suffix}`
  const ownerId = `user-t7-deadlock-${suffix}`
  await createDirectoryUser(ownerId, 'T7 死锁负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const tool = await createTool({ id: `tool-t7-deadlock-${suffix}` })
  const legacySourceId = await seedLegacySource({
    workspaceId,
    capabilityType: 'tool',
    capabilityVersionId: tool.versionId,
  })
  const agent = await createPublishedAgent({
    id: `agent-t7-deadlock-${suffix}`,
    name: 'T7 死锁 Agent',
    ownerId,
    toolRefs: [`tool-t7-deadlock-${suffix}@1.0.0`],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201)
  const memberId = (joined.body.data as { id: string }).id

  // 对账（admin）与移出（员工端 HTTP）并发提交。旧实现里 reconcile 先锁
  // workspace_grant_sources 行、再锁 workspace 行，而移出先锁 workspace 行、
  // 再读来源行——相反锁序会被 PostgreSQL 判为死锁。
  //
  // Promise.all 不保证谁先拿到空间锁：若移出先持锁，此时 legacy 尚未对账，
  // 门禁返回 409 是**正确**行为，不能强制要求 200。接受两种合法顺序：
  //   - 移出 200：对账先完成，门禁已解除；
  //   - 移出 409：移出先持锁、被门禁拒绝；等对账完成后重试，最终状态一致。
  // 无论哪种顺序，都不得出现 deadlock。
  const [reconciled, firstRemoval] = await Promise.all([
    api('POST', '/api/admin/v1/grant-sources/reconcile', {
      as: adminUserId,
      body: { sourceIds: [legacySourceId] },
    }),
    api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${memberId}`, { as: ownerId }),
  ])
  assert.equal(/deadlock/i.test(errorMessage(reconciled)), false, `对账不得死锁：${errorMessage(reconciled)}`)
  assert.equal(/deadlock/i.test(errorMessage(firstRemoval)), false, `移出不得死锁：${errorMessage(firstRemoval)}`)
  assert.equal(reconciled.status, 200, '对账必须成功')

  if (firstRemoval.status === 409) {
    assert.match(errorMessage(firstRemoval), /待对账的历史授权来源/, '先持锁的移出应被门禁拒绝')
    const retried = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${memberId}`, { as: ownerId })
    assert.equal(retried.status, 200, '对账完成后重试移出应成功')
  } else {
    assert.equal(firstRemoval.status, 200)
  }

  const [legacySource] = await database<{ sourceType: string; status: string }[]>`
    select source_type as "sourceType", status from workspace_grant_sources
     where tenant_id = ${tenantId} and id = ${legacySourceId}
  `
  assert.equal(legacySource?.sourceType, 'manual')
  assert.equal(legacySource?.status, 'active')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function testApiAuthenticator(request: IncomingMessage, audience: ApiAudience): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    throw error
  }
  const isAdmin = audience === 'admin'
  const isPlatformAdmin = isAdmin && userId === adminUserId
  return Promise.resolve({
    audience,
    applicationId: isAdmin ? 'test-admin' : 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId,
      name: userId,
      title: isAdmin ? '平台管理员' : '员工',
      department: '测试部门',
      avatarText: '测',
      role: isAdmin ? 'platform_admin' : 'employee',
      dataScopes: ['enterprise:authorized'],
    },
    roleIds: isAdmin ? ['role-platform-admin'] : ['role-employee'],
    permissions: isAdmin ? (isPlatformAdmin ? ['admin:*'] : ['admin:read']) : ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}

async function createDirectoryUser(id: string, displayName: string) {
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

async function createTeamWorkspace(
  workspaceId: string,
  members: Array<{ userId: string, role: 'owner' | 'admin' | 'member' | 'viewer' }>,
) {
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '1A Agent 成员测试团队空间', '', 'team', 'U00001', 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, 'U00001')
    `
  }
}

async function createPublishedAgent(input: {
  id: string
  name?: string
  ownerId: string
  toolRefs?: string[]
  allowJoin?: boolean
}) {
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
      status, active_version_id, allow_workspace_join
    ) values (
      ${input.id}, ${tenantId}, ${input.name ?? 'T7 测试 Agent'}, 'T7 对账与治理集成测试。',
      '', ${input.ownerId}, ${input.ownerId}, 'published', null, ${input.allowJoin ?? true}
    )
  `
  const versionId = `agent-version-${input.id}-1-0-0`
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_output_bytes, max_tool_calls,
      timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${input.id}, '1.0.0', 'T7 测试 Agent', 'T7 对账与治理集成测试。',
      '', ${database.json(['测试'] as string[])}, '你是 T7 集成测试 Agent。',
      ${database.json(['role-employee'])}, ${database.json(['enterprise:authorized'])},
      65536, 20, 300, ${database.json([] as string[])}, ${database.json(input.toolRefs ?? [])},
      'published', ${input.ownerId}, 'T7 测试版本'
    )
  `
  await database`
    update agents set active_version_id = ${versionId}
     where tenant_id = ${tenantId} and id = ${input.id}
  `
  return { id: input.id, versionId }
}

async function createTool(input: { id: string }) {
  const versionId = `tool-version-${input.id}-1`
  await database.begin(async transaction => {
    await transaction`
      insert into tools (
        id, tenant_id, key, name, source, status, connector_id, system, description,
        dsh_tool_name, mode, timeout_seconds, allowed_role_ids, data_scopes,
        approval_policy, last_checked_at
      ) values (
        ${input.id}, ${tenantId}, ${`dsh-${input.id}`}, 'T7 测试工具', 'platform', 'available',
        'connector-dsh-workspace', 'DSH Runtime', 'T7 对账集成测试工具。',
        ${input.id}, 'read', 30, ${transaction.json(['role-employee'] as string[])},
        ${transaction.json(['enterprise:authorized'] as string[])}, 'none', now()
      )
    `
    await transaction`
      insert into tool_versions (id, tenant_id, tool_id, version, input_schema, output_schema, risk_level, status)
      values (${versionId}, ${tenantId}, ${input.id}, '1.0.0', '{}', '{}', 'low', 'published')
    `
  })
  return { id: input.id, versionId }
}

/**
 * 模拟「迁移后、对账前」状态：一条既有 grant + 一条 legacy_unresolved 来源。
 */
async function seedLegacySource(input: {
  workspaceId: string
  capabilityType: 'agent' | 'skill' | 'tool'
  capabilityVersionId: string
}) {
  const sourceId = `wgs-legacy-t7-${suffix}-${randomUUID().slice(0, 8)}`
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, ${input.workspaceId}, ${input.capabilityType}, ${input.capabilityVersionId})
    on conflict do nothing
  `
  await database`
    insert into workspace_grant_sources (
      id, tenant_id, workspace_id, capability_type, capability_version_id,
      source_type, source_ref_id, status, created_by
    ) values (
      ${sourceId}, ${tenantId}, ${input.workspaceId}, ${input.capabilityType},
      ${input.capabilityVersionId}, 'legacy_unresolved', null, 'active', 'U00001'
    )
  `
  return sourceId
}

async function candidates(workspaceId: string, as: string) {
  const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-candidates?limit=100`, { as })
  assert.equal(result.status, 200)
  return (result.body.data as { items: Array<{ agentId: string }> }).items.map(item => item.agentId)
}

async function api(method: string, path: string, options: { as?: string, body?: unknown } = {}) {
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
    error?: { code: string, message: string }
  }
  return { status: response.status, body }
}

function errorMessage(result: { body: { error?: { message: string } } }): string {
  return result.body.error?.message ?? ''
}
