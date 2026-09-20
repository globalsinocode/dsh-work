import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
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
  UpsertCredentialReferenceInput,
} from './model-types.ts'

interface ProviderRow {
  id: string
  key: string
  name: string
  providerType: string
  baseUrl: string
  status: ProviderStatus
  updatedAt: Date
  credentialId: string | null
  credentialBackend: CredentialBackend | null
  credentialExternalRef: string | null
  credentialStatus: CredentialStatus | null
  credentialLastVerifiedAt: Date | null
  credentialUpdatedAt: Date | null
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

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async listProviders(tenantId: string): Promise<ModelProvider[]> {
    const providers = await this.database<ProviderRow[]>`
      select p.id, p.key, p.name, p.provider_type as "providerType", p.base_url as "baseUrl",
             p.status, p.updated_at as "updatedAt",
             c.id as "credentialId", c.backend as "credentialBackend",
             c.external_ref as "credentialExternalRef", c.status as "credentialStatus",
             c.last_verified_at as "credentialLastVerifiedAt", c.updated_at as "credentialUpdatedAt"
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
    await this.database`
      insert into model_providers (
        id, tenant_id, key, name, provider_type, base_url, status
      ) values (
        ${providerId}, ${tenantId}, ${input.key}, ${input.name}, ${input.providerType}, ${input.baseUrl}, 'active'
      )
    `
    await this.appendAudit(tenantId, input.actor, 'model_provider.create', providerId)
    return this.requireProvider(tenantId, providerId)
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
    if (result.count !== 1) throw new Error(`Provider 不存在：${providerId}`)
    await this.appendAudit(tenantId, actor, `model_provider.${status}`, providerId)
    return this.requireProvider(tenantId, providerId)
  }

  async createProviderModel(tenantId: string, input: CreateProviderModelInput) {
    const modelId = `model-${randomUUID()}`
    await this.database`
      insert into provider_models (
        id, tenant_id, provider_id, model_key, display_name, capabilities, status
      ) values (
        ${modelId}, ${tenantId}, ${input.providerId}, ${input.modelKey}, ${input.displayName},
        ${this.database.json([...new Set(input.capabilities)])}, 'active'
      )
    `
    await this.database`
      update model_providers set updated_at = now()
       where tenant_id = ${tenantId} and id = ${input.providerId}
    `
    await this.appendAudit(tenantId, input.actor, 'provider_model.create', modelId)
    return this.requireProvider(tenantId, input.providerId)
  }

  async upsertCredentialReference(tenantId: string, input: UpsertCredentialReferenceInput) {
    const provider = await this.requireProvider(tenantId, input.providerId)
    const credentialId = provider.credential?.id ?? `credential-${randomUUID()}`
    await this.database.begin(async (transaction) => {
      await transaction`
        insert into credential_refs (
          id, tenant_id, backend, external_ref, status, last_verified_at, updated_by
        ) values (
          ${credentialId}, ${tenantId}, ${input.backend}, ${input.externalRef}, ${input.status},
          ${input.status === 'configured' ? new Date() : null}, ${input.actor}
        )
        on conflict (id) do update
          set backend = excluded.backend,
              external_ref = excluded.external_ref,
              status = excluded.status,
              last_verified_at = excluded.last_verified_at,
              updated_by = excluded.updated_by,
              updated_at = now()
      `
      await transaction`
        update model_providers
           set credential_ref_id = ${credentialId}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.providerId}
      `
    })
    await this.appendAudit(tenantId, input.actor, 'model_provider.credential_ref.update', input.providerId)
    return this.requireProvider(tenantId, input.providerId)
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
      if (input.purpose === 'default' && input.enabled) {
        await transaction`
          update model_routes set enabled = false, updated_at = now()
           where tenant_id = ${tenantId} and purpose = 'default' and enabled
        `
      }
      await transaction`
        insert into model_routes (
          id, tenant_id, key, name, purpose, provider_model_id, priority, enabled
        ) values (
          ${routeId}, ${tenantId}, ${input.key}, ${input.name}, ${input.purpose},
          ${input.providerModelId}, ${input.priority}, ${input.enabled}
        )
      `
    })
    await this.appendAudit(tenantId, input.actor, 'model_route.create', routeId)
    const route = (await this.listRoutes(tenantId)).find((item) => item.id === routeId)
    if (!route) throw new Error(`模型路由创建失败：${routeId}`)
    return route
  }

  async resolveRoute(tenantId: string, routeKey = 'default'): Promise<ModelRouteSnapshot> {
    const [row] = await this.database<{
      routeId: string
      routeKey: string
      providerId: string
      providerKey: string
      providerType: string
      baseUrl: string
      providerStatus: ProviderStatus
      modelId: string
      modelKey: string
      modelStatus: ModelStatus
      modelCapabilities: string[]
      credentialRefId: string | null
      credentialBackend: CredentialBackend | null
      credentialExternalRef: string | null
      credentialStatus: CredentialStatus | null
    }[]>`
      select r.id as "routeId", r.key as "routeKey",
             p.id as "providerId", p.key as "providerKey", p.provider_type as "providerType",
             p.base_url as "baseUrl", p.status as "providerStatus",
             m.id as "modelId", m.model_key as "modelKey", m.status as "modelStatus",
             m.capabilities as "modelCapabilities",
             c.id as "credentialRefId", c.backend as "credentialBackend",
             c.external_ref as "credentialExternalRef", c.status as "credentialStatus"
        from model_routes r
        join provider_models m on m.tenant_id = r.tenant_id and m.id = r.provider_model_id
        join model_providers p on p.tenant_id = m.tenant_id and p.id = m.provider_id
        left join credential_refs c on c.tenant_id = p.tenant_id and c.id = p.credential_ref_id
       where r.tenant_id = ${tenantId} and r.key = ${routeKey} and r.enabled
       order by r.priority asc
       limit 1
    `
    if (!row) throw new Error(`没有可用的模型路由：${routeKey}`)
    if (row.providerStatus !== 'active' || row.modelStatus !== 'active') throw new Error('模型路由目标已停用')
    if (!row.credentialRefId || !row.credentialBackend || !row.credentialExternalRef || row.credentialStatus !== 'configured') {
      throw new Error('Provider 凭据未配置')
    }
    return {
      routeId: row.routeId,
      routeKey: row.routeKey,
      providerId: row.providerId,
      providerKey: row.providerKey,
      providerType: row.providerType,
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

  private async requireProvider(tenantId: string, providerId: string) {
    const provider = (await this.listProviders(tenantId)).find((item) => item.id === providerId)
    if (!provider) throw new Error(`Provider 不存在：${providerId}`)
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
        lastVerifiedAt: provider.credentialLastVerifiedAt?.toISOString() ?? null,
        updatedAt: provider.credentialUpdatedAt.toISOString(),
      }
    : null
  return {
    id: provider.id,
    key: provider.key,
    name: provider.name,
    providerType: provider.providerType,
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
