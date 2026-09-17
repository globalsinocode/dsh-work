import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WorkbenchQueryService } from '../../modules/workbench/application/workbench-query-service.ts'
import { envelope, requireRequestIdentity, type RouteContext, type Router } from '../router.ts'
import { writeDownload } from './content-routes.ts'

const basePath = '/api/workbench/v1'

export function registerWorkbenchRoutes(router: Router, service: WorkbenchQueryService) {
  router.get(`${basePath}/session`, async (_request, context) => envelope(
    'workbench',
    context.identity
      ? {
          user: context.identity.profile,
          identityProvider: context.identity.identityProvider,
          apiAudience: 'workbench' as const,
        }
      : await service.getSession(),
  ))
  router.get(`${basePath}/tasks`, async () => envelope('workbench', await service.getTasks()))
  router.get(`${basePath}/workspaces`, async () => envelope('workbench', await service.getWorkspaces()))
  router.get(`${basePath}/artifacts`, async () => envelope('workbench', await service.getArtifacts()))
  router.get(`${basePath}/agents`, async () => envelope('workbench', await service.getAgents()))
  router.get(`${basePath}/skills`, async () => envelope('workbench', await service.getSkills()))
}

/**
 * 仅在 Prototype 模式（无 PostgreSQL）注册：为 `mockArtifactFiles` 登记过的种子
 * 成果提供确定性字节，供下载与 HTML 预览；Postgres 模式下成果下载由
 * `registerContentRoutes` 经鉴权与读门禁处理，本函数不注册。
 *
 * P0 边界（刻意收窄，勿照搬到 Postgres）：Prototype 只有一个受控单用户身份，
 * 这里只校验 workbench 身份，不复核 workspace 成员关系；`:versionId` 仅为与
 * Postgres 路由形状对齐而接受，种子字节按 artifactId 索引、忽略版本参数。
 */
export function registerPrototypeArtifactFileRoutes(router: Router, service: WorkbenchQueryService) {
  const download = async (_request: IncomingMessage, context: RouteContext, response: ServerResponse) => {
    requireRequestIdentity(context, 'workbench')
    const file = await service.getArtifactFile(context.params['artifactId'] ?? '')
    writeDownload(response, file.name, file.mimeType, file.bytes)
  }
  router.get(`${basePath}/artifacts/:artifactId/download`, download)
  router.get(`${basePath}/artifacts/:artifactId/versions/:versionId/download`, download)
}
