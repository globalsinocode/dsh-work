import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type JsonWebKey,
} from 'node:crypto'

import { identityHttpTimeoutMs } from './identity-http-timeout.ts'
import type { OAuthTokenResponse, VerifiedToken } from './types.ts'

interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint?: string
}

interface JsonCacheEntry {
  value: Record<string, unknown>
  freshUntil: number
  staleUntil: number
}

interface TokenValidationOptions {
  requiredScopes?: string[]
  expectedNonce?: string
  expectedAudience?: string
  requireAiHubUser?: boolean
}

export class OidcProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OidcProtocolError'
    this.code = code
  }
}

export class OidcProviderClient {
  private readonly issuer: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly expectedAudience: string
  private readonly cacheTtlMilliseconds: number
  private readonly staleTtlMilliseconds: number
  private metadataCache: JsonCacheEntry | null = null
  private jwksCache: JsonCacheEntry | null = null

  constructor(input: {
    issuer: string
    clientId: string
    clientSecret: string
    expectedAudience: string
    cacheTtlSeconds: number
    staleTtlSeconds: number
  }) {
    this.issuer = normalizeIssuer(input.issuer)
    this.clientId = input.clientId
    this.clientSecret = input.clientSecret
    this.expectedAudience = input.expectedAudience
    this.cacheTtlMilliseconds = input.cacheTtlSeconds * 1000
    this.staleTtlMilliseconds = input.staleTtlSeconds * 1000
  }

  async createAuthorizationRequest(redirectUri: string, scopes: string[], forceLogin = false) {
    const metadata = await this.metadata()
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(64).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
    const url = new URL(metadata.authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: [...new Set(scopes)].join(' '),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString()
    if (forceLogin) url.searchParams.set('prompt', 'login')
    return { url: url.toString(), state, nonce, codeVerifier }
  }

  exchangeCode(code: string, redirectUri: string, codeVerifier: string) {
    return this.tokenRequest(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }))
  }

  refresh(refreshToken: string) {
    return this.tokenRequest(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }))
  }

  clientCredentials(scopes: string[]) {
    return this.tokenRequest(new URLSearchParams({
      grant_type: 'client_credentials',
      scope: [...new Set(scopes)].join(' '),
    }))
  }

  async logoutUrl(postLogoutRedirectUri: string) {
    const metadata = await this.metadata()
    const endpoint = metadata.end_session_endpoint
      ?? `${this.issuer.replace(/\/$/, '')}/end-session/`
    const url = new URL(endpoint)
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri)
    return url.toString()
  }

  async verify(token: string, options: TokenValidationOptions = {}): Promise<VerifiedToken> {
    const segments = token.split('.')
    if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
      throw new OidcProtocolError('invalid_token', 'OIDC Token 格式无效')
    }
    const header = parseSegment(segments[0], 'OIDC Token Header')
    const claims = parseSegment(segments[1], 'OIDC Token Claims')
    const algorithm = stringClaim(header, 'alg')
    const keyId = stringClaim(header, 'kid')
    if (algorithm !== 'RS256') throw new OidcProtocolError('invalid_token', 'OIDC Token 签名算法不受支持')

    let signingKey = await this.findSigningKey(keyId, false)
    if (!signingKey) signingKey = await this.findSigningKey(keyId, true)
    if (!signingKey) throw new OidcProtocolError('unknown_signing_key', 'OIDC Token 签名密钥未知')

    let publicKey: ReturnType<typeof createPublicKey>
    try {
      publicKey = createPublicKey({ key: signingKey as JsonWebKey, format: 'jwk' })
    } catch {
      throw new OidcProtocolError('invalid_jwks', 'OIDC JWKS 公钥格式无效')
    }
    const validSignature = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii'),
      publicKey,
      Buffer.from(segments[2], 'base64url'),
    )
    if (!validSignature) throw new OidcProtocolError('invalid_token', 'OIDC Token 签名无效')

    const subject = stringClaim(claims, 'sub')
    const issuer = normalizeIssuer(stringClaim(claims, 'iss'))
    const audiences = audienceClaims(claims.aud)
    const expiresAt = integerClaim(claims, 'exp')
    const issuedAt = integerClaim(claims, 'iat')
    const now = Math.floor(Date.now() / 1000)
    const clockSkew = 30
    if (issuer !== this.issuer) throw new OidcProtocolError('invalid_issuer', 'OIDC Token issuer 不匹配')
    const expectedAudience = options.expectedAudience ?? this.expectedAudience
    if (!audiences.includes(expectedAudience)) throw new OidcProtocolError('invalid_audience', 'OIDC Token audience 不匹配')
    if (expiresAt <= now - clockSkew) throw new OidcProtocolError('token_expired', 'OIDC Token 已过期')
    if (issuedAt > now + clockSkew) throw new OidcProtocolError('invalid_token', 'OIDC Token 签发时间无效')
    if (typeof claims.nbf === 'number' && claims.nbf > now + clockSkew) {
      throw new OidcProtocolError('invalid_token', 'OIDC Token 尚未生效')
    }

    if (options.expectedNonce !== undefined && claims.nonce !== options.expectedNonce) {
      throw new OidcProtocolError('invalid_nonce', 'OIDC ID Token nonce 不匹配')
    }

    const scopes = scopeClaims(claims.scope)
    for (const requiredScope of options.requiredScopes ?? []) {
      if (!scopes.includes(requiredScope)) {
        throw new OidcProtocolError('insufficient_scope', `OIDC Token 缺少 ${requiredScope} scope`)
      }
    }

    const actorType = typeof claims.actor_type === 'string' ? claims.actor_type : null
    const authorizationVersion = typeof claims.authorization_version === 'number'
      && Number.isInteger(claims.authorization_version)
      ? claims.authorization_version
      : null
    if (options.requireAiHubUser) {
      if (actorType !== 'user') throw new OidcProtocolError('invalid_actor_type', 'OIDC Token 不是用户身份')
    }

    return {
      subject,
      issuer,
      audiences,
      expiresAt,
      issuedAt,
      scopes,
      actorType,
      authorizationVersion,
      displayName: optionalStringClaim(claims, 'name'),
      email: optionalStringClaim(claims, 'email'),
      claims,
    }
  }

  private async tokenRequest(body: URLSearchParams): Promise<OAuthTokenResponse> {
    const metadata = await this.metadata()
    let response: Response
    try {
      response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(identityHttpTimeoutMs()),
      })
    } catch {
      throw new OidcProtocolError('identity_provider_unavailable', 'OIDC Token Endpoint 不可用')
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok) {
      const code = payload && typeof payload.error === 'string' ? payload.error : 'token_request_rejected'
      throw new OidcProtocolError(code, 'OIDC Token 请求被拒绝')
    }
    if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new OidcProtocolError('invalid_token_response', 'OIDC Token 响应无效')
    }
    const expiresIn = Number(payload.expires_in)
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new OidcProtocolError('invalid_token_response', 'OIDC Token 有效期无效')
    }
    return {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
      idToken: typeof payload.id_token === 'string' ? payload.id_token : null,
      expiresIn,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
    }
  }

  private async metadata(): Promise<OidcMetadata> {
    const raw = await this.cachedJson(
      `${this.issuer}.well-known/openid-configuration`,
      'metadata',
      false,
    )
    const issuer = normalizeIssuer(stringClaim(raw, 'issuer'))
    if (issuer !== this.issuer) throw new OidcProtocolError('invalid_oidc_metadata', 'OIDC Discovery issuer 不匹配')
    return {
      issuer,
      authorization_endpoint: absoluteUrlClaim(raw, 'authorization_endpoint'),
      token_endpoint: absoluteUrlClaim(raw, 'token_endpoint'),
      jwks_uri: absoluteUrlClaim(raw, 'jwks_uri'),
      end_session_endpoint: optionalAbsoluteUrlClaim(raw, 'end_session_endpoint'),
    }
  }

  private async findSigningKey(keyId: string, forceRefresh: boolean) {
    const metadata = await this.metadata()
    const jwks = await this.cachedJson(metadata.jwks_uri, 'jwks', forceRefresh)
    if (!Array.isArray(jwks.keys)) throw new OidcProtocolError('invalid_jwks', 'OIDC JWKS 缺少 keys')
    return jwks.keys.find((key): key is Record<string, unknown> => (
      typeof key === 'object' && key !== null && (key as Record<string, unknown>).kid === keyId
    ))
  }

  private async cachedJson(url: string, kind: 'metadata' | 'jwks', forceRefresh: boolean) {
    const cache = kind === 'metadata' ? this.metadataCache : this.jwksCache
    const now = Date.now()
    if (!forceRefresh && cache && now < cache.freshUntil) return cache.value
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(identityHttpTimeoutMs()),
      })
      if (!response.ok) throw new Error('non-success response')
      const payload = await response.json() as unknown
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid JSON object')
      const entry: JsonCacheEntry = {
        value: payload as Record<string, unknown>,
        freshUntil: now + this.cacheTtlMilliseconds,
        staleUntil: now + this.staleTtlMilliseconds,
      }
      if (kind === 'metadata') this.metadataCache = entry
      else this.jwksCache = entry
      return entry.value
    } catch {
      if (!forceRefresh && cache && now < cache.staleUntil) return cache.value
      throw new OidcProtocolError('identity_provider_unavailable', 'OIDC Discovery 或 JWKS 不可用')
    }
  }
}

function parseSegment(segment: string, label: string) {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new OidcProtocolError('invalid_token', `${label} 无效`)
  }
}

function stringClaim(claims: Record<string, unknown>, name: string) {
  const value = claims[name]
  if (typeof value !== 'string' || !value) throw new OidcProtocolError('invalid_token', `OIDC Token 缺少 ${name}`)
  return value
}

function optionalStringClaim(claims: Record<string, unknown>, name: string) {
  const value = claims[name]
  return typeof value === 'string' && value ? value : null
}

function integerClaim(claims: Record<string, unknown>, name: string) {
  const value = claims[name]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OidcProtocolError('invalid_token', `OIDC Token 缺少有效 ${name}`)
  }
  return value
}

function audienceClaims(value: unknown) {
  if (typeof value === 'string' && value) return [value]
  if (Array.isArray(value) && value.every(item => typeof item === 'string' && item)) return [...value] as string[]
  throw new OidcProtocolError('invalid_token', 'OIDC Token 缺少有效 aud')
}

function scopeClaims(value: unknown) {
  if (typeof value === 'string') return [...new Set(value.split(/\s+/).filter(Boolean))]
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return [...new Set(value as string[])]
  return []
}

function absoluteUrlClaim(claims: Record<string, unknown>, name: string) {
  const value = stringClaim(claims, name)
  try {
    return new URL(value).toString()
  } catch {
    throw new OidcProtocolError('invalid_oidc_metadata', `OIDC Discovery ${name} 无效`)
  }
}

function optionalAbsoluteUrlClaim(claims: Record<string, unknown>, name: string) {
  const value = claims[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new OidcProtocolError('invalid_oidc_metadata', `OIDC Discovery ${name} 无效`)
  try {
    return new URL(value).toString()
  } catch {
    throw new OidcProtocolError('invalid_oidc_metadata', `OIDC Discovery ${name} 无效`)
  }
}

function normalizeIssuer(value: string) {
  return `${value.replace(/\/$/, '')}/`
}
