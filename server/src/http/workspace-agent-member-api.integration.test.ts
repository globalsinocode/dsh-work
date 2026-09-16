import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { ModelGovernanceService } from '../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../modules/run/postgres-run-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeHealth,
} from '../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresWorkspaceAgentMemberService } from '../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { DatabaseClient, DatabaseTransaction } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { Router } from './router.ts'
import { registerContentRoutes } from './workbench/content-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './workbench/workspace-agent-member-routes.ts'
import { registerConversationRoutes } from './workbench/conversation-routes.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let storageRoot: string
let server: Server
let baseUrl = ''
let authorization: PostgresAuthorizationService
let agents: PostgresAgentService
let agentMembers: PostgresWorkspaceAgentMemberService

interface SourceRow {
  capabilityType: string
  capabilityVersionId: string
  sourceRefId: string | null
  status: string
}

interface GrantRow {
  capabilityType: string
  capabilityVersionId: string
}

interface AgentMemberRow {
  id: string
  agentId: string
  agentVersionId: string
  status: string
  addedBy: string
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
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_member_api_test', maxConnections: 8 })
  database = throwaway.client

  authorization = new PostgresAuthorizationService(database)
  agents = new PostgresAgentService(database)
  agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-agent-member-'))
  const content = new PostgresContentService(database, storageRoot, authorization)
  const conversations = new PostgresConversationRepository(database)
  const orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database),
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    new UnusedTestRuntime(),
    undefined,
    undefined,
    agents,
    undefined,
    authorization,
  )
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerContentRoutes(router, content, authorization, agentMembers)
  registerWorkspaceAgentMemberRoutes(router, agentMembers, authorization)
  registerConversationRoutes(router, conversations, orchestration, new PostgresRunRepository(database), agents, authorization, undefined, undefined, agentMembers)
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
  await rm(storageRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Agent 候选查询
// ---------------------------------------------------------------------------

test('负责人分页搜索可加入的 Agent 候选，仅返回最小字段并排除已加入的 Agent', async () => {
  const workspaceId = 'ws-1a-ag-cand'
  const ownerId = 'user-1a-ag-cand-owner'
  await createDirectoryUser(ownerId, 'Agent候选负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-cand' })
  const created = [
    await createPublishedAgent({ id: 'agent-1a-cand-a', name: 'T4候选甲', updatedAtSecondsAgo: 1, toolRefs: ['tool-1a-cand@1.0.0'] }),
    await createPublishedAgent({ id: 'agent-1a-cand-b', name: 'T4候选乙', updatedAtSecondsAgo: 2, toolRefs: ['tool-1a-cand@1.0.0'] }),
    await createPublishedAgent({ id: 'agent-1a-cand-c', name: 'T4候选丙', updatedAtSecondsAgo: 3, toolRefs: ['tool-1a-cand@1.0.0'] }),
  ]
  await createPublishedAgent({ id: 'agent-1a-cand-other', name: '其他Agent', toolRefs: ['tool-1a-cand@1.0.0'] })

  const query = encodeURIComponent('T4候选')
  const first = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-candidates?query=${query}&limit=2`, { as: ownerId })
  assert.equal(first.status, 200)
  const firstPage = first.body.data as { items: Array<Record<string, unknown>>; nextCursor: string | null }
  assert.equal(firstPage.items.length, 2)
  assert.deepEqual(firstPage.items.map(item => item.agentId), [created[0]?.id, created[1]?.id])
  assert.ok(firstPage.nextCursor)
  for (const item of firstPage.items) {
    assert.deepEqual(Object.keys(item).sort(), ['activeVersion', 'activeVersionId', 'agentId', 'description', 'name', 'status'].sort())
  }

  const second = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-candidates?query=${query}&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`, { as: ownerId })
  assert.equal(second.status, 200)
  const secondPage = second.body.data as { items: Array<Record<string, unknown>>; nextCursor: string | null }
  assert.deepEqual(secondPage.items.map(item => item.agentId), [created[2]?.id])
  assert.equal(secondPage.nextCursor, null)

  const [last] = created
  assert.ok(last)
  assert.equal(firstPage.items[0]?.activeVersionId, last.versionId)
  assert.equal(firstPage.items[0]?.activeVersion, '1.0.0')
  assert.equal(firstPage.items[0]?.status, 'published')

  // 加入后候选不再包含该 Agent。
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: created[0]?.id },
  })
  assert.equal(joined.status, 201)
  const afterJoin = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-candidates?query=${query}&limit=100`, { as: ownerId })
  const afterJoinIds = (afterJoin.body.data as { items: Array<{ agentId: string }> }).items.map(item => item.agentId)
  assert.ok(!afterJoinIds.includes(created[0]?.id ?? ''))
})

test('Agent 候选搜索拒绝无效分页游标与越界 limit，成员不可查询', async () => {
  const workspaceId = 'ws-1a-ag-cand-params'
  const ownerId = 'user-1a-ag-candp-owner'
  const memberId = 'user-1a-ag-candp-member'
  await createDirectoryUser(ownerId, 'Agent候选参数负责人')
  await createDirectoryUser(memberId, 'Agent候选参数成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])

  const badCursor = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-candidates?cursor=${encodeURIComponent('不是游标')}`, { as: ownerId })
  assert.equal(badCursor.status, 422)
  assert.match(errorMessage(badCursor), /游标无效/)

  const badLimit = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-candidates?limit=0`, { as: ownerId })
  assert.equal(badLimit.status, 422)
  assert.match(errorMessage(badLimit), /limit/)

  const asMember = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-candidates`, { as: memberId })
  assert.equal(asMember.status, 403)
  assert.match(errorMessage(asMember), /无权执行/)
})

// ---------------------------------------------------------------------------
// 加入 Agent 成员
// ---------------------------------------------------------------------------

test('负责人加入 Agent 后写入成员关系、Agent/Skill/Tool 授权来源与有效授权并提升修订号', async () => {
  const workspaceId = 'ws-1a-ag-join'
  const ownerId = 'user-1a-ag-join-owner'
  await createDirectoryUser(ownerId, 'Agent加入负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-join' })
  await createSkill({ id: 'skill-1a-join', toolRefs: ['tool-1a-join@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-join',
    name: '加入测试Agent',
    skillRefs: ['skill-1a-join@1.0.0'],
    toolRefs: ['tool-1a-join@1.0.0'],
  })

  const result = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(result.status, 201)
  const member = result.body.data as Record<string, unknown>
  assert.equal(member.agentId, agent.id)
  assert.equal(member.status, 'available')
  assert.equal(member.version, '1.0.0')
  assert.equal(member.addedBy, ownerId)
  assert.deepEqual(member.allowedActions, ['start_conversation', 'disable', 'upgrade', 'remove'])
  // 5-T1 规格评审 F7：`requireAgentMemberRecord` 这条投影（POST/PATCH 响应）此前没有断言。
  // 它与名册共用同一段静态 SQL，健康环境下原因必须是显式的 null（而不是缺字段）。
  assert.ok('unavailableReason' in member, 'POST 响应必须带 unavailableReason 字段')
  assert.equal(member.unavailableReason, null, '可用成员的原因必须是 null')

  const [wam] = await agentMemberRows(workspaceId)
  assert.ok(wam)
  assert.equal(wam.agentId, agent.id)
  assert.equal(wam.agentVersionId, agent.versionId)
  assert.equal(wam.status, 'available')
  assert.equal(wam.addedBy, ownerId)

  const sources = await listSources(workspaceId)
  assert.equal(sources.length, 3)
  for (const source of sources) {
    assert.equal(source.sourceRefId, wam.id)
    assert.equal(source.status, 'active')
  }
  assert.deepEqual(
    sources.map(source => `${source.capabilityType}|${source.capabilityVersionId}`).sort(),
    [
      `agent|${agent.versionId}`,
      `skill|skill-version-skill-1a-join-1`,
      `tool|tool-version-tool-1a-join-1`,
    ].sort(),
  )
  assert.deepEqual(await listGrants(workspaceId), [
    { capabilityType: 'agent', capabilityVersionId: agent.versionId },
    { capabilityType: 'skill', capabilityVersionId: 'skill-version-skill-1a-join-1' },
    { capabilityType: 'tool', capabilityVersionId: 'tool-version-tool-1a-join-1' },
  ])
  assert.equal(await revision(workspaceId), 1)
})

test('依赖校验失败时加入整体回滚：无成员行、无授权来源、无有效授权（AC-03）', async () => {
  const workspaceId = 'ws-1a-ag-deps'
  const ownerId = 'user-1a-ag-deps-owner'
  await createDirectoryUser(ownerId, '依赖校验负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-deps' })
  await createSkill({ id: 'skill-1a-deps', toolRefs: ['tool-1a-deps@1.0.0'] })
  // Agent 未显式授权 Skill 依赖的工具。
  await createPublishedAgent({
    id: 'agent-1a-deps',
    name: '依赖缺失Agent',
    skillRefs: ['skill-1a-deps@1.0.0'],
    toolRefs: [],
  })

  const result = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: 'agent-1a-deps' },
  })
  assert.equal(result.status, 422)
  assert.match(errorMessage(result), /显式授权/)

  assert.equal((await agentMemberRows(workspaceId)).length, 0)
  assert.equal((await listSources(workspaceId)).length, 0)
  assert.equal((await listGrants(workspaceId)).length, 0)
  assert.equal(await revision(workspaceId), 0)
})

test('未发布、不允许加入或无活动版本的 Agent 被明确拒绝', async () => {
  const workspaceId = 'ws-1a-ag-invalid'
  const ownerId = 'user-1a-ag-inv-owner'
  await createDirectoryUser(ownerId, '无效Agent负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-inv' })
  await createPublishedAgent({ id: 'agent-1a-inv-disabled', name: '停用Agent', status: 'disabled', toolRefs: ['tool-1a-inv@1.0.0'] })
  await createPublishedAgent({ id: 'agent-1a-inv-notallowed', name: '不允许加入Agent', allowJoin: false, toolRefs: ['tool-1a-inv@1.0.0'] })
  await createPublishedAgent({ id: 'agent-1a-inv-draft', name: '草稿Agent', toolRefs: ['tool-1a-inv@1.0.0'], versionStatus: 'draft' })

  const disabled = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: 'agent-1a-inv-disabled' },
  })
  assert.equal(disabled.status, 409)
  assert.match(errorMessage(disabled), /未发布/)

  const notAllowed = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: 'agent-1a-inv-notallowed' },
  })
  assert.equal(notAllowed.status, 409)
  assert.match(errorMessage(notAllowed), /未开放加入/)

  const draft = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: 'agent-1a-inv-draft' },
  })
  assert.equal(draft.status, 409)
  assert.match(errorMessage(draft), /活动版本/)

  const missing = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: 'agent-1a-inv-missing' },
  })
  assert.equal(missing.status, 404)
  assert.match(errorMessage(missing), /Agent 不存在/)

  assert.equal((await agentMemberRows(workspaceId)).length, 0)
})

test('非移除状态的重复加入返回明确冲突，移出后重新加入复用同一成员行', async () => {
  const workspaceId = 'ws-1a-ag-readd'
  const ownerId = 'user-1a-ag-readd-owner'
  await createDirectoryUser(ownerId, '重复加入负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-readd' })
  await createSkill({ id: 'skill-1a-readd', toolRefs: ['tool-1a-readd@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-readd',
    name: '重加Agent',
    skillRefs: ['skill-1a-readd@1.0.0'],
    toolRefs: ['tool-1a-readd@1.0.0'],
  })

  const first = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(first.status, 201)
  const firstId = (first.body.data as { id: string }).id

  const duplicate = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(duplicate.status, 409)
  assert.match(errorMessage(duplicate), /已是空间成员/)

  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${firstId}`, { as: ownerId })
  assert.equal(removed.status, 200)

  const readd = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(readd.status, 201)
  assert.equal((readd.body.data as { id: string }).id, firstId)
  assert.equal((readd.body.data as { status: string }).status, 'available')

  const rows = await agentMemberRows(workspaceId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.id, firstId)
  assert.equal(rows[0]?.status, 'available')
  for (const source of await listSources(workspaceId)) {
    assert.equal(source.sourceRefId, firstId)
    assert.equal(source.status, 'active')
  }
  assert.equal((await listGrants(workspaceId)).length, 3)
  assert.equal(await revision(workspaceId), 3)
})

// ---------------------------------------------------------------------------
// Agent 成员列表与允许动作
// ---------------------------------------------------------------------------

test('成员列表仅返回非移除成员，并按当前角色给出允许动作', async () => {
  const workspaceId = 'ws-1a-ag-list'
  const ownerId = 'user-1a-ag-list-owner'
  const adminId = 'user-1a-ag-list-admin'
  const memberId = 'user-1a-ag-list-member'
  const viewerId = 'user-1a-ag-list-viewer'
  await createDirectoryUser(ownerId, 'Agent列表负责人')
  await createDirectoryUser(adminId, 'Agent列表管理员')
  await createDirectoryUser(memberId, 'Agent列表成员')
  await createDirectoryUser(viewerId, 'Agent列表只读')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  await createTool({ id: 'tool-1a-list' })
  await createSkill({ id: 'skill-1a-list', toolRefs: ['tool-1a-list@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-list',
    name: '列表Agent',
    description: '用于验证成员列表与允许动作。',
    skillRefs: ['skill-1a-list@1.0.0'],
    toolRefs: ['tool-1a-list@1.0.0'],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  const asOwner = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId })
  assert.equal(asOwner.status, 200)
  const ownerItems = asOwner.body.data as Array<Record<string, unknown>>
  assert.equal(ownerItems.length, 1)
  const [ownerItem] = ownerItems
  assert.deepEqual(Object.keys(ownerItem ?? {}).sort(), ['addedBy', 'agentId', 'allowedActions', 'createdAt', 'description', 'id', 'name', 'status', 'unavailableReason', 'version'].sort())
  assert.equal(ownerItem?.id, wamId)
  assert.equal(ownerItem?.name, '列表Agent')
  assert.deepEqual(ownerItem?.allowedActions, ['start_conversation', 'disable', 'upgrade', 'remove'])

  const asAdmin = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: adminId })
  const [adminItem] = asAdmin.body.data as Array<Record<string, unknown>>
  assert.deepEqual(adminItem?.allowedActions, ['start_conversation'])

  const asMember = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: memberId })
  const [memberItem] = asMember.body.data as Array<Record<string, unknown>>
  assert.deepEqual(memberItem?.allowedActions, ['start_conversation'])

  const asViewer = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: viewerId })
  const [viewerItem] = asViewer.body.data as Array<Record<string, unknown>>
  assert.deepEqual(viewerItem?.allowedActions, [])

  // 停用后成员不可开始对话，负责人保留管理动作。
  const disabled = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, {
    as: ownerId,
    body: { action: 'disable' },
  })
  assert.equal(disabled.status, 200)
  const afterDisable = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId })
  const [disabledItem] = afterDisable.body.data as Array<Record<string, unknown>>
  assert.equal(disabledItem?.status, 'disabled')
  assert.deepEqual(disabledItem?.allowedActions, ['enable', 'remove'])
  const memberAfterDisable = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: memberId })
  assert.deepEqual((memberAfterDisable.body.data as Array<Record<string, unknown>>)[0]?.allowedActions, [])

  // 移出后不再出现在列表。
  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, { as: ownerId })
  assert.equal(removed.status, 200)
  const afterRemove = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId })
  assert.equal((afterRemove.body.data as unknown[]).length, 0)
})

// ---------------------------------------------------------------------------
// 不可用第三态与具体原因（5-T1）
// ---------------------------------------------------------------------------

test('Agent 成员不可用原因按「版本失效 → 平台未授权 → Runtime 不可用」优先级给出，正常时为 null 且不可用时无 start_conversation', async () => {
  const workspaceId = 'ws-1a-ag-reason'
  const ownerId = 'user-1a-ag-reason-owner'
  const memberId = 'user-1a-ag-reason-member'
  await createDirectoryUser(ownerId, '不可用原因负责人')
  await createDirectoryUser(memberId, '不可用原因成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  await createTool({ id: 'tool-1a-reason' })
  await createSkill({ id: 'skill-1a-reason', toolRefs: ['tool-1a-reason@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-reason',
    name: '不可用原因Agent',
    skillRefs: ['skill-1a-reason@1.0.0'],
    toolRefs: ['tool-1a-reason@1.0.0'],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: agent.id },
  })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id
  // 已发布版本不可变（触发器），「版本已下架」用一条草稿版本被成员固定来制造。
  const draftVersionId = await createAgentVersion({
    agentId: agent.id,
    version: '2.0.0',
    skillRefs: ['skill-1a-reason@1.0.0'],
    toolRefs: ['tool-1a-reason@1.0.0'],
    roleIds: ['role-employee'],
    activate: false,
    versionStatus: 'draft',
  })

  try {
    // 三类原因都不成立：状态可用、原因为 null、允许发起对话。
    const normal = await onlyAgentMember(workspaceId, ownerId)
    assert.equal(normal.status, 'available')
    assert.equal(normal.unavailableReason, null)
    assert.deepEqual(normal.allowedActions, ['start_conversation', 'disable', 'upgrade', 'remove'])

    // 1a) 固定版本非 published 优先于「授权撤销」与「Runtime 不可用」：同时制造三种不成立条件。
    await database`
      update workspace_agent_members set agent_version_id = ${draftVersionId}
       where tenant_id = ${tenantId} and id = ${wamId}
    `
    await revokeAgentMemberSources(workspaceId, wamId)
    await setRuntimeState('degraded', 'draining')
    const versionReason = await onlyAgentMember(workspaceId, ownerId)
    assert.equal(versionReason.status, 'available', '第三态不改 status 取值集合')
    assert.equal(versionReason.unavailableReason, '版本失效：Agent 版本已下架')
    assert.ok(!versionReason.allowedActions.includes('start_conversation'), '不可用时不得给出开始对话')
    assert.deepEqual(versionReason.allowedActions, ['disable', 'upgrade', 'remove'])
    // 管理员/成员在不可用时没有任何动作（不渲染开始对话入口）。
    assert.deepEqual((await onlyAgentMember(workspaceId, memberId)).allowedActions, [])

    // 1b) 成员固定版本恢复 published，但所属 Agent 非 published 同样判定「版本失效」。
    await database`
      update workspace_agent_members set agent_version_id = ${agent.versionId}
       where tenant_id = ${tenantId} and id = ${wamId}
    `
    await database`
      update agents set status = 'disabled'
       where tenant_id = ${tenantId} and id = ${agent.id}
    `
    assert.equal((await onlyAgentMember(workspaceId, ownerId)).unavailableReason, '版本失效：Agent 版本已下架')

    // 2) 版本与 Agent 都恢复 published 后，「平台未授权」优先于「Runtime 不可用」。
    await database`
      update agents set status = 'published'
       where tenant_id = ${tenantId} and id = ${agent.id}
    `
    const grantReason = await onlyAgentMember(workspaceId, ownerId)
    assert.equal(grantReason.unavailableReason, '平台未授权：能力授权已被撤销')
    assert.ok(!grantReason.allowedActions.includes('start_conversation'))

    // 3) 授权恢复后，仅剩 Runtime 不可用。
    await database`
      update workspace_grant_sources set status = 'active', revoked_at = null
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
         and source_type = 'agent_member' and source_ref_id = ${wamId}
    `
    const runtimeReason = await onlyAgentMember(workspaceId, ownerId)
    assert.equal(runtimeReason.unavailableReason, 'Runtime 不可用：暂无可接单的运行节点')
    assert.ok(!runtimeReason.allowedActions.includes('start_conversation'))

    // 4) Runtime 恢复后回到正常（原因为 null）。
    await setRuntimeState('healthy', 'accepting')
    const restored = await onlyAgentMember(workspaceId, ownerId)
    assert.equal(restored.unavailableReason, null)
    assert.ok(restored.allowedActions.includes('start_conversation'))
  } finally {
    await setRuntimeState('healthy', 'accepting')
  }
})

// ---------------------------------------------------------------------------
// 停用与重新启用（含共享授权保留 AC-26）
// ---------------------------------------------------------------------------

test('停用撤销本成员授权来源并写入事件，共享工具授权由另一 Agent 保留（AC-26），新会话被阻止', async () => {
  const workspaceId = 'ws-1a-ag-disable'
  const ownerId = 'user-1a-ag-dis-owner'
  const memberId = 'user-1a-ag-dis-member'
  await createDirectoryUser(ownerId, '停用Agent负责人')
  await createDirectoryUser(memberId, '停用Agent成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  await createTool({ id: 'tool-1a-shared' })
  await createSkill({ id: 'skill-1a-dis-a', toolRefs: ['tool-1a-shared@1.0.0'] })
  await createSkill({ id: 'skill-1a-dis-b', toolRefs: ['tool-1a-shared@1.0.0'] })
  const agentA = await createPublishedAgent({
    id: 'agent-1a-dis-a',
    name: '共享工具Agent甲',
    skillRefs: ['skill-1a-dis-a@1.0.0'],
    toolRefs: ['tool-1a-shared@1.0.0'],
  })
  const agentB = await createPublishedAgent({
    id: 'agent-1a-dis-b',
    name: '共享工具Agent乙',
    skillRefs: ['skill-1a-dis-b@1.0.0'],
    toolRefs: ['tool-1a-shared@1.0.0'],
  })
  const joinA = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId, body: { agentId: agentA.id } })
  assert.equal(joinA.status, 201)
  const wamA = (joinA.body.data as { id: string }).id
  const joinB = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId, body: { agentId: agentB.id } })
  assert.equal(joinB.status, 201)
  const wamB = (joinB.body.data as { id: string }).id
  assert.equal(await revision(workspaceId), 2)

  const result = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamA}`, {
    as: ownerId,
    body: { action: 'disable' },
  })
  assert.equal(result.status, 200)
  assert.equal((result.body.data as { status: string }).status, 'disabled')

  const [wam] = await agentMemberRows(workspaceId)
  assert.equal(wam?.id, wamA)
  assert.equal(wam?.status, 'disabled')

  // A 的 Agent 与 Skill 来源被撤销；共享工具授权仍有 B 的来源。
  const sources = await listSources(workspaceId)
  const sharedToolSources = sources.filter(source => source.capabilityType === 'tool')
  assert.equal(sharedToolSources.length, 2)
  assert.equal(sharedToolSources.filter(source => source.status === 'active').length, 1)
  assert.equal(sharedToolSources.find(source => source.status === 'active')?.sourceRefId, wamB)
  const revokedRefs = sources.filter(source => source.status === 'revoked').map(source => source.sourceRefId)
  assert.deepEqual([...new Set(revokedRefs)], [wamA])

  // 共享工具授权保留（AC-26），A 的 Agent/Skill 授权被清理。
  assert.deepEqual(await listGrants(workspaceId), [
    { capabilityType: 'agent', capabilityVersionId: agentB.versionId },
    { capabilityType: 'skill', capabilityVersionId: 'skill-version-skill-1a-dis-b-1' },
    { capabilityType: 'tool', capabilityVersionId: 'tool-version-tool-1a-shared-1' },
  ])
  assert.equal(await revision(workspaceId), 3)

  const events = await revocationEvents(workspaceId)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event?.userId, wamA, '撤权事件主体是被停用的 Agent 成员；操作人由审计链路记录')
  assert.equal(event?.kind, 'agent_disabled')
  assert.equal(event?.status, 'pending')
  assert.deepEqual(event?.payload, { agentMemberId: wamA, agentId: agentA.id })
  assert.ok(event?.payloadHash && /^[0-9a-f]{32}$/.test(event?.payloadHash ?? ''))

  // 停用后新会话启动被阻止并给出具体原因（TW-02）。
  const start = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '停用后启动', workspaceId, workspaceAgentMemberId: wamA },
  })
  assert.equal(start.status, 409)
  assert.match(errorMessage(start), /不能发起/)

  // B 的会话仍可启动（共享工具授权未被误删）。
  const startB = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '乙仍可用', workspaceId, workspaceAgentMemberId: wamB },
  })
  assert.equal(startB.status, 201)
})

test('重新启用恢复授权来源与有效授权，会话启动恢复；无效状态转换被拒绝', async () => {
  const workspaceId = 'ws-1a-ag-enable'
  const ownerId = 'user-1a-ag-en-owner'
  const memberId = 'user-1a-ag-en-member'
  await createDirectoryUser(ownerId, '启用Agent负责人')
  await createDirectoryUser(memberId, '启用Agent成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  await createTool({ id: 'tool-1a-en' })
  await createSkill({ id: 'skill-1a-en', toolRefs: ['tool-1a-en@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-en',
    name: '启用Agent',
    skillRefs: ['skill-1a-en@1.0.0'],
    toolRefs: ['tool-1a-en@1.0.0'],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId, body: { agentId: agent.id } })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  const disabled = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, { as: ownerId, body: { action: 'disable' } })
  assert.equal(disabled.status, 200)
  assert.deepEqual(await listGrants(workspaceId), [])
  assert.equal((await listSources(workspaceId)).filter(source => source.status === 'active').length, 0)

  const enabled = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, { as: ownerId, body: { action: 'enable' } })
  assert.equal(enabled.status, 200)
  assert.equal((enabled.body.data as { status: string }).status, 'available')
  assert.equal((await listSources(workspaceId)).filter(source => source.status === 'active').length, 3)
  assert.equal((await listGrants(workspaceId)).length, 3)

  const start = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '启用后启动', workspaceId, workspaceAgentMemberId: wamId },
  })
  assert.equal(start.status, 201)
  assert.equal((start.body.data as { agentVersionId: string }).agentVersionId, agent.versionId)

  // 非 disabled 状态不能直接启用；已移出的成员必须重新添加。
  const enableAgain = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, { as: ownerId, body: { action: 'enable' } })
  assert.equal(enableAgain.status, 409)
  assert.match(errorMessage(enableAgain), /已是可用/)

  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, { as: ownerId })
  assert.equal(removed.status, 200)
  const enableRemoved = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, { as: ownerId, body: { action: 'enable' } })
  assert.equal(enableRemoved.status, 409)
  assert.match(errorMessage(enableRemoved), /已移出/)
})

// ---------------------------------------------------------------------------
// 撤权事件去重语义
// ---------------------------------------------------------------------------

test('停用→启用→停用只产生一行 agent_disabled 事件（去重由被撤销对象决定）', async () => {
  const workspaceId = 'ws-1a-ag-dedupe'
  const ownerId = 'user-1a-ag-dd-owner'
  await createDirectoryUser(ownerId, '去重负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-dd' })
  await createSkill({ id: 'skill-1a-dd', toolRefs: ['tool-1a-dd@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-dd',
    name: '去重Agent',
    skillRefs: ['skill-1a-dd@1.0.0'],
    toolRefs: ['tool-1a-dd@1.0.0'],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId, body: { agentId: agent.id } })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id
  const path = `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`

  const disable = () => api('PATCH', path, { as: ownerId, body: { action: 'disable' } })
  const enable = () => api('PATCH', path, { as: ownerId, body: { action: 'enable' } })

  // 两次停用中间启用一次：payload_hash 若含生命周期状态或操作人就会产生多行，
  // 违反「重复生命周期事件只产生一条」的去重语义。
  assert.equal((await disable()).status, 200)
  assert.equal((await enable()).status, 200)
  assert.equal((await disable()).status, 200)

  const events = await revocationEvents(workspaceId)
  const disabledEvents = events.filter(event => event.kind === 'agent_disabled')
  assert.equal(disabledEvents.length, 1, '重复停用只应产生一行事件')
  assert.equal(disabledEvents[0]?.userId, wamId)
  assert.deepEqual(disabledEvents[0]?.payload, { agentMemberId: wamId, agentId: agent.id })
})

// ---------------------------------------------------------------------------
// 事务内角色复核（TOCTOU）
// ---------------------------------------------------------------------------

test('加入 Agent 时若负责人转交发生在前置检查与加锁之间，旧负责人写入被拒绝', async () => {
  const workspaceId = 'ws-1a-ag-lock-role'
  const oldOwnerId = 'user-1a-ag-lock-role-old'
  const newOwnerId = 'user-1a-ag-lock-role-new'
  await createDirectoryUser(oldOwnerId, '转交前负责人')
  await createDirectoryUser(newOwnerId, '转交后负责人')
  await createTeamWorkspace(workspaceId, [
    { userId: oldOwnerId, role: 'owner' },
    { userId: newOwnerId, role: 'admin' },
  ])
  await createTool({ id: 'tool-1a-lockrole' })
  await createSkill({ id: 'skill-1a-lockrole', toolRefs: ['tool-1a-lockrole@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-lockrole',
    name: 'TOCTOU Agent',
    skillRefs: ['skill-1a-lockrole@1.0.0'],
    toolRefs: ['tool-1a-lockrole@1.0.0'],
  })

  // 旧负责人的前置角色检查已通过；在其事务拿到空间锁之后、事务内角色复核之前
  // 提交负责人转交。旧负责人不得再写入成员与授权（P1-4）。
  //
  // 事务内的探针调用顺序固定（与 addAgentMember 一致）：
  //   1) lockWorkspaceRow（select ... for update）
  //   2) 事务内 requireActorRole（select member_role ...）
  // 在第 2 次探针调用前提交转交，即可精确制造「加锁后、复核前」的窗口。
  const originalBegin = database.begin.bind(database)
  let transferred = false
  let probeCalls = 0
  const racingDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'begin') {
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (callback: (transaction: DatabaseTransaction) => Promise<unknown>) => originalBegin(async (transaction) => {
        const probe = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          probeCalls += 1
          if (!transferred && probeCalls === 2) {
            transferred = true
            return transaction.unsafe(
              `update workspace_members set member_role = 'admin'
                where tenant_id = '${tenantId}' and workspace_id = '${workspaceId}' and user_id = '${oldOwnerId}'`,
            ).then(() => transaction.unsafe(
              `update workspace_members set member_role = 'owner'
                where tenant_id = '${tenantId}' and workspace_id = '${workspaceId}' and user_id = '${newOwnerId}'`,
            )).then(() => transaction(strings, ...values))
          }
          return transaction(strings, ...values)
        }) as unknown as DatabaseTransaction
        probe.unsafe = transaction.unsafe.bind(transaction)
        return callback(probe)
      })
    },
  }) as DatabaseClient

  const racingService = new PostgresWorkspaceAgentMemberService(racingDatabase, authorization, agents)
  await assert.rejects(
    racingService.addAgentMember(workspaceId, agent.id, oldOwnerId, ['role-employee']),
    /当前用户角色没有权限执行此操作|当前用户不是该空间的成员/,
    '拿到空间锁后必须复核当前角色',
  )
  assert.equal(transferred, true, '转交应当在事务内角色复核前提交')
  const members = await database<{ id: string }[]>`
    select id from workspace_agent_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
  `
  assert.equal(members.length, 0, '旧负责人不得写入成员关系')
})

test('HTTP：提交负责人不可见的 Agent 返回 403 而不是 500', async () => {
  const workspaceId = 'ws-1a-ag-role-scope-http'
  const ownerId = 'user-1a-ag-role-scope-http-owner'
  await createDirectoryUser(ownerId, '可见范围 HTTP 负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-role-scope-http' })
  await createSkill({ id: 'skill-1a-role-scope-http', toolRefs: ['tool-1a-role-scope-http@1.0.0'] })
  const hidden = await createPublishedAgent({
    id: 'agent-1a-role-scope-http',
    name: '不可见 HTTP Agent',
    roleIds: ['role-platform-admin'],
    skillRefs: ['skill-1a-role-scope-http@1.0.0'],
    toolRefs: ['tool-1a-role-scope-http@1.0.0'],
  })

  const result = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, {
    as: ownerId,
    body: { agentId: hidden.id },
  })
  // 授权拒绝必须走类型化错误映射为 403，不能落到 500。
  assert.equal(result.status, 403)
  assert.equal((result.body.error as { code: string } | undefined)?.code, 'permission_denied')
})

test('加入 Agent 时复核角色可见范围：提交负责人不可见的 Agent 被拒绝', async () => {
  const workspaceId = 'ws-1a-ag-role-scope'
  const ownerId = 'user-1a-ag-role-scope-owner'
  await createDirectoryUser(ownerId, '可见范围负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-role-scope' })
  await createSkill({ id: 'skill-1a-role-scope', toolRefs: ['tool-1a-role-scope@1.0.0'] })
  // 该 Agent 只对平台管理员角色可见，而负责人的会话角色是 role-employee。
  const hidden = await createPublishedAgent({
    id: 'agent-1a-role-scope',
    name: '不可见 Agent',
    roleIds: ['role-platform-admin'],
    skillRefs: ['skill-1a-role-scope@1.0.0'],
    toolRefs: ['tool-1a-role-scope@1.0.0'],
  })

  await assert.rejects(
    agentMembers.addAgentMember(workspaceId, hidden.id, ownerId, ['role-employee']),
    /当前用户角色不可使用所选 Agent/,
    '候选列表只负责展示，写入前必须按添加人角色复核可见范围',
  )
  const members = await database<{ id: string }[]>`
    select id from workspace_agent_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
  `
  assert.equal(members.length, 0, '越权提交不得写入成员关系与授权来源')
  const sources = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
  `
  assert.equal(sources[0]?.count, 0, '越权提交不得写入授权来源')
})

// ---------------------------------------------------------------------------
// 版本升级
// ---------------------------------------------------------------------------

test('升级固定新版本并保留旧版本来源，新会话使用新版本；相同版本升级为空操作', async () => {
  const workspaceId = 'ws-1a-ag-upgrade'
  const ownerId = 'user-1a-ag-up-owner'
  const memberId = 'user-1a-ag-up-member'
  await createDirectoryUser(ownerId, '升级Agent负责人')
  await createDirectoryUser(memberId, '升级Agent成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  await createTool({ id: 'tool-1a-up' })
  await createSkill({ id: 'skill-1a-up', toolRefs: ['tool-1a-up@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-up',
    name: '升级Agent',
    skillRefs: ['skill-1a-up@1.0.0'],
    toolRefs: ['tool-1a-up@1.0.0'],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId, body: { agentId: agent.id } })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  const oldStart = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '升级前会话', workspaceId, workspaceAgentMemberId: wamId },
  })
  assert.equal(oldStart.status, 201)
  assert.equal((oldStart.body.data as { agentVersionId: string }).agentVersionId, agent.versionId)

  // 平台发布新版本。
  const v2Id = await createAgentVersion({
    agentId: agent.id,
    version: '2.0.0',
    skillRefs: ['skill-1a-up@1.0.0'],
    toolRefs: ['tool-1a-up@1.0.0'],
    roleIds: ['role-employee'],
  })

  const upgraded = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, {
    as: ownerId,
    body: { action: 'upgrade' },
  })
  assert.equal(upgraded.status, 200)
  assert.equal((upgraded.body.data as { version: string }).version, '2.0.0')

  const [wam] = await agentMemberRows(workspaceId)
  assert.equal(wam?.agentVersionId, v2Id)

  // 新旧两个 Agent 版本来源均有效；Skill/Tool 来源复用同一行保持有效。
  const agentSources = (await listSources(workspaceId)).filter(source => source.capabilityType === 'agent')
  assert.deepEqual(
    agentSources.map(source => `${source.capabilityVersionId}:${source.status}`).sort(),
    [`${agent.versionId}:active`, `${v2Id}:active`].sort(),
  )
  const grants = await listGrants(workspaceId)
  assert.deepEqual(grants.map(grant => `${grant.capabilityType}|${grant.capabilityVersionId}`).sort(), [
    `agent|${agent.versionId}`,
    `agent|${v2Id}`,
    `skill|skill-version-skill-1a-up-1`,
    `tool|tool-version-tool-1a-up-1`,
  ].sort())
  assert.equal(await revision(workspaceId), 2)
  assert.equal((await revocationEvents(workspaceId)).length, 0)

  // 新会话使用新版本；旧版本来源保留（旧会话继续可执行）。
  const newStart = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '升级后会话', workspaceId, workspaceAgentMemberId: wamId },
  })
  assert.equal(newStart.status, 201)
  assert.equal((newStart.body.data as { agentVersionId: string }).agentVersionId, v2Id)

  // 相同版本再次升级为空操作，不新增来源也不提升修订号。
  const noop = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, {
    as: ownerId,
    body: { action: 'upgrade' },
  })
  assert.equal(noop.status, 200)
  assert.equal((noop.body.data as { version: string }).version, '2.0.0')
  assert.equal(await revision(workspaceId), 2)
  assert.equal((await listSources(workspaceId)).length, 4)
})

// ---------------------------------------------------------------------------
// 移出
// ---------------------------------------------------------------------------

test('移出撤销授权来源并写入 agent_removed 事件，新会话被阻止，历史保留', async () => {
  const workspaceId = 'ws-1a-ag-remove'
  const ownerId = 'user-1a-ag-rm-owner'
  const memberId = 'user-1a-ag-rm-member'
  await createDirectoryUser(ownerId, '移出Agent负责人')
  await createDirectoryUser(memberId, '移出Agent成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  await createTool({ id: 'tool-1a-rm' })
  await createSkill({ id: 'skill-1a-rm', toolRefs: ['tool-1a-rm@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-rm',
    name: '移出Agent',
    skillRefs: ['skill-1a-rm@1.0.0'],
    toolRefs: ['tool-1a-rm@1.0.0'],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId, body: { agentId: agent.id } })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  const removed = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, { as: ownerId })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.body.data, { id: wamId, removed: true })

  const [wam] = await agentMemberRows(workspaceId)
  assert.equal(wam?.id, wamId)
  assert.equal(wam?.status, 'removed')
  assert.equal((await listSources(workspaceId)).filter(source => source.status === 'active').length, 0)
  assert.deepEqual(await listGrants(workspaceId), [])
  assert.equal(await revision(workspaceId), 2)

  const events = await revocationEvents(workspaceId)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event?.userId, wamId, '撤权事件主体是被移出的 Agent 成员；操作人由审计链路记录')
  assert.equal(event?.kind, 'agent_removed')
  assert.deepEqual(event?.payload, { agentMemberId: wamId, agentId: agent.id })

  const start = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '移出后启动', workspaceId, workspaceAgentMemberId: wamId },
  })
  assert.equal(start.status, 409)
  assert.match(errorMessage(start), /不能发起/)

  const removeAgain = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/${wamId}`, { as: ownerId })
  assert.equal(removeAgain.status, 409)
  assert.match(errorMessage(removeAgain), /已移出/)
})

// ---------------------------------------------------------------------------
// 权限边界
// ---------------------------------------------------------------------------

test('管理员与成员不能加入或管理 Agent，非成员不可访问；个人工作空间全部端点被拒绝', async () => {
  const workspaceId = 'ws-1a-ag-perm'
  const ownerId = 'user-1a-ag-perm-owner'
  const adminId = 'user-1a-ag-perm-admin'
  const memberId = 'user-1a-ag-perm-member'
  const outsiderId = 'user-1a-ag-perm-outsider'
  await createDirectoryUser(ownerId, 'Agent权限负责人')
  await createDirectoryUser(adminId, 'Agent权限管理员')
  await createDirectoryUser(memberId, 'Agent权限成员')
  await createDirectoryUser(outsiderId, 'Agent权限非成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
  ])
  await createTool({ id: 'tool-1a-perm' })
  await createSkill({ id: 'skill-1a-perm', toolRefs: ['tool-1a-perm@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-perm',
    name: '权限Agent',
    skillRefs: ['skill-1a-perm@1.0.0'],
    toolRefs: ['tool-1a-perm@1.0.0'],
  })

  const adminJoin = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: adminId, body: { agentId: agent.id } })
  assert.equal(adminJoin.status, 403)
  assert.match(errorMessage(adminJoin), /无权执行/)

  const memberJoin = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: memberId, body: { agentId: agent.id } })
  assert.equal(memberJoin.status, 403)

  const memberPatch = await api('PATCH', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/wam-bogus`, { as: memberId, body: { action: 'disable' } })
  assert.equal(memberPatch.status, 403)

  const memberDelete = await api('DELETE', `/api/workbench/v1/workspaces/${workspaceId}/agent-members/wam-bogus`, { as: memberId })
  assert.equal(memberDelete.status, 403)

  const outsiderList = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: outsiderId })
  assert.equal(outsiderList.status, 403)
  assert.match(errorMessage(outsiderList), /不是成员/)

  assert.equal((await agentMemberRows(workspaceId)).length, 0)

  // 个人工作空间：5 个成员端点全部拒绝，个人空间行为不变。
  const personalWorkspaceId = 'ws-personal-U00001'
  const personalRequests = [
    () => api('GET', `/api/workbench/v1/workspaces/${personalWorkspaceId}/agent-candidates`, { as: 'U00001' }),
    () => api('GET', `/api/workbench/v1/workspaces/${personalWorkspaceId}/agent-members`, { as: 'U00001' }),
    () => api('POST', `/api/workbench/v1/workspaces/${personalWorkspaceId}/agent-members`, { as: 'U00001', body: { agentId: agent.id } }),
    () => api('PATCH', `/api/workbench/v1/workspaces/${personalWorkspaceId}/agent-members/wam-bogus`, { as: 'U00001', body: { action: 'disable' } }),
    () => api('DELETE', `/api/workbench/v1/workspaces/${personalWorkspaceId}/agent-members/wam-bogus`, { as: 'U00001' }),
  ]
  for (const run of personalRequests) {
    const result = await run()
    assert.equal(result.status, 422)
    assert.equal(result.body.error?.code, 'invalid_request')
    assert.match(errorMessage(result), /仅支持团队工作空间/)
  }
})

test('成员变更操作在服务层重新校验负责人角色（TOCTOU）', async () => {
  const workspaceId = 'ws-1a-ag-toctou'
  const ownerId = 'user-1a-ag-toc-owner'
  const demotedAdminId = 'user-1a-ag-toc-admin'
  await createDirectoryUser(ownerId, 'Agent TOCTOU 负责人')
  await createDirectoryUser(demotedAdminId, 'Agent TOCTOU 管理员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: demotedAdminId, role: 'admin' },
  ])
  await createTool({ id: 'tool-1a-toc' })
  await createSkill({ id: 'skill-1a-toc', toolRefs: ['tool-1a-toc@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-toc',
    name: 'TOCTOU Agent',
    skillRefs: ['skill-1a-toc@1.0.0'],
    toolRefs: ['tool-1a-toc@1.0.0'],
  })

  // 守卫通过后被降级为成员：服务层必须重新校验并拒绝。
  await database`
    update workspace_members
       set member_role = 'member'
     where tenant_id = ${tenantId}
       and workspace_id = ${workspaceId}
       and user_id = ${demotedAdminId}
  `
  await assert.rejects(
    agentMembers.addAgentMember(workspaceId, agent.id, demotedAdminId),
    /当前用户角色没有权限执行此操作/,
  )
  assert.equal((await agentMemberRows(workspaceId)).length, 0)
})

// ---------------------------------------------------------------------------
// 团队会话启动
// ---------------------------------------------------------------------------

test('团队空间会话必须通过 Agent 成员关联发起：缺关联、跨空间关联与原始版本不匹配均被拒绝', async () => {
  const workspaceId = 'ws-1a-session-team'
  const otherWorkspaceId = 'ws-1a-session-other'
  const ownerId = 'user-1a-ses-owner'
  const memberId = 'user-1a-ses-member'
  await createDirectoryUser(ownerId, '会话启动负责人')
  await createDirectoryUser(memberId, '会话启动成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  await createTeamWorkspace(otherWorkspaceId, [{ userId: ownerId, role: 'owner' }])
  await createTool({ id: 'tool-1a-ses' })
  await createSkill({ id: 'skill-1a-ses', toolRefs: ['tool-1a-ses@1.0.0'] })
  const agent = await createPublishedAgent({
    id: 'agent-1a-ses',
    name: '会话Agent',
    skillRefs: ['skill-1a-ses@1.0.0'],
    toolRefs: ['tool-1a-ses@1.0.0'],
  })
  const joined = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: ownerId, body: { agentId: agent.id } })
  assert.equal(joined.status, 201)
  const wamId = (joined.body.data as { id: string }).id

  // 平台发布新版本，但成员固定旧版本。
  const v2Id = await createAgentVersion({
    agentId: agent.id,
    version: '2.0.0',
    skillRefs: ['skill-1a-ses@1.0.0'],
    toolRefs: ['tool-1a-ses@1.0.0'],
    roleIds: ['role-employee'],
  })

  // 正常路径：成员通过 wam 关联发起，固定成员版本（不受平台新版本影响）。
  const started = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '团队会话', workspaceId, workspaceAgentMemberId: wamId },
  })
  assert.equal(started.status, 201)
  const session = started.body.data as { id: string; workspaceId: string; agentVersionId: string }
  assert.equal(session.workspaceId, workspaceId)
  assert.equal(session.agentVersionId, agent.versionId)

  // 缺关联字段：拒绝并提示必须通过 Agent 成员关联发起。
  const omitted = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '缺关联', workspaceId },
  })
  assert.equal(omitted.status, 422)
  assert.match(errorMessage(omitted), /团队空间对话必须通过 Agent 成员关联发起/)

  // 携带原始 agentId 解析出的版本（v2）与成员固定版本（v1）不一致：拒绝。
  const rawMismatch = await api('POST', '/api/workbench/v1/sessions', {
    as: memberId,
    body: { title: '原始版本不匹配', workspaceId, workspaceAgentMemberId: wamId, agentId: agent.id },
  })
  assert.equal(rawMismatch.status, 422)
  assert.match(errorMessage(rawMismatch), /团队空间对话必须通过 Agent 成员关联发起/)

  // 跨空间关联：拒绝。
  const crossWorkspace = await api('POST', '/api/workbench/v1/sessions', {
    as: ownerId,
    body: { title: '跨空间关联', workspaceId: otherWorkspaceId, workspaceAgentMemberId: wamId },
  })
  assert.equal(crossWorkspace.status, 404)
  assert.match(errorMessage(crossWorkspace), /不存在或不属于/)

  assert.ok(v2Id)
})

test('个人空间会话启动保持原路径：不需要也不受 workspaceAgentMemberId 影响（AC-23）', async () => {
  const personalWorkspaceId = 'ws-personal-U00001'

  const plain = await api('POST', '/api/workbench/v1/sessions', {
    as: 'U00001',
    body: { title: '个人空间会话', workspaceId: personalWorkspaceId },
  })
  assert.equal(plain.status, 201)
  const plainSession = plain.body.data as { workspaceId: string }
  assert.equal(plainSession.workspaceId, personalWorkspaceId)

  // 个人空间忽略新增字段，按原有路径创建。
  const withWamField = await api('POST', '/api/workbench/v1/sessions', {
    as: 'U00001',
    body: { title: '个人空间会话带多余字段', workspaceId: personalWorkspaceId, workspaceAgentMemberId: 'wam-bogus' },
  })
  assert.equal(withWamField.status, 201)
  assert.equal((withWamField.body.data as { workspaceId: string }).workspaceId, personalWorkspaceId)
})

// ---------------------------------------------------------------------------
// 创建空间自动加入默认 Agent
// ---------------------------------------------------------------------------

test('创建团队空间自动加入默认 Agent 成员并派生 agent_member 授权来源', async () => {
  const ownerId = 'user-auto-default-owner'
  await createDirectoryUser(ownerId, '自动默认负责人')

  const created = await api('POST', '/api/workbench/v1/workspaces', {
    as: ownerId,
    body: { name: '自动默认空间', description: '' },
  })
  assert.equal(created.status, 201)
  const workspace = created.body.data as { id: string }

  const members = await database<AgentMemberRow[]>`
    select id, agent_id as "agentId", agent_version_id as "agentVersionId",
           status, added_by as "addedBy"
      from workspace_agent_members
     where tenant_id = ${tenantId} and workspace_id = ${workspace.id}
  `
  assert.equal(members.length, 1)
  assert.equal(members[0]?.agentId, 'agent-dsh-work-assistant')
  assert.equal(members[0]?.status, 'available')
  assert.equal(members[0]?.addedBy, ownerId)

  const sources = await database<{ capabilityType: string; capabilityVersionId: string; sourceType: string; status: string; sourceRefId: string }[]>`
    select capability_type as "capabilityType", capability_version_id as "capabilityVersionId",
           source_type as "sourceType", status, source_ref_id as "sourceRefId"
      from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspace.id}
  `
  assert.ok(sources.length > 0)
  for (const source of sources) {
    assert.equal(source.sourceType, 'agent_member')
    assert.equal(source.status, 'active')
    assert.equal(source.sourceRefId, members[0]?.id)
  }
  assert.ok(sources.some(source => source.capabilityType === 'agent' && source.capabilityVersionId === members[0]?.agentVersionId))
})

test('默认 Agent 不可加入时空间照常创建且无 Agent 成员', async () => {
  const ownerId = 'user-auto-default-fallback-owner'
  await createDirectoryUser(ownerId, '降级负责人')
  await database`
    update agents set allow_workspace_join = false
     where tenant_id = ${tenantId} and id = 'agent-dsh-work-assistant'
  `
  try {
    const created = await api('POST', '/api/workbench/v1/workspaces', {
      as: ownerId,
      body: { name: '降级空间', description: '' },
    })
    assert.equal(created.status, 201)
    const workspace = created.body.data as { id: string }

    const members = await database<AgentMemberRow[]>`
      select id, agent_id as "agentId", agent_version_id as "agentVersionId",
             status, added_by as "addedBy"
        from workspace_agent_members
       where tenant_id = ${tenantId} and workspace_id = ${workspace.id}
    `
    assert.equal(members.length, 0)
  } finally {
    await database`
      update agents set allow_workspace_join = true
       where tenant_id = ${tenantId} and id = 'agent-dsh-work-assistant'
    `
  }
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

async function createTeamWorkspace(workspaceId: string, members: Array<{ userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>) {
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
  description?: string
  status?: 'published' | 'disabled' | 'draft'
  allowJoin?: boolean
  roleIds?: string[]
  skillRefs?: string[]
  toolRefs?: string[]
  versionStatus?: 'published' | 'draft'
  updatedAtSecondsAgo?: number
}) {
  const status = input.status ?? 'published'
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
      status, active_version_id, allow_workspace_join
    ) values (
      ${input.id}, ${tenantId}, ${input.name ?? 'T4 测试 Agent'}, ${input.description ?? 'T4 Agent 成员集成测试。'},
      '', 'U00008', 'U00008', ${status}, null, ${input.allowJoin ?? true}
    )
  `
  const versionId = status === 'draft'
    ? await createAgentVersion({
        agentId: input.id,
        version: '1.0.0',
        skillRefs: input.skillRefs ?? [],
        toolRefs: input.toolRefs ?? [],
        roleIds: input.roleIds ?? ['role-employee'],
        activate: false,
      })
    : await createAgentVersion({
        agentId: input.id,
        version: '1.0.0',
        skillRefs: input.skillRefs ?? [],
        toolRefs: input.toolRefs ?? [],
        roleIds: input.roleIds ?? ['role-employee'],
        versionStatus: input.versionStatus,
      })
  if (input.updatedAtSecondsAgo !== undefined) {
    await database`
      update agents set updated_at = now() - make_interval(secs => ${input.updatedAtSecondsAgo})
       where tenant_id = ${tenantId} and id = ${input.id}
    `
  }
  return { id: input.id, versionId }
}

async function createAgentVersion(input: {
  agentId: string
  version: string
  skillRefs: string[]
  toolRefs: string[]
  roleIds: string[]
  activate?: boolean
  versionStatus?: 'published' | 'draft'
}) {
  const versionId = `agent-version-${input.agentId}-${input.version.replaceAll('.', '-')}`
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
      timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${input.agentId}, ${input.version}, 'T4 测试 Agent', 'T4 Agent 成员集成测试。',
      '', ${database.json(['测试'] as string[])}, '你是 T4 集成测试 Agent。',
      ${database.json(input.roleIds)}, ${database.json(['enterprise:authorized'] as string[])},
      12000, 300, ${database.json(input.skillRefs)}, ${database.json(input.toolRefs)},
      ${input.versionStatus ?? 'published'}, 'U00008', 'T4 测试版本'
    )
  `
  if (input.activate ?? true) {
    await database`
      update agents set active_version_id = ${versionId}
       where tenant_id = ${tenantId} and id = ${input.agentId}
    `
  }
  return versionId
}

async function createSkill(input: { id: string; toolRefs?: string[] }) {
  const versionId = `skill-version-${input.id}-1`
  await database.begin(async transaction => {
    await transaction`
      insert into skills (
        id, tenant_id, key, name, category, description, owner_user_id, created_by,
        status, active_version_id, draft_version_id
      ) values (
        ${input.id}, ${tenantId}, ${input.id}, 'T4 测试技能', '文件', 'T4 Agent 成员集成测试技能。',
        'U00008', 'U00008', 'published', null, null
      )
    `
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, tool_refs, test_prompt, status, created_by, published_by, published_at,
        change_summary
      ) values (
        ${versionId}, ${tenantId}, ${input.id}, '1.0.0', 'T4 测试技能', '文件',
        'T4 Agent 成员集成测试技能。', '测试说明。', '{}',
        ${transaction.json(input.toolRefs ?? [])}, '测试问题', 'published', 'U00008', 'U00008',
        now(), 'T4 测试'
      )
    `
    await transaction`
      update skills set active_version_id = ${versionId}
       where tenant_id = ${tenantId} and id = ${input.id}
    `
  })
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
        ${input.id}, ${tenantId}, ${`dsh-${input.id}`}, 'T4 测试工具', 'platform', 'available',
        'connector-dsh-workspace', 'DSH Runtime', 'T4 Agent 成员集成测试工具。',
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

function errorMessage(result: { body: { error?: { message: string } } }): string {
  return result.body.error?.message ?? ''
}

async function agentMemberRows(workspaceId: string): Promise<AgentMemberRow[]> {
  const rows = await database<{
    id: string
    agentId: string
    agentVersionId: string
    status: string
    addedBy: string
  }[]>`
    select id, agent_id as "agentId", agent_version_id as "agentVersionId",
           status, added_by as "addedBy"
      from workspace_agent_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by created_at asc, id asc
  `
  return rows.map(row => ({ ...row }))
}

/** 读取唯一 Agent 成员（5-T1 用例的 workspace 只加入一个）。 */
async function onlyAgentMember(
  workspaceId: string,
  actorUserId: string,
): Promise<{ status: string; unavailableReason: string | null; allowedActions: string[] }> {
  const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/agent-members`, { as: actorUserId })
  assert.equal(result.status, 200)
  const items = result.body.data as Array<{ status: string; unavailableReason: string | null; allowedActions: string[] }>
  assert.equal(items.length, 1)
  return items[0]!
}

/** 直接撤销该成员的全部 agent_member 来源，制造「平台未授权」。 */
async function revokeAgentMemberSources(workspaceId: string, memberId: string) {
  await database`
    update workspace_grant_sources set status = 'revoked', revoked_at = now()
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
       and source_type = 'agent_member' and source_ref_id = ${memberId}
  `
}

/** 租户只有一个预置 Runtime；用例结束后必须恢复，避免污染同文件后续用例。 */
async function setRuntimeState(health: 'healthy' | 'degraded' | 'offline', scheduling: 'accepting' | 'draining' | 'disabled') {
  await database`
    update runtimes set health_status = ${health}, scheduling_status = ${scheduling}
     where tenant_id = ${tenantId} and id = 'runtime-local-01'
  `
}

async function listSources(workspaceId: string): Promise<SourceRow[]> {
  const rows = await database<{
    capabilityType: string
    capabilityVersionId: string
    sourceRefId: string | null
    status: string
  }[]>`
    select capability_type as "capabilityType", capability_version_id as "capabilityVersionId",
           source_ref_id as "sourceRefId", status
      from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by capability_type, capability_version_id, created_at
  `
  return rows.map(row => ({ ...row }))
}

async function listGrants(workspaceId: string): Promise<GrantRow[]> {
  const rows = await database<{
    capabilityType: string
    capabilityVersionId: string
  }[]>`
    select capability_type as "capabilityType", capability_version_id as "capabilityVersionId"
      from workspace_capability_grants
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by capability_type, capability_version_id
  `
  return rows.map(row => ({ ...row }))
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
  return rows.map(row => ({ ...row }))
}

class UnusedTestRuntime implements AgentRuntimePort {
  async execute(): Promise<RuntimeExecutionHandle> {
    throw new Error('T4 集成测试不执行 Runtime')
  }

  subscribe(): () => void {
    return () => undefined
  }

  async cancel(): Promise<{ accepted: boolean }> {
    return { accepted: false }
  }

  status(): RuntimeExecutionSnapshot | undefined {
    return undefined
  }

  async health(): Promise<RuntimeHealth> {
    return {
      status: 'healthy',
      runtimeId: 'runtime-local-01',
      activeExecutions: 0,
      acceptingRuns: true,
      dshRepository: '/tmp',
      transport: 'acp-stdio',
      message: 'test',
    }
  }

  async close() {}
}
