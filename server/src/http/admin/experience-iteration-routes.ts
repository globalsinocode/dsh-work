import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { requestInvalid } from '../../domain/authorization-errors.ts'
import type {
  ExperienceIterationApplication,
  PostgresControlledMemoryService,
} from '../../modules/memory/postgres-controlled-memory-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1/experience-iterations'

export function registerAdminExperienceIterationRoutes(
  router: Router,
  service: PostgresControlledMemoryService,
  authorization: PostgresAuthorizationService,
): void {
  router.get(`${basePath}/agents`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requireAdminReader(identity.userId)
    return envelope('admin', await service.listExperienceIterationAgents(), 'postgres')
  })

  router.get(`${basePath}/applications`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requireAdminReader(identity.userId)
    const status = parseStatus(context.url.searchParams.get('status'))
    const agentId = context.url.searchParams.get('agentId')?.trim() || undefined
    return envelope('admin', await service.listExperienceIterationApplications(
      agentId,
      status,
    ), 'postgres')
  })

  router.post(`${basePath}/applications/:applicationId/review`, async (request, context) => {
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
    return envelope('admin', await service.reviewExperienceIterationApplication({
      applicationId: context.params['applicationId'] ?? '',
      decision: body.decision,
      actor: identity.userId,
      resolutionKey: body.resolutionKey.trim(),
      comment: typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) : undefined,
    }), 'postgres')
  })

  // AE-04：按 Agent 管理已发布经验的当前版本（停用、启用、回滚）。
  router.get(`${basePath}/agents/:agentId/experiences`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requireAdminReader(identity.userId)
    return envelope('admin', await service.listAgentExperiences(context.params['agentId'] ?? ''), 'postgres')
  })

  router.put(`${basePath}/agents/:agentId/experiences/:entryId/current`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    await authorization.requirePlatformAdmin(identity.userId)
    const body = await readJsonBody<{ versionId?: unknown; expectedVersionId?: unknown; reason?: unknown } | null>(request)
    const nullableId = (value: unknown) => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128)
    if (!body || !nullableId(body.versionId) || !nullableId(body.expectedVersionId)) {
      throw requestInvalid('versionId 与 expectedVersionId 必须是版本 ID 或 null')
    }
    if (typeof body.reason !== 'string') throw requestInvalid('reason 必填')
    return envelope('admin', await service.setAgentExperienceVersion({
      agentId: context.params['agentId'] ?? '',
      entryId: context.params['entryId'] ?? '',
      versionId: body.versionId as string | null,
      expectedVersionId: body.expectedVersionId as string | null,
      actor: identity.userId,
      reason: body.reason,
    }), 'postgres')
  })
}

function parseStatus(value: string | null): ExperienceIterationApplication['status'] | undefined {
  if (value === null) return undefined
  if (value === 'pending' || value === 'approved' || value === 'rejected') return value
  throw requestInvalid('status 不受支持')
}
