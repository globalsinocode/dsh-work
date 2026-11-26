/** 管理端“企业知识库”（功能规则第 11 节，WK-S3），与管理端 OpenAPI 的 KnowledgeAdmin* 结构一致。 */
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
  /** 最近一次检索的重排序结果（WeKnora meta.rerank.outcome，功能规则第 11 节）与时间。 */
  lastRerankOutcome: string | null
  lastRerankAt: string | null
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
  /** 嵌入模型与当前配置不同；仍按原模型检索，原模型从 WeKnora 删除后才失效（功能规则第 11 节）。 */
  needsRebuild: boolean
  /** unavailable：原连接已更换，不参与检索、员工端不显示，可恢复（功能规则第 11 节）。 */
  status: 'active' | 'unavailable'
  /** WeKnora 中为该知识库配置了摘要模型（功能规则第 11 节）；WeKnora 不可用时为 null。 */
  summaryModelConfigured: boolean | null
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
