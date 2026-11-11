import { createHash, randomUUID } from 'node:crypto'

import type { AuditTrail } from '../../domain/audit-trail.ts'
import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { toolPreconditionFailed, toolUnavailable } from '../runtime/platform-tool-contract.ts'
import type { RuntimeKnowledgeDocument } from '../runtime/runtime-types.ts'
import { knowledgeViewLevel, visibleBaseIdsSql } from './knowledge-access.ts'
import type { KnowledgeCitation, KnowledgeProvider, KnowledgeResolution, KnowledgeToolResult } from './knowledge-provider.ts'
import type { PostgresKnowledgeConnection } from './knowledge-connection.ts'
import { WeKnoraRequestError, WeKnoraUnavailableError, type WeKnoraClient, type WeKnoraFailureReason } from './weknora-client.ts'

const tenantId = 'tenant-dsh-work'
const maxContextDocuments = 3
const searchMatchCount = 10
/** Agent 知识检索工具每个 Attempt 最多调用的次数（KS3）。 */
export const maxKnowledgeToolCalls = 3
/**
 * WeKnora 分值在 0～1 之间（重排序或混合检索）。低于该值的分段不注入，避免每次都带上弱相关内容
 * （4.4 第 1 步）。2026-11-02 在 WeKnora v0.9.0、未配置重排序时校准：命中文档 0.56～0.83，无关提问最高
 * 0.36，相关提问中非目标文档最高 0.45。2026-11-11 启用重排序（qwen3-rerank）后复核：命中 0.62～0.91，非目标
 * 最高 0.43，无关提问最高 0.39，保持 0.5。契约测试中的“最低相关度”用例在升级或更换模型后复核。
 */
export const minimumRelevanceScore = 0.5
const maxExcerptLength = 4000
const maxSkippedBases = 20
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

interface SelectedBaseRow {
  id: string
  externalId: string
  name: string
  visible: boolean
  /** 知识库因更换连接地址标为“原连接已更换”（优化方案 O9）。 */
  moved: boolean
}

/**
 * 企业知识库接入 WeKnora（weknora-knowledge-plan）。可见范围按部门授权实时计算（5.3、5.5），
 * 检索范围 = 会话所选知识库 ∩ 当前可见知识库（5.7）；返回结果再按本次传入的知识库校验一次
 * （4.4 第 4 步）。员工与 Agent 都须具备查看级别（5.1、WK14）。
 */
export class WeKnoraKnowledgeProvider implements KnowledgeProvider {
  readonly connectionId: string
  private readonly database: DatabaseClient
  private readonly connection: PostgresKnowledgeConnection
  private readonly audit: AuditTrail | undefined

  constructor(database: DatabaseClient, connection: PostgresKnowledgeConnection, audit?: AuditTrail) {
    this.database = database
    this.connection = connection
    this.connectionId = connection.connectionId
    this.audit = audit
  }

  /**
   * 执行前检索与知识检索工具共用的复核（5.1、5.3、5.7，WK14）：连接、身份模式、员工与 Agent 的查看级别，
   * 以及会话所选知识库当前是否可见。每次调用都实时读取，不使用 Manifest 中冻结的结果。
   */
  private async evaluate(input: { sessionId: string; userId: string; agentVersionId: string }) {
    const [levels] = await this.database<{ connection: boolean; localIdentity: boolean; employee: boolean; agent: boolean }[]>`
      select
        exists (
          select 1 from external_knowledge_connections c
           where c.tenant_id = ${tenantId} and c.id = ${this.connectionId} and c.status = 'active'
        ) as connection,
        -- 按部门授权只在本地身份模式下提供；AI Hub（OIDC）账号没有部门，也没有添加入口（第 3 节）。
        exists (
          select 1 from users u
           where u.tenant_id = ${tenantId} and u.id = ${input.userId} and u.identity_provider <> 'ai-hub'
        ) as "localIdentity",
        exists (
          select 1 from users u
            join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
             and (ur.valid_until is null or ur.valid_until > now())
             and (ur.source_key = 'local' or ur.source_key like 'department:%')
            join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.status = 'active'
           where u.tenant_id = ${tenantId} and u.id = ${input.userId} and u.status = 'active'
             and r.permissions ?| ${knowledgeViewLevel}::text[]
        ) as employee,
        exists (
          select 1 from agent_versions av
            join execution_principals ep on ep.tenant_id = av.tenant_id and ep.agent_id = av.agent_id
             and ep.kind = 'agent' and ep.status = 'active'
            join agent_principal_role_grants g on g.tenant_id = ep.tenant_id and g.principal_id = ep.id
            join roles r on r.tenant_id = g.tenant_id and r.id = g.role_id and r.status = 'active'
           where av.tenant_id = ${tenantId} and av.id = ${input.agentVersionId}
             and r.permissions ?| ${knowledgeViewLevel}::text[]
        ) as agent
    `
    const selected: SelectedBaseRow[] = levels?.localIdentity ? await this.database<SelectedBaseRow[]>`
      select kb.id, kb.external_id as "externalId", kb.name,
             (kb.status = 'active' and kb.id in (${visibleBaseIdsSql(this.database, input.userId)})) as visible,
             kb.status = 'unavailable' as moved
        from session_knowledge_bases skb
        join external_knowledge_bases kb on kb.tenant_id = skb.tenant_id and kb.id = skb.knowledge_base_id
       where skb.tenant_id = ${tenantId} and skb.session_id = ${input.sessionId}
         and kb.connection_id = ${this.connectionId}
       order by skb.added_at, kb.id
    ` : []
    return {
      levels: levels ?? { connection: false, localIdentity: false, employee: false, agent: false },
      selected,
    }
  }

  async resolveContext(input: {
    sessionId: string
    userId: string
    agentVersionId: string
    query: string
    fallbackQuery?: string
  }): Promise<KnowledgeResolution> {
    const empty = { documents: [], citations: [], skippedBases: [] }
    const { levels, selected } = await this.evaluate(input)
    if (!levels.localIdentity) return { status: 'not_applicable', ...empty }

    // Manifest 最多记 20 个名称；会话所选知识库没有数量上限，超出的不再逐一提示。
    const names = (bases: SelectedBaseRow[]) => bases.map(base => base.name.trim()).filter(Boolean).slice(0, maxSkippedBases)

    // 会话没有添加知识库：不具备检索条件时与之前相同，不进入 Manifest；否则按 WK18 提示添加知识库。
    if (!selected.length) {
      const ready = levels.connection && levels.employee && levels.agent && await this.connection.client() !== null
      return { status: ready ? 'not_selected' : 'not_applicable', ...empty }
    }
    // 优化方案 O2：员工添加了知识库但本次没有检索时，都要让模型与员工知道，不能静默按普通对话回答。
    // 连接停用、未配置或 API Key 读不出按不可用处理；这不是 WeKnora 故障，不写连接的失败记录。
    const client = levels.connection ? await this.connection.client() : null
    if (!client) return { status: 'unavailable', ...empty, failureReason: 'not_configured' }
    // 员工已不具备查看级别：所选知识库都按“你已无权查看”跳过。
    if (!levels.employee) return { status: 'skipped', ...empty, skippedBases: names(selected) }
    // Agent 的判断取其执行身份的全部岗位角色，不用与员工角色取交集后的权限（5.1、WK14）。
    if (!levels.agent) return { status: 'skipped', ...empty, skippedReason: 'agent_not_permitted' }

    const scope = selected.filter(base => base.visible)
    // 原连接已更换的知识库单独提示，不说成“你已无权查看”，避免员工误以为被收回了权限。
    const skippedBases = names(selected.filter(base => !base.visible && !base.moved))
    const movedBases = names(selected.filter(base => !base.visible && base.moved))
    const skips = { skippedBases, ...(movedBases.length ? { movedBases } : {}) }
    if (!scope.length) return { status: 'skipped', documents: [], citations: [], ...skips }

    let retrieved: Awaited<ReturnType<WeKnoraKnowledgeProvider['retrieve']>>
    try {
      retrieved = await this.retrieve(client, input.query, scope)
    } catch (error) {
      if (!(error instanceof WeKnoraUnavailableError || error instanceof WeKnoraRequestError)) throw error
      const failureReason = error instanceof WeKnoraUnavailableError ? error.reason : 'protocol'
      await this.recordFailure(failureReason)
      return { status: 'unavailable', documents: [], citations: [], ...skips, failureReason }
    }
    // 优化方案 O3：本次提问没有结果时，再用“上一条提问 + 本次提问”检索一次，追问也能命中；两次结果不合并。
    // 第二次失败时保留第一次“没有找到”的结果，不算不可用。
    const fallbackQuery = input.fallbackQuery?.trim()
    if (!retrieved.documents.length && fallbackQuery && fallbackQuery !== input.query.trim()) {
      try {
        const second = await this.retrieve(client, fallbackQuery, scope)
        if (second.documents.length) retrieved = second
        else retrieved = { ...retrieved, rerankOutcome: second.rerankOutcome ?? retrieved.rerankOutcome }
      } catch (error) {
        if (!(error instanceof WeKnoraUnavailableError || error instanceof WeKnoraRequestError)) throw error
        console.warn('WeKnora fallback search failed; keeping the first empty result')
      }
    }
    await this.recordSuccess(retrieved.rerankOutcome)
    return { status: 'ok', documents: retrieved.documents, citations: retrieved.citations, ...skips }
  }

  /**
   * Agent 知识检索工具（Agent 知识检索工具方案 4.3，KO9）：每次调用实时复核范围，筛选规则与执行前检索相同，
   * 结果写入引用快照并续编序号（KS5）。审计不记录检索词与摘录（KS6）；失败单独审计，不计入健康状态的
   * 检索与不可用次数（KS7）。
   */
  async searchForTool(input: {
    runId: string
    attemptId: string
    sessionId: string
    userId: string
    agentVersionId: string
    traceId: string
    query: string
    knowledgeBaseNames?: string[]
    callNumber: number
    signal?: AbortSignal
  }): Promise<KnowledgeToolResult> {
    if (input.callNumber > maxKnowledgeToolCalls) {
      throw toolPreconditionFailed(`本次回答的知识检索次数已用完（每次回答最多 ${maxKnowledgeToolCalls} 次），请依据已有资料回答或如实说明`)
    }
    const query = input.query.trim()
    if (!query) throw toolPreconditionFailed('检索词不能为空')
    const { levels, selected } = await this.evaluate(input)
    if (!levels.localIdentity || !levels.employee || !levels.agent) {
      throw toolPreconditionFailed('当前不能检索企业知识库：员工或 AI 同事已没有知识库查看权限')
    }
    const client = levels.connection ? await this.connection.client() : null
    if (!client) throw toolUnavailable('企业知识库尚未配置或已停用，本次检索未执行')
    if (!selected.length) throw toolPreconditionFailed('这次对话没有添加知识库')
    let candidates = selected
    if (input.knowledgeBaseNames?.length) {
      const wanted = new Set(input.knowledgeBaseNames.map(name => name.trim()))
      const known = new Set(selected.map(base => base.name.trim()))
      const unknown = [...wanted].filter(name => !known.has(name))
      if (unknown.length) {
        throw toolPreconditionFailed(`这些知识库不在本次对话添加的范围内：${unknown.join('、')}。可用的知识库：${[...known].join('、')}`)
      }
      candidates = selected.filter(base => wanted.has(base.name.trim()))
    }
    const scope = candidates.filter(base => base.visible)
    const names = (bases: SelectedBaseRow[]) => bases.map(base => base.name.trim()).filter(Boolean).slice(0, maxSkippedBases)
    const skippedBases = names(candidates.filter(base => !base.visible && !base.moved))
    const movedBases = names(candidates.filter(base => !base.visible && base.moved))
    if (!scope.length) throw toolPreconditionFailed('所选知识库当前都不可用（已删除、已无权查看或连接已更换）')
    input.signal?.throwIfAborted()
    const auditTarget = `Attempt ${input.attemptId}`

    let retrieved: Awaited<ReturnType<WeKnoraKnowledgeProvider['retrieve']>>
    try {
      retrieved = await this.retrieve(client, query, scope)
    } catch (error) {
      if (!(error instanceof WeKnoraUnavailableError || error instanceof WeKnoraRequestError)) throw error
      const reason = error instanceof WeKnoraUnavailableError ? error.reason : 'protocol'
      await this.recordFailure(reason)
      await this.audit?.appendAudit(input.userId, 'knowledge.search.tool', input.runId, 'failed', input.traceId,
        `${auditTarget}：知识检索工具调用失败（${reason}），检索词 ${query.length} 字`, 'run')
      throw toolUnavailable('企业知识库暂不可用，本次检索未完成')
    }
    await this.recordSuccess(retrieved.rerankOutcome)
    // 工具超时或 Attempt 取消后不再写入引用：模型没有拿到的资料不能出现在页脚（评审 PR 118）。
    input.signal?.throwIfAborted()
    const ordinals = await this.appendToolCitations(input, retrieved.citations)
    await this.audit?.appendAudit(input.userId, 'knowledge.search.tool', input.runId, 'success', input.traceId,
      `${auditTarget}：知识检索工具（第 ${input.callNumber} 次），检索词 ${query.length} 字，知识库 ${scope.map(base => base.id).join('、')}，`
        + `命中 ${retrieved.citations.map(citation => `${citation.externalDocumentId}:${citation.relevanceScore.toFixed(3)}`).join('、') || '无'}`,
      'run')
    return {
      documents: retrieved.citations.map((citation, index) => ({
        ordinal: ordinals[index]!,
        title: citation.title,
        knowledgeBaseName: citation.knowledgeBaseName,
        updatedDate: citation.documentUpdatedAt.slice(0, 10),
        excerpt: citation.excerpt,
      })),
      skippedBases,
      movedBases,
      remainingCalls: maxKnowledgeToolCalls - input.callNumber,
    }
  }

  /**
   * 引用续编（KS5）：接在本 Attempt 已有引用之后编号；同一文档、同一校验值的分段已在本 Attempt 中出现时
   * 不新增行，沿用原序号。锁住 Attempt 行，序号分配与写入在同一事务中完成。
   */
  private async appendToolCitations(input: { runId: string; attemptId: string }, citations: KnowledgeCitation[]): Promise<number[]> {
    if (!citations.length) return []
    return this.database.begin(async transaction => {
      await transaction`select id from run_attempts where tenant_id = ${tenantId} and id = ${input.attemptId} for update`
      const existing = await transaction<{ ordinal: number; externalDocumentId: string; contentChecksum: string }[]>`
        select ordinal, external_document_id as "externalDocumentId", content_checksum as "contentChecksum"
          from run_knowledge_citations where tenant_id = ${tenantId} and attempt_id = ${input.attemptId}
      `
      const known = new Map(existing.map(row => [`${row.externalDocumentId}|${row.contentChecksum}`, row.ordinal]))
      let next = existing.reduce((max, row) => Math.max(max, row.ordinal), 0) + 1
      const ordinals: number[] = []
      for (const citation of citations) {
        const key = `${citation.externalDocumentId}|${citation.contentChecksum}`
        const reused = known.get(key)
        if (reused !== undefined) {
          ordinals.push(reused)
          continue
        }
        await transaction`
          insert into run_knowledge_citations (
            id, tenant_id, run_id, attempt_id, ordinal, external_document_id, knowledge_base_id, knowledge_base_name,
            title, file_name, document_updated_at, content_checksum, excerpt, relevance_score, source
          ) values (
            ${`run-knowledge-${randomUUID()}`}, ${tenantId}, ${input.runId}, ${input.attemptId}, ${next},
            ${citation.externalDocumentId}, ${citation.knowledgeBaseId}, ${citation.knowledgeBaseName}, ${citation.title},
            ${citation.fileName}, ${citation.documentUpdatedAt}, ${citation.contentChecksum}, ${citation.excerpt},
            ${citation.relevanceScore}, 'tool'
          )
        `
        known.set(key, next)
        ordinals.push(next)
        next += 1
      }
      return ordinals
    })
  }

  async addCitationFooter(attemptId: string, answer: string): Promise<string> {
    const [attempt] = await this.database<{ status: string | null; skipped: string[] | null; moved: string[] | null; reason: string | null }[]>`
      select manifest->>'knowledge_status' as status, manifest->'knowledge_skipped_bases' as skipped,
             manifest->'knowledge_moved_bases' as moved,
             manifest->>'knowledge_skipped_reason' as reason
        from run_attempts where tenant_id = ${tenantId} and id = ${attemptId}
    `
    const citations = await this.database<{ ordinal: number; documentId: string; title: string; updatedAt: Date }[]>`
      select ordinal, external_document_id as "documentId", title, document_updated_at as "updatedAt"
        from run_knowledge_citations
       where tenant_id = ${tenantId} and attempt_id = ${attemptId}
       order by ordinal
    `
    const sections: string[] = []
    if (citations.length) {
      // 优化方案 O6：列出的是本次注入的全部资料，不代表模型都引用了。同一篇文档的多个分段合并为一行，
      // 列出它的全部序号（评审 PR 118：检索工具可能取到同一文档的另一个分段）。
      const documents = new Map<string, { ordinals: number[]; title: string; updatedAt: Date }>()
      for (const row of citations) {
        const entry = documents.get(row.documentId)
        if (entry) entry.ordinals.push(row.ordinal)
        else documents.set(row.documentId, { ordinals: [row.ordinal], title: row.title, updatedAt: row.updatedAt })
      }
      sections.push(['本次检索到的资料', ...[...documents.values()].map(document =>
        `- ${document.ordinals.map(ordinal => `【${ordinal}】`).join('')}${document.title}（更新于 ${formatDate(document.updatedAt)}）`)].join('\n'))
    } else if (attempt?.status === 'ok') {
      sections.push('已查询所添加的知识库，没有找到相关内容，本次回答未引用企业知识。')
    }
    if (attempt?.reason === 'agent_not_permitted') {
      sections.push('当前 AI 同事未开通企业知识，本次未使用所添加的知识库。')
    }
    for (const name of attempt?.skipped ?? []) sections.push(`知识库“${name}”你已无权查看，本次未使用。`)
    for (const name of attempt?.moved ?? []) sections.push(`知识库“${name}”的连接已更换，暂不可用，本次未使用；如需继续使用请联系管理员。`)
    if (attempt?.status === 'unavailable') sections.push('企业知识库暂不可用，本次回答未引用企业知识。')
    return sections.length ? `${answer.trim()}\n\n${sections.join('\n\n')}` : answer
  }

  private async retrieve(client: WeKnoraClient, query: string, scope: SelectedBaseRow[]): Promise<{
    documents: RuntimeKnowledgeDocument[]
    citations: KnowledgeCitation[]
    rerankOutcome: string | null
  }> {
    const byExternalId = new Map(scope.map(base => [base.externalId, base]))
    const { results, rerankOutcome } = await client.search({
      query,
      knowledgeBaseIds: scope.map(base => base.externalId),
      matchCount: searchMatchCount,
    })
    // 4.4：去掉弱相关分段，每篇文档只留得分最高的分段；校验后取前 3 篇，被丢弃的由后面的候选补上。
    const best = new Map<string, typeof results[number]>()
    for (const result of [...results].sort((a, b) => b.score - a.score)) {
      if (result.score < minimumRelevanceScore || best.has(result.knowledge_id)) continue
      if (result.knowledge_base_id !== undefined && !byExternalId.has(result.knowledge_base_id)) {
        console.warn('WeKnora returned a chunk outside the requested knowledge bases; dropped')
        continue
      }
      best.set(result.knowledge_id, result)
    }
    if (!best.size) return { documents: [], citations: [], rerankOutcome }
    const metadata = new Map((await client.knowledgeBatch([...best.keys()])).map(item => [item.id, item]))
    const documents: RuntimeKnowledgeDocument[] = []
    const citations: KnowledgeCitation[] = []
    for (const result of best.values()) {
      if (documents.length === maxContextDocuments) break
      const document = metadata.get(result.knowledge_id)
      // 单篇文档的元数据缺失（例如两次请求之间被删除）只丢弃这一篇；接口本身失败才算不可用（4.4 第 3 步）。
      if (!document) {
        console.warn('WeKnora document metadata is missing; dropped')
        continue
      }
      const base = byExternalId.get(document.knowledge_base_id)
      const documentId = `weknora:${result.knowledge_id}`
      if (!base || (result.knowledge_base_id !== undefined && result.knowledge_base_id !== document.knowledge_base_id)) {
        console.warn('WeKnora document belongs to a knowledge base outside the request; dropped')
        continue
      }
      if (!documentIdPattern.test(documentId)) {
        console.warn('WeKnora knowledge id does not match the platform ID format; dropped')
        continue
      }
      const updatedAt = new Date(document.updated_at)
      const title = result.knowledge_title.trim() || document.title.trim() || result.knowledge_filename.trim()
        || document.file_name.trim() || '未命名文档'
      const excerpt = truncateExcerpt(result.content)
      if (!excerpt.trim()) continue
      const contentChecksum = createHash('sha256').update(result.content).digest('hex')
      documents.push({
        documentId,
        title,
        version: formatVersion(updatedAt),
        effectiveDate: formatDate(updatedAt),
        dataScope: `knowledge:${base.name}`,
        contentChecksum,
        excerpt,
      })
      citations.push({
        ordinal: citations.length + 1,
        externalDocumentId: result.knowledge_id,
        knowledgeBaseId: base.id,
        knowledgeBaseName: base.name,
        title,
        fileName: result.knowledge_filename || document.file_name,
        documentUpdatedAt: updatedAt.toISOString(),
        contentChecksum,
        excerpt,
        relevanceScore: result.score,
      })
    }
    return { documents, citations, rerankOutcome }
  }

  /** 记录成功与本次重排序结果（优化方案 O5）：WeKnora 重排序降级时检索照常返回，只能靠这里让管理员看到。 */
  private async recordSuccess(rerankOutcome: string | null) {
    await this.database`
      update external_knowledge_connections
         set last_success_at = now(),
             last_rerank_outcome = coalesce(${rerankOutcome}, last_rerank_outcome),
             last_rerank_at = case when ${rerankOutcome}::text is null then last_rerank_at else now() end
       where tenant_id = ${tenantId} and id = ${this.connectionId}
    `
  }

  private async recordFailure(reason: WeKnoraFailureReason) {
    console.warn(`WeKnora unavailable: ${reason}`)
    await this.database`
      update external_knowledge_connections set last_failure_at = now(), last_failure_reason = ${reason}
       where tenant_id = ${tenantId} and id = ${this.connectionId}
    `
  }
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10)
}

/** WeKnora 文档没有版本号：用更新时间 YYYYMMDD.HHmm（4.5）。 */
function formatVersion(value: Date) {
  const iso = value.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}.${iso.slice(11, 13)}${iso.slice(14, 16)}`
}

/** 超过 4000 字时按码点截断并加“…”，不切开代理对，总长不超过编译校验的上限（4.5）。 */
function truncateExcerpt(content: string) {
  if (content.length <= maxExcerptLength) return content
  let excerpt = ''
  for (const character of content) {
    if (excerpt.length + character.length > maxExcerptLength - 1) break
    excerpt += character
  }
  return `${excerpt}…`
}
