import type {
  DataProtectionAdminPort,
  DataProtectionAllowRecord,
  DataProtectionFilter,
  DataProtectionOverview,
  DataProtectionPreview,
  DataProtectionRecord,
  DataProtectionRecordPage,
  DataProtectionTermInput,
  DataProtectionTermRecord,
} from '../../domain/data-protection.ts'
import { deriveTenantKey, inspectMessageForSecrets, maskTexts } from '../../modules/data-protection/data-protection-masking.ts'

/** P0 冒烟的确定性内存数据：不代表 PostgreSQL 或真实网关。 */
const base = {
  runId: null, attemptId: null, providerName: null, model: null, endpoint: null, trustLevel: null, hasImage: false, entry: null, sessionId: null,
  secret: 0, personal: 0, term: 0,
} as const

const RECORDS: DataProtectionRecord[] = [
  { ...base, id: 'smoke-blocked', time: '2026-11-08T06:32:00.000Z', employeeId: 'U1', employeeName: '张三', department: '销售一部', source: 'conversation', action: 'blocked', secret: 1, entry: 'conversation', sessionId: 'session-7c41' },
  { ...base, id: 'smoke-masked', time: '2026-11-08T06:05:00.000Z', employeeId: 'U2', employeeName: '李四', department: '交付中心', source: 'conversation', action: 'masked', personal: 6, term: 2, runId: 'run-9f20', attemptId: 'attempt-9f20', providerName: 'DeepSeek 官方', model: 'deepseek-v4-pro', endpoint: 'chat', trustLevel: 'external' },
  { ...base, id: 'smoke-automation', time: '2026-11-08T03:47:00.000Z', employeeId: 'U3', employeeName: '王五', department: '财务部', source: 'automation', action: 'masked', personal: 12, runId: 'run-81b3', attemptId: 'attempt-81b3', providerName: '阿里云百炼', model: 'qwen3.8-flash', endpoint: 'chat', trustLevel: 'external', hasImage: true },
]

export class SmokeDataProtectionService implements DataProtectionAdminPort {
  private terms: DataProtectionTermRecord[] = [
    { id: 'term-1', value: '星河项目', caseSensitive: false, wholeWord: false, createdAt: '2026-11-06T02:12:00.000Z' },
    { id: 'term-2', value: '华星科技', caseSensitive: false, wholeWord: false, createdAt: '2026-11-06T02:12:00.000Z' },
  ]
  private allow: DataProtectionAllowRecord[] = [{ id: 'allow-1', value: 'service@example.cn', createdAt: '2026-11-07T01:30:00.000Z' }]
  private sequence = 0

  async getOverview(): Promise<DataProtectionOverview> {
    return { externalRequests: 12480, maskedRequests: 1936, blockedMessages: 14, imageRequests: 203, secret: 86, personal: 1342, term: 512 }
  }

  async getRecords(filter: DataProtectionFilter, page: number, pageSize: number): Promise<DataProtectionRecordPage> {
    const items = RECORDS.filter(row =>
      (!filter.category || row[filter.category] > 0)
      && (!filter.action || row.action === filter.action)
      && (!filter.employee || row.employeeName.includes(filter.employee)))
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize }
  }

  async listTerms() { return this.terms }

  async addTerms(terms: DataProtectionTermInput[]) {
    const seen = new Set(this.terms.map(term => term.value))
    const fresh = terms.filter(term => !seen.has(term.value) && Boolean(seen.add(term.value)))
    this.terms = [...fresh.map(term => ({ ...term, id: `term-new-${(this.sequence += 1)}`, createdAt: new Date().toISOString() })), ...this.terms]
    return { added: fresh.length, skipped: terms.length - fresh.length }
  }

  async removeTerm(id: string) {
    const removed = this.terms.some(term => term.id === id)
    this.terms = this.terms.filter(term => term.id !== id)
    return { removed }
  }

  async listAllowlist() { return this.allow }

  async addAllow(value: string) {
    if (this.allow.some(item => item.value === value)) return { added: false }
    this.allow = [{ id: `allow-new-${(this.sequence += 1)}`, value, createdAt: new Date().toISOString() }, ...this.allow]
    return { added: true }
  }

  async removeAllow(id: string) {
    const removed = this.allow.some(item => item.id === id)
    this.allow = this.allow.filter(item => item.id !== id)
    return { removed }
  }

  async preview(text: string): Promise<DataProtectionPreview> {
    const policy = { terms: this.terms, allowlist: this.allow.map(item => item.value) }
    const result = maskTexts([text], { tenantKey: deriveTenantKey(Buffer.alloc(32, 9), 'smoke'), policy })
    return { maskedText: result.texts[0] ?? '', ...result.counts, wouldBlock: inspectMessageForSecrets(text, policy).secretCount > 0 }
  }
}
