/**
 * 平台内置 Skill（docs/design/builtin-skills-plan.md）：随代码发布的基线方法。
 *
 * 内容在 server/config/builtin-skills/<id>/，本文件的注册表是唯一来源，与内置工具注册表同一治理方式：
 * 不写入 Skill 表，不经安装、发布或授权；员工侧运行以内联 Skill 写入 Manifest，正文随 Manifest 留存。
 * versions.lock.json 固定每个版本的内容摘要：内容变化而版本号未变时加载失败，服务不启动。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { MAX_SKILL_BYTES, MAX_SKILL_FILES } from '../../domain/skill-package-limits.ts'
import { BUILTIN_SKILL_ID_PREFIX, isBuiltinSkillReference } from '../../domain/builtin-skill-ref.ts'
import { builtinToolReference } from '../runtime/builtin-tools.ts'
import { assertPackagePath, hash, parseSkillMarkdown, skillPackageContentHash } from './skill-package.ts'
import type { RuntimeSkillConfiguration } from './postgres-skill-service.ts'

export const BUILTIN_SKILL_SCENARIOS = ['file-analysis', 'html-page', 'office-document'] as const
export type BuiltinSkillScenario = typeof BUILTIN_SKILL_SCENARIOS[number]

export const BUILTIN_SKILL_SCENARIO_LABELS: Record<BuiltinSkillScenario, string> = {
  'file-analysis': '文件分析',
  'html-page': 'HTML 页面',
  'office-document': 'Office 文档',
}

export { BUILTIN_SKILL_ID_PREFIX, isBuiltinSkillReference }

/** 内置 Skill 的名称后缀为保留值：安装入口拒绝，避免 Manifest 目录重名。 */
export const BUILTIN_SKILL_NAME_SUFFIX = '（平台内置）'

const definitions: ReadonlyArray<{ id: string; scenario: BuiltinSkillScenario }> = [
  { id: 'dsh-work-file-analysis', scenario: 'file-analysis' },
  { id: 'dsh-work-html-page', scenario: 'html-page' },
  { id: 'dsh-work-office-document', scenario: 'office-document' },
]

/** 内置 Skill 只提供方法：只能声明读工具，生成文件依赖平台另行装配的 bash。 */
const allowedTools = new Set(['read', 'glob', 'grep'].map(builtinToolReference))
const allowedExtensions = /\.(md|txt|json|ya?ml|csv|toml)$/i

export interface BuiltinSkill {
  id: string
  scenario: BuiltinSkillScenario
  name: string
  description: string
  version: string
  instructions: string
  tools: string[]
  /** SKILL.md 以外的参考资料，内联写入 Manifest。 */
  files: Array<{ path: string; content: string; sha256: string; size: number }>
  /** 包含 SKILL.md 在内的全部文件摘要，与 versions.lock.json 比对。 */
  sha256: string
}

export interface BuiltinSkillExclusion {
  skill: string
  reason: 'covered' | 'disabled'
  coveredBy?: string
}

/** 本次运行中由 Agent 固定或会话选择的 Skill（不含依赖），用于判断覆盖。 */
export interface CoveringSkill {
  reference: string
  name: string
  scenarios: readonly string[]
  modelInvocable: boolean
}

export function isReservedBuiltinSkillName(name: string): boolean {
  return name.trim().endsWith(BUILTIN_SKILL_NAME_SUFFIX)
}

/** 管理员设置的“覆盖内置场景”：去重、排序，只接受固定场景。 */
export function normalizeBuiltinSkillScenarios(value: unknown): BuiltinSkillScenario[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError('覆盖内置场景格式无效')
  const scenarios = [...new Set(value.map(item => item.trim()))].sort()
  const unknown = scenarios.filter(item => !(BUILTIN_SKILL_SCENARIOS as readonly string[]).includes(item))
  if (unknown.length) throw new TypeError(`未知的内置场景：${unknown.join('、')}`)
  return scenarios as BuiltinSkillScenario[]
}

/** 管理端只读展示：内置 Skill、固定场景与 Runtime 当前停用清单。 */
export interface BuiltinSkillStatus {
  skills: Array<{
    id: string
    name: string
    description: string
    version: string
    scenario: BuiltinSkillScenario
    instructions: string
    tools: string[]
    files: Array<{ path: string; size: number }>
  }>
  scenarios: Array<{ id: BuiltinSkillScenario; label: string }>
  disabledBuiltinSkills: string[]
}

export class BuiltinSkillCatalog {
  readonly skills: readonly BuiltinSkill[]

  constructor(skills: readonly BuiltinSkill[]) {
    this.skills = skills
  }

  get(id: string): BuiltinSkill | undefined {
    return this.skills.find(skill => skill.id === id)
  }

  status(disabledBuiltinSkills: readonly string[]): BuiltinSkillStatus {
    return {
      skills: this.skills.map(skill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        scenario: skill.scenario,
        instructions: skill.instructions,
        tools: [...skill.tools],
        files: skill.files.map(file => ({ path: file.path, size: file.size })),
      })),
      scenarios: BUILTIN_SKILL_SCENARIOS.map(id => ({ id, label: BUILTIN_SKILL_SCENARIO_LABELS[id] })),
      disabledBuiltinSkills: [...disabledBuiltinSkills],
    }
  }

  /** Runtime 配置的停用清单：去重、排序，只接受注册表中的内置 Skill。 */
  normalizeDisabled(value: unknown): string[] {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError('停用内置 Skill 清单格式无效')
    const ids = [...new Set(value.map(item => item.trim()))].sort()
    const unknown = ids.filter(id => !this.get(id))
    if (unknown.length) throw new TypeError(`只能停用平台内置 Skill：${unknown.join('、')}`)
    return ids
  }

  /**
   * 本次运行装配的内置 Skill：去掉紧急停用的，以及被本次 Skill 覆盖的。
   * 已安装 Skill 与内置 Skill 同名时（历史数据）视为覆盖，避免 Manifest 目录重名。
   */
  resolve(input: { disabled: readonly string[]; covering: readonly CoveringSkill[] }): {
    skills: RuntimeSkillConfiguration[]
    exclusions: BuiltinSkillExclusion[]
  } {
    const disabled = new Set(input.disabled)
    const skills: RuntimeSkillConfiguration[] = []
    const exclusions: BuiltinSkillExclusion[] = []
    for (const skill of this.skills) {
      const reference = `${skill.id}@${skill.version}`
      if (disabled.has(skill.id)) {
        exclusions.push({ skill: reference, reason: 'disabled' })
        continue
      }
      const cover = input.covering.find(item => item.name === skill.name)
        ?? input.covering.find(item => item.modelInvocable && item.scenarios.includes(skill.scenario))
      if (cover) {
        exclusions.push({ skill: reference, reason: 'covered', coveredBy: cover.reference })
        continue
      }
      skills.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        instructions: skill.instructions,
        tools: [...skill.tools],
        ...(skill.files.length ? { files: skill.files.map(file => ({ ...file })) } : {}),
      })
    }
    return { skills, exclusions }
  }
}

/** 启动时加载：任何内置 Skill 不合法都抛错，由调用方让服务启动失败。 */
export function loadBuiltinSkillCatalog(root: string): BuiltinSkillCatalog {
  const lock = readLock(join(root, 'versions.lock.json'))
  return new BuiltinSkillCatalog(definitions.map(definition => loadBuiltinSkill(root, definition, lock)))
}

function loadBuiltinSkill(root: string, definition: { id: string; scenario: BuiltinSkillScenario }, lock: Record<string, Record<string, string>>): BuiltinSkill {
  const directory = join(root, definition.id)
  const fail = (message: string): never => { throw new Error(`内置 Skill ${definition.id} 无效：${message}`) }
  const files = listFiles(directory).map(path => {
    try { assertPackagePath(path) } catch { fail(`不安全的文件路径：${path}`) }
    if (!allowedExtensions.test(path)) fail(`不允许的文件类型：${path}`)
    const content = readFileSync(join(directory, path), 'utf8')
    return { path, content, sha256: hash(content), size: Buffer.byteLength(content) }
  })
  if (files.length > MAX_SKILL_FILES) fail(`最多 ${MAX_SKILL_FILES} 个文件`)
  if (files.reduce((total, file) => total + file.size, 0) > MAX_SKILL_BYTES) fail('资源合计超过 1 MB')
  const entry = files.find(file => file.path === 'SKILL.md') ?? fail('缺少 SKILL.md')
  let parsed: ReturnType<typeof parseSkillMarkdown>
  try { parsed = parseSkillMarkdown(entry.content) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  if (!parsed.version || !/^\d+\.\d+\.\d+$/.test(parsed.version)) fail('version 必须为 x.y.z')
  if (!isReservedBuiltinSkillName(parsed.name)) fail(`name 必须以“${BUILTIN_SKILL_NAME_SUFFIX}”结尾`)
  if (parsed.disableModelInvocation) fail('内置 Skill 必须允许模型调用')
  if (parsed.requirements.length) fail(`存在不支持的声明：${parsed.requirements.map(item => item.name).join('、')}`)
  const extraTools = parsed.toolIds.filter(tool => !allowedTools.has(tool))
  if (extraTools.length) fail(`只能声明 read、glob、grep：${extraTools.join('、')}`)
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path))
  const sha256 = skillPackageContentHash(sorted)
  const locked = lock[definition.id]?.[parsed.version!]
  if (!locked) fail(`versions.lock.json 缺少 ${parsed.version} 的摘要（当前 ${sha256}）`)
  if (locked !== sha256) fail(`${parsed.version} 的内容与 versions.lock.json 不一致：内容变化须升版本号（当前 ${sha256}）`)
  return {
    id: definition.id,
    scenario: definition.scenario,
    name: parsed.name,
    description: parsed.description,
    version: parsed.version!,
    instructions: parsed.instructions,
    tools: [...parsed.toolIds].sort(),
    files: sorted.filter(file => file.path !== 'SKILL.md'),
    sha256,
  }
}

function listFiles(directory: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(directory, { recursive: true }) as string[]
  } catch {
    throw new Error(`内置 Skill 目录不存在：${directory}`)
  }
  return entries
    .filter(entry => !entry.split(/[\\/]/).some(part => part.startsWith('.')) && statSync(join(directory, entry)).isFile())
    .map(entry => relative(directory, join(directory, entry)).split('\\').join('/'))
}

function readLock(path: string): Record<string, Record<string, string>> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`内置 Skill 版本锁文件不可读：${path}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内置 Skill 版本锁文件格式无效')
  return value as Record<string, Record<string, string>>
}
