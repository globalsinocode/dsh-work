import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { registerLoginSettingsRoutes } from '../../http/admin/login-settings-routes.ts'
import { registerLocalAuthRoutes } from '../../http/local-auth-routes.ts'
import { requireRequestIdentity, Router } from '../../http/router.ts'
import { IdentityAdministrationService } from './administration-service.ts'
import { loadIdentityConfiguration } from './config.ts'
import { LocalAuthService } from './local-auth-service.ts'
import { LoginSettingsService, loadStartupIdentityConfiguration } from './login-settings-service.ts'
import { IdentitySessionRepository } from './session-repository.ts'
import type { RequestIdentity } from './types.ts'

let fixture: ThrowawayDatabase
let server: Server
let origin: string
let environment: NodeJS.ProcessEnv
let settings: LoginSettingsService
let adminId: string
let upstreamAdminId: string
let cookie: string
let identity: RequestIdentity
const password = 'login-settings-only admin passphrase'

before(async () => {
  fixture = await createThrowawayDatabase({ namePrefix: 'dsh_login_settings_test', maxConnections: 3 })
  const router = new Router({ authenticateApi: (request, audience) => authentication.authenticateApi(request, audience) })
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://localhost:${address.port}`
  environment = {
    DSH_WORK_AUTH_MODE: 'local', DSH_WORK_COOKIE_SECURE: 'false',
    DSH_WORK_SESSION_SECRET: 'login-settings-fixture-session-secret-32',
    DSH_WORK_ADMIN_ORIGINS: origin, DSH_WORK_WORKBENCH_ORIGINS: origin,
    DSH_WORK_ADMIN_PORT: String(address.port), DSH_WORK_WORKBENCH_PORT: String(address.port),
    AI_HUB_PLATFORM_URL: 'http://localhost:9', AI_HUB_APPLICATION_ID: 'fixture-app',
    AI_HUB_CLIENT_ID: 'fixture-client', AI_HUB_CLIENT_SECRET: 'fixture-oidc-secret-not-a-real-credential',
    AI_HUB_OIDC_ISSUER: 'http://localhost:9/oidc',
  }
  const config = loadIdentityConfiguration(environment)
  assert.equal(config.mode, 'local')
  const authentication = new LocalAuthService(config, fixture.client)
  adminId = (await authentication.bootstrap({ username: 'settings.admin', name: '登录设置管理员', password })).userId
  const repository = new IdentitySessionRepository(fixture.client)
  upstreamAdminId = (await repository.synchronizeIdentity({ externalUserId: 'settings-upstream', subject: 'settings-upstream-subject', displayName: '上游管理员', email: null, organizationName: '验收', businessUser: true, status: 'ACTIVE' })).userId
  await new IdentityAdministrationService(fixture.client, true).grantRole({ userId: upstreamAdminId, roleId: 'role-platform-admin', actorId: adminId })
  settings = new LoginSettingsService(fixture.client, 'local', environment)
  registerLocalAuthRoutes(router, authentication)
  registerLoginSettingsRoutes(router, settings)
  router.get('/api/admin/v1/session', (_request, context) => requireRequestIdentity(context, 'admin'))
})

beforeEach(async () => {
  await fixture.client`delete from system_settings where key = 'identity.login'`
  await fixture.client`delete from local_auth_rate_limits`
  const response = await fetch(`${origin}/auth/admin/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'settings.admin', password }),
  })
  assert.equal(response.status, 200)
  cookie = response.headers.get('set-cookie')!.split(';')[0]!
  identity = await (await fetch(`${origin}/api/admin/v1/session`, { headers: { Cookie: cookie } })).json() as RequestIdentity
})
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (fixture) await fixture.dispose()
})

test('HTTP settings are persisted, audited and pending until activation; restart revokes old sessions', async () => {
  const response = await fetch(`${origin}/api/admin/v1/identity/login-settings`, {
    method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'oidc', expectedRevision: 0, actorId: 'forged-actor' }),
  })
  assert.equal(response.status, 200)
  const saved = (await response.json()).data
  assert.equal(saved.activeMode, 'local')
  assert.equal(saved.savedMode, 'oidc')
  assert.equal(saved.pendingRestart, true)
  assert.equal(JSON.stringify(saved).includes(environment.AI_HUB_CLIENT_SECRET!), false)
  assert.equal((await fetch(`${origin}/api/admin/v1/session`, { headers: { Cookie: cookie } })).status, 200)
  assert.equal((await new LoginSettingsService(fixture.client, 'local', environment).get()).savedMode, 'oidc')
  assert.equal((await loadStartupIdentityConfiguration(fixture.client, environment)).mode, 'oidc')
  assert.equal((await fetch(`${origin}/api/admin/v1/session`, { headers: { Cookie: cookie } })).status, 200, 'preflight must not revoke sessions')
  await new IdentitySessionRepository(fixture.client).createLoginTransaction({ transactionHash: 'old-transaction', audience: 'admin', stateHash: 'state', codeVerifierEncrypted: 'encrypted', nonce: 'nonce', returnTo: '/', portalOrigin: origin, redirectUri: `${origin}/auth/admin/callback`, expiresAt: new Date(Date.now() + 60_000) })
  assert.equal((await loadStartupIdentityConfiguration(fixture.client, environment, true)).mode, 'oidc')
  assert.equal((await fetch(`${origin}/api/admin/v1/session`, { headers: { Cookie: cookie } })).status, 401)
  const [transactions] = await fixture.client`select count(*)::int as count from oidc_login_transactions`
  assert.equal(transactions!.count, 0)
  const [audit] = await fixture.client`select actor_id from audit_events where action = 'identity.login_mode.save' order by occurred_at desc limit 1`
  assert.equal(audit!.actor_id, adminId)
})

test('cancelling a pending change keeps local login and old sessions after restart', async () => {
  await settings.save({ mode: 'oidc', expectedRevision: 0 }, identity)
  await settings.save({ mode: 'local', expectedRevision: 1 }, identity)
  assert.equal((await settings.get()).pendingRestart, false)
  const localOnlyEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('AI_HUB_')))
  assert.equal((await loadStartupIdentityConfiguration(fixture.client, { ...localOnlyEnvironment, DSH_WORK_AUTH_MODE: 'oidc' }, true)).mode, 'local')
  assert.equal((await fetch(`${origin}/api/admin/v1/session`, { headers: { Cookie: cookie } })).status, 200)
})

test('missing provider configuration or target administrator blocks saving and activation', async () => {
  const missing = new LoginSettingsService(fixture.client, 'local', { ...environment, AI_HUB_CLIENT_SECRET: '' })
  assert.equal((await missing.get()).options.find(option => option.mode === 'oidc')?.available, false)
  await assert.rejects(missing.save({ mode: 'oidc', expectedRevision: 0 }, identity), /CLIENT_SECRET/)
  await fixture.client`update users set status = 'disabled' where id = ${upstreamAdminId}`
  try {
    await assert.rejects(settings.save({ mode: 'oidc', expectedRevision: 0 }, identity), /有效平台管理员/)
  } finally { await fixture.client`update users set status = 'active' where id = ${upstreamAdminId}` }
  await settings.save({ mode: 'oidc', expectedRevision: 0 }, identity)
  await assert.rejects(loadStartupIdentityConfiguration(fixture.client, { ...environment, AI_HUB_CLIENT_SECRET: '' }, true), /CLIENT_SECRET/)
  assert.equal((await fetch(`${origin}/api/admin/v1/session`, { headers: { Cookie: cookie } })).status, 200)
  await fixture.client`update users set status = 'disabled' where id = ${upstreamAdminId}`
  try { await assert.rejects(loadStartupIdentityConfiguration(fixture.client, environment, true), /有效平台管理员/) }
  finally { await fixture.client`update users set status = 'active' where id = ${upstreamAdminId}` }
})

test('concurrent settings updates reject stale revisions instead of overwriting', async () => {
  const results = await Promise.allSettled([
    settings.save({ mode: 'oidc', expectedRevision: 0 }, identity),
    settings.save({ mode: 'local', expectedRevision: 0 }, identity),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.match(failure.reason.message, /已被修改/)
  assert.equal((await settings.get()).revision, 1)
})

test('prototype, ordinary writers, revoked administrators and invalid modes cannot modify settings', async () => {
  await assert.rejects(settings.save({ mode: 'prototype', expectedRevision: 0 }, identity), /请选择/)
  await assert.rejects(settings.save({ mode: 'oidc', expectedRevision: 0 }, { ...identity, permissions: ['admin:write'] }), /只有平台管理员/)
  await assert.rejects(settings.save({ mode: 'oidc', expectedRevision: 0 }, { ...identity, identityProvider: 'prototype-sso' }), /正式管理员/)
  await fixture.client`update users set status = 'disabled' where id = ${adminId}`
  try { await assert.rejects(settings.save({ mode: 'oidc', expectedRevision: 0 }, identity), /已无平台管理员权限/) }
  finally { await fixture.client`update users set status = 'active' where id = ${adminId}` }
  assert.equal((await settings.get()).revision, 0)
})

test('settings writes enforce same-origin, authentication and valid bodies', async () => {
  const url = `${origin}/api/admin/v1/identity/login-settings`
  assert.equal((await fetch(url, { method: 'PATCH', headers: { Cookie: cookie, Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'oidc', expectedRevision: 0 }) })).status, 403)
  assert.equal((await fetch(url, { method: 'PATCH', headers: { Origin: origin } })).status, 401)
  assert.equal((await fetch(url, { method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: 'null' })).status, 422)
})
