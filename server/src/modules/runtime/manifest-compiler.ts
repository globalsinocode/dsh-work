import { normalizeSkillTestScenario } from '../../domain/skill-test-scenario.ts'
import { MAX_SKILL_FILES, MAX_SKILL_BYTES } from '../../domain/skill-package-limits.ts'
import { SKILL_ARTIFACT_REF_PATTERN } from '../../domain/skill-artifact-ref.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'
import { isSafeResumeWorkspacePath } from './resume-workspace-path.ts'
import {
  MAX_MCP_CONNECTIONS_PER_ATTEMPT,
  type CompiledRuntimeManifest,
  type RuntimeManifest,
  type RuntimeResumeCheckpointContext,
} from './runtime-types.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}@[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const BINDING_FIELDS = new Set(['tool', 'binding_id', 'revision', 'digest'])
const MCP_CONNECTION_FIELDS = new Set(['connector_id', 'server_name', 'transport', 'endpoint', 'auth_type', 'capability_digest'])
const RESUME_FIELDS = new Set(['strategy', 'checkpoint_id', 'checkpoint_digest', 'source_attempt_id', 'approval_id', 'action_name', 'parameter_digest', 'resource_ref', 'data_version', 'approved_by', 'approved_at', 'checkpoint_context_sha256', 'checkpoint_context'])
// 引用规则由 domain/skill-artifact-ref.ts 统一提供，与 FileSystemSkillArtifactStore
// 读写同口径；runtime-manifest.schema.json 中的等价 pattern 由 contracts 静态检查固定。
const ARTIFACT_REF_PATTERN = SKILL_ARTIFACT_REF_PATTERN
const SKILL_FIELDS = new Set(['id', 'name', 'description', 'version', 'instructions', 'artifact_ref', 'instructions_sha256', 'dependencies', 'disable_model_invocation', 'files'])
const SKILL_FILE_FIELDS = new Set(['path', 'content', 'sha256', 'size'])

function assertId(name: string, value: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new TypeError(`${name} is invalid`)
}

export function compileRuntimeManifest(input: RuntimeManifest): CompiledRuntimeManifest {
  if (input.manifest_version !== '1.0') throw new TypeError('manifest_version must be 1.0')
  if (input.model_requirements !== undefined && (!Array.isArray(input.model_requirements)
    || input.model_requirements.some(requirement => !['long-context', 'structured-output'].includes(requirement))
    || new Set(input.model_requirements).size !== input.model_requirements.length)) {
    throw new TypeError('model_requirements must contain unique supported requirement names')
  }
  assertId('run_id', input.run_id)
  assertId('attempt_id', input.attempt_id)
  assertId('task_id', input.task_id)
  if (input.session_id !== null) assertId('session_id', input.session_id)
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
  if (input.resume !== undefined) {
    for (const key of Object.keys(input.resume)) if (!RESUME_FIELDS.has(key)) throw new TypeError(`resume contains unsupported field: ${key}`)
    if (input.resume.strategy !== 'new-attempt-context-v1') throw new TypeError('resume strategy is unsupported')
    for (const [name, value] of Object.entries(input.resume)) {
      if (name === 'strategy' || name === 'approved_at' || name === 'checkpoint_context') continue
      if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`resume.${name} must not be blank`)
    }
    if (!/^[a-f0-9]{64}$/.test(input.resume.checkpoint_digest)
      || !/^[a-f0-9]{64}$/.test(input.resume.parameter_digest)
      || !/^[a-f0-9]{64}$/.test(input.resume.checkpoint_context_sha256)) {
      throw new TypeError('resume digests are invalid')
    }
    if (!Number.isFinite(Date.parse(input.resume.approved_at))) throw new TypeError('resume.approved_at is invalid')
    validateResumeCheckpointContext(input.resume.checkpoint_context, input.resume.parameter_digest, input.resume.checkpoint_context_sha256)
  }
  if (input.limits.timeout_seconds < 1 || input.limits.timeout_seconds > 3600) {
    throw new RangeError('limits.timeout_seconds must be between 1 and 3600')
  }
  if (input.limits.max_output_bytes < 1024) throw new RangeError('limits.max_output_bytes must be at least 1024')
  if (input.limits.max_tool_calls < 0 || input.limits.max_tool_calls > 1000) {
    throw new RangeError('limits.max_tool_calls must be between 0 and 1000')
  }
  if (!input.budget || typeof input.budget !== 'object'
    || !input.budget.cumulative_limits || typeof input.budget.cumulative_limits !== 'object'
    || !input.budget.reservation || typeof input.budget.reservation !== 'object'
    || !input.budget.enforcement || typeof input.budget.enforcement !== 'object') {
    throw new TypeError('budget is required')
  }
  assertId('budget.scope_task_id', input.budget.scope_task_id)
  if (input.budget.reservation.duration_ms !== input.limits.timeout_seconds * 1000
    || input.budget.reservation.tool_calls !== input.limits.max_tool_calls
    || input.budget.reservation.output_bytes !== input.limits.max_output_bytes) {
    throw new TypeError('budget reservation must match the enforceable Attempt limits')
  }
  assertOptionalBudgetLimit(input.budget.cumulative_limits.max_duration_ms, 'max_duration_ms', 1_000, 86_400_000)
  assertOptionalBudgetLimit(input.budget.cumulative_limits.max_tool_calls, 'max_tool_calls', 0, 100_000)
  assertOptionalBudgetLimit(input.budget.cumulative_limits.max_output_bytes, 'max_output_bytes', 1_024, 1_073_741_824)
  if (input.budget.enforcement.duration !== 'hard'
    || input.budget.enforcement.tool_calls !== 'hard'
    || input.budget.enforcement.output_bytes !== 'hard'
    || input.budget.enforcement.tokens !== 'unsupported'
    || input.budget.enforcement.cost !== 'unsupported') {
    throw new TypeError('budget enforcement capabilities are invalid')
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

  if ((input.memory_context?.length ?? 0) > 3) throw new RangeError('memory_context must contain at most 3 memories')
  const memoryVersions = new Set<string>()
  for (const memory of input.memory_context ?? []) {
    assertId('memory_context.memoryVersionId', memory.memoryVersionId)
    if (memoryVersions.has(memory.memoryVersionId)) throw new TypeError('memory_context contains duplicate versions')
    memoryVersions.add(memory.memoryVersionId)
    if (!memory.title.trim() || memory.title.length > 120) throw new TypeError('memory title is invalid')
    if (!Number.isInteger(memory.version) || memory.version < 1) throw new TypeError('memory version is invalid')
    if (!['preference', 'experience'].includes(memory.kind)) throw new TypeError('memory kind is invalid')
    if (!['private', 'workspace', 'organization'].includes(memory.visibility)) throw new TypeError('memory visibility is invalid')
    if (!/^[a-f0-9]{64}$/.test(memory.contentDigest)) throw new TypeError('memory contentDigest is invalid')
    if (!memory.excerpt.trim() || memory.excerpt.length > 4000) throw new TypeError('memory excerpt is invalid')
  }

  if (input.delegation_policy !== undefined) {
    const policy = input.delegation_policy
    if (!Array.isArray(policy.allowed_agent_version_ids) || policy.allowed_agent_version_ids.length > 16
      || policy.allowed_agent_version_ids.some(id => typeof id !== 'string' || !ID_PATTERN.test(id))
      || new Set(policy.allowed_agent_version_ids).size !== policy.allowed_agent_version_ids.length) {
      throw new TypeError('delegation_policy.allowed_agent_version_ids is invalid')
    }
    if (!Number.isInteger(policy.max_depth) || policy.max_depth < 1 || policy.max_depth > 4
      || !Number.isInteger(policy.max_parallel) || policy.max_parallel < 1 || policy.max_parallel > 4
      || !Number.isInteger(policy.timeout_seconds) || policy.timeout_seconds < 10 || policy.timeout_seconds > 300) {
      throw new TypeError('delegation_policy limits are invalid')
    }
    const hasTool = input.tools.some(tool => tool.id === 'delegate_agent')
    if (hasTool !== (policy.allowed_agent_version_ids.length > 0)) {
      throw new TypeError('delegate_agent tool and non-empty delegation_policy must be declared together')
    }
  } else if (input.tools.some(tool => tool.id === 'delegate_agent')) {
    throw new TypeError('delegate_agent requires delegation_policy')
  }
  if (input.delegation_context !== undefined) {
    const context = input.delegation_context
    assertId('delegation_context.delegation_id', context.delegation_id)
    assertId('delegation_context.root_task_id', context.root_task_id)
    assertId('delegation_context.parent_task_id', context.parent_task_id)
    assertId('delegation_context.parent_run_id', context.parent_run_id)
    assertId('delegation_context.parent_attempt_id', context.parent_attempt_id)
    if (!Number.isInteger(context.depth) || context.depth < 1 || context.depth > 4
      || !Number.isInteger(context.max_depth) || context.max_depth < context.depth || context.max_depth > 4) {
      throw new TypeError('delegation_context depth is invalid')
    }
    if (!Array.isArray(context.role_ceiling) || !Array.isArray(context.data_scope_ceiling)
      || context.role_ceiling.some(value => typeof value !== 'string')
      || context.data_scope_ceiling.some(value => typeof value !== 'string')) {
      throw new TypeError('delegation_context permission ceiling is invalid')
    }
    if (input.budget.scope_task_id !== context.root_task_id) {
      throw new TypeError('delegated Attempt must share the root Task budget scope')
    }
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

  if ((input.mcp_connections?.length ?? 0) > MAX_MCP_CONNECTIONS_PER_ATTEMPT) {
    throw new TypeError(`mcp_connections 最多包含 ${MAX_MCP_CONNECTIONS_PER_ATTEMPT} 个 Connector`)
  }
  const pinnedMcpConnectors = new Set<string>()
  const pinnedMcpNames = new Set<string>()
  for (const connection of input.mcp_connections ?? []) {
    for (const key of Object.keys(connection)) {
      if (!MCP_CONNECTION_FIELDS.has(key)) throw new TypeError(`mcp_connections 存在未声明字段：${key}`)
    }
    assertId('mcp_connections[].connector_id', connection.connector_id)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(connection.server_name)) throw new TypeError('mcp_connections[].server_name 无效')
    if (connection.transport !== 'streamable-http') throw new TypeError('mcp_connections 仅支持 streamable-http')
    const endpoint = new URL(connection.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
      throw new TypeError('mcp_connections[].endpoint 无效')
    }
    if (!['none', 'bearer'].includes(connection.auth_type)) throw new TypeError('mcp_connections[].auth_type 无效')
    if (!/^[a-f0-9]{64}$/.test(connection.capability_digest)) throw new TypeError('mcp_connections[].capability_digest 必须是 sha256 摘要')
    if (pinnedMcpConnectors.has(connection.connector_id) || pinnedMcpNames.has(connection.server_name)) {
      throw new TypeError('mcp_connections 不允许重复连接器或 server_name')
    }
    pinnedMcpConnectors.add(connection.connector_id)
    pinnedMcpNames.add(connection.server_name)
  }
  if (input.mcp_connections?.length && input.permission_policy.network_policy !== 'allowlist') {
    throw new TypeError('mcp_connections 要求 network_policy=allowlist')
  }

  const manifest = structuredClone(input)
  const serialized = canonicalJson(manifest)
  return { manifest, canonicalJson: serialized, sha256: sha256(serialized) }
}

function validateResumeCheckpointContext(
  context: RuntimeResumeCheckpointContext,
  parameterDigest: string,
  contextDigest: string,
): void {
  if (!context || typeof context !== 'object') throw new TypeError('resume.checkpoint_context is required')
  const fields = Object.keys(context)
  if (fields.some(field => !['pending_action', 'completed_tool_results', 'workspace_files', 'assistant_output'].includes(field))) {
    throw new TypeError('resume.checkpoint_context contains unsupported field')
  }
  if (!context.pending_action || typeof context.pending_action !== 'object'
    || Object.keys(context.pending_action).some(field => field !== 'arguments')
    || !context.pending_action.arguments || typeof context.pending_action.arguments !== 'object'
    || Array.isArray(context.pending_action.arguments)) {
    throw new TypeError('resume checkpoint pending action is invalid')
  }
  if (sha256(canonicalJson(context.pending_action.arguments)) !== parameterDigest) {
    throw new TypeError('resume checkpoint pending action digest mismatch')
  }
  if (!Array.isArray(context.completed_tool_results) || context.completed_tool_results.length > 50) {
    throw new TypeError('resume checkpoint tool results exceed the bounded context')
  }
  let toolResultBytes = 0
  for (const result of context.completed_tool_results) {
    if (!result || typeof result !== 'object'
      || Object.keys(result).some(field => !['call_id', 'tool_name', 'parameter_digest', 'result'].includes(field))
      || typeof result.call_id !== 'string' || !result.call_id
      || typeof result.tool_name !== 'string' || !result.tool_name
      || typeof result.parameter_digest !== 'string' || !/^[a-f0-9]{64}$/.test(result.parameter_digest)) {
      throw new TypeError('resume checkpoint tool result is invalid')
    }
    toolResultBytes += Buffer.byteLength(canonicalJson(result))
  }
  if (toolResultBytes > 256 * 1024) throw new TypeError('resume checkpoint tool results exceed 256 KB')
  if (!Array.isArray(context.workspace_files) || context.workspace_files.length > 64) {
    throw new TypeError('resume checkpoint workspace files exceed the bounded context')
  }
  let workspaceBytes = 0
  const paths = new Set<string>()
  for (const file of context.workspace_files) {
    if (!file || typeof file !== 'object'
      || Object.keys(file).some(field => !['path', 'content', 'sha256'].includes(field))
      || typeof file.path !== 'string' || !isSafeResumeWorkspacePath(file.path) || paths.has(file.path)
      || typeof file.content !== 'string'
      || typeof file.sha256 !== 'string' || sha256(file.content) !== file.sha256) {
      throw new TypeError('resume checkpoint workspace file is invalid')
    }
    paths.add(file.path)
    workspaceBytes += Buffer.byteLength(file.content)
  }
  if (workspaceBytes > 1024 * 1024) throw new TypeError('resume checkpoint workspace files exceed 1 MB')
  if (typeof context.assistant_output !== 'string' || Buffer.byteLength(context.assistant_output) > 64 * 1024) {
    throw new TypeError('resume checkpoint assistant output exceeds 64 KB')
  }
  if (sha256(canonicalJson(context)) !== contextDigest) throw new TypeError('resume checkpoint context digest mismatch')
}

function assertOptionalBudgetLimit(value: number | null, name: string, minimum: number, maximum: number): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
    throw new TypeError(`budget.cumulative_limits.${name} must be null or an integer between ${minimum} and ${maximum}`)
  }
}
