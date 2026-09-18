import { stripVTControlCharacters } from 'node:util'

import { redactSensitiveText } from '../security/safe-observability.ts'

/** Safe, bounded diagnostic projection. Never serialize the request, response or Error object. */
export function logHttpFailure(input: {
  traceId: string
  method: string
  /** Registered route template; raw URLs/parameters may themselves contain credentials. */
  path: string
  status: number
  code: string
  error?: unknown
  safeMessage: string
  responseStarted: boolean
}): void {
  try {
    // JSON.parse errors can quote the body in their message, even without accessing request.body.
    const original = input.error instanceof SyntaxError ? '请求内容不是有效 JSON'
      : input.error instanceof Error ? input.error.message
        : input.error === undefined ? input.safeMessage : '未知服务端错误'
    console.error(JSON.stringify({
      event: 'http.request.failed', traceId: input.traceId,
      method: input.method.slice(0, 24), path: input.path.slice(0, 512),
      status: input.status, code: input.code,
      message: diagnosticMessage(typeof original === 'string' ? original : input.safeMessage),
      responseStarted: input.responseStarted,
    }))
  } catch {
    // Observability must not replace the actual HTTP failure or attempt a second response.
    // In particular do not log the original request/error to a fallback sink.
  }
}

function diagnosticMessage(value: string): string {
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
