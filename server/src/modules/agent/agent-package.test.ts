import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { parseAgentPackage } from './agent-package.ts'
import { AGENT_PACKAGE_SCHEMA } from './agent-package.schema.ts'

/**
 * Agent 发布包清单（agent.yaml）严格结构校验单测：
 * apiVersion/kind/metadata/spec 分层格式、Schema 拒绝规则、平台受管字段、
 * 精确依赖引用与包内候选版本核对。
 */

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

const PROMPT = '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。'

interface ManifestOverrides {
  apiVersion?: string
  kind?: string
  id?: string
  name?: string
  version?: string
  description?: string
  instructions?: string
  specLines?: string[]
  topLines?: string[]
  metadataLines?: string[]
}

function agentYaml(overrides: ManifestOverrides = {}) {
  return [
    `apiVersion: ${overrides.apiVersion ?? 'dsh-work.ai/v1'}`,
    `kind: ${overrides.kind ?? 'AgentPackage'}`,
    'metadata:',
    `  id: ${overrides.id ?? 'zip-agent'}`,
    `  name: ${overrides.name ?? '退款预测助手'}`,
    `  version: ${overrides.version ?? '0.1.0'}`,
    `  description: ${overrides.description ?? '基于历史退款记录预测高风险订单。'}`,
    ...(overrides.metadataLines ?? []),
    'spec:',
    `  instructions: ${overrides.instructions ?? 'prompts/system.md'}`,
    ...(overrides.specLines ?? []),
    ...(overrides.topLines ?? []),
    '',
  ].join('\n')
}

function buildZip(entries: Record<string, string>, options: { checksums?: boolean; rootDir?: string } = {}) {
  const files: Record<string, Uint8Array> = {}
  for (const [path, text] of Object.entries(entries)) files[path] = strToU8(text)
  if (options.checksums !== false) {
    const rootDir = options.rootDir ?? ''
    const checksumPath = `${rootDir}checksums.json`
    if (!entries[checksumPath]) {
      const table = Object.fromEntries(
        Object.keys(entries)
          .filter(path => path.startsWith(rootDir))
          .map(path => [path.slice(rootDir.length), createHash('sha256').update(entries[path]!).digest('hex')]),
      )
      files[checksumPath] = strToU8(JSON.stringify({ files: table }))
    }
  }
  return zipSync(files, { level: 0 })
}

function basePackage(overrides: ManifestOverrides = {}, entries: Record<string, string> = {}) {
  return buildZip({
    'agent.yaml': agentYaml(overrides),
    'prompts/system.md': PROMPT,
    ...entries,
  })
}

const CASES = `apiVersion: dsh-work.ai/evaluation/v1
kind: AgentEvaluationSuite
cases:
  - name: 正常预测
    kind: success
    input: 评估本周退款风险
    automatedAssertions: [run_attempt_recorded, execution_succeeded, output_non_empty]
    manualReview:
      required: true
      rubric: 输出高风险订单清单与依据
`

test('Schema 文档与代码常量保持同步', () => {
  const published = JSON.parse(readFileSync(resolve(moduleDirectory, '../../../../docs/development/agent-package.schema.json'), 'utf8'))
  assert.deepEqual(published, JSON.parse(JSON.stringify(AGENT_PACKAGE_SCHEMA)))
})

test('最小有效包解析成功：默认值展开进 AgentSpec，checksums 覆盖时无警告', () => {
  const parsed = parseAgentPackage(basePackage())
  const { spec } = parsed
  assert.equal(spec.apiVersion, 'dsh-work.ai/v1')
  assert.equal(spec.metadata.id, 'zip-agent')
  assert.equal(spec.metadata.version, '0.1.0')
  assert.deepEqual(spec.instructions, { path: 'prompts/system.md', body: PROMPT })
  assert.deepEqual(spec.input, { type: 'text' })
  assert.deepEqual(spec.output, { type: 'text' })
  assert.deepEqual(spec.context, { conversationHistory: 'recent' })
  assert.deepEqual(spec.limits, { timeoutSeconds: 300, maxToolCalls: 20, maxOutputBytes: 65536 })
  assert.equal(spec.evaluation.cases, null)
  assert.deepEqual(spec.model, { requirements: [] })
  assert.equal(parsed.checksumsVerified, true)
  assert.deepEqual(parsed.warnings, [])
})

test('嵌套顶层目录与完整 spec 字段解析', () => {
  const parsed = parseAgentPackage(buildZip({
    'pkg/agent.yaml': agentYaml({
      name: '文档助手',
      version: '1.2.3',
      specLines: [
        '  capabilities:',
        '    skills:',
        '      - id: skill-document',
        '        version: 1.0.0',
        '    tools:',
        '      - id: read',
        '        version: 2.0.0',
        '  input:',
        '    type: text',
        '  output:',
        '    type: text',
        '  context:',
        '    conversationHistory: recent',
        '  catalog:',
        '    welcomeMessage: 你好，我是文档助手',
        '    examplePrompts: [总结这份文档]',
        '  limits:',
        '    timeoutSeconds: 120',
        '    maxToolCalls: 8',
        '    maxOutputBytes: 32768',
        '  evaluation:',
        '    cases: evals/cases.yaml',
        '  model:',
        '    requirements: [long-context]',
      ],
    }),
    'pkg/prompts/system.md': PROMPT,
    'pkg/evals/cases.yaml': CASES,
  }, { rootDir: 'pkg/' }))
  const { spec } = parsed
  assert.equal(parsed.rootDir, 'pkg/')
  assert.equal(spec.metadata.name, '文档助手')
  assert.deepEqual(spec.capabilities.skills, ['skill-document@1.0.0'])
  assert.deepEqual(spec.capabilities.tools, ['read@2.0.0'])
  assert.deepEqual(spec.limits, { timeoutSeconds: 120, maxToolCalls: 8, maxOutputBytes: 32768 })
  assert.equal(spec.catalog.welcomeMessage, '你好，我是文档助手')
  assert.deepEqual(spec.catalog.examplePrompts, ['总结这份文档'])
  assert.equal(spec.evaluation.cases, 'evals/cases.yaml')
  assert.deepEqual(spec.model.requirements, ['long-context'])
  assert.deepEqual(parsed.declared, { skills: ['skill-document@1.0.0'], tools: ['read@2.0.0'] })
  assert.equal(parsed.cases.length, 1)
})

test('limits 部分声明时其余字段按平台默认值展开', () => {
  const parsed = parseAgentPackage(basePackage({ specLines: ['  limits:', '    timeoutSeconds: 120'] }))
  assert.deepEqual(parsed.spec.limits, { timeoutSeconds: 120, maxToolCalls: 20, maxOutputBytes: 65536 })
})

test('不支持的 apiVersion 与 kind 明确拒绝', () => {
  assert.throws(() => parseAgentPackage(basePackage({ apiVersion: 'dsh-work.ai/v2' })), /apiVersion 必须为 "dsh-work\.ai\/v1"/)
  assert.throws(() => parseAgentPackage(basePackage({ kind: 'Agent' })), /kind 必须为 "AgentPackage"/)
  assert.throws(() => parseAgentPackage(basePackage({ apiVersion: 'dsh-work/v1' })), /apiVersion 必须为/)
})

test('旧扁平清单按格式错误明确拒绝，不做双格式解析', () => {
  const legacy = [
    'id: legacy-agent',
    'display_name: 旧包助手',
    'version: 1.2.3',
    'description: 旧格式兼容样本。',
    `system_prompt: ${PROMPT}`,
    'role_ids: [role-employee]',
    'tool_refs: [read@1.0.0]',
    '',
  ].join('\n')
  assert.throws(
    () => parseAgentPackage(buildZip({ 'agent.yaml': legacy, 'prompts/system.md': PROMPT })),
    /旧扁平清单字段.*apiVersion.*metadata\/spec/,
  )
  // 只有 spec 没有 apiVersion/kind 同样按旧格式提示拒绝。
  assert.throws(
    () => parseAgentPackage(buildZip({ 'agent.yaml': 'spec:\n  instructions: prompts/system.md\n', 'prompts/system.md': PROMPT })),
    /旧扁平清单字段|结构校验未通过/,
  )
})

for (const [label, yaml, pattern] of [
  ['顶层未知字段', 'apiVersion: dsh-work.ai/v1\nkind: AgentPackage\nauthor: ops-team\nmetadata:\n  id: zip-agent\n  name: 退款预测助手\n  version: 0.1.0\n  description: 基于历史退款记录预测高风险订单。\nspec:\n  instructions: prompts/system.md\n', /agent\.yaml 包含未定义字段 author/],
  ['metadata 未知字段', null, /metadata 包含未定义字段 display_name/],
  ['spec 未知字段', null, /spec 包含未定义字段 system_prompt/],
  ['缺少 metadata', 'apiVersion: dsh-work.ai/v1\nkind: AgentPackage\nspec:\n  instructions: prompts/system.md\n', /缺少必填字段 metadata/],
  ['缺少 spec', 'apiVersion: dsh-work.ai/v1\nkind: AgentPackage\nmetadata:\n  id: zip-agent\n  name: 退款预测助手\n  version: 0.1.0\n  description: 基于历史退款记录预测高风险订单。\n', /缺少必填字段 spec/],
  ['缺少 spec.instructions', 'apiVersion: dsh-work.ai/v1\nkind: AgentPackage\nmetadata:\n  id: zip-agent\n  name: 退款预测助手\n  version: 0.1.0\n  description: 基于历史退款记录预测高风险订单。\nspec:\n  input:\n    type: text\n', /spec 缺少必填字段 instructions/],
] as const) {
  test(`严格结构校验拒绝：${label}`, () => {
    const document = label === 'metadata 未知字段'
      ? agentYaml({ metadataLines: ['  display_name: 另一个名称'] })
      : label === 'spec 未知字段'
        ? agentYaml({ specLines: [`  system_prompt: ${PROMPT}`] })
        : yaml
    assert.throws(
      () => parseAgentPackage(buildZip({ 'agent.yaml': document!, 'prompts/system.md': PROMPT })),
      pattern,
    )
  })
}

test('YAML 重复键拒绝', () => {
  const yaml = [
    'apiVersion: dsh-work.ai/v1',
    'kind: AgentPackage',
    'metadata:',
    '  id: zip-agent',
    '  id: other-agent',
    '  name: 退款预测助手',
    '  version: 0.1.0',
    '  description: 基于历史退款记录预测高风险订单。',
    'spec:',
    '  instructions: prompts/system.md',
    '',
  ].join('\n')
  assert.throws(
    () => parseAgentPackage(buildZip({ 'agent.yaml': yaml, 'prompts/system.md': PROMPT })),
    /不是有效的 YAML/,
  )
})

test('YAML 锚点/别名在对象化阶段被捕获并映射为包校验错误', () => {
  const yaml = [
    'apiVersion: dsh-work.ai/v1',
    'kind: AgentPackage',
    'metadata:',
    '  id: zip-agent',
    '  name: &anchor 退款预测助手',
    '  version: 0.1.0',
    '  description: *anchor',
    'spec:',
    '  instructions: prompts/system.md',
    '',
  ].join('\n')
  let error: unknown
  try {
    parseAgentPackage(buildZip({ 'agent.yaml': yaml, 'prompts/system.md': PROMPT }))
  } catch (cause) {
    error = cause
  }
  assert.ok(error instanceof Error)
  assert.match(error.message, /Agent 包校验失败：agent\.yaml 不是有效的 YAML/)
  assert.equal((error as { status?: number }).status, 422)
  assert.equal((error as { code?: string }).code, 'agent_package_invalid')
})

for (const [instructions, label] of [
  ['../secrets/system.md', '路径遍历'],
  ['/abs/system.md', '绝对路径'],
  ['system.md', '非 prompts/ 目录'],
  ['prompts/system.txt', '非 .md 文件'],
  ['prompts/sub dir/system.md', '含空格路径'],
] as const) {
  test(`spec.instructions 拒绝非法文件引用：${label}`, () => {
    assert.throws(() => parseAgentPackage(basePackage({ instructions })), /instructions.*pattern|结构校验未通过/)
  })
}

test('spec.instructions 必须是文件路径字符串，内联指令对象拒绝', () => {
  const yaml = agentYaml({ instructions: '' }) + ''
  const inline = yaml.replace('  instructions: \n', '  instructions:\n    body: 内联指令内容不得出现在包清单中\n')
  assert.throws(
    () => parseAgentPackage(buildZip({ 'agent.yaml': inline, 'prompts/system.md': PROMPT })),
    /结构校验未通过/,
  )
})

test('spec.instructions 指定文件不存在或正文过短拒绝', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({ instructions: 'prompts/missing.md' })),
    /spec\.instructions 指定的 prompts\/missing\.md 不存在/,
  )
  assert.throws(
    () => parseAgentPackage(buildZip({ 'agent.yaml': agentYaml(), 'prompts/system.md': '太短' })),
    /System Prompt 长度必须为 20～20000 个字符/,
  )
})

for (const [label, overrides, pattern] of [
  ['id 非法', { id: 'BAD ID' }, /metadata\.id/],
  ['id 过短', { id: 'ab' }, /metadata\.id/],
  ['version 预发布后缀', { version: '1.0.0-rc.1' }, /metadata\.version/],
  ['version 缺段', { version: '1.0' }, /metadata\.version/],
  ['name 过短', { name: '短' }, /metadata\.name/],
  ['description 过短', { description: '太短' }, /metadata\.description/],
] as const) {
  test(`metadata 校验拒绝：${label}`, () => {
    assert.throws(() => parseAgentPackage(basePackage(overrides)), pattern)
  })
}

for (const [label, lines, pattern] of [
  ['字符串引用而非对象', ['  capabilities:', '    tools: [read@1.0.0]'], /结构校验未通过/],
  ['缺少 version', ['  capabilities:', '    tools:', '      - id: read'], /缺少必填字段 version|capabilities\.tools\.0 缺少必填字段/],
  ['非精确版本 latest', ['  capabilities:', '    tools:', '      - id: read', '        version: latest'], /结构校验未通过/],
  ['非精确版本范围', ['  capabilities:', '    tools:', '      - id: read', '        version: ^1.0.0'], /结构校验未通过/],
  ['能力 id 非法', ['  capabilities:', '    tools:', '      - id: "BAD ID"', '        version: 1.0.0'], /结构校验未通过/],
  ['引用含未知字段', ['  capabilities:', '    tools:', '      - id: read', '        version: 1.0.0', '        channel: beta'], /包含未定义字段 channel/],
] as const) {
  test(`capabilities 引用校验拒绝：${label}`, () => {
    assert.throws(() => parseAgentPackage(basePackage({ specLines: [...lines] })), pattern)
  })
}

test('同一能力重复声明（含相同版本）直接拒绝', () => {
  for (const version of ['1.0.0', '2.0.0']) {
    assert.throws(
      () => parseAgentPackage(basePackage({ specLines: [
        '  capabilities:',
        '    tools:',
        '      - id: read',
        '        version: 1.0.0',
        `      - id: read`,
        `        version: ${version}`,
      ] })),
      /spec\.capabilities\.tools 中 read 声明了多条引用/,
    )
  }
})

for (const [label, lines, pattern] of [
  ['input.type 非法', ['  input:', '    type: file'], /input\.type 必须为 "text"/],
  ['output.type 非法', ['  output:', '    type: json'], /output\.type 必须为 "text"/],
  ['context.conversationHistory 非法', ['  context:', '    conversationHistory: full'], /conversationHistory 必须为 "recent"/],
  ['timeoutSeconds 越界', ['  limits:', '    timeoutSeconds: 10'], /timeoutSeconds/],
  ['maxToolCalls 越界', ['  limits:', '    maxToolCalls: 0'], /maxToolCalls/],
  ['maxOutputBytes 越界', ['  limits:', '    maxOutputBytes: 10000000'], /maxOutputBytes/],
  ['model.requirements 未知能力', ['  model:', '    requirements: [vision]'], /requirements/],
  ['evaluation.cases 非 yaml', ['  evaluation:', '    cases: evals/cases.txt'], /cases/],
] as const) {
  test(`spec 字段枚举与边界校验拒绝：${label}`, () => {
    assert.throws(() => parseAgentPackage(basePackage({ specLines: [...lines] })), pattern)
  })
}

for (const [field, pattern] of [
  ['api_key: sk-test', /api_key（凭据由平台受管槽位注入）/],
  ['provider: deepseek', /provider（模型路由由平台管理）/],
  ['endpoint: https://api.internal', /endpoint（服务端点由平台绑定管理）/],
  ['mcp_servers:\n  - name: crm', /mcp_servers（外部能力须经平台准入流程接入）/],
  ['run_as: root', /run_as（执行身份由平台解析）/],
  ['env:\n  KEY: value', /env（环境变量由平台受管注入）/],
  ['permissions: [admin]', /permissions（授权范围由平台治理）/],
  ['postinstall: ./setup.sh', /postinstall（安装钩子不由包执行）/],
  ['auth_token: abc', /auth_token（凭据由平台受管槽位注入）/],
  ['jwt: x.y.z', /jwt（认证方式由平台绑定管理）/],
  ['proxy: http://proxy.internal:8080', /proxy（网络出口由平台治理）/],
  ['role_ids: [role-admin]', /role_ids（可见角色由平台配置）/],
  ['data_scopes: [all]', /data_scopes（数据范围由平台配置）/],
  ['allow_workspace_join: true', /allow_workspace_join（团队空间准入由平台配置）/],
  ['schedule: "0 9 * * *"', /schedule（调度由平台配置）/],
  ['bindings: [rev-1]', /bindings（绑定修订由平台发布流程固定）/],
] as const) {
  test(`平台受管字段直接拒绝：${field.split('\n')[0]}`, () => {
    assert.throws(() => parseAgentPackage(basePackage({ topLines: [field] })), pattern)
  })
}

test('平台受管字段在嵌套层级同样拒绝并给出位置', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({ specLines: ['  provider: openai'] })),
    /spec\.provider（模型路由由平台管理）/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({ specLines: ['  model:', '    requirements: [long-context]', '    credentials: sk-x'] })),
    /spec\.model\.credentials（凭据由平台受管槽位注入）/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({ metadataLines: ['  endpoint: https://x'] })),
    /metadata\.endpoint（服务端点由平台绑定管理）/,
  )
})

test('spec.model 仅接受 requirements 声明，路由字段拒绝', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({ specLines: ['  model:', '    requirements: [structured-output]', '    route: fast'] })),
    /包含未定义字段 route/,
  )
})

test('声明版本与包内候选版本冲突直接拒绝，精确匹配视为包内提供', () => {
  const entries = {
    'skills/forecast/SKILL.md': '---\nname: forecast\ndescription: 按周聚合预测退款量趋势。\nversion: "0.3.0"\n---\n读取已授权退款历史，按周聚合并输出预测区间与置信度。',
  }
  assert.throws(
    () => parseAgentPackage(basePackage({ specLines: ['  capabilities:', '    skills:', '      - id: forecast', '        version: 0.2.0'] }, entries)),
    /声明的 Skill forecast@0\.2\.0 与包内 skills\/forecast 候选版本 0\.3\.0 冲突/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({ specLines: ['  capabilities:', '    tools:', '      - id: refund-risk-score', '        version: 0.2.0'] }, {
      'tools/refund-risk-score/tool.yaml': 'id: refund-risk-score\nversion: 0.1.0\nname: 退款风险评分\n',
    })),
    /声明的 Tool refund-risk-score@0\.2\.0 与包内 tools\/refund-risk-score 候选版本 0\.1\.0 冲突/,
  )

  const pinned = parseAgentPackage(basePackage({ specLines: ['  capabilities:', '    skills:', '      - id: forecast', '        version: 0.3.0'] }, entries))
  assert.deepEqual(pinned.declared.skills, [])
  assert.equal(pinned.packageRefs.skills[0]?.version, '0.3.0')
})

test('skills/tools 目录缺少描述符文件时警告而不静默忽略', () => {
  const parsed = parseAgentPackage(basePackage({}, {
    'tools/half/readme.md': '此目录疑似未完成的工具候选。',
    'skills/draft/notes.md': '缺少 SKILL.md 的草稿目录。',
  }))
  assert.ok(parsed.warnings.some(item => /tools\/half\/ 缺少 tool\.yaml/.test(item)))
  assert.ok(parsed.warnings.some(item => /skills\/draft\/ 缺少 SKILL\.md/.test(item)))
  assert.equal(parsed.packageRefs.tools.length, 0)
  assert.equal(parsed.packageRefs.skills.length, 0)
})

test('两个包内目录声明同一能力 id 直接拒绝，不允许静默覆盖', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({}, {
      'tools/alpha/tool.yaml': 'id: shared-tool\nversion: 0.1.0\n',
      'tools/beta/tool.yaml': 'id: shared-tool\nversion: 0.2.0\n',
    })),
    /包内 Tool 能力 id「shared-tool」重复声明（tools\/alpha 与 tools\/beta）/,
  )
})

test('tool.yaml 的 id 不符合能力标识规则直接拒绝，描述符含受管字段同样拒绝', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({}, {
      'tools/score/tool.yaml': 'id: "BAD ID"\nversion: 0.1.0\n',
    })),
    /tools\/score\/tool\.yaml 的 id「BAD ID」不符合能力标识规则/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({}, {
      'tools/score/tool.yaml': 'id: score\nversion: 0.1.0\nendpoint: https://x\n',
    })),
    /endpoint（服务端点由平台绑定管理）/,
  )
})

test('evaluation.cases 声明文件缺失拒绝；未声明时按约定路径探测', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({ specLines: ['  evaluation:', '    cases: evals/missing.yaml'] })),
    /spec\.evaluation\.cases 指定的 evals\/missing\.yaml 不存在/,
  )
  const discovered = parseAgentPackage(basePackage({}, { 'evals/cases.yaml': CASES }))
  assert.equal(discovered.cases.length, 1)
  assert.equal(discovered.spec.evaluation.cases, null)
})

test('案例字段校验：缺字段与非法 kind 拒绝', () => {
  const bad = `apiVersion: dsh-work.ai/evaluation/v1
kind: AgentEvaluationSuite
cases:
  - name: 正常预测
    kind: unknown
    input: 评估本周退款风险
    automatedAssertions: [execution_succeeded]
    manualReview:
      required: true
      rubric: 输出依据
`
  assert.throws(
    () => parseAgentPackage(basePackage({}, { 'evals/cases.yaml': bad })),
    /kind 必须是 success \/ invalid_input \/ permission_denied \/ prompt_injection \/ capability_failure/,
  )
})

test('评测套件要求版本、机器断言与人工 rubric，拒绝旧数组格式和未知断言', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({}, { 'evals/cases.yaml': '- name: 旧案例\n' })),
    /必须是版本化评测套件对象/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({}, { 'evals/cases.yaml': CASES.replace('dsh-work.ai/evaluation/v1', 'dsh-work.ai/evaluation/v2') })),
    /apiVersion 必须是 dsh-work\.ai\/evaluation\/v1/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({}, { 'evals/cases.yaml': CASES.replace('output_non_empty', 'tool_receipt_recorded') })),
    /自动断言必须是 run_attempt_recorded \/ execution_succeeded \/ output_non_empty/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({}, { 'evals/cases.yaml': CASES.replace('run_attempt_recorded, execution_succeeded, output_non_empty', 'execution_succeeded') })),
    /v1 中必须声明全部自动断言/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({}, { 'evals/cases.yaml': CASES.replace('required: true', 'required: false') })),
    /manualReview\.required 在 v1 中必须为 true/,
  )
})

test('checksums 仅证明文件完整性：缺失警告、覆盖不全与摘要不一致拒绝', () => {
  const noChecksums = parseAgentPackage(basePackage({}, {}))
  assert.equal(noChecksums.checksumsVerified, true)
  const withoutChecksums = parseAgentPackage(buildZip({ 'agent.yaml': agentYaml(), 'prompts/system.md': PROMPT }, { checksums: false }))
  assert.equal(withoutChecksums.checksumsVerified, false)
  assert.ok(withoutChecksums.warnings.some(item => /未做文件摘要校验/.test(item)))

  const tampered = buildZip({
    'agent.yaml': agentYaml(),
    'prompts/system.md': PROMPT,
    'checksums.json': JSON.stringify({ files: { 'agent.yaml': '0'.repeat(64), 'prompts/system.md': createHash('sha256').update(PROMPT).digest('hex') } }),
  })
  assert.throws(() => parseAgentPackage(tampered), /摘要与 checksums\.json 不一致/)

  const uncovered = buildZip({
    'agent.yaml': agentYaml(),
    'prompts/system.md': PROMPT,
    'checksums.json': JSON.stringify({ files: { 'agent.yaml': createHash('sha256').update(agentYaml()).digest('hex') } }),
  })
  assert.throws(() => parseAgentPackage(uncovered), /未覆盖全部文件/)
})
