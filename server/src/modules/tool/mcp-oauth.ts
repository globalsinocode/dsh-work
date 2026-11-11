import { createHash, randomBytes } from 'node:crypto'

const JWT_MISMATCH_MESSAGE = '用户令牌受众或签发方不匹配'

/** 授权/令牌端点登记校验：允许 http 或 https（内网 HTTP 部署与 Docker 联调）。 */
export function assertOAuthEndpointScheme(endpoint: string, label = 'OAuth 端点'): URL {
  let parsed: URL
  try { parsed = new URL(endpoint.trim()) }
  catch { throw new TypeError(`${label} 必须是有效的 URL`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} 须为 http 或 https URL`)
  }
  return parsed
}

/** 登记用 OAuth 端点：保持登记值，仅去掉 `/api/oauth` 误写为 data-hub 实际的 `/oauth`。 */
export function normalizeOAuthDiscoveryEndpoint(raw: string, role: 'authorize' | 'token'): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  let url: URL
  try { url = new URL(trimmed) }
  catch { return trimmed }
  const wrong = role === 'authorize' ? '/api/oauth/authorize' : '/api/oauth/token'
  const right = role === 'authorize' ? '/oauth/authorize' : '/oauth/token'
  const path = url.pathname.replace(/\/$/, '') || '/'
  if (path === wrong) {
    url.pathname = right
    return url.toString()
  }
  return trimmed
}

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
  assertOAuthEndpointScheme(input.authorizationEndpoint, 'authorizationEndpoint')
  const url = new URL(normalizeOAuthDiscoveryEndpoint(input.authorizationEndpoint, 'authorize'))

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

/** 登记前探测令牌端点是否可达，避免 OAuth 同意后换票 404 却只显示「授权没有完成」。 */
export async function assertOAuthTokenEndpointReachable(
  tokenEndpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let url: URL
  try { url = new URL(tokenEndpoint.trim()) }
  catch { throw new TypeError('令牌端点必须是有效的 URL') }

  const normalized = normalizeOAuthDiscoveryEndpoint(url.toString(), 'token')
  const response = await fetchImpl(normalized, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code',
  })
  if (response.status !== 404) return

  const dataHubHint = url.pathname.startsWith('/api/oauth/')
    ? ' data-hub 使用 /oauth/token（无 /api 前缀），勿写 /api/oauth/token。'
    : ''
  throw new Error(`令牌端点不存在（HTTP 404）。${dataHubHint}`.trim())
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
  /** 用于校验 access token JWT 的 `iss` 来源；未传时回退为 tokenEndpoint（同主机部署） */
  authorizationEndpoint?: string
  clientId: string
  clientSecret?: string
  code: string
  codeVerifier: string
  redirectUri: string
  resource: string
  fetchImpl?: typeof fetch
}): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const tokenEndpoint = normalizeOAuthDiscoveryEndpoint(input.tokenEndpoint, 'token')
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

  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const err = await response.json() as { error?: string; error_description?: string }
      if (err.error_description?.trim()) detail = err.error_description.trim()
      else if (err.error?.trim()) detail = err.error.trim()
    } catch { /* non-JSON body */ }
    throw new Error(`MCP OAuth 换票失败：${detail}`)
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

  const authorizationEndpoint = input.authorizationEndpoint?.trim()
    ? normalizeOAuthDiscoveryEndpoint(input.authorizationEndpoint, 'authorize')
    : tokenEndpoint
  assertJwtAccessToken(accessToken, {
    resource: input.resource,
    authorizationEndpoint,
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
  const tokenEndpoint = normalizeOAuthDiscoveryEndpoint(input.tokenEndpoint, 'token')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    resource: input.resource,
  })
  if (input.clientSecret) {
    body.set('client_secret', input.clientSecret)
  }

  const response = await fetchImpl(tokenEndpoint, {
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
