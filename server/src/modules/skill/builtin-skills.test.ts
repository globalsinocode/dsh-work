import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  BUILTIN_SKILL_SCENARIOS, isBuiltinSkillReference, isReservedBuiltinSkillName, loadBuiltinSkillCatalog,
  normalizeBuiltinSkillScenarios,
} from './builtin-skills.ts'
import { toRuntimeManifestSkill } from '../run/orchestration/manifest-helpers.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/builtin-skills')

test('the shipped built-in Skills load, cover each scenario once and only declare read tools', () => {
  const catalog = loadBuiltinSkillCatalog(root)
  assert.deepEqual(catalog.skills.map(skill => skill.scenario).sort(), [...BUILTIN_SKILL_SCENARIOS].sort())
  for (const skill of catalog.skills) {
    assert.equal(isBuiltinSkillReference(`${skill.id}@${skill.version}`), true)
    assert.equal(isReservedBuiltinSkillName(skill.name), true)
    assert.match(skill.version, /^\d+\.\d+\.\d+$/)
    assert.ok(skill.tools.every(tool => ['read@1.0.0', 'glob@1.0.0', 'grep@1.0.0'].includes(tool)), skill.id)
    assert.ok(skill.instructions.length > 200, skill.id)
  }
})

test('resolve returns inline Skills and records disabled and covered ones', () => {
  const catalog = loadBuiltinSkillCatalog(root)
  const all = catalog.resolve({ disabled: [], covering: [] })
  assert.equal(all.skills.length, 3)
  assert.deepEqual(all.exclusions, [])
  const manifestSkill = toRuntimeManifestSkill(all.skills[0]!)
  assert.equal(typeof manifestSkill.instructions, 'string', 'built-in Skills are inline in the Manifest')
  assert.equal(manifestSkill.artifact_ref, undefined)

  const html = catalog.skills.find(skill => skill.scenario === 'html-page')!
  const analysis = catalog.skills.find(skill => skill.scenario === 'file-analysis')!
  const result = catalog.resolve({
    disabled: [analysis.id],
    covering: [{ reference: 'skill-report@1.0.0', name: '报告', scenarios: ['html-page'], modelInvocable: true }],
  })
  assert.deepEqual(result.skills.map(skill => skill.id), [catalog.skills.find(skill => skill.scenario === 'office-document')!.id])
  assert.deepEqual(result.exclusions, [
    { skill: `${analysis.id}@${analysis.version}`, reason: 'disabled' },
    { skill: `${html.id}@${html.version}`, reason: 'covered', coveredBy: 'skill-report@1.0.0' },
  ])
})

test('a Skill only users may invoke does not cover, while a same-name installed Skill does', () => {
  const catalog = loadBuiltinSkillCatalog(root)
  const html = catalog.skills.find(skill => skill.scenario === 'html-page')!
  const manual = catalog.resolve({ disabled: [], covering: [{ reference: 'skill-a@1.0.0', name: 'A', scenarios: ['html-page'], modelInvocable: false }] })
  assert.equal(manual.skills.length, 3)
  const sameName = catalog.resolve({ disabled: [], covering: [{ reference: 'skill-b@1.0.0', name: html.name, scenarios: [], modelInvocable: false }] })
  assert.deepEqual(sameName.exclusions, [{ skill: `${html.id}@${html.version}`, reason: 'covered', coveredBy: 'skill-b@1.0.0' }])
})

test('CRLF line endings still match versions.lock.json', () => {
  const copy = mkdtempSync(join(tmpdir(), 'builtin-skills-crlf-'))
  try {
    cpSync(root, copy, { recursive: true })
    const path = join(copy, 'dsh-work-file-analysis', 'SKILL.md')
    const lf = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    writeFileSync(path, lf.replace(/\n/g, '\r\n'))
    assert.doesNotThrow(() => loadBuiltinSkillCatalog(copy))
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('changing a built-in Skill without bumping its version fails to load', () => {
  const copy = mkdtempSync(join(tmpdir(), 'builtin-skills-'))
  try {
    cpSync(root, copy, { recursive: true })
    const path = join(copy, 'dsh-work-html-page', 'SKILL.md')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n补充一行。\n`)
    assert.throws(() => loadBuiltinSkillCatalog(copy), /内容与 versions\.lock\.json 不一致/)
    writeFileSync(path, readFileSync(path, 'utf8').replace('version: 1.0.0', 'version: 1.0.1'))
    assert.throws(() => loadBuiltinSkillCatalog(copy), /缺少 1\.0\.1 的摘要/)
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('emergency disable and covered scenarios accept only registered values', () => {
  const catalog = loadBuiltinSkillCatalog(root)
  assert.deepEqual(catalog.normalizeDisabled([' dsh-work-html-page', 'dsh-work-html-page']), ['dsh-work-html-page'])
  assert.throws(() => catalog.normalizeDisabled(['skill-report']), /只能停用平台内置 Skill/)
  assert.deepEqual(normalizeBuiltinSkillScenarios(['html-page', 'file-analysis', 'html-page']), ['file-analysis', 'html-page'])
  assert.throws(() => normalizeBuiltinSkillScenarios(['chart']), /未知的内置场景/)
  assert.equal(isReservedBuiltinSkillName('HTML 页面（平台内置）'), true)
  assert.equal(isReservedBuiltinSkillName('HTML 页面'), false)
})
