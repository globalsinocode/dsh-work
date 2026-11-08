import { randomUUID } from 'node:crypto'

import type { ModelGovernanceRepository } from './model-governance-repository.ts'
import type {
  CreateModelRouteInput,
  CreateProviderInput,
  CreateProviderModelInput,
  ModelProvider,
  ModelRoute,
  ModelRouteSnapshot,
  ProviderStatus,
  SetProviderApiKeyInput,
  SetProviderModelStatusInput,
  UpdateModelRouteInput,
  UpdateProviderInput,
} from './model-types.ts'
import { invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'
import { noEnabledRoute, routeCredentialMissing, routeTargetDisabled } from './model-route-errors.ts'

const clone = <T>(value: T): T => structuredClone(value)

export class MemoryModelGovernanceRepository implements ModelGovernanceRepository {
  private readonly providers: ModelProvider[] = [createSeedProvider()]
  private readonly routes: ModelRoute[] = [createSeedRoute()]

  async listProviders() {
    return clone(this.providers)
  }

  async createProvider(_tenantId: string, input: CreateProviderInput) {
    if (this.providers.some((provider) => provider.key === input.key)) {
      throw stateConflict(`Provider 标识已存在：${input.key}`)
    }
    const timestamp = new Date().toISOString()
    const provider: ModelProvider = {
      id: `provider-${randomUUID()}`,
      key: input.key,
      name: input.name,
      providerType: input.providerType,
      trustLevel: input.trustLevel,
      baseUrl: input.baseUrl,
      status: 'active',
      credential: null,
      models: [],
      updatedAt: timestamp,
    }
    this.providers.push(provider)
    if (input.apiKey) this.storeApiKey(provider, input.apiKey)
    return clone(provider)
  }

  /** 测试替身只记录已配置状态与后 4 位，不保存密钥本身。 */
  async setProviderApiKey(_tenantId: string, input: SetProviderApiKeyInput) {
    const provider = this.requireProvider(input.providerId)
    this.storeApiKey(provider, input.apiKey)
    return clone(provider)
  }

  async updateProvider(_tenantId: string, input: UpdateProviderInput) {
    const provider = this.requireProvider(input.providerId)
    provider.name = input.name
    provider.baseUrl = input.baseUrl
    provider.trustLevel = input.trustLevel
    provider.updatedAt = new Date().toISOString()
    for (const route of this.routes) {
      if (route.providerId === provider.id) route.providerName = provider.name
    }
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
      throw stateConflict(`模型标识已存在：${input.modelKey}`)
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

  async setProviderModelStatus(_tenantId: string, input: SetProviderModelStatusInput) {
    const { provider, model } = this.requireModel(input.modelId)
    model.status = input.status
    provider.updatedAt = new Date().toISOString()
    return clone(provider)
  }

  async listRoutes() {
    return clone(this.routes)
  }

  async createRoute(_tenantId: string, input: CreateModelRouteInput) {
    if (this.routes.some((route) => route.key === input.key)) {
      throw stateConflict(`模型路由标识已存在：${input.key}`)
    }
    const { provider, model } = this.requireRouteTarget(input.providerModelId, input.enabled)
    if (input.enabled) this.disableDefaultRoutes()
    const route: ModelRoute = {
      id: `route-${randomUUID()}`,
      key: input.key,
      name: input.name,
      purpose: 'default',
      providerModelId: model.id,
      providerId: provider.id,
      providerName: provider.name,
      modelKey: model.modelKey,
      modelName: model.displayName,
      priority: 100,
      enabled: input.enabled,
      updatedAt: new Date().toISOString(),
    }
    this.routes.push(route)
    return clone(route)
  }

  async updateRoute(_tenantId: string, input: UpdateModelRouteInput) {
    const route = this.routes.find((item) => item.id === input.routeId)
    if (!route) throw notFound(`模型路由不存在：${input.routeId}`)
    const { provider, model } = this.requireRouteTarget(input.providerModelId, input.enabled)
    if (input.enabled) this.disableDefaultRoutes(route.id)
    Object.assign(route, {
      name: input.name,
      providerModelId: model.id,
      providerId: provider.id,
      providerName: provider.name,
      modelKey: model.modelKey,
      modelName: model.displayName,
      enabled: input.enabled,
      updatedAt: new Date().toISOString(),
    })
    return clone(route)
  }

  async resolveDefaultRoute(): Promise<ModelRouteSnapshot> {
    const route = this.routes.find((item) => item.purpose === 'default' && item.enabled)
    if (!route) throw noEnabledRoute()
    const { provider, model } = this.requireModel(route.providerModelId)
    if (provider.status !== 'active' || model.status !== 'active') {
      throw routeTargetDisabled({ routeName: route.name, providerName: provider.name, providerActive: provider.status === 'active', modelName: model.displayName, modelKey: model.modelKey })
    }
    if (!provider.credential || provider.credential.status !== 'configured') throw routeCredentialMissing(provider.name)
    return {
      routeId: route.id,
      routeKey: route.key,
      providerId: provider.id,
      providerKey: provider.key,
      providerType: provider.providerType,
      trustLevel: provider.trustLevel,
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

  private disableDefaultRoutes(exceptRouteId?: string) {
    for (const route of this.routes) {
      if (route.purpose === 'default' && route.id !== exceptRouteId) route.enabled = false
    }
  }

  private requireRouteTarget(modelId: string, enabling: boolean) {
    let target: { provider: ModelProvider; model: ModelProvider['models'][number] }
    try {
      target = this.requireModel(modelId)
    } catch {
      throw invalidRequest(`目标模型不存在：${modelId}`)
    }
    if (enabling && (target.model.status !== 'active' || target.provider.status !== 'active')) {
      throw stateConflict('目标模型或其 Provider 已停用，不能设为默认路由')
    }
    return target
  }

  private storeApiKey(provider: ModelProvider, apiKey: string) {
    const timestamp = new Date().toISOString()
    provider.credential = {
      id: provider.credential?.id ?? `credential-${randomUUID()}`,
      backend: 'postgres-encrypted',
      externalRef: `model-provider:${provider.key}:api-key`,
      status: 'configured',
      hint: apiKey.length > 8 ? apiKey.slice(-4) : null,
      lastVerifiedAt: timestamp,
      updatedAt: timestamp,
    }
    provider.updatedAt = timestamp
  }

  private requireProvider(providerId: string) {
    const provider = this.providers.find((item) => item.id === providerId)
    if (!provider) throw notFound(`Provider 不存在：${providerId}`)
    return provider
  }

  private requireModel(modelId: string) {
    for (const provider of this.providers) {
      const model = provider.models.find((item) => item.id === modelId)
      if (model) return { provider, model }
    }
    throw notFound(`Provider 模型不存在：${modelId}`)
  }
}

function createSeedProvider(): ModelProvider {
  const timestamp = '2026-08-30T00:00:00.000Z'
  return {
    id: 'provider-deepseek-official',
    key: 'deepseek-official',
    name: 'DeepSeek 官方',
    providerType: 'openai-completions',
    trustLevel: 'external',
    baseUrl: 'https://api.deepseek.com',
    status: 'active',
    credential: {
      id: 'credential-deepseek-default',
      backend: 'dsh-managed',
      externalRef: 'DEEPSEEK_API_KEY',
      status: 'configured',
      hint: null,
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
