import { randomUUID } from 'node:crypto'

import type { DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { hashOpaque } from '../secure-values.ts'

const tenantId = 'tenant-dsh-work'
export const DINGTALK_CHANNEL = 'dingtalk'

export interface SelfBindTicket {
  externalUserId: string
  externalUnionId: string | null
  externalDisplayName: string | null
  externalDepartment: string | null
  corpId: string
}

/** 钉钉内登录即绑定被拒绝的原因（4.2 方式一第 4 步）。 */
export type SelfBindRefusal =
  | 'dingtalk_account_bound_to_other'
  | 'account_has_other_binding'
  | 'self_bind_locked'

export type SelfBindOutcome =
  | { status: 'bound'; bindingId: string; created: boolean }
  | { status: 'refused'; reason: SelfBindRefusal }

/** 只读取、不消费：用于需先改初始密码时保留凭证到改密请求。 */
export async function peekSelfBindTicket(transaction: DatabaseTransaction, ticket: string, origin: string) {
  const [row] = await transaction<{ ticketHash: string }[]>`
    select ticket_hash as "ticketHash" from external_binding_tickets
     where ticket_hash = ${hashOpaque(ticket)} and tenant_id = ${tenantId} and purpose = 'self-bind'
       and consumed_at is null and expires_at > now() and request_origin = ${origin}
  `
  return Boolean(row)
}

/** 原子消费：重复使用、过期、来源不符一律返回 null。 */
export async function consumeSelfBindTicket(transaction: DatabaseTransaction, ticket: string, origin: string): Promise<SelfBindTicket | null> {
  const [row] = await transaction<SelfBindTicket[]>`
    update external_binding_tickets set consumed_at = now()
     where ticket_hash = ${hashOpaque(ticket)} and tenant_id = ${tenantId} and purpose = 'self-bind'
       and consumed_at is null and expires_at > now() and request_origin = ${origin}
    returning external_user_id as "externalUserId", external_union_id as "externalUnionId",
              external_display_name as "externalDisplayName", external_department as "externalDepartment", corp_id as "corpId"
  `
  return row ?? null
}

/**
 * 写入本人绑定。调用方已在同一事务中锁定 users 与 local_user_credentials 并校验密码与 audience。
 * 只凭密码不替换已有绑定；撞上唯一索引不抛 23505（那会中止整个事务），而是以空结果判为冲突。
 */
export async function bindFromSelfTicket(transaction: DatabaseTransaction, userId: string, ticket: SelfBindTicket): Promise<SelfBindOutcome> {
  const [locked] = await transaction`
    select 1 from external_account_bindings
     where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and self_rebind_locked
     limit 1
  `
  if (locked) return { status: 'refused', reason: 'self_bind_locked' }
  const [existing] = await transaction<{ id: string; externalUserId: string }[]>`
    select id, external_user_id as "externalUserId" from external_account_bindings
     where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and status = 'valid'
     for update
  `
  if (existing) {
    return existing.externalUserId === ticket.externalUserId
      ? { status: 'bound', bindingId: existing.id, created: false }
      : { status: 'refused', reason: 'account_has_other_binding' }
  }
  const bindingId = `binding-${randomUUID()}`
  const [created] = await transaction<{ id: string }[]>`
    insert into external_account_bindings (
      id, tenant_id, channel, user_id, external_user_id, external_union_id,
      external_display_name, external_department, bound_by, status
    ) values (
      ${bindingId}, ${tenantId}, ${DINGTALK_CHANNEL}, ${userId}, ${ticket.externalUserId}, ${ticket.externalUnionId},
      ${ticket.externalDisplayName}, ${ticket.externalDepartment}, 'self', 'valid'
    ) on conflict do nothing returning id
  `
  if (!created) {
    // 并发绑定：同一平台账号的另一请求先提交。绑定的是同一个钉钉账号时视为已绑定，否则按“已有其他绑定”提示。
    const [own] = await transaction<{ id: string; externalUserId: string }[]>`
      select id, external_user_id as "externalUserId" from external_account_bindings
       where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and status = 'valid'
    `
    if (own?.externalUserId === ticket.externalUserId) return { status: 'bound', bindingId: own.id, created: false }
    return { status: 'refused', reason: own ? 'account_has_other_binding' : 'dingtalk_account_bound_to_other' }
  }
  return { status: 'bound', bindingId, created: true }
}

/** 签发关联绑定的 dingtalk 会话：只撤销该账号此前的 dingtalk 会话（按来源撤销，4.3）。 */
export async function insertDingTalkSession(transaction: DatabaseTransaction, input: {
  sessionHash: string
  userId: string
  bindingId: string
  authorizationVersion: number
  ttlSeconds: number
}) {
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000)
  await transaction`
    update authentication_sessions set revoked_at = now()
     where tenant_id = ${tenantId} and user_id = ${input.userId} and audience = 'workbench'
       and authentication_provider = 'dingtalk' and revoked_at is null
  `
  await transaction`
    insert into authentication_sessions (
      session_hash, tenant_id, audience, user_id, authentication_provider, binding_id,
      authorization_version, permissions_expires_at, expires_at
    ) values (
      ${input.sessionHash}, ${tenantId}, 'workbench', ${input.userId}, 'dingtalk', ${input.bindingId},
      ${input.authorizationVersion}, ${expiresAt}, ${expiresAt}
    )
  `
}

/**
 * 使账号的有效钉钉绑定失效，并按 binding_id 撤销其 dingtalk 会话（同一事务）。返回失效的绑定。
 * 账号停用、管理员重置密码、解绑、改绑与离职检查共用。
 */
export async function invalidateUserBindings(transaction: DatabaseTransaction, userId: string, reason: string, options: { lockSelfRebind?: boolean } = {}) {
  const rows = await transaction<{ id: string; externalUserId: string; externalDisplayName: string | null }[]>`
    update external_account_bindings
       set status = 'invalid', revoked_at = now(), revoke_reason = ${reason},
           self_rebind_locked = ${options.lockSelfRebind ?? false}, updated_at = now()
     where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and user_id = ${userId} and status = 'valid'
    returning id, external_user_id as "externalUserId", external_display_name as "externalDisplayName"
  `
  await revokeBindingSessions(transaction, rows.map(row => row.id))
  return rows
}

export async function revokeBindingSessions(transaction: DatabaseTransaction, bindingIds: string[]) {
  if (!bindingIds.length) return
  await transaction`
    update authentication_sessions set revoked_at = now()
     where tenant_id = ${tenantId} and binding_id = any(${bindingIds}::text[]) and revoked_at is null
  `
}

/**
 * 钉钉应用换到另一个企业（CorpId 变化）时调用：钉钉 userid 只在企业内唯一，旧企业的有效绑定全部失效
 * （revoke_reason = corp_changed），撤销对应钉钉会话，删除尚未使用的待绑定与代绑确认凭证。返回失效的绑定数。
 */
export async function invalidateAllBindingsForCorpChange(transaction: DatabaseTransaction) {
  const rows = await transaction<{ id: string }[]>`
    update external_account_bindings
       set status = 'invalid', revoked_at = now(), revoke_reason = 'corp_changed', updated_at = now()
     where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and status = 'valid'
    returning id
  `
  await revokeBindingSessions(transaction, rows.map(row => row.id))
  await transaction`delete from external_binding_tickets where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL} and consumed_at is null`
  return rows.length
}
