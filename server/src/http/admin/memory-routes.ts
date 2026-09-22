import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { requestInvalid } from '../../modules/authorization/authorization-errors.ts'
import type {
  MemoryCandidateStatus,
  PostgresControlledMemoryService,
} from '../../modules/memory/postgres-controlled-memory-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1/memory'

export function registerAdminMemoryRoutes(
  router: Router,
  service: PostgresControlledMemoryService,
  authorization: PostgresAuthorizationService,
): void {
  router.get(`${basePath}/candidates`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requireAdminReader(identity.userId)
    const rawStatus = context.url.searchParams.get('status')
    const status = rawStatus === null ? undefined : parseStatus(rawStatus)
    return envelope('admin', await service.listCandidates(status), 'postgres')
  })

  router.post(`${basePath}/candidates/:candidateId/review`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requirePlatformAdmin(identity.userId)
    const body = await readJsonBody<{
      decision?: unknown
      resolutionKey?: unknown
      comment?: unknown
    } | null>(request)
    if (!body || (body.decision !== 'approved' && body.decision !== 'rejected')) {
      throw requestInvalid('decision 仅支持 approved 或 rejected')
    }
    if (typeof body.resolutionKey !== 'string' || !body.resolutionKey.trim()) throw requestInvalid('resolutionKey 必填')
    if (body.comment !== undefined && typeof body.comment !== 'string') throw requestInvalid('comment 必须是字符串')
    return envelope('admin', await service.reviewCandidate({
      candidateId: context.params['candidateId'] ?? '',
      decision: body.decision,
      actor: identity.userId,
      resolutionKey: body.resolutionKey.trim(),
      comment: typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) : undefined,
    }), 'postgres')
  })
}

function parseStatus(value: string): MemoryCandidateStatus {
  if (value === 'pending' || value === 'approved' || value === 'rejected' || value === 'withdrawn') return value
  throw requestInvalid('status 不受支持')
}
