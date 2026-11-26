import {
  parseErrorGroupFilter,
  parseErrorRange,
  type ErrorRecordsQueryPort,
} from '../../domain/error-records.ts'
import { notFound } from '../../domain/request-errors.ts'
import { envelope, type Router } from '../router.ts'

const basePath = '/api/admin/v1/error-records'

/** 管理端“错误记录”页（安全与运维，模块 `ops` 只读；错误记录方案 6.5）。 */
export function registerErrorRecordsRoutes(router: Router, records: ErrorRecordsQueryPort, adapter: 'postgres' | 'prototype-memory' = 'postgres') {
  router.get(`${basePath}/groups`, async (_request, context) =>
    envelope('admin', await records.listGroups(parseErrorGroupFilter(context.url.searchParams)), adapter))
  router.get(`${basePath}/groups/:groupId`, async (_request, context) => {
    const detail = await records.getGroup(context.params.groupId!, parseErrorRange(context.url.searchParams.get('range')))
    if (!detail) throw notFound('没有找到该问题')
    return envelope('admin', detail, adapter)
  })
  router.get(`${basePath}/run-problems`, async (_request, context) =>
    envelope('admin', await records.runProblems(parseErrorRange(context.url.searchParams.get('range'))), adapter))
  router.get(`${basePath}/lookup`, async (_request, context) =>
    envelope('admin', await records.lookup(context.url.searchParams.get('q') ?? ''), adapter))
}
