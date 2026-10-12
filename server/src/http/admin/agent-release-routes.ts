import type { PostgresAgentReleaseService, ReleaseEvalCase } from '../../modules/agent/postgres-agent-release-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

/**
 * Agent 发布工作台的服务端接口：候选修订、检查、试运行、单次审核发布与
 * 发布证据。替代前端原型 overlay 内存态。
 */
export function registerAgentReleaseRoutes(router: Router, service?: PostgresAgentReleaseService) {
  const available = () => {
    if (!service) throw Object.assign(new Error('Agent 发布治理服务不可用：请配置 PostgreSQL'), { status: 503, code: 'agent_release_unavailable' })
    return service
  }

  router.get(`${basePath}/agent-release-submissions`, async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    return envelope('admin', { items: await available().listSubmissions() }, 'postgres')
  })

  router.get(`${basePath}/agent-version-evidence`, async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    return envelope('admin', { items: await available().listVersionEvidence() }, 'postgres')
  })

  router.get(`${basePath}/agents/:agentId/release`, async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    return envelope('admin', await available().getReleaseState(context.params['agentId'] ?? ''), 'postgres')
  })

  router.get(`${basePath}/agents/:agentId/versions/:versionId/package`, async (_request, context, response) => {
    requireRequestIdentity(context, 'admin')
    const agentId = context.params['agentId'] ?? ''
    const bytes = await available().exportVersionPackage(agentId, context.params['versionId'] ?? '')
    const fileName = `${agentId.replace(/[^A-Za-z0-9._-]/g, '_') || 'agent'}.zip`
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(bytes)
  })

  // GET 只读：候选创建/重绑/修订推进收敛到这个显式同步端点
  router.post(`${basePath}/agents/:agentId/release/candidate`, async (_request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await available().ensureCandidate(context.params['agentId'] ?? '', userId), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/release/cases`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ cases: ReleaseEvalCase[] }>(request)
    if (!Array.isArray(input?.cases)) throw Object.assign(new Error('cases 必须是数组'), { status: 422, code: 'validation_failed' })
    return envelope('admin', await available().updateCases(context.params['agentId'] ?? '', input.cases, userId), 'postgres')
  })

  // 独立路径作为逐项执行契约：新版页面连接旧服务时必须失败，不能落到旧版整轮派发入口。
  router.post(`${basePath}/agents/:agentId/release/case-trials`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ caseId?: string }>(request)
    if (typeof input?.caseId !== 'string' || !input.caseId.trim()) {
      throw Object.assign(new Error('caseId 不能为空'), { status: 422, code: 'validation_failed' })
    }
    return httpResult(201, envelope('admin', await available().startTrial(context.params['agentId'] ?? '', userId, input.caseId), 'postgres'))
  })

  router.post(`${basePath}/agents/:agentId/release/trials/:trialId/cases`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ caseId?: string; input?: string; rubric?: string }>(request)
    if (typeof input?.caseId !== 'string' || typeof input.input !== 'string' || typeof input.rubric !== 'string') {
      throw Object.assign(new Error('caseId、input、rubric 必须是字符串'), { status: 422, code: 'validation_failed' })
    }
    return envelope('admin', await available().continueTrialCase(
      context.params['agentId'] ?? '', context.params['trialId'] ?? '',
      { caseId: input.caseId, input: input.input, rubric: input.rubric }, userId,
    ), 'postgres')
  })

  // 每次只确认当前案例；全部案例完成后才记为 passed。
  router.post(`${basePath}/agents/:agentId/release/trials/:trialId/confirm`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ verdicts?: Array<{ caseId: string; verdict: 'passed' | 'failed'; note?: string }> }>(request)
    if (!Array.isArray(input?.verdicts)) throw Object.assign(new Error('verdicts 必须是数组'), { status: 422, code: 'validation_failed' })
    return envelope('admin', await available().confirmTrial(context.params['agentId'] ?? '', context.params['trialId'] ?? '', input.verdicts, userId), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/release/trials/:trialId/cancel`, async (_request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await available().cancelTrial(context.params['agentId'] ?? '', context.params['trialId'] ?? '', userId), 'postgres')
  })

  // 新候选试运行通过后直接审核并发布；既有 submitted 候选保留退回与撤回能力。
  router.post(`${basePath}/agents/:agentId/release/request-changes`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ note?: string }>(request)
    return envelope('admin', await available().requestChanges(context.params['agentId'] ?? '', input?.note ?? '', userId), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/release/withdraw`, async (_request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await available().withdrawSubmission(context.params['agentId'] ?? '', userId), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/release/publish`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ note?: string }>(request)
    return envelope('admin', await available().publish(context.params['agentId'] ?? '', input?.note ?? '', userId), 'postgres')
  })

}
