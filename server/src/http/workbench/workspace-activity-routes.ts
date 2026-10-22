import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type { PostgresWorkspaceActivityService } from '../../modules/workbench/application/postgres-workspace-activity-service.ts'
import type { ServerResponse } from 'node:http'

import {
  envelope,
  readJsonBody,
  requireRequestIdentity,
  routeValidationFailed,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * Team workspace activity feed and in-app notification state (batch 3 / 3-T7 /
 * TW-08).
 *
 * Every route is the READ track (`allowArchived: true`): archived team
 * workspaces stay readable for current members, while personal workspaces get
 * the established team-only 422 (AC-23). The service re-resolves workspace
 * membership from the database on every call, so a member removed after
 * receiving a notification cannot read it through the old id — the route guard
 * here is only the first, uncached check.
 */
export function registerWorkspaceActivityRoutes(
  router: Router,
  activity: PostgresWorkspaceActivityService,
  authorization: PostgresAuthorizationService,
) {
  const readable = { allowArchived: true } as const

  const authorize = async (
    identity: ReturnType<typeof requireRequestIdentity>,
    workspaceId: string,
  ) => {
    await authorization.authorizeWorkbench({
      userId: identity.userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
      ...readable,
    })
  }

  router.get(`${basePath}/workspaces/:workspaceId/activity`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorize(identity, workspaceId)
    return envelope(
      'workbench',
      await activity.listActivity({
        workspaceId,
        actorUserId: identity.userId,
        cursor: context.url.searchParams.get('cursor') ?? undefined,
        limit: parseLimit(context.url.searchParams.get('limit')),
      }),
      'postgres',
    )
  })

  // 点击动态（阅读单条）：每次读取都重新校验当前成员资格，失权成员的旧 id 一律拒绝。
  router.get(`${basePath}/workspaces/:workspaceId/activity/:activityId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorize(identity, workspaceId)
    return envelope(
      'workbench',
      await activity.getActivityItem({
        workspaceId,
        activityId: context.params['activityId'] ?? '',
        actorUserId: identity.userId,
      }),
      'postgres',
    )
  })

  router.get(`${basePath}/workspaces/:workspaceId/notifications`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorize(identity, workspaceId)
    return envelope(
      'workbench',
      await activity.getNotifications({
        workspaceId,
        actorUserId: identity.userId,
        cursor: context.url.searchParams.get('cursor') ?? undefined,
        limit: parseLimit(context.url.searchParams.get('limit')),
      }),
      'postgres',
    )
  })

  router.post(`${basePath}/workspaces/:workspaceId/notifications/read`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorize(identity, workspaceId)
    return envelope(
      'workbench',
      await activity.markNotificationsRead({ workspaceId, actorUserId: identity.userId }),
      'postgres',
    )
  })

  router.post(`${basePath}/workspaces/:workspaceId/notifications/mute`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorize(identity, workspaceId)
    return envelope(
      'workbench',
      await activity.setNotificationsMuted({ workspaceId, actorUserId: identity.userId, muted: true }),
      'postgres',
    )
  })

  router.post(`${basePath}/workspaces/:workspaceId/notifications/unmute`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorize(identity, workspaceId)
    return envelope(
      'workbench',
      await activity.setNotificationsMuted({ workspaceId, actorUserId: identity.userId, muted: false }),
      'postgres',
    )
  })

  router.get(`${basePath}/notifications`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorization.authorizeWorkbench({ userId: identity.userId, ...sessionAuthorizationContext(identity) })
    const unreadOnly = context.url.searchParams.get('unread') === 'true'
    const workspaceId = context.url.searchParams.get('workspaceId') ?? undefined
    return envelope(
      'workbench',
      await activity.listAccountNotifications({
        userId: identity.userId,
        workspaceId,
        unreadOnly,
        cursor: context.url.searchParams.get('cursor') ?? undefined,
        limit: parseLimit(context.url.searchParams.get('limit')),
      }),
      'postgres',
    )
  })

  router.get(`${basePath}/notifications/counts`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorization.authorizeWorkbench({ userId: identity.userId, ...sessionAuthorizationContext(identity) })
    return envelope('workbench', await activity.countAccountUnread(identity.userId), 'postgres')
  })

  router.post(`${basePath}/notifications/read`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorization.authorizeWorkbench({ userId: identity.userId, ...sessionAuthorizationContext(identity) })
    const body = await readJsonBody<{ throughSequence?: unknown; workspaceId?: unknown } | null>(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw routeValidationFailed('请求体必须是 JSON 对象')
    }
    if (typeof body.throughSequence !== 'number' || !Number.isFinite(body.throughSequence)) {
      throw routeValidationFailed('throughSequence 必须是数字')
    }
    if (body.workspaceId !== undefined && typeof body.workspaceId !== 'string') {
      throw routeValidationFailed('workspaceId 必须是字符串')
    }
    return envelope(
      'workbench',
      await activity.markAccountNotificationsRead({
        userId: identity.userId,
        throughSequence: body.throughSequence,
        workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
      }),
      'postgres',
    )
  })

  router.get(`${basePath}/notifications/events`, async (request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorization.authorizeWorkbench({ userId: identity.userId, ...sessionAuthorizationContext(identity) })
    const sinceRaw = context.url.searchParams.get('since')
      ?? (Array.isArray(request.headers['last-event-id']) ? request.headers['last-event-id'][0] : request.headers['last-event-id'])
    const since = sinceRaw ? Number(sinceRaw) : 0
    await streamAccountNotificationEvents(response, activity, identity.userId, Number.isFinite(since) ? since : 0)
  })
}

export async function streamAccountNotificationEvents(
  response: ServerResponse,
  activity: PostgresWorkspaceActivityService,
  userId: string,
  since: number,
  pollIntervalMs = 500,
  heartbeatIntervalMs = 15_000,
) {
  response.writeHead(200, {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders?.()
  let cursor = since
  let closed = false
  response.on('close', () => { closed = true })
  let heartbeatAt = Date.now()
  while (!closed) {
    const maxSequence = await activity.maxDeliverySequenceForUser(userId, cursor)
    if (maxSequence > cursor) {
      cursor = maxSequence
      response.write(`id: ${cursor}\n`)
      response.write('event: notification.changed\n')
      response.write(`data: ${JSON.stringify({ sequence: cursor })}\n\n`)
    }
    if (Date.now() - heartbeatAt >= heartbeatIntervalMs) {
      response.write(`: heartbeat ${Date.now()}\n\n`)
      heartbeatAt = Date.now()
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  if (!closed) response.end()
}

function parseLimit(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined
  // Strict decimal only: `Number('0x10')` is 16 and `Number('1e2')` is 100, and
  // both would silently pass the service-bound integer check. Rejecting them
  // here keeps "limit 必须是 1..100 的十进制整数" honest; NaN becomes a typed 422
  // in the service.
  if (!/^[0-9]{1,3}$/.test(raw)) return Number.NaN
  return Number(raw)
}
