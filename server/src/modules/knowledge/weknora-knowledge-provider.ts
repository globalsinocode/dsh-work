import { createHash } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { RuntimeKnowledgeDocument } from '../runtime/runtime-types.ts'
import { knowledgeViewLevel, visibleBaseIdsSql } from './knowledge-access.ts'
import type { KnowledgeCitation, KnowledgeProvider, KnowledgeResolution } from './knowledge-provider.ts'
import type { PostgresKnowledgeConnection } from './knowledge-connection.ts'
import { WeKnoraRequestError, WeKnoraUnavailableError, type WeKnoraClient, type WeKnoraFailureReason } from './weknora-client.ts'

const tenantId = 'tenant-dsh-work'
const maxContextDocuments = 3
const searchMatchCount = 10
/**
 * WeKnora 分值在 0～1 之间（重排序或混合检索）。低于该值的分段不注入，避免每次都带上弱相关内容
 * （4.4 第 1 步）。2026-11-02 在 WeKnora v0.9.0、未配置重排序时校准：命中文档 0.56～0.83，无关提问最高
 * 0.36，相关提问中非目标文档最高 0.45；契约测试中的“最低相关度”用例在升级或更换模型后复核。
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

  constructor(database: DatabaseClient, connection: PostgresKnowledgeConnection) {
    this.database = database
    this.connection = connection
    this.connectionId = connection.connectionId
  }

  async resolveContext(input: {
    sessionId: string
    userId: string
    agentVersionId: string
    query: string
  }): Promise<KnowledgeResolution> {
    const empty = { documents: [], citations: [], skippedBases: [] }
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
    // Agent 的判断取其执行身份的全部岗位角色，不用与员工角色取交集后的权限（5.1）。
    if (!levels?.connection || !levels.localIdentity || !levels.employee || !levels.agent) {
      return { status: 'not_applicable', ...empty }
    }
    // 连接按管理端当前配置读取（地址与加密的 API Key），保存后下一次执行即生效。
    const client = await this.connection.client()
    if (!client) return { status: 'not_applicable', ...empty }

    const selected = await this.database<SelectedBaseRow[]>`
      select kb.id, kb.external_id as "externalId", kb.name,
             (kb.status = 'active' and kb.id in (${visibleBaseIdsSql(this.database, input.userId)})) as visible
        from session_knowledge_bases skb
        join external_knowledge_bases kb on kb.tenant_id = skb.tenant_id and kb.id = skb.knowledge_base_id
       where skb.tenant_id = ${tenantId} and skb.session_id = ${input.sessionId}
         and kb.connection_id = ${this.connectionId}
       order by skb.added_at, kb.id
    `
    if (!selected.length) return { status: 'not_selected', ...empty }
    const scope = selected.filter(base => base.visible)
    // Manifest 最多记 20 个名称；会话所选知识库没有数量上限，超出的不再逐一提示。
    const skippedBases = selected.filter(base => !base.visible)
      .map(base => base.name.trim()).filter(Boolean).slice(0, maxSkippedBases)
    if (!scope.length) return { status: 'skipped', documents: [], citations: [], skippedBases }

    try {
      const documents = await this.retrieve(client, input.query, scope)
      await this.recordSuccess()
      return { status: 'ok', ...documents, skippedBases }
    } catch (error) {
      if (!(error instanceof WeKnoraUnavailableError || error instanceof WeKnoraRequestError)) throw error
      const failureReason = error instanceof WeKnoraUnavailableError ? error.reason : 'protocol'
      await this.recordFailure(failureReason)
      return { status: 'unavailable', documents: [], citations: [], skippedBases, failureReason }
    }
  }

  async addCitationFooter(attemptId: string, answer: string): Promise<string> {
    const [attempt] = await this.database<{ status: string | null; skipped: string[] | null }[]>`
      select manifest->>'knowledge_status' as status, manifest->'knowledge_skipped_bases' as skipped
        from run_attempts where tenant_id = ${tenantId} and id = ${attemptId}
    `
    const citations = await this.database<{ title: string; updatedAt: Date }[]>`
      select title, document_updated_at as "updatedAt"
        from run_knowledge_citations
       where tenant_id = ${tenantId} and attempt_id = ${attemptId}
       order by ordinal
    `
    const sections: string[] = []
    if (citations.length) {
      sections.push(['参考来源', ...citations.map((row, index) =>
        `- 【${index + 1}】${row.title}（更新于 ${formatDate(row.updatedAt)}）`)].join('\n'))
    }
    for (const name of attempt?.skipped ?? []) sections.push(`知识库“${name}”你已无权查看，本次未使用。`)
    if (attempt?.status === 'unavailable') sections.push('企业知识库暂不可用，本次回答未引用企业知识。')
    return sections.length ? `${answer.trim()}\n\n${sections.join('\n\n')}` : answer
  }

  private async retrieve(client: WeKnoraClient, query: string, scope: SelectedBaseRow[]): Promise<Omit<KnowledgeResolution, 'status' | 'skippedBases'>> {
    const byExternalId = new Map(scope.map(base => [base.externalId, base]))
    const results = await client.search({
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
    if (!best.size) return { documents: [], citations: [] }
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
    return { documents, citations }
  }

  private async recordSuccess() {
    await this.database`
      update external_knowledge_connections set last_success_at = now()
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
