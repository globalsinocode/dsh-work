import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { PostgresAgentAccessService, UpdateAgentAccessInput } from '../../modules/agent/agent-access-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, routeValidationFailed, type Router } from '../router.ts'
import type { CreateAgentDraftInput, PublishStatus, UpdateAgentDraftInput } from '../../domain/types.ts'

const basePath = '/api/admin/v1'

export function registerAgentRoutes(router: Router, service: PostgresAgentService, access: PostgresAgentAccessService) {
  router.get(`${basePath}/agents`, async () => envelope('admin', await service.getAgents(), 'postgres'))
  router.get(`${basePath}/agent-versions`, async () => envelope('admin', await service.getAgentVersions(), 'postgres'))
  router.get(`${basePath}/agent-release-records`, async () => envelope('admin', await service.getReleaseRecords(), 'postgres'))
  router.post(`${basePath}/agents`, async (request, context) => {
    const input = await readJsonBody<Omit<CreateAgentDraftInput, 'actor'>>(request)
    return httpResult(201, envelope('admin', await service.createAgent({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres'))
  })
  router.patch(`${basePath}/agents/draft`, async (request, context) => {
    const { expectedRevision, ...input } = await readJsonBody<Omit<UpdateAgentDraftInput, 'actor'>>(request)
    if (typeof expectedRevision !== 'string' || !expectedRevision.trim()) {
      throw routeValidationFailed('缺少草稿修订，请刷新 Agent 后重新编辑')
    }
    // 访问授权（可见角色、执行角色、数据范围）不属于草稿，只能经 /agents/:agentId/access 修改。
    return envelope('admin', await service.updateAgent({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }, expectedRevision), 'postgres')
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
  // S2 岗位权限：可见角色、岗位角色、数据范围属于 Agent，修改立即生效并记审计。
  router.get(`${basePath}/agents/:agentId/access`, async (_request, context) =>
    envelope('admin', await access.getAccess(context.params.agentId ?? ''), 'postgres'))
  router.patch(`${basePath}/agents/:agentId/access`, async (request, context) => {
    const input = await readJsonBody<Omit<UpdateAgentAccessInput, 'agentId' | 'actor'>>(request)
    if (typeof input?.expectedRevision !== 'number') {
      throw routeValidationFailed('缺少岗位权限修订号，请刷新后重试')
    }
    return envelope('admin', await access.updateAccess({
      ...input,
      agentId: context.params.agentId ?? '',
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
}
