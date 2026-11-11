import { invalidRequest, notFound } from '../../domain/request-errors.ts'
import type {
  KnowledgeAdminBase,
  KnowledgeAdminBaseList,
  KnowledgeAdminDepartment,
  KnowledgeAdminOverview,
} from '../../modules/knowledge/postgres-knowledge-admin-service.ts'

type MemoryAdminBase = Omit<KnowledgeAdminBase, 'needsRebuild' | 'ownerDepartmentName' | 'ownerDepartmentActive' | 'status' | 'summaryModelConfigured'>
  & { status?: KnowledgeAdminBase['status']; summaryModelConfigured?: boolean }

const departments: Array<KnowledgeAdminDepartment & { active: boolean; name: string }> = [
  { id: 'dept-root', label: '全公司', name: '全公司', root: true, active: true },
  { id: 'dept-supply', label: '供应链部', name: '供应链部', root: false, active: true },
  { id: 'dept-plan', label: '供应链部 / 计划组', name: '计划组', root: false, active: true },
  { id: 'dept-procurement', label: '供应链部 / 采购组', name: '采购组', root: false, active: true },
  { id: 'dept-finance', label: '财务部', name: '财务部', root: false, active: true },
  { id: 'dept-sales', label: '销售部', name: '销售部', root: false, active: true },
  { id: 'dept-general', label: '综合管理部', name: '综合管理部', root: false, active: true },
  { id: 'dept-quality', label: '质量部', name: '质量部', root: false, active: false },
]

/**
 * P0 冒烟用的管理端企业知识库（验收目录 KB-ADM-P0）：一组确定性的连接与知识库，只用于页面冒烟，随
 * `/api/testing/p0/reset` 重建。加密凭据、权限与 WeKnora 转发由 PostgreSQL 实现与 KB-ADM-01/02 集成测试保证。
 */
export class MemoryKnowledgeAdminStore {
  private sequence = 1
  private connection: KnowledgeAdminOverview['connection'] = {
    configured: true, baseUrl: 'https://weknora.internal.example.com', credentialHint: '7f3a',
    credentialExpiresAt: '2027-05-01T00:00:00.000Z', credentialSource: 'admin', embeddingModelId: '5d0f6c2a-7b1e-4c3d-9a8e-2f4b6d8c1a90', enabled: true,
    lastSuccessAt: new Date(Date.now() - 2 * 60_000).toISOString(), lastFailureAt: '2026-11-01T13:14:00.000Z', lastFailureReason: 'timeout',
    lastRerankOutcome: 'model_unavailable', lastRerankAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    credentialReadable: true,
  }
  private bases: MemoryAdminBase[] = [
    { id: 'kb-plan', name: '计划组工作手册', description: '排产、补货与例会规范', ownerDepartmentId: 'dept-plan', documentCount: 4, updatedAt: '2026-10-28T09:30:00Z', embeddingModelId: '5d0f6c2a-7b1e-4c3d-9a8e-2f4b6d8c1a90',
      grants: [
        { id: 'grant-plan', departmentId: 'dept-plan', departmentName: '计划组', includeDescendants: true, grantedVia: 'employee' },
        { id: 'grant-plan-finance', departmentId: 'dept-finance', departmentName: '财务部', includeDescendants: false, grantedVia: 'admin' },
      ] },
    { id: 'kb-supply', name: '供应链制度库', description: '供应链部发布的制度与流程', ownerDepartmentId: 'dept-supply', documentCount: 12, updatedAt: '2026-10-20T10:00:00Z', embeddingModelId: '5d0f6c2a-7b1e-4c3d-9a8e-2f4b6d8c1a90',
      grants: [{ id: 'grant-supply', departmentId: 'dept-supply', departmentName: '供应链部', includeDescendants: true, grantedVia: 'employee' }] },
    { id: 'kb-all', name: '全员制度汇编', description: '人事、行政、财务通用制度', ownerDepartmentId: 'dept-general', documentCount: 36, updatedAt: '2026-09-30T09:00:00Z', embeddingModelId: '5d0f6c2a-7b1e-4c3d-9a8e-2f4b6d8c1a90',
      grants: [{ id: 'grant-all', departmentId: 'dept-root', departmentName: '全公司', includeDescendants: true, grantedVia: 'admin' }] },
    { id: 'kb-quality', name: '旧版质量手册', description: '质量部撤并前的检验规范', ownerDepartmentId: 'dept-quality', documentCount: 9, updatedAt: '2026-06-12T08:00:00Z', embeddingModelId: '5d0f6c2a-7b1e-4c3d-9a8e-2f4b6d8c1a90', grants: [] },
    { id: 'kb-sales', name: '销售话术库', description: '产品介绍与常见问题', ownerDepartmentId: 'dept-sales', documentCount: 21, updatedAt: '2026-08-02T08:00:00Z', embeddingModelId: '9e1b3a7c-2d4f-4e6a-8b0c-1f3e5d7a9c2b',
      summaryModelConfigured: true,
      grants: [{ id: 'grant-sales', departmentId: 'dept-sales', departmentName: '销售部', includeDescendants: true, grantedVia: 'employee' }] },
  ]

  async overview(): Promise<KnowledgeAdminOverview> {
    return { connection: { ...this.connection }, health: { retrievals24h: 128, unavailable24h: 2 } }
  }

  async updateConnection(_actorId: string, input: { baseUrl: string; apiKey?: string; credentialExpiresAt?: string | null; embeddingModelId?: string | null; enabled: boolean }) {
    if (!/^https?:\/\//.test(input.baseUrl.trim())) throw invalidRequest('WeKnora 地址必须以 http 或 https 开头')
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    // 优化方案 O9：更换地址后原有知识库标为“原连接已更换”。
    if (baseUrl !== this.connection.baseUrl) {
      for (const base of this.bases) if ((base.status ?? 'active') === 'active') base.status = 'unavailable'
    }
    this.connection = {
      ...this.connection,
      baseUrl,
      enabled: input.enabled,
      embeddingModelId: input.embeddingModelId?.trim() || null,
      ...(input.apiKey ? { credentialHint: input.apiKey.slice(-4), credentialSource: 'admin' as const } : {}),
      ...(input.credentialExpiresAt !== undefined ? { credentialExpiresAt: input.credentialExpiresAt } : input.apiKey ? { credentialExpiresAt: null } : {}),
    }
    return this.overview()
  }

  async testConnection() {
    return { ok: true, reason: null }
  }

  async departments(): Promise<KnowledgeAdminDepartment[]> {
    return departments.filter(item => item.active).map(({ id, label, root }) => ({ id, label, root }))
  }

  async listBases(): Promise<KnowledgeAdminBaseList> {
    return {
      statsAvailable: true,
      items: this.bases.map(base => {
        const owner = departments.find(item => item.id === base.ownerDepartmentId)
        return {
          ...base, grants: base.grants.map(grant => ({ ...grant })),
          ownerDepartmentName: owner?.name ?? '', ownerDepartmentActive: owner?.active ?? false,
          needsRebuild: Boolean(this.connection.embeddingModelId && base.embeddingModelId !== this.connection.embeddingModelId),
          status: base.status ?? 'active',
          summaryModelConfigured: base.summaryModelConfigured ?? false,
        }
      }),
    }
  }

  async createBase(_actorId: string, input: { name: string; description?: string; ownerDepartmentId: string }) {
    const owner = this.activeDepartment(input.ownerDepartmentId, false)
    if (!input.name.trim()) throw invalidRequest('名称长度为 1～60 个字')
    this.bases.push({
      id: `kb-admin-${this.sequence++}`, name: input.name.trim(), description: (input.description ?? '').trim(), ownerDepartmentId: owner.id,
      documentCount: 0, updatedAt: new Date().toISOString(), embeddingModelId: this.connection.embeddingModelId,
      grants: [{ id: `grant-admin-${this.sequence++}`, departmentId: owner.id, departmentName: owner.name, includeDescendants: true, grantedVia: 'admin' }],
    })
    return this.listBases()
  }

  async updateOwner(_actorId: string, knowledgeBaseId: string, ownerDepartmentId: string) {
    this.find(knowledgeBaseId).ownerDepartmentId = this.activeDepartment(ownerDepartmentId, false).id
    return this.listBases()
  }

  async addGrant(_actorId: string, knowledgeBaseId: string, input: { departmentId: string; includeDescendants?: boolean }) {
    const base = this.find(knowledgeBaseId)
    const department = this.activeDepartment(input.departmentId, true)
    const existing = base.grants.find(grant => grant.departmentId === department.id)
    if (existing) Object.assign(existing, { includeDescendants: input.includeDescendants ?? true, grantedVia: 'admin' as const })
    else {
      base.grants.push({ id: `grant-admin-${this.sequence++}`, departmentId: department.id, departmentName: department.name, includeDescendants: input.includeDescendants ?? true, grantedVia: 'admin' })
    }
    return this.listBases()
  }

  async revokeGrant(_actorId: string, knowledgeBaseId: string, grantId: string) {
    const base = this.find(knowledgeBaseId)
    if (!base.grants.some(grant => grant.id === grantId)) throw notFound('授权不存在')
    base.grants = base.grants.filter(grant => grant.id !== grantId)
    return this.listBases()
  }

  /** 内存数据中原地址的知识库在新连接中都视为存在，恢复总是成功。 */
  async restoreBase(_actorId: string, knowledgeBaseId: string) {
    const base = this.find(knowledgeBaseId)
    if ((base.status ?? 'active') !== 'unavailable') throw invalidRequest('知识库不需要恢复')
    base.status = 'active'
    return this.listBases()
  }

  async deleteBase(_actorId: string, knowledgeBaseId: string) {
    this.find(knowledgeBaseId)
    this.bases = this.bases.filter(base => base.id !== knowledgeBaseId)
    return this.listBases()
  }

  private find(knowledgeBaseId: string) {
    const base = this.bases.find(item => item.id === knowledgeBaseId)
    if (!base) throw notFound('知识库不存在')
    return base
  }

  private activeDepartment(departmentId: string, allowRoot: boolean) {
    const department = departments.find(item => item.id === departmentId && item.active)
    if (!department) throw invalidRequest('部门不存在或已删除')
    if (department.root && !allowRoot) throw invalidRequest('归属部门不能是根部门')
    return department
  }
}
