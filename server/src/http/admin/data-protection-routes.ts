import { accessDenied } from '../../domain/request-errors.ts'
import {
  DATA_PROTECTION_TERMS_BODY_BYTES,
  DATA_PROTECTION_TERMS_PERMISSION,
  normalizeAllowValue,
  normalizePreviewText,
  normalizeTermInputs,
  parseDataProtectionFilter,
  type DataProtectionAdminPort,
} from '../../domain/data-protection.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router, type RouteContext } from '../router.ts'

const basePath = '/api/admin/v1/data-protection'

/** 词表和白名单是机密内容：查看也需要单独授权，不默认给所有管理员（方案 5.8）。 */
function requireTermAccess(context: RouteContext) {
  const identity = requireRequestIdentity(context, 'admin')
  if (!identity.permissions.includes('admin:*') && !identity.permissions.includes(DATA_PROTECTION_TERMS_PERMISSION)) {
    throw accessDenied('当前用户没有数据防护词表权限')
  }
  return identity
}

export function registerDataProtectionRoutes(
  router: Router,
  service: DataProtectionAdminPort,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  router.get(`${basePath}/overview`, async (_request, context) =>
    envelope('admin', await service.getOverview(parseDataProtectionFilter(context.url.searchParams)), adapter))
  router.get(`${basePath}/records`, async (_request, context) => {
    const params = context.url.searchParams
    const page = clamp(Number(params.get('page') ?? 1), 1, 1_000_000, 1)
    const pageSize = clamp(Number(params.get('page_size') ?? 20), 1, 100, 20)
    return envelope('admin', await service.getRecords(parseDataProtectionFilter(params), page, pageSize), adapter)
  })
  router.post(`${basePath}/preview`, async (request, context) => {
    requireRequestIdentity(context, 'admin')
    const body = await readJsonBody<{ text?: unknown } | null>(request)
    return envelope('admin', await service.preview(normalizePreviewText(body?.text)), adapter)
  })

  router.get(`${basePath}/terms`, async (_request, context) => {
    requireTermAccess(context)
    return envelope('admin', await service.listTerms(), adapter)
  })
  router.post(`${basePath}/terms`, async (request, context) => {
    const identity = requireTermAccess(context)
    const body = await readJsonBody<{ terms?: unknown } | null>(request, DATA_PROTECTION_TERMS_BODY_BYTES)
    return envelope('admin', await service.addTerms(normalizeTermInputs(body?.terms), identity.userId), adapter)
  })
  router.delete(`${basePath}/terms/:id`, async (_request, context) => {
    const identity = requireTermAccess(context)
    return envelope('admin', await service.removeTerm(context.params['id'] ?? '', identity.userId), adapter)
  })

  router.get(`${basePath}/allowlist`, async (_request, context) => {
    requireTermAccess(context)
    return envelope('admin', await service.listAllowlist(), adapter)
  })
  router.post(`${basePath}/allowlist`, async (request, context) => {
    const identity = requireTermAccess(context)
    const body = await readJsonBody<{ value?: unknown } | null>(request)
    return envelope('admin', await service.addAllow(normalizeAllowValue(body?.value), identity.userId), adapter)
  })
  router.delete(`${basePath}/allowlist/:id`, async (_request, context) => {
    const identity = requireTermAccess(context)
    return envelope('admin', await service.removeAllow(context.params['id'] ?? '', identity.userId), adapter)
  })
}

function clamp(value: number, min: number, max: number, fallback: number) {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback
}
