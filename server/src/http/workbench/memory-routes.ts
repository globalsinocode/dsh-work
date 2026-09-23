import { requestInvalid } from '../../modules/authorization/authorization-errors.ts'
import type {
  MemoryKind,
  MemoryVisibility,
  PostgresControlledMemoryService,
} from '../../modules/memory/postgres-controlled-memory-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/workbench/v1/memory'

export function registerWorkbenchMemoryRoutes(router: Router, service: PostgresControlledMemoryService): void {
  router.get(`${basePath}/proposals`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const attemptId = new URL(request.url ?? '', 'http://localhost').searchParams.get('attemptId')
    if (!attemptId) throw requestInvalid('attemptId 必填')
    return envelope('workbench', await service.listOwnProposals(identity.userId, attemptId), 'postgres')
  })

  router.get(`${basePath}/consents`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await service.listOwnConsents(identity.userId), 'postgres')
  })

  router.post(`${basePath}/candidates`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<{
      attemptId?: unknown
      kind?: unknown
      title?: unknown
      content?: unknown
      visibility?: unknown
      retentionDays?: unknown
      proposalId?: unknown
    } | null>(request)
    if (!body) throw requestInvalid('请求体不能为空')
    const submissionKeyHeader = request.headers['idempotency-key']
    const submissionKey = Array.isArray(submissionKeyHeader) ? submissionKeyHeader[0] : submissionKeyHeader
    if (typeof submissionKey !== 'string' || !submissionKey.trim()) throw requestInvalid('Idempotency-Key 必填')
    const kind = parseKind(body.kind)
    const visibility = parseVisibility(body.visibility)
    if (typeof body.attemptId !== 'string' || !body.attemptId.trim()) throw requestInvalid('attemptId 必填')
    if (typeof body.title !== 'string') throw requestInvalid('title 必须是字符串')
    if (typeof body.content !== 'string') throw requestInvalid('content 必须是字符串')
    if (typeof body.retentionDays !== 'number') throw requestInvalid('retentionDays 必须是数字')
    if (body.proposalId !== undefined && typeof body.proposalId !== 'string') throw requestInvalid('proposalId 必须是字符串')
    const candidate = await service.submitCandidate({
      userId: identity.userId,
      attemptId: body.attemptId.trim(),
      submissionKey: submissionKey.trim(),
      kind,
      title: body.title,
      content: body.content,
      visibility,
      retentionDays: body.retentionDays,
      ...(body.proposalId ? { proposalId: body.proposalId } : {}),
    })
    return httpResult(201, envelope('workbench', candidate, 'postgres'))
  })

  router.post(`${basePath}/consents/:consentId/withdraw`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await service.withdrawConsent({
      userId: identity.userId,
      consentId: context.params['consentId'] ?? '',
    }), 'postgres')
  })
}

function parseKind(value: unknown): MemoryKind {
  if (value === 'preference' || value === 'experience') return value
  throw requestInvalid('kind 仅支持 preference 或 experience')
}

function parseVisibility(value: unknown): MemoryVisibility {
  if (value === 'private' || value === 'workspace' || value === 'organization') return value
  throw requestInvalid('visibility 仅支持 private、workspace 或 organization')
}
