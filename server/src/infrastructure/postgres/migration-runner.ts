import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { DatabaseClient } from './database.ts'
import { upgradePreflightChecks } from './team-workspace-upgrade-baseline.ts'
import { stateConflict } from '../../domain/request-errors.ts'

const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/
const webPushMigrationVersion = '0111_web_push.sql'
const legacyWebPushMigrationVersion = '0110_web_push.sql'

export interface AppliedMigration {
  version: string
  applied: boolean
}

/** Serializes migrations across processes that start against the same database. */
const migrationLockKey = 0x64736877 // 'dshw'

/** Line endings are normalized so a Windows checkout does not look like an edited migration. */
export function migrationChecksum(sqlText: string) {
  return createHash('sha256').update(sqlText.replaceAll('\r\n', '\n')).digest('hex')
}

export async function runMigrations(
  database: DatabaseClient,
  migrationsDirectory = resolve(import.meta.dirname, '../../../migrations'),
): Promise<AppliedMigration[]> {
  await database.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(${migrationLockKey})`
    await transaction.unsafe(`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `)
    await transaction.unsafe('alter table schema_migrations add column if not exists checksum text')
  })

  await reconcileRenamedWebPushMigration(database, migrationsDirectory)

  const files = (await readdir(migrationsDirectory))
    .filter((file) => migrationPattern.test(file))
    .sort()
  const results: AppliedMigration[] = []

  for (const version of files) {
    const sqlText = await readFile(resolve(migrationsDirectory, version), 'utf8')
    const checksum = migrationChecksum(sqlText)
    const [existing] = await database<{ checksum: string | null }[]>`
      select checksum from schema_migrations where version = ${version}
    `
    if (existing) {
      await verifyAppliedMigration(database, version, existing.checksum, checksum)
      results.push({ version, applied: false })
      continue
    }
    // AC-27：升级前置检查（例如 0022 依赖有效的 0013 个人空间基线）。失败时抛出并
    // 中止本次迁移，不写入 schema_migrations，杜绝「半升级」状态。
    const preflight = upgradePreflightChecks[version]
    if (preflight) await preflight(database)
    const applied = await database.begin(async (transaction) => {
      // Another process may have applied this version while we waited for the lock.
      await transaction`select pg_advisory_xact_lock(${migrationLockKey})`
      const [concurrent] = await transaction`select 1 from schema_migrations where version = ${version}`
      if (concurrent) return false
      await transaction.unsafe(sqlText)
      await transaction`insert into schema_migrations (version, checksum) values (${version}, ${checksum})`
      return true
    })
    results.push({ version, applied })
  }

  return results
}

/**
 * Web Push 曾以 `0110_web_push.sql` 发布，后与 WeKnora 迁移撞号并重编号为 `0111_web_push.sql`。
 * 旧库可能仍保留 orphan 记录或仅有表结构，需在执行 0111 前补写 schema_migrations。
 */
async function reconcileRenamedWebPushMigration(
  database: DatabaseClient,
  migrationsDirectory: string,
) {
  const [alreadyApplied] = await database`select 1 from schema_migrations where version = ${webPushMigrationVersion}`
  if (alreadyApplied) return

  const [legacyApplied] = await database`select 1 from schema_migrations where version = ${legacyWebPushMigrationVersion}`
  if (legacyApplied) {
    await recordWebPushMigration(database, migrationsDirectory)
    return
  }

  const [pushExists] = await database<{ exists: boolean }[]>`
    select exists (
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'push_subscriptions'
    ) as exists
  `
  if (!pushExists?.exists) return

  const [prefsExists] = await database<{ exists: boolean }[]>`
    select exists (
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'notification_preferences'
    ) as exists
  `
  if (!prefsExists?.exists) return

  await recordWebPushMigration(database, migrationsDirectory)
}

async function recordWebPushMigration(database: DatabaseClient, migrationsDirectory: string) {
  const sqlText = await readFile(resolve(migrationsDirectory, webPushMigrationVersion), 'utf8')
  const checksum = migrationChecksum(sqlText)
  await database.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(${migrationLockKey})`
    const [concurrent] = await transaction`select 1 from schema_migrations where version = ${webPushMigrationVersion}`
    if (concurrent) return
    await transaction`insert into schema_migrations (version, checksum) values (${webPushMigrationVersion}, ${checksum})`
  })
}

/**
 * An applied migration must never change: the database already ran the old text.
 * Rows recorded before checksums existed are filled in once with the current text.
 */
async function verifyAppliedMigration(database: DatabaseClient, version: string, recorded: string | null, current: string) {
  if (recorded === null) {
    await database`update schema_migrations set checksum = ${current} where version = ${version} and checksum is null`
    return
  }
  if (recorded !== current) {
    throw stateConflict(`迁移 ${version} 已执行过，但文件内容已被修改。已执行的迁移不能修改，请恢复原文件并把变更写成新的迁移。`)
  }
}
