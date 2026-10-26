import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { PostgresAgentValidationService } from '../../modules/agent/agent-validation-service.ts'
import type { PostgresAgentRunHistory } from '../../modules/agent/agent-run-history.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'
import { RequestError } from '../../domain/request-errors.ts'

const basePath = '/api/admin/v1'

/**
 * S3 验证与发布：冻结草稿为待发布版本、后台并行运行案例、逐项判定、发布。
 * 修改类接口只返回状态，运行进度由前端轮询 GET 接口获取。
 */
export function registerAgentValidationRoutes(
  router: Router,
  agents: PostgresAgentService,
  service?: PostgresAgentValidationService,
  runs?: PostgresAgentRunHistory,
) {
  const available = () => {
    if (!service) throw new RequestError(503, 'agent_validation_unavailable', 'Agent 验证服务不可用：请配置 PostgreSQL')
    return service
  }
  const agentId = (context: { params: Record<string, string | undefined> }) => context.params['agentId'] ?? ''

  router.get(`${basePath}/agents/:agentId`, async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    const id = agentId(context)
    const agent = (await agents.getAgents()).find(item => item.id === id)
    if (!agent) throw new RequestError(404, 'not_found', `Agent 不存在：${id}`)
    return envelope('admin', { agent, release: await available().getOverview(id) }, 'postgres')
  })

  router.get(`${basePath}/agents/:agentId/runs`, async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    if (!runs) throw new RequestError(503, 'agent_runs_unavailable', 'Agent 运行记录不可用：请配置 PostgreSQL')
    const limit = Number(context.url.searchParams.get('limit') ?? 20)
    return envelope('admin', { items: await runs.listRecentRuns(agentId(context), limit) }, 'postgres')
  })

  router.get(`${basePath}/agents/:agentId/versions`, async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    return envelope('admin', { items: await available().listVersions(agentId(context)) }, 'postgres')
  })

  router.put(`${basePath}/agents/:agentId/test-cases`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ prompts: unknown }>(request)
    return envelope('admin', await available().replaceTestCases(agentId(context), userId, input?.prompts), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/validations`, async (_request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    return httpResult(202, envelope('admin', await available().startValidation(agentId(context), userId), 'postgres'))
  })

  router.get(`${basePath}/agents/:agentId/validations/:validationId`, async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    return envelope('admin', await available().getValidation(agentId(context), context.params['validationId'] ?? ''), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/validations/:validationId/cases/:caseId/rerun`, async (_request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await available().rerunCase(
      agentId(context), context.params['validationId'] ?? '', context.params['caseId'] ?? '', userId,
    ), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/validations/:validationId/cases/:caseId/verdict`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ verdict: unknown; note?: unknown }>(request)
    return envelope('admin', await available().setVerdict(
      agentId(context), context.params['validationId'] ?? '', context.params['caseId'] ?? '', userId, input ?? { verdict: null },
    ), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/publish`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ validationId: unknown; note?: unknown }>(request)
    return envelope('admin', await available().publish(agentId(context), userId, input ?? { validationId: null }), 'postgres')
  })
}
