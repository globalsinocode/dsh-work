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
 *
 * 扁平清单字段规则（agent.yaml）：
 *   受支持字段（含别名）：id；name/display_name；version；description；
 *   system_prompt；system_prompt_file/prompt_file；welcome_message；example_prompts；
 *   visible_role_ids/role_ids；data_scopes；max_tokens（默认 12000，1024~32768）；
 *   timeout_seconds（默认 300，30~600）；allow_workspace_join（默认 false）；
 *   skills/skill_refs；tools/tool_refs；evals/cases_file。
 *   - 同一字段的多个别名并存：取值一致给警告，取值不一致直接拒绝。
 *   - system_prompt 与 system_prompt_file 并存：内容一致给警告，不一致拒绝。
 *   - 未识别字段给警告并忽略；apiVersion/spec 结构清单明确拒绝。
 *   - 身份、凭据、端点、模型路由、执行环境、外部能力接入等平台受管字段直接拒绝。
 *   - 依赖引用为 id 或 id@x.y.z；空条目、残缺引用、同 id 多版本均拒绝；
 *     声明版本与包内候选版本冲突拒绝（不再警告后覆盖）。
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
// 与配置入口 assertConfiguration 共用同一标识规则；发布检查复用此常量避免口径漂移
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,47}$/
// 严格 x.y.z：版本排序 SQL 用 split_part(version,'.',3)::integer，预发布/构建后缀会导致转换失败
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
// 依赖引用的能力标识：与包内 skills/、tools/ 目录及平台能力 ID 字符集一致
const DEP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/
const CASE_KINDS = new Set(['success', 'invalid_input', 'permission_denied'])
const decoder = new TextDecoder('utf-8', { fatal: true })

/** agent.yaml 顶层受支持字段（含全部别名）。 */
const KNOWN_MANIFEST_KEYS = new Set([
  'id', 'name', 'display_name', 'version', 'description',
  'system_prompt', 'system_prompt_file', 'prompt_file',
  'welcome_message', 'example_prompts',
  'visible_role_ids', 'role_ids', 'data_scopes',
  'max_tokens', 'timeout_seconds', 'allow_workspace_join',
  'skills', 'skill_refs', 'tools', 'tool_refs',
  'evals', 'cases_file',
])

/** 目标格式草案的顶层标记：当前不支持，单独给出可读错误而不是按未知字段忽略。 */
const STRUCTURED_MANIFEST_KEYS = new Set(['apiVersion', 'api_version', 'spec'])

/**
 * 平台受管字段：包内声明这些字段若被静默忽略即构成安全/能力语义漂移，直接拒绝。
 * key 为小写字段名（匹配时对清单键做小写归一）。
 */
const RESERVED_MANIFEST_KEYS: Record<string, string> = {
  // 模型与路由
  model: '模型路由由平台管理', provider: '模型路由由平台管理', model_route: '模型路由由平台管理', llm: '模型路由由平台管理',
  // 端点与连接
  endpoint: '服务端点由平台绑定管理', base_url: '服务端点由平台绑定管理', api_base: '服务端点由平台绑定管理',
  server_url: '服务端点由平台绑定管理', host: '服务端点由平台绑定管理', url: '服务端点由平台绑定管理',
  upstream: '服务端点由平台绑定管理', proxy: '网络出口由平台治理', headers: '连接配置由平台绑定管理',
  // 凭据、密钥与环境变量
  api_key: '凭据由平台受管槽位注入', apikey: '凭据由平台受管槽位注入', credential: '凭据由平台受管槽位注入',
  credentials: '凭据由平台受管槽位注入', secret: '凭据由平台受管槽位注入', secrets: '凭据由平台受管槽位注入',
  token: '凭据由平台受管槽位注入', auth_token: '凭据由平台受管槽位注入', bearer_token: '凭据由平台受管槽位注入',
  password: '凭据由平台受管槽位注入', private_key: '凭据由平台受管槽位注入', signing_key: '凭据由平台受管槽位注入',
  access_key: '凭据由平台受管槽位注入', client_secret: '凭据由平台受管槽位注入',
  env: '环境变量由平台受管注入', environment: '环境变量由平台受管注入',
  // 认证与会话
  auth: '认证方式由平台绑定管理', authentication: '认证方式由平台绑定管理', oauth: '认证方式由平台绑定管理',
  jwt: '认证方式由平台绑定管理', session: '认证方式由平台绑定管理', cookie: '认证方式由平台绑定管理',
  // 外部能力接入
  mcp: '外部能力须经平台准入流程接入', mcp_servers: '外部能力须经平台准入流程接入', mcpservers: '外部能力须经平台准入流程接入',
  registry: '外部能力须经平台准入流程接入',
  // 身份与授权
  identity: '执行身份由平台解析', execution_identity: '执行身份由平台解析', run_as: '执行身份由平台解析',
  impersonate: '执行身份由平台解析', tenant_id: '租户身份由平台决定',
  permissions: '授权范围由平台治理', grants: '授权范围由平台治理', allowlist: '能力准入由平台治理', allow_list: '能力准入由平台治理',
  // 绑定与执行环境
  binding: '绑定修订由平台发布流程固定', bindings: '绑定修订由平台发布流程固定',
  runtime: '执行环境由平台 Runtime 决定', executor: '执行环境由平台 Runtime 决定', sandbox: '执行环境由平台 Runtime 决定',
  network: '网络范围由平台治理', egress: '网络范围由平台治理',
  // 执行入口与安装钩子（AS-02：包导入不执行安装钩子）
  command: '执行入口由平台 Runtime 决定', entrypoint: '执行入口由平台 Runtime 决定', script: '执行入口由平台 Runtime 决定',
  exec: '执行入口由平台 Runtime 决定', shell: '执行入口由平台 Runtime 决定',
  hooks: '安装钩子不由包执行', install: '安装钩子不由包执行', postinstall: '安装钩子不由包执行',
}

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

function parseYamlValue(files: Record<string, Uint8Array>, path: string): unknown {
  const text = readText(files, path)
  if (text === undefined) fail(`缺少文件 ${path}`)
  const document = parseDocument(text!, { uniqueKeys: true })
  if (document.errors.length) fail(`${path} 不是有效的 YAML：${document.errors[0]!.message}`)
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 0 })
  } catch (cause) {
    fail(`${path} 不是有效的 YAML：${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (document.errors.length) fail(`${path} 不是有效的 YAML：${document.errors[0]!.message}`)
  return value
}

function parseYamlFile(files: Record<string, Uint8Array>, path: string): Record<string, unknown> {
  const value = parseYamlValue(files, path)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} 顶层必须是对象`)
  return value as Record<string, unknown>
}

/** 别名并存比较值：列表按元素集合比较（元素顺序不视为冲突），其余按 JSON 序列化比较。 */
const aliasCompareKey = (value: unknown): string =>
  Array.isArray(value) ? JSON.stringify([...value].sort()) : JSON.stringify(value)

/** 同一字段多个别名并存：取值一致警告、不一致拒绝（仅传入 warnings 的调用点启用）。 */
function reportAliasCoexistence(found: Array<{ key: string; value: unknown }>, warnings: string[] | undefined) {
  if (!warnings || found.length < 2) return
  const keys = found.map(item => item.key).join(' 与 ')
  if (new Set(found.map(item => aliasCompareKey(item.value))).size > 1) {
    fail(`字段 ${keys} 为同一字段的别名，同时声明且取值不一致，请保留其一`)
  }
  warnings.push(`字段 ${keys} 重复声明相同取值，请保留其一`)
}

function stringField(source: Record<string, unknown>, keys: string[], { required = false, max = 2000 } = {}, warnings?: string[]): string {
  const found: Array<{ key: string; value: string }> = []
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') fail(`字段 ${key} 必须是字符串`)
    const text = (value as string).trim()
    if (text.length > max) fail(`字段 ${key} 长度不能超过 ${max} 个字符`)
    found.push({ key, value: text })
  }
  reportAliasCoexistence(found, warnings)
  if (found.length) return found[0]!.value
  if (required) fail(`缺少必填字段 ${keys[0]}`)
  return ''
}

function stringListField(source: Record<string, unknown>, keys: string[], max = 64, warnings?: string[]): string[] {
  const found: Array<{ key: string; value: string[] }> = []
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    const items: unknown = typeof value === 'string' ? [value] : value
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string' || !item.trim())) {
      fail(`字段 ${key} 必须是字符串数组`)
    }
    const list = items as string[]
    if (list.length > max) fail(`字段 ${key} 最多 ${max} 项`)
    found.push({ key, value: list.map(item => item.trim()).filter(Boolean) })
  }
  reportAliasCoexistence(found, warnings)
  return found[0]?.value ?? []
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

function depRefId(reference: string) {
  const separator = reference.lastIndexOf('@')
  return separator >= 0 ? reference.slice(0, separator) : reference
}

function depRefVersion(reference: string) {
  const separator = reference.lastIndexOf('@')
  return separator >= 0 ? reference.slice(separator + 1) : ''
}

/** 单条声明引用：归一化为 `id` 或 `id@x.y.z`；空条目、残缺引用、非法字符与非法版本在此拒绝。 */
function normalizeDeclaredRef(item: unknown, key: string, index: number, warnings: string[]): string {
  let reference: string
  if (typeof item === 'string') reference = item.trim()
  else if (item && typeof item === 'object' && !Array.isArray(item)) {
    const entry = item as Record<string, unknown>
    const id = stringField(entry, ['id', 'name'], { required: true, max: 80 }, warnings)
    const version = stringField(entry, ['version'], { max: 80 }, warnings)
    reference = version ? `${id}@${version}` : id
  } else {
    return fail(`字段 ${key} 的条目必须是字符串或 { id, version } 对象`)
  }
  if (!reference) return fail(`字段 ${key} 第 ${index + 1} 条为空`)
  const id = depRefId(reference)
  const separator = reference.lastIndexOf('@')
  if (!DEP_ID_PATTERN.test(id)) fail(`字段 ${key} 的依赖引用「${reference}」能力标识无效，须匹配 ${DEP_ID_PATTERN.source}`)
  if (separator >= 0) {
    const version = depRefVersion(reference)
    if (!version) fail(`字段 ${key} 的依赖引用「${reference}」缺少版本号`)
    if (!VERSION_PATTERN.test(version)) fail(`字段 ${key} 的依赖引用「${reference}」的版本必须是 x.y.z 形式`)
  }
  return reference
}

/** 同一字段内同一能力的多条声明：完全一致去重并警告，版本/写法不同拒绝。 */
function dedupeDeclaredRefs(references: string[], key: string, warnings: string[]): string[] {
  const byId = new Map<string, Set<string>>()
  for (const reference of references) {
    const id = depRefId(reference)
    const variants = byId.get(id) ?? new Set<string>()
    variants.add(reference)
    byId.set(id, variants)
  }
  for (const [id, variants] of byId) {
    if (variants.size > 1) {
      fail(`字段 ${key} 中 ${id} 声明了多个不同版本（${[...variants].join('、')}），同一能力只能声明一个版本`)
    }
  }
  const unique = [...new Set(references)]
  if (unique.length !== references.length) {
    warnings.push(`字段 ${key} 存在 ${references.length - unique.length} 条重复声明，已去重`)
  }
  return unique
}

/** 声明依赖字段（含别名）：字符串 `id`/`id@version` 数组，或 { id, version? } 对象数组。 */
function declaredReferences(source: Record<string, unknown>, keys: string[], warnings: string[]): string[] {
  const found: Array<{ key: string; value: string[] }> = []
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) fail(`字段 ${key} 必须是数组`)
    found.push({ key, value: (value as unknown[]).map((item, index) => normalizeDeclaredRef(item, key, index, warnings)) })
  }
  reportAliasCoexistence(found, warnings)
  return dedupeDeclaredRefs(found[0]?.value ?? [], found[0]?.key ?? keys[0]!, warnings)
}

/** 顶层字段政策：结构化清单标记与平台受管字段拒绝，未识别字段警告后忽略。 */
function assertManifestFieldPolicy(manifest: Record<string, unknown>, warnings: string[]) {
  const structured = Object.keys(manifest).filter(key => STRUCTURED_MANIFEST_KEYS.has(key))
  if (structured.length) {
    fail(`检测到 ${structured.join('、')} 结构清单字段，当前仅支持扁平 agent.yaml 格式（id/name/version/description + system_prompt 等顶层字段），结构化格式待平台单独支持`)
  }
  const reserved = Object.keys(manifest)
    .map(key => ({ key, reason: RESERVED_MANIFEST_KEYS[key.toLowerCase()] }))
    .filter((item): item is { key: string; reason: string } => Boolean(item.reason))
  if (reserved.length) {
    fail(`agent.yaml 包含平台受管字段：${reserved.map(item => `${item.key}（${item.reason}）`).join('、')}；发布包不支持声明此类字段，请移除后重新打包`)
  }
  const unknown = Object.keys(manifest).filter(key => !KNOWN_MANIFEST_KEYS.has(key))
  if (unknown.length) {
    warnings.push(`agent.yaml 未识别字段已忽略：${unknown.join('、')}；身份、凭据、端点、模型路由、执行环境与外部能力等平台受管项不支持由包声明`)
  }
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

function parseCases(files: Record<string, Uint8Array>, rootDir: string, declaredPath: string | undefined, warnings: string[]): AgentPackageCase[] {
  const path = declaredPath ?? 'evals/cases.yaml'
  const full = `${rootDir}${path}`
  if (!files[full]) return []
  const value = parseYamlValue(files, full)
  const items: unknown = Array.isArray(value) ? value : (value as Record<string, unknown> | null)?.['cases']
  if (!Array.isArray(items)) fail(`${path} 必须是案例数组或含 cases 数组的对象`)
  return (items as unknown[]).map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${path} 第 ${index + 1} 个案例必须是对象`)
    const entry = item as Record<string, unknown>
    const name = stringField(entry, ['name'], { required: true, max: 120 }, warnings)
    const kind = stringField(entry, ['kind', 'type'], { required: true, max: 40 }, warnings)
    if (!CASE_KINDS.has(kind)) fail(`${path} 第 ${index + 1} 个案例 kind 必须是 success / invalid_input / permission_denied`)
    const input = stringField(entry, ['input'], { required: true, max: 8000 }, warnings)
    const expect = stringField(entry, ['expect', 'expected'], { required: true, max: 4000 }, warnings)
    return { name, kind: kind as AgentPackageCase['kind'], input, expect }
  })
}

export function parseAgentPackage(bytes: Uint8Array): AgentPackageParseResult {
  if (bytes.length > 20 * 1024 * 1024) fail('发布包超过 20 MB')
  const buffer = Buffer.from(bytes)
  if (buffer.length < 2 || buffer.readUInt16LE(0) !== 0x4b50) fail('仅支持 ZIP 格式的 Agent 发布包')
  const specialPaths = new Set<string>()
  const allFiles = extractZip(buffer, specialPaths, LABEL)
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
  const warnings: string[] = []
  assertManifestFieldPolicy(manifest, warnings)
  const id = stringField(manifest, ['id'], { required: true, max: 48 }, warnings)
  if (!AGENT_ID_PATTERN.test(id)) fail('agent.yaml 的 id 必须匹配 ^[a-z][a-z0-9-]{2,47}$')
  const name = stringField(manifest, ['name', 'display_name'], { required: true, max: 80 }, warnings)
  const version = stringField(manifest, ['version'], { required: true, max: 40 }, warnings)
  if (!VERSION_PATTERN.test(version)) fail('agent.yaml 的 version 必须是 x.y.z 形式')
  const description = stringField(manifest, ['description'], { required: true, max: 2000 }, warnings)

  let systemPrompt = stringField(manifest, ['system_prompt'], { max: 100000 }, warnings)
  const promptFile = stringField(manifest, ['system_prompt_file', 'prompt_file'], { max: 200 }, warnings)
  if (promptFile) {
    const content = readText(files, `${rootDir}${promptFile}`)
    if (content === undefined) fail(`system_prompt_file 指定的 ${promptFile} 不存在`)
    const filePrompt = (content as string).trim()
    if (systemPrompt && systemPrompt !== filePrompt) {
      fail('system_prompt 与 system_prompt_file 同时声明且内容不一致，请保留其一')
    }
    if (systemPrompt) warnings.push('system_prompt 与 system_prompt_file 声明了相同内容，请保留其一')
    systemPrompt = filePrompt
  }
  if (systemPrompt.length < 20) fail('系统提示词至少 20 个字符（system_prompt 或 system_prompt_file）')

  const checksumsVerified = verifyChecksums(files, rootDir, warnings)

  // 包内候选：skills/<dir>/SKILL.md 与 tools/<dir>/tool.yaml。
  const packageSkills: AgentPackageCapabilityRef[] = []
  const packageTools: AgentPackageCapabilityRef[] = []
  const skillDirs = new Map<string, string>()
  const toolDirs = new Map<string, string>()
  const orphanSkillDirs = new Set<string>()
  const orphanToolDirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const rel = path.slice(rootDir.length)
    const skillMatch = rel.match(/^skills\/([a-z0-9][a-z0-9-]{0,79})\/SKILL\.md$/)
    if (skillMatch) skillDirs.set(skillMatch[1]!, path)
    const toolMatch = rel.match(/^tools\/([a-z0-9][a-z0-9._-]{0,79})\/tool\.yaml$/)
    if (toolMatch) toolDirs.set(toolMatch[1]!, path)
    const orphanSkill = rel.match(/^skills\/([^/]+)\//)
    if (orphanSkill && !skillMatch) orphanSkillDirs.add(orphanSkill[1]!)
    const orphanTool = rel.match(/^tools\/([^/]+)\//)
    if (orphanTool && !toolMatch) orphanToolDirs.add(orphanTool[1]!)
  }
  for (const dir of [...orphanSkillDirs].filter(dir => !skillDirs.has(dir)).sort()) {
    warnings.push(`skills/${dir}/ 缺少 SKILL.md，未登记为包内 Skill 候选`)
  }
  for (const dir of [...orphanToolDirs].filter(dir => !toolDirs.has(dir)).sort()) {
    warnings.push(`tools/${dir}/ 缺少 tool.yaml，未登记为包内 Tool 候选`)
  }
  for (const [dirName, path] of skillDirs) {
    const parsed = parseSkillMarkdown(readText(files, path)!)
    packageSkills.push({ id: dirName, version: parsed.version ?? version, path: path.slice(0, path.length - 'SKILL.md'.length).slice(rootDir.length).replace(/\/$/, '') })
  }
  for (const [dirName, path] of toolDirs) {
    const descriptor = parseYamlFile(files, path)
    // 描述符 id/name 为规范能力标识（可与目录名不同），缺省回退目录名；两者均须符合依赖标识规则。
    const toolId = stringField(descriptor, ['id', 'name'], { max: 80 }) || dirName
    if (!DEP_ID_PATTERN.test(toolId)) {
      fail(`tools/${dirName}/tool.yaml 的 id「${toolId}」不符合能力标识规则 ${DEP_ID_PATTERN.source}`)
    }
    const toolVersion = stringField(descriptor, ['version'], { max: 40 }) || version
    if (!VERSION_PATTERN.test(toolVersion)) fail(`tools/${dirName}/tool.yaml 的 version 必须是 x.y.z 形式`)
    packageTools.push({ id: toolId, version: toolVersion, path: `tools/${dirName}` })
  }

  const declared = {
    skills: declaredReferences(manifest, ['skills', 'skill_refs'], warnings),
    tools: declaredReferences(manifest, ['tools', 'tool_refs'], warnings),
  }
  // 声明条目与包内目录同名时视为包内提供，不再走平台解析；声明版本与包内
  // 候选版本不一致属于作者需要修正的冲突，不再静默覆盖为包内版本。
  const consumeDeclared = (references: string[], provided: AgentPackageCapabilityRef[], kind: 'Skill' | 'Tool') => {
    // 包内能力 id 必须唯一：tool.yaml 的 id 可与目录名不同，两个目录声明同一 id 时
    // Map 会静默覆盖，必须显式拒绝而不是让后写者胜出。
    const byId = new Map<string, AgentPackageCapabilityRef>()
    for (const item of provided) {
      const existing = byId.get(item.id)
      if (existing) {
        fail(`包内 ${kind} 能力 id「${item.id}」重复声明（${existing.path} 与 ${item.path}），同一包内能力标识必须唯一`)
      }
      byId.set(item.id, item)
    }
    const remaining: string[] = []
    for (const reference of references) {
      const match = byId.get(depRefId(reference))
      if (!match) {
        remaining.push(reference)
        continue
      }
      const wanted = depRefVersion(reference)
      if (wanted && wanted !== match.version) {
        fail(`声明的 ${kind} ${reference} 与包内 ${kind === 'Skill' ? 'skills' : 'tools'}/${match.id} 候选版本 ${match.version} 冲突，请修正声明版本或包内版本后重新打包`)
      }
    }
    return remaining
  }
  declared.skills = consumeDeclared(declared.skills, packageSkills, 'Skill')
  declared.tools = consumeDeclared(declared.tools, packageTools, 'Tool')

  const casesPath = stringField(manifest, ['evals', 'cases_file'], { max: 200 }, warnings) || undefined
  const cases = parseCases(files, rootDir, casesPath, warnings)

  return {
    rootDir,
    manifest: { id, name, version, description },
    definition: {
      systemPrompt,
      welcomeMessage: stringField(manifest, ['welcome_message'], { max: 2000 }, warnings),
      examplePrompts: stringListField(manifest, ['example_prompts'], 8, warnings),
      roleIds: stringListField(manifest, ['visible_role_ids', 'role_ids'], 32, warnings),
      dataScopes: stringListField(manifest, ['data_scopes'], 32, warnings),
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
