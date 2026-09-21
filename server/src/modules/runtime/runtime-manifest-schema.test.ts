import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import Ajv2020Module from 'ajv/dist/2020.js'
import { MAX_SKILL_BYTES } from '../../domain/skill-package-limits.ts'
import { compileRuntimeManifest } from './manifest-compiler.ts'
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

  it('pins model requirements and rejects unknown, repeated or malformed declarations', () => {
    assertBothAccept({ ...baseManifest(), model_requirements: ['long-context', 'structured-output'] }, 'declared requirements')
    assertBothAccept({ ...baseManifest(), model_requirements: [] }, 'no extra requirements')
    for (const value of [['unknown'], ['long-context', 'long-context'], 'structured-output', null]) {
      assertBothReject({ ...baseManifest(), model_requirements: value } as RuntimeManifest, /model_requirements/, 'invalid model requirements')
    }
  })

  it('B-03/I-04: pins platform tool bindings at both boundaries without crossing the tools[] namespace', () => {
    const pin = () => ({
      tool: 'tool-erp-read@1.0.0',
      binding_id: 'tool-binding-9f2c',
      revision: 3,
      digest: sha256('binding-snapshot'),
    })
    const applyBindings = (mutate: (pins: Record<string, unknown>[]) => void) => {
      const manifest = baseManifest()
      const pins = [pin()]
      mutate(pins)
      manifest.tool_bindings = pins as unknown as RuntimeManifest['tool_bindings']
      return manifest
    }
    // tools[] 是 DSH 运行时名命名空间，tool_bindings 是平台 id@version 命名空间——
    // 两者独立校验，互不交叉引用。
    assertBothAccept(applyBindings(() => undefined), 'platform binding pin')
    assertBothAccept(baseManifest(), 'manifest without tool_bindings')

    assertBothReject(applyBindings(pins => { pins[0]!.endpoint = 'https://erp.internal' }), /未声明字段/, 'binding pin with undeclared field')
    assertBothReject(applyBindings(pins => { pins[0]!.tool = 'not-a-reference' }), /id@version/, 'binding pin with malformed tool reference')
    // 同一工具的重复固定是编译器侧检查——schema 无法表达按字段去重。
    {
      const duplicated = applyBindings(pins => { pins.push(pin()) })
      assert.equal(schemaErrors(duplicated).valid, true)
      assert.throws(() => compileRuntimeManifest(duplicated), /重复固定/)
    }
    assertBothReject(applyBindings(pins => { pins[0]!.binding_id = '' }), /binding_id/, 'binding pin with blank binding_id')
    assertBothReject(applyBindings(pins => { pins[0]!.revision = 0 }), /revision/, 'binding pin with non-positive revision')
    assertBothReject(applyBindings(pins => { pins[0]!.digest = 'A'.repeat(64) }), /digest/, 'binding pin with uppercase digest')
    assertBothReject(applyBindings(pins => { pins[0]!.digest = 'abc' }), /digest/, 'binding pin with short digest')
  })
})
