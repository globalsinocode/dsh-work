import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import {
  envelope,
  requireRequestIdentity,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'

export function registerWorkbenchAgentRoutes(
  router: Router,
  service: PostgresAgentService,
  authorization: PostgresAuthorizationService,
  ) {
  router.get(`${basePath}/agents`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const access = await authorization.authorizeWorkbench({
      userId: identity.userId,
      ...sessionAuthorizationContext(identity),
    })
    return envelope(
      'workbench',
      await service.listWorkbenchAgents(identity.userId, access?.roleIds ?? identity.roleIds),
      'postgres',
    )
  })
}
