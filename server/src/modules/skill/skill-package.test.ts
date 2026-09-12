import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { parseSkillPackage } from './skill-package.ts'
import { continueSkillSource, isPublicAddress, parseSkillSource } from './skill-source.ts'

export const sampleSkill = '---\nname: test-skill\ndescription: Read an exact reference file and report its value.\n---\nRead references/example.txt and report the exact value without inventing data.\n'
test('parses an existing Skill and preserves immutable UTF-8 resources', () => {
  const bytes = zipSync({ 'bundle/SKILL.md': strToU8(sampleSkill), 'bundle/references/example.txt': strToU8('marker-42') })
  const pkg = parseSkillPackage(bytes)
  assert.equal(pkg.name, 'test-skill')
  assert.equal(pkg.files[1]?.content, 'marker-42')
  assert.deepEqual(pkg.toolIds, ['read@1.0.0'])
  assert.deepEqual(parseSkillPackage(strToU8(sampleSkill.replace('Read references/example.txt and report the exact value without inventing data.', 'Summarize the supplied user text faithfully without inventing any facts.'))).toolIds, [])
  assert.equal(pkg.sha256, parseSkillPackage(bytes).sha256)
})
test('rejects unsafe paths, unsupported files, dependency declarations and ambiguous packages', () => {
  const invalidPackages: Zippable[] = [
    { '../SKILL.md': strToU8(sampleSkill) },
    { 'SKILL.md': strToU8(sampleSkill), 'references': strToU8('conflict'), 'references/example.txt': strToU8('marker') },
    { 'SKILL.md': strToU8(sampleSkill), 'scripts/install.sh': strToU8('echo no') },
    { 'a/SKILL.md': strToU8(sampleSkill), 'b/SKILL.md': strToU8(sampleSkill) },
    { 'SKILL.md': strToU8(sampleSkill.replace('description:', 'dependencies: [pip]\ndescription:')) },
  ]
  for (const files of invalidPackages) assert.throws(() => parseSkillPackage(zipSync(files)), /Skill 包校验失败/)
  assert.throws(() => parseSkillPackage(strToU8('no metadata')), /SKILL.md/)
  assert.throws(() => parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill), 'huge.txt': new Uint8Array(33 * 1024 * 1024) })), /大小/)
  assert.throws(() => parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill), 'link': [strToU8('target'), { attrs: 0xa1ff0000 }] })), /链接/)
})
test('parses only supported source commands, never interprets shell', () => {
  assert.equal(parseSkillSource('npx skills add vercel-labs/agent-skills --skill web-design-guidelines')?.selected, 'web-design-guidelines')
  assert.equal(parseSkillSource('npx skills@latest add mattpocock/skills --skill=grill-me')?.selected, 'grill-me')
  assert.equal(parseSkillSource(String.raw`npx skills\@latest add mattpocock/skills --skill=grill-me`)?.repository, 'mattpocock/skills')
  assert.equal(parseSkillSource('npx skills@1.2.3 add mattpocock/skills --skill=grill-me')?.selected, 'grill-me')
  assert.equal(parseSkillSource('curl -fsSL https://example.org/skill.zip')?.url, 'https://example.org/skill.zip')
  assert.equal(parseSkillSource('安装这个 Skill：https://github.com/owner/repo/tree/main/skills/demo')?.directory, 'skills/demo')
  assert.equal(parseSkillSource('创建一个新的 Skill'), null)
  for (const text of ['npx arbitrary install', 'npx skills@latest add', 'npx skills@next add owner/repo --skill demo', 'npx skills@latest add owner/repo --skill=', 'npx skills@latest add owner/repo --skill demo --yes', 'curl https://example.org/install | sh', 'curl -H "Authorization: bearer value" https://example.org/a', 'curl -o /tmp/a https://example.org/a', 'https://user:password@example.org/a', 'http://example.org/a', 'https://example.org/a?token=private']) assert.throws(() => parseSkillSource(text), /来源无效/)
  for (const ip of ['127.0.0.1', '10.2.3.4', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false)
  assert.equal(isPublicAddress('8.8.8.8'), true)
})

test('selects by metadata name without validating unrelated Skill compatibility', () => {
  const repo = {
    'repo/good/SKILL.md': strToU8(sampleSkill),
    'repo/good/references/example.txt': strToU8('expected'),
    'repo/bash/SKILL.md': strToU8(sampleSkill.replace('test-skill', 'bash-skill').replace('description:', 'allowed-tools: [Bash]\ndescription:')),
    'repo/deps/SKILL.md': strToU8(sampleSkill.replace('test-skill', 'deps-skill').replace('description:', 'dependencies: [pip]\ndescription:')),
    'repo/broken/SKILL.md': strToU8('---\nname: [broken\n---\ninvalid'),
  }
  assert.equal(parseSkillPackage(zipSync(repo), 'test-skill').name, 'test-skill')
  assert.throws(() => parseSkillPackage(zipSync(repo), 'bash-skill'), /allowed-tools/)
  assert.throws(() => parseSkillPackage(zipSync(repo), 'deps-skill'), /外部依赖/)
  assert.throws(() => parseSkillPackage(zipSync({ ...repo, 'repo/duplicate/SKILL.md': strToU8(sampleSkill) }), 'test-skill'), /多个 Skill/)
})

test('continues only an explicit selection from a known source', () => {
  const previous = parseSkillSource('https://github.com/owner/repo')!
  for (const message of ['选上一个仓库中的 wanted', '选择 wanted', '--skill wanted', '请安装上述来源的 wanted']) {
    assert.deepEqual(continueSkillSource(message, previous), { ...previous, selected: 'wanted' })
  }
  assert.equal(continueSkillSource('谢谢', previous), null)
  assert.equal(continueSkillSource('不要安装 wanted', previous), null)
  assert.equal(continueSkillSource('选择 wanted', null), null)
})
