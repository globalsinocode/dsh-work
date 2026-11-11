/**
 * WeKnora v0.9.0 HTTP 客户端（weknora-knowledge-plan 第 4 节）。只调用检索、文档元数据与知识库
 * 管理接口；WeKnora 的问答、Agent 与 MCP 一律不用（WK5）。API Key 只在这里进入请求头，
 * 错误信息不带 Key、请求正文或响应正文。
 */

/** not_configured：连接已停用、未配置或 API Key 读不出（优化方案 O2），不是 WeKnora 自身故障。 */
export type WeKnoraFailureReason = 'timeout' | 'network' | 'auth' | 'rate_limited' | 'server' | 'protocol' | 'not_configured'

export class WeKnoraUnavailableError extends Error {
  readonly reason: WeKnoraFailureReason

  constructor(reason: WeKnoraFailureReason, message: string) {
    super(message)
    this.name = 'WeKnoraUnavailableError'
    this.reason = reason
  }
}

/** Request-level rejections (400/404/409) that are not an outage. */
export class WeKnoraRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'WeKnoraRequestError'
    this.status = status
  }
}

export interface WeKnoraSearchResult {
  id: string
  content: string
  knowledge_id: string
  knowledge_base_id?: string
  knowledge_title: string
  knowledge_filename: string
  score: number
}

export interface WeKnoraSearchResponse {
  results: WeKnoraSearchResult[]
  /**
   * 重排序结果（响应 `meta.rerank.outcome`，WeKnora v0.9.0 `types.RerankOutcome`）：ok、threshold_degraded、
   * fallback_top1、all_below_threshold、model_error、model_unavailable、no_model、disabled、no_candidates。
   * 缺失或格式不符时为 null。
   */
  rerankOutcome: string | null
}

export interface WeKnoraKnowledge {
  id: string
  knowledge_base_id: string
  title: string
  file_name: string
  updated_at: string
  parse_status?: string
}

export interface WeKnoraKnowledgeBase {
  id: string
  name: string
}

export interface WeKnoraKnowledgeBaseStats {
  id: string
  knowledgeCount: number
  processingCount: number
  updatedAt: string | null
  /** WeKnora 中为该知识库配置的摘要模型；平台建库不设置，非空表示有人在 WeKnora 中修改过（优化方案 O7）。 */
  summaryModelId: string | null
}

export interface WeKnoraDocument {
  id: string
  knowledgeBaseId: string
  title: string
  fileName: string
  fileSize: number | null
  /** pending、processing、finalizing、completed、failed、deleting、cancelled */
  parseStatus: string
  errorMessage: string | null
  /** WeKnora 文档列表按创建时间倒序。 */
  createdAt: string | null
  updatedAt: string | null
}

export interface WeKnoraClientConfig {
  baseUrl: string
  apiKey: string
  /** 检索超时（4.3）：5 秒，不重试。 */
  timeoutMs?: number
  fetch?: typeof fetch
}

export const weknoraSearchTimeoutMs = 5000
/** 员工端管理操作不在执行链路上，可以多等一会儿；上传与下载按文件大小再放宽。 */
const managementTimeoutMs = 15000
const uploadTimeoutMs = 120000

/**
 * WeKnora 服务根地址：去掉末尾斜杠与 `/api/v1`（WeKnora 文档给出的地址常带这一段，客户端自己拼接）。
 * 按路径处理，大小写不敏感，重复出现也一并去掉；无法解析的地址按字符串处理。
 */
export function weknoraServiceRoot(value: string): string {
  const strip = (path: string) => path.replace(/(\/api\/v1)+\/*$/i, '').replace(/\/+$/, '')
  try {
    const url = new URL(value.trim())
    url.pathname = strip(url.pathname.replace(/\/+$/, '')) || '/'
    return url.toString().replace(/\/+$/, '')
  } catch {
    return strip(value.trim().replace(/\/+$/, ''))
  }
}

export class WeKnoraClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(config: WeKnoraClientConfig) {
    this.baseUrl = weknoraServiceRoot(config.baseUrl)
    this.apiKey = config.apiKey
    this.timeoutMs = config.timeoutMs ?? weknoraSearchTimeoutMs
    this.fetchImpl = config.fetch ?? fetch
  }

  async search(input: { query: string; knowledgeBaseIds: string[]; matchCount: number }): Promise<WeKnoraSearchResponse> {
    // rerank 不传：沿用 WeKnora 工作空间默认的重排序配置（4.3）。
    const body = await this.request('POST', '/api/v1/knowledge-search', {
      query: input.query,
      knowledge_base_ids: input.knowledgeBaseIds,
      match_count: input.matchCount,
    })
    const data = arrayData(body)
    const outcome = ((body as { meta?: { rerank?: { outcome?: unknown } } }).meta?.rerank?.outcome)
    const rerankOutcome = typeof outcome === 'string' && /^[a-z0-9_]{1,40}$/.test(outcome) ? outcome : null
    const results = data.map(item => {
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.content !== 'string' || typeof row.knowledge_id !== 'string'
        || typeof row.score !== 'number') {
        throw new WeKnoraUnavailableError('protocol', 'WeKnora 检索结果缺少必要字段')
      }
      return {
        id: row.id,
        content: row.content,
        knowledge_id: row.knowledge_id,
        ...(typeof row.knowledge_base_id === 'string' ? { knowledge_base_id: row.knowledge_base_id } : {}),
        knowledge_title: typeof row.knowledge_title === 'string' ? row.knowledge_title : '',
        knowledge_filename: typeof row.knowledge_filename === 'string' ? row.knowledge_filename : '',
        score: row.score,
      }
    })
    return { results, rerankOutcome }
  }

  async knowledgeBatch(ids: string[]): Promise<WeKnoraKnowledge[]> {
    if (!ids.length) return []
    const query = new URLSearchParams()
    for (const id of ids) query.append('ids', id)
    const body = await this.request('GET', `/api/v1/knowledge/batch?${query.toString()}`)
    return arrayData(body).map(item => {
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.knowledge_base_id !== 'string' || typeof row.updated_at !== 'string'
        || Number.isNaN(Date.parse(row.updated_at))) {
        throw new WeKnoraUnavailableError('protocol', 'WeKnora 文档元数据缺少必要字段')
      }
      return {
        id: row.id,
        knowledge_base_id: row.knowledge_base_id,
        title: typeof row.title === 'string' ? row.title : '',
        file_name: typeof row.file_name === 'string' ? row.file_name : '',
        updated_at: row.updated_at,
        ...(typeof row.parse_status === 'string' ? { parse_status: row.parse_status } : {}),
      }
    })
  }

  /** 新建文档型知识库并带上统一嵌入模型（4.6）。 */
  async createKnowledgeBase(input: { name: string; description: string; embeddingModelId: string }): Promise<WeKnoraKnowledgeBase> {
    const body = await this.request('POST', '/api/v1/knowledge-bases', {
      name: input.name,
      description: input.description,
      type: 'document',
      embedding_model_id: input.embeddingModelId,
    }, managementTimeoutMs)
    const data = (body as { data?: Record<string, unknown> }).data
    if (!data || typeof data.id !== 'string') throw new WeKnoraUnavailableError('protocol', 'WeKnora 新建知识库响应缺少 ID')
    return { id: data.id, name: typeof data.name === 'string' ? data.name : input.name }
  }

  async deleteKnowledgeBase(id: string): Promise<void> {
    await this.request('DELETE', `/api/v1/knowledge-bases/${encodeURIComponent(id)}`, undefined, managementTimeoutMs)
  }

  /** 平台创建的知识库在 WeKnora 中的统计（文档数、解析中数量、更新时间），一次读取全部。 */
  async listKnowledgeBases(): Promise<WeKnoraKnowledgeBaseStats[]> {
    const body = await this.request('GET', '/api/v1/knowledge-bases?page=1&page_size=1000', undefined, managementTimeoutMs)
    return arrayData(body).flatMap(item => {
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string') return []
      return [{
        id: row.id,
        knowledgeCount: typeof row.knowledge_count === 'number' ? row.knowledge_count : 0,
        processingCount: typeof row.processing_count === 'number' ? row.processing_count : 0,
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
        summaryModelId: typeof row.summary_model_id === 'string' && row.summary_model_id.trim() ? row.summary_model_id : null,
      }]
    })
  }

  async updateKnowledgeBase(id: string, input: { name: string; description: string }): Promise<void> {
    await this.request('PATCH', `/api/v1/knowledge-bases/${encodeURIComponent(id)}`, input, managementTimeoutMs)
  }

  async listDocuments(knowledgeBaseId: string, input: { keyword?: string; parseStatus?: string; page: number; pageSize: number }) {
    const query = new URLSearchParams({ page: String(input.page), page_size: String(input.pageSize) })
    if (input.keyword) query.set('keyword', input.keyword)
    if (input.parseStatus) query.set('parse_status', input.parseStatus)
    const body = await this.request('GET', `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge?${query.toString()}`, undefined, managementTimeoutMs)
    const total = (body as { total?: unknown }).total
    return {
      items: arrayData(body).map(toDocument),
      total: typeof total === 'number' ? total : 0,
    }
  }

  /** 上传文件（WK16：只支持文件，不调用网址导入）。重复文件由 WeKnora 返回 409。 */
  async uploadDocument(knowledgeBaseId: string, input: { fileName: string; mimeType: string; bytes: Buffer }): Promise<WeKnoraDocument> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.fileName)
    const body = await this.request('POST', `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/file`, form, uploadTimeoutMs)
    return toDocument((body as { data?: unknown }).data)
  }

  async updateDocumentTitle(id: string, title: string): Promise<void> {
    await this.request('PUT', `/api/v1/knowledge/${encodeURIComponent(id)}`, { title }, managementTimeoutMs)
  }

  async reparseDocument(id: string): Promise<void> {
    await this.request('POST', `/api/v1/knowledge/${encodeURIComponent(id)}/reparse`, {}, managementTimeoutMs)
  }

  async deleteDocument(id: string): Promise<void> {
    await this.request('DELETE', `/api/v1/knowledge/${encodeURIComponent(id)}`, undefined, managementTimeoutMs)
  }

  async downloadDocument(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    return this.binary(`/api/v1/knowledge/${encodeURIComponent(id)}/download`)
  }

  async previewDocument(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    return this.binary(`/api/v1/knowledge/${encodeURIComponent(id)}/preview`)
  }

  private async binary(path: string): Promise<{ bytes: Buffer; mimeType: string }> {
    return this.send('GET', path, undefined, uploadTimeoutMs, async response => ({
      bytes: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    }))
  }

  private async request(method: string, path: string, payload?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    return this.send(method, path, payload, timeoutMs, async response => {
      const body: unknown = await response.json().catch(() => {
        throw new WeKnoraUnavailableError('protocol', 'WeKnora 响应不是 JSON')
      })
      if (!body || typeof body !== 'object' || (body as { success?: unknown }).success === false) {
        throw new WeKnoraUnavailableError('protocol', 'WeKnora 响应格式不符合约定')
      }
      return body
    })
  }

  private async send<T>(method: string, path: string, payload: unknown, timeoutMs: number, read: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    // 超时覆盖连接与读取响应正文，避免慢响应拖住执行。
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const form = payload instanceof FormData
    try {
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'X-API-Key': this.apiKey,
            accept: 'application/json',
            ...(payload === undefined || form ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { body: form ? payload : JSON.stringify(payload) }),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw new WeKnoraUnavailableError('timeout', 'WeKnora 请求超时')
        throw new WeKnoraUnavailableError('network', `WeKnora 连接失败：${error instanceof Error ? error.name : 'unknown'}`)
      }
      if (response.status === 401 || response.status === 403) throw new WeKnoraUnavailableError('auth', `WeKnora 认证失败（${response.status}）`)
      if (response.status === 429) throw new WeKnoraUnavailableError('rate_limited', 'WeKnora 限流（429）')
      if (response.status >= 500) throw new WeKnoraUnavailableError('server', `WeKnora 服务错误（${response.status}）`)
      if (response.status >= 400) throw new WeKnoraRequestError(response.status, `WeKnora 拒绝请求（${response.status}）`)
      try {
        return await read(response)
      } catch (error) {
        if (controller.signal.aborted) throw new WeKnoraUnavailableError('timeout', 'WeKnora 请求超时')
        throw error
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

function toDocument(value: unknown): WeKnoraDocument {
  const row = (value ?? {}) as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.knowledge_base_id !== 'string') {
    throw new WeKnoraUnavailableError('protocol', 'WeKnora 文档信息缺少必要字段')
  }
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    title: typeof row.title === 'string' ? row.title : '',
    fileName: typeof row.file_name === 'string' ? row.file_name : '',
    fileSize: typeof row.file_size === 'number' ? row.file_size : null,
    parseStatus: typeof row.parse_status === 'string' ? row.parse_status : 'pending',
    errorMessage: typeof row.error_message === 'string' && row.error_message ? row.error_message : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  }
}

function arrayData(body: unknown): unknown[] {
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) throw new WeKnoraUnavailableError('protocol', 'WeKnora 响应缺少 data 列表')
  return data
}
