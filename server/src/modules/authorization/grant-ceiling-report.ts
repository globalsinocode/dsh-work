import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { isManagementPermission, missingDataScopes, missingPermissions } from '../../domain/admin-permissions.ts'
import { loadGrantCeiling, loadRoleGrants } from './admin-actor.ts'

const tenantId = 'tenant-dsh-work'

export interface GrantCeilingException {
  kind: 'department-grant' | 'agent-access'
  objectId: string
  objectName: string
  grantedBy: string
  grantedByName: string
  missingPermissions: string[]
  missingDataScopes: string[]
}

/**
 * 存量清单（功能规则第 13 节）：上线“授出不超过自身”之前，由非平台管理员授出、
 * 且超出其**当前**权限的部门授权与 Agent 岗位权限。只读，供平台管理员复核，不自动回收。
 * Agent 岗位权限的授予人取最近一次 `agent.access.update` 审计的操作人，没有时取 Agent 创建人。
 */
export async function listGrantCeilingExceptions(sql: DatabaseClient | DatabaseTransaction): Promise<GrantCeilingException[]> {
  const exceptions: GrantCeilingException[] = []
  const ceilings = new Map<string, Awaited<ReturnType<typeof loadGrantCeiling>>>()
  const ceilingOf = async (userId: string) => {
    if (!ceilings.has(userId)) ceilings.set(userId, await loadGrantCeiling(sql, userId))
    return ceilings.get(userId)!
  }

  const departmentGrants = await sql<{ id: string; departmentName: string; roleId: string; grantedBy: string | null; grantedByName: string | null }[]>`
    select g.id, d.name as "departmentName", g.role_id as "roleId", g.granted_by as "grantedBy", u.display_name as "grantedByName"
      from org_department_grants g
      join org_departments d on d.tenant_id = g.tenant_id and d.id = g.department_id
      left join users u on u.tenant_id = g.tenant_id and u.id = g.granted_by
     where g.tenant_id = ${tenantId} and g.status = 'active'
     order by g.created_at, g.id
  `
  for (const grant of departmentGrants) {
    if (!grant.grantedBy) continue
    const ceiling = await ceilingOf(grant.grantedBy)
    if (ceiling.platformAdmin) continue
    const role = await loadRoleGrants(sql, [grant.roleId])
    const missing = missingPermissions(role.permissions, ceiling.permissions)
    const scopes = missingDataScopes(role.dataScopes, ceiling.dataScopes)
    if (!missing.length && !scopes.length) continue
    exceptions.push({
      kind: 'department-grant', objectId: grant.id, objectName: `${grant.departmentName} · ${grant.roleId}`,
      grantedBy: grant.grantedBy, grantedByName: grant.grantedByName ?? grant.grantedBy,
      missingPermissions: missing, missingDataScopes: scopes,
    })
  }

  const agents = await sql<{ agentId: string; name: string | null; actorId: string; actorName: string | null; roleIds: string[]; dataScopes: string[] }[]>`
    select a.id as "agentId", a.name, last.actor_id as "actorId", u.display_name as "actorName",
           coalesce((select jsonb_agg(g.role_id) from agent_principal_role_grants g
                      where g.tenant_id = ep.tenant_id and g.principal_id = ep.id), '[]'::jsonb) as "roleIds",
           coalesce((select jsonb_agg(g.scope_value) from agent_principal_scope_grants g
                      where g.tenant_id = ep.tenant_id and g.principal_id = ep.id), '[]'::jsonb) as "dataScopes"
      from agents a
      join execution_principals ep on ep.tenant_id = a.tenant_id and ep.kind = 'agent' and ep.agent_id = a.id
      join lateral (
        -- 授予人：最近一次修改岗位权限的人；从未修改过时为创建人（创建时可带执行授权）。
        select coalesce(
          (select e.actor_id from audit_events e
            where e.tenant_id = a.tenant_id and e.action = 'agent.access.update' and e.object_id = a.id and e.actor_type = 'user'
            order by e.occurred_at desc, e.id desc limit 1),
          a.created_by
        ) as actor_id
      ) last on last.actor_id is not null
      left join users u on u.tenant_id = a.tenant_id and u.id = last.actor_id
     where a.tenant_id = ${tenantId}
     order by a.id
  `
  for (const agent of agents) {
    const ceiling = await ceilingOf(agent.actorId)
    if (ceiling.platformAdmin) continue
    const roles = await loadRoleGrants(sql, agent.roleIds)
    const missing = missingPermissions(roles.permissions, ceiling.permissions)
    const management = roles.permissions.filter(isManagementPermission)
    const scopes = missingDataScopes(agent.dataScopes, ceiling.dataScopes)
    const all = [...new Set([...missing, ...management])].sort()
    if (!all.length && !scopes.length) continue
    exceptions.push({
      kind: 'agent-access', objectId: agent.agentId, objectName: agent.name ?? agent.agentId,
      grantedBy: agent.actorId, grantedByName: agent.actorName ?? agent.actorId,
      missingPermissions: all, missingDataScopes: scopes,
    })
  }
  return exceptions
}
