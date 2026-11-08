import type { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

type WithoutActor<T extends (input: never) => unknown> = Omit<Parameters<T>[0], 'actor'>

export function registerModelGovernanceRoutes(router: Router, service: ModelGovernanceService) {
  router.get(`${basePath}/model-providers`, async () => envelope('admin', await service.listProviders()))
  router.post(`${basePath}/model-providers`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['createProvider']>>(request)
    return envelope('admin', await service.createProvider({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/model-providers`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['updateProvider']>>(request)
    return envelope('admin', await service.updateProvider({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/model-providers/status`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['setProviderStatus']>>(request)
    return envelope('admin', await service.setProviderStatus({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.post(`${basePath}/model-providers/catalog`, async (request) => {
    const input = await readJsonBody<Parameters<ModelGovernanceService['listProviderModelCatalog']>[0]>(request)
    return envelope('admin', await service.listProviderModelCatalog(input))
  })
  router.post(`${basePath}/provider-models`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['createProviderModel']>>(request)
    return envelope('admin', await service.createProviderModel({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/provider-models/status`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['setProviderModelStatus']>>(request)
    return envelope('admin', await service.setProviderModelStatus({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/model-providers/api-key`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['setProviderApiKey']>>(request)
    return envelope('admin', await service.setProviderApiKey({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.get(`${basePath}/model-routes`, async () => envelope('admin', await service.listRoutes()))
  router.post(`${basePath}/model-routes`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['createRoute']>>(request)
    return envelope('admin', await service.createRoute({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/model-routes`, async (request, context) => {
    const input = await readJsonBody<WithoutActor<ModelGovernanceService['updateRoute']>>(request)
    return envelope('admin', await service.updateRoute({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.post(`${basePath}/model-routes/resolve`, async () => envelope('admin', await service.resolveDefaultRoute()))
}
