import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pnpmCommands, workflowCommands } from './context.mjs'

const unitScripts = [
  'test:m1', 'test:m2', 'test:m4:file', 'test:m4:error', 'test:m5:frontend',
  'test:m5:api', 'test:m5:security', 'test:m5:faults', 'test:sso', 'test:scripts',
]
const integrationScripts = [
  'test:m2:integration', 'test:m3:integration', 'test:m4:integration',
  ...['skill', 'tool', 'knowledge', 'file', 'authorization', 'runtime', 'audit', 'error']
    .map(feature => `test:m4:${feature}:integration`),
  ...['security', 'faults', 'capacity'].map(feature => `test:m5:${feature}:integration`),
  'test:sso:integration',
]

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
  const markdownFiles = ['README.md', ...(existsSync(docs)
    ? readdirSync(docs, { recursive: true }).filter(file => file.endsWith('.md')).map(file => `docs/${file}`)
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
  const quality = new Set(pnpmCommands(scripts['ci:check'] ?? ''))
  const ci = new Set(workflowCommands(workflow))
  for (const name of [...unitScripts, ...integrationScripts, 'test:e2e']) {
    check.assert(typeof scripts[name] === 'string', `package.json 缺少 ${name}`)
    const owner = name.endsWith(':integration') || name === 'test:e2e' ? ci : quality
    check.assert(owner.has(name), `${name} 未接入 ${owner === ci ? 'GitHub CI' : 'ci:check'}`)
  }
  for (const name of ['verify', 'check:secrets', 'typecheck', 'lint', 'build']) {
    check.assert(quality.has(name), `ci:check 缺少 ${name}`)
  }
  for (const name of [...quality, ...ci]) {
    if (['install', 'exec'].includes(name)) continue
    check.assert(typeof scripts[name] === 'string', `工作流引用了不存在的命令 ${name}`)
  }
  const server = check.json('server/package.json')?.scripts ?? {}
  for (const name of [...unitScripts, ...integrationScripts]) {
    const target = scripts[name]?.match(/^pnpm --filter @dsh-work\/server ([\w:-]+)$/)?.[1]
    if (!target) continue
    check.assert(typeof server[target] === 'string', `服务端缺少被引用的 ${target}`)
    const files = [...(server[target] ?? '').matchAll(/\b((?:src|config)\/\S+\.(?:ts|js))(?=\s|$)/g)]
    check.assert(files.length > 0, `${target} 没有明确的测试文件`)
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
    'pnpm install --frozen-lockfile', 'pnpm ci:check',
    'playwright install --with-deps chromium', 'bash scripts/ci/deploy.sh',
  ])
}
