import type { ServerResponse } from 'node:http'

import { IdentityAccessError, OidcAuthService } from '../modules/identity/auth-service.ts'
import type { ApiAudience } from '../modules/identity/types.ts'
import type { Router } from './router.ts'

export function registerOidcRoutes(router: Router, authentication: OidcAuthService) {
  router.get('/auth/admin/bootstrap', async (request, context, response) => {
    const result = await authentication.beginBootstrapLogin(request, context.url.searchParams.get('return_to'))
    redirect(response, result.location, [result.cookie])
  })
  for (const audience of ['workbench', 'admin'] as const) {
    router.get(`/auth/${audience}/login`, async (request, context, response) => {
      const result = await authentication.beginLogin(request, audience, context.url.searchParams.get('return_to'))
      redirect(response, result.location, [result.cookie])
    })

    router.get(`/auth/${audience}/switch-account`, async (request, context, response) => {
      const result = await authentication.switchAccount(request, audience, context.url.searchParams.get('return_to'))
      redirect(response, result.location, [result.cookie, result.clearSessionCookie])
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
        redirect(response, result.location, [result.sessionCookie, result.clearTransactionCookie])
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
      redirect(response, result.location, [result.clearSessionCookie])
    }
    router.get(`/auth/${audience}/logout`, async (request, _context, response) => logout(request, response))
    router.post(`/auth/${audience}/logout`, async (request, _context, response) => logout(request, response))
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
