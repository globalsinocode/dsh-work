import type { ModelGovernanceRepository } from './model-governance-repository.ts'
import {
  creatableProviderTypes,
  providerTrustLevels,
  type CreateModelRouteInput,
  type CreateProviderInput,
  type CreateProviderModelInput,
  type ProviderStatus,
  type SetProviderApiKeyInput,
  type SetProviderModelStatusInput,
  type UpdateModelRouteInput,
  type UpdateProviderInput,
  type UpsertCredentialReferenceInput,
} from './model-types.ts'
import { invalidRequest, stateConflict } from '../../domain/request-errors.ts'

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
    assertProviderName(input.name)
    if (!creatableProviderTypes.includes(input.providerType)) {
      throw invalidRequest('Provider 协议类型无效：首批只开放 OpenAI Chat Completions 兼容协议（openai-completions）')
    }
    assertTrustLevel(input.trustLevel)
    assertHttpUrl(input.baseUrl)
    const apiKey = input.apiKey === undefined || input.apiKey === '' ? undefined : normalizeApiKey(input.apiKey)
    return this.repository.createProvider(this.tenantId, {
      ...input,
      key: input.key.trim(),
      name: input.name.trim(),
      baseUrl: normalizeUrl(input.baseUrl),
      apiKey,
    })
  }

  setProviderApiKey(input: SetProviderApiKeyInput) {
    assertActor(input.actor)
    return this.repository.setProviderApiKey(this.tenantId, { ...input, apiKey: normalizeApiKey(input.apiKey) })
  }

  updateProvider(input: UpdateProviderInput) {
    assertActor(input.actor)
    assertProviderName(input.name)
    assertTrustLevel(input.trustLevel)
    assertHttpUrl(input.baseUrl)
    return this.repository.updateProvider(this.tenantId, {
      ...input,
      name: input.name.trim(),
      baseUrl: normalizeUrl(input.baseUrl),
    })
  }

  setProviderStatus(input: { providerId: string; status: ProviderStatus; actor: string }) {
    assertActor(input.actor)
    if (!['active', 'disabled'].includes(input.status)) throw invalidRequest('Provider 状态无效')
    return this.repository.setProviderStatus(this.tenantId, input.providerId, input.status, input.actor)
  }

  createProviderModel(input: CreateProviderModelInput) {
    assertActor(input.actor)
    assertKey(input.modelKey, '模型')
    if (input.displayName.trim().length < 2) throw invalidRequest('模型名称至少需要 2 个字符')
    return this.repository.createProviderModel(this.tenantId, {
      ...input,
      modelKey: input.modelKey.trim(),
      displayName: input.displayName.trim(),
    })
  }

  setProviderModelStatus(input: SetProviderModelStatusInput) {
    assertActor(input.actor)
    if (!['active', 'disabled'].includes(input.status)) throw invalidRequest('模型状态无效')
    return this.repository.setProviderModelStatus(this.tenantId, input)
  }

  upsertCredentialReference(input: UpsertCredentialReferenceInput) {
    assertActor(input.actor)
    if (!['dsh-managed', 'keychain', 'secret-manager'].includes(input.backend)) {
      throw invalidRequest('密钥后端无效；平台加密保存的密钥请直接录入密钥')
    }
    if (!input.externalRef.trim()) throw stateConflict('密钥引用不能为空')
    if (!['configured', 'missing', 'revoked'].includes(input.status)) throw invalidRequest('凭据状态无效')
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
    assertRouteName(input.name)
    assertEnabledFlag(input.enabled)
    assertId(input.providerModelId, '目标模型')
    return this.repository.createRoute(this.tenantId, { ...input, key: input.key.trim(), name: input.name.trim() })
  }

  updateRoute(input: UpdateModelRouteInput) {
    assertActor(input.actor)
    assertRouteName(input.name)
    assertEnabledFlag(input.enabled)
    assertId(input.routeId, '模型路由')
    assertId(input.providerModelId, '目标模型')
    return this.repository.updateRoute(this.tenantId, { ...input, name: input.name.trim() })
  }

  async resolveDefaultRoute(requirements: readonly string[] = []) {
    const route = await this.repository.resolveDefaultRoute(this.tenantId)
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
  if (!actor.trim()) throw stateConflict('操作人不能为空')
}

function assertKey(key: string, objectName: string) {
  if (!keyPattern.test(key.trim())) {
    throw invalidRequest(`${objectName} 标识必须以小写字母开头，只能包含小写字母、数字和连字符，长度为 3～48 位`)
  }
}

function assertProviderName(name: string) {
  if (name.trim().length < 2) throw invalidRequest('Provider 名称至少需要 2 个字符')
}

function assertRouteName(name: string) {
  if (name.trim().length < 2) throw invalidRequest('模型路由名称至少需要 2 个字符')
}

function assertTrustLevel(value: string) {
  if (!providerTrustLevels.includes(value as never)) {
    throw invalidRequest('请选择 Provider 信任级别：内部部署（internal）或外部厂商（external）')
  }
}

function assertId(value: unknown, objectName: string) {
  if (typeof value !== 'string' || !value.trim()) throw invalidRequest(`请指定${objectName}`)
}

function assertEnabledFlag(value: unknown) {
  if (typeof value !== 'boolean') throw invalidRequest('请指定路由是否启用（enabled 必须是布尔值）')
}

/** 厂商密钥：1–8192 字节、不含空白字符；只校验格式，不记录、不回显。 */
function normalizeApiKey(value: unknown) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 8192 || /\s/.test(value)) {
    throw invalidRequest('密钥必须为 1～8192 字节且不能包含空白字符')
  }
  return value
}

function normalizeUrl(value: string) {
  return value.trim().replace(/\/$/, '')
}

function assertHttpUrl(value: string) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error()
  } catch {
    throw invalidRequest('Provider 地址必须是有效的 http:// 或 https:// URL')
  }
}
