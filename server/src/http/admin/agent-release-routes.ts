import type { IncomingMessage } from 'node:http'

import type { PostgresAgentReleaseService, ReleaseEvalCase } from '../../modules/agent/postgres-agent-release-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'
const maxUploadBytes = 20 * 1024 * 1024

/**
 * Agent 发布工作台的服务端接口：候选提交（修订/案例/依赖）、检查、试运行、
 * 审核发布与 ZIP 发布包导入。替代前端原型 overlay 内存态。
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

  // GET 只读：候选创建/重绑/修订推进收敛到这个显式同步端点
  router.post(`${basePath}/agents/:agentId/release/candidate`, async (_request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await available().ensureCandidate(context.params['agentId'] ?? '', userId), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/release/checks`, async (_request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await available().runChecks(context.params['agentId'] ?? '', userId), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/release/cases`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ cases: ReleaseEvalCase[] }>(request)
    if (!Array.isArray(input?.cases)) throw Object.assign(new Error('cases 必须是数组'), { status: 422, code: 'validation_failed' })
    return envelope('admin', await available().updateCases(context.params['agentId'] ?? '', input.cases, userId), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/release/dependencies/remove`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ kind: 'skills' | 'tools'; reference: string }>(request)
    if (input?.kind !== 'skills' && input?.kind !== 'tools') throw Object.assign(new Error('kind 必须是 skills 或 tools'), { status: 422, code: 'validation_failed' })
    if (!input.reference?.trim()) throw Object.assign(new Error('缺少要移除的依赖引用'), { status: 422, code: 'validation_failed' })
    return envelope('admin', await available().removeMissingDependency(context.params['agentId'] ?? '', input.kind, input.reference.trim(), userId), 'postgres')
  })

  router.post(`${basePath}/agents/:agentId/release/trials`, async (_request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    return httpResult(201, envelope('admin', await available().startTrial(context.params['agentId'] ?? '', userId), 'postgres'))
  })

  // 试运行案例逐项确认：执行完毕停在 asserting，全部案例确认通过才记为 passed。
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

  router.post(`${basePath}/agents/:agentId/release/publish`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const input = await readJsonBody<{ note?: string }>(request)
    return envelope('admin', await available().publish(context.params['agentId'] ?? '', input?.note ?? '', userId), 'postgres')
  })

  router.post(`${basePath}/agent-packages/inspect`, async (request, context) => {
    requireRequestIdentity(context, 'admin')
    const fileName = decodeHeader(request, 'x-file-name')
    const bytes = await readBinaryBody(request, maxUploadBytes)
    return envelope('admin', await available().inspectPackage(fileName, bytes), 'postgres')
  })

  router.post(`${basePath}/agent-packages/import`, async (request, context) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    const fileName = decodeHeader(request, 'x-file-name')
    const bytes = await readBinaryBody(request, maxUploadBytes)
    return httpResult(201, envelope('admin', await available().importPackage(userId, fileName, bytes), 'postgres'))
  })
}

function decodeHeader(request: IncomingMessage, name: string) {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) throw Object.assign(new Error('缺少发布包文件名'), { status: 422, code: 'validation_failed' })
  try {
    return decodeURIComponent(value)
  } catch {
    throw Object.assign(new Error('发布包文件名编码无效'), { status: 422, code: 'validation_failed' })
  }
}

async function readBinaryBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > maxBytes) throw Object.assign(new Error('发布包超过 20 MB 限制'), { status: 422, code: 'validation_failed' })
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
