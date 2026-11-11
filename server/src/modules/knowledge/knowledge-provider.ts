import type { RuntimeKnowledgeDocument, RuntimeKnowledgeStatus } from '../runtime/runtime-types.ts'

/** One injected chunk, kept as a snapshot so footers and source panels survive document deletion. */
export interface KnowledgeCitation {
  ordinal: number
  externalDocumentId: string
  knowledgeBaseId: string
  knowledgeBaseName: string
  title: string
  fileName: string
  documentUpdatedAt: string
  contentChecksum: string
  excerpt: string
  relevanceScore: number
}

export interface KnowledgeResolution {
  /** not_applicable：员工或 Agent 不具备查看级别（5.1），不进入 Manifest。 */
  status: RuntimeKnowledgeStatus
  documents: RuntimeKnowledgeDocument[]
  citations: KnowledgeCitation[]
  /** Names of selected knowledge bases skipped because they were deleted or are no longer visible. */
  skippedBases: string[]
  /** 所选但因更换连接地址标为“原连接已更换”而跳过的知识库名称（优化方案 O9）。 */
  movedBases?: string[]
  /** 优化方案 O2：会话添加了知识库，但当前 Agent 不具备查看级别。 */
  skippedReason?: 'agent_not_permitted'
  /** 不可用原因分类（第 7 节），只在 unavailable 时出现；不含 API Key 与请求正文。 */
  failureReason?: string
}

/**
 * 企业知识端口（weknora-knowledge-plan 第 6 节）：执行前按会话所选、员工可见的知识库检索，
 * 回答完成后按引用快照追加页脚。只在个人空间的员工对话中调用（一期，2.1）。
 */
export interface KnowledgeProvider {
  resolveContext(input: {
    sessionId: string
    userId: string
    agentVersionId: string
    /** 本次提问（优化方案 O3：先只用它检索）。 */
    query: string
    /** 本次提问没有结果时再试一次的查询词：同一会话上一条提问加本次提问；与 query 相同或缺省时不重试。 */
    fallbackQuery?: string
  }): Promise<KnowledgeResolution>
  addCitationFooter(attemptId: string, answer: string): Promise<string>
}
