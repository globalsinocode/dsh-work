import { createHmac, randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { recordUserNotification } from '../../notification/user-notification-writer.ts'
import { IdentityAccessError } from '../auth-service.ts'
import { hashOpaque, randomOpaque } from '../secure-values.ts'
import { IdentitySessionRepository } from '../session-repository.ts'
import { LOCAL_PERMISSIONS } from '../types.ts'
import { DINGTALK_CHANNEL, invalidateUserBindings, revokeBindingSessions } from './dingtalk-bindings.ts'
import type { DingTalkConfiguration } from './dingtalk-config.ts'
import { DingTalkDirectoryError } from './dingtalk-directory.ts'
import type { DingTalkSettingsInput, DingTalkSettingsManager, DingTalkSettingsProvider, DingTalkSettingsView } from './dingtalk-settings.ts'

const tenantId = 'tenant-dsh-work'
/** 代绑确认凭证有效期（4.2 方式二：单次有效、短时过期）。 */
const confirmationTtlSeconds = 5 * 60
/** 管理类权限：拥有任一项的账号只能本人在钉钉内登录绑定（4.2 方式二第 6 步）。 */
const administrativePermissions: string[] = [LOCAL_PERMISSIONS.adminAll, LOCAL_PERMISSIONS.adminWrite, LOCAL_PERMISSIONS.adminRead, LOCAL_PERMISSIONS.auditRead]
/** 离职检查：判为离职的比例超过该值时整批暂停（与组织架构方案附录 A 一致）。 */
const departurePauseRatio = 0.1
/** 离职检查异常：连续 3 次检查失败比例超过 5%。 */
const departureWarningRatio = 0.05
const departureWarningRuns = 3

export interface DingTalkBindingView {
  status: 'bound' | 'unbound' | 'invalid'
  binding: {
    id: string
    dingtalkName: string | null
    dingtalkDepartment: string | null
    boundBy: 'self' | 'admin'
    boundByAdminName: string | null
    boundAt: string
  } | null
  invalid: { reason: string | null; at: string } | null
  selfRebindLocked: boolean
}

export interface AdminBindPreview {
  confirmationToken: string
  expiresInSeconds: number
  dingtalkName: string | null
  dingtalkDepartment: string | null
  maskedMobile: string
  platformName: string
  nameMatches: boolean
  /** 钉钉姓名与平台姓名不一致或部门无法读取时，确认请求须带 `identityConfirmed: true`。 */
  requireIdentityConfirmation: boolean
  /** 该钉钉账号已绑定其他员工：确认时须带 `rebind: true`。 */
  conflict: { userId: string; name: string } | null
}

interface ConfirmationPayload {
  maskedMobile: string
  mobileHash: string
  requireIdentityConfirmation: boolean
  conflictUserId: string | null
}

export class DingTalkAdministrationService {
  private readonly database: DatabaseClient
  /** 钉钉应用配置在每次使用时读取（管理端保存后立即生效）。 */
  private readonly settings: DingTalkSettingsProvider
  private readonly manager: DingTalkSettingsManager | null
  private readonly secret: string
  private readonly publicOrigins: string[]
  private readonly repository: IdentitySessionRepository

  constructor(database: DatabaseClient, settings: DingTalkSettingsProvider, options: { secret: string; workbenchOrigins: string[]; manager?: DingTalkSettingsManager }) {
    this.database = database
    this.settings = settings
    this.manager = options.manager ?? null
    this.secret = options.secret
    this.publicOrigins = options.workbenchOrigins.filter(origin => origin.startsWith('https://'))
    this.repository = new IdentitySessionRepository(database)
  }

  /** “钉钉集成 › 应用配置”：查看、保存（先向钉钉验证凭据）与清除。只有平台管理员可用。 */
  async getSettings(actorId: string): Promise<DingTalkSettingsView> {
    await this.database.begin(transaction => assertPlatformAdmin(transaction, actorId))
    return this.requireManager().view()
  }

  async saveSettings(input: DingTalkSettingsInput, actorId: string): Promise<DingTalkSettingsView> {
    await this.database.begin(transaction => assertPlatformAdmin(transaction, actorId))
    return this.requireManager().save(input, actorId)
  }

  async clearSettings(actorId: string): Promise<DingTalkSettingsView> {
    await this.database.begin(transaction => assertPlatformAdmin(transaction, actorId))
    return this.requireManager().clear(actorId)
  }

  private requireManager() {
    if (!this.manager) throw new IdentityAccessError(503, 'dingtalk_settings_unavailable', '钉钉应用配置不可用')
    return this.manager
  }

  async getBinding(userId: string, actorId: string): Promise<DingTalkBindingView> {
    return this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      await requireLocalUser(transaction, userId)
      return readBinding(transaction, userId)
    })
  }

  /** 代绑预览：按手机号在钉钉中查成员与部门，返回服务端保存的确认凭证（4.2 方式二第 2 步）。 */
  async preview(userId: string, input: { mobile?: unknown }, actorId: string): Promise<AdminBindPreview> {
    const configuration = await this.requireConfiguration()
    const directory = this.settings.directory(configuration)
    const mobile = normalizeMobile(input.mobile)
    const target = await this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      const user = await requireLocalUser(transaction, userId)
      await this.assertBindable(transaction, userId, actorId, configuration, 'preview')
      const [own] = await transaction`
        select 1 from external_account_bindings where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and status = 'valid'
      `
      if (own) throw new IdentityAccessError(409, 'dingtalk_already_bound', '该员工已绑定钉钉，请先解除绑定')
      return user
    })
    // 钉钉调用在事务之外。
    const dingUserId = await this.call(() => directory.findUserIdByMobile(mobile))
    const member = await this.call(() => directory.getMember(dingUserId))
    let department: string | null = null
    try {
      const names = await Promise.all(member.departmentIds.slice(0, 2).map(id => directory.getDepartmentName(id)))
      department = names.length ? names.join('、') : null
    } catch {
      department = null
    }
    const nameMatches = Boolean(member.name) && normalizeName(member.name!) === normalizeName(target.name)
    const requireIdentityConfirmation = !nameMatches || department === null
    const maskedMobile = maskMobile(mobile)
    const token = randomOpaque()
    const preview = await this.database.begin(async transaction => {
      const [conflict] = await transaction<{ userId: string; name: string }[]>`
        select b.user_id as "userId", u.display_name as name from external_account_bindings b
          join users u on u.tenant_id = b.tenant_id and u.id = b.user_id
         where b.tenant_id = ${tenantId} and b.channel = ${DINGTALK_CHANNEL} and b.external_user_id = ${dingUserId} and b.status = 'valid'
      `
      const payload: ConfirmationPayload = {
        maskedMobile, mobileHash: this.mobileHash(mobile), requireIdentityConfirmation, conflictUserId: conflict?.userId ?? null,
      }
      await transaction`
        insert into external_binding_tickets (
          ticket_hash, tenant_id, channel, purpose, external_user_id, external_union_id, external_display_name,
          external_department, corp_id, target_user_id, actor_id, payload, expires_at
        ) values (
          ${hashOpaque(token)}, ${tenantId}, ${DINGTALK_CHANNEL}, 'admin-confirm', ${dingUserId}, ${member.unionId}, ${member.name},
          ${department}, ${configuration.corpId}, ${userId}, ${actorId}, ${transaction.json({ ...payload })},
          now() + make_interval(secs => ${confirmationTtlSeconds})
        )
      `
      await adminAudit(transaction, actorId, 'identity.dingtalk.admin_bind.preview', 'success', userId, {
        maskedMobile, mobileHash: payload.mobileHash, nameMatches: String(nameMatches), conflict: String(Boolean(conflict)),
      })
      return { conflict: conflict ?? null }
    })
    return {
      confirmationToken: token,
      expiresInSeconds: confirmationTtlSeconds,
      dingtalkName: member.name,
      dingtalkDepartment: department,
      maskedMobile,
      platformName: target.name,
      nameMatches,
      requireIdentityConfirmation,
      conflict: preview.conflict,
    }
  }

  /** 代绑确认：只接受确认凭证，不接受 userid（4.2 方式二第 3～5 步）。 */
  async confirm(userId: string, input: { confirmationToken?: unknown; identityConfirmed?: unknown; rebind?: unknown }, actorId: string) {
    const configuration = await this.requireConfiguration()
    if (typeof input.confirmationToken !== 'string' || !input.confirmationToken) {
      throw new IdentityAccessError(422, 'invalid_request', '缺少确认凭证，请重新查找')
    }
    const token = input.confirmationToken
    return this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      const [ticket] = await transaction<{
        externalUserId: string; externalUnionId: string | null; externalDisplayName: string | null
        externalDepartment: string | null; payload: ConfirmationPayload
      }[]>`
        select external_user_id as "externalUserId", external_union_id as "externalUnionId",
               external_display_name as "externalDisplayName", external_department as "externalDepartment", payload
          from external_binding_tickets
         where ticket_hash = ${hashOpaque(token)} and tenant_id = ${tenantId} and purpose = 'admin-confirm'
           and target_user_id = ${userId} and actor_id = ${actorId}
           and consumed_at is null and expires_at > now()
         for update
      `
      if (!ticket) throw new IdentityAccessError(409, 'dingtalk_confirmation_invalid', '确认已过期或已使用，请重新查找')
      if (ticket.payload.requireIdentityConfirmation && input.identityConfirmed !== true) {
        throw new IdentityAccessError(422, 'dingtalk_identity_confirmation_required', '钉钉姓名与员工姓名不一致，请勾选“我已核实是本人”')
      }
      // 锁定目标员工后复核：账号有效、非管理类账号、尚未绑定、每日上限。
      const target = await requireLocalUser(transaction, userId, true)
      await this.assertBindable(transaction, userId, actorId, configuration, 'confirm')
      const [own] = await transaction`
        select 1 from external_account_bindings where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and status = 'valid' for update
      `
      if (own) throw new IdentityAccessError(409, 'dingtalk_already_bound', '该员工已绑定钉钉，请先解除绑定')
      const [conflict] = await transaction<{ id: string; userId: string }[]>`
        select id, user_id as "userId" from external_account_bindings
         where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and external_user_id = ${ticket.externalUserId} and status = 'valid'
         for update
      `
      if (conflict && conflict.userId !== ticket.payload.conflictUserId) {
        throw new IdentityAccessError(409, 'dingtalk_conflict_changed', '该钉钉账号的绑定刚刚发生变化，请重新查找')
      }
      if (conflict && input.rebind !== true) {
        throw new IdentityAccessError(409, 'dingtalk_member_bound', '该钉钉账号已绑定其他员工，确认改绑后才能继续')
      }
      await transaction`update external_binding_tickets set consumed_at = now() where ticket_hash = ${hashOpaque(token)}`
      if (conflict) {
        await transaction`
          update external_account_bindings set status = 'invalid', revoked_at = now(), revoke_reason = 'rebound_to_other', updated_at = now()
           where id = ${conflict.id}
        `
        await revokeBindingSessions(transaction, [conflict.id])
        await recordUserNotification(transaction, {
          recipientUserId: conflict.userId, kind: 'dingtalk_binding_revoked', workspaceId: null,
          objectType: 'dingtalk_binding', objectId: conflict.id, actorUserId: actorId,
          dedupeKey: `dingtalk-revoked:${conflict.id}`, metadata: { reason: 'rebound_to_other' },
        })
      }
      // 管理员重新代绑即解除此前的“锁定自行绑定”。
      await transaction`
        update external_account_bindings set self_rebind_locked = false, updated_at = now()
         where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and self_rebind_locked
      `
      const bindingId = `binding-${randomUUID()}`
      const [created] = await transaction`
        insert into external_account_bindings (
          id, tenant_id, channel, user_id, external_user_id, external_union_id, external_display_name,
          external_department, bound_by, bound_by_admin_id, status
        ) values (
          ${bindingId}, ${tenantId}, ${DINGTALK_CHANNEL}, ${userId}, ${ticket.externalUserId}, ${ticket.externalUnionId},
          ${ticket.externalDisplayName}, ${ticket.externalDepartment}, 'admin', ${actorId}, 'valid'
        ) on conflict do nothing returning id
      `
      if (!created) throw new IdentityAccessError(409, 'dingtalk_conflict_changed', '该钉钉账号的绑定刚刚发生变化，请重新查找')
      await recordUserNotification(transaction, {
        recipientUserId: userId, kind: 'dingtalk_bound_by_admin', workspaceId: null,
        objectType: 'dingtalk_binding', objectId: bindingId, actorUserId: actorId, dedupeKey: `dingtalk-bound:${bindingId}`,
      })
      await adminAudit(transaction, actorId, 'identity.dingtalk.admin_bind', 'success', userId, {
        bindingId, maskedMobile: ticket.payload.maskedMobile, mobileHash: ticket.payload.mobileHash,
        identityConfirmed: String(input.identityConfirmed === true), ...(conflict ? { reboundFromUserId: conflict.userId } : {}),
      })
      return { ...(await readBinding(transaction, userId)), platformName: target.name }
    })
  }

  /** 管理员解绑：失效、撤销该绑定的钉钉会话、可锁定自行绑定、通知本人（4.2“解绑与失效”）。 */
  async unbind(userId: string, input: { lockSelfRebind?: unknown }, actorId: string) {
    const lock = input.lockSelfRebind === true
    return this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      await requireLocalUser(transaction, userId, true)
      const invalidated = await invalidateUserBindings(transaction, userId, 'admin_unbind', { lockSelfRebind: lock })
      if (!invalidated.length) {
        if (!lock) throw new IdentityAccessError(404, 'dingtalk_not_bound', '该员工没有有效的钉钉绑定')
        // 未绑定时只锁定：在最近一条失效记录上标记；没有记录时无从冒用，不需要锁定。
        const [latest] = await transaction<{ id: string }[]>`
          select id from external_account_bindings where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId}
           order by bound_at desc limit 1 for update
        `
        if (!latest) throw new IdentityAccessError(404, 'dingtalk_not_bound', '该员工没有钉钉绑定记录')
        await transaction`update external_account_bindings set self_rebind_locked = true, updated_at = now() where id = ${latest.id}`
      }
      for (const binding of invalidated) {
        await recordUserNotification(transaction, {
          recipientUserId: userId, kind: 'dingtalk_binding_revoked', workspaceId: null,
          objectType: 'dingtalk_binding', objectId: binding.id, actorUserId: actorId,
          dedupeKey: `dingtalk-revoked:${binding.id}`, metadata: { reason: 'admin_unbind' },
        })
      }
      await adminAudit(transaction, actorId, 'identity.dingtalk.admin_unbind', 'success', userId, { lockSelfRebind: String(lock) })
      return readBinding(transaction, userId)
    })
  }

  /** 解除“锁定自行绑定”。 */
  async unlock(userId: string, actorId: string) {
    return this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      await requireLocalUser(transaction, userId, true)
      await transaction`
        update external_account_bindings set self_rebind_locked = false, updated_at = now()
         where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and self_rebind_locked
      `
      await adminAudit(transaction, actorId, 'identity.dingtalk.unlock', 'success', userId, {})
      return readBinding(transaction, userId)
    })
  }

  /** “钉钉集成”页概况。 */
  async overview(actorId: string) {
    await this.database.begin(transaction => assertPlatformAdmin(transaction, actorId))
    const [status] = await this.database<{ checkedAt: Date | null; status: string | null; capabilities: Record<string, string>; message: string | null }[]>`
      select checked_at as "checkedAt", status, capabilities, message from external_channel_status
       where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL}
    `
    const [counts] = await this.database<{ bound: number; selfBound: number; adminBound: number; invalid: number; unbound: number; activeLocal: number }[]>`
      with local_users as (
        select u.id from users u
         where u.tenant_id = ${tenantId} and u.identity_provider = 'local' and u.business_user and u.status = 'active'
           and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)
      ), states as (
        select lu.id,
               (select b.bound_by from external_account_bindings b where b.tenant_id = ${tenantId} and b.user_id = lu.id and b.channel = ${DINGTALK_CHANNEL} and b.status = 'valid') as valid_by,
               exists (select 1 from external_account_bindings b where b.tenant_id = ${tenantId} and b.user_id = lu.id and b.channel = ${DINGTALK_CHANNEL}) as any_record
          from local_users lu
      )
      select count(*)::integer as "activeLocal",
             count(*) filter (where valid_by is not null)::integer as bound,
             count(*) filter (where valid_by = 'self')::integer as "selfBound",
             count(*) filter (where valid_by = 'admin')::integer as "adminBound",
             count(*) filter (where valid_by is null and any_record)::integer as invalid,
             count(*) filter (where not any_record)::integer as unbound
        from states
    `
    const configuration = await this.settings.current()
    return {
      configured: configuration !== null,
      agentId: configuration?.agentId ?? null,
      publicEntries: this.publicOrigins,
      connection: status ? {
        checkedAt: status.checkedAt?.toISOString() ?? null, status: status.status,
        capabilities: status.capabilities, message: status.message,
      } : null,
      counts: counts!,
      departureCheck: await this.departureSummary(),
    }
  }

  /**
   * 连接检查：凭据换取 access_token，并用不存在的手机号、userid 与根部门探测各项接口权限——
   * 返回“未找到”说明权限已开通，返回权限错误说明未开通。不读取真实员工信息。
   */
  async checkConnection(actorId: string) {
    await this.database.begin(transaction => assertPlatformAdmin(transaction, actorId))
    const capabilities: Record<string, 'ok' | 'denied' | 'unknown'> = {}
    let status: 'ok' | 'configuration_error' | 'unavailable' = 'ok'
    let message: string | null = null
    const configuration = await this.settings.current()
    if (!configuration) {
      status = 'configuration_error'
      message = '钉钉应用未配置：请在“应用配置”中填写，或已保存的 AppSecret 无法读取'
    } else {
      const directory = this.settings.directory(configuration)
      try {
        await directory.checkCredentials()
        capabilities.credentials = 'ok'
        capabilities.mobileLookup = await probe(() => directory.findUserIdByMobile('10000000000'), ['member_not_found', 'invalid_mobile'])
        capabilities.memberRead = await probe(() => directory.getMember('dsh-work-connection-probe'), ['member_not_found'])
        capabilities.departmentRead = await probe(() => directory.getDepartmentName(1), ['department_not_found'])
        if (Object.values(capabilities).includes('denied')) {
          status = 'configuration_error'
          message = '部分接口权限未开通，或通讯录权限范围不是“全部员工”'
        } else if (Object.values(capabilities).includes('unknown')) {
          status = 'unavailable'
          message = '部分接口暂时无法检查，请稍后重试'
        }
      } catch (error) {
        capabilities.credentials = 'denied'
        status = error instanceof DingTalkDirectoryError && error.code === 'unavailable' ? 'unavailable' : 'configuration_error'
        message = error instanceof DingTalkDirectoryError ? error.message : '连接检查失败'
      }
    }
    await this.database`
      insert into external_channel_status (tenant_id, channel, checked_at, status, capabilities, message, checked_by)
      values (${tenantId}, ${DINGTALK_CHANNEL}, now(), ${status}, ${this.database.json(capabilities)}, ${message}, ${actorId})
      on conflict (tenant_id, channel) do update set checked_at = excluded.checked_at, status = excluded.status,
        capabilities = excluded.capabilities, message = excluded.message, checked_by = excluded.checked_by
    `
    return this.overview(actorId)
  }

  /** 未绑定名单：有效独立账号中没有有效绑定的员工（含已失效）。 */
  async listUnbound(input: { page?: number; pageSize?: number }, actorId: string) {
    await this.database.begin(transaction => assertPlatformAdmin(transaction, actorId))
    const pageSize = Math.min(100, Math.max(10, Number.isInteger(input.pageSize) ? input.pageSize! : 50))
    const page = Math.max(1, Number.isInteger(input.page) ? input.page! : 1)
    const rows = await this.database<{ id: string; name: string; loginAccount: string; department: string; status: 'unbound' | 'invalid'; revokeReason: string | null; selfRebindLocked: boolean; total: number }[]>`
      select u.id, u.display_name as name, c.username as "loginAccount", coalesce(u.department_id, '未分配部门') as department,
             case when latest.id is null then 'unbound' else 'invalid' end as status,
             latest.revoke_reason as "revokeReason",
             exists (select 1 from external_account_bindings b where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = ${DINGTALK_CHANNEL} and b.self_rebind_locked) as "selfRebindLocked",
             count(*) over ()::integer as total
        from users u
        join local_user_credentials c on c.tenant_id = u.tenant_id and c.user_id = u.id
        left join lateral (
          select b.id, b.revoke_reason from external_account_bindings b
           where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = ${DINGTALK_CHANNEL}
           order by b.bound_at desc limit 1
        ) latest on true
       where u.tenant_id = ${tenantId} and u.identity_provider = 'local' and u.business_user and u.status = 'active'
         and not exists (select 1 from external_account_bindings b where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = ${DINGTALK_CHANNEL} and b.status = 'valid')
       order by (latest.id is null) desc, u.display_name, u.id
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `
    return { items: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0, page, pageSize }
  }

  /** “提醒员工”：给未绑定且未被锁定的员工各登记一条站内通知；同一员工每天最多一条。 */
  async remind(input: { userIds?: unknown; all?: unknown }, actorId: string) {
    const all = input.all === true
    const userIds = Array.isArray(input.userIds) ? input.userIds.filter((id): id is string => typeof id === 'string').slice(0, 500) : []
    if (!all && !userIds.length) throw new IdentityAccessError(422, 'invalid_request', '请选择要提醒的员工')
    return this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      const targets = await transaction<{ id: string }[]>`
        select u.id from users u
         where u.tenant_id = ${tenantId} and u.identity_provider = 'local' and u.business_user and u.status = 'active'
           and exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id)
           and not exists (select 1 from external_account_bindings b where b.tenant_id = u.tenant_id and b.user_id = u.id and b.channel = ${DINGTALK_CHANNEL} and (b.status = 'valid' or b.self_rebind_locked))
           and (${all} or u.id = any(${userIds}::text[]))
      `
      // 按服务器本地日期去重（部署在企业所在时区），不按 UTC。
      const now = new Date()
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      for (const target of targets) {
        await recordUserNotification(transaction, {
          recipientUserId: target.id, kind: 'dingtalk_bind_reminder', workspaceId: null,
          objectType: 'dingtalk_binding', objectId: target.id, actorUserId: actorId, dedupeKey: `dingtalk-reminder:${day}`,
        })
      }
      await adminAudit(transaction, actorId, 'identity.dingtalk.remind', 'success', actorId, { count: String(targets.length), all: String(all) })
      return { reminded: targets.length }
    })
  }

  /**
   * 每日离职检查（4.2“解绑与失效”、8.1）：逐个查询已绑定的钉钉账号，只有“明确不存在”才判为离职；
   * 权限或范围错误记为配置异常、不计入单个员工的检查失败；判为离职的超过有效绑定 10% 时整批暂停。
   */
  async runDepartureCheck(options: { delayMs?: number } = {}) {
    const configuration = await this.settings.current()
    if (!configuration) return null
    const directory = this.settings.directory(configuration)
    const runId = `dtcheck-${randomUUID()}`
    // 进程在检查中途退出（重启、发布）会留下 running 记录；超过 6 小时未结束的视为中断，否则唯一索引会让检查永久停止。
    await this.database`
      update dingtalk_departure_checks set status = 'failed', finished_at = now()
       where tenant_id = ${tenantId} and status = 'running' and started_at < now() - interval '6 hours'
    `
    const [started] = await this.database`
      insert into dingtalk_departure_checks (id, tenant_id, status) values (${runId}, ${tenantId}, 'running')
      on conflict do nothing returning id
    `
    if (!started) return null
    try {
      const bindings = await this.database<{ id: string; userId: string; externalUserId: string }[]>`
        select id, user_id as "userId", external_user_id as "externalUserId" from external_account_bindings
         where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and status = 'valid' order by bound_at
      `
      const departed: string[] = []
      const errorCodes: Record<string, number> = {}
      let failed = 0
      let checked = 0
      let configurationError = false
      for (const binding of bindings) {
        try {
          await directory.getMember(binding.externalUserId)
        } catch (error) {
          const code = error instanceof DingTalkDirectoryError ? `${error.code}${error.upstreamCode === null ? '' : `:${error.upstreamCode}`}` : 'unknown'
          errorCodes[code] = (errorCodes[code] ?? 0) + 1
          if (error instanceof DingTalkDirectoryError && error.code === 'member_not_found') departed.push(binding.id)
          else if (error instanceof DingTalkDirectoryError && (error.code === 'permission_denied' || error.code === 'configuration_invalid')) {
            configurationError = true
            break
          } else failed += 1
        }
        checked += 1
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      }
      const summary = { checked, departed: departed.length, failed, bound: bindings.length, errorCodes }
      if (configurationError) {
        await this.finishRun(runId, 'configuration_error', summary, [])
        return { runId, status: 'configuration_error' as const, ...summary }
      }
      if (departed.length && departed.length > bindings.length * departurePauseRatio) {
        await this.finishRun(runId, 'paused', summary, departed)
        return { runId, status: 'paused' as const, ...summary }
      }
      await this.database.begin(async transaction => {
        await this.invalidateDeparted(transaction, departed)
        await this.finishRun(runId, 'completed', summary, departed, transaction)
      })
      return { runId, status: 'completed' as const, ...summary }
    } catch (error) {
      await this.database`
        update dingtalk_departure_checks set status = 'failed', finished_at = now() where id = ${runId} and status = 'running'
      `
      throw error
    }
  }

  /** 管理员确认或忽略一次被暂停的离职检查。 */
  async decideDepartureBatch(runId: string, input: { decision?: unknown }, actorId: string) {
    const decision = input.decision === 'confirm' ? 'confirmed' : input.decision === 'dismiss' ? 'dismissed' : null
    if (!decision) throw new IdentityAccessError(422, 'invalid_request', 'decision 必须为 confirm 或 dismiss')
    return this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      const [run] = await transaction<{ pending: string[] }[]>`
        select pending_binding_ids as pending from dingtalk_departure_checks
         where id = ${runId} and tenant_id = ${tenantId} and status = 'paused' for update
      `
      if (!run) throw new IdentityAccessError(409, 'departure_check_not_paused', '该次检查不在待确认状态')
      const invalidated = decision === 'confirmed' ? await this.invalidateDeparted(transaction, run.pending) : 0
      await transaction`
        update dingtalk_departure_checks set status = ${decision}, decided_by = ${actorId}, decided_at = now() where id = ${runId}
      `
      await adminAudit(transaction, actorId, 'identity.dingtalk.departure_check.decide', 'success', runId, { decision, invalidated: String(invalidated) })
      return { invalidated }
    })
  }

  /** 每天检查一次：当天（服务器时区）03:00 之后、当天还没有检查时运行；未配置钉钉时跳过（配置随时可在页面保存）。 */
  startDailyDepartureCheck(options: { hour?: number; intervalMs?: number } = {}) {
    const hour = options.hour ?? 3
    const tick = async () => {
      const now = new Date()
      if (now.getHours() < hour) return
      if (!await this.settings.current()) return
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const [recent] = await this.database`
        select 1 from dingtalk_departure_checks where tenant_id = ${tenantId} and started_at >= ${startOfDay} limit 1
      `
      if (!recent) await this.runDepartureCheck({ delayMs: 100 })
    }
    const timer = setInterval(() => { void tick().catch(error => console.error('钉钉离职检查失败:', error)) }, options.intervalMs ?? 15 * 60 * 1000)
    timer.unref()
    return timer
  }

  private async invalidateDeparted(transaction: DatabaseTransaction, bindingIds: string[]) {
    if (!bindingIds.length) return 0
    const rows = await transaction<{ id: string; userId: string }[]>`
      update external_account_bindings set status = 'invalid', revoked_at = now(), revoke_reason = 'departed', updated_at = now()
       where tenant_id = ${tenantId} and id = any(${bindingIds}::text[]) and status = 'valid'
      returning id, user_id as "userId"
    `
    await revokeBindingSessions(transaction, rows.map(row => row.id))
    for (const row of rows) await adminAudit(transaction, 'system', 'identity.dingtalk.departed', 'success', row.userId, { bindingId: row.id })
    return rows.length
  }

  private async finishRun(runId: string, status: string, summary: { checked: number; departed: number; failed: number; bound: number; errorCodes: Record<string, number> }, pending: string[], database: DatabaseClient | DatabaseTransaction = this.database) {
    await database`
      update dingtalk_departure_checks set status = ${status}, finished_at = now(), checked_count = ${summary.checked},
             departed_count = ${summary.departed}, failed_count = ${summary.failed}, bound_count = ${summary.bound},
             error_codes = ${database.json(summary.errorCodes)}, pending_binding_ids = ${pending}
       where id = ${runId}
    `
  }

  private async departureSummary() {
    const runs = await this.database<{ id: string; startedAt: Date; status: string; checked: number; departed: number; failed: number; bound: number; errorCodes: Record<string, number>; pending: number }[]>`
      select id, started_at as "startedAt", status, checked_count as checked, departed_count as departed,
             failed_count as failed, bound_count as bound, error_codes as "errorCodes",
             cardinality(pending_binding_ids)::integer as pending
        from dingtalk_departure_checks where tenant_id = ${tenantId} and status <> 'running'
       order by started_at desc limit ${departureWarningRuns}
    `
    const latest = runs[0]
    // 被暂停的批次在之后的检查完成后仍须可确认或忽略：取最近一次仍为 paused 的检查，而不只看最新一次。
    const [paused] = await this.database<{ id: string; pending: number; bound: number }[]>`
      select id, cardinality(pending_binding_ids)::integer as pending, bound_count as bound
        from dingtalk_departure_checks where tenant_id = ${tenantId} and status = 'paused'
       order by started_at desc limit 1
    `
    const persistentWarning = runs.length >= departureWarningRuns
      && runs.every(run => run.status === 'configuration_error' || run.status === 'failed' || (run.bound > 0 && run.failed > run.bound * departureWarningRatio))
    return {
      lastRun: latest ? {
        id: latest.id, startedAt: latest.startedAt.toISOString(), status: latest.status, checked: latest.checked,
        departed: latest.departed, failed: latest.failed, bound: latest.bound, errorCodes: latest.errorCodes,
      } : null,
      pausedRun: paused ? { id: paused.id, pending: paused.pending, bound: paused.bound } : null,
      persistentWarning,
    }
  }

  /**
   * 目标员工可被代绑：账号有效、非管理类账号，且发起管理员 24 小时内未超出次数上限。按管理员加事务级咨询锁后再计数，
   * 并发的确认请求不能越过上限；预览另有上限（代绑上限的 4 倍），避免按手机号批量查询钉钉成员。
   */
  private async assertBindable(transaction: DatabaseTransaction, userId: string, actorId: string, configuration: DingTalkConfiguration, kind: 'preview' | 'confirm') {
    const [user] = await transaction<{ active: boolean }[]>`
      select (u.status = 'active' and u.business_user and t.status = 'active') as active
        from users u join tenants t on t.id = u.tenant_id
       where u.tenant_id = ${tenantId} and u.id = ${userId}
    `
    if (!user?.active) throw new IdentityAccessError(422, 'account_inactive', '该账号已停用，不能绑定钉钉')
    const authorization = await this.repository.resolveAuthorization(userId, transaction)
    if (authorization.permissions.some(permission => administrativePermissions.includes(permission))) {
      throw new IdentityAccessError(422, 'dingtalk_admin_account', '拥有管理权限的账号只能由本人在钉钉内登录绑定')
    }
    await transaction`select pg_advisory_xact_lock(hashtext(${`dingtalk-admin-bind:${tenantId}:${actorId}`}))`
    const action = kind === 'confirm' ? 'identity.dingtalk.admin_bind' : 'identity.dingtalk.admin_bind.preview'
    const limit = kind === 'confirm' ? configuration.adminDailyBindLimit : configuration.adminDailyBindLimit * 4
    const [usage] = await transaction<{ count: number }[]>`
      select count(*)::integer as count from audit_events
       where tenant_id = ${tenantId} and actor_id = ${actorId} and action = ${action}
         and result = 'success' and occurred_at > now() - interval '1 day'
    `
    if ((usage?.count ?? 0) >= limit) {
      throw new IdentityAccessError(429, kind === 'confirm' ? 'dingtalk_admin_daily_limit' : 'dingtalk_admin_preview_limit',
        kind === 'confirm'
          ? `24 小时内的代绑次数已达上限（${limit} 次），请稍后再试`
          : `24 小时内的钉钉成员查找次数已达上限（${limit} 次），请稍后再试`)
    }
  }

  private async requireConfiguration(): Promise<DingTalkConfiguration> {
    const configuration = await this.settings.current()
    if (!configuration) throw new IdentityAccessError(503, 'dingtalk_not_configured', '钉钉应用未配置')
    return configuration
  }

  private async call<T>(operation: () => Promise<T>) {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof DingTalkDirectoryError)) throw error
      if (error.code === 'member_not_found') throw new IdentityAccessError(404, 'dingtalk_member_not_found', '企业钉钉中没有找到这个手机号，请核对号码，或确认该员工已加入企业钉钉')
      if (error.code === 'invalid_mobile') throw new IdentityAccessError(422, 'dingtalk_invalid_mobile', '手机号格式无效')
      if (error.code === 'permission_denied' || error.code === 'configuration_invalid') {
        throw new IdentityAccessError(503, 'dingtalk_configuration_error', '钉钉应用配置异常：缺少接口权限或成员不在通讯录范围内，请在“钉钉集成”页检查')
      }
      throw new IdentityAccessError(503, 'dingtalk_unavailable', '暂时无法连接钉钉，请稍后重试')
    }
  }

  private mobileHash(mobile: string) {
    return createHmac('sha256', this.secret).update(`dingtalk-mobile:${mobile}`).digest('hex')
  }
}

async function probe(operation: () => Promise<unknown>, okCodes: string[]): Promise<'ok' | 'denied' | 'unknown'> {
  try {
    await operation()
    return 'ok'
  } catch (error) {
    if (!(error instanceof DingTalkDirectoryError)) return 'unknown'
    if (okCodes.includes(error.code)) return 'ok'
    if (error.code === 'permission_denied' || error.code === 'configuration_invalid') return 'denied'
    return 'unknown'
  }
}

async function readBinding(transaction: DatabaseTransaction, userId: string): Promise<DingTalkBindingView> {
  const [latest] = await transaction<{
    id: string; status: 'valid' | 'invalid'; externalDisplayName: string | null; externalDepartment: string | null
    boundBy: 'self' | 'admin'; adminName: string | null; boundAt: Date; revokedAt: Date | null; revokeReason: string | null
  }[]>`
    select b.id, b.status, b.external_display_name as "externalDisplayName", b.external_department as "externalDepartment",
           b.bound_by as "boundBy", admin.display_name as "adminName", b.bound_at as "boundAt",
           b.revoked_at as "revokedAt", b.revoke_reason as "revokeReason"
      from external_account_bindings b
      left join users admin on admin.tenant_id = b.tenant_id and admin.id = b.bound_by_admin_id
     where b.tenant_id = ${tenantId} and b.channel = ${DINGTALK_CHANNEL} and b.user_id = ${userId}
     order by (b.status = 'valid') desc, b.bound_at desc limit 1
  `
  const [locked] = await transaction`
    select 1 from external_account_bindings where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and self_rebind_locked
  `
  const selfRebindLocked = Boolean(locked)
  if (!latest) return { status: 'unbound', binding: null, invalid: null, selfRebindLocked }
  if (latest.status === 'valid') {
    return {
      status: 'bound', invalid: null, selfRebindLocked,
      binding: {
        id: latest.id, dingtalkName: latest.externalDisplayName, dingtalkDepartment: latest.externalDepartment,
        boundBy: latest.boundBy, boundByAdminName: latest.adminName, boundAt: latest.boundAt.toISOString(),
      },
    }
  }
  return { status: 'invalid', binding: null, invalid: { reason: latest.revokeReason, at: latest.revokedAt!.toISOString() }, selfRebindLocked }
}

export async function readOwnBinding(database: DatabaseClient, userId: string) {
  return database.begin(transaction => readBinding(transaction, userId))
}

async function requireLocalUser(transaction: DatabaseTransaction, userId: string, lock = false) {
  const [user] = lock
    ? await transaction<{ name: string; active: boolean }[]>`
        select u.display_name as name, (u.status = 'active' and u.business_user) as active from users u
          join local_user_credentials c on c.tenant_id = u.tenant_id and c.user_id = u.id
         where u.tenant_id = ${tenantId} and u.id = ${userId} and u.identity_provider = 'local' for update of u, c
      `
    : await transaction<{ name: string; active: boolean }[]>`
        select u.display_name as name, (u.status = 'active' and u.business_user) as active from users u
          join local_user_credentials c on c.tenant_id = u.tenant_id and c.user_id = u.id
         where u.tenant_id = ${tenantId} and u.id = ${userId} and u.identity_provider = 'local'
      `
  if (!user) throw new IdentityAccessError(404, 'local_account_missing', '只有独立账号可以绑定钉钉')
  return user
}

async function assertPlatformAdmin(transaction: DatabaseTransaction, userId: string) {
  const [actor] = await transaction`
    select u.id from users u join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
    join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
    join tenants t on t.id = u.tenant_id
    where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active' and u.business_user and t.status = 'active'
      and ur.source_key = 'local' and r.status = 'active' and r.permissions ? 'admin:*' and (ur.valid_until is null or ur.valid_until > now())
    limit 1
  `
  if (!actor) throw new IdentityAccessError(403, 'permission_denied', '只有平台管理员可以管理钉钉绑定')
}

async function adminAudit(transaction: DatabaseTransaction, actorId: string, action: string, result: 'success' | 'failed', objectId: string, context: Record<string, string>) {
  await transaction`
    insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
    values (${`audit-${randomUUID()}`}, ${tenantId}, ${actorId === 'system' ? 'system' : 'user'}, ${actorId}, ${action},
      'dingtalk_binding', ${objectId}, ${result}, ${`trace-dingtalk-${randomUUID()}`},
      ${transaction.json({ channel: 'dingtalk', ...context })})
  `
}

/** 手机号：去掉空格与连字符，兼容 +86 前缀，只接受中国大陆 11 位。 */
export function normalizeMobile(value: unknown) {
  if (typeof value !== 'string') throw new IdentityAccessError(422, 'dingtalk_invalid_mobile', '请输入员工在钉钉中使用的手机号')
  const compact = value.replace(/[\s-]/g, '').replace(/^\+?86(?=1\d{10}$)/, '')
  if (!/^1\d{10}$/.test(compact)) throw new IdentityAccessError(422, 'dingtalk_invalid_mobile', '请输入 11 位手机号')
  return compact
}

/** 审计只记脱敏号码（后 4 位）。 */
export function maskMobile(mobile: string) {
  return `*******${mobile.slice(-4)}`
}

function normalizeName(name: string) {
  return name.replace(/\s/g, '').toLowerCase()
}
