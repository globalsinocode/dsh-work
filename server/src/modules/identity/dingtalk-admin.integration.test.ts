import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../infrastructure/postgres/test-database.ts'
import { DingTalkDirectoryDouble } from '../../testing/dingtalk-double.ts'
import { PostgresUserNotificationService } from '../workbench/application/postgres-user-notification-service.ts'
import { IdentityAdministrationService } from './administration-service.ts'
import { bindFromSelfTicket } from './dingtalk/dingtalk-bindings.ts'
import { DingTalkAdministrationService } from './dingtalk/dingtalk-admin-service.ts'
import { loadDingTalkConfiguration } from './dingtalk/dingtalk-config.ts'
import { DingTalkSettingsService } from './dingtalk/dingtalk-settings.ts'
import { DingTalkDirectoryError } from './dingtalk/dingtalk-directory.ts'
import { LocalAuthService } from './local-auth-service.ts'
import { loadIdentityConfiguration } from './config.ts'
import type { LocalIdentityConfiguration } from './types.ts'

// 钉钉接入方案第 9 节 P1（DT-S1 管理端部分）：管理员代绑、解绑、锁定、集成页与离职检查。

const password = 'Initial12345'
let database: ThrowawayDatabase
let local: LocalAuthService
let administration: IdentityAdministrationService
let dingtalk: DingTalkDirectoryDouble
let service: DingTalkAdministrationService
let adminId: string
let secondAdminId: string
let sequence = 0

before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_dingtalk_admin_test', maxConnections: 2 })
  const config = loadIdentityConfiguration({
    DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: 'dingtalk-admin-secret-with-32-characters!',
    DSH_WORK_WORKBENCH_ORIGINS: 'https://m.example.test', DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180',
  }) as LocalIdentityConfiguration
  const dingtalkConfig = loadDingTalkConfiguration({
    DSH_WORK_DINGTALK_CORP_ID: 'ding-corp-test', DSH_WORK_DINGTALK_AGENT_ID: '3189', DSH_WORK_DINGTALK_APP_KEY: 'k', DSH_WORK_DINGTALK_APP_SECRET: 's',
    DSH_WORK_DINGTALK_ADMIN_DAILY_BIND_LIMIT: '6',
  })!
  dingtalk = new DingTalkDirectoryDouble('ding-corp-test').addDepartment(11, '销售部').addDepartment(12, '华东区')
  // 走真实的配置服务：部署配置作为初始配置写入（页面从未保存过），目录实现换成测试替身。
  const settings = new DingTalkSettingsService(database.client, {
    deployment: { apiBaseUrl: dingtalkConfig.apiBaseUrl, bootstrap: dingtalkConfig }, directoryFactory: () => dingtalk,
  })
  await settings.ensureBootstrap()
  local = new LocalAuthService(config, database.client, settings)
  administration = new IdentityAdministrationService(database.client, true)
  service = new DingTalkAdministrationService(database.client, settings, { manager: settings, secret: config.sessionSecret, workbenchOrigins: config.audiences.workbench.allowedOrigins })
  adminId = (await local.bootstrap({ username: 'dt.admin@example.invalid', name: '陈默', password })).userId
  const second = await local.createAccount({ username: 'dt.admin2@example.invalid', name: '第二管理员', password }, adminId)
  await administration.grantRole({ userId: second.userId, roleId: 'role-platform-admin', actorId: adminId })
  secondAdminId = second.userId
})

after(async () => { if (database) await database.dispose() })

async function employee(name = `员工${++sequence}`) {
  const { userId } = await local.createAccount({ username: `dt.e.${++sequence}@example.invalid`, name, password }, adminId)
  await administration.grantRole({ userId, roleId: 'role-employee', actorId: adminId })
  return userId
}

function mobile() {
  return `139${String(10_000_000 + ++sequence).slice(-8)}`
}

function member(name: string, options: { departments?: number[] } = {}) {
  const userId = `ding-${++sequence}`
  const phone = mobile()
  dingtalk.addMember({ userId, name, mobile: phone, departmentIds: options.departments ?? [11] })
  return { userId, phone }
}

async function bind(userId: string, phone: string, actor = adminId, extra: Record<string, unknown> = {}) {
  const preview = await service.preview(userId, { mobile: phone }, actor)
  return service.confirm(userId, { confirmationToken: preview.confirmationToken, identityConfirmed: true, ...extra }, actor)
}

async function code(promise: Promise<unknown>) {
  return promise.then(() => 'ok', (error: { code?: string }) => error.code ?? String(error))
}

async function dingSessions(userId: string) {
  return (await database.client<{ count: number }[]>`
    select count(*)::integer as count from authentication_sessions where user_id = ${userId} and authentication_provider = 'dingtalk' and revoked_at is null
  `)[0]!.count
}

async function insertDingSession(userId: string) {
  const [binding] = await database.client<{ id: string }[]>`select id from external_account_bindings where user_id = ${userId} and status = 'valid'`
  await database.client`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider, binding_id, authorization_version, permissions_expires_at, expires_at)
    values (${`s-${randomUUID()}`}, 'tenant-dsh-work', 'workbench', ${userId}, 'dingtalk', ${binding!.id}, 1, now() + interval '1 hour', now() + interval '1 hour')
  `
}

async function notifications(userId: string) {
  return (await new PostgresUserNotificationService(database.client).list({ userId, status: 'all' })).items
}

test('代绑预览显示钉钉姓名与部门并返回确认凭证；确认只接受凭证，写绑定、通知本人、审计不含手机号', async () => {
  const userId = await employee('赵宁')
  const { userId: dingUserId, phone } = member('赵宁', { departments: [11, 12] })
  const preview = await service.preview(userId, { mobile: `+86 ${phone.slice(0, 3)} ${phone.slice(3)}` }, adminId)
  assert.equal(preview.dingtalkName, '赵宁')
  assert.equal(preview.dingtalkDepartment, '销售部、华东区')
  assert.equal(preview.nameMatches, true)
  assert.equal(preview.requireIdentityConfirmation, false)
  assert.equal(preview.maskedMobile, `*******${phone.slice(-4)}`)
  assert.equal(preview.conflict, null)
  assert.equal(await code(service.confirm(userId, { userId: dingUserId } as Parameters<typeof service.confirm>[1], adminId)), 'invalid_request', '确认只接受确认凭证')
  assert.equal(await code(service.confirm(userId, { confirmationToken: 'forged' }, adminId)), 'dingtalk_confirmation_invalid')
  assert.equal(await code(service.confirm(userId, { confirmationToken: preview.confirmationToken }, secondAdminId)), 'dingtalk_confirmation_invalid', '凭证固定发起的管理员')
  const other = await employee()
  assert.equal(await code(service.confirm(other, { confirmationToken: preview.confirmationToken }, adminId)), 'dingtalk_confirmation_invalid', '凭证固定目标员工')

  const view = await service.confirm(userId, { confirmationToken: preview.confirmationToken }, adminId)
  assert.equal(view.status, 'bound')
  assert.equal(view.binding!.boundBy, 'admin')
  assert.equal(view.binding!.boundByAdminName, '陈默')
  assert.equal(view.binding!.dingtalkName, '赵宁')
  assert.equal(await code(service.confirm(userId, { confirmationToken: preview.confirmationToken }, adminId)), 'dingtalk_confirmation_invalid', '凭证单次有效')

  const [item] = await notifications(userId)
  assert.equal(item!.kind, 'dingtalk_bound_by_admin')
  assert.equal(item!.objectName, '赵宁')
  assert.equal(item!.actor!.name, '陈默')
  const audits = await database.client<{ context: Record<string, string> }[]>`
    select safe_context as context from audit_events where action like 'identity.dingtalk.admin_bind%' and object_id = ${userId}
  `
  assert.equal(audits.length, 2)
  for (const audit of audits) {
    assert.equal(audit.context.maskedMobile, `*******${phone.slice(-4)}`)
    assert.match(audit.context.mobileHash!, /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(audit.context).includes(phone), '审计不保存完整手机号')
  }
  const [columns] = await database.client<{ count: number }[]>`
    select count(*)::integer as count from information_schema.columns where table_name = 'external_account_bindings' and column_name like '%mobile%'
  `
  assert.equal(columns!.count, 0, '平台不保存手机号字段')
})

test('姓名不一致或部门无法读取时须勾选“我已核实是本人”；未找到与无效号码直接提示', async () => {
  const userId = await employee('王一凡')
  const mismatch = member('王逸帆')
  const preview = await service.preview(userId, { mobile: mismatch.phone }, adminId)
  assert.equal(preview.nameMatches, false)
  assert.equal(preview.requireIdentityConfirmation, true)
  assert.equal(await code(service.confirm(userId, { confirmationToken: preview.confirmationToken }, adminId)), 'dingtalk_identity_confirmation_required')
  assert.equal((await service.confirm(userId, { confirmationToken: preview.confirmationToken, identityConfirmed: true }, adminId)).status, 'bound', '未确认的请求不消费凭证')

  const second = await employee('周婷')
  const noDepartment = member('周婷', { departments: [99] })
  const departmentless = await service.preview(second, { mobile: noDepartment.phone }, adminId)
  assert.equal(departmentless.dingtalkDepartment, null)
  assert.equal(departmentless.requireIdentityConfirmation, true)

  assert.equal(await code(service.preview(second, { mobile: '13800000000' }, adminId)), 'dingtalk_member_not_found')
  assert.equal(await code(service.preview(second, { mobile: '12345' }, adminId)), 'dingtalk_invalid_mobile')
  dingtalk.failure = new DingTalkDirectoryError('permission_denied', 'no scope', 60011)
  try {
    assert.equal(await code(service.preview(second, { mobile: noDepartment.phone }, adminId)), 'dingtalk_configuration_error')
  } finally { dingtalk.failure = null }
})

test('不能为管理类账号代绑；非平台管理员不能代绑；单个管理员每日代绑有上限', async () => {
  const target = member('第二管理员')
  assert.equal(await code(service.preview(secondAdminId, { mobile: target.phone }, adminId)), 'dingtalk_admin_account')
  const auditor = await employee()
  const [auditRole] = await database.client<{ id: string }[]>`select id from roles where permissions ? 'audit:read' and id <> 'role-platform-admin' limit 1`
  if (auditRole) {
    await administration.grantRole({ userId: auditor, roleId: auditRole.id, actorId: adminId })
    assert.equal(await code(service.preview(auditor, { mobile: target.phone }, adminId)), 'dingtalk_admin_account')
  }
  const plain = await employee()
  assert.equal(await code(service.preview(plain, { mobile: target.phone }, plain)), 'permission_denied')

  // 第二位管理员今天已代绑 0 次；上限为 6。
  for (let index = 0; index < 6; index += 1) {
    const user = await employee()
    const { phone } = member(`限额${index}`)
    await bind(user, phone, secondAdminId)
  }
  const overflow = await employee()
  const preview = await service.preview(overflow, { mobile: member('超额').phone }, secondAdminId)
  assert.equal(await code(service.confirm(overflow, { confirmationToken: preview.confirmationToken, identityConfirmed: true }, secondAdminId)), 'dingtalk_admin_daily_limit')
  // 预览另有上限（代绑上限的 4 倍）：按手机号查钉钉成员不能无限次。
  await database.client`
    insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id)
    select 'audit-preview-fill-' || g, 'tenant-dsh-work', 'user', ${secondAdminId}, 'identity.dingtalk.admin_bind.preview', 'dingtalk_binding', ${overflow}, 'success', 'trace-fill'
      from generate_series(1, 24) g
  `
  assert.equal(await code(service.preview(overflow, { mobile: member('超额2').phone }, secondAdminId)), 'dingtalk_admin_preview_limit')
})

test('钉钉账号已绑定其他员工时提示冲突；改绑使原绑定失效、撤销其钉钉会话并通知原员工', async () => {
  const original = await employee('李响')
  const target = await employee('李响')
  const { phone } = member('李响')
  await bind(original, phone)
  await insertDingSession(original)
  assert.equal(await dingSessions(original), 1)

  const preview = await service.preview(target, { mobile: phone }, adminId)
  assert.deepEqual(preview.conflict, { userId: original, name: '李响' })
  assert.equal(await code(service.confirm(target, { confirmationToken: preview.confirmationToken, identityConfirmed: true }, adminId)), 'dingtalk_member_bound')
  const view = await service.confirm(target, { confirmationToken: preview.confirmationToken, identityConfirmed: true, rebind: true }, adminId)
  assert.equal(view.status, 'bound')
  assert.equal(await dingSessions(original), 0, '原员工的钉钉会话按 binding_id 撤销')
  const [old] = await database.client<{ status: string; reason: string }[]>`
    select status, revoke_reason as reason from external_account_bindings where user_id = ${original}
  `
  assert.deepEqual({ ...old }, { status: 'invalid', reason: 'rebound_to_other' })
  const [notice] = await notifications(original)
  assert.equal(notice!.kind, 'dingtalk_binding_revoked')
  assert.deepEqual(notice!.detail, { reason: 'rebound_to_other' })
})

test('管理员解绑撤销钉钉会话并可锁定自行绑定；解除锁定或重新代绑后恢复', async () => {
  const userId = await employee('孙悦')
  const { userId: dingUserId, phone } = member('孙悦')
  await bind(userId, phone)
  await insertDingSession(userId)
  const unbound = await service.unbind(userId, { lockSelfRebind: true }, adminId)
  assert.equal(unbound.status, 'invalid')
  assert.equal(unbound.selfRebindLocked, true)
  assert.equal(await dingSessions(userId), 0)
  assert.equal((await notifications(userId))[0]!.kind, 'dingtalk_binding_revoked')

  const ticket = { externalUserId: dingUserId, externalUnionId: null, externalDisplayName: '孙悦', externalDepartment: null, corpId: 'ding-corp-test' }
  const locked = await database.client.begin(transaction => bindFromSelfTicket(transaction, userId, ticket))
  assert.deepEqual(locked, { status: 'refused', reason: 'self_bind_locked' })
  assert.equal(await code(service.unbind(userId, {}, adminId)), 'dingtalk_not_bound')

  assert.equal((await service.unlock(userId, adminId)).selfRebindLocked, false)
  const rebound = await database.client.begin(transaction => bindFromSelfTicket(transaction, userId, ticket))
  assert.equal(rebound.status, 'bound')

  // 重新代绑也会解除锁定。
  await service.unbind(userId, { lockSelfRebind: true }, adminId)
  const again = await bind(userId, phone)
  assert.equal(again.selfRebindLocked, false)
})

test('员工与权限列表返回钉钉状态、按状态筛选并给出概况；集成页名单与提醒', async () => {
  await database.client`update audit_events set occurred_at = now() - interval '2 days' where action = 'identity.dingtalk.admin_bind'`
  const bound = await employee('列表已绑定')
  await bind(bound, member('列表已绑定').phone)
  const invalid = await employee('列表已失效')
  await bind(invalid, member('列表已失效').phone)
  await service.unbind(invalid, {}, adminId)
  const unbound = await employee('列表未绑定')

  const list = await administration.listUsers({ query: '列表', pageSize: 50 })
  const byId = new Map(list.items.map(item => [item.id, item.dingtalk]))
  assert.equal(byId.get(bound)!.status, 'bound')
  assert.equal(byId.get(bound)!.boundBy, 'admin')
  assert.equal(byId.get(invalid)!.status, 'invalid')
  assert.equal(byId.get(invalid)!.revokeReason, 'admin_unbind')
  assert.equal(byId.get(unbound)!.status, 'unbound')
  assert.deepEqual((await administration.listUsers({ query: '列表', dingtalk: 'unbound' })).items.map(item => item.id), [unbound])
  const summary = list.summary.dingtalk
  assert.equal(summary.bound + summary.unbound + summary.invalid, summary.activeLocal)
  assert.equal(summary.selfBound + summary.adminBound, summary.bound)

  const overview = await service.overview(adminId)
  assert.equal(overview.configured, true)
  assert.deepEqual(overview.publicEntries, ['https://m.example.test'])
  assert.deepEqual({ ...overview.counts }, { ...summary })
  const names = (await service.listUnbound({ pageSize: 100 }, adminId)).items
  assert.ok(names.some(item => item.id === unbound && item.status === 'unbound'))
  assert.ok(names.some(item => item.id === invalid && item.status === 'invalid' && item.revokeReason === 'admin_unbind'))
  assert.ok(!names.some(item => item.id === bound))

  assert.equal((await service.remind({ userIds: [unbound, bound] }, adminId)).reminded, 1, '已绑定的员工不提醒')
  assert.equal((await service.remind({ userIds: [unbound] }, adminId)).reminded, 1)
  assert.equal((await notifications(unbound)).filter(item => item.kind === 'dingtalk_bind_reminder').length, 1, '同一员工每天只登记一条')
  assert.equal(await code(service.overview(unbound)), 'permission_denied')
})

test('连接检查：凭据与各项接口权限；权限不足显示为配置异常', async () => {
  const ok = await service.checkConnection(adminId)
  assert.equal(ok.connection!.status, 'ok')
  assert.deepEqual(ok.connection!.capabilities, { credentials: 'ok', mobileLookup: 'ok', memberRead: 'ok', departmentRead: 'ok' })
  dingtalk.failure = new DingTalkDirectoryError('configuration_invalid', '钉钉应用凭据无效或服务器出口 IP 未登记', 40089)
  try {
    const failed = await service.checkConnection(adminId)
    assert.equal(failed.connection!.status, 'configuration_error')
    assert.equal(failed.connection!.capabilities.credentials, 'denied')
  } finally { dingtalk.failure = null }
})

test('离职检查只按明确“用户不存在”失效，检查失败不改变绑定；超过 10% 整批暂停待确认；连续失败提醒', async () => {
  // 清空前面用例留下的绑定，使比例可控。
  await database.client`update external_account_bindings set status = 'invalid', revoked_at = now(), revoke_reason = 'test_reset' where status = 'valid'`
  const people: Array<{ userId: string; dingUserId: string }> = []
  for (let index = 0; index < 12; index += 1) {
    const userId = await employee()
    const { userId: dingUserId, phone } = member(`离职检查${index}`)
    await database.client`update audit_events set occurred_at = now() - interval '2 days' where action = 'identity.dingtalk.admin_bind'`
    await bind(userId, phone)
    people.push({ userId, dingUserId })
  }
  const clean = await service.runDepartureCheck()
  assert.equal(clean!.status, 'completed')
  assert.equal(clean!.departed, 0)

  dingtalk.removeMember(people[0]!.dingUserId)
  dingtalk.memberErrors.set(people[1]!.dingUserId, new DingTalkDirectoryError('unavailable', '系统繁忙', -1))
  await insertDingSession(people[0]!.userId)
  const one = await service.runDepartureCheck()
  assert.equal(one!.status, 'completed')
  assert.equal(one!.departed, 1)
  assert.equal(one!.failed, 1)
  assert.deepEqual({ ...one!.errorCodes }, { 'member_not_found:33012': 1, 'unavailable:-1': 1 })
  const statuses = await database.client<{ userId: string; status: string; reason: string | null }[]>`
    select user_id as "userId", status, revoke_reason as reason from external_account_bindings where user_id = any(${[people[0]!.userId, people[1]!.userId]}::text[])
  `
  assert.deepEqual(statuses.find(row => row.userId === people[0]!.userId)!.reason, 'departed')
  assert.equal(statuses.find(row => row.userId === people[1]!.userId)!.status, 'valid', '检查失败不改变绑定')
  assert.equal(await dingSessions(people[0]!.userId), 0)

  for (const person of people.slice(2, 5)) dingtalk.removeMember(person.dingUserId)
  const paused = await service.runDepartureCheck()
  assert.equal(paused!.status, 'paused', '3/11 超过 10%')
  const stillValid = await database.client<{ count: number }[]>`
    select count(*)::integer as count from external_account_bindings where user_id = any(${people.slice(2, 5).map(person => person.userId)}::text[]) and status = 'valid'
  `
  assert.equal(stillValid[0]!.count, 3, '暂停时不失效')
  const overview = await service.overview(adminId)
  assert.deepEqual(overview.departureCheck.pausedRun, { id: paused!.runId, pending: 3, bound: 11 })
  assert.equal(await code(service.decideDepartureBatch(paused!.runId, { decision: 'confirm' }, people[6]!.userId)), 'permission_denied')
  assert.deepEqual(await service.decideDepartureBatch(paused!.runId, { decision: 'confirm' }, adminId), { invalidated: 3 })
  assert.equal(await code(service.decideDepartureBatch(paused!.runId, { decision: 'confirm' }, adminId)), 'departure_check_not_paused')

  dingtalk.memberErrors.clear()
  dingtalk.failure = new DingTalkDirectoryError('permission_denied', '不在通讯录范围', 60011)
  try {
    for (let run = 0; run < 3; run += 1) {
      const result = await service.runDepartureCheck()
      assert.equal(result!.status, 'configuration_error', '权限错误记为配置异常，不失效任何绑定')
    }
  } finally { dingtalk.failure = null }
  const warned = await service.overview(adminId)
  assert.equal(warned.departureCheck.persistentWarning, true)
  const [{ count }] = await database.client<{ count: number }[]>`select count(*)::integer as count from external_account_bindings where status = 'valid' and user_id = any(${people.map(person => person.userId)}::text[])`
  assert.equal(count, 8)
})

test('离职检查中途中断留下的 running 记录超过 6 小时后不阻止下一次检查', async () => {
  await database.client`
    insert into dingtalk_departure_checks (id, tenant_id, status, started_at)
    values ('dtcheck-crashed', 'tenant-dsh-work', 'running', now() - interval '7 hours')
  `
  const result = await service.runDepartureCheck()
  assert.ok(result, '中断的检查不再阻止新检查')
  const [crashed] = await database.client<{ status: string }[]>`select status from dingtalk_departure_checks where id = 'dtcheck-crashed'`
  assert.equal(crashed!.status, 'failed')

  await database.client`
    insert into dingtalk_departure_checks (id, tenant_id, status, started_at)
    values ('dtcheck-active', 'tenant-dsh-work', 'running', now() - interval '5 minutes')
  `
  assert.equal(await service.runDepartureCheck(), null, '仍在进行中的检查不重复开始')
  await database.client`delete from dingtalk_departure_checks where id = 'dtcheck-active'`
})

test('并发确认不能越过每日代绑上限；被暂停的离职检查在之后的检查完成后仍可确认', async () => {
  await database.client`update audit_events set occurred_at = now() - interval '2 days' where action like 'identity.dingtalk.admin_bind%'`
  const previews = []
  for (let index = 0; index < 8; index += 1) {
    const userId = await employee()
    const preview = await service.preview(userId, { mobile: member(`并发${index}`).phone }, adminId)
    previews.push({ userId, token: preview.confirmationToken })
  }
  const results = await Promise.all(previews.map(item => code(service.confirm(item.userId, { confirmationToken: item.token, identityConfirmed: true }, adminId))))
  assert.equal(results.filter(result => result === 'ok').length, 6, '上限为 6')
  assert.equal(results.filter(result => result === 'dingtalk_admin_daily_limit').length, 2)

  await database.client`
    insert into dingtalk_departure_checks (id, tenant_id, status, started_at, finished_at, bound_count, pending_binding_ids)
    values ('dtcheck-old-paused', 'tenant-dsh-work', 'paused', now() - interval '1 day', now() - interval '1 day', 20, '{}')
  `
  await service.runDepartureCheck()
  const overview = await service.overview(adminId)
  assert.equal(overview.departureCheck.lastRun!.status, 'completed')
  assert.equal(overview.departureCheck.pausedRun!.id, 'dtcheck-old-paused', '较早被暂停的批次仍显示待确认')
  await service.decideDepartureBatch('dtcheck-old-paused', { decision: 'dismiss' }, adminId)
  assert.equal((await service.overview(adminId)).departureCheck.pausedRun, null)
})

test('停用账号使代绑失效；停用后不能再代绑', async () => {
  const userId = await employee()
  const { phone } = member('停用')
  await database.client`update audit_events set occurred_at = now() - interval '2 days' where action = 'identity.dingtalk.admin_bind'`
  await bind(userId, phone)
  await local.setStatus(userId, 'disabled', adminId)
  const [row] = await database.client<{ status: string; reason: string }[]>`select status, revoke_reason as reason from external_account_bindings where user_id = ${userId}`
  assert.deepEqual({ ...row }, { status: 'invalid', reason: 'account_disabled' })
  assert.equal(await code(service.preview(userId, { mobile: phone }, adminId)), 'account_inactive')
})
