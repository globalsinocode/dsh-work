import { normalizeSkillTestScenario } from '../../domain/skill-test-scenario.ts'
import { MAX_SKILL_FILES, MAX_SKILL_BYTES } from '../../domain/skill-package-limits.ts'
import { SKILL_ARTIFACT_REF_PATTERN } from '../../domain/skill-artifact-ref.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'
import type { CompiledRuntimeManifest, RuntimeManifest } from './runtime-types.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}@[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const BINDING_FIELDS = new Set(['tool', 'binding_id', 'revision', 'digest'])
// 引用规则由 domain/skill-artifact-ref.ts 统一提供，与 FileSystemSkillArtifactStore
// 读写同口径；runtime-manifest.schema.json 中的等价 pattern 由 contracts 静态检查固定。
const ARTIFACT_REF_PATTERN = SKILL_ARTIFACT_REF_PATTERN
const SKILL_FIELDS = new Set(['id', 'name', 'description', 'version', 'instructions', 'artifact_ref', 'instructions_sha256', 'dependencies', 'disable_model_invocation', 'files'])
const SKILL_FILE_FIELDS = new Set(['path', 'content', 'sha256', 'size'])

function assertId(name: string, value: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} is invalid`)
}

export function compileRuntimeManifest(input: RuntimeManifest): CompiledRuntimeManifest {
  if (input.manifest_version !== '1.0') throw new TypeError('manifest_version must be 1.0')
  assertId('run_id', input.run_id)
  assertId('attempt_id', input.attempt_id)
  assertId('session_id', input.session_id)
  assertId('user_context.user_id', input.user_context.user_id)
  assertId('user_context.tenant_id', input.user_context.tenant_id)

  if (input.agent_configuration.system_prompt.trim().length < 20) {
    throw new TypeError('agent_configuration.system_prompt must be at least 20 characters')
  }
  const skillReferences = new Set(input.skills.map(skill => `${skill.id}@${skill.version}`))
  const skillNames = new Set<string>()
  for (const skill of input.agent_configuration.skill_instructions) {
    for (const key of Object.keys(skill)) {
      if (!SKILL_FIELDS.has(key)) throw new TypeError(`Skill 存在未声明字段：${key}`)
    }
    assertId('agent_configuration.skill_instructions.id', skill.id)
    assertId('agent_configuration.skill_instructions.version', skill.version)
    const externalized = typeof skill.artifact_ref === 'string'
    if (externalized && skill.instructions !== undefined) throw new TypeError('外置 Skill 不得携带内联 instructions')
    if (!externalized && skill.instructions_sha256 !== undefined) throw new TypeError('内联 Skill 不得携带 instructions_sha256')
    if (!externalized && (skill.instructions ?? '').trim().length < 20) {
      throw new TypeError('agent_configuration.skill_instructions.instructions must be at least 20 characters')
    }
    if (externalized && !ARTIFACT_REF_PATTERN.test(skill.artifact_ref!)) {
      throw new TypeError('agent_configuration.skill_instructions artifact reference is invalid')
    }
    if (externalized && !/^[a-f0-9]{64}$/.test(skill.instructions_sha256 ?? '')) {
      throw new TypeError('agent_configuration.skill_instructions instructions_sha256 is invalid or missing')
    }
    const catalogName = (skill.name ?? skill.id).trim()
    if (!catalogName || catalogName.length > 80 || skillNames.has(catalogName)) throw new TypeError('Skill 目录名称为空、过长或重复')
    skillNames.add(catalogName)
    for (const dependency of skill.dependencies ?? []) {
      if (!skillReferences.has(dependency)) throw new TypeError(`Skill 依赖未包含在当前 Run 固定快照中：${dependency}`)
    }
    if ((skill.files?.length ?? 0) > MAX_SKILL_FILES) throw new TypeError('Skill 最多包含 64 个文件')
    let skillBytes = 0
    const paths = new Set<string>()
    for (const file of skill.files ?? []) {
      for (const key of Object.keys(file)) {
        if (!SKILL_FILE_FIELDS.has(key)) throw new TypeError(`Skill 文件索引存在未声明字段：${key}`)
      }
      if (!file.path || /[\\:]/.test(file.path) || [...file.path].some(character => character.charCodeAt(0) < 32) || file.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(file.path)) throw new TypeError('Skill 文件路径无效')
      paths.add(file.path)
      if (externalized && file.content !== undefined) throw new TypeError('外置 Skill 文件索引不得携带 content')
      if (file.content !== undefined && sha256(file.content) !== file.sha256) throw new TypeError('Skill 文件摘要不匹配')
      if (file.content === undefined && !externalized) throw new TypeError('Skill 文件内容只能由受控文件夹引用省略')
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0) throw new TypeError('Skill 文件索引无效')
      if (file.content !== undefined && Buffer.byteLength(file.content) !== file.size) throw new TypeError('Skill 文件大小不匹配')
      // 内联文件的 size 已校验等于内容字节数；外置文件按索引声明值计入，实际文件由加载侧 stat 复核。
      skillBytes += file.size
      if (skillBytes > MAX_SKILL_BYTES) throw new TypeError('单个 Skill 资源合计超过 1 MB')
    }
    if (externalized && !(skill.files ?? []).some(file => file.path === 'SKILL.md')) throw new TypeError('Skill 文件夹索引缺少 SKILL.md')
    if (!skillReferences.has(`${skill.id}@${skill.version}`)) {
      throw new TypeError(`skill instruction is not declared in skills: ${skill.id}@${skill.version}`)
    }
  }
  if (input.test_scenario !== undefined) {
    if (input.purpose !== 'admin-skill-test') throw new TypeError('test_scenario requires admin-skill-test purpose')
    normalizeSkillTestScenario(input.test_scenario, input.agent_configuration.skill_instructions)
  }
  const history = input.input.conversation_history ?? []
  if (history.length > 12 || history.some(message => !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') || history.reduce((size, message) => size + message.content.length, 0) > 24000) {
    throw new TypeError('conversation_history exceeds the bounded conversation context')
  }
  if (input.input.message.trim().length === 0) throw new TypeError('input.message must not be blank')
  if (input.limits.timeout_seconds < 1 || input.limits.timeout_seconds > 3600) {
    throw new RangeError('limits.timeout_seconds must be between 1 and 3600')
  }
  if (input.limits.max_output_bytes < 1024) throw new RangeError('limits.max_output_bytes must be at least 1024')
  if (input.limits.max_tool_calls < 0 || input.limits.max_tool_calls > 1000) {
    throw new RangeError('limits.max_tool_calls must be between 0 and 1000')
  }

  if (input.input.file_mounts.length > 5) throw new RangeError('input.file_mounts must contain at most 5 files')
  let mountedBytes = 0
  const mountedPaths = new Set<string>()
  for (const mount of input.input.file_mounts) {
    if (!/^\/workspace\/input\/[A-Za-z0-9._-]+\.txt$/.test(mount.mount_path)) {
      throw new TypeError('file mount paths must start with /workspace/input/')
    }
    if (mount.access !== 'read_only') throw new TypeError('input file mounts must be read_only')
    if (mountedPaths.has(mount.mount_path)) throw new TypeError(`duplicate file mount path: ${mount.mount_path}`)
    mountedPaths.add(mount.mount_path)
    if (!mount.source_name.trim() || !mount.media_type.trim()) throw new TypeError('file mount source name and media type are required')
    if (sha256(mount.content) !== mount.content_sha256) throw new TypeError(`file mount checksum mismatch: ${mount.file_id}`)
    mountedBytes += Buffer.byteLength(mount.content)
  }
  if (mountedBytes > 1024 * 1024) throw new RangeError('mounted extracted text must not exceed 1 MB')

  if (input.knowledge_context.length > 3) throw new RangeError('knowledge_context must contain at most 3 documents')
  for (const document of input.knowledge_context) {
    assertId('knowledge_context.documentId', document.documentId)
    if (!document.title.trim() || !document.version.trim()) throw new TypeError('knowledge document title and version are required')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(document.effectiveDate)) throw new TypeError('knowledge document effectiveDate is invalid')
    if (!/^[a-f0-9]{32,64}$/.test(document.contentChecksum)) throw new TypeError('knowledge document contentChecksum is invalid')
    if (!document.excerpt.trim() || document.excerpt.length > 4000) throw new TypeError('knowledge document excerpt is invalid')
  }

  // B-03/I-04：tool_bindings 是 Attempt 固定的平台绑定快照；逐字段校验并拒绝工具级重复固定。
  const pinnedTools = new Set<string>()
  for (const binding of input.tool_bindings ?? []) {
    for (const key of Object.keys(binding)) {
      if (!BINDING_FIELDS.has(key)) throw new TypeError(`tool_bindings 存在未声明字段：${key}`)
    }
    if (!CAPABILITY_REF_PATTERN.test(binding.tool ?? '')) throw new TypeError('tool_bindings[].tool 必须是 id@version 平台引用')
    // tools[] 使用 DSH 运行时名（dsh_tool_name@version），tool_bindings 使用平台
    // 引用（tool_id@version）——两者命名空间不同，无法也不应做成员一致性比较；
    // 「pin 对应的是清单声明的工具」由 getRuntimeSnapshot 的解析路径保证。
    if (pinnedTools.has(binding.tool)) throw new TypeError(`tool_bindings 重复固定了 ${binding.tool}`)
    pinnedTools.add(binding.tool)
    if (!binding.binding_id?.trim()) throw new TypeError('tool_bindings[].binding_id 不允许为空')
    if (!Number.isInteger(binding.revision) || binding.revision < 1) throw new TypeError('tool_bindings[].revision 必须是正整数')
    if (!/^[a-f0-9]{64}$/.test(binding.digest ?? '')) throw new TypeError('tool_bindings[].digest 必须是 sha256 摘要')
  }

  const manifest = structuredClone(input)
  const serialized = canonicalJson(manifest)
  return { manifest, canonicalJson: serialized, sha256: sha256(serialized) }
}
