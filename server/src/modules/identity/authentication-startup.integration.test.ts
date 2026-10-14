import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { loadIdentityConfiguration } from './config.ts'
import { LocalAuthService } from './local-auth-service.ts'

let database: ThrowawayDatabase
let adminId: string
const password = 'Startup12345'
const secret = 'startup-fixture-session-secret-at-least-32'
before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_auth_startup' })
  const config = loadIdentityConfiguration({ DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: secret, DSH_WORK_WORKBENCH_ORIGINS: 'http://localhost:4674', DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4680' })
  assert.equal(config.mode, 'local')
  adminId = (await new LocalAuthService(config, database.client).bootstrap({ username: 'startup.admin@example.invalid', name: '启动验收管理员', password })).userId
  // Old saved settings must be inert, including malformed or pending selections.
  await database.client`insert into system_settings (tenant_id, key, value, revision, updated_by) values ('tenant-dsh-work', 'identity.login', '{"mode":"invalid-old-setting","appliedMode":"local"}', 1, ${adminId})`
})
after(async () => { await database?.dispose() })

async function start(extra: NodeJS.ProcessEnv, legacyCallbacks = false) {
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>(done => listener.close(() => done()))
  const origin = `http://localhost:${port}`
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-startup-'))
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: { PATH: process.env.PATH, NODE_ENV: 'development', DSH_WORK_DATABASE_URL: database.url,
      DSH_WORK_DATA_ROOT: root, DSH_RUNTIME_HOME: join(root, 'unavailable-runtime'),
      DSH_WORK_SESSION_SECRET: secret, DSH_WORK_COOKIE_SECURE: 'false',
      ...(legacyCallbacks ? {
        AI_HUB_ADMIN_PORTAL_URL: origin, AI_HUB_WORKBENCH_PORTAL_URL: origin,
        AI_HUB_ADMIN_REDIRECT_URI: 'http://localhost:4190/auth/admin/callback',
        AI_HUB_WORKBENCH_REDIRECT_URI: 'http://localhost:4190/auth/workbench/callback',
      } : { DSH_WORK_ADMIN_ORIGINS: origin, DSH_WORK_WORKBENCH_ORIGINS: origin }),
      DSH_WORK_ADMIN_PORT: String(port), DSH_WORK_WORKBENCH_PORT: String(port),
      DSH_WORK_SERVER_HOST: '127.0.0.1', DSH_WORK_SERVER_PORT: String(port), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const exited = once(child, 'exit')
  return {
    origin, output: () => output,
    async ready() {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(output)
        try { if ((await fetch(`${origin}/health/live`)).ok) return } catch { /* starting */ }
        await delay(30)
      }
      throw new Error(`Startup timed out: ${output}`)
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([exited, delay(3000)])
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

const upstream = { AI_HUB_PLATFORM_URL: 'http://localhost:9', AI_HUB_OIDC_ISSUER: 'http://localhost:9/fixture', AI_HUB_APPLICATION_ID: 'startup-fixture', AI_HUB_CLIENT_ID: 'startup-fixture', AI_HUB_CLIENT_SECRET: 'fixture-not-a-real-secret' }
for (const scenario of [
  { name: 'no provider configuration', environment: {}, aiHubEnabled: false },
  { name: 'incomplete provider configuration', environment: { ...upstream, AI_HUB_CLIENT_SECRET: '' }, aiHubEnabled: false },
  { name: 'valid configuration with unavailable provider and legacy local mode', environment: { ...upstream, DSH_WORK_AUTH_MODE: 'local' }, aiHubEnabled: true },
  { name: 'legacy portal configuration with separate backend callbacks', environment: upstream, aiHubEnabled: true, legacyCallbacks: true },
]) {
  test(`startup ignores old mode records and supports password login with ${scenario.name}`, async () => {
    const app = await start(scenario.environment, scenario.legacyCallbacks)
    try {
      await app.ready()
      for (const audience of ['admin', 'workbench']) {
        const config = await (await fetch(`${app.origin}/auth/${audience}/configuration`)).json()
        assert.equal(config.localEnabled, true)
        assert.equal(config.aiHubEnabled, scenario.aiHubEnabled)
        assert.equal(JSON.stringify(config).includes('fixture-not-a-real-secret'), false)
      }
      if (scenario.name.startsWith('incomplete')) assert.match(app.output(), /AI Hub 登录未启用/)
      if (scenario.aiHubEnabled) assert.doesNotMatch(app.output(), /AI Hub 登录未启用/)
      const login = await fetch(`${app.origin}/auth/admin/login`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'startup.admin@example.invalid', password, returnTo: '/identity' }) })
      assert.equal(login.status, 200)
      const cookie = login.headers.getSetCookie().find(value => value.startsWith('dsh_work_local_admin_session='))!.split(';')[0]!
      assert.equal((await fetch(`${app.origin}/api/admin/v1/session`, { headers: { Cookie: cookie } })).status, 200)
      for (const method of ['GET', 'PATCH']) {
        assert.equal((await fetch(`${app.origin}/api/admin/v1/identity/login-settings`, { method, headers: { Cookie: cookie, Origin: app.origin } })).status, 404)
      }
      const [old] = await database.client`select value from system_settings where key = 'identity.login'`
      assert.equal(old!.value.mode, 'invalid-old-setting')
      if (scenario.aiHubEnabled) {
        const response = await fetch(`${app.origin}/auth/admin/oidc/login?return_to=%2Fidentity`, { redirect: 'manual' })
        assert.equal(response.status, 302)
        assert.equal(new URL(response.headers.get('location')!).searchParams.get('auth_error'), 'ai_hub_unavailable')
        assert.equal((await fetch(`${app.origin}/api/admin/v1/session`, { headers: { Cookie: cookie } })).status, 200)
      }
    } finally { await app.close() }
  })
}
