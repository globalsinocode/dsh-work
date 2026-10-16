import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresWorkspaceGrantSourceService } from '../../modules/authorization/postgres-workspace-grant-source-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase } from './test-database.ts'

const tenantId = 'tenant-dsh-work'
const migration = '0079_team_agent_binding_grants.sql'
const migrationsDirectory = resolve(import.meta.dirname, '../../../migrations')

test('升级补齐封存默认工具的成员来源，保留旧版本并尊重停用、移除和撤权', async () => {
  const baseline = await mkdtemp(resolve(tmpdir(), 'dsh-work-binding-upgrade-'))
  const throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_binding_upgrade', migrate: false })
  const db = throwaway.client
  try {
    for (const file of await readdir(migrationsDirectory)) {
      if (file.endsWith('.sql') && file < migration) await copyFile(resolve(migrationsDirectory, file), resolve(baseline, file))
    }
    await runMigrations(db, baseline)
    // Current code reads the Agent-level audience (0084); give the pre-0079 schema that column.
    await db`alter table agents add column visible_role_ids jsonb not null default '["role-employee"]'::jsonb`
    const toolService = new PostgresToolConnectorService(db)
    const bindings = await toolService.resolveToolBindings(['read@1.0.0', 'write@1.0.0'])
    await db`
      insert into agents (id, tenant_id, name, description, status, owner_user_id, created_by)
      values ('binding-upgrade-agent', ${tenantId}, '升级 Agent', '', 'published', 'U00001', 'U00001')
    `
    for (const version of ['1', '2']) {
      await db`
        insert into agent_versions (
          id, tenant_id, agent_id, version, name, system_prompt, visible_role_ids,
          data_scopes, skill_refs, tool_refs, binding_refs, status, created_by
        ) values (
          ${`binding-upgrade-v${version}`}, ${tenantId}, 'binding-upgrade-agent', ${`${version}.0.0`},
          '升级 Agent', '测试', '["role-employee"]', '[]', '[]', '[]',
          ${db.json([{ ...bindings[Number(version) - 1]! }])}, 'published', 'U00001'
        )
      `
    }
    await db`update agents set active_version_id = 'binding-upgrade-v2' where id = 'binding-upgrade-agent'`
    const scenarios = ['valid', 'disabled', 'removed', 'revoked', 'missing-effective', 'legacy', 'tool-revoked']
    for (const scenario of scenarios) {
      const ws = `binding-upgrade-${scenario}`
      const member = `${ws}-member`
      await db`
        insert into workspaces (id, tenant_id, name, workspace_type, created_by, status)
        values (${ws}, ${tenantId}, '升级团队', 'team', 'U00001', 'active')
      `
      await db`
        insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${tenantId}, ${ws}, 'U00001', 'owner', 'U00001')
      `
      await db`
        insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
        values (${member}, ${tenantId}, ${ws}, 'binding-upgrade-agent', 'binding-upgrade-v2',
          ${scenario === 'disabled' || scenario === 'removed' ? scenario : 'available'}, 'U00001')
      `
      for (const version of ['1', '2']) {
        await db`
          insert into workspace_grant_sources (
            id, tenant_id, workspace_id, capability_type, capability_version_id,
            source_type, source_ref_id, status, created_by
          ) values (
            ${`${ws}-v${version}`}, ${tenantId}, ${ws}, 'agent', ${`binding-upgrade-v${version}`},
            ${scenario === 'legacy' ? 'legacy_unresolved' : 'agent_member'},
            ${scenario === 'legacy' ? null : member}, ${scenario === 'revoked' ? 'revoked' : 'active'}, 'U00001'
          )
        `
        if (scenario !== 'missing-effective') await db`
          insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
          values (${tenantId}, ${ws}, 'agent', ${`binding-upgrade-v${version}`})
        `
      }
      if (scenario === 'tool-revoked') await db`
        insert into workspace_grant_sources (
          id, tenant_id, workspace_id, capability_type, capability_version_id,
          source_type, source_ref_id, status, created_by
        ) select ${`${ws}-tool`}, ${tenantId}, ${ws}, 'tool', id, 'agent_member', ${member}, 'revoked', 'U00001'
          from tool_versions where tenant_id = ${tenantId} and tool_id = 'read' and version = '1.0.0'
      `
    }
    const authorization = new PostgresAuthorizationService(db)
    const authorize = (version: string) => authorization.authorizeRuntime({
      userId: 'U00001', workspaceId: 'binding-upgrade-valid', agentVersionId: `binding-upgrade-v${version}`,
    })
    await assert.rejects(authorize('1'), /工作空间未配置工具授权/)
    const revisionsBefore = await db<{ id: string; revision: number }[]>`
      select id, team_auth_revision as revision from workspaces where id like 'binding-upgrade-%' order by id
    `
    assert.ok((await runMigrations(db)).some(result => result.version === migration && result.applied))
    await authorize('1')
    await authorize('2')
    const toolGrants = await db<{ workspaceId: string; toolId: string; sourceRef: string; sourceStatus: string }[]>`
      select g.workspace_id as "workspaceId", tv.tool_id as "toolId", s.source_ref_id as "sourceRef", s.status as "sourceStatus"
      from workspace_capability_grants g
      join tool_versions tv on tv.tenant_id = g.tenant_id and tv.id = g.capability_version_id
      join workspace_grant_sources s on s.tenant_id = g.tenant_id and s.workspace_id = g.workspace_id
        and s.capability_type = g.capability_type and s.capability_version_id = g.capability_version_id
      where g.workspace_id like 'binding-upgrade-%' and g.capability_type = 'tool'
      order by g.workspace_id, tv.tool_id
    `
    assert.deepEqual(toolGrants.map(row => [row.workspaceId, row.toolId]), [
      ['binding-upgrade-tool-revoked', 'write'],
      ['binding-upgrade-valid', 'read'], ['binding-upgrade-valid', 'write'],
    ])
    assert.ok(toolGrants.every(row => row.sourceStatus === 'active' && row.sourceRef === `${row.workspaceId}-member`))
    const revisionsAfter = await db<{ id: string; revision: number }[]>`
      select id, team_auth_revision as revision from workspaces where id like 'binding-upgrade-%' order by id
    `
    assert.deepEqual([...revisionsAfter], revisionsBefore.map(row => ({
      ...row, revision: row.revision + (row.id.endsWith('-valid') || row.id.endsWith('-tool-revoked') ? 1 : 0),
    })))
    // Re-applying the SQL cannot duplicate provenance or invalidate caches again.
    await db.begin(async tx => { await tx.unsafe(await readFile(resolve(migrationsDirectory, migration), 'utf8')) })
    assert.deepEqual(await db`
      select id, team_auth_revision as revision from workspaces where id like 'binding-upgrade-%' order by id
    `, revisionsAfter)
    // The added permissions follow the normal member revocation path.
    await db.begin(async tx => {
      await new PostgresWorkspaceGrantSourceService().revokeGrantSourcesByRef(tx, 'binding-upgrade-valid', 'binding-upgrade-valid-member')
    })
    assert.equal((await db`
      select 1 from workspace_capability_grants where workspace_id = 'binding-upgrade-valid' and capability_type = 'tool'
    `).length, 0)
  } finally {
    await throwaway.dispose()
    await rm(baseline, { recursive: true, force: true })
  }
})
