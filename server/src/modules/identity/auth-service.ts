import type { IncomingMessage } from 'node:http'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { AiHubApiError, AiHubClient } from './ai-hub-client.ts'
import { OidcProtocolError, OidcProviderClient } from './oidc-client.ts'
import { equalOpaqueHash, hashOpaque, randomOpaque, SecretBox } from './secure-values.ts'
import {
  IdentitySessionRepository,
  type AuthenticationSessionRecord,
  type LocalAuthorizationContext,
} from './session-repository.ts'
import type {
  ApiAudience,
  CurrentPlatformUser,
  OidcAudienceConfiguration,
  OidcIdentityConfiguration,
  RequestIdentity,
  VerifiedToken,
} from './types.ts'
import { LOCAL_PERMISSIONS } from './types.ts'

const bootstrapScope = 'platform.application.bootstrap'

export class IdentityAccessError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'IdentityAccessError'
    this.status = status
    this.code = code
  }
}

export class OidcAuthService {
  private readonly configuration: OidcIdentityConfiguration
  private readonly repository: IdentitySessionRepository
  private readonly secretBox: SecretBox
  private readonly platform: AiHubClient
  private readonly providers: Record<ApiAudience, OidcProviderClient>

  constructor(configuration: OidcIdentityConfiguration, database: DatabaseClient) {
    this.configuration = configuration
    this.repository = new IdentitySessionRepository(database)
    this.secretBox = new SecretBox(configuration.sessionSecret)
    this.platform = new AiHubClient(configuration.platformUrl)
    this.providers = {
      workbench: provider(configuration, 'workbench'),
      admin: provider(configuration, 'admin'),
    }
  }

  async beginLogin(
    request: IncomingMessage,
    audience: ApiAudience,
    requestedReturnTo: string | null,
    forceLogin = false,
  ) {
    return this.beginLoginTransaction(request, audience, requestedReturnTo, forceLogin, 'login')
  }

  async beginBootstrapLogin(request: IncomingMessage, returnTo: string | null) {
    await this.assertBootstrapOpen()
    return this.beginLoginTransaction(request, 'admin', returnTo, true, 'admin-bootstrap')
  }

  private async assertBootstrapOpen() {
    if (!this.configuration.adminBootstrapEnabled
      || await this.repository.hasConsumedAdminBootstrap(this.configuration.applicationId, this.configuration.environment)) {
      throw new IdentityAccessError(403, 'admin_bootstrap_closed', '初始管理员认领未开放或已经完成，请使用正常登录')
    }
  }

  private async beginLoginTransaction(
    request: IncomingMessage, audience: ApiAudience, requestedReturnTo: string | null,
    forceLogin: boolean, loginPurpose: 'login' | 'admin-bootstrap',
  ) {
    const settings = this.configuration.audiences[audience]
    const portalOrigin = resolveRequestOrigin(request, settings)
    const redirectUri = redirectUriForOrigin(settings, portalOrigin)
    const scopes = settings.loginScopes.filter(scope => scope !== bootstrapScope)
    if (loginPurpose === 'admin-bootstrap') scopes.push(bootstrapScope)
    const authorization = await this.providers[audience].createAuthorizationRequest(
      redirectUri,
      scopes,
      forceLogin,
    )
    const transactionToken = randomOpaque()
    await this.repository.createLoginTransaction({
      transactionHash: hashOpaque(transactionToken),
      audience,
      loginPurpose,
      stateHash: hashOpaque(authorization.state),
      codeVerifierEncrypted: this.secretBox.seal(authorization.codeVerifier),
      nonce: authorization.nonce,
      returnTo: normalizeReturnTo(requestedReturnTo, portalOrigin),
      portalOrigin,
      redirectUri,
      expiresAt: new Date(Date.now() + this.configuration.transactionTtlSeconds * 1000),
    })
    return {
      location: authorization.url,
      cookie: serializeCookie(
        settings.transactionCookieName,
        transactionToken,
        this.configuration.transactionTtlSeconds,
        this.configuration.cookieSecure,
      ),
    }
  }

  async switchAccount(request: IncomingMessage, audience: ApiAudience, returnTo: string | null) {
    const settings = this.configuration.audiences[audience]
    resolveRequestOrigin(request, settings)
    const cookieValue = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (cookieValue) await this.repository.logoutSession(hashOpaque(cookieValue), audience)
    const login = await this.beginLogin(request, audience, returnTo, true)
    return {
      ...login,
      clearSessionCookie: clearCookie(settings.sessionCookieName, this.configuration.cookieSecure),
    }
  }

  async completeLogin(input: {
    request: IncomingMessage
    audience: ApiAudience
    code: string
    state: string
    transactionToken: string
  }) {
    const settings = this.configuration.audiences[input.audience]
    const transaction = await this.repository.consumeLoginTransaction(
      hashOpaque(input.transactionToken),
      input.audience,
    )
    if (!transaction || !equalOpaqueHash(input.state, transaction.stateHash)) {
      throw new IdentityAccessError(401, 'invalid_state', 'OIDC 登录状态无效或已过期')
    }
    const requestOrigin = resolveCallbackOrigin(input.request, settings)
    const portalOrigin = transaction.portalOrigin ?? requestOrigin
    if (requestOrigin !== portalOrigin) {
      throw new IdentityAccessError(403, 'invalid_callback_origin', 'OIDC 回调入口与登录入口不一致')
    }
    const redirectUri = transaction.redirectUri ?? redirectUriForOrigin(settings, portalOrigin)
    if (redirectUri !== redirectUriForOrigin(settings, portalOrigin)) {
      throw new IdentityAccessError(401, 'invalid_redirect_uri', 'OIDC 登录回调地址不在允许列表中')
    }

    // Callback query parameters cannot elevate intent; use only the consumed transaction.
    const bootstrap = transaction.loginPurpose === 'admin-bootstrap'
    if (bootstrap) {
      if (input.audience !== 'admin') throw new IdentityAccessError(403, 'invalid_bootstrap_audience', '认领受众无效')
      await this.assertBootstrapOpen()
    }
    let tokenResponse
    let verified: VerifiedToken
    try {
      tokenResponse = await this.providers[input.audience].exchangeCode(
        input.code,
        redirectUri,
        this.secretBox.open(transaction.codeVerifierEncrypted),
      )
      verified = await this.providers[input.audience].verify(tokenResponse.accessToken, {
        requiredScopes: [...requiredUserScopes(), ...(bootstrap ? [bootstrapScope] : [])],
        requireAiHubUser: true,
      })
      if (!tokenResponse.idToken) {
        throw new OidcProtocolError('missing_id_token', 'OIDC 响应缺少 ID Token')
      }
      const idToken = await this.providers[input.audience].verify(tokenResponse.idToken, {
        expectedNonce: transaction.nonce,
        expectedAudience: settings.clientId,
      })
      if (idToken.subject !== verified.subject) {
        throw new OidcProtocolError('invalid_subject', 'OIDC Token subject 不一致')
      }
    } catch (error) {
      throw identityError(error)
    }

    const platformUser = await this.loadPlatformIdentity(
      tokenResponse.accessToken,
      settings,
      verified,
    )
    const synchronized = await this.repository.synchronizeIdentity(toExternalIdentity(platformUser))
    let authorization: LocalAuthorizationContext
    try {
      if (!platformUser.business_user) {
        throw new IdentityAccessError(
          403,
          'business_user_required',
          'AI Hub 平台账号不能登录业务应用，请使用业务员工账号',
        )
      }
      authorization = await this.repository.resolveAuthorization(synchronized.userId)
      if (bootstrap) {
        authorization = await this.claimInitialAdministrator({
          accessToken: tokenResponse.accessToken,
          settings,
          platformUser,
          localUserId: synchronized.userId,
        })
      }
      assertAudienceAccess(input.audience, authorization.permissions, false)
    } catch (error) {
      const normalized = identityError(error)
      await this.repository.appendAudit({
        userId: synchronized.userId,
        action: 'identity.login',
        result: 'blocked',
        audience: input.audience,
        context: { errorCode: normalized.code },
      }).catch(() => undefined)
      throw normalized
    }

    const sessionToken = randomOpaque()
    const now = Date.now()
    const tokenExpiresAt = new Date(verified.expiresAt * 1000)
    const configuredSessionExpiry = new Date(now + this.configuration.sessionTtlSeconds * 1000)
    const expiresAt = tokenResponse.refreshToken
      ? configuredSessionExpiry
      : new Date(Math.min(configuredSessionExpiry.getTime(), tokenExpiresAt.getTime()))
    await this.repository.createSession({
      sessionHash: hashOpaque(sessionToken),
      audience: input.audience,
      userId: synchronized.userId,
      accessTokenEncrypted: this.secretBox.seal(tokenResponse.accessToken),
      refreshTokenEncrypted: tokenResponse.refreshToken
        ? this.secretBox.seal(tokenResponse.refreshToken)
        : null,
      tokenExpiresAt,
      authorizationVersion: authorization.authorizationVersion,
      expiresAt,
    })
    return {
      location: transaction.returnTo,
      sessionCookie: serializeCookie(
        settings.sessionCookieName,
        sessionToken,
        Math.max(1, Math.floor((expiresAt.getTime() - now) / 1000)),
        this.configuration.cookieSecure,
      ),
      clearTransactionCookie: clearCookie(
        settings.transactionCookieName,
        this.configuration.cookieSecure,
      ),
    }
  }

  async authenticateApi(request: IncomingMessage, audience: ApiAudience): Promise<RequestIdentity> {
    const settings = this.configuration.audiences[audience]
    const cookieValue = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (!cookieValue) throw new IdentityAccessError(401, 'authentication_required', '请先登录')
    let session = await this.repository.findSession(hashOpaque(cookieValue), audience)
    if (!session) throw new IdentityAccessError(401, 'session_expired', '登录会话不存在或已过期')

    validateRequestOrigin(request, settings)
    session = await this.refreshSession(session)
    const authorization = await this.repository.resolveAuthorization(session.userId)
    assertAudienceAccess(audience, authorization.permissions, isUnsafeMethod(request.method))
    if (session.authorizationVersion !== authorization.authorizationVersion) {
      await this.repository.updateAuthorizationVersion(
        session.sessionHash,
        authorization.authorizationVersion,
      )
    } else {
      await this.repository.touch(session.sessionHash)
    }
    return {
      audience,
      applicationId: settings.applicationId,
      sessionHash: session.sessionHash,
      userId: session.userId,
      subject: session.subject,
      profile: authorization.profile,
      roleIds: [...authorization.roleIds],
      permissions: [...authorization.permissions],
      dataScopes: [...authorization.dataScopes],
      authorizationVersion: authorization.authorizationVersion,
      identityProvider: 'ai-hub-oidc',
    }
  }

  async logout(request: IncomingMessage, audience: ApiAudience) {
    const settings = this.configuration.audiences[audience]
    const portalOrigin = resolveRequestOrigin(request, settings)
    const cookieValue = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (cookieValue) {
      const sessionHash = hashOpaque(cookieValue)
      await this.repository.logoutSession(sessionHash, audience)
    }
    return {
      location: await this.providers[audience].logoutUrl(portalOrigin),
      clearSessionCookie: clearCookie(settings.sessionCookieName, this.configuration.cookieSecure),
    }
  }

  transactionCookie(request: IncomingMessage, audience: ApiAudience) {
    const name = this.configuration.audiences[audience].transactionCookieName
    return parseCookies(request.headers.cookie)[name] ?? null
  }

  errorRedirect(request: IncomingMessage, audience: ApiAudience, code: string) {
    const origin = resolveCallbackOrigin(request, this.configuration.audiences[audience])
    const url = new URL('/login-error', `${origin}/`)
    url.searchParams.set('code', safeErrorCode(code))
    return url.toString()
  }

  clearTransactionCookie(audience: ApiAudience) {
    return clearCookie(
      this.configuration.audiences[audience].transactionCookieName,
      this.configuration.cookieSecure,
    )
  }

  private async refreshSession(original: AuthenticationSessionRecord) {
    if (original.tokenExpiresAt.getTime() > Date.now() + 30_000) return original
    try {
      const refreshed = await this.repository.refreshTokensWithLock(
        original.sessionHash,
        original.audience,
        async (latest) => {
          if (latest.tokenExpiresAt.getTime() > Date.now() + 30_000) return null
          if (!latest.refreshTokenEncrypted) {
            throw new IdentityAccessError(401, 'session_expired', '登录凭据已经过期')
          }
          const tokenResponse = await this.providers[latest.audience].refresh(
            this.secretBox.open(latest.refreshTokenEncrypted),
          )
          const verified = await this.providers[latest.audience].verify(tokenResponse.accessToken, {
            requiredScopes: requiredUserScopes(),
            requireAiHubUser: true,
          })
          if (verified.subject !== latest.subject) {
            throw new OidcProtocolError('invalid_subject', '刷新后的用户身份不一致')
          }
          return {
            accessTokenEncrypted: this.secretBox.seal(tokenResponse.accessToken),
            refreshTokenEncrypted: tokenResponse.refreshToken
              ? this.secretBox.seal(tokenResponse.refreshToken)
              : latest.refreshTokenEncrypted,
            tokenExpiresAt: new Date(verified.expiresAt * 1000),
          }
        },
      )
      if (!refreshed) {
        throw new IdentityAccessError(401, 'session_expired', '登录会话不存在或已过期')
      }
      return refreshed
    } catch (error) {
      if (shouldRevokeAfterRefreshFailure(error)) {
        await this.repository.revoke(original.sessionHash)
      }
      throw identityError(error, error instanceof OidcProtocolError ? 401 : 503)
    }
  }

  private async loadPlatformIdentity(
    accessToken: string,
    settings: OidcAudienceConfiguration,
    verified: VerifiedToken,
  ) {
    try {
      const user = await this.platform.me(accessToken, settings.applicationId)
      if (user.status.toUpperCase() !== 'ACTIVE') {
        throw new IdentityAccessError(403, 'account_disabled', 'AI Hub 用户已停用')
      }
      if (user.subject !== verified.subject) {
        throw new IdentityAccessError(401, 'identity_mismatch', 'AI Hub 用户身份映射不一致')
      }
      return user
    } catch (error) {
      if (error instanceof IdentityAccessError) throw error
      throw identityError(error)
    }
  }

  private async claimInitialAdministrator(input: {
    accessToken: string
    settings: OidcAudienceConfiguration
    platformUser: CurrentPlatformUser
    localUserId: string
  }): Promise<LocalAuthorizationContext> {
    try {
      await this.assertBootstrapOpen()
      const claim = await this.platform.claimAdminBootstrap(
        input.accessToken,
        input.settings.applicationId,
        this.configuration.environment,
      )
      if (
        claim.application_id !== input.settings.applicationId
        || claim.environment !== this.configuration.environment
        || claim.claimed_user_id !== input.platformUser.user_id
        || claim.initial_admin_user_id !== input.platformUser.user_id
      ) {
        throw new IdentityAccessError(502, 'invalid_admin_bootstrap', 'AI Hub 初始管理员响应不一致')
      }
      const consumedAt = new Date(claim.consumed_at)
      if (!Number.isFinite(consumedAt.getTime())) {
        throw new IdentityAccessError(502, 'invalid_admin_bootstrap', 'AI Hub 初始管理员时间无效')
      }
      await this.repository.consumeAdminBootstrap({
        applicationId: claim.application_id,
        environment: claim.environment,
        externalUserId: claim.claimed_user_id,
        userId: input.localUserId,
        consumedAt,
      })
      return this.repository.resolveAuthorization(input.localUserId)
    } catch (error) {
      if (error instanceof IdentityAccessError) throw error
      if (
        error instanceof AiHubApiError
        && [403, 404, 409].includes(error.status)
      ) {
        throw new IdentityAccessError(
          403,
          'initial_admin_not_authorized',
          '当前账号不是应用初始管理员，且尚未获得本地管理角色',
        )
      }
      throw identityError(error)
    }
  }
}

function provider(configuration: OidcIdentityConfiguration, audience: ApiAudience) {
  const settings = configuration.audiences[audience]
  return new OidcProviderClient({
    issuer: settings.issuer,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    expectedAudience: settings.tokenAudience,
    cacheTtlSeconds: configuration.jwksCacheTtlSeconds,
    staleTtlSeconds: configuration.jwksStaleTtlSeconds,
  })
}

function requiredUserScopes() {
  return [
    'ai_hub.identity',
    'platform.me.read',
  ]
}

function toExternalIdentity(user: CurrentPlatformUser) {
  return {
    externalUserId: user.user_id,
    subject: user.subject,
    displayName: user.display_name,
    email: user.email,
    organizationName: user.organization_name,
    businessUser: user.business_user,
    status: user.status,
  }
}

function hasAdminAccess(permissions: string[]) {
  const granted = new Set(permissions)
  return granted.has(LOCAL_PERMISSIONS.adminAll)
    || granted.has(LOCAL_PERMISSIONS.adminRead)
    || granted.has(LOCAL_PERMISSIONS.adminWrite)
    || granted.has(LOCAL_PERMISSIONS.auditRead)
}

function assertAudienceAccess(audience: ApiAudience, permissions: string[], unsafe: boolean) {
  const granted = new Set(permissions)
  if (audience === 'workbench') {
    if (!granted.has(LOCAL_PERMISSIONS.workbenchUse) && !granted.has(LOCAL_PERMISSIONS.workbenchManage)) {
      throw new IdentityAccessError(403, 'permission_denied', '当前用户没有员工工作台访问权限')
    }
    return
  }
  if (unsafe) {
    if (!granted.has(LOCAL_PERMISSIONS.adminAll) && !granted.has(LOCAL_PERMISSIONS.adminWrite)) {
      throw new IdentityAccessError(403, 'permission_denied', '当前用户没有管理写权限')
    }
    return
  }
  if (!hasAdminAccess(permissions)) {
    throw new IdentityAccessError(403, 'permission_denied', '当前用户没有管理后台访问权限')
  }
}

function normalizeReturnTo(value: string | null, portalOrigin: string) {
  const portal = new URL(`${portalOrigin.replace(/\/$/, '')}/`)
  if (!value) return portal.toString()
  try {
    const candidate = new URL(value, portal)
    if (candidate.origin !== portal.origin) return portal.toString()
    return candidate.toString()
  } catch {
    return portal.toString()
  }
}

function validateRequestOrigin(
  request: IncomingMessage,
  settings: OidcAudienceConfiguration,
) {
  if (!isUnsafeMethod(request.method)) return
  const origin = request.headers.origin
  const requestOrigin = resolveRequestOrigin(request, settings)
  if (!origin || normalizeHeaderOrigin(origin) !== requestOrigin) {
    throw new IdentityAccessError(403, 'csrf_check_failed', '请求来源校验失败')
  }
}

function redirectUriForOrigin(settings: OidcAudienceConfiguration, origin: string) {
  const redirectUri = settings.redirectUriByOrigin[origin]
  if (!redirectUri) {
    throw new IdentityAccessError(421, 'unknown_request_origin', '请求入口不在允许列表中')
  }
  return redirectUri
}

function resolveRequestOrigin(
  request: IncomingMessage,
  settings: OidcAudienceConfiguration,
) {
  const origin = requestOrigin(request)
  if (!settings.allowedOrigins.includes(origin)) {
    throw new IdentityAccessError(421, 'unknown_request_origin', '请求入口不在允许列表中')
  }
  return origin
}

function resolveCallbackOrigin(request: IncomingMessage, settings: OidcAudienceConfiguration) {
  const origin = requestOrigin(request)
  // Legacy single-portal configurations may send callbacks directly to the
  // backend port. Only the explicitly configured callback origin is an alias;
  // it never becomes an allowed login/API/logout origin.
  if (settings.allowedOrigins.length === 1) {
    const portalOrigin = settings.allowedOrigins[0]!
    if (new URL(redirectUriForOrigin(settings, portalOrigin)).origin === origin) {
      return portalOrigin
    }
  }
  return resolveRequestOrigin(request, settings)
}

function requestOrigin(request: IncomingMessage) {
  const forwardedProtocol = singleForwardedHeader(request.headers['x-forwarded-proto'])
  const forwardedHost = singleForwardedHeader(request.headers['x-forwarded-host'])
  const protocol = forwardedProtocol
    ?? ((request.socket as IncomingMessage['socket'] & { encrypted?: boolean }).encrypted ? 'https' : 'http')
  const host = forwardedHost ?? singleForwardedHeader(request.headers.host)
  if (!host || !['http', 'https'].includes(protocol)) {
    throw new IdentityAccessError(421, 'invalid_request_origin', '请求入口地址无效')
  }
  let origin: string
  try {
    origin = new URL(`${protocol}://${host}`).origin
  } catch {
    throw new IdentityAccessError(421, 'invalid_request_origin', '请求入口地址无效')
  }
  return origin
}

function singleForwardedHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new IdentityAccessError(421, 'invalid_request_origin', '请求入口地址无效')
    return singleForwardedHeader(value[0])
  }
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (normalized.includes(',') || /[\r\n]/.test(normalized)) {
    throw new IdentityAccessError(421, 'invalid_request_origin', '请求入口地址无效')
  }
  return normalized
}

function normalizeHeaderOrigin(value: string) {
  try {
    const parsed = new URL(value)
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

function isUnsafeMethod(method: string | undefined) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method ?? 'GET')
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {}
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (!name || !value) continue
    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      continue
    }
  }
  return cookies
}

function serializeCookie(name: string, value: string, maxAge: number, secure: boolean) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

function clearCookie(name: string, secure: boolean) {
  return serializeCookie(name, '', 0, secure)
}

function safeErrorCode(code: string) {
  return /^[a-z0-9_]{1,80}$/i.test(code) ? code : 'authentication_failed'
}

function identityError(error: unknown, defaultStatus = 502) {
  if (error instanceof IdentityAccessError) return error
  if (error instanceof AiHubApiError) {
    if (error.status === 401) return new IdentityAccessError(401, error.code, error.message)
    if (error.status === 403) return new IdentityAccessError(403, error.code, error.message)
    return new IdentityAccessError(503, error.code, error.message)
  }
  if (error instanceof OidcProtocolError) {
    const status = ['identity_provider_unavailable'].includes(error.code) ? 503 : defaultStatus
    return new IdentityAccessError(status, error.code, error.message)
  }
  return new IdentityAccessError(defaultStatus, 'authentication_failed', '身份认证未完成')
}

function shouldRevokeAfterRefreshFailure(error: unknown) {
  if (error instanceof IdentityAccessError) return error.status === 401
  if (!(error instanceof OidcProtocolError)) return false
  return ![
    'identity_provider_unavailable',
    'invalid_oidc_metadata',
    'invalid_jwks',
    'unknown_signing_key',
  ].includes(error.code)
}
