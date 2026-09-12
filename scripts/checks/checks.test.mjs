import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { verify } from '../verify.mjs'
import { workflowCommands } from './context.mjs'

const projectRoot = resolve(import.meta.dirname, '../..')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-work-checks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of [
    'AGENTS.md', 'README.md', 'package.json', '.env.example', '.github/workflows/ci.yml', 'docs',
    'server/package.json', 'server/config', 'server/src', 'server/migrations',
    'deploy/runtime.env.example', 'scripts/deploy/preflight.sh', 'scripts/runtime/probe.ts',
    'apps/workbench-web/vitest.config.ts', 'apps/admin-web/vitest.config.ts', 'playwright.config.ts', 'e2e/mvp-smoke.spec.ts',
    // 文档（如 docs/design/team-workspace-plan.md）会链接到员工端与共享包的具体文件，
    // 夹具必须提供这些路径，否则 project 检查会把真实存在的链接报成悬空。
    'apps/workbench-web/src/stores/content.ts', 'apps/workbench-web/src/stores/tasks.ts',
    'apps/admin-web/src/views/AdminAssistantView.vue', 'apps/admin-web/src/stores/admin-assistant.ts',
    'apps/admin-web/src/components/SkillInstallationPanel.vue', 'apps/admin-web/src/components/SkillPackagePreview.vue',
    'apps/workbench-web/src/views/WorkspacesView.vue', 'apps/workbench-web/src/views/WorkspaceDetailView.vue',
    'packages/workbench-components/src/WorkspaceInfoPanel.vue', 'packages/design-tokens/src/tokens.css',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(join(projectRoot, path), join(root, path), { recursive: true })
  }
  return root
}
function editJson(root, path, edit) {
  const value = JSON.parse(readFileSync(join(root, path), 'utf8'))
  edit(value)
  writeFileSync(join(root, path), JSON.stringify(value))
}
const failures = (root, group) => verify(root, [group])[0].failures.join('\n')

test('current project passes every static group', () => {
  assert.deepEqual(verify(projectRoot).flatMap(result => result.failures), [])
})

test('contract checks reject missing API paths and required error fields', t => {
  const root = fixture(t)
  editJson(root, 'docs/development/openapi-admin.json', api => { delete api.paths['/agents/rollback'] })
  editJson(root, 'docs/development/openapi-workbench.json', api => { api.components.schemas.ErrorEnvelope.properties.error.required = [] })
  assert.match(failures(root, 'contracts'), /缺少路径 \/agents\/rollback/)
  assert.match(failures(root, 'contracts'), /错误契约缺少 traceId/)
})

test('missing or malformed contracts report failures instead of passing', t => {
  const root = fixture(t)
  rmSync(join(root, 'docs/development/run-event.schema.json'))
  writeFileSync(join(root, 'docs/development/runtime-manifest.schema.json'), '{')
  assert.match(failures(root, 'contracts'), /run-event.schema.json 无法读取/)
  assert.match(failures(root, 'contracts'), /runtime-manifest.schema.json 不是有效 JSON/)
})

test('runtime checks reject version drift and production compatibility', t => {
  const root = fixture(t)
  editJson(root, 'server/config/dsh/runtime-lock.json', lock => { lock.commit = 'changed'; lock.compatibility.broken = null })
  appendFileSync(join(root, 'deploy/runtime.env.example'), '\nDSH_RUNTIME_COMPATIBILITY=legacy\n')
  assert.match(failures(root, 'runtime'), /完整 Commit SHA/)
  assert.match(failures(root, 'runtime'), /生产 DSH Commit 与 Lock 不一致/)
  assert.match(failures(root, 'runtime'), /生产模板不得启用开发兼容模式/)
})

test('project checks reject dangling docs and tests disconnected from CI', t => {
  const root = fixture(t)
  assert.equal(failures(root, 'project'), '')
  appendFileSync(join(root, 'README.md'), '\n[missing](docs/deleted.md)\n')
  editJson(root, 'package.json', pkg => { pkg.scripts['ci:check'] = pkg.scripts['ci:check'].replace('pnpm test:sso && ', '') })
  const workflow = join(root, '.github/workflows/ci.yml')
  writeFileSync(workflow, readFileSync(workflow, 'utf8').replace(' && pnpm test:sso:integration', ''))
  assert.match(failures(root, 'project'), /文档链接不存在：docs\/deleted.md/)
  assert.match(failures(root, 'project'), /test:sso 未接入 ci:check/)
  assert.match(failures(root, 'project'), /test:sso:integration 未接入 GitHub CI/)
})

test('security checks reject external authorization calls and plaintext secret columns', t => {
  const root = fixture(t)
  appendFileSync(join(root, 'server/src/modules/identity/ai-hub-client.ts'), '\nfetch("/authorization/decisions")\n')
  appendFileSync(join(root, 'server/migrations/0001_m2_platform.sql'), '\nALTER TABLE x ADD API_KEY TEXT;\n')
  assert.match(failures(root, 'security'), /不应包含 \/authorization\/decisions/)
  assert.match(failures(root, 'security'), /不得包含明文凭据列/)
})

test('CI command discovery handles run blocks and ignores step names and comments', () => {
  assert.deepEqual(workflowCommands(`
      - name: Set up pnpm and Node.js
        run: |
          # pnpm nonexistent
          pnpm verify
          pnpm run test:scripts
      - name: End
        run: pnpm test:e2e
  `), ['verify', 'test:scripts', 'test:e2e'])
})

test('verify CLI accepts a selected group and rejects typos', () => {
  const cli = join(projectRoot, 'scripts/verify.mjs')
  const selected = spawnSync(process.execPath, [cli, 'contracts'], { cwd: tmpdir(), encoding: 'utf8' })
  assert.equal(selected.status, 0, selected.stderr)
  assert.match(selected.stdout, /contracts 静态检查通过/)
  assert.doesNotMatch(selected.stdout, /runtime/)
  const invalid = spawnSync(process.execPath, [cli, 'contract'], { encoding: 'utf8' })
  assert.equal(invalid.status, 2)
})
