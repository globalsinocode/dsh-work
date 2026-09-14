import type { ToolDefinition } from '../../domain/types.ts'
import type { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerToolRoutes(router: Router, service: PostgresToolConnectorService) {
  router.get(`${basePath}/tools`, async () => envelope('admin', await service.getTools(), 'postgres'))
  router.get(`${basePath}/tools/catalog`, async () => envelope('admin', await service.getToolCatalog(), 'postgres'))
  router.post(`${basePath}/tools`, async (request, context) => {
    const input = await readJsonBody<{
      catalogId: string
      allowedRoles: string[]
      dataScopes: string[]
      approvalPolicy: ToolDefinition['approvalPolicy']
    }>(request)
    return envelope('admin', await service.addTool({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.patch(`${basePath}/tools/status`, async (request, context) => {
    const input = await readJsonBody<{
      toolId: string
      status: 'available' | 'disabled'
    }>(request)
    return envelope('admin', await service.setToolStatus({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.patch(`${basePath}/tools/permissions`, async (request, context) => {
    const input = await readJsonBody<{
      toolId: string
      allowedRoles: string[]
      dataScopes: string[]
      approvalPolicy: ToolDefinition['approvalPolicy']
    }>(request)
    return envelope('admin', await service.updateToolPermissions({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.get(`${basePath}/connectors`, async () => envelope('admin', await service.getConnectors(), 'postgres'))
  router.post(`${basePath}/connectors/check`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string }>(request)
    return envelope('admin', await service.checkConnector({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
}
