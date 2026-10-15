import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { RuntimeKnowledgeDocument } from '../runtime/runtime-types.ts'

const tenantId = 'tenant-dsh-work'
const maxContextDocuments = 3
const minimumRelevanceScore = 4
// Score weights per chunk (unchanged from the document-level keyword ranking):
// a document keyword contained in the query, a query term in the title, a query term in the chunk.
const keywordWeight = 8
const titleTermWeight = 4
const contentTermWeight = 1

interface KnowledgeChunkRow {
  id: string
  sourceId: string
  sourceName: string
  title: string
  version: string
  effectiveDate: Date
  contentChecksum: string
  dataScope: string
  synthetic: boolean
  excerpt: string
  ordinal: number
  lastOrdinal: number
  score: number
}

export interface ResolvedKnowledgeDocument extends RuntimeKnowledgeDocument {
  sourceId: string
  sourceName: string
  relevanceScore: number
  synthetic: boolean
}

/**
 * Retrieves governed knowledge for a Run. Documents are split into chunks with search terms
 * when written (migration 0081); a GIN index narrows candidates and the best chunk per
 * document becomes the excerpt. Role, workspace, Data Scope and status filters are applied
 * in the same query, before ranking, so unauthorized text never leaves the database.
 */
export class PostgresKnowledgeService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async resolveContext(input: {
    query: string
    userId: string
    workspaceId: string | null
    dataScopes: string[]
    roleIds?: string[]
  }): Promise<ResolvedKnowledgeDocument[]> {
    const dataScopes = [...new Set(input.dataScopes)]
    const query = input.query.trim()
    if (dataScopes.length === 0 || !query) return []
    const roleIds = input.roleIds?.length ? [...new Set(input.roleIds)] : ['__no_role__']
    const rows = await this.database<KnowledgeChunkRow[]>`
      with query as (select knowledge_search_terms(${query}) as terms, lower(${query}) as text),
      authorized as (
        select kd.id, kd.source_id, ks.name as source_name, kd.title, kd.version, kd.effective_date,
               kd.content_checksum, kd.data_scope, ks.synthetic, kd.keywords
          from knowledge_documents kd
          join knowledge_sources ks on ks.tenant_id = kd.tenant_id and ks.id = kd.source_id
         where kd.tenant_id = ${tenantId} and kd.status = 'published' and ks.status = 'active'
           and kd.data_scope in ${this.database(dataScopes)}
           and exists (
             select 1 from users u where u.tenant_id = kd.tenant_id
               and u.id = ${input.userId} and u.status = 'active'
           )
           and (
             jsonb_array_length(kd.allowed_role_ids) = 0
             or (
               ${input.roleIds !== undefined}
               and exists (
                 select 1 from roles r
                  where r.tenant_id = kd.tenant_id and r.id in ${this.database(roleIds)}
                    and kd.allowed_role_ids ? r.id
               )
             )
             or exists (
               select 1 from user_roles ur
                where ur.tenant_id = kd.tenant_id and ur.user_id = ${input.userId}
                  and kd.allowed_role_ids ? ur.role_id
                  and (ur.valid_until is null or ur.valid_until > now())
                  and ${input.roleIds === undefined}
             )
           )
           and (
             jsonb_array_length(kd.allowed_workspace_ids) = 0
             or (
               ${input.workspaceId}::text is not null
               and kd.allowed_workspace_ids ? ${input.workspaceId ?? ''}
               and exists (
                 select 1 from workspace_members wm
                  where wm.tenant_id = kd.tenant_id and wm.workspace_id = ${input.workspaceId ?? ''}
                    and wm.user_id = ${input.userId}
               )
             )
           )
      ),
      scored as (
        select d.*, kc.ordinal, kc.content as excerpt,
               (select max(c.ordinal) from knowledge_chunks c
                 where c.tenant_id = kc.tenant_id and c.document_id = kc.document_id) as last_ordinal,
               ${keywordWeight} * (select count(*) from jsonb_array_elements_text(d.keywords) k
                                    where k <> '' and position(lower(k) in q.text) > 0)
             + ${titleTermWeight} * cardinality(array(select unnest(q.terms) intersect select unnest(kc.title_terms)))
             + ${contentTermWeight} * cardinality(array(select unnest(q.terms) intersect select unnest(kc.terms)))
               as score
          from authorized d
          join knowledge_chunks kc on kc.tenant_id = ${tenantId} and kc.document_id = d.id
         cross join query q
         where kc.terms && q.terms or kc.title_terms && q.terms
      ),
      best as (
        select distinct on (id) * from scored order by id, score desc, ordinal
      )
      select id, source_id as "sourceId", source_name as "sourceName", title, version,
             effective_date as "effectiveDate", content_checksum as "contentChecksum",
             data_scope as "dataScope", synthetic, excerpt, ordinal,
             last_ordinal as "lastOrdinal", score::int as score
        from best
       where score >= ${minimumRelevanceScore}
       order by score desc, effective_date desc, id
       limit ${maxContextDocuments}
    `
    return rows.map(row => ({
      documentId: row.id,
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      title: row.title,
      version: row.version,
      effectiveDate: formatDate(row.effectiveDate),
      dataScope: row.dataScope,
      contentChecksum: row.contentChecksum,
      excerpt: `${row.ordinal > 0 ? '…' : ''}${row.excerpt}${row.ordinal < row.lastOrdinal ? '…' : ''}`,
      relevanceScore: row.score,
      synthetic: row.synthetic,
    }))
  }

  async addCitationFooter(attemptId: string, answer: string): Promise<string> {
    const rows = await this.database<{
      title: string
      version: string
      effectiveDate: Date
      synthetic: boolean
    }[]>`
      select kd.title, kd.version, kd.effective_date as "effectiveDate", ks.synthetic
        from run_knowledge_sources rks
        join knowledge_documents kd on kd.tenant_id = rks.tenant_id and kd.id = rks.document_id
        join knowledge_sources ks on ks.tenant_id = kd.tenant_id and ks.id = kd.source_id
       where rks.tenant_id = ${tenantId} and rks.attempt_id = ${attemptId}
       order by rks.relevance_score desc, kd.effective_date desc
    `
    if (!rows.length) return answer
    const citations = rows.map((row, index) =>
      `- 【${index + 1}】${row.title} v${row.version}（生效日期：${formatDate(row.effectiveDate)}${row.synthetic ? '；合成测试数据' : ''}）`,
    )
    return `${answer.trim()}\n\n参考来源\n${citations.join('\n')}`
  }
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10)
}
