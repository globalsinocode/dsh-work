import { IdentityAccessError, type OidcAuthService } from './auth-service.ts'
import type { LocalAuthService } from './local-auth-service.ts'
import type { ApiAuthenticator } from './types.ts'

export function portalAuthenticator(local: LocalAuthService, oidc: OidcAuthService | null): ApiAuthenticator {
  return (request, audience) => {
    const localSession = local.hasSessionCookie(request, audience)
    if (localSession && oidc?.hasSessionCookie(request, audience)) {
      throw new IdentityAccessError(401, 'ambiguous_session', '存在多个登录会话，请重新登录')
    }
    // An expired or revoked credential must never fall through to another identity.
    return !localSession && oidc ? oidc.authenticateApi(request, audience) : local.authenticateApi(request, audience)
  }
}
