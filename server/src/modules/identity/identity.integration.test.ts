import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import { IdentityAdministrationService } from './administration-service.ts'
import { IdentityDirectorySyncService } from './directory-sync-service.ts'
import { SecretBox, hashOpaque, randomOpaque } from './secure-values.ts'
import { IdentitySessionRepository } from './session-repository.ts'
import type { OidcIdentityConfiguration } from './types.ts'

const suffix = randomUUID()
const subject = `ai-hub-integration-${suffix}`
const externalUserId = `ai-user-${suffix}`
const applicationId = `dsh-work-test-${suffix}`
let localUserId = ''
let directoryUserId = ''
let backupAdminUserId = ''
let legacyUserId = ''
let database: DatabaseClient
let throwaway: ThrowawayDatabase
let repository: IdentitySessionRepository
let administration: IdentityAdministrationService

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据影响目录同步与授权断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_identity_test', maxConnections: 4 })
  database = throwaway.client
  repository = new IdentitySessionRepository(database)
  administration = new IdentityAdministrationService(database)
})

after(async () => {
  // 整套用例使用一次性数据库，销毁数据库即可清理所有测试用户及关联数据。
  if (throwaway) await throwaway.dispose()
})

test('identity-owned authorization migration installs mapping, bootstrap and sync state', async () => {
  const [record] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from information_schema.columns
     where table_schema = 'public'
       and (
         (table_name = 'users' and column_name = 'external_user_id')
         or (table_name = 'users' and column_name = 'local_authorization_version')
         or (table_name = 'users' and column_name = 'business_user')
         or (table_name = 'roles' and column_name = 'status')
         or (table_name = 'identity_directory_sync_state' and column_name = 'cursor')
         or (table_name = 'application_admin_bootstrap_claims' and column_name = 'consumed_at')
       )
  `
  assert.equal(record?.count, 6)
})

test('OIDC login transaction is short-lived and can only be consumed once', async () => {
  const transactionToken = randomOpaque()
  const transactionHash = hashOpaque(transactionToken)
  await repository.createLoginTransaction({
    transactionHash,
    audience: 'workbench',
    stateHash: hashOpaque('state-value'),
    codeVerifierEncrypted: 'encrypted-code-verifier',
    nonce: 'nonce-value',
    returnTo: 'http://localhost:4174/workbench',
    portalOrigin: 'http://localhost:4174',
    redirectUri: 'http://localhost:4190/auth/workbench/callback',
    expiresAt: new Date(Date.now() + 60_000),
  })

  const consumed = await repository.consumeLoginTransaction(transactionHash, 'workbench')
  assert.equal(consumed?.nonce, 'nonce-value')
  assert.equal(consumed?.portalOrigin, 'http://localhost:4174')
  assert.equal(consumed?.redirectUri, 'http://localhost:4190/auth/workbench/callback')
  assert.equal(await repository.consumeLoginTransaction(transactionHash, 'workbench'), null)
})

test('AI Hub sync upgrades a legacy subject mapping without losing local roles', async () => {
  legacyUserId = `legacy-user-${suffix}`
  const legacySubject = `legacy-subject-${suffix}`
  const legacyExternalUserId = `legacy-external-user-${suffix}`
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status
    ) values (
      ${legacyUserId}, 'tenant-dsh-work', ${legacySubject}, '旧身份用户', '旧部门', 'active'
    )
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key, granted_by)
    values ('tenant-dsh-work', ${legacyUserId}, 'role-employee', 'local', 'U00008')
  `

  const synchronized = await repository.synchronizeIdentity({
    externalUserId: legacyExternalUserId,
    subject: legacySubject,
    displayName: '升级后的身份用户',
    email: 'legacy-upgraded@example.invalid',
    organizationName: '新部门',
    businessUser: true,
    status: 'ACTIVE',
  })

  assert.equal(synchronized.userId, legacyUserId)
  const [upgraded] = await database<{
    identityProvider: string
    externalUserId: string | null
    name: string
  }[]>`
    select identity_provider as "identityProvider", external_user_id as "externalUserId",
           display_name as name
      from users
     where tenant_id = 'tenant-dsh-work' and id = ${legacyUserId}
  `
  assert.equal(upgraded?.identityProvider, 'ai-hub')
  assert.equal(upgraded?.externalUserId, legacyExternalUserId)
  assert.equal(upgraded?.name, '升级后的身份用户')
  assert.ok((await repository.resolveAuthorization(legacyUserId)).permissions.includes('workbench:use'))
})

test('AI Hub profile sync preserves local authorization and sessions use local versions', async () => {
  const synchronized = await repository.synchronizeIdentity({
    externalUserId,
    subject,
    displayName: 'SSO 集成用户',
    email: 'sso-integration@example.invalid',
    organizationName: '集成测试组织',
    businessUser: true,
    status: 'ACTIVE',
  })
  localUserId = synchronized.userId
  assert.notEqual(localUserId, externalUserId)
  assert.deepEqual((await repository.resolveAuthorization(localUserId)).roleIds, [])

  await administration.grantRole({
    userId: localUserId,
    roleId: 'role-employee',
    actorId: 'U00008',
  })
  await administration.replaceUserScopes({
    userId: localUserId,
    dataScopes: ['region:east'],
    actorId: 'U00008',
  })
  const authorization = await repository.resolveAuthorization(localUserId)
  assert.ok(authorization.permissions.includes('workbench:use'))
  assert.ok(authorization.dataScopes.includes('region:east'))

  const sessionToken = randomOpaque()
  const secretBox = new SecretBox('integration-session-secret-with-at-least-32-characters')
  const accessTokenEncrypted = secretBox.seal('access-token-value')
  const refreshTokenEncrypted = secretBox.seal('refresh-token-value')
  const sessionHash = hashOpaque(sessionToken)
  await repository.createSession({
    sessionHash,
    audience: 'workbench',
    userId: localUserId,
    accessTokenEncrypted,
    refreshTokenEncrypted,
    tokenExpiresAt: new Date(Date.now() + 300_000),
    authorizationVersion: authorization.authorizationVersion,
    expiresAt: new Date(Date.now() + 600_000),
  })

  const stored = await repository.findSession(sessionHash, 'workbench')
  assert.equal(stored?.subject, subject)
  assert.equal(secretBox.open(stored?.accessTokenEncrypted ?? ''), 'access-token-value')
  assert.notEqual(stored?.accessTokenEncrypted, 'access-token-value')
  const [loginAudit] = await database<{ count: number }[]>`
    select count(*)::integer as count from audit_events
     where actor_id = ${localUserId} and action = 'identity.login' and result = 'success'
  `
  assert.equal(loginAudit?.count, 1)

  await repository.synchronizeIdentity({
    externalUserId,
    subject: `${subject}-rotated`,
    displayName: '同步后的员工姓名',
    email: 'updated@example.invalid',
    organizationName: '更新后的组织',
    businessUser: true,
    status: 'ACTIVE',
    updatedAt: new Date().toISOString(),
  })
  const afterProfileSync = await repository.resolveAuthorization(localUserId)
  assert.ok(afterProfileSync.roleIds.includes('role-employee'))
  assert.ok(afterProfileSync.dataScopes.includes('region:east'))
  assert.equal(afterProfileSync.profile.name, '同步后的员工姓名')

  await repository.consumeAdminBootstrap({
    applicationId,
    environment: 'local',
    externalUserId,
    userId: localUserId,
    consumedAt: new Date(),
  })
  await repository.consumeAdminBootstrap({
    applicationId,
    environment: 'local',
    externalUserId,
    userId: localUserId,
    consumedAt: new Date(),
  })
  const adminAuthorization = await repository.resolveAuthorization(localUserId)
  assert.ok(adminAuthorization.permissions.includes('admin:*'))
  const [bootstrapAudit] = await database<{ count: number }[]>`
    select count(*)::integer as count from audit_events
     where actor_id = ${localUserId} and action = 'identity.admin_bootstrap'
  `
  assert.equal(bootstrapAudit?.count, 1, 'idempotent bootstrap retries produce one grant audit')
  const listed = await administration.listUsers({
    query: '同步后的员工姓名',
    status: 'active',
    page: 1,
    pageSize: 10,
  })
  assert.equal(listed.items[0]?.id, localUserId)
  assert.equal(listed.total, 1)
  assert.equal(listed.pageSize, 10)
  assert.ok(listed.summary.synchronized >= 1)
  assert.ok(listed.summary.active >= 1)
  assert.ok(listed.summary.authorized >= 1)
  await assert.rejects(
    administration.revokeRole({
      userId: localUserId,
      roleId: 'role-platform-admin',
      actorId: localUserId,
    }),
    /不能移除最后一个有效的平台管理员/,
  )
  const backupAdmin = await repository.synchronizeIdentity({
    externalUserId: `backup-admin-${suffix}`,
    subject: `backup-admin-subject-${suffix}`,
    displayName: '备用平台管理员',
    email: 'backup-admin@example.invalid',
    organizationName: '集成测试组织',
    businessUser: true,
    status: 'ACTIVE',
  })
  backupAdminUserId = backupAdmin.userId
  await assert.rejects(
    administration.grantRole({
      userId: backupAdminUserId,
      roleId: 'role-platform-admin',
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      actorId: localUserId,
    }),
    /平台管理员角色不能设置有效期/,
  )
  await administration.grantRole({
    userId: backupAdminUserId,
    roleId: 'role-platform-admin',
    actorId: localUserId,
  })
  await administration.revokeRole({
    userId: localUserId,
    roleId: 'role-platform-admin',
    actorId: backupAdminUserId,
  })
  assert.equal(
    (await repository.resolveAuthorization(localUserId)).permissions.includes('admin:*'),
    false,
  )
  assert.equal(await repository.consumeAdminBootstrap({
    applicationId,
    environment: 'local',
    externalUserId,
    userId: localUserId,
    consumedAt: new Date(),
  }), false)
  assert.equal(
    (await repository.resolveAuthorization(localUserId)).permissions.includes('admin:*'),
    false,
    'OIDC bootstrap retry must not resurrect a locally revoked administrator',
  )

  await administration.grantRole({
    userId: localUserId,
    roleId: 'role-platform-admin',
    actorId: backupAdminUserId,
  })
  const concurrentRevocations = await Promise.allSettled([
    administration.revokeRole({
      userId: localUserId,
      roleId: 'role-platform-admin',
      actorId: backupAdminUserId,
    }),
    administration.revokeRole({
      userId: backupAdminUserId,
      roleId: 'role-platform-admin',
      actorId: localUserId,
    }),
  ])
  assert.equal(
    concurrentRevocations.filter(result => result.status === 'fulfilled').length,
    1,
  )
  const rejectedRevocation = concurrentRevocations.find(result => result.status === 'rejected')
  assert.ok(rejectedRevocation && rejectedRevocation.status === 'rejected')
  assert.match(String(rejectedRevocation.reason), /不能移除最后一个有效的平台管理员/)
  const remainingAdministrators = await Promise.all([
    repository.resolveAuthorization(localUserId),
    repository.resolveAuthorization(backupAdminUserId),
  ])
  assert.equal(
    remainingAdministrators.filter(result => result.permissions.includes('admin:*')).length,
    1,
  )

  const access = await new PostgresAuthorizationService(database).authorizeWorkbench({
    userId: localUserId,
    roleIds: adminAuthorization.roleIds,
    dataScopes: adminAuthorization.dataScopes,
  })
  assert.ok(access.permissions.includes('workbench:use'))

  let refreshCalls = 0
  const rotatedAccessToken = secretBox.seal('rotated-access-token')
  const refreshOnce = async (latest: NonNullable<typeof stored>) => {
    if (latest.accessTokenEncrypted === rotatedAccessToken) return null
    refreshCalls += 1
    await new Promise(resolve => setTimeout(resolve, 25))
    return {
      accessTokenEncrypted: rotatedAccessToken,
      refreshTokenEncrypted: latest.refreshTokenEncrypted,
      tokenExpiresAt: new Date(Date.now() + 300_000),
    }
  }
  const [firstRefresh, secondRefresh] = await Promise.all([
    repository.refreshTokensWithLock(sessionHash, 'workbench', refreshOnce),
    repository.refreshTokensWithLock(sessionHash, 'workbench', refreshOnce),
  ])
  assert.equal(refreshCalls, 1)
  assert.equal(firstRefresh?.accessTokenEncrypted, rotatedAccessToken)
  assert.equal(secondRefresh?.accessTokenEncrypted, rotatedAccessToken)

  await repository.synchronizeIdentity({
    externalUserId,
    subject: `${subject}-rotated`,
    displayName: '同步后的员工姓名',
    email: 'updated@example.invalid',
    organizationName: '更新后的组织',
    businessUser: true,
    status: 'INACTIVE',
    tombstone: true,
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  })
  assert.equal(await repository.findSession(sessionHash, 'workbench'), null)
  const [roleCount] = await database<{ count: number }[]>`
    select count(*)::integer as count from user_roles
     where tenant_id = 'tenant-dsh-work' and user_id = ${localUserId}
       and role_id = 'role-employee'
  `
  assert.equal(roleCount?.count, 1, '停用身份不能删除本地角色配置')
})

test('directory sync uses a service token and never overwrites local role assignments', async () => {
  const directoryExternalId = `directory-user-${suffix}`
  const directoryPlatformExternalId = `directory-platform-user-${suffix}`
  let issuer = ''
  const tokenRequestBodies: string[] = []
  let directoryRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/oidc/.well-known/openid-configuration') {
      return json(response, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
      })
    }
    if (request.url === '/oidc/token' && request.method === 'POST') {
      let tokenRequestBody = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { tokenRequestBody += String(chunk) })
      request.on('end', () => {
        tokenRequestBodies.push(tokenRequestBody)
        json(response, {
          access_token: 'directory-service-token',
          expires_in: 300,
          scope: 'ai_hub.identity platform.directory.read',
        })
      })
      return
    }
    if (request.url?.startsWith('/platform-api/v1/directory/users')) {
      assert.equal(request.headers.authorization, 'Bearer directory-service-token')
      assert.equal(request.headers['x-application-id'], applicationId)
      directoryRequests += 1
      const cursor = new URL(request.url, 'http://localhost').searchParams.get('cursor')
      const tombstone = cursor === 'cursor-active'
      const employee = {
        user_id: directoryExternalId,
        subject: `directory-subject-${suffix}`,
        display_name: '目录同步员工',
        email: 'directory@example.invalid',
        status: tombstone ? 'INACTIVE' : 'ACTIVE',
        organization_id: 'org-directory',
        organization_name: '目录组织',
        business_user: true,
        updated_at: new Date(Date.now() + directoryRequests * 1000).toISOString(),
        tombstone,
      }
      return json(response, {
        items: tombstone ? [employee] : [
          employee,
          {
            user_id: directoryPlatformExternalId,
            subject: `directory-platform-subject-${suffix}`,
            display_name: '目录平台管理员',
            email: 'directory-platform@example.invalid',
            status: 'ACTIVE',
            organization_id: 'org-platform',
            organization_name: 'AI Hub 平台团队',
            business_user: false,
            updated_at: new Date(Date.now() + directoryRequests * 1000 + 1).toISOString(),
            tombstone: true,
          },
        ],
        next_cursor: tombstone ? 'cursor-disabled' : 'cursor-active',
        has_more: false,
        synchronized_at: new Date().toISOString(),
      })
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试 HTTP Server 没有端口')
    const origin = `http://127.0.0.1:${address.port}`
    issuer = `${origin}/oidc/`
    const service = new IdentityDirectorySyncService(
      identityConfiguration(origin, issuer),
      database,
    )

    const firstState = await service.synchronize({
      actorId: 'service:dsh-work-directory-test',
      full: true,
    })
    assert.equal(firstState.synchronizedUsers, 2)
    const [directoryUser] = await database<{ id: string; status: string }[]>`
      select id, status from users
       where tenant_id = 'tenant-dsh-work' and identity_provider = 'ai-hub'
         and external_user_id = ${directoryExternalId}
    `
    assert.equal(directoryUser?.status, 'active')
    directoryUserId = directoryUser?.id ?? ''
    const [directoryPlatformUser] = await database<{
      id: string
      status: string
      businessUser: boolean
    }[]>`
      select id, status, business_user as "businessUser" from users
       where tenant_id = 'tenant-dsh-work' and identity_provider = 'ai-hub'
         and external_user_id = ${directoryPlatformExternalId}
    `
    assert.equal(directoryPlatformUser?.status, 'disabled')
    assert.equal(directoryPlatformUser?.businessUser, false)
    const hiddenPlatformUser = await administration.listUsers({
      query: '目录平台管理员',
      page: 1,
      pageSize: 10,
    })
    assert.equal(hiddenPlatformUser.total, 0)
    await administration.grantRole({
      userId: directoryUserId,
      roleId: 'role-employee',
      actorId: 'U00008',
    })

    const secondState = await service.synchronize({ actorId: 'U00008' })
    assert.equal(secondState.synchronizedUsers, 1)
    const [disabled] = await database<{ status: string; roles: number }[]>`
      select u.status,
             (select count(*)::integer from user_roles ur
               where ur.tenant_id = u.tenant_id and ur.user_id = u.id) as roles
        from users u where u.id = ${directoryUserId}
    `
    assert.equal(disabled?.status, 'disabled')
    assert.equal(disabled?.roles, 1)
    const submitted = new URLSearchParams(tokenRequestBodies[0])
    assert.equal(submitted.get('grant_type'), 'client_credentials')
    assert.equal(submitted.get('scope'), 'ai_hub.identity platform.directory.read')
    const [systemAudit] = await database<{ count: number }[]>`
      select count(*)::integer as count from audit_events
       where actor_id = 'service:dsh-work-directory-test'
         and actor_type = 'system' and action = 'identity.directory.sync'
    `
    assert.equal(systemAudit?.count, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

function identityConfiguration(origin: string, issuer: string): OidcIdentityConfiguration {
  const shared = {
    applicationId,
    issuer,
    tokenAudience: 'dsh-work-test-client',
    clientId: 'dsh-work-test-client',
    clientSecret: 'directory-test-secret',
    allowedOrigins: [origin],
    defaultOrigin: origin,
    redirectUriByOrigin: { [origin]: `${origin}/callback` },
    loginScopes: ['openid'],
  }
  return {
    mode: 'oidc',
    platformUrl: origin,
    applicationId,
    environment: 'local',
    sessionSecret: 'directory-test-session-secret-with-32-characters',
    sessionTtlSeconds: 3600,
    transactionTtlSeconds: 600,
    cookieSecure: false,
    directorySyncIntervalSeconds: 0,
    jwksCacheTtlSeconds: 60,
    jwksStaleTtlSeconds: 120,
    audiences: {
      workbench: {
        audience: 'workbench',
        ...shared,
        sessionCookieName: 'workbench-session',
        transactionCookieName: 'workbench-transaction',
      },
      admin: {
        audience: 'admin',
        ...shared,
        sessionCookieName: 'admin-session',
        transactionCookieName: 'admin-transaction',
      },
    },
  }
}

function json(response: import('node:http').ServerResponse, body: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
