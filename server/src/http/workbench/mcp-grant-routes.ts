import type { IncomingMessage, ServerResponse } from 'node:http'

import { invalidRequest } from '../../domain/request-errors.ts'
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
  const settings = configuration.audiences.workbench
  return resolveRequestOrigin(request, settings)
}

/** 管理端 OAuth 探活结束后回到连接器页，避免员工台设置页与登记表单割裂。 */
function configuredAdminPortalOrigin() {
  const configuration = loadStartupIdentityConfiguration()
  const origin = configuration.audiences.admin.defaultOrigin
    ?? configuration.audiences.admin.allowedOrigins[0]
  if (!origin) {
    throw invalidRequest(
      '未配置管理端入口：请设置 DSH_WORK_ADMIN_ORIGINS 与 DSH_WORK_ADMIN_DEFAULT_ORIGIN',
    )
  }
  return origin.replace(/\/$/, '')
}

function redirectWithReason(baseUrl: string, extraQuery: Record<string, string>, reason?: string) {
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(extraQuery)) {
    url.searchParams.set(key, value)
  }
  if (reason?.trim()) {
    url.searchParams.set('reason', reason.trim().slice(0, 180))
  }
  return url.toString()
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
    const workbenchOrigin = workbenchPortalOrigin(request).replace(/\/$/, '')
    const adminOrigin = configuredAdminPortalOrigin()
    const phaseHint = state ? await grantService.oauthTransactionPhase(state) : null
    const probeFlow = phaseHint === 'probe'
    try {
      if (!code || !state) throw routeValidationFailed('OAuth 回调缺少 code 或 state')
      const flow = await grantService.completeAuthorization({ code, state, userId: identity.userId })
      const location = flow === 'probe'
        ? redirectWithReason(`${adminOrigin}/connectors`, { mcpProbe: 'connected' })
        : `${workbenchOrigin}/settings?mcpGrant=connected`
      response.writeHead(302, { Location: location })
      response.end()
      return
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'OAuth 回调未完成'
      const location = probeFlow
        ? redirectWithReason(`${adminOrigin}/connectors`, { mcpProbe: 'failed' }, reason)
        : redirectWithReason(`${workbenchOrigin}/settings`, { mcpGrant: 'failed' }, reason)
      response.writeHead(302, { Location: location })
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
