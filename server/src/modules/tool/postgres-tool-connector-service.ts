import { randomUUID } from 'node:crypto'

import type { ConnectorDefinition, ToolDefinition } from '../../domain/types.ts'
import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../runtime/runtime-types.ts'

const tenantId = 'tenant-dsh-work'
const runtimeIntrinsicTools = new Set(['activate_skill@1.0.0', 'python_execute@1.0.0'])

interface ToolRow {
  id: string
  version: string
  name: string
  system: string
  description: string
  connectorId: string
  risk: ToolDefinition['risk']
  mode: ToolDefinition['mode']
  status: ToolDefinition['status']
  inputSchema: unknown
  outputSchema: unknown
  timeoutSeconds: number
  allowedRoleIds: string[]
  dataScopes: string[]
  approvalPolicy: ToolDefinition['approvalPolicy']
  lastCheckedAt: Date | null
}

interface ConnectorRow {
  id: string
  name: string
  system: string
  status: ConnectorDefinition['status']
  protocol: ConnectorDefinition['protocol']
  endpoint: string
  authType: string
  credentialRef: string | null
  scopeDescription: string
  latencyMs: number | null
  lastCheckedAt: Date | null
  toolCount: number
}

export class PostgresToolConnectorService {
  private readonly database: DatabaseClient
  private readonly runtime?: AgentRuntimePort
  private readonly operations?: PostgresOperationsService

  constructor(database: DatabaseClient, runtime?: AgentRuntimePort, operations?: PostgresOperationsService) {
    this.database = database
    this.runtime = runtime
    this.operations = operations
  }

  async getTools(): Promise<ToolDefinition[]> {
    const rows = await this.database<ToolRow[]>`
      select t.id, tv.version, t.name, t.system, t.description,
             t.connector_id as "connectorId", tv.risk_level as risk, t.mode, t.status,
             tv.input_schema as "inputSchema", tv.output_schema as "outputSchema",
             t.timeout_seconds as "timeoutSeconds", t.allowed_role_ids as "allowedRoleIds",
             t.data_scopes as "dataScopes", t.approval_policy as "approvalPolicy",
             t.last_checked_at as "lastCheckedAt"
        from tools t
        join lateral (
          select version, risk_level, input_schema, output_schema
            from tool_versions
           where tenant_id = t.tenant_id and tool_id = t.id and status = 'published'
           order by created_at desc limit 1
        ) tv on true
       where t.tenant_id = ${tenantId} and t.connector_id is not null
       order by t.name
    `
    const roleNames = await this.roleNameMap()
    return rows.map(row => ({
      id: row.id,
      version: row.version,
      name: row.name,
      system: row.system,
      description: row.description,
      connectorId: row.connectorId,
      risk: row.risk,
      mode: row.mode,
      status: row.status,
      inputSchema: JSON.stringify(row.inputSchema, null, 2),
      outputSchema: JSON.stringify(row.outputSchema, null, 2),
      timeoutSeconds: row.timeoutSeconds,
      allowedRoles: row.allowedRoleIds.map(id => roleNames.get(id) ?? id),
      dataScopes: row.dataScopes,
      approvalPolicy: row.approvalPolicy,
      lastCheckedAt: formatRelative(row.lastCheckedAt),
    }))
  }

  async getConnectors(): Promise<ConnectorDefinition[]> {
    const rows = await this.database<ConnectorRow[]>`
      select c.id, c.name, c.system, c.status, c.protocol, c.endpoint,
             c.auth_type as "authType", cr.external_ref as "credentialRef",
             c.scope_description as "scopeDescription", c.latency_ms as "latencyMs",
             c.last_checked_at as "lastCheckedAt", count(t.id)::int as "toolCount"
        from connectors c
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
        left join tools t on t.tenant_id = c.tenant_id and t.connector_id = c.id
       where c.tenant_id = ${tenantId}
       group by c.id, cr.external_ref
       order by c.name
    `
    return rows.map(toConnectorDefinition)
  }

  async setToolStatus(input: { toolId: string; status: 'available' | 'disabled'; actor: string }) {
    const actor = await this.requireActor(input.actor)
    const [tool] = await this.database<{ connectorStatus: ConnectorDefinition['status'] }[]>`
      select c.status as "connectorStatus" from tools t
      join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
       where t.tenant_id = ${tenantId} and t.id = ${input.toolId}
    `
    if (!tool) throw new Error(`工具不存在：${input.toolId}`)
    if (input.status === 'available' && tool.connectorStatus !== 'healthy') {
      throw new Error('连接器未处于健康状态，不能启用工具')
    }
    await this.database`
      update tools set status = ${input.status}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${input.toolId}
    `
    await this.audit(actor.id, `tool.${input.status === 'available' ? 'enable' : 'disable'}`, input.toolId, 'success', `工具已${input.status === 'available' ? '启用' : '停用'}`)
    return this.requireTool(input.toolId)
  }

  async updateToolPermissions(input: {
    toolId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
    actor: string
  }) {
    const actor = await this.requireActor(input.actor)
    if (!input.allowedRoles.length || !input.dataScopes.length) throw new Error('工具必须配置授权角色和数据范围')
    const roleIds: string[] = []
    for (const value of unique(input.allowedRoles)) {
      const [role] = await this.database<{ id: string }[]>`
        select id from roles where tenant_id = ${tenantId} and (id = ${value} or name = ${value})
      `
      if (!role) throw new Error(`角色不存在：${value}`)
      roleIds.push(role.id)
    }
    const result = await this.database`
      update tools set allowed_role_ids = ${this.database.json(roleIds)},
                       data_scopes = ${this.database.json(unique(input.dataScopes))},
                       approval_policy = ${input.approvalPolicy}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${input.toolId}
       returning id
    `
    if (!result.length) throw new Error(`工具不存在：${input.toolId}`)
    await this.audit(actor.id, 'tool.permissions.update', input.toolId, 'success', '更新工具角色、数据范围和审批策略')
    return this.requireTool(input.toolId)
  }

  async checkConnector(input: { connectorId: string; actor: string }) {
    const actor = await this.requireActor(input.actor)
    const [connector] = await this.database<{ id: string; protocol: ConnectorDefinition['protocol'] }[]>`
      select id, protocol from connectors where tenant_id = ${tenantId} and id = ${input.connectorId}
    `
    if (!connector) throw new Error(`连接器不存在：${input.connectorId}`)
    const started = performance.now()
    let status: 'healthy' | 'degraded' | 'offline' = 'offline'
    let message = '连接器没有可用的健康检查适配器'
    if (connector.protocol === 'runtime' && this.runtime) {
      const health = await this.runtime.health()
      status = health.status
      message = health.message
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    await this.database.begin(async transaction => {
      await transaction`
        update connectors set status = ${status}, latency_ms = ${latencyMs},
                              last_checked_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.connectorId}
      `
      await transaction`
        update tools set status = case when ${status} = 'healthy' and status = 'degraded' then 'available'
                                       when ${status} <> 'healthy' and status = 'available' then 'degraded'
                                       else status end,
                         last_checked_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and connector_id = ${input.connectorId}
      `
      await transaction`
        insert into connector_health_checks (
          id, tenant_id, connector_id, status, latency_ms, message, checked_by
        ) values (
          ${`connector-check-${randomUUID()}`}, ${tenantId}, ${input.connectorId},
          ${status}, ${latencyMs}, ${message}, ${actor.id}
        )
      `
    })
    await this.audit(actor.id, 'connector.health.check', input.connectorId, status === 'offline' ? 'failed' : 'success', message)
    return this.requireConnector(input.connectorId)
  }

  async assertAvailableReferences(references: string[]): Promise<void> {
    for (const reference of unique(references)) {
      if (runtimeIntrinsicTools.has(reference)) continue
      const { id, version } = parseReference(reference)
      const [row] = await this.database<{ id: string }[]>`
        select tv.id from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
        join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
         where t.tenant_id = ${tenantId} and t.id = ${id}
           and (t.mode = 'read' or (t.mode = 'write' and t.connector_id = 'connector-dsh-workspace' and t.dsh_tool_name = 'write'))
           and t.status = 'available' and c.status = 'healthy'
           and tv.version = ${version} and tv.status = 'published'
      `
      if (!row) throw new Error(`工具不存在、未发布、不可用或不符合受控运行策略：${reference}`)
    }
  }

  async assertAuthorizationCompatibility(
    references: string[],
    visibleRoleIds: string[],
    agentDataScopes: string[],
  ): Promise<void> {
    const scopeSet = new Set(agentDataScopes)
    for (const reference of unique(references)) {
      if (runtimeIntrinsicTools.has(reference)) continue
      const { id, version } = parseReference(reference)
      const [row] = await this.database<{ allowedRoleIds: string[]; dataScopes: string[] }[]>`
        select t.allowed_role_ids as "allowedRoleIds", t.data_scopes as "dataScopes"
          from tools t
          join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
         where t.tenant_id = ${tenantId} and t.id = ${id} and tv.version = ${version}
      `
      if (!row) throw new Error(`工具授权配置不存在：${reference}`)
      const allowedRoleSet = new Set(row.allowedRoleIds)
      const unsupportedRoles = unique(visibleRoleIds).filter(roleId => !allowedRoleSet.has(roleId))
      if (unsupportedRoles.length) {
        throw new Error(`Agent 可见角色未被工具 ${reference} 授权：${unsupportedRoles.join('、')}`)
      }
      const missingScopes = unique(row.dataScopes).filter(scope => !scopeSet.has(scope))
      if (missingScopes.length) {
        throw new Error(`Agent 数据范围未覆盖工具 ${reference}：${missingScopes.join('、')}`)
      }
    }
  }

  async resolveRuntimeToolNames(references: string[]): Promise<string[]> {
    await this.assertAvailableReferences(references)
    const names: string[] = []
    for (const reference of unique(references)) {
      if (runtimeIntrinsicTools.has(reference)) { names.push(parseReference(reference).id); continue }
      const { id } = parseReference(reference)
      const [row] = await this.database<{ name: string }[]>`
        select dsh_tool_name as name from tools
         where tenant_id = ${tenantId} and id = ${id} and dsh_tool_name is not null
      `
      if (!row) throw new Error(`工具没有 DSH Runtime 映射：${reference}`)
      names.push(row.name)
    }
    return names
  }

  async resolveRuntimeApprovalMode(
    references: string[],
  ): Promise<RuntimeManifest['permission_policy']['approval_mode']> {
    await this.assertAvailableReferences(references)
    const policies: ToolDefinition['approvalPolicy'][] = []
    for (const reference of unique(references)) {
      if (runtimeIntrinsicTools.has(reference)) { policies.push('sensitive'); continue }
      const { id, version } = parseReference(reference)
      const [row] = await this.database<{ approvalPolicy: ToolDefinition['approvalPolicy'] }[]>`
        select t.approval_policy as "approvalPolicy" from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
         where t.tenant_id = ${tenantId} and t.id = ${id} and tv.version = ${version}
           and tv.status = 'published'
      `
      if (!row) throw new Error(`工具审批策略不存在：${reference}`)
      policies.push(row.approvalPolicy)
    }
    if (policies.includes('always')) return 'always'
    if (policies.includes('sensitive')) return 'risk_based'
    return 'never'
  }

  private async requireTool(toolId: string) {
    const tool = (await this.getTools()).find(item => item.id === toolId)
    if (!tool) throw new Error(`工具不存在：${toolId}`)
    return tool
  }

  private async requireConnector(connectorId: string) {
    const connector = (await this.getConnectors()).find(item => item.id === connectorId)
    if (!connector) throw new Error(`连接器不存在：${connectorId}`)
    return connector
  }

  private async requireActor(userId: string) {
    const [actor] = await this.database<{ id: string }[]>`
      select u.id from users u
       where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and exists (
           select 1 from user_roles ur
           join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
            where ur.tenant_id = u.tenant_id and ur.user_id = u.id
              and (ur.valid_until is null or ur.valid_until > now())
              and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
         )
    `
    if (!actor) throw new Error(`操作人不存在、已停用或不是平台管理员：${userId}`)
    return actor
  }

  private async roleNameMap() {
    const rows = await this.database<{ id: string; name: string }[]>`
      select id, name from roles where tenant_id = ${tenantId}
    `
    return new Map(rows.map(row => [row.id, row.name]))
  }

  private audit(actorId: string, action: string, objectId: string, result: 'success' | 'failed', detail: string) {
    return this.operations?.appendAudit(actorId, action, objectId, result, `trace-tool-${randomUUID()}`, detail)
      ?? Promise.resolve()
  }
}

function toConnectorDefinition(row: ConnectorRow): ConnectorDefinition {
  return {
    id: row.id,
    name: row.name,
    system: row.system,
    status: row.status,
    toolCount: row.toolCount,
    protocol: row.protocol,
    endpoint: row.endpoint,
    authType: row.authType,
    credentialRef: row.credentialRef ?? '无独立凭据',
    scopeDescription: row.scopeDescription,
    latency: row.latencyMs === null ? '未检查' : `${row.latencyMs} ms`,
    lastCheckedAt: formatRelative(row.lastCheckedAt),
  }
}

function parseReference(reference: string) {
  const separator = reference.lastIndexOf('@')
  if (separator <= 0 || separator === reference.length - 1) throw new Error(`工具引用必须锁定版本：${reference}`)
  return { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function formatRelative(value: Date | null) {
  if (!value) return '未检查'
  const seconds = Math.max(0, Math.round((Date.now() - value.getTime()) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  return `${Math.floor(seconds / 3600)} 小时前`
}
