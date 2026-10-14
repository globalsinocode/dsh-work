import type { IncomingMessage } from 'node:http'

import { IdentityAccessError, type OidcAuthService } from '../modules/identity/auth-service.ts'
import type { LocalAuthService, LocalAccountInput } from '../modules/identity/local-auth-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from './router.ts'

export function registerLocalAuthRoutes(router: Router, authentication: LocalAuthService, oidc?: OidcAuthService | null) {
  for (const audience of ['workbench', 'admin'] as const) {
    router.get(`/auth/${audience}/login`, (request, context, response) => {
      response.writeHead(302, { 'Cache-Control': 'no-store', Location: authentication.loginPage(request, audience, context.url.searchParams.get('return_to')) })
      response.end()
    })
    router.get(`/auth/${audience}/switch-account`, (request, context, response) => {
      const location = new URL(authentication.loginPage(request, audience, context.url.searchParams.get('return_to')))
      location.searchParams.set('switch_account', 'true')
      response.writeHead(302, { 'Cache-Control': 'no-store', Location: location.toString() })
      response.end()
    })
    router.post(`/auth/${audience}/login`, async (request, _context, response) => {
      const input = await readLocalBody<{ username: unknown; password: unknown; returnTo?: string }>(request)
      const result = await authentication.login(request, audience, input)
      response.setHeader('Set-Cookie', oidc ? [result.sessionCookie, await oidc.revokeSession(request, audience), oidc.clearTransactionCookie(audience)] : result.sessionCookie)
      return { location: result.location }
    })
    router.post(`/auth/${audience}/logout`, async (request, _context, response) => {
      const result = await authentication.logout(request, audience)
      response.setHeader('Set-Cookie', oidc ? [result.clearSessionCookie, await oidc.revokeSession(request, audience), oidc.clearTransactionCookie(audience)] : result.clearSessionCookie)
      return { location: result.location }
    })
    router.post(`/auth/${audience}/password`, async (request, _context, response) => {
      const input = await readLocalBody<{ currentPassword: unknown; newPassword: unknown; returnTo?: string }>(request)
      const result = await authentication.changePassword(request, audience, input)
      response.setHeader('Set-Cookie', oidc ? [result.sessionCookie, await oidc.revokeSession(request, audience), oidc.clearTransactionCookie(audience)] : result.sessionCookie)
      return { location: result.location }
    })
  }

  const base = '/api/admin/v1/identity/users'
  router.post('/api/admin/v1/identity/login-account/check', async (request, context) => {
    const input = await readLocalBody<{ username: unknown }>(request)
    return envelope('admin', await authentication.checkLoginAccount(input.username, requireRequestIdentity(context, 'admin').userId), 'postgres')
  })
  router.post(base, async (request, context) => {
    const input = await readLocalBody<LocalAccountInput>(request)
    return envelope('admin', await authentication.createAccount(input, requireRequestIdentity(context, 'admin').userId), 'postgres')
  })
  router.post(`${base}/:userId/password`, async (request, context) => {
    const input = await readLocalBody<{ password: unknown }>(request)
    return envelope('admin', await authentication.resetPassword(context.params.userId!, input.password, requireRequestIdentity(context, 'admin').userId), 'postgres')
  })
  router.patch(`${base}/:userId/status`, async (request, context) => {
    const input = await readLocalBody<{ status: unknown }>(request)
    return envelope('admin', await authentication.setStatus(context.params.userId!, input.status, requireRequestIdentity(context, 'admin').userId), 'postgres')
  })
}

async function readLocalBody<T extends object>(request: IncomingMessage): Promise<T> {
  const input = await readJsonBody<unknown>(request)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new IdentityAccessError(422, 'invalid_request', '请求体必须为 JSON 对象')
  }
  return input as T
}
