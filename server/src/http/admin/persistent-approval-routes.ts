import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { requestInvalid } from '../../modules/authorization/authorization-errors.ts'
import type { PostgresPersistentWaitService } from '../../modules/run/postgres-persistent-wait-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

export function registerPersistentApprovalRoutes(
  router: Router,
  service: PostgresPersistentWaitService,
  authorization: PostgresAuthorizationService,
): void {
  router.get('/api/admin/v1/approvals', async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requireAdminReader(identity.userId)
    const status = context.url.searchParams.get('status') ?? undefined
    if (status !== undefined && !['pending', 'approved', 'rejected', 'expired', 'cancelled'].includes(status)) {
      throw requestInvalid('status 不受支持')
    }
    return envelope('admin', await service.list(status as Parameters<PostgresPersistentWaitService['list']>[0]), 'postgres')
  })
  router.get('/api/admin/v1/approvals/:approvalId', async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requireAdminReader(identity.userId)
    const approval = await service.get(context.params['approvalId'] ?? '')
    if (!approval) throw requestInvalid('审批不存在')
    return envelope('admin', approval, 'postgres')
  })
  router.post('/api/admin/v1/approvals/:approvalId/resolve', async (request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requirePlatformAdmin(identity.userId)
    const body = await readJsonBody<{ decision?: unknown; resolutionKey?: unknown; comment?: unknown } | null>(request)
    if (!body || (body.decision !== 'approved' && body.decision !== 'rejected')) throw requestInvalid('decision 仅支持 approved 或 rejected')
    if (typeof body.resolutionKey !== 'string' || !body.resolutionKey.trim()) throw requestInvalid('resolutionKey 必须是非空字符串')
    if (body.comment !== undefined && typeof body.comment !== 'string') throw requestInvalid('comment 必须是字符串')
    return envelope('admin', await service.resolve({
      approvalId: context.params['approvalId'] ?? '', decision: body.decision,
      actor: identity.userId, resolutionKey: body.resolutionKey.trim(),
      comment: typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) : undefined,
    }), 'postgres')
  })
}
