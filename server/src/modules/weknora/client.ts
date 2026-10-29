import { RequestError } from '../../domain/request-errors.ts'
import type { WeknoraConfig } from './config.ts'

export class WeknoraAccountNotProvisionedError extends Error {
  readonly name = 'WeknoraAccountNotProvisionedError'
}

export class WeknoraAccountDisabledError extends Error {
  readonly name = 'WeknoraAccountDisabledError'
}

export interface WeknoraSession {
  userId: string
  tenantId: number
  accessToken: string
  expiresIn: number
}

export interface WeknoraKnowledgeBaseSummary {
  id: string
  name: string
  description?: string
  documentCount?: number
  updatedAt?: string
}

export interface WeknoraDocumentSummary {
  id: string
  title: string
  updatedAt?: string
}

export interface WeknoraSearchHit {
  documentId: string
  title: string
  snippet: string
}

export interface WeknoraDirectoryLookup {
  subject?: string
  aiHubUserId?: string
  userId?: string
}

type FetchFn = typeof fetch

export class WeknoraClient {
  private readonly config: WeknoraConfig
  private readonly fetchImpl: FetchFn

  constructor(config: WeknoraConfig, fetchImpl: FetchFn = fetch) {
    this.config = config
    this.fetchImpl = fetchImpl
  }

  async exchangeSession(lookup: WeknoraDirectoryLookup): Promise<WeknoraSession> {
    const body: Record<string, string> = {}
    if (lookup.aiHubUserId) body.ai_hub_user_id = lookup.aiHubUserId
    if (lookup.subject) body.subject = lookup.subject
    if (lookup.userId) body.user_id = lookup.userId
    return this.postSession(body)
  }

  async redeemBindCode(bindCode: string): Promise<{ userId: string }> {
    const response = await this.integrationFetch('/api/v1/integrations/dsh-work/bind-codes/exchange', {
      method: 'POST',
      body: JSON.stringify({ bind_code: bindCode }),
    })
    if (response.status === 400) {
      throw new RequestError(400, 'weknora_bind_invalid', '连接未完成或已过期，请重试')
    }
    if (!response.ok) {
      throw await this.integrationFailure(response)
    }
    const payload = await response.json() as { user_id?: string }
    if (!payload.user_id) throw new RequestError(503, 'weknora_unavailable', '知识库暂时无法访问')
    return { userId: payload.user_id }
  }

  async startBind(redirectUri: string, state: string): Promise<{ url: string }> {
    const response = await this.integrationFetch('/api/v1/integrations/dsh-work/bind-codes', {
      method: 'POST',
      body: JSON.stringify({ redirect_uri: redirectUri, state }),
    })
    if (response.status === 400) {
      throw new RequestError(422, 'invalid_request', '知识库连接地址无效')
    }
    if (!response.ok) throw await this.integrationFailure(response)
    const payload = await response.json() as { url?: string }
    if (!payload.url) throw new RequestError(503, 'weknora_unavailable', '知识库暂时无法访问')
    return { url: payload.url }
  }

  async listKnowledgeBases(accessToken: string): Promise<WeknoraKnowledgeBaseSummary[]> {
    const response = await this.userFetch('/api/v1/knowledge-bases', accessToken)
    if (!response.ok) throw await this.userFailure(response)
    const payload = await parseWeKnoraData(response)
    const rows = Array.isArray(payload) ? payload : []
    return rows.map(mapKnowledgeBase).filter((item): item is WeknoraKnowledgeBaseSummary => item !== null)
  }

  async getKnowledgeBase(accessToken: string, kbId: string): Promise<WeknoraKnowledgeBaseSummary> {
    const response = await this.userFetch(`/api/v1/knowledge-bases/${encodeURIComponent(kbId)}`, accessToken)
    if (response.status === 404) throw new RequestError(404, 'resource_not_found', '无法打开该知识库')
    if (!response.ok) throw await this.userFailure(response)
    const payload = await parseWeKnoraData(response)
    const mapped = mapKnowledgeBase(payload)
    if (!mapped) throw new RequestError(404, 'resource_not_found', '无法打开该知识库')
    return mapped
  }

  async listDocuments(accessToken: string, kbId: string): Promise<WeknoraDocumentSummary[]> {
    const response = await this.userFetch(
      `/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/knowledge`,
      accessToken,
    )
    if (response.status === 404) throw new RequestError(404, 'resource_not_found', '无法打开该知识库')
    if (!response.ok) throw await this.userFailure(response)
    const payload = await parseWeKnoraData(response)
    const rows = Array.isArray(payload) ? payload : (payload && typeof payload === 'object' && 'list' in payload
      ? (payload as { list: unknown }).list
      : [])
    const list = Array.isArray(rows) ? rows : []
    return list.map(mapDocument).filter((item): item is WeknoraDocumentSummary => item !== null)
  }

  async searchKnowledgeBase(accessToken: string, kbId: string, query: string): Promise<WeknoraSearchHit[]> {
    const response = await this.userFetch(
      `/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/hybrid-search`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ query, top_k: 20 }),
      },
    )
    if (response.status === 404) throw new RequestError(404, 'resource_not_found', '无法打开该知识库')
    if (!response.ok) throw await this.userFailure(response)
    const payload = await parseWeKnoraData(response)
    const rows = Array.isArray(payload) ? payload : []
    return rows.map(mapSearchHit).filter((item): item is WeknoraSearchHit => item !== null)
  }

  async fetchDocumentContent(accessToken: string, documentId: string): Promise<Response> {
    const response = await this.userFetch(
      `/api/v1/knowledge/${encodeURIComponent(documentId)}/preview`,
      accessToken,
    )
    if (response.status === 404) throw new RequestError(404, 'resource_not_found', '无法预览该文档')
    if (!response.ok) throw await this.userFailure(response)
    return response
  }

  private async postSession(body: Record<string, string>): Promise<WeknoraSession> {
    const response = await this.integrationFetch('/api/v1/integrations/dsh-work/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (response.status === 404) {
      const errorBody = await readErrorField(response)
      if (errorBody === 'account_not_provisioned') throw new WeknoraAccountNotProvisionedError()
      throw new RequestError(404, 'resource_not_found', '无法打开该知识库')
    }
    if (response.status === 403) {
      const errorBody = await readErrorField(response)
      if (errorBody === 'account_disabled') throw new WeknoraAccountDisabledError()
    }
    if (!response.ok) throw await this.integrationFailure(response)
    const payload = await response.json() as {
      user_id?: string
      tenant_id?: number
      access_token?: string
      expires_in?: number
    }
    if (!payload.user_id || !payload.access_token) {
      throw new RequestError(503, 'weknora_unavailable', '知识库暂时无法访问')
    }
    return {
      userId: payload.user_id,
      tenantId: payload.tenant_id ?? 0,
      accessToken: payload.access_token,
      expiresIn: Math.min(payload.expires_in ?? 3600, 3600),
    }
  }

  private integrationFetch(path: string, init: RequestInit) {
    return this.fetchImpl(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.integrationSecret}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  }

  private userFetch(path: string, accessToken: string, init: RequestInit = {}) {
    return this.fetchImpl(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
  }

  private async integrationFailure(response: Response) {
    if (response.status >= 500 || response.status === 429) {
      return new RequestError(503, 'weknora_unavailable', '知识库暂时无法访问')
    }
    return new RequestError(503, 'weknora_unavailable', '知识库暂时无法访问')
  }

  private async userFailure(response: Response) {
    if (response.status === 401) {
      return new RequestError(503, 'weknora_unavailable', '知识库暂时无法访问')
    }
    if (response.status >= 500) {
      return new RequestError(503, 'weknora_unavailable', '知识库暂时无法访问')
    }
    return new RequestError(503, 'weknora_unavailable', '知识库暂时无法访问')
  }
}

async function parseWeKnoraData(response: Response): Promise<unknown> {
  const payload = await response.json() as { data?: unknown; success?: boolean }
  if ('data' in payload) return payload.data
  return payload
}

async function readErrorField(response: Response): Promise<string | null> {
  try {
    const payload = await response.json() as { error?: string }
    return typeof payload.error === 'string' ? payload.error : null
  } catch {
    return null
  }
}

function mapKnowledgeBase(row: unknown): WeknoraKnowledgeBaseSummary | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const id = stringField(record, 'id')
  const name = stringField(record, 'name') ?? stringField(record, 'title')
  if (!id || !name) return null
  const summary: WeknoraKnowledgeBaseSummary = { id, name }
  const description = stringField(record, 'description')
  if (description) summary.description = description
  const documentCount = numberField(record, 'knowledge_count') ?? numberField(record, 'document_count')
  if (documentCount !== undefined) summary.documentCount = documentCount
  const updatedAt = stringField(record, 'updated_at') ?? stringField(record, 'updatedAt')
  if (updatedAt) summary.updatedAt = updatedAt
  return summary
}

function mapDocument(row: unknown): WeknoraDocumentSummary | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const id = stringField(record, 'id')
  const title = stringField(record, 'title') ?? stringField(record, 'name')
  if (!id || !title) return null
  const summary: WeknoraDocumentSummary = { id, title }
  const updatedAt = stringField(record, 'updated_at') ?? stringField(record, 'updatedAt')
  if (updatedAt) summary.updatedAt = updatedAt
  return summary
}

function mapSearchHit(row: unknown): WeknoraSearchHit | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const documentId = stringField(record, 'knowledge_id')
    ?? stringField(record, 'document_id')
    ?? stringField(record, 'id')
  const title = stringField(record, 'title') ?? stringField(record, 'name') ?? '未命名文档'
  const snippet = stringField(record, 'content') ?? stringField(record, 'snippet') ?? ''
  if (!documentId) return null
  return { documentId, title, snippet }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
