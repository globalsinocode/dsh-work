import type { RegisterMcpConnectorInput, TestMcpConnectionInput, ToolDefinition } from '../../domain/types.ts'
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
  router.get(`${basePath}/tools/bindings`, async () => envelope('admin', { items: await service.listToolBindings() }, 'postgres'))
  router.get(`${basePath}/connectors`, async () => envelope('admin', await service.getConnectors(), 'postgres'))
  router.get(`${basePath}/connectors/mcp/invocations`, async (_request, context) => envelope(
    'admin',
    await service.listMcpInvocationAudits(context.url.searchParams.get('connector_id') ?? ''),
    'postgres',
  ))
  router.post(`${basePath}/connectors/mcp/test`, async (request, context) => {
    const input = await readJsonBody<Omit<TestMcpConnectionInput, 'actor'>>(request)
    return envelope('admin', await service.testMcpConnection({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/connectors/mcp`, async (request, context) => {
    const input = await readJsonBody<Omit<RegisterMcpConnectorInput, 'actor'>>(request)
    return envelope('admin', await service.registerMcpConnector({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.delete(`${basePath}/connectors/mcp/:connectorId`, async (_request, context) => envelope(
    'admin',
    await service.deleteMcpConnector({
      connectorId: context.params['connectorId'] ?? '',
      actor: requireRequestIdentity(context, 'admin').userId,
    }),
    'postgres',
  ))
  router.patch(`${basePath}/connectors/mcp/credential`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string; bearerToken: string }>(request)
    return envelope('admin', await service.rotateMcpCredential({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/connectors/check`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string }>(request)
    return envelope('admin', await service.checkConnector({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/connectors/mcp/approve`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string; capabilityDigest: string }>(request)
    return envelope('admin', await service.approveMcpConnector({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.patch(`${basePath}/connectors/mcp/status`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string; status: 'enabled' | 'disabled' }>(request)
    return envelope('admin', await service.setMcpConnectorStatus({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.patch(`${basePath}/connectors/mcp/agent-access`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string; agentId: string; enabled: boolean }>(request)
    return envelope('admin', await service.setAgentMcpAccess({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
}
