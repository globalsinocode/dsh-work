import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'

const tenantId = 'tenant-dsh-work'

export interface AudienceCeiling {
  /** The Agent's role grants that at least one visible role can actually reach. */
  roleIds: string[]
  /** The Agent's data scopes that at least one active member of a visible role holds. */
  dataScopes: string[]
}

/**
 * Employee-side ceiling for release validation.
 *
 * An employee run is bounded twice: by the Agent's own grants and by the employee
 * (roles ∩, data scopes ∩). A validation run has no real employee, so it is bounded by the
 * most any employee in the audience could have: the Agent's roles that are visible roles,
 * and the Agent's data scopes granted to a visible role or to an active member of one.
 * Workspace grants are left out because validation runs have no workspace.
 *
 * This keeps validation from succeeding with access no employee would ever lend the Agent.
 */
export async function resolveAudienceCeiling(
  database: DatabaseClient | DatabaseTransaction,
  agentId: string,
  grants: { roleIds: string[]; dataScopes: string[] },
): Promise<AudienceCeiling> {
  const rows = await database<{ id: string }[]>`
    select r.id
      from agents a
      join roles r on r.tenant_id = a.tenant_id and r.status = 'active'
       and a.visible_role_ids @> to_jsonb(r.id)
     where a.tenant_id = ${tenantId} and a.id = ${agentId}
  `
  const visible = rows.map(row => row.id)
  if (!visible.length) return { roleIds: [], dataScopes: [] }
  const reachable = grants.dataScopes.length ? await database<{ scopeValue: string }[]>`
    select distinct g.scope_value as "scopeValue"
      from data_scope_grants g
     where g.tenant_id = ${tenantId}
       and g.scope_value in ${database(grants.dataScopes)}
       and (
         (g.subject_type = 'role' and g.subject_id in ${database(visible)})
         or (g.subject_type = 'user' and exists (
           select 1 from user_roles ur
             join users u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.status = 'active'
            where ur.tenant_id = g.tenant_id and ur.user_id = g.subject_id
              and ur.role_id in ${database(visible)}
              and (ur.valid_until is null or ur.valid_until > now())
         ))
       )
  ` : []
  const scopes = new Set(reachable.map(row => row.scopeValue))
  return {
    roleIds: grants.roleIds.filter(role => visible.includes(role)),
    dataScopes: grants.dataScopes.filter(scope => scopes.has(scope)),
  }
}
