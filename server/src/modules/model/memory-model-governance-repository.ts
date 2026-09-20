import { randomUUID } from 'node:crypto'

import type { ModelGovernanceRepository } from './model-governance-repository.ts'
import type {
  CreateModelRouteInput,
  CreateProviderInput,
  CreateProviderModelInput,
  CredentialReference,
  ModelProvider,
  ModelRoute,
  ModelRouteSnapshot,
  ProviderStatus,
  UpsertCredentialReferenceInput,
} from './model-types.ts'

const clone = <T>(value: T): T => structuredClone(value)

export class MemoryModelGovernanceRepository implements ModelGovernanceRepository {
  private readonly providers: ModelProvider[] = [createSeedProvider()]
  private readonly routes: ModelRoute[] = [createSeedRoute()]

  async listProviders() {
    return clone(this.providers)
  }

  async createProvider(_tenantId: string, input: CreateProviderInput) {
    if (this.providers.some((provider) => provider.key === input.key)) {
      throw new Error(`Provider 标识已存在：${input.key}`)
    }
    const timestamp = new Date().toISOString()
    const provider: ModelProvider = {
      id: `provider-${randomUUID()}`,
      key: input.key,
      name: input.name,
      providerType: input.providerType,
      baseUrl: input.baseUrl,
      status: 'active',
      credential: null,
      models: [],
      updatedAt: timestamp,
    }
    this.providers.push(provider)
    return clone(provider)
  }

  async setProviderStatus(_tenantId: string, providerId: string, status: ProviderStatus) {
    const provider = this.requireProvider(providerId)
    provider.status = status
    provider.updatedAt = new Date().toISOString()
    return clone(provider)
  }

  async createProviderModel(_tenantId: string, input: CreateProviderModelInput) {
    const provider = this.requireProvider(input.providerId)
    if (provider.models.some((model) => model.modelKey === input.modelKey)) {
      throw new Error(`模型标识已存在：${input.modelKey}`)
    }
    provider.models.push({
      id: `model-${randomUUID()}`,
      providerId: provider.id,
      modelKey: input.modelKey,
      displayName: input.displayName,
      capabilities: [...new Set(input.capabilities)],
      status: 'active',
    })
    provider.updatedAt = new Date().toISOString()
    return clone(provider)
  }

  async upsertCredentialReference(_tenantId: string, input: UpsertCredentialReferenceInput) {
    const provider = this.requireProvider(input.providerId)
    const timestamp = new Date().toISOString()
    const credential: CredentialReference = {
      id: provider.credential?.id ?? `credential-${randomUUID()}`,
      backend: input.backend,
      externalRef: input.externalRef,
      status: input.status,
      lastVerifiedAt: input.status === 'configured' ? timestamp : null,
      updatedAt: timestamp,
    }
    provider.credential = credential
    provider.updatedAt = timestamp
    return clone(provider)
  }

  async listRoutes() {
    return clone(this.routes)
  }

  async createRoute(_tenantId: string, input: CreateModelRouteInput) {
    if (this.routes.some((route) => route.key === input.key)) {
      throw new Error(`模型路由标识已存在：${input.key}`)
    }
    if (input.purpose === 'default' && input.enabled) {
      for (const route of this.routes) {
        if (route.purpose === 'default') route.enabled = false
      }
    }
    const { provider, model } = this.requireModel(input.providerModelId)
    const route: ModelRoute = {
      id: `route-${randomUUID()}`,
      key: input.key,
      name: input.name,
      purpose: input.purpose,
      providerModelId: model.id,
      providerId: provider.id,
      providerName: provider.name,
      modelKey: model.modelKey,
      modelName: model.displayName,
      priority: input.priority,
      enabled: input.enabled,
      updatedAt: new Date().toISOString(),
    }
    this.routes.push(route)
    return clone(route)
  }

  async resolveRoute(_tenantId: string, routeKey = 'default'): Promise<ModelRouteSnapshot> {
    const route = this.routes.find((item) => item.key === routeKey && item.enabled)
    if (!route) throw new Error(`没有可用的模型路由：${routeKey}`)
    const { provider, model } = this.requireModel(route.providerModelId)
    if (provider.status !== 'active' || model.status !== 'active') throw new Error('模型路由目标已停用')
    if (!provider.credential || provider.credential.status !== 'configured') throw new Error('Provider 凭据未配置')
    return {
      routeId: route.id,
      routeKey: route.key,
      providerId: provider.id,
      providerKey: provider.key,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      modelId: model.id,
      modelKey: model.modelKey,
      modelCapabilities: [...model.capabilities],
      credentialRefId: provider.credential.id,
      credentialBackend: provider.credential.backend,
      credentialExternalRef: provider.credential.externalRef,
      resolvedAt: new Date().toISOString(),
    }
  }

  private requireProvider(providerId: string) {
    const provider = this.providers.find((item) => item.id === providerId)
    if (!provider) throw new Error(`Provider 不存在：${providerId}`)
    return provider
  }

  private requireModel(modelId: string) {
    for (const provider of this.providers) {
      const model = provider.models.find((item) => item.id === modelId)
      if (model) return { provider, model }
    }
    throw new Error(`Provider 模型不存在：${modelId}`)
  }
}

function createSeedProvider(): ModelProvider {
  const timestamp = '2026-08-30T00:00:00.000Z'
  return {
    id: 'provider-deepseek-official',
    key: 'deepseek-official',
    name: 'DeepSeek 官方',
    providerType: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    status: 'active',
    credential: {
      id: 'credential-deepseek-default',
      backend: 'dsh-managed',
      externalRef: 'DEEPSEEK_API_KEY',
      status: 'configured',
      lastVerifiedAt: timestamp,
      updatedAt: timestamp,
    },
    models: [{
      id: 'model-deepseek-v4-pro',
      providerId: 'provider-deepseek-official',
      modelKey: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      capabilities: ['text', 'thinking', 'tool-calling'],
      status: 'active',
    }],
    updatedAt: timestamp,
  }
}

function createSeedRoute(): ModelRoute {
  return {
    id: 'route-default',
    key: 'default',
    name: '平台默认模型路由',
    purpose: 'default',
    providerModelId: 'model-deepseek-v4-pro',
    providerId: 'provider-deepseek-official',
    providerName: 'DeepSeek 官方',
    modelKey: 'deepseek-v4-pro',
    modelName: 'DeepSeek V4 Pro',
    priority: 100,
    enabled: true,
    updatedAt: '2026-08-30T00:00:00.000Z',
  }
}
