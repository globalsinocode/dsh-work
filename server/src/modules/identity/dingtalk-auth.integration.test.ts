import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { registerDingTalkAuthRoutes } from '../../http/dingtalk-auth-routes.ts'
import { registerLocalAuthRoutes } from '../../http/local-auth-routes.ts'
import { registerDingTalkBindingRoutes } from '../../http/workbench/dingtalk-binding-routes.ts'
import { PostgresDingTalkSelfBindingService } from './dingtalk/dingtalk-self-service.ts'
import { envelope, requireRequestIdentity, Router } from '../../http/router.ts'
import { DingTalkDirectoryDouble } from '../../testing/dingtalk-double.ts'
import { IdentityAdministrationService } from './administration-service.ts'
import { loadIdentityConfiguration } from './config.ts'
import { DingTalkAuthService } from './dingtalk/dingtalk-auth-service.ts'
import { loadDingTalkConfiguration } from './dingtalk/dingtalk-config.ts'
import { staticDingTalkSettings } from './dingtalk/dingtalk-settings.ts'
import { LocalAuthService } from './local-auth-service.ts'
import type { LocalIdentityConfiguration } from './types.ts'

// 钉钉接入方案第 9 节 P1（DT-S1 身份部分）：专用可丢弃 PostgreSQL + 钉钉开放平台测试替身。

const password = 'Initial12345'
const publicHost = 'm.example.test'
const publicOrigin = `http://${publicHost}`
let origin: string
let database: ThrowawayDatabase
let local: LocalAuthService
let administration: IdentityAdministrationService
let dingtalk: DingTalkDirectoryDouble
let server: Server
let adminId: string
let sequence = 0

before(async () => {
  // 单连接：登录事务内若有钉钉调用或连接池查询会直接卡死，借此证明外部调用都在事务之外。
  database = await createThrowawayDatabase({ namePrefix: 'dsh_dingtalk_auth_test', maxConnections: 1 })
  const router = new Router({ authenticateApi: (request, audience) => local.authenticateApi(request, audience) })
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const endpoint = server.address()
  assert.ok(endpoint && typeof endpoint !== 'string')
  origin = `http://localhost:${endpoint.port}`
  const config = loadIdentityConfiguration({
    DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: 'dingtalk-integration-secret-with-32-chars',
    DSH_WORK_WORKBENCH_ORIGINS: `${origin},${publicOrigin}`, DSH_WORK_ADMIN_ORIGINS: origin,
  }) as LocalIdentityConfiguration
  const dingtalkConfig = loadDingTalkConfiguration({
    DSH_WORK_DINGTALK_CORP_ID: 'ding-corp-test', DSH_WORK_DINGTALK_AGENT_ID: '3189', DSH_WORK_DINGTALK_APP_KEY: 'key', DSH_WORK_DINGTALK_APP_SECRET: 'secret',
  })!
  dingtalk = new DingTalkDirectoryDouble('ding-corp-test').addDepartment(11, '销售部').addDepartment(12, '华东区')
  const settings = staticDingTalkSettings(dingtalkConfig, dingtalk)
  local = new LocalAuthService(config, database.client, settings)
  administration = new IdentityAdministrationService(database.client, true)
  adminId = (await local.bootstrap({ username: 'dt.admin@example.invalid', name: '钉钉管理员', password })).userId
  registerLocalAuthRoutes(router, local)
  registerDingTalkAuthRoutes(router, new DingTalkAuthService(config, database.client, settings), local)
  registerDingTalkBindingRoutes(router, new PostgresDingTalkSelfBindingService(database.client, settings))
  router.get('/api/workbench/v1/session', (_request, context) => envelope('workbench', requireRequestIdentity(context, 'workbench'), 'postgres'))
})

beforeEach(async () => { await database.client`delete from local_auth_rate_limits` })
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (database) await database.dispose()
})

async function call(path: string, options: { method?: string; cookie?: string; body?: unknown; public?: boolean; origin?: string } = {}) {
  const hasBody = options.body !== undefined
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? (hasBody ? 'POST' : 'GET'), redirect: 'manual',
    headers: {
      ...(options.public ? { 'X-Forwarded-Host': publicHost } : {}),
      Origin: options.origin ?? (options.public ? publicOrigin : origin),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  const body = await response.json()
  return { status: response.status, cookie, body }
}

/** 已改过初始密码、拥有员工端权限的账号。 */
async function employee(options: { mustChangePassword?: boolean } = {}) {
  const username = `dt.employee.${++sequence}@example.invalid`
  const { userId } = await local.createAccount({ username, name: `员工${sequence}`, password }, adminId)
  await administration.grantRole({ userId, roleId: 'role-employee', actorId: adminId })
  if (!options.mustChangePassword) await database.client`update local_user_credentials set must_change_password = false where user_id = ${userId}`
  return { userId, username }
}

function member(name = '赵宁') {
  const userId = `ding-user-${++sequence}`
  dingtalk.addMember({ userId, name, unionId: `union-${sequence}`, departmentIds: [11, 12] })
  return userId
}

async function dingtalkLogin(dingUserId: string, options: { returnTo?: string } = {}) {
  return call('/auth/workbench/dingtalk/login', { public: true, body: { authCode: dingtalk.issueAuthCode(dingUserId), returnTo: options.returnTo ?? '/collab' } })
}

async function bindLogin(username: string, bindingToken: string, options: { public?: boolean; origin?: string } = {}) {
  return call('/auth/workbench/dingtalk/bind-login', { public: options.public ?? true, origin: options.origin, body: { username, password, bindingToken, returnTo: '/collab' } })
}

async function sessionOf(cookie: string | undefined) {
  return call('/api/workbench/v1/session', { public: true, cookie })
}

async function bindings(userId: string) {
  return [...await database.client<{ id: string; status: string; boundBy: string; externalUserId: string; revokeReason: string | null }[]>`
    select id, status, bound_by as "boundBy", external_user_id as "externalUserId", revoke_reason as "revokeReason"
      from external_account_bindings where user_id = ${userId} order by bound_at
  `]
}

async function bindNew() {
  const account = await employee()
  const dingUserId = member()
  const pending = await dingtalkLogin(dingUserId)
  const bound = await bindLogin(account.username, pending.body.bindingToken)
  assert.equal(bound.status, 200)
  assert.deepEqual(bound.body.binding, { status: 'bound' })
  return { ...account, dingUserId, cookie: bound.cookie! }
}

test('首次在钉钉内用密码登录即绑定，之后免登；会话来源为 dingtalk 且只撤销旧钉钉会话', async () => {
  const account = await employee()
  const dingUserId = member()
  const pending = await dingtalkLogin(dingUserId)
  assert.equal(pending.status, 200)
  assert.equal(pending.body.status, 'binding_required')
  assert.equal(pending.body.dingtalkName, '赵宁')
  assert.equal(pending.body.dingtalkDepartment, '销售部、华东区')
  assert.equal(pending.cookie, undefined)
  assert.equal(typeof pending.body.bindingToken, 'string')

  const bound = await bindLogin(account.username, pending.body.bindingToken)
  assert.equal(bound.status, 200)
  assert.deepEqual(bound.body.binding, { status: 'bound' })
  assert.equal(bound.body.location, `${publicOrigin}/collab`)
  const session = await sessionOf(bound.cookie)
  assert.equal(session.body.data.identityProvider, 'dingtalk')
  const [binding] = await bindings(account.userId)
  assert.equal(binding!.status, 'valid')
  assert.equal(binding!.boundBy, 'self')
  const [stored] = await database.client<{ bindingId: string; ttl: number }[]>`
    select binding_id as "bindingId", extract(epoch from expires_at - created_at)::integer as ttl
      from authentication_sessions where user_id = ${account.userId} and authentication_provider = 'dingtalk' and revoked_at is null
  `
  assert.equal(stored!.bindingId, binding!.id)
  assert.ok(stored!.ttl > 12 * 3600 - 60 && stored!.ttl <= 12 * 3600 + 5, `钉钉会话默认 12 小时，实际 ${stored!.ttl}s`)

  const again = await dingtalkLogin(dingUserId, { returnTo: '/collab/groups/g-1' })
  assert.equal(again.body.status, 'signed_in')
  assert.equal(again.body.location, `${publicOrigin}/collab/groups/g-1`)
  assert.equal((await sessionOf(again.cookie)).body.data.identityProvider, 'dingtalk')
  assert.equal((await sessionOf(bound.cookie)).status, 401, '重新免登撤销此前的钉钉会话')
  const audit = await database.client<{ action: string; result: string }[]>`
    select action, result from audit_events where actor_id = ${account.userId} and action = 'identity.dingtalk.bind'
  `
  assert.deepEqual([...audit], [{ action: 'identity.dingtalk.bind', result: 'success' }])
})

test('手机钉钉会话与桌面密码会话并存互不撤销；退出登录撤销全部来源', async () => {
  const { username, cookie: phone, dingUserId } = await bindNew()
  const desktop = await call('/auth/workbench/login', { body: { username, password } })
  assert.equal(desktop.status, 200)
  assert.equal((await sessionOf(phone)).status, 200, '桌面密码登录不撤销钉钉会话')
  const phoneAgain = await dingtalkLogin(dingUserId)
  assert.equal((await call('/api/workbench/v1/session', { cookie: desktop.cookie })).status, 200, '钉钉免登不撤销密码会话')
  const logout = await call('/auth/workbench/logout', { body: {}, cookie: desktop.cookie })
  assert.equal(logout.status, 200)
  assert.equal((await sessionOf(phoneAgain.cookie)).status, 401, '退出登录撤销全部来源的会话')
})

test('待绑定凭证单次有效：重复使用、过期、来源不符一律拒绝，且不绑定', async () => {
  const first = await employee()
  const dingUserId = member()
  const pending = await dingtalkLogin(dingUserId)
  const wrongOrigin = await bindLogin(first.username, pending.body.bindingToken, { public: false })
  assert.equal(wrongOrigin.status, 409, '桌面入口不能使用钉钉入口签发的凭证')
  assert.equal(wrongOrigin.body.error?.code ?? wrongOrigin.body.code, 'dingtalk_ticket_invalid')
  assert.equal(wrongOrigin.cookie, undefined)

  assert.equal((await bindLogin(first.username, pending.body.bindingToken)).status, 200)
  const second = await employee()
  const reused = await bindLogin(second.username, pending.body.bindingToken)
  assert.equal(reused.status, 409, '凭证不能重复使用')
  assert.deepEqual(await bindings(second.userId), [])

  const expiring = await dingtalkLogin(member())
  await database.client`update external_binding_tickets set expires_at = now() - interval '1 second' where consumed_at is null`
  assert.equal((await bindLogin(second.username, expiring.body.bindingToken)).status, 409, '过期凭证被拒')
  assert.equal((await bindLogin(second.username, 'forged-token-value')).status, 409, '伪造凭证被拒')
  assert.deepEqual(await bindings(second.userId), [])
})

test('授权码重放与非本企业授权码被拒；未登记的公网 origin 被拒；return_to 只接受同源路径', async () => {
  const dingUserId = member()
  const code = dingtalk.issueAuthCode(dingUserId)
  assert.equal((await call('/auth/workbench/dingtalk/login', { public: true, body: { authCode: code } })).status, 200)
  const replay = await call('/auth/workbench/dingtalk/login', { public: true, body: { authCode: code } })
  assert.equal(replay.status, 401, '授权码不能重放')
  const foreign = await call('/auth/workbench/dingtalk/login', { public: true, body: { authCode: dingtalk.issueForeignCode(dingUserId) } })
  assert.equal(foreign.status, 401, '非本企业授权码被拒')

  const response = await fetch(`${origin}/auth/workbench/dingtalk/login`, {
    method: 'POST', headers: { 'X-Forwarded-Host': 'evil.example.test', Origin: 'http://evil.example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ authCode: dingtalk.issueAuthCode(dingUserId) }),
  })
  assert.equal(response.status, 421, '未登记的公网 origin 被拒')
  const csrf = await call('/auth/workbench/dingtalk/login', { public: true, origin: 'http://evil.example.test', body: { authCode: dingtalk.issueAuthCode(dingUserId) } })
  assert.equal(csrf.status, 403, '跨站请求被拒')

  const { dingUserId: bound } = await bindNew()
  const external = await dingtalkLogin(bound, { returnTo: 'https://evil.example.test/steal' })
  assert.equal(external.body.location, `${publicOrigin}/`)
  const protocolRelative = await dingtalkLogin(bound, { returnTo: '//evil.example.test/steal' })
  assert.equal(protocolRelative.body.location, `${publicOrigin}/`)
})

test('钉钉账号已绑定他人时拒绝绑定但允许本次登录；平台账号已有其他绑定时不替换', async () => {
  const owner = await employee()
  const other = await employee()
  const dingUserId = member()
  const forOther = await dingtalkLogin(dingUserId)
  const forOwner = await dingtalkLogin(dingUserId)
  assert.deepEqual((await bindLogin(owner.username, forOwner.body.bindingToken)).body.binding, { status: 'bound' })

  const refused = await bindLogin(other.username, forOther.body.bindingToken)
  assert.equal(refused.status, 200)
  assert.deepEqual(refused.body.binding, { status: 'refused', reason: 'dingtalk_account_bound_to_other' })
  assert.equal((await sessionOf(refused.cookie)).body.data.identityProvider, 'local-password', '本次登录照常，签发密码会话')
  assert.deepEqual(await bindings(other.userId), [])

  const secondDevice = await dingtalkLogin(member('另一个钉钉'))
  const replaced = await bindLogin(owner.username, secondDevice.body.bindingToken)
  assert.deepEqual(replaced.body.binding, { status: 'refused', reason: 'account_has_other_binding' })
  const ownerBindings = await bindings(owner.userId)
  assert.equal(ownerBindings.length, 1)
  assert.equal(ownerBindings[0]!.externalUserId, dingUserId, '只凭密码不替换已有绑定')
})

test('并发绑定同一钉钉账号只有一个成功', async () => {
  const dingUserId = member()
  const accounts = await Promise.all([employee(), employee()])
  const tickets = [await dingtalkLogin(dingUserId), await dingtalkLogin(dingUserId)]
  const results = await Promise.all(accounts.map((account, index) => bindLogin(account.username, tickets[index]!.body.bindingToken)))
  assert.deepEqual(results.map(result => result.status), [200, 200])
  assert.deepEqual(results.map(result => result.body.binding.status).sort(), ['bound', 'refused'])
  const [{ count }] = await database.client<{ count: number }[]>`
    select count(*)::integer as count from external_account_bindings where external_user_id = ${dingUserId} and status = 'valid'
  `
  assert.equal(count, 1)
})

test('同一员工并发绑定同一个钉钉账号：两次都视为已绑定', async () => {
  const account = await employee()
  const dingUserId = member()
  const tickets = [await dingtalkLogin(dingUserId), await dingtalkLogin(dingUserId)]
  const results = await Promise.all(tickets.map(ticket => bindLogin(account.username, ticket.body.bindingToken)))
  assert.deepEqual(results.map(result => result.body.binding), [{ status: 'bound' }, { status: 'bound' }])
  assert.equal((await bindings(account.userId)).filter(row => row.status === 'valid').length, 1)
})

test('需改初始密码时先改密再绑定：改密请求带回凭证后才写入绑定', async () => {
  const account = await employee({ mustChangePassword: true })
  const dingUserId = member()
  const pending = await dingtalkLogin(dingUserId)
  const first = await bindLogin(account.username, pending.body.bindingToken)
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.binding, { status: 'password_change_required' })
  assert.match(first.body.location, /\/change-password\?return_to=/)
  assert.deepEqual(await bindings(account.userId), [], '改密前不绑定')

  const changed = await call('/auth/workbench/password', {
    public: true, cookie: first.cookie,
    body: { currentPassword: password, newPassword: 'Changed12345', returnTo: '/collab', dingtalkBindingToken: pending.body.bindingToken },
  })
  assert.equal(changed.status, 200)
  assert.deepEqual(changed.body.binding, { status: 'bound' })
  assert.equal((await sessionOf(changed.cookie)).body.data.identityProvider, 'dingtalk')
  assert.equal((await bindings(account.userId))[0]!.status, 'valid')
  assert.equal((await dingtalkLogin(dingUserId)).body.status, 'signed_in')
})

test('dingtalk 会话不要求密码凭据、不能用于改密；绑定失效后按 binding_id 撤销', async () => {
  const { userId, cookie, dingUserId } = await bindNew()
  const change = await call('/auth/workbench/password', { public: true, cookie, body: { currentPassword: password, newPassword: 'Changed12345' } })
  assert.equal(change.status, 403, '钉钉会话不能修改密码')

  await database.client`update external_account_bindings set status = 'invalid', revoked_at = now(), revoke_reason = 'test' where user_id = ${userId}`
  assert.equal((await sessionOf(cookie)).status, 401, '绑定失效后钉钉会话立即不可用')
  assert.equal((await dingtalkLogin(dingUserId)).body.status, 'binding_required', '失效后重新进入登录即绑定')
})

test('钉钉会话过期后重新免登签发；管理员锁定后无法自行重新绑定', async () => {
  const { userId, cookie, dingUserId } = await bindNew()
  await database.client`update authentication_sessions set expires_at = now() - interval '1 second' where user_id = ${userId} and authentication_provider = 'dingtalk'`
  assert.equal((await sessionOf(cookie)).status, 401)
  const renewed = await dingtalkLogin(dingUserId)
  assert.equal(renewed.body.status, 'signed_in')
  assert.equal((await sessionOf(renewed.cookie)).status, 200)

  await database.client`
    update external_account_bindings set status = 'invalid', revoked_at = now(), revoke_reason = 'admin_unbind', self_rebind_locked = true
     where user_id = ${userId}
  `
  const pending = await dingtalkLogin(dingUserId)
  const { username } = (await database.client<{ username: string }[]>`select username from local_user_credentials where user_id = ${userId}`)[0]!
  const locked = await bindLogin(username, pending.body.bindingToken)
  assert.deepEqual(locked.body.binding, { status: 'refused', reason: 'self_bind_locked' })
  assert.equal((await bindings(userId)).filter(row => row.status === 'valid').length, 0)
})

test('管理员重置密码与停用账号使绑定失效并撤销钉钉会话', async () => {
  const reset = await bindNew()
  await local.resetPassword(reset.userId, 'Reset1234567', adminId)
  assert.equal((await sessionOf(reset.cookie)).status, 401)
  assert.equal((await bindings(reset.userId))[0]!.revokeReason, 'admin_password_reset')

  const disabled = await bindNew()
  await local.setStatus(disabled.userId, 'disabled', adminId)
  assert.equal((await sessionOf(disabled.cookie)).status, 401)
  assert.equal((await bindings(disabled.userId))[0]!.revokeReason, 'account_disabled')
  const pending = await dingtalkLogin(disabled.dingUserId)
  assert.equal(pending.body.status, 'binding_required', '停用账号的钉钉账号不再免登')
})

test('员工自己改密时绑定保留、会话全部撤销，钉钉内下次自动免登', async () => {
  const { username, cookie, userId, dingUserId } = await bindNew()
  const desktop = await call('/auth/workbench/login', { body: { username, password } })
  const changed = await call('/auth/workbench/password', { cookie: desktop.cookie, body: { currentPassword: password, newPassword: 'Changed12345' } })
  assert.equal(changed.status, 200)
  assert.equal((await sessionOf(cookie)).status, 401)
  assert.equal((await bindings(userId))[0]!.status, 'valid')
  assert.equal((await dingtalkLogin(dingUserId)).body.status, 'signed_in')
})

test('数据库约束：dingtalk 会话必须关联绑定，其他来源不得带 binding_id', async () => {
  const { userId } = await bindNew()
  await assert.rejects(database.client`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider, authorization_version, permissions_expires_at, expires_at)
    values ('constraint-check-1', 'tenant-dsh-work', 'workbench', ${userId}, 'dingtalk', 1, now() + interval '1 hour', now() + interval '1 hour')
  `)
  const [binding] = await bindings(userId)
  await assert.rejects(database.client`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider, binding_id, authorization_version, permissions_expires_at, expires_at)
    values ('constraint-check-2', 'tenant-dsh-work', 'workbench', ${userId}, 'local-password', ${binding!.id}, 1, now() + interval '1 hour', now() + interval '1 hour')
  `)
  await assert.rejects(database.client`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider, authorization_version, permissions_expires_at, expires_at)
    values ('constraint-check-3', 'tenant-dsh-work', 'workbench', ${userId}, 'wechat', 1, now() + interval '1 hour', now() + interval '1 hour')
  `)
})

test('钉钉不可用时明确报告不可用，不降级', async () => {
  const { DingTalkDirectoryError } = await import('./dingtalk/dingtalk-directory.ts')
  dingtalk.failure = new DingTalkDirectoryError('unavailable', '限流', 90018)
  try {
    const result = await call('/auth/workbench/dingtalk/login', { public: true, body: { authCode: 'code-anything' } })
    assert.equal(result.status, 503)
  } finally {
    dingtalk.failure = null
  }
})

test('用户中心 › 钉钉：查看本人绑定；自行解除后钉钉内登录立即失效，之后可重新绑定', async () => {
  const { cookie, dingUserId, userId } = await bindNew()
  const view = await call('/api/workbench/v1/me/dingtalk-binding', { public: true, cookie })
  assert.equal(view.status, 200)
  assert.equal(view.body.data.enabled, true)
  assert.equal(view.body.data.status, 'bound')
  assert.equal(view.body.data.binding.boundBy, 'self')
  assert.equal(view.body.data.binding.dingtalkName, '赵宁')
  assert.equal(view.body.data.binding.dingtalkDepartment, '销售部、华东区')

  const unbound = await call('/api/workbench/v1/me/dingtalk-binding', { public: true, cookie, method: 'DELETE' })
  assert.equal(unbound.status, 200)
  assert.equal(unbound.body.data.status, 'invalid')
  assert.equal(unbound.body.data.invalid.reason, 'self_unbind')
  assert.equal(unbound.body.data.selfRebindLocked, false)
  assert.equal((await sessionOf(cookie)).status, 401, '当前钉钉会话随解绑撤销')
  const [audit] = await database.client<{ count: number }[]>`select count(*)::integer as count from audit_events where actor_id = ${userId} and action = 'identity.dingtalk.self_unbind'`
  assert.equal(audit!.count, 1)

  const desktop = await call('/auth/workbench/login', { body: { username: (await database.client<{ username: string }[]>`select username from local_user_credentials where user_id = ${userId}`)[0]!.username, password } })
  assert.equal((await call('/api/workbench/v1/me/dingtalk-binding', { cookie: desktop.cookie, method: 'DELETE' })).status, 404, '没有有效绑定时不能再解绑')
  assert.equal((await dingtalkLogin(dingUserId)).body.status, 'binding_required', '解绑后在钉钉内登录一次可重新绑定')
})
