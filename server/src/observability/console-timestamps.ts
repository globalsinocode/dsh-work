import { inspect } from 'node:util'

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error'>

const installed = Symbol.for('dsh-work.timestamped-console')

/**
 * 结构化日志 producer 自己写入有效 ISO `at` 时就保持原样（JSON 可被解析）；
 * 其余 console 调用规范化成一个带时间戳的物理行，避免 stderr 出现无时间戳续行。
 */
function isSingleJsonLine(args: unknown[]): args is [string] {
  if (args.length !== 1 || typeof args[0] !== 'string' || /[\r\n\u2028\u2029]/u.test(args[0])) return false
  try {
    const parsed: unknown = JSON.parse(args[0])
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('at' in parsed)) return false
    return typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at))
  } catch {
    return false
  }
}

function oneLine(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : value instanceof Error
      ? `${value.name}: ${value.message}${value.stack ? ` ${value.stack}` : ''}`
      : inspect(value, { depth: 4, breakLength: Infinity, compact: true })
  return text.replace(/[\r\n\u2028\u2029]+/gu, '\\n')
}

export function installTimestampedConsole(
  target: ConsoleLike = console,
  now: () => Date = () => new Date(),
): void {
  const marker = target as unknown as Record<symbol, unknown>
  if (marker[installed]) return
  marker[installed] = true
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = target[level].bind(target)
    target[level] = (...args: unknown[]) => {
      if (isSingleJsonLine(args)) {
        original(args[0])
        return
      }
      original(`${now().toISOString()} [${level}] ${args.map(oneLine).join(' ')}`)
    }
  }
}
