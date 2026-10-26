import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { projectOwnerRoles as ownerRoles } from '../../domain/project-roles.ts'
import type { PostgresWorkspaceLifecycleService } from '../../modules/workbench/application/postgres-workspace-lifecycle-service.ts'
import { envelope, requireRequestIdentity, type Router } from '../router.ts'
import { requireTeamActor } from './workspace-member-routes.ts'

const basePath = '/api/workbench/v1'

/**
 * Team-workspace archive / restore (batch 3 / 3-T2).
 *
 * Owner-only, and the workspace status change is recorded as an audit fact.
 * The route guard runs on the read track (`allowArchived: true`) because
 * restoring an archived workspace must be reachable; the service re-reads the
 * current owner inside the workspace row lock, so a concurrent owner transfer
 * cannot let the previous owner archive or restore.
 *
 * Personal workspaces are rejected with the established team-only convention
 * (422, AC-23) before any state change.
 */
export function registerWorkspaceLifecycleRoutes(
  router: Router,
  lifecycle: PostgresWorkspaceLifecycleService,
  authorization: PostgresAuthorizationService,
) {
  const ownerOnly = { allowArchived: true, teamOnlyMessage: '仅支持团队工作空间进行归档或恢复' } as const

  router.post(`${basePath}/workspaces/:workspaceId/archive`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ownerRoles, ownerOnly)
    return envelope('workbench', await lifecycle.archiveWorkspace(workspaceId, identity.userId), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/restore`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ownerRoles, ownerOnly)
    return envelope('workbench', await lifecycle.restoreWorkspace(workspaceId, identity.userId), 'postgres')
  })
}
