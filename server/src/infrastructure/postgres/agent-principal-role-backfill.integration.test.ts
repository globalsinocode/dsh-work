import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const migrationsDirectory = resolve(import.meta.dirname, '../../../migrations')
const tenantId = 'tenant-dsh-work'

async function copyMigrationsThrough0108(targetDir: string) {
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (file <= '0108_workspace_grants_agent_skill_only.sql') {
      await copyFile(resolve(migrationsDirectory, file), join(targetDir, file))
    }
  }
}

async function grantedRoles(database: ThrowawayDatabase['client'], agentId: string) {
  const rows = await database<{ roleId: string }[]>`
    select grants.role_id as "roleId"
      from agent_principal_role_grants grants
      join execution_principals principal
        on principal.tenant_id = grants.tenant_id and principal.id = grants.principal_id
     where grants.tenant_id = ${tenantId} and principal.agent_id = ${agentId}
     order by grants.role_id
  `
  return rows.map(row => row.roleId)
}

let fresh: ThrowawayDatabase

before(async () => {
  fresh = await createThrowawayDatabase({ namePrefix: 'dsh_work_agent_principal_0109_fresh' })
})

after(async () => {
  await fresh?.dispose()
})

test('fresh install keeps the default assistant executable only as an employee', async () => {
  assert.deepEqual(await grantedRoles(fresh.client, 'agent-dsh-work-assistant'), ['role-employee'])
})

test('0109 preserves audited grants and clears unaudited legacy grants fail closed', async () => {
  const baselineDir = await mkdtemp(join(tmpdir(), 'dsh-migrations-0108-'))
  const throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_agent_principal_0109_upgrade',
    migrate: false,
  })
  try {
    await copyMigrationsThrough0108(baselineDir)
    await runMigrations(throwaway.client, baselineDir)

    for (const agentId of ['agent-explicit-principal', 'agent-legacy-principal']) {
      await throwaway.client`
        insert into agents (id, tenant_id, name, description, owner_user_id, created_by, status)
        values (${agentId}, ${tenantId}, ${agentId}, 'migration fixture', 'U00001', 'U00001', 'draft')
      `
      await throwaway.client`
        insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
        values
          (${tenantId}, ${`principal-agent-${agentId}`}, 'role-employee'),
          (${tenantId}, ${`principal-agent-${agentId}`}, 'role-platform-admin')
      `
    }
    await throwaway.client`
      insert into audit_events (
        id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context
      ) values (
        'audit-agent-explicit-principal', ${tenantId}, 'user', 'U00001',
        'agent.principal.update', 'agent', 'agent-explicit-principal', 'success',
        'trace-agent-explicit-principal', '{}'::jsonb
      )
    `

    await runMigrations(throwaway.client, migrationsDirectory)

    assert.deepEqual(await grantedRoles(throwaway.client, 'agent-explicit-principal'),
      ['role-employee', 'role-platform-admin'])
    assert.deepEqual(await grantedRoles(throwaway.client, 'agent-legacy-principal'), [])
    assert.deepEqual(await grantedRoles(throwaway.client, 'agent-dsh-work-assistant'), ['role-employee'])

    const impacts = await throwaway.client<{ agentId: string; clearedRoleIds: string[]; replacementRoleIds: string[] }[]>`
      select object_id as "agentId",
             safe_context->'clearedRoleIds' as "clearedRoleIds",
             safe_context->'replacementRoleIds' as "replacementRoleIds"
        from audit_events
       where tenant_id = ${tenantId}
         and action = 'agent.principal.migration_reconfiguration_required'
       order by object_id
    `
    assert.deepEqual(impacts.map(row => row.agentId),
      ['agent-dsh-work-assistant', 'agent-legacy-principal'])
    assert.deepEqual(impacts.find(row => row.agentId === 'agent-legacy-principal')?.replacementRoleIds, [])
  } finally {
    await throwaway.dispose()
    await rm(baselineDir, { recursive: true, force: true })
  }
})
