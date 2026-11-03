import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadSkillCreatorPreset } from './skill-creator-preset.ts'

const repositoryPresets = fileURLToPath(new URL('../../../config/agent-presets', import.meta.url))

function presetRoot(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-work-agent-presets-'))
  mkdirSync(join(root, 'skill-creator'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'skill-creator', name), content)
  return root
}

const validJson = JSON.stringify({
  id: 'agent-skill-creator', name: 'Skill 创建专家', description: '帮员工把工作方法写成 Skill 草稿。',
  welcomeMessage: '你好', examplePrompts: ['帮我做个 Skill'], testPrompts: ['帮我做个 Skill'],
})

test('the repository preset loads', () => {
  const preset = loadSkillCreatorPreset(repositoryPresets)
  assert.equal(preset.id, 'agent-skill-creator')
  assert.ok(preset.systemPrompt.includes('Skill 创建专家'))
})

test('a release bundle without the preset directory fails startup with a clear error', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-work-agent-presets-'))
  try {
    assert.throws(() => loadSkillCreatorPreset(root), (error: Error) => {
      // 缺文件只报一次读取失败，不能被误报成“不是有效 JSON”。
      assert.match(error.message, /^Skill 创建专家预置定义无效（[^）]+）：无法读取 preset\.json/)
      assert.doesNotMatch(error.message, /不是有效 JSON/)
      assert.equal(error.message.split('预置定义无效').length, 2)
      return true
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing SOUL.md, invalid JSON or missing field is rejected', () => {
  for (const [files, message] of [
    [{ 'preset.json': validJson }, /无法读取 SOUL\.md/],
    [{ 'preset.json': '{', 'SOUL.md': '# 职责' }, /不是有效 JSON/],
    [{ 'preset.json': 'null', 'SOUL.md': '# 职责' }, /preset\.json 必须是 JSON 对象/],
    [{ 'preset.json': JSON.stringify({ ...JSON.parse(validJson), testPrompts: [] }), 'SOUL.md': '# 职责' }, /testPrompts 必须是非空字符串数组/],
    [{ 'preset.json': JSON.stringify({ ...JSON.parse(validJson), name: '' }), 'SOUL.md': '# 职责' }, /缺少 name/],
    [{ 'preset.json': validJson, 'SOUL.md': '  \n' }, /SOUL\.md 为空/],
  ] as const) {
    const root = presetRoot(files)
    try {
      assert.throws(() => loadSkillCreatorPreset(root), message)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
