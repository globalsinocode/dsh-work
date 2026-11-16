import type { LocalAuthService } from './local-auth-service.ts'
import type { ApiAuthenticator } from './types.ts'

export function portalAuthenticator(local: LocalAuthService): ApiAuthenticator {
  return (request, audience) => local.authenticateApi(request, audience)
}
