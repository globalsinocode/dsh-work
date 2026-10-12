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
const password = 'test-only initial passphrase'
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
  adminId = (await auth.bootstrap({ username: 'local.admin', name: '独立管理员', password })).userId
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

async function login(username = 'local.admin', audience = 'admin', suppliedPassword = password) {
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

test('bootstrap stays consumed after role removal and local prototype seeds cannot satisfy last-admin protection', async () => {
  await assert.rejects(auth.bootstrap({ username: 'second.admin', name: 'second', password }), /不能重复初始化/)
  await assert.rejects(auth.setStatus(adminId, 'disabled', adminId), /最后一个/)
  await assert.rejects(administration.revokeRole({ userId: adminId, roleId: 'role-platform-admin', actorId: adminId }), /最后一个/)
  const list = await administration.listUsers({})
  assert.equal(list.items.some(user => user.id === 'U00008'), false)
})

test('login refuses wrong passwords and cross-origin requests and never redirects off-site', async () => {
  assert.equal((await call('/auth/admin/login', { body: null })).response.status, 422)
  assert.equal((await call('/auth/workbench/password', { body: [] })).response.status, 422)
  assert.equal((await login('local.admin', 'admin', 'wrong password')).response.status, 401)
  assert.equal((await login('missing.user', 'admin', 'wrong password')).response.status, 401)
  assert.equal((await call('/auth/admin/login', { origin: 'https://evil.invalid', body: { username: 'local.admin', password } })).response.status, 403)
  assert.equal((await call('/auth/admin/login', { host: 'evil.invalid', body: { username: 'local.admin', password } })).response.status, 421)
  const result = await call('/auth/admin/login', { body: { username: 'LOCAL.ADMIN', password, returnTo: 'https://evil.invalid/collect' } })
  assert.equal(result.body.location, `${origin}/`)
  assert.equal((await call('/auth/admin/bootstrap')).response.status, 404)
  assert.equal((await call('/auth/workbench/register', { body: { username: 'intruder', password } })).response.status, 404)
})

test('administrator can create an account; ordinary users cannot grant or create identities', async () => {
  const admin = await login()
  const created = await call('/api/admin/v1/identity/users', { cookie: admin.cookie, body: { username: 'api.employee', name: 'API 员工', password } })
  assert.equal(created.response.status, 200)
  const userId = created.body.data.userId
  assert.equal((await login('api.employee', 'workbench')).response.status, 403)
  assert.equal((await call(`/api/admin/v1/identity/users/${userId}/roles`, { cookie: admin.cookie, body: { roleId: 'role-employee' } })).response.status, 200)
  const employeeLogin = await login('api.employee', 'workbench')
  assert.equal(employeeLogin.response.status, 200)
  assert.equal((await login('api.employee', 'admin')).response.status, 403)
  assert.equal((await call('/api/admin/v1/identity/users', { cookie: employeeLogin.cookie, body: { username: 'unauthorized', name: 'bad', password } })).response.status, 401)
  await assert.rejects(auth.createAccount({ username: 'no.permission', name: 'bad', password }, userId), /只有平台管理员/)
})

test('first login requires password change; changing or resetting a password revokes both portal sessions', async () => {
  const userId = await employee('password.employee')
  await administration.grantRole({ userId, roleId: 'role-platform-admin', actorId: adminId })
  const first = await login('password.employee', 'workbench')
  const firstAdmin = await login('password.employee', 'admin')
  assert.match(first.body.location, /\/change-password/)
  assert.equal((await call('/api/workbench/v1/session', { cookie: first.cookie })).body.error.code, 'password_change_required')
  const changed = await call('/auth/workbench/password', { cookie: first.cookie, body: { currentPassword: password, newPassword: 'my new private long passphrase', returnTo: '/settings' } })
  assert.equal(changed.response.status, 200)
  assert.equal(new URL(changed.body.location).searchParams.get('return_to'), `${origin}/settings`)
  assert.equal((await call('/api/workbench/v1/session', { cookie: first.cookie })).response.status, 401)
  assert.equal((await call('/api/admin/v1/session', { cookie: firstAdmin.cookie })).response.status, 401)
  assert.equal((await login('password.employee', 'workbench')).response.status, 401)
  const current = await login('password.employee', 'workbench', 'my new private long passphrase')
  const currentAdmin = await login('password.employee', 'admin', 'my new private long passphrase')
  assert.equal((await call('/api/workbench/v1/session', { cookie: current.cookie })).response.status, 200)
  assert.equal((await call('/api/admin/v1/session', { cookie: currentAdmin.cookie })).response.status, 200)
  await auth.resetPassword(userId, 'reset temporary long passphrase', adminId)
  assert.equal((await call('/api/workbench/v1/session', { cookie: current.cookie })).response.status, 401)
  assert.equal((await call('/api/admin/v1/session', { cookie: currentAdmin.cookie })).response.status, 401)
  assert.equal((await login('password.employee', 'workbench', 'my new private long passphrase')).response.status, 401)
  assert.match((await login('password.employee', 'workbench', 'reset temporary long passphrase')).body.location, /\/change-password/)
  await administration.revokeRole({ userId, roleId: 'role-platform-admin', actorId: adminId })
})

test('disabling, re-enabling, expiring and logging out a local account preserve data but invalidate sessions', async () => {
  const userId = await employee('status.employee')
  await database.client`update local_user_credentials set must_change_password = false where user_id = ${userId}`
  const first = await login('status.employee', 'workbench')
  await auth.setStatus(userId, 'disabled', adminId)
  assert.equal((await call('/api/workbench/v1/session', { cookie: first.cookie })).response.status, 401)
  assert.equal((await login('status.employee', 'workbench')).response.status, 401)
  await auth.setStatus(userId, 'active', adminId)
  const second = await login('status.employee', 'workbench')
  assert.equal((await call('/api/workbench/v1/session', { cookie: second.cookie })).response.status, 200)
  await administration.revokeRole({ userId, roleId: 'role-employee', actorId: adminId })
  assert.equal((await call('/api/workbench/v1/session', { cookie: second.cookie })).response.status, 403)
  await administration.grantRole({ userId, roleId: 'role-employee', actorId: adminId })
  assert.equal((await call('/auth/workbench/logout', { method: 'POST', cookie: second.cookie, origin: 'https://evil.invalid' })).response.status, 403)
  assert.equal((await call('/auth/workbench/logout', { method: 'POST', cookie: second.cookie })).response.status, 200)
  assert.equal((await call('/api/workbench/v1/session', { cookie: second.cookie })).response.status, 401)
  const third = await login('status.employee', 'workbench')
  await database.client`update authentication_sessions set expires_at = now() - interval '1 second' where user_id = ${userId}`
  assert.equal((await call('/api/workbench/v1/session', { cookie: third.cookie })).response.status, 401)
})

test('explicit binding preserves the existing AI Hub user id and grants without matching by email', async () => {
  const repository = new IdentitySessionRepository(database.client)
  const existing = await repository.synchronizeIdentity({ externalUserId: 'legacy-local-switch', subject: 'legacy-local-subject', displayName: '原有员工', email: 'legacy@example.invalid', organizationName: '原部门', businessUser: true, status: 'ACTIVE' })
  await administration.grantRole({ userId: existing.userId, roleId: 'role-employee', actorId: adminId })
  const bound = await auth.createAccount({ username: 'legacy.employee', name: '不得覆盖原资料', existingUserId: existing.userId, password }, adminId)
  assert.equal(bound.userId, existing.userId)
  const authorization = await repository.resolveAuthorization(existing.userId)
  assert.equal(authorization.profile.name, '原有员工')
  assert.ok(authorization.roleIds.includes('role-employee'))
  await assert.rejects(auth.createAccount({ username: 'duplicate.employee', name: 'bad', existingUserId: existing.userId, password }, adminId), /已开通/)
})

test('rate limiting is persisted and failed requests never store password material in audits', async () => {
  await login('local.admin', 'admin', 'wrong')
  await database.client`update local_auth_rate_limits set attempts = 10`
  assert.equal((await login()).response.status, 429)
  await database.client`update local_auth_rate_limits set expires_at = now() - interval '1 second'`
  assert.equal((await login()).response.status, 200)
  const audit = await database.client`select safe_context from audit_events where object_type = 'local_identity'`
  assert.ok(audit.length > 0)
  assert.equal(JSON.stringify(audit).includes(password), false)
  assert.equal(JSON.stringify(audit).includes('scrypt$'), false)
})
