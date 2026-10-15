import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { classifyServerTest, listServerTests } from './run-server-tests.mjs'

test('server tests are classified by file name', () => {
  assert.equal(classifyServerTest('src/http/a.test.ts'), 'unit')
  assert.equal(classifyServerTest('config/dsh/policy.test.js'), 'unit')
  assert.equal(classifyServerTest('src/http/a.integration.test.ts'), 'integration')
  assert.equal(classifyServerTest('src/http/a.ts'), undefined)
  assert.equal(classifyServerTest('src/http/integration-helper.ts'), undefined)
})

test('server tests are selected by kind and directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-work-server-tests-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of [
    'src/modules/run/a.test.ts', 'src/modules/run/b.integration.test.ts', 'src/http/c.test.ts',
    'src/modules/run/node_modules/x.test.ts', 'config/dsh/d.test.js', 'dist/e.test.js',
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'export {}\n')
  }
  assert.deepEqual(listServerTests(root, 'unit'), ['config/dsh/d.test.js', 'src/http/c.test.ts', 'src/modules/run/a.test.ts'])
  assert.deepEqual(listServerTests(root, 'integration'), ['src/modules/run/b.integration.test.ts'])
  assert.deepEqual(listServerTests(root, 'unit', ['src/modules/run']), ['src/modules/run/a.test.ts'])
  assert.throws(() => listServerTests(root, 'unit', ['dist']), /只能选择 server\/src 或 server\/config/)
  assert.throws(() => listServerTests(root, 'unit', ['src/missing']), /目录不存在/)
})

test('runner CLI rejects unknown kinds and directories outside the server test roots', () => {
  const cli = resolve(import.meta.dirname, 'run-server-tests.mjs')
  assert.equal(spawnSync(process.execPath, [cli, 'e2e'], { encoding: 'utf8' }).status, 2)
  const outside = spawnSync(process.execPath, [cli, 'unit', '../e2e'], { encoding: 'utf8' })
  assert.equal(outside.status, 2)
  assert.match(outside.stderr, /只能选择/)
})
