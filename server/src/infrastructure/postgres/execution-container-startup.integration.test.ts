import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

/**
 * 执行隔离阶段 3（方案 4.9）：执行容器为必需，服务启动时检查。需要真实 DSH 与 Docker，
 * 并用 DSH_WORK_EXECUTION_E2E_IMAGE 指定能通过工具链检查（bash、rg、LibreOffice、pdftoppm）、按摘要或本地镜像 ID
 * 锁定的执行镜像（执行镜像工作流产出的镜像即可）；缺少任一项则跳过。
 */
const image = process.env.DSH_WORK_EXECUTION_E2E_IMAGE?.trim()
const skip = !image ? 'DSH_WORK_EXECUTION_E2E_IMAGE is not set'
  : !process.env.DSH_RUNTIME_HOME ? 'DSH_RUNTIME_HOME is not set'
    : spawnSync('docker', ['info'], { timeout: 5_000 }).status !== 0 ? 'Docker is not available' : false

let db: ThrowawayDatabase | undefined
before(async () => { if (!skip) db = await createThrowawayDatabase({ namePrefix: 'dsh_exec_startup' }) })
after(async () => { await db?.dispose() })

interface Health { data: { dshRuntime: { status: string }; executionCapabilities: { dsh: { status: string }; python: { status: string }; executionContainer: { status: string } } } }

test('a usable image: every DSH process gets the overlay, and the removed switch is ignored with a warning', { skip, timeout: 120_000 }, async () => {
  const app = await startApplication({ DSH_WORK_EXECUTION_CONTAINER: 'off', DSH_WORK_EXECUTION_IMAGE: image! })
  try {
    const health = await waitForHealth(app)
    assert.equal(health.data.executionCapabilities.dsh.status, 'available')
    assert.equal(health.data.executionCapabilities.executionContainer.status, 'available', app.output())
    assert.equal(health.data.executionCapabilities.python.status, 'available')
    assert.notEqual(health.data.dshRuntime.status, 'offline')
    assert.match(app.output(), /execution container toolchain: bash [\d.]+, rg [\d.]+, soffice [\d.]+, pdftoppm [\d.]+/)
    assert.match(app.output(), /DSH_WORK_EXECUTION_CONTAINER is removed and ignored/)
    const overlay = await readFile(join(app.root, 'dsh-config/execution-container.cordis.patch.yml'), 'utf8')
    assert.match(overlay, /dsh-work-remote-subprocess\.js/)
  } finally { await app.close() }
})

test('an unusable image: DSH never runs on the host and the Runtime refuses runs', { skip, timeout: 120_000 }, async () => {
  const app = await startApplication({ DSH_WORK_EXECUTION_IMAGE: `missing@sha256:${'0'.repeat(64)}` })
  try {
    const health = await waitForHealth(app)
    assert.equal(health.data.executionCapabilities.dsh.status, 'available')
    assert.equal(health.data.executionCapabilities.executionContainer.status, 'unavailable')
    assert.equal(health.data.executionCapabilities.python.status, 'unavailable')
    assert.equal(health.data.dshRuntime.status, 'offline', 'no Runtime accepts work without the execution container')
    assert.match(app.output(), /execution container unavailable; Agent runs are refused/)
    assert.doesNotMatch(app.output(), /stay on the host/)
  } finally { await app.close() }
})

test('no image configured: the execution container is unavailable, not optional', { skip, timeout: 120_000 }, async () => {
  const app = await startApplication({})
  try {
    const health = await waitForHealth(app)
    assert.equal(health.data.executionCapabilities.executionContainer.status, 'unavailable')
    assert.equal(health.data.dshRuntime.status, 'offline')
  } finally { await app.close() }
})

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port
}

async function startApplication(extra: NodeJS.ProcessEnv) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exec-startup-'))
  const port = await freePort()
  const base = `http://localhost:${port}`
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_HUB_')
    && key !== 'DSH_WORK_AUTH_MODE' && !key.startsWith('DSH_WORK_EXECUTION_') && !key.startsWith('DSH_WORK_PYTHON_')))
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: { ...inherited, NODE_ENV: 'development',
      DSH_WORK_SESSION_SECRET: 'execution-startup-session-secret-32-chars', DSH_WORK_COOKIE_SECURE: 'false',
      DSH_WORK_WORKBENCH_ORIGINS: base, DSH_WORK_ADMIN_ORIGINS: base,
      DSH_WORK_DATABASE_URL: db!.url, DSH_WORK_DATA_ROOT: root,
      DSH_WORK_SERVER_PORT: String(port), DSH_WORK_SERVER_HOST: '127.0.0.1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.on('data', chunk => { output += String(chunk) })
  const exited = once(child, 'exit')
  return { root, base, child, output: () => output,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await Promise.race([exited, delay(5000)])
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
      }
      await rm(root, { recursive: true, force: true })
    } }
}

async function waitForHealth(app: Awaited<ReturnType<typeof startApplication>>): Promise<Health> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (app.child.exitCode !== null) throw new Error(`backend exited during startup: ${app.output()}`)
    try {
      const response = await fetch(`${app.base}/health`)
      if (response.ok) return await response.json() as Health
    } catch { /* still starting */ }
    await delay(100)
  }
  throw new Error(`backend never became healthy: ${app.output()}`)
}
