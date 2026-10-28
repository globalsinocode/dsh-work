import type { PostgresAgentAccessService } from '../../modules/agent/agent-access-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerAgentAccessRoutes(router: Router, access: PostgresAgentAccessService) {
  router.get(`${basePath}/agents/:agentId/access`, async (_request, context) =>
    envelope('admin', await access.getAccess(context.params.agentId ?? ''), 'postgres'))
  router.patch(`${basePath}/agents/:agentId/access`, async (request, context) => {
    const input = await readJsonBody<{
      expectedRevision: number
      visibleRoleIds: string[]
      roleIds: string[]
      dataScopes: string[]
      principalStatus?: 'active' | 'disabled'
    }>(request)
    return envelope('admin', await access.updateAccess({
      agentId: context.params.agentId ?? '',
      actor: requireRequestIdentity(context, 'admin').userId,
      expectedRevision: input.expectedRevision,
      visibleRoleIds: input.visibleRoleIds,
      roleIds: input.roleIds,
      dataScopes: input.dataScopes,
      ...(input.principalStatus !== undefined ? { principalStatus: input.principalStatus } : {}),
    }), 'postgres')
  })
}
