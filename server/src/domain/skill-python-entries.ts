import { parseDocument } from 'yaml'

/**
 * 脚本型 Skill 的入口登记（功能规则第 6 节）：SKILL.md frontmatter 的 `python-entries` 列出可由
 * `python_execute` 直接运行的 `.py` 文件；只被导入的模块和示例脚本不列入。没有这个字段的 Skill
 * 保持原有行为（包内全部 `.py` 都可作入口），安装计划提示建议登记。
 */
export const PYTHON_ENTRIES_FIELD = 'python-entries'
export const MAX_PYTHON_ENTRIES = 32
// 与执行器 resolvePythonCall 一致：任何位置出现 `..` 都不接受，也不接受 `.` 路径段。
const ENTRY_PATH = /^(?!\/)(?!.*\.\.)(?!.*(?:^|\/)\.(?:\/|$))[A-Za-z0-9_./-]+\.py$/

/**
 * 校验 frontmatter 中 `python-entries` 的取值。字段缺失返回 undefined；格式无效时抛出说明原因的 Error。
 * 接受单个路径字符串或路径列表，路径相对于 Skill 根目录。
 */
export function readPythonEntriesField(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || !values.length || values.length > MAX_PYTHON_ENTRIES) {
    throw new Error(`${PYTHON_ENTRIES_FIELD} 必须列出 1～${MAX_PYTHON_ENTRIES} 个 .py 文件路径`)
  }
  const entries = values.map(item => typeof item === 'string' ? item.trim() : '')
  const invalid = entries.find(item => !ENTRY_PATH.test(item))
  if (invalid !== undefined) throw new Error(`${PYTHON_ENTRIES_FIELD} 中的路径无效：${invalid || '（空）'}；须为 Skill 目录内的相对 .py 路径`)
  if (new Set(entries).size !== entries.length) throw new Error(`${PYTHON_ENTRIES_FIELD} 中有重复路径`)
  return entries
}

/**
 * 按 Skill 文件夹（含 SKILL.md 正文）得出可执行入口。`declared` 为 false 表示 SKILL.md 没有登记，
 * 此时包内全部 `.py` 都是入口；登记格式无效时不放行任何入口（安装时已拒绝这类包）。
 */
export function skillPythonEntries(files: ReadonlyArray<{ path: string; content?: string }>): { declared: boolean; entries: string[] } {
  const python = files.filter(file => file.path.endsWith('.py')).map(file => file.path)
  const skillMarkdown = files.find(file => file.path === 'SKILL.md')?.content
  const match = skillMarkdown?.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { declared: false, entries: python }
  const document = parseDocument(match[1], { uniqueKeys: true })
  if (document.errors.length) return { declared: false, entries: python }
  const metadata = document.toJS({ maxAliasCount: 0 }) as unknown
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { declared: false, entries: python }
  let declared: string[] | undefined
  try { declared = readPythonEntriesField((metadata as Record<string, unknown>)[PYTHON_ENTRIES_FIELD]) } catch { return { declared: true, entries: [] } }
  if (!declared) return { declared: false, entries: python }
  return { declared: true, entries: declared.filter(entry => python.includes(entry)) }
}

/**
 * python_execute 调用前的入口核对：SKILL.md 登记了入口而本次入口不在其中时返回拒绝说明，否则返回 null。
 * 未登记的 Skill 不在这里拦截，入口是否为包内 .py 由执行器另行校验。
 */
export function undeclaredPythonEntry(files: ReadonlyArray<{ path: string; content?: string }>, entry: string): string | null {
  const { declared, entries } = skillPythonEntries(files)
  if (!declared || entries.includes(entry)) return null
  return `入口 ${entry || '（未提供）'} 未在 Skill 的 ${PYTHON_ENTRIES_FIELD} 中登记；可运行的入口：${entries.join('、') || '无'}`
}
