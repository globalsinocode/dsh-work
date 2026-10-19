// Server dependency rules. The application is a modular monolith: modules may call each other,
// but layers must not point backwards and module cycles may only shrink. Existing cycles live in
// server-dependency-baseline.json; a new cycle fails, and so does a baseline entry that no longer
// describes a real cycle, so the baseline can only get smaller.
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'

const sourceRoot = 'server/src'

/** Test files and test-only support code may use anything, including server/src/testing. */
export function isTestSupport(path) {
  return /\.test\.ts$/.test(path)
    || path.startsWith('testing/')
    || /(^|\/)test-[^/]+\.ts$/.test(path)
    || /-test-fixture\.ts$/.test(path)
}

/** The architectural unit a server/src-relative path belongs to. */
export function unitOf(path) {
  const [first, second] = path.split('/')
  if (first === 'modules') return `modules/${second}`
  if (first === 'main.ts') return 'main'
  return first.replace(/\.ts$/, '')
}

const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm

/** Relative imports of one file, resolved to server/src-relative paths. */
export function importsOf(path, content) {
  return [...content.matchAll(importPattern)].map(match =>
    normalize(join(dirname(path), match[1])).replace(/\\/g, '/'))
}

const forbidden = [
  { from: unit => unit === 'domain', to: unit => unit !== 'domain', message: 'domain 层只能依赖 domain 自身' },
  { from: unit => unit.startsWith('modules/'), to: unit => unit === 'http' || unit === 'main', message: '业务模块不得依赖 HTTP 层或应用入口' },
  { from: unit => unit === 'infrastructure', to: unit => unit === 'http' || unit === 'main', message: '基础设施不得依赖 HTTP 层或应用入口' },
  { from: () => true, to: unit => unit === 'testing', message: '生产代码不得引用 server/src/testing 中的测试身份或冒烟数据' },
]

/**
 * @param files Map of server/src-relative path → source text
 * @param baseline { cyclicModuleEdges: Array<{ from: string, to: string }> } with module names (no "modules/" prefix)
 * @returns violation messages
 */
export function analyzeServerDependencies(files, baseline) {
  const violations = []
  const edges = new Map()
  for (const [path, content] of files) {
    if (isTestSupport(path)) continue
    const from = unitOf(path)
    for (const target of importsOf(path, content)) {
      if (target.startsWith('..')) continue
      const to = unitOf(target)
      if (to === from) continue
      for (const rule of forbidden) {
        if (rule.from(from) && rule.to(to)) violations.push(`server/src/${path} → server/src/${target}：${rule.message}`)
      }
      if (from.startsWith('modules/') && to.startsWith('modules/')) {
        const a = from.slice('modules/'.length), b = to.slice('modules/'.length)
        if (!edges.has(a)) edges.set(a, new Map())
        if (!edges.get(a).has(b)) edges.get(a).set(b, path)
      }
    }
  }

  const reaches = (start, goal) => {
    const seen = new Set([start]), queue = [start]
    while (queue.length) {
      const node = queue.shift()
      if (node === goal) return true
      for (const next of edges.get(node)?.keys() ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
    return false
  }
  const key = (a, b) => `${a} → ${b}`
  const allowed = new Set((baseline.cyclicModuleEdges ?? []).map(edge => key(edge.from, edge.to)))
  const cyclic = new Set()
  for (const [a, targets] of edges) {
    for (const [b, path] of targets) {
      if (!reaches(b, a)) continue
      cyclic.add(key(a, b))
      if (!allowed.has(key(a, b))) {
        violations.push(`新增模块循环依赖 ${key(a, b)}（server/src/${path}）：请依赖接口或调整方向，不要新增循环`)
      }
    }
  }
  for (const entry of allowed) {
    if (!cyclic.has(entry)) {
      violations.push(`循环依赖基线已过期：${entry} 已不构成循环，请从 scripts/checks/server-dependency-baseline.json 删除`)
    }
  }
  return violations
}

async function readSources(root, directory = '') {
  const files = new Map()
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.isDirectory()) for (const [p, c] of await readSources(root, path)) files.set(p, c)
    else if (entry.name.endsWith('.ts')) files.set(path, await readFile(join(root, path), 'utf8'))
  }
  return files
}

export async function checkServerDependencies(projectRoot) {
  const baseline = JSON.parse(await readFile(join(projectRoot, 'scripts/checks/server-dependency-baseline.json'), 'utf8'))
  return analyzeServerDependencies(await readSources(join(projectRoot, sourceRoot)), baseline)
}
