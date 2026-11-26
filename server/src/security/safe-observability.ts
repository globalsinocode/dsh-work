import { stripVTControlCharacters } from 'node:util'

const redacted = '[REDACTED]'
export type SafeJsonValue = null | boolean | number | string | SafeJsonValue[] | { [key: string]: SafeJsonValue }
const sensitiveKeys = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'secretvalue',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'credentialvalue',
  'privatekey',
])

export function sanitizeSafeMetadata(value: unknown): SafeJsonValue {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(item => sanitizeSafeMetadata(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? redacted : sanitizeSafeMetadata(child),
    ])) as { [key: string]: SafeJsonValue }
  }
  if (typeof value === 'string') return redactSensitiveText(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  return String(value)
}

export function redactSensitiveText(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@/]+@/gi, '$1[REDACTED]@')
    .replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
}

function isSensitiveKey(key: string) {
  return sensitiveKeys.has(key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase())
}

/**
 * 单行诊断消息：只保留第一行，遮盖凭据、网址与结构化数据，长度 ≤1,024。
 * 服务端日志、错误记录入库与浏览器上报的消息共用（错误记录方案 6.3）；不适用于多行堆栈。
 */
export function diagnosticMessage(value: string): string {
  // Keep the first physical line only: stack/continuation/header dumps are not diagnostic messages.
  let message = value.split(/[\r\n\u2028\u2029]/, 1)[0]!.slice(0, 8_192)
  message = stripVTControlCharacters(message).replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\{.*$/u, '[STRUCTURED_DATA_OMITTED]')
    .replace(/\[(?=\s*(?:["'{[\d-]|true\b|false\b|null\b)).*$/u, '[STRUCTURED_DATA_OMITTED]')
    .replace(/\b(?:request[_ -]?body|body|payload)\s*[:=].*$/giu, '[BODY_OMITTED]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*["']?\s*[:=].*$/giu, '[CREDENTIALS_OMITTED]')
    // URL userinfo, query strings and signed paths can all carry secrets; omit the whole URL.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, '[URL_OMITTED]')
    .replace(/\b(?:api[_-]?key|password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|credential(?:[_-]?value)?|private[_-]?key)\s*["']?\s*[:=]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/giu, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED]')
  // Reuse the shared bearer/API-key redaction without changing other modules' logging behavior.
  return redactSensitiveText(message).slice(0, 1_024)
}
