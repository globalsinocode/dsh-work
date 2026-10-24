import { createHash, randomBytes } from 'node:crypto'

const JWT_MISMATCH_MESSAGE = '用户令牌受众或签发方不匹配'

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')
  return { verifier, challenge }
}

export function authorizationUrl(input: {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  scopes: string[]
  resource: string
  state: string
  codeChallenge: string
}): URL {
  const url = new URL(input.authorizationEndpoint)
  if (url.protocol !== 'https:') {
    throw new TypeError('authorizationEndpoint 必须是 https URL')
  }

  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', [...new Set(input.scopes)].join(' '))
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', input.resource)
  return url
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null
  const payloadSegment = segments[1]
  if (!payloadSegment) return null
  try {
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8')
    const payload = JSON.parse(json) as Record<string, unknown>
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

function audienceMatches(aud: unknown, resource: string): boolean {
  if (typeof aud === 'string') return aud === resource
  if (Array.isArray(aud)) return aud.some(entry => entry === resource)
  return false
}

function issuerOriginMatches(iss: unknown, authorizationEndpoint: string): boolean {
  if (typeof iss !== 'string' || !iss.trim()) return false
  try {
    return new URL(iss).origin === new URL(authorizationEndpoint).origin
  } catch {
    return false
  }
}

function expirationValid(exp: unknown, now: Date): boolean {
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false
  return exp > Math.floor(now.getTime() / 1000)
}

export function assertJwtAccessToken(token: string, input: {
  resource: string
  authorizationEndpoint: string
  now?: Date
}): void {
  const payload = decodeJwtPayload(token)
  if (!payload) return

  const now = input.now ?? new Date()
  const valid = audienceMatches(payload.aud, input.resource)
    && issuerOriginMatches(payload.iss, input.authorizationEndpoint)
    && expirationValid(payload.exp, now)

  if (!valid) {
    throw new Error(JWT_MISMATCH_MESSAGE)
  }
}

export async function exchangeAuthorizationCode(input: {
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  code: string
  codeVerifier: string
  redirectUri: string
  resource: string
  fetchImpl?: typeof fetch
}): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    resource: input.resource,
  })
  if (input.clientSecret) {
    body.set('client_secret', input.clientSecret)
  }

  const response = await fetchImpl(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    throw new Error(`MCP OAuth 换票失败：HTTP ${response.status}`)
  }

  const json = await response.json() as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  const accessToken = json.access_token
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('MCP OAuth 换票响应缺少 access_token')
  }

  assertJwtAccessToken(accessToken, {
    resource: input.resource,
    authorizationEndpoint: input.tokenEndpoint,
  })

  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : null
  const expiresAt = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
    ? new Date(Date.now() + json.expires_in * 1000).toISOString()
    : null

  return { accessToken, refreshToken, expiresAt }
}

export async function exchangeRefreshToken(input: {
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  refreshToken: string
  resource: string
  authorizationEndpoint: string
  fetchImpl?: typeof fetch
}): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    resource: input.resource,
  })
  if (input.clientSecret) {
    body.set('client_secret', input.clientSecret)
  }

  const response = await fetchImpl(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    throw new Error(`MCP OAuth 刷新失败：HTTP ${response.status}`)
  }

  const json = await response.json() as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  const accessToken = json.access_token
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('MCP OAuth 刷新响应缺少 access_token')
  }

  assertJwtAccessToken(accessToken, {
    resource: input.resource,
    authorizationEndpoint: input.authorizationEndpoint,
  })

  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : null
  const expiresAt = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
    ? new Date(Date.now() + json.expires_in * 1000).toISOString()
    : null

  return { accessToken, refreshToken, expiresAt }
}
