import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import {
  assertAudienceAccess, clearCookie, IdentityAccessError, normalizeReturnTo,
  parseCookies, resolveRequestOrigin, serializeCookie, validateRequestOrigin,
} from './auth-service.ts'
import { assignNewAccountDepartment } from '../organization/postgres-organization-service.ts'
import { assertCanGrant, assertCanManageUser, loadGrantCeiling, requireAdminModuleActor } from '../authorization/admin-actor.ts'
import { isAuthorizationDenial } from '../../domain/authorization-errors.ts'
import { lockPlatformAdminInvariant, requireAnotherPlatformAdmin } from './administration-service.ts'
import { hashPassword, normalizeUsername, verifyPassword } from './password.ts'
import { loginAccountCandidates, normalizeLoginAccount } from './login-account.ts'
import { hashOpaque, randomOpaque } from './secure-values.ts'
import { IdentitySessionRepository } from './session-repository.ts'
import type { ApiAudience, IdentityProvider, LocalIdentityConfiguration, RequestIdentity } from './types.ts'
import { LoginRateLimiter } from './login-rate-limiter.ts'
import {
  bindFromSelfTicket, consumeSelfBindTicket, insertDingTalkSession, invalidateUserBindings,
  peekSelfBindTicket, type SelfBindOutcome,
} from './dingtalk/dingtalk-bindings.ts'
import type { DingTalkSettingsProvider } from './dingtalk/dingtalk-settings.ts'

const tenantId = 'tenant-dsh-work'
interface ValidatedSession {
  userId: string
  subject: string
  mustChangePassword: boolean
  provider: 'local-password' | 'dingtalk'
}

interface CredentialRow {
  userId: string
  subject: string
  passwordHash: string
  mustChangePassword: boolean
  active: boolean
}

export interface LocalAccountInput {
  username: string
  password: string
  name: string
  /** 新建账号时从部门树选择的部门，成为该员工的主部门；不再接受自由填写的部门文字。 */
  departmentId?: string | null
  email?: string | null
}

/** 钉钉内登录即绑定的结果（4.2 方式一）；未带待绑定凭证时为 undefined。 */
export type DingTalkLoginBinding =
  | { status: 'bound' }
  | { status: 'refused'; reason: Extract<SelfBindOutcome, { status: 'refused' }>['reason'] | 'ticket_invalid' }
  | { status: 'password_change_required' }

export class LocalAuthService {
  private readonly configuration: LocalIdentityConfiguration
  private readonly database: DatabaseClient
  private readonly repository: IdentitySessionRepository
  private readonly limiter: LoginRateLimiter
  /** 钉钉应用配置在每次使用时读取：管理端保存后立即生效。 */
  private readonly dingtalk: DingTalkSettingsProvider | null

  constructor(configuration: LocalIdentityConfiguration, database: DatabaseClient, dingtalk: DingTalkSettingsProvider | null = null) {
    this.configuration = configuration
    this.database = database
    this.repository = new IdentitySessionRepository(database)
    this.limiter = new LoginRateLimiter(database, configuration.sessionSecret)
    this.dingtalk = dingtalk
  }

  loginPage(request: IncomingMessage, audience: ApiAudience, returnTo: string | null) {
    const origin = resolveRequestOrigin(request, this.configuration.audiences[audience])
    const url = new URL('/login', origin)
    url.searchParams.set('return_to', normalizeReturnTo(returnTo, origin))
    return url.toString()
  }

  hasSessionCookie(request: IncomingMessage, audience: ApiAudience) {
    return Boolean(parseCookies(request.headers.cookie)[this.configuration.audiences[audience].sessionCookieName])
  }

  /** Only called after the selected login flow has validated its origin and credentials. */
  async revokeSession(request: IncomingMessage, audience: ApiAudience) {
    const settings = this.configuration.audiences[audience]
    const token = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (token) await this.repository.logoutSession(hashOpaque(token), audience)
    return clearCookie(settings.sessionCookieName, this.configuration.cookieSecure)
  }

  /**
   * 账号密码登录。带 `dingtalkTicket`（钉钉内待绑定凭证）时即 `bind-login`：在同一事务中锁定账号与凭据、
   * 校验密码与 audience、消费凭证、写入绑定并签发 dingtalk 会话（4.2 方式一）。
   */
  async login(request: IncomingMessage, audience: ApiAudience, input: { username: unknown; password: unknown; returnTo?: string }, options: { dingtalkTicket?: string } = {}) {
    const settings = this.configuration.audiences[audience]
    validateRequestOrigin(request, settings)
    const origin = resolveRequestOrigin(request, settings)
    const ticket = options.dingtalkTicket
    const dingtalkConfiguration = ticket !== undefined ? await this.dingtalk?.current() ?? null : null
    if (ticket !== undefined && (audience !== 'workbench' || !dingtalkConfiguration)) {
      throw new IdentityAccessError(503, 'dingtalk_not_configured', '钉钉登录未启用')
    }
    const username = normalizeUsername(input.username)
    const accountKey = `login:${username}`
    await this.limiter.consume(accountKey)
    // Derive outside the transaction so no row lock or pooled connection is held during scrypt.
    const [candidate] = await this.database<{ passwordHash: string }[]>`
      select c.password_hash as "passwordHash"
        from local_user_credentials c
        join users u on u.tenant_id = c.tenant_id and u.id = c.user_id
       where c.tenant_id = ${tenantId} and c.username = ${username} and u.identity_provider = 'local'
    `
    const valid = await verifyPassword(input.password, candidate?.passwordHash ?? null)
    const sessionToken = randomOpaque()
    const sessionHash = hashOpaque(sessionToken)
    const result = await this.database.begin(async transaction => {
      const [credential] = await transaction<CredentialRow[]>`
        select c.user_id as "userId", c.password_hash as "passwordHash",
               c.must_change_password as "mustChangePassword", u.external_subject as subject,
               (u.status = 'active' and u.business_user and t.status = 'active') as active
          from local_user_credentials c
          join users u on u.tenant_id = c.tenant_id and u.id = c.user_id
          join tenants t on t.id = u.tenant_id
         where c.tenant_id = ${tenantId} and c.username = ${username} and u.identity_provider = 'local'
         for update of u, c
      `
      // Recheck under the lock: a concurrent password change or reset invalidates the verified hash.
      if (!valid || !credential?.active || credential.passwordHash !== candidate?.passwordHash) {
        await localAudit(transaction, credential?.userId ?? 'anonymous', 'identity.login', 'failed')
        return null
      }
      const authorization = await this.repository.resolveAuthorization(credential.userId, transaction)
      assertAudienceAccess(audience, authorization.permissions, false)
      let binding: DingTalkLoginBinding | undefined
      if (ticket !== undefined) {
        if (credential.mustChangePassword) {
          // 需先修改初始密码：不消费凭证，改密请求带回同一凭证后才绑定。
          if (!await peekSelfBindTicket(transaction, ticket, origin)) return ticketRejected(transaction, credential.userId)
          binding = { status: 'password_change_required' }
        } else {
          const bound = await this.completeSelfBinding(transaction, credential.userId, ticket, origin, sessionHash, authorization.authorizationVersion, dingtalkConfiguration!.sessionTtlSeconds)
          if (!bound) return ticketRejected(transaction, credential.userId)
          binding = bound
          if (bound.status === 'bound') {
            await localAudit(transaction, credential.userId, 'identity.login', 'success', { audience, provider: 'dingtalk' }, 'dingtalk')
            return { mustChangePassword: false, binding }
          }
        }
      }
      await this.insertPasswordSession(transaction, credential.userId, audience, sessionHash, authorization.authorizationVersion)
      await localAudit(transaction, credential.userId, 'identity.login', 'success', { audience })
      return { mustChangePassword: credential.mustChangePassword, binding }
    })
    if (!result) throw new IdentityAccessError(401, 'invalid_credentials', '账号或密码错误，或账号已停用')
    if ('ticketRejected' in result) {
      throw new IdentityAccessError(409, 'dingtalk_ticket_invalid', '钉钉登录凭证已失效，请重新在钉钉中打开')
    }
    await this.limiter.clear(accountKey)
    const returnTo = normalizeReturnTo(typeof input.returnTo === 'string' ? input.returnTo : null, origin)
    const location = result.mustChangePassword
      ? new URL(`/change-password?return_to=${encodeURIComponent(returnTo)}`, origin).toString()
      : returnTo
    const ttl = result.binding?.status === 'bound' ? dingtalkConfiguration!.sessionTtlSeconds : this.configuration.sessionTtlSeconds
    return {
      location,
      sessionCookie: serializeCookie(settings.sessionCookieName, sessionToken, ttl, this.configuration.cookieSecure),
      ...(result.binding ? { dingtalkBinding: result.binding } : {}),
    }
  }

  /** 消费待绑定凭证并写入绑定；绑定成功时签发 dingtalk 会话。凭证无效返回 null。 */
  private async completeSelfBinding(
    transaction: DatabaseTransaction, userId: string, ticket: string, origin: string,
    sessionHash: string, authorizationVersion: number, dingtalkSessionTtlSeconds: number,
  ): Promise<DingTalkLoginBinding | null> {
    const consumed = await consumeSelfBindTicket(transaction, ticket, origin)
    if (!consumed) return null
    const outcome = await bindFromSelfTicket(transaction, userId, consumed)
    if (outcome.status === 'refused') {
      await localAudit(transaction, userId, 'identity.dingtalk.bind', 'failed', { reason: outcome.reason }, 'dingtalk')
      return { status: 'refused', reason: outcome.reason }
    }
    await insertDingTalkSession(transaction, {
      sessionHash, userId, bindingId: outcome.bindingId, authorizationVersion,
      ttlSeconds: dingtalkSessionTtlSeconds,
    })
    if (outcome.created) {
      await localAudit(transaction, userId, 'identity.dingtalk.bind', 'success', { bindingId: outcome.bindingId, boundBy: 'self' }, 'dingtalk')
    }
    return { status: 'bound' }
  }

  /** 密码登录只撤销此前的密码与 AI Hub 会话，不撤销钉钉会话（按来源撤销，4.3）。 */
  private async insertPasswordSession(transaction: DatabaseTransaction, userId: string, audience: ApiAudience, sessionHash: string, authorizationVersion: number) {
    const expiresAt = new Date(Date.now() + this.configuration.sessionTtlSeconds * 1000)
    await transaction`
      update authentication_sessions set revoked_at = now()
       where tenant_id = ${tenantId} and user_id = ${userId}
         and audience = ${audience} and revoked_at is null and authentication_provider <> 'dingtalk'
    `
    await transaction`
      insert into authentication_sessions (
        session_hash, tenant_id, audience, user_id, authentication_provider,
        authorization_version, permissions_expires_at, expires_at
      ) values (
        ${sessionHash}, ${tenantId}, ${audience}, ${userId}, 'local-password',
        ${authorizationVersion}, ${expiresAt}, ${expiresAt}
      )
    `
  }

  async authenticateApi(request: IncomingMessage, audience: ApiAudience, allowPasswordChange = false): Promise<RequestIdentity> {
    const settings = this.configuration.audiences[audience]
    resolveRequestOrigin(request, settings)
    validateRequestOrigin(request, settings)
    const token = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (!token) throw new IdentityAccessError(401, 'authentication_required', '请先登录')
    const sessionHash = hashOpaque(token)
    const session = await this.findLocalSession(sessionHash, audience) ?? await this.findDingTalkSession(sessionHash, audience)
    if (!session) throw new IdentityAccessError(401, 'session_expired', '登录会话不存在或已过期')
    if (session.mustChangePassword && (!allowPasswordChange || session.provider === 'dingtalk')) {
      throw new IdentityAccessError(403, 'password_change_required', '请先修改初始密码')
    }
    // 钉钉会话不能用于修改密码（改密仍需密码会话）。
    if (allowPasswordChange && session.provider === 'dingtalk') {
      throw new IdentityAccessError(403, 'password_session_required', '请使用账号密码登录后修改密码')
    }
    const authorization = await this.repository.resolveAuthorization(session.userId)
    assertAudienceAccess(audience, authorization.permissions, !allowPasswordChange && !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET'))
    await this.repository.updateAuthorizationVersion(sessionHash, authorization.authorizationVersion)
    return {
      audience, applicationId: settings.applicationId, sessionHash,
      userId: session.userId, subject: session.subject, ...authorization,
      identityProvider: session.provider,
    }
  }

  private async findLocalSession(sessionHash: string, audience: ApiAudience): Promise<ValidatedSession | null> {
    const [session] = await this.database<Omit<ValidatedSession, 'provider'>[]>`
      select s.user_id as "userId", u.external_subject as subject, c.must_change_password as "mustChangePassword"
        from authentication_sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.user_id
        join tenants t on t.id = u.tenant_id
        join local_user_credentials c on c.tenant_id = u.tenant_id and c.user_id = u.id
       where s.tenant_id = ${tenantId} and s.session_hash = ${sessionHash} and s.audience = ${audience}
         and s.authentication_provider = 'local-password' and s.revoked_at is null and s.expires_at > now()
         and u.status = 'active' and u.business_user and t.status = 'active' and u.identity_provider = 'local'
    `
    return session ? { ...session, provider: 'local-password' } : null
  }

  /**
   * dingtalk 会话另走一条查询（4.3）：账号为本地账号且有效、会话上的 binding_id 对应的绑定仍有效且属于该账号；
   * 不要求密码凭据。must_change_password 为真时同样拒绝（绑定前已要求先改密，此处兜底）。
   */
  private async findDingTalkSession(sessionHash: string, audience: ApiAudience): Promise<ValidatedSession | null> {
    if (audience !== 'workbench') return null
    const [session] = await this.database<Omit<ValidatedSession, 'provider'>[]>`
      select s.user_id as "userId", u.external_subject as subject,
             coalesce(c.must_change_password, false) as "mustChangePassword"
        from authentication_sessions s
        join external_account_bindings b on b.id = s.binding_id and b.tenant_id = s.tenant_id
         and b.user_id = s.user_id and b.channel = 'dingtalk' and b.status = 'valid'
        join users u on u.tenant_id = s.tenant_id and u.id = s.user_id
        join tenants t on t.id = u.tenant_id
        left join local_user_credentials c on c.tenant_id = u.tenant_id and c.user_id = u.id
       where s.tenant_id = ${tenantId} and s.session_hash = ${sessionHash} and s.audience = 'workbench'
         and s.authentication_provider = 'dingtalk' and s.revoked_at is null and s.expires_at > now()
         and u.status = 'active' and u.business_user and t.status = 'active' and u.identity_provider = 'local'
    `
    return session ? { ...session, provider: 'dingtalk' } : null
  }

  /** 退出登录撤销该账号在此 audience 的全部来源会话（4.3：手机钉钉与桌面浏览器会话都结束）。 */
  async logout(request: IncomingMessage, audience: ApiAudience) {
    const settings = this.configuration.audiences[audience]
    validateRequestOrigin(request, settings)
    const origin = resolveRequestOrigin(request, settings)
    const token = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (token) await this.repository.logoutSession(hashOpaque(token), audience, { allSources: true })
    return { location: new URL('/login', origin).toString(), clearSessionCookie: clearCookie(settings.sessionCookieName, this.configuration.cookieSecure) }
  }

  /**
   * 修改密码。带 `dingtalkTicket` 时为钉钉内“修改初始密码并绑定”：改密成功后在同一事务中消费待绑定凭证、
   * 写入绑定并签发 dingtalk 会话（4.2 方式一第 4 步）。凭证失效时改密照常成功，只是不绑定。
   */
  async changePassword(request: IncomingMessage, audience: ApiAudience, input: { currentPassword: unknown; newPassword: unknown; returnTo?: string; dingtalkTicket?: unknown }) {
    const identity = await this.authenticateApi(request, audience, true)
    const settings = this.configuration.audiences[audience]
    const origin = resolveRequestOrigin(request, settings)
    const ticket = typeof input.dingtalkTicket === 'string' && input.dingtalkTicket ? input.dingtalkTicket : undefined
    const dingtalkConfiguration = ticket !== undefined ? await this.dingtalk?.current() ?? null : null
    if (ticket !== undefined && (audience !== 'workbench' || !dingtalkConfiguration)) {
      throw new IdentityAccessError(503, 'dingtalk_not_configured', '钉钉登录未启用')
    }
    const passwordKey = `password:${identity.userId}`
    await this.limiter.consume(passwordKey)
    if (input.currentPassword === input.newPassword) throw new IdentityAccessError(422, 'password_unchanged', '新密码不能与当前密码相同')
    const passwordHash = await hashPassword(input.newPassword)
    // Verify outside the transaction; the locked recheck below rejects a hash changed meanwhile.
    const [current] = await this.database<{ passwordHash: string }[]>`
      select password_hash as "passwordHash" from local_user_credentials
       where tenant_id = ${tenantId} and user_id = ${identity.userId}
    `
    const currentValid = await verifyPassword(input.currentPassword, current?.passwordHash ?? null)
    const sessionToken = randomOpaque()
    const sessionHash = hashOpaque(sessionToken)
    const changed = await this.database.begin(async transaction => {
      // Use the same user/credential lock order as login, and recheck after hashing.
      const [credential] = await transaction<{ passwordHash: string; active: boolean }[]>`
        select c.password_hash as "passwordHash",
               (u.status = 'active' and u.business_user and t.status = 'active') as active
          from local_user_credentials c
          join users u on u.tenant_id = c.tenant_id and u.id = c.user_id
          join tenants t on t.id = u.tenant_id
         where c.tenant_id = ${tenantId} and c.user_id = ${identity.userId} and u.identity_provider = 'local'
         for update of u, c
      `
      const [session] = await transaction`
        select session_hash from authentication_sessions
         where tenant_id = ${tenantId} and user_id = ${identity.userId}
           and session_hash = ${identity.sessionHash} and audience = ${audience}
           and authentication_provider = 'local-password' and revoked_at is null and expires_at > now() for update
      `
      if (!session || !credential?.active || !currentValid || credential.passwordHash !== current?.passwordHash) {
        await localAudit(transaction, identity.userId, 'identity.password.change', 'failed')
        return null
      }
      const authorization = await this.repository.resolveAuthorization(identity.userId, transaction)
      assertAudienceAccess(audience, authorization.permissions, false)
      await transaction`
        update local_user_credentials set password_hash = ${passwordHash}, must_change_password = false, updated_at = now()
         where tenant_id = ${tenantId} and user_id = ${identity.userId}
      `
      // 员工自己改密：绑定保留，但与现在一样撤销全部来源的会话（4.2“解绑与失效”）。
      await revokeUserSessions(transaction, identity.userId)
      await localAudit(transaction, identity.userId, 'identity.password.change', 'success', { audience })
      if (ticket !== undefined) {
        const binding = await this.completeSelfBinding(transaction, identity.userId, ticket, origin, sessionHash, authorization.authorizationVersion, dingtalkConfiguration!.sessionTtlSeconds)
        if (binding?.status === 'bound') return { binding }
        if (!binding) await localAudit(transaction, identity.userId, 'identity.dingtalk.bind', 'failed', { reason: 'ticket_invalid' }, 'dingtalk')
        await this.insertPasswordSession(transaction, identity.userId, audience, sessionHash, authorization.authorizationVersion)
        return { binding: binding ?? ({ status: 'refused', reason: 'ticket_invalid' } satisfies DingTalkLoginBinding) }
      }
      await this.insertPasswordSession(transaction, identity.userId, audience, sessionHash, authorization.authorizationVersion)
      return { binding: undefined }
    })
    if (!changed) throw new IdentityAccessError(401, 'invalid_credentials', '当前密码错误或会话已过期')
    await this.limiter.clear(passwordKey)
    const ttl = changed.binding?.status === 'bound' ? dingtalkConfiguration!.sessionTtlSeconds : this.configuration.sessionTtlSeconds
    return {
      location: normalizeReturnTo(typeof input.returnTo === 'string' ? input.returnTo : null, origin),
      sessionCookie: serializeCookie(settings.sessionCookieName, sessionToken, ttl, this.configuration.cookieSecure),
      ...(changed.binding ? { dingtalkBinding: changed.binding } : {}),
    }
  }

  /** Operator-only, one-time command. No HTTP bootstrap endpoint or default password. */
  async bootstrap(input: LocalAccountInput) {
    const username = normalizeLoginAccount(input.username)
    const passwordHash = await hashPassword(input.password)
    return this.database.begin(async transaction => {
      await lockPlatformAdminInvariant(transaction)
      const [closed] = await transaction`
        select tenant_id from local_identity_bootstrap where tenant_id = ${tenantId}
        union all select tenant_id from local_user_credentials where tenant_id = ${tenantId} limit 1
      `
      if (closed) throw new IdentityAccessError(409, 'bootstrap_closed', '独立账号初始化已完成，不能重复初始化或通过此命令恢复权限')
      const userId = await insertAccount(transaction, input, username, passwordHash, false)
      await transaction`
        insert into user_roles (tenant_id, user_id, role_id, source_key, granted_by)
        values (${tenantId}, ${userId}, 'role-platform-admin', 'local', ${userId}) on conflict do nothing
      `
      await transaction`insert into local_identity_bootstrap (tenant_id, user_id) values (${tenantId}, ${userId})`
      await localAudit(transaction, userId, 'identity.local.bootstrap', 'success')
      return { userId, username }
    })
  }

  async createAccount(input: LocalAccountInput, actorId: string) {
    const username = normalizeLoginAccount(input.username)
    const passwordHash = await hashPassword(input.password)
    return this.database.begin(async transaction => {
      await assertIdentityWriter(transaction, actorId)
      const userId = await insertAccount(transaction, input, username, passwordHash, true)
      if (input.departmentId) await assignNewAccountDepartment(transaction, { userId, departmentId: input.departmentId, actorId })
      // 新账号经部门授权得到的角色同样不能超过建号人（方案 AP13 ①）。
      await mapDenial(assertCanGrant(transaction, actorId, await loadGrantCeiling(transaction, userId), '新账号经所选部门获得的权限'))
      await revokeUserSessions(transaction, userId)
      await localAudit(transaction, actorId, 'identity.local.create', 'success', { userId })
      return { userId, username }
    })
  }

  async checkLoginAccount(input: unknown, actorId: string) {
    const username = normalizeLoginAccount(input)
    return this.database.begin(async transaction => {
      await assertIdentityWriter(transaction, actorId)
      return { username, available: !await loginAccountExists(transaction, username) }
    })
  }

  async resetPassword(userId: string, password: unknown, actorId: string) {
    if (userId === actorId) throw new IdentityAccessError(422, 'self_reset_forbidden', '请通过修改密码验证自己的当前密码')
    const passwordHash = await hashPassword(password)
    await this.database.begin(async transaction => {
      await assertIdentityWriter(transaction, actorId)
      await mapDenial(assertCanManageUser(transaction, actorId, userId))
      const [credential] = await transaction`
        update local_user_credentials set password_hash = ${passwordHash}, must_change_password = true, updated_at = now()
         where tenant_id = ${tenantId} and user_id = ${userId}
           and exists (select 1 from users u where u.tenant_id = ${tenantId} and u.id = ${userId} and u.identity_provider = 'local') returning user_id
      `
      if (!credential) throw new IdentityAccessError(404, 'local_account_missing', '该员工尚未开通独立登录')
      // 管理员重置密码通常意味着密码可能泄露：钉钉绑定同时失效（4.2“解绑与失效”）。
      const invalidated = await invalidateUserBindings(transaction, userId, 'admin_password_reset')
      await revokeUserSessions(transaction, userId)
      await localAudit(transaction, actorId, 'identity.password.reset', 'success', { userId, ...(invalidated.length ? { dingtalkBindingInvalidated: 'true' } : {}) })
    })
    return { userId }
  }

  async setStatus(userId: string, status: unknown, actorId: string) {
    if (status !== 'active' && status !== 'disabled') throw new IdentityAccessError(422, 'invalid_status', '账号状态无效')
    await this.database.begin(async transaction => {
      await lockPlatformAdminInvariant(transaction)
      await assertIdentityWriter(transaction, actorId)
      await mapDenial(assertCanManageUser(transaction, actorId, userId))
      const [user] = await transaction<{ identityProvider: string }[]>`
        select u.identity_provider as "identityProvider" from users u join local_user_credentials c on c.tenant_id = u.tenant_id and c.user_id = u.id
         where u.tenant_id = ${tenantId} and u.id = ${userId} for update of u
      `
      if (!user) throw new IdentityAccessError(404, 'local_account_missing', '该员工尚未开通独立登录')
      if (user.identityProvider !== 'local') {
        throw new IdentityAccessError(422, 'upstream_managed_status', 'AI Hub 账号状态请在企业身份平台中管理')
      }
      if (status === 'disabled') {
        const [admin] = await transaction`
          select ur.user_id from user_roles ur join roles r on r.id = ur.role_id and r.tenant_id = ur.tenant_id
           where ur.tenant_id = ${tenantId} and ur.user_id = ${userId} and r.id = 'role-platform-admin'
             and r.status = 'active' and (ur.valid_until is null or ur.valid_until > now())
        `
        if (admin) await requireAnotherPlatformAdmin(transaction, userId, true)
      }
      await transaction`update users set status = ${status}, local_authorization_version = local_authorization_version + 1, updated_at = now() where tenant_id = ${tenantId} and id = ${userId}`
      if (status === 'disabled') {
        await invalidateUserBindings(transaction, userId, 'account_disabled')
        await revokeUserSessions(transaction, userId)
      }
      await localAudit(transaction, actorId, 'identity.local.status', 'success', { userId, status })
    })
    return { userId, status }
  }
}

async function insertAccount(transaction: DatabaseTransaction, input: LocalAccountInput, username: string, passwordHash: string, mustChangePassword: boolean) {
  if ('existingUserId' in input) throw new IdentityAccessError(422, 'account_binding_unsupported', '不支持绑定既有账号，请创建独立账号')
  if (await loginAccountExists(transaction, username)) throw new IdentityAccessError(409, 'local_account_exists', '登录账号已存在，请使用其他手机号或邮箱')
  const userId = `user-${randomUUID()}`
  const name = requiredText(input.name, '姓名', 80)
  const email = optionalText(input.email, '邮箱', 254)
  await transaction`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user, email)
    values (${userId}, ${tenantId}, ${`local:${randomUUID()}`}, ${name}, 'active', 'local', true, ${email})
  `
  const [created] = await transaction`
    insert into local_user_credentials (tenant_id, user_id, username, password_hash, must_change_password)
    values (${tenantId}, ${userId}, ${username}, ${passwordHash}, ${mustChangePassword}) on conflict do nothing returning user_id
  `
  if (!created) throw new IdentityAccessError(409, 'local_account_exists', '登录账号已存在，请使用其他手机号或邮箱')
  return userId
}

async function loginAccountExists(transaction: DatabaseTransaction, username: string) {
  const candidates = loginAccountCandidates(username)
  const [existing] = await transaction`
    select 1 from local_user_credentials where tenant_id = ${tenantId} and username = any(${candidates}::text[])
    union all
    select 1 from users where tenant_id = ${tenantId} and identity_provider = 'ai-hub'
      and lower(btrim(external_subject)) = any(${candidates}::text[])
    limit 1
  `
  return Boolean(existing)
}

/** 修改员工与权限（管理端模块权限方案 AP11）：只认本地授予的模块权限。 */
async function assertIdentityWriter(transaction: DatabaseTransaction, userId: string) {
  try {
    await requireAdminModuleActor(transaction, userId, 'identity', 'write')
  } catch (error) {
    if (isAuthorizationDenial(error)) throw new IdentityAccessError(403, 'permission_denied', '当前用户没有员工与权限的修改权限')
    throw error
  }
}

/** 防提权拒绝（方案 AP13）以身份模块的错误类型返回，保留原因文案。 */
async function mapDenial(check: Promise<unknown>) {
  try {
    await check
  } catch (error) {
    if (isAuthorizationDenial(error)) throw new IdentityAccessError(403, 'permission_denied', error instanceof Error ? error.message : '没有权限')
    throw error
  }
}

async function revokeUserSessions(transaction: DatabaseTransaction, userId: string) {
  await transaction`update authentication_sessions set revoked_at = now() where tenant_id = ${tenantId} and user_id = ${userId} and revoked_at is null`
}

async function ticketRejected(transaction: DatabaseTransaction, userId: string) {
  await localAudit(transaction, userId, 'identity.dingtalk.bind', 'failed', { reason: 'ticket_invalid' }, 'dingtalk')
  return { ticketRejected: true as const }
}

async function localAudit(
  transaction: DatabaseTransaction, actorId: string, action: string, result: 'success' | 'failed',
  context: Record<string, string> = {}, provider: IdentityProvider = 'local-password',
) {
  await transaction`
    insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
    values (${`audit-${randomUUID()}`}, ${tenantId}, ${actorId === 'anonymous' ? 'system' : 'user'}, ${actorId}, ${action},
      'local_identity', ${context.userId ?? actorId}, ${result}, ${`trace-identity-${randomUUID()}`},
      ${transaction.json({ provider, ...context })})
  `
}

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new IdentityAccessError(422, 'invalid_request', `${label}必须为 1–${max} 个字符`)
  return value.trim()
}

function optionalText(value: unknown, label: string, max: number) {
  return value === null || value === undefined || value === '' ? null : requiredText(value, label, max)
}
