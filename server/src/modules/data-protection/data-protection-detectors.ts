import type { DataProtectionCategory, DataProtectionPolicy, DataProtectionTerm } from './data-protection-types.ts'

export interface DetectedValue {
  value: string
  category: DataProtectionCategory
}

/** 替换时沿用的边界：内置规则不贴字母数字，整词词表不贴单词字符，其余不限。 */
export type ValueBoundary = 'alnum' | 'word' | 'none'

export interface DetectedInfo {
  category: DataProtectionCategory
  boundary: ValueBoundary
}

interface Rule {
  category: DataProtectionCategory
  pattern: RegExp
  /** 取值的捕获组（取第一个有值的）；缺省为整个匹配。 */
  groups?: readonly number[]
  boundary: ValueBoundary
  transform?: (value: string) => string
  validate?: (value: string, match: RegExpMatchArray, text: string) => boolean
  /** 字段上下文规则：宽口径遮盖，预检拦截时要求更高置信。 */
  field?: boolean
}

/** 值两侧不能紧贴字母或数字（方案 5.3 误报控制）。 */
const START = '(?<![A-Za-z0-9])'
const END = '(?![A-Za-z0-9])'

const NON_VALUES = new Set([
  'null', 'undefined', 'none', 'true', 'false', 'password', 'example', 'placeholder', 'string', 'required', 'optional',
  'incorrect', 'invalid', 'expired', 'missing', 'wrong', 'number', 'boolean', 'integer', 'object', 'bearer', 'unknown', 'changeme',
])
const ALGORITHM_NAME = /^(?:aes|rsa|des|3des|sha|md5|hmac|ecdsa|ed25519)[-\d]*$/i

/** 明显不是真实取值的形态：变量引用、类型名、函数调用、属性访问、算法名。 */
function isNonValue(value: string): boolean {
  return NON_VALUES.has(value.toLowerCase())
    || /^\$\{/.test(value) || /^\$[A-Z_][A-Z0-9_]*$/.test(value) || /^<[^>]*>?$/.test(value) || /^%[A-Za-z_]+%?$/.test(value) || /^\{\{/.test(value)
    || /^your(?:[_-]|$)/i.test(value) || /(.)\1{7,}/.test(value)
    || /^[A-Za-z_$][\w$.]*\(/.test(value) || /^[A-Za-z_][\w.]*\[/.test(value) || /^[a-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)
    || ALGORITHM_NAME.test(value)
}

/** 去掉句末标点、下一个键值对，保证同一个值在其他位置也能按原样匹配。 */
function trimUnquotedValue(value: string): string {
  return (value.split(/[,;&](?=[\w-]+[=:])/)[0] ?? value).replace(/[.,;:!?)\]}>]+$/, '')
}

function decodeJsonEscapes(value: string): string {
  if (!value.includes('\\')) return value
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value
  }
}

function isFieldValue(value: string, match: RegExpMatchArray): boolean {
  if (value.length < 6 || isNonValue(value)) return false
  // 纯数字只有密码字段才算（token: 102400 多半是用量）。
  return !/^\d+$/.test(value) || !/token|key|令牌|密钥/i.test(match[0])
}

/** 预检命中会直接拦截消息：字段规则要求取值至少混合两类字符，普通单词只遮盖、不拦截。 */
function isConfidentFieldValue(value: string): boolean {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(kind => kind.test(value)).length >= 2
}

function isPlausibleKey(value: string): boolean {
  return /\d/.test(value) && !/your|here|example|sample|placeholder/i.test(value) && !/(.)\1{7,}/.test(value)
}

function isConnectionPassword(value: string): boolean {
  // host:8080/path@v1 里的端口不是密码。
  return value.length >= 4 && !/^\d{1,5}(?:\/|$)/.test(value) && !isNonValue(value)
}

/** user:密码@主机 不是邮箱；只回看有限长度，避免长文本上的平方级耗时。 */
function isNotConnectionUserInfo(_value: string, match: RegExpMatchArray, text: string): boolean {
  const index = match.index ?? 0
  return !/:\/\/[^\s/@]*$/.test(text.slice(Math.max(0, index - 256), index))
}

function isIdentityCard(value: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const sum = weights.reduce((total, weight, index) => total + weight * Number(value[index]), 0)
  return '10X98765432'[sum % 11] === value[17]?.toUpperCase()
}

function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2
    sum += digit
  }
  return sum % 10 === 0
}

const caseInsensitive = (word: string) => word.replace(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`)
/** 不靠 i 标志：驼峰边界要区分大小写（clientSecret、accessToken）。 */
const FIELD_NAME_START = '(?:(?<![A-Za-z0-9])|(?<=[a-z0-9])(?=[A-Z]))'
const FIELD_NAMES = [
  'secret[_-]?access[_-]?key', 'secret[_-]?key', 'private[_-]?key', 'client[_-]?secret', 'app[_-]?secret', 'api[_-]?key', 'access[_-]?key',
  'password', 'passwd', 'passphrase', 'pwd', 'secret', 'token',
].map(caseInsensitive).join('|')
const FIELD_PREFIX = `(?:${FIELD_NAME_START}(?:${FIELD_NAMES})|密码|口令|密钥|令牌)["'”]?\\s*(?:[:：=]|为|是)\\s*`

/** 按类别优先级排列：同一个值命中多条规则时取最前的类别。 */
const SECRET_RULES: readonly Rule[] = [
  // 截断或只贴一半的私钥没有结尾，遮盖到文本末尾。
  { category: 'secret', boundary: 'none', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { category: 'secret', boundary: 'alnum', validate: isPlausibleKey, pattern: new RegExp(`${START}(?:sk[-_](?:live_|test_)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|dshwg_[A-Za-z0-9_-]{20,})${END}`, 'g') },
  { category: 'secret', boundary: 'alnum', pattern: new RegExp(`${START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}${END}`, 'g') },
  { category: 'secret', boundary: 'alnum', validate: isPlausibleKey, pattern: new RegExp(`${START}Bearer\\s+([A-Za-z0-9._~+/-]{16,}=*)`, 'gi'), groups: [1] },
  // 连接串只遮盖其中的密码，保留主机与库名供模型理解。密码取到本段最后一个 @，可含 / 和 @。
  { category: 'secret', boundary: 'alnum', validate: isConnectionPassword, pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,128}:(\S{1,256})@/gi, groups: [1] },
  // 带引号的取值匹配到闭合引号，可含空格和逗号；JSON 转义解码后再比对。
  { category: 'secret', boundary: 'alnum', field: true, validate: isFieldValue, transform: decodeJsonEscapes, groups: [1, 2, 3],
    pattern: new RegExp(`${FIELD_PREFIX}(?:"((?:[^"\\\\\\n]|\\\\.){1,256})"|'([^'\\n]{1,256})'|“([^”\\n]{1,256})”)`, 'g') },
  // 不带引号的取值限 ASCII，“密码是否正确”这样的普通中文不会命中。
  { category: 'secret', boundary: 'alnum', field: true, validate: isFieldValue, transform: trimUnquotedValue, groups: [1],
    pattern: new RegExp(`${FIELD_PREFIX}(?!["'“])((?:(?!["'\`])[!-~]){6,256})`, 'g') },
]

const PERSONAL_RULES: readonly Rule[] = [
  { category: 'personal', boundary: 'alnum', validate: isIdentityCard, pattern: new RegExp(`${START}[1-9]\\d{5}(?:18|19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]${END}`, 'g') },
  { category: 'personal', boundary: 'alnum', pattern: new RegExp(`${START}(?:(?:\\+86|0086|86)[ -]?)?1[3-9]\\d(?:\\d{8}|[ -]\\d{4}[ -]\\d{4})${END}`, 'g') },
  { category: 'personal', boundary: 'alnum', validate: passesLuhn, pattern: new RegExp(`${START}\\d{16,19}${END}`, 'g') },
  { category: 'personal', boundary: 'alnum', validate: passesLuhn, pattern: new RegExp(`${START}\\d{4}(?:[ -]\\d{4}){3}(?:[ -]?\\d{1,3})?${END}`, 'g') },
  // 本地部分限长（RFC 上限 64），长文本上保持线性。
  { category: 'personal', boundary: 'alnum', validate: isNotConnectionUserInfo, pattern: new RegExp(`${START}[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}${END}`, 'g') },
]

/** UUID、长十六进制串（内容摘要、缓存键等）整体不参与匹配（方案 5.3）。 */
const IDENTIFIER_PATTERN = new RegExp(`${START}(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,})${END}`, 'gi')

export function identifierRanges(text: string): [number, number][] {
  return [...text.matchAll(IDENTIFIER_PATTERN)].map(match => [match.index, match.index + match[0].length])
}

/** 只有严格落在标识符内部的片段才排除；取值恰好就是整个标识符时（如 password=<hex>）仍算命中。 */
export function isIdentifierFragment(ranges: readonly [number, number][], start: number, end: number): boolean {
  return ranges.some(([from, to]) => start >= from && end <= to && (start !== from || end !== to))
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termAlternative(term: DataProtectionTerm): string {
  const escaped = escapeRegExp(term.value)
  return term.wholeWord ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])` : escaped
}

/** 词表合并为多模式表达式（长词在前），避免按词逐个扫描全文。 */
function termRules(terms: readonly DataProtectionTerm[]): Rule[] {
  const usable = terms.filter(term => term.value.length > 0).sort((a, b) => b.value.length - a.value.length)
  const rules: Rule[] = []
  for (const wholeWord of [true, false]) {
    for (const [caseSensitive, flags] of [[true, 'gu'], [false, 'giu']] as const) {
      const items = usable.filter(term => term.caseSensitive === caseSensitive && term.wholeWord === wholeWord)
      if (items.length) rules.push({ category: 'term', boundary: wholeWord ? 'word' : 'none', pattern: new RegExp(items.map(termAlternative).join('|'), flags) })
    }
  }
  return rules
}

/** 按规则优先级在全部文本上收集命中值：同一个值的类别与它先在哪段文本出现无关。 */
function collect(texts: readonly string[], rules: readonly Rule[], policy: DataProtectionPolicy): Map<string, DetectedInfo> {
  const found = new Map<string, DetectedInfo>()
  const allowed = new Set(policy.allowlist.map(value => value.toLowerCase()))
  const ranges = texts.map(identifierRanges)
  for (const rule of rules) {
    texts.forEach((text, textIndex) => {
      for (const match of text.matchAll(rule.pattern)) {
        const group = rule.groups?.find(index => match[index] !== undefined)
        const raw = match[group ?? 0]
        if (!raw) continue
        const value = rule.transform ? rule.transform(raw) : raw
        if (!value || found.has(value) || allowed.has(value.toLowerCase())) continue
        if (rule.validate && !rule.validate(value, match, text)) continue
        const start = group ? match.index + match[0].lastIndexOf(raw) : match.index
        if (isIdentifierFragment(ranges[textIndex]!, start, start + value.length)) continue
        found.set(value, { category: rule.category, boundary: rule.boundary })
      }
    })
  }
  return found
}

/** 收集全部文本中命中的值（类别、替换边界）。 */
export function detectValues(texts: readonly string[], policy: DataProtectionPolicy): Map<string, DetectedInfo> {
  return collect(texts, [...SECRET_RULES, ...PERSONAL_RULES, ...termRules(policy.terms)], policy)
}

/** 只查密钥类别，供输入预检使用（D10）；字段规则按高置信口径。 */
export function detectSecrets(text: string, policy: DataProtectionPolicy): DetectedValue[] {
  const rules = SECRET_RULES.map(rule => rule.field
    ? { ...rule, validate: (value: string, match: RegExpMatchArray, source: string) => isConfidentFieldValue(value) && (rule.validate?.(value, match, source) ?? true) }
    : rule)
  return [...collect([text], rules, policy)].map(([value, info]) => ({ value, category: info.category }))
}
