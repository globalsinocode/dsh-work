import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeServerDependencies, isTestSupport, unitOf } from './server-dependencies.mjs'

const files = entries => new Map(Object.entries(entries))

test('units and test-support files are recognised', () => {
  assert.equal(unitOf('modules/run/run-types.ts'), 'modules/run')
  assert.equal(unitOf('http/workbench/content-routes.ts'), 'http')
  assert.equal(unitOf('main.ts'), 'main')
  assert.equal(unitOf('domain/run-state.ts'), 'domain')
  for (const path of ['http/router.test.ts', 'testing/test-identity.ts', 'infrastructure/postgres/test-database.ts', 'infrastructure/postgres/personal-workbench-test-fixture.ts']) {
    assert.equal(isTestSupport(path), true, path)
  }
  assert.equal(isTestSupport('modules/run/run-orchestration-service.ts'), false)
})

test('layers may not point backwards and production code may not use test identities', () => {
  const violations = analyzeServerDependencies(files({
    'domain/task-result.ts': "import type { RunState } from '../modules/run/run-types.ts'",
    'modules/run/run-types.ts': "export type RunState = 'queued'",
    'modules/run/service.ts': "import { envelope } from '../../http/router.ts'",
    'http/router.ts': 'export const envelope = 1',
    'main.ts': "import { testApiAuthenticator } from './testing/test-identity.ts'",
    'testing/test-identity.ts': 'export const testApiAuthenticator = 1',
    'infrastructure/postgres/personal-workbench-test-fixture.ts': "import { testApiAuthenticator } from '../../testing/test-identity.ts'",
  }), { cyclicModuleEdges: [] })
  assert.equal(violations.length, 3)
  assert.match(violations.join('\n'), /domain 层只能依赖 domain 自身/)
  assert.match(violations.join('\n'), /业务模块不得依赖 HTTP 层/)
  assert.match(violations.join('\n'), /main\.ts → server\/src\/testing\/test-identity\.ts：生产代码不得引用/)
})

test('a new module cycle fails, a baselined one passes, and a stale baseline entry fails', () => {
  const sources = files({
    'modules/a/a.ts': "import type { B } from '../b/b.ts'",
    'modules/b/b.ts': "import type { C } from '../c/c.ts'",
    'modules/c/c.ts': "import type { A } from '../a/a.ts'",
    'modules/d/d.ts': "import type { A } from '../a/a.ts'",
  })
  const all = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]
  assert.deepEqual(analyzeServerDependencies(sources, { cyclicModuleEdges: all }), [], 'd → a is not part of a cycle')
  const missing = analyzeServerDependencies(sources, { cyclicModuleEdges: all.slice(0, 2) })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /新增模块循环依赖 c → a（server\/src\/modules\/c\/c\.ts）/)
  const stale = analyzeServerDependencies(sources, { cyclicModuleEdges: [...all, { from: 'd', to: 'a' }] })
  assert.equal(stale.length, 1)
  assert.match(stale[0], /循环依赖基线已过期：d → a/)
})
