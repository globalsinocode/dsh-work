import type { ServerFailure } from '../../domain/error-records.ts'
import { fingerprintOf, type ErrorRecordInput } from './client-error-report.ts'
import { sanitizeErrorMessage, sanitizeStack } from './error-sanitize.ts'

const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/

/**
 * 服务端 5xx 的错误记录（错误记录方案 6.2）：按路由模板 + 错误码归并；路由参数中的运行编号
 * 写入样本，接口链路编号只经此关联到运行（评审第 4 条）。
 */
export function serverFailureRecord(failure: ServerFailure, release: string | null): ErrorRecordInput {
  const route = `${failure.method} ${failure.routePath}`.slice(0, 512)
  const runId = failure.params['runId']
  return {
    source: 'server',
    kind: 'http',
    message: sanitizeErrorMessage(`${failure.status} ${failure.code}：${failure.errorMessage}`),
    stack: null,
    route,
    traceId: failure.traceId,
    runId: runId && RUN_ID.test(runId) ? runId : null,
    release,
    client: null,
    userId: failure.userId,
    count: 1,
    fingerprint: fingerprintOf(['server', 'http', route, failure.code]),
  }
}

export function processFailureRecord(kind: 'uncaughtException' | 'unhandledRejection', error: unknown, release: string | null): ErrorRecordInput {
  const message = sanitizeErrorMessage(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  const stack = error instanceof Error ? sanitizeStack(error.stack) : null
  const top = stack?.split('\n')[0]?.trim() ?? ''
  return {
    source: 'process', kind: 'uncaught', message, stack, route: kind, traceId: null, runId: null, release,
    client: null, userId: null, count: 1,
    fingerprint: fingerprintOf(['process', kind, message.replace(/\d+/g, '<n>').slice(0, 200), top]),
  }
}

/**
 * 进程级异常（评审第 1 条）：注册监听器后 Node 不再自动退出，因此同步写 stderr、尽力在
 * 2 秒内入库，然后显式 `process.exit(1)`，由部署的守护进程拉起。重复触发只处理第一次。
 */
export function installProcessFailureHandlers(options: {
  record: (input: ErrorRecordInput) => Promise<void>
  release: string | null
  timeoutMs?: number
  exit?: (code: number) => void
  target?: NodeJS.EventEmitter
}) {
  const target = options.target ?? process
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let handling = false
  const handle = (kind: 'uncaughtException' | 'unhandledRejection') => (error: unknown) => {
    if (handling) return
    handling = true
    const input = processFailureRecord(kind, error, options.release)
    try {
      console.error(JSON.stringify({ event: 'process.failed', kind, message: input.message }))
    } catch {
      // 继续退出。
    }
    const timeout = new Promise<void>(resolve => setTimeout(resolve, options.timeoutMs ?? 2_000).unref?.())
    void Promise.race([options.record(input).catch(() => undefined), timeout]).finally(() => exit(1))
  }
  target.on('uncaughtException', handle('uncaughtException'))
  target.on('unhandledRejection', handle('unhandledRejection'))
}
