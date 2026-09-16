import { parseDocument } from 'yaml'

import { extractZip, hash, parseSkillMarkdown } from '../skill/skill-package.ts'

/**
 * Agent 发布包（ZIP）服务端解包与清单解析。
 * 约定结构（允许全部文件包在唯一一层顶层目录下）：
 *   agent.yaml            必填清单：id/name/version/description + 声明依赖 + 运行限制
 *   prompts/system.md     system_prompt_file 指定的提示词文件（也可用 system_prompt 内联）
 *   skills/<name>/SKILL.md  包内新 Skill 候选（走联合发布）
 *   tools/<name>/tool.yaml  包内新 Tool 候选（走准入流水线）
 *   evals/cases.yaml        试运行案例（缺省时由系统按定义生成默认案例）
 *   checksums.json          { "相对路径": "sha256" }，列出的文件逐一校验
 */

export interface AgentPackageCapabilityRef { id: string; version: string; path: string }

export interface AgentPackageCase {
  name: string
  kind: 'success' | 'invalid_input' | 'permission_denied'
  input: string
  expect: string
}

export interface AgentPackageParseResult {
  rootDir: string
  manifest: { id: string; name: string; version: string; description: string }
  definition: {
    systemPrompt: string
    welcomeMessage: string
    examplePrompts: string[]
    roleIds: string[]
    dataScopes: string[]
    maxTokens: number
    timeoutSeconds: number
    allowWorkspaceJoin: boolean
  }
  /** agent.yaml 声明的依赖引用（id 或 id@version），包内同名项除外时由服务层解析。 */
  declared: { skills: string[]; tools: string[] }
  packageRefs: { skills: AgentPackageCapabilityRef[]; tools: AgentPackageCapabilityRef[] }
  cases: AgentPackageCase[]
  files: Record<string, Uint8Array>
  checksumsVerified: boolean
  warnings: string[]
}

const LABEL = 'Agent 包校验失败'
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,47}$/
// 严格 x.y.z：版本排序 SQL 用 split_part(version,'.',3)::integer，预发布/构建后缀会导致转换失败
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const CASE_KINDS = new Set(['success', 'invalid_input', 'permission_denied'])
const decoder = new TextDecoder('utf-8', { fatal: true })

const fail = (message: string): never => {
  throw Object.assign(new Error(`${LABEL}：${message}`), { status: 422, code: 'agent_package_invalid' })
}

function readText(files: Record<string, Uint8Array>, path: string): string | undefined {
  const content = files[path]
  if (!content) return undefined
  try {
    return decoder.decode(content)
  } catch {
    fail(`文件 ${path} 不是有效的 UTF-8 文本`)
  }
}

function parseYamlFile(files: Record<string, Uint8Array>, path: string): Record<string, unknown> {
  const text = readText(files, path)
  if (text === undefined) fail(`缺少文件 ${path}`)
  const document = parseDocument(text!, { uniqueKeys: true })
  if (document.errors.length) fail(`${path} 不是有效的 YAML：${document.errors[0]!.message}`)
  const value = document.toJS({ maxAliasCount: 0 })
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} 顶层必须是对象`)
  return value as Record<string, unknown>
}

function stringField(source: Record<string, unknown>, keys: string[], { required = false, max = 2000 } = {}): string {
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') fail(`字段 ${key} 必须是字符串`)
    const text = (value as string).trim()
    if (text.length > max) fail(`字段 ${key} 长度不能超过 ${max} 个字符`)
    return text
  }
  if (required) fail(`缺少必填字段 ${keys[0]}`)
  return ''
}

function stringListField(source: Record<string, unknown>, keys: string[], max = 64): string[] {
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    const items: unknown = typeof value === 'string' ? [value] : value
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string' || !item.trim())) {
      fail(`字段 ${key} 必须是字符串数组`)
    }
    const list = items as string[]
    if (list.length > max) fail(`字段 ${key} 最多 ${max} 项`)
    return list.map(item => item.trim()).filter(Boolean)
  }
  return []
}

function numberField(source: Record<string, unknown>, keys: string[], fallback: number, min: number, max: number): number {
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`字段 ${key} 必须是数字`)
    const num = value as number
    if (num < min || num > max) fail(`字段 ${key} 需在 ${min}～${max} 之间`)
    return Math.floor(num)
  }
  return fallback
}

/** 声明依赖条目：字符串 `id`/`id@version`，或对象 { id, version? }。 */
function declaredReferences(source: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) fail(`字段 ${key} 必须是数组`)
    return (value as unknown[]).map((item: unknown): string => {
      if (typeof item === 'string') return item.trim()
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>
        const id = stringField(entry, ['id', 'name'], { required: true, max: 80 })
        const version = stringField(entry, ['version'], { max: 80 })
        return version ? `${id}@${version}` : id
      }
      return fail(`字段 ${key} 的条目必须是字符串或 { id, version } 对象`)
    }).filter(Boolean)
  }
  return []
}

function verifyChecksums(files: Record<string, Uint8Array>, rootDir: string, warnings: string[]): boolean {
  const text = readText(files, `${rootDir}checksums.json`)
  if (text === undefined) {
    warnings.push('包内无 checksums.json，未做文件摘要校验')
    return false
  }
  let table: unknown
  try {
    table = JSON.parse(text)
  } catch {
    return fail('checksums.json 不是有效的 JSON')
  }
  if (!table || typeof table !== 'object' || Array.isArray(table)) fail('checksums.json 必须是对象')
  const record = table as Record<string, unknown>
  const nested = record['files']
  const entries = (nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : record) as Record<string, unknown>
  // 摘要表必须恰好覆盖包内全部文件（自身除外）：缺条目或多余条目都视为无效。
  const uncovered = new Set(
    Object.keys(files)
      .filter(path => path !== `${rootDir}checksums.json`)
      .map(path => path.slice(rootDir.length)),
  )
  for (const [rawPath, expected] of Object.entries(entries)) {
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) fail(`checksums.json 中 ${rawPath} 的摘要格式无效`)
    const path = rawPath.startsWith(rootDir) ? rawPath : `${rootDir}${rawPath}`
    const content = files[path]
    if (!content) fail(`checksums.json 列出的 ${rawPath} 在包内不存在`)
    if (hash(content) !== (expected as string).toLowerCase()) fail(`文件 ${rawPath} 摘要与 checksums.json 不一致`)
    uncovered.delete(rawPath.startsWith(rootDir) ? rawPath.slice(rootDir.length) : rawPath)
  }
  if (uncovered.size) fail(`checksums.json 未覆盖全部文件，缺少：${[...uncovered].sort().join('、')}`)
  return true
}

function parseCases(files: Record<string, Uint8Array>, rootDir: string, declaredPath?: string): AgentPackageCase[] {
  const path = declaredPath ?? 'evals/cases.yaml'
  const full = `${rootDir}${path}`
  if (!files[full]) return []
  const document = parseDocument(readText(files, full)!, { uniqueKeys: true })
  if (document.errors.length) fail(`${path} 不是有效的 YAML：${document.errors[0]!.message}`)
  const value = document.toJS({ maxAliasCount: 0 })
  const items: unknown = Array.isArray(value) ? value : (value as Record<string, unknown> | null)?.['cases']
  if (!Array.isArray(items)) fail(`${path} 必须是案例数组或含 cases 数组的对象`)
  return (items as unknown[]).map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${path} 第 ${index + 1} 个案例必须是对象`)
    const entry = item as Record<string, unknown>
    const name = stringField(entry, ['name'], { required: true, max: 120 })
    const kind = stringField(entry, ['kind', 'type'], { required: true, max: 40 })
    if (!CASE_KINDS.has(kind)) fail(`${path} 第 ${index + 1} 个案例 kind 必须是 success / invalid_input / permission_denied`)
    const input = stringField(entry, ['input'], { required: true, max: 8000 })
    const expect = stringField(entry, ['expect', 'expected'], { required: true, max: 4000 })
    return { name, kind: kind as AgentPackageCase['kind'], input, expect }
  })
}

export function parseAgentPackage(bytes: Uint8Array): AgentPackageParseResult {
  if (bytes.length > 20 * 1024 * 1024) fail('发布包超过 20 MB')
  if (bytes.length < 2 || Buffer.from(bytes).readUInt16LE(0) !== 0x4b50) fail('仅支持 ZIP 格式的 Agent 发布包')
  const specialPaths = new Set<string>()
  const allFiles = extractZip(Buffer.from(bytes), specialPaths, LABEL)
  if (specialPaths.size) fail('包内包含不支持的设备或链接文件')
  const files: Record<string, Uint8Array> = Object.create(null)
  for (const [path, content] of Object.entries(allFiles)) {
    if (!path.endsWith('/')) files[path] = content
  }

  // 允许清单位于根目录或唯一一层顶层目录下。
  let rootDir = ''
  if (!files['agent.yaml']) {
    const candidates = Object.keys(files)
      .filter(path => path.endsWith('/agent.yaml') && path.split('/').length === 2)
      .map(path => path.slice(0, path.length - 'agent.yaml'.length))
    if (candidates.length !== 1) fail('包内未找到唯一的 agent.yaml 清单')
    rootDir = candidates[0]!
  }

  const manifest = parseYamlFile(files, `${rootDir}agent.yaml`)
  const id = stringField(manifest, ['id'], { required: true, max: 48 })
  if (!AGENT_ID_PATTERN.test(id)) fail('agent.yaml 的 id 必须匹配 ^[a-z][a-z0-9-]{2,47}$')
  const name = stringField(manifest, ['name', 'display_name'], { required: true, max: 80 })
  const version = stringField(manifest, ['version'], { required: true, max: 40 })
  if (!VERSION_PATTERN.test(version)) fail('agent.yaml 的 version 必须是 x.y.z 形式')
  const description = stringField(manifest, ['description'], { required: true, max: 2000 })

  let systemPrompt = stringField(manifest, ['system_prompt'], { max: 100000 })
  const promptFile = stringField(manifest, ['system_prompt_file', 'prompt_file'], { max: 200 })
  if (promptFile) {
    const content = readText(files, `${rootDir}${promptFile}`)
    if (content === undefined) fail(`system_prompt_file 指定的 ${promptFile} 不存在`)
    systemPrompt = (content as string).trim()
  }
  if (systemPrompt.length < 20) fail('系统提示词至少 20 个字符（system_prompt 或 system_prompt_file）')

  const warnings: string[] = []
  const checksumsVerified = verifyChecksums(files, rootDir, warnings)

  // 包内候选：skills/<dir>/SKILL.md 与 tools/<dir>/tool.yaml。
  const packageSkills: AgentPackageCapabilityRef[] = []
  const packageTools: AgentPackageCapabilityRef[] = []
  const skillDirs = new Map<string, string>()
  const toolDirs = new Map<string, string>()
  for (const path of Object.keys(files)) {
    const skillMatch = path.slice(rootDir.length).match(/^skills\/([a-z0-9][a-z0-9-]{0,79})\/SKILL\.md$/)
    if (skillMatch) skillDirs.set(skillMatch[1]!, path)
    const toolMatch = path.slice(rootDir.length).match(/^tools\/([a-z0-9][a-z0-9._-]{0,79})\/tool\.yaml$/)
    if (toolMatch) toolDirs.set(toolMatch[1]!, path)
  }
  for (const [dirName, path] of skillDirs) {
    const parsed = parseSkillMarkdown(readText(files, path)!)
    packageSkills.push({ id: dirName, version: parsed.version ?? version, path: path.slice(0, path.length - 'SKILL.md'.length).slice(rootDir.length).replace(/\/$/, '') })
  }
  for (const [dirName, path] of toolDirs) {
    const descriptor = parseYamlFile(files, path)
    const toolId = stringField(descriptor, ['id', 'name'], { max: 80 }) || dirName
    const toolVersion = stringField(descriptor, ['version'], { max: 40 }) || version
    if (!VERSION_PATTERN.test(toolVersion)) fail(`tools/${dirName}/tool.yaml 的 version 必须是 x.y.z 形式`)
    packageTools.push({ id: toolId, version: toolVersion, path: `tools/${dirName}` })
  }

  const declared = {
    skills: declaredReferences(manifest, ['skills', 'skill_refs']),
    tools: declaredReferences(manifest, ['tools', 'tool_refs']),
  }
  // 声明条目与包内目录同名时视为包内提供，不再走平台解析。
  const refId = (reference: string) => {
    const separator = reference.lastIndexOf('@')
    return separator > 0 ? reference.slice(0, separator) : reference
  }
  const refVersion = (reference: string) => {
    const separator = reference.lastIndexOf('@')
    return separator > 0 ? reference.slice(separator + 1) : ''
  }
  const consumeDeclared = (references: string[], provided: AgentPackageCapabilityRef[], kind: 'Skill' | 'Tool') => {
    const byId = new Map(provided.map(item => [item.id, item]))
    return references.filter((reference) => {
      const match = byId.get(refId(reference))
      if (!match) return true
      const wanted = refVersion(reference)
      if (wanted && wanted !== match.version) {
        warnings.push(`声明的 ${kind} ${reference} 与包内版本 ${match.version} 不一致，以包内版本为准`)
      }
      return false
    })
  }
  declared.skills = consumeDeclared(declared.skills, packageSkills, 'Skill')
  declared.tools = consumeDeclared(declared.tools, packageTools, 'Tool')

  const casesPath = stringField(manifest, ['evals', 'cases_file'], { max: 200 }) || undefined
  const cases = parseCases(files, rootDir, casesPath)

  return {
    rootDir,
    manifest: { id, name, version, description },
    definition: {
      systemPrompt,
      welcomeMessage: stringField(manifest, ['welcome_message'], { max: 2000 }),
      examplePrompts: stringListField(manifest, ['example_prompts'], 8),
      roleIds: stringListField(manifest, ['visible_role_ids', 'role_ids'], 32),
      dataScopes: stringListField(manifest, ['data_scopes'], 32),
      maxTokens: numberField(manifest, ['max_tokens'], 12000, 1024, 32768),
      timeoutSeconds: numberField(manifest, ['timeout_seconds'], 300, 30, 600),
      allowWorkspaceJoin: manifest['allow_workspace_join'] === true,
    },
    declared,
    packageRefs: { skills: packageSkills, tools: packageTools },
    cases,
    files,
    checksumsVerified,
    warnings,
  }
}
