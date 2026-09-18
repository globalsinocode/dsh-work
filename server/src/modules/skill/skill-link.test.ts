import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { acquireSkillSource, downloadPublicHttps, parseSkillLink, isPublicAddress } from './skill-source.ts'
import { parseSkillBundle } from './skill-package.ts'
import { buildSkillInstallationPlan } from './skill-installation-plan.ts'

const skill = '---\nname: link-unit\ndescription: A synthetic direct link package.\n---\nSummarize only the supplied input without invoking external commands.\n'
test('direct link accepts one approved public URL, never commands, credentials or caller-controlled resolved ref', () => {
  assert.deepEqual(parseSkillLink({ url: 'https://github.com/fixture/repo/tree/main/skills/good', selected: 'good' }),
    { url: 'https://github.com/fixture/repo/tree/main/skills/good', repository: 'fixture/repo', ref: 'main', directory: 'skills/good', selected: 'good' })
  for (const url of ['http://github.com/a/b', 'curl https://github.com/a/b', '请安装 https://github.com/a/b',
    'https://github.com/a/b https://github.com/c/d', 'https://user:password@github.com/a/b', 'https://github.com/a/b?token=private',
    'https://github.com/a/b#fragment', 'https://github.com:444/a/b', 'https://unapproved.example/a', 'https://127.0.0.1/a', 'https://[::1]/a']) {
    assert.throws(() => parseSkillLink({ url }), { code: 'skill_source_invalid' })
  }
  for (const input of [{ url: 'https://github.com/a/b', selected: '../private' }, { url: 'https://github.com/a/b', channel: 'assistant' },
    { url: 'https://github.com/a/b', resolvedRef: 'f'.repeat(40) }]) assert.throws(() => parseSkillLink(input), { code: 'skill_source_invalid' })
})

test('acquisition pins repository ref once and propagates the same cancellation signal to the existing downloader', async () => {
  const calls: string[] = [], signal = new AbortController().signal, sha = 'a'.repeat(40)
  const result = await acquireSkillSource(parseSkillLink({ url: 'https://github.com/fixture/repo' }), signal, async (url, actual) => {
    assert.equal(actual, signal); calls.push(url)
    return calls.length === 1 ? strToU8(JSON.stringify({ sha })) : strToU8(skill)
  })
  assert.equal(result.resolvedRef, sha)
  assert.deepEqual(calls, ['https://api.github.com/repos/fixture/repo/commits/HEAD', `https://codeload.github.com/fixture/repo/zip/${sha}`])
})

test('existing download security gates and reserved-address denial stay active without network probes', async () => {
  const signal = new AbortController().signal
  await assert.rejects(downloadPublicHttps('https://unapproved.example/redirect.zip', signal), /未获准/)
  await assert.rejects(downloadPublicHttps('https://github.com/a/b', signal, 5), /重定向/)
  for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.2', '169.254.169.254', '172.16.1.1', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false)
})

test('only runtime dependencies may be deferred; missing skills, forbidden tools and unsafe files still block', () => {
  const bundle = parseSkillBundle(zipSync({ 'SKILL.md': strToU8(skill), 'scripts/a.py': strToU8('import pandas\nprint(12)\n'), 'requirements.txt': strToU8('pandas==2.2.3\n') }))
  const direct = buildSkillInstallationPlan(bundle, { pythonSandboxAvailable: false, deferRuntimeRequirements: true })
  assert.equal(direct.compatibility.status, 'needs_review')
  assert.equal(buildSkillInstallationPlan(bundle, { pythonSandboxAvailable: false }).compatibility.status, 'incompatible', 'ZIP/assistant default is unchanged')
  const forbidden = parseSkillBundle(strToU8(skill.replace('description:', 'allowed-tools: [Bash]\ndescription:')))
  assert.equal(buildSkillInstallationPlan(forbidden, { pythonSandboxAvailable: false, deferRuntimeRequirements: true }).compatibility.status, 'incompatible')
  const missing = parseSkillBundle(strToU8(skill + '\nCall the Skill tool with "missing-child".'))
  assert.equal(buildSkillInstallationPlan(missing, { pythonSandboxAvailable: false, deferRuntimeRequirements: true }).compatibility.status, 'incompatible')
  assert.throws(() => parseSkillBundle(zipSync({ 'SKILL.md': strToU8(skill), '../outside.txt': strToU8('no') })))
})
