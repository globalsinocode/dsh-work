import { BlockList, isIP } from 'node:net'
import { domainToUnicode } from 'node:url'

import type { RuntimeManifest } from './runtime-types.ts'

/**
 * 读取网页方案（精简版）6.2：`web_fetch` 每次调用前的服务端复核。
 *
 * DSH 的取页请求不经模型网关，网址本身可能把数据带出去；因此只放行来源可信的网址（员工消息与本 Attempt
 * 联网搜索结果中的网址），并对网址做数据防护检测、次数上限与 IP 字面量检查。当前授权由平台工具通道在
 * 调用本函数之前复核。函数本身不发请求、不读数据库，便于单测。
 */

/** 每个 Attempt 最多放行的读取次数。 */
export const WEB_FETCH_MAX_PER_ATTEMPT = 10

/** 与 DSH `dsh-web-fetch-http` 的 URL 安全上限一致。 */
const MAX_URL_LENGTH = 2048

export type DataProtectionCategoryName = 'secret' | 'personal' | 'term'

export interface WebFetchCheckInput {
  url: unknown
  manifest: Pick<RuntimeManifest, 'input'>
  /** 本 Attempt 经网关的联网搜索回复中结构化结果条目的网址。 */
  searchResultUrls: ReadonlySet<string>
  /** 本 Attempt 已放行的读取次数。 */
  allowedSoFar: number
  /** 对网址文本做数据防护检测，返回命中的类别；不可用时抛错（调用方按拒绝处理）。 */
  detectCategories: (texts: string[]) => Promise<readonly DataProtectionCategoryName[]>
}

export type WebFetchDecision =
  | { allowed: true; url: string }
  | { allowed: false; code: WebFetchDenialCode; reason: string }

export type WebFetchDenialCode =
  | 'invalid_url'
  | 'data_protection'
  | 'source_not_allowed'
  | 'limit_reached'
  | 'non_public_address'

const categoryLabels: Record<DataProtectionCategoryName, string> = {
  secret: '密钥',
  personal: '个人信息',
  term: '保密词',
}

export async function checkWebFetch(input: WebFetchCheckInput): Promise<WebFetchDecision> {
  const parsed = parseFetchUrl(input.url)
  if (!parsed) return deny('invalid_url', '网址无效：只能打开不带账号密码、长度不超过 2048 个字符的 http 或 https 网址')

  // 数据防护先于来源检查：命中时原因只写类别，不回显网址。检测原样、百分号解码、`+` 视为空格，
  // 以及国际化域名（xn--）的 Unicode 形式，避免编码绕过。
  const categories = await input.detectCategories(detectionTexts(parsed))
  if (categories.length) {
    const labels = [...new Set(categories)].map(category => categoryLabels[category] ?? category).join('、')
    return deny('data_protection', `网址中包含${labels}，为防止数据外流，平台拒绝打开该网址`)
  }

  if (!allowedSources(input).has(normalizeUrl(parsed))) {
    return deny('source_not_allowed', '只能打开用户在对话中给出的网址或本次联网搜索结果中的网址，请原样使用这些网址，不要猜测、拼接或改写；需要打开其他网页时请用户把链接发在对话中')
  }

  if (input.allowedSoFar >= WEB_FETCH_MAX_PER_ATTEMPT) {
    return deny('limit_reached', `本次运行读取网页已达 ${WEB_FETCH_MAX_PER_ATTEMPT} 次上限，请基于已读取的内容作答`)
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) {
    return deny('non_public_address', '只能打开公网网页，内网与本机地址不能打开；请用户改为上传附件或使用知识库')
  }

  return { allowed: true, url: parsed.href }
}

function deny(code: WebFetchDenialCode, reason: string): WebFetchDecision {
  return { allowed: false, code, reason }
}

function parseFetchUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) return undefined
  let url: URL
  try { url = new URL(value.trim()) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  return url
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function detectionTexts(url: URL): string[] {
  const unicodeHost = domainToUnicode(url.hostname)
  return [...new Set([
    url.href,
    safeDecode(url.href),
    safeDecode(url.href.replace(/\+/g, ' ')),
    ...(unicodeHost && unicodeHost !== url.hostname ? [unicodeHost] : []),
  ])]
}

/** 规范化只做主机名小写（URL 解析已完成）与去掉片段，不做模糊匹配。 */
function normalizeUrl(url: URL): string {
  const copy = new URL(url.href)
  copy.hash = ''
  return copy.href
}

/** 文本中的网址：遇到空白、引号、尖括号与常见中文标点即结束，去掉句末标点。 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。；：！？、（）【】《》「」『』“”‘’]+/gi

export function urlsInText(text: string): string[] {
  const urls: string[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    // 原样匹配与去掉句末标点后的形式都收入：两者都是员工原文中的子串，不放宽来源；
    // 这样 `https://en.wikipedia.org/wiki/Mercury_(planet)` 这类以括号结尾的网址也能匹配。
    let candidate = match[0]
    if (candidate.length > 8) urls.push(candidate)
    while (/[.,;:!?)\]}'"]$/.test(candidate)) candidate = candidate.slice(0, -1)
    if (candidate.length > 8 && candidate !== match[0]) urls.push(candidate)
  }
  return urls
}

/** 员工本轮消息与近期历史中员工的消息（对话摘要由模型生成，不算来源），加上本 Attempt 的搜索结果网址。 */
function allowedSources(input: WebFetchCheckInput): Set<string> {
  const texts = [
    input.manifest.input.message,
    ...(input.manifest.input.conversation_history ?? []).filter(item => item.role === 'user').map(item => item.content),
  ]
  const sources = new Set<string>()
  for (const raw of [...texts.flatMap(text => urlsInText(text)), ...input.searchResultUrls]) {
    const parsed = parseFetchUrl(raw)
    if (parsed) sources.add(normalizeUrl(parsed))
  }
  return sources
}

/**
 * 非公网地址：私网、回环、链路本地、运营商 NAT、基准测试、组播与保留地址；IPv4 映射的 IPv6 一律视为非公网。
 * IPv4 与 IPv6 分两张表：同一张表里 `::ffff:0:0/96` 会把所有 IPv4 地址都判为命中。
 */
const nonPublicV4 = new BlockList()
const nonPublicV6 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublicV4.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) nonPublicV6.addSubnet(network, prefix, 'ipv6')

function isPublicAddress(address: string): boolean {
  return isIP(address) === 6 ? !nonPublicV6.check(address, 'ipv6') : !nonPublicV4.check(address, 'ipv4')
}
