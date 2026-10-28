import type { PostgresAgentAccessService } from '../../modules/agent/agent-access-service.ts'
import { invalidRequest } from '../../domain/request-errors.ts'
import { readJsonBody, envelope, httpResult, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

/**
 * S2 岗位权限：Agent 的可见角色、岗位角色、数据范围与执行身份状态。
 *
 * 这三项都属于 Agent 而非版本，页面用 `revision` 做乐观并发。客户端
 * （`apps/admin-web/src/api/client.ts` 的 `getAgentAccess` / `updateAgentAccess`）
 * 一直在调用这两个接口，但合并后没有任何路由注册，管理端「岗位权限」页在生产
 * 只能拿到 404；服务层的读、写与冲突校验都已在 `PostgresAgentAccessService` 内。
 */
export function registerAgentAccessRoutes(router: Router, access: PostgresAgentAccessService) {
  router.get(`${basePath}/agents/:agentId/access`, async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    const agentId = context.params['agentId'] ?? ''
    return envelope('admin', await access.getAccess(agentId), 'postgres')
  })

  router.patch(`${basePath}/agents/:agentId/access`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    const agentId = context.params['agentId'] ?? ''
    const body = await readJsonBody<Record<string, unknown>>(request)
    // 缺字段一律 422：可见角色/岗位角色/数据范围是「整体替换」语义，不能用缺省值
    // 悄悄清空管理端刚配置的授权。
    const list = (key: string) => {
      const value = body[key]
      if (!Array.isArray(value)) throw invalidRequest(`${key} 必须是数组`)
      return value.map(item => {
        if (typeof item !== 'string') throw invalidRequest(`${key} 必须是字符串数组`)
        return item
      })
    }
    const expectedRevision = body['expectedRevision']
    if (typeof expectedRevision !== 'number') throw invalidRequest('缺少岗位权限修订号，请刷新后重试')
    const principalStatus = body['principalStatus']
    if (principalStatus !== undefined && principalStatus !== 'active' && principalStatus !== 'disabled') {
      throw invalidRequest('执行身份状态无效')
    }
    return httpResult(200, envelope('admin', await access.updateAccess({
      agentId,
      actor: identity.userId,
      expectedRevision,
      visibleRoleIds: list('visibleRoleIds'),
      roleIds: list('roleIds'),
      dataScopes: list('dataScopes'),
      ...(principalStatus === undefined ? {} : { principalStatus }),
    }), 'postgres'))
  })
}
