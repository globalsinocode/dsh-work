import { parseDocument } from 'yaml'

import { extractZip, hash, parseSkillMarkdown } from '../skill/skill-package.ts'
import {
  AGENT_SPEC_API_VERSION,
  AGENT_SPEC_LIMITS_DEFAULT,
  assertAgentSpecContent,
  type AgentModelRequirement,
  type AgentSpec,
} from './agent-spec.ts'
import { manifestSchemaErrors, type AgentPackageManifestDocument } from './agent-package.schema.ts'

/**
 * Agent 发布包（ZIP）服务端解包与清单解析。
 * 约定结构（允许全部文件包在唯一一层顶层目录下）：
 *   agent.yaml            必填清单：apiVersion/kind/metadata/spec 分层结构
 *   SOUL.md               spec.instructions 唯一指定的根目录指令文件
 *   skills/<name>/SKILL.md  包内新 Skill 候选（走联合发布）
 *   tools/<name>/tool.yaml  包内新 Tool 候选（走准入流水线）
 *   evals/cases.yaml        试运行案例（缺省时由系统按定义生成默认案例）
 *   checksums.json          { "相对路径": "sha256" }，列出的文件逐一校验；
 *                         仅证明文件完整性，不构成信任、授权或来源证明
 *
 * 清单格式规则（agent.yaml，由 agent-package.schema.ts 严格校验）：
 *   apiVersion: dsh-work.ai/v2；kind: AgentPackage；
 *   metadata: { id, name, version, description }；spec 唯一入口：
 *   instructions（必填，固定引用包根目录 SOUL.md）、capabilities.skills/tools
 *   （{ id, version } 对象数组，version 必须精确 x.y.z）、input/output/context、
 *   catalog、limits、evaluation、model.requirements。
 *   - 未知字段、旧扁平字段、旧别名一律拒绝；YAML 重复键拒绝；不做警告后忽略。
 *   - 旧扁平清单（顶层 id/system_prompt/…）按明确的格式错误拒绝。
 *   - 身份、凭据、端点、模型路由、绑定、执行环境、外部能力接入等平台受管字段
 *     在任意层级直接拒绝并给出原因。
 *   - 角色、数据范围、团队空间开关等授权配置属平台字段，不在包内声明；
 *     首次导入由平台默认值初始化，重复导入保留管理员既有配置。
 */

export interface AgentPackageCapabilityRef { id: string; version: string; path: string }

export const AGENT_EVALUATION_API_VERSION = 'dsh-work.ai/evaluation/v1' as const
export const AGENT_EVALUATION_KIND = 'AgentEvaluationSuite' as const
export const AGENT_EVALUATION_CASE_KINDS = [
  'success',
  'invalid_input',
  'permission_denied',
  'prompt_injection',
  'capability_failure',
] as const
export const AGENT_EVALUATION_ASSERTIONS = [
  'run_attempt_recorded',
  'execution_succeeded',
  'output_non_empty',
] as const

export type AgentEvaluationCaseKind = typeof AGENT_EVALUATION_CASE_KINDS[number]
export type AgentEvaluationAssertion = typeof AGENT_EVALUATION_ASSERTIONS[number]

export interface AgentPackageCase {
  /** 案例随候选持久化时保留其解释契约，避免脱离套件文件后丢失版本。 */
  evaluationApiVersion: typeof AGENT_EVALUATION_API_VERSION
  name: string
  kind: AgentEvaluationCaseKind
  input: string
  automatedAssertions: AgentEvaluationAssertion[]
  manualReview: { required: true; rubric: string }
}

export interface AgentPackageParseResult {
  rootDir: string
  /** 规范化 Agent 定义：与配置入口产出的 AgentSpec 同一结构，缺省值已展开。 */
  spec: AgentSpec
  /** spec.capabilities 中需平台解析的引用（包内候选已在解析时按精确版本核对并剔除）。 */
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
const CASE_KINDS = new Set<string>(AGENT_EVALUATION_CASE_KINDS)
const CASE_ASSERTIONS = new Set<string>(AGENT_EVALUATION_ASSERTIONS)
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * 平台受管字段：包内声明这些字段若被静默忽略即构成安全/能力语义漂移，直接拒绝。
 * key 为小写字段名；对清单做递归扫描，任意层级出现均拒绝。
 */
const RESERVED_MANIFEST_KEYS: Record<string, string> = {
  // 模型与路由
  model_route: '模型路由由平台管理', provider: '模型路由由平台管理', model_route_id: '模型路由由平台管理', llm: '模型路由由平台管理',
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
  // 身份、授权与租户
  identity: '执行身份由平台解析', execution_identity: '执行身份由平台解析', run_as: '执行身份由平台解析',
  impersonate: '执行身份由平台解析', tenant_id: '租户身份由平台决定',
  permissions: '授权范围由平台治理', grants: '授权范围由平台治理', allowlist: '能力准入由平台治理', allow_list: '能力准入由平台治理',
  role_ids: '可见角色由平台配置', visible_role_ids: '可见角色由平台配置', roleids: '可见角色由平台配置',
  data_scopes: '数据范围由平台配置', datascopes: '数据范围由平台配置',
  allow_workspace_join: '团队空间准入由平台配置', owner: '负责人归属由平台配置',
  // 绑定与执行环境
  binding: '绑定修订由平台发布流程固定', bindings: '绑定修订由平台发布流程固定',
  runtime: '执行环境由平台 Runtime 决定', executor: '执行环境由平台 Runtime 决定', sandbox: '执行环境由平台 Runtime 决定',
  network: '网络范围由平台治理', egress: '网络范围由平台治理',
  // 调度与激活范围（平台配置，不入包）
  schedule: '调度由平台配置', schedules: '调度由平台配置', activation: '激活范围由平台配置',
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

/** 平台受管字段递归扫描：任意层级命中 RESERVED_MANIFEST_KEYS 即给出逐项原因并拒绝。 */
function assertNoReservedFields(node: unknown, path: string) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoReservedFields(item, `${path}[${index}]`))
    return
  }
  const reserved = Object.keys(node as Record<string, unknown>)
    .map(key => ({ key, reason: RESERVED_MANIFEST_KEYS[key.toLowerCase()] }))
    .filter((item): item is { key: string; reason: string } => Boolean(item.reason))
  if (reserved.length) {
    fail(`agent.yaml 包含平台受管字段：${reserved.map(item => `${path ? `${path}.` : ''}${item.key}（${item.reason}）`).join('、')}；发布包不支持声明此类字段，请移除后重新打包`)
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    assertNoReservedFields(value, path ? `${path}.${key}` : key)
  }
}

/** 旧扁平清单探测：缺 apiVersion/kind 且带旧字段时给出格式迁移提示，而不是 schema 逐条报错。 */
function assertStructuredManifest(manifest: Record<string, unknown>) {
  if (manifest['apiVersion'] !== undefined && manifest['kind'] !== undefined) return
  const legacyKeys = ['id', 'name', 'version', 'description', 'system_prompt', 'system_prompt_file', 'prompt_file',
    'welcome_message', 'example_prompts', 'visible_role_ids', 'role_ids', 'data_scopes', 'max_tokens',
    'timeout_seconds', 'allow_workspace_join', 'skills', 'skill_refs', 'tools', 'tool_refs', 'evals', 'cases_file',
    'display_name', 'api_version', 'spec',
  ].filter(key => manifest[key] !== undefined)
  if (legacyKeys.length) {
    fail(`检测到旧扁平清单字段（${legacyKeys.slice(0, 4).join('、')} 等）：agent.yaml 必须使用 apiVersion: ${AGENT_SPEC_API_VERSION} + kind: AgentPackage + metadata/spec 分层结构，旧格式与别名不再支持`)
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

function stringField(source: Record<string, unknown>, key: string, { required = false, max = 2000 } = {}): string {
  const value = source[key]
  if (value === undefined || value === null) {
    if (required) fail(`缺少必填字段 ${key}`)
    return ''
  }
  if (typeof value !== 'string') fail(`字段 ${key} 必须是字符串`)
  const text = (value as string).trim()
  if (required && !text) fail(`字段 ${key} 不能为空`)
  if (text.length > max) fail(`字段 ${key} 长度不能超过 ${max} 个字符`)
  return text
}

function assertOnlyFields(source: Record<string, unknown>, allowed: string[], location: string) {
  const unknown = Object.keys(source).filter(key => !allowed.includes(key))
  if (unknown.length) fail(`${location} 含未定义字段：${unknown.join('、')}`)
}

function parseCases(files: Record<string, Uint8Array>, rootDir: string, declaredPath: string | undefined): AgentPackageCase[] {
  const path = declaredPath ?? 'evals/cases.yaml'
  const full = `${rootDir}${path}`
  if (!files[full]) {
    // 显式声明的案例文件必须存在；未声明时按约定路径探测，缺省由平台生成默认案例。
    if (declaredPath) fail(`spec.evaluation.cases 指定的 ${path} 不存在`)
    return []
  }
  const value = parseYamlValue(files, full)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} 必须是版本化评测套件对象`)
  const suite = value as Record<string, unknown>
  assertOnlyFields(suite, ['apiVersion', 'kind', 'cases'], path)
  if (suite['apiVersion'] !== AGENT_EVALUATION_API_VERSION) fail(`${path} apiVersion 必须是 ${AGENT_EVALUATION_API_VERSION}`)
  if (suite['kind'] !== AGENT_EVALUATION_KIND) fail(`${path} kind 必须是 ${AGENT_EVALUATION_KIND}`)
  const items = suite['cases']
  if (!Array.isArray(items) || !items.length) fail(`${path} cases 必须是非空数组`)
  return (items as unknown[]).map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${path} 第 ${index + 1} 个案例必须是对象`)
    const entry = item as Record<string, unknown>
    assertOnlyFields(entry, ['name', 'kind', 'input', 'automatedAssertions', 'manualReview'], `${path} 第 ${index + 1} 个案例`)
    const name = stringField(entry, 'name', { required: true, max: 120 })
    const kind = stringField(entry, 'kind', { required: true, max: 40 })
    if (!CASE_KINDS.has(kind)) fail(`${path} 第 ${index + 1} 个案例 kind 必须是 ${AGENT_EVALUATION_CASE_KINDS.join(' / ')}`)
    const input = stringField(entry, 'input', { required: true, max: 8000 })
    const rawAssertions = entry['automatedAssertions']
    if (!Array.isArray(rawAssertions) || !rawAssertions.length) fail(`${path} 第 ${index + 1} 个案例 automatedAssertions 必须是非空数组`)
    const automatedAssertions = (rawAssertions as unknown[]).map((assertion) => {
      if (typeof assertion !== 'string' || !CASE_ASSERTIONS.has(assertion)) {
        fail(`${path} 第 ${index + 1} 个案例自动断言必须是 ${AGENT_EVALUATION_ASSERTIONS.join(' / ')}`)
      }
      return assertion as AgentEvaluationAssertion
    })
    if (new Set(automatedAssertions).size !== automatedAssertions.length) fail(`${path} 第 ${index + 1} 个案例自动断言不能重复`)
    if (automatedAssertions.length !== AGENT_EVALUATION_ASSERTIONS.length
      || AGENT_EVALUATION_ASSERTIONS.some(assertion => !automatedAssertions.includes(assertion))) {
      fail(`${path} 第 ${index + 1} 个案例在 v1 中必须声明全部自动断言：${AGENT_EVALUATION_ASSERTIONS.join(' / ')}`)
    }
    const rawReview = entry['manualReview']
    if (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview)) fail(`${path} 第 ${index + 1} 个案例 manualReview 必须是对象`)
    const manualReview = rawReview as Record<string, unknown>
    assertOnlyFields(manualReview, ['required', 'rubric'], `${path} 第 ${index + 1} 个案例 manualReview`)
    if (manualReview['required'] !== true) fail(`${path} 第 ${index + 1} 个案例 manualReview.required 在 v1 中必须为 true`)
    const rubric = stringField(manualReview, 'rubric', { required: true, max: 4000 })
    return {
      evaluationApiVersion: AGENT_EVALUATION_API_VERSION,
      name,
      kind: kind as AgentPackageCase['kind'],
      input,
      automatedAssertions,
      manualReview: { required: true, rubric },
    }
  })
}

/** spec.capabilities 条目归一化为 `id@x.y.z`；同 id 重复声明（含不同版本）直接拒绝。 */
function normalizeCapabilityRefs(entries: Array<{ id: string; version: string }> | undefined, key: string): string[] {
  const references = (entries ?? []).map(item => `${item.id}@${item.version}`)
  const seen = new Set<string>()
  for (const item of entries ?? []) {
    if (seen.has(item.id)) {
      fail(`spec.capabilities.${key} 中 ${item.id} 声明了多条引用，同一能力只能声明一个精确版本`)
    }
    seen.add(item.id)
  }
  return references
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
  assertStructuredManifest(manifest)
  assertNoReservedFields(manifest, '')
  const schemaErrors = manifestSchemaErrors(manifest)
  if (schemaErrors.length) fail(`agent.yaml 结构校验未通过：${schemaErrors.join('；')}`)
  const document = manifest as unknown as AgentPackageManifestDocument

  const warnings: string[] = []
  const instructionsPath = document.spec.instructions
  if (Object.keys(files).some(path => path.startsWith(`${rootDir}prompts/`))) {
    fail('发布包不能同时包含旧 prompts/ 指令目录；请只保留根目录 SOUL.md')
  }
  const instructionsBody = readText(files, `${rootDir}${instructionsPath}`)
    ?? fail(`spec.instructions 指定的 ${instructionsPath} 不存在`)
  const checksumsVerified = verifyChecksums(files, rootDir, warnings)

  const spec: AgentSpec = {
    apiVersion: AGENT_SPEC_API_VERSION,
    metadata: {
      id: document.metadata.id,
      name: document.metadata.name.trim(),
      version: document.metadata.version,
      description: document.metadata.description.trim(),
    },
    instructions: { path: instructionsPath, body: instructionsBody.trim() },
    capabilities: {
      skills: normalizeCapabilityRefs(document.spec.capabilities?.skills, 'skills'),
      tools: normalizeCapabilityRefs(document.spec.capabilities?.tools, 'tools'),
    },
    input: { type: (document.spec.input?.type ?? 'text') as AgentSpec['input']['type'] },
    output: { type: (document.spec.output?.type ?? 'text') as AgentSpec['output']['type'] },
    context: { conversationHistory: (document.spec.context?.conversationHistory ?? 'recent') as AgentSpec['context']['conversationHistory'] },
    catalog: {
      welcomeMessage: (document.spec.catalog?.welcomeMessage ?? '').trim(),
      examplePrompts: (document.spec.catalog?.examplePrompts ?? []).map(item => item.trim()).filter(Boolean),
    },
    limits: { ...AGENT_SPEC_LIMITS_DEFAULT, ...(document.spec.limits ?? {}) },
    evaluation: { cases: document.spec.evaluation?.cases ?? null },
    model: { requirements: [...(document.spec.model?.requirements ?? [])] as AgentModelRequirement[] },
  }
  assertAgentSpecContent(spec)

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
    packageSkills.push({ id: dirName, version: parsed.version ?? spec.metadata.version, path: path.slice(0, path.length - 'SKILL.md'.length).slice(rootDir.length).replace(/\/$/, '') })
  }
  for (const [dirName, path] of toolDirs) {
    const descriptor = parseYamlFile(files, path)
    assertNoReservedFields(descriptor, `tools/${dirName}/tool.yaml`)
    // 描述符 id 为规范能力标识（可与目录名不同），缺省回退目录名；须符合依赖标识规则。
    const toolId = stringField(descriptor, 'id', { max: 80 }) || dirName
    if (!DEP_ID_PATTERN.test(toolId)) {
      fail(`tools/${dirName}/tool.yaml 的 id「${toolId}」不符合能力标识规则 ${DEP_ID_PATTERN.source}`)
    }
    const toolVersion = stringField(descriptor, 'version', { max: 40 }) || spec.metadata.version
    if (!VERSION_PATTERN.test(toolVersion)) fail(`tools/${dirName}/tool.yaml 的 version 必须是 x.y.z 形式`)
    packageTools.push({ id: toolId, version: toolVersion, path: `tools/${dirName}` })
  }

  // 声明条目与包内目录同 id 时视为包内提供，不再走平台解析；声明为精确版本，
  // 与包内候选版本不一致属于作者需要修正的冲突。
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
      const id = reference.slice(0, reference.lastIndexOf('@'))
      const version = reference.slice(reference.lastIndexOf('@') + 1)
      const match = byId.get(id)
      if (!match) {
        remaining.push(reference)
        continue
      }
      if (version !== match.version) {
        fail(`声明的 ${kind} ${reference} 与包内 ${kind === 'Skill' ? 'skills' : 'tools'}/${match.id} 候选版本 ${match.version} 冲突，请修正声明版本或包内版本后重新打包`)
      }
    }
    return remaining
  }
  const declared = {
    skills: consumeDeclared(spec.capabilities.skills, packageSkills, 'Skill'),
    tools: consumeDeclared(spec.capabilities.tools, packageTools, 'Tool'),
  }

  const cases = parseCases(files, rootDir, spec.evaluation.cases ?? undefined)

  return {
    rootDir,
    spec,
    declared,
    packageRefs: { skills: packageSkills, tools: packageTools },
    cases,
    files,
    checksumsVerified,
    warnings,
  }
}
