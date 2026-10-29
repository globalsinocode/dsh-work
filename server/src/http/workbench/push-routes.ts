import { parseNotificationPreferencesPatch } from '../../modules/workbench/application/notification-preferences.ts'
import type { WebPushService } from '../../modules/workbench/application/web-push-service.ts'
import { dependencyUnavailable } from '../../domain/request-errors.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

export function registerPushRoutes(
  router: Router,
  push: WebPushService,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  router.get(`${basePath}/me/push/config`, async (_request, context) => {
    requireRequestIdentity(context, 'workbench')
    const config = push.getConfig()
    if (!config) throw dependencyUnavailable('通知服务暂不可用')
    return envelope('workbench', config, adapter)
  })

  router.put(`${basePath}/me/push/subscriptions`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<unknown>(request)
    return envelope('workbench', await push.upsertSubscription(identity.userId, body), adapter)
  })

  router.delete(`${basePath}/me/push/subscriptions`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<unknown>(request)
    return envelope('workbench', await push.deleteSubscription(identity.userId, body), adapter)
  })

  router.get(`${basePath}/me/notification-preferences`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await push.getNotificationPreferences(identity.userId), adapter)
  })

  router.patch(`${basePath}/me/notification-preferences`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const patch = parseNotificationPreferencesPatch(await readJsonBody<unknown>(request))
    return envelope('workbench', await push.patchNotificationPreferences(identity.userId, patch), adapter)
  })
}
