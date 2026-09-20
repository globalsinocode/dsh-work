import type { ModelGovernanceRepository } from './model-governance-repository.ts'
import type {
  CreateModelRouteInput,
  CreateProviderInput,
  CreateProviderModelInput,
  ProviderStatus,
  UpsertCredentialReferenceInput,
} from './model-types.ts'

const keyPattern = /^[a-z][a-z0-9-]{2,47}$/

export class ModelGovernanceService {
  private readonly repository: ModelGovernanceRepository
  private readonly tenantId: string

  constructor(repository: ModelGovernanceRepository, tenantId = 'tenant-dsh-work') {
    this.repository = repository
    this.tenantId = tenantId
  }

  listProviders() {
    return this.repository.listProviders(this.tenantId)
  }

  createProvider(input: CreateProviderInput) {
    assertActor(input.actor)
    assertKey(input.key, 'Provider')
    if (input.name.trim().length < 2) throw new Error('Provider 名称至少需要 2 个字符')
    if (!input.providerType.trim()) throw new Error('Provider 类型不能为空')
    assertHttpUrl(input.baseUrl)
    return this.repository.createProvider(this.tenantId, {
      ...input,
      key: input.key.trim(),
      name: input.name.trim(),
      providerType: input.providerType.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/$/, ''),
    })
  }

  setProviderStatus(input: { providerId: string; status: ProviderStatus; actor: string }) {
    assertActor(input.actor)
    if (!['active', 'disabled'].includes(input.status)) throw new Error('Provider 状态无效')
    return this.repository.setProviderStatus(this.tenantId, input.providerId, input.status, input.actor)
  }

  createProviderModel(input: CreateProviderModelInput) {
    assertActor(input.actor)
    assertKey(input.modelKey, '模型')
    if (input.displayName.trim().length < 2) throw new Error('模型名称至少需要 2 个字符')
    return this.repository.createProviderModel(this.tenantId, {
      ...input,
      modelKey: input.modelKey.trim(),
      displayName: input.displayName.trim(),
    })
  }

  upsertCredentialReference(input: UpsertCredentialReferenceInput) {
    assertActor(input.actor)
    if (!['dsh-managed', 'keychain', 'secret-manager'].includes(input.backend)) throw new Error('密钥后端无效')
    if (!input.externalRef.trim()) throw new Error('密钥引用不能为空')
    if (!['configured', 'missing', 'revoked'].includes(input.status)) throw new Error('凭据状态无效')
    return this.repository.upsertCredentialReference(this.tenantId, {
      ...input,
      externalRef: input.externalRef.trim(),
    })
  }

  listRoutes() {
    return this.repository.listRoutes(this.tenantId)
  }

  createRoute(input: CreateModelRouteInput) {
    assertActor(input.actor)
    assertKey(input.key, '模型路由')
    if (input.name.trim().length < 2) throw new Error('模型路由名称至少需要 2 个字符')
    if (!['default', 'chat', 'analysis', 'fallback'].includes(input.purpose)) throw new Error('模型路由用途无效')
    if (!Number.isInteger(input.priority) || input.priority < 0) throw new Error('路由优先级必须是非负整数')
    return this.repository.createRoute(this.tenantId, { ...input, key: input.key.trim(), name: input.name.trim() })
  }

  async resolveRoute(routeKey?: string, requirements: readonly string[] = []) {
    const route = await this.repository.resolveRoute(this.tenantId, routeKey)
    const missing = requirements.filter(requirement => !route.modelCapabilities.includes(requirement))
    if (missing.length) throw new ModelCapabilityMismatchError(missing)
    return route
  }
}

export class ModelCapabilityMismatchError extends Error {
  readonly status = 422
  readonly code = 'MODEL_CAPABILITY_MISMATCH'
  constructor(requirements: readonly string[]) {
    super(`默认模型路由未声明 Agent 所需能力：${requirements.join('、')}`)
  }
}

function assertActor(actor: string) {
  if (!actor.trim()) throw new Error('操作人不能为空')
}

function assertKey(key: string, objectName: string) {
  if (!keyPattern.test(key.trim())) {
    throw new Error(`${objectName} 标识必须以小写字母开头，只能包含小写字母、数字和连字符，长度为 3～48 位`)
  }
}

function assertHttpUrl(value: string) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error()
  } catch {
    throw new Error('Provider 地址必须是有效的 http:// 或 https:// URL')
  }
}
