import type { IdentityAdministrationService } from '../../modules/identity/administration-service.ts'
import type { IdentityDirectorySyncService } from '../../modules/identity/directory-sync-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1/identity'

export function registerIdentityAdministrationRoutes(
  router: Router,
  administration: IdentityAdministrationService,
  directory?: IdentityDirectorySyncService | null,
) {
  router.get(`${basePath}/users`, async (_request, context) => envelope('admin', await administration.listUsers({
    query: context.url.searchParams.get('query') ?? '',
    status: context.url.searchParams.get('status') ?? '',
    page: Number(context.url.searchParams.get('page') ?? undefined),
    pageSize: Number(context.url.searchParams.get('page_size') ?? undefined),
  }), 'postgres'))

  router.get(`${basePath}/roles`, async () => envelope(
    'admin',
    await administration.listRoles(),
    'postgres',
  ))
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
    return envelope('admin', await directory.synchronize({
      actorId,
      full: context.url.searchParams.get('full') === 'true',
    }), 'postgres')
  })
}
