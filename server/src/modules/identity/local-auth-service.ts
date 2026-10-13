import { createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import {
  assertAudienceAccess, clearCookie, IdentityAccessError, normalizeReturnTo,
  parseCookies, resolveRequestOrigin, serializeCookie, validateRequestOrigin,
} from './auth-service.ts'
import { lockPlatformAdminInvariant, requireAnotherPlatformAdmin } from './administration-service.ts'
import { hashPassword, normalizeUsername, verifyPassword } from './password.ts'
import { loginAccountCandidates, normalizeLoginAccount } from './login-account.ts'
import { hashOpaque, randomOpaque } from './secure-values.ts'
import { IdentitySessionRepository } from './session-repository.ts'
import type { ApiAudience, LocalIdentityConfiguration, RequestIdentity } from './types.ts'

const tenantId = 'tenant-dsh-work'
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
  department?: string | null
  email?: string | null
}

export class LocalAuthService {
  private readonly configuration: LocalIdentityConfiguration
  private readonly database: DatabaseClient
  private readonly repository: IdentitySessionRepository

  constructor(configuration: LocalIdentityConfiguration, database: DatabaseClient) {
    this.configuration = configuration
    this.database = database
    this.repository = new IdentitySessionRepository(database)
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

  async login(request: IncomingMessage, audience: ApiAudience, input: { username: unknown; password: unknown; returnTo?: string }) {
    const settings = this.configuration.audiences[audience]
    validateRequestOrigin(request, settings)
    const origin = resolveRequestOrigin(request, settings)
    const username = normalizeUsername(input.username)
    await this.rateLimit(request, `login:${username}`)
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
      const valid = await verifyPassword(input.password, credential?.passwordHash ?? null)
      if (!valid || !credential?.active) {
        await localAudit(transaction, credential?.userId ?? 'anonymous', 'identity.login', 'failed')
        return null
      }
      const authorization = await this.repository.resolveAuthorization(credential.userId, transaction)
      assertAudienceAccess(audience, authorization.permissions, false)
      const expiresAt = new Date(Date.now() + this.configuration.sessionTtlSeconds * 1000)
      await transaction`
        update authentication_sessions set revoked_at = now()
         where tenant_id = ${tenantId} and user_id = ${credential.userId}
           and audience = ${audience} and revoked_at is null
      `
      await transaction`
        insert into authentication_sessions (
          session_hash, tenant_id, audience, user_id, authentication_provider,
          authorization_version, permissions_expires_at, expires_at
        ) values (
          ${sessionHash}, ${tenantId}, ${audience}, ${credential.userId}, 'local-password',
          ${authorization.authorizationVersion}, ${expiresAt}, ${expiresAt}
        )
      `
      await localAudit(transaction, credential.userId, 'identity.login', 'success', { audience })
      return { mustChangePassword: credential.mustChangePassword }
    })
    if (!result) throw new IdentityAccessError(401, 'invalid_credentials', '账号或密码错误，或账号已停用')
    const returnTo = normalizeReturnTo(typeof input.returnTo === 'string' ? input.returnTo : null, origin)
    const location = result.mustChangePassword
      ? new URL(`/change-password?return_to=${encodeURIComponent(returnTo)}`, origin).toString()
      : returnTo
    return {
      location,
      sessionCookie: serializeCookie(settings.sessionCookieName, sessionToken, this.configuration.sessionTtlSeconds, this.configuration.cookieSecure),
    }
  }

  async authenticateApi(request: IncomingMessage, audience: ApiAudience, allowPasswordChange = false): Promise<RequestIdentity> {
    const settings = this.configuration.audiences[audience]
    resolveRequestOrigin(request, settings)
    validateRequestOrigin(request, settings)
    const token = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (!token) throw new IdentityAccessError(401, 'authentication_required', '请先登录')
    const sessionHash = hashOpaque(token)
    const [session] = await this.database<{ userId: string; subject: string; mustChangePassword: boolean }[]>`
      select s.user_id as "userId", u.external_subject as subject, c.must_change_password as "mustChangePassword"
        from authentication_sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.user_id
        join tenants t on t.id = u.tenant_id
        join local_user_credentials c on c.tenant_id = u.tenant_id and c.user_id = u.id
       where s.tenant_id = ${tenantId} and s.session_hash = ${sessionHash} and s.audience = ${audience}
         and s.authentication_provider = 'local-password' and s.revoked_at is null and s.expires_at > now()
         and u.status = 'active' and u.business_user and t.status = 'active' and u.identity_provider = 'local'
    `
    if (!session) throw new IdentityAccessError(401, 'session_expired', '登录会话不存在或已过期')
    if (session.mustChangePassword && !allowPasswordChange) {
      throw new IdentityAccessError(403, 'password_change_required', '请先修改初始密码')
    }
    const authorization = await this.repository.resolveAuthorization(session.userId)
    assertAudienceAccess(audience, authorization.permissions, !allowPasswordChange && !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET'))
    await this.repository.updateAuthorizationVersion(sessionHash, authorization.authorizationVersion)
    return {
      audience, applicationId: settings.applicationId, sessionHash,
      userId: session.userId, subject: session.subject, ...authorization,
      identityProvider: 'local-password',
    }
  }

  async logout(request: IncomingMessage, audience: ApiAudience) {
    const settings = this.configuration.audiences[audience]
    validateRequestOrigin(request, settings)
    const origin = resolveRequestOrigin(request, settings)
    return { location: new URL('/login', origin).toString(), clearSessionCookie: await this.revokeSession(request, audience) }
  }

  async changePassword(request: IncomingMessage, audience: ApiAudience, input: { currentPassword: unknown; newPassword: unknown; returnTo?: string }) {
    const identity = await this.authenticateApi(request, audience, true)
    const settings = this.configuration.audiences[audience]
    const origin = resolveRequestOrigin(request, settings)
    await this.rateLimit(request, `password:${identity.userId}`)
    if (input.currentPassword === input.newPassword) throw new IdentityAccessError(422, 'password_unchanged', '新密码不能与当前密码相同')
    const passwordHash = await hashPassword(input.newPassword)
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
      if (!session || !credential?.active || !await verifyPassword(input.currentPassword, credential.passwordHash)) {
        await localAudit(transaction, identity.userId, 'identity.password.change', 'failed')
        return false
      }
      const authorization = await this.repository.resolveAuthorization(identity.userId, transaction)
      assertAudienceAccess(audience, authorization.permissions, false)
      await transaction`
        update local_user_credentials set password_hash = ${passwordHash}, must_change_password = false, updated_at = now()
         where tenant_id = ${tenantId} and user_id = ${identity.userId}
      `
      await revokeUserSessions(transaction, identity.userId)
      const expiresAt = new Date(Date.now() + this.configuration.sessionTtlSeconds * 1000)
      await transaction`
        insert into authentication_sessions (
          session_hash, tenant_id, audience, user_id, authentication_provider,
          authorization_version, permissions_expires_at, expires_at
        ) values (
          ${sessionHash}, ${tenantId}, ${audience}, ${identity.userId}, 'local-password',
          ${authorization.authorizationVersion}, ${expiresAt}, ${expiresAt}
        )
      `
      await localAudit(transaction, identity.userId, 'identity.password.change', 'success', { audience })
      return true
    })
    if (!changed) throw new IdentityAccessError(401, 'invalid_credentials', '当前密码错误或会话已过期')
    return {
      location: normalizeReturnTo(typeof input.returnTo === 'string' ? input.returnTo : null, origin),
      sessionCookie: serializeCookie(settings.sessionCookieName, sessionToken, this.configuration.sessionTtlSeconds, this.configuration.cookieSecure),
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
      await assertPlatformAdmin(transaction, actorId)
      const userId = await insertAccount(transaction, input, username, passwordHash, true)
      await revokeUserSessions(transaction, userId)
      await localAudit(transaction, actorId, 'identity.local.create', 'success', { userId })
      return { userId, username }
    })
  }

  async checkLoginAccount(input: unknown, actorId: string) {
    const username = normalizeLoginAccount(input)
    return this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      return { username, available: !await loginAccountExists(transaction, username) }
    })
  }

  async resetPassword(userId: string, password: unknown, actorId: string) {
    if (userId === actorId) throw new IdentityAccessError(422, 'self_reset_forbidden', '请通过修改密码验证自己的当前密码')
    const passwordHash = await hashPassword(password)
    await this.database.begin(async transaction => {
      await assertPlatformAdmin(transaction, actorId)
      const [credential] = await transaction`
        update local_user_credentials set password_hash = ${passwordHash}, must_change_password = true, updated_at = now()
         where tenant_id = ${tenantId} and user_id = ${userId}
           and exists (select 1 from users u where u.tenant_id = ${tenantId} and u.id = ${userId} and u.identity_provider = 'local') returning user_id
      `
      if (!credential) throw new IdentityAccessError(404, 'local_account_missing', '该员工尚未开通独立登录')
      await revokeUserSessions(transaction, userId)
      await localAudit(transaction, actorId, 'identity.password.reset', 'success', { userId })
    })
    return { userId }
  }

  async setStatus(userId: string, status: unknown, actorId: string) {
    if (status !== 'active' && status !== 'disabled') throw new IdentityAccessError(422, 'invalid_status', '账号状态无效')
    await this.database.begin(async transaction => {
      await lockPlatformAdminInvariant(transaction)
      await assertPlatformAdmin(transaction, actorId)
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
      if (status === 'disabled') await revokeUserSessions(transaction, userId)
      await localAudit(transaction, actorId, 'identity.local.status', 'success', { userId, status })
    })
    return { userId, status }
  }

  private async rateLimit(request: IncomingMessage, accountKey: string) {
    // Forwarded client IP headers are deliberately not trusted by the application.
    const keys = [{ key: `peer:${request.socket.remoteAddress ?? 'unknown'}`, limit: 100 }, { key: accountKey, limit: 10 }]
    for (const { key, limit } of keys) {
      const keyHash = createHmac('sha256', this.configuration.sessionSecret).update(key).digest('hex')
      const [row] = await this.database<{ attempts: number }[]>`
        insert into local_auth_rate_limits (key_hash, attempts, expires_at)
        values (${keyHash}, 1, now() + interval '15 minutes')
        on conflict (key_hash) do update set
          attempts = case when local_auth_rate_limits.expires_at <= now() then 1 else least(local_auth_rate_limits.attempts + 1, 1000) end,
          expires_at = case when local_auth_rate_limits.expires_at <= now() then now() + interval '15 minutes' else local_auth_rate_limits.expires_at end
        returning attempts
      `
      if (!row || row.attempts > limit) throw new IdentityAccessError(429, 'login_rate_limited', '尝试次数过多，请 15 分钟后重试')
    }
    await this.database`delete from local_auth_rate_limits where expires_at < now() - interval '1 day'`
  }
}

async function insertAccount(transaction: DatabaseTransaction, input: LocalAccountInput, username: string, passwordHash: string, mustChangePassword: boolean) {
  if ('existingUserId' in input) throw new IdentityAccessError(422, 'account_binding_unsupported', '不支持绑定既有账号，请创建独立账号')
  if (await loginAccountExists(transaction, username)) throw new IdentityAccessError(409, 'local_account_exists', '登录账号已存在，请使用其他手机号或邮箱')
  const userId = `user-${randomUUID()}`
  const name = requiredText(input.name, '姓名', 80)
  const department = optionalText(input.department, '部门', 100)
  const email = optionalText(input.email, '邮箱', 254)
  await transaction`
    insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user, email)
    values (${userId}, ${tenantId}, ${`local:${randomUUID()}`}, ${name}, ${department}, 'active', 'local', true, ${email})
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

async function assertPlatformAdmin(transaction: DatabaseTransaction, userId: string) {
  const [actor] = await transaction`
    select u.id from users u join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
    join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
    join tenants t on t.id = u.tenant_id
    where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active' and u.business_user and t.status = 'active'
      and ur.source_key = 'local' and r.status = 'active' and r.permissions ? 'admin:*' and (ur.valid_until is null or ur.valid_until > now())
  `
  if (!actor) throw new IdentityAccessError(403, 'permission_denied', '只有平台管理员可以管理独立账号')
}

async function revokeUserSessions(transaction: DatabaseTransaction, userId: string) {
  await transaction`update authentication_sessions set revoked_at = now() where tenant_id = ${tenantId} and user_id = ${userId} and revoked_at is null`
}

async function localAudit(transaction: DatabaseTransaction, actorId: string, action: string, result: 'success' | 'failed', context: Record<string, string> = {}) {
  await transaction`
    insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
    values (${`audit-${randomUUID()}`}, ${tenantId}, ${actorId === 'anonymous' ? 'system' : 'user'}, ${actorId}, ${action},
      'local_identity', ${context.userId ?? actorId}, ${result}, ${`trace-identity-${randomUUID()}`},
      ${transaction.json({ provider: 'local-password', ...context })})
  `
}

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new IdentityAccessError(422, 'invalid_request', `${label}必须为 1–${max} 个字符`)
  return value.trim()
}

function optionalText(value: unknown, label: string, max: number) {
  return value === null || value === undefined || value === '' ? null : requiredText(value, label, max)
}
