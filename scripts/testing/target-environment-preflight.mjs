import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../..')
const runtimeLockPath = resolve(repoRoot, 'server/config/dsh/runtime-lock.json')
const requireFromServer = createRequire(resolve(repoRoot, 'server/package.json'))
const secretName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i
const reportedSecretKeys = ['DSH_WORK_TEST_DATABASE_URL', 'DSH_RUNTIME_COMPATIBILITY']
const profileMarker = ['packages', 'bundle', 'acp-app', 'cordis.patch.yml']

export function checkTargetEnvironment(snapshot, inputs = {}) {
  const env = inputs.env ?? {}
  const fileExists = inputs.fileExists ?? existsSync
  const lock = lockIdentity(inputs.runtimeLock)
  const items = [
    compareText('node', snapshot.node, inputs.nodeVersion, normalizeToolVersion),
    compareText('pnpm', snapshot.pnpm, inputs.pnpmVersion, normalizeToolVersion),
    compareText('sourceCommit', snapshot.sourceCommit, inputs.gitCommit, normalizeCommit),
    compareText('dsh.version', snapshot.dsh?.version, lock.version, normalizePlain),
    compareText('dsh.commit', snapshot.dsh?.commit, lock.commit, normalizeCommit),
    profileItem(snapshot.dsh?.profile, env, fileExists),
    compatibilityItem(env),
    migrationItem(snapshot.migrationsThrough, env, inputs.migrationVersion),
  ]
  const secrets = secretReport(env)
  const exitCode = items.some(item => item.status === 'mismatch' || item.status === 'missing') ? 1 : 0
  const report = { ok: exitCode === 0, exitCode, items, secrets }
  return {
    ...report,
    stdout: renderText(report),
    stderr: '',
    json: `${JSON.stringify(report, null, 2)}\n`,
  }
}

function lockIdentity(lock) {
  if (!lock || typeof lock !== 'object') return { version: null, commit: null }
  return { version: lock.version ?? null, commit: lock.commit ?? null }
}

function compareText(name, expected, actual, normalize) {
  if (expected == null || String(expected).trim() === '') {
    return { name, status: 'missing', expected: null, actual: null }
  }
  const normalizedExpected = normalize(expected)
  const normalizedActual = actual == null ? null : normalize(actual)
  if (normalizedExpected == null) return { name, status: 'missing', expected: null, actual: null }
  if (normalizedActual == null) return { name, status: 'missing', expected: normalizedExpected, actual: null }
  return {
    name,
    status: normalizedExpected === normalizedActual ? 'match' : 'mismatch',
    expected: normalizedExpected,
    actual: normalizedActual,
  }
}

function normalizeToolVersion(value) {
  const text = String(value).trim().replace(/^v/i, '')
  return text === '' ? null : text
}

function normalizePlain(value) {
  const text = String(value).trim()
  return text === '' ? null : text
}

function normalizeCommit(value) {
  const text = String(value).trim().toLowerCase()
  return text === '' ? null : text
}

function presentText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function profileItem(expected, env, fileExists) {
  if (expected == null || String(expected).trim() === '') {
    return { name: 'dsh.profile', status: 'missing', expected: null, actual: null }
  }
  const home = presentText(env.DSH_RUNTIME_HOME) ?? presentText(env.DSH_HOME)
  if (!home) return { name: 'dsh.profile', status: 'missing', expected, actual: null }
  const active = fileExists(join(home, ...profileMarker)) ? 'acp-app' : null
  if (active == null) return { name: 'dsh.profile', status: 'mismatch', expected, actual: null }
  return {
    name: 'dsh.profile',
    status: active === expected ? 'match' : 'mismatch',
    expected,
    actual: active,
  }
}

function compatibilityItem(env) {
  const set = env.DSH_RUNTIME_COMPATIBILITY !== undefined && env.DSH_RUNTIME_COMPATIBILITY !== null
  return { name: 'dsh.compatibility', status: set ? 'mismatch' : 'match', expected: null, actual: null }
}

function migrationItem(expected, env, migrationVersion) {
  const databaseUrl = env.DSH_WORK_TEST_DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') {
    return { name: 'migrations', status: 'not-checked', expected: expected ?? null, actual: null }
  }
  if (expected == null || String(expected).trim() === '' || migrationVersion == null || migrationVersion === '') {
    return { name: 'migrations', status: 'missing', expected: expected ?? null, actual: null }
  }
  const expectedRank = migrationRank(expected)
  const actualRank = migrationRank(migrationVersion)
  if (expectedRank == null || actualRank == null) {
    return { name: 'migrations', status: 'mismatch', expected, actual: null }
  }
  return {
    name: 'migrations',
    status: expectedRank === actualRank ? 'match' : 'mismatch',
    expected,
    actual: String(migrationVersion),
  }
}

function migrationRank(value) {
  const match = String(value).trim().match(/^(\d+)/)
  return match ? Number(match[1]) : null
}

function secretReport(env) {
  const extras = Object.keys(env)
    .filter(key => secretName.test(key) && !reportedSecretKeys.includes(key))
    .sort()
  const secrets = {}
  for (const key of [...reportedSecretKeys, ...extras]) {
    const value = env[key]
    secrets[key] = value === undefined || value === null ? 'MISSING' : 'SET'
  }
  return secrets
}

function renderText(report) {
  const lines = [`target-environment: ${report.ok ? 'ok' : 'fail'}`]
  for (const item of report.items) lines.push(formatItem(item))
  lines.push('secrets:')
  for (const [key, state] of Object.entries(report.secrets)) lines.push(`${key}: ${state}`)
  return `${lines.join('\n')}\n`
}

function formatItem(item) {
  if (item.name === 'dsh.compatibility' || item.status === 'missing' || item.status === 'not-checked' || item.actual == null) {
    return `${item.name}: ${item.status}`
  }
  return `${item.name}: ${item.status} expected=${item.expected} actual=${item.actual}`
}

function commandStdout(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    cwd: options.cwd,
    shell: options.shell ?? false,
  })
  if (result.error || result.status !== 0) return null
  const stdout = result.stdout?.trim() ?? ''
  return stdout === '' ? null : stdout
}

function readPnpmVersion() {
  if (process.platform === 'win32') {
    return commandStdout('pnpm.cmd', ['--version']) ?? commandStdout('pnpm', ['--version'], { shell: true })
  }
  return commandStdout('pnpm', ['--version'])
}

function readRuntimeLock() {
  try {
    const parsed = JSON.parse(readFileSync(runtimeLockPath, 'utf8'))
    return { version: parsed.version ?? null, commit: parsed.commit ?? null }
  } catch {
    return null
  }
}

async function readMigrationVersion(databaseUrl) {
  if (databaseUrl === undefined || databaseUrl === '') return undefined
  let sql
  try {
    const postgres = requireFromServer('postgres')
    sql = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 1,
      connect_timeout: 5,
      prepare: false,
      onnotice() {},
    })
    const rows = await sql`select max(version) as version from schema_migrations`
    const version = rows[0]?.version
    return version == null ? null : String(version)
  } catch {
    return null
  } finally {
    if (sql) {
      try {
        await sql.end({ timeout: 1 })
      } catch {
        // 查询失败时不输出连接信息
      }
    }
  }
}

async function collectTargetEnvironmentInputs(env) {
  return {
    env,
    nodeVersion: commandStdout(process.execPath, ['--version']),
    pnpmVersion: readPnpmVersion(),
    gitCommit: commandStdout('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    runtimeLock: readRuntimeLock(),
    migrationVersion: await readMigrationVersion(env.DSH_WORK_TEST_DATABASE_URL),
  }
}

function parseArgs(argv) {
  let profile = ''
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') json = true
    else if (arg === '--profile') {
      profile = argv[index + 1] ?? ''
      index += 1
    }
  }
  return { profile, json }
}

async function main() {
  const { profile, json } = parseArgs(process.argv.slice(2))
  if (!profile) {
    process.stderr.write('missing --profile\n')
    process.exit(2)
  }
  let snapshot
  try {
    snapshot = JSON.parse(readFileSync(profile, 'utf8'))
  } catch {
    process.stderr.write('unable to read profile\n')
    process.exit(2)
  }
  const result = checkTargetEnvironment(snapshot, await collectTargetEnvironmentInputs(process.env))
  process.stdout.write(json ? result.json : result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.exitCode)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
