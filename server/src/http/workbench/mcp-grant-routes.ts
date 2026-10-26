import type { IncomingMessage, ServerResponse } from 'node:http'

import { loadStartupIdentityConfiguration } from '../../modules/identity/config.ts'
import { resolveRequestOrigin } from '../../modules/identity/auth-service.ts'
import type { McpUserGrantService } from '../../modules/tool/mcp-user-grant-service.ts'
import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { normalizeAgentMcpScope } from '../../modules/tool/agent-mcp-scope.ts'
import {
  envelope,
  requireRequestIdentity,
  routeValidationFailed,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'

function workbenchPortalOrigin(request: IncomingMessage) {
  const configuration = loadStartupIdentityConfiguration()
  const settings = configuration.mode === 'oidc'
    ? configuration.audiences.workbench
    : configuration.audiences.workbench
  return resolveRequestOrigin(request, settings)
}

export function registerMcpGrantRoutes(
  router: Router,
  grantService: McpUserGrantService,
  toolService: PostgresToolConnectorService,
  agentService: PostgresAgentService,
) {
  router.get(`${basePath}/mcp-grants`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const page = Number(context.url.searchParams.get('page') ?? '1')
    const pageSize = Number(context.url.searchParams.get('pageSize') ?? '100')
    return envelope('workbench', await grantService.listForUser(identity.userId, page, pageSize), 'postgres')
  })

  router.post(`${basePath}/mcp-grants/:connectorId/authorization`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const connectorId = context.params['connectorId'] ?? ''
    const result = await grantService.beginAuthorization({
      connectorId,
      userId: identity.userId,
      portalOrigin: workbenchPortalOrigin(request),
    })
    return envelope('workbench', result, 'postgres')
  })

  router.get(`${basePath}/mcp-grants/callback`, async (request, context, response: ServerResponse) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const code = context.url.searchParams.get('code') ?? ''
    const state = context.url.searchParams.get('state') ?? ''
    const origin = workbenchPortalOrigin(request)
    const successLocation = `${origin.replace(/\/$/, '')}/settings?mcpGrant=connected`
    const failureLocation = `${origin.replace(/\/$/, '')}/settings?mcpGrant=failed`
    try {
      if (!code || !state) throw routeValidationFailed('OAuth 回调缺少 code 或 state')
      await grantService.completeAuthorization({ code, state, userId: identity.userId })
      response.writeHead(302, { Location: successLocation })
      response.end()
      return
    } catch {
      response.writeHead(302, { Location: failureLocation })
      response.end()
    }
  })

  router.delete(`${basePath}/mcp-grants/:connectorId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const connectorId = context.params['connectorId'] ?? ''
    return envelope('workbench', await grantService.revoke(identity.userId, connectorId), 'postgres')
  })

  router.get(`${basePath}/agents/:agentId/mcp-access`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const agentId = context.params['agentId'] ?? ''
    const versionId = await agentService.resolveActiveVersionId(agentId)
    const scope = normalizeAgentMcpScope(await toolService.readAgentMcpScope(versionId))
    const basePins = await toolService.resolveMcpConnectionsForAgentVersion(versionId)
    const applied = await toolService.applyUserGrants(basePins, scope.mode, identity.userId, { preview: true })
    return envelope('workbench', {
      blocked: applied.blocked,
      omitted: applied.omitted,
    }, 'postgres')
  })
}
