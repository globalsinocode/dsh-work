import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import Ajv2020Module from 'ajv/dist/2020.js'
import { MAX_SKILL_BYTES } from '../../domain/skill-package-limits.ts'
import { archiveDigest } from '../../domain/project-archive.ts'
import { compileRuntimeManifest } from './manifest-compiler.ts'
import { canonicalJson } from './canonical-json.ts'
import { normalizePersistedRuntimeManifest } from './runtime-manifest-compatibility.ts'
import type { RuntimeManifest } from './runtime-types.ts'

// ajv is a CommonJS package: under NodeNext the default import types as the
// module namespace (not constructable), while `.default` yields the class —
// at runtime module.exports self-references it, so both resolve identically.
const Ajv2020 = Ajv2020Module.default

/**
 * The same fixtures are validated by both the JSON Schema
 * (docs/development/runtime-manifest.schema.json) and compileRuntimeManifest,
 * pinning the boundary between them:
 *   - Schema owns structure: field presence, inline/externalized form, index
 *     relationships, unknown fields;
 *   - Compiler owns content: digest/body matching, path safety, byte budgets —
 *     and is also fail-closed on Skill field/mutual-exclusion drift, since
 *     compileRuntimeManifest is the only runtime gate before persistence.
 */

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(resolve(moduleDirectory, '../../../../docs/development/runtime-manifest.schema.json'), 'utf8'))
const validate = new Ajv2020({
  strict: true,
  // test_scenario assertions allow a string|number|boolean|null union for `expected`.
  allowUnionTypes: true,
  // Match the compiler: effectiveDate only needs a YYYY-MM-DD shape; created_at
  // date-time semantics are not enforced by the compiler either.
  formats: { date: /^\d{4}-\d{2}-\d{2}$/, 'date-time': () => true },
}).compile(schema)

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function baseManifest(): RuntimeManifest {
  return {
    manifest_version: '1.0',
    run_id: 'run-schema-check',
    attempt_id: 'attempt-1',
    task_id: 'task-schema-check',
    session_id: 'session-schema-check',
    workspace_id: 'ws-supply-analysis',
    agent_version_id: 'agent-supply-v1',
    agent_configuration: {
      system_prompt: '你是供应链分析助手，只能在当前用户授权的数据范围内提供准确回答。',
      skill_instructions: [],
    },
    user_context: { user_id: 'usr-linlan', tenant_id: 'tenant-demo', role_ids: ['role-employee'] },
    permission_policy: { approval_mode: 'risk_based', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [{ id: 'skill-inventory', version: '1.0.0' }],
    tools: [{ id: 'tool-inventory-read', version: '1.0.0' }],
    data_scopes: ['region:east'],
    knowledge_context: [],
    model_route_id: null,
    input: { message: 'summarize inventory', file_mounts: [] },
    budget: { scope_task_id: 'task-schema-check', cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null }, reservation: { duration_ms: 5000, tool_calls: 10, output_bytes: 64 * 1024 }, enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' } },
    limits: { timeout_seconds: 5, max_output_bytes: 64 * 1024, max_tool_calls: 10 },
    created_at: '2026-08-29T10:00:00.000Z',
    trace_id: 'trace-schema-check',
  }
}

type SkillInstruction = RuntimeManifest['agent_configuration']['skill_instructions'][number]

function inlineSkill(): SkillInstruction {
  return {
    id: 'skill-inventory',
    version: '1.0.0',
    instructions: '读取当前授权范围内的库存信息，说明数据口径，并明确列出缺料风险和建议动作。',
  }
}

function externalizedSkill(): SkillInstruction {
  const instructions = 'Read references/value.txt and return the exact immutable value.'
  const markdown = `---\nname: inventory-analysis\ndescription: Verify filesystem-backed Skill loading.\n---\n${instructions}\n`
  return {
    id: 'skill-inventory',
    name: 'inventory-analysis',
    description: 'Verify filesystem-backed Skill loading.',
    version: '1.0.0',
    artifact_ref: `packages/inventory-analysis/${'a'.repeat(64)}`,
    // Mirrors the adapter contract: instructions_sha256 covers the loaded
    // instruction body, while the SKILL.md index entry covers the whole file.
    instructions_sha256: sha256(instructions),
    files: [
      { path: 'SKILL.md', sha256: sha256(markdown), size: Buffer.byteLength(markdown) },
      { path: 'references/value.txt', sha256: sha256('value'), size: 5 },
    ],
  }
}

function applySkill(mutate: (skill: SkillInstruction) => void) {
  const manifest = baseManifest()
  const skill = inlineSkill()
  mutate(skill)
  manifest.agent_configuration.skill_instructions = [skill]
  return manifest
}

function schemaErrors(manifest: RuntimeManifest) {
  const valid = validate(JSON.parse(JSON.stringify(manifest)))
  return { valid, errors: validate.errors ?? [] }
}

function assertBothReject(manifest: RuntimeManifest, compilePattern: RegExp, label: string) {
  const { valid, errors } = schemaErrors(manifest)
  assert.equal(valid, false, `${label} should be rejected by the schema: ${JSON.stringify(errors)}`)
  assert.throws(() => compileRuntimeManifest(manifest), compilePattern, `${label} should be rejected by the compiler`)
}

function assertBothAccept(manifest: RuntimeManifest, label: string) {
  const { valid, errors } = schemaErrors(manifest)
  assert.equal(valid, true, `${label} should pass the schema: ${JSON.stringify(errors)}`)
  assert.doesNotThrow(() => compileRuntimeManifest(manifest), `${label} should pass the compiler`)
}

describe('Runtime Manifest Schema / compiler boundary', () => {
  it('EX-02 accepts a session-summary run and a conversation summary; rejects misuse', () => {
    const turn = baseManifest()
    turn.input.conversation_history = [{ role: 'user', content: '首条' }]
    turn.input.conversation_summary = { content: '摘要', covered_message_count: 3, sha256: sha256('摘要') }
    assertBothAccept(turn, 'conversation summary')
    const forged = structuredClone(turn)
    forged.input.conversation_summary!.sha256 = sha256('另一段')
    assert.throws(() => compileRuntimeManifest(forged), /conversation_summary is invalid/)

    const summaryRun = baseManifest()
    summaryRun.purpose = 'session-summary'
    summaryRun.summary_target = { session_id: 'session-long', covered_through_message_id: 'message-9' }
    summaryRun.session_id = null
    summaryRun.workspace_id = ''
    summaryRun.agent_version_id = null
    summaryRun.skills = []
    summaryRun.tools = []
    assertBothAccept(summaryRun, 'session-summary run')
    const withTools = structuredClone(summaryRun)
    withTools.tools = [{ id: 'read', version: '1.0.0' }]
    assert.throws(() => compileRuntimeManifest(withTools), /session-summary runs carry no Agent/)
    const strayTarget = baseManifest()
    strayTarget.summary_target = { session_id: 's', covered_through_message_id: 'm' }
    assert.throws(() => compileRuntimeManifest(strayTarget), /summary_target is required for and only allowed/)
  })

  it('项目空间 S2 accepts a project-archive run and rejects tools, data scopes or a stray target', () => {
    const archiveRun = baseManifest()
    archiveRun.purpose = 'project-archive'
    archiveRun.archive_target = { workspace_id: 'ws-team', update_id: 'warchup-1' }
    archiveRun.session_id = null
    archiveRun.workspace_id = ''
    archiveRun.agent_version_id = null
    archiveRun.skills = []
    archiveRun.tools = []
    archiveRun.data_scopes = []
    assertBothAccept(archiveRun, 'project-archive run')
    const withTools = structuredClone(archiveRun)
    withTools.tools = [{ id: 'read', version: '1.0.0' }]
    assertBothReject(withTools, /project-archive runs carry no Agent|maxItems|must NOT have more/, 'archive run with tools')
    const withScopes = structuredClone(archiveRun)
    withScopes.data_scopes = ['scope-east']
    assertBothReject(withScopes, /project-archive runs carry no Agent|must NOT have more/, 'archive run with data scopes')
    const strayTarget = baseManifest()
    strayTarget.archive_target = { workspace_id: 'ws-team', update_id: 'warchup-1' }
    assert.throws(() => compileRuntimeManifest(strayTarget), /archive_target is required for and only allowed/)
  })

  it('accepts a bounded MCP Connector snapshot and rejects secret or unsupported transport fields', () => {
    const manifest = baseManifest()
    manifest.permission_policy.network_policy = 'allowlist'
    manifest.mcp_connections = [{
      connector_id: 'connector-crm', server_name: 'crm', transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/rpc', auth_type: 'bearer', capability_digest: 'a'.repeat(64),
    }]
    assertBothAccept(manifest, 'approved MCP Connector snapshot')

    const secret = structuredClone(manifest) as RuntimeManifest & { mcp_connections: Array<Record<string, unknown>> }
    secret.mcp_connections[0]!['credential'] = 'must-not-enter-manifest'
    assertBothReject(secret, /未声明字段/, 'MCP snapshot containing a secret field')

    const unsupported = structuredClone(manifest)
    unsupported.mcp_connections![0]!.transport = 'stdio' as 'streamable-http'
    assertBothReject(unsupported, /仅支持 streamable-http/, 'unsupported MCP transport')
  })

  it('accepts user_oauth MCP pins with grant metadata and rejects tokens or grant fields on bearer', () => {
    const manifest = baseManifest()
    manifest.permission_policy.network_policy = 'allowlist'
    manifest.mcp_connections = [{
      connector_id: 'connector-crm',
      server_name: 'crm',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/rpc',
      auth_type: 'user_oauth',
      capability_digest: 'a'.repeat(64),
      grant_subject_id: 'usr-linlan',
      credential_version: 1,
    }]
    assert.doesNotThrow(() => compileRuntimeManifest(manifest), '合法的 user_oauth pin 应通过编译器')

    const withToken = structuredClone(manifest) as RuntimeManifest & { mcp_connections: Array<Record<string, unknown>> }
    withToken.mcp_connections[0]!['access_token'] = 'must-not-enter-manifest'
    assert.throws(() => compileRuntimeManifest(withToken), /未声明字段/, 'user_oauth pin 携带 access_token 应被拒绝')

    const bearerWithGrant = baseManifest()
    bearerWithGrant.permission_policy.network_policy = 'allowlist'
    bearerWithGrant.mcp_connections = [{
      connector_id: 'connector-crm',
      server_name: 'crm',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.test/rpc',
      auth_type: 'bearer',
      capability_digest: 'a'.repeat(64),
      grant_subject_id: 'usr-linlan',
    }]
    assert.throws(() => compileRuntimeManifest(bearerWithGrant), /none 与 bearer 不能携带用户授权字段/, 'bearer pin 携带 grant_subject_id 应被拒绝')
  })

  it('accepts a Task manifest without a product Session and still requires task_id', () => {
    const manifest = baseManifest()
    manifest.session_id = null
    assertBothAccept(manifest, 'session-neutral Task')
    const missingTask: Partial<RuntimeManifest> = structuredClone(manifest)
    delete missingTask.task_id
    const { valid } = schemaErrors(missingTask as RuntimeManifest)
    assert.equal(valid, false)
    assert.throws(() => compileRuntimeManifest(missingTask as RuntimeManifest), /task_id/)
  })

  it('requires an immutable PF-02 budget snapshot and rejects reservations that differ from Attempt limits', () => {
    const missingBudget: Partial<RuntimeManifest> = baseManifest()
    delete missingBudget.budget
    const missingResult = schemaErrors(missingBudget as RuntimeManifest)
    assert.equal(missingResult.valid, false)
    assert.throws(() => compileRuntimeManifest(missingBudget as RuntimeManifest), /budget/)
    assert.doesNotThrow(() => compileRuntimeManifest(normalizePersistedRuntimeManifest(
      missingBudget as RuntimeManifest,
    )), 'the explicit persisted-record upgrade bridge keeps pre-PF-02 Attempts executable')

    const mismatched = baseManifest()
    mismatched.budget.reservation.tool_calls = mismatched.limits.max_tool_calls - 1
    assert.equal(schemaErrors(mismatched).valid, true, 'JSON Schema owns structure; compiler owns cross-field equality')
    assert.throws(() => compileRuntimeManifest(mismatched), /reservation must match/)
  })

  it('accepts inline Skills with and without content-bearing files at both boundaries', () => {
    assertBothAccept(applySkill(() => undefined), 'inline Skill')
    const content = 'reference-content'
    assertBothAccept(applySkill(skill => {
      skill.files = [{ path: 'references/data.txt', content, sha256: sha256(content), size: Buffer.byteLength(content) }]
    }), 'inline Skill with files')
  })

  it('accepts externalized Skills (artifact_ref + instructions_sha256 + file index) at both boundaries', () => {
    assertBothAccept(applySkill(skill => {
      const external = externalizedSkill()
      delete skill.instructions
      Object.assign(skill, external)
    }), 'externalized Skill')
  })

  it('rejects externalized Skills missing instructions_sha256, files, or the SKILL.md entry at both boundaries', () => {
    assertBothReject(applySkill(skill => {
      const { instructions_sha256: _dropped, ...rest } = externalizedSkill()
      delete skill.instructions
      Object.assign(skill, rest)
    }), /instructions_sha256/, 'externalized Skill missing instructions_sha256')

    assertBothReject(applySkill(skill => {
      const { files: _dropped, ...rest } = externalizedSkill()
      delete skill.instructions
      Object.assign(skill, rest)
    }), /SKILL\.md/, 'externalized Skill missing files index')

    assertBothReject(applySkill(skill => {
      const external = externalizedSkill()
      external.files = external.files!.filter(file => file.path !== 'SKILL.md')
      delete skill.instructions
      Object.assign(skill, external)
    }), /SKILL\.md/, 'externalized file index without SKILL.md')
  })

  it('rejects invalid artifact_ref at both boundaries', () => {
    assertBothReject(applySkill(skill => {
      const external = externalizedSkill()
      external.artifact_ref = '../escape/abc'
      delete skill.instructions
      Object.assign(skill, external)
    }), /artifact reference is invalid/, 'invalid artifact_ref')
    for (const segment of ['..', '.']) {
      assertBothReject(applySkill(skill => {
        const external = externalizedSkill()
        external.artifact_ref = `packages/${segment}/${'a'.repeat(64)}`
        delete skill.instructions
        Object.assign(skill, external)
      }), /artifact reference is invalid/, `artifact_ref with ${segment} package segment`)
    }
    for (const [ref, label] of [
      ['packages/only-segment', 'missing digest segment'],
      [`packages/ok/${'a'.repeat(32)}`, 'short digest'],
      [`packages/ok/${'A'.repeat(64)}`, 'non-lowercase digest'],
    ] as const) {
      assertBothReject(applySkill(skill => {
        const external = externalizedSkill()
        external.artifact_ref = ref
        delete skill.instructions
        Object.assign(skill, external)
      }), /artifact reference is invalid/, `artifact_ref with ${label}`)
    }
  })

  it('rejects legacy artifact_ref shapes (symbol-edged package segments) at both boundaries', () => {
    // B-02 唯一引用规则：旧版生成器只替换非法字符并截断、未清理首尾符号，
    // 中文名落成 packages/____/<sha>——Schema/编译/存储读写同口径，不再接受。
    for (const segment of ['____', '-degenerate', 'degenerate.', '.hidden', '._edge_', 'a'.repeat(63) + '-']) {
      assertBothReject(applySkill(skill => {
        const external = externalizedSkill()
        external.artifact_ref = `packages/${segment}/${'a'.repeat(64)}`
        delete skill.instructions
        Object.assign(skill, external)
      }), /artifact reference is invalid/, `legacy artifact_ref ${segment}`)
    }
  })

  it('rejects externalized file index entries carrying inline content at both boundaries', () => {
    const body = 'content that must not live in the manifest'
    assertBothReject(applySkill(skill => {
      const external = externalizedSkill()
      external.files = external.files!.map(file =>
        file.path === 'SKILL.md' ? file : { ...file, content: body, sha256: sha256(body), size: Buffer.byteLength(body) })
      delete skill.instructions
      Object.assign(skill, external)
    }), /不得携带 content/, 'externalized file index with inline content')
  })

  it('accepts an artifact revision on a file mount and rejects malformed ones at both boundaries', () => {
    const withRevision = (revision: unknown) => {
      const manifest = baseManifest()
      const content = '# 周报\n第一版'
      manifest.input.file_mounts = [{
        file_id: 'file-artifact-1', mount_path: '/workspace/input/01-report.txt', access: 'read_only',
        source_name: 'report.md', media_type: 'text/markdown; charset=utf-8',
        content_sha256: sha256(content), content,
        artifact_revision: revision as { artifact_id: string; version: number },
      }]
      return manifest
    }
    assertBothAccept(withRevision({ artifact_id: 'artifact-abc123', version: 2 }), 'artifact revision')
    assertBothReject(withRevision({ artifact_id: 'artifact-abc123', version: 0 }), /artifact revision is invalid/, 'version 0')
    assertBothReject(withRevision({ artifact_id: '../escape', version: 1 }), /artifact revision is invalid/, 'malformed artifact id')
  })

  it('accepts image attachments and rejects malformed or mismatched ones', () => {
    const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)])
    const withAttachment = (mutate: (attachment: Record<string, unknown>) => void = () => {}) => {
      const manifest = baseManifest()
      const attachment: Record<string, unknown> = {
        file_id: 'file-image-1',
        name: 'image-1.png',
        mount_path: '/workspace/input/attachments/image-1.png',
        media_type: 'image/png',
        content_sha256: createHash('sha256').update(bytes).digest('hex'),
        content_base64: bytes.toString('base64'),
        source: 'S1 第 4 行',
      }
      mutate(attachment)
      manifest.input.attachments = [attachment as unknown as NonNullable<RuntimeManifest['input']['attachments']>[number]]
      return manifest
    }
    assertBothAccept(withAttachment(), 'image attachment')
    // 摘要与内容的关系只有编译器能核；Schema 只能约束形状。
    assert.throws(() => compileRuntimeManifest(withAttachment(a => { a.content_sha256 = '0'.repeat(64) })), /attachment checksum mismatch/, 'checksum drift')
    assertBothReject(withAttachment(a => { a.mount_path = '/workspace/input/image-1.png' }), /attachment mount path/, 'path outside attachments')
    assertBothReject(withAttachment(a => { a.media_type = 'text/plain' }), /media type/, 'non-image media type')
    const many = baseManifest()
    many.input.attachments = Array.from({ length: 13 }, (_, index) => ({
      file_id: 'file-image-1',
      name: `image-${index + 1}.png`,
      mount_path: `/workspace/input/attachments/image-${index + 1}.png`,
      media_type: 'image/png',
      content_sha256: createHash('sha256').update(bytes).digest('hex'),
      content_base64: bytes.toString('base64'),
    }))
    assertBothReject(many, /at most 12/, 'attachment count cap')
  })

  it('original file mounts (2b-4): references only, under input/original/, and only with bash', () => {
    const withOriginal = (overrides: Partial<NonNullable<RuntimeManifest['input']['original_mounts']>[number]> = {}, tools = ['bash']) => {
      const manifest = baseManifest()
      manifest.tools = tools.map(id => ({ id, version: '1.0.0' }))
      manifest.input.original_mounts = [{
        file_id: 'file-artifact-1', mount_path: '/workspace/input/original/01-data.xlsx', access: 'read_only',
        source_name: '数据.xlsx', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sha256: 'a'.repeat(64), size_bytes: 1024, artifact_revision: { artifact_id: 'artifact-abc123', version: 1 },
        ...overrides,
      }]
      return manifest
    }
    assertBothAccept(withOriginal(), 'xlsx original with bash')
    assertBothReject(withOriginal({ mount_path: '/workspace/input/01-data.xlsx' }), /input\/original/, 'outside input/original')
    assertBothReject(withOriginal({ mount_path: '/workspace/input/original/run.sh' }), /input\/original/, 'extension not accepted')
    assertBothReject(withOriginal({ sha256: 'xyz' }), /sha256 is invalid/, 'malformed digest')
    assertBothReject(withOriginal({ size_bytes: 20 * 1024 * 1024 + 1 }), /size is invalid/, 'over 20 MB')
    assertBothReject(withOriginal({ content: 'bytes' } as never), /undeclared fields: content/, 'bytes never travel in the Manifest')
    // Without bash nothing can read the original; the compiler refuses the combination.
    assert.throws(() => compileRuntimeManifest(withOriginal({}, ['read'])), /require the bash tool/)
    const twice = withOriginal()
    twice.input.original_mounts!.push({ ...twice.input.original_mounts![0]!, mount_path: '/workspace/input/original/02-data.xlsx' })
    assert.throws(() => compileRuntimeManifest(twice), /duplicate original mount/)
  })

  it('rejects structural ambiguities at both boundaries', () => {
    const cases: Array<[string, (skill: SkillInstruction) => void, RegExp]> = [
      ['externalized Skill carrying inline instructions', skill => Object.assign(skill, externalizedSkill()), /内联 instructions/],
      ['orphan instructions_sha256 on an inline Skill', skill => { skill.instructions_sha256 = 'a'.repeat(64) }, /instructions_sha256/],
      ['undeclared field', skill => Object.assign(skill, { unsigned_field: true }), /未声明字段/],
    ]
    for (const [label, mutate, compilePattern] of cases) {
      assertBothReject(applySkill(mutate), compilePattern, label)
    }
  })

  it('pins the session-selected Skill to the Run skill snapshot at both boundaries', () => {
    const accepted = baseManifest()
    accepted.selected_skill = 'skill-inventory@1.0.0'
    assertBothAccept(accepted, 'selected_skill 指向本 Run 快照内的 Skill')

    // 形态（id@version）由 schema 与编译器同时固定。
    const malformed = baseManifest()
    malformed.selected_skill = 'skill inventory@1.0.0'
    assertBothReject(malformed, /selected_skill 必须是本 Run 固定快照中的 Skill 引用/, 'selected_skill 形态非法')

    // 成员关系只有编译器能判定：schema 只固定形态，编译器必须 fail-closed，
    // 不允许 latest 语义或快照外引用进入持久化 Manifest。
    const notInSnapshot = baseManifest()
    notInSnapshot.selected_skill = 'skill-missing@1.0.0'
    assert.equal(schemaErrors(notInSnapshot).valid, true, 'schema 不校验成员关系，只固定形态')
    assert.throws(
      () => compileRuntimeManifest(notInSnapshot),
      /selected_skill 必须是本 Run 固定快照中的 Skill 引用/,
    )
  })

  it('rejects inline Skills missing instructions or file content at both boundaries', () => {
    assertBothReject(applySkill(skill => { delete skill.instructions }), /instructions must be at least/, 'inline Skill missing instructions')
    assertBothReject(applySkill(skill => {
      skill.files = [{ path: 'references/data.txt', sha256: sha256('x'), size: 1 }]
    }), /只能由受控文件夹引用省略/, 'inline file missing content')
  })

  it('rejects externalized file index whose declared sizes exceed the byte budget (compiler only)', () => {
    // 声明大小总和属内容侧预算：schema 只校验单项为非负整数，不合计；编译器汇总拒绝。
    const manifest = applySkill(skill => {
      const external = externalizedSkill()
      external.files = [
        { path: 'SKILL.md', sha256: 'a'.repeat(64), size: MAX_SKILL_BYTES },
        { path: 'references/big.txt', sha256: 'b'.repeat(64), size: 1 },
      ]
      delete skill.instructions
      Object.assign(skill, external)
    })
    const { valid } = schemaErrors(manifest)
    assert.equal(valid, true, 'declared size sum is a compiler-side budget; the schema does not total sizes')
    assert.throws(() => compileRuntimeManifest(manifest), /超过 1 MB/)
  })

  it('keeps content checks in the compiler: the schema accepts a file whose sha256 does not match its content', () => {
    const manifest = applySkill(skill => {
      skill.files = [{ path: 'references/data.txt', content: 'actual', sha256: sha256('forged'), size: 6 }]
    })
    const { valid } = schemaErrors(manifest)
    assert.equal(valid, true, 'digest mismatch is content validation; the schema does not read bodies')
    assert.throws(() => compileRuntimeManifest(manifest), /摘要不匹配/)
  })

  it('records built-in Skills that were covered or disabled, and rejects malformed exclusions', () => {
    const withExclusions = (exclusions: unknown) => ({ ...baseManifest(), builtin_skill_exclusions: exclusions }) as RuntimeManifest
    assertBothAccept(withExclusions([
      { skill: 'dsh-work-html-page@1.0.0', reason: 'covered', covered_by: 'skill-inventory@1.0.0' },
      { skill: 'dsh-work-file-analysis@1.0.0', reason: 'disabled' },
    ]), 'covered and disabled built-in Skills')
    assertBothReject(withExclusions([{ skill: 'skill-inventory@1.0.0', reason: 'disabled' }]), /built-in Skill reference/, 'non built-in exclusion')
    assertBothReject(withExclusions([{ skill: 'dsh-work-html-page@1.0.0', reason: 'removed' }]), /reason is invalid/, 'unknown reason')
    assertBothReject(withExclusions([{ skill: 'dsh-work-html-page@1.0.0', reason: 'disabled', note: 'x' }]), /unsupported field/, 'extra field')
    assertBothReject(withExclusions([]), /non-empty/, 'empty exclusions')
    // Cross references are content checks: the schema only sees well-formed strings.
    const dangling = withExclusions([{ skill: 'dsh-work-html-page@1.0.0', reason: 'covered', covered_by: 'skill-other@1.0.0' }])
    assert.equal(schemaErrors(dangling).valid, true)
    assert.throws(() => compileRuntimeManifest(dangling), /covered_by must reference an assembled Skill/)
    const both = withExclusions([{ skill: 'dsh-work-html-page@1.0.0', reason: 'disabled' }])
    both.skills = [...both.skills, { id: 'dsh-work-html-page', version: '1.0.0' }]
    assert.throws(() => compileRuntimeManifest(both), /both excluded and assembled/)
  })

  it('pins model requirements and rejects unknown, repeated or malformed declarations', () => {
    assertBothAccept({ ...baseManifest(), model_requirements: ['long-context', 'structured-output'] }, 'declared requirements')
    assertBothAccept({ ...baseManifest(), model_requirements: [] }, 'no extra requirements')
    for (const value of [['unknown'], ['long-context', 'long-context'], 'structured-output', null]) {
      assertBothReject({ ...baseManifest(), model_requirements: value } as RuntimeManifest, /model_requirements/, 'invalid model requirements')
    }
  })

  it('PF-04 pins a bounded approval checkpoint in a resumed Attempt', () => {
    const manifest = baseManifest()
    manifest.attempt_id = 'attempt-resumed'
    const checkpointContext = {
      pending_action: { arguments: { orderId: '42', expectedVersion: 'etag-v1' } },
      completed_tool_results: [{
        call_id: 'call-read-1', tool_name: 'erp.read', parameter_digest: 'c'.repeat(64),
        result: { status: 'open' },
      }],
      workspace_files: [{
        path: 'output/库存报告.md', content: '# Draft\n',
        sha256: createHash('sha256').update('# Draft\n').digest('hex'),
      }],
      assistant_output: '已读取订单，等待更新审批。',
    }
    const parameterDigest = createHash('sha256').update(canonicalJson(checkpointContext.pending_action.arguments)).digest('hex')
    const checkpointContextSha256 = createHash('sha256').update(canonicalJson(checkpointContext)).digest('hex')
    manifest.resume = {
      strategy: 'new-attempt-context-v1', checkpoint_id: 'checkpoint-1', checkpoint_digest: 'a'.repeat(64),
      source_attempt_id: 'attempt-1', approval_id: 'approval-1', action_name: 'erp.update',
      parameter_digest: parameterDigest, resource_ref: 'erp://orders/42', data_version: 'etag-v1',
      approved_by: 'usr-admin', approved_at: '2026-09-22T10:00:00.000Z',
      checkpoint_context_sha256: checkpointContextSha256,
      checkpoint_context: checkpointContext,
    }
    assertBothAccept(manifest, 'persistent approval resume')
    const traversal = structuredClone(manifest)
    traversal.resume!.checkpoint_context.workspace_files[0]!.path = 'output/../库存报告.md'
    assertBothReject(traversal, /workspace file|pattern/, 'checkpoint traversal path')
    assertBothReject({ ...manifest, resume: { ...manifest.resume, parameter_digest: 'changed' } } as RuntimeManifest, /digest/, 'invalid resume digest')
    const tampered = {
      ...manifest,
      resume: {
        ...manifest.resume,
        checkpoint_context: {
          ...manifest.resume.checkpoint_context,
          pending_action: { arguments: { orderId: 'changed' } },
        },
      },
    } as RuntimeManifest
    assert.equal(schemaErrors(tampered).valid, true, 'JSON Schema owns structure; compiler owns checkpoint digest integrity')
    assert.throws(() => compileRuntimeManifest(tampered), /digest/, 'tampered checkpoint action should fail content integrity')
  })

  it('PF-05 pins only bounded reviewed memory versions', () => {
    const manifest = baseManifest()
    manifest.memory_context = [{
      memoryVersionId: 'memory-version-1',
      title: '报告展示偏好',
      version: 2,
      kind: 'preference',
      visibility: 'private',
      contentDigest: 'd'.repeat(64),
      excerpt: '报告先给结论，再列证据和待确认项。',
    }]
    assertBothAccept(manifest, 'controlled memory context')
    const duplicate = structuredClone(manifest)
    duplicate.memory_context!.push(structuredClone(duplicate.memory_context![0]!))
    assert.equal(schemaErrors(duplicate).valid, true, 'field-level uniqueness belongs to the compiler')
    assert.throws(() => compileRuntimeManifest(duplicate), /duplicate versions/)
    assertBothReject({
      ...manifest,
      memory_context: [{ ...manifest.memory_context[0]!, contentDigest: 'not-a-digest' }],
    } as RuntimeManifest, /contentDigest/, 'invalid memory digest')
  })

  it('项目空间 S1 pins the project brief version with a matching digest', () => {
    const manifest = baseManifest()
    const content = '目标：本季度把华东区缺货率降到 3% 以下。'
    manifest.project_context = {
      brief: { version_id: 'wbrief-1', version_no: 2, content, content_sha256: sha256(content), due_date: '2026-12-31' },
    }
    assertBothAccept(manifest, 'project brief context')
    assertBothAccept({ ...manifest, project_context: { brief: { ...manifest.project_context.brief!, due_date: null } } }, 'brief without due date')
    const tampered = { ...manifest, project_context: { brief: { ...manifest.project_context.brief!, content: '已被篡改' } } }
    assert.equal(schemaErrors(tampered).valid, true, 'digest/body matching belongs to the compiler')
    assert.throws(() => compileRuntimeManifest(tampered), /content_sha256/)
    assertBothReject({
      ...manifest,
      project_context: { brief: { ...manifest.project_context.brief!, extra: true } },
    } as unknown as RuntimeManifest, /project_context|brief/, 'unknown brief field')
  })

  it('项目空间 S2 pins the project archive version with a matching digest', () => {
    const manifest = baseManifest()
    const items = ['缺货集中在高周转 SKU 类目。', '决策：按类目设置安全库存。']
    manifest.project_context = {
      archive: { version_id: 'warch-1', version_no: 3, items, items_sha256: archiveDigest(items) },
    }
    assertBothAccept(manifest, 'archive-only project context')
    const content = '目标：缺货率降到 3%'
    assertBothAccept({
      ...manifest,
      project_context: {
        ...manifest.project_context,
        brief: { version_id: 'wbrief-1', version_no: 1, content, content_sha256: sha256(content), due_date: null },
      },
    }, 'brief and archive')
    const tampered = { ...manifest, project_context: { archive: { ...manifest.project_context.archive!, items: ['已被篡改'] } } }
    assert.equal(schemaErrors(tampered).valid, true, 'digest/items matching belongs to the compiler')
    assert.throws(() => compileRuntimeManifest(tampered), /items_sha256/)
    const duplicated = ['同一条', '同一条']
    assertBothReject({
      ...manifest,
      project_context: { archive: { ...manifest.project_context.archive!, items: duplicated, items_sha256: archiveDigest(duplicated) } },
    }, /archive items are invalid/, 'duplicated archive items')
    assertBothReject({ ...manifest, project_context: {} } as RuntimeManifest, /project_context|fewer than 1/, 'empty project context')
  })

  it('rejects the removed Agent delegation fields', () => {
    const manifest = { ...baseManifest(), delegation_policy: { allowed_agent_version_ids: [] } } as unknown as RuntimeManifest
    assert.equal(schemaErrors(manifest).valid, false)
  })
})
