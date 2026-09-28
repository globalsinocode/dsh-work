import type { PostgresAgentDataService, CollectionAction } from '../../modules/agent-data/postgres-agent-data-service.ts'
import { requestInvalid } from '../../modules/authorization/authorization-errors.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1/agent-data'
const tenantId = 'tenant-dsh-work'
const allowedActions = new Set<CollectionAction>(['query', 'propose', 'create', 'update', 'transition'])

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestInvalid('请求体必须为对象')
  return value as Record<string, unknown>
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw requestInvalid(`${name} 必填`)
  return value.trim()
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw requestInvalid(`${name} 必须为字符串数组`)
  return value
}

export function registerAdminAgentDataRoutes(router: Router, service: PostgresAgentDataService): void {
  router.get(`${basePath}/collections`, async (_request, context) => {
    const actor = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', { items: await service.listCollections(tenantId, actor) }, 'postgres')
  })

  router.post(`${basePath}/collections`, async (request, context) => {
    const body = object(await readJsonBody(request))
    const schema = object(body['schema'])
    const input = {
      tenantId, key: string(body['key'], '集合 key'), schema,
      queryFields: stringArray(body['queryFields'], 'queryFields'),
      retentionDays: body['retentionDays'] as number,
      actorUserId: requireRequestIdentity(context, 'admin').userId,
      ...(body['ownerWorkspaceId'] === undefined ? {} : { ownerWorkspaceId: string(body['ownerWorkspaceId'], 'ownerWorkspaceId') }),
      ...(body['privateAgentId'] === undefined ? {} : { privateAgentId: string(body['privateAgentId'], 'privateAgentId') }),
    }
    return httpResult(201, envelope('admin', { id: await service.publishCollection(input) }, 'postgres'))
  })

  router.patch(`${basePath}/collections/:collectionId/schema`, async (request, context) => {
    const body = object(await readJsonBody(request))
    const version = await service.evolveCollection({
      tenantId, collectionId: context.params['collectionId'] ?? '',
      expectedVersion: body['expectedVersion'] as number,
      schema: object(body['schema']), queryFields: stringArray(body['queryFields'], 'queryFields'),
      actorUserId: requireRequestIdentity(context, 'admin').userId,
    })
    return envelope('admin', { version }, 'postgres')
  })

  router.patch(`${basePath}/collections/:collectionId/status`, async (request, context) => {
    const body = object(await readJsonBody(request))
    if (body['status'] !== 'active' && body['status'] !== 'disabled') throw requestInvalid('集合状态无效')
    await service.setCollectionStatus({ tenantId, collectionId: context.params['collectionId'] ?? '',
      status: body['status'], actorUserId: requireRequestIdentity(context, 'admin').userId })
    return envelope('admin', { status: body['status'] }, 'postgres')
  })

  router.get(`${basePath}/collections/:collectionId/grants`, async (_request, context) => {
    const actor = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', { items: await service.listGrants(tenantId,
      context.params['collectionId'] ?? '', actor) }, 'postgres')
  })

  router.get(`${basePath}/collections/:collectionId/records`, async (_request, context) => {
    const after = context.url.searchParams.get('after') ?? undefined
    const limitText = context.url.searchParams.get('limit')
    const limit = limitText === null ? undefined : Number(limitText)
    return envelope('admin', await service.listRecordsForAdministration({ tenantId,
      collectionId: context.params['collectionId'] ?? '', actorUserId: requireRequestIdentity(context, 'admin').userId,
      after, limit }), 'postgres')
  })

  router.patch(`${basePath}/collections/:collectionId/grants/:agentId`, async (request, context) => {
    const body = object(await readJsonBody(request))
    const actions = stringArray(body['actions'], 'actions')
    if (actions.some(action => !allowedActions.has(action as CollectionAction))) throw requestInvalid('集合授权动作无效')
    await service.setGrant({ tenantId, collectionId: context.params['collectionId'] ?? '',
      agentId: context.params['agentId'] ?? '', actions: actions as CollectionAction[],
      actorUserId: requireRequestIdentity(context, 'admin').userId })
    return envelope('admin', { actions }, 'postgres')
  })

  router.get(`${basePath}/proposals`, async (_request, context) => {
    const status = context.url.searchParams.get('status')
    if (status && status !== 'pending' && status !== 'approved' && status !== 'rejected') throw requestInvalid('提案状态无效')
    const actor = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', { items: await service.listProposals(tenantId, actor, status as 'pending' | 'approved' | 'rejected' | undefined) }, 'postgres')
  })

  router.post(`${basePath}/proposals/:proposalId/review`, async (request, context) => {
    const body = object(await readJsonBody(request))
    if (body['decision'] !== 'approved' && body['decision'] !== 'rejected') throw requestInvalid('审核决定无效')
    return envelope('admin', await service.reviewProposal({ tenantId,
      proposalId: context.params['proposalId'] ?? '', decision: body['decision'],
      actorUserId: requireRequestIdentity(context, 'admin').userId }), 'postgres')
  })

  router.delete(`${basePath}/records/:recordId`, async (_request, context) => {
    await service.deleteRecord({ tenantId, recordId: context.params['recordId'] ?? '',
      actorUserId: requireRequestIdentity(context, 'admin').userId })
    return envelope('admin', { deleted: true }, 'postgres')
  })
}
