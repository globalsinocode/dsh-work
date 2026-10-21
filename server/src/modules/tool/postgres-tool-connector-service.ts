import { createHash, randomUUID } from 'node:crypto'

import {
  toolBindingDigest,
  type ManifestToolBinding,
  type ResolvedToolBinding,
  type ToolBindingSnapshot,
} from '../../domain/tool-binding.ts'
import { DSH_RUNTIME_CONNECTOR_ID, DSH_WORK_EXECUTION_TOOL_REFS } from '../../domain/tool-category.ts'
import type { AddToolInput, ConnectorDefinition, DshRuntimeToolConnectorStatus, ToolCatalogCandidate, ToolCatalogSyncResult, ToolDefinition } from '../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { AuditTrail } from '../../domain/audit-trail.ts'
import { authorizationDenied } from '../../domain/authorization-errors.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../runtime/runtime-types.ts'
import { assertDshToolApprovalPolicy, dshBuiltInToolCatalog, defaultAgentDshToolNames, hiddenRuntimeCatalogTools, isVisibleDshCatalogTool, normalizeToolPolicyInput, publicCatalogCandidate, requiredDshToolApprovalPolicy, runtimeToolToCatalogEntry, type CatalogEntry } from './dsh-built-in-tool-catalog.ts'
import { isDefaultRunLocalAgentTool } from '../../domain/tool-category.ts'
import { requirePlatformAdminActor } from '../authorization/platform-admin-actor.ts'
import { dependencyUnavailable, invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'

const tenantId = 'tenant-dsh-work'
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
  dshToolName: string | null
  risk: ToolDefinition['risk']
  mode: ToolDefinition['mode']
  status: ToolDefinition['status']
  admissionStatus: NonNullable<ToolDefinition['admissionStatus']>
  admissionMessage: string
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
  lastHealthMessage: string | null
  toolCount: number
  createdAt: Date
  createdBy: string
  updatedAt: Date
}

export class PostgresToolConnectorService {
  private readonly database: DatabaseClient
  private readonly runtime?: AgentRuntimePort
  private readonly operations?: AuditTrail

  /** DSH 内置工具目录、工具权限与绑定修订；MCP 由 PostgresMcpConnectorService 管理。 */
  constructor(database: DatabaseClient, runtime?: AgentRuntimePort, operations?: AuditTrail) {
    this.database = database
    this.runtime = runtime
    this.operations = operations
  }

  async getTools(): Promise<ToolDefinition[]> {
    const rows = await this.database<ToolRow[]>`
      select t.id, tv.version, t.name, t.system, t.description,
             t.connector_id as "connectorId", t.dsh_tool_name as "dshToolName",
             tv.risk_level as risk, t.mode, t.status,
             t.admission_status as "admissionStatus", t.admission_message as "admissionMessage",
             tv.input_schema as "inputSchema", tv.output_schema as "outputSchema",
             tv.output_validation as "outputValidation", tv.retry_policy as "retryPolicy",
             tv.concurrency_policy as "concurrencyPolicy", tv.completion_semantics as "completionSemantics",
             t.timeout_seconds as "timeoutSeconds", t.allowed_role_ids as "allowedRoleIds",
             t.data_scopes as "dataScopes", t.approval_policy as "approvalPolicy",
             t.last_checked_at as "lastCheckedAt"
        from tools t
        join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
        join lateral (
          select version, risk_level, input_schema, output_schema, output_validation,
                 retry_policy, concurrency_policy, completion_semantics
            from tool_versions
           where tenant_id = t.tenant_id and tool_id = t.id and status = 'published'
           order by created_at desc limit 1
        ) tv on true
       where t.tenant_id = ${tenantId} and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
         and c.deleted_at is null
       order by t.name
    `
    const roleNames = await this.roleNameMap()
    return rows.filter(row => isVisibleDshCatalogTool(row.id)).map(row => ({
      id: row.id,
      version: row.version,
      name: row.name,
      system: row.system,
      description: row.description,
      connectorId: row.connectorId,
      risk: row.risk,
      mode: row.mode,
      status: row.status,
      admissionStatus: row.admissionStatus,
      admissionMessage: row.admissionMessage,
      inputSchema: JSON.stringify(row.inputSchema, null, 2),
      outputSchema: JSON.stringify(row.outputSchema, null, 2),
      outputValidation: row.outputValidation,
      retryPolicy: row.retryPolicy,
      concurrencyPolicy: row.concurrencyPolicy,
      completionSemantics: row.completionSemantics,
      timeoutSeconds: row.timeoutSeconds,
      allowedRoleIds: [...row.allowedRoleIds],
      allowedRoles: row.allowedRoleIds.map(id => roleNames.get(id) ?? id),
      dataScopes: row.dataScopes,
      agentRunLocalDefault: isDefaultRunLocalAgentTool({
        connectorId: row.connectorId,
        dshToolName: row.dshToolName,
        allowedRoleIds: row.allowedRoleIds,
        dataScopes: row.dataScopes,
      }),
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

  /**
   * Discover the current DSH Profile once and reconcile the complete result
   * into the platform inventory. Discovery never implies execution approval:
   * unadmitted tools are persisted as disabled, without an active binding.
   */
  async syncToolCatalog(input: { actor: string }): Promise<ToolCatalogSyncResult> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    if (!this.runtime?.listTools) throw dependencyUnavailable('DSH Runtime 未提供工具目录发现能力')
    const health = await this.runtime.health()
    if (health.status !== 'healthy' || !health.acceptingRuns) {
      throw dependencyUnavailable(health.message || 'DSH Runtime 当前不可用，无法同步工具目录')
    }
    const entries = await this.loadRuntimeCatalogEntries()
    const defaultRoleIds = new Map<string, string[]>()
    for (const entry of entries) {
      defaultRoleIds.set(entry.id, await this.resolveRoleIds(entry.defaultAllowedRoles))
    }

    await this.database.begin(async transaction => {
      const existingRows = await transaction<{
        id: string
        connectorId: string | null
        status: ToolDefinition['status']
        admissionStatus: NonNullable<ToolDefinition['admissionStatus']>
      }[]>`
        select id, connector_id as "connectorId", status,
               admission_status as "admissionStatus"
          from tools
         where tenant_id = ${tenantId}
      `
      const existingById = new Map(existingRows.map(row => [row.id, row]))
      const discoveredIds = new Set(entries.map(entry => entry.id))

      for (const row of existingRows) {
        if (row.connectorId !== DSH_RUNTIME_CONNECTOR_ID) continue
        const hidden = hiddenRuntimeCatalogTools.has(row.id)
        if (!hidden && discoveredIds.has(row.id)) continue
        await transaction`
          update tools
             set status = 'disabled', admission_status = 'unavailable',
                 admission_message = ${hidden
                   ? 'DSH 内部控制工具不进入普通工具授权目录'
                   : '当前 DSH Profile 已不再加载该工具'},
                 last_checked_at = now(), updated_at = now()
           where tenant_id = ${tenantId} and id = ${row.id}
        `
        await this.revokeToolBindings(row.id, transaction)
      }

      for (const entry of entries) {
        const existing = existingById.get(entry.id)
        if (existing && existing.connectorId !== DSH_RUNTIME_CONNECTOR_ID) {
          throw new Error(`DSH 工具标识与现有非 DSH 工具冲突：${entry.id}`)
        }
        const admissionStatus = entry.platformSupported ? 'approved' : 'unavailable'
        const admissionMessage = entry.platformSupported
          ? '已完成平台安全准入，可在 Agent 版本中授权'
          : entry.unsupportedReason ?? '平台尚未完成该工具的安全准入'
        const nextStatus: ToolDefinition['status'] = !entry.platformSupported
          ? 'disabled'
          : existing?.admissionStatus === 'unavailable'
            ? 'available'
            : existing?.status ?? 'available'
        const roleIds = defaultRoleIds.get(entry.id)!

        await transaction`
          insert into tools (
            id, tenant_id, key, name, source, status, connector_id, system, description,
            dsh_tool_name, mode, timeout_seconds, allowed_role_ids, data_scopes,
            approval_policy, admission_status, admission_message, last_checked_at
          ) values (
            ${entry.id}, ${tenantId}, ${`dsh-${entry.id}`}, ${entry.name}, 'platform', ${nextStatus},
            ${entry.connectorId}, ${entry.system}, ${entry.description}, ${entry.id}, ${entry.mode},
            ${entry.timeoutSeconds}, ${transaction.json(roleIds)}, ${transaction.json(entry.defaultDataScopes)},
            ${entry.defaultApprovalPolicy}, ${admissionStatus}, ${admissionMessage}, now()
          )
          on conflict (id) do update set
            name = excluded.name,
            system = excluded.system,
            description = excluded.description,
            dsh_tool_name = excluded.dsh_tool_name,
            mode = excluded.mode,
            timeout_seconds = excluded.timeout_seconds,
            approval_policy = excluded.approval_policy,
            admission_status = excluded.admission_status,
            admission_message = excluded.admission_message,
            status = excluded.status,
            last_checked_at = now(),
            updated_at = now()
          where tools.tenant_id = excluded.tenant_id
            and tools.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
        `

        const version = await this.ensureSynchronizedToolVersion(transaction, entry)
        if (!entry.platformSupported) {
          await this.revokeToolBindings(entry.id, transaction)
        } else if (nextStatus === 'available') {
          await this.ensureToolBindingWithin(transaction, entry.id, version, actor.id)
        }
      }
    })

    await this.audit(
      actor.id,
      'tool.catalog.sync',
      DSH_RUNTIME_CONNECTOR_ID,
      'success',
      `同步 DSH 工具目录：发现 ${entries.length} 个，可授权 ${entries.filter(entry => entry.platformSupported).length} 个`,
    )
    return {
      tools: await this.getTools(),
      discoveredCount: entries.length,
      admittedCount: entries.filter(entry => entry.platformSupported).length,
      unavailableCount: entries.filter(entry => !entry.platformSupported).length,
      synchronizedAt: new Date().toISOString(),
    }
  }

  async addTool(input: AddToolInput): Promise<ToolDefinition> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    const policy = normalizeToolPolicyInput(input)
    const entry = (await this.loadRuntimeCatalogEntries()).find(item => item.id === input.catalogId)
    if (!entry) throw invalidRequest(`不支持添加该 DSH 工具：${input.catalogId}`)
    if (!entry.platformSupported) throw invalidRequest(entry.unsupportedReason ?? `平台尚未接入该工具：${input.catalogId}`)
    assertDshToolApprovalPolicy(entry, policy.approvalPolicy)
    const candidate = (await this.getToolCatalog()).find(item => item.id === entry.id)
    if (candidate?.status === 'installed') throw stateConflict(`工具已存在：${entry.name}`)
    if (candidate?.status !== 'ready') throw stateConflict(candidate?.availabilityMessage ?? '工具当前不可添加')
    const roleIds = await this.resolveRoleIds(policy.allowedRoles)

    await this.database.begin(async transaction => {
      const [connector] = await transaction<{ id: string }[]>`
        select id from connectors
         where tenant_id = ${tenantId} and id = ${entry.connectorId} and status = 'healthy'
      `
      if (!connector) throw dependencyUnavailable('DSH Runtime 连接器未处于健康状态，不能添加工具')
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
      if (!inserted.length) throw stateConflict(`工具已存在：${entry.name}`)
      await transaction`
        insert into tool_versions (
          id, tenant_id, tool_id, version, input_schema, output_schema, risk_level,
          output_validation, retry_policy, concurrency_policy, completion_semantics, status
        ) values (
          ${`tool-version-${entry.id}-1`}, ${tenantId}, ${entry.id}, ${entry.version},
          ${transaction.json(asJson(entry.inputSchemaObject))}, ${transaction.json(asJson(entry.outputSchemaObject))},
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
    if (!tools.length) throw dependencyUnavailable('DSH Runtime 返回了空工具目录')
    return tools
      .filter(tool => isVisibleDshCatalogTool(tool.id))
      .map(runtimeToolToCatalogEntry)
  }

  private async ensureSynchronizedToolVersion(
    transaction: DatabaseTransaction,
    entry: CatalogEntry,
  ): Promise<string> {
    const versions = await transaction<{
      version: string
      inputSchema: unknown
      outputSchema: unknown
      risk: ToolDefinition['risk']
      outputValidation: ToolDefinition['outputValidation']
      retryPolicy: ToolDefinition['retryPolicy']
      concurrencyPolicy: ToolDefinition['concurrencyPolicy']
      completionSemantics: ToolDefinition['completionSemantics']
    }[]>`
      select version, input_schema as "inputSchema", output_schema as "outputSchema",
             risk_level as risk, output_validation as "outputValidation",
             retry_policy as "retryPolicy", concurrency_policy as "concurrencyPolicy",
             completion_semantics as "completionSemantics"
        from tool_versions
       where tenant_id = ${tenantId} and tool_id = ${entry.id} and status = 'published'
       order by created_at desc, version desc
    `
    const expectedDigest = synchronizedToolContractDigest({
      inputSchema: entry.inputSchemaObject,
      outputSchema: entry.outputSchemaObject,
      risk: entry.risk,
      outputValidation: entry.outputValidation,
      retryPolicy: entry.retryPolicy,
      concurrencyPolicy: entry.concurrencyPolicy,
      completionSemantics: entry.completionSemantics,
    })
    const matching = versions.find(version => synchronizedToolContractDigest(version) === expectedDigest)
    if (matching) return matching.version

    const nextVersion = versions.length
      ? `1.0.${Math.max(...versions.map(item => Number(/^1\.0\.(\d+)$/.exec(item.version)?.[1] ?? -1)), 0) + 1}`
      : entry.version
    await transaction`
      insert into tool_versions (
        id, tenant_id, tool_id, version, input_schema, output_schema, risk_level,
        output_validation, retry_policy, concurrency_policy, completion_semantics, status
      ) values (
        ${`tool-version-${randomUUID()}`}, ${tenantId}, ${entry.id}, ${nextVersion},
        ${transaction.json(asJson(entry.inputSchemaObject))}, ${transaction.json(asJson(entry.outputSchemaObject))},
        ${entry.risk}, ${entry.outputValidation}, ${entry.retryPolicy},
        ${entry.concurrencyPolicy}, ${entry.completionSemantics}, 'published'
      )
    `
    return nextVersion
  }

  private async getRuntimeConnector(): Promise<ConnectorDefinition> {
    const [row] = await this.database<ConnectorRow[]>`
      select c.id, c.name, c.system, c.status, c.protocol, c.endpoint,
             c.auth_type as "authType", cr.external_ref as "credentialRef",
             c.scope_description as "scopeDescription", c.latency_ms as "latencyMs",
             c.last_checked_at as "lastCheckedAt", hc.message as "lastHealthMessage",
             c.created_at as "createdAt", creator.display_name as "createdBy",
             c.updated_at as "updatedAt",
             count(t.id)::int as "toolCount"
        from connectors c
        join users creator on creator.tenant_id = c.tenant_id and creator.id = c.created_by
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
        left join tools t on t.tenant_id = c.tenant_id and t.connector_id = c.id
        left join lateral (
          select message
            from connector_health_checks
           where tenant_id = c.tenant_id and connector_id = c.id
           order by checked_at desc, id desc
           limit 1
        ) hc on true
       where c.tenant_id = ${tenantId} and c.id = ${DSH_RUNTIME_CONNECTOR_ID} and c.deleted_at is null
       group by c.id, cr.external_ref, hc.message, creator.display_name
    `
    if (!row) throw notFound('DSH Runtime 内置工具连接器不存在')
    return toConnectorDefinition(row)
  }

  async getDshRuntimeToolConnectorStatus(): Promise<DshRuntimeToolConnectorStatus> {
    const connector = await this.getRuntimeConnector()

    const [catalogRows, bindingRows, healthRows, liveHealth] = await Promise.all([
      this.database<{ id: string; version: string; status: string }[]>`
        select t.id, tv.version, t.status
          from tools t
          join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
         where t.tenant_id = ${tenantId}
           and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
           and tv.status = 'published'
         order by t.id, tv.version
      `,
      this.database<{ activeBindingCount: number; latestBindingRevision: number | null }[]>`
        select count(*) filter (where status = 'active')::integer as "activeBindingCount",
               max(revision) filter (where status = 'active')::integer as "latestBindingRevision"
          from tool_binding_revisions
         where tenant_id = ${tenantId} and connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
      `,
      this.database<{ message: string }[]>`
        select message
          from connector_health_checks
         where tenant_id = ${tenantId} and connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
         order by checked_at desc
         limit 1
      `,
      this.runtime?.health().catch(() => undefined),
    ])
    const bindings = bindingRows[0]
    return {
      runtimeId: liveHealth?.runtimeId ?? null,
      connectorId: connector.id,
      name: connector.name,
      status: connector.status,
      endpoint: connector.endpoint,
      toolCount: connector.toolCount,
      activeBindingCount: bindings?.activeBindingCount ?? 0,
      latestBindingRevision: bindings?.latestBindingRevision ?? null,
      catalogDigest: createHash('sha256').update(JSON.stringify(catalogRows)).digest('hex'),
      lastCheckedAt: connector.lastCheckedAt,
      lastHealthMessage: healthRows[0]?.message
        ?? (connector.status === 'disabled' ? '内置工具连接已人工停用。' : '尚无独立工具连接检查记录。'),
    }
  }

  async checkDshRuntimeToolConnector(input: { actor: string }): Promise<DshRuntimeToolConnectorStatus> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    const started = performance.now()
    let status: 'healthy' | 'degraded' | 'offline' = 'offline'
    let message = 'DSH Runtime 未配置'
    if (this.runtime) {
      const health = await this.runtime.health()
      status = health.status
      message = health.message
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    await this.database.begin(async transaction => {
      const [connector] = await transaction<{ status: ConnectorDefinition['status'] }[]>`
        select status from connectors
         where tenant_id = ${tenantId} and id = ${DSH_RUNTIME_CONNECTOR_ID} and deleted_at is null
         for update
      `
      if (!connector) throw notFound('DSH Runtime 内置工具连接器不存在')
      const connectorStatus = connector.status === 'disabled' ? 'disabled' : status
      if (connector.status === 'disabled') message = `${message}；连接器保持人工停用，需显式启用`
      await transaction`
        update connectors set status = ${connectorStatus}, latency_ms = ${latencyMs},
                              last_checked_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and id = ${DSH_RUNTIME_CONNECTOR_ID}
      `
      await transaction`
        update tools set status = case when ${connectorStatus} = 'healthy' and status = 'degraded' then 'available'
                                       when ${connectorStatus} <> 'healthy' and status = 'available' then 'degraded'
                                       else status end,
                         last_checked_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
      `
      await transaction`
        insert into connector_health_checks (
          id, tenant_id, connector_id, status, latency_ms, message, checked_by
        ) values (
          ${`connector-check-${randomUUID()}`}, ${tenantId}, ${DSH_RUNTIME_CONNECTOR_ID},
          ${status}, ${latencyMs}, ${message}, ${actor.id}
        )
      `
    })
    await this.audit(actor.id, 'connector.health.check', DSH_RUNTIME_CONNECTOR_ID, status === 'offline' ? 'failed' : 'success', message)
    return this.getDshRuntimeToolConnectorStatus()
  }


  async setToolStatus(input: { toolId: string; status: 'available' | 'disabled'; actor: string }) {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    const [tool] = await this.database<{
      connectorStatus: ConnectorDefinition['status']
      connectorId: string | null
      dshToolName: string | null
      admissionStatus: NonNullable<ToolDefinition['admissionStatus']>
      admissionMessage: string
    }[]>`
      select c.status as "connectorStatus", t.connector_id as "connectorId", t.dsh_tool_name as "dshToolName",
             t.admission_status as "admissionStatus", t.admission_message as "admissionMessage" from tools t
      join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
       where t.tenant_id = ${tenantId} and t.id = ${input.toolId}
    `
    if (!tool) throw notFound(`工具不存在：${input.toolId}`)
    if (tool.connectorId !== DSH_RUNTIME_CONNECTOR_ID) throw invalidRequest('普通工具管理只允许操作 DSH 内置工具')
    if (input.status === 'available' && tool.admissionStatus !== 'approved') {
      throw stateConflict(tool.admissionMessage || '该 DSH 工具尚未完成平台安全准入，不能启用')
    }
    if (input.status === 'available' && tool.connectorStatus !== 'healthy') {
      throw dependencyUnavailable('连接器未处于健康状态，不能启用工具')
    }
    if (input.status === 'available'
      && tool.connectorId === DSH_RUNTIME_CONNECTOR_ID
      && tool.dshToolName
      && requiredDshToolApprovalPolicy(tool.dshToolName) === undefined) {
      throw stateConflict('该 DSH 工具所需的逐次审批尚未接入，不能启用')
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
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    if (!input.allowedRoles.length || !input.dataScopes.length) throw invalidRequest('工具必须配置授权角色和数据范围')
    const [current] = await this.database<{
      connectorId: string | null
      dshToolName: string | null
      admissionStatus: NonNullable<ToolDefinition['admissionStatus']>
      admissionMessage: string
    }[]>`
      select connector_id as "connectorId", dsh_tool_name as "dshToolName",
             admission_status as "admissionStatus", admission_message as "admissionMessage"
        from tools where tenant_id = ${tenantId} and id = ${input.toolId}
    `
    if (!current) throw notFound(`工具不存在：${input.toolId}`)
    if (current.connectorId !== DSH_RUNTIME_CONNECTOR_ID) throw invalidRequest('普通工具管理只允许操作 DSH 内置工具')
    if (current.admissionStatus !== 'approved') {
      throw stateConflict(current.admissionMessage || '该 DSH 工具尚未完成平台安全准入，不能配置权限')
    }
    if (current.connectorId === DSH_RUNTIME_CONNECTOR_ID && current.dshToolName) {
      const requiredPolicy = requiredDshToolApprovalPolicy(current.dshToolName)
      if (requiredPolicy === undefined) throw stateConflict('该 DSH 工具尚未接入所需的逐次审批，不能配置为可用')
      if (input.approvalPolicy !== requiredPolicy) {
        throw stateConflict('DSH 内置工具的审批策略由平台安全策略固定，不能在权限页面覆盖')
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
      if (!result.length) throw notFound(`工具不存在：${input.toolId}`)
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

  async assertAvailableReferences(references: string[]): Promise<void> {
    return this.assertReferences(references, true)
  }

  /** Optional platform defaults eligible for this Agent definition; callers seal exact refs and bindings. */
  async resolvePlatformDefaultToolReferences(roleIds: string[], dataScopes: string[]): Promise<string[]> {
    const rows = await this.database<{ id: string; version: string; connectorId: string; dshToolName: string | null; allowedRoleIds: string[]; requiredScopes: string[] }[]>`
      select distinct on (t.id) t.id, tv.version,
             t.connector_id as "connectorId", t.dsh_tool_name as "dshToolName",
             t.allowed_role_ids as "allowedRoleIds", t.data_scopes as "requiredScopes"
        from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
        join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
       where t.tenant_id = ${tenantId} and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
         and t.dsh_tool_name = any(${[...defaultAgentDshToolNames]})
         and t.admission_status = 'approved' and t.status = 'available'
         and tv.status = 'published' and c.status = 'healthy'
       order by t.id, split_part(tv.version, '.', 1)::integer desc,
                split_part(tv.version, '.', 2)::integer desc,
                split_part(tv.version, '.', 3)::integer desc
    `
    const scopes = new Set(dataScopes)
    return rows.filter(row => isDefaultRunLocalAgentTool({
      connectorId: row.connectorId, dshToolName: row.dshToolName,
      allowedRoleIds: row.allowedRoleIds, dataScopes: row.requiredScopes,
    }) || (roleIds.some(role => row.allowedRoleIds.includes(role))
      && row.requiredScopes.every(scope => scopes.has(scope))))
      .map(row => `${row.id}@${row.version}`)
  }

  /** Draft storage is not execution: allow unhealthy connectors, never unknown/disabled tools or unpublished versions. */
  async assertDraftReferences(references: string[], sql: DatabaseClient | DatabaseTransaction = this.database): Promise<void> {
    return this.assertReferences(references, false, sql)
  }

  private async assertReferences(references: string[], requireHealthy: boolean, sql: DatabaseClient | DatabaseTransaction = this.database): Promise<void> {
    for (const reference of unique(references)) {
      if (DSH_WORK_EXECUTION_TOOL_REFS.has(reference)) continue
      const { id, version } = parseReference(reference)
      const [row] = await sql<{ id: string }[]>`
        select tv.id from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
        join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
         where t.tenant_id = ${tenantId} and t.id = ${id}
           and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
           and t.admission_status = 'approved'
           and (t.mode = 'read' or (t.mode = 'write'
                and t.dsh_tool_name in ('write', 'edit', 'str_replace_editor', 'todo_write', 'create_goal', 'update_goal')))
           and ${requireHealthy ? sql` t.status = 'available' and c.status = 'healthy'` : sql`t.status in ('available', 'degraded')`}
           and tv.version = ${version} and tv.status = 'published'
      `
      if (!row) throw notFound(`工具不存在、未发布、不可用或不符合受控运行策略：${reference}`)
    }
  }

  async assertAuthorizationCompatibility(
    references: string[],
    executionRoleIds: string[],
    agentDataScopes: string[],
  ): Promise<void> {
    const scopeSet = new Set(agentDataScopes)
    for (const reference of unique(references)) {
      if (DSH_WORK_EXECUTION_TOOL_REFS.has(reference)) continue
      const { id, version } = parseReference(reference)
      const [row] = await this.database<{ connectorId: string; dshToolName: string | null; allowedRoleIds: string[]; dataScopes: string[] }[]>`
        select t.connector_id as "connectorId", t.dsh_tool_name as "dshToolName",
               t.allowed_role_ids as "allowedRoleIds", t.data_scopes as "dataScopes"
          from tools t
          join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
         where t.tenant_id = ${tenantId} and t.id = ${id} and tv.version = ${version}
           and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
           and t.admission_status = 'approved'
      `
      if (!row) throw notFound(`工具授权配置不存在：${reference}`)
      if (isDefaultRunLocalAgentTool(row)) continue
      if (!executionRoleIds.some(roleId => row.allowedRoleIds.includes(roleId))) {
        throw invalidRequest(`Agent 执行身份缺少工具 ${reference} 所需角色：${row.allowedRoleIds.join('、')}`)
      }
      const missingScopes = unique(row.dataScopes).filter(scope => !scopeSet.has(scope))
      if (missingScopes.length) {
        throw invalidRequest(`Agent 执行身份缺少工具 ${reference} 所需平台数据范围：${missingScopes.join('、')}`)
      }
    }
  }

  /**
   * S2 岗位权限：列出 Agent 能力所需的角色与数据范围，供管理端在授权时对齐。
   * declared 为版本声明的平台工具；default 为平台默认装配、但有角色或数据要求的 DSH 工具。
   * 运行时本地默认工具（文件读写等）无需授权，不列出。
   */
  async describeAuthorizationRequirements(references: string[]): Promise<Array<{
    reference: string; name: string; source: 'declared' | 'default'
    requiredRoleIds: string[]; requiredScopes: string[]
  }>> {
    const declared = unique(references).filter(reference => !DSH_WORK_EXECUTION_TOOL_REFS.has(reference))
    const rows = await this.database<{
      id: string; version: string; name: string; connectorId: string; dshToolName: string | null
      allowedRoleIds: string[]; requiredScopes: string[]; isDefault: boolean
    }[]>`
      select distinct on (t.id) t.id, tv.version, t.name,
             t.connector_id as "connectorId", t.dsh_tool_name as "dshToolName",
             t.allowed_role_ids as "allowedRoleIds", t.data_scopes as "requiredScopes",
             (t.dsh_tool_name = any(${[...defaultAgentDshToolNames]})) as "isDefault"
        from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
       where t.tenant_id = ${tenantId} and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
         and t.admission_status = 'approved'
         and ((t.id || '@' || tv.version) = any(${declared})
           or (t.dsh_tool_name = any(${[...defaultAgentDshToolNames]}) and t.status = 'available' and tv.status = 'published'))
       order by t.id, ((t.id || '@' || tv.version) = any(${declared})) desc,
                split_part(tv.version, '.', 1)::integer desc,
                split_part(tv.version, '.', 2)::integer desc,
                split_part(tv.version, '.', 3)::integer desc
    `
    return rows
      .filter(row => !isDefaultRunLocalAgentTool({
        connectorId: row.connectorId, dshToolName: row.dshToolName,
        allowedRoleIds: row.allowedRoleIds, dataScopes: row.requiredScopes,
      }))
      .map(row => {
        const reference = `${row.id}@${row.version}`
        return {
          reference, name: row.name,
          source: declared.includes(reference) ? 'declared' as const : 'default' as const,
          requiredRoleIds: unique(row.allowedRoleIds), requiredScopes: unique(row.requiredScopes),
        }
      })
      .sort((left, right) => left.source.localeCompare(right.source) || left.reference.localeCompare(right.reference))
  }

  async resolveRuntimeToolNames(references: string[]): Promise<string[]> {
    await this.assertAvailableReferences(references)
    const names: string[] = []
    for (const reference of unique(references)) {
      if (DSH_WORK_EXECUTION_TOOL_REFS.has(reference)) { names.push(parseReference(reference).id); continue }
      const { id } = parseReference(reference)
      const [row] = await this.database<{ name: string }[]>`
        select dsh_tool_name as name from tools
         where tenant_id = ${tenantId} and id = ${id}
           and connector_id = ${DSH_RUNTIME_CONNECTOR_ID} and dsh_tool_name is not null
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
      if (DSH_WORK_EXECUTION_TOOL_REFS.has(reference)) { policies.push('none'); continue }
      const { id, version } = parseReference(reference)
      const [row] = await this.database<{ approvalPolicy: ToolDefinition['approvalPolicy'] }[]>`
        select t.approval_policy as "approvalPolicy" from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
         where t.tenant_id = ${tenantId} and t.id = ${id} and tv.version = ${version}
           and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
           and tv.status = 'published'
      `
      if (!row) throw notFound(`工具审批策略不存在：${reference}`)
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
    await this.assertDraftReferences(references)
    const resolved: ResolvedToolBinding[] = []
    for (const reference of unique(references)) {
      if (DSH_WORK_EXECUTION_TOOL_REFS.has(reference)) continue
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
       where tenant_id = ${tenantId} and connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
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
      if (!snapshot) throw notFound(`工具不存在、版本未发布或已停用，无法解析绑定：${toolId}@${toolVersion}`)
      const digest = toolBindingDigest(snapshot)
      const current = await loadCurrent()
      if (current?.contentDigest === digest) return toResolvedBinding(current)
      // 需要轮换：持 tools 行锁复核快照与活跃修订，与并发解析/语义变更串行化。
      const locked = await this.loadBindingSnapshot(db, toolId, toolVersion, true)
      if (!locked) throw notFound(`工具不存在、版本未发布或已停用，无法解析绑定：${toolId}@${toolVersion}`)
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
      admissionStatus: NonNullable<ToolDefinition['admissionStatus']>
      credentialRef: string | null
      allowedRoleIds: string[]
      dataScopes: string[]
      approvalPolicy: string
    }[]>`
      select t.status as "toolStatus", c.id as "connectorId", c.protocol, c.endpoint,
             c.auth_type as "authType", t.dsh_tool_name as "dshToolName",
             t.admission_status as "admissionStatus",
             cr.external_ref as "credentialRef",
             t.allowed_role_ids as "allowedRoleIds", t.data_scopes as "dataScopes",
             t.approval_policy as "approvalPolicy"
        from tools t
        join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
        join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
       where t.tenant_id = ${tenantId} and t.id = ${toolId}
         and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}
         and tv.version = ${toolVersion} and tv.status = 'published'
       ${lock ? db`for update of t` : db``}
    `
    if (!row || row.toolStatus === 'disabled' || row.admissionStatus !== 'approved') return undefined
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
    if (!tool) throw notFound(`工具不存在：${toolId}`)
    return tool
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
      if (!role) throw notFound(`角色不存在：${value}`)
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
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    latency: row.latencyMs === null ? '未检查' : `${row.latencyMs} ms`,
    lastCheckedAt: formatRelative(row.lastCheckedAt),
    ...(row.lastHealthMessage ? { lastHealthMessage: row.lastHealthMessage } : {}),
  }
}

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value))

function synchronizedToolContractDigest(value: {
  inputSchema: unknown
  outputSchema: unknown
  risk: ToolDefinition['risk']
  outputValidation: ToolDefinition['outputValidation']
  retryPolicy: ToolDefinition['retryPolicy']
  concurrencyPolicy: ToolDefinition['concurrencyPolicy']
  completionSemantics: ToolDefinition['completionSemantics']
}) {
  const { inputSchema, outputSchema, risk, outputValidation, retryPolicy, concurrencyPolicy, completionSemantics } = value
  return createHash('sha256').update(canonicalJson({
    inputSchema, outputSchema, risk, outputValidation, retryPolicy, concurrencyPolicy, completionSemantics,
  })).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function parseReference(reference: string) {
  const separator = reference.lastIndexOf('@')
  if (separator <= 0 || separator === reference.length - 1) throw invalidRequest(`工具引用必须锁定版本：${reference}`)
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
