import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { assertWithinGrantCeiling, loadGrantCeiling, loadRoleGrants, requireAdminModuleActor } from '../authorization/admin-actor.ts'
import { isManagementPermission } from '../../domain/admin-permissions.ts'
import { authorizationDenied } from '../../domain/authorization-errors.ts'
import { RequestError, invalidRequest, notFound } from '../../domain/request-errors.ts'

const tenantId = 'tenant-dsh-work'
const MAX_ENTRIES = 100

export interface AgentAccessRoleOption {
  id: string
  name: string
  status: 'active' | 'disabled'
  /** 角色带有管理类权限（`admin:`、`audit:`、`data-protection:` 前缀）；只有平台管理员能授给 Agent。 */
  privileged: boolean
}

/**
 * S2 岗位权限：谁可以向 Agent 请求工作、它持有哪些岗位角色、能接触哪些数据。
 * 三者都属于 Agent 而非版本，修改立即生效，不触发重新验证。
 */
export interface AgentAccess {
  agentId: string
  /** Optimistic concurrency token of the whole access setting (agents.access_revision). */
  revision: number
  principalId: string
  principalStatus: 'active' | 'disabled'
  visibleRoleIds: string[]
  roleIds: string[]
  dataScopes: string[]
  roleOptions: AgentAccessRoleOption[]
  scopeOptions: string[]
  routines: Array<{
    id: string; name: string; status: string; schedule: Record<string, unknown>
    recipientUserId: string; recipientName: string
  }>
}

export interface UpdateAgentAccessInput {
  agentId: string
  actor: string
  expectedRevision: number
  visibleRoleIds: string[]
  roleIds: string[]
  dataScopes: string[]
  principalStatus?: 'active' | 'disabled'
}

export class PostgresAgentAccessService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async getAccess(agentId: string): Promise<AgentAccess> {
    const [row] = await this.database<{
      agentId: string; visibleRoleIds: string[]; principalId: string; principalStatus: 'active' | 'disabled'
      revision: number; roleIds: string[]; dataScopes: string[]
    }[]>`
      select a.id as "agentId", a.visible_role_ids as "visibleRoleIds",
             ep.id as "principalId", ep.status as "principalStatus", a.access_revision as revision,
             coalesce((select jsonb_agg(g.role_id order by g.role_id) from agent_principal_role_grants g
                       where g.tenant_id = ep.tenant_id and g.principal_id = ep.id), '[]'::jsonb) as "roleIds",
             coalesce((select jsonb_agg(g.scope_value order by g.scope_value) from agent_principal_scope_grants g
                       where g.tenant_id = ep.tenant_id and g.principal_id = ep.id), '[]'::jsonb) as "dataScopes"
        from agents a
        join execution_principals ep on ep.tenant_id = a.tenant_id and ep.kind = 'agent' and ep.agent_id = a.id
       where a.tenant_id = ${tenantId} and a.id = ${agentId}
    `
    if (!row) throw notFound(`Agent 不存在：${agentId}`)
    const roleOptions = await this.database<AgentAccessRoleOption[]>`
      select id, name, status,
             exists (
               select 1 from jsonb_array_elements_text(coalesce(permissions, '[]'::jsonb)) as permission(code)
                where permission.code like 'admin:%' or permission.code like 'audit:%' or permission.code like 'data-protection:%'
             ) as privileged
        from roles where tenant_id = ${tenantId} order by name, id
    `
    const routines = await this.database<AgentAccess['routines']>`
      select r.id, r.name, r.status, r.schedule, r.recipient_user_id as "recipientUserId",
             u.display_name as "recipientName"
        from agent_routines r
        join users u on u.tenant_id = r.tenant_id and u.id = r.recipient_user_id
       where r.tenant_id = ${tenantId} and r.agent_id = ${agentId} and r.status <> 'disabled'
       order by r.created_at
    `
    const knownScopes = await this.database<{ scope: string }[]>`
      select distinct scope_value as scope from data_scope_grants where tenant_id = ${tenantId}
    `
    const scopeOptions = [...new Set([
      ...knownScopes.map(item => item.scope), ...row.dataScopes,
    ])].filter(Boolean).sort()
    return {
      agentId: row.agentId,
      revision: row.revision,
      principalId: row.principalId,
      principalStatus: row.principalStatus,
      visibleRoleIds: [...row.visibleRoleIds].sort(),
      roleIds: row.roleIds,
      dataScopes: row.dataScopes,
      roleOptions,
      scopeOptions,
      routines,
    }
  }

  async updateAccess(input: UpdateAgentAccessInput): Promise<AgentAccess> {
    const actor = await requireAdminModuleActor(this.database, input.actor, 'agent', 'write')
    const visibleRoleIds = readList(input.visibleRoleIds, '可见角色')
    const roleIds = readList(input.roleIds, '岗位角色')
    const dataScopes = readList(input.dataScopes, '数据范围')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw invalidRequest('缺少岗位权限修订号，请刷新后重试')
    }
    if (input.principalStatus !== undefined && !['active', 'disabled'].includes(input.principalStatus)) {
      throw invalidRequest('执行身份状态无效')
    }
    await this.database.begin(async transaction => {
      const [principal] = await transaction<{ id: string; status: 'active' | 'disabled'; revision: number }[]>`
        select ep.id, ep.status, a.access_revision as revision
          from execution_principals ep
          join agents a on a.tenant_id = ep.tenant_id and a.id = ep.agent_id
         where ep.tenant_id = ${tenantId} and ep.kind = 'agent' and ep.agent_id = ${input.agentId}
         for update of ep, a
      `
      if (!principal) throw notFound(`Agent 不存在：${input.agentId}`)
      if (principal.revision !== input.expectedRevision) {
        throw new RequestError(409, 'AGENT_ACCESS_REVISION_CONFLICT', 'Agent 岗位权限已被修改，请刷新后重试')
      }
      const [current] = await transaction<{ visibleRoleIds: string[]; roleIds: string[]; dataScopes: string[] }[]>`
        select a.visible_role_ids as "visibleRoleIds",
               coalesce((select jsonb_agg(g.role_id) from agent_principal_role_grants g
                         where g.tenant_id = a.tenant_id and g.principal_id = ${principal.id}), '[]'::jsonb) as "roleIds",
               coalesce((select jsonb_agg(g.scope_value) from agent_principal_scope_grants g
                         where g.tenant_id = a.tenant_id and g.principal_id = ${principal.id}), '[]'::jsonb) as "dataScopes"
          from agents a where a.tenant_id = ${tenantId} and a.id = ${input.agentId}
      `
      // Keeping an already-granted role that has since been disabled is allowed (it grants
      // nothing at runtime); adding a role requires it to be active.
      const added = [
        ...visibleRoleIds.filter(role => !current!.visibleRoleIds.includes(role)),
        ...roleIds.filter(role => !current!.roleIds.includes(role)),
      ]
      if (added.length) {
        const known = await transaction<{ id: string }[]>`
          select id from roles where tenant_id = ${tenantId} and status = 'active' and id = any(${[...new Set(added)]})
        `
        if (known.length !== new Set(added).size) throw invalidRequest('岗位权限包含无效或已停用的角色')
      }
      const status = input.principalStatus ?? principal.status
      const visibleChange = diff(current!.visibleRoleIds, visibleRoleIds)
      await assertAgentAccessWithinActor(transaction, actor.id, {
        roleIds,
        dataScopes,
        // 放宽（新增岗位角色、数据范围、新增可见角色或重新启用执行身份）时才复核；只移除不受影响。
        widened: roleIds.some(role => !current!.roleIds.includes(role))
          || dataScopes.some(scope => !current!.dataScopes.includes(scope))
          || visibleChange.added.length > 0
          || (principal.status === 'disabled' && status === 'active'),
      })
      await transaction`
        update agents set visible_role_ids = ${transaction.json(visibleRoleIds)},
               access_revision = access_revision + 1, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.agentId}
      `
      await replaceGrants(transaction, 'agent_principal_role_grants', 'role_id', principal.id, roleIds)
      await replaceGrants(transaction, 'agent_principal_scope_grants', 'scope_value', principal.id, dataScopes)
      // Grant changes bump the principal's authorization_version through triggers;
      // a status change bumps it here. An audience-only change leaves it untouched.
      if (status !== principal.status) {
        await transaction`
          update execution_principals
             set status = ${status}, authorization_version = authorization_version + 1, updated_at = now()
           where tenant_id = ${tenantId} and id = ${principal.id}
        `
      }
      const changes = {
        visibleRoleIds: visibleChange,
        roleIds: diff(current!.roleIds, roleIds),
        dataScopes: diff(current!.dataScopes, dataScopes),
        ...(status !== principal.status ? { principalStatus: { from: principal.status, to: status } } : {}),
      }
      await transaction`
        insert into audit_events (id, tenant_id, actor_type, actor_id, action,
          object_type, object_id, result, trace_id, safe_context)
        values (${`audit-agent-access-${randomUUID()}`}, ${tenantId}, 'user', ${actor.id},
          'agent.access.update', 'agent', ${input.agentId}, 'success',
          ${`trace-agent-access-${randomUUID()}`}, ${transaction.json(changes)})
      `
    })
    return this.getAccess(input.agentId)
  }
}

/**
 * 授出不超过自身（功能规则第 13 节）：非平台管理员不能给 Agent 授予管理类角色；
 * Agent 的全部岗位角色权限与数据范围须是操作人自身的子集。改变可见角色等于把 Agent 的能力
 * 开放给新的人，同样要求 Agent 当前能力不超过操作人。平台管理员不受约束。
 */
export async function assertAgentAccessWithinActor(
  sql: DatabaseClient | DatabaseTransaction,
  actorId: string,
  input: { roleIds: string[]; dataScopes: string[]; widened: boolean },
) {
  if (!input.widened) return
  const ceiling = await loadGrantCeiling(sql, actorId)
  if (ceiling.platformAdmin) return
  const roles = await loadRoleGrants(sql, input.roleIds)
  if (roles.permissions.some(isManagementPermission)) {
    throw authorizationDenied('含管理类权限的角色只有平台管理员可以授给 Agent')
  }
  assertWithinGrantCeiling(ceiling, { permissions: roles.permissions, dataScopes: input.dataScopes }, 'Agent 的岗位权限')
}

/** Agent 当前岗位角色与数据范围（用于主动任务接收人等开放 Agent 能力的操作复核）。 */
export async function assertAgentCapabilityWithinActor(sql: DatabaseClient | DatabaseTransaction, actorId: string, agentId: string) {
  const [row] = await sql<{ roleIds: string[]; dataScopes: string[] }[]>`
    select coalesce((select jsonb_agg(g.role_id) from agent_principal_role_grants g
                      where g.tenant_id = ep.tenant_id and g.principal_id = ep.id), '[]'::jsonb) as "roleIds",
           coalesce((select jsonb_agg(g.scope_value) from agent_principal_scope_grants g
                      where g.tenant_id = ep.tenant_id and g.principal_id = ep.id), '[]'::jsonb) as "dataScopes"
      from execution_principals ep
     where ep.tenant_id = ${tenantId} and ep.kind = 'agent' and ep.agent_id = ${agentId}
  `
  if (!row) throw notFound(`Agent 不存在：${agentId}`)
  await assertAgentAccessWithinActor(sql, actorId, { roleIds: row.roleIds, dataScopes: row.dataScopes, widened: true })
}

function readList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES
    || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 128)) {
    throw invalidRequest(`${label}参数无效`)
  }
  return [...new Set(value.map(item => (item as string).trim()))].sort()
}

function diff(before: string[], after: string[]) {
  return {
    added: after.filter(item => !before.includes(item)),
    removed: before.filter(item => !after.includes(item)),
  }
}

async function replaceGrants(
  transaction: DatabaseTransaction,
  table: 'agent_principal_role_grants' | 'agent_principal_scope_grants',
  column: 'role_id' | 'scope_value',
  principalId: string,
  values: string[],
) {
  await transaction`
    delete from ${transaction(table)} where tenant_id = ${tenantId} and principal_id = ${principalId}
      and not (${transaction(column)} = any(${values}))
  `
  for (const value of values) await transaction`
    insert into ${transaction(table)} (tenant_id, principal_id, ${transaction(column)})
    values (${tenantId}, ${principalId}, ${value}) on conflict do nothing
  `
}
