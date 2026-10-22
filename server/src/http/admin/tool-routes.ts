import type { RegisterMcpConnectorInput, TestMcpConnectionInput } from '../../domain/types.ts'
import type { PostgresMcpConnectorService } from '../../modules/tool/postgres-mcp-connector-service.ts'
import type { BuiltinToolStatus } from '../../modules/runtime/builtin-tools.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

/** MCP Connector 管理与内置工具只读展示；内置工具本身由代码注册表管理。 */
export function registerToolRoutes(router: Router, mcp: PostgresMcpConnectorService, builtinToolStatus: () => Promise<BuiltinToolStatus>) {
  router.get(`${basePath}/runtimes/builtin-tools`, async () => envelope('admin', await builtinToolStatus(), 'postgres'))
  router.get(`${basePath}/connectors`, async () => envelope('admin', await mcp.getMcpConnectors(), 'postgres'))
  router.get(`${basePath}/connectors/mcp/invocations`, async (_request, context) => envelope(
    'admin',
    await mcp.listMcpInvocationAudits(context.url.searchParams.get('connector_id') ?? ''),
    'postgres',
  ))
  router.post(`${basePath}/connectors/mcp/test`, async (request, context) => {
    const input = await readJsonBody<Omit<TestMcpConnectionInput, 'actor'>>(request)
    return envelope('admin', await mcp.testMcpConnection({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/connectors/mcp`, async (request, context) => {
    const input = await readJsonBody<Omit<RegisterMcpConnectorInput, 'actor'>>(request)
    return envelope('admin', await mcp.registerMcpConnector({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.delete(`${basePath}/connectors/mcp/:connectorId`, async (_request, context) => envelope(
    'admin',
    await mcp.deleteMcpConnector({
      connectorId: context.params['connectorId'] ?? '',
      actor: requireRequestIdentity(context, 'admin').userId,
    }),
    'postgres',
  ))
  router.patch(`${basePath}/connectors/mcp/credential`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string; bearerToken: string }>(request)
    return envelope('admin', await mcp.rotateMcpCredential({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/connectors/check`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string }>(request)
    return envelope('admin', await mcp.checkMcpConnector({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/connectors/mcp/capabilities/approve`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string; capabilityDigest: string }>(request)
    return envelope('admin', await mcp.approveMcpCapabilities({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.patch(`${basePath}/connectors/mcp/status`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string; status: 'enabled' | 'disabled' }>(request)
    return envelope('admin', await mcp.setMcpConnectorStatus({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
}
