#!/usr/bin/env node
// Runs server tests selected by file name and directory instead of hand-maintained file lists.
//   node scripts/testing/run-server-tests.mjs unit [dir...]
//   node scripts/testing/run-server-tests.mjs integration [dir...]
// Directories are relative to server/ (e.g. src/modules/run). Integration suites need
// DSH_WORK_TEST_DATABASE_URL and run one file at a time against throwaway databases.
// A test file whose leaked child or handle keeps it alive never finishes, and node:test then
// prints nothing for it or any later file. A run that outlives DSH_WORK_TEST_WATCHDOG_MINUTES
// (unit 10, integration 25) lists the processes still running under the runner and is stopped.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const serverTestRoots = ['src', 'config']

/** 'integration' | 'unit' | undefined for a server-relative path. */
export function classifyServerTest(path) {
  if (!/\.test\.(?:ts|js)$/.test(path)) return undefined
  return /\.integration\.test\.(?:ts|js)$/.test(path) ? 'integration' : 'unit'
}

/** `pid args` lines for every process below `root`, given `ps -A -o pid=,ppid=,args=` output. */
export function descendantProcesses(psOutput, root) {
  const rows = psOutput.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }))
  const found = []
  const visit = parent => {
    for (const row of rows) if (row.ppid === parent) { found.push(`${row.pid} ${row.args}`); visit(row.pid) }
  }
  visit(root)
  return found
}

export function listServerTests(serverRoot, kind, directories = serverTestRoots) {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path) } else {
        const file = relative(serverRoot, path).split('\\').join('/')
        if (classifyServerTest(file) === kind) files.push(file)
      }
    }
  }
  for (const directory of directories) {
    const absolute = resolve(serverRoot, directory)
    const inside = serverTestRoots.some(root => `${absolute}${sep}`.startsWith(`${resolve(serverRoot, root)}${sep}`))
    if (!inside) {
      throw new Error(`只能选择 server/src 或 server/config 下的目录：${directory}`)
    }
    if (!existsSync(absolute)) throw new Error(`目录不存在：server/${directory}`)
    walk(absolute)
  }
  return [...new Set(files)].sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [kind, ...directories] = process.argv.slice(2)
  if (kind !== 'unit' && kind !== 'integration') {
    console.error('用法：run-server-tests.mjs <unit|integration> [server 相对目录...]')
    process.exit(2)
  }
  const serverRoot = resolve(import.meta.dirname, '../../server')
  let files
  try {
    files = listServerTests(serverRoot, kind, directories.length ? directories : serverTestRoots)
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  if (!files.length) { console.error(`没有找到 ${kind} 测试`); process.exit(1) }
  if (kind === 'integration' && !process.env.DSH_WORK_TEST_DATABASE_URL && !existsSync(resolve(serverRoot, '../.env'))) {
    console.error('集成测试需要 DSH_WORK_TEST_DATABASE_URL（可写在 .env）')
    process.exit(2)
  }
  console.log(`运行 ${files.length} 个 ${kind} 测试文件`)
  const child = spawn(process.execPath, [
    '--env-file-if-exists=../.env', '--experimental-strip-types', '--test',
    `--test-concurrency=${kind === 'integration' ? 1 : 4}`, ...files,
  ], { cwd: serverRoot, stdio: 'inherit' })
  const minutes = Number(process.env.DSH_WORK_TEST_WATCHDOG_MINUTES || (kind === 'integration' ? 25 : 10))
  let interrupted = false
  const watchdog = setTimeout(() => {
    interrupted = true
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })
    console.error(`\n测试运行超过 ${minutes} 分钟，已中断。仍在运行的进程（卡住的测试文件及其遗留子进程）：`)
    for (const line of descendantProcesses(ps.stdout ?? '', child.pid)) console.error(`  ${line}`)
    child.kill('SIGINT')
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
  }, minutes * 60_000)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('exit', (code, signal) => {
    clearTimeout(watchdog)
    process.exit(interrupted ? 1 : code ?? (signal ? 1 : 0))
  })
}
