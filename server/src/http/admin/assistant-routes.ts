import type { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

export function registerAssistantRoutes(router: Router, service?: AdminSkillInstallationService) {
  const base = '/api/admin/v1/assistant'
  const available = () => {
    if (!service) throw Object.assign(new Error('安装助手不可用：请配置 PostgreSQL 和 DSH Runtime'), { status: 503, code: 'assistant_unavailable' })
    return service
  }
  router.get(`${base}/sessions`, async (_request, context) => envelope('admin', await available().list(requireRequestIdentity(context, 'admin').userId), 'postgres'))
  router.get(`${base}/sessions/:id`, async (_request, context) => envelope('admin', await available().detail(requireRequestIdentity(context, 'admin').userId, context.params['id']!), 'postgres'))
  router.post(`${base}/messages`, async (request, context) => {
    const input = await readJsonBody<{ sessionId: string; message: string; requestId: string }>(request)
    return httpResult(202, envelope('admin', await available().send(requireRequestIdentity(context, 'admin').userId, input), 'postgres'))
  })
  router.post(`${base}/runs/:id/confirm`, async (request, context) => {
    const input = await readJsonBody<{ planSha256: string }>(request)
    return envelope('admin', await available().confirm(requireRequestIdentity(context, 'admin').userId, context.params['id']!, input?.planSha256), 'postgres')
  })
  router.post(`${base}/runs/:id/cancel`, async (_request, context) => envelope('admin', await available().cancel(requireRequestIdentity(context, 'admin').userId, context.params['id']!), 'postgres'))
  router.post(`${base}/runs/:id/retry`, async (_request, context) => envelope('admin', await available().retry(requireRequestIdentity(context, 'admin').userId, context.params['id']!), 'postgres'))
}
