/**
 * 判定 Provider 是否为 DeepSeek 官方（按 base_url 主机名，模型路由方案 4.3、数据防护方案 D12 补充）。
 *
 * MR-S1 之后 provider_type 只表示接入协议，不能区分厂商；DeepSeek 专有的两处行为按此判定：
 * - pi-ai 模型条目设置 `compat.thinkingFormat: deepseek`（DLP-S0 验证）；
 * - 联网搜索：只有默认路由的 Provider 是 DeepSeek 官方时，网关才透传其 Anthropic 兼容搜索接口，
 *   并使用该 Provider 的平台加密密钥；否则本轮不装配联网搜索。
 */
export const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com'

/** DSH `web-search-deepseek` 插件使用的搜索模型（插件默认值，网关对搜索接口只放行此模型）。 */
export const DEEPSEEK_WEB_SEARCH_MODEL = 'deepseek-v4-flash'

export function isDeepSeekOfficialBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === DEEPSEEK_OFFICIAL_HOST
  } catch {
    return false
  }
}

/** DeepSeek 官方 Anthropic 兼容搜索接口地址（DSH 插件默认 `https://api.deepseek.com/anthropic/v1` + `/messages`）。 */
export function deepSeekSearchEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  return `${url.protocol}//${url.host}/anthropic/v1/messages`
}
