import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'
import type { CreateAgentDraftInput, PublishStatus, UpdateAgentDraftInput } from '../../domain/types.ts'

const basePath = '/api/admin/v1'

export function registerAgentRoutes(router: Router, service: PostgresAgentService) {
  router.get(`${basePath}/agents`, async () => envelope('admin', await service.getAgents(), 'postgres'))
  router.get(`${basePath}/agent-versions`, async () => envelope('admin', await service.getAgentVersions(), 'postgres'))
  router.get(`${basePath}/agent-release-records`, async () => envelope('admin', await service.getReleaseRecords(), 'postgres'))
  router.get(`${basePath}/agents/principal-role-options`, async () =>
    envelope('admin', await service.listPrincipalRoleOptions(), 'postgres'))
  router.post(`${basePath}/agents`, async (request, context) => {
    const input = await readJsonBody<Omit<CreateAgentDraftInput, 'actor'>>(request)
    return httpResult(201, envelope('admin', await service.createAgent({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres'))
  })
  router.patch(`${basePath}/agents/draft`, async (request, context) => {
    const input = await readJsonBody<Omit<UpdateAgentDraftInput, 'actor'>>(request)
    return envelope('admin', await service.updateAgent({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.patch(`${basePath}/agents/status`, async (request, context) => {
    const input = await readJsonBody<{
      agentId: string
      status: Extract<PublishStatus, 'published' | 'disabled'>
    }>(request)
    return envelope('admin', await service.setStatus({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/agents/rollback`, async (request, context) => {
    const input = await readJsonBody<{ agentId: string; version: string }>(request)
    return envelope('admin', await service.rollback({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  // 平台治理开关（convergence §1）。注册顺序必须在 /agents/draft、/agents/status 之后，
  // 否则参数路由会抢先匹配固定路径。
  router.patch(`${basePath}/agents/:agentId`, async (request, context) => {
    const input = await readJsonBody<{ allowWorkspaceJoin: boolean }>(request)
    return envelope('admin', {
      agent: await service.setAgentWorkspaceJoin({
        agentId: context.params.agentId ?? '',
        allowWorkspaceJoin: input.allowWorkspaceJoin,
        actor: requireRequestIdentity(context, 'admin').userId,
      }),
    }, 'postgres')
  })
  router.get(`${basePath}/agents/:agentId/workspaces`, async (_request, context) =>
    envelope('admin', {
      items: await service.listAgentJoinedWorkspaces(context.params.agentId ?? ''),
    }, 'postgres'))
  router.get(`${basePath}/agents/:agentId/principal`, async (_request, context) =>
    envelope('admin', await service.getAgentPrincipal(context.params.agentId ?? ''), 'postgres'))
  router.patch(`${basePath}/agents/:agentId/principal`, async (request, context) => {
    const input = await readJsonBody<{
      expectedAuthorizationVersion: number
      status: 'active' | 'disabled'
      roleIds: string[]
      dataScopes: string[]
    }>(request)
    return envelope('admin', await service.updateAgentPrincipal({
      ...input,
      agentId: context.params.agentId ?? '',
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
}
