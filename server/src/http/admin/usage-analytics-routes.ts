import { notFound } from '../../domain/request-errors.ts'
import { parseUsageFilter, type UsageAnalyticsQueryPort } from '../../domain/usage-analytics.ts'
import { envelope, type Router } from '../router.ts'

const basePath = '/api/admin/v1/usage-analytics'

/** 管理端“运营概览”的使用情况（OBS-S2，模块 `ops` 只读）：汇总、按人明细与员工详情，不含对话内容。 */
export function registerUsageAnalyticsRoutes(router: Router, usage: UsageAnalyticsQueryPort, adapter: 'postgres' | 'prototype-memory' = 'postgres') {
  router.get(`${basePath}/overview`, async (_request, context) =>
    envelope('admin', await usage.overview(parseUsageFilter(context.url.searchParams)), adapter))
  router.get(`${basePath}/people`, async (_request, context) =>
    envelope('admin', await usage.people(parseUsageFilter(context.url.searchParams)), adapter))
  router.get(`${basePath}/people/:userId`, async (_request, context) => {
    const detail = await usage.person(context.params.userId!, parseUsageFilter(context.url.searchParams).range)
    if (!detail) throw notFound('该员工在所选期间内没有使用记录')
    return envelope('admin', detail, adapter)
  })
}
