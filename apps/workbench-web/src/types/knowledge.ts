/** 员工端“知识库”（weknora-knowledge-plan 第 8 节，WK-S2），与工作台 OpenAPI 的 Knowledge* 结构一致。 */
export type KnowledgeLevel = 'none' | 'view' | 'docs' | 'bases'

export interface KnowledgeStatus {
  enabled: boolean
  level: KnowledgeLevel
}

export interface KnowledgeDepartmentOption {
  id: string
  name: string
  primary: boolean
}

export interface KnowledgeGrant {
  id: string
  departmentId: string
  departmentName: string
  includeDescendants: boolean
  grantedVia: 'employee' | 'admin'
}

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  ownerDepartmentId: string
  ownerDepartmentName: string
  canManageDocuments: boolean
  canManageBase: boolean
  documentCount: number
  processingCount: number
  updatedAt: string | null
  grants: KnowledgeGrant[]
}

export type KnowledgeDocumentStatus = 'parsing' | 'completed' | 'failed'

export interface KnowledgeDocument {
  id: string
  title: string
  fileName: string
  fileSize: number | null
  status: KnowledgeDocumentStatus
  errorMessage: string | null
  uploadedBy: string | null
  updatedAt: string | null
}

export interface KnowledgeDocumentPage {
  items: KnowledgeDocument[]
  total: number
  page: number
  pageSize: number
}

export interface SessionKnowledgeBase {
  id: string
  name: string
  available: boolean
}
