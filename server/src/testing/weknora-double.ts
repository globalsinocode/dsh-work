import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 按 WeKnora v0.9.0 接口约定实现的测试替身（weknora-knowledge-plan 第 12 节）。只实现平台调用的
 * 检索、文档元数据与知识库管理接口，返回固定数据；仅用于测试，不是生产备用。
 */
export interface WeKnoraDoubleDocument {
  id: string
  knowledgeBaseId: string
  title: string
  fileName: string
  updatedAt: string
  /** 缺省同 updatedAt；列表按它倒序，与 WeKnora 一致。 */
  createdAt?: string
  /** 缺省为 completed。 */
  parseStatus?: string
}

export interface WeKnoraDoubleChunk {
  id: string
  knowledgeId: string
  content: string
  score: number
}

export interface WeKnoraDoubleRequest {
  method: string
  path: string
  apiKey: string | undefined
  body: unknown
}

export class WeKnoraDouble {
  readonly apiKey: string
  readonly requests: WeKnoraDoubleRequest[] = []
  documents: WeKnoraDoubleDocument[] = []
  chunks: WeKnoraDoubleChunk[] = []
  /** 下一批请求返回的 HTTP 状态（模拟 5xx、401、429 等）；为空时正常响应。 */
  failWith: number | null = null
  /** 只让文档元数据接口失败。 */
  failBatchWith: number | null = null
  /** 响应前等待的毫秒数（模拟超时）。 */
  delayMs = 0
  /** 检索结果中省略 knowledge_base_id（WeKnora 中该字段为 omitempty）。 */
  omitKnowledgeBaseId = false
  /** 忽略请求中的知识库范围（模拟返回范围之外的分段，验证平台再校验）。 */
  ignoreKnowledgeBaseScope = false
  /** 元数据接口不返回这些文档（模拟两次请求之间被删除）。 */
  hiddenMetadataIds: string[] = []
  /** 经 POST /knowledge-bases 创建、尚未删除的知识库及收到的建库请求体。 */
  readonly knowledgeBases = new Map<string, Record<string, unknown>>()
  private server: Server | null = null
  private nextKnowledgeBase = 1

  constructor(apiKey = 'test-weknora-key') {
    this.apiKey = apiKey
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request).then(result => {
        if (result.raw) {
          response.writeHead(result.status, { 'content-type': result.contentType ?? 'application/octet-stream' })
          response.end(result.raw)
          return
        }
        response.writeHead(result.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result.body))
      })
    })
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server!.close(() => resolve()))
    this.server = null
  }

  reset() {
    this.requests.length = 0
    this.documents = []
    this.chunks = []
    this.failWith = null
    this.failBatchWith = null
    this.delayMs = 0
    this.omitKnowledgeBaseId = false
    this.ignoreKnowledgeBaseScope = false
    this.hiddenMetadataIds = []
    this.knowledgeBases.clear()
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body?: unknown; raw?: Buffer; contentType?: string }> {
    const url = new URL(request.url ?? '/', 'http://double')
    const raw = await readBody(request)
    const json = String(request.headers['content-type'] ?? '').includes('application/json')
    const body = raw && json ? JSON.parse(raw) as Record<string, unknown> : undefined
    const apiKey = request.headers['x-api-key']
    this.requests.push({ method: request.method ?? 'GET', path: url.pathname, apiKey: Array.isArray(apiKey) ? apiKey[0] : apiKey, body })
    if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs))
    if (apiKey !== this.apiKey) return { status: 401, body: { success: false, error: { code: 1001, message: 'unauthorized' } } }
    if (this.failWith) return { status: this.failWith, body: { success: false, error: { code: 1007, message: 'failure' } } }

    if (request.method === 'POST' && url.pathname === '/api/v1/knowledge-search') {
      const bases = new Set((body?.knowledge_base_ids as string[] | undefined) ?? [])
      const documents = new Map(this.documents.filter(document => this.ignoreKnowledgeBaseScope || bases.has(document.knowledgeBaseId)).map(document => [document.id, document]))
      const data = this.chunks
        .filter(chunk => documents.has(chunk.knowledgeId))
        .sort((a, b) => b.score - a.score)
        .slice(0, Number(body?.match_count ?? 10))
        .map((chunk, index) => {
          const document = documents.get(chunk.knowledgeId)!
          return {
            id: chunk.id,
            content: chunk.content,
            knowledge_id: chunk.knowledgeId,
            chunk_index: index,
            knowledge_title: document.title,
            start_at: 0,
            end_at: chunk.content.length,
            seq: index,
            score: chunk.score,
            match_type: 0,
            sub_chunk_id: [],
            metadata: {},
            chunk_type: 'text',
            parent_chunk_id: '',
            image_info: '',
            knowledge_filename: document.fileName,
            knowledge_source: 'file',
            knowledge_channel: 'api',
            ...(this.omitKnowledgeBaseId ? {} : { knowledge_base_id: document.knowledgeBaseId }),
          }
        })
      return { status: 200, body: { success: true, data, meta: { rerank: { applied: false, outcome: 'disabled' } } } }
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/knowledge/batch') {
      if (this.failBatchWith) return { status: this.failBatchWith, body: { success: false, error: { code: 1007, message: 'failure' } } }
      const ids = new Set(url.searchParams.getAll('ids').flatMap(value => value.split(',')))
      const data = this.documents.filter(document => ids.has(document.id) && !this.hiddenMetadataIds.includes(document.id)).map(document => ({
        id: document.id,
        knowledge_base_id: document.knowledgeBaseId,
        title: document.title,
        file_name: document.fileName,
        parse_status: document.parseStatus ?? 'completed',
        updated_at: document.updatedAt,
      }))
      return { status: 200, body: { success: true, data } }
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/knowledge-bases') {
      if (typeof body?.name !== 'string' || !body.name) return { status: 400, body: { success: false, error: { code: 1010, message: 'name required' } } }
      const id = `kb-double-${this.nextKnowledgeBase++}`
      this.knowledgeBases.set(id, { ...body })
      return { status: 201, body: { success: true, data: { id, name: body.name, type: body.type ?? 'document', embedding_model_id: body.embedding_model_id ?? '' } } }
    }
    const ok = (data?: unknown) => ({ status: 200, body: { success: true, ...(data === undefined ? {} : { data }) } })
    const missing = { status: 404, body: { success: false, error: { code: 1003, message: 'not found' } } }
    const base = url.pathname.match(/^\/api\/v1\/knowledge-bases\/([^/]+)$/)
    if (request.method === 'GET' && url.pathname === '/api/v1/knowledge-bases') {
      const ids = new Set([...this.knowledgeBases.keys(), ...this.documents.map(document => document.knowledgeBaseId)])
      return { status: 200, body: { success: true, total: ids.size, page: 1, page_size: 1000, data: [...ids].map(id => {
        const documents = this.documents.filter(document => document.knowledgeBaseId === id)
        return {
          id, name: String(this.knowledgeBases.get(id)?.name ?? id), knowledge_count: documents.length,
          processing_count: documents.filter(document => (document.parseStatus ?? 'completed') === 'processing').length,
          updated_at: documents.map(document => document.updatedAt).sort().at(-1) ?? '2026-11-01T00:00:00Z',
        }
      }) } }
    }
    if (request.method === 'DELETE' && base) {
      this.knowledgeBases.delete(decodeURIComponent(base[1]!))
      return { status: 200, body: { success: true, message: 'Knowledge base deleted successfully' } }
    }
    if (request.method === 'PATCH' && base) {
      const id = decodeURIComponent(base[1]!)
      this.knowledgeBases.set(id, { ...this.knowledgeBases.get(id), ...body })
      return ok({ id, ...body })
    }
    const list = url.pathname.match(/^\/api\/v1\/knowledge-bases\/([^/]+)\/knowledge$/)
    if (request.method === 'GET' && list) {
      const keyword = url.searchParams.get('keyword') ?? ''
      const status = url.searchParams.get('parse_status')
      const items = this.documents
        .filter(document => document.knowledgeBaseId === decodeURIComponent(list[1]!))
        .filter(document => !keyword || document.title.includes(keyword) || document.fileName.includes(keyword))
        .filter(document => !status || (document.parseStatus ?? 'completed') === status)
        .sort((left, right) => (right.createdAt ?? right.updatedAt).localeCompare(left.createdAt ?? left.updatedAt))
      // 与 WeKnora v0.9.0 一致：page_size 超过 1000 返回 400，否则按页截取。
      const page = Number(url.searchParams.get('page') ?? 1)
      const pageSize = Number(url.searchParams.get('page_size') ?? 20)
      if (pageSize > 1000) return { status: 400, body: { success: false, error: { code: 1000, message: 'PageSize max' } } }
      const data = items.slice((page - 1) * pageSize, page * pageSize).map(toKnowledge)
      return { status: 200, body: { success: true, data, total: items.length, page, page_size: pageSize } }
    }
    const upload = url.pathname.match(/^\/api\/v1\/knowledge-bases\/([^/]+)\/knowledge\/file$/)
    if (request.method === 'POST' && upload) {
      const fileName = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'upload.bin'
      const knowledgeBaseId = decodeURIComponent(upload[1]!)
      const existing = this.documents.find(document => document.knowledgeBaseId === knowledgeBaseId && document.fileName === fileName)
      if (existing) return { status: 409, body: { success: false, data: toKnowledge(existing) } }
      const document = { id: `doc-double-${this.nextKnowledgeBase++}`, knowledgeBaseId, title: fileName.replace(/\.[^.]+$/, ''), fileName, updatedAt: new Date().toISOString(), parseStatus: 'processing' }
      this.documents.push(document)
      return ok(toKnowledge(document))
    }
    const knowledge = url.pathname.match(/^\/api\/v1\/knowledge\/([^/]+)(\/(reparse|download|preview))?$/)
    if (knowledge) {
      const document = this.documents.find(item => item.id === decodeURIComponent(knowledge[1]!))
      if (!document) return missing
      const action = knowledge[3]
      if (request.method === 'GET' && !action) return ok(toKnowledge(document))
      if (request.method === 'PUT' && !action) { document.title = String(body?.title ?? document.title); return ok(toKnowledge(document)) }
      if (request.method === 'DELETE' && !action) { this.documents = this.documents.filter(item => item !== document); return ok({ task_id: 'task-delete' }) }
      if (request.method === 'POST' && action === 'reparse') { document.parseStatus = 'processing'; return ok(toKnowledge(document)) }
      if (request.method === 'GET' && (action === 'download' || action === 'preview')) {
        return { status: 200, raw: Buffer.from(`${action}:${document.title}`), contentType: action === 'preview' ? 'text/html' : 'application/octet-stream' }
      }
    }
    return { status: 404, body: { success: false, error: { code: 1003, message: 'not found' } } }
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function toKnowledge(document: WeKnoraDoubleDocument) {
  return {
    id: document.id,
    knowledge_base_id: document.knowledgeBaseId,
    title: document.title,
    file_name: document.fileName,
    file_size: 1024,
    parse_status: document.parseStatus ?? 'completed',
    error_message: document.parseStatus === 'failed' ? 'parse failed' : '',
    created_at: document.createdAt ?? document.updatedAt,
    updated_at: document.updatedAt,
  }
}
