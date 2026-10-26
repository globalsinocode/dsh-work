import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pnpmCommands, workflowCommands } from './context.mjs'

// CI runs server tests by file name (scripts/testing/run-server-tests.mjs), so wiring is checked
// at the level of these entry points rather than per suite.
const qualityScripts = ['verify', 'check:secrets', 'typecheck', 'lint', 'build', 'test:scripts', 'test:unit', 'test:m5:frontend']
const ciScripts = ['ci:static', 'ci:unit', 'test:integration', 'test:e2e']

/** pnpm commands a script runs, following nested pnpm scripts. */
function expandScripts(scripts, name, seen = new Set()) {
  if (seen.has(name)) return seen
  seen.add(name)
  for (const child of pnpmCommands(scripts[name] ?? '')) if (!child.startsWith('-')) expandScripts(scripts, child, seen)
  return seen
}

export function checkProject(check) {
  check.files([
    'README.md', 'docs/index/README.md', 'docs/development/overview.md', 'docs/design/data-model.md',
    'docs/development/internal-ports.md', 'docs/development/development.md',
    'docs/release/ai-hub-sso-integration.md', 'docs/release/dsh-runtime-delivery.md',
    'docs/release/mac-mini-deployment-runbook.md',
    'apps/workbench-web/vitest.config.ts', 'apps/admin-web/vitest.config.ts',
    'playwright.config.ts', 'e2e/mvp-smoke.spec.ts',
  ])
  const docs = resolve(check.root, 'docs')
  const skipDocLinkPrefixes = ['development/fixtures/', 'development/local-skills/']
  const markdownFiles = ['README.md', ...(existsSync(docs)
    ? readdirSync(docs, { recursive: true })
      .filter(file => typeof file === 'string' && file.endsWith('.md'))
      .map(file => file.replace(/\\/g, '/'))
      .filter(file => !skipDocLinkPrefixes.some(prefix => file.startsWith(prefix)))
      .map(file => `docs/${file}`)
    : [])]
  for (const file of markdownFiles) {
    const markdown = check.read(file).replace(/```[^\n]*\n[\s\S]*?```/g, '')
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0]
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue
      check.assert(existsSync(resolve(check.root, dirname(file), target)), `${file} 文档链接不存在：${target}`)
    }
  }

  const pkg = check.json('package.json')
  const scripts = pkg?.scripts ?? {}
  const workflow = check.read('.github/workflows/ci.yml')
  const quality = expandScripts(scripts, 'ci:check')
  const ciCommands = workflowCommands(workflow)
  const ci = new Set(ciCommands.flatMap(name => [...expandScripts(scripts, name)]))
  for (const name of qualityScripts) {
    check.assert(typeof scripts[name] === 'string', `package.json 缺少 ${name}`)
    check.assert(quality.has(name), `${name} 未接入 ci:check`)
  }
  for (const name of [...ciScripts, ...Object.keys(scripts).filter(key => key.startsWith('test:e2e'))]) {
    check.assert(typeof scripts[name] === 'string', `package.json 缺少 ${name}`)
    check.assert(ciCommands.includes(name), `${name} 未接入 GitHub CI`)
  }
  for (const name of [...quality, ...ci]) {
    if (['install', 'exec'].includes(name)) continue
    check.assert(typeof scripts[name] === 'string', `工作流引用了不存在的命令 ${name}`)
  }
  // Named suites stay available for targeted local runs; they must still point at real files.
  const server = check.json('server/package.json')?.scripts ?? {}
  for (const [name, command] of Object.entries(scripts)) {
    const target = command.match(/^pnpm --filter @dsh-work\/server ([\w:-]+)$/)?.[1]
    if (!target) continue
    check.assert(typeof server[target] === 'string', `${name} 引用的服务端脚本 ${target} 不存在`)
    const files = [...(server[target] ?? '').matchAll(/\b((?:src|config)\/\S+\.(?:ts|js))(?=\s|$)/g)]
    check.files(files.map(match => `server/${match[1]}`))
  }
  for (const dependency of ['vitest', '@vue/test-utils', 'happy-dom', '@playwright/test']) {
    check.assert(typeof pkg?.devDependencies?.[dependency] === 'string', `缺少测试依赖 ${dependency}`)
  }
  for (const [action, pattern] of [
    ['actions/checkout', /actions\/checkout@[0-9a-f]{40}\s+# v\d/],
    ['pnpm/setup', /pnpm\/setup@[0-9a-f]{40}\s+# v\d/],
  ]) check.assert(pattern.test(workflow), `CI 的 ${action} 必须固定带版本注释的 Commit SHA`)
  check.includes('.github/workflows/ci.yml', [
    'pnpm install --frozen-lockfile',
    'playwright install --with-deps chromium', 'bash scripts/ci/deploy.sh',
  ])
  checkMigrationNumbers(check)
  checkDataModelCoversTables(check)
  checkDatabaseTestsAreNamed(check)
}

// 0039 was assigned twice before this check existed; applied versions are keyed by file
// name and must never be renamed, so only that pair is grandfathered.
const grandfatheredMigrationNumbers = new Set(['0039'])

function checkMigrationNumbers(check) {
  const directory = resolve(check.root, 'server/migrations')
  if (!existsSync(directory)) return
  const seen = new Map()
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    const number = file.slice(0, 4)
    check.assert(/^\d{4}_[a-z0-9_]+\.sql$/.test(file), `迁移文件名不符合 NNNN_name.sql：${file}`)
    if (seen.has(number) && !grandfatheredMigrationNumbers.has(number)) {
      check.failures.add(`迁移编号重复：${seen.get(number)} 与 ${file}，新迁移请使用下一个未占用编号`)
    }
    seen.set(number, file)
  }
}

/**
 * test:unit runs every *.test.ts without a database, test:integration every *.integration.test.ts with
 * one; a database suite with the wrong name would run (and fail or skip) in the unit job instead.
 */
function checkDatabaseTestsAreNamed(check) {
  for (const base of ['server/src', 'server/config']) {
    for (const file of testFiles(resolve(check.root, base))) {
      if (/\.integration\.test\.(?:ts|js)$/.test(file)) continue
      const path = `${base}/${file}`
      check.assert(!/createThrowawayDatabase|DSH_WORK_TEST_DATABASE_URL/.test(check.read(path)),
        `${path} 使用测试数据库，必须命名为 *.integration.test.ts`)
    }
  }
}

function testFiles(directory, prefix = '') {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? testFiles(resolve(directory, entry.name), `${prefix}${entry.name}/`)
    : /\.test\.(?:ts|js)$/.test(entry.name) ? [`${prefix}${entry.name}`] : [])
}

/** docs/design/data-model.md must name every table that a migration creates and none drops. */
function checkDataModelCoversTables(check) {
  const directory = resolve(check.root, 'server/migrations')
  if (!existsSync(directory)) return
  const tables = new Set()
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    const sql = check.read(`server/migrations/${file}`)
    for (const match of sql.matchAll(/create table (?:if not exists )?([a-z_][a-z0-9_]*)/gi)) tables.add(match[1].toLowerCase())
    for (const match of sql.matchAll(/drop table (?:if exists )?([a-z_][a-z0-9_]*)/gi)) tables.delete(match[1].toLowerCase())
  }
  const model = check.read('docs/design/data-model.md')
  for (const table of tables) {
    check.assert(model.includes(`\`${table}\``), `docs/design/data-model.md 未说明数据表 ${table}`)
  }
}
