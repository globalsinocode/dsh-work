import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { PostgresEncryptedCredentialStore } from '../tool/postgres-encrypted-credential-store.ts'
import { invalidRequest } from '../../domain/request-errors.ts'
import { WeKnoraClient, weknoraServiceRoot } from './weknora-client.ts'

const tenantId = 'tenant-dsh-work'
export const knowledgeConnectionId = 'knowledge-connection-weknora'
export const knowledgeCredentialRefId = 'credential-weknora-api-key'

/** 部署配置（WEKNORA_*）提供的初始连接；管理员在管理端保存 API Key 后不再使用其中的 Key。 */
export interface KnowledgeConnectionBootstrap {
  baseUrl: string
  apiKey: string
  embeddingModelId?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

interface ConnectionRow {
  baseUrl: string
  credentialRef: string | null
  embeddingModelId: string | null
  status: string
  updatedAt: Date
}

/**
 * 企业知识库连接（weknora-knowledge-plan 第 9 节，WK-S3）：管理端保存的地址、加密 API Key 与统一嵌入模型
 * 是唯一来源，检索链路与员工端每次调用前读取，保存后立即生效。连接停用、未配置或凭据不可读时没有客户端。
 */
export class PostgresKnowledgeConnection {
  readonly connectionId = knowledgeConnectionId
  private readonly database: DatabaseClient
  private readonly credentials: PostgresEncryptedCredentialStore | undefined
  private readonly bootstrap: KnowledgeConnectionBootstrap | undefined
  private cached: { key: string; client: WeKnoraClient } | null = null

  constructor(database: DatabaseClient, options: { credentials?: PostgresEncryptedCredentialStore; bootstrap?: KnowledgeConnectionBootstrap } = {}) {
    this.database = database
    this.credentials = options.credentials
    this.bootstrap = options.bootstrap
  }

  /**
   * 启动时按部署配置写入连接：还没有连接时新建。Key 仍来自部署配置（管理员没有保存过 Key）时，地址始终跟随
   * 部署配置，保证部署配置的 Key 只发往部署配置的地址；嵌入模型只在管理员从未保存过时同步。
   * 管理员保存过 Key 后，部署配置不再覆盖，重启不会撤销管理端的修改。
   */
  async ensureBootstrap(): Promise<void> {
    if (!this.bootstrap) return
    let baseUrl: string
    try {
      baseUrl = normalizeBaseUrl(this.bootstrap.baseUrl)
    } catch {
      console.warn('WEKNORA_BASE_URL is invalid; knowledge connection bootstrap skipped')
      return
    }
    const hint = this.bootstrap.apiKey.length > 8 ? this.bootstrap.apiKey.slice(-4) : null
    const existing = await this.row()
    await this.database`
      insert into external_knowledge_connections (id, tenant_id, base_url, credential_hint, embedding_model_id, updated_by)
      values (${this.connectionId}, ${tenantId}, ${baseUrl}, ${hint}, ${this.bootstrap.embeddingModelId ?? null}, 'deployment-config')
      on conflict (tenant_id) do update
         set base_url = excluded.base_url,
             credential_hint = excluded.credential_hint,
             embedding_model_id = case when external_knowledge_connections.updated_by = 'deployment-config'
                                       then excluded.embedding_model_id else external_knowledge_connections.embedding_model_id end,
             updated_at = now()
       where external_knowledge_connections.credential_ref is null
         and (external_knowledge_connections.base_url is distinct from excluded.base_url
              or external_knowledge_connections.credential_hint is distinct from excluded.credential_hint
              or (external_knowledge_connections.updated_by = 'deployment-config'
                  and external_knowledge_connections.embedding_model_id is distinct from excluded.embedding_model_id))
    `
    // 优化方案 O9：部署配置的地址变化与管理端更换地址一样，原有知识库属于原实例，标为“原连接已更换”。
    if (existing && !existing.credentialRef && !sameBaseUrl(existing.baseUrl, baseUrl)) {
      const moved = await this.database`
        update external_knowledge_bases set status = 'unavailable', updated_by = 'deployment-config', updated_at = now()
         where tenant_id = ${tenantId} and connection_id = ${this.connectionId} and status = 'active'
      `
      if (moved.count) console.warn(`WEKNORA_BASE_URL changed; ${moved.count} knowledge bases marked unavailable`)
    }
  }

  /** 有效连接的客户端；未配置、已停用或凭据不可读时为 null。按连接版本缓存，保存前不重复解密 Key。 */
  async client(): Promise<WeKnoraClient | null> {
    const row = await this.row()
    if (!row || row.status !== 'active') return null
    const key = `${row.baseUrl}|${row.credentialRef ?? 'deployment'}|${row.updatedAt.toISOString()}`
    if (this.cached?.key === key) return this.cached.client
    const apiKey = await this.apiKey(row)
    if (!apiKey) return null
    this.cached = {
      key,
      client: new WeKnoraClient({ baseUrl: row.baseUrl, apiKey, timeoutMs: this.bootstrap?.timeoutMs, fetch: this.bootstrap?.fetch }),
    }
    return this.cached.client
  }

  async embeddingModelId(): Promise<string | undefined> {
    return (await this.row())?.embeddingModelId ?? undefined
  }

  /**
   * 用给定的地址与 Key（缺省为已保存的）建立一次性客户端，供“测试连接”使用。已保存的 Key 只发往已保存的地址：
   * 测试其他地址必须同时填写 Key，避免把只写不读的 Key 发到输错或不受信任的主机。
   */
  async probeClient(input: { baseUrl?: string; apiKey?: string }): Promise<{ client: WeKnoraClient } | { reason: 'not_configured' | 'api_key_required' }> {
    const row = await this.row()
    const baseUrl = input.baseUrl ?? row?.baseUrl
    if (!baseUrl) return { reason: 'not_configured' }
    if (!input.apiKey && row && !sameBaseUrl(baseUrl, row.baseUrl)) return { reason: 'api_key_required' }
    const apiKey = input.apiKey ?? (row ? await this.apiKey(row) : undefined)
    if (!apiKey) return { reason: 'not_configured' }
    return { client: new WeKnoraClient({ baseUrl, apiKey, timeoutMs: this.bootstrap?.timeoutMs, fetch: this.bootstrap?.fetch }) }
  }

  /** 已保存的地址（规范化后，规则调整前保存的旧格式与现行格式可直接比较）；用于判断测试的是否是已保存的连接。 */
  async savedBaseUrl(): Promise<string | undefined> {
    const saved = (await this.row())?.baseUrl
    return saved === undefined ? undefined : comparableBaseUrl(saved)
  }

  private async row(): Promise<ConnectionRow | undefined> {
    const [row] = await this.database<ConnectionRow[]>`
      select base_url as "baseUrl", credential_ref as "credentialRef", embedding_model_id as "embeddingModelId",
             status, updated_at as "updatedAt"
        from external_knowledge_connections where tenant_id = ${tenantId} and id = ${this.connectionId}
    `
    return row
  }

  private async apiKey(row: ConnectionRow): Promise<string | undefined> {
    if (!row.credentialRef) return this.bootstrap?.apiKey
    if (!this.credentials) return undefined
    try {
      return await this.credentials.readBearerToken(tenantId, row.credentialRef)
    } catch {
      // 凭据缺失或无法解密时按未配置处理，不把错误细节带到检索链路。
      console.warn('WeKnora API Key cannot be read from the credential store')
      return undefined
    }
  }
}

/** 规范化 WeKnora 地址：只允许 http/https，不能带账号或密码，去掉末尾斜杠和 WeKnora 文档常带的 /api/v1。 */
export function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw invalidRequest('WeKnora 地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidRequest('WeKnora 地址必须以 http 或 https 开头')
  if (url.username || url.password) throw invalidRequest('WeKnora 地址不能包含账号或密码')
  if (url.search || url.hash) throw invalidRequest('WeKnora 地址不能包含查询参数或锚点')
  return weknoraServiceRoot(url.toString())
}

/** API Key 去掉首尾空白；中间含空白时视为填写错误（HTTP 头不能携带），返回 400。 */
export function normalizeApiKey(value: string | undefined): string | undefined {
  const apiKey = value?.trim() || undefined
  if (apiKey && /\s/.test(apiKey)) throw invalidRequest('API Key 不能包含空格或换行')
  return apiKey
}

/** 规范化后比较，避免规则调整前保存的地址（如带 /api/v1）被当成“更换了地址”。 */
export function sameBaseUrl(left: string, right: string): boolean {
  return comparableBaseUrl(left) === comparableBaseUrl(right)
}

function comparableBaseUrl(value: string): string {
  try {
    return normalizeBaseUrl(value)
  } catch {
    return value
  }
}
