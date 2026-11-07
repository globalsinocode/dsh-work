/** 管理端“企业知识库”（weknora-knowledge-plan 第 9 节，WK-S3），与管理端 OpenAPI 的 KnowledgeAdmin* 结构一致。 */
export interface KnowledgeAdminConnection {
  configured: boolean
  baseUrl: string | null
  credentialHint: string | null
  credentialExpiresAt: string | null
  credentialSource: 'admin' | 'deployment' | null
  embeddingModelId: string | null
  enabled: boolean
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastFailureReason: string | null
}

export interface KnowledgeAdminOverview {
  connection: KnowledgeAdminConnection & { credentialReadable: boolean }
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
  documentCount: number | null
  updatedAt: string | null
  embeddingModelId: string | null
  needsRebuild: boolean
}

export interface KnowledgeAdminBaseList {
  items: KnowledgeAdminBase[]
  statsAvailable: boolean
}

export interface KnowledgeAdminDepartment {
  id: string
  label: string
  root: boolean
}

export interface KnowledgeConnectionInput {
  baseUrl: string
  apiKey?: string
  credentialExpiresAt?: string | null
  embeddingModelId?: string | null
  enabled: boolean
}
