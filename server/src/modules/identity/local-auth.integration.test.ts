import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { registerIdentityAdministrationRoutes } from '../../http/admin/identity-routes.ts'
import { registerLocalAuthRoutes } from '../../http/local-auth-routes.ts'
import { envelope, requireRequestIdentity, Router } from '../../http/router.ts'
import { IdentityAdministrationService } from './administration-service.ts'
import { loadIdentityConfiguration } from './config.ts'
import { LocalAuthService } from './local-auth-service.ts'
import { IdentitySessionRepository } from './session-repository.ts'

let origin: string
const password = 'Initial12345'
let database: ThrowawayDatabase
let auth: LocalAuthService
let administration: IdentityAdministrationService
let server: Server
let address: string
let adminId: string

before(async () => {
  // One connection also catches accidental pool queries inside the login transaction.
  database = await createThrowawayDatabase({ namePrefix: 'dsh_local_auth_test', maxConnections: 1 })
  const router = new Router({ authenticateApi: (request, audience) => auth.authenticateApi(request, audience) })
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const endpoint = server.address()
  assert.ok(endpoint && typeof endpoint !== 'string')
  origin = `http://localhost:${endpoint.port}`
  address = origin
  const config = loadIdentityConfiguration({ DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: 'local-integration-secret-with-32-characters', DSH_WORK_WORKBENCH_ORIGINS: origin, DSH_WORK_ADMIN_ORIGINS: origin })
  assert.equal(config.mode, 'local')
  auth = new LocalAuthService(config, database.client)
  administration = new IdentityAdministrationService(database.client, true)
  adminId = (await auth.bootstrap({ username: 'local.admin@example.invalid', name: '独立管理员', password })).userId
  registerLocalAuthRoutes(router, auth)
  registerIdentityAdministrationRoutes(router, administration)
  for (const audience of ['admin', 'workbench'] as const) {
    router.get(`/api/${audience}/v1/session`, (_request, context) => envelope(audience, requireRequestIdentity(context, audience), 'postgres'))
  }
})

beforeEach(async () => { await database.client`delete from local_auth_rate_limits` })
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (database) await database.dispose()
})

async function call(path: string, options: { method?: string; cookie?: string; body?: unknown; origin?: string; host?: string } = {}) {
  const hasBody = options.body !== undefined
  const response = await fetch(`${address}${path}`, {
    method: options.method ?? (hasBody ? 'POST' : 'GET'), redirect: 'manual',
    headers: { ...(options.host ? { 'X-Forwarded-Host': options.host } : {}), Origin: options.origin ?? origin, ...(options.cookie ? { Cookie: options.cookie } : {}), ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  const body = response.status === 302 ? {} : await response.json()
  return { response, cookie, body }
}

async function login(username = 'local.admin@example.invalid', audience = 'admin', suppliedPassword = password) {
  return call(`/auth/${audience}/login`, { body: { username, password: suppliedPassword, returnTo: '/identity' } })
}

async function employee(username: string) {
  const { userId } = await auth.createAccount({ username, name: username, password }, adminId)
  await administration.grantRole({ userId, roleId: 'role-employee', actorId: adminId })
  return userId
}

test('local login creates only opaque provider-separated cookies and persists hashed credentials', async () => {
  const result = await login()
  assert.equal(result.response.status, 200)
  assert.match(result.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/)
  assert.match(result.cookie!, /^dsh_work_local_admin_session=/)
  const session = await call('/api/admin/v1/session', { cookie: result.cookie })
  assert.equal(session.body.data.identityProvider, 'local-password')
  assert.equal(session.body.data.userId, adminId)
  const [credential] = await database.client`select password_hash from local_user_credentials where user_id = ${adminId}`
  assert.match(credential!.password_hash, /^scrypt\$/)
  assert.equal(credential!.password_hash.includes(password), false)
  const [stored] = await database.client`select * from authentication_sessions where user_id = ${adminId} and revoked_at is null`
  assert.equal(stored!.access_token_encrypted, null)
  assert.equal(stored!.token_expires_at, null)
  assert.equal(await new IdentitySessionRepository(database.client).findSession(stored!.session_hash, 'admin'), null)
  assert.equal((await call('/api/workbench/v1/session', { cookie: result.cookie })).response.status, 401)
})

test('logging in on another device keeps the existing session usable', async () => {
  const userId = await employee('multi.device@example.invalid')
  await database.client`update local_user_credentials set must_change_password = false where user_id = ${userId}`
  const desktop = await login('multi.device@example.invalid', 'workbench')
  const mobile = await login('multi.device@example.invalid', 'workbench')
  assert.equal(desktop.response.status, 200)
  assert.equal(mobile.response.status, 200)
  assert.notEqual(desktop.cookie, mobile.cookie)
  assert.equal((await call('/api/workbench/v1/session', { cookie: desktop.cookie })).body.data.userId, userId)
  assert.equal((await call('/api/workbench/v1/session', { cookie: mobile.cookie })).body.data.userId, userId)
  const [active] = await database.client`select count(*)::int as n from authentication_sessions where user_id = ${userId} and revoked_at is null`
  assert.equal(active!.n, 2)
  // 退出其中一个入口不影响另一个入口的会话
  await call('/auth/workbench/logout', { cookie: mobile.cookie, body: {} })
  assert.equal((await call('/api/workbench/v1/session', { cookie: desktop.cookie })).response.status, 200)
  assert.equal((await call('/api/workbench/v1/session', { cookie: mobile.cookie })).response.status, 401)
})

test('bootstrap stays consumed after role removal and local prototype seeds cannot satisfy last-admin protection', async () => {
  await assert.rejects(auth.bootstrap({ username: 'second.admin@example.invalid', name: 'second', password }), /不能重复初始化/)
  await assert.rejects(auth.setStatus(adminId, 'disabled', adminId), /最后一个/)
  await assert.rejects(administration.revokeRole({ userId: adminId, roleId: 'role-platform-admin', actorId: adminId }), /最后一个/)
  const list = await administration.listUsers({})
  assert.equal(list.items.some(user => user.id === 'U00008'), false)
})

test('login refuses wrong passwords and cross-origin requests and never redirects off-site', async () => {
  assert.equal((await call('/auth/admin/login', { body: null })).response.status, 422)
  assert.equal((await call('/auth/workbench/password', { body: [] })).response.status, 422)
  assert.equal((await login('local.admin@example.invalid', 'admin', 'wrong password')).response.status, 401)
  assert.equal((await login('missing.user', 'admin', 'wrong password')).response.status, 401)
  assert.equal((await call('/auth/admin/login', { origin: 'https://evil.invalid', body: { username: 'local.admin@example.invalid', password } })).response.status, 403)
  assert.equal((await call('/auth/admin/login', { host: 'evil.invalid', body: { username: 'local.admin@example.invalid', password } })).response.status, 421)
  const result = await call('/auth/admin/login', { body: { username: 'LOCAL.ADMIN@EXAMPLE.INVALID', password, returnTo: 'https://evil.invalid/collect' } })
  assert.equal(result.body.location, `${origin}/`)
  assert.equal((await call('/auth/admin/bootstrap')).response.status, 404)
  assert.equal((await call('/auth/workbench/register', { body: { username: 'intruder', password } })).response.status, 404)
})

test('administrator can create an account; ordinary users cannot grant or create identities', async () => {
  const admin = await login()
  const created = await call('/api/admin/v1/identity/users', { cookie: admin.cookie, body: { username: 'api.employee@example.invalid', name: 'API 员工', password } })
  assert.equal(created.response.status, 200)
  const userId = created.body.data.userId
  assert.equal((await login('api.employee@example.invalid', 'workbench')).response.status, 403)
  assert.equal((await call(`/api/admin/v1/identity/users/${userId}/roles`, { cookie: admin.cookie, body: { roleId: 'role-employee' } })).response.status, 200)
  const employeeLogin = await login('api.employee@example.invalid', 'workbench')
  assert.equal(employeeLogin.response.status, 200)
  assert.equal((await login('api.employee@example.invalid', 'admin')).response.status, 403)
  assert.equal((await call('/api/admin/v1/identity/users', { cookie: employeeLogin.cookie, body: { username: 'unauthorized@example.invalid', name: 'bad', password } })).response.status, 401)
  await assert.rejects(auth.createAccount({ username: 'no.permission@example.invalid', name: 'bad', password }, userId), /只有平台管理员/)
})

test('first password changes return directly with a fresh session and revoke both portals, including after a reset', async () => {
  const userId = await employee('password.employee@example.invalid')
  await administration.grantRole({ userId, roleId: 'role-platform-admin', actorId: adminId })
  const first = await login('password.employee@example.invalid', 'workbench')
  const firstAdmin = await login('password.employee@example.invalid', 'admin')
  assert.match(first.body.location, /\/change-password/)
  assert.equal((await call('/api/workbench/v1/session', { cookie: first.cookie })).body.error.code, 'password_change_required')
  const changed = await call('/auth/workbench/password', { cookie: first.cookie, body: { currentPassword: password, newPassword: 'Changed1', returnTo: '/settings?view=profile#details' } })
  assert.equal(changed.response.status, 200)
  assert.equal(changed.body.location, `${origin}/settings?view=profile#details`)
  assert.ok(changed.cookie)
  assert.notEqual(changed.cookie, first.cookie)
  const continued = await call('/api/workbench/v1/session', { cookie: changed.cookie })
  assert.equal(continued.response.status, 200)
  assert.equal(continued.body.data.userId, userId)
  assert.equal(continued.body.data.identityProvider, 'local-password')
  assert.equal((await call('/api/workbench/v1/session', { cookie: first.cookie })).response.status, 401)
  assert.equal((await call('/api/admin/v1/session', { cookie: firstAdmin.cookie })).response.status, 401)
  assert.equal((await call('/api/admin/v1/session', { cookie: changed.cookie })).response.status, 401)
  assert.equal((await call('/auth/workbench/password', { cookie: first.cookie, body: { currentPassword: 'Changed1', newPassword: 'stale session must not change password' } })).response.status, 401)
  assert.equal((await login('password.employee@example.invalid', 'workbench')).response.status, 401)
  const current = await login('password.employee@example.invalid', 'workbench', 'Changed1')
  const currentAdmin = await login('password.employee@example.invalid', 'admin', 'Changed1')
  assert.equal((await call('/api/workbench/v1/session', { cookie: current.cookie })).response.status, 200)
  assert.equal((await call('/api/admin/v1/session', { cookie: currentAdmin.cookie })).response.status, 200)
  await auth.resetPassword(userId, 'TempPass1234', adminId)
  assert.equal((await call('/api/workbench/v1/session', { cookie: current.cookie })).response.status, 401)
  assert.equal((await call('/api/admin/v1/session', { cookie: currentAdmin.cookie })).response.status, 401)
  assert.equal((await login('password.employee@example.invalid', 'workbench', 'Changed1')).response.status, 401)
  const reset = await login('password.employee@example.invalid', 'admin', 'TempPass1234')
  assert.match(reset.body.location, /\/change-password/)
  const resetChanged = await call('/auth/admin/password', { cookie: reset.cookie, body: { currentPassword: 'TempPass1234', newPassword: 'AfterReset12', returnTo: '/identity' } })
  assert.equal(resetChanged.response.status, 200)
  assert.equal(resetChanged.body.location, `${origin}/identity`)
  assert.notEqual(resetChanged.cookie, reset.cookie)
  assert.equal((await call('/api/admin/v1/session', { cookie: resetChanged.cookie })).response.status, 200)
  assert.equal((await call('/api/admin/v1/session', { cookie: reset.cookie })).response.status, 401)
  assert.equal((await login('password.employee@example.invalid', 'admin', 'TempPass1234')).response.status, 401)
  await administration.revokeRole({ userId, roleId: 'role-platform-admin', actorId: adminId })
})

test('failed password changes do not rotate sessions or unlock access, and successful changes reject external return targets', async () => {
  const userId = await employee('password.validation@example.invalid')
  const first = await login('password.validation@example.invalid', 'workbench')
  for (const input of [
    { currentPassword: 'incorrect password', newPassword: 'ValidPass12', status: 401 },
    { currentPassword: password, newPassword: password, status: 422 },
    { currentPassword: password, newPassword: 'x'.repeat(7), status: 422 },
    { currentPassword: password, newPassword: 'x'.repeat(65), status: 422 },
  ]) {
    const failed = await call('/auth/workbench/password', { cookie: first.cookie, body: input })
    assert.equal(failed.response.status, input.status)
    assert.equal(failed.cookie, undefined)
    assert.equal(failed.body.location, undefined)
    assert.equal((await call('/api/workbench/v1/session', { cookie: first.cookie })).body.error.code, 'password_change_required')
  }
  const changed = await call('/auth/workbench/password', { cookie: first.cookie, body: { currentPassword: password, newPassword: 'ValidPass12', returnTo: 'https://evil.invalid' } })
  assert.equal(changed.response.status, 200)
  assert.equal(changed.body.location, `${origin}/`)
  const [active] = await database.client`select count(*)::int as n from authentication_sessions where user_id = ${userId} and revoked_at is null`
  assert.equal(active!.n, 1)
  assert.equal((await call('/api/workbench/v1/session', { cookie: changed.cookie })).response.status, 200)
})

test('account provisioning and reset enforce 8–64 characters without changing credentials or sessions on failure', async () => {
  const admin = await login()
  const userId = await employee('length.employee@example.invalid')
  await database.client`update local_user_credentials set must_change_password = false where user_id = ${userId}`
  const session = await login('length.employee@example.invalid', 'workbench')
  for (const length of [7, 65]) {
    const invalid = 'x'.repeat(length)
    await assert.rejects(auth.bootstrap({ username: 'length.invalid.admin@example.invalid', name: 'invalid', password: invalid }), /8–64/)
    const created = await call('/api/admin/v1/identity/users', { cookie: admin.cookie, body: { username: 'length.invalid@example.invalid', name: 'invalid', password: invalid } })
    assert.equal(created.response.status, 422)
    assert.equal(created.body.error.code, 'invalid_password')
    const reset = await call(`/api/admin/v1/identity/users/${userId}/password`, { cookie: admin.cookie, body: { password: invalid } })
    assert.equal(reset.response.status, 422)
    assert.equal(reset.body.error.code, 'invalid_password')
    assert.equal((await call('/api/workbench/v1/session', { cookie: session.cookie })).response.status, 200)
  }
  assert.equal((await administration.listUsers({ query: 'length.invalid@example.invalid' })).total, 0)
  for (const length of [8, 64]) {
    const candidate = 'p'.repeat(length)
    const created = await call('/api/admin/v1/identity/users', { cookie: admin.cookie, body: { username: `length.valid.${length}@example.invalid`, name: '有效长度', password: candidate } })
    assert.equal(created.response.status, 200)
    const reset = await call(`/api/admin/v1/identity/users/${userId}/password`, { cookie: admin.cookie, body: { password: candidate } })
    assert.equal(reset.response.status, 200)
    assert.equal((await login('length.employee@example.invalid', 'workbench', candidate)).response.status, 200)
  }
  assert.equal((await call('/api/workbench/v1/session', { cookie: session.cookie })).response.status, 401)
})

test('an existing long password can still log in and be changed to an 8-character password', async () => {
  const userId = await employee('legacy.password@example.invalid')
  // Persisted credential produced under the former 15–128-character policy.
  const legacyHash = 'scrypt$131072$8$1$0123456789abcdef0123456789abcdef$c7ca7ab024bc3ab3a88041e4c13420d753fb55a515162131e29ba83d8455ffc2'
  await database.client`update local_user_credentials set password_hash = ${legacyHash} where user_id = ${userId}`
  const legacyPassword = 'legacy test-only long passphrase'
  const first = await login('legacy.password@example.invalid', 'workbench', legacyPassword)
  assert.equal(first.response.status, 200)
  const changed = await call('/auth/workbench/password', { cookie: first.cookie, body: { currentPassword: legacyPassword, newPassword: 'Updated1', returnTo: '/settings' } })
  assert.equal(changed.response.status, 200)
  assert.equal(changed.body.location, `${origin}/settings`)
  assert.equal((await call('/api/workbench/v1/session', { cookie: changed.cookie })).response.status, 200)
  assert.equal((await login('legacy.password@example.invalid', 'workbench', legacyPassword)).response.status, 401)
  assert.equal((await login('legacy.password@example.invalid', 'workbench', 'Updated1')).response.status, 200)
})

test('disabling, re-enabling, expiring and logging out a local account preserve data but invalidate sessions', async () => {
  const userId = await employee('status.employee@example.invalid')
  await database.client`update local_user_credentials set must_change_password = false where user_id = ${userId}`
  const first = await login('status.employee@example.invalid', 'workbench')
  await auth.setStatus(userId, 'disabled', adminId)
  assert.equal((await call('/api/workbench/v1/session', { cookie: first.cookie })).response.status, 401)
  assert.equal((await login('status.employee@example.invalid', 'workbench')).response.status, 401)
  await auth.setStatus(userId, 'active', adminId)
  const second = await login('status.employee@example.invalid', 'workbench')
  assert.equal((await call('/api/workbench/v1/session', { cookie: second.cookie })).response.status, 200)
  await administration.revokeRole({ userId, roleId: 'role-employee', actorId: adminId })
  assert.equal((await call('/api/workbench/v1/session', { cookie: second.cookie })).response.status, 403)
  await administration.grantRole({ userId, roleId: 'role-employee', actorId: adminId })
  assert.equal((await call('/auth/workbench/logout', { method: 'POST', cookie: second.cookie, origin: 'https://evil.invalid' })).response.status, 403)
  assert.equal((await call('/auth/workbench/logout', { method: 'POST', cookie: second.cookie })).response.status, 200)
  assert.equal((await call('/api/workbench/v1/session', { cookie: second.cookie })).response.status, 401)
  const third = await login('status.employee@example.invalid', 'workbench')
  await database.client`update authentication_sessions set expires_at = now() - interval '1 second' where user_id = ${userId}`
  assert.equal((await call('/api/workbench/v1/session', { cookie: third.cookie })).response.status, 401)
})

test('same-name and same-email accounts remain separate and binding is unavailable', async () => {
  const repository = new IdentitySessionRepository(database.client)
  const existing = await repository.synchronizeIdentity({ externalUserId: 'legacy-local-switch', subject: 'legacy-local-subject', displayName: '原有员工', email: 'legacy@example.invalid', organizationName: '原部门', businessUser: true, status: 'ACTIVE' })
  await administration.grantRole({ userId: existing.userId, roleId: 'role-employee', actorId: adminId })
  const independent = await auth.createAccount({ username: 'separate.employee@example.invalid', name: '原有员工', email: 'legacy@example.invalid', password }, adminId)
  assert.notEqual(independent.userId, existing.userId)
  assert.deepEqual((await repository.resolveAuthorization(independent.userId)).roleIds, [])
  assert.ok((await repository.resolveAuthorization(existing.userId)).roleIds.includes('role-employee'))
  const [localIdentity] = await database.client`select external_subject from users where id = ${independent.userId}`
  await assert.rejects(repository.synchronizeIdentity({ externalUserId: 'conflicting-upstream-subject', subject: localIdentity!.external_subject, displayName: '不应覆盖', email: 'legacy@example.invalid', organizationName: '上游部门', businessUser: true, status: 'ACTIVE' }), /不能绑定或转换独立账号/)
  const [unchanged] = await database.client`select identity_provider, display_name from users where id = ${independent.userId}`
  assert.equal(unchanged!.identity_provider, 'local')
  assert.equal(unchanged!.display_name, '原有员工')
  const session = await login()
  const bound = await call(`/api/admin/v1/identity/users/${existing.userId}/local-account`, { cookie: session.cookie, body: { username: 'legacy.employee@example.invalid', password } })
  assert.equal(bound.response.status, 404)
  const forged = await call('/api/admin/v1/identity/users', { cookie: session.cookie, body: { username: 'forged.employee@example.invalid', name: '伪造绑定', password, existingUserId: existing.userId } })
  assert.equal(forged.response.status, 422)
  assert.equal(forged.body.error.code, 'account_binding_unsupported')
  const [count] = await database.client`select count(*)::int as n from local_user_credentials where user_id = ${existing.userId}`
  assert.equal(count!.n, 0)
})

test('an AI Hub administrator cannot replace the final independent administrator', async () => {
  const repository = new IdentitySessionRepository(database.client)
  const upstream = await repository.synchronizeIdentity({ externalUserId: 'upstream-admin-invariant', subject: 'upstream-admin-invariant', displayName: '上游管理员', email: 'upstream-admin@example.invalid', organizationName: '验收部门', businessUser: true, status: 'ACTIVE' })
  await administration.grantRole({ userId: upstream.userId, roleId: 'role-platform-admin', actorId: adminId })
  await assert.rejects(administration.revokeRole({ userId: adminId, roleId: 'role-platform-admin', actorId: upstream.userId }), /最后一个有效的平台管理员/)
  await assert.rejects(auth.setStatus(adminId, 'disabled', upstream.userId), /最后一个有效的平台管理员/)
  assert.ok((await repository.resolveAuthorization(adminId)).roleIds.includes('role-platform-admin'))
  // The independent administrator keeps the platform accessible when removing upstream access.
  await administration.revokeRole({ userId: upstream.userId, roleId: 'role-platform-admin', actorId: adminId })
  assert.equal((await repository.resolveAuthorization(upstream.userId)).roleIds.includes('role-platform-admin'), false)
})

test('employee login accounts are searchable for both sources without exposing upstream local credentials', async () => {
  const repository = new IdentitySessionRepository(database.client)
  const independent = await auth.createAccount({ username: 'shared.login@example.invalid', name: '独立展示用户', password }, adminId)
  const upstream = await repository.synchronizeIdentity({ externalUserId: 'display-only-upstream-id', subject: 'shared.login@example.invalid', displayName: '企业展示用户', email: 'profile@example.invalid', organizationName: '同步部门', businessUser: true, status: 'ACTIVE', updatedAt: '2026-10-12T01:00:00Z' })
  const result = await administration.listUsers({ query: 'SHARED.LOGIN@EXAMPLE.INVALID' })
  assert.equal(result.total, 2)
  assert.equal(result.items.find(user => user.id === independent.userId)?.loginAccount, 'shared.login@example.invalid')
  const displayed = result.items.find(user => user.id === upstream.userId)!
  assert.equal(displayed.loginAccount, 'shared.login@example.invalid')
  assert.equal(displayed.username, null)
  assert.equal(displayed.externalUserId, 'display-only-upstream-id')
  assert.equal(displayed.email, 'profile@example.invalid')
  assert.ok(displayed.directorySyncedAt)
  assert.equal(displayed.lastSeenAt, null)
  assert.equal(displayed.activeSessionCount, 0)
  const updated = await administration.grantRole({ userId: upstream.userId, roleId: 'role-employee', actorId: adminId })
  assert.equal(updated.loginAccount, 'shared.login@example.invalid', 'mutation responses keep account details in the open drawer')
  assert.equal(updated.username, null)
  assert.equal((await administration.listUsers({ query: 'missing.login.account' })).total, 0)
  const session = await login()
  const response = await call('/api/admin/v1/identity/users?query=shared.login', { cookie: session.cookie })
  assert.equal(response.response.status, 200)
  assert.equal(response.body.data.items.length, 2)
  assert.equal(response.body.data.total, 2)
  assert.ok(response.body.data.items.every((user: { loginAccount: string }) => user.loginAccount === 'shared.login@example.invalid'))
})

test('creation and availability checks reject duplicate local and synchronized AI Hub login accounts', async () => {
  const admin = await login()
  const check = (username: unknown, cookie = admin.cookie) => call('/api/admin/v1/identity/login-account/check', { cookie, body: { username } })
  assert.equal((await call('/api/admin/v1/identity/login-account/check', { body: { username: 'new@example.invalid' } })).response.status, 401)
  assert.equal((await check('not-an-email')).response.status, 422)
  assert.equal((await call('/api/admin/v1/identity/users', { cookie: admin.cookie, body: { username: 'legacy.new', name: '格式无效', password } })).response.status, 422)
  const ready = await check(' New+Account@Example.Invalid ')
  assert.deepEqual(ready.body.data, { username: 'new+account@example.invalid', available: true })
  const created = await call('/api/admin/v1/identity/users', { cookie: admin.cookie, body: { username: ' New+Account@Example.Invalid ', name: '独立账号', password } })
  assert.equal(created.response.status, 200)
  assert.equal(created.body.data.username, 'new+account@example.invalid')
  await auth.setStatus(created.body.data.userId, 'disabled', adminId)
  const repository = new IdentitySessionRepository(database.client)
  const upstream = await repository.synchronizeIdentity({ externalUserId: 'duplicate-hub-email', subject: 'HUB.LOGIN@EXAMPLE.INVALID', displayName: '已停用企业账号', email: 'contact-only@example.invalid', organizationName: '合成组织', businessUser: true, status: 'DISABLED' })
  await repository.synchronizeIdentity({ externalUserId: 'duplicate-hub-phone', subject: '+8613800138000', displayName: '企业手机账号', email: null, organizationName: '合成组织', businessUser: true, status: 'ACTIVE' })
  for (const username of ['NEW+ACCOUNT@EXAMPLE.INVALID', ' hub.login@example.invalid ', '13800138000', '+8613800138000']) {
    assert.equal((await check(username)).body.data.available, false)
    const duplicate = await call('/api/admin/v1/identity/users', { cookie: admin.cookie, body: { username, name: '不应创建', password } })
    assert.equal(duplicate.response.status, 409)
    assert.equal(duplicate.body.error.code, 'local_account_exists')
    assert.match(duplicate.body.error.message, /登录账号已存在/)
  }
  const [unchanged] = await database.client`select identity_provider, display_name from users where id = ${upstream.userId}`
  assert.equal(unchanged!.identity_provider, 'ai-hub')
  assert.equal(unchanged!.display_name, '已停用企业账号')
  const [credentials] = await database.client`select count(*)::int as n from local_user_credentials where user_id = ${upstream.userId}`
  assert.equal(credentials!.n, 0)
  assert.equal((await check('contact-only@example.invalid')).body.data.available, true, 'profile email is not the upstream login account')
})

test('phone accounts log in with or without +86 and old usernames remain usable', async () => {
  const user = await auth.createAccount({ username: '+8613900139000', name: '手机账号', password }, adminId)
  await administration.grantRole({ userId: user.userId, roleId: 'role-employee', actorId: adminId })
  assert.equal(user.username, '13900139000')
  assert.equal((await login('+8613900139000', 'workbench')).response.status, 200)
  assert.equal((await login('13900139000', 'workbench')).response.status, 200)
  const legacy = await employee('legacy.login@example.invalid')
  await database.client`update local_user_credentials set username = 'legacy.user' where user_id = ${legacy}`
  assert.equal((await login('LEGACY.USER', 'workbench')).response.status, 200)
})

test('only platform administrators may check account availability', async () => {
  const reader = await auth.createAccount({ username: 'availability.reader@example.invalid', name: '只读账号', password }, adminId)
  await administration.grantRole({ userId: reader.userId, roleId: 'role-auditor', actorId: adminId })
  await database.client`update local_user_credentials set must_change_password = false where user_id = ${reader.userId}`
  const session = await login('availability.reader@example.invalid', 'admin')
  assert.equal(session.response.status, 200)
  assert.equal((await call('/api/admin/v1/identity/login-account/check', { cookie: session.cookie, body: { username: 'someone@example.invalid' } })).response.status, 403)
})

test('rate limiting is per account: no shared connection quota and a success clears the failure window', async () => {
  assert.equal((await login('local.admin@example.invalid', 'admin', 'wrong')).response.status, 401)
  // Only the account window is recorded; a per-connection key would be one quota for everyone behind the proxy.
  assert.equal((await database.client`select key_hash from local_auth_rate_limits`).length, 1)
  await database.client`update local_auth_rate_limits set attempts = 9`
  assert.equal((await login()).response.status, 200)
  assert.equal((await database.client`select key_hash from local_auth_rate_limits`).length, 0)
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await login('local.admin@example.invalid', 'admin', 'wrong')).response.status, 401)
  }
  assert.equal((await login()).response.status, 429)
  await employee('rate.other@example.invalid')
  await database.client`update local_user_credentials set must_change_password = false where username = 'rate.other@example.invalid'`
  assert.equal((await login('rate.other@example.invalid', 'workbench')).response.status, 200, 'another account is unaffected by a locked account')
})

test('rate limiting is persisted and failed requests never store password material in audits', async () => {
  await login('local.admin@example.invalid', 'admin', 'wrong')
  await database.client`update local_auth_rate_limits set attempts = 10`
  assert.equal((await login()).response.status, 429)
  await database.client`update local_auth_rate_limits set expires_at = now() - interval '1 second'`
  assert.equal((await login()).response.status, 200)
  const audit = await database.client`select safe_context from audit_events where object_type = 'local_identity'`
  assert.ok(audit.length > 0)
  assert.equal(JSON.stringify(audit).includes(password), false)
  assert.equal(JSON.stringify(audit).includes('scrypt$'), false)
})
