import type { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import type { PostgresGrantReconciliationService } from '../../modules/admin/application/postgres-grant-reconciliation-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerOperationsRoutes(
  router: Router,
  service: PostgresOperationsService,
  reconciliation?: PostgresGrantReconciliationService,
) {
  router.get(`${basePath}/tasks`, async () => envelope('admin', await service.getTaskSummaries(), 'postgres'))
  router.get(`${basePath}/runtimes`, async () => envelope('admin', await service.getRuntimes(), 'postgres'))
  router.get(`${basePath}/runtimes/configuration`, async () =>
    envelope('admin', await service.getRuntimePolicy('runtime-local-01'), 'postgres'))
  router.post(`${basePath}/runtimes/check`, async (request, context) => {
    const input = await readJsonBody<{ runtimeId: string }>(request)
    return envelope('admin', await service.checkRuntime({ ...input, actor: requireRequestIdentity(context, 'admin').userId }), 'postgres')
  })
  router.patch(`${basePath}/runtimes/configuration`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<PostgresOperationsService['updateRuntimeConfiguration']>[0], 'actor'>>(request)
    return envelope('admin', await service.updateRuntimeConfiguration({ ...input, actor: requireRequestIdentity(context, 'admin').userId }), 'postgres')
  })
  router.get(`${basePath}/sessions`, async (_request, context) => envelope('admin', await service.getSessions({
    query: context.url.searchParams.get('query') ?? undefined,
    status: context.url.searchParams.get('status') ?? undefined,
    workspace: context.url.searchParams.get('workspace') ?? undefined,
    page: Number(context.url.searchParams.get('page') ?? undefined),
    pageSize: Number(context.url.searchParams.get('page_size') ?? undefined),
  }), 'postgres'))
  router.get(`${basePath}/workspaces`, async () => envelope('admin', await service.getManagedWorkspaces(), 'postgres'))
  router.get(`${basePath}/audit-events`, async (_request, context) => envelope('admin', await service.getAuditEvents({
    query: context.url.searchParams.get('query') ?? undefined,
    status: context.url.searchParams.get('status') ?? undefined,
    category: context.url.searchParams.get('category') ?? undefined,
    page: Number(context.url.searchParams.get('page') ?? undefined),
    pageSize: Number(context.url.searchParams.get('page_size') ?? undefined),
  }), 'postgres'))
  router.get(`${basePath}/operations/summary`, async () =>
    envelope('admin', await service.getOperationsSummary(), 'postgres'))
  router.get(`${basePath}/operations/runs/:runId`, async (_request, context) =>
    envelope('admin', await service.getRunOperations(context.params.runId ?? ''), 'postgres'))
  router.get(`${basePath}/health`, async () => envelope('admin', await service.getHealth(), 'postgres'))
  router.get(`${basePath}/usage`, async () => envelope('admin', await service.getUsage(), 'postgres'))
  router.get(`${basePath}/model-usage`, async (_request, context) => envelope('admin', await service.getModelUsage(modelUsageQuery(context)), 'postgres'))
  router.get(`${basePath}/model-usage/employees`, async (_request, context) =>
    envelope('admin', await service.getModelUsageEmployees(modelUsageQuery(context)), 'postgres'))
  router.get(`${basePath}/platform-status`, async () => envelope('admin', await service.getPlatformStatus(), 'postgres'))
  // 1A-T7 授权来源对账清单（convergence §2 / plan 6.3）。仅在 postgres 适配器下注册。
  if (reconciliation) {
    router.get(`${basePath}/grant-sources/unresolved`, async () =>
      envelope('admin', await reconciliation.listUnresolvedSources(), 'postgres'))
    router.post(`${basePath}/grant-sources/reconcile`, async (request, context) => {
      const input = await readJsonBody<{ sourceIds: string[] }>(request)
      return envelope('admin', await reconciliation.reconcile({
        sourceIds: input.sourceIds,
        actor: requireRequestIdentity(context, 'admin').userId,
      }), 'postgres')
    })
  }
}

function modelUsageQuery(context: { url: URL }) {
  return {
    query: context.url.searchParams.get('query') ?? undefined,
    employee: context.url.searchParams.get('employee') ?? undefined,
    provider: context.url.searchParams.get('provider') ?? undefined,
    status: context.url.searchParams.get('status') ?? undefined,
    page: Number(context.url.searchParams.get('page') ?? undefined),
    pageSize: Number(context.url.searchParams.get('page_size') ?? undefined),
  }
}
