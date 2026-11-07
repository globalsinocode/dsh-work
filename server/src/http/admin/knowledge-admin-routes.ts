import type { PostgresKnowledgeAdminService } from '../../modules/knowledge/postgres-knowledge-admin-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, routeValidationFailed, type Router } from '../router.ts'

const basePath = '/api/admin/v1/knowledge'

type KnowledgeAdminStore = Pick<
  PostgresKnowledgeAdminService,
  'overview' | 'updateConnection' | 'testConnection' | 'listBases' | 'departments'
  | 'createBase' | 'updateOwner' | 'addGrant' | 'revokeGrant' | 'deleteBase'
>

/**
 * 管理端“企业知识库”（weknora-knowledge-plan 第 9 节，WK-S3）。读取需要管理读权限，写入由服务层再按平台管理员
 * 校验。API Key 只写不读：读取接口只返回末四位与到期时间。
 */
export function registerKnowledgeAdminRoutes(
  router: Router,
  knowledge: KnowledgeAdminStore,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  const actor = (context: Parameters<typeof requireRequestIdentity>[0]) => requireRequestIdentity(context, 'admin').userId
  const ok = <T>(data: T) => envelope('admin', data, adapter)

  router.get(basePath, async () => ok(await knowledge.overview()))

  router.put(`${basePath}/connection`, async (request, context) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (typeof body.baseUrl !== 'string') throw routeValidationFailed('baseUrl 必须为字符串')
    if (typeof body.enabled !== 'boolean') throw routeValidationFailed('enabled 必须为布尔值')
    return ok(await knowledge.updateConnection(actor(context), {
      baseUrl: body.baseUrl,
      enabled: body.enabled,
      ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      ...(body.credentialExpiresAt === null || typeof body.credentialExpiresAt === 'string' ? { credentialExpiresAt: body.credentialExpiresAt } : {}),
      ...(body.embeddingModelId === null || typeof body.embeddingModelId === 'string' ? { embeddingModelId: body.embeddingModelId } : {}),
    }))
  })

  router.post(`${basePath}/connection/test`, async (request, context) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    return ok(await knowledge.testConnection(actor(context), {
      ...(typeof body.baseUrl === 'string' && body.baseUrl ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.apiKey === 'string' && body.apiKey ? { apiKey: body.apiKey } : {}),
    }))
  })

  router.get(`${basePath}/bases`, async () => ok(await knowledge.listBases()))

  router.get(`${basePath}/departments`, async () => ok(await knowledge.departments()))

  router.post(`${basePath}/bases`, async (request, context) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (typeof body.name !== 'string' || typeof body.ownerDepartmentId !== 'string') throw routeValidationFailed('name 与 ownerDepartmentId 必须为字符串')
    return ok(await knowledge.createBase(actor(context), {
      name: body.name,
      ownerDepartmentId: body.ownerDepartmentId,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
    }))
  })

  router.patch(`${basePath}/bases/:knowledgeBaseId`, async (request, context) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (typeof body.ownerDepartmentId !== 'string') throw routeValidationFailed('ownerDepartmentId 必须为字符串')
    return ok(await knowledge.updateOwner(actor(context), context.params['knowledgeBaseId'] ?? '', body.ownerDepartmentId))
  })

  router.delete(`${basePath}/bases/:knowledgeBaseId`, async (_request, context) =>
    ok(await knowledge.deleteBase(actor(context), context.params['knowledgeBaseId'] ?? '')))

  router.post(`${basePath}/bases/:knowledgeBaseId/grants`, async (request, context) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (typeof body.departmentId !== 'string') throw routeValidationFailed('departmentId 必须为字符串')
    if (body.includeDescendants !== undefined && typeof body.includeDescendants !== 'boolean') throw routeValidationFailed('includeDescendants 必须为布尔值')
    return ok(await knowledge.addGrant(actor(context), context.params['knowledgeBaseId'] ?? '', {
      departmentId: body.departmentId,
      ...(typeof body.includeDescendants === 'boolean' ? { includeDescendants: body.includeDescendants } : {}),
    }))
  })

  router.delete(`${basePath}/bases/:knowledgeBaseId/grants/:grantId`, async (_request, context) =>
    ok(await knowledge.revokeGrant(actor(context), context.params['knowledgeBaseId'] ?? '', context.params['grantId'] ?? '')))
}
