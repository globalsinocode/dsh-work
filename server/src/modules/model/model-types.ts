export type ProviderStatus = 'active' | 'disabled'
export type CredentialStatus = 'configured' | 'missing' | 'revoked'
export type CredentialBackend = 'dsh-managed' | 'keychain' | 'secret-manager'
export type ModelStatus = 'active' | 'disabled'
export type ModelRoutePurpose = 'default' | 'chat' | 'analysis' | 'fallback'

export interface CredentialReference {
  id: string
  backend: CredentialBackend
  externalRef: string
  status: CredentialStatus
  lastVerifiedAt: string | null
  updatedAt: string
}

export interface ProviderModel {
  id: string
  providerId: string
  modelKey: string
  displayName: string
  capabilities: string[]
  status: ModelStatus
}

export interface ModelProvider {
  id: string
  key: string
  name: string
  providerType: string
  baseUrl: string
  status: ProviderStatus
  credential: CredentialReference | null
  models: ProviderModel[]
  updatedAt: string
}

export interface ModelRoute {
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
  updatedAt: string
}

export interface ModelRouteSnapshot {
  routeId: string
  routeKey: string
  providerId: string
  providerKey: string
  providerType: string
  baseUrl: string
  modelId: string
  modelKey: string
  credentialRefId: string
  modelCapabilities: string[]
  credentialBackend: CredentialBackend
  credentialExternalRef: string
  resolvedAt: string
}

export interface CreateProviderInput {
  key: string
  name: string
  providerType: string
  baseUrl: string
  actor: string
}

export interface CreateProviderModelInput {
  providerId: string
  modelKey: string
  displayName: string
  capabilities: string[]
  actor: string
}

export interface UpsertCredentialReferenceInput {
  providerId: string
  backend: CredentialBackend
  externalRef: string
  status: CredentialStatus
  actor: string
}

export interface CreateModelRouteInput {
  key: string
  name: string
  purpose: ModelRoutePurpose
  providerModelId: string
  priority: number
  enabled: boolean
  actor: string
}
