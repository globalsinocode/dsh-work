import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { canReadWorkspaceObject, AuthorizationDeniedError, isAuthorizationDenial } from '../../modules/authorization/authorization-errors.ts'
import { PostgresWorkspaceGrantSourceService } from '../../modules/authorization/postgres-workspace-grant-source-service.ts'
import { classifyHttpError } from '../../http/router.ts'
import { createDatabase, type DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const suffix = randomUUID()

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let authorization: PostgresAuthorizationService
let grantSources: PostgresWorkspaceGrantSourceService
let agents: PostgresAgentService
/** 套件自身的测试库 URL；并发用例的第二个会话必须连同一个库。 */
let testDatabaseUrl = ''

before(async () => {
  // 一次性库：共享 dev 库的历史数据会让「候选列表」「种子 grants」等全量断言失真。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_t1a_auth_test', maxConnections: 4 })
  database = throwaway.client
  testDatabaseUrl = throwaway.url
  authorization = new PostgresAuthorizationService(database)
  grantSources = new PostgresWorkspaceGrantSourceService()
  agents = new PostgresAgentService(database)
})

after(async () => {
  await throwaway.dispose()
})

// ---------------------------------------------------------------------------
// 1. requireTeamRole
// ---------------------------------------------------------------------------

test('requireTeamRole enforces team member roles and rejects non-members', async () => {
  const workspaceId = `ws-t2-role-${suffix}`
  const ownerId = `user-t2-owner-${suffix}`
  const adminId = `user-t2-admin-${suffix}`
  const memberId = `user-t2-member-${suffix}`
  const viewerId = `user-t2-viewer-${suffix}`
  const outsiderId = `user-t2-outsider-${suffix}`
  await createUser(ownerId, 'T2 负责人')
  await createUser(adminId, 'T2 管理员')
  await createUser(memberId, 'T2 成员')
  await createUser(viewerId, 'T2 只读成员')
  await createUser(outsiderId, 'T2 非成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])

  // Owner passes owner-only and wider role sets.
  await authorization.requireTeamRole(workspaceId, ownerId, ['owner'])
  await authorization.requireTeamRole(workspaceId, ownerId, ['owner', 'admin', 'member', 'viewer'])

  // Member fails owner-only roles.
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, memberId, ['owner']),
    /无权执行/,
  )
  // Member passes member/viewer roles.
  await authorization.requireTeamRole(workspaceId, memberId, ['member', 'viewer'])

  // Admin passes admin roles, fails owner-only roles.
  await authorization.requireTeamRole(workspaceId, adminId, ['owner', 'admin'])
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, adminId, ['owner']),
    /无权执行/,
  )

  // Viewer rejected where not allowed, allowed where listed.
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, viewerId, ['owner', 'admin', 'member']),
    /无权执行/,
  )
  await authorization.requireTeamRole(workspaceId, viewerId, ['viewer'])

  // Non-member rejected with the existing membership wording.
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, outsiderId, ['owner', 'admin', 'member', 'viewer']),
    /不是成员/,
  )

  // Unknown workspace rejected with the existing membership wording.
  await assert.rejects(
    authorization.requireTeamRole(`ws-t2-missing-${suffix}`, ownerId, ['owner']),
    /不是成员/,
  )
})

test('requireTeamRole is a no-op for personal workspaces', async () => {
  const personalWorkspaceId = 'ws-personal-U00001'
  // The personal space owner passes.
  await authorization.requireTeamRole(personalWorkspaceId, 'U00001', ['owner'])
  // Team role checks are skipped entirely for personal spaces: even a user
  // who is not the personal space owner is not subjected to a role check.
  await authorization.requireTeamRole(personalWorkspaceId, 'U00008', ['owner'])
})

test('requireTeamRole keeps rejecting archived team workspaces for the execution track', async () => {
  const workspaceId = `ws-t2-archived-${suffix}`
  const ownerId = `user-t2-archived-owner-${suffix}`
  await createUser(ownerId, 'T2 归档空间负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await archiveWorkspace(workspaceId)
  // Execution track (the default): even the owner is rejected, because the
  // status predicate excludes archived rows. 3-T1 kept this default and made
  // the read track opt-in instead, so an execution caller that forgets to
  // decide stays fail-closed.
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, ownerId, ['owner']),
    /不是成员/,
  )
})

test('requireTeamRole allows archived team workspaces only with the explicit read purpose', async () => {
  const workspaceId = `ws-t2-archived-read-${suffix}`
  const ownerId = `user-t2-archived-read-owner-${suffix}`
  const memberId = `user-t2-archived-read-member-${suffix}`
  const viewerId = `user-t2-archived-read-viewer-${suffix}`
  const outsiderId = `user-t2-archived-read-outsider-${suffix}`
  await createUser(ownerId, 'T2 归档读取负责人')
  await createUser(memberId, 'T2 归档读取成员')
  await createUser(viewerId, 'T2 归档读取只读')
  await createUser(outsiderId, 'T2 归档读取非成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  await archiveWorkspace(workspaceId)

  // Read purpose: every CURRENT member passes, including the read-only role
  // and the owner (归档=只读保留).
  for (const userId of [ownerId, memberId, viewerId]) {
    await authorization.requireTeamRole(workspaceId, userId, ['owner', 'admin', 'member', 'viewer'], {
      purpose: 'read',
    })
  }

  // Role sets still apply on the read track: a member is not an owner.
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, memberId, ['owner'], { purpose: 'read' }),
    /无权执行/,
  )

  // Non-members are denied with the same non-enumerable wording as "missing".
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, outsiderId, ['owner', 'admin', 'member', 'viewer'], {
      purpose: 'read',
    }),
    /不是成员/,
  )
  // An unknown workspace is denied on the read track too.
  await assert.rejects(
    authorization.requireTeamRole(`ws-t2-archived-read-missing-${suffix}`, ownerId, ['owner'], {
      purpose: 'read',
    }),
    /不是成员/,
  )
})

test('归档后默认（执行）轨不得被归档前预热的授权缓存放行（3-T1 缓存状态轨）', async () => {
  const suffix = randomUUID().slice(0, 8)
  const ws = `ws-t1-cache-warm-${suffix}`
  const ownerId = `${ws}-owner`
  await createUser(ownerId, '缓存状态轨负责人')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }])

  // 归档前在**同一实例**上把读取轨授权预热（读取轨允许归档，且授权与状态无关）。
  await authorization.authorizeTeamReadAccess(ws, ownerId, { allowArchived: true, ttlMs: 60_000 })

  await database`
    update workspaces set status = 'archived' where tenant_id = ${tenantId} and id = ${ws}
  `

  // 默认（执行）轨：缓存键虽含状态轨，但若修订号查询不过滤 status，预热条目仍会放行。
  // 必须拒绝——这正是验证代理 D3 指出「旧断言不具鉴别力」的地方。
  await assert.rejects(
    authorization.authorizeTeamReadAccess(ws, ownerId),
    /不存在、已归档或当前用户不可用/,
    '归档后默认执行轨不得被归档前的预热缓存放行',
  )
  // 读取轨仍应放行（归档 = 只读保留）。
  await authorization.authorizeTeamReadAccess(ws, ownerId, { allowArchived: true })
})

test('readableWorkspaceTypeOf resolves archived workspaces while workspaceTypeOf stays active-only', async () => {
  const workspaceId = `ws-t2-type-${suffix}`
  const ownerId = `user-t2-type-owner-${suffix}`
  await createUser(ownerId, 'T2 类型负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  assert.equal(await authorization.workspaceTypeOf(workspaceId), 'team')
  assert.equal(await authorization.readableWorkspaceTypeOf(workspaceId), 'team')

  await archiveWorkspace(workspaceId)
  // Execution-track resolver keeps treating archived as absent (fail-closed).
  assert.equal(await authorization.workspaceTypeOf(workspaceId), null)
  // Status-agnostic read-track resolver still recognises the team workspace.
  assert.equal(await authorization.readableWorkspaceTypeOf(workspaceId), 'team')
  assert.equal(await authorization.readableWorkspaceTypeOf(`ws-t2-type-missing-${suffix}`), null)
  assert.equal(await authorization.readableWorkspaceTypeOf(null), null)
})

test('authorizeTeamReadAccess allows archived workspaces only for current members', async () => {
  const workspaceId = `ws-t2-read-access-${suffix}`
  const ownerId = `user-t2-read-access-owner-${suffix}`
  const memberId = `user-t2-read-access-member-${suffix}`
  const outsiderId = `user-t2-read-access-outsider-${suffix}`
  await createUser(ownerId, 'T2 读门禁负责人')
  await createUser(memberId, 'T2 读门禁成员')
  await createUser(outsiderId, 'T2 读门禁非成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  await archiveWorkspace(workspaceId)

  // Archived read access is opt-in and allows current members.
  await authorization.authorizeTeamReadAccess(workspaceId, ownerId, { allowArchived: true })
  await authorization.authorizeTeamReadAccess(workspaceId, memberId, { allowArchived: true })

  // The default (no option) stays active-only so a write path cannot follow.
  await assert.rejects(
    authorization.authorizeTeamReadAccess(workspaceId, ownerId),
    /不存在/,
  )
  // Non-members and unknown workspaces deny with the same non-enumerable
  // wording as "missing" (either the workspace row is absent or membership is).
  await assert.rejects(
    authorization.authorizeTeamReadAccess(workspaceId, outsiderId, { allowArchived: true }),
    /不存在|不是成员/,
  )
  await assert.rejects(
    authorization.authorizeTeamReadAccess(`ws-t2-read-access-missing-${suffix}`, ownerId, { allowArchived: true }),
    /不存在|不是成员/,
  )
})

// ---------------------------------------------------------------------------
// 1b. canReadWorkspaceObject (shared read gate, 3-T1 dual track)
// ---------------------------------------------------------------------------

test('canReadWorkspaceObject is archive-permissive for current members and still fails closed otherwise', async () => {
  const workspaceId = `ws-t2-read-gate-${suffix}`
  const ownerId = `user-t2-read-gate-owner-${suffix}`
  const memberId = `user-t2-read-gate-member-${suffix}`
  const removedId = `user-t2-read-gate-removed-${suffix}`
  await createUser(ownerId, 'T2 读门禁负责人')
  await createUser(memberId, 'T2 读门禁现任成员')
  await createUser(removedId, 'T2 读门禁被移出成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: removedId, role: 'member' },
  ])
  await database`
    delete from workspace_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${removedId}
  `
  assert.equal(await canReadWorkspaceObject(authorization, workspaceId, memberId), true)

  await archiveWorkspace(workspaceId)
  // 归档=只读保留：archived + current member (incl. owner) may read.
  assert.equal(await canReadWorkspaceObject(authorization, workspaceId, ownerId), true)
  assert.equal(await canReadWorkspaceObject(authorization, workspaceId, memberId), true)
  // Removed members and unknown workspaces still fail closed.
  assert.equal(await canReadWorkspaceObject(authorization, workspaceId, removedId), false)
  assert.equal(await canReadWorkspaceObject(authorization, `ws-t2-read-gate-missing-${suffix}`, ownerId), false)
  // Personal workspaces keep the existing open path (AC-23), and a null
  // workspace is not a team object.
  assert.equal(await canReadWorkspaceObject(authorization, 'ws-personal-U00001', 'U00001'), true)
  assert.equal(await canReadWorkspaceObject(authorization, null, ownerId), true)
})

// ---------------------------------------------------------------------------
// 2. resolveWorkspaceOwner
// ---------------------------------------------------------------------------

test('resolveWorkspaceOwner returns the single owner', async () => {
  const workspaceId = `ws-t2-owner-${suffix}`
  const ownerId = `user-t2-owner-single-${suffix}`
  await createUser(ownerId, 'T2 负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  assert.equal(await authorization.resolveWorkspaceOwner(workspaceId), ownerId)
})

test('resolveWorkspaceOwner throws when the workspace has no owner', async () => {
  const workspaceId = `ws-t2-ownerless-${suffix}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'T2 无负责人空间', '', 'team', 'U00001', 'active')
  `
  await assert.rejects(
    authorization.resolveWorkspaceOwner(workspaceId),
    /负责人/,
  )
})

test('resolveWorkspaceOwner throws when two owners exist (trigger bypassed via SQL)', async () => {
  const workspaceId = `ws-t2-two-owners-${suffix}`
  const firstOwnerId = `user-t2-two-a-${suffix}`
  const secondOwnerId = `user-t2-two-b-${suffix}`
  await createUser(firstOwnerId, 'T2 负责人甲')
  await createUser(secondOwnerId, 'T2 负责人乙')
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'T2 双负责人空间', '', 'team', 'U00001', 'active')
  `
  try {
    await insertOwnersBypassingTrigger(workspaceId, [firstOwnerId, secondOwnerId])
    await assert.rejects(
      authorization.resolveWorkspaceOwner(workspaceId),
      /负责人/,
    )
  } finally {
    await removeWorkspaceBypassingTrigger(workspaceId)
  }
})

// ---------------------------------------------------------------------------
// 3. Grant source sync
// ---------------------------------------------------------------------------

test('addGrantSources syncs the effective grant set and is idempotent per agent member source', async () => {
  const workspaceId = `ws-t2-grant-${suffix}`
  const memberRefA = `wam-t2-a-${suffix}`
  const memberRefB = `wam-t2-b-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])

  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefB, createdBy: 'U00001' },
      { capabilityType: 'skill', capabilityVersionId: 'skill-version-document-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
    ], workspaceId)
  })

  // Effective grants contain exactly the union of the added tuples.
  const grants = await listGrants(workspaceId)
  assert.deepEqual(grants, [
    { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1' },
    { capabilityType: 'skill', capabilityVersionId: 'skill-version-document-1' },
  ])

  // Three active sources were recorded.
  assert.equal(await countSources(workspaceId), 3)
  assert.equal(await revisionOf(workspaceId), 1)

  // Re-adding the same agent_member source tuple is idempotent (partial unique index).
  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
    ], workspaceId)
  })
  assert.equal(await countSources(workspaceId), 3)
  assert.deepEqual(await listGrants(workspaceId), grants)
  assert.equal(await revisionOf(workspaceId), 2)
})

test('revokeGrantSourcesByRef keeps grants with remaining active sources and deletes the rest', async () => {
  const workspaceId = `ws-t2-revoke-${suffix}`
  const memberRefA = `wam-t2-a-${suffix}`
  const memberRefB = `wam-t2-b-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])

  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefB, createdBy: 'U00001' },
      { capabilityType: 'skill', capabilityVersionId: 'skill-version-document-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
    ], workspaceId)
  })

  // Revoke one of two sources for the agent tuple: the grant must remain (AC-26).
  await database.begin(async transaction => {
    await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefB)
  })
  assert.deepEqual(await listGrants(workspaceId), [
    { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1' },
    { capabilityType: 'skill', capabilityVersionId: 'skill-version-document-1' },
  ])
  const [revoked] = await database<{ status: string; revokedAt: Date | null }[]>`
    select status, revoked_at as "revokedAt" from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
       and source_ref_id = ${memberRefB}
  `
  assert.equal(revoked?.status, 'revoked')
  assert.ok(revoked?.revokedAt)
  assert.equal(await revisionOf(workspaceId), 2)

  // Revoke the last source for each tuple: grants are deleted.
  await database.begin(async transaction => {
    await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefA)
  })
  assert.deepEqual(await listGrants(workspaceId), [])
  assert.equal(await countActiveSources(workspaceId), 0)
  assert.equal(await revisionOf(workspaceId), 3)
})

test('re-adding an agent_member source after revocation reactivates the same row instead of silently skipping it', async () => {
  const workspaceId = `ws-t2-reactivate-${suffix}`
  const memberRefA = `wam-t2-reactivate-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])

  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
    ], workspaceId)
  })
  assert.equal(await countSources(workspaceId), 1)
  assert.deepEqual(await listGrants(workspaceId), [
    { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1' },
  ])

  // Revoke: the source row is marked revoked and the grant is deleted.
  await database.begin(async transaction => {
    await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefA)
  })
  assert.equal(await countActiveSources(workspaceId), 0)
  assert.deepEqual(await listGrants(workspaceId), [])

  // Re-add the same sourceRefId + tuple (disable→enable / remove→re-add flows
  // reuse the reference). The revoked provenance row must be reactivated, not
  // silently skipped by the partial unique index — otherwise the recreated
  // grant would have zero active sources and die on the next revoke sweep.
  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
    ], workspaceId)
  })

  // Exactly one source row exists (no duplicate) and it is active again.
  const rows = await database<{ status: string; revokedAt: Date | null }[]>`
    select status, revoked_at as "revokedAt" from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
       and source_ref_id = ${memberRefA}
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.status, 'active')
  assert.equal(rows[0]?.revokedAt, null)
  assert.equal(await countActiveSources(workspaceId), 1)
  assert.deepEqual(await listGrants(workspaceId), [
    { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1' },
  ])

  // Revoke again: the grant must be deleted this time too.
  await database.begin(async transaction => {
    await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefA)
  })
  assert.deepEqual(await listGrants(workspaceId), [])
  assert.equal(await countActiveSources(workspaceId), 0)
})

test('addGrantSources rejects agent_member sources without a sourceRefId', async () => {
  const workspaceId = `ws-t2-no-ref-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])
  await assert.rejects(
    database.begin(async transaction => {
      await grantSources.addGrantSources(transaction, [
        { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', createdBy: 'U00001' },
      ], workspaceId)
    }),
    /sourceRefId/,
  )
})

test('concurrent revokes of different sources serialize per workspace and never orphan a grant', async () => {
  const workspaceId = `ws-t2-concurrent-${suffix}`
  const memberRefA = `wam-t2-conc-a-${suffix}`
  const memberRefB = `wam-t2-conc-b-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])
  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefB, createdBy: 'U00001' },
    ], workspaceId)
  })

  // Two independent sessions revoke the two sources of the same tuple
  // concurrently. A barrier ensures both transactions are open before either
  // revoke runs, so the update-then-sweep sequences interleave exactly like
  // the reported write-skew race.
  const secondSession = createDatabase({ url: testDatabaseUrl, maxConnections: 2 })
  try {
    const arrived = new Set<string>()
    let release: () => void = () => undefined
    const barrier = new Promise<void>(resolve => { release = resolve })
    const enter = async (session: string) => {
      arrived.add(session)
      if (arrived.size === 2) release()
      await Promise.race([
        barrier,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`并发会话 ${session} 等待对方启动超时`)), 10_000)
        }),
      ])
    }
    await Promise.all([
      database.begin(async transaction => {
        await enter('sessionA')
        await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefA)
      }),
      secondSession.begin(async transaction => {
        await enter('sessionB')
        await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefB)
      }),
    ])
  } finally {
    await secondSession.end()
  }

  // The workspace-row lock serializes the two transactions, so the second
  // revoke's sweep sees the first's committed revoke: no orphan grant with
  // zero active sources may survive.
  assert.deepEqual(await listGrants(workspaceId), [])
  assert.equal(await countActiveSources(workspaceId), 0)
  const [revoked] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
       and status = 'revoked'
  `
  assert.equal(revoked?.count, 2)
})

test('listGrantSources groups active sources by capability and includes legacy sources', async () => {
  // The seeded ws-supply grants were backfilled with legacy_unresolved sources by migration 0022.
  await database.begin(async transaction => {
    const groups = await grantSources.listGrantSources(transaction, 'ws-supply')
    assert.equal(groups.length, 3)
    for (const group of groups) {
      assert.equal(group.sources.length, 1)
      assert.equal(group.sources[0]?.sourceType, 'legacy_unresolved')
      assert.equal(group.sources[0]?.sourceRefId, null)
    }
  })

  const workspaceId = `ws-t2-list-${suffix}`
  const memberRefA = `wam-t2-a-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])
  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'manual', createdBy: 'U00008' },
    ], workspaceId)
  })

  await database.begin(async transaction => {
    const groups = await grantSources.listGrantSources(transaction, workspaceId)
    assert.equal(groups.length, 1)
    const [group] = groups
    assert.equal(group?.capabilityType, 'agent')
    assert.equal(group?.capabilityVersionId, 'agent-version-dsh-work-assistant-1')
    assert.deepEqual(
      group?.sources.map(source => source.sourceType).sort(),
      ['agent_member', 'manual'],
    )
  })

  // After revoking the agent member source, only the manual source remains active.
  await database.begin(async transaction => {
    await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefA)
    const groups = await grantSources.listGrantSources(transaction, workspaceId)
    assert.equal(groups.length, 1)
    assert.deepEqual(
      groups[0]?.sources.map(source => source.sourceType),
      ['manual'],
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Agent candidate filtering for team spaces
// ---------------------------------------------------------------------------

test('listWorkspaceAgentCandidates filters by publish state, join allowance, visible roles and membership', async () => {
  const workspaceId = `ws-t2-cand-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])

  // Snapshot of the personal list before candidates are created.
  const personalListBefore = (await agents.listWorkbenchAgents('U00001')).map(agent => agent.id)

  const joinable = await createCandidateAgent({ id: `agent-t2-joinable-${suffix}`, status: 'published', allowJoin: true, roleIds: ['role-employee'] })
  const disabled = await createCandidateAgent({ id: `agent-t2-disabled-${suffix}`, status: 'disabled', allowJoin: true, roleIds: ['role-employee'] })
  const draft = await createCandidateAgent({ id: `agent-t2-draft-${suffix}`, status: 'draft', allowJoin: true, roleIds: ['role-employee'] })
  const notAllowed = await createCandidateAgent({ id: `agent-t2-not-allowed-${suffix}`, status: 'published', allowJoin: false, roleIds: ['role-employee'] })
  const wrongRole = await createCandidateAgent({ id: `agent-t2-wrong-role-${suffix}`, status: 'published', allowJoin: true, roleIds: ['role-platform-admin'] })
  const joined = await createCandidateAgent({ id: `agent-t2-joined-${suffix}`, status: 'published', allowJoin: true, roleIds: ['role-employee'], memberStatus: 'available', workspaceId })
  const removedMember = await createCandidateAgent({ id: `agent-t2-removed-${suffix}`, status: 'published', allowJoin: true, roleIds: ['role-employee'], memberStatus: 'removed', workspaceId })

  const candidates = await agents.listWorkspaceAgentCandidates(workspaceId, 'U00001')
  const ids = candidates.map(candidate => candidate.id)

  assert.ok(ids.includes(joinable.id))
  assert.ok(ids.includes('agent-dsh-work-assistant'), 'seeded published joinable agent is a candidate')
  assert.ok(ids.includes(removedMember.id), 'a removed membership no longer blocks the picker')
  assert.ok(!ids.includes(disabled.id))
  assert.ok(!ids.includes(draft.id))
  assert.ok(!ids.includes(notAllowed.id))
  assert.ok(!ids.includes(wrongRole.id))
  assert.ok(!ids.includes(joined.id))

  const candidate = candidates.find(item => item.id === joinable.id)
  assert.deepEqual(candidate?.activeVersion, {
    id: joinable.versionId,
    version: '1.0.0',
    status: 'published',
  })

  // Session-provided roles resolve the same way listWorkbenchAgents does:
  // the platform-admin-visible candidate and the seeded assistant both match.
  const sessionCandidates = await agents.listWorkspaceAgentCandidates(workspaceId, 'U00001', ['role-platform-admin'])
  assert.deepEqual(
    sessionCandidates.map(item => item.id).sort(),
    [wrongRole.id, 'agent-dsh-work-assistant'].sort(),
  )

  // The personal-space list path is untouched: every previously listed agent is still listed.
  const personalListAfter = (await agents.listWorkbenchAgents('U00001')).map(agent => agent.id)
  for (const id of personalListBefore) assert.ok(personalListAfter.includes(id))
})

// ---------------------------------------------------------------------------
// 5-T4 授权拒绝类型化（去按文案分类）
// ---------------------------------------------------------------------------

/**
 * 5-T4：授权服务内这五处拒绝原先抛裸 `Error`，HTTP 层靠中文消息正则才落 403。
 * 类型化后状态码与 code 必须逐条不变（仍是 403 / permission_denied），文案也保持
 * 原样——本用例把「消息 → 状态/code」的对照关系锁死，防止有人靠改文案分类。
 */
test('5-T4 授权拒绝类型化：消息不变，HTTP 仍是 403 permission_denied', async () => {
  // 1）缺少 workbench:use：没有任何角色的员工。
  const bareUserId = `user-t2-typed-bare-${suffix}`
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status)
    values (${bareUserId}, ${tenantId}, ${`bootstrap:${bareUserId}`}, 'T2 无角色员工', 'active')
  `
  await expectTypedDenial(
    'authorizeWorkbench 缺少 workbench:use',
    '当前用户没有员工工作台使用权限',
    () => authorization.authorizeWorkbench({ userId: bareUserId }),
  )

  // 2）平台管理员校验（原先靠「不是平台管理员」文案落 403）。
  await expectTypedDenial(
    'requirePlatformAdmin',
    `操作人不存在、已停用或不是平台管理员：${bareUserId}`,
    () => authorization.requirePlatformAdmin(bareUserId),
  )

  // 3）角色不可调用工具：临时把只读工具收紧到平台管理员角色。
  const [toolBefore] = await database<{ allowedRoleIds: string[] }[]>`
    select allowed_role_ids as "allowedRoleIds" from tools
     where tenant_id = ${tenantId} and id = 'read'
  `
  await database`
    update tools set allowed_role_ids = '["role-platform-admin"]'::jsonb
     where tenant_id = ${tenantId} and id = 'read'
  `
  try {
    await expectTypedDenial(
      'resolveAndAuthorizeTools',
      '当前用户角色不可调用工具：read@1.0.0',
      () => authorization.authorizeRuntime({
        userId: 'U00001',
        agentVersionId: 'agent-version-dsh-work-assistant-1',
      }),
    )
  } finally {
    await database`
      update tools set allowed_role_ids = ${database.json(toolBefore?.allowedRoleIds ?? ['role-employee', 'role-platform-admin'])}
       where tenant_id = ${tenantId} and id = 'read'
    `
  }

  // 4）空间已配置能力授权，但不含本次请求的 Agent 版本。
  const workspaceId = `ws-t2-typed-cap-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, ${workspaceId}, 'agent', 'agent-version-t2-other')
  `
  await expectTypedDenial(
    'requireWorkspaceCapabilities',
    '工作空间未授权Agent：agent-version-dsh-work-assistant-1',
    () => authorization.authorizeRuntime({
      userId: 'U00001',
      workspaceId,
      agentVersionId: 'agent-version-dsh-work-assistant-1',
    }),
  )

  // 5）数据范围未授权（原先靠「未授权」文案落 403）。
  await database`
    delete from data_scope_grants
     where tenant_id = ${tenantId} and id = 'grant-role-employee-workspace'
  `
  try {
    await expectTypedDenial(
      'requireScopes',
      'Agent要求未授权的数据范围：workspace:authorized',
      () => authorization.authorizeRuntime({
        userId: 'U00001',
        agentVersionId: 'agent-version-dsh-work-assistant-1',
      }),
    )
  } finally {
    await database`
      insert into data_scope_grants (id, tenant_id, subject_type, subject_id, scope_code, scope_value)
      values ('grant-role-employee-workspace', ${tenantId}, 'role', 'role-employee', 'capability', 'workspace:authorized')
      on conflict do nothing
    `
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createUser(id: string, displayName: string) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status)
    values (${id}, ${tenantId}, ${`bootstrap:${id}`}, ${displayName}, 'active')
  `
  // 读门禁用例要过 authorizeWorkbench 的 workbench:use 检查，因此本人测试用户
  // 需要员工角色（该文件其余用例只查 requireTeamRole，不依赖平台权限）。
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local')
    on conflict do nothing
  `
}

async function createTeamWorkspace(workspaceId: string, members: Array<{ userId: string; role: string }>) {
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'T2 测试团队空间', '', 'team', 'U00001', 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, 'U00001')
    `
  }
}

/** 3-T2 的归档 API 尚未实现；测试按既有约定直接用 SQL 落归档态。 */
async function archiveWorkspace(workspaceId: string) {
  await database`
    update workspaces set status = 'archived', archived_at = now()
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
}

async function insertOwnersBypassingTrigger(workspaceId: string, ownerIds: string[]) {
  await database.unsafe('alter table workspace_members disable trigger team_workspace_single_owner')
  try {
    await database.begin(async transaction => {
      for (const ownerId of ownerIds) {
        await transaction`
          insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
          values (${tenantId}, ${workspaceId}, ${ownerId}, 'owner', 'U00001')
        `
      }
    })
  } finally {
    await database.unsafe('alter table workspace_members enable trigger team_workspace_single_owner')
  }
}

async function removeWorkspaceBypassingTrigger(workspaceId: string) {
  await database.unsafe('alter table workspace_members disable trigger team_workspace_single_owner')
  try {
    await database.begin(async transaction => {
      await transaction`
        delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
      `
      await transaction`
        delete from workspaces where tenant_id = ${tenantId} and id = ${workspaceId}
      `
    })
  } finally {
    await database.unsafe('alter table workspace_members enable trigger team_workspace_single_owner')
  }
}

async function listGrants(workspaceId: string) {
  const rows = await database<{ capabilityType: string; capabilityVersionId: string }[]>`
    select capability_type as "capabilityType", capability_version_id as "capabilityVersionId"
      from workspace_capability_grants
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by capability_type, capability_version_id
  `
  return rows.map(row => ({
    capabilityType: row.capabilityType,
    capabilityVersionId: row.capabilityVersionId,
  }))
}

async function countSources(workspaceId: string) {
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
  `
  return row?.count ?? 0
}

async function countActiveSources(workspaceId: string) {
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and status = 'active'
  `
  return row?.count ?? 0
}

async function revisionOf(workspaceId: string) {
  const [row] = await database<{ teamAuthRevision: number }[]>`
    select team_auth_revision as "teamAuthRevision" from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
  return row?.teamAuthRevision ?? 0
}

async function createCandidateAgent(input: {
  id: string
  status: 'published' | 'disabled' | 'draft'
  allowJoin: boolean
  roleIds: string[]
  memberStatus?: 'available' | 'removed'
  workspaceId?: string
}) {
  const versionId = `agent-version-${input.id}`
  const versionStatus = input.status === 'draft' ? 'draft' : 'published'
  await database.begin(async transaction => {
    await transaction`
      insert into agents (
        id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
        status, active_version_id, allow_workspace_join
      ) values (
        ${input.id}, ${tenantId}, '候选测试 Agent', '用于验证团队空间 Agent 候选过滤。', '',
        'U00001', 'U00001', ${input.status}, null, ${input.allowJoin}
      )
    `
    await transaction`
      insert into agent_versions (
        id, tenant_id, agent_id, version, name, description, welcome_message,
        example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
        timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
      ) values (
        ${versionId}, ${tenantId}, ${input.id}, '1.0.0', '候选测试 Agent', '用于验证团队空间 Agent 候选过滤。',
        '', ${transaction.json(['测试'] as string[])}, '你是候选测试 Agent。',
        ${transaction.json(input.roleIds)}, ${transaction.json(['enterprise:authorized'] as string[])},
        12000, 300, ${transaction.json([] as string[])}, ${transaction.json([] as string[])},
        ${versionStatus}, 'U00001', '候选过滤测试'
      )
    `
    if (input.status !== 'draft') {
      await transaction`
        update agents set active_version_id = ${versionId}
         where tenant_id = ${tenantId} and id = ${input.id}
      `
    }
  })
  if (input.memberStatus && input.workspaceId) {
    await database`
      insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
      values (${`wam-${input.id}`}, ${tenantId}, ${input.workspaceId}, ${input.id}, ${versionId}, ${input.memberStatus}, 'U00001')
    `
  }
  return { id: input.id, versionId }
}

/**
 * 断言一个拒绝已经是**类型化授权拒绝**，且消息不变、HTTP 映射仍是 403 permission_denied。
 * `classifyHttpError` 对类型化错误走 status/code 分支、对裸 Error 走文案正则，两者都必须给出
 * 403——这正是「去文案分类」要保证的可观察行为不变。
 */
async function expectTypedDenial(label: string, message: string, run: () => Promise<unknown>) {
  const error = await run().then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof AuthorizationDeniedError, `${label} 必须是类型化授权拒绝，实际：${String(error)}`)
  assert.equal(error.status, 403, `${label} 状态码不得变化`)
  assert.equal(error.code, 'permission_denied', `${label} code 不得变化`)
  assert.equal(error.message, message, `${label} 文案不得变化`)
  assert.equal(isAuthorizationDenial(error), true, `${label} 必须仍被撤权分类器识别`)
  const mapped = classifyHttpError(error, '/api/workbench/v1/workspaces/ws-t2-typed/agents')
  assert.equal(mapped.status, 403)
  assert.equal(mapped.error.code, 'permission_denied')
}

/** 最小可用的已发布 Agent 版本 + 空间级 agent 授权（无 skill/tool 依赖）。 */
async function seedAuthorizableAgent(workspaceId: string, versionId: string, visibleRoleIds: string[] = ['role-employee']) {
  const agentId = `${versionId}-agent`
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
      status, active_version_id, allow_workspace_join
    ) values (
      ${agentId}, ${tenantId}, '5-T4 测试 Agent', '5-T4 类型化拒绝用例。', '',
      'U00008', 'U00008', 'published', null, true
    )
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
      timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${agentId}, '1.0.0', '5-T4 测试 Agent', '5-T4 用例版本。', '',
      ${database.json([] as string[])}, '你是 5-T4 测试 Agent。',
      ${database.json(visibleRoleIds)}, ${database.json(['enterprise:authorized'] as string[])},
      12000, 300, ${database.json([] as string[])}, ${database.json([] as string[])},
      'published', 'U00008', '5-T4 测试版本'
    )
  `
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, ${workspaceId}, 'agent', ${versionId})
    on conflict do nothing
  `
}

test('5-T4 后续：三处原先落 500/409 的授权拒绝已类型化为 403（消息不变）', async () => {
  // 1）Agent 可见范围不含调用者角色：原分类无正则命中 → 500 operation_failed。
  const roleScopeVersion = `agent-version-t4-rolescope-${suffix}`
  const roleScopeWorkspace = `ws-t4-rolescope-${suffix}`
  // U00001/U00002 由基础种子迁移创建，不要重复插入（会撞主键）。
  await createTeamWorkspace(roleScopeWorkspace, [{ userId: 'U00001', role: 'owner' }])
  await seedAuthorizableAgent(roleScopeWorkspace, roleScopeVersion, ['role-platform-admin'])
  await expectTypedDenial(
    'authorizeRuntime 角色不在 Agent 可见范围',
    '当前用户角色不可使用所选 Agent',
    () => authorization.authorizeRuntime({
      userId: 'U00001',
      workspaceId: roleScopeWorkspace,
      agentVersionId: roleScopeVersion,
    }),
  )

  // 2）空间完全没有能力授权：原「未配置…授权」文案不匹配任何授权正则 → 500。
  const noGrantWorkspace = `ws-t4-nogrant-${suffix}`
  await createTeamWorkspace(noGrantWorkspace, [{ userId: 'U00001', role: 'owner' }])
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
      status, active_version_id, allow_workspace_join
    ) values (
      ${`${noGrantWorkspace}-agent`}, ${tenantId}, '5-T4 无授权 Agent', '5-T4 用例。', '',
      'U00008', 'U00008', 'published', null, true
    )
  `
  const noGrantVersion = `${noGrantWorkspace}-version`
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
      timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${noGrantVersion}, ${tenantId}, ${`${noGrantWorkspace}-agent`}, '1.0.0', '5-T4 无授权 Agent', '5-T4 用例。', '',
      ${database.json([] as string[])}, '你是 5-T4 测试 Agent。',
      ${database.json(['role-employee'] as string[])}, ${database.json(['enterprise:authorized'] as string[])},
      12000, 300, ${database.json([] as string[])}, ${database.json([] as string[])},
      'published', 'U00008', '5-T4 测试版本'
    )
  `
  await expectTypedDenial(
    'requireWorkspaceCapabilities 未配置授权',
    '工作空间未配置Agent授权',
    () => authorization.authorizeRuntime({
      userId: 'U00001',
      workspaceId: noGrantWorkspace,
      agentVersionId: noGrantVersion,
    }),
  )

  // 3）只读成员的执行前复核：原分类先命中「不能」→ 409 state_conflict，语义上是无权限。
  const viewerWorkspace = `ws-t4-viewer-${suffix}`
  const viewerVersion = `${viewerWorkspace}-version`
  const viewerUserId = `user-t4-viewer-${suffix}`
  await createUser(viewerUserId, 'T4 只读成员')
  await createTeamWorkspace(viewerWorkspace, [
    { userId: 'U00001', role: 'owner' },
    { userId: viewerUserId, role: 'viewer' },
  ])
  await seedAuthorizableAgent(viewerWorkspace, viewerVersion)
  await expectTypedDenial(
    'authorizeTeamRunExecution 只读成员',
    '当前用户角色为只读，不能继续执行任务',
    () => authorization.authorizeTeamRunExecution({
      userId: viewerUserId,
      workspaceId: viewerWorkspace,
      agentVersionId: viewerVersion,
    }),
  )

  // 说明：`authorizeTeamRunExecution` 里「成员在读两次之间被移除」的那条（原 500）只能在竞态窗口
  // 触发，无法在集成用例里稳定构造；它与上面第 3 条同处一个方法、同一改造方式，故未单独构造。
})
