import { envelope, requireRequestIdentity, type Router } from './router.ts'
import { adminModuleSummary, isPlatformAdmin } from '../domain/admin-permissions.ts'

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
      // 各模块的可用级别（管理端模块权限方案 5.6）：前端只用于展示菜单与按钮，服务端仍逐请求校验。
      adminModules: adminModuleSummary(identity.permissions),
      platformAdmin: isPlatformAdmin(identity.permissions),
    }, 'postgres')
  })
}

interface AuthConfiguration { mode: string; localEnabled: boolean; aiHubEnabled: boolean; dingtalk?: { corpId: string } }

/** Login options for both portals; the login pages read it before showing the AI Hub entry. */
export function registerAuthConfigurationRoutes(
  router: Router,
  describe: (audience: 'workbench' | 'admin') => Promise<AuthConfiguration> | AuthConfiguration,
) {
  for (const audience of ['workbench', 'admin'] as const) {
    router.get(`/auth/${audience}/configuration`, async () => describe(audience))
  }
}
