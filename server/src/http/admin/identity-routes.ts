import type { IdentityAdministrationService } from '../../modules/identity/administration-service.ts'
import type { IdentityDirectorySyncService } from '../../modules/identity/directory-sync-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1/identity'

export function registerIdentityAdministrationRoutes(
  router: Router,
  administration: IdentityAdministrationService,
  directory?: IdentityDirectorySyncService | null,
) {
  router.get(`${basePath}/users`, async (_request, context) => {
    const page = await administration.listUsers({
      query: context.url.searchParams.get('query') ?? '',
      status: context.url.searchParams.get('status') ?? '',
      dingtalk: context.adminView === 'selector' ? '' : context.url.searchParams.get('dingtalk') ?? '',
      page: Number(context.url.searchParams.get('page') ?? undefined),
      pageSize: Number(context.url.searchParams.get('page_size') ?? undefined),
      nameOnly: context.adminView === 'selector',
    })
    // 只凭 Agent 修改权限读取时（选择主动任务接收人，管理端模块权限方案 5.2）只返回姓名与部门，
    // 不返回员工概况统计，也只按姓名搜索。
    if (context.adminView !== 'selector') return envelope('admin', page, 'postgres')
    return envelope('admin', {
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      items: page.items.map(({ id, name, department, status }) => ({ id, name, department, status, roles: [], departmentRoles: [] })),
    }, 'postgres')
  })

  router.get(`${basePath}/roles`, async (_request, context) => {
    const roles = await administration.listRoles()
    // 只凭 Skill 修改权限读取时（选择可见角色，方案 5.2）不返回角色的权限与数据范围。
    return envelope('admin', context.adminView === 'selector'
      ? roles.map(({ id, code, name, status }) => ({ id, code, name, status, permissions: [], dataScopes: [], userCount: 0 }))
      : roles, 'postgres')
  })
  router.get(`${basePath}/permissions`, () => envelope(
    'admin',
    administration.permissions(),
    'postgres',
  ))
  router.post(`${basePath}/roles`, async (request, context) => {
    const input = await readJsonBody<{
      code: string
      name: string
      description?: string
      permissions?: string[]
      dataScopes?: string[]
    }>(request)
    const actorId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await administration.createRole({ ...input, actorId }), 'postgres')
  })
  router.patch(`${basePath}/roles/:roleId`, async (request, context) => {
    const input = await readJsonBody<{
      name: string
      description?: string
      status: 'active' | 'disabled'
      permissions: string[]
      dataScopes: string[]
    }>(request)
    const actorId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await administration.updateRole({
      ...input,
      roleId: context.params.roleId ?? '',
      actorId,
    }), 'postgres')
  })
  router.post(`${basePath}/users/:userId/roles`, async (request, context) => {
    const input = await readJsonBody<{ roleId: string; validUntil?: string | null }>(request)
    const actorId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await administration.grantRole({
      ...input,
      userId: context.params.userId ?? '',
      actorId,
    }), 'postgres')
  })
  router.delete(`${basePath}/users/:userId/roles/:roleId`, async (_request, context) => {
    const actorId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await administration.revokeRole({
      userId: context.params.userId ?? '',
      roleId: context.params.roleId ?? '',
      actorId,
    }), 'postgres')
  })
  router.patch(`${basePath}/users/:userId/scopes`, async (request, context) => {
    const input = await readJsonBody<{ dataScopes: string[] }>(request)
    const actorId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await administration.replaceUserScopes({
      userId: context.params.userId ?? '',
      dataScopes: input.dataScopes,
      actorId,
    }), 'postgres')
  })
  router.post(`${basePath}/users/:userId/sessions/revoke`, async (_request, context) => {
    const actorId = requireRequestIdentity(context, 'admin').userId
    return envelope('admin', await administration.revokeSessions({
      userId: context.params.userId ?? '',
      actorId,
    }), 'postgres')
  })
  if (!directory) return
  router.get(`${basePath}/directory-sync`, async () => envelope(
    'admin',
    await directory.state(),
    'postgres',
  ))
  router.post(`${basePath}/directory-sync`, async (_request, context) => {
    const actorId = requireRequestIdentity(context, 'admin').userId
    await administration.requireIdentityWriter(actorId)
    return envelope('admin', await directory.synchronize({
      actorId,
      full: context.url.searchParams.get('full') === 'true',
    }), 'postgres')
  })
}
