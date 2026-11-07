import type { KnowledgeLevel } from './knowledge-access.ts'

/** 员工端“知识库”的读写端口（weknora-knowledge-plan 第 8 节，WK-S2）。P0 冒烟服务提供内存实现。 */
export interface KnowledgeStatusView {
  /** WeKnora 已配置、账号为本地身份且具备查看级别时为 true；为 false 时员工端不显示入口。 */
  enabled: boolean
  level: KnowledgeLevel
}

export interface KnowledgeGrantView {
  id: string
  departmentId: string
  departmentName: string
  includeDescendants: boolean
  grantedVia: 'employee' | 'admin'
}

export interface KnowledgeBaseView {
  id: string
  name: string
  description: string
  ownerDepartmentId: string
  ownerDepartmentName: string
  /** 归属部门是本人直接所属部门且具备文档管理级别。 */
  canManageDocuments: boolean
  /** 归属部门是本人直接所属部门且具备知识库管理级别。 */
  canManageBase: boolean
  documentCount: number
  processingCount: number
  updatedAt: string | null
  grants: KnowledgeGrantView[]
}

export type KnowledgeDocumentStatus = 'parsing' | 'completed' | 'failed'

export interface KnowledgeDocumentView {
  id: string
  title: string
  fileName: string
  fileSize: number | null
  status: KnowledgeDocumentStatus
  errorMessage: string | null
  uploadedBy: string | null
  updatedAt: string | null
}

export interface KnowledgeDepartmentOption {
  id: string
  name: string
  primary: boolean
}

export interface SessionKnowledgeBaseView {
  id: string
  name: string
  /** 已删除或对本人已不可见时为 false，执行时跳过。 */
  available: boolean
}

export interface KnowledgeBaseService {
  status(userId: string): Promise<KnowledgeStatusView>
  listDepartments(userId: string): Promise<KnowledgeDepartmentOption[]>
  list(userId: string, options?: { withStats?: boolean }): Promise<KnowledgeBaseView[]>
  get(userId: string, knowledgeBaseId: string, options?: { withStats?: boolean }): Promise<KnowledgeBaseView>
  create(userId: string, input: { name: string; description?: string; ownerDepartmentId: string; includeDescendants?: boolean }): Promise<KnowledgeBaseView>
  update(userId: string, knowledgeBaseId: string, input: { name?: string; description?: string }): Promise<KnowledgeBaseView>
  remove(userId: string, knowledgeBaseId: string): Promise<void>
  addGrant(userId: string, knowledgeBaseId: string, input: { departmentId: string; includeDescendants?: boolean }): Promise<KnowledgeBaseView>
  revokeGrant(userId: string, knowledgeBaseId: string, grantId: string): Promise<KnowledgeBaseView>
  listDocuments(userId: string, knowledgeBaseId: string, input: { keyword?: string; status?: string; page?: number; pageSize?: number }): Promise<{ items: KnowledgeDocumentView[]; total: number; page: number; pageSize: number }>
  /** read 在权限与文件名校验通过后才调用，读取请求中的文件内容。 */
  uploadDocument(userId: string, knowledgeBaseId: string, input: { fileName: string; mimeType: string; read: () => Promise<Buffer> }): Promise<KnowledgeDocumentView>
  updateDocument(userId: string, knowledgeBaseId: string, documentId: string, input: { title: string }): Promise<void>
  reparseDocument(userId: string, knowledgeBaseId: string, documentId: string): Promise<void>
  deleteDocument(userId: string, knowledgeBaseId: string, documentId: string): Promise<void>
  downloadDocument(userId: string, knowledgeBaseId: string, documentId: string): Promise<{ fileName: string; mimeType: string; bytes: Buffer }>
  previewDocument(userId: string, knowledgeBaseId: string, documentId: string): Promise<{ text: string; truncated: boolean }>
  sessionKnowledgeBases(userId: string, sessionId: string): Promise<SessionKnowledgeBaseView[]>
  setSessionKnowledgeBases(userId: string, sessionId: string, knowledgeBaseIds: string[]): Promise<SessionKnowledgeBaseView[]>
}

/** 单个上传文件的平台上限，与 WeKnora 的 MAX_FILE_SIZE_MB 默认值一致（4.1）。 */
export const maxKnowledgeUploadBytes = 50 * 1024 * 1024
/** 一个会话最多添加的知识库数量。 */
export const maxSessionKnowledgeBases = 20
