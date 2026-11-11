import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { AuditTrail } from '../../domain/audit-trail.ts'
import { dependencyUnavailable, invalidRequest, notFound, RequestError, stateConflict } from '../../domain/request-errors.ts'
import { requirePlatformAdminActor } from '../authorization/platform-admin-actor.ts'
import type { PostgresEncryptedCredentialStore } from '../tool/postgres-encrypted-credential-store.ts'
import { knowledgeCredentialRefId, normalizeApiKey, normalizeBaseUrl, sameBaseUrl, type PostgresKnowledgeConnection } from './knowledge-connection.ts'
import { WeKnoraRequestError, WeKnoraUnavailableError, type WeKnoraClient } from './weknora-client.ts'

const tenantId = 'tenant-dsh-work'

export interface KnowledgeAdminConnection {
  configured: boolean
  baseUrl: string | null
  credentialHint: string | null
  credentialExpiresAt: string | null
  /** admin：管理端保存的加密 Key；deployment：部署配置（WEKNORA_API_KEY）。 */
  credentialSource: 'admin' | 'deployment' | null
  embeddingModelId: string | null
  enabled: boolean
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastFailureReason: string | null
  /** 最近一次检索响应中的重排序结果（WeKnora meta.rerank.outcome，优化方案 O5）与时间。 */
  lastRerankOutcome: string | null
  lastRerankAt: string | null
}

export interface KnowledgeAdminOverview {
  connection: KnowledgeAdminConnection & {
    /** 启用且能读出 API Key（主密钥正确、凭据完整）时为 true；为 false 时检索与员工端实际不可用。 */
    credentialReadable: boolean
  }
  /** 最近 24 小时调用了 WeKnora 的执行数与其中不可用的次数（按 Manifest 的 knowledge_status 统计）。 */
  health: { retrievals24h: number; unavailable24h: number }
}

export interface KnowledgeAdminGrant {
  id: string
  departmentId: string
  departmentName: string
  includeDescendants: boolean
  grantedVia: 'employee' | 'admin'
}

export interface KnowledgeAdminBase {
  id: string
  name: string
  description: string
  ownerDepartmentId: string
  ownerDepartmentName: string
  ownerDepartmentActive: boolean
  grants: KnowledgeAdminGrant[]
  /** WeKnora 不可用时为 null。 */
  documentCount: number | null
  updatedAt: string | null
  embeddingModelId: string | null
  /**
   * 建库时的嵌入模型与当前连接配置不同（4.6）。WeKnora 按各知识库自己的嵌入模型检索，旧模型仍登记在 WeKnora 中时
   * 照常可用；旧模型被删除后才失效（优化方案 O10）。
   */
  needsRebuild: boolean
  /** active：有效；unavailable：原连接已更换，不参与检索、员工端不显示，可恢复（优化方案 O9）。 */
  status: 'active' | 'unavailable'
  /** WeKnora 中为该知识库配置了摘要模型（优化方案 O7）；WeKnora 不可用时为 null。 */
  summaryModelConfigured: boolean | null
}

export interface KnowledgeAdminBaseList {
  items: KnowledgeAdminBase[]
  /** WeKnora 统计是否读取成功；失败时文档数与更新时间为空，知识库与授权仍可查看和调整。 */
  statsAvailable: boolean
}

export interface KnowledgeAdminDepartment {
  id: string
  /** 带上级路径的名称，例如“供应链部 / 计划组”；根部门为“全公司”。 */
  label: string
  root: boolean
}

interface ConnectionRow {
  baseUrl: string
  credentialRef: string | null
  credentialHint: string | null
  credentialExpiresAt: Date | null
  embeddingModelId: string | null
  status: string
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  lastFailureReason: string | null
  lastRerankOutcome: string | null
  lastRerankAt: Date | null
}

/**
 * 管理端“企业知识库”（weknora-knowledge-plan 第 9 节，WK-S3）：连接配置、全部知识库与跨部门授权、
 * 归属部门、新建与删除、健康状态。读取需要管理读权限（路由层），写入只有平台管理员可以执行；
 * 平台管理员可以授给任意有效部门（含根部门）并撤销任何授权（5.4）。文档不在管理端维护。
 */
export class PostgresKnowledgeAdminService {
  private readonly database: DatabaseClient
  private readonly audit: AuditTrail
  private readonly connection: PostgresKnowledgeConnection
  private readonly credentials: PostgresEncryptedCredentialStore | undefined

  constructor(
    database: DatabaseClient,
    audit: AuditTrail,
    connection: PostgresKnowledgeConnection,
    credentials?: PostgresEncryptedCredentialStore,
  ) {
    this.database = database
    this.audit = audit
    this.connection = connection
    this.credentials = credentials
  }

  async overview(): Promise<KnowledgeAdminOverview> {
    const row = await this.row()
    // 不可用次数按失败审计统计：连接被停用或 Key 读不出（not_configured）时执行也记为 unavailable，但不是检索故障，
    // 不写审计，也不计入检索与不可用次数（优化方案 O2）。
    const [health] = await this.database<{ retrievals: number; unavailable: number }[]>`
      with unavailable as (
        select count(*)::int as count from audit_events
         where tenant_id = ${tenantId} and action = 'knowledge.retrieve.unavailable' and result = 'failed'
           and occurred_at > now() - interval '24 hours'
      )
      select (select count(*)::int from run_attempts
               where tenant_id = ${tenantId} and created_at > now() - interval '24 hours'
                 and manifest->>'knowledge_status' = 'ok') + (select count from unavailable) as retrievals,
             (select count from unavailable) as unavailable
    `
    return {
      connection: {
        configured: Boolean(row),
        baseUrl: row?.baseUrl ?? null,
        credentialHint: row?.credentialHint ?? null,
        credentialExpiresAt: row?.credentialExpiresAt?.toISOString() ?? null,
        credentialSource: !row ? null : row.credentialRef ? 'admin' : 'deployment',
        embeddingModelId: row?.embeddingModelId ?? null,
        enabled: row?.status === 'active',
        lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: row?.lastFailureAt?.toISOString() ?? null,
        lastFailureReason: row?.lastFailureReason ?? null,
        lastRerankOutcome: row?.lastRerankOutcome ?? null,
        lastRerankAt: row?.lastRerankAt?.toISOString() ?? null,
        credentialReadable: row?.status === 'active' ? (await this.connection.client()) !== null : false,
      },
      health: { retrievals24h: health?.retrievals ?? 0, unavailable24h: health?.unavailable ?? 0 },
    }
  }

  async updateConnection(actorId: string, input: {
    baseUrl: string
    apiKey?: string
    credentialExpiresAt?: string | null
    embeddingModelId?: string | null
    enabled: boolean
  }): Promise<KnowledgeAdminOverview> {
    await requirePlatformAdminActor(this.database, actorId)
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const embeddingModelId = input.embeddingModelId?.trim() || null
    if (embeddingModelId && embeddingModelId.length > 128) throw invalidRequest('嵌入模型 ID 不能超过 128 个字符')
    const expiresAt = input.credentialExpiresAt ? new Date(input.credentialExpiresAt) : null
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw invalidRequest('API Key 到期时间无效')
    const apiKey = normalizeApiKey(input.apiKey)
    const existing = await this.row()
    if (!existing && !apiKey) throw invalidRequest('首次配置须填写 API Key')
    // 已保存的 Key 只发往已保存的地址：更换地址必须同时填写 Key，避免把 Key 带到新主机。
    if (existing && !apiKey && !sameBaseUrl(baseUrl, existing.baseUrl)) throw invalidRequest('更换 WeKnora 地址时须重新填写 API Key')
    if (apiKey && !this.credentials) throw stateConflict('服务未配置 DSH_CREDENTIAL_MASTER_KEY，不能保存 API Key')
    let movedBases = 0
    await this.database.begin(async transaction => {
      if (apiKey) {
        await transaction`
          insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by)
          values (${knowledgeCredentialRefId}, ${tenantId}, 'dsh-managed', 'weknora:api-key', 'configured', null, ${actorId})
          on conflict (id) do update set status = 'configured', updated_by = excluded.updated_by, updated_at = now()
        `
        const [secret] = await transaction<{ exists: boolean }[]>`
          select exists (
            select 1 from credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${knowledgeCredentialRefId}
          ) as exists
        `
        const write = { tenantId, credentialRefId: knowledgeCredentialRefId, bearerToken: apiKey, actorId }
        if (secret?.exists) await this.credentials!.rotate(transaction, write)
        else await this.credentials!.create(transaction, write)
      }
      const hint = apiKey ? (apiKey.length > 8 ? apiKey.slice(-4) : null) : existing?.credentialHint ?? null
      const credentialRef = apiKey ? knowledgeCredentialRefId : existing?.credentialRef ?? null
      // 未填写到期时间时：沿用原 Key 的到期时间；换了新 Key 则不再沿用（旧 Key 的到期时间不属于新 Key）。
      const credentialExpiresAt = input.credentialExpiresAt === undefined ? (apiKey ? null : existing?.credentialExpiresAt ?? null) : expiresAt
      // 换了 Key 或地址后，旧连接的失败记录不再代表当前状态。
      const connectionChanged = Boolean(apiKey) || !existing || !sameBaseUrl(baseUrl, existing.baseUrl)
      // 优化方案 O9：更换地址后，现有知识库的外部 ID 属于原实例，标为“原连接已更换”，不再参与检索，由管理员逐个恢复。
      if (existing && !sameBaseUrl(baseUrl, existing.baseUrl)) {
        const moved = await transaction`
          update external_knowledge_bases set status = 'unavailable', updated_by = ${actorId}, updated_at = now()
           where tenant_id = ${tenantId} and connection_id = ${this.connection.connectionId} and status = 'active'
        `
        movedBases = moved.count
      }
      await transaction`
        insert into external_knowledge_connections (
          id, tenant_id, base_url, credential_ref, credential_hint, credential_expires_at, embedding_model_id, status, updated_by
        ) values (
          ${this.connection.connectionId}, ${tenantId}, ${baseUrl}, ${credentialRef}, ${hint}, ${credentialExpiresAt},
          ${embeddingModelId}, ${input.enabled ? 'active' : 'disabled'}, ${actorId}
        )
        on conflict (tenant_id) do update
           set base_url = excluded.base_url, credential_ref = excluded.credential_ref, credential_hint = excluded.credential_hint,
               credential_expires_at = excluded.credential_expires_at, embedding_model_id = excluded.embedding_model_id,
               status = excluded.status, updated_by = excluded.updated_by, updated_at = now(),
               last_failure_at = case when ${connectionChanged} then null else external_knowledge_connections.last_failure_at end,
               last_failure_reason = case when ${connectionChanged} then null else external_knowledge_connections.last_failure_reason end
      `
    })
    await this.record(actorId, 'knowledge.connection.update', this.connection.connectionId,
      `更新企业知识库连接：${baseUrl}，嵌入模型 ${embeddingModelId ?? '未配置'}，${input.enabled ? '启用' : '停用'}${apiKey ? '，已更换 API Key' : ''}${movedBases ? `，${movedBases} 个知识库因更换地址标为原连接已更换` : ''}`,
      'knowledge_connection')
    return this.overview()
  }

  /** 用填写的（或已保存的）地址与 Key 调用 WeKnora 的知识库列表接口，只返回结果与原因分类。 */
  async testConnection(actorId: string, input: { baseUrl?: string; apiKey?: string }): Promise<{ ok: boolean; reason: string | null }> {
    await requirePlatformAdminActor(this.database, actorId)
    const baseUrl = input.baseUrl ? normalizeBaseUrl(input.baseUrl) : undefined
    const apiKey = normalizeApiKey(input.apiKey)
    const probe = await this.connection.probeClient({ ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) })
    if ('reason' in probe) return { ok: false, reason: probe.reason }
    try {
      await probe.client.listKnowledgeBases()
      // 测的是已保存的连接时记一次成功，“暂不可用”提示随之消失，不必等下一次检索。
      if (!apiKey && (!baseUrl || sameBaseUrl(baseUrl, await this.connection.savedBaseUrl() ?? ''))) {
        await this.database`
          update external_knowledge_connections set last_success_at = now()
           where tenant_id = ${tenantId} and id = ${this.connection.connectionId}
        `
      }
      return { ok: true, reason: null }
    } catch (error) {
      if (error instanceof WeKnoraUnavailableError) return { ok: false, reason: error.reason }
      if (error instanceof WeKnoraRequestError) return { ok: false, reason: 'request_rejected' }
      throw error
    }
  }

  async listBases(): Promise<KnowledgeAdminBaseList> {
    const rows = await this.database<(Omit<KnowledgeAdminBase, 'grants' | 'documentCount' | 'updatedAt' | 'needsRebuild' | 'summaryModelConfigured'> & { externalId: string })[]>`
      select kb.id, kb.external_id as "externalId", kb.name, kb.description,
             kb.owner_department_id as "ownerDepartmentId", d.name as "ownerDepartmentName",
             d.status = 'active' as "ownerDepartmentActive", kb.embedding_model_id as "embeddingModelId", kb.status
        from external_knowledge_bases kb
        join org_departments d on d.tenant_id = kb.tenant_id and d.id = kb.owner_department_id
       where kb.tenant_id = ${tenantId} and kb.connection_id = ${this.connection.connectionId} and kb.status <> 'deleted'
       order by kb.created_at, kb.id
    `
    const grants = rows.length ? await this.database<(KnowledgeAdminGrant & { knowledgeBaseId: string })[]>`
      select g.id, g.knowledge_base_id as "knowledgeBaseId", g.department_id as "departmentId",
             case when d.parent_id is null then '全公司' else d.name end as "departmentName",
             g.include_descendants as "includeDescendants", g.granted_via as "grantedVia"
        from external_knowledge_base_grants g
        join org_departments d on d.tenant_id = g.tenant_id and d.id = g.department_id and d.status = 'active'
       where g.tenant_id = ${tenantId} and g.status = 'active' and g.knowledge_base_id in ${this.database(rows.map(row => row.id))}
       order by g.created_at, g.id
    ` : []
    const currentModel = await this.connection.embeddingModelId()
    let stats = new Map<string, { knowledgeCount: number; updatedAt: string | null; summaryModelId: string | null }>()
    let statsAvailable = true
    const client = rows.length ? await this.connection.client() : null
    if (rows.length) {
      try {
        if (!client) throw new WeKnoraUnavailableError('network', 'not configured')
        stats = new Map((await client.listKnowledgeBases()).map(item => [item.id, item]))
      } catch (error) {
        if (!(error instanceof WeKnoraUnavailableError || error instanceof WeKnoraRequestError)) throw error
        statsAvailable = false
      }
    }
    return {
      statsAvailable,
      items: rows.map(({ externalId, ...row }) => {
        const stat = stats.get(externalId)
        return {
          ...row,
          grants: grants.filter(grant => grant.knowledgeBaseId === row.id).map(({ knowledgeBaseId: _id, ...grant }) => grant),
          documentCount: statsAvailable ? stat?.knowledgeCount ?? 0 : null,
          updatedAt: statsAvailable ? stat?.updatedAt ?? null : null,
          summaryModelConfigured: statsAvailable && stat ? stat.summaryModelId !== null : null,
          needsRebuild: Boolean(currentModel && row.embeddingModelId && row.embeddingModelId !== currentModel),
        }
      }),
    }
  }

  async departments(): Promise<KnowledgeAdminDepartment[]> {
    const rows = await this.database<{ id: string; name: string; path: string; root: boolean }[]>`
      select id, name, path, parent_id is null as root from org_departments
       where tenant_id = ${tenantId} and status = 'active' order by path
    `
    const names = new Map(rows.map(row => [row.id, row.name]))
    return rows.map(row => ({
      id: row.id,
      root: row.root,
      label: row.root ? '全公司' : row.path.split('/').filter(Boolean).slice(1).map(id => names.get(id) ?? id).join(' / '),
    }))
  }

  async createBase(actorId: string, input: { name: string; description?: string; ownerDepartmentId: string }): Promise<KnowledgeAdminBaseList> {
    await requirePlatformAdminActor(this.database, actorId)
    const name = input.name.trim()
    if (!name || name.length > 60) throw invalidRequest('名称长度为 1～60 个字')
    const description = (input.description ?? '').trim()
    if (description.length > 200) throw invalidRequest('说明不能超过 200 个字')
    const owner = await this.requireDepartment(input.ownerDepartmentId, { allowRoot: false })
    const embeddingModelId = await this.connection.embeddingModelId()
    if (!embeddingModelId) throw dependencyUnavailable('尚未配置统一嵌入模型，请先在连接配置中填写')
    const client = await this.requireClient()
    const created = await this.call(() => client.createKnowledgeBase({ name, description, embeddingModelId }))
    const id = `knowledge-base-${randomUUID()}`
    try {
      await this.database.begin(async transaction => {
        await transaction`
          insert into external_knowledge_bases (
            id, tenant_id, connection_id, external_id, name, description, owner_department_id, embedding_model_id, created_by, updated_by
          ) values (
            ${id}, ${tenantId}, ${this.connection.connectionId}, ${created.id}, ${name}, ${description}, ${owner.id},
            ${embeddingModelId}, ${actorId}, ${actorId}
          )
        `
        await transaction`
          insert into external_knowledge_base_grants (id, tenant_id, knowledge_base_id, department_id, include_descendants, granted_by, granted_via)
          values (${`knowledge-grant-${randomUUID()}`}, ${tenantId}, ${id}, ${owner.id}, true, ${actorId}, 'admin')
        `
      })
    } catch (error) {
      await client.deleteKnowledgeBase(created.id).catch(() => undefined)
      throw error
    }
    await this.record(actorId, 'knowledge.base.create', id, `管理员新建知识库“${name}”，归属与可见部门：${owner.label}（含下级）`)
    return this.listBases()
  }

  async updateOwner(actorId: string, knowledgeBaseId: string, ownerDepartmentId: string): Promise<KnowledgeAdminBaseList> {
    await requirePlatformAdminActor(this.database, actorId)
    const base = await this.requireBase(knowledgeBaseId)
    const owner = await this.requireDepartment(ownerDepartmentId, { allowRoot: false })
    await this.database`
      update external_knowledge_bases set owner_department_id = ${owner.id}, updated_by = ${actorId}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${base.id}
    `
    await this.record(actorId, 'knowledge.base.owner', base.id, `把知识库“${base.name}”的归属部门改为${owner.label}`)
    return this.listBases()
  }

  async addGrant(actorId: string, knowledgeBaseId: string, input: { departmentId: string; includeDescendants?: boolean }): Promise<KnowledgeAdminBaseList> {
    await requirePlatformAdminActor(this.database, actorId)
    const base = await this.requireBase(knowledgeBaseId)
    const department = await this.requireDepartment(input.departmentId, { allowRoot: true })
    // 已有有效授权时按本次选择更新“含下级”；完全相同时不写入也不记审计。
    const includeDescendants = input.includeDescendants ?? true
    const changed = await this.database`
      insert into external_knowledge_base_grants (id, tenant_id, knowledge_base_id, department_id, include_descendants, granted_by, granted_via)
      values (${`knowledge-grant-${randomUUID()}`}, ${tenantId}, ${base.id}, ${department.id}, ${includeDescendants}, ${actorId}, 'admin')
      on conflict (tenant_id, knowledge_base_id, department_id) where status = 'active'
      do update set include_descendants = excluded.include_descendants, granted_by = excluded.granted_by, granted_via = 'admin'
       -- 优化方案 O12：管理员再次授予或调整过的授权归管理员，员工不能再撤销。
       where external_knowledge_base_grants.include_descendants is distinct from excluded.include_descendants
          or external_knowledge_base_grants.granted_via <> 'admin'
    `
    if (changed.count) {
      await this.record(actorId, 'knowledge.grant.add', base.id,
        `管理员把知识库“${base.name}”授给${department.label}${input.includeDescendants === false || department.root ? '' : '（含下级）'}`)
    }
    return this.listBases()
  }

  /** 平台管理员可以撤销任何授权，包括员工授予的，也可以撤到没有任何授权（员工都看不到）。 */
  async revokeGrant(actorId: string, knowledgeBaseId: string, grantId: string): Promise<KnowledgeAdminBaseList> {
    await requirePlatformAdminActor(this.database, actorId)
    const base = await this.requireBase(knowledgeBaseId)
    const [revoked] = await this.database<{ departmentName: string }[]>`
      with revoked as (
        update external_knowledge_base_grants set status = 'invalid', invalidated_at = now()
         where tenant_id = ${tenantId} and id = ${grantId} and knowledge_base_id = ${base.id} and status = 'active'
         returning tenant_id, department_id
      )
      select case when d.id is null then r.department_id when d.parent_id is null then '全公司' else d.name end as "departmentName"
        from revoked r left join org_departments d on d.tenant_id = r.tenant_id and d.id = r.department_id
    `
    if (!revoked) throw notFound('授权不存在')
    await this.record(actorId, 'knowledge.grant.revoke', base.id, `管理员撤销知识库“${base.name}”对${revoked.departmentName}的授权`)
    return this.listBases()
  }

  async deleteBase(actorId: string, knowledgeBaseId: string): Promise<KnowledgeAdminBaseList> {
    await requirePlatformAdminActor(this.database, actorId)
    const base = await this.requireBase(knowledgeBaseId)
    const client = await this.requireClient()
    try {
      await this.call(() => client.deleteKnowledgeBase(base.externalId))
    } catch (error) {
      // WeKnora 中已不存在时，平台侧照常标为已删除。
      if (!(error instanceof RequestError && error.status === 404)) throw error
    }
    await this.database`
      update external_knowledge_bases set status = 'deleted', updated_by = ${actorId}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${base.id}
    `
    await this.record(actorId, 'knowledge.base.delete', base.id, `管理员删除知识库“${base.name}”`)
    return this.listBases()
  }

  /**
   * 恢复“原连接已更换”的知识库（优化方案 O9）：先确认当前连接的 WeKnora 中存在该知识库，存在才恢复为有效。
   * 用于把地址改回原实例，或新地址只是同一实例的另一个访问地址。
   */
  async restoreBase(actorId: string, knowledgeBaseId: string): Promise<KnowledgeAdminBaseList> {
    await requirePlatformAdminActor(this.database, actorId)
    const base = await this.requireBase(knowledgeBaseId)
    if (base.status !== 'unavailable') throw stateConflict('知识库不需要恢复')
    const client = await this.requireClient()
    const present = (await this.call(() => client.listKnowledgeBases())).some(item => item.id === base.externalId)
    if (!present) throw stateConflict('当前连接的知识库服务中没有这个知识库，不能恢复；如需继续使用请重建')
    await this.database`
      update external_knowledge_bases set status = 'active', updated_by = ${actorId}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${base.id} and status = 'unavailable'
    `
    await this.record(actorId, 'knowledge.base.restore', base.id, `恢复知识库“${base.name}”（当前连接中存在）`)
    return this.listBases()
  }

  private async row(): Promise<ConnectionRow | undefined> {
    const [row] = await this.database<ConnectionRow[]>`
      select base_url as "baseUrl", credential_ref as "credentialRef", credential_hint as "credentialHint",
             credential_expires_at as "credentialExpiresAt", embedding_model_id as "embeddingModelId", status,
             last_success_at as "lastSuccessAt", last_failure_at as "lastFailureAt", last_failure_reason as "lastFailureReason",
             last_rerank_outcome as "lastRerankOutcome", last_rerank_at as "lastRerankAt"
        from external_knowledge_connections where tenant_id = ${tenantId} and id = ${this.connection.connectionId}
    `
    return row
  }

  private async requireBase(knowledgeBaseId: string) {
    const [base] = await this.database<{ id: string; externalId: string; name: string; status: string }[]>`
      select id, external_id as "externalId", name, status from external_knowledge_bases
       where tenant_id = ${tenantId} and id = ${knowledgeBaseId} and connection_id = ${this.connection.connectionId} and status <> 'deleted'
    `
    if (!base) throw notFound('知识库不存在')
    return base
  }

  private async requireDepartment(departmentId: string, options: { allowRoot: boolean }) {
    const department = (await this.departments()).find(item => item.id === departmentId)
    if (!department) throw invalidRequest('部门不存在或已删除')
    if (department.root && !options.allowRoot) throw invalidRequest('归属部门不能是根部门')
    return department
  }

  private async requireClient(): Promise<WeKnoraClient> {
    const client = await this.connection.client()
    if (!client) throw dependencyUnavailable('企业知识库尚未配置或已停用')
    return client
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof WeKnoraUnavailableError) throw dependencyUnavailable('知识库服务暂不可用，请稍后重试')
      if (error instanceof WeKnoraRequestError) {
        if (error.status === 404) throw notFound('知识库服务中找不到该对象')
        if (error.status === 409) throw stateConflict('知识库服务中已有同名对象，请换一个名称')
        throw invalidRequest('知识库服务拒绝了这个请求')
      }
      throw error
    }
  }

  private async record(actorId: string, action: string, objectId: string, detail: string, objectType = 'knowledge_base') {
    await this.audit.appendAudit(actorId, action, objectId, 'success', `trace-knowledge-${randomUUID()}`, detail, objectType)
  }
}
