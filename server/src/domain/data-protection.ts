import { invalidRequest } from './request-errors.ts'
import { modelUsageRanges, type ModelUsageRange, type RunSource } from './model-usage.ts'

/** 管理端数据防护页（DLP-S3）。只有类别与次数，任何接口都不返回命中的原值（D8）。 */
export const DATA_PROTECTION_TERMS_PERMISSION = 'data-protection:terms'
export const DATA_PROTECTION_MAX_TERMS = 5000
export const DATA_PROTECTION_MAX_TERM_LENGTH = 200
export const DATA_PROTECTION_MAX_ALLOW_LENGTH = 500
export const DATA_PROTECTION_MAX_PREVIEW_LENGTH = 20_000
/** 5000 条 × 200 字（UTF-8 每字 3 字节）加 JSON 外壳，一次导入放得下。 */
export const DATA_PROTECTION_TERMS_BODY_BYTES = 4 * 1024 * 1024

export type DataProtectionHitCategory = 'secret' | 'personal' | 'term'
export type DataProtectionAction = 'masked' | 'blocked'

export interface DataProtectionFilter {
  range: ModelUsageRange
  category?: DataProtectionHitCategory
  action?: DataProtectionAction
  employee?: string
}

export interface DataProtectionOverview {
  externalRequests: number
  maskedRequests: number
  blockedMessages: number
  imageRequests: number
  secret: number
  personal: number
  term: number
}

export interface DataProtectionRecord {
  id: string
  time: string
  employeeId: string | null
  employeeName: string
  department: string
  source: RunSource
  action: DataProtectionAction
  secret: number
  personal: number
  term: number
  /** 被拦截的消息没有运行，以下字段为 null。 */
  runId: string | null
  attemptId: string | null
  providerName: string | null
  model: string | null
  endpoint: 'chat' | 'search' | null
  trustLevel: 'internal' | 'external' | null
  hasImage: boolean
  /** 被拦截的消息的入口与会话。 */
  entry: string | null
  sessionId: string | null
}

export interface DataProtectionRecordPage {
  items: DataProtectionRecord[]
  total: number
  page: number
  pageSize: number
}

export interface DataProtectionTermInput {
  value: string
  caseSensitive: boolean
  wholeWord: boolean
}

export interface DataProtectionTermRecord extends DataProtectionTermInput {
  id: string
  createdAt: string
}

export interface DataProtectionAllowRecord {
  id: string
  value: string
  createdAt: string
}

export interface DataProtectionPreview {
  maskedText: string
  secret: number
  personal: number
  term: number
  /** 员工作为消息发送时是否会被拦截。 */
  wouldBlock: boolean
}

export interface DataProtectionAdminPort {
  getOverview(filter: DataProtectionFilter): Promise<DataProtectionOverview>
  getRecords(filter: DataProtectionFilter, page: number, pageSize: number): Promise<DataProtectionRecordPage>
  listTerms(): Promise<DataProtectionTermRecord[]>
  /** 词表变更与审计在同一事务内；审计只记条数，不记词条内容。 */
  addTerms(terms: DataProtectionTermInput[], actorId: string): Promise<{ added: number; skipped: number }>
  removeTerm(id: string, actorId: string): Promise<{ removed: boolean }>
  listAllowlist(): Promise<DataProtectionAllowRecord[]>
  addAllow(value: string, actorId: string): Promise<{ added: boolean }>
  removeAllow(id: string, actorId: string): Promise<{ removed: boolean }>
  preview(text: string): Promise<DataProtectionPreview>
}

export function parseDataProtectionFilter(params: URLSearchParams): DataProtectionFilter {
  const range = params.get('range') ?? '7d'
  if (!modelUsageRanges.includes(range as ModelUsageRange)) throw invalidRequest('时间范围只支持今天、近 7 天和近 30 天')
  const category = params.get('category')?.trim() || undefined
  if (category && !['secret', 'personal', 'term'].includes(category)) throw invalidRequest('类别无效')
  const action = params.get('action')?.trim() || undefined
  if (action && !['masked', 'blocked'].includes(action)) throw invalidRequest('处理方式无效')
  const employee = params.get('employee')?.trim().slice(0, 100) || undefined
  return {
    range: range as ModelUsageRange,
    ...(category ? { category: category as DataProtectionHitCategory } : {}),
    ...(action ? { action: action as DataProtectionAction } : {}),
    ...(employee ? { employee } : {}),
  }
}

/** 校验并规范一批词条。重复项保留，由写入时跳过，“跳过”的数字才包含同一批内的重复。 */
export function normalizeTermInputs(input: unknown): DataProtectionTermInput[] {
  if (!Array.isArray(input) || input.length === 0) throw invalidRequest('词条不能为空')
  if (input.length > DATA_PROTECTION_MAX_TERMS) throw invalidRequest(`一次最多导入 ${DATA_PROTECTION_MAX_TERMS} 条`)
  const terms: DataProtectionTermInput[] = []
  for (const item of input) {
    const record = (item ?? {}) as Record<string, unknown>
    const value = typeof record['value'] === 'string' ? record['value'].trim() : ''
    if (!value) throw invalidRequest('词条不能为空')
    if (value.length > DATA_PROTECTION_MAX_TERM_LENGTH) throw invalidRequest(`单个词条不能超过 ${DATA_PROTECTION_MAX_TERM_LENGTH} 字`)
    terms.push({ value, caseSensitive: record['caseSensitive'] === true, wholeWord: record['wholeWord'] === true })
  }
  return terms
}

export function normalizeAllowValue(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!value) throw invalidRequest('放行的值不能为空')
  if (value.length > DATA_PROTECTION_MAX_ALLOW_LENGTH) throw invalidRequest(`放行的值不能超过 ${DATA_PROTECTION_MAX_ALLOW_LENGTH} 字`)
  return value
}

export function normalizePreviewText(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw invalidRequest('请输入要检测的文本')
  if (input.length > DATA_PROTECTION_MAX_PREVIEW_LENGTH) throw invalidRequest(`检测文本不能超过 ${DATA_PROTECTION_MAX_PREVIEW_LENGTH} 字`)
  return input
}
