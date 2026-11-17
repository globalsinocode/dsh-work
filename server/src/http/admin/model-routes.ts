import type { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type RouteContext, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

type WithoutActor<T extends (input: never) => unknown> = Omit<Parameters<T>[0], 'actor'>

/**
 * 服务层复核（功能规则第 13 节）：模型模块的写操作在数据库中按本地授予的
 * `admin:model:write` 再判定一次。冒烟服务没有数据库，不传入。
 */
type ModelAdminCheck = Pick<PostgresAuthorizationService, 'requireAdminModule'>

export function registerModelGovernanceRoutes(router: Router, service: ModelGovernanceService, authorization?: ModelAdminCheck) {
  const writer = async (context: RouteContext) => {
    const userId = requireRequestIdentity(context, 'admin').userId
    await authorization?.requireAdminModule(userId, 'model', 'write')
    return userId
  }
  router.get(`${basePath}/model-providers`, async () => envelope('admin', await service.listProviders()))
  router.post(`${basePath}/model-providers`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['createProvider']>>(request)
    return envelope('admin', await service.createProvider({ ...input, actor: await writer(context) }))
  })
  router.patch(`${basePath}/model-providers`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['updateProvider']>>(request)
    return envelope('admin', await service.updateProvider({ ...input, actor: await writer(context) }))
  })
  router.patch(`${basePath}/model-providers/status`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['setProviderStatus']>>(request)
    return envelope('admin', await service.setProviderStatus({ ...input, actor: await writer(context) }))
  })
  router.post(`${basePath}/model-providers/catalog`, async (request, context) => {
    await writer(context)
    const input = await readJsonBody<Parameters<ModelGovernanceService['listProviderModelCatalog']>[0]>(request)
    return envelope('admin', await service.listProviderModelCatalog(input))
  })
  router.post(`${basePath}/provider-models`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['createProviderModel']>>(request)
    return envelope('admin', await service.createProviderModel({ ...input, actor: await writer(context) }))
  })
  router.patch(`${basePath}/provider-models/status`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['setProviderModelStatus']>>(request)
    return envelope('admin', await service.setProviderModelStatus({ ...input, actor: await writer(context) }))
  })
  router.patch(`${basePath}/provider-models/capabilities`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['updateProviderModelCapabilities']>>(request)
    return envelope('admin', await service.updateProviderModelCapabilities({ ...input, actor: await writer(context) }))
  })
  router.delete(`${basePath}/provider-models/:modelId`, async (_request, context) => envelope('admin',
    await service.deleteProviderModel({ modelId: context.params.modelId ?? '', actor: await writer(context) })))
  router.patch(`${basePath}/model-providers/api-key`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['setProviderApiKey']>>(request)
    return envelope('admin', await service.setProviderApiKey({ ...input, actor: await writer(context) }))
  })
  router.get(`${basePath}/model-routes`, async () => envelope('admin', await service.listRoutes()))
  router.post(`${basePath}/model-routes`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['createRoute']>>(request)
    return envelope('admin', await service.createRoute({ ...input, actor: await writer(context) }))
  })
  router.patch(`${basePath}/model-routes`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['updateRoute']>>(request)
    return envelope('admin', await service.updateRoute({ ...input, actor: await writer(context) }))
  })
  router.post(`${basePath}/model-routes/resolve`, async (_request, context) => {
    await writer(context)
    return envelope('admin', await service.resolveDefaultRoute())
  })
}
