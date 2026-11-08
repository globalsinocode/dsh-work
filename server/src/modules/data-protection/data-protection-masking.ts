import { createHmac, hkdfSync } from 'node:crypto'

import { detectSecrets, detectValues, escapeRegExp, identifierRanges, isIdentifierFragment, type ValueBoundary } from './data-protection-detectors.ts'
import {
  DataProtectionUnavailableError,
  type DataProtectionCategory,
  type DataProtectionCounts,
  type DataProtectionPolicy,
} from './data-protection-types.ts'

const CATEGORY_PREFIX: Record<DataProtectionCategory, string> = { secret: 'SECRET', personal: 'PERSONAL', term: 'TERM' }
/** 原文里本来就有占位符形式的文本时，用此前缀把它也换成占位符（相当于转义），不计入命中。 */
const LITERAL_PREFIX = 'TEXT'
const PLACEHOLDER_PATTERN = /\{\{(?:SECRET|PERSONAL|TERM|TEXT)_[a-z2-7]{10}\}\}/g
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** 租户数据防护密钥：由环境主密钥按租户派生，不单独存储、不分版本（方案 5.4、D11）。 */
export function deriveTenantKey(masterKey: Uint8Array, tenantId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, new Uint8Array(0), `dsh-work/data-protection/${tenantId}`, 32))
}

/** HMAC-SHA256 取前 50 比特，按 base32 编码为 10 位短码。 */
function hmacShortCode(tenantKey: Uint8Array, value: string): string {
  const digest = createHmac('sha256', tenantKey).update(value, 'utf8').digest()
  let code = ''
  let buffer = 0
  let bits = 0
  for (let index = 0; code.length < 10; index += 1) {
    buffer = (buffer << 8) | digest[index]!
    bits += 8
    while (bits >= 5 && code.length < 10) {
      bits -= 5
      code += BASE32[(buffer >> bits) & 31]
    }
    buffer &= (1 << bits) - 1
  }
  return code
}

export interface MaskOptions {
  tenantKey: Uint8Array
  policy: DataProtectionPolicy
  /** 仅供测试构造短码碰撞。 */
  shortCode?: (value: string) => string
}

export interface MaskResult {
  texts: string[]
  /** 占位符 → 原值。只在单个请求及其回复期间保存在内存中，不持久化（方案 5.4）。 */
  placeholders: Map<string, string>
  counts: DataProtectionCounts
}

const BOUNDARY_WRAP: Record<ValueBoundary, [string, string]> = {
  alnum: ['(?<![A-Za-z0-9])', '(?![A-Za-z0-9])'],
  word: ['(?<![A-Za-z0-9_])', '(?![A-Za-z0-9_])'],
  none: ['', ''],
}

/**
 * 请求内全文遮盖（方案 5.4）：先在全部文本上收集命中值，再统一替换。一个值只要在任一位置被识别，
 * 它在所有位置都遮盖，即使别处的周围文字不再触发规则；替换沿用识别时的边界。
 * contexts 只参与识别、不写回（如工具参数的完整 JSON：键名是字段规则的上下文）。
 */
export function maskTexts(input: readonly string[], options: MaskOptions & { contexts?: readonly string[] }): MaskResult {
  try {
    const found = new Map<string, { category: DataProtectionCategory | 'literal'; boundary: ValueBoundary }>()
    for (const text of input) {
      for (const match of text.matchAll(PLACEHOLDER_PATTERN)) found.set(match[0], { category: 'literal', boundary: 'none' })
    }
    for (const [value, info] of detectValues([...input, ...(options.contexts ?? [])], options.policy)) {
      if (!found.has(value)) found.set(value, info)
    }

    const placeholders = new Map<string, string>()
    const replacements = new Map<string, { placeholder: string; category: DataProtectionCategory | 'literal' }>()
    const shortCode = options.shortCode ?? ((value: string) => hmacShortCode(options.tenantKey, value))
    for (const [value, { category }] of found) {
      const placeholder = `{{${category === 'literal' ? LITERAL_PREFIX : CATEGORY_PREFIX[category]}_${shortCode(value)}}}`
      // 错误信息不带任何取值或占位符。
      if (placeholders.has(placeholder)) throw new DataProtectionUnavailableError('数据防护短码碰撞')
      placeholders.set(placeholder, value)
      replacements.set(value, { placeholder, category })
    }

    const counts: DataProtectionCounts = { secret: 0, personal: 0, term: 0 }
    if (found.size === 0) return { texts: [...input], placeholders, counts }
    const alternation = new RegExp(
      [...found].sort(([a], [b]) => b.length - a.length).map(([value, { boundary }]) => {
        const [before, after] = BOUNDARY_WRAP[boundary]
        return `${before}${escapeRegExp(value)}${after}`
      }).join('|'),
      'gu',
    )
    const texts = input.map(text => {
      const ranges = identifierRanges(text)
      return text.replace(alternation, (match: string, offset: number) => {
        if (isIdentifierFragment(ranges, offset, offset + match.length)) return match
        const replacement = replacements.get(match)!
        if (replacement.category !== 'literal') counts[replacement.category] += 1
        return replacement.placeholder
      })
    })
    return { texts, placeholders, counts }
  } catch (error) {
    if (error instanceof DataProtectionUnavailableError) throw error
    // 只带错误类型：引擎的错误消息可能含由原值拼成的表达式。
    throw new DataProtectionUnavailableError(`数据防护识别失败：${error instanceof Error ? error.name : 'unknown'}`)
  }
}

/**
 * 输入预检（方案 5.6.1、D10）：只查员工本条消息正文中的密钥。识别异常抛出
 * DataProtectionUnavailableError，调用方不创建 Run。返回命中的出现次数，不返回取值本身。
 */
export function inspectMessageForSecrets(text: string, policy: DataProtectionPolicy): { secretCount: number } {
  try {
    // 按出现次数计，与网关审计的口径一致。
    return { secretCount: detectSecrets(text, policy).reduce((total, { value }) => total + text.split(value).length - 1, 0) }
  } catch (error) {
    throw new DataProtectionUnavailableError(`数据防护识别失败：${error instanceof Error ? error.name : 'unknown'}`)
  }
}

/**
 * 流式还原：把本请求映射内的占位符换回原值，映射之外的占位符形式原样保留。
 * 只扣住“可能是某个已知占位符开头”的尾部，其余立即放行。每个文本字段各用一个实例。
 */
export class PlaceholderRestorer {
  private buffer = ''
  private readonly placeholders: ReadonlyMap<string, string>
  private readonly encode: (value: string) => string
  private readonly prefixes = new Set<string>()
  private readonly longest: number

  /** encode：写回目标格式时对原值的转义（如 JSON 字符串转义），默认不转义。 */
  constructor(placeholders: ReadonlyMap<string, string>, encode: (value: string) => string = value => value) {
    this.placeholders = placeholders
    this.encode = encode
    let longest = 0
    for (const placeholder of placeholders.keys()) {
      longest = Math.max(longest, placeholder.length)
      for (let length = 1; length < placeholder.length; length += 1) this.prefixes.add(placeholder.slice(0, length))
    }
    this.longest = longest
  }

  push(chunk: string): string {
    if (this.placeholders.size === 0) return chunk
    const text = this.buffer + chunk
    let output = ''
    let cursor = 0
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
      const original = this.placeholders.get(match[0])
      if (original === undefined) continue
      output += text.slice(cursor, match.index) + this.encode(original)
      cursor = match.index + match[0].length
    }
    const rest = text.slice(cursor)
    const held = this.heldLength(rest)
    this.buffer = rest.slice(rest.length - held)
    return output + rest.slice(0, rest.length - held)
  }

  flush(): string {
    const rest = this.buffer
    this.buffer = ''
    return rest
  }

  private heldLength(text: string): number {
    for (let length = Math.min(text.length, this.longest - 1); length > 0; length -= 1) {
      if (this.prefixes.has(text.slice(text.length - length))) return length
    }
    return 0
  }
}
