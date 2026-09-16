import assert from 'node:assert/strict'
import {
  generateKeyPairSync,
  sign as signPayload,
  type JsonWebKey,
} from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { test } from 'node:test'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { loadIdentityConfiguration } from './config.ts'
import { OidcAuthService } from './auth-service.ts'
import { AiHubClient } from './ai-hub-client.ts'
import { IdentitySessionRepository, type LoginTransactionRecord } from './session-repository.ts'
import { IdentityDirectorySyncService } from './directory-sync-service.ts'
import { OidcProtocolError, OidcProviderClient } from './oidc-client.ts'
import { assertApiRouteAccess } from '../../http/router.ts'
import { LOCAL_PERMISSIONS, type RequestIdentity } from './types.ts'
import { SecretBox, equalOpaqueHash, hashOpaque, randomOpaque } from './secure-values.ts'

test('OIDC configuration uses one AI Hub credential for both portals', () => {
  const configuration = loadIdentityConfiguration(baseEnvironment())
  assert.equal(configuration.mode, 'oidc')
  assert.equal(configuration.audiences.workbench.clientId, 'dsh-work__local__v1')
  assert.equal(configuration.audiences.admin.clientId, 'dsh-work__local__v1')
  assert.equal(configuration.audiences.workbench.tokenAudience, 'dsh-work__local__v1')
  assert.equal(configuration.applicationId, 'dsh-work')
  assert.equal(configuration.environment, 'local')
  assert.equal(configuration.directorySyncIntervalSeconds, 900)
  assert.deepEqual(configuration.audiences.workbench.allowedOrigins, ['http://localhost:4174'])
  assert.equal(configuration.audiences.workbench.defaultOrigin, 'http://localhost:4174')
  assert.equal(
    configuration.audiences.workbench.redirectUriByOrigin['http://localhost:4174'],
    'http://localhost:4190/auth/workbench/callback',
  )
  assert.deepEqual(configuration.audiences.workbench.loginScopes, [
    'openid', 'profile', 'email', 'offline_access', 'ai_hub.identity', 'platform.me.read',
  ])
  assert.ok(configuration.audiences.admin.loginScopes.includes('platform.application.bootstrap'))
})

test('OIDC configuration rejects a separate admin application credential', () => {
  const environment = baseEnvironment()
  environment.AI_HUB_ADMIN_CLIENT_ID = 'dsh-work-admin__local__v1'
  environment.AI_HUB_ADMIN_CLIENT_SECRET = 'admin-client-secret-with-at-least-32-characters'
  environment.AI_HUB_ADMIN_OIDC_ISSUER = 'http://auth.localhost:8088/application/o/dsh-work-admin/'
  assert.throws(
    () => loadIdentityConfiguration(environment),
    /必须共用同一个 AI Hub 应用环境凭据/,
  )
})

test('OIDC configuration supports multiple exact origins and derives matching callbacks', () => {
  const environment = baseEnvironment()
  delete environment.AI_HUB_WORKBENCH_PORTAL_URL
  delete environment.AI_HUB_WORKBENCH_REDIRECT_URI
  delete environment.AI_HUB_ADMIN_PORTAL_URL
  delete environment.AI_HUB_ADMIN_REDIRECT_URI
  Object.assign(environment, {
    DSH_WORK_WORKBENCH_ORIGINS: 'http://192.168.1.99:4174,http://work.internal:4174',
    DSH_WORK_ADMIN_ORIGINS: 'http://192.168.1.99:4180,http://work.internal:4180',
    DSH_WORK_WORKBENCH_DEFAULT_ORIGIN: 'http://work.internal:4174',
    DSH_WORK_ADMIN_DEFAULT_ORIGIN: 'http://work.internal:4180',
  })

  const configuration = loadIdentityConfiguration(environment)
  assert.equal(configuration.mode, 'oidc')
  assert.deepEqual(configuration.audiences.workbench.allowedOrigins, [
    'http://192.168.1.99:4174',
    'http://work.internal:4174',
  ])
  assert.equal(configuration.audiences.workbench.defaultOrigin, 'http://work.internal:4174')
  assert.equal(
    configuration.audiences.workbench.redirectUriByOrigin['http://192.168.1.99:4174'],
    'http://192.168.1.99:4174/auth/workbench/callback',
  )
})

test('OIDC configuration rejects duplicate, wrong-port, and conflicting origins', () => {
  const duplicate = baseEnvironment()
  duplicate.DSH_WORK_WORKBENCH_ORIGINS = 'http://localhost:4174,http://localhost:4174'
  assert.throws(() => loadIdentityConfiguration(duplicate), /重复 Origin/)

  const wrongPort = baseEnvironment()
  delete wrongPort.AI_HUB_WORKBENCH_PORTAL_URL
  delete wrongPort.AI_HUB_WORKBENCH_REDIRECT_URI
  wrongPort.DSH_WORK_WORKBENCH_ORIGINS = 'http://localhost:9999'
  assert.throws(() => loadIdentityConfiguration(wrongPort), /必须使用端口 4174/)

  const conflictingLegacy = baseEnvironment()
  conflictingLegacy.DSH_WORK_WORKBENCH_ORIGINS = 'http://work.internal:4174'
  assert.throws(() => loadIdentityConfiguration(conflictingLegacy), /含义不一致/)

  const publicIp = baseEnvironment()
  delete publicIp.AI_HUB_WORKBENCH_PORTAL_URL
  delete publicIp.AI_HUB_WORKBENCH_REDIRECT_URI
  publicIp.DSH_WORK_WORKBENCH_ORIGINS = 'http://203.0.113.10:4174'
  assert.throws(() => loadIdentityConfiguration(publicIp), /RFC1918/)
})

test('directory scheduler reconciles immediately before waiting for the interval', async () => {
  const configuration = loadIdentityConfiguration(baseEnvironment())
  if (configuration.mode !== 'oidc') assert.fail('expected OIDC configuration')
  const directory = new IdentityDirectorySyncService(configuration, {} as DatabaseClient)
  let synchronizationCalls = 0
  directory.synchronize = (async () => {
    synchronizationCalls += 1
    return {} as Awaited<ReturnType<typeof directory.synchronize>>
  }) as typeof directory.synchronize

  const timer = directory.startScheduler()
  await new Promise(resolve => setImmediate(resolve))
  if (timer) clearInterval(timer)

  assert.ok(timer)
  assert.equal(synchronizationCalls, 1)

  const oneShot = new IdentityDirectorySyncService(
    { ...configuration, directorySyncIntervalSeconds: 0 },
    {} as DatabaseClient,
  )
  let oneShotCalls = 0
  oneShot.synchronize = (async () => {
    oneShotCalls += 1
    return {} as Awaited<ReturnType<typeof oneShot.synchronize>>
  }) as typeof oneShot.synchronize
  const disabledTimer = oneShot.startScheduler()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disabledTimer, null)
  assert.equal(oneShotCalls, 1)
})

test('OIDC errors redirect to frontend routes outside the backend auth proxy', () => {
  const configuration = loadIdentityConfiguration(baseEnvironment())
  if (configuration.mode !== 'oidc') assert.fail('expected OIDC configuration')
  const authentication = new OidcAuthService(configuration, {} as DatabaseClient)

  assert.equal(
    authentication.errorRedirect(requestFor('localhost:4174'), 'workbench', 'invalid_callback'),
    'http://localhost:4174/login-error?code=invalid_callback',
  )
  assert.equal(
    authentication.errorRedirect(requestFor('localhost:4180'), 'admin', 'access_denied'),
    'http://localhost:4180/login-error?code=access_denied',
  )
})

test('OIDC redirects trust only a forwarded Origin from the exact allowlist', () => {
  const environment = baseEnvironment()
  delete environment.AI_HUB_WORKBENCH_PORTAL_URL
  delete environment.AI_HUB_WORKBENCH_REDIRECT_URI
  environment.DSH_WORK_WORKBENCH_ORIGINS = 'http://192.168.1.99:4174,http://work.internal:4174'
  const configuration = loadIdentityConfiguration(environment)
  if (configuration.mode !== 'oidc') assert.fail('expected OIDC configuration')
  const authentication = new OidcAuthService(configuration, {} as DatabaseClient)

  const forwarded = requestFor('127.0.0.1:4190', {
    'x-forwarded-proto': 'http',
    'x-forwarded-host': 'work.internal:4174',
  })
  assert.equal(
    authentication.errorRedirect(forwarded, 'workbench', 'invalid_callback'),
    'http://work.internal:4174/login-error?code=invalid_callback',
  )
  assert.throws(
    () => authentication.errorRedirect(requestFor('unknown.internal:4174'), 'workbench', 'invalid_callback'),
    /不在允许列表/,
  )
})

test('local SSO rejects platform accounts then accepts employees through each legacy callback', async (context) => {
  const configuration = loadIdentityConfiguration(baseEnvironment())
  if (configuration.mode !== 'oidc') assert.fail('expected OIDC configuration')
  const authentication = new OidcAuthService(configuration, {} as DatabaseClient)
  let pending: LoginTransactionRecord | null = null
  context.mock.method(IdentitySessionRepository.prototype, 'createLoginTransaction', async (
    input: Parameters<IdentitySessionRepository['createLoginTransaction']>[0],
  ) => {
    pending = input
  })
  context.mock.method(IdentitySessionRepository.prototype, 'consumeLoginTransaction', async () => pending)
  const authorizationRequest = context.mock.method(OidcProviderClient.prototype, 'createAuthorizationRequest', async (redirectUri: string) => ({
    url: `https://issuer.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
    state: 'login-state', nonce: 'login-nonce', codeVerifier: 'login-verifier',
  }))
  const exchange = context.mock.method(OidcProviderClient.prototype, 'exchangeCode', async () => ({
    accessToken: 'access-token', idToken: 'id-token', refreshToken: null, expiresIn: 3600, scope: 'openid',
  }))
  context.mock.method(OidcProviderClient.prototype, 'verify', async () => ({
    subject: 'employee', issuer: configuration.audiences.workbench.issuer,
    audiences: ['dsh-work__local__v1'], expiresAt: Date.now() / 1000 + 3600,
    issuedAt: Date.now() / 1000, scopes: ['openid'], actorType: 'user',
    authorizationVersion: 1, displayName: 'Employee', email: null, claims: {},
  }))
  let businessUser = false
  context.mock.method(IdentitySessionRepository.prototype, 'appendAudit', async () => {})
  context.mock.method(AiHubClient.prototype, 'me', async () => ({
    user_id: 'employee', subject: 'employee', display_name: 'Employee', email: null,
    status: 'ACTIVE', organization_id: 'org', organization_name: 'Company',
    business_user: businessUser, authorization_version: 1,
  }))
  context.mock.method(IdentitySessionRepository.prototype, 'synchronizeIdentity', async () => ({
    userId: 'employee', authorizationVersion: 1,
  }))
  context.mock.method(IdentitySessionRepository.prototype, 'resolveAuthorization', async () => ({
    profile: adminIdentity([]).profile, roleIds: [], roleCodes: [], dataScopes: [],
    permissions: [LOCAL_PERMISSIONS.workbenchUse, LOCAL_PERMISSIONS.adminAll], authorizationVersion: 1,
  }))
  const createSession = context.mock.method(IdentitySessionRepository.prototype, 'createSession', async () => {})

  for (const [audience, port] of [['workbench', 4174], ['admin', 4180]] as const) {
    const origin = `http://localhost:${port}`
    const callback = `http://localhost:4190/auth/${audience}/callback`
    const login = await authentication.beginLogin(requestFor(`localhost:${port}`), audience, '/home')
    assert.equal(new URL(login.location).searchParams.get('redirect_uri'), callback)
    businessUser = false
    const sessionCount = createSession.mock.callCount()
    await assert.rejects(authentication.completeLogin({
      request: requestFor('localhost:4190'), audience, code: 'code',
      state: 'login-state', transactionToken: 'transaction-cookie',
    }), { code: 'business_user_required', status: 403 })
    assert.equal(createSession.mock.callCount(), sessionCount)
    businessUser = true
    const switched = await authentication.switchAccount(requestFor(`localhost:${port}`), audience, '/home')
    assert.match(switched.clearSessionCookie, /Max-Age=0/)
    assert.equal(authorizationRequest.mock.calls.at(-1)?.arguments[2], true)
    const result = await authentication.completeLogin({
      request: requestFor('localhost:4190'), audience, code: 'code',
      state: 'login-state', transactionToken: 'transaction-cookie',
    })
    assert.equal(result.location, `${origin}/home`)
    assert.match(result.sessionCookie, /_session=/)
    assert.deepEqual(exchange.mock.calls.at(-1)?.arguments, ['code', callback, 'login-verifier'])
    assert.equal(authentication.errorRedirect(requestFor('localhost:4190'), audience, 'denied'),
      `${origin}/login-error?code=denied`)
  }
  assert.equal(createSession.mock.callCount(), 2)
  await assert.rejects(authentication.beginLogin(requestFor('localhost:4190'), 'workbench', null),
    /不在允许列表/)
  assert.throws(() => authentication.errorRedirect(requestFor('localhost:4191'), 'workbench', 'denied'),
    /不在允许列表/)
})

test('account switching without a local session logs out of OIDC and returns to the same portal', async (context) => {
  const configuration = loadIdentityConfiguration(baseEnvironment())
  if (configuration.mode !== 'oidc') assert.fail('expected OIDC configuration')
  const authentication = new OidcAuthService(configuration, {} as DatabaseClient)
  const logout = context.mock.method(OidcProviderClient.prototype, 'logoutUrl', async (origin: string) =>
    `https://identity.example/end-session/?post_logout_redirect_uri=${encodeURIComponent(origin)}`)
  const localLogout = context.mock.method(IdentitySessionRepository.prototype, 'logoutSession', async () => {})
  for (const [audience, port] of [['workbench', 4174], ['admin', 4180]] as const) {
    const origin = `http://localhost:${port}`
    const result = await authentication.logout(requestFor(`localhost:${port}`), audience)
    assert.equal(new URL(result.location).searchParams.get('post_logout_redirect_uri'), origin)
    assert.match(result.clearSessionCookie, /Max-Age=0/)
    assert.equal(authentication.errorRedirect(requestFor('localhost:4190'), audience, 'business_user_required'),
      `${origin}/login-error?code=business_user_required`)
  }
  assert.equal(logout.mock.callCount(), 2)
  assert.equal(localLogout.mock.callCount(), 0)
})

test('multi-origin callbacks cannot switch away from the transaction origin', async (context) => {
  const environment = baseEnvironment()
  delete environment.AI_HUB_WORKBENCH_PORTAL_URL
  delete environment.AI_HUB_WORKBENCH_REDIRECT_URI
  environment.DSH_WORK_WORKBENCH_ORIGINS = 'http://192.168.1.99:4174,http://192.168.101.20:4174'
  const configuration = loadIdentityConfiguration(environment)
  if (configuration.mode !== 'oidc') assert.fail('expected OIDC configuration')
  const authentication = new OidcAuthService(configuration, {} as DatabaseClient)
  context.mock.method(IdentitySessionRepository.prototype, 'consumeLoginTransaction', async () => ({
    stateHash: hashOpaque('state'), codeVerifierEncrypted: '', nonce: '', returnTo: '/',
    portalOrigin: 'http://192.168.1.99:4174',
    redirectUri: 'http://192.168.1.99:4174/auth/workbench/callback',
  }))
  await assert.rejects(authentication.completeLogin({
    request: requestFor('192.168.101.20:4174'), audience: 'workbench',
    code: 'code', state: 'state', transactionToken: 'cookie',
  }), /回调入口与登录入口不一致/)
  assert.throws(() => authentication.errorRedirect(requestFor('localhost:4190'), 'workbench', 'denied'),
    /不在允许列表/)
})

test('production OIDC configuration rejects insecure URLs, cookies, and placeholder secrets', () => {
  assert.throws(
    () => loadIdentityConfiguration({ ...baseEnvironment(), NODE_ENV: 'production' }),
    /Secure Session Cookie|https/,
  )

  const production = baseEnvironment()
  Object.assign(production, {
    NODE_ENV: 'production',
    DSH_WORK_COOKIE_SECURE: 'true',
    AI_HUB_PLATFORM_URL: 'https://platform.example.internal',
    AI_HUB_OIDC_ISSUER: 'https://auth.example.internal/application/o/dsh-work/',
    AI_HUB_WORKBENCH_REDIRECT_URI: 'https://work.example.internal/auth/workbench/callback',
    AI_HUB_WORKBENCH_PORTAL_URL: 'https://work.example.internal',
    AI_HUB_ADMIN_REDIRECT_URI: 'https://admin.example.internal/auth/admin/callback',
    AI_HUB_ADMIN_PORTAL_URL: 'https://admin.example.internal',
    DSH_WORK_SESSION_SECRET: 'replace-me-with-at-least-32-random-characters',
  })
  assert.throws(() => loadIdentityConfiguration(production), /占位值/)

  production.DSH_WORK_SESSION_SECRET = 'a-production-session-secret-with-strong-random-material'
  production.DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS = '0'
  assert.throws(
    () => loadIdentityConfiguration(production),
    /不能关闭 AI Hub 员工目录同步/,
  )

  production.DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS = '-1'
  assert.throws(
    () => loadIdentityConfiguration(production),
    /必须是非负整数/,
  )
})

test('admin API read permissions are enforced per route', () => {
  const auditIdentity = adminIdentity([LOCAL_PERMISSIONS.auditRead])
  assert.doesNotThrow(() => assertApiRouteAccess(
    auditIdentity,
    '/api/admin/v1/audit-events',
    'GET',
  ))
  assert.throws(
    () => assertApiRouteAccess(auditIdentity, '/api/admin/v1/agents', 'GET'),
    /管理读取权限/,
  )

  const adminReadIdentity = adminIdentity([LOCAL_PERMISSIONS.adminRead])
  assert.doesNotThrow(() => assertApiRouteAccess(
    adminReadIdentity,
    '/api/admin/v1/agents',
    'GET',
  ))
  assert.throws(
    () => assertApiRouteAccess(adminReadIdentity, '/api/admin/v1/operations/summary', 'GET'),
    /审计读取权限/,
  )
  assert.throws(
    () => assertApiRouteAccess(adminReadIdentity, '/api/admin/v1/agents', 'POST'),
    /管理写权限/,
  )
})

test('business permissions remain local and are not AI Hub application permissions', () => {
  assert.deepEqual(Object.values(LOCAL_PERMISSIONS), [
    'workbench:use', 'workbench:manage', 'admin:*', 'admin:read', 'admin:write', 'audit:read',
  ])
  assert.equal(Object.values(LOCAL_PERMISSIONS).some(permission => permission.startsWith('dsh_work.')), false)
})

test('opaque values are hashed and encrypted session values fail closed on tampering', () => {
  const opaque = randomOpaque()
  assert.ok(opaque.length >= 32)
  assert.equal(equalOpaqueHash(opaque, hashOpaque(opaque)), true)
  assert.equal(equalOpaqueHash(`${opaque}x`, hashOpaque(opaque)), false)

  const box = new SecretBox('a-random-session-secret-with-more-than-32-characters')
  const sealed = box.seal('sensitive-refresh-token')
  assert.equal(box.open(sealed), 'sensitive-refresh-token')
  const segments = sealed.split('.')
  const ciphertext = segments[3] ?? ''
  segments[3] = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`
  assert.throws(() => box.open(segments.join('.')))
})

test('OIDC client builds PKCE requests, verifies RS256 claims, and authenticates token exchange', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey & { kid?: string; alg?: string; use?: string }
  Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' })
  let issuer = ''
  let tokenAuthorization = ''
  const tokenBodies: string[] = []
  const server = createServer((request, response) => {
    if (request.url === '/application/o/dsh-work/.well-known/openid-configuration') {
      json(response, {
        issuer,
        authorization_endpoint: `${issuer}authorize/`,
        token_endpoint: `${issuer}token/`,
        jwks_uri: `${issuer}jwks/`,
        end_session_endpoint: `${issuer}end-session/`,
      })
      return
    }
    if (request.url === '/application/o/dsh-work/jwks/') {
      json(response, { keys: [jwk] })
      return
    }
    if (request.url === '/application/o/dsh-work/token/' && request.method === 'POST') {
      tokenAuthorization = String(request.headers.authorization ?? '')
      request.setEncoding('utf8')
      let tokenBody = ''
      request.on('data', chunk => { tokenBody += String(chunk) })
      request.on('end', () => json(response, {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        id_token: 'id-token',
        expires_in: 300,
        scope: 'openid ai_hub.identity platform.me.read',
      }))
      request.on('end', () => { tokenBodies.push(tokenBody) })
      return
    }
    response.writeHead(404).end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no port')
    issuer = `http://127.0.0.1:${address.port}/application/o/dsh-work/`
    const client = new OidcProviderClient({
      issuer,
      clientId: 'dsh-work__local__v1',
      clientSecret: 'test-client-secret',
      expectedAudience: 'dsh-work__local__v1',
      cacheTtlSeconds: 60,
      staleTtlSeconds: 120,
    })

    const authorization = await client.createAuthorizationRequest(
      'http://localhost:4190/auth/workbench/callback',
      ['openid', 'ai_hub.identity', 'platform.me.read'],
    )
    const authorizationUrl = new URL(authorization.url)
    assert.equal(authorizationUrl.searchParams.get('response_type'), 'code')
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorizationUrl.searchParams.get('state'), authorization.state)
    assert.equal(authorizationUrl.searchParams.get('nonce'), authorization.nonce)
    assert.ok((authorizationUrl.searchParams.get('code_challenge') ?? '').length >= 43)

    assert.equal(authorizationUrl.searchParams.has('prompt'), false)
    const switching = new URL((await client.createAuthorizationRequest(
      'http://localhost:4190/auth/workbench/callback', ['openid'], true,
    )).url)
    assert.equal(switching.searchParams.get('prompt'), 'login')
    assert.equal(switching.searchParams.get('redirect_uri'), 'http://localhost:4190/auth/workbench/callback')
    assert.notEqual(switching.searchParams.get('state'), authorization.state)

    const now = Math.floor(Date.now() / 1000)
    const token = signedJwt(privateKey, {
      iss: issuer,
      aud: 'dsh-work__local__v1',
      sub: 'ai-hub-user',
      exp: now + 300,
      iat: now,
      scope: 'openid ai_hub.identity platform.me.read',
      actor_type: 'user',
      authorization_version: 7,
      nonce: authorization.nonce,
    })
    const verified = await client.verify(token, {
      requiredScopes: ['ai_hub.identity', 'platform.me.read'],
      expectedNonce: authorization.nonce,
      requireAiHubUser: true,
    })
    assert.equal(verified.subject, 'ai-hub-user')
    assert.equal(verified.authorizationVersion, 7)

    await client.verify(token, { expectedAudience: 'dsh-work__local__v1' })
    await assert.rejects(
      client.verify(token, { expectedAudience: 'platform-api' }),
      (error: unknown) => error instanceof OidcProtocolError && error.code === 'invalid_audience',
    )

    await assert.rejects(
      client.verify(token, { expectedNonce: 'wrong-nonce' }),
      (error: unknown) => error instanceof OidcProtocolError && error.code === 'invalid_nonce',
    )

    const tokens = await client.exchangeCode(
      'authorization-code',
      'http://localhost:4190/auth/workbench/callback',
      authorization.codeVerifier,
    )
    assert.equal(tokens.refreshToken, 'refresh-token')
    assert.equal(
      tokenAuthorization,
      `Basic ${Buffer.from('dsh-work__local__v1:test-client-secret').toString('base64')}`,
    )
    const submitted = new URLSearchParams(tokenBodies[0])
    assert.equal(submitted.get('grant_type'), 'authorization_code')
    assert.equal(submitted.get('code_verifier'), authorization.codeVerifier)

    await client.clientCredentials(['ai_hub.identity', 'platform.directory.read'])
    const serviceRequest = new URLSearchParams(tokenBodies[1])
    assert.equal(serviceRequest.get('grant_type'), 'client_credentials')
    assert.equal(serviceRequest.get('scope'), 'ai_hub.identity platform.directory.read')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    DSH_WORK_AUTH_MODE: 'oidc',
    DSH_WORK_SESSION_SECRET: 'local-session-secret-with-at-least-32-characters',
    DSH_WORK_COOKIE_SECURE: 'false',
    AI_HUB_PLATFORM_URL: 'http://platform.localhost:8088',
    AI_HUB_APPLICATION_ID: 'dsh-work',
    AI_HUB_OIDC_ISSUER: 'http://auth.localhost:8088/application/o/ai-hub-dsh-work-local-v1/',
    AI_HUB_CLIENT_ID: 'dsh-work__local__v1',
    AI_HUB_CLIENT_SECRET: 'local-client-secret-with-at-least-32-characters',
    AI_HUB_WORKBENCH_REDIRECT_URI: 'http://localhost:4190/auth/workbench/callback',
    AI_HUB_WORKBENCH_PORTAL_URL: 'http://localhost:4174',
    AI_HUB_ADMIN_REDIRECT_URI: 'http://localhost:4190/auth/admin/callback',
    AI_HUB_ADMIN_PORTAL_URL: 'http://localhost:4180',
  }
}

function requestFor(
  host: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  return {
    headers: { host, ...headers },
    socket: {},
  } as IncomingMessage
}

function adminIdentity(permissions: string[]): RequestIdentity {
  return {
    audience: 'admin',
    applicationId: 'dsh-work',
    sessionHash: 'test-session',
    userId: 'user-test',
    subject: 'subject-test',
    profile: {
      id: 'user-test',
      name: '测试用户',
      title: '测试角色',
      department: '测试部门',
      avatarText: '测',
      role: 'auditor',
      dataScopes: [],
    },
    roleIds: ['role-auditor'],
    permissions,
    dataScopes: [],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  }
}

function signedJwt(privateKey: Parameters<typeof signPayload>[2], claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = signPayload('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

function json(response: import('node:http').ServerResponse, body: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
