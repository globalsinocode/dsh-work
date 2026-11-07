import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type { PostgresUserNotificationService } from '../../modules/workbench/application/postgres-user-notification-service.ts'
import { envelope, requireRequestIdentity, routeValidationFailed, sessionAuthorizationContext, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

type WorkbenchAccess = Pick<PostgresAuthorizationService, 'authorizeWorkbench'>
type NotificationStore = Pick<PostgresUserNotificationService, 'list' | 'unreadCount' | 'markRead' | 'markAllRead'>

/**
 * 站内通知（方案 NC-S1）：只读写当前登录账号本人的通知。已读只改本人记录，不改变业务数据；
 * 通知不是授权依据，点击后的目标页面仍按自身权限判断。
 */
export function registerUserNotificationRoutes(
  router: Router,
  notifications: NotificationStore,
  authorization?: WorkbenchAccess,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  const authorize = async (identity: ReturnType<typeof requireRequestIdentity>) => {
    await authorization?.authorizeWorkbench({ userId: identity.userId, ...sessionAuthorizationContext(identity) })
  }

  router.get(`${basePath}/me/notifications`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorize(identity)
    const params = context.url.searchParams
    const limitText = params.get('limit')
    const limit = limitText === null ? undefined : Number(limitText)
    if (limit !== undefined && !Number.isInteger(limit)) throw routeValidationFailed('limit 必须为整数')
    return envelope('workbench', await notifications.list({
      userId: identity.userId,
      status: params.get('status'),
      cursor: params.get('cursor'),
      ...(limit !== undefined ? { limit } : {}),
    }), adapter)
  })

  router.get(`${basePath}/me/notifications/unread-count`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorize(identity)
    return envelope('workbench', await notifications.unreadCount(identity.userId), adapter)
  })

  router.post(`${basePath}/me/notifications/read-all`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorize(identity)
    return envelope('workbench', await notifications.markAllRead(identity.userId), adapter)
  })

  router.post(`${basePath}/me/notifications/:notificationId/read`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorize(identity)
    return envelope('workbench', await notifications.markRead(identity.userId, context.params['notificationId'] ?? ''), adapter)
  })
}
