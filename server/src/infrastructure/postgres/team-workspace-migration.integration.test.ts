import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { runMigrations } from './migration-runner.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
const suffix = randomUUID()
const agentId = `agent-1a-${suffix}`
const teamWorkspaceId = `ws-1a-team-${suffix}`
const secondUserId = `user-1a-second-${suffix}`
const personalUserId = `user-1a-personal-${suffix}`
const personalWorkspaceId = `ws-personal-${personalUserId}`

before(async () => {
  // 迁移与回填计数必须跑在一次性库上：共享 dev 库的历史数据会污染 grants/sources
  // 计数，也会让「全新安装」断言失真。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_t1a_migration_test', maxConnections: 4 })
  database = throwaway.client
})

after(async () => {
  await throwaway.dispose()
})

test('0022 applies once and installs the three authorization tables', async () => {
  const results = await runMigrations(database)
  assert.equal(results.every((result) => !result.applied), true)

  const [tables] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('workspace_agent_members', 'workspace_grant_sources', 'workspace_revocation_events')
  `
  assert.equal(tables?.count, 3)

  const [functionRow] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from pg_proc
     where proname = 'assert_team_workspace_single_owner'
  `
  assert.equal(functionRow?.count, 1)

  const [triggerRow] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from pg_trigger
     where tgname = 'team_workspace_single_owner'
       and not tgisinternal
  `
  assert.equal(triggerRow?.count, 1)
})

test('new tables enforce their check constraints', async () => {
  await assert.rejects(
    database`
      insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
      values (${`wam-bad-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'agent-dsh-work-assistant', 'agent-version-dsh-work-assistant-1', 'bogus', 'U00001')
    `,
    /workspace_agent_members_status_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_grant_sources (id, tenant_id, workspace_id, capability_type, capability_version_id, source_type, status, created_by)
      values (${`wgs-bad-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'bogus', 'anything', 'manual', 'active', 'U00001')
    `,
    /workspace_grant_sources_capability_type_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_grant_sources (id, tenant_id, workspace_id, capability_type, capability_version_id, source_type, status, created_by)
      values (${`wgs-bad-source-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'agent', 'agent-version-dsh-work-assistant-1', 'bogus', 'active', 'U00001')
    `,
    /workspace_grant_sources_source_type_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_grant_sources (id, tenant_id, workspace_id, capability_type, capability_version_id, source_type, status, created_by)
      values (${`wgs-bad-status-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'agent', 'agent-version-dsh-work-assistant-1', 'manual', 'bogus', 'U00001')
    `,
    /workspace_grant_sources_status_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload_hash)
      values (${`wre-bad-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'bogus', 'hash')
    `,
    /workspace_revocation_events_kind_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload_hash, status)
      values (${`wre-bad-status-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'member_removed', 'hash', 'bogus')
    `,
    /workspace_revocation_events_status_check/,
  )
})

test('allow_workspace_join defaults to true and team_auth_revision defaults to 0', async () => {
  await database`
    insert into agents (id, tenant_id, name, description, owner_user_id, created_by, status)
    values (${agentId}, 'tenant-dsh-work', '1A 授权测试 Agent', '验证默认允许加入团队空间', 'U00001', 'U00001', 'published')
  `
  const [agent] = await database<{ allowWorkspaceJoin: boolean }[]>`
    select allow_workspace_join as "allowWorkspaceJoin" from agents where id = ${agentId}
  `
  assert.equal(agent?.allowWorkspaceJoin, true)

  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${teamWorkspaceId}, 'tenant-dsh-work', '1A 团队空间', '', 'team', 'U00001', 'active')
  `
  const [workspace] = await database<{ teamAuthRevision: number }[]>`
    select team_auth_revision as "teamAuthRevision" from workspaces where id = ${teamWorkspaceId}
  `
  assert.equal(workspace?.teamAuthRevision, 0)

  await database`
    update workspaces set team_auth_revision = team_auth_revision + 1 where id = ${teamWorkspaceId}
  `
  const [bumped] = await database<{ teamAuthRevision: number }[]>`
    select team_auth_revision as "teamAuthRevision" from workspaces where id = ${teamWorkspaceId}
  `
  assert.equal(bumped?.teamAuthRevision, 1)
})

test('team workspace keeps exactly one owner at commit', async () => {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status)
    values (${secondUserId}, 'tenant-dsh-work', ${`bootstrap:${secondUserId}`}, '1A 第二成员', 'active')
  `

  // First owner insert succeeds.
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values ('tenant-dsh-work', ${teamWorkspaceId}, 'U00001', 'owner', 'U00001')
  `

  // A second owner is rejected when the transaction commits.
  await assert.rejects(
    database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values ('tenant-dsh-work', ${teamWorkspaceId}, ${secondUserId}, 'owner', 'U00001')
    `,
    /exactly one owner/,
  )

  // Non-owner roles are fine.
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values ('tenant-dsh-work', ${teamWorkspaceId}, ${secondUserId}, 'member', 'U00001')
  `

  // Promoting a member to a second owner is rejected as well.
  await assert.rejects(
    database`
      update workspace_members
         set member_role = 'owner'
       where tenant_id = 'tenant-dsh-work'
         and workspace_id = ${teamWorkspaceId}
         and user_id = ${secondUserId}
    `,
    /exactly one owner/,
  )

  // Removing the sole owner is rejected, leaving the owner row intact.
  await assert.rejects(
    database`
      delete from workspace_members
       where tenant_id = 'tenant-dsh-work'
         and workspace_id = ${teamWorkspaceId}
         and user_id = 'U00001'
    `,
    /exactly one owner/,
  )

  const [owners] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${teamWorkspaceId}
       and member_role = 'owner'
  `
  assert.equal(owners?.count, 1)

  const [members] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${teamWorkspaceId}
  `
  assert.equal(members?.count, 2)
})

test('personal workspace memberships are untouched by the team owner trigger', async () => {
  // Creating an active user provisions their personal workspace via the 0013 triggers;
  // the deferred team trigger fires on that membership write too and must skip it.
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status)
    values (${personalUserId}, 'tenant-dsh-work', ${`bootstrap:${personalUserId}`}, '1A 个人空间用户', 'active')
  `

  const [workspace] = await database<{ id: string; workspaceType: string }[]>`
    select id, workspace_type as "workspaceType"
      from workspaces
     where id = ${personalWorkspaceId}
  `
  assert.equal(workspace?.workspaceType, 'personal')

  const [owners] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${personalWorkspaceId}
       and user_id = ${personalUserId}
       and member_role = 'owner'
  `
  assert.equal(owners?.count, 1)

  // A no-op update fires both membership triggers; the team trigger must skip personal rows.
  await database`
    update workspace_members
       set joined_at = joined_at
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${personalWorkspaceId}
  `

  // The 0013 guard still governs personal rows: removing the owner fails with its own message.
  await assert.rejects(
    database`
      delete from workspace_members
       where tenant_id = 'tenant-dsh-work'
         and workspace_id = ${personalWorkspaceId}
         and user_id = ${personalUserId}
    `,
    /personal workspace owner membership cannot be removed/,
  )
})

test('legacy capability grants are backfilled with legacy_unresolved sources', async () => {
  const rows = await database<{
    id: string
    capabilityType: string
    capabilityVersionId: string
    sourceType: string
    sourceRefId: string | null
    status: string
    createdBy: string
  }[]>`
    select s.id,
           s.capability_type as "capabilityType",
           s.capability_version_id as "capabilityVersionId",
           s.source_type as "sourceType",
           s.source_ref_id as "sourceRefId",
           s.status,
           s.created_by as "createdBy"
      from workspace_grant_sources s
     where s.tenant_id = 'tenant-dsh-work'
       and s.workspace_id = 'ws-supply'
       and s.capability_type = 'agent'
       and s.capability_version_id = 'agent-version-dsh-work-assistant-1'
  `
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.equal(row.id, 'wgs-legacy-tenant-dsh-work-ws-supply-agent-agent-version-dsh-work-assistant-1')
  assert.equal(row.sourceType, 'legacy_unresolved')
  assert.equal(row.sourceRefId, null)
  assert.equal(row.status, 'active')
  assert.equal(row.createdBy, 'U00001')

  // Every seeded grant has exactly one matching legacy source.
  const [counts] = await database<{ grants: number; sources: number }[]>`
    select (select count(*)::integer from workspace_capability_grants g
             where g.tenant_id = 'tenant-dsh-work') as grants,
           (select count(*)::integer from workspace_grant_sources s
             where s.tenant_id = 'tenant-dsh-work'
               and s.source_type = 'legacy_unresolved') as sources
  `
  assert.equal(counts?.grants, counts?.sources)
})

test('revocation events dedupe on (workspace_id, user_id, kind, payload_hash)', async () => {
  const payloadHash = `md5-${suffix}`
  await database`
    insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload, payload_hash)
    values (${`wre-${suffix}-1`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'member_removed', '{"role":"member"}'::jsonb, ${payloadHash})
  `

  const [created] = await database<{ status: string; attempts: number; payload: Record<string, unknown> }[]>`
    select status, attempts, payload
      from workspace_revocation_events
     where id = ${`wre-${suffix}-1`}
  `
  assert.equal(created?.status, 'pending')
  assert.equal(created?.attempts, 0)
  assert.deepEqual(created?.payload, { role: 'member' })

  await assert.rejects(
    database`
      insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload, payload_hash)
      values (${`wre-${suffix}-2`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'member_removed', '{"role":"member"}'::jsonb, ${payloadHash})
    `,
    /workspace_revocation_events_dedupe/,
  )

  // Same tuple with a different payload hash is a distinct event.
  await database`
    insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload, payload_hash)
    values (${`wre-${suffix}-3`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'member_removed', '{"role":"owner"}'::jsonb, ${`md5-${suffix}-other`})
  `
})

test('moving a sole owner to another team workspace is rejected at commit', async () => {
  const secondTeamWorkspaceId = `ws-1a-team-b-${suffix}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${secondTeamWorkspaceId}, 'tenant-dsh-work', '1A 团队空间 B', '', 'team', 'U00001', 'active')
  `

  // Cross-workspace move of the sole owner must leave the old team workspace with an owner.
  await assert.rejects(
    database`
      update workspace_members
         set workspace_id = ${secondTeamWorkspaceId}
       where tenant_id = 'tenant-dsh-work'
         and workspace_id = ${teamWorkspaceId}
         and user_id = 'U00001'
    `,
    /exactly one owner/,
  )

  const [owners] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${teamWorkspaceId}
       and member_role = 'owner'
  `
  assert.equal(owners?.count, 1)
})

test('moving a team membership into a personal workspace hits the 0013 guard', async () => {
  // The 0013 personal guard fires first (before-trigger) and rejects the move;
  // the team side keeps its owner.
  await assert.rejects(
    database`
      update workspace_members
         set workspace_id = ${personalWorkspaceId}
       where tenant_id = 'tenant-dsh-work'
         and workspace_id = ${teamWorkspaceId}
         and user_id = 'U00001'
    `,
    /personal workspace can only contain its owner/,
  )

  const [owners] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${teamWorkspaceId}
       and member_role = 'owner'
  `
  assert.equal(owners?.count, 1)
})

test('0086 adds sequenced notification deliveries and non-negative read watermarks', async () => {
  const [sequenceColumn] = await database<{ isNullable: string }[]>`
    select is_nullable as "isNullable"
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'workspace_activity_events'
       and column_name = 'sequence'
  `
  assert.equal(sequenceColumn?.isNullable, 'NO')

  const [deliveryFk] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from information_schema.table_constraints
     where table_schema = 'public'
       and table_name = 'workspace_notification_deliveries'
       and constraint_type = 'FOREIGN KEY'
  `
  assert.ok((deliveryFk?.count ?? 0) >= 1)

  await assert.rejects(
    database`
      insert into workspace_notification_account_states (tenant_id, user_id, last_read_sequence)
      values ('tenant-dsh-work', 'U00001', -1)
    `,
    /workspace_notification_account_states_last_read_sequence_check/,
  )
})

test('记录决策：0013 守卫不校验 personal→team 移动后的旧个人空间（1A 不修）', async () => {
  // 交接文档 §5 遗留观察：protect_personal_workspace_membership 只看 NEW.workspace_id，
  // 因此把个人空间唯一 owner 的成员行移动到团队空间时，旧个人空间不会被校验，也不会被
  // 阻止。核实结论：该路径当前可被直接的 UPDATE 触发，导致个人空间失去 owner 成员行。
  //
  // 决策（1A-T7）：本批次不修。理由：plan 6.4 明确「不改写个人空间已有唯一索引、成员
  // 保护触发器和创建者规则」，AC-23/AC-27 要求个人空间零改动；此路径无任何 API 入口，
  // 属潜在数据完整性缺口而非可利用越权。建议后续批次用独立迁移扩展 0013 守卫（在
  // UPDATE 时同时校验 OLD 个人空间）；本测试固定当前行为，修复时需同步更新。
  const targetTeamWorkspaceId = `ws-1a-team-personal-move-${suffix}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${targetTeamWorkspaceId}, 'tenant-dsh-work', '1A 个人空间迁移目标', '', 'team', 'U00001', 'active')
  `

  await database`
    update workspace_members
       set workspace_id = ${targetTeamWorkspaceId}
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${personalWorkspaceId}
       and user_id = ${personalUserId}
  `

  const [oldPersonalMembers] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${personalWorkspaceId}
  `
  assert.equal(oldPersonalMembers?.count, 0, '当前行为：旧个人空间失去 owner 成员行（已知缺口，见上述决策）')

  const [targetOwners] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${targetTeamWorkspaceId}
       and member_role = 'owner'
  `
  assert.equal(targetOwners?.count, 1)

  // 个人空间唯一索引与空间记录本身不受该移动影响。
  const [personalWorkspace] = await database<{ id: string }[]>`
    select id from workspaces
     where tenant_id = 'tenant-dsh-work' and id = ${personalWorkspaceId}
  `
  assert.equal(personalWorkspace?.id, personalWorkspaceId)
})
