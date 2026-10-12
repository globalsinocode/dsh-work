import type { LoginSettingsService } from '../../modules/identity/login-settings-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, routeValidationFailed, type Router } from '../router.ts'

export function registerLoginSettingsRoutes(router: Router, settings: LoginSettingsService) {
  const path = '/api/admin/v1/identity/login-settings'
  router.get(path, async () => envelope('admin', await settings.get(), 'postgres'))
  router.patch(path, async (request, context) => {
    const input = await readJsonBody<{ mode?: unknown; expectedRevision?: unknown }>(request)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw routeValidationFailed('请求体必须为 JSON 对象')
    return envelope('admin', await settings.save(input, requireRequestIdentity(context, 'admin')), 'postgres')
  })
}
