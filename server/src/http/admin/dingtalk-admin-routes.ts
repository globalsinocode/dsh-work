import type { IncomingMessage } from 'node:http'

import { IdentityAccessError } from '../../modules/identity/auth-service.ts'
import type { DingTalkAdministrationService } from '../../modules/identity/dingtalk/dingtalk-admin-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

/** 管理员代绑、解绑与“钉钉集成”页（钉钉接入方案 4.2 方式二、第 5 节）。只有平台管理员可用。 */
export function registerDingTalkAdminRoutes(router: Router, dingtalk: DingTalkAdministrationService) {
  const binding = '/api/admin/v1/identity/users/:userId/dingtalk-binding'
  const actor = (context: Parameters<typeof requireRequestIdentity>[0]) => requireRequestIdentity(context, 'admin').userId

  router.get(binding, async (_request, context) => envelope('admin', await dingtalk.getBinding(context.params.userId!, actor(context)), 'postgres'))
  router.post(`${binding}/preview`, async (request, context) =>
    envelope('admin', await dingtalk.preview(context.params.userId!, await readObject(request), actor(context)), 'postgres'))
  router.post(`${binding}/confirm`, async (request, context) =>
    envelope('admin', await dingtalk.confirm(context.params.userId!, await readObject(request), actor(context)), 'postgres'))
  router.delete(binding, async (_request, context) => envelope('admin', await dingtalk.unbind(
    context.params.userId!, { lockSelfRebind: context.url.searchParams.get('lock_self_rebind') === 'true' }, actor(context)), 'postgres'))
  router.post(`${binding}/unlock`, async (_request, context) => envelope('admin', await dingtalk.unlock(context.params.userId!, actor(context)), 'postgres'))

  const root = '/api/admin/v1/dingtalk'
  router.get(`${root}/settings`, async (_request, context) => envelope('admin', await dingtalk.getSettings(actor(context)), 'postgres'))
  router.put(`${root}/settings`, async (request, context) => envelope('admin', await dingtalk.saveSettings(await readObject(request), actor(context)), 'postgres'))
  router.delete(`${root}/settings`, async (_request, context) => envelope('admin', await dingtalk.clearSettings(actor(context)), 'postgres'))
  router.get(`${root}/overview`, async (_request, context) => envelope('admin', await dingtalk.overview(actor(context)), 'postgres'))
  router.post(`${root}/connection-check`, async (_request, context) => envelope('admin', await dingtalk.checkConnection(actor(context)), 'postgres'))
  router.get(`${root}/unbound`, async (_request, context) => envelope('admin', await dingtalk.listUnbound({
    page: Number(context.url.searchParams.get('page') ?? undefined),
    pageSize: Number(context.url.searchParams.get('page_size') ?? undefined),
  }, actor(context)), 'postgres'))
  router.post(`${root}/reminders`, async (request, context) => envelope('admin', await dingtalk.remind(await readObject(request), actor(context)), 'postgres'))
  router.post(`${root}/departure-checks/:runId/decision`, async (request, context) =>
    envelope('admin', await dingtalk.decideDepartureBatch(context.params.runId!, await readObject(request), actor(context)), 'postgres'))
}

async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const input = await readJsonBody<unknown>(request)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IdentityAccessError(422, 'invalid_request', '请求体必须为 JSON 对象')
  return input as Record<string, unknown>
}
