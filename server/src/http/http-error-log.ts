import { diagnosticMessage } from '../security/safe-observability.ts'

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
