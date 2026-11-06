import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { DingTalkDirectoryDouble } from '../../testing/dingtalk-double.ts'
import { PostgresEncryptedCredentialStore } from '../tool/postgres-encrypted-credential-store.ts'
import { IdentityAdministrationService } from './administration-service.ts'
import { DingTalkAdministrationService } from './dingtalk/dingtalk-admin-service.ts'
import { loadDingTalkConfiguration, type DingTalkConfiguration } from './dingtalk/dingtalk-config.ts'
import { DingTalkDirectoryError } from './dingtalk/dingtalk-directory.ts'
import { DingTalkSettingsService, dingtalkCredentialRefId } from './dingtalk/dingtalk-settings.ts'
import { loadIdentityConfiguration } from './config.ts'
import { LocalAuthService } from './local-auth-service.ts'
import type { LocalIdentityConfiguration } from './types.ts'

// 钉钉应用配置改在管理端填写（2026-11-06）：AppSecret 加密入库、保存前向钉钉验证、立即生效、部署配置只作初始配置。

const password = 'Initial12345'
const correctSecret = 'correct-app-secret-0001'
const masterKey = randomBytes(32).toString('base64')
let database: ThrowawayDatabase
let adminId: string
let employeeId: string
const verified: DingTalkConfiguration[] = []

/** 假钉钉：只有 AppSecret 正确时才能换取 access_token。 */
function directoryFactory(configuration: DingTalkConfiguration) {
  const double = new DingTalkDirectoryDouble(configuration.corpId)
  double.checkCredentials = async () => {
    verified.push(configuration)
    if (configuration.appSecret !== correctSecret) throw new DingTalkDirectoryError('configuration_invalid', '凭据无效', 40089)
  }
  return double
}

function settingsService(options: { bootstrap?: DingTalkConfiguration | null; withCredentials?: boolean; key?: string } = {}) {
  return new DingTalkSettingsService(database.client, {
    deployment: { apiBaseUrl: 'https://oapi.dingtalk.com/', bootstrap: options.bootstrap ?? null },
    ...(options.withCredentials === false ? {} : { credentials: new PostgresEncryptedCredentialStore(database.client, { masterKeyBase64: options.key ?? masterKey }) }),
    directoryFactory,
  })
}

const pageInput = {
  corpId: 'ding-corp-page', agentId: '3189002', appKey: 'page-app-key', appSecret: correctSecret,
  sessionTtlSeconds: 7200, bindingTicketTtlSeconds: 600, adminDailyBindLimit: 20, timeoutMs: 5000,
}

async function code(promise: Promise<unknown>) {
  return promise.then(() => 'ok', (error: { code?: string }) => error.code ?? String(error))
}

before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_dingtalk_settings_test', maxConnections: 2 })
  const config = loadIdentityConfiguration({
    DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: 'dingtalk-settings-secret-with-32-chars!!',
    DSH_WORK_WORKBENCH_ORIGINS: 'http://localhost:4174', DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180',
  }) as LocalIdentityConfiguration
  const local = new LocalAuthService(config, database.client)
  adminId = (await local.bootstrap({ username: 'dt.settings.admin@example.invalid', name: '陈默', password })).userId
  employeeId = (await local.createAccount({ username: 'dt.settings.e@example.invalid', name: '员工', password }, adminId)).userId
  await new IdentityAdministrationService(database.client, true).grantRole({ userId: employeeId, roleId: 'role-employee', actorId: adminId })
})

after(async () => { if (database) await database.dispose() })

test('部署配置只在页面从未保存过时作为初始配置；页面保存后以页面为准', async () => {
  const bootstrap = loadDingTalkConfiguration({
    DSH_WORK_DINGTALK_CORP_ID: 'ding-corp-env', DSH_WORK_DINGTALK_AGENT_ID: '3189001',
    DSH_WORK_DINGTALK_APP_KEY: 'env-app-key', DSH_WORK_DINGTALK_APP_SECRET: correctSecret,
  })!
  const fromEnvironment = settingsService({ bootstrap })
  await fromEnvironment.ensureBootstrap()
  const initial = await fromEnvironment.current()
  assert.equal(initial!.corpId, 'ding-corp-env')
  assert.equal(initial!.appSecret, correctSecret, '部署配置的 AppSecret 只在内存中使用')
  const view = await fromEnvironment.view()
  assert.equal(view.source, 'deployment-config')
  assert.equal(view.secretHint, '0001')
  const [stored] = await database.client`select count(*)::integer as count from credential_secrets where credential_ref_id = ${dingtalkCredentialRefId}`
  assert.equal(stored!.count, 0, '部署配置的 AppSecret 不入库')

  // 只改其他参数、不填 AppSecret：同一个应用沿用部署配置的 AppSecret。
  const updated = await fromEnvironment.save({ ...pageInput, corpId: 'ding-corp-env', appKey: 'env-app-key', appSecret: '' }, adminId)
  assert.equal(updated.source, 'admin')
  assert.equal(updated.sessionTtlSeconds, 7200)
  assert.equal((await fromEnvironment.current())!.sessionTtlSeconds, 7200, '保存后立即生效，无需重启')

  // 页面保存过之后，部署配置变化不再覆盖。
  const changedEnvironment = settingsService({ bootstrap: { ...bootstrap, corpId: 'ding-corp-other' } })
  await changedEnvironment.ensureBootstrap()
  assert.equal((await changedEnvironment.view()).corpId, 'ding-corp-env')
})

test('保存前向钉钉验证凭据，不通过不保存；AppSecret 加密入库、不回显、审计不含密钥', async () => {
  const service = settingsService()
  const before = await service.view()
  assert.equal(await code(service.save({ ...pageInput, appSecret: 'wrong-app-secret-9999' }, adminId)), 'dingtalk_credentials_rejected')
  assert.deepEqual({ ...(await service.view()) }, { ...before }, '验证失败时配置不变')

  assert.equal(await code(service.save({ ...pageInput, appSecret: '' }, adminId)), 'dingtalk_secret_required', '更换 CorpId 或 AppKey 时须重新填写 AppSecret')

  const saved = await service.save(pageInput, adminId)
  assert.equal(saved.configured, true)
  assert.equal(saved.corpId, 'ding-corp-page')
  assert.equal(saved.secretHint, '0001')
  assert.equal(saved.secretReadable, true)
  assert.equal(saved.updatedByName, '陈默')
  assert.ok(!JSON.stringify(saved).includes(correctSecret), '接口不回显 AppSecret')
  assert.equal(verified.at(-1)!.appSecret, correctSecret)
  assert.equal(verified.at(-1)!.apiBaseUrl, 'https://oapi.dingtalk.com/', '开放平台地址只来自部署配置')

  const [secret] = await database.client<{ ciphertext: Uint8Array }[]>`select ciphertext from credential_secrets where credential_ref_id = ${dingtalkCredentialRefId}`
  assert.ok(!Buffer.from(secret!.ciphertext).toString('utf8').includes(correctSecret), 'AppSecret 加密保存')
  const [row] = await database.client`select * from dingtalk_app_configurations`
  assert.ok(!JSON.stringify(row).includes(correctSecret), '配置表不存 AppSecret')
  const audits = await database.client<{ context: unknown }[]>`select safe_context as context from audit_events where action like 'identity.dingtalk.settings.%'`
  assert.ok(audits.length >= 2)
  assert.ok(!JSON.stringify(audits).includes(correctSecret), '审计不含 AppSecret')

  const current = await service.current()
  assert.equal(current!.appSecret, correctSecret)
  assert.equal(current!.adminDailyBindLimit, 20)
  assert.equal(current!.bindingTicketTtlSeconds, 600)

  assert.equal(await code(service.save({ ...pageInput, sessionTtlSeconds: 10 }, adminId)), 'invalid_request', '参数越界被拒')
})

test('主密钥未配置时不能在页面保存 AppSecret；主密钥更换后提示重新填写', async () => {
  assert.equal(await code(settingsService({ withCredentials: false }).save(pageInput, adminId)), 'credential_master_key_missing')
  const rotated = settingsService({ key: randomBytes(32).toString('base64') })
  const view = await rotated.view()
  assert.equal(view.configured, true)
  assert.equal(view.secretReadable, false)
  assert.equal(await rotated.current(), null, '无法解密时视为未配置，不使用错误的凭据')
  assert.equal(await code(rotated.save({ ...pageInput, appSecret: '' }, adminId)), 'dingtalk_secret_required')
})

test('只有平台管理员可以查看与修改；清除后钉钉功能立即停用，部署配置不会自动恢复', async () => {
  const service = settingsService()
  const admin = new DingTalkAdministrationService(database.client, service, { manager: service, secret: 'x'.repeat(32), workbenchOrigins: [] })
  assert.equal(await code(admin.getSettings(employeeId)), 'permission_denied')
  assert.equal(await code(admin.saveSettings(pageInput, employeeId)), 'permission_denied')
  assert.equal((await admin.getSettings(adminId)).configured, true)
  assert.equal((await admin.overview(adminId)).configured, true)

  const cleared = await admin.clearSettings(adminId)
  assert.equal(cleared.configured, false)
  assert.equal(await service.current(), null)
  assert.equal((await admin.overview(adminId)).configured, false)
  assert.equal((await admin.checkConnection(adminId)).connection!.status, 'configuration_error')
  const [secret] = await database.client`select count(*)::integer as count from credential_secrets where credential_ref_id = ${dingtalkCredentialRefId}`
  assert.equal(secret!.count, 0, '清除时删除已加密的 AppSecret')

  const bootstrap = loadDingTalkConfiguration({
    DSH_WORK_DINGTALK_CORP_ID: 'ding-corp-env', DSH_WORK_DINGTALK_AGENT_ID: '3189001',
    DSH_WORK_DINGTALK_APP_KEY: 'env-app-key', DSH_WORK_DINGTALK_APP_SECRET: correctSecret,
  })!
  const restarted = settingsService({ bootstrap })
  await restarted.ensureBootstrap()
  assert.equal(await restarted.current(), null, '管理员清除后，重启不会让部署配置重新生效')

  const resaved = await admin.saveSettings(pageInput, adminId)
  assert.equal(resaved.configured, true)
  assert.equal((await service.current())!.corpId, 'ding-corp-page')
})

async function seedBinding(userId: string, externalUserId: string) {
  const bindingId = `binding-${externalUserId}`
  await database.client`
    insert into external_account_bindings (id, tenant_id, channel, user_id, external_user_id, bound_by, status)
    values (${bindingId}, 'tenant-dsh-work', 'dingtalk', ${userId}, ${externalUserId}, 'self', 'valid')
  `
  await database.client`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider, binding_id, authorization_version, permissions_expires_at, expires_at)
    values (${`s-${externalUserId}`}, 'tenant-dsh-work', 'workbench', ${userId}, 'dingtalk', ${bindingId}, 1, now() + interval '1 hour', now() + interval '1 hour')
  `
  await database.client`
    insert into external_binding_tickets (ticket_hash, tenant_id, channel, purpose, external_user_id, corp_id, request_origin, expires_at)
    values (${`t-${externalUserId}`}, 'tenant-dsh-work', 'dingtalk', 'self-bind', ${externalUserId}, 'old-corp', 'http://localhost:4174', now() + interval '5 minutes')
  `
  return bindingId
}

async function bindingState(bindingId: string) {
  const [binding] = await database.client<{ status: string; reason: string | null }[]>`select status, revoke_reason as reason from external_account_bindings where id = ${bindingId}`
  const [session] = await database.client<{ revoked: boolean }[]>`select revoked_at is not null as revoked from authentication_sessions where binding_id = ${bindingId}`
  const [tickets] = await database.client<{ count: number }[]>`select count(*)::integer as count from external_binding_tickets where consumed_at is null`
  return { status: binding!.status, reason: binding!.reason, sessionRevoked: session!.revoked, openTickets: tickets!.count }
}

test('换到另一个钉钉企业（页面保存）时，所有绑定失效、钉钉会话撤销、未用凭证删除；同企业改参数不影响绑定', async () => {
  const service = settingsService()
  await service.save(pageInput, adminId)
  const bindingId = await seedBinding(employeeId, 'ding-user-a')
  await service.save({ ...pageInput, appSecret: '', adminDailyBindLimit: 21 }, adminId)
  assert.equal((await bindingState(bindingId)).status, 'valid', '同一企业只改参数不失效')

  await service.save({ ...pageInput, corpId: 'ding-corp-b' }, adminId)
  assert.deepEqual(await bindingState(bindingId), { status: 'invalid', reason: 'corp_changed', sessionRevoked: true, openTickets: 0 })
  const [audit] = await database.client<{ context: Record<string, string> }[]>`
    select safe_context as context from audit_events where action = 'identity.dingtalk.settings.update' order by occurred_at desc limit 1
  `
  assert.equal(audit!.context.previousCorpId, 'ding-corp-page')
  assert.equal(audit!.context.invalidatedBindings, '1')
})

test('部署配置换了企业：启动同步初始配置时同样使旧企业的绑定失效；超出范围的部署值收进范围、不阻止启动', async () => {
  await database.client`delete from dingtalk_app_configurations`
  const base = {
    DSH_WORK_DINGTALK_AGENT_ID: '3189001', DSH_WORK_DINGTALK_APP_KEY: 'env-app-key', DSH_WORK_DINGTALK_APP_SECRET: correctSecret,
  }
  const first = settingsService({ bootstrap: loadDingTalkConfiguration({ ...base, DSH_WORK_DINGTALK_CORP_ID: 'ding-corp-env-a', DSH_WORK_DINGTALK_TIMEOUT_MS: '500' })! })
  await first.ensureBootstrap()
  assert.equal((await first.current())!.timeoutMs, 1000, '500 毫秒收进 1–60 秒范围')
  await database.client`delete from external_account_bindings where external_user_id = 'ding-user-env'`
  const bindingId = await seedBinding(employeeId, 'ding-user-env')

  const second = settingsService({ bootstrap: loadDingTalkConfiguration({ ...base, DSH_WORK_DINGTALK_CORP_ID: 'ding-corp-env-b' })! })
  await second.ensureBootstrap()
  assert.equal((await second.current())!.corpId, 'ding-corp-env-b')
  assert.equal((await bindingState(bindingId)).reason, 'corp_changed')
})

test('依赖部署配置的 AppSecret：删除部署配置后提示原因；页面保存一次即加密入库、不再依赖部署配置', async () => {
  await database.client`delete from dingtalk_app_configurations`
  await database.client`delete from credential_secrets where credential_ref_id = ${dingtalkCredentialRefId}`
  const bootstrap = loadDingTalkConfiguration({
    DSH_WORK_DINGTALK_CORP_ID: 'ding-corp-env', DSH_WORK_DINGTALK_AGENT_ID: '3189001',
    DSH_WORK_DINGTALK_APP_KEY: 'env-app-key', DSH_WORK_DINGTALK_APP_SECRET: correctSecret,
  })!
  await settingsService({ bootstrap }).ensureBootstrap()
  const withoutEnvironment = settingsService()
  const missing = await withoutEnvironment.view()
  assert.equal(missing.secretReadable, false)
  assert.equal(missing.secretProblem, 'deployment_secret_missing')
  const failure = await withoutEnvironment.save({ ...pageInput, corpId: 'ding-corp-env', appKey: 'env-app-key', appSecret: '' }, adminId)
    .then(() => '', (error: Error) => error.message)
  assert.match(failure, /部署配置中已没有它/)

  const withEnvironment = settingsService({ bootstrap })
  const saved = await withEnvironment.save({ ...pageInput, corpId: 'ding-corp-env', appKey: 'env-app-key', appSecret: '' }, adminId)
  assert.equal(saved.source, 'admin')
  const [row] = await database.client<{ credentialRef: string | null }[]>`select credential_ref as "credentialRef" from dingtalk_app_configurations`
  assert.equal(row!.credentialRef, dingtalkCredentialRefId, '部署配置的 AppSecret 已加密入库')
  assert.equal((await settingsService().current())!.appSecret, correctSecret, '删除部署配置后仍可用')
})

test('验证期间配置被其他管理员清除时不保存，不写回指向已删除密钥的配置', async () => {
  const service = settingsService()
  await service.save(pageInput, adminId)
  const racing = new DingTalkSettingsService(database.client, {
    deployment: { apiBaseUrl: 'https://oapi.dingtalk.com/', bootstrap: null },
    credentials: new PostgresEncryptedCredentialStore(database.client, { masterKeyBase64: masterKey }),
    directoryFactory: configuration => {
      const double = new DingTalkDirectoryDouble(configuration.corpId)
      double.checkCredentials = async () => { await service.clear(adminId) }
      return double
    },
  })
  assert.equal(await code(racing.save({ ...pageInput, appSecret: '', adminDailyBindLimit: 22 }, adminId)), 'dingtalk_settings_changed')
  const view = await service.view()
  assert.equal(view.configured, false, '清除结果保留')
})
