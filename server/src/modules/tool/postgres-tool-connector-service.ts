import { createHash, randomUUID } from 'node:crypto'

import {
  RUNTIME_INTRINSIC_TOOL_REFS,
  toolBindingDigest,
  type ManifestToolBinding,
  type ResolvedToolBinding,
  type ToolBindingSnapshot,
} from '../../domain/tool-binding.ts'
import type { AddToolInput, ConnectorDefinition, McpInvocationAudit, RegisterMcpConnectorInput, ToolCatalogCandidate, ToolDefinition } from '../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import { authorizationDenied } from '../authorization/authorization-errors.ts'
import type { AgentRuntimePort, McpConnectionSnapshot, McpInspectionResult, McpRuntimeConnection, RuntimeManifest } from '../runtime/runtime-types.ts'
import {
  assertDshToolApprovalPolicy,
  dshBuiltInToolCatalog,
  normalizeToolPolicyInput,
  publicCatalogCandidate,
  requiredDshToolApprovalPolicy,
  runtimeToolToCatalogEntry,
  type CatalogEntry,
} from './dsh-built-in-tool-catalog.ts'

const tenantId = 'tenant-dsh-work'
const hiddenRuntimeCatalogTools = new Set(['activate_skill', 'prepare_skill_installation', 'python_execute'])
/** 平台拥有的绑定记录在非管理员上下文首次物化时归属到 bootstrap 平台管理员。 */
const PLATFORM_BOOTSTRAP_ACTOR = 'U00008'

interface BindingRow {
  id: string
  toolId: string
  toolVersion: string
  revision: number
  connectorId: string
  executor: string
  endpoint: string
  credentialRef: string | null
  identityPolicy: string
  environment: string
  allowedRoleIds: string[]
  dataScopes: string[]
  approvalPolicy: string
  contentDigest: string
  status: 'active' | 'superseded' | 'revoked'
  createdAt: Date
}

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
  outputValidation: ToolDefinition['outputValidation']
  retryPolicy: ToolDefinition['retryPolicy']
  concurrencyPolicy: ToolDefinition['concurrencyPolicy']
  completionSemantics: ToolDefinition['completionSemantics']
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

interface McpProfileRow {
  connectorId: string
  serverName: string
  transport: 'streamable-http'
  approvalStatus: NonNullable<ConnectorDefinition['mcp']>['approvalStatus']
  capabilityDigest: string | null
  approvedDigest: string | null
  capabilitySnapshot: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  discoveredAt: Date | null
  reviewedAt: Date | null
  reviewedBy: string | null
  grantedAgentIds: string[]
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
             tv.output_validation as "outputValidation", tv.retry_policy as "retryPolicy",
             tv.concurrency_policy as "concurrencyPolicy", tv.completion_semantics as "completionSemantics",
             t.timeout_seconds as "timeoutSeconds", t.allowed_role_ids as "allowedRoleIds",
             t.data_scopes as "dataScopes", t.approval_policy as "approvalPolicy",
             t.last_checked_at as "lastCheckedAt"
        from tools t
        join lateral (
          select version, risk_level, input_schema, output_schema, output_validation,
                 retry_policy, concurrency_policy, completion_semantics
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
      outputValidation: row.outputValidation,
      retryPolicy: row.retryPolicy,
      concurrencyPolicy: row.concurrencyPolicy,
      completionSemantics: row.completionSemantics,
      timeoutSeconds: row.timeoutSeconds,
      allowedRoles: row.allowedRoleIds.map(id => roleNames.get(id) ?? id),
      dataScopes: row.dataScopes,
      approvalPolicy: row.approvalPolicy,
      lastCheckedAt: formatRelative(row.lastCheckedAt),
    }))
  }

  async getToolCatalog(): Promise<ToolCatalogCandidate[]> {
    const installedRows = await this.database<{ id: string }[]>`
      select id from tools where tenant_id = ${tenantId}
    `
    const installed = new Set(installedRows.map(row => row.id))
    let runtimeAvailable = false
    let runtimeMessage = 'DSH Runtime 未配置，暂时不能添加工具'
    let entries: readonly CatalogEntry[] = dshBuiltInToolCatalog
    if (this.runtime) {
      try {
        const health = await this.runtime.health()
        runtimeAvailable = health.status === 'healthy' && health.acceptingRuns
        runtimeMessage = runtimeAvailable ? '当前 DSH Profile 已加载该工具' : health.message
        if (runtimeAvailable) entries = await this.loadRuntimeCatalogEntries()
      } catch (cause) {
        runtimeAvailable = false
        runtimeMessage = cause instanceof Error ? cause.message : 'DSH Runtime 工具目录读取失败'
      }
    }
    return entries.map(entry => {
      if (!entry.platformSupported) {
        const prefix = installed.has(entry.id) ? '该工具已安装但不可授权：' : ''
        return publicCatalogCandidate(entry, 'unavailable', `${prefix}${entry.unsupportedReason ?? '平台尚未接入该工具'}`)
      }
      if (installed.has(entry.id)) return publicCatalogCandidate(entry, 'installed', '已添加到工具目录')
      return publicCatalogCandidate(entry, runtimeAvailable ? 'ready' : 'unavailable', runtimeMessage)
    }).sort((left, right) => {
      const rank = { ready: 0, installed: 1, unavailable: 2 }
      return rank[left.status] - rank[right.status] || left.name.localeCompare(right.name, 'zh-CN')
    })
  }

  async addTool(input: AddToolInput): Promise<ToolDefinition> {
    const actor = await this.requireActor(input.actor)
    const policy = normalizeToolPolicyInput(input)
    const entry = (await this.loadRuntimeCatalogEntries()).find(item => item.id === input.catalogId)
    if (!entry) throw new Error(`不支持添加该 DSH 工具：${input.catalogId}`)
    if (!entry.platformSupported) throw new Error(entry.unsupportedReason ?? `平台尚未接入该工具：${input.catalogId}`)
    assertDshToolApprovalPolicy(entry, policy.approvalPolicy)
    const candidate = (await this.getToolCatalog()).find(item => item.id === entry.id)
    if (candidate?.status === 'installed') throw new Error(`工具已存在：${entry.name}`)
    if (candidate?.status !== 'ready') throw new Error(candidate?.availabilityMessage ?? '工具当前不可添加')
    const roleIds = await this.resolveRoleIds(policy.allowedRoles)

    await this.database.begin(async transaction => {
      const [connector] = await transaction<{ id: string }[]>`
        select id from connectors
         where tenant_id = ${tenantId} and id = ${entry.connectorId} and status = 'healthy'
      `
      if (!connector) throw new Error('DSH Runtime 连接器未处于健康状态，不能添加工具')
      const inserted = await transaction`
        insert into tools (
          id, tenant_id, key, name, source, status, connector_id, system, description,
          dsh_tool_name, mode, timeout_seconds, allowed_role_ids, data_scopes,
          approval_policy, last_checked_at
        ) values (
          ${entry.id}, ${tenantId}, ${`dsh-${entry.id}`}, ${entry.name}, 'platform', 'available',
          ${entry.connectorId}, ${entry.system}, ${entry.description}, ${entry.id}, ${entry.mode},
          ${entry.timeoutSeconds}, ${transaction.json(roleIds)}, ${transaction.json(policy.dataScopes)},
          ${policy.approvalPolicy}, now()
        ) on conflict do nothing returning id
      `
      if (!inserted.length) throw new Error(`工具已存在：${entry.name}`)
      await transaction`
        insert into tool_versions (
          id, tenant_id, tool_id, version, input_schema, output_schema, risk_level,
          output_validation, retry_policy, concurrency_policy, completion_semantics, status
        ) values (
          ${`tool-version-${entry.id}-1`}, ${tenantId}, ${entry.id}, ${entry.version},
          ${JSON.stringify(entry.inputSchemaObject)}::jsonb, ${JSON.stringify(entry.outputSchemaObject)}::jsonb,
          ${entry.risk}, ${entry.outputValidation}, ${entry.retryPolicy},
          ${entry.concurrencyPolicy}, ${entry.completionSemantics}, 'published'
        )
      `
      // 初始绑定修订：批准连接/凭据槽位/身份策略/授权范围的真实依据。
      await this.ensureToolBindingWithin(transaction, entry.id, entry.version, actor.id)
    })
    await this.audit(actor.id, 'tool.create', entry.id, 'success', `从 DSH 内置目录添加工具 ${entry.name}@${entry.version}`)
    return this.requireTool(entry.id)
  }

  private async loadRuntimeCatalogEntries(): Promise<readonly CatalogEntry[]> {
    if (!this.runtime?.listTools) return dshBuiltInToolCatalog
    const tools = await this.runtime.listTools()
    if (!tools.length) throw new Error('DSH Runtime 返回了空工具目录')
    return tools
      .filter(tool => !hiddenRuntimeCatalogTools.has(tool.id))
      .map(runtimeToolToCatalogEntry)
  }

  async getConnectors(): Promise<ConnectorDefinition[]> {
    const [rows, profiles] = await Promise.all([
      this.database<ConnectorRow[]>`
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
      `,
      this.database<McpProfileRow[]>`
        select p.connector_id as "connectorId", p.server_name as "serverName", p.transport,
               p.approval_status as "approvalStatus", p.capability_digest as "capabilityDigest",
               p.approved_digest as "approvedDigest", p.capability_snapshot as "capabilitySnapshot",
               p.discovered_at as "discoveredAt", p.reviewed_at as "reviewedAt",
               reviewer.display_name as "reviewedBy",
               coalesce(array_agg(g.agent_id order by g.agent_id) filter (where g.status = 'active'), '{}') as "grantedAgentIds"
          from mcp_connector_profiles p
          left join users reviewer on reviewer.tenant_id = p.tenant_id and reviewer.id = p.reviewed_by
          left join agent_mcp_grants g on g.tenant_id = p.tenant_id and g.connector_id = p.connector_id
         where p.tenant_id = ${tenantId}
         group by p.tenant_id, p.connector_id, reviewer.display_name
      `,
    ])
    const profileByConnector = new Map(profiles.map(profile => [profile.connectorId, profile]))
    return rows.map(row => toConnectorDefinition(row, profileByConnector.get(row.id)))
  }

  async registerMcpConnector(input: RegisterMcpConnectorInput): Promise<ConnectorDefinition> {
    const actor = await this.requireActor(input.actor)
    const id = normalizeConnectorId(input.id)
    const serverName = input.serverName.trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) throw new Error('MCP serverName 必须为 1-32 位字母、数字、下划线或连字符')
    const endpoint = normalizeMcpEndpoint(input.endpoint)
    if (!input.name.trim() || !input.system.trim() || !input.scopeDescription.trim()) throw new Error('连接器名称、系统和范围说明不能为空')
    if (!['none', 'bearer'].includes(input.authType)) throw new Error('MCP 仅支持 none 或 bearer 认证')
    const credentialRef = input.credentialRef?.trim() ?? ''
    if (input.authType === 'bearer' && !credentialRef) throw new Error('Bearer MCP 必须提供受管凭据引用')
    if (credentialRef && !/^DSH_MCP_CREDENTIAL_[A-Z0-9_]{1,80}$/.test(credentialRef)) {
      throw new Error('MCP 受管凭据引用必须使用 DSH_MCP_CREDENTIAL_ 前缀')
    }
    if (credentialRef && !process.env[credentialRef]?.trim()) throw new Error(`受管凭据引用尚未在运行环境配置：${credentialRef}`)

    await this.database.begin(async transaction => {
      let credentialId: string | null = null
      if (credentialRef) {
        const [credential] = await transaction<{ id: string }[]>`
          insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by)
          values (${`credential-mcp-${randomUUID()}`}, ${tenantId}, 'dsh-managed', ${credentialRef}, 'configured', now(), ${actor.id})
          on conflict (tenant_id, backend, external_ref) do update
            set status = 'configured', last_verified_at = now(), updated_by = excluded.updated_by, updated_at = now()
          returning id
        `
        credentialId = credential!.id
      }
      await transaction`
        insert into connectors (
          id, tenant_id, key, name, connector_type, credential_ref_id, status,
          system, protocol, endpoint, auth_type, scope_description, updated_at
        ) values (
          ${id}, ${tenantId}, ${serverName}, ${input.name.trim()}, 'mcp', ${credentialId}, 'degraded',
          ${input.system.trim()}, 'mcp', ${endpoint}, ${input.authType}, ${input.scopeDescription.trim()}, now()
        )
      `
      await transaction`
        insert into mcp_connector_profiles (tenant_id, connector_id, server_name)
        values (${tenantId}, ${id}, ${serverName})
      `
    })
    await this.audit(actor.id, 'connector.mcp.register', id, 'success', '登记 Streamable HTTP MCP Connector；等待发现与整体审核')
    return this.requireConnector(id)
  }

  async approveMcpConnector(input: { connectorId: string; capabilityDigest: string; actor: string }): Promise<ConnectorDefinition> {
    const actor = await this.requireActor(input.actor)
    let approvedCount = 0
    await this.database.begin(async transaction => {
      const [profile] = await transaction<{ digest: string | null; count: number; connectorStatus: string }[]>`
        select p.capability_digest as digest, jsonb_array_length(p.capability_snapshot)::int as count,
               c.status as "connectorStatus"
          from mcp_connector_profiles p
          join connectors c on c.tenant_id = p.tenant_id and c.id = p.connector_id
         where p.tenant_id = ${tenantId} and p.connector_id = ${input.connectorId}
         for update of p, c
      `
      if (!profile?.digest || profile.count < 1) throw new Error('MCP 尚未成功发现 Tool，不能审核')
      if (profile.connectorStatus === 'offline') throw new Error('MCP 当前离线，不能审核')
      if (profile.digest !== input.capabilityDigest) throw new Error('MCP 能力清单已变化，请刷新并重新审核')
      approvedCount = profile.count
      await transaction`
        update mcp_connector_profiles
           set approval_status = 'approved', approved_digest = capability_digest,
               reviewed_by = ${actor.id}, reviewed_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and connector_id = ${input.connectorId}
      `
      await transaction`
        update connectors
           set status = case when status = 'disabled' then 'disabled' else 'healthy' end,
               updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.connectorId} and protocol = 'mcp'
      `
    })
    await this.audit(actor.id, 'connector.mcp.approve', input.connectorId, 'success', `按连接器整体审核 ${approvedCount} 个 MCP Tool`)
    return this.requireConnector(input.connectorId)
  }

  async setMcpConnectorStatus(input: { connectorId: string; status: 'enabled' | 'disabled'; actor: string }): Promise<ConnectorDefinition> {
    const actor = await this.requireActor(input.actor)
    const connector = await this.requireConnector(input.connectorId)
    if (connector.protocol !== 'mcp' || !connector.mcp) throw new Error('目标不是 MCP Connector')
    if (input.status === 'enabled' && (connector.mcp.approvalStatus !== 'approved'
      || connector.mcp.capabilityDigest !== connector.mcp.approvedDigest)) {
      throw new Error('MCP 当前能力清单尚未审核，不能启用')
    }
    await this.database`
      update connectors set status = ${input.status === 'enabled' ? 'healthy' : 'disabled'}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${input.connectorId}
    `
    await this.audit(actor.id, `connector.mcp.${input.status}`, input.connectorId, 'success', `MCP Connector 已${input.status === 'enabled' ? '启用' : '停用'}`)
    return this.requireConnector(input.connectorId)
  }

  async setAgentMcpAccess(input: { connectorId: string; agentId: string; enabled: boolean; actor: string }): Promise<ConnectorDefinition> {
    const actor = await this.requireActor(input.actor)
    const connector = await this.requireConnector(input.connectorId)
    if (connector.protocol !== 'mcp' || !connector.mcp) throw new Error('目标不是 MCP Connector')
    if (input.enabled && (connector.status !== 'healthy' || connector.mcp.approvalStatus !== 'approved'
      || connector.mcp.capabilityDigest !== connector.mcp.approvedDigest)) {
      throw new Error('只能向 Agent 授予已经整体审核且当前健康的 MCP Connector')
    }
    const [agent] = await this.database<{ id: string }[]>`
      select id from agents where tenant_id = ${tenantId} and id = ${input.agentId}
    `
    if (!agent) throw new Error(`Agent 不存在：${input.agentId}`)
    await this.database`
      insert into agent_mcp_grants (
        tenant_id, agent_id, connector_id, status, granted_by, granted_at, revoked_by, revoked_at, updated_at
      ) values (
        ${tenantId}, ${input.agentId}, ${input.connectorId}, ${input.enabled ? 'active' : 'revoked'},
        ${actor.id}, now(), ${input.enabled ? null : actor.id}, ${input.enabled ? null : new Date()}, now()
      )
      on conflict (tenant_id, agent_id, connector_id) do update
        set status = excluded.status,
            granted_by = case when excluded.status = 'active' then excluded.granted_by else agent_mcp_grants.granted_by end,
            granted_at = case when excluded.status = 'active' then now() else agent_mcp_grants.granted_at end,
            revoked_by = excluded.revoked_by, revoked_at = excluded.revoked_at, updated_at = now()
    `
    await this.audit(actor.id, input.enabled ? 'connector.mcp.agent.grant' : 'connector.mcp.agent.revoke', input.connectorId, 'success', `${input.agentId} ${input.enabled ? '获得' : '撤销'}整个 MCP Connector 使用权`)
    return this.requireConnector(input.connectorId)
  }

  async setToolStatus(input: { toolId: string; status: 'available' | 'disabled'; actor: string }) {
    const actor = await this.requireActor(input.actor)
    const [tool] = await this.database<{
      connectorStatus: ConnectorDefinition['status']
      connectorId: string | null
      dshToolName: string | null
    }[]>`
      select c.status as "connectorStatus", t.connector_id as "connectorId", t.dsh_tool_name as "dshToolName" from tools t
      join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
       where t.tenant_id = ${tenantId} and t.id = ${input.toolId}
    `
    if (!tool) throw new Error(`工具不存在：${input.toolId}`)
    if (input.status === 'available' && tool.connectorStatus !== 'healthy') {
      throw new Error('连接器未处于健康状态，不能启用工具')
    }
    if (input.status === 'available'
      && tool.connectorId === 'connector-dsh-workspace'
      && tool.dshToolName
      && requiredDshToolApprovalPolicy(tool.dshToolName) === undefined) {
      throw new Error('该 DSH 工具所需的逐次审批尚未接入，不能启用')
    }
    await this.database.begin(async transaction => {
      await transaction`
        update tools set status = ${input.status}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.toolId}
      `
      if (input.status === 'disabled') {
        // 停用即撤销绑定：固定到该修订的在途/排队执行在下一次复核中失败。
        await this.revokeToolBindings(input.toolId, transaction)
      } else {
        // 重新启用不复活被撤销的修订：按当前配置为全部已发布版本物化新的 active 修订。
        for (const { version } of await this.publishedToolVersions(transaction, input.toolId)) {
          await this.ensureToolBindingWithin(transaction, input.toolId, version, actor.id)
        }
      }
    })
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
    const [current] = await this.database<{ connectorId: string | null; dshToolName: string | null }[]>`
      select connector_id as "connectorId", dsh_tool_name as "dshToolName"
        from tools where tenant_id = ${tenantId} and id = ${input.toolId}
    `
    if (!current) throw new Error(`工具不存在：${input.toolId}`)
    if (current.connectorId === 'connector-dsh-workspace' && current.dshToolName) {
      const requiredPolicy = requiredDshToolApprovalPolicy(current.dshToolName)
      if (requiredPolicy === undefined) throw new Error('该 DSH 工具尚未接入所需的逐次审批，不能配置为可用')
      if (input.approvalPolicy !== requiredPolicy) {
        throw new Error('DSH 内置工具的审批策略由平台安全策略固定，不能在权限页面覆盖')
      }
    }
    const roleIds = await this.resolveRoleIds(input.allowedRoles)
    await this.database.begin(async transaction => {
      const result = await transaction<{ status: string }[]>`
        update tools set allowed_role_ids = ${transaction.json(roleIds)},
                         data_scopes = ${transaction.json(unique(input.dataScopes))},
                         approval_policy = ${input.approvalPolicy}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.toolId}
         returning status
      `
      if (!result.length) throw new Error(`工具不存在：${input.toolId}`)
      // 授权角色/数据范围/审批策略属绑定语义：变更对全部已发布版本产生新修订，
      // 旧发布依据随之失效，不能只轮换最新版本而留下名义上仍 active 的陈旧行。
      // 已停用工具的绑定早已撤销，不重新物化。
      if (result[0]!.status !== 'disabled') {
        for (const { version } of await this.publishedToolVersions(transaction, input.toolId)) {
          await this.ensureToolBindingWithin(transaction, input.toolId, version, actor.id)
        }
      }
    })
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
    let capabilities: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> | undefined
    if (connector.protocol === 'mcp') {
      if (!this.runtime?.inspectMcpConnection) {
        message = '当前 DSH Runtime 未接入 MCP 检查能力'
      } else {
        try {
          const runtimeConnection = await this.resolveMcpRuntimeConnection(input.connectorId)
          const inspected = await this.runtime.inspectMcpConnection(runtimeConnection)
          capabilities = normalizeMcpCapabilities(inspected.capabilities)
          status = 'degraded'
          message = `已通过 DSH 发现 ${capabilities.length} 个 MCP Tool，等待整体审核`
        } catch (error) {
          status = 'offline'
          message = error instanceof Error ? error.message : 'MCP 发现失败'
        }
      }
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    await this.database.begin(async transaction => {
      if (connector.protocol === 'mcp' && capabilities) {
        const digest = mcpCapabilityDigest(capabilities)
        const [profile] = await transaction<{ approvalStatus: McpProfileRow['approvalStatus']; approvedDigest: string | null }[]>`
          select approval_status as "approvalStatus", approved_digest as "approvedDigest"
            from mcp_connector_profiles
           where tenant_id = ${tenantId} and connector_id = ${input.connectorId}
           for update
        `
        if (!profile) throw new Error('MCP Connector 缺少治理配置')
        const unchangedApproval = profile.approvalStatus === 'approved' && profile.approvedDigest === digest
        const approvalStatus = unchangedApproval
          ? 'approved'
          : profile.approvedDigest === null ? 'pending_review' : 'changes_pending'
        status = unchangedApproval ? 'healthy' : 'degraded'
        message = unchangedApproval
          ? `MCP 整体审核摘要保持一致，共 ${capabilities.length} 个 Tool`
          : profile.approvedDigest === null
            ? `已发现 ${capabilities.length} 个 MCP Tool，等待整体审核`
            : `MCP 能力清单已变化，共 ${capabilities.length} 个 Tool，需要重新审核`
        await transaction`
          update mcp_connector_profiles
             set capability_snapshot = ${transaction.json(asJson(capabilities))}, capability_digest = ${digest},
                 approval_status = ${approvalStatus}, discovered_at = now(), updated_at = now()
           where tenant_id = ${tenantId} and connector_id = ${input.connectorId}
        `
      }
      const [lockedConnector] = await transaction<{ status: ConnectorDefinition['status'] }[]>`
        select status from connectors
         where tenant_id = ${tenantId} and id = ${input.connectorId}
         for update
      `
      if (!lockedConnector) throw new Error(`连接器不存在：${input.connectorId}`)
      const connectorStatus = lockedConnector.status === 'disabled' ? 'disabled' : status
      if (lockedConnector.status === 'disabled') message = `${message}；连接器保持人工停用，需显式启用`
      await transaction`
        update connectors set status = ${connectorStatus}, latency_ms = ${latencyMs},
                              last_checked_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.connectorId}
      `
      await transaction`
        update tools set status = case when ${connectorStatus} = 'healthy' and status = 'degraded' then 'available'
                                       when ${connectorStatus} <> 'healthy' and status = 'available' then 'degraded'
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

  /** Agent version only selects its owning Agent. Grants remain outside Agent Version/release data. */
  async resolveMcpConnectionsForAgentVersion(versionId: string): Promise<McpConnectionSnapshot[]> {
    const rows = await this.database<Array<McpConnectionSnapshot & { credentialStatus: string | null }>>`
      select c.id as connector_id, p.server_name, p.transport, c.endpoint,
             c.auth_type as auth_type, p.capability_digest as capability_digest,
             cr.status as "credentialStatus"
        from agent_versions av
        join agent_mcp_grants g on g.tenant_id = av.tenant_id and g.agent_id = av.agent_id and g.status = 'active'
        join connectors c on c.tenant_id = g.tenant_id and c.id = g.connector_id
        join mcp_connector_profiles p on p.tenant_id = c.tenant_id and p.connector_id = c.id
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
       where av.tenant_id = ${tenantId} and av.id = ${versionId}
         and c.protocol = 'mcp' and c.status = 'healthy'
         and p.approval_status = 'approved' and p.capability_digest = p.approved_digest
       order by p.server_name
    `
    return rows.map(row => {
      if (row.auth_type === 'bearer' && row.credentialStatus !== 'configured') {
        throw new Error(`MCP Connector 凭据不可用：${row.connector_id}`)
      }
      const { credentialStatus: _credentialStatus, ...snapshot } = row
      return snapshot
    })
  }

  async assertActiveMcpConnections(pins: McpConnectionSnapshot[], agentVersionId: string): Promise<void> {
    const current = await this.resolveMcpConnectionsForAgentVersion(agentVersionId)
    const byId = new Map(current.map(connection => [connection.connector_id, connection]))
    for (const pin of pins) {
      const connection = byId.get(pin.connector_id)
      if (!connection || !sameMcpConnectionSnapshot(connection, pin)) {
        throw authorizationDenied(`固定的 MCP Connector 授权已撤销或能力摘要已变化：${pin.connector_id}`)
      }
    }
  }

  async resolveMcpRuntimeConnections(manifest: RuntimeManifest): Promise<McpRuntimeConnection[]> {
    const pins = manifest.mcp_connections ?? []
    if (!pins.length) return []
    if (!manifest.agent_version_id) throw authorizationDenied('MCP 只允许绑定到具体 Agent 的运行')
    await this.assertActiveMcpConnections(pins, manifest.agent_version_id)
    return Promise.all(pins.map(pin => this.resolveMcpRuntimeConnection(pin.connector_id, pin)))
  }

  async recordMcpInvocation(manifest: RuntimeManifest, input: {
    serverName: string
    callId: string
    capabilityName: string
    parameterDigest: string
    result: 'success' | 'failed' | 'unknown'
  }): Promise<void> {
    const pin = manifest.mcp_connections?.find(connection => connection.server_name === input.serverName)
    if (!pin) throw authorizationDenied(`MCP 调用不属于当前 Attempt 授权：${input.serverName}`)
    await this.database`
      insert into mcp_invocation_audits (
        id, tenant_id, run_id, attempt_id, connector_id, actor_user_id,
        call_id, capability_name, parameter_digest, result
      ) values (
        ${`mcp-audit-${randomUUID()}`}, ${tenantId}, ${manifest.run_id}, ${manifest.attempt_id},
        ${pin.connector_id}, ${manifest.user_context.user_id}, ${input.callId}, ${input.capabilityName},
        ${input.parameterDigest}, ${input.result}
      )
      on conflict (tenant_id, attempt_id, call_id) do update
        set result = excluded.result, occurred_at = now()
    `
  }

  async listMcpInvocationAudits(connectorId: string): Promise<McpInvocationAudit[]> {
    const [connector] = await this.database<{ id: string }[]>`
      select id from connectors
       where tenant_id = ${tenantId} and id = ${connectorId} and protocol = 'mcp'
    `
    if (!connector) throw new Error(`MCP Connector 不存在：${connectorId}`)
    return this.database<McpInvocationAudit[]>`
      select id, run_id as "runId", attempt_id as "attemptId", connector_id as "connectorId",
             actor_user_id as "actorUserId", capability_name as "capabilityName",
             parameter_digest as "parameterDigest", result, occurred_at as "occurredAt"
        from mcp_invocation_audits
       where tenant_id = ${tenantId} and connector_id = ${connectorId}
       order by occurred_at desc
       limit 50
    `
  }

  private async resolveMcpRuntimeConnection(connectorId: string, expected?: McpConnectionSnapshot): Promise<McpRuntimeConnection> {
    const [row] = await this.database<{
      connectorId: string; serverName: string; transport: 'streamable-http'; endpoint: string;
      authType: 'none' | 'bearer'; capabilityDigest: string | null; capabilitySnapshot: McpInspectionResult['capabilities']; approvalStatus: string;
      connectorStatus: string; credentialRef: string | null; credentialStatus: string | null
    }[]>`
      select c.id as "connectorId", p.server_name as "serverName", p.transport, c.endpoint,
             c.auth_type as "authType", p.capability_digest as "capabilityDigest",
             p.capability_snapshot as "capabilitySnapshot",
             p.approval_status as "approvalStatus", c.status as "connectorStatus",
             cr.external_ref as "credentialRef", cr.status as "credentialStatus"
        from connectors c
        join mcp_connector_profiles p on p.tenant_id = c.tenant_id and p.connector_id = c.id
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
       where c.tenant_id = ${tenantId} and c.id = ${connectorId} and c.protocol = 'mcp'
    `
    if (!row) throw new Error(`MCP Connector 不存在：${connectorId}`)
    if (expected && (row.connectorStatus !== 'healthy' || row.approvalStatus !== 'approved'
      || row.capabilityDigest !== expected.capability_digest || row.serverName !== expected.server_name
      || row.endpoint !== expected.endpoint || row.authType !== expected.auth_type)) {
      throw authorizationDenied(`MCP Connector 当前配置与 Attempt 快照不一致：${connectorId}`)
    }
    const snapshot: McpConnectionSnapshot = expected ?? {
      connector_id: row.connectorId,
      server_name: row.serverName,
      transport: row.transport,
      endpoint: row.endpoint,
      auth_type: row.authType,
      capability_digest: row.capabilityDigest ?? '0'.repeat(64),
    }
    const headers: Record<string, string> = {}
    if (row.authType === 'bearer') {
      if (row.credentialStatus !== 'configured' || !row.credentialRef) throw new Error('MCP Bearer 凭据引用不可用')
      const secret = process.env[row.credentialRef]
      if (!secret?.trim()) throw new Error(`MCP 受管凭据未在运行环境提供：${row.credentialRef}`)
      headers['Authorization'] = `Bearer ${secret.trim()}`
    }
    return {
      snapshot,
      headers,
      ...(expected ? { capabilities: normalizeMcpCapabilities(row.capabilitySnapshot) } : {}),
    }
  }

  async assertAvailableReferences(references: string[]): Promise<void> {
    return this.assertReferences(references, true)
  }

  /** Draft storage is not execution: allow unhealthy connectors, never unknown/disabled tools or unpublished versions. */
  async assertDraftReferences(references: string[], sql: DatabaseClient | DatabaseTransaction = this.database): Promise<void> {
    return this.assertReferences(references, false, sql)
  }

  private async assertReferences(references: string[], requireHealthy: boolean, sql: DatabaseClient | DatabaseTransaction = this.database): Promise<void> {
    for (const reference of unique(references)) {
      if (RUNTIME_INTRINSIC_TOOL_REFS.has(reference)) continue
      const { id, version } = parseReference(reference)
      const [row] = await sql<{ id: string }[]>`
        select tv.id from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
        join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
         where t.tenant_id = ${tenantId} and t.id = ${id}
           and (t.mode = 'read' or (t.mode = 'write' and t.connector_id = 'connector-dsh-workspace'
                and t.dsh_tool_name in ('write', 'edit', 'todo_write', 'create_goal', 'update_goal')))
           and ${requireHealthy ? sql` t.status = 'available' and c.status = 'healthy'` : sql`t.status in ('available', 'degraded')`}
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
      if (RUNTIME_INTRINSIC_TOOL_REFS.has(reference)) continue
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
      if (RUNTIME_INTRINSIC_TOOL_REFS.has(reference)) { names.push(parseReference(reference).id); continue }
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
      if (RUNTIME_INTRINSIC_TOOL_REFS.has(reference)) { policies.push('none'); continue }
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

  /* ---------- 绑定修订（B-03 / I-04） ---------- */

  /**
   * 解析平台工具引用的当前绑定修订：首次解析或语义字段漂移时在 tools 行锁下
   * 物化/轮换修订，保证返回的 active 修订摘要始终等于当前真实配置。包/候选
   * 不得自带绑定——没有已发布版本或已停用工具的工具直接拒绝。
   */
  async resolveToolBindings(references: string[], actor = PLATFORM_BOOTSTRAP_ACTOR): Promise<ResolvedToolBinding[]> {
    const resolved: ResolvedToolBinding[] = []
    for (const reference of unique(references)) {
      if (RUNTIME_INTRINSIC_TOOL_REFS.has(reference)) continue
      const { id, version } = parseReference(reference)
      resolved.push(await this.ensureToolBinding(id, version, actor))
    }
    return resolved
  }

  /**
   * 执行期复核：Attempt Manifest 固定的每条绑定修订必须仍是 active、与当前
   * 真实配置摘要一致。撤销/被取代/语义漂移/绑定行缺失一律拒绝——固定清单
   * 不能覆盖当前收权。
   */
  async assertActiveToolBindings(pins: ManifestToolBinding[], db: DatabaseClient | DatabaseTransaction = this.database): Promise<void> {
    // 按 tool 排序取锁：并发事务锁定多个 tools 行时保持全局一致的锁序，避免死锁。
    for (const pin of [...pins].sort((a, b) => a.tool.localeCompare(b.tool))) {
      const { id, version } = parseReference(pin.tool)
      const [row] = await db<{ toolId: string; toolVersion: string; revision: number; contentDigest: string; status: string }[]>`
        select tool_id as "toolId", tool_version as "toolVersion", revision,
               content_digest as "contentDigest", status
          from tool_binding_revisions
         where tenant_id = ${tenantId} and id = ${pin.binding_id}
      `
      if (!row || row.status !== 'active' || row.toolId !== id || row.toolVersion !== version
        || row.revision !== pin.revision || row.contentDigest !== pin.digest) {
        throw authorizationDenied(`固定的工具绑定修订已失效或被撤销：${pin.tool}`)
      }
      // 持 tools 行锁复核当前快照：在发布/提交事务内与 updateToolPermissions、
      // setToolStatus 等写方串行化，杜绝“校验通过后被并发轮换”的发布竞态。
      const snapshot = await this.loadBindingSnapshot(db, id, version, true)
      if (!snapshot || toolBindingDigest(snapshot) !== pin.digest) {
        throw authorizationDenied(`工具绑定的当前配置已偏离固定修订：${pin.tool}`)
      }
    }
  }

  /** 管理端工具绑定视图：全部修订按工具与修订序号排列。 */
  async listToolBindings(): Promise<ResolvedToolBinding[]> {
    const rows = await this.database<BindingRow[]>`
      select id, tool_id as "toolId", tool_version as "toolVersion", revision,
             connector_id as "connectorId", executor, endpoint,
             credential_ref as "credentialRef", identity_policy as "identityPolicy",
             environment, allowed_role_ids as "allowedRoleIds", data_scopes as "dataScopes",
             approval_policy as "approvalPolicy", content_digest as "contentDigest",
             status, created_at as "createdAt"
        from tool_binding_revisions
       where tenant_id = ${tenantId}
       order by tool_id, revision
    `
    return rows.map(toResolvedBinding)
  }

  /**
   * 物化当前语义快照对应的 active 修订：无 active 修订或摘要漂移时取代旧行
   * 并插入新修订。tools 行锁串行化并发解析，唯一索引兜底同号冲突。
   */
  private async ensureToolBinding(
    toolId: string,
    toolVersion: string,
    actor: string,
    db?: DatabaseClient | DatabaseTransaction,
  ): Promise<ResolvedToolBinding> {
    if (db) return this.ensureToolBindingWithin(db, toolId, toolVersion, actor)
    return this.database.begin(tx => this.ensureToolBindingWithin(tx, toolId, toolVersion, actor))
  }

  private async ensureToolBindingWithin(
    db: DatabaseClient | DatabaseTransaction,
    toolId: string,
    toolVersion: string,
    actor: string,
  ): Promise<ResolvedToolBinding> {
      const loadCurrent = async () => {
        const [row] = await db<BindingRow[]>`
          select id, tool_id as "toolId", tool_version as "toolVersion", revision,
                 connector_id as "connectorId", executor, endpoint,
                 credential_ref as "credentialRef", identity_policy as "identityPolicy",
                 environment, allowed_role_ids as "allowedRoleIds", data_scopes as "dataScopes",
                 approval_policy as "approvalPolicy", content_digest as "contentDigest",
                 status, created_at as "createdAt"
            from tool_binding_revisions
           where tenant_id = ${tenantId} and tool_id = ${toolId} and tool_version = ${toolVersion}
             and status = 'active'
        `
        return row
      }
      // 快路径不加锁：活跃修订与当前快照一致时直接复用，避免每次派发都对 tools 行取写锁。
      const snapshot = await this.loadBindingSnapshot(db, toolId, toolVersion, false)
      if (!snapshot) throw new Error(`工具不存在、版本未发布或已停用，无法解析绑定：${toolId}@${toolVersion}`)
      const digest = toolBindingDigest(snapshot)
      const current = await loadCurrent()
      if (current?.contentDigest === digest) return toResolvedBinding(current)
      // 需要轮换：持 tools 行锁复核快照与活跃修订，与并发解析/语义变更串行化。
      const locked = await this.loadBindingSnapshot(db, toolId, toolVersion, true)
      if (!locked) throw new Error(`工具不存在、版本未发布或已停用，无法解析绑定：${toolId}@${toolVersion}`)
      const lockedDigest = toolBindingDigest(locked)
      const currentUnderLock = await loadCurrent()
      if (currentUnderLock?.contentDigest === lockedDigest) return toResolvedBinding(currentUnderLock)
      if (currentUnderLock) {
        await db`update tool_binding_revisions set status = 'superseded'
                  where tenant_id = ${tenantId} and id = ${currentUnderLock.id} and status = 'active'`
      }
      const [seq] = await db<{ next: number }[]>`
        select coalesce(max(revision), 0) + 1 as next
          from tool_binding_revisions
         where tenant_id = ${tenantId} and tool_id = ${toolId}
      `
      const [row] = await db<BindingRow[]>`
        insert into tool_binding_revisions (
          id, tenant_id, tool_id, tool_version, revision, connector_id, executor,
          endpoint, credential_ref, identity_policy, environment,
          allowed_role_ids, data_scopes, approval_policy, content_digest, status, created_by
        ) values (
          ${`tool-binding-${randomUUID()}`}, ${tenantId}, ${toolId}, ${toolVersion}, ${seq!.next},
          ${locked.connectorId}, ${locked.executor}, ${locked.endpoint}, ${locked.credentialRef},
          ${locked.identityPolicy}, ${locked.environment}, ${db.json(locked.allowedRoleIds)},
          ${db.json(locked.dataScopes)}, ${locked.approvalPolicy}, ${lockedDigest}, 'active', ${actor}
        )
        returning id, tool_id as "toolId", tool_version as "toolVersion", revision,
                  connector_id as "connectorId", executor, endpoint,
                  credential_ref as "credentialRef", identity_policy as "identityPolicy",
                  environment, allowed_role_ids as "allowedRoleIds", data_scopes as "dataScopes",
                  approval_policy as "approvalPolicy", content_digest as "contentDigest",
                  status, created_at as "createdAt"
      `
      return toResolvedBinding(row!)
  }

  /** 工具的全部已发布版本（新→旧）：语义变更需要为每个版本轮换绑定修订。 */
  private async publishedToolVersions(db: DatabaseClient | DatabaseTransaction, toolId: string) {
    return db<{ version: string }[]>`
      select version from tool_versions
       where tenant_id = ${tenantId} and tool_id = ${toolId} and status = 'published'
       order by created_at desc
    `
  }

  /** 撤销工具全部 active 绑定修订（停用/撤权路径）；重新启用由下一次解析物化新修订。 */
  private async revokeToolBindings(toolId: string, db: DatabaseClient | DatabaseTransaction = this.database) {
    await db`
      update tool_binding_revisions set status = 'revoked'
       where tenant_id = ${tenantId} and tool_id = ${toolId} and status = 'active'
    `
  }

  /**
   * 绑定语义快照的来源：tools + 指定已发布版本 + 连接器 + 凭据槽位。
   * 不含密钥值；端点/身份策略/授权范围任一变化都会改变 content_digest。
   */
  private async loadBindingSnapshot(
    db: DatabaseClient | DatabaseTransaction,
    toolId: string,
    toolVersion: string,
    lock = false,
  ): Promise<ToolBindingSnapshot | undefined> {
    const [row] = await db<{
      toolStatus: string
      connectorId: string
      protocol: string
      endpoint: string
      authType: string
      dshToolName: string | null
      credentialRef: string | null
      allowedRoleIds: string[]
      dataScopes: string[]
      approvalPolicy: string
    }[]>`
      select t.status as "toolStatus", c.id as "connectorId", c.protocol, c.endpoint,
             c.auth_type as "authType", t.dsh_tool_name as "dshToolName",
             cr.external_ref as "credentialRef",
             t.allowed_role_ids as "allowedRoleIds", t.data_scopes as "dataScopes",
             t.approval_policy as "approvalPolicy"
        from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
        join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
       where t.tenant_id = ${tenantId} and t.id = ${toolId}
         and tv.version = ${toolVersion} and tv.status = 'published'
       ${lock ? db`for update of t` : db``}
    `
    if (!row || row.toolStatus === 'disabled') return undefined
    return {
      toolId,
      toolVersion,
      connectorId: row.connectorId,
      executor: row.dshToolName ?? row.protocol,
      endpoint: row.endpoint,
      credentialRef: row.credentialRef,
      identityPolicy: row.authType,
      environment: 'default',
      allowedRoleIds: row.allowedRoleIds,
      dataScopes: row.dataScopes,
      approvalPolicy: row.approvalPolicy,
    }
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

  private async resolveRoleIds(values: string[]) {
    const roleIds: string[] = []
    for (const value of unique(values)) {
      const [role] = await this.database<{ id: string }[]>`
        select id from roles where tenant_id = ${tenantId} and (id = ${value} or name = ${value})
      `
      if (!role) throw new Error(`角色不存在：${value}`)
      roleIds.push(role.id)
    }
    return roleIds
  }

  private audit(actorId: string, action: string, objectId: string, result: 'success' | 'failed', detail: string) {
    return this.operations?.appendAudit(actorId, action, objectId, result, `trace-tool-${randomUUID()}`, detail)
      ?? Promise.resolve()
  }
}

function toResolvedBinding(row: BindingRow): ResolvedToolBinding {
  return {
    tool: `${row.toolId}@${row.toolVersion}`,
    bindingId: row.id,
    revision: row.revision,
    digest: row.contentDigest,
    connectorId: row.connectorId,
    executor: row.executor,
    endpoint: row.endpoint,
    credentialRef: row.credentialRef,
    identityPolicy: row.identityPolicy,
    environment: row.environment,
    approvalPolicy: row.approvalPolicy,
    status: row.status,
    sealedAt: row.createdAt.toISOString(),
  }
}

function toConnectorDefinition(row: ConnectorRow, profile?: McpProfileRow): ConnectorDefinition {
  const definition: ConnectorDefinition = {
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
  if (profile) {
    definition.mcp = {
      serverName: profile.serverName,
      transport: profile.transport,
      approvalStatus: profile.approvalStatus,
      capabilityDigest: profile.capabilityDigest,
      approvedDigest: profile.approvedDigest,
      capabilityCount: profile.capabilitySnapshot.length,
      capabilities: profile.capabilitySnapshot,
      grantedAgentIds: profile.grantedAgentIds,
      discoveredAt: profile.discoveredAt?.toISOString() ?? null,
      reviewedAt: profile.reviewedAt?.toISOString() ?? null,
      reviewedBy: profile.reviewedBy,
    }
  }
  return definition
}

function normalizeConnectorId(value: string) {
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('连接器标识格式无效')
  return id
}

function normalizeMcpEndpoint(value: string) {
  let endpoint: URL
  try { endpoint = new URL(value.trim()) }
  catch { throw new Error('MCP 服务地址必须是有效的 HTTP(S) URL') }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error('MCP 服务地址只能使用 HTTP(S)，且不得包含账号、密码、查询参数或片段')
  }
  return endpoint.toString()
}

function normalizeMcpCapabilities(
  capabilities: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
) {
  const names = new Set<string>()
  return capabilities.map(capability => {
    const name = capability.name.trim()
    if (!name || name.length > 200 || names.has(name)) throw new Error(`MCP 返回了无效或重复的 Tool 名称：${name || '空名称'}`)
    names.add(name)
    return {
      name,
      description: capability.description.trim().slice(0, 2000),
      inputSchema: JSON.parse(JSON.stringify(capability.inputSchema)) as Record<string, unknown>,
    }
  }).sort((left, right) => left.name.localeCompare(right.name))
}

function mcpCapabilityDigest(capabilities: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) {
  return createHash('sha256').update(JSON.stringify(capabilities)).digest('hex')
}

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value))

function sameMcpConnectionSnapshot(left: McpConnectionSnapshot, right: McpConnectionSnapshot) {
  return left.connector_id === right.connector_id
    && left.server_name === right.server_name
    && left.transport === right.transport
    && left.endpoint === right.endpoint
    && left.auth_type === right.auth_type
    && left.capability_digest === right.capability_digest
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
