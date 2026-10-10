import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describePromptTemplateFinding,
  findPromptTemplateFindings,
  PROMPT_TEMPLATE_REMEDIATION,
} from './prompt-template.ts'

test('合法且已注册的 DSH 模板变量不产生发现项', () => {
  const prompt = [
    '你在 {{cwd}} 下工作。',
    '模型 {{model}}，提供方 {{provider}}。',
  ].join('\n')
  assert.deepEqual(findPromptTemplateFindings(prompt), [])
})

test('没有花括号的普通文本不产生发现项', () => {
  assert.deepEqual(findPromptTemplateFindings('报告头部写「数据截至系统仿真日期」。'), [])
})

test('单个花括号是普通散文，不触发 DSH 的畸形引用判定', () => {
  // 与 DSH 一致：只有存在配对的 }} 时才算畸形引用，否则视为字面散文。
  assert.deepEqual(findPromptTemplateFindings('这里只有 { 一个花括号 {@code like this}。'), [])
})

test('{{ 与 }} 之间存在嵌套花括号而配不成完整分组时，与 DSH 一样判为畸形', () => {
  // DSH 在此处直接抛错：GROUP_AT 不匹配，且 {{ 之后仍能搜到 }}。
  const findings = findPromptTemplateFindings('第一行 {{a{{b}} 。')
  const unclosed = findings.find(item => item.reason === 'unclosed')
  assert.ok(unclosed, '应报告配不成对的花括号引用')
  assert.equal(unclosed.line, 1)
  assert.match(describePromptTemplateFinding(unclosed), /配不成对的花括号引用/)
  // 内层 {{b}} 确实是另一个未注册引用，一并列出便于一次改完。
  assert.ok(findings.some(item => item.reason === 'unknown' && item.name === 'b'))
})

test('{{ 之后没有 }} 时按字面散文放过，不误报', () => {
  assert.deepEqual(findPromptTemplateFindings('输出格式 {{{{ 未闭合，没有右括号。'), [])
  assert.deepEqual(findPromptTemplateFindings('模板骨架：{{'), [])
})

test('大小写混写的变量名判为畸形并给出行号', () => {
  const prompt = ['第一行正常。', '第二行有 {{simToday}}。', '第三行有 {{startDate}} 与 {{endDate}}。'].join('\n')
  assert.deepEqual(findPromptTemplateFindings(prompt), [
    { name: 'simToday', line: 2, reason: 'malformed' },
    { name: 'startDate', line: 3, reason: 'malformed' },
    { name: 'endDate', line: 3, reason: 'malformed' },
  ])
  assert.equal(describePromptTemplateFinding({ name: 'simToday', line: 2, reason: 'malformed' }),
    '第 2 行 {{simToday}} 变量名不合法')
})

test('小写但未注册的变量名判为未注册', () => {
  assert.deepEqual(findPromptTemplateFindings('今天是 {{sim_today}}。'), [
    { name: 'sim_today', line: 1, reason: 'unknown' },
  ])
  assert.equal(describePromptTemplateFinding({ name: 'sim_today', line: 1, reason: 'unknown' }),
    '第 1 行 {{sim_today}} 不是已注册变量')
})

test('空引用 {{}} 与含空格的引用都判为畸形', () => {
  assert.deepEqual(findPromptTemplateFindings('a {{}} b').map(item => item.reason), ['malformed'])
  assert.deepEqual(findPromptTemplateFindings('a {{sim today}} b').map(item => item.reason), ['malformed'])
})

test('同一行多个引用各自登记', () => {
  assert.deepEqual(findPromptTemplateFindings('{{a}}{{b}}').map(item => item.name), ['a', 'b'])
})

test('跨行的分组按 DSH 的 GROUP_AT 语义参与校验（[^{}] 可匹配换行）', () => {
  // DSH 用 /^\{\{([^{}]*)\}\}/ 匹配切片，[^{}] 包含换行，因此 {{\ncwd\n}} 会被
  // 当成名为「\ncwd\n」的引用并判为畸形。检查必须同样判红，否则运行时才会炸。
  const findings = findPromptTemplateFindings('{{\ncwd\n}}')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.reason, 'malformed')
  assert.equal(findings[0]?.line, 1)
})

test('修复提示明确指向「去掉花括号」并列出已注册变量', () => {
  assert.match(PROMPT_TEMPLATE_REMEDIATION, /去掉花括号/)
  assert.match(PROMPT_TEMPLATE_REMEDIATION, /provider \/ model \/ cwd/)
})
