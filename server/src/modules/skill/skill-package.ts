import { createHash } from 'node:crypto'
import { crc32, inflateRawSync } from 'node:zlib'
import { parseDocument } from 'yaml'
import { MAX_SKILL_FILES, MAX_SKILL_BYTES } from '../../domain/skill-package-limits.ts'

export interface SkillPackage {
  name: string
  description: string
  instructions: string
  version: string | null
  toolIds: string[]
  files: Array<{ path: string; content: string; sha256: string; size: number }>
  sha256: string
  archiveSha256: string
}
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const decoder = new TextDecoder('utf-8', { fatal: true })
const fail = (message: string): never => { throw Object.assign(new Error(`Skill 包校验失败：${message}`), { status: 422, code: 'skill_package_invalid' }) }

export function parseSkillPackage(bytes: Uint8Array, selected?: string, directory?: string): SkillPackage {
  if (bytes.length > 20 * 1024 * 1024) fail('下载包超过 20 MB')
  let files: Record<string, Uint8Array>
  const specialPaths = new Set<string>()
  if (bytes.length < 2) fail('文件为空或损坏')
  if (Buffer.from(bytes).readUInt16LE(0) === 0x4b50) {
    files = extractZip(Buffer.from(bytes), specialPaths)
  } else {
    files = { 'SKILL.md': bytes }
  }
  const entries = Object.keys(files).filter(path => !path.endsWith('/'))
  let candidates = entries.filter(path => !specialPaths.has(path) && (path === 'SKILL.md' || path.endsWith('/SKILL.md')))
  if (directory) candidates = candidates.filter(path => path.endsWith(`/${directory}/SKILL.md`))
  if (selected) candidates = candidates.filter(path => {
    // Discover by name before checking compatibility: other Skills are not installed.
    try {
      const name = readEntry(decoder.decode(files[path])).metadata['name']
      return typeof name === 'string' && name.trim() === selected
    } catch { return false }
  })
  if (candidates.length !== 1) fail(candidates.length ? '包中有多个 Skill，请用 --skill 指定名称或提供具体目录链接' : '没有找到指定 Skill 的 SKILL.md')
  const entry = candidates[0]!
  const root = entry.slice(0, -'SKILL.md'.length)
  const selectedPaths = entries.filter(path => path.startsWith(root)).sort()
  const normalizedPaths = new Set(selectedPaths.map(path => path.normalize('NFC').toLowerCase()))
  if (selectedPaths.some(path => path.split('/').slice(0, -1).some((_, index, parts) => normalizedPaths.has(parts.slice(0, index + 1).join('/').normalize('NFC').toLowerCase())))) fail('Skill 包含文件与目录冲突路径')
  if (selectedPaths.some(path => specialPaths.has(path))) fail('选中的 Skill 目录不允许符号链接或特殊文件')
  if (selectedPaths.length > MAX_SKILL_FILES) fail('单个 Skill 最多包含 64 个文件')
  let total = 0
  const packaged = selectedPaths.map(path => {
    const relative = path.slice(root.length)
    assertPackagePath(relative)
    if (!/(?:\.(?:md|txt|json|ya?ml|csv|toml)|(?:^|\/)LICENSE(?:\.txt)?)$/i.test(relative)) {
      fail(`暂不支持文件 ${relative}；当前支持说明、参考资料与文本模板，不执行脚本或安装依赖`)
    }
    total += files[path]!.length
    if (total > MAX_SKILL_BYTES) fail('Skill 解包文本总大小超过 1 MB')
    const content = decoder.decode(files[path])
    if (content.includes('\0')) fail(`文件 ${relative} 不是受支持的 UTF-8 文本`)
    return { path: relative, content, size: files[path]!.length, sha256: hash(files[path]!) }
  })
  const metadata = parseEntry(decoder.decode(files[entry]))
  for (const reference of metadata.instructions.match(/(?:references|templates|scripts|assets)\/[A-Za-z0-9_./-]+/g) ?? []) {
    if (!packaged.some(file => file.path === reference)) fail(`缺少引用文件 ${reference}，请提供完整 Skill 目录或 ZIP`)
  }
  const tools = new Set(metadata.toolIds)
  if (packaged.length > 1) tools.add('read@1.0.0')
  return { ...metadata, toolIds: [...tools], files: packaged, archiveSha256: hash(bytes), sha256: hash(JSON.stringify(packaged)) }
}

function readEntry(text: string) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (!match) return fail('SKILL.md 必须包含 YAML 元数据及正文')
  const document = parseDocument(match[1], { uniqueKeys: true })
  if (document.errors.length) return fail('SKILL.md 元数据格式无效或字段重复')
  const metadata = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return fail('元数据必须是对象')
  return { metadata, instructions: match[2]!.trim() }
}

function parseEntry(text: string) {
  const { metadata, instructions } = readEntry(text)
  const name = metadata['name'], description = metadata['description']
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return fail('name 必须为 1～80 个字符')
  if (typeof description !== 'string' || !description.trim() || description.length > 2000) return fail('description 必须为 1～2000 个字符')
  if (instructions.length < 20 || instructions.length > 100000) return fail('SKILL.md 正文必须为 20～100000 个字符')
  const declared = metadata['allowed-tools'] ?? []
  const toolNames = typeof declared === 'string' ? declared.split(/[\s,]+/).filter(Boolean) : declared
  if (!Array.isArray(toolNames) || toolNames.some(value => typeof value !== 'string' || !['read', 'glob', 'grep'].includes(value))) return fail('allowed-tools 当前仅支持 read、glob、grep；其他工具需先适配')
  if (metadata['dependencies'] || metadata['requires']) return fail('当前不支持自动安装外部依赖')
  const version = metadata['version']
  if (version !== undefined && (typeof version !== 'string' || version.length > 80)) return fail('version 格式无效')
  return { name: name.trim(), description: description.trim(), instructions, toolIds: [...new Set(toolNames as string[])].map(name => `${name}@1.0.0`), version: typeof version === 'string' ? version : null }
}

export function assertPackagePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || [...path].some(character => character.charCodeAt(0) < 32) || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`不安全的文件路径：${path}`)
}

function extractZip(bytes: Buffer, specialPaths: Set<string>) {
  const files: Record<string, Uint8Array> = Object.create(null)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0) fail('ZIP 目录损坏')
  const count = bytes.readUInt16LE(end + 10)
  if (count < 1 || count > 2000 || bytes.readUInt16LE(end + 8) !== count || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('ZIP 文件数量或分卷格式不受支持')
  let offset = bytes.readUInt32LE(end + 16), expanded = 0
  const paths = new Set<string>()
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('ZIP 目录无效')
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32)
    const next = offset + 46 + nameSize + extraSize + commentSize
    if (next > end) fail('ZIP 目录越界')
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameSize))
    assertPackagePath(path.endsWith('/') ? path.slice(0, -1) : path)
    const key = path.replace(/\/$/, '').normalize('NFC').toLowerCase()
    if (paths.has(key)) fail('ZIP 包含重复或冲突路径')
    paths.add(key)
    const mode = bytes.readUInt32LE(offset + 38) >>> 16
    if (mode && (mode & 0xf000) !== 0 && ![0x8000, 0x4000].includes(mode & 0xf000)) specialPaths.add(path)
    if (bytes.readUInt16LE(offset + 8) & 1) fail('不支持加密 ZIP')
    if (![0, 8].includes(bytes.readUInt16LE(offset + 10))) fail('不支持此 ZIP 压缩方式')
    expanded += bytes.readUInt32LE(offset + 24)
    if (expanded > 32 * 1024 * 1024) fail('ZIP 解压总大小超过 32 MB')
    const local = bytes.readUInt32LE(offset + 42)
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) fail('ZIP 文件头无效')
    const localName = decoder.decode(bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)))
    if (localName !== path) fail('ZIP 文件名不一致')
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24)
    if (dataStart + compressed > bytes.readUInt32LE(end + 16)) fail('ZIP 文件数据越界')
    const raw = bytes.subarray(dataStart, dataStart + compressed)
    const content = bytes.readUInt16LE(offset + 10) === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) })
    if (content.length !== size || crc32(content) !== bytes.readUInt32LE(offset + 16)) fail('ZIP 内容大小或 CRC 校验不匹配')
    files[path] = content
    offset = next
  }
  if (offset !== end) fail('不支持 ZIP64 或扩展目录')
  return files
}
