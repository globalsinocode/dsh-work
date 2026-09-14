import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { inspectPersonalWorkspaceBaseline } from './team-workspace-upgrade-baseline.ts'

const tenantId = 'tenant-dsh-work'
const suffix = randomUUID().replaceAll('-', '')
const migrationsDirectory = resolve(import.meta.dirname, '../../../migrations')
const upgradeTeamWorkspaceId = `ws-t7-upgrade-${suffix}`
const personalSessionId = `session-t7-personal-${suffix}`
const personalFileId = `file-t7-personal-${suffix}`
const personalArtifactId = `artifact-t7-personal-${suffix}`
const personalWorkspaceId = 'ws-personal-U00001'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let baselineMigrationsDirectory = ''
let preUpgradeSnapshot: Snapshot

interface Snapshot {
  grantCount: number
  agentGrantCount: number
  sourceCount: number
  personalSessions: number
  personalFiles: number
  personalArtifacts: number
  personalWorkspaceIds: string[]
}

before(async () => {
  // 迁移链 0001~0021 的副本目录：用于构造「已有数据、0022 尚未应用」的升级场景。
  baselineMigrationsDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-migrations-'))
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (file < '0022') await copyFile(resolve(migrationsDirectory, file), resolve(baselineMigrationsDirectory, file))
  }

  // 一次性升级库：只应用 0001~0021 基线，随后由用例驱动 0022 升级/回滚。
  throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_t1a_upgrade_test',
    maxConnections: 4,
    migrate: false,
  })
  database = throwaway.client
  await runMigrations(database, baselineMigrationsDirectory)
  await seedPreUpgradeData()
  // 升级前 0022 尚未应用：只读取 0022 之前就存在的表。
  preUpgradeSnapshot = { ...(await baseSnapshot()), sourceCount: 0 }
})

after(async () => {
  await throwaway.dispose()
  if (baselineMigrationsDirectory) await rm(baselineMigrationsDirectory, { recursive: true, force: true })
})

test('已有数据升级：0022 回填 legacy 来源并保持个人空间业务记录不变（AC-17/AC-27）', async () => {
  const results = await runMigrations(database)
  const applied = results.filter(result => result.applied).map(result => result.version)
  assert.ok(applied.includes('0022_team_workspace_authorization.sql'))
  // 升级只应应用 0022 及其之后的迁移，0001~0021 已存在于目标环境。
  assert.equal(applied.some(version => version < '0022'), false)

  // 每条既有 grant 恰好回填一条 legacy_unresolved 来源（确定性 id）。
  const [counts] = await database<{ grants: number, sources: number, legacy: number }[]>`
    select (select count(*)::integer from workspace_capability_grants
             where tenant_id = ${tenantId}) as grants,
           (select count(*)::integer from workspace_grant_sources
             where tenant_id = ${tenantId}) as sources,
           (select count(*)::integer from workspace_grant_sources
             where tenant_id = ${tenantId} and source_type = 'legacy_unresolved') as legacy
  `
  assert.equal(counts?.grants, preUpgradeSnapshot.grantCount)
  assert.equal(counts?.sources, preUpgradeSnapshot.grantCount)
  assert.equal(counts?.legacy, preUpgradeSnapshot.grantCount)

  const [upgradeSource] = await database<{ id: string, sourceRefId: string | null, status: string, createdBy: string }[]>`
    select id, source_ref_id as "sourceRefId", status, created_by as "createdBy"
      from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${upgradeTeamWorkspaceId}
       and capability_type = 'agent'
       and capability_version_id = 'agent-version-dsh-work-assistant-1'
  `
  assert.equal(
    upgradeSource?.id,
    `wgs-legacy-${tenantId}-${upgradeTeamWorkspaceId}-agent-agent-version-dsh-work-assistant-1`,
  )
  assert.equal(upgradeSource?.sourceRefId, null, '来源不明的存量授权不能猜测为某个 Agent 所有')
  assert.equal(upgradeSource?.status, 'active')

  // 新列默认值：allow_workspace_join 默认允许加入，team_auth_revision 默认 0。
  const [agentDefaults] = await database<{ total: number, joinable: number }[]>`
    select count(*)::integer as total,
           count(*) filter (where allow_workspace_join)::integer as joinable
      from agents where tenant_id = ${tenantId}
  `
  assert.ok((agentDefaults?.total ?? 0) > 0)
  assert.equal(agentDefaults?.joinable, agentDefaults?.total)
  const [revision] = await database<{ revision: number }[]>`
    select team_auth_revision as revision from workspaces
     where tenant_id = ${tenantId} and id = ${upgradeTeamWorkspaceId}
  `
  assert.equal(revision?.revision, 0)

  // 个人空间业务记录、保护触发器和唯一索引不被团队迁移改写。
  const after = await snapshot()
  assert.deepEqual(after.personalWorkspaceIds, preUpgradeSnapshot.personalWorkspaceIds)
  assert.equal(after.personalSessions, preUpgradeSnapshot.personalSessions)
  assert.equal(after.personalFiles, preUpgradeSnapshot.personalFiles)
  assert.equal(after.personalArtifacts, preUpgradeSnapshot.personalArtifacts)

  const baseline = await inspectPersonalWorkspaceBaseline(database)
  assert.equal(baseline.uniqueIndexPresent, true)
  assert.equal(baseline.activeOnlyConstraintPresent, true)
  assert.deepEqual(baseline.missingNotNullColumns, [])
  assert.deepEqual(baseline.missingGuardTriggers, [])

  // 不批量公开历史内容：会话归属不变，且没有新增有效授权。
  const [workspaceOfSession] = await database<{ workspaceId: string }[]>`
    select workspace_id as "workspaceId" from sessions
     where tenant_id = ${tenantId} and id = ${personalSessionId}
  `
  assert.equal(workspaceOfSession?.workspaceId, personalWorkspaceId)
})

test('重复运行 0022 不重复回填，也不改变已有来源（幂等）', async () => {
  const results = await runMigrations(database)
  assert.equal(results.every(result => !result.applied), true)
  const after = await snapshot()
  assert.equal(after.sourceCount, preUpgradeSnapshot.grantCount)
  assert.equal(after.grantCount, preUpgradeSnapshot.grantCount)
})

test('回滚兼容：删除 0022 对象后旧结构与个人数据完整，重新升级可复现相同对账清单', async () => {
  const beforeRollback = await snapshot()
  await database.unsafe(`
    drop trigger if exists team_workspace_single_owner on workspace_members;
    drop function if exists assert_team_workspace_single_owner();
    drop index if exists model_usage_by_attempt;
    drop index if exists runs_active_by_tenant;
    drop table if exists workspace_notification_states;
    drop table if exists workspace_activity_events;
    drop table if exists workspace_file_versions;
    drop table if exists workspace_files;
    drop table if exists workspace_revocation_events;
    drop table if exists workspace_grant_sources;
    drop table if exists workspace_agent_members;
    alter table agents drop column if exists allow_workspace_join;
    alter table workspaces drop column if exists team_auth_revision;
    delete from schema_migrations where version in (
      '0022_team_workspace_authorization.sql',
      '0023_revocation_event_dead_letter.sql',
      '0025_workspace_file_versions.sql',
      '0026_workspace_activity.sql',
      '0028_runs_and_usage_indexes.sql'
    );
  `)

  // 只回滚本用例覆盖的附加对象；后续管理会话等迁移保持已应用，避免把它们的
  // schema_migrations 记录删除后在未回滚对应结构的情况下重复执行。
  const oldSchema = await baseSnapshot()
  assert.equal(oldSchema.grantCount, beforeRollback.grantCount)
  assert.equal(oldSchema.personalSessions, beforeRollback.personalSessions)
  assert.equal(oldSchema.personalFiles, beforeRollback.personalFiles)
  assert.equal(oldSchema.personalArtifacts, beforeRollback.personalArtifacts)

  const results = await runMigrations(database)
  const reappliedVersions = results.filter(result => result.applied).map(result => result.version)
  assert.ok(reappliedVersions.includes('0022_team_workspace_authorization.sql'))
  assert.ok(
    reappliedVersions.includes('0025_workspace_file_versions.sql'),
    '0025 是纯新增迁移，回滚后必须能被重放',
  )
  assert.ok(
    reappliedVersions.includes('0026_workspace_activity.sql'),
    '0026（团队动态与通知，纯新增）必须能被重放',
  )
  assert.ok(
    reappliedVersions.includes('0028_runs_and_usage_indexes.sql'),
    '0028（runs 活动索引与每 attempt 唯一索引，纯新增）必须能被重放',
  )
  assert.equal(reappliedVersions.some(version => version < '0022'), false)
  // 动态与通知状态两张表在重放后必须回来（0026 不依赖任何既有表结构变更）。
  const [activityTables] = await database<{ activity: string | null; notifications: string | null }[]>`
    select to_regclass('public.workspace_activity_events')::text as activity,
           to_regclass('public.workspace_notification_states')::text as notifications
  `
  assert.equal(activityTables?.activity, 'workspace_activity_events')
  assert.equal(activityTables?.notifications, 'workspace_notification_states')
  // 0028 的两个索引在重放后必须回来（纯新增，不依赖任何既有表结构变更）。
  const [usageIndexes] = await database<{ runsActive: string | null; usageByAttempt: string | null }[]>`
    select to_regclass('public.runs_active_by_tenant')::text as "runsActive",
           to_regclass('public.model_usage_by_attempt')::text as "usageByAttempt"
  `
  assert.equal(usageIndexes?.runsActive, 'runs_active_by_tenant')
  assert.equal(usageIndexes?.usageByAttempt, 'model_usage_by_attempt')
  const reapplied = await snapshot()
  assert.equal(reapplied.grantCount, beforeRollback.grantCount)
  assert.equal(reapplied.sourceCount, beforeRollback.sourceCount, '重新升级必须复现相同的 legacy 对账清单')
  assert.equal(reapplied.personalSessions, beforeRollback.personalSessions)
})

test('0013 个人空间基线缺失时停止 0022 升级，修复后重试成功（AC-27）', async () => {
  const preflightThrowaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_t1a_preflight_test',
    maxConnections: 2,
    migrate: false,
  })
  const preflightDatabase = preflightThrowaway.client
  try {
    await runMigrations(preflightDatabase, baselineMigrationsDirectory)
    // 破坏基线：删除唯一索引并放开空间非空约束。
    await preflightDatabase.unsafe('drop index one_personal_workspace_per_user')
    await preflightDatabase.unsafe('alter table sessions alter column workspace_id drop not null')

    await assert.rejects(
      runMigrations(preflightDatabase),
      /0013 个人空间数据基线不完整[\s\S]*已停止 0022 团队工作空间升级/,
    )
    const [pending] = await preflightDatabase<{ count: number }[]>`
      select count(*)::integer as count from schema_migrations
       where version = '0022_team_workspace_authorization.sql'
    `
    assert.equal(pending?.count, 0, '升级前置检查失败时不得写入 schema_migrations')
    const [column] = await preflightDatabase<{ count: number }[]>`
      select count(*)::integer as count from information_schema.columns
       where table_schema = 'public' and table_name = 'agents' and column_name = 'allow_workspace_join'
    `
    assert.equal(column?.count, 0, '升级前置检查失败时不得产生半个 0022')

    // 修复 0013 基线后重试成功。
    await preflightDatabase.unsafe(`
      create unique index one_personal_workspace_per_user
        on workspaces (tenant_id, created_by) where workspace_type = 'personal';
      alter table sessions alter column workspace_id set not null;
    `)
    const results = await runMigrations(preflightDatabase)
    const applied = results.filter(result => result.applied).map(result => result.version)
    assert.ok(applied.includes('0022_team_workspace_authorization.sql'))
    assert.equal(applied.some(version => version < '0022'), false)
    const baseline = await inspectPersonalWorkspaceBaseline(preflightDatabase)
    assert.equal(baseline.uniqueIndexPresent, true)
    assert.deepEqual(baseline.missingNotNullColumns, [])
  } finally {
    await preflightThrowaway.dispose()
  }
})

async function seedPreUpgradeData() {
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${upgradeTeamWorkspaceId}, ${tenantId}, 'T7 升级团队空间', '', 'team', 'U00001', 'active')
  `
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${upgradeTeamWorkspaceId}, 'U00001', 'owner', 'U00001')
  `
  // 升级前已存在的有效授权（迁移会各回填一条 legacy_unresolved 来源）。
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values
      (${tenantId}, ${upgradeTeamWorkspaceId}, 'agent', 'agent-version-dsh-work-assistant-1'),
      (${tenantId}, ${upgradeTeamWorkspaceId}, 'skill', 'skill-version-document-1'),
      (${tenantId}, ${upgradeTeamWorkspaceId}, 'tool', 'tool-version-read-1')
    on conflict do nothing
  `
  // 个人空间的业务记录：升级不得改写其归属。
  await database`
    insert into sessions (
      id, tenant_id, workspace_id, created_by, agent_version_id, title, status
    ) values (
      ${personalSessionId}, ${tenantId}, ${personalWorkspaceId}, 'U00001',
      'agent-version-dsh-work-assistant-1', 'T7 个人空间会话', 'active'
    )
  `
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name,
      mime_type, size_bytes, sha256, scan_status, uploaded_by
    ) values (
      ${personalFileId}, ${tenantId}, ${personalWorkspaceId}, ${personalSessionId},
      ${`t7/${personalFileId}`}, 'T7 个人文件.txt', 'text/plain', 12, ${'a'.repeat(64)}, 'clean', 'U00001'
    )
  `
  await database`
    insert into artifacts (
      id, tenant_id, workspace_id, session_id, name, artifact_type, created_by
    ) values (
      ${personalArtifactId}, ${tenantId}, ${personalWorkspaceId}, ${personalSessionId},
      'T7 个人成果', 'report', 'U00001'
    )
  `
}

async function snapshot(): Promise<Snapshot> {
  const base = await baseSnapshot()
  const [sources] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources where tenant_id = ${tenantId}
  `
  return { ...base, sourceCount: sources?.count ?? 0 }
}

/**
 * 只依赖 0022 之前就存在的表；回滚场景（0022 对象已删除）也能安全读取。
 */
async function baseSnapshot(): Promise<Omit<Snapshot, 'sourceCount'>> {
  const [grants] = await database<{ count: number, agentCount: number }[]>`
    select count(*)::integer as count,
           count(*) filter (where capability_type = 'agent')::integer as "agentCount"
      from workspace_capability_grants where tenant_id = ${tenantId}
  `
  const [personal] = await database<{ sessions: number, files: number, artifacts: number }[]>`
    select (select count(*)::integer from sessions s
              join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
             where s.tenant_id = ${tenantId} and w.workspace_type = 'personal') as sessions,
           (select count(*)::integer from file_objects f
              join workspaces w on w.tenant_id = f.tenant_id and w.id = f.workspace_id
             where f.tenant_id = ${tenantId} and w.workspace_type = 'personal') as files,
           (select count(*)::integer from artifacts a
              join workspaces w on w.tenant_id = a.tenant_id and w.id = a.workspace_id
             where a.tenant_id = ${tenantId} and w.workspace_type = 'personal') as artifacts
  `
  const workspaceRows = await database<{ id: string }[]>`
    select id from workspaces
     where tenant_id = ${tenantId} and workspace_type = 'personal' order by id
  `
  return {
    grantCount: grants?.count ?? 0,
    agentGrantCount: grants?.agentCount ?? 0,
    personalSessions: personal?.sessions ?? 0,
    personalFiles: personal?.files ?? 0,
    personalArtifacts: personal?.artifacts ?? 0,
    personalWorkspaceIds: workspaceRows.map(row => row.id),
  }
}
