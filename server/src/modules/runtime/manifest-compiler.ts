import { MAX_SKILL_FILES, MAX_SKILL_BYTES } from '../../domain/skill-package-limits.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'
import type { CompiledRuntimeManifest, RuntimeManifest } from './runtime-types.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

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
    assertId('agent_configuration.skill_instructions.id', skill.id)
    assertId('agent_configuration.skill_instructions.version', skill.version)
    if (skill.instructions.trim().length < 20) {
      throw new TypeError('agent_configuration.skill_instructions.instructions must be at least 20 characters')
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
      if (!file.path || /[\\:]/.test(file.path) || [...file.path].some(character => character.charCodeAt(0) < 32) || file.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(file.path)) throw new TypeError('Skill 文件路径无效')
      paths.add(file.path)
      if (sha256(file.content) !== file.sha256) throw new TypeError('Skill 文件摘要不匹配')
      skillBytes += Buffer.byteLength(file.content)
      if (skillBytes > MAX_SKILL_BYTES) throw new TypeError('单个 Skill 资源合计超过 1 MB')
    }
    if (!skillReferences.has(`${skill.id}@${skill.version}`)) {
      throw new TypeError(`skill instruction is not declared in skills: ${skill.id}@${skill.version}`)
    }
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

  const manifest = structuredClone(input)
  const serialized = canonicalJson(manifest)
  return { manifest, canonicalJson: serialized, sha256: sha256(serialized) }
}
