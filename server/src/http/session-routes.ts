import { envelope, requireRequestIdentity, type Router } from './router.ts'

/**
 * Current signed-in user for each portal. The browser uses this to render the shell
 * and to decide whether to send the user to the login page. Router authentication
 * has already validated the session cookie for the requested audience.
 */
export function registerSessionRoutes(router: Router) {
  router.get('/api/workbench/v1/session', (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', {
      user: identity.profile,
      identityProvider: identity.identityProvider,
      apiAudience: 'workbench' as const,
    }, 'postgres')
  })
  router.get('/api/admin/v1/session', (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    return envelope('admin', {
      user: identity.profile,
      identityProvider: identity.identityProvider,
      apiAudience: 'admin' as const,
      permissions: [...identity.permissions],
    }, 'postgres')
  })
}
