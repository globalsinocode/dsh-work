import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  assertJwtAccessToken,
  assertOAuthEndpointScheme,
  assertOAuthTokenEndpointReachable,
  authorizationUrl,
  createPkce,
  exchangeAuthorizationCode,
  normalizeOAuthDiscoveryEndpoint,
} from './mcp-oauth.ts'

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

test('normalizeOAuthDiscoveryEndpoint fixes mistaken /api/oauth paths for data-hub', () => {
  assert.equal(
    normalizeOAuthDiscoveryEndpoint('http://localhost:5175/api/oauth/authorize', 'authorize'),
    'http://localhost:5175/oauth/authorize',
  )
  assert.equal(
    normalizeOAuthDiscoveryEndpoint('http://localhost:3005/api/oauth/token', 'token'),
    'http://localhost:3005/oauth/token',
  )
  assert.equal(
    normalizeOAuthDiscoveryEndpoint('http://192.168.0.248:5175/oauth/authorize', 'authorize'),
    'http://192.168.0.248:5175/oauth/authorize',
  )
})

test('authorizationUrl uses corrected authorize endpoint', () => {
  const url = authorizationUrl({
    authorizationEndpoint: 'http://localhost:5175/api/oauth/authorize',
    clientId: 'c',
    redirectUri: 'https://localhost/cb',
    scopes: ['mcp:read'],
    resource: 'http://localhost:3005/mcp',
    state: 's',
    codeChallenge: 'ch',
  })
  assert.equal(url.pathname, '/oauth/authorize')
})

test('createPkce challenge matches S256 of verifier', () => {
  const { verifier, challenge } = createPkce()
  const expected = createHash('sha256').update(verifier, 'utf8').digest('base64url')
  assert.equal(challenge, expected)
  assert.ok(verifier.length >= 43)
})

test('authorizationUrl allows http localhost for dev', () => {
  const url = authorizationUrl({
    authorizationEndpoint: 'http://localhost:5175/oauth/authorize',
    clientId: 'client-dev',
    redirectUri: 'http://localhost:4174/api/workbench/v1/mcp-grants/callback',
    scopes: ['mcp:read'],
    resource: 'http://localhost:3005/mcp',
    state: 'state-dev',
    codeChallenge: 'challenge-dev',
  })
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, 'localhost')
  assert.equal(url.searchParams.get('scope'), 'mcp:read')
})

test('assertOAuthEndpointScheme allows http on LAN hosts', () => {
  assert.ok(assertOAuthEndpointScheme('http://192.168.1.10:8085/oauth/authorize', '授权端点'))
  assert.ok(assertOAuthEndpointScheme('http://host.docker.internal:3005/oauth/token', '令牌端点'))
  assert.throws(
    () => assertOAuthEndpointScheme('ftp://idp.example/oauth/token', '令牌端点'),
    /http 或 https/i,
  )
})

test('authorizationUrl keeps registered endpoint host and allows plain http', () => {
  const registered = 'https://auth.example.com/oauth/authorize?tenant=acme'
  const url = authorizationUrl({
    authorizationEndpoint: registered,
    clientId: 'client-1',
    redirectUri: 'https://portal.evil.example/callback',
    scopes: ['mcp:tools', 'offline'],
    resource: 'https://mcp.example.com/mcp',
    state: 'state-abc',
    codeChallenge: 'challenge-xyz',
  })

  assert.equal(url.origin, 'https://auth.example.com')
  assert.equal(url.pathname, '/oauth/authorize')
  assert.equal(url.searchParams.get('tenant'), 'acme')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-xyz')
  assert.equal(url.searchParams.get('client_id'), 'client-1')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://portal.evil.example/callback')
  assert.equal(url.searchParams.get('scope'), 'mcp:tools offline')
  assert.equal(url.searchParams.get('resource'), 'https://mcp.example.com/mcp')
  assert.equal(url.searchParams.get('state'), 'state-abc')

  const httpUrl = authorizationUrl({
    authorizationEndpoint: 'http://192.168.0.8:8085/oauth/authorize',
    clientId: 'c',
    redirectUri: 'https://portal/cb',
    scopes: ['s'],
    resource: 'http://192.168.0.8:8085/mcp',
    state: 'st',
    codeChallenge: 'ch',
  })
  assert.equal(httpUrl.protocol, 'http:')
  assert.equal(httpUrl.hostname, '192.168.0.8')
})

test('assertJwtAccessToken validates aud, iss origin, and exp', () => {
  const resource = 'https://mcp.example.com/mcp'
  const authorizationEndpoint = 'https://auth.example.com/oauth/authorize'
  const now = new Date('2026-01-15T12:00:00.000Z')

  const valid = unsignedJwt({
    aud: resource,
    iss: 'https://auth.example.com/',
    exp: Math.floor(now.getTime() / 1000) + 300,
  })
  assert.doesNotThrow(() => assertJwtAccessToken(valid, { resource, authorizationEndpoint, now }))

  const audArray = unsignedJwt({
    aud: ['other', resource],
    iss: 'https://auth.example.com/token',
    exp: Math.floor(now.getTime() / 1000) + 60,
  })
  assert.doesNotThrow(() => assertJwtAccessToken(audArray, { resource, authorizationEndpoint, now }))

  const wrongAud = unsignedJwt({
    aud: 'https://other.example/resource',
    iss: 'https://auth.example.com/',
    exp: Math.floor(now.getTime() / 1000) + 300,
  })
  assert.throws(
    () => assertJwtAccessToken(wrongAud, { resource, authorizationEndpoint, now }),
    /用户令牌受众或签发方不匹配/,
  )

  const wrongIss = unsignedJwt({
    aud: resource,
    iss: 'https://evil.example.com/',
    exp: Math.floor(now.getTime() / 1000) + 300,
  })
  assert.throws(
    () => assertJwtAccessToken(wrongIss, { resource, authorizationEndpoint, now }),
    /用户令牌受众或签发方不匹配/,
  )

  const expired = unsignedJwt({
    aud: resource,
    iss: 'https://auth.example.com/',
    exp: Math.floor(now.getTime() / 1000) - 1,
  })
  assert.throws(
    () => assertJwtAccessToken(expired, { resource, authorizationEndpoint, now }),
    /用户令牌受众或签发方不匹配/,
  )
})

test('assertJwtAccessToken ignores opaque non-JWT strings', () => {
  assert.doesNotThrow(() => assertJwtAccessToken('opaque-access-token-value', {
    resource: 'https://mcp.example.com/mcp',
    authorizationEndpoint: 'https://auth.example.com/authorize',
  }))
})

test('exchangeAuthorizationCode posts secrets in body and validates JWT access token', async () => {
  const resource = 'https://mcp.example.com/mcp'
  const tokenEndpoint = 'https://auth.example.com/oauth/token'
  const accessToken = unsignedJwt({
    aud: resource,
    iss: 'https://auth.example.com/',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })

  let requestUrl = ''
  let requestInit: RequestInit | undefined
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url)
    requestInit = init
    return new Response(JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh-abc',
      expires_in: 3600,
      token_type: 'Bearer',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const result = await exchangeAuthorizationCode({
    tokenEndpoint,
    clientId: 'client-1',
    clientSecret: 'super-secret',
    code: 'auth-code-123',
    codeVerifier: 'verifier-456',
    redirectUri: 'https://portal.example/callback',
    resource,
    fetchImpl,
  })

  assert.equal(result.accessToken, accessToken)
  assert.equal(result.refreshToken, 'refresh-abc')
  assert.ok(result.expiresAt)
  const expiresMs = Date.parse(result.expiresAt!)
  assert.ok(expiresMs > Date.now() + 3590 * 1000 && expiresMs <= Date.now() + 3600 * 1000)

  const parsedUrl = new URL(requestUrl)
  assert.equal(parsedUrl.origin, 'https://auth.example.com')
  assert.equal(parsedUrl.searchParams.has('client_secret'), false)
  assert.equal(parsedUrl.searchParams.has('code'), false)

  assert.equal(requestInit?.method, 'POST')
  const headers = new Headers(requestInit?.headers)
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded')
  const body = String(requestInit?.body ?? '')
  assert.match(body, /grant_type=authorization_code/)
  assert.match(body, /code=auth-code-123/)
  assert.match(body, /code_verifier=verifier-456/)
  assert.match(body, /client_secret=super-secret/)
  assert.match(body, /resource=https%3A%2F%2Fmcp.example.com%2Fmcp/)

  await assert.rejects(
    () => exchangeAuthorizationCode({
      tokenEndpoint,
      clientId: 'client-1',
      code: 'auth-code-123',
      codeVerifier: 'verifier-456',
      redirectUri: 'https://portal.example/callback',
      resource,
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: unsignedJwt({
          aud: 'wrong-aud',
          iss: 'https://auth.example.com/',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    /用户令牌受众或签发方不匹配/,
  )
})

test('assertOAuthTokenEndpointReachable rejects 404 with data-hub hint for /oauth/token on localhost', async () => {
  const fetchImpl = (async () => new Response('not found', { status: 404 })) as typeof fetch
  await assert.rejects(
    () => assertOAuthTokenEndpointReachable('http://localhost:3005/oauth/token', fetchImpl),
    /令牌端点不存在（HTTP 404）/,
  )
})

test('exchangeAuthorizationCode validates JWT iss against authorizationEndpoint when it differs from token host', async () => {
  const resource = 'http://localhost:3005/mcp'
  const tokenEndpoint = 'http://localhost:3005/api/oauth/token'
  const authorizationEndpoint = 'http://localhost:5175/api/oauth/authorize'
  const accessToken = unsignedJwt({
    aud: resource,
    iss: 'http://localhost:5175/',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })

  const result = await exchangeAuthorizationCode({
    tokenEndpoint,
    authorizationEndpoint,
    clientId: 'client-1',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'https://localhost:4174/callback',
    resource,
    fetchImpl: async () => new Response(JSON.stringify({ access_token: accessToken }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })

  assert.equal(result.accessToken, accessToken)
})

test('exchangeAuthorizationCode returns null refresh token when absent', async () => {
  const resource = 'https://mcp.example.com/mcp'
  const now = Math.floor(Date.now() / 1000) + 600
  const accessToken = unsignedJwt({
    aud: resource,
    iss: 'https://auth.example.com/',
    exp: now,
  })

  const result = await exchangeAuthorizationCode({
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'client-1',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'https://portal/cb',
    resource,
    fetchImpl: async () => new Response(JSON.stringify({ access_token: accessToken }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })

  assert.equal(result.refreshToken, null)
  assert.equal(result.expiresAt, null)
})
