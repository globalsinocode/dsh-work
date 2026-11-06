import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import {
  assertAudienceAccess, IdentityAccessError, normalizeReturnTo, resolveRequestOrigin,
  serializeCookie, validateRequestOrigin,
} from '../auth-service.ts'
import { LoginRateLimiter } from '../login-rate-limiter.ts'
import { hashOpaque, randomOpaque } from '../secure-values.ts'
import { IdentitySessionRepository } from '../session-repository.ts'
import type { LocalIdentityConfiguration } from '../types.ts'
import { DINGTALK_CHANNEL, insertDingTalkSession } from './dingtalk-bindings.ts'
import type { DingTalkConfiguration } from './dingtalk-config.ts'
import { DingTalkDirectoryError, type DingTalkDirectory } from './dingtalk-directory.ts'
import type { DingTalkSettingsProvider } from './dingtalk-settings.ts'

const tenantId = 'tenant-dsh-work'

export type DingTalkLoginResult =
  | { status: 'signed_in'; location: string; sessionCookie: string }
  | {
      status: 'binding_required'
      bindingToken: string
      expiresInSeconds: number
      dingtalkName: string | null
      dingtalkDepartment: string | null
    }

/**
 * 钉钉容器内免登（钉钉接入方案 4.3）：一次性授权码 → 钉钉 userid → 有效绑定 → dingtalk 会话。
 * 没有有效绑定时返回服务端保存的待绑定凭证（4.2 方式一），不自动建账号。
 */
export class DingTalkAuthService {
  private readonly local: LocalIdentityConfiguration
  private readonly database: DatabaseClient
  private readonly settings: DingTalkSettingsProvider
  private readonly repository: IdentitySessionRepository
  private readonly limiter: LoginRateLimiter

  constructor(local: LocalIdentityConfiguration, database: DatabaseClient, settings: DingTalkSettingsProvider) {
    this.local = local
    this.database = database
    this.settings = settings
    this.repository = new IdentitySessionRepository(database)
    this.limiter = new LoginRateLimiter(database, local.sessionSecret)
  }

  async login(request: IncomingMessage, input: { authCode?: unknown; returnTo?: unknown }): Promise<DingTalkLoginResult> {
    const settings = this.local.audiences.workbench
    validateRequestOrigin(request, settings)
    const origin = resolveRequestOrigin(request, settings)
    const configuration = await this.requireConfiguration()
    const directory = this.settings.directory(configuration)
    if (typeof input.authCode !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.authCode)) {
      throw new IdentityAccessError(422, 'invalid_request', '缺少钉钉授权码')
    }
    // 授权码一次性：服务端不缓存、不重放，每次都向钉钉换取。非本企业或已使用的授权码在换取时失败。
    const identity = await this.exchange(directory, input.authCode)
    if (identity.corpId !== configuration.corpId) {
      await this.audit(this.database, 'anonymous', 'identity.dingtalk.login', 'failed', { reason: 'foreign_corp' })
      throw new IdentityAccessError(401, 'dingtalk_auth_code_invalid', '钉钉登录凭证无效，请在本企业钉钉中重新打开')
    }
    const userKey = `dingtalk:${identity.userId}`
    await this.limiter.consume(userKey, 30)
    const sessionToken = randomOpaque()
    const sessionHash = hashOpaque(sessionToken)
    const signedIn = await this.database.begin(async transaction => {
      // 与停用、重置密码、解绑相同的加锁顺序：先锁 users，再锁绑定，避免死锁。
      const [candidate] = await transaction<{ userId: string }[]>`
        select user_id as "userId" from external_account_bindings
         where tenant_id = ${tenantId} and channel = ${DINGTALK_CHANNEL}
           and external_user_id = ${identity.userId} and status = 'valid'
      `
      if (!candidate) return null
      await transaction`select id from users where tenant_id = ${tenantId} and id = ${candidate.userId} for update`
      const [binding] = await transaction<{ id: string; userId: string; active: boolean }[]>`
        select b.id, b.user_id as "userId",
               (u.status = 'active' and u.business_user and t.status = 'active' and u.identity_provider = 'local') as active
          from external_account_bindings b
          join users u on u.tenant_id = b.tenant_id and u.id = b.user_id
          join tenants t on t.id = u.tenant_id
         where b.tenant_id = ${tenantId} and b.channel = ${DINGTALK_CHANNEL}
           and b.external_user_id = ${identity.userId} and b.status = 'valid' and b.user_id = ${candidate.userId}
         for update of b
      `
      if (!binding) return null
      if (!binding.active) {
        await this.audit(transaction, binding.userId, 'identity.dingtalk.login', 'failed', { reason: 'account_inactive' })
        return { denied: true as const }
      }
      const [credential] = await transaction<{ mustChangePassword: boolean }[]>`
        select must_change_password as "mustChangePassword" from local_user_credentials
         where tenant_id = ${tenantId} and user_id = ${binding.userId}
      `
      if (credential?.mustChangePassword) {
        await this.audit(transaction, binding.userId, 'identity.dingtalk.login', 'failed', { reason: 'password_change_required' })
        return { passwordChangeRequired: true as const }
      }
      const authorization = await this.repository.resolveAuthorization(binding.userId, transaction)
      assertAudienceAccess('workbench', authorization.permissions, false)
      await insertDingTalkSession(transaction, {
        sessionHash, userId: binding.userId, bindingId: binding.id,
        authorizationVersion: authorization.authorizationVersion, ttlSeconds: configuration.sessionTtlSeconds,
      })
      await this.audit(transaction, binding.userId, 'identity.login', 'success', { audience: 'workbench', bindingId: binding.id })
      return { userId: binding.userId }
    })
    if (signedIn && 'denied' in signedIn) {
      throw new IdentityAccessError(403, 'dingtalk_account_unavailable', '钉钉绑定的账号已停用，请联系管理员')
    }
    if (signedIn && 'passwordChangeRequired' in signedIn) {
      throw new IdentityAccessError(403, 'password_change_required', '请先用账号密码登录并修改初始密码')
    }
    if (signedIn) {
      await this.limiter.clear(userKey)
      return {
        status: 'signed_in',
        location: normalizeReturnTo(typeof input.returnTo === 'string' ? input.returnTo : null, origin),
        sessionCookie: serializeCookie(settings.sessionCookieName, sessionToken, configuration.sessionTtlSeconds, this.local.cookieSecure),
      }
    }
    const department = await this.departmentLabel(directory, identity.userId)
    const ticket = randomOpaque()
    await this.database`
      insert into external_binding_tickets (
        ticket_hash, tenant_id, channel, purpose, external_user_id, external_union_id,
        external_display_name, external_department, corp_id, request_origin, expires_at
      ) values (
        ${hashOpaque(ticket)}, ${tenantId}, ${DINGTALK_CHANNEL}, 'self-bind', ${identity.userId}, ${identity.unionId},
        ${identity.name}, ${department}, ${identity.corpId}, ${origin},
        now() + make_interval(secs => ${configuration.bindingTicketTtlSeconds})
      )
    `
    await this.database`delete from external_binding_tickets where expires_at < now() - interval '1 day'`
    return {
      status: 'binding_required',
      bindingToken: ticket,
      expiresInSeconds: configuration.bindingTicketTtlSeconds,
      dingtalkName: identity.name,
      dingtalkDepartment: department,
    }
  }

  private async requireConfiguration(): Promise<DingTalkConfiguration> {
    const configuration = await this.settings.current()
    if (!configuration) throw new IdentityAccessError(503, 'dingtalk_not_configured', '钉钉登录未启用')
    return configuration
  }

  private async exchange(directory: DingTalkDirectory, authCode: string) {
    try {
      return await directory.exchangeAuthCode(authCode)
    } catch (error) {
      if (error instanceof DingTalkDirectoryError && error.code === 'auth_code_invalid') {
        await this.audit(this.database, 'anonymous', 'identity.dingtalk.login', 'failed', { reason: 'auth_code_invalid' })
        throw new IdentityAccessError(401, 'dingtalk_auth_code_invalid', '钉钉登录凭证无效或已使用，请重新打开')
      }
      // 钉钉不可用时明确报告，不降级为其他登录方式。
      throw new IdentityAccessError(503, 'dingtalk_unavailable', '暂时无法连接钉钉，请稍后重试或使用账号密码登录')
    }
  }

  /** 登录页提示“当前钉钉账号：姓名（部门）”用；任何失败只省略部门，不影响登录。 */
  private async departmentLabel(directory: DingTalkDirectory, userId: string) {
    try {
      const member = await directory.getMember(userId)
      const names = await Promise.all(member.departmentIds.slice(0, 2).map(id => directory.getDepartmentName(id)))
      return names.length ? names.join('、') : null
    } catch {
      return null
    }
  }

  private async audit(database: DatabaseClient | DatabaseTransaction, actorId: string, action: string, result: 'success' | 'failed', context: Record<string, string>) {
    await database`
      insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
      values (${`audit-${randomUUID()}`}, ${tenantId}, ${actorId === 'anonymous' ? 'system' : 'user'}, ${actorId}, ${action},
        'local_identity', ${actorId}, ${result}, ${`trace-identity-${randomUUID()}`},
        ${database.json({ provider: 'dingtalk', ...context })})
    `
  }
}
