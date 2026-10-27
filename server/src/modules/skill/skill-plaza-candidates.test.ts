import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { zipSync } from 'fflate'

import { parseSkillPackage } from './skill-package.ts'

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url))
const fixturesRoot = resolve(moduleDirectory, '../../../../docs/development/fixtures/skill-plaza-candidates')
const packagesRoot = join(fixturesRoot, 'packages')

const ADMISSION_REJECTED_IDS = new Set([
  'plaza-anth-docx',
  'plaza-sp-brainstorming',
  'plaza-wb-deep-research',
  'plaza-wb-excalidraw-diagram',
  'plaza-wb-fbs-bookwriter',
])

interface SourceIndex {
  batch: string
  skillCount: number
  repos: Record<string, { license: string }>
  skills: Array<{ id: string; repo: string; sourcePath: string }>
}

function acceptableRepositoryLicense(repos: SourceIndex['repos'], repoKey: string): boolean {
  const license = repos[repoKey]?.license ?? ''
  return license.length > 0 && !/^none\b/i.test(license)
}

function zipDirectory(packageId: string): Uint8Array {
  const pkgDir = join(packagesRoot, packageId)
  const files: Record<string, Uint8Array> = {}
  const walk = (prefix = '') => {
    const dir = prefix ? join(pkgDir, prefix) : pkgDir
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${name.name}` : name.name
      const full = join(pkgDir, rel)
      if (name.isDirectory()) walk(rel)
      else files[rel] = new Uint8Array(readFileSync(full))
    }
  }
  walk()
  return zipSync(files, { level: 0 })
}

const source = JSON.parse(readFileSync(join(fixturesRoot, 'SOURCE.json'), 'utf8')) as SourceIndex

const packageIds = existsSync(packagesRoot)
  ? readdirSync(packagesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort()
  : []

test('skill-plaza：候选准入策略与 SOURCE/packages 一致', () => {
  for (const skill of source.skills) {
    assert.ok(!ADMISSION_REJECTED_IDS.has(skill.id), `${skill.id} 不应进入已选候选`)
    assert.ok(acceptableRepositoryLicense(source.repos, skill.repo), `${skill.id} 的仓库许可证不可接受`)
  }
  assert.equal(new Set(source.skills.map(item => item.id)).size, source.skills.length, 'SOURCE 中 id 必须唯一')
  assert.equal(packageIds.length, source.skillCount, '请先运行 fetch + package 脚本生成 fixtures')
  assert.equal(packageIds.length, source.skills.length)
  const indexIds = new Set(source.skills.map(item => item.id))
  const dirIds = new Set(packageIds)
  for (const id of packageIds) assert.ok(indexIds.has(id), `SOURCE.json 缺少 ${id}`)
  for (const id of indexIds) assert.ok(dirIds.has(id), `packages 缺少 ${id}`)
})

test('skill-plaza：目录数与 SOURCE.json 一致且均可 parseSkillPackage', () => {
  assert.equal(source.skillCount, source.skills.length)
  for (const id of packageIds) {
    assert.match(id, /^plaza-[a-z0-9-]+$/)
    const parsed = parseSkillPackage(zipDirectory(id))
    assert.ok(parsed.name.length > 0)
    assert.ok(parsed.description.length > 0)
    assert.notEqual(parsed.compatibility.status, 'incompatible')
  }
})

test('skill-plaza：PUBLISH-ALLOWLIST 默认不发布', () => {
  const allowlist = JSON.parse(readFileSync(join(fixturesRoot, 'PUBLISH-ALLOWLIST.json'), 'utf8')) as {
    defaultPublish: boolean
    skills: Array<{ id: string; publish: boolean }>
  }
  assert.equal(allowlist.defaultPublish, false)
  assert.equal(allowlist.skills.length, source.skillCount)
  for (const row of allowlist.skills) {
    assert.equal(row.publish, false, `${row.id} 不应自动发布`)
  }
})
