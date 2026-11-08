import { RequestError } from '../../domain/request-errors.ts'

/** 厂商模型目录：管理端添加模型时列出厂商可用的模型 id，只作为输入建议，不参与执行。 */
export interface ProviderModelCatalogPort {
  list(input: { tenantId: string; credentialRefId: string; baseUrl: string }): Promise<string[]>
}

export interface HttpProviderModelCatalogOptions {
  /** 读取平台加密保存的厂商密钥（与模型网关同一来源）；密钥只在本进程内使用，不返回给浏览器。 */
  readSecret(tenantId: string, credentialRefId: string): Promise<string>
  fetch?: typeof fetch
  timeoutMs?: number
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 1000

/** 按 OpenAI 兼容协议请求 `{base_url}/models`；与网关转发 `{base_url}/chat/completions` 的拼接方式一致。 */
export class HttpProviderModelCatalog implements ProviderModelCatalogPort {
  private readonly options: HttpProviderModelCatalogOptions

  constructor(options: HttpProviderModelCatalogOptions) {
    this.options = options
  }

  async list(input: { tenantId: string; credentialRefId: string; baseUrl: string }): Promise<string[]> {
    let secret: string
    try {
      secret = await this.options.readSecret(input.tenantId, input.credentialRefId)
    } catch {
      throw catalogError(503, 'model_catalog_credential_unreadable', '无法读取该 Provider 的 API Key，请重新录入后再试')
    }
    const target = `${input.baseUrl.replace(/\/+$/, '')}/models`
    const doFetch = this.options.fetch ?? fetch
    // 同一个超时覆盖连接与读取正文。
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
    let response: Response
    try {
      response = await doFetch(target, {
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        signal,
        redirect: 'error',
      })
    } catch {
      if (signal.aborted) throw timeoutError()
      throw catalogError(502, 'model_catalog_unreachable', '无法连接厂商获取模型列表，请检查 Base URL 与网络')
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      throw catalogError(409, 'model_catalog_credential_rejected', `厂商拒绝了该 API Key（HTTP ${response.status}），请检查或重新录入密钥`)
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw catalogError(502, 'model_catalog_unsupported', `厂商未提供模型列表（HTTP ${response.status}）`)
    }
    let text: string
    try {
      text = await readTextWithin(response, MAX_RESPONSE_BYTES)
    } catch (error) {
      if (error instanceof RequestError) throw error
      if (signal.aborted) throw timeoutError()
      throw catalogError(502, 'model_catalog_unreachable', '读取厂商模型列表时连接中断，请稍后重试')
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw catalogError(502, 'model_catalog_invalid', '厂商返回的模型列表无法解析')
    }
    return parseModelIds(payload)
  }
}

const MANUAL_SUGGESTION = '可直接在“模型标识”中手动输入厂商的模型 id。'

function catalogError(status: number, code: string, message: string) {
  return new RequestError(status, code, message, MANUAL_SUGGESTION)
}

function timeoutError() {
  return catalogError(504, 'model_catalog_timeout', '厂商在规定时间内没有返回模型列表')
}

/** 边读边计字节；超过上限立即中止，不把整个正文读进内存（不依赖 content-length）。 */
async function readTextWithin(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function tooLarge() {
  return catalogError(502, 'model_catalog_too_large', '厂商返回的模型列表过大')
}

/** 兼容 `{data:[{id}]}`（OpenAI 标准）与 `{models:[{id|name}]}` 两种常见形态；去重、排序，最多 1000 个。 */
export function parseModelIds(payload: unknown): string[] {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const items = Array.isArray(record['data']) ? record['data'] : Array.isArray(record['models']) ? record['models'] : null
  if (!items) throw catalogError(502, 'model_catalog_invalid', '厂商返回的模型列表格式不符合 OpenAI 兼容协议')
  const ids = new Set<string>()
  for (const item of items) {
    const value = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? (item as Record<string, unknown>)['id'] ?? (item as Record<string, unknown>)['name']
        : undefined
    if (typeof value === 'string' && value.trim() && value.length <= 200) ids.add(value.trim())
    if (ids.size >= MAX_MODELS) break
  }
  return [...ids].sort((left, right) => left.localeCompare(right))
}
