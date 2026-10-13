import type { ServerResponse } from 'node:http'

import { IdentityAccessError, OidcAuthService } from '../modules/identity/auth-service.ts'
import type { LocalAuthService } from '../modules/identity/local-auth-service.ts'
import type { ApiAudience } from '../modules/identity/types.ts'
import type { Router } from './router.ts'

export function registerOidcRoutes(router: Router, authentication: OidcAuthService, local?: LocalAuthService | null) {
  router.get('/auth/admin/bootstrap', async (request, context, response) => {
    const result = await authentication.beginBootstrapLogin(request, context.url.searchParams.get('return_to'))
    redirect(response, result.location, [result.cookie])
  })
  for (const audience of ['workbench', 'admin'] as const) {
    for (const action of ['login', 'switch-account']) router.get(`/auth/${audience}/${local ? 'oidc/' : ''}${action}`, async (request, context, response) => {
      // Validate the portal before handling upstream outages as a recoverable page state.
      const loginPage = local ? new URL(local.loginPage(request, audience, context.url.searchParams.get('return_to'))) : null
      try {
        const returnTo = context.url.searchParams.get('return_to')
        if (action === 'switch-account') {
          const result = await authentication.switchAccount(request, audience, returnTo)
          redirect(response, result.location, [result.cookie, result.clearSessionCookie])
        } else {
          const result = await authentication.beginLogin(request, audience, returnTo)
          redirect(response, result.location, [result.cookie])
        }
      } catch (error) {
        if (!loginPage) throw error
        loginPage.searchParams.set('provider', 'ai-hub')
        loginPage.searchParams.set('auth_error', 'ai_hub_unavailable')
        if (action === 'switch-account') loginPage.searchParams.set('switch_account', 'true')
        redirect(response, loginPage.toString(), [authentication.clearTransactionCookie(audience)])
      }
    })

    router.get(`/auth/${audience}/callback`, async (request, context, response) => {
      const providerError = context.url.searchParams.get('error')
      if (providerError) {
        redirect(
          response,
          authentication.errorRedirect(request, audience, providerError),
          [authentication.clearTransactionCookie(audience)],
        )
        return
      }
      const code = context.url.searchParams.get('code')
      const state = context.url.searchParams.get('state')
      const transactionToken = authentication.transactionCookie(request, audience)
      if (!code || !state || !transactionToken) {
        redirect(
          response,
          authentication.errorRedirect(request, audience, 'invalid_callback'),
          [authentication.clearTransactionCookie(audience)],
        )
        return
      }
      try {
        const result = await authentication.completeLogin({
          request,
          audience,
          code,
          state,
          transactionToken,
        })
        const cookies = [result.sessionCookie, result.clearTransactionCookie]
        if (local) cookies.push(await local.revokeSession(request, audience))
        redirect(response, result.location, cookies)
      } catch (error) {
        const codeValue = error instanceof IdentityAccessError ? error.code : 'authentication_failed'
        redirect(
          response,
          authentication.errorRedirect(request, audience, codeValue),
          [authentication.clearTransactionCookie(audience)],
        )
      }
    })

    const logout = async (request: Parameters<Parameters<Router['get']>[1]>[0], response: ServerResponse) => {
      const result = await authentication.logout(request, audience)
      const cookies = [result.clearSessionCookie]
      if (local) cookies.push(await local.revokeSession(request, audience))
      redirect(response, result.location, cookies)
    }
    router.get(`/auth/${audience}/logout`, async (request, _context, response) => logout(request, response))
    if (!local) router.post(`/auth/${audience}/logout`, async (request, _context, response) => logout(request, response))
  }
}

function redirect(response: ServerResponse, location: string, cookies: string[]) {
  response.writeHead(302, {
    'Cache-Control': 'no-store',
    Location: location,
    'Set-Cookie': cookies,
  })
  response.end()
}

export function audienceLoginPath(audience: ApiAudience) {
  return `/auth/${audience}/login`
}
