import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { parseAgentPackage } from './agent-package.ts'

/**
 * Agent 发布包清单（agent.yaml）字段与冲突规则单测：
 * 覆盖扁平字段白名单、别名冲突、平台受管字段、依赖引用与包内候选版本冲突。
 */

const PROMPT = '你是退款预测助手。基于已授权的历史退款与订单数据评估风险，只输出风险等级与依据。'

function agentYaml(overrides: Record<string, string | string[]> = {}) {
  const extra = Array.isArray(overrides.extra) ? overrides.extra : []
  return [
    `id: ${overrides.id ?? 'zip-agent'}`,
    `name: ${overrides.name ?? '退款预测助手'}`,
    `version: ${overrides.version ?? '0.1.0'}`,
    `description: ${overrides.description ?? '基于历史退款记录预测高风险订单。'}`,
    overrides.promptFile === 'inline' ? `system_prompt: ${PROMPT}` : `system_prompt_file: ${overrides.promptFile ?? 'prompts/system.md'}`,
    ...(typeof overrides.tools === 'string' ? [`tools: [${overrides.tools}]`] : []),
    ...extra,
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

function basePackage(overrides: Record<string, string | string[]> = {}, entries: Record<string, string> = {}) {
  return buildZip({
    'agent.yaml': agentYaml(overrides),
    'prompts/system.md': PROMPT,
    ...entries,
  })
}

const CASES = `cases:
  - name: 正常预测
    kind: success
    input: 评估本周退款风险
    expect: 输出高风险订单清单与依据
`

test('最小有效包解析成功，checksums 覆盖时无警告', () => {
  const parsed = parseAgentPackage(basePackage())
  assert.equal(parsed.manifest.id, 'zip-agent')
  assert.equal(parsed.manifest.version, '0.1.0')
  assert.equal(parsed.definition.systemPrompt, PROMPT)
  assert.equal(parsed.checksumsVerified, true)
  assert.deepEqual(parsed.warnings, [])
})

test('旧式扁平清单（含别名与内联 Prompt）保持兼容', () => {
  const parsed = parseAgentPackage(buildZip({
    'pkg/agent.yaml': [
      'id: legacy-agent',
      'display_name: 旧包助手',
      'version: 1.2.3',
      'description: 旧格式兼容样本。',
      `system_prompt: ${PROMPT}`,
      'role_ids: [role-employee]',
      'tool_refs:',
      '  - id: read',
      '    version: 1.0.0',
      'cases_file: evals/cases.yaml',
      'welcome_message: 你好',
      'example_prompts: [评估退款风险]',
      'data_scopes: [workspace:authorized]',
      'max_tokens: 8000',
      'timeout_seconds: 120',
      'allow_workspace_join: true',
      '',
    ].join('\n'),
    'pkg/evals/cases.yaml': CASES,
  }, { rootDir: 'pkg/' }))
  assert.equal(parsed.rootDir, 'pkg/')
  assert.equal(parsed.manifest.name, '旧包助手')
  assert.equal(parsed.definition.allowWorkspaceJoin, true)
  assert.deepEqual(parsed.declared.tools, ['read@1.0.0'])
  assert.equal(parsed.cases.length, 1)
  assert.deepEqual(parsed.warnings, [])
})

test('未识别字段给警告并忽略，不阻塞解析', () => {
  const parsed = parseAgentPackage(basePackage({ extra: ['author: ops-team', 'tags: [refund]', 'homepage: https://example.invalid/doc'] }))
  assert.equal(parsed.manifest.id, 'zip-agent')
  assert.equal(parsed.warnings.length, 1)
  assert.match(parsed.warnings[0]!, /未识别字段已忽略：author、tags、homepage/)
})

for (const [field, pattern] of [
  ['api_key: sk-test', /api_key（凭据由平台受管槽位注入）/],
  ['model: gpt-x', /model（模型路由由平台管理）/],
  ['endpoint: https://api.internal', /endpoint（服务端点由平台绑定管理）/],
  ['mcp_servers:\n  - name: crm', /mcp_servers（外部能力须经平台准入流程接入）/],
  ['run_as: root', /run_as（执行身份由平台解析）/],
  ['env:\n  KEY: value', /env（环境变量由平台受管注入）/],
  ['permissions: [admin]', /permissions（授权范围由平台治理）/],
  ['postinstall: ./setup.sh', /postinstall（安装钩子不由包执行）/],
  ['auth_token: abc', /auth_token（凭据由平台受管槽位注入）/],
  ['jwt: x.y.z', /jwt（认证方式由平台绑定管理）/],
  ['proxy: http://proxy.internal:8080', /proxy（网络出口由平台治理）/],
] as const) {
  test(`平台受管字段直接拒绝：${field.split('\n')[0]}`, () => {
    assert.throws(() => parseAgentPackage(basePackage({ extra: [field] })), pattern)
  })
}

test('YAML 锚点/别名在对象化阶段被捕获并映射为包校验错误', () => {
  const yaml = [
    'id: zip-agent',
    'name: &anchor 退款预测助手',
    'version: 0.1.0',
    'description: *anchor',
    'system_prompt_file: prompts/system.md',
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

test('apiVersion/spec 结构清单给出明确的格式不支持错误', () => {
  assert.throws(
    () => parseAgentPackage(buildZip({
      'agent.yaml': [
        'apiVersion: dsh-work/v1',
        'kind: Agent',
        'spec:',
        '  id: zip-agent',
        '',
      ].join('\n'),
      'prompts/system.md': PROMPT,
    })),
    /apiVersion.*结构清单字段.*扁平 agent\.yaml/,
  )
})

test('别名字段并存：取值一致警告，取值不一致拒绝', () => {
  const same = parseAgentPackage(basePackage({ extra: ['display_name: 退款预测助手'] }))
  assert.ok(same.warnings.some(item => /name 与 display_name 重复声明相同取值/.test(item)))

  assert.throws(
    () => parseAgentPackage(basePackage({ extra: ['display_name: 另一个名称'] })),
    /name 与 display_name.*取值不一致/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({ extra: ['role_ids: [role-admin]', 'visible_role_ids: [role-employee]'] })),
    /visible_role_ids 与 role_ids.*取值不一致/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({ extra: ['prompt_file: prompts/other.md'], promptFile: 'prompts/system.md' })),
    /system_prompt_file 与 prompt_file.*取值不一致/,
  )
})

test('system_prompt 与 system_prompt_file 并存：内容一致警告，不一致拒绝', () => {
  const same = parseAgentPackage(basePackage({ extra: [`system_prompt: ${PROMPT}`] }))
  assert.ok(same.warnings.some(item => /system_prompt 与 system_prompt_file 声明了相同内容/.test(item)))
  assert.equal(same.definition.systemPrompt, PROMPT)

  assert.throws(
    () => parseAgentPackage(buildZip({
      'agent.yaml': agentYaml({ extra: ['system_prompt: 这是与文件内容完全不同的另一套提示词内容'] }),
      'prompts/system.md': PROMPT,
    })),
    /system_prompt 与 system_prompt_file 同时声明且内容不一致/,
  )
})

for (const [entries, pattern] of [
  ['"read@"', /依赖引用「read@」缺少版本号/],
  ['"@1.0.0"', /能力标识无效/],
  ['"read@latest"', /版本必须是 x\.y\.z/],
  ['"read@1.0.0", "read@2.0.0"', /read 声明了多个不同版本（read@1\.0\.0、read@2\.0\.0）/],
  ['"read", "read@1.0.0"', /read 声明了多个不同版本/],
  ['""', /第 1 条为空/],
  ['"BAD ID"', /能力标识无效/],
  ['"Read@1.0.0"', /能力标识无效/],
] as const) {
  test(`依赖引用校验拒绝非法或冲突声明：tools: [${entries}]`, () => {
    assert.throws(() => parseAgentPackage(basePackage({ tools: entries })), pattern)
  })
}

test('同字段重复声明去重并警告，skills/skill_refs 别名冲突拒绝', () => {
  const parsed = parseAgentPackage(basePackage({ extra: ['tools: ["read@1.0.0", "read@1.0.0", "grep"]'] }))
  assert.deepEqual(parsed.declared.tools, ['read@1.0.0', 'grep'])
  assert.ok(parsed.warnings.some(item => /重复声明/.test(item)))

  assert.throws(
    () => parseAgentPackage(basePackage({ extra: ['tools: ["read@1.0.0"]', 'tool_refs: ["read@1.0.0", "write@1.0.0"]'] })),
    /tools 与 tool_refs.*取值不一致/,
  )
})

test('声明版本与包内候选版本冲突直接拒绝，未固定版本视为包内提供', () => {
  const entries = {
    'skills/forecast/SKILL.md': '---\nname: forecast\ndescription: 按周聚合预测退款量趋势。\nversion: "0.3.0"\n---\n读取已授权退款历史，按周聚合并输出预测区间与置信度。',
  }
  assert.throws(
    () => parseAgentPackage(basePackage({ extra: ['skills: ["forecast@0.2.0"]'] }, entries)),
    /声明的 Skill forecast@0\.2\.0 与包内 skills\/forecast 候选版本 0\.3\.0 冲突/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({ tools: '"refund-risk-score@0.2.0"' }, {
      'tools/refund-risk-score/tool.yaml': 'id: refund-risk-score\nversion: 0.1.0\nname: 退款风险评分\n',
    })),
    /声明的 Tool refund-risk-score@0\.2\.0 与包内 tools\/refund-risk-score 候选版本 0\.1\.0 冲突/,
  )

  const unpinned = parseAgentPackage(basePackage({ extra: ['skills: ["forecast"]'] }, entries))
  assert.deepEqual(unpinned.declared.skills, [])
  assert.equal(unpinned.packageRefs.skills[0]?.version, '0.3.0')
  const pinned = parseAgentPackage(basePackage({ extra: ['skills: ["forecast@0.3.0"]'] }, entries))
  assert.deepEqual(pinned.declared.skills, [])
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

test('tool.yaml 的 id 与 name 是不同字段（非别名），并存不视为冲突', () => {
  const parsed = parseAgentPackage(basePackage({}, {
    'tools/score/tool.yaml': 'id: score\nname: 退款风险评分\nversion: 0.1.0\n',
  }))
  assert.equal(parsed.packageRefs.tools[0]?.id, 'score')
})

test('两个包内目录声明同一能力 id 直接拒绝，不允许静默覆盖', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({ tools: '"shared-tool"' }, {
      'tools/alpha/tool.yaml': 'id: shared-tool\nversion: 0.1.0\n',
      'tools/beta/tool.yaml': 'id: shared-tool\nversion: 0.2.0\n',
    })),
    /包内 Tool 能力 id「shared-tool」重复声明（tools\/alpha 与 tools\/beta）/,
  )
})

test('tool.yaml 的 id/name 不符合能力标识规则直接拒绝', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({}, {
      'tools/score/tool.yaml': 'id: "BAD ID"\nversion: 0.1.0\n',
    })),
    /tools\/score\/tool\.yaml 的 id「BAD ID」不符合能力标识规则/,
  )
  assert.throws(
    () => parseAgentPackage(basePackage({}, {
      'tools/score/tool.yaml': 'name: 退款风险评分\nversion: 0.1.0\n',
    })),
    /不符合能力标识规则/,
  )
})

test('别名列表取值仅元素顺序不同视为一致取值，警告而非拒绝', () => {
  const parsed = parseAgentPackage(basePackage({
    extra: ['visible_role_ids: [role-b, role-a]', 'role_ids: [role-a, role-b]'],
  }))
  assert.deepEqual(parsed.definition.roleIds, ['role-b', 'role-a'])
  assert.ok(parsed.warnings.some(item => /visible_role_ids 与 role_ids 重复声明相同取值/.test(item)))
})

test('案例别名字段并存冲突拒绝', () => {
  const conflict = `cases:
  - name: 正常预测
    kind: success
    type: invalid_input
    input: 评估本周退款风险
    expect: 输出依据
`
  assert.throws(
    () => parseAgentPackage(basePackage({ extra: ['evals: evals/cases.yaml'] }, { 'evals/cases.yaml': conflict })),
    /kind 与 type.*取值不一致/,
  )
  const expectConflict = `cases:
  - name: 正常预测
    kind: success
    input: 评估本周退款风险
    expect: 输出依据
    expected: 另一份预期
`
  assert.throws(
    () => parseAgentPackage(basePackage({ extra: ['evals: evals/cases.yaml'] }, { 'evals/cases.yaml': expectConflict })),
    /expect 与 expected.*取值不一致/,
  )
})

test('evals 与 cases_file 别名冲突拒绝', () => {
  assert.throws(
    () => parseAgentPackage(basePackage({ extra: ['evals: evals/a.yaml', 'cases_file: evals/b.yaml'] })),
    /evals 与 cases_file.*取值不一致/,
  )
})
