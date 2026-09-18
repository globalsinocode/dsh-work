import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { loadIdentityConfiguration } from './config.ts'
import { OidcAuthService } from './auth-service.ts'
import { SecretBox } from './secure-values.ts'
import type { AuthenticationSessionRecord, LoginTransactionRecord } from './session-repository.ts'

const scope = 'platform.application.bootstrap'
function harness(input: { enabled?: boolean; consumed?: boolean; admin?: boolean; bootstrapToken?: boolean } = {}) {
  const configuration = loadIdentityConfiguration({ NODE_ENV: 'development', DSH_WORK_AUTH_MODE: 'oidc',
    DSH_WORK_ADMIN_BOOTSTRAP_ENABLED: input.enabled ? 'true' : 'false',
    DSH_WORK_SESSION_SECRET: 'test-only-session-key-at-least-32-characters', DSH_WORK_COOKIE_SECURE: 'false',
    AI_HUB_PLATFORM_URL: 'http://platform.localhost:8088', AI_HUB_APPLICATION_ID: 'test-app',
    AI_HUB_OIDC_ISSUER: 'http://issuer.localhost:8088', AI_HUB_CLIENT_ID: 'test-client', AI_HUB_CLIENT_SECRET: 'test-only-client-key',
    AI_HUB_WORKBENCH_PORTAL_URL: 'http://localhost:4174', AI_HUB_WORKBENCH_REDIRECT_URI: 'http://localhost:4190/auth/workbench/callback',
    AI_HUB_ADMIN_PORTAL_URL: 'http://localhost:4180', AI_HUB_ADMIN_REDIRECT_URI: 'http://localhost:4190/auth/admin/callback' })
  assert.equal(configuration.mode, 'oidc')
  const auth = new OidcAuthService(configuration, {} as DatabaseClient)
  const box = new SecretBox(configuration.sessionSecret)
  let pending: LoginTransactionRecord | null = null
  let consumed = input.consumed ?? true, admin = input.admin ?? true, claims = 0, sessions = 0
  const requested: string[][] = [], verifiedScopes: string[][] = []
  const scopes = ['ai_hub.identity', 'platform.me.read', ...(input.bootstrapToken ? [scope] : [])]
  const tokens = { accessToken: 'fixture-access', idToken: 'fixture-id', refreshToken: 'fixture-refresh', expiresIn: 3600 }
  const provider = {
    async createAuthorizationRequest(redirect: string, scopes: string[]) { requested.push(scopes); return {
      url: `http://issuer.localhost/authorize?redirect_uri=${encodeURIComponent(redirect)}`, state: 'state', nonce: 'nonce', codeVerifier: 'verifier' } },
    async exchangeCode() { return tokens }, async refresh() { return tokens },
    async verify(_token: string, options: { requiredScopes?: string[] }) {
      void _token
      if (options.requiredScopes) { verifiedScopes.push(options.requiredScopes)
        if (options.requiredScopes.some(required => !scopes.includes(required))) throw new Error('missing required scope') }
      return { subject: 'employee-subject', scopes, expiresAt: Date.now() / 1000 + 3600 }
    },
  }
  const session: AuthenticationSessionRecord = { sessionHash: 'fixture-hash', audience: 'admin', userId: 'employee-local',
    subject: 'employee-subject', accessTokenEncrypted: box.seal('fixture-access'), refreshTokenEncrypted: box.seal('fixture-refresh'),
    tokenExpiresAt: new Date(0), authorizationVersion: 1, currentAuthorizationVersion: 1, expiresAt: new Date(Date.now() + 3600000) }
  const repository = {
    async createLoginTransaction(transaction: LoginTransactionRecord) { pending = transaction },
    async consumeLoginTransaction() { const value = pending; pending = null; return value },
    async hasConsumedAdminBootstrap() { return consumed },
    async synchronizeIdentity() { return { userId: 'employee-local', authorizationVersion: 1 } },
    async resolveAuthorization() { return { permissions: admin ? ['admin:*'] : [], roleIds: [], dataScopes: [], authorizationVersion: 1,
      profile: { id: 'employee-local', name: 'synthetic' } } },
    async createSession() { sessions++ }, async appendAudit() {}, async touch() {}, async revoke() {},
    async findSession() { return session },
    async refreshTokensWithLock(_hash: string, _audience: string, update: (value: AuthenticationSessionRecord) => Promise<object>) {
      void _hash; void _audience; return { ...session, ...await update(session) }
    },
    async consumeAdminBootstrap() { if (consumed) return false; consumed = true; admin = true; return true },
  }
  const platform = {
    async me() { return { user_id: 'employee-external', subject: 'employee-subject', display_name: 'synthetic',
      status: 'ACTIVE', business_user: true, organization_name: 'fixture', email: null } },
    async claimAdminBootstrap() { claims++; return { application_id: 'test-app', environment: 'local',
      initial_admin_user_id: 'employee-external', claimed_user_id: 'employee-external', consumed_at: new Date().toISOString(), status: 'CONSUMED' } },
  }
  Object.assign(auth, { repository, platform, providers: { admin: provider, workbench: provider } })
  const request = (host = 'localhost:4180') => ({ method: 'GET', headers: { host, cookie: 'dsh_work_admin_session=fixture-cookie' }, socket: {} }) as IncomingMessage
  const complete = () => auth.completeLogin({ request: request('localhost:4190'), audience: 'admin', code: 'fixture-code', state: 'state', transactionToken: 'fixture' })
  return { auth, configuration, request, complete, requested, verifiedScopes, platform,
    consume: () => { consumed = true; admin = false }, counts: () => ({ claims, sessions }) }
}

test('C10 RED: normal admin login and refresh never request or require Bootstrap Scope', async () => {
  const h = harness()
  await h.auth.beginLogin(h.request(), 'admin', '/')
  assert.equal(h.requested[0]?.includes(scope), false)
  await h.complete()
  await h.auth.authenticateApi(h.request(), 'admin')
  assert.equal(h.verifiedScopes.some(scopes => scopes.includes(scope)), false)
  assert.equal(h.counts().claims, 0)
})
test('normal admin login with no local role never implicitly claims administrator', async () => {
  const h = harness({ consumed: false, admin: false, bootstrapToken: true, enabled: true })
  await h.auth.beginLogin(h.request(), 'admin', '/')
  await assert.rejects(h.complete(), { status: 403 })
  assert.equal(h.counts().claims, 0); assert.equal(h.counts().sessions, 0)
})

test('explicit fresh-install flow binds Bootstrap Scope to its single-use login transaction', async () => {
  const h = harness({ enabled: true, consumed: false, admin: false, bootstrapToken: true })
  await h.auth.beginBootstrapLogin(h.request(), '/')
  assert.equal(h.requested[0]?.includes(scope), true)
  await h.complete()
  assert.equal(h.counts().claims, 1); assert.equal(h.counts().sessions, 1)
  await assert.rejects(h.complete(), { status: 401, code: 'invalid_state' })
})
test('bootstrap is disabled by default and remains closed after all local admin roles are removed', async () => {
  const disabled = harness({ consumed: false, admin: false, bootstrapToken: true })
  await assert.rejects(disabled.auth.beginBootstrapLogin(disabled.request(), '/'), { code: 'admin_bootstrap_closed' })
  const closed = harness({ enabled: true, consumed: true, admin: false, bootstrapToken: true })
  await assert.rejects(closed.auth.beginBootstrapLogin(closed.request(), '/'), { code: 'admin_bootstrap_closed' })
  assert.equal(closed.counts().claims, 0)
})
test('a pending bootstrap transaction cannot claim again after another request consumes initialization', async () => {
  const h = harness({ enabled: true, consumed: false, admin: false, bootstrapToken: true })
  await h.auth.beginBootstrapLogin(h.request(), '/')
  h.consume()
  await assert.rejects(h.complete(), { code: 'admin_bootstrap_closed' })
  assert.equal(h.counts().claims, 0)
})
test('bootstrap token must carry the scope and response must match the registered user/application/environment', async () => {
  const missing = harness({ enabled: true, consumed: false, admin: false })
  await missing.auth.beginBootstrapLogin(missing.request(), '/')
  await assert.rejects(missing.complete())
  assert.equal(missing.counts().claims, 0)
  for (const field of ['application_id', 'environment', 'initial_admin_user_id', 'claimed_user_id'] as const) {
    const h = harness({ enabled: true, consumed: false, admin: false, bootstrapToken: true })
    const claim = h.platform.claimAdminBootstrap.bind(h.platform)
    h.platform.claimAdminBootstrap = async () => ({ ...await claim(), [field]: 'incorrect' })
    await h.auth.beginBootstrapLogin(h.request(), '/')
    await assert.rejects(h.complete(), { code: 'invalid_admin_bootstrap' })
    assert.equal(h.counts().sessions, 0)
  }
})
