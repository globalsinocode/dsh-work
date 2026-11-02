import type { IncomingMessage } from 'node:http'

import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { maxKnowledgeUploadBytes, type KnowledgeBaseService } from '../../modules/knowledge/knowledge-base-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, routeValidationFailed, sessionAuthorizationContext, type Router } from '../router.ts'
import { writeDownload } from './content-routes.ts'

const basePath = '/api/workbench/v1'

type WorkbenchAccess = Pick<PostgresAuthorizationService, 'authorizeWorkbench'>

/**
 * 员工端“知识库”（weknora-knowledge-plan 第 8 节，WK-S2）。员工浏览器只访问这些接口，不直接访问
 * WeKnora；查看与管理权限全部在服务层按部门与三级权限码校验。
 */
export function registerKnowledgeRoutes(
  router: Router,
  knowledge: KnowledgeBaseService,
  authorization?: WorkbenchAccess,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  const identityOf = async (context: Parameters<Parameters<Router['get']>[1]>[1]) => {
    const identity = requireRequestIdentity(context, 'workbench')
    await authorization?.authorizeWorkbench({ userId: identity.userId, ...sessionAuthorizationContext(identity) })
    return identity.userId
  }
  const ok = <T>(data: T) => envelope('workbench', data, adapter)

  router.get(`${basePath}/knowledge/status`, async (_request, context) => ok(await knowledge.status(await identityOf(context))))

  router.get(`${basePath}/knowledge/departments`, async (_request, context) => ok(await knowledge.listDepartments(await identityOf(context))))

  router.get(`${basePath}/knowledge-bases`, async (_request, context) => ok(await knowledge.list(await identityOf(context), {
    withStats: context.url.searchParams.get('stats') !== 'false',
  })))

  router.post(`${basePath}/knowledge-bases`, async (request, context) => {
    const userId = await identityOf(context)
    const body = await readJsonBody<Record<string, unknown>>(request)
    return httpResult(201, ok(await knowledge.create(userId, {
      name: requireString(body.name, 'name'),
      description: optionalString(body.description, 'description'),
      ownerDepartmentId: requireString(body.ownerDepartmentId, 'ownerDepartmentId'),
      includeDescendants: optionalBoolean(body.includeDescendants, 'includeDescendants'),
    })))
  })

  router.get(`${basePath}/knowledge-bases/:knowledgeBaseId`, async (_request, context) =>
    ok(await knowledge.get(await identityOf(context), context.params['knowledgeBaseId'] ?? '', {
      withStats: context.url.searchParams.get('stats') !== 'false',
    })))

  router.patch(`${basePath}/knowledge-bases/:knowledgeBaseId`, async (request, context) => {
    const userId = await identityOf(context)
    const body = await readJsonBody<Record<string, unknown>>(request)
    return ok(await knowledge.update(userId, context.params['knowledgeBaseId'] ?? '', {
      name: optionalString(body.name, 'name'),
      description: optionalString(body.description, 'description'),
    }))
  })

  router.delete(`${basePath}/knowledge-bases/:knowledgeBaseId`, async (_request, context) => {
    await knowledge.remove(await identityOf(context), context.params['knowledgeBaseId'] ?? '')
    return ok({ deleted: true })
  })

  router.post(`${basePath}/knowledge-bases/:knowledgeBaseId/grants`, async (request, context) => {
    const userId = await identityOf(context)
    const body = await readJsonBody<Record<string, unknown>>(request)
    return ok(await knowledge.addGrant(userId, context.params['knowledgeBaseId'] ?? '', {
      departmentId: requireString(body.departmentId, 'departmentId'),
      includeDescendants: optionalBoolean(body.includeDescendants, 'includeDescendants'),
    }))
  })

  router.delete(`${basePath}/knowledge-bases/:knowledgeBaseId/grants/:grantId`, async (_request, context) =>
    ok(await knowledge.revokeGrant(await identityOf(context), context.params['knowledgeBaseId'] ?? '', context.params['grantId'] ?? '')))

  router.get(`${basePath}/knowledge-bases/:knowledgeBaseId/documents`, async (_request, context) => {
    const userId = await identityOf(context)
    const params = context.url.searchParams
    return ok(await knowledge.listDocuments(userId, context.params['knowledgeBaseId'] ?? '', {
      keyword: params.get('keyword') ?? undefined,
      status: params.get('status') ?? undefined,
      page: optionalInteger(params.get('page'), 'page'),
      pageSize: optionalInteger(params.get('pageSize'), 'pageSize'),
    }))
  })

  // 上传：请求体为文件原始字节，文件名放在 X-File-Name（URL 编码），与共享文件上传同一约定。
  router.post(`${basePath}/knowledge-bases/:knowledgeBaseId/documents`, async (request, context) => {
    const userId = await identityOf(context)
    const encodedName = headerValue(request, 'x-file-name')
    if (!encodedName) throw routeValidationFailed('缺少文件名')
    return httpResult(201, ok(await knowledge.uploadDocument(userId, context.params['knowledgeBaseId'] ?? '', {
      fileName: decodeHeader(encodedName),
      mimeType: headerValue(request, 'content-type') ?? 'application/octet-stream',
      read: () => readUpload(request),
    })))
  })

  router.patch(`${basePath}/knowledge-bases/:knowledgeBaseId/documents/:documentId`, async (request, context) => {
    const userId = await identityOf(context)
    const body = await readJsonBody<Record<string, unknown>>(request)
    await knowledge.updateDocument(userId, context.params['knowledgeBaseId'] ?? '', context.params['documentId'] ?? '', {
      title: requireString(body.title, 'title'),
    })
    return ok({ updated: true })
  })

  router.post(`${basePath}/knowledge-bases/:knowledgeBaseId/documents/:documentId/reparse`, async (_request, context) => {
    await knowledge.reparseDocument(await identityOf(context), context.params['knowledgeBaseId'] ?? '', context.params['documentId'] ?? '')
    return ok({ submitted: true })
  })

  router.delete(`${basePath}/knowledge-bases/:knowledgeBaseId/documents/:documentId`, async (_request, context) => {
    await knowledge.deleteDocument(await identityOf(context), context.params['knowledgeBaseId'] ?? '', context.params['documentId'] ?? '')
    return ok({ deleted: true })
  })

  router.get(`${basePath}/knowledge-bases/:knowledgeBaseId/documents/:documentId/download`, async (_request, context, response) => {
    const file = await knowledge.downloadDocument(await identityOf(context), context.params['knowledgeBaseId'] ?? '', context.params['documentId'] ?? '')
    writeDownload(response, file.fileName, file.mimeType, file.bytes)
  })

  router.get(`${basePath}/knowledge-bases/:knowledgeBaseId/documents/:documentId/preview`, async (_request, context) =>
    ok(await knowledge.previewDocument(await identityOf(context), context.params['knowledgeBaseId'] ?? '', context.params['documentId'] ?? '')))

  router.get(`${basePath}/sessions/:sessionId/knowledge-bases`, async (_request, context) =>
    ok(await knowledge.sessionKnowledgeBases(await identityOf(context), context.params['sessionId'] ?? '')))

  router.put(`${basePath}/sessions/:sessionId/knowledge-bases`, async (request, context) => {
    const userId = await identityOf(context)
    const body = await readJsonBody<Record<string, unknown>>(request)
    const ids = body.knowledgeBaseIds
    if (!Array.isArray(ids) || ids.some(item => typeof item !== 'string')) throw routeValidationFailed('knowledgeBaseIds 必须为字符串数组')
    return ok(await knowledge.setSessionKnowledgeBases(userId, context.params['sessionId'] ?? '', ids as string[]))
  })
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw routeValidationFailed(`${name} 必须为字符串`)
  return value
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, name)
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw routeValidationFailed(`${name} 必须为布尔值`)
  return value
}

function optionalInteger(value: string | null, name: string): number | undefined {
  if (value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number)) throw routeValidationFailed(`${name} 必须为整数`)
  return number
}

function headerValue(request: IncomingMessage, name: string) {
  const header = request.headers[name]
  return Array.isArray(header) ? header[0] : header
}

function decodeHeader(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw routeValidationFailed('文件名的编码无效')
  }
}

async function readUpload(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > maxKnowledgeUploadBytes) throw routeValidationFailed('文件超过 50 MB 限制')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
