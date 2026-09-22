import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const migrationsDirectory = resolve(import.meta.dirname, '../../../migrations')
const tenantId = 'tenant-dsh-work'
const staleConnectorId = 'connector-mcp-upgrade-stale-credential'
const verifiedConnectorId = 'connector-mcp-upgrade-verified-credential'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let baselineDirectory = ''
let activationDirectory = ''
let correctionDirectory = ''

before(async () => {
  baselineDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-mcp-baseline-'))
  activationDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-mcp-activation-'))
  correctionDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-mcp-correction-'))
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (file < '0057_mcp_auto_activation.sql') {
      await copyFile(resolve(migrationsDirectory, file), resolve(baselineDirectory, file))
    }
  }
  await copyFile(
    resolve(migrationsDirectory, '0057_mcp_auto_activation.sql'),
    resolve(activationDirectory, '0057_mcp_auto_activation.sql'),
  )
  await copyFile(
    resolve(migrationsDirectory, '0059_mcp_credential_recheck_guard.sql'),
    resolve(correctionDirectory, '0059_mcp_credential_recheck_guard.sql'),
  )

  throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_mcp_auto_activation_upgrade',
    maxConnections: 3,
    migrate: false,
  })
  database = throwaway.client
  await runMigrations(database, baselineDirectory)
  await seedUpgradeFixtures()
})

after(async () => {
  await throwaway.dispose()
  await Promise.all([
    rm(baselineDirectory, { recursive: true, force: true }),
    rm(activationDirectory, { recursive: true, force: true }),
    rm(correctionDirectory, { recursive: true, force: true }),
  ])
})

test('0057 only activates a Bearer Connector when its current credential has a later discovery check', async () => {
  const checksBefore = await healthCheckCount()
  const results = await runMigrations(database, activationDirectory)
  assert.equal(results.find(result => result.version === '0057_mcp_auto_activation.sql')?.applied, true)

  assert.deepEqual(await connectorStatuses(), [
    { id: staleConnectorId, status: 'degraded' },
    { id: verifiedConnectorId, status: 'healthy' },
  ])
  assert.equal(await availableGrantCount(), 1, 'the grant using an unchecked rotated credential must remain unavailable')
  assert.equal(await healthCheckCount(), checksBefore, 'a migration must not fabricate a discovery check')

  const profiles = await database<{ connectorId: string; approvalStatus: string }[]>`
    select connector_id as "connectorId", approval_status as "approvalStatus"
      from mcp_connector_profiles
     where tenant_id = ${tenantId}
       and connector_id in (${staleConnectorId}, ${verifiedConnectorId})
     order by connector_id
  `
  assert.deepEqual([...profiles], [
    { connectorId: staleConnectorId, approvalStatus: 'approved' },
    { connectorId: verifiedConnectorId, approvalStatus: 'approved' },
  ])
})

test('0059 returns a Connector incorrectly activated by the old 0057 migration to degraded', async () => {
  await database`
    update connectors set status = 'healthy'
     where tenant_id = ${tenantId} and id = ${staleConnectorId}
  `
  assert.equal(await availableGrantCount(), 2, 'fixture reproduces the old migration exposure')
  const checksBefore = await healthCheckCount()

  const results = await runMigrations(database, correctionDirectory)
  assert.equal(results.find(result => result.version === '0059_mcp_credential_recheck_guard.sql')?.applied, true)
  assert.deepEqual(await connectorStatuses(), [
    { id: staleConnectorId, status: 'degraded' },
    { id: verifiedConnectorId, status: 'healthy' },
  ])
  assert.equal(await availableGrantCount(), 1)
  assert.equal(await healthCheckCount(), checksBefore, 'the corrective migration must require a real recheck')
})

async function seedUpgradeFixtures() {
  await database`
    insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by, updated_at)
    values
      ('credential-mcp-upgrade-stale', ${tenantId}, 'postgres-encrypted', 'credential-mcp-upgrade-stale', 'configured', '2026-09-01T00:00:00Z', 'U00008', '2026-09-02T00:00:00Z'),
      ('credential-mcp-upgrade-verified', ${tenantId}, 'postgres-encrypted', 'credential-mcp-upgrade-verified', 'configured', '2026-09-02T00:00:00Z', 'U00008', '2026-09-02T00:00:00Z')
  `
  await database`
    insert into connectors (
      id, tenant_id, key, name, connector_type, credential_ref_id, status,
      system, protocol, endpoint, auth_type, scope_description, latency_ms, last_checked_at, updated_at
    ) values
      (${staleConnectorId}, ${tenantId}, 'mcp-upgrade-stale', '轮换后未检查 MCP', 'mcp', 'credential-mcp-upgrade-stale', 'degraded',
       'MCP', 'mcp', 'https://stale.example.test/mcp', 'bearer', '升级迁移回归', 5, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'),
      (${verifiedConnectorId}, ${tenantId}, 'mcp-upgrade-verified', '凭据已检查 MCP', 'mcp', 'credential-mcp-upgrade-verified', 'degraded',
       'MCP', 'mcp', 'https://verified.example.test/mcp', 'bearer', '升级迁移对照', 5, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')
  `
  await database.unsafe(`
    insert into credential_secrets (
      tenant_id, credential_ref_id, algorithm, key_id, version,
      ciphertext, nonce, auth_tag, created_by, updated_by, created_at, rotated_at, updated_at
    ) values
      ('${tenantId}', 'credential-mcp-upgrade-stale', 'aes-256-gcm', 'test', 2,
       decode('aa', 'hex'), decode(repeat('01', 12), 'hex'), decode(repeat('02', 16), 'hex'),
       'U00008', 'U00008', '2026-08-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z'),
      ('${tenantId}', 'credential-mcp-upgrade-verified', 'aes-256-gcm', 'test', 1,
       decode('bb', 'hex'), decode(repeat('03', 12), 'hex'), decode(repeat('04', 16), 'hex'),
       'U00008', 'U00008', '2026-08-01T00:00:00Z', null, '2026-08-01T00:00:00Z')
  `)
  await database`
    insert into mcp_connector_profiles (
      tenant_id, connector_id, server_name, approval_status,
      capability_digest, capability_snapshot, discovered_at, updated_at
    ) values
      (${tenantId}, ${staleConnectorId}, 'upgrade_stale', 'changes_pending', ${'a'.repeat(64)}, ${database.json([{ name: 'read', description: 'read', inputSchema: {} }])}, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      (${tenantId}, ${verifiedConnectorId}, 'upgrade_verified', 'pending_review', ${'b'.repeat(64)}, ${database.json([{ name: 'read', description: 'read', inputSchema: {} }])}, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')
  `
  await database`
    insert into connector_health_checks (id, tenant_id, connector_id, status, latency_ms, message, checked_by, checked_at)
    values
      ('check-mcp-upgrade-stale', ${tenantId}, ${staleConnectorId}, 'degraded', 5, '能力变化，需要重新审核', 'U00008', '2026-09-01T00:00:00Z'),
      ('check-mcp-upgrade-verified', ${tenantId}, ${verifiedConnectorId}, 'degraded', 5, '已发现工具，等待整体审核', 'U00008', '2026-09-02T00:00:00Z')
  `
  await database`
    insert into agent_mcp_grants (tenant_id, agent_id, connector_id, status, granted_by)
    values
      (${tenantId}, 'agent-dsh-work-assistant', ${staleConnectorId}, 'active', 'U00008'),
      (${tenantId}, 'agent-dsh-work-assistant', ${verifiedConnectorId}, 'active', 'U00008')
  `
}

async function connectorStatuses() {
  const rows = await database<{ id: string; status: string }[]>`
    select id, status from connectors
     where tenant_id = ${tenantId} and id in (${staleConnectorId}, ${verifiedConnectorId})
     order by id
  `
  return [...rows]
}

async function availableGrantCount() {
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from agent_mcp_grants g
      join connectors c on c.tenant_id = g.tenant_id and c.id = g.connector_id
      join mcp_connector_profiles p on p.tenant_id = c.tenant_id and p.connector_id = c.id
     where g.tenant_id = ${tenantId}
       and g.connector_id in (${staleConnectorId}, ${verifiedConnectorId})
       and g.status = 'active'
       and c.status = 'healthy'
       and c.deleted_at is null
       and p.approval_status = 'approved'
       and p.capability_digest = p.approved_digest
  `
  return row?.count ?? 0
}

async function healthCheckCount() {
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count from connector_health_checks
     where tenant_id = ${tenantId} and connector_id in (${staleConnectorId}, ${verifiedConnectorId})
  `
  return row?.count ?? 0
}
