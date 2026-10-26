import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type { PostgresWorkspaceTimelineService } from '../../modules/workbench/application/postgres-workspace-timeline-service.ts'
import { parseTargetLimit } from '../../modules/workbench/application/conversation-targets.ts'
import { envelope, requireRequestIdentity, sessionAuthorizationContext, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * 群聊时间线（S5d）：读取轨（`allowArchived: true`），归档空间现任成员可读；个人空间按
 * 既有口径 422。服务内每次重新解析成员关系，被移出的成员不能再读取。
 */
export function registerWorkspaceTimelineRoutes(
  router: Router,
  timeline: Pick<PostgresWorkspaceTimelineService, 'getTimeline'>,
  authorization: Pick<PostgresAuthorizationService, 'authorizeWorkbench'>,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  router.get(`${basePath}/workspaces/:workspaceId/timeline`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization.authorizeWorkbench({
      userId: identity.userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
      allowArchived: true,
    })
    const before = context.url.searchParams.get('before') ?? undefined
    return envelope('workbench', await timeline.getTimeline({
      workspaceId,
      actorUserId: identity.userId,
      ...(before ? { before } : {}),
      limit: parseTargetLimit(context.url.searchParams.get('limit'), 40),
    }), adapter)
  })
}
