import { createHash, randomUUID } from 'node:crypto'

import type { AgentMcpScope, ConnectorDefinition, McpConnectionTestResult, McpConnectorDeletionResult, McpInvocationAudit, RegisterMcpConnectorInput, TestMcpConnectionInput } from '../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { AuditTrail } from '../../domain/audit-trail.ts'
import { authorizationDenied } from '../../domain/authorization-errors.ts'
import { RequestError, invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'
import type { AgentRuntimePort, McpConnectionSnapshot, McpRuntimeConnection, RuntimeManifest } from '../runtime/runtime-types.ts'
import { normalizeAgentMcpScope } from './agent-mcp-scope.ts'
import { mcpCapabilityDigest, mergeMcpCapabilities, normalizeMcpCapabilities, pendingMcpCapabilities, type McpCapability } from './mcp-capabilities.ts'
import { normalizeBearerToken, type PostgresEncryptedCredentialStore } from './postgres-encrypted-credential-store.ts'
import { requirePlatformAdminActor } from '../authorization/platform-admin-actor.ts'

const tenantId = 'tenant-dsh-work'

/** Agent 与运行编排使用的 MCP 端口：调用方传入 Agent Version 的使用范围，MCP 模块不读取 Agent 表。 */
export interface McpScopePort {
  validateSelection(connectorIds: readonly string[]): Promise<void>
  resolveConnections(scope: AgentMcpScope | null | undefined): Promise<McpConnectionSnapshot[]>
  assertPinnedConnections(pins: readonly McpConnectionSnapshot[]): Promise<void>
}

interface McpConnectorRow {
  id: string
  name: string
  status: ConnectorDefinition['status']
  endpoint: string
  authType: string
  credentialBackend: string | null
  scopeDescription: string
  latencyMs: number | null
  lastCheckedAt: Date | null
  lastHealthMessage: string | null
  createdAt: Date
  createdBy: string
  updatedAt: Date
  serverName: string
  approvalStatus: NonNullable<ConnectorDefinition['mcp']>['approvalStatus']
  capabilityDigest: string | null
  approvedDigest: string | null
  capabilitySnapshot: McpCapability[]
  approvedSnapshot: McpCapability[]
  discoveredAt: Date | null
  reviewedAt: Date | null
  reviewedBy: string | null
}

interface CredentialRevision {
  credentialRefId: string | null
  credentialBackend: string | null
  credentialVersion: number | null
}

interface RuntimeConnectionRow {
  connectorId: string
  serverName: string
  endpoint: string
  authType: 'none' | 'bearer'
  approvedDigest: string | null
  approvedSnapshot: McpCapability[]
  connectorStatus: ConnectorDefinition['status']
  credentialRefId: string | null
  credentialStatus: string | null
  credentialBackend: string | null
  credentialVersion: number | null
}

export class PostgresMcpConnectorService implements McpScopePort {
  private readonly database: DatabaseClient
  private readonly runtime?: AgentRuntimePort
  private readonly operations?: AuditTrail
  private readonly credentialSecrets?: PostgresEncryptedCredentialStore

  constructor(
    database: DatabaseClient,
    runtime?: AgentRuntimePort,
    operations?: AuditTrail,
    credentialSecrets?: PostgresEncryptedCredentialStore,
  ) {
    this.database = database
    this.runtime = runtime
    this.operations = operations
    this.credentialSecrets = credentialSecrets
  }

  /* ---------- 管理端 ---------- */

  async getMcpConnectors(): Promise<ConnectorDefinition[]> {
    const rows = await this.database<McpConnectorRow[]>`
      select c.id, c.name, c.status, c.endpoint, c.auth_type as "authType",
             cr.backend as "credentialBackend", c.scope_description as "scopeDescription",
             c.latency_ms as "latencyMs", c.last_checked_at as "lastCheckedAt", hc.message as "lastHealthMessage",
             c.created_at as "createdAt", creator.display_name as "createdBy", c.updated_at as "updatedAt",
             p.server_name as "serverName", p.approval_status as "approvalStatus",
             p.capability_digest as "capabilityDigest", p.approved_digest as "approvedDigest",
             p.capability_snapshot as "capabilitySnapshot", p.approved_snapshot as "approvedSnapshot",
             p.discovered_at as "discoveredAt", p.reviewed_at as "reviewedAt", reviewer.display_name as "reviewedBy"
        from connectors c
        join mcp_connector_profiles p on p.tenant_id = c.tenant_id and p.connector_id = c.id
        join users creator on creator.tenant_id = c.tenant_id and creator.id = c.created_by
        left join users reviewer on reviewer.tenant_id = p.tenant_id and reviewer.id = p.reviewed_by
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
        left join lateral (
          select message from connector_health_checks
           where tenant_id = c.tenant_id and connector_id = c.id
           order by checked_at desc, id desc limit 1
        ) hc on true
       where c.tenant_id = ${tenantId} and c.protocol = 'mcp' and c.deleted_at is null
       order by c.name
    `
    return rows.map(toConnectorDefinition)
  }

  async testMcpConnection(input: TestMcpConnectionInput): Promise<McpConnectionTestResult> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    try {
      const inspected = await this.inspectRegistrationInput(input)
      await this.audit(
        actor.id,
        'connector.mcp.test',
        `mcp-test-${createHash('sha256').update(inspected.endpoint).digest('hex').slice(0, 16)}`,
        'success',
        `MCP 连通测试通过；通过 DSH 发现 ${inspected.capabilities.length} 个 Tool`,
      )
      return {
        status: 'reachable',
        endpoint: inspected.endpoint,
        latencyMs: inspected.latencyMs,
        capabilityCount: inspected.capabilities.length,
        capabilities: inspected.capabilities,
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'MCP 连通测试失败'
      await this.audit(actor.id, 'connector.mcp.test', 'mcp-test-failed', 'failed', message)
      if (isTypedServiceError(cause)) throw cause
      throw new RequestError(503, 'MCP_CONNECTION_TEST_FAILED', message)
    }
  }

  /** 登记前再次通过 DSH 发现；登记时看到的完整清单即为首个生效清单。 */
  async registerMcpConnector(input: RegisterMcpConnectorInput): Promise<ConnectorDefinition> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    const id = `connector-mcp-${randomUUID()}`
    if (!input.scopeDescription.trim()) throw stateConflict('整体权限范围不能为空')
    const inspected = await this.inspectRegistrationInput(input, id)
    const digest = mcpCapabilityDigest(inspected.capabilities)

    await this.database.begin(async transaction => {
      let credentialId: string | null = null
      if (input.authType === 'bearer') {
        credentialId = `credential-mcp-${randomUUID()}`
        await transaction`
          insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by)
          values (${credentialId}, ${tenantId}, 'postgres-encrypted', ${credentialId}, 'configured', now(), ${actor.id})
        `
        await this.credentialSecrets!.create(transaction, {
          tenantId, credentialRefId: credentialId, bearerToken: input.bearerToken!, actorId: actor.id,
        })
      }
      await transaction`
        insert into connectors (
          id, tenant_id, key, name, connector_type, credential_ref_id, status, created_by,
          system, protocol, endpoint, auth_type, scope_description,
          latency_ms, last_checked_at, updated_at
        ) values (
          ${id}, ${tenantId}, ${inspected.serverName}, ${input.name.trim()}, 'mcp', ${credentialId}, 'healthy', ${actor.id},
          'MCP', 'mcp', ${inspected.endpoint}, ${input.authType}, ${input.scopeDescription.trim()},
          ${inspected.latencyMs}, now(), now()
        )
      `
      await transaction`
        insert into mcp_connector_profiles (
          tenant_id, connector_id, server_name, approval_status,
          capability_digest, capability_snapshot, approved_digest, approved_snapshot,
          reviewed_by, reviewed_at, discovered_at, updated_at
        ) values (
          ${tenantId}, ${id}, ${inspected.serverName}, 'approved',
          ${digest}, ${transaction.json(asJson(inspected.capabilities))},
          ${digest}, ${transaction.json(asJson(inspected.capabilities))},
          ${actor.id}, now(), now(), now()
        )
      `
      await this.insertHealthCheck(transaction, id, 'healthy', inspected.latencyMs,
        `已通过 DSH 发现并生效 ${inspected.capabilities.length} 个 MCP Tool`, actor.id)
    })
    await this.audit(actor.id, 'connector.mcp.register', id, 'success', `连通复核通过并登记 MCP Connector；生效 ${inspected.capabilities.length} 个 Tool`)
    return this.requireConnector(id)
  }

  /**
   * 重新发现能力。名称与输入 Schema 未变的 Tool 继续生效（描述随之更新），远端删除的
   * Tool 立即下线；新增或 Schema 变化的 Tool 进入待确认，须管理员确认后才生效。
   */
  async checkMcpConnector(input: { connectorId: string; actor: string }): Promise<ConnectorDefinition> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    const checkedCredential = await this.readCredentialRevision(this.database, input.connectorId)
    const started = performance.now()
    let status: 'healthy' | 'offline' = 'offline'
    let message: string
    let discovered: McpCapability[] | undefined
    if (!this.runtime?.inspectMcpConnection) {
      message = '当前 DSH Runtime 未接入 MCP 检查能力'
    } else {
      try {
        const connection = await this.resolveRuntimeConnection(input.connectorId)
        discovered = normalizeMcpCapabilities((await this.runtime.inspectMcpConnection(connection)).capabilities)
        if (!discovered.length) throw invalidRequest('MCP Server 未发现任何 Tool；Resources 与 Prompts 当前不受支持')
        status = 'healthy'
        message = ''
      } catch (error) {
        discovered = undefined
        message = error instanceof Error ? error.message : 'MCP 发现失败'
      }
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - started))

    await this.database.begin(async transaction => {
      const [connector] = await transaction<{ status: ConnectorDefinition['status'] }[]>`
        select status from connectors
         where tenant_id = ${tenantId} and id = ${input.connectorId} and protocol = 'mcp' and deleted_at is null
         for update
      `
      if (!connector) throw notFound(`MCP Connector 不存在：${input.connectorId}`)
      const currentCredential = await this.readCredentialRevision(transaction, input.connectorId)
      if (!sameCredentialRevision(checkedCredential, currentCredential)) {
        await this.insertHealthCheck(transaction, input.connectorId, 'degraded', latencyMs,
          'MCP Bearer 凭据已在检查期间更新；本次旧凭据检查结果已丢弃，请重新检查', actor.id)
        return
      }
      if (discovered) {
        const [profile] = await transaction<{ approvedSnapshot: McpCapability[] }[]>`
          select approved_snapshot as "approvedSnapshot" from mcp_connector_profiles
           where tenant_id = ${tenantId} and connector_id = ${input.connectorId}
           for update
        `
        if (!profile) throw invalidRequest('MCP Connector 缺少治理配置')
        const { effective, pending } = mergeMcpCapabilities(profile.approvedSnapshot, discovered)
        await transaction`
          update mcp_connector_profiles
             set capability_snapshot = ${transaction.json(asJson(discovered))},
                 capability_digest = ${mcpCapabilityDigest(discovered)},
                 approved_snapshot = ${transaction.json(asJson(effective))},
                 approved_digest = ${mcpCapabilityDigest(effective)},
                 approval_status = ${pending.length ? 'changes_pending' : 'approved'},
                 discovered_at = now(), updated_at = now()
           where tenant_id = ${tenantId} and connector_id = ${input.connectorId}
        `
        message = pending.length
          ? `发现 ${discovered.length} 个 MCP Tool，已生效 ${effective.length} 个，${pending.length} 个待确认`
          : `MCP 能力清单已同步，共 ${effective.length} 个 Tool 生效`
      }
      const nextStatus = connector.status === 'disabled' ? 'disabled' : status
      if (connector.status === 'disabled') message = `${message}；连接器保持人工停用，需显式启用`
      await transaction`
        update connectors set status = ${nextStatus}, latency_ms = ${latencyMs},
                              last_checked_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.connectorId}
      `
      await this.insertHealthCheck(transaction, input.connectorId, status, latencyMs, message, actor.id)
    })
    await this.audit(actor.id, 'connector.health.check', input.connectorId, status === 'offline' ? 'failed' : 'success', message)
    return this.requireConnector(input.connectorId)
  }

  /** 把当前发现清单整体确认为生效清单；清单已再次变化时返回冲突，要求刷新后再确认。 */
  async approveMcpCapabilities(input: { connectorId: string; capabilityDigest: string; actor: string }): Promise<ConnectorDefinition> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    let approvedCount = 0
    await this.database.begin(async transaction => {
      const [profile] = await transaction<{ capabilityDigest: string | null; capabilitySnapshot: McpCapability[] }[]>`
        select p.capability_digest as "capabilityDigest", p.capability_snapshot as "capabilitySnapshot"
          from mcp_connector_profiles p
          join connectors c on c.tenant_id = p.tenant_id and c.id = p.connector_id
         where p.tenant_id = ${tenantId} and p.connector_id = ${input.connectorId}
           and c.protocol = 'mcp' and c.deleted_at is null
         for update of p
      `
      if (!profile) throw notFound(`MCP Connector 不存在：${input.connectorId}`)
      if (!profile.capabilityDigest || profile.capabilityDigest !== input.capabilityDigest) {
        throw stateConflict('MCP 能力清单已变化，请刷新后再确认')
      }
      approvedCount = profile.capabilitySnapshot.length
      await transaction`
        update mcp_connector_profiles
           set approved_snapshot = capability_snapshot, approved_digest = capability_digest,
               approval_status = 'approved', reviewed_by = ${actor.id}, reviewed_at = now(), updated_at = now()
         where tenant_id = ${tenantId} and connector_id = ${input.connectorId}
      `
    })
    await this.audit(actor.id, 'connector.mcp.capabilities.approve', input.connectorId, 'success', `确认 MCP 能力清单，共 ${approvedCount} 个 Tool 生效`)
    return this.requireConnector(input.connectorId)
  }

  /** 受控软删除：后续解析立即排除该连接器；独占密文删除，治理证据与调用审计保留。 */
  async deleteMcpConnector(input: { connectorId: string; actor: string }): Promise<McpConnectorDeletionResult> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    let credentialDestroyed = false
    await this.database.begin(async transaction => {
      const [connector] = await transaction<{ credentialRefId: string | null }[]>`
        select credential_ref_id as "credentialRefId" from connectors
         where tenant_id = ${tenantId} and id = ${input.connectorId} and protocol = 'mcp' and deleted_at is null
         for update
      `
      if (!connector) throw notFound(`MCP Connector 不存在：${input.connectorId}`)
      await transaction`
        update connectors
           set status = 'disabled', credential_ref_id = null,
               deleted_at = now(), deleted_by = ${actor.id}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.connectorId}
      `
      if (connector.credentialRefId) {
        const deleted = await transaction<{ id: string }[]>`
          delete from credential_refs cr
           where cr.tenant_id = ${tenantId} and cr.id = ${connector.credentialRefId}
             and not exists (
               select 1 from connectors c where c.tenant_id = cr.tenant_id and c.credential_ref_id = cr.id
             )
          returning id
        `
        credentialDestroyed = deleted.length > 0
      }
    })
    await this.audit(actor.id, 'connector.mcp.delete', input.connectorId, 'success',
      `删除 MCP Connector；所有 Agent 后续运行均停止使用；${credentialDestroyed ? '已销毁独占凭据' : '未删除共享或空凭据'}`)
    return { connectorId: input.connectorId, credentialDestroyed }
  }

  async rotateMcpCredential(input: { connectorId: string; bearerToken: string; actor: string }): Promise<ConnectorDefinition> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    if (!this.credentialSecrets) throw mcpCredentialStoreUnavailable()
    const secrets = this.credentialSecrets
    await this.database.begin(async transaction => {
      const [connector] = await transaction<{ credentialRefId: string | null }[]>`
        select credential_ref_id as "credentialRefId" from connectors
         where tenant_id = ${tenantId} and id = ${input.connectorId}
           and protocol = 'mcp' and auth_type = 'bearer' and deleted_at is null
         for update
      `
      if (!connector?.credentialRefId) throw stateConflict('目标不是已配置 Bearer 认证的 MCP Connector')
      const [credential] = await transaction<{ backend: string }[]>`
        select backend from credential_refs where tenant_id = ${tenantId} and id = ${connector.credentialRefId} for update
      `
      if (!credential) throw notFound('MCP Bearer 凭据引用不存在')
      const [secret] = await transaction<{ version: number }[]>`
        select version from credential_secrets
         where tenant_id = ${tenantId} and credential_ref_id = ${connector.credentialRefId} for update
      `
      const [usage] = await transaction<{ connectorCount: number }[]>`
        select count(*)::int as "connectorCount" from connectors
         where tenant_id = ${tenantId} and credential_ref_id = ${connector.credentialRefId}
      `
      const mustSplitCredential = credential.backend !== 'postgres-encrypted' || !secret || (usage?.connectorCount ?? 0) > 1
      let targetCredentialId = connector.credentialRefId
      if (mustSplitCredential) {
        if (!['dsh-managed', 'postgres-encrypted'].includes(credential.backend)) {
          throw invalidRequest('MCP Bearer 凭据后端不支持页面轮换')
        }
        targetCredentialId = `credential-mcp-${randomUUID()}`
        await transaction`
          insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by)
          values (${targetCredentialId}, ${tenantId}, 'postgres-encrypted', ${targetCredentialId}, 'configured', now(), ${actor.id})
        `
        await secrets.create(transaction, { tenantId, credentialRefId: targetCredentialId, bearerToken: input.bearerToken, actorId: actor.id })
      } else {
        await secrets.rotate(transaction, { tenantId, credentialRefId: targetCredentialId, bearerToken: input.bearerToken, actorId: actor.id })
        await transaction`
          update credential_refs
             set status = 'configured', last_verified_at = now(), updated_by = ${actor.id}, updated_at = now()
           where tenant_id = ${tenantId} and id = ${targetCredentialId}
        `
      }
      await transaction`
        update connectors
           set credential_ref_id = ${targetCredentialId},
               status = case when status = 'disabled' then 'disabled' else 'degraded' end,
               updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.connectorId}
      `
    })
    await this.audit(actor.id, 'connector.mcp.credential.rotate', input.connectorId, 'success', '录入或轮换 MCP Bearer 凭据；等待重新检查')
    return this.requireConnector(input.connectorId)
  }

  async setMcpConnectorStatus(input: { connectorId: string; status: 'enabled' | 'disabled'; actor: string }): Promise<ConnectorDefinition> {
    const actor = await requirePlatformAdminActor(this.database, input.actor)
    await this.database.begin(async transaction => {
      const [connector] = await transaction<{ authType: string; credentialBackend: string | null; credentialVersion: number | null }[]>`
        select c.auth_type as "authType", cr.backend as "credentialBackend", cs.version as "credentialVersion"
          from connectors c
          left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
          left join credential_secrets cs on cs.tenant_id = c.tenant_id and cs.credential_ref_id = c.credential_ref_id
         where c.tenant_id = ${tenantId} and c.id = ${input.connectorId}
           and c.protocol = 'mcp' and c.deleted_at is null
         for update of c
      `
      if (!connector) throw notFound('目标不是 MCP Connector')
      if (input.status === 'enabled' && connector.authType === 'bearer'
        && (connector.credentialBackend !== 'postgres-encrypted' || connector.credentialVersion === null)) {
        throw stateConflict('旧版 MCP Bearer 凭据需要先重新录入 Token，不能启用')
      }
      await transaction`
        update connectors set status = ${input.status === 'enabled' ? 'healthy' : 'disabled'}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.connectorId}
      `
    })
    await this.audit(actor.id, `connector.mcp.${input.status}`, input.connectorId, 'success', `MCP Connector 已${input.status === 'enabled' ? '启用' : '停用'}`)
    return this.requireConnector(input.connectorId)
  }

  async listMcpInvocationAudits(connectorId: string): Promise<McpInvocationAudit[]> {
    const [connector] = await this.database<{ id: string }[]>`
      select id from connectors where tenant_id = ${tenantId} and id = ${connectorId} and protocol = 'mcp'
    `
    if (!connector) throw notFound(`MCP Connector 不存在：${connectorId}`)
    return this.database<McpInvocationAudit[]>`
      select id, run_id as "runId", attempt_id as "attemptId", connector_id as "connectorId",
             actor_user_id as "actorUserId", executor_principal_id as "executorPrincipalId",
             capability_name as "capabilityName",
             parameter_digest as "parameterDigest", result, occurred_at as "occurredAt"
        from mcp_invocation_audits
       where tenant_id = ${tenantId} and connector_id = ${connectorId}
       order by occurred_at desc
       limit 50
    `
  }

  /* ---------- Agent 与运行端口 ---------- */

  /** 草稿保存：选定的连接器必须存在且未删除；可用性在验证和执行准备时检查。 */
  async validateSelection(connectorIds: readonly string[]): Promise<void> {
    if (!connectorIds.length) return
    const rows = await this.database<{ id: string }[]>`
      select id from connectors
       where tenant_id = ${tenantId} and protocol = 'mcp' and deleted_at is null
         and id = any(${[...connectorIds]})
    `
    if (rows.length !== new Set(connectorIds).size) {
      throw new RequestError(422, 'validation_failed', '选定的 MCP Connector 不存在、已删除或不属于当前租户')
    }
  }

  /** 新 Attempt：解析 Agent Version 选定的连接器；任一不可用即拒绝，不回退。 */
  async resolveConnections(value: AgentMcpScope | null | undefined): Promise<McpConnectionSnapshot[]> {
    const scope = normalizeAgentMcpScope(value)
    if (scope.mode === 'none') return []
    const rows = await this.loadRuntimeRows(scope.connectorIds)
    const usable = rows.filter(isUsable)
    if (usable.length !== scope.connectorIds.length) {
      const available = new Set(usable.map(row => row.connectorId))
      throw authorizationDenied(`已选 MCP Connector 不可用：${scope.connectorIds.filter(id => !available.has(id)).join('、')}`)
    }
    return usable.map(row => {
      assertRuntimeCredential(row)
      return toSnapshot(row)
    })
  }

  /** 执行期与恢复复核：Attempt 固定的每个连接仍可用，且生效清单与固定摘要一致。 */
  async assertPinnedConnections(pins: readonly McpConnectionSnapshot[]): Promise<void> {
    if (!pins.length) return
    const rows = new Map((await this.loadRuntimeRows(pins.map(pin => pin.connector_id))).map(row => [row.connectorId, row]))
    for (const pin of pins) {
      const row = rows.get(pin.connector_id)
      if (!row || !isUsable(row) || !sameSnapshot(toSnapshot(row), pin)) {
        throw authorizationDenied(`固定的 MCP Connector 已停用、删除或生效能力已变化：${pin.connector_id}`)
      }
      assertRuntimeCredential(row)
    }
  }

  /** Adapter 启动 Worker：复核固定连接并解析凭据与生效清单。 */
  async resolveRuntimeConnections(manifest: RuntimeManifest): Promise<McpRuntimeConnection[]> {
    const pins = manifest.mcp_connections ?? []
    if (!pins.length) return []
    await this.assertPinnedConnections(pins)
    return Promise.all(pins.map(pin => this.resolveRuntimeConnection(pin.connector_id, pin)))
  }

  async recordMcpInvocation(manifest: RuntimeManifest, input: {
    serverName: string
    callId: string
    capabilityName: string
    parameterDigest: string
    result: 'success' | 'failed' | 'unknown'
  }): Promise<void> {
    const pin = manifest.mcp_connections?.find(connection => connection.server_name === input.serverName)
    if (!pin) throw authorizationDenied(`MCP 调用不属于当前 Attempt 固定清单：${input.serverName}`)
    await this.database`
      insert into mcp_invocation_audits (
        id, tenant_id, run_id, attempt_id, connector_id, actor_user_id, executor_principal_id,
        call_id, capability_name, parameter_digest, result
      ) values (
        ${`mcp-audit-${randomUUID()}`}, ${tenantId}, ${manifest.run_id}, ${manifest.attempt_id},
        ${pin.connector_id}, ${manifest.user_context.user_id},
        (select t.executed_as_principal_id from runs r join tasks t
           on t.tenant_id = r.tenant_id and t.id = r.task_id
          where r.tenant_id = ${tenantId} and r.id = ${manifest.run_id}),
        ${input.callId}, ${input.capabilityName},
        ${input.parameterDigest}, ${input.result}
      )
      on conflict (tenant_id, attempt_id, call_id) do update
        set result = excluded.result, occurred_at = now()
    `
  }

  async finalizeMcpInvocationAudit(manifest: RuntimeManifest): Promise<void> {
    const [attempt] = await this.database<{ id: string }[]>`
      update run_attempts
         set mcp_audit_finalized_at = coalesce(mcp_audit_finalized_at, now())
       where tenant_id = ${tenantId} and id = ${manifest.attempt_id} and run_id = ${manifest.run_id}
       returning id
    `
    if (!attempt) throw new Error(`MCP 调用审计无法关联 Attempt：${manifest.attempt_id}`)
  }

  /* ---------- 内部 ---------- */

  private async loadRuntimeRows(connectorIds: readonly string[]): Promise<RuntimeConnectionRow[]> {
    return this.database<RuntimeConnectionRow[]>`
      select c.id as "connectorId", p.server_name as "serverName", c.endpoint, c.auth_type as "authType",
             p.approved_digest as "approvedDigest", p.approved_snapshot as "approvedSnapshot",
             c.status as "connectorStatus", cr.id as "credentialRefId", cr.status as "credentialStatus",
             cr.backend as "credentialBackend", cs.version as "credentialVersion"
        from connectors c
        join mcp_connector_profiles p on p.tenant_id = c.tenant_id and p.connector_id = c.id
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
        left join credential_secrets cs on cs.tenant_id = c.tenant_id and cs.credential_ref_id = c.credential_ref_id
       where c.tenant_id = ${tenantId} and c.protocol = 'mcp' and c.deleted_at is null
         and c.id = any(${[...connectorIds]})
       order by p.server_name
    `
  }

  private async resolveRuntimeConnection(connectorId: string, expected?: McpConnectionSnapshot): Promise<McpRuntimeConnection> {
    const [row] = await this.loadRuntimeRows([connectorId])
    if (!row) throw notFound(`MCP Connector 不存在：${connectorId}`)
    if (expected && (!isUsable(row) || !sameSnapshot(toSnapshot(row), expected))) {
      throw authorizationDenied(`MCP Connector 当前配置与 Attempt 快照不一致：${connectorId}`)
    }
    const headers: Record<string, string> = {}
    if (row.authType === 'bearer') {
      assertRuntimeCredential(row)
      if (!this.credentialSecrets) throw mcpCredentialStoreUnavailable()
      headers['Authorization'] = `Bearer ${await this.credentialSecrets.readBearerToken(tenantId, row.credentialRefId!)}`
    }
    return {
      snapshot: expected ?? { ...toSnapshot(row), capability_digest: row.approvedDigest ?? '0'.repeat(64) },
      headers,
      ...(expected ? { capabilities: row.approvedSnapshot } : {}),
    }
  }

  private async inspectRegistrationInput(
    input: Pick<TestMcpConnectionInput, 'name' | 'endpoint' | 'authType' | 'bearerToken'>,
    connectorId = `connector-mcp-test-${randomUUID()}`,
  ): Promise<{ endpoint: string; serverName: string; latencyMs: number; capabilities: McpCapability[] }> {
    const name = input.name.trim()
    if (!name) throw invalidMcpConnectionInput('连接器名称不能为空')
    let endpoint: string
    try { endpoint = normalizeMcpEndpoint(input.endpoint) }
    catch (cause) { throw invalidMcpConnectionInput(cause instanceof Error ? cause.message : 'MCP 服务地址无效') }
    if (!['none', 'bearer'].includes(input.authType)) throw invalidMcpConnectionInput('MCP 仅支持 none 或 bearer 认证')
    if (input.authType === 'bearer' && !input.bearerToken) throw invalidMcpConnectionInput('Bearer MCP 必须提供 Token')
    if (input.authType === 'none' && input.bearerToken) throw invalidMcpConnectionInput('无认证 MCP 不能提交 Bearer Token')
    if (input.authType === 'bearer' && !this.credentialSecrets) throw mcpCredentialStoreUnavailable()
    if (!this.runtime?.inspectMcpConnection) {
      throw new RequestError(503, 'MCP_DISCOVERY_UNAVAILABLE', '当前 DSH Runtime 未接入 MCP 检查能力')
    }
    const serverName = createMcpServerName(name, connectorId)
    let bearerToken: string | undefined
    try { bearerToken = input.authType === 'bearer' ? normalizeBearerToken(input.bearerToken!) : undefined }
    catch (cause) { throw invalidMcpConnectionInput(cause instanceof Error ? cause.message : 'Bearer Token 无效') }
    try {
      const inspected = await this.runtime.inspectMcpConnection({
        snapshot: {
          connector_id: connectorId,
          server_name: serverName,
          transport: 'streamable-http',
          endpoint,
          auth_type: input.authType,
          capability_digest: '0'.repeat(64),
        },
        headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
      })
      const capabilities = normalizeMcpCapabilities(inspected.capabilities)
      if (!capabilities.length) throw invalidRequest('MCP Server 未发现任何 Tool；Resources 与 Prompts 当前不受支持')
      return { endpoint, serverName, latencyMs: inspected.latencyMs, capabilities }
    } catch (cause) {
      if (isTypedServiceError(cause)) throw cause
      throw new RequestError(503, 'MCP_CONNECTION_TEST_FAILED', cause instanceof Error ? cause.message : 'MCP 连通测试失败')
    }
  }

  private async readCredentialRevision(sql: DatabaseClient | DatabaseTransaction, connectorId: string): Promise<CredentialRevision> {
    const [row] = await sql<CredentialRevision[]>`
      select c.credential_ref_id as "credentialRefId", cr.backend as "credentialBackend", cs.version as "credentialVersion"
        from connectors c
        left join credential_refs cr on cr.tenant_id = c.tenant_id and cr.id = c.credential_ref_id
        left join credential_secrets cs on cs.tenant_id = c.tenant_id and cs.credential_ref_id = c.credential_ref_id
       where c.tenant_id = ${tenantId} and c.id = ${connectorId} and c.protocol = 'mcp' and c.deleted_at is null
    `
    if (!row) throw notFound(`MCP Connector 不存在：${connectorId}`)
    return row
  }

  private async insertHealthCheck(
    transaction: DatabaseTransaction, connectorId: string, status: string, latencyMs: number, message: string, actorId: string,
  ) {
    await transaction`
      insert into connector_health_checks (id, tenant_id, connector_id, status, latency_ms, message, checked_by)
      values (${`connector-check-${randomUUID()}`}, ${tenantId}, ${connectorId}, ${status}, ${latencyMs}, ${message}, ${actorId})
    `
  }

  private async requireConnector(connectorId: string): Promise<ConnectorDefinition> {
    const connector = (await this.getMcpConnectors()).find(item => item.id === connectorId)
    if (!connector) throw notFound(`MCP Connector 不存在：${connectorId}`)
    return connector
  }

  private audit(actorId: string, action: string, objectId: string, result: 'success' | 'failed', detail: string) {
    return this.operations?.appendAudit(actorId, action, objectId, result, `trace-tool-${randomUUID()}`, detail)
      ?? Promise.resolve()
  }
}

function isUsable(row: RuntimeConnectionRow) {
  return row.connectorStatus === 'healthy' && row.approvedDigest !== null && row.approvedSnapshot.length > 0
}

function assertRuntimeCredential(row: RuntimeConnectionRow) {
  if (row.authType !== 'bearer') return
  if (row.credentialStatus !== 'configured' || !row.credentialRefId
    || row.credentialBackend !== 'postgres-encrypted' || row.credentialVersion === null) {
    throw stateConflict(`MCP Connector 的 Bearer 凭据不可用，请在管理端重新录入 Token：${row.connectorId}`)
  }
}

function toSnapshot(row: RuntimeConnectionRow): McpConnectionSnapshot {
  return {
    connector_id: row.connectorId,
    server_name: row.serverName,
    transport: 'streamable-http',
    endpoint: row.endpoint,
    auth_type: row.authType,
    capability_digest: row.approvedDigest ?? '0'.repeat(64),
  }
}

function sameSnapshot(left: McpConnectionSnapshot, right: McpConnectionSnapshot) {
  return left.connector_id === right.connector_id
    && left.server_name === right.server_name
    && left.transport === right.transport
    && left.endpoint === right.endpoint
    && left.auth_type === right.auth_type
    && left.capability_digest === right.capability_digest
}

function sameCredentialRevision(left: CredentialRevision, right: CredentialRevision) {
  return left.credentialRefId === right.credentialRefId
    && left.credentialBackend === right.credentialBackend
    && left.credentialVersion === right.credentialVersion
}

function toConnectorDefinition(row: McpConnectorRow): ConnectorDefinition {
  return {
    id: row.id,
    name: row.name,
    system: 'MCP',
    status: row.status,
    toolCount: row.approvedSnapshot.length,
    protocol: 'mcp',
    endpoint: row.endpoint,
    authType: row.authType,
    credentialRef: row.authType === 'bearer'
      ? row.credentialBackend === 'postgres-encrypted' ? 'Bearer Token 已加密存储' : 'Bearer Token 需要重新录入'
      : '无独立凭据',
    scopeDescription: row.scopeDescription,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    latency: row.latencyMs === null ? '未检查' : `${row.latencyMs} ms`,
    lastCheckedAt: formatRelative(row.lastCheckedAt),
    ...(row.lastHealthMessage ? { lastHealthMessage: row.lastHealthMessage } : {}),
    mcp: {
      serverName: row.serverName,
      transport: 'streamable-http',
      approvalStatus: row.approvalStatus,
      capabilityDigest: row.capabilityDigest,
      approvedDigest: row.approvedDigest,
      capabilityCount: row.approvedSnapshot.length,
      capabilities: row.approvedSnapshot,
      pendingCapabilities: pendingMcpCapabilities(row.approvedSnapshot, row.capabilitySnapshot),
      discoveredAt: row.discoveredAt?.toISOString() ?? null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewedBy: row.reviewedBy,
    },
  }
}

function createMcpServerName(name: string, connectorId: string) {
  const slug = name.trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'mcp'
  const suffix = connectorId.replace(/[^a-f0-9]/gi, '').slice(-8).toLowerCase()
  return `${slug}_${suffix}`
}

function normalizeMcpEndpoint(value: string) {
  let endpoint: URL
  try { endpoint = new URL(value.trim()) }
  catch { throw invalidRequest('MCP 服务地址必须是有效的 HTTP(S) URL') }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw invalidRequest('MCP 服务地址只能使用 HTTP(S)，且不得包含账号、密码、查询参数或片段')
  }
  return endpoint.toString()
}

function mcpCredentialStoreUnavailable() {
  return Object.assign(
    new Error('MCP 加密凭据存储不可用：请配置 DSH_CREDENTIAL_MASTER_KEY 并重启服务'),
    { status: 503 as const, code: 'MCP_CREDENTIAL_STORE_UNAVAILABLE' },
  )
}

function invalidMcpConnectionInput(message: string) {
  return new RequestError(422, 'MCP_CONNECTION_INVALID', message)
}

function isTypedServiceError(error: unknown): error is Error & { status: number; code: string } {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & { status?: unknown; code?: unknown }
  return typeof candidate.status === 'number' && typeof candidate.code === 'string'
}

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value))

function formatRelative(value: Date | null) {
  if (!value) return '未检查'
  const seconds = Math.max(0, Math.round((Date.now() - value.getTime()) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  return `${Math.floor(seconds / 3600)} 小时前`
}
