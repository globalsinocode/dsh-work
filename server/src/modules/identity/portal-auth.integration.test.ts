import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, mock, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { registerOidcRoutes } from '../../http/auth-routes.ts'
import { registerLocalAuthRoutes } from '../../http/local-auth-routes.ts'
import { envelope, requireRequestIdentity, Router } from '../../http/router.ts'
import { IdentityAdministrationService } from './administration-service.ts'
import { OidcAuthService } from './auth-service.ts'
import { loadIdentityConfiguration, localIdentityConfiguration } from './config.ts'
import { LocalAuthService } from './local-auth-service.ts'
import { portalAuthenticator } from './portal-authenticator.ts'
import { hashOpaque, randomOpaque, SecretBox } from './secure-values.ts'
import { IdentitySessionRepository } from './session-repository.ts'
import type { ApiAudience, OidcIdentityConfiguration } from './types.ts'

let database: ThrowawayDatabase
let server: Server
let router: Router
let origin: string
let configuration: OidcIdentityConfiguration
let local: LocalAuthService
let oidc: OidcAuthService
let repository: IdentitySessionRepository
let upstreamUserId: string
let localUserId: string
let providerRequests = 0
let providerAvailable = true
const password = 'PortalPass12'

before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_portal_auth' })
  server = createServer((request, response) => {
    if (request.url?.startsWith('/fixture/')) {
      providerRequests++
      response.writeHead(providerAvailable ? 200 : 503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ issuer: `${origin}/fixture`, authorization_endpoint: `${origin}/fixture/authorize`, token_endpoint: `${origin}/fixture/token`, jwks_uri: `${origin}/fixture/jwks` }))
      return
    }
    void router.handle(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = server.address()
  assert.ok(endpoint && typeof endpoint !== 'string')
  origin = `http://localhost:${endpoint.port}`
  const settings = loadIdentityConfiguration({
    DSH_WORK_AUTH_MODE: 'oidc', DSH_WORK_SESSION_SECRET: 'portal-auth-test-secret-with-at-least-32-characters',
    AI_HUB_PLATFORM_URL: origin, AI_HUB_OIDC_ISSUER: `${origin}/fixture`,
    AI_HUB_APPLICATION_ID: 'portal-fixture', AI_HUB_CLIENT_ID: 'portal-fixture', AI_HUB_CLIENT_SECRET: 'portal-fixture-only',
    DSH_WORK_ADMIN_ORIGINS: origin, DSH_WORK_WORKBENCH_ORIGINS: origin,
    DSH_WORK_ADMIN_PORT: String(endpoint.port), DSH_WORK_WORKBENCH_PORT: String(endpoint.port),
  })
  assert.equal(settings.mode, 'oidc')
  configuration = settings
  local = new LocalAuthService(localIdentityConfiguration(configuration), database.client)
  repository = new IdentitySessionRepository(database.client)
  localUserId = (await local.bootstrap({ username: 'portal.admin@example.invalid', name: '合成独立管理员', password })).userId
  upstreamUserId = (await repository.synchronizeIdentity({ externalUserId: 'portal-upstream-admin', subject: 'portal-upstream-subject', displayName: '合成上游管理员', email: null, organizationName: '合成组织', businessUser: true, status: 'ACTIVE' })).userId
  await new IdentityAdministrationService(database.client, true).grantRole({ userId: upstreamUserId, roleId: 'role-platform-admin', actorId: localUserId })
})

beforeEach(async () => {
  mock.restoreAll()
  providerRequests = 0
  providerAvailable = true
  await database.client`delete from local_auth_rate_limits`
  oidc = new OidcAuthService(configuration, database.client)
  router = new Router({ authenticateApi: portalAuthenticator(local, oidc) })
  registerLocalAuthRoutes(router, local, oidc)
  registerOidcRoutes(router, oidc, local)
  for (const audience of ['admin', 'workbench'] as const) {
    router.get(`/api/${audience}/v1/session`, (_request, context) => envelope(audience, requireRequestIdentity(context, audience), 'postgres'))
  }
})

after(async () => {
  mock.restoreAll()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (database) await database.dispose()
})

async function call(path: string, options: { cookie?: string; body?: object; requestOrigin?: string; host?: string } = {}) {
  return fetch(`${origin}${path}`, {
    method: options.body ? 'POST' : 'GET', redirect: 'manual',
    headers: { Origin: options.requestOrigin ?? origin, ...(options.host ? { 'X-Forwarded-Host': options.host } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

function cookie(response: Response, name: string) {
  return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';')[0]
}

async function upstreamSession(audience: ApiAudience = 'admin') {
  const token = randomOpaque()
  const sessionHash = hashOpaque(token)
  const authorization = await repository.resolveAuthorization(upstreamUserId)
  await repository.createSession({ sessionHash, userId: upstreamUserId, audience,
    accessTokenEncrypted: new SecretBox(configuration.sessionSecret).seal('fixture-access-token'), refreshTokenEncrypted: null,
    tokenExpiresAt: new Date(Date.now() + 300_000), expiresAt: new Date(Date.now() + 300_000), authorizationVersion: authorization.authorizationVersion,
  })
  return { cookie: `${configuration.audiences[audience].sessionCookieName}=${token}`, sessionHash }
}

test('both portals open the password page without calling the configured OIDC provider', async () => {
  for (const audience of ['admin', 'workbench']) {
    const response = await call(`/auth/${audience}/login?return_to=${encodeURIComponent('/settings?view=profile#details')}`)
    assert.equal(response.status, 302)
    const location = new URL(response.headers.get('location')!)
    assert.equal(location.origin, origin)
    assert.equal(location.pathname, '/login')
    assert.equal(location.searchParams.get('return_to'), `${origin}/settings?view=profile#details`)
  }
  assert.equal(providerRequests, 0)
})

test('password login remains independent with AI Hub enabled and revokes the other identity cookie', async () => {
  const previous = await upstreamSession()
  providerAvailable = false
  const response = await call('/auth/admin/login', { cookie: previous.cookie, body: { username: 'portal.admin@example.invalid', password, returnTo: '/identity' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).location, `${origin}/identity`)
  const sessionCookie = cookie(response, 'dsh_work_local_admin_session')!
  assert.ok(sessionCookie)
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith('dsh_work_admin_session=') && value.includes('Max-Age=0')))
  assert.equal(await repository.findSession(previous.sessionHash, 'admin'), null)
  const current = await call('/api/admin/v1/session', { cookie: sessionCookie })
  assert.equal((await current.json()).data.identityProvider, 'local-password')
  assert.equal((await call('/api/workbench/v1/session', { cookie: sessionCookie })).status, 401)
  assert.equal(providerRequests, 0)
  assert.equal((await call('/auth/admin/login', { requestOrigin: 'https://evil.invalid', body: { username: 'portal.admin@example.invalid', password } })).status, 403)
})

test('password changes keep a fresh local session and clear stale AI Hub cookies without contacting the provider', async () => {
  const user = await local.createAccount({ username: 'portal.password@example.invalid', name: '合成改密管理员', password }, localUserId)
  await new IdentityAdministrationService(database.client, true).grantRole({ userId: user.userId, roleId: 'role-platform-admin', actorId: localUserId })
  const first = await call('/auth/admin/login', { body: { username: 'portal.password@example.invalid', password } })
  const firstCookie = cookie(first, 'dsh_work_local_admin_session')!
  const upstream = await upstreamSession()
  providerAvailable = false
  const changed = await call('/auth/admin/password', {
    cookie: `${firstCookie}; ${upstream.cookie}; dsh_work_admin_oidc_tx=stale-transaction`,
    body: { currentPassword: password, newPassword: 'PortalNew1!', returnTo: '/identity' },
  })
  assert.equal(changed.status, 200)
  assert.equal((await changed.json()).location, `${origin}/identity`)
  const nextCookie = cookie(changed, 'dsh_work_local_admin_session')!
  assert.ok(nextCookie)
  assert.notEqual(nextCookie, firstCookie)
  assert.ok(changed.headers.getSetCookie().some(value => value.startsWith('dsh_work_admin_session=') && value.includes('Max-Age=0')))
  assert.ok(changed.headers.getSetCookie().some(value => value.startsWith('dsh_work_admin_oidc_tx=') && value.includes('Max-Age=0')))
  const current = await call('/api/admin/v1/session', { cookie: nextCookie })
  assert.equal(current.status, 200)
  assert.equal((await current.json()).data.userId, user.userId)
  assert.equal((await call('/api/admin/v1/session', { cookie: firstCookie })).status, 401)
  assert.equal(await repository.findSession(upstream.sessionHash, 'admin'), null)
  assert.equal(providerRequests, 0)
})

test('API routing keeps providers separate and never falls back from ambiguous or expired credentials', async () => {
  const localLogin = await call('/auth/admin/login', { body: { username: 'portal.admin@example.invalid', password } })
  const localCookie = cookie(localLogin, 'dsh_work_local_admin_session')!
  const upstream = await upstreamSession()
  const identity = await call('/api/admin/v1/session', { cookie: upstream.cookie })
  assert.equal((await identity.json()).data.identityProvider, 'ai-hub-oidc')
  const ambiguous = await call('/api/admin/v1/session', { cookie: `${localCookie}; ${upstream.cookie}` })
  assert.equal(ambiguous.status, 401)
  assert.equal((await ambiguous.json()).error.code, 'ambiguous_session')
  assert.equal((await call('/api/admin/v1/session', { cookie: `dsh_work_local_admin_session=expired; ${upstream.cookie}` })).status, 401)
  assert.equal((await call('/api/admin/v1/session', { cookie: localCookie.replace('dsh_work_local_admin_session=', 'dsh_work_admin_session=') })).status, 401)
  assert.equal(providerRequests, 0)
})

test('explicit AI Hub entry keeps audience, return target and PKCE while rejecting unknown portals', async () => {
  const response = await call(`/auth/workbench/oidc/login?return_to=${encodeURIComponent('/settings?view=profile#details')}`)
  assert.equal(response.status, 302)
  const destination = new URL(response.headers.get('location')!)
  assert.equal(destination.pathname, '/fixture/authorize')
  assert.equal(destination.searchParams.get('redirect_uri'), `${origin}/auth/workbench/callback`)
  assert.equal(destination.searchParams.get('code_challenge_method'), 'S256')
  const transactionToken = cookie(response, 'dsh_work_oidc_tx')!.split('=')[1]!
  const transaction = await repository.consumeLoginTransaction(hashOpaque(transactionToken), 'workbench')
  assert.equal(transaction?.returnTo, `${origin}/settings?view=profile#details`)
  assert.equal(providerRequests, 1)
  assert.equal((await call('/auth/admin/oidc/login', { host: 'evil.invalid' })).status, 421)
  assert.equal(providerRequests, 1)
})

test('unavailable AI Hub returns to a recoverable local page with the original return target', async () => {
  providerAvailable = false
  const response = await call('/auth/admin/oidc/login?return_to=%2Fidentity')
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!)
  assert.equal(location.pathname, '/login')
  assert.equal(location.searchParams.get('provider'), 'ai-hub')
  assert.equal(location.searchParams.get('auth_error'), 'ai_hub_unavailable')
  assert.equal(location.searchParams.get('return_to'), `${origin}/identity`)
})

test('switching accounts keeps the local choice page and forces reauthentication after choosing AI Hub', async () => {
  const entry = await call('/auth/admin/switch-account?return_to=%2Fidentity')
  const location = new URL(entry.headers.get('location')!)
  assert.equal(location.pathname, '/login')
  assert.equal(location.searchParams.get('switch_account'), 'true')
  assert.equal(providerRequests, 0)
  const previous = await upstreamSession()
  const response = await call('/auth/admin/oidc/switch-account?return_to=%2Fidentity', { cookie: previous.cookie })
  assert.equal(response.status, 302)
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('prompt'), 'login')
  assert.equal(await repository.findSession(previous.sessionHash, 'admin'), null)
})

test('a successful OIDC callback removes the previous local session without mixing identities', async () => {
  const localLogin = await call('/auth/admin/login', { body: { username: 'portal.admin@example.invalid', password } })
  const localCookie = cookie(localLogin, 'dsh_work_local_admin_session')!
  const upstream = await upstreamSession()
  // Callback cookie handoff is under test; token verification has its own OIDC suite.
  mock.method(oidc, 'completeLogin', async () => ({ location: `${origin}/identity`, sessionCookie: `${upstream.cookie}; Path=/; HttpOnly`, clearTransactionCookie: oidc.clearTransactionCookie('admin') }))
  const response = await call('/auth/admin/callback?code=fixture&state=fixture', { cookie: `${localCookie}; dsh_work_admin_oidc_tx=fixture` })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), `${origin}/identity`)
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith('dsh_work_local_admin_session=') && value.includes('Max-Age=0')))
  assert.equal((await call('/api/admin/v1/session', { cookie: localCookie })).status, 401)
  assert.equal((await call('/api/admin/v1/session', { cookie: upstream.cookie })).status, 200)
})

test('password logout clears both browser identities locally, even when AI Hub is unavailable', async () => {
  const localLogin = await call('/auth/admin/login', { body: { username: 'portal.admin@example.invalid', password } })
  const localCookie = cookie(localLogin, 'dsh_work_local_admin_session')!
  const upstream = await upstreamSession()
  providerAvailable = false
  const response = await call('/auth/admin/logout', { cookie: `${localCookie}; ${upstream.cookie}`, body: {} })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).location, `${origin}/login`)
  assert.equal((await call('/api/admin/v1/session', { cookie: localCookie })).status, 401)
  assert.equal(await repository.findSession(upstream.sessionHash, 'admin'), null)
  assert.equal(providerRequests, 0)
})

test('AI Hub managed account status cannot be overridden through local account administration', async () => {
  // Retain a historical credential row to prove it cannot revive cross-provider login.
  const [credential] = await database.client`select password_hash from local_user_credentials where user_id = ${localUserId}`
  await database.client`insert into local_user_credentials (tenant_id, user_id, username, password_hash, must_change_password) values ('tenant-dsh-work', ${upstreamUserId}, 'bound.upstream', ${credential!.password_hash}, false)`
  await assert.rejects(local.resetPassword(upstreamUserId, password, localUserId), /尚未开通/)
  assert.equal((await call('/auth/admin/login', { body: { username: 'bound.upstream', password } })).status, 401)
  await assert.rejects(local.setStatus(upstreamUserId, 'disabled', localUserId), /企业身份平台/)
  await database.client`update users set status = 'disabled' where id = ${upstreamUserId}`
  try {
    await assert.rejects(local.setStatus(upstreamUserId, 'active', localUserId), /企业身份平台/)
    const response = await call('/auth/admin/login', { body: { username: 'bound.upstream', password } })
    assert.equal(response.status, 401)
  } finally {
    await database.client`update users set status = 'active' where id = ${upstreamUserId}`
  }
})
