import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const migrationsDirectory = resolve(import.meta.dirname, '../../../migrations')

async function copyMigrationsUpTo(maxInclusive: string, targetDir: string) {
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (file <= maxInclusive) {
      await copyFile(resolve(migrationsDirectory, file), join(targetDir, file))
    }
  }
}

async function assertGovernanceSurfaces(database: DatabaseClient) {
  const [tables] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from information_schema.tables
     where table_schema = 'public'
       and table_name in (
         'tools', 'tool_binding_revisions', 'agent_release_submissions',
         'task_delegations', 'mcp_user_grants'
       )
  `
  assert.equal(tables?.count, 5)
  const [visibleRoles] = await database<{ exists: boolean }[]>`
    select exists(
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'agent_versions'
         and column_name = 'visible_role_ids'
    ) as exists
  `
  assert.equal(visibleRoles?.exists, true)
  await assert.rejects(database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values ('tenant-dsh-work', 'ws-supply', 'tool', 'read')
  `, /capability_type_check|violates/)
}

let freshThrowaway: ThrowawayDatabase

before(async () => {
  freshThrowaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_three_way_fresh', maxConnections: 4 })
})

after(async () => {
  await freshThrowaway?.dispose()
})

test('empty database applies the full migration chain through 0116', async () => {
  const versions = await freshThrowaway.client<{ version: string }[]>`
    select version from schema_migrations order by version desc limit 1
  `
  assert.equal(versions[0]?.version, '0116_agent_recommendation.sql')
  const applied = await freshThrowaway.client<{ version: string }[]>`
    select version from schema_migrations where version = '0111_web_push.sql'
  `
  assert.equal(applied[0]?.version, '0111_web_push.sql')
  await assertGovernanceSurfaces(freshThrowaway.client)
})

test('database stopped at 0084 upgrades through hardening and tonycc tail', async () => {
  const baselineDir = await mkdtemp(join(tmpdir(), 'dsh-migrations-0084-'))
  const throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_three_way_0084',
    maxConnections: 4,
    migrate: false,
  })
  try {
    await copyMigrationsUpTo('0084_mcp_user_grants.sql', baselineDir)
    const first = await runMigrations(throwaway.client, baselineDir)
    assert.ok(first.some(row => row.version === '0084_mcp_user_grants.sql' && row.applied))
    const [before] = await throwaway.client<{ version: string }[]>`
      select version from schema_migrations order by version desc limit 1
    `
    assert.equal(before?.version, '0084_mcp_user_grants.sql')
    const second = await runMigrations(throwaway.client, migrationsDirectory)
    assert.ok(second.some(row => row.version === '0111_web_push.sql' && row.applied))
    assert.ok(second.some(row => row.version === '0116_agent_recommendation.sql' && row.applied))
    const [tail] = await throwaway.client<{ version: string }[]>`
      select version from schema_migrations order by version desc limit 1
    `
    assert.equal(tail?.version, '0116_agent_recommendation.sql')
    await assertGovernanceSurfaces(throwaway.client)
  } finally {
    await throwaway.dispose()
    await rm(baselineDir, { recursive: true, force: true })
  }
})

test('legacy 0110_web_push record upgrades through 0111 without recreating tables', async () => {
  const baselineDir = await mkdtemp(join(tmpdir(), 'dsh-migrations-0109-legacy-push-'))
  const throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_three_way_legacy_push',
    maxConnections: 4,
    migrate: false,
  })
  try {
    await copyMigrationsUpTo('0109_agent_principal_role_backfill.sql', baselineDir)
    await runMigrations(throwaway.client, baselineDir)
    const webPushSql = await readFile(resolve(migrationsDirectory, '0111_web_push.sql'), 'utf8')
    await throwaway.client.unsafe(webPushSql)
    await throwaway.client`insert into schema_migrations (version) values ('0110_web_push.sql')`
    await runMigrations(throwaway.client, migrationsDirectory)
    const [webPush] = await throwaway.client<{ version: string }[]>`
      select version from schema_migrations where version = '0111_web_push.sql'
    `
    assert.ok(webPush?.version)
    await assertGovernanceSurfaces(throwaway.client)
  } finally {
    await throwaway.dispose()
    await rm(baselineDir, { recursive: true, force: true })
  }
})

test('hardening midpoint 0088 upgrades without dropping governance tables', async () => {
  const baselineDir = await mkdtemp(join(tmpdir(), 'dsh-migrations-0088-'))
  const throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_three_way_0088',
    maxConnections: 4,
    migrate: false,
  })
  try {
    await copyMigrationsUpTo('0088_automation_archive_metadata.sql', baselineDir)
    await runMigrations(throwaway.client, baselineDir)
    const [mid] = await throwaway.client<{ version: string }[]>`
      select version from schema_migrations order by version desc limit 1
    `
    assert.equal(mid?.version, '0088_automation_archive_metadata.sql')
    await runMigrations(throwaway.client, migrationsDirectory)
    await assertGovernanceSurfaces(throwaway.client)
    const [tail] = await throwaway.client<{ version: string }[]>`
      select version from schema_migrations order by version desc limit 1
    `
    assert.equal(tail?.version, '0116_agent_recommendation.sql')
  } finally {
    await throwaway.dispose()
    await rm(baselineDir, { recursive: true, force: true })
  }
})
