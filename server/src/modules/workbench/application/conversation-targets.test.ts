import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewLength, previewText } from './conversation-targets.ts'

test('预览去掉 Markdown 标记，只留可读文本', () => {
  const content = [
    '本期巡检结果如下。',
    '',
    '## 执行情况（**已核实**）',
    '- 本任务调度正常：`latestRun` 2026-10-30 09:00',
    '1. 详见 [运行记录](https://example.com/runs/1)',
    '> *提示*：无异常',
    '',
    '| 项目 | 结论 |',
    '| --- | --- |',
    '| 调度 | 正常 |',
    '---',
    '```ts',
    'const a_b = 1 * 2',
    '```',
  ].join('\n')
  assert.equal(
    previewText(content),
    '本期巡检结果如下。 执行情况（已核实） 本任务调度正常：latestRun 2026-10-30 09:00 详见 运行记录 提示：无异常 项目 结论 调度 正常 const a_b = 1 * 2',
  )
})

test('预览保留普通星号与下划线，超长时截断', () => {
  assert.equal(previewText('2 * 3 = 6，文件 snake_case_name'), '2 * 3 = 6，文件 snake_case_name')
  const preview = previewText(`**结论**：${'变化'.repeat(100)}`)
  assert.equal(preview.length, previewLength)
  assert.ok(preview.startsWith('结论：'))
  assert.ok(preview.endsWith('…'))
})
