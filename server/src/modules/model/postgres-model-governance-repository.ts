import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { ModelGovernanceRepository } from './model-governance-repository.ts'
import type {
  CreateModelRouteInput,
  CreateProviderInput,
  CreateProviderModelInput,
  CredentialBackend,
  CredentialReference,
  CredentialStatus,
  ModelProvider,
  ModelRoute,
  ModelRoutePurpose,
  ModelRouteSnapshot,
  ModelStatus,
  ProviderModel,
  ProviderStatus,
  ProviderTrustLevel,
  ProviderType,
  SetProviderApiKeyInput,
  SetProviderModelStatusInput,
  UpdateModelRouteInput,
  UpdateProviderInput,
} from './model-types.ts'
import { invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'
import { noEnabledRoute, routeCredentialMissing, routeTargetDisabled } from './model-route-errors.ts'
import type { PostgresEncryptedCredentialStore } from '../tool/postgres-encrypted-credential-store.ts'

interface ProviderRow {
  id: string
  key: string
  name: string
  providerType: ProviderType
  trustLevel: ProviderTrustLevel
  baseUrl: string
  status: ProviderStatus
  updatedAt: Date
  credentialId: string | null
  credentialBackend: CredentialBackend | null
  credentialExternalRef: string | null
  credentialStatus: CredentialStatus | null
  credentialLastVerifiedAt: Date | null
  credentialUpdatedAt: Date | null
  credentialHint: string | null
}

interface ModelRow {
  id: string
  providerId: string
  modelKey: string
  displayName: string
  capabilities: string[]
  status: ModelStatus
}

interface RouteRow {
  id: string
  key: string
  name: string
  purpose: ModelRoutePurpose
  providerModelId: string
  providerId: string
  providerName: string
  modelKey: string
  modelName: string
  priority: number
  enabled: boolean
  updatedAt: Date
}

export class PostgresModelGovernanceRepository implements ModelGovernanceRepository {
  private readonly database: DatabaseClient
  private readonly credentials: PostgresEncryptedCredentialStore | undefined

  /** credentials：DSH_CREDENTIAL_MASTER_KEY 配置后提供；未配置时不能录入厂商密钥。 */
  constructor(database: DatabaseClient, credentials?: PostgresEncryptedCredentialStore) {
    this.database = database
    this.credentials = credentials
  }

  async listProviders(tenantId: string): Promise<ModelProvider[]> {
    const providers = await this.database<ProviderRow[]>`
      select p.id, p.key, p.name, p.provider_type as "providerType", p.trust_level as "trustLevel",
             p.base_url as "baseUrl",
             p.status, p.updated_at as "updatedAt",
             c.id as "credentialId", c.backend as "credentialBackend",
             c.external_ref as "credentialExternalRef", c.status as "credentialStatus",
             c.last_verified_at as "credentialLastVerifiedAt", c.updated_at as "credentialUpdatedAt",
             p.credential_hint as "credentialHint"
        from model_providers p
        left join credential_refs c
          on c.tenant_id = p.tenant_id and c.id = p.credential_ref_id
       where p.tenant_id = ${tenantId}
       order by p.created_at asc
    `
    const models = await this.database<ModelRow[]>`
      select id, provider_id as "providerId", model_key as "modelKey",
             display_name as "displayName", capabilities, status
        from provider_models
       where tenant_id = ${tenantId}
       order by display_name asc
    `
    return providers.map((provider) => mapProvider(provider, models.filter((model) => model.providerId === provider.id)))
  }

  async createProvider(tenantId: string, input: CreateProviderInput) {
    const providerId = `provider-${randomUUID()}`
    if (input.apiKey) this.requireCredentialStore()
    try {
      await this.database.begin(async (transaction) => {
        await transaction`
          insert into model_providers (
            id, tenant_id, key, name, provider_type, trust_level, base_url, status
          ) values (
            ${providerId}, ${tenantId}, ${input.key}, ${input.name}, ${input.providerType},
            ${input.trustLevel}, ${input.baseUrl}, 'active'
          )
        `
        if (input.apiKey) await this.writeApiKey(transaction, tenantId, providerId, input.key, input.apiKey, input.actor)
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw stateConflict(`Provider 标识已存在：${input.key}`)
      throw error
    }
    await this.appendAudit(tenantId, input.actor, 'model_provider.create', providerId)
    if (input.apiKey) await this.appendAudit(tenantId, input.actor, 'model_provider.api_key.update', providerId)
    return this.requireProvider(tenantId, providerId)
  }

  async setProviderApiKey(tenantId: string, input: SetProviderApiKeyInput) {
    this.requireCredentialStore()
    const provider = await this.requireProvider(tenantId, input.providerId)
    await this.database.begin(async (transaction) => {
      await this.writeApiKey(transaction, tenantId, provider.id, provider.key, input.apiKey, input.actor)
    })
    await this.appendAudit(tenantId, input.actor, 'model_provider.api_key.update', provider.id)
    return this.requireProvider(tenantId, provider.id)
  }

  async updateProvider(tenantId: string, input: UpdateProviderInput) {
    const result = await this.database`
      update model_providers
         set name = ${input.name}, base_url = ${input.baseUrl}, trust_level = ${input.trustLevel},
             updated_at = now()
       where tenant_id = ${tenantId} and id = ${input.providerId}
    `
    if (result.count !== 1) throw notFound(`Provider 不存在：${input.providerId}`)
    await this.appendAudit(tenantId, input.actor, 'model_provider.update', input.providerId)
    return this.requireProvider(tenantId, input.providerId)
  }

  async setProviderStatus(
    tenantId: string,
    providerId: string,
    status: ProviderStatus,
    actor: string,
  ) {
    const result = await this.database`
      update model_providers
         set status = ${status}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${providerId}
    `
    if (result.count !== 1) throw notFound(`Provider 不存在：${providerId}`)
    await this.appendAudit(tenantId, actor, `model_provider.${status}`, providerId)
    return this.requireProvider(tenantId, providerId)
  }

  async createProviderModel(tenantId: string, input: CreateProviderModelInput) {
    const modelId = `model-${randomUUID()}`
    try {
      await this.database`
        insert into provider_models (
          id, tenant_id, provider_id, model_key, display_name, capabilities, status
        ) values (
          ${modelId}, ${tenantId}, ${input.providerId}, ${input.modelKey}, ${input.displayName},
          ${this.database.json([...new Set(input.capabilities)])}, 'active'
        )
      `
    } catch (error) {
      if (isUniqueViolation(error)) throw stateConflict(`模型标识已存在：${input.modelKey}`)
      throw error
    }
    await this.database`
      update model_providers set updated_at = now()
       where tenant_id = ${tenantId} and id = ${input.providerId}
    `
    await this.appendAudit(tenantId, input.actor, 'provider_model.create', modelId)
    return this.requireProvider(tenantId, input.providerId)
  }

  async setProviderModelStatus(tenantId: string, input: SetProviderModelStatusInput) {
    const [row] = await this.database<{ providerId: string }[]>`
      update provider_models set status = ${input.status}
       where tenant_id = ${tenantId} and id = ${input.modelId}
      returning provider_id as "providerId"
    `
    if (!row) throw notFound(`Provider 模型不存在：${input.modelId}`)
    await this.database`
      update model_providers set updated_at = now()
       where tenant_id = ${tenantId} and id = ${row.providerId}
    `
    await this.appendAudit(tenantId, input.actor, `provider_model.${input.status}`, input.modelId)
    return this.requireProvider(tenantId, row.providerId)
  }

  async listRoutes(tenantId: string): Promise<ModelRoute[]> {
    const rows = await this.database<RouteRow[]>`
      select r.id, r.key, r.name, r.purpose, r.provider_model_id as "providerModelId",
             p.id as "providerId", p.name as "providerName", m.model_key as "modelKey",
             m.display_name as "modelName", r.priority, r.enabled, r.updated_at as "updatedAt"
        from model_routes r
        join provider_models m on m.tenant_id = r.tenant_id and m.id = r.provider_model_id
        join model_providers p on p.tenant_id = m.tenant_id and p.id = m.provider_id
       where r.tenant_id = ${tenantId}
       order by r.priority asc, r.created_at asc
    `
    return rows.map(mapRoute)
  }

  async createRoute(tenantId: string, input: CreateModelRouteInput): Promise<ModelRoute> {
    const routeId = `route-${randomUUID()}`
    await this.database.begin(async (transaction) => {
      await lockDefaultRoutes(transaction, tenantId)
      await assertRouteTarget(transaction, tenantId, input.providerModelId, input.enabled)
      const [duplicate] = await transaction<{ id: string }[]>`
        select id from model_routes where tenant_id = ${tenantId} and key = ${input.key}
      `
      if (duplicate) throw stateConflict(`模型路由标识已存在：${input.key}`)
      if (input.enabled) await disableDefaultRoutes(transaction, tenantId)
      await transaction`
        insert into model_routes (
          id, tenant_id, key, name, purpose, provider_model_id, enabled
        ) values (
          ${routeId}, ${tenantId}, ${input.key}, ${input.name}, 'default',
          ${input.providerModelId}, ${input.enabled}
        )
      `
    })
    await this.appendAudit(tenantId, input.actor, 'model_route.create', routeId)
    return this.requireRoute(tenantId, routeId)
  }

  async updateRoute(tenantId: string, input: UpdateModelRouteInput): Promise<ModelRoute> {
    await this.database.begin(async (transaction) => {
      await lockDefaultRoutes(transaction, tenantId)
      await assertRouteTarget(transaction, tenantId, input.providerModelId, input.enabled)
      if (input.enabled) await disableDefaultRoutes(transaction, tenantId, input.routeId)
      const result = await transaction`
        update model_routes
           set name = ${input.name}, provider_model_id = ${input.providerModelId},
               enabled = ${input.enabled}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.routeId}
      `
      if (result.count !== 1) throw notFound(`模型路由不存在：${input.routeId}`)
    })
    await this.appendAudit(tenantId, input.actor, 'model_route.update', input.routeId)
    return this.requireRoute(tenantId, input.routeId)
  }

  async resolveDefaultRoute(tenantId: string): Promise<ModelRouteSnapshot> {
    const [row] = await this.database<{
      routeId: string
      routeKey: string
      routeName: string
      providerId: string
      providerKey: string
      providerName: string
      providerType: ProviderType
      trustLevel: ProviderTrustLevel
      baseUrl: string
      providerStatus: ProviderStatus
      modelId: string
      modelKey: string
      modelName: string
      modelStatus: ModelStatus
      modelCapabilities: string[]
      credentialRefId: string | null
      credentialBackend: CredentialBackend | null
      credentialExternalRef: string | null
      credentialStatus: CredentialStatus | null
    }[]>`
      select r.id as "routeId", r.key as "routeKey", r.name as "routeName",
             p.id as "providerId", p.key as "providerKey", p.name as "providerName", p.provider_type as "providerType",
             p.trust_level as "trustLevel", p.base_url as "baseUrl", p.status as "providerStatus",
             m.id as "modelId", m.model_key as "modelKey", m.display_name as "modelName", m.status as "modelStatus",
             m.capabilities as "modelCapabilities",
             c.id as "credentialRefId", c.backend as "credentialBackend",
             c.external_ref as "credentialExternalRef", c.status as "credentialStatus"
        from model_routes r
        join provider_models m on m.tenant_id = r.tenant_id and m.id = r.provider_model_id
        join model_providers p on p.tenant_id = m.tenant_id and p.id = m.provider_id
        left join credential_refs c on c.tenant_id = p.tenant_id and c.id = p.credential_ref_id
       where r.tenant_id = ${tenantId} and r.purpose = 'default' and r.enabled
       limit 1
    `
    if (!row) throw noEnabledRoute()
    if (row.providerStatus !== 'active' || row.modelStatus !== 'active') {
      throw routeTargetDisabled({ routeName: row.routeName, providerName: row.providerName, providerActive: row.providerStatus === 'active', modelName: row.modelName, modelKey: row.modelKey })
    }
    if (!row.credentialRefId || !row.credentialBackend || !row.credentialExternalRef || row.credentialStatus !== 'configured') {
      throw routeCredentialMissing(row.providerName)
    }
    return {
      routeId: row.routeId,
      routeKey: row.routeKey,
      providerId: row.providerId,
      providerKey: row.providerKey,
      providerType: row.providerType,
      trustLevel: row.trustLevel,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      modelKey: row.modelKey,
      modelCapabilities: row.modelCapabilities,
      credentialRefId: row.credentialRefId,
      credentialBackend: row.credentialBackend,
      credentialExternalRef: row.credentialExternalRef,
      resolvedAt: new Date().toISOString(),
    }
  }

  private requireCredentialStore() {
    if (!this.credentials) throw stateConflict('服务未配置 DSH_CREDENTIAL_MASTER_KEY，不能保存厂商密钥')
    return this.credentials
  }

  /** 平台加密保存厂商密钥：credential_refs 记录 postgres-encrypted 引用，密文进 credential_secrets，只留后 4 位提示。 */
  private async writeApiKey(transaction: DatabaseTransaction, tenantId: string, providerId: string, providerKey: string, apiKey: string, actor: string) {
    const credentials = this.requireCredentialStore()
    const [provider] = await transaction<{ credentialRefId: string | null }[]>`
      select credential_ref_id as "credentialRefId" from model_providers
       where tenant_id = ${tenantId} and id = ${providerId}
       for update
    `
    if (!provider) throw notFound(`Provider 不存在：${providerId}`)
    const credentialRefId = provider.credentialRefId ?? `credential-${randomUUID()}`
    await transaction`
      insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by)
      values (${credentialRefId}, ${tenantId}, 'postgres-encrypted', ${`model-provider:${providerKey}:api-key`}, 'configured', now(), ${actor})
      on conflict (id) do update
        set backend = 'postgres-encrypted', external_ref = excluded.external_ref, status = 'configured',
            last_verified_at = now(), updated_by = excluded.updated_by, updated_at = now()
    `
    const [secret] = await transaction<{ exists: boolean }[]>`
      select exists (
        select 1 from credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${credentialRefId}
      ) as exists
    `
    const write = { tenantId, credentialRefId, bearerToken: apiKey, actorId: actor }
    if (secret?.exists) await credentials.rotate(transaction, write)
    else await credentials.create(transaction, write)
    await transaction`
      update model_providers
         set credential_ref_id = ${credentialRefId}, credential_hint = ${apiKeyHint(apiKey)}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${providerId}
    `
  }

  private async requireRoute(tenantId: string, routeId: string) {
    const route = (await this.listRoutes(tenantId)).find((item) => item.id === routeId)
    if (!route) throw notFound(`模型路由不存在：${routeId}`)
    return route
  }

  private async requireProvider(tenantId: string, providerId: string) {
    const provider = (await this.listProviders(tenantId)).find((item) => item.id === providerId)
    if (!provider) throw notFound(`Provider 不存在：${providerId}`)
    return provider
  }

  private async appendAudit(tenantId: string, actor: string, action: string, objectId: string) {
    await this.database`
      insert into audit_events (
        id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context
      ) values (
        ${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actor}, ${action},
        'model_governance', ${objectId}, 'success', ${`trace-${randomUUID()}`}, '{}'::jsonb
      )
    `
  }
}

function mapProvider(provider: ProviderRow, models: ModelRow[]): ModelProvider {
  const credential: CredentialReference | null = provider.credentialId && provider.credentialBackend
    && provider.credentialExternalRef && provider.credentialStatus && provider.credentialUpdatedAt
    ? {
        id: provider.credentialId,
        backend: provider.credentialBackend,
        externalRef: provider.credentialExternalRef,
        status: provider.credentialStatus,
        hint: provider.credentialBackend === 'postgres-encrypted' ? provider.credentialHint : null,
        lastVerifiedAt: provider.credentialLastVerifiedAt?.toISOString() ?? null,
        updatedAt: provider.credentialUpdatedAt.toISOString(),
      }
    : null
  return {
    id: provider.id,
    key: provider.key,
    name: provider.name,
    providerType: provider.providerType,
    trustLevel: provider.trustLevel,
    baseUrl: provider.baseUrl,
    status: provider.status,
    credential,
    models: models.map(mapModel),
    updatedAt: provider.updatedAt.toISOString(),
  }
}

function mapModel(model: ModelRow): ProviderModel {
  return { ...model, capabilities: Array.isArray(model.capabilities) ? model.capabilities : [] }
}

function mapRoute(row: RouteRow): ModelRoute {
  return { ...row, updatedAt: row.updatedAt.toISOString() }
}

/** 路由目标必须存在；启用为默认路由时，模型与其 Provider 还必须处于启用状态，否则会让租户失去可用的默认路由。 */
async function assertRouteTarget(transaction: DatabaseTransaction, tenantId: string, modelId: string, enabling: boolean) {
  const [target] = await transaction<{ modelStatus: ModelStatus; providerStatus: ProviderStatus }[]>`
    select m.status as "modelStatus", p.status as "providerStatus"
      from provider_models m
      join model_providers p on p.tenant_id = m.tenant_id and p.id = m.provider_id
     where m.tenant_id = ${tenantId} and m.id = ${modelId}
  `
  if (!target) throw invalidRequest(`目标模型不存在：${modelId}`)
  if (enabling && (target.modelStatus !== 'active' || target.providerStatus !== 'active')) {
    throw stateConflict('目标模型或其 Provider 已停用，不能设为默认路由')
  }
}

/** 同一租户的默认路由切换串行执行，避免并发启用时撞上唯一索引 model_routes_one_default。 */
async function lockDefaultRoutes(transaction: DatabaseTransaction, tenantId: string) {
  await transaction`select pg_advisory_xact_lock(hashtext(${`model_routes_default:${tenantId}`}))`
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

function apiKeyHint(apiKey: string) {
  return apiKey.length > 8 ? apiKey.slice(-4) : null
}

/** 每个租户只能有一条启用的默认路由：启用一条前先停用其余（与唯一索引 model_routes_one_default 一致）。 */
async function disableDefaultRoutes(transaction: DatabaseTransaction, tenantId: string, exceptRouteId?: string) {
  await transaction`
    update model_routes set enabled = false, updated_at = now()
     where tenant_id = ${tenantId} and purpose = 'default' and enabled
       and id <> ${exceptRouteId ?? ''}
  `
}
