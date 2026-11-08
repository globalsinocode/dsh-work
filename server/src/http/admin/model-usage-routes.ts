import {
  parseModelUsageDimension,
  parseModelUsageFilter,
  type ModelUsageQueryPort,
} from '../../domain/model-usage.ts'
import { envelope, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

/** 管理端模型用量页：概况与趋势、按维度统计、执行明细（只读）。 */
export function registerModelUsageRoutes(router: Router, usage: ModelUsageQueryPort, adapter: 'postgres' | 'prototype-memory' = 'postgres') {
  router.get(`${basePath}/model-usage/overview`, async (_request, context) =>
    envelope('admin', await usage.getOverview(parseModelUsageFilter(context.url.searchParams)), adapter))
  router.get(`${basePath}/model-usage/breakdown`, async (_request, context) =>
    envelope('admin', await usage.getBreakdown(
      parseModelUsageFilter(context.url.searchParams),
      parseModelUsageDimension(context.url.searchParams.get('dimension')),
    ), adapter))
  router.get(`${basePath}/model-usage/executions`, async (_request, context) => {
    const params = context.url.searchParams
    const page = clamp(Number(params.get('page') ?? 1), 1, 1_000_000, 1)
    const pageSize = clamp(Number(params.get('page_size') ?? 20), 1, 100, 20)
    return envelope('admin', await usage.getExecutions(parseModelUsageFilter(params), page, pageSize), adapter)
  })
}

function clamp(value: number, min: number, max: number, fallback: number) {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback
}
