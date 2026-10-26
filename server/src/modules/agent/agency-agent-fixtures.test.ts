import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { parseAgentPackage } from './agent-package.ts'

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url))
const fixturesRoot = resolve(moduleDirectory, '../../../../docs/development/fixtures/agency-agents')

const CAPABILITY_MARK = '平台能力边界'

interface SourceIndex {
  expertCount: number
  experts: Array<{ id: string }>
}

function zipDirectory(packageId: string): Uint8Array {
  const pkgDir = join(fixturesRoot, packageId)
  const files: Record<string, Uint8Array> = {}
  const walk = (prefix = '') => {
    const dir = prefix ? join(pkgDir, prefix) : pkgDir
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${name.name}` : name.name
      const full = join(pkgDir, rel)
      if (name.isDirectory()) walk(rel)
      else files[rel] = new Uint8Array(readFileSync(full))
    }
  }
  walk()
  const checksums = { files: {} as Record<string, string> }
  for (const [path, content] of Object.entries(files)) {
    checksums.files[path] = createHash('sha256').update(content).digest('hex')
  }
  files['checksums.json'] = strToU8(JSON.stringify(checksums, null, 2))
  return zipSync(files, { level: 0 })
}

const packageIds = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.startsWith('agency-'))
  .map(e => e.name)
  .sort()

const source = JSON.parse(readFileSync(join(fixturesRoot, 'SOURCE.json'), 'utf8')) as SourceIndex

test('agency 全量包：目录数与 SOURCE.json 一致且均可 parseAgentPackage', () => {
  assert.equal(packageIds.length, source.expertCount)
  assert.equal(packageIds.length, source.experts.length)
  const indexIds = new Set(source.experts.map(item => item.id))
  for (const id of packageIds) {
    assert.ok(indexIds.has(id), `SOURCE.json 缺少 ${id}`)
    assert.match(id, /^agency-[a-z0-9-]+$/)
    const parsed = parseAgentPackage(zipDirectory(id))
    assert.equal(parsed.spec.metadata.id, id)
    assert.equal(parsed.spec.capabilities.skills.length, 0)
    assert.equal(parsed.spec.capabilities.tools.length, 0)
    assert.ok(parsed.spec.catalog.examplePrompts.length >= 1)
    assert.ok(parsed.spec.instructions.body.includes(CAPABILITY_MARK))
    assert.ok(parsed.spec.workProcedures?.body.includes('工作规程'))
    assert.equal(parsed.cases.length, 5)
  }
})
