import { stripVTControlCharacters } from 'node:util'

import { detectValues } from '../data-protection/data-protection-detectors.ts'
import type { DataProtectionCategory } from '../data-protection/data-protection-types.ts'
import { diagnosticMessage } from '../../security/safe-observability.ts'

/**
 * 错误记录入库前的脱敏（错误记录方案 6.3），全部在服务端完成，不信任客户端。
 *
 * - 消息：`diagnosticMessage`（首行、凭据、网址、结构化数据）之后，再按数据防护内置规则遮盖密钥与个人信息。
 * - 堆栈：逐行解析为帧，只保留函数名、文件名（去掉路径与查询参数）与行列号；解析不出的行丢弃。
 */

const EMPTY_POLICY = { terms: [], allowlist: [] } as const
const CATEGORY_LABEL: Record<DataProtectionCategory, string> = { secret: '[密钥]', personal: '[个人信息]', term: '[保密词]' }
const MAX_FRAMES = 50
const MAX_STACK_CHARS = 8_192

/** 按数据防护内置规则遮盖密钥与个人信息（不查保密词表：错误记录不依赖数据库策略）。 */
export function maskPersonalData(text: string): string {
  if (!text) return text
  const found = detectValues([text], EMPTY_POLICY)
  if (found.size === 0) return text
  let result = text
  // 长值先替换，避免短值是长值的一部分时留下残片。
  for (const [value, info] of [...found].sort((a, b) => b[0].length - a[0].length)) {
    result = result.split(value).join(CATEGORY_LABEL[info.category])
  }
  return result
}

// 中英文引号与书名号括起的内容。
const QUOTED = /“[^”]{0,500}”|‘[^’]{0,500}’|「[^」]{0,500}」|『[^』]{0,500}』|"[^"]{0,500}"|'[^']{0,500}'|`[^`]{0,500}`/g
const IDENTIFIER = /^[A-Za-z_$][\w$.-]{0,80}$/

/**
 * 引号里的内容多是业务文字（对象名、文件名、员工输入），一律替换为“[内容]”（PR #171 评审）；
 * 只由字母、数字、下划线组成的标识符（如 `'artifacts'`）保留，便于排查。
 */
export function maskQuotedText(text: string): string {
  return text.replace(QUOTED, match => {
    const inner = match.slice(1, -1)
    return IDENTIFIER.test(inner) ? match : `${match[0]}[内容]${match.at(-1)}`
  })
}

export function sanitizeErrorMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  const cleaned = maskPersonalData(maskQuotedText(diagnosticMessage(text))).trim()
  return (cleaned || '未提供错误消息').slice(0, 1_024)
}

// Chrome/Edge/Node: "    at fn (url:line:col)" or "    at url:line:col"
const V8_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/
// Firefox/Safari: "fn@url:line:col" or "@url:line:col"
const GECKO_FRAME = /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/

function fileName(location: string): string | null {
  const withoutQuery = location.replace(/[?#].*$/, '')
  const name = withoutQuery.split(/[\\/]/).pop() ?? ''
  if (!/^[\w.@-]{1,120}$/.test(name)) return null
  return name
}

function functionName(raw: string | undefined): string {
  if (!raw) return '<anonymous>'
  const name = raw.replace(/^async\s+/, '').replace(/\s*\[as .+\]$/, '').trim()
  return /^[\w$.<>]{1,120}$/.test(name) ? name : '<anonymous>'
}

/** 解析出的帧，供源码映射还原：文件名、行、列。 */
export interface StackFrame { fn: string; file: string; line: number; column: number }

export function parseStackFrames(value: unknown): StackFrame[] {
  if (typeof value !== 'string' || !value) return []
  const frames: StackFrame[] = []
  for (const rawLine of stripVTControlCharacters(value).split(/\r?\n/)) {
    if (frames.length >= MAX_FRAMES) break
    const match = V8_FRAME.exec(rawLine) ?? GECKO_FRAME.exec(rawLine)
    if (!match) continue
    const file = fileName(match[2]!)
    const line = Number(match[3])
    const column = Number(match[4])
    if (!file || !Number.isInteger(line) || !Number.isInteger(column)) continue
    frames.push({ fn: functionName(match[1]), file, line, column })
  }
  return frames
}

export function formatStackFrames(frames: readonly StackFrame[]): string {
  return frames.map(frame => `  at ${frame.fn} (${frame.file}:${frame.line}:${frame.column})`).join('\n').slice(0, MAX_STACK_CHARS)
}

/** 只保留帧位置的堆栈；没有可解析的帧时为 null。 */
export function sanitizeStack(value: unknown): string | null {
  const frames = parseStackFrames(value)
  return frames.length ? formatStackFrames(frames) : null
}

/** 规范化后的消息用于指纹：去掉数字、十六进制串、UUID 与引号内值。 */
export function normalizeForFingerprint(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, '<v>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, '<h>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** 构建产物文件名去掉哈希：`index-3f2a9c.js` → `index.js`。 */
export function stableFileName(file: string): string {
  return file.replace(/-[A-Za-z0-9_]{6,}(?=\.(?:m?js|css)$)/, '')
}
