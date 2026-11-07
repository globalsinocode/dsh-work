import { accessDenied, invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'
import type { KnowledgeLevel } from '../../modules/knowledge/knowledge-access.ts'
import type {
  KnowledgeBaseService,
  KnowledgeBaseView,
  KnowledgeDocumentStatus,
  KnowledgeDocumentView,
  KnowledgeGrantView,
  SessionKnowledgeBaseView,
} from '../../modules/knowledge/knowledge-base-service.ts'
import { mockTasks } from './data.ts'

interface MemoryBase {
  id: string
  name: string
  description: string
  ownerDepartmentId: string
  updatedAt: string
  deleted: boolean
  grants: KnowledgeGrantView[]
  documents: KnowledgeDocumentView[]
}

const departments = {
  plan: { id: 'dept-plan', name: '计划组' },
  procurement: { id: 'dept-procurement', name: '采购组' },
  supply: { id: 'dept-supply', name: '供应链部' },
  general: { id: 'dept-general', name: '综合管理部' },
  finance: { id: 'dept-finance', name: '财务部' },
}
/** 测试身份直接所属的部门：计划组（主）与采购组。 */
const myDepartments = [departments.plan, departments.procurement]
const levelRank: Record<KnowledgeLevel, number> = { none: 0, view: 1, docs: 2, bases: 3 }

/**
 * P0 冒烟用的企业知识库（验收目录 KB-P0-01、KB-P0-02）：测试身份可见的一组确定性知识库与文档，
 * 只用于页面冒烟，随 `/api/testing/p0/reset` 重建。按部门的可见范围、WeKnora 转发与审计由
 * PostgreSQL 实现与 KB-01～KB-06 集成测试保证；这里的权限级别可由测试专用端点切换。
 */
export class MemoryKnowledgeBaseStore implements KnowledgeBaseService {
  level: KnowledgeLevel = 'bases'
  private readonly bases: MemoryBase[]
  private readonly sessions = new Map<string, string[]>()
  private sequence = 1

  constructor() {
    const doc = (id: string, title: string, fileName: string, uploadedBy: string, updatedAt: string, status: KnowledgeDocumentStatus): KnowledgeDocumentView => ({
      id, title, fileName, fileSize: 120_000, status, errorMessage: status === 'failed' ? '未能识别文字内容' : null, uploadedBy, updatedAt,
    })
    this.bases = [
      {
        id: 'kb-plan', name: '计划组工作手册', description: '计划组的排产、补货与例会规范', ownerDepartmentId: departments.plan.id,
        updatedAt: '2026-10-28T09:30:00Z', deleted: false,
        grants: [
          { id: 'grant-plan', departmentId: departments.plan.id, departmentName: departments.plan.name, includeDescendants: true, grantedVia: 'employee' },
          { id: 'grant-plan-finance', departmentId: departments.finance.id, departmentName: departments.finance.name, includeDescendants: false, grantedVia: 'admin' },
        ],
        documents: [
          doc('doc-replenish', '补货会议规则', '补货会议规则.docx', '林岚', '2026-10-28T09:30:00Z', 'completed'),
          doc('doc-forecast', '需求预测评审流程', '需求预测评审流程.pdf', '周衡', '2026-10-12T16:05:00Z', 'completed'),
          doc('doc-template', '排产计划模板说明', '排产计划模板说明.xlsx', '林岚', '2026-10-30T11:20:00Z', 'parsing'),
          doc('doc-legacy', '旧版补货口径（扫描件）', '补货口径-2024.pdf', '周衡', '2026-09-02T14:12:00Z', 'failed'),
        ],
      },
      {
        id: 'kb-supply', name: '供应链制度库', description: '供应链部发布的制度与流程', ownerDepartmentId: departments.supply.id,
        updatedAt: '2026-10-20T10:00:00Z', deleted: false,
        grants: [{ id: 'grant-supply', departmentId: departments.supply.id, departmentName: departments.supply.name, includeDescendants: true, grantedVia: 'employee' }],
        documents: [
          doc('doc-outsourcing', '委外加工业务管理办法', '委外加工业务管理办法.pdf', '许宁', '2026-10-20T10:00:00Z', 'completed'),
          doc('doc-warehouse', '仓储出入库操作规范', '仓储出入库操作规范.docx', '许宁', '2026-09-18T15:40:00Z', 'completed'),
        ],
      },
      {
        id: 'kb-all', name: '全员制度汇编', description: '人事、行政、财务通用制度', ownerDepartmentId: departments.general.id,
        updatedAt: '2026-09-30T09:00:00Z', deleted: false,
        grants: [{ id: 'grant-all', departmentId: 'dept-root', departmentName: '全公司', includeDescendants: true, grantedVia: 'admin' }],
        documents: [doc('doc-travel', '差旅报销管理办法', '差旅报销管理办法.pdf', '陈默', '2026-09-30T09:00:00Z', 'completed')],
      },
    ]
  }

  async status() {
    return { enabled: this.level !== 'none', level: this.level }
  }

  async listDepartments() {
    return myDepartments.map((department, index) => ({ ...department, primary: index === 0 }))
  }

  async list() {
    this.requireLevel('view')
    return this.active().map(base => this.view(base))
  }

  async get(_userId: string, knowledgeBaseId: string) {
    this.requireLevel('view')
    return this.view(this.find(knowledgeBaseId))
  }

  async create(_userId: string, input: { name: string; description?: string; ownerDepartmentId: string; includeDescendants?: boolean }) {
    this.requireLevel('bases')
    const name = input.name.trim()
    if (!name || name.length > 60) throw invalidRequest('名称长度为 1～60 个字')
    const department = myDepartments.find(item => item.id === input.ownerDepartmentId)
    if (!department) throw invalidRequest('归属部门必须是你所属的部门（不能是根部门）')
    const id = `kb-new-${this.sequence++}`
    this.bases.push({
      id, name, description: (input.description ?? '').trim(), ownerDepartmentId: department.id, updatedAt: new Date().toISOString(), deleted: false,
      grants: [{ id: `grant-${id}`, departmentId: department.id, departmentName: department.name, includeDescendants: input.includeDescendants ?? true, grantedVia: 'employee' }],
      documents: [],
    })
    return this.view(this.find(id))
  }

  async update(_userId: string, knowledgeBaseId: string, input: { name?: string; description?: string }) {
    const base = this.manage(knowledgeBaseId, 'bases')
    if (input.name !== undefined) {
      if (!input.name.trim() || input.name.trim().length > 60) throw invalidRequest('名称长度为 1～60 个字')
      base.name = input.name.trim()
    }
    if (input.description !== undefined) base.description = input.description.trim()
    return this.view(base)
  }

  async remove(_userId: string, knowledgeBaseId: string) {
    this.manage(knowledgeBaseId, 'bases').deleted = true
  }

  async addGrant(_userId: string, knowledgeBaseId: string, input: { departmentId: string; includeDescendants?: boolean }) {
    const base = this.manage(knowledgeBaseId, 'bases')
    const department = myDepartments.find(item => item.id === input.departmentId)
    if (!department) throw accessDenied('只能授给你所属的部门；授给其他部门或全公司请联系平台管理员')
    if (!base.grants.some(grant => grant.departmentId === department.id)) {
      base.grants.push({ id: `grant-${this.sequence++}`, departmentId: department.id, departmentName: department.name, includeDescendants: input.includeDescendants ?? true, grantedVia: 'employee' })
    }
    return this.view(base)
  }

  async revokeGrant(_userId: string, knowledgeBaseId: string, grantId: string) {
    const base = this.manage(knowledgeBaseId, 'bases')
    const grant = base.grants.find(item => item.id === grantId)
    if (!grant) throw notFound('授权不存在')
    if (grant.grantedVia === 'admin') throw accessDenied('平台管理员授予的可见范围只能由平台管理员撤销')
    if (base.grants.length <= 1) throw stateConflict('至少保留一个可见部门')
    base.grants = base.grants.filter(item => item.id !== grantId)
    return this.view(base)
  }

  async listDocuments(_userId: string, knowledgeBaseId: string, input: { keyword?: string; status?: string; page?: number; pageSize?: number }) {
    this.requireLevel('view')
    const keyword = input.keyword?.trim()
    const items = this.find(knowledgeBaseId).documents
      .filter(item => !input.status || input.status === 'all' || item.status === input.status)
      .filter(item => !keyword || item.title.includes(keyword) || item.fileName.includes(keyword))
    return { items: items.map(item => ({ ...item })), total: items.length, page: input.page ?? 1, pageSize: input.pageSize ?? 20 }
  }

  async uploadDocument(_userId: string, knowledgeBaseId: string, input: { fileName: string; mimeType: string; read: () => Promise<Buffer> }) {
    const base = this.manage(knowledgeBaseId, 'docs')
    const bytes = await input.read()
    if (base.documents.some(item => item.fileName === input.fileName)) throw stateConflict('该文档已存在')
    const document: KnowledgeDocumentView = {
      id: `doc-new-${this.sequence++}`, title: input.fileName.replace(/\.[^.]+$/, ''), fileName: input.fileName, fileSize: bytes.length,
      status: 'parsing', errorMessage: null, uploadedBy: '林岚', updatedAt: new Date().toISOString(),
    }
    base.documents.unshift(document)
    return { ...document }
  }

  async updateDocument(_userId: string, knowledgeBaseId: string, documentId: string, input: { title: string }) {
    if (!input.title.trim()) throw invalidRequest('标题长度为 1～200 个字')
    this.document(this.manage(knowledgeBaseId, 'docs'), documentId).title = input.title.trim()
  }

  async reparseDocument(_userId: string, knowledgeBaseId: string, documentId: string) {
    const document = this.document(this.manage(knowledgeBaseId, 'docs'), documentId)
    document.status = 'parsing'
    document.errorMessage = null
  }

  async deleteDocument(_userId: string, knowledgeBaseId: string, documentId: string) {
    const base = this.manage(knowledgeBaseId, 'docs')
    this.document(base, documentId)
    base.documents = base.documents.filter(item => item.id !== documentId)
  }

  async downloadDocument(_userId: string, knowledgeBaseId: string, documentId: string) {
    this.requireLevel('view')
    const document = this.document(this.find(knowledgeBaseId), documentId)
    return { fileName: document.fileName, mimeType: 'application/octet-stream', bytes: Buffer.from(`冒烟测试文件：${document.title}`) }
  }

  async previewDocument(_userId: string, knowledgeBaseId: string, documentId: string) {
    this.requireLevel('view')
    const document = this.document(this.find(knowledgeBaseId), documentId)
    return { text: `${document.title}\n\n（冒烟测试的预览文本）`, truncated: false }
  }

  async sessionKnowledgeBases(_userId: string, sessionId: string): Promise<SessionKnowledgeBaseView[]> {
    this.requirePersonalSession(sessionId)
    return this.selected(sessionId)
  }

  async setSessionKnowledgeBases(_userId: string, sessionId: string, knowledgeBaseIds: string[]) {
    this.requireLevel('view')
    this.requirePersonalSession(sessionId)
    const ids = [...new Set(knowledgeBaseIds)]
    const current = this.sessions.get(sessionId) ?? []
    if (ids.some(id => !current.includes(id) && !this.active().some(base => base.id === id))) throw notFound('知识库不存在或你没有查看权限')
    this.sessions.set(sessionId, ids)
    return this.selected(sessionId)
  }

  private selected(sessionId: string): SessionKnowledgeBaseView[] {
    return (this.sessions.get(sessionId) ?? []).flatMap(id => {
      const base = this.bases.find(item => item.id === id)
      return base ? [{ id: base.id, name: base.name, available: !base.deleted }] : []
    })
  }

  /** 冒烟数据中属于团队空间的会话；其余（含新建的个人对话）按个人空间处理。 */
  private requirePersonalSession(sessionId: string) {
    const task = mockTasks.find(item => item.sessionId === sessionId)
    if (task && !task.workspaceId.startsWith('ws-personal')) throw invalidRequest('目前只能在个人空间的对话中添加知识库')
  }

  private requireLevel(minimum: KnowledgeLevel) {
    if (levelRank[this.level] < levelRank[minimum]) {
      throw accessDenied(minimum === 'view' ? '你没有查看企业知识库的权限' : '你没有执行此操作的知识库权限')
    }
  }

  private active() {
    return this.bases.filter(base => !base.deleted)
  }

  private find(knowledgeBaseId: string) {
    const base = this.active().find(item => item.id === knowledgeBaseId)
    if (!base) throw notFound('知识库不存在或你没有查看权限')
    return base
  }

  private manage(knowledgeBaseId: string, minimum: 'docs' | 'bases') {
    this.requireLevel('view')
    const base = this.find(knowledgeBaseId)
    if (levelRank[this.level] < levelRank[minimum] || !myDepartments.some(item => item.id === base.ownerDepartmentId)) {
      throw accessDenied(minimum === 'docs' ? '只能管理归属你所在部门的知识库中的文档' : '只能管理归属你所在部门的知识库')
    }
    return base
  }

  private document(base: MemoryBase, documentId: string) {
    const document = base.documents.find(item => item.id === documentId)
    if (!document) throw notFound('文档不存在')
    return document
  }

  private view(base: MemoryBase): KnowledgeBaseView {
    const owned = myDepartments.some(item => item.id === base.ownerDepartmentId)
    const owner = Object.values(departments).find(item => item.id === base.ownerDepartmentId)
    return {
      id: base.id, name: base.name, description: base.description,
      ownerDepartmentId: base.ownerDepartmentId, ownerDepartmentName: owner?.name ?? '',
      canManageDocuments: owned && levelRank[this.level] >= levelRank.docs,
      canManageBase: owned && this.level === 'bases',
      documentCount: base.documents.length,
      processingCount: base.documents.filter(item => item.status === 'parsing').length,
      updatedAt: base.updatedAt,
      grants: base.grants.map(grant => ({ ...grant })),
    }
  }
}
