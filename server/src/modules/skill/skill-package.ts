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
  requirements: SkillRequirement[]
  compatibility: SkillCompatibility
  disableModelInvocation: boolean
}
export interface SkillPackageFileIndex {
  path: string
  sha256: string
  size: number
}
export interface SkillPackageArtifact extends Omit<SkillPackage, 'instructions' | 'files'> {
  artifactRef: string
  instructionsSha256: string
  files: SkillPackageFileIndex[]
}
export interface SkillRequirement {
  type: 'skill' | 'tool' | 'python' | 'external'
  name: string
  status: 'resolved' | 'missing' | 'unsupported' | 'needs_review'
  evidence: string
}
export interface SkillCompatibility {
  status: 'compatible' | 'needs_review' | 'incompatible'
  issues: Array<{ code: string; severity: 'warning' | 'error'; message: string }>
}
export interface SkillBundle {
  root: SkillPackage
  packages: SkillPackage[]
  edges: Array<{ from: string; to: string; type: 'skill' }>
}
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const skillPackageContentHash = (files: SkillPackage['files']) => hash(JSON.stringify(files.map(file => ({
  path: file.path,
  content: file.content,
  size: file.size,
  sha256: file.sha256,
}))))
const decoder = new TextDecoder('utf-8', { fatal: true })
const fail = (message: string, label = 'Skill 包校验失败'): never => { throw Object.assign(new Error(`${label}：${message}`), { status: 422, code: 'skill_package_invalid' }) }

export function toSkillPackageArtifact(pkg: SkillPackage, artifactRef: string): SkillPackageArtifact {
  return {
    name: pkg.name,
    description: pkg.description,
    version: pkg.version,
    toolIds: [...pkg.toolIds],
    files: pkg.files.map(({ path, sha256, size }) => ({ path, sha256, size })),
    sha256: pkg.sha256,
    archiveSha256: pkg.archiveSha256,
    requirements: structuredClone(pkg.requirements),
    compatibility: structuredClone(pkg.compatibility),
    disableModelInvocation: pkg.disableModelInvocation,
    artifactRef,
    instructionsSha256: hash(pkg.instructions),
  }
}

export function parseSkillMarkdown(value: string) {
  return parseEntry(value)
}

export function createSkillPackage(input: {
  name: string
  description: string
  instructions: string
  version: string | null
  toolIds: string[]
}): SkillPackage {
  const allowedTools = input.toolIds.map(reference => reference.split('@')[0]!).filter(Boolean)
  const content = [
    '---',
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
    ...(input.version ? [`version: ${JSON.stringify(input.version)}`] : []),
    ...(allowedTools.length ? [`allowed-tools: ${JSON.stringify(allowedTools)}`] : []),
    '---',
    input.instructions.trim(),
    '',
  ].join('\n')
  const files = [{ path: 'SKILL.md', content, size: Buffer.byteLength(content), sha256: hash(content) }]
  const sha256 = skillPackageContentHash(files)
  return {
    name: input.name,
    description: input.description,
    instructions: input.instructions.trim(),
    version: input.version,
    toolIds: [...input.toolIds],
    files,
    sha256,
    archiveSha256: sha256,
    requirements: [],
    compatibility: { status: 'compatible', issues: [] },
    disableModelInvocation: false,
  }
}

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
    if (!/(?:\.(?:md|txt|json|ya?ml|csv|toml|py)|(?:^|\/)LICENSE(?:\.txt)?)$/i.test(relative)) {
      fail(`暂不支持文件 ${relative}；当前仅接受说明、配置、文本资源与 Python 源文件`)
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
  const requirements = [...metadata.requirements]
  if (packaged.some(file => file.path.endsWith('.py'))) {
    requirements.push({ type: 'python', name: 'python-runtime', status: 'needs_review', evidence: '包中包含 Python 源文件' })
    tools.add('python_execute@1.0.0')
    for (const file of packaged.filter(item => /(?:^|\/)requirements(?:-[A-Za-z0-9._-]+)?\.txt$/i.test(item.path))) {
      for (const line of file.content.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'))) {
        const requirement = line.split(/\s+#/, 1)[0]!
        const safe = requirement.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._-]+\])?(?:\s*(?:===|==|~=|>=|<=|>|<|!=).+)?$/)
        requirements.push({ type: 'external', name: safe ? `python-package:${safe[1]!.toLowerCase()}` : `unsupported-requirement:${requirement.slice(0, 100)}`, status: safe ? 'needs_review' : 'unsupported', evidence: file.path })
      }
    }
    if (packaged.some(file => /(?:^|\/)pyproject\.toml$/i.test(file.path))) requirements.push({ type: 'external', name: 'pyproject-dependencies', status: 'needs_review', evidence: 'pyproject.toml 需要与固定镜像核对' })
  }
  const compatibility = compatibilityFor(requirements)
  return { ...metadata, toolIds: [...tools], files: packaged, requirements, compatibility, archiveSha256: hash(bytes), sha256: skillPackageContentHash(packaged) }
}

/** Resolve same-archive Skill dependencies without executing package content. */
export function parseSkillBundle(bytes: Uint8Array, selected?: string, directory?: string): SkillBundle {
  const root = parseSkillPackage(bytes, selected, directory)
  const packages = new Map<string, SkillPackage>([[root.name, root]])
  const edges: SkillBundle['edges'] = []
  const pending = [root]
  while (pending.length) {
    const current = pending.shift()!
    for (const requirement of current.requirements.filter(item => item.type === 'skill')) {
      let dependency: SkillPackage
      try {
        dependency = parseSkillPackage(bytes, requirement.name)
      } catch {
        requirement.status = 'missing'
        continue
      }
      requirement.status = 'resolved'
      edges.push({ from: current.name, to: dependency.name, type: 'skill' })
      if (!packages.has(dependency.name)) {
        if (packages.size >= 32) fail('一次安装计划最多包含 32 个 Skill')
        packages.set(dependency.name, dependency)
        pending.push(dependency)
      }
    }
    current.compatibility = compatibilityFor(current.requirements)
  }
  return { root, packages: [...packages.values()], edges }
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
  if (!Array.isArray(toolNames) || toolNames.some(value => typeof value !== 'string' || !value.trim())) return fail('allowed-tools 格式无效')
  const requirements: SkillRequirement[] = []
  const supportedTools: string[] = []
  for (const value of toolNames as string[]) {
    const normalized = value.trim().toLowerCase()
    if (['read', 'glob', 'grep'].includes(normalized)) supportedTools.push(normalized)
    else requirements.push({ type: 'tool', name: value.trim(), status: 'unsupported', evidence: 'allowed-tools 声明' })
  }
  const declaredDependencies = metadata['dependencies'] ?? metadata['requires']
  if (declaredDependencies !== undefined) {
    const values = typeof declaredDependencies === 'string' ? [declaredDependencies] : declaredDependencies
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) return fail('dependencies/requires 格式无效')
    if (values.length > 32) return fail('dependencies/requires 最多声明 32 项')
    for (const value of values as string[]) requirements.push({ type: 'external', name: value.trim(), status: 'unsupported', evidence: 'SKILL.md 元数据声明' })
  }
  for (const dependency of inferSkillDependencies(instructions)) {
    requirements.push({ type: 'skill', name: dependency, status: 'needs_review', evidence: 'SKILL.md 正文要求激活其他 Skill' })
  }
  const compatibilityNote = metadata['compatibility']
  if (compatibilityNote !== undefined) {
    if (typeof compatibilityNote !== 'string' || !compatibilityNote.trim() || compatibilityNote.length > 500) return fail('compatibility 格式无效')
    requirements.push({ type: 'external', name: compatibilityNote.trim(), status: 'needs_review', evidence: 'SKILL.md compatibility 声明' })
  }
  const disableModelInvocation = metadata['disable-model-invocation'] ?? false
  if (typeof disableModelInvocation !== 'boolean') return fail('disable-model-invocation 必须是布尔值')
  const version = metadata['version']
  if (version !== undefined && (typeof version !== 'string' || version.length > 80)) return fail('version 格式无效')
  return { name: name.trim(), description: description.trim(), instructions, toolIds: [...new Set(supportedTools)].map(name => `${name}@1.0.0`), version: typeof version === 'string' ? version : null, requirements, disableModelInvocation }
}

function inferSkillDependencies(instructions: string): string[] {
  const names = new Set<string>()
  const patterns = [
    /(?:call|use|activate)\s+(?:the\s+)?skill(?:\s+tool)?\s+(?:with\s+)?["'`]([a-z0-9][a-z0-9._-]{0,79})["'`]/gi,
    /(?:activate_skill|skill)\s*\(\s*["'`]([a-z0-9][a-z0-9._-]{0,79})["'`]\s*\)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of instructions.matchAll(pattern)) if (match[1]) names.add(match[1])
  }
  return [...names]
}

function compatibilityFor(requirements: SkillRequirement[]): SkillCompatibility {
  const issues = requirements.filter(item => item.status !== 'resolved').map(item => ({
    code: `${item.type}_${item.status}`,
    severity: (item.status === 'unsupported' || item.status === 'missing' ? 'error' : 'warning') as 'warning' | 'error',
    message: item.status === 'missing'
      ? `缺少依赖 Skill：${item.name}`
      : item.status === 'unsupported'
        ? `平台暂不支持依赖：${item.name}`
        : `安装前需要检查运行能力：${item.name}`,
  }))
  return { status: issues.some(issue => issue.severity === 'error') ? 'incompatible' : issues.length ? 'needs_review' : 'compatible', issues }
}

export function assertPackagePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || [...path].some(character => character.charCodeAt(0) < 32) || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`不安全的文件路径：${path}`)
}

export function extractZip(bytes: Buffer, specialPaths: Set<string>, label = 'Skill 包校验失败') {
  const files: Record<string, Uint8Array> = Object.create(null)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0) fail('ZIP 目录损坏', label)
  const count = bytes.readUInt16LE(end + 10)
  if (count < 1 || count > 2000 || bytes.readUInt16LE(end + 8) !== count || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('ZIP 文件数量或分卷格式不受支持', label)
  let offset = bytes.readUInt32LE(end + 16), expanded = 0
  const paths = new Set<string>()
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('ZIP 目录无效', label)
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32)
    const next = offset + 46 + nameSize + extraSize + commentSize
    if (next > end) fail('ZIP 目录越界', label)
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameSize))
    assertPackagePath(path.endsWith('/') ? path.slice(0, -1) : path)
    const key = path.replace(/\/$/, '').normalize('NFC').toLowerCase()
    if (paths.has(key)) fail('ZIP 包含重复或冲突路径', label)
    paths.add(key)
    const mode = bytes.readUInt32LE(offset + 38) >>> 16
    if (mode && (mode & 0xf000) !== 0 && ![0x8000, 0x4000].includes(mode & 0xf000)) specialPaths.add(path)
    if (bytes.readUInt16LE(offset + 8) & 1) fail('不支持加密 ZIP', label)
    if (![0, 8].includes(bytes.readUInt16LE(offset + 10))) fail('不支持此 ZIP 压缩方式', label)
    expanded += bytes.readUInt32LE(offset + 24)
    if (expanded > 32 * 1024 * 1024) fail('ZIP 解压总大小超过 32 MB', label)
    const local = bytes.readUInt32LE(offset + 42)
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) fail('ZIP 文件头无效', label)
    const localName = decoder.decode(bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)))
    if (localName !== path) fail('ZIP 文件名不一致', label)
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24)
    if (dataStart + compressed > bytes.readUInt32LE(end + 16)) fail('ZIP 文件数据越界', label)
    const raw = bytes.subarray(dataStart, dataStart + compressed)
    const content = bytes.readUInt16LE(offset + 10) === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) })
    if (content.length !== size || crc32(content) !== bytes.readUInt32LE(offset + 16)) fail('ZIP 内容大小或 CRC 校验不匹配', label)
    files[path] = content
    offset = next
  }
  if (offset !== end) fail('不支持 ZIP64 或扩展目录', label)
  return files
}
