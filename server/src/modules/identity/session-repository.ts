import { randomUUID } from 'node:crypto'

import type { UserProfile, UserRole } from '../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { ApiAudience } from './types.ts'
import { authorizationDenied } from '../authorization/authorization-errors.ts'

const tenantId = 'tenant-dsh-work'

export interface LoginTransactionRecord {
  loginPurpose?: 'login' | 'admin-bootstrap'
  stateHash: string
  codeVerifierEncrypted: string
  nonce: string
  returnTo: string
  portalOrigin: string | null
  redirectUri: string | null
}

export interface AuthenticationSessionRecord {
  sessionHash: string
  audience: ApiAudience
  userId: string
  subject: string
  accessTokenEncrypted: string
  refreshTokenEncrypted: string | null
  tokenExpiresAt: Date
  authorizationVersion: number
  currentAuthorizationVersion: number
  expiresAt: Date
}

export interface ExternalIdentityProfile {
  externalUserId: string
  subject: string
  displayName: string
  email: string | null
  organizationName: string
  businessUser: boolean
  status: string
  tombstone?: boolean
  updatedAt?: string | null
}

export interface LocalAuthorizationContext {
  profile: UserProfile
  roleIds: string[]
  roleCodes: string[]
  permissions: string[]
  dataScopes: string[]
  authorizationVersion: number
}

export interface DirectorySyncState {
  applicationId: string
  environment: string
  cursor: string | null
  status: 'idle' | 'running' | 'failed'
  lastStartedAt: Date | null
  lastSucceededAt: Date | null
  lastError: string | null
  synchronizedUsers: number
  updatedAt: Date
}

export class IdentitySessionRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async createLoginTransaction(input: {
    loginPurpose?: 'login' | 'admin-bootstrap'
    transactionHash: string
    audience: ApiAudience
    stateHash: string
    codeVerifierEncrypted: string
    nonce: string
    returnTo: string
    portalOrigin: string
    redirectUri: string
    expiresAt: Date
  }) {
    await this.database.begin(async (transaction) => {
      await transaction`delete from oidc_login_transactions where expires_at <= now()`
      await transaction`
        insert into oidc_login_transactions (
          transaction_hash, audience, state_hash, code_verifier_encrypted,
          nonce, return_to, portal_origin, redirect_uri, expires_at, login_purpose
        ) values (
          ${input.transactionHash}, ${input.audience}, ${input.stateHash},
          ${input.codeVerifierEncrypted}, ${input.nonce}, ${input.returnTo},
          ${input.portalOrigin}, ${input.redirectUri}, ${input.expiresAt}, ${input.loginPurpose ?? 'login'}
        )
      `
    })
  }

  async consumeLoginTransaction(
    transactionHash: string,
    audience: ApiAudience,
  ): Promise<LoginTransactionRecord | null> {
    return this.database.begin(async (transaction) => {
      const [record] = await transaction<LoginTransactionRecord[]>`
        delete from oidc_login_transactions
         where transaction_hash = ${transactionHash} and audience = ${audience}
           and expires_at > now()
        returning state_hash as "stateHash", code_verifier_encrypted as "codeVerifierEncrypted",
                  nonce, return_to as "returnTo", portal_origin as "portalOrigin",
                  redirect_uri as "redirectUri", login_purpose as "loginPurpose"
      `
      return record ?? null
    })
  }

  async synchronizeIdentity(input: ExternalIdentityProfile) {
    const normalizedStatus = !input.businessUser
      || input.tombstone
      || input.status.toUpperCase() !== 'ACTIVE'
      ? 'disabled'
      : 'active'
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : null
    if (updatedAt && !Number.isFinite(updatedAt.getTime())) {
      throw new Error('AI Hub 员工更新时间无效')
    }
    return this.database.begin(async (transaction) => {
      const identityLocks = [
        `${tenantId}:external-user:${input.externalUserId}`,
        `${tenantId}:subject:${input.subject}`,
      ].sort()
      for (const lock of identityLocks) {
        await transaction`select pg_advisory_xact_lock(hashtext(${lock}))`
      }

      type IdentityMatch = {
        id: string
        identityProvider: 'local' | 'ai-hub'
        externalUserId: string | null
        authorizationVersion: number
      }
      const matches = await transaction<IdentityMatch[]>`
        select id, identity_provider as "identityProvider",
               external_user_id as "externalUserId",
               local_authorization_version::integer as "authorizationVersion"
          from users
         where tenant_id = ${tenantId}
           and (
             (identity_provider = 'ai-hub' and external_user_id = ${input.externalUserId})
             or external_subject = ${input.subject}
           )
         for update
      `
      const externalMatch = matches.find(item => item.externalUserId === input.externalUserId)
      const subjectMatch = matches.find(item => item.id !== externalMatch?.id)
      if (externalMatch && subjectMatch) {
        throw new Error('AI Hub 用户标识与既有 OIDC subject 分别映射到不同本地用户')
      }
      const existing = externalMatch ?? subjectMatch
      if (
        existing?.identityProvider === 'ai-hub'
        && existing.externalUserId !== input.externalUserId
      ) {
        throw new Error('OIDC subject 已绑定到其他 AI Hub 用户标识')
      }

      let applied = false
      let record: { id: string; authorizationVersion: number } | undefined
      if (existing) {
        const [updated] = await transaction<{ id: string; authorizationVersion: number }[]>`
          update users
             set external_subject = ${input.subject},
                 display_name = ${input.displayName},
                 department_id = ${input.organizationName},
                 status = ${normalizedStatus},
                 identity_provider = 'ai-hub',
                 external_user_id = ${input.externalUserId},
                 business_user = ${input.businessUser},
                 email = ${input.email},
                 identity_updated_at = coalesce(${updatedAt}, identity_updated_at),
                 directory_synced_at = coalesce(${updatedAt ? new Date() : null}, directory_synced_at),
                 updated_at = now()
           where tenant_id = ${tenantId} and id = ${existing.id}
             and (
               ${updatedAt}::timestamptz is null
               or identity_updated_at is null
               or ${updatedAt}::timestamptz >= identity_updated_at
             )
          returning id, local_authorization_version::integer as "authorizationVersion"
        `
        applied = Boolean(updated)
        record = updated ?? {
          id: existing.id,
          authorizationVersion: existing.authorizationVersion,
        }
      } else {
        const generatedId = `user-${randomUUID()}`
        const [inserted] = await transaction<{ id: string; authorizationVersion: number }[]>`
          insert into users (
            id, tenant_id, external_subject, display_name, department_id, status,
            identity_provider, external_user_id, business_user, email, identity_updated_at,
            directory_synced_at
          ) values (
            ${generatedId}, ${tenantId}, ${input.subject}, ${input.displayName},
            ${input.organizationName}, ${normalizedStatus}, 'ai-hub', ${input.externalUserId},
            ${input.businessUser}, ${input.email}, ${updatedAt}, ${updatedAt ? new Date() : null}
          )
          returning id, local_authorization_version::integer as "authorizationVersion"
        `
        applied = true
        record = inserted
      }
      if (!record) throw new Error('AI Hub 用户身份同步失败')
      if (applied && normalizedStatus === 'disabled') {
        await transaction`
          update authentication_sessions set revoked_at = now()
           where tenant_id = ${tenantId} and user_id = ${record.id} and revoked_at is null
        `
      }
      return { userId: record.id, authorizationVersion: record.authorizationVersion }
    })
  }

  /** Durable consumption ledger, never inferred from the current number of admins. */
  async hasConsumedAdminBootstrap(applicationId: string, environment: string): Promise<boolean> {
    const [row] = await this.database<{ consumed: boolean }[]>`
      select exists (
        select 1 from application_admin_bootstrap_claims
         where application_id = ${applicationId} and environment = ${environment}
      ) as consumed
    `
    return row?.consumed === true
  }

  async consumeAdminBootstrap(input: {
    applicationId: string
    environment: string
    externalUserId: string
    userId: string
    consumedAt: Date
  }) {
    return this.database.begin(async (transaction) => {
      const [inserted] = await transaction<{ applicationId: string }[]>`
        insert into application_admin_bootstrap_claims (
          application_id, environment, external_user_id, user_id, consumed_at
        ) values (
          ${input.applicationId}, ${input.environment}, ${input.externalUserId},
          ${input.userId}, ${input.consumedAt}
        )
        on conflict (application_id, environment) do nothing
        returning application_id as "applicationId"
      `
      const [claim] = await transaction<{ externalUserId: string; userId: string }[]>`
        select external_user_id as "externalUserId", user_id as "userId"
          from application_admin_bootstrap_claims
         where application_id = ${input.applicationId} and environment = ${input.environment}
         for update
      `
      if (!claim || claim.externalUserId !== input.externalUserId || claim.userId !== input.userId) {
        throw new Error('应用初始管理员已经由其他账号认领')
      }
      if (!inserted) return false
      const [role] = await transaction<{ id: string }[]>`
        select id from roles
         where tenant_id = ${tenantId} and id = 'role-platform-admin' and status = 'active'
      `
      if (!role) throw new Error('本地平台管理员角色不存在或已停用')
      await transaction`
        insert into user_roles (
          tenant_id, user_id, role_id, source_key, granted_by
        ) values (
          ${tenantId}, ${input.userId}, 'role-platform-admin', 'local', ${input.userId}
        )
        on conflict do nothing
      `
      await appendIdentityAudit(transaction, {
        userId: input.userId,
        action: 'identity.admin_bootstrap',
        result: 'success',
        audience: 'admin',
        objectType: 'application_environment',
        objectId: `${input.applicationId}:${input.environment}`,
      })
      return true
    })
  }

  async createSession(input: {
    sessionHash: string
    audience: ApiAudience
    userId: string
    accessTokenEncrypted: string
    refreshTokenEncrypted: string | null
    tokenExpiresAt: Date
    authorizationVersion: number
    expiresAt: Date
  }) {
    await this.database.begin(async (transaction) => {
      await transaction`
        update authentication_sessions set revoked_at = now()
         where tenant_id = ${tenantId} and user_id = ${input.userId}
           and audience = ${input.audience} and revoked_at is null
      `
      await transaction`
        insert into authentication_sessions (
          session_hash, tenant_id, audience, user_id, access_token_encrypted,
          refresh_token_encrypted, token_expires_at, authorization_version,
          permissions, data_scopes, permissions_expires_at, expires_at
        ) values (
          ${input.sessionHash}, ${tenantId}, ${input.audience}, ${input.userId},
          ${input.accessTokenEncrypted}, ${input.refreshTokenEncrypted}, ${input.tokenExpiresAt},
          ${input.authorizationVersion}, '[]'::jsonb, '[]'::jsonb, ${input.expiresAt}, ${input.expiresAt}
        )
      `
      await appendIdentityAudit(transaction, {
        userId: input.userId,
        action: 'identity.login',
        result: 'success',
        audience: input.audience,
      })
    })
  }

  async findSession(sessionHash: string, audience: ApiAudience): Promise<AuthenticationSessionRecord | null> {
    const [record] = await this.database<AuthenticationSessionRecord[]>`
      select s.session_hash as "sessionHash", s.audience, s.user_id as "userId",
             u.external_subject as subject,
             s.access_token_encrypted as "accessTokenEncrypted",
             s.refresh_token_encrypted as "refreshTokenEncrypted",
             s.token_expires_at as "tokenExpiresAt",
             s.authorization_version::integer as "authorizationVersion",
             u.local_authorization_version::integer as "currentAuthorizationVersion",
             s.expires_at as "expiresAt"
        from authentication_sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.user_id
        join tenants t on t.id = u.tenant_id
       where s.session_hash = ${sessionHash} and s.tenant_id = ${tenantId}
         and s.audience = ${audience} and s.revoked_at is null and s.expires_at > now()
         and u.status = 'active' and t.status = 'active'
    `
    return record ?? null
  }

  async refreshTokensWithLock(
    sessionHash: string,
    audience: ApiAudience,
    refresh: (session: AuthenticationSessionRecord) => Promise<{
      accessTokenEncrypted: string
      refreshTokenEncrypted: string | null
      tokenExpiresAt: Date
    } | null>,
  ): Promise<AuthenticationSessionRecord | null> {
    return this.database.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${sessionHash}`}))`
      const [session] = await transaction<AuthenticationSessionRecord[]>`
        select s.session_hash as "sessionHash", s.audience, s.user_id as "userId",
               u.external_subject as subject,
               s.access_token_encrypted as "accessTokenEncrypted",
               s.refresh_token_encrypted as "refreshTokenEncrypted",
               s.token_expires_at as "tokenExpiresAt",
               s.authorization_version::integer as "authorizationVersion",
               u.local_authorization_version::integer as "currentAuthorizationVersion",
               s.expires_at as "expiresAt"
          from authentication_sessions s
          join users u on u.tenant_id = s.tenant_id and u.id = s.user_id
          join tenants t on t.id = u.tenant_id
         where s.session_hash = ${sessionHash} and s.tenant_id = ${tenantId}
           and s.audience = ${audience} and s.revoked_at is null and s.expires_at > now()
           and u.status = 'active' and t.status = 'active'
      `
      if (!session) return null
      const update = await refresh(session)
      if (!update) return session
      await transaction`
        update authentication_sessions
           set access_token_encrypted = ${update.accessTokenEncrypted},
               refresh_token_encrypted = ${update.refreshTokenEncrypted},
               token_expires_at = ${update.tokenExpiresAt}, last_seen_at = now()
         where session_hash = ${sessionHash} and tenant_id = ${tenantId}
           and revoked_at is null and expires_at > now()
      `
      return { ...session, ...update }
    })
  }

  async updateAuthorizationVersion(sessionHash: string, authorizationVersion: number) {
    await this.database`
      update authentication_sessions
         set authorization_version = ${authorizationVersion}, last_seen_at = now()
       where session_hash = ${sessionHash} and tenant_id = ${tenantId}
         and revoked_at is null and expires_at > now()
    `
  }

  async resolveAuthorization(userId: string): Promise<LocalAuthorizationContext> {
    const [user] = await this.database<{
      id: string
      name: string
      department: string
      authorizationVersion: number
      roleIds: string[]
      roleCodes: string[]
      permissions: string[]
      dataScopes: string[]
    }[]>`
      select u.id, u.display_name as name,
             coalesce(u.department_id, '未分配部门') as department,
             u.local_authorization_version::integer as "authorizationVersion",
             coalesce(array_agg(distinct r.id) filter (where r.id is not null), '{}') as "roleIds",
             coalesce(array_agg(distinct r.code) filter (where r.code is not null), '{}') as "roleCodes",
             coalesce(array_agg(distinct permission.value) filter (where permission.value is not null), '{}') as permissions,
             coalesce(array_agg(distinct dsg.scope_value) filter (where dsg.scope_value is not null), '{}') as "dataScopes"
        from users u
        join tenants t on t.id = u.tenant_id and t.status = 'active'
        left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
          and ur.source_key = 'local'
          and (ur.valid_until is null or ur.valid_until > now())
        left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
          and r.status = 'active'
        left join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value) on true
        left join data_scope_grants dsg on dsg.tenant_id = u.tenant_id
          and (
            (dsg.subject_type = 'user' and dsg.subject_id = u.id)
            or (dsg.subject_type = 'role' and dsg.subject_id = r.id)
          )
       where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and u.business_user
       group by u.id
    `
    if (!user) throw authorizationDenied('当前用户不存在、已停用或所属企业不可用')
    const role = primaryRole(user.roleCodes, user.permissions)
    return {
      profile: {
        id: user.id,
        name: user.name,
        title: roleTitle(role),
        department: user.department,
        avatarText: [...user.name][0] ?? '用',
        role,
        dataScopes: unique(user.dataScopes).sort(),
      },
      roleIds: unique(user.roleIds),
      roleCodes: unique(user.roleCodes),
      permissions: unique(user.permissions),
      dataScopes: unique(user.dataScopes).sort(),
      authorizationVersion: user.authorizationVersion,
    }
  }

  async touch(sessionHash: string) {
    await this.database`
      update authentication_sessions set last_seen_at = now()
       where session_hash = ${sessionHash} and tenant_id = ${tenantId}
         and revoked_at is null and expires_at > now()
    `
  }

  async revoke(sessionHash: string) {
    await this.database`
      update authentication_sessions set revoked_at = now()
       where session_hash = ${sessionHash} and tenant_id = ${tenantId} and revoked_at is null
    `
  }

  async logoutSession(sessionHash: string, audience: ApiAudience) {
    return this.database.begin(async (transaction) => {
      const [session] = await transaction<{ userId: string }[]>`
        update authentication_sessions set revoked_at = now()
         where session_hash = ${sessionHash} and tenant_id = ${tenantId}
           and audience = ${audience} and revoked_at is null
        returning user_id as "userId"
      `
      if (!session) return false
      await appendIdentityAudit(transaction, {
        userId: session.userId,
        action: 'identity.logout',
        result: 'success',
        audience,
      })
      return true
    })
  }

  async beginDirectorySync(applicationId: string, environment: string) {
    const runId = `directory-sync-${randomUUID()}`
    const staleBefore = new Date(Date.now() - 15 * 60 * 1000)
    const [state] = await this.database<{ cursor: string | null }[]>`
      insert into identity_directory_sync_state (
        application_id, environment, status, run_id, last_started_at,
        last_error, synchronized_users, updated_at
      ) values (
        ${applicationId}, ${environment}, 'running', ${runId}, now(), null, 0, now()
      )
      on conflict (application_id, environment) do update
        set status = 'running', run_id = ${runId}, last_started_at = now(),
            last_error = null, synchronized_users = 0, updated_at = now()
      where identity_directory_sync_state.status <> 'running'
         or identity_directory_sync_state.last_started_at < ${staleBefore}
      returning cursor
    `
    return state ? { runId, cursor: state.cursor } : null
  }

  async advanceDirectorySync(input: {
    applicationId: string
    environment: string
    runId: string
    cursor: string | null
    synchronizedUsers: number
  }) {
    await this.database`
      update identity_directory_sync_state
         set cursor = ${input.cursor}, synchronized_users = ${input.synchronizedUsers}, updated_at = now()
       where application_id = ${input.applicationId} and environment = ${input.environment}
         and status = 'running' and run_id = ${input.runId}
    `
  }

  async finishDirectorySync(input: {
    applicationId: string
    environment: string
    runId: string
    cursor: string | null
    synchronizedUsers: number
  }) {
    await this.database`
      update identity_directory_sync_state
         set cursor = ${input.cursor}, status = 'idle', run_id = null,
             last_succeeded_at = now(), last_error = null,
             synchronized_users = ${input.synchronizedUsers}, updated_at = now()
       where application_id = ${input.applicationId} and environment = ${input.environment}
         and status = 'running' and run_id = ${input.runId}
    `
  }

  async failDirectorySync(input: {
    applicationId: string
    environment: string
    runId: string
    error: string
  }) {
    await this.database`
      update identity_directory_sync_state
         set status = 'failed', run_id = null, last_error = ${input.error}, updated_at = now()
       where application_id = ${input.applicationId} and environment = ${input.environment}
         and status = 'running' and run_id = ${input.runId}
    `
  }

  async resetDirectoryCursor(applicationId: string, environment: string) {
    await this.database`
      insert into identity_directory_sync_state (application_id, environment, cursor)
      values (${applicationId}, ${environment}, null)
      on conflict (application_id, environment) do update
        set cursor = null, updated_at = now()
      where identity_directory_sync_state.status <> 'running'
    `
  }

  async directorySyncState(applicationId: string, environment: string): Promise<DirectorySyncState> {
    const [state] = await this.database<DirectorySyncState[]>`
      select application_id as "applicationId", environment, cursor, status,
             last_started_at as "lastStartedAt", last_succeeded_at as "lastSucceededAt",
             last_error as "lastError", synchronized_users::integer as "synchronizedUsers",
             updated_at as "updatedAt"
        from identity_directory_sync_state
       where application_id = ${applicationId} and environment = ${environment}
    `
    return state ?? {
      applicationId,
      environment,
      cursor: null,
      status: 'idle',
      lastStartedAt: null,
      lastSucceededAt: null,
      lastError: null,
      synchronizedUsers: 0,
      updatedAt: new Date(0),
    }
  }

  async appendAudit(input: {
    userId: string
    action: string
    result: 'success' | 'failed' | 'blocked'
    audience: ApiAudience | 'system'
    objectType?: string
    objectId?: string
    context?: Record<string, unknown>
  }) {
    await this.database`
      insert into audit_events (
        id, tenant_id, actor_type, actor_id, action, object_type,
        object_id, result, trace_id, safe_context
      ) values (
        ${`audit-${randomUUID()}`}, ${tenantId}, ${input.audience === 'system' ? 'system' : 'user'},
        ${input.userId}, ${input.action}, ${input.objectType ?? 'identity_session'},
        ${input.objectId ?? input.audience}, ${input.result},
        ${`trace-identity-${randomUUID()}`},
        ${this.database.json({
          audience: input.audience,
          provider: 'ai-hub-oidc',
          ...input.context,
        })}
      )
    `
  }
}

async function appendIdentityAudit(
  transaction: DatabaseTransaction,
  input: {
    userId: string
    action: string
    result: 'success' | 'failed' | 'blocked'
    audience: ApiAudience | 'system'
    objectType?: string
    objectId?: string
    context?: Record<string, unknown>
  },
) {
  await transaction`
    insert into audit_events (
      id, tenant_id, actor_type, actor_id, action, object_type,
      object_id, result, trace_id, safe_context
    ) values (
      ${`audit-${randomUUID()}`}, ${tenantId},
      ${input.audience === 'system' ? 'system' : 'user'}, ${input.userId},
      ${input.action}, ${input.objectType ?? 'identity_session'},
      ${input.objectId ?? input.audience}, ${input.result},
      ${`trace-identity-${randomUUID()}`},
      ${transaction.json({
        audience: input.audience,
        provider: 'ai-hub-oidc',
        ...input.context,
      })}
    )
  `
}

function primaryRole(roleCodes: string[], permissions: string[]): UserRole {
  const roles = new Set(roleCodes)
  const granted = new Set(permissions)
  if (roles.has('platform_admin') || granted.has('admin:*')) {
    return 'platform_admin'
  }
  if (roles.has('auditor') && !granted.has('admin:write')) {
    return 'auditor'
  }
  if (granted.has('admin:write') || granted.has('admin:read')) return 'business_admin'
  if (granted.has('audit:read')) return 'auditor'
  if (roles.has('department_manager') || granted.has('workbench:manage')) {
    return 'department_manager'
  }
  return 'employee'
}

function roleTitle(role: UserRole) {
  if (role === 'platform_admin') return 'AI 平台管理员'
  if (role === 'business_admin') return '业务管理员'
  if (role === 'auditor') return '安全审计员'
  if (role === 'department_manager') return '部门负责人'
  return '企业员工'
}

function unique(values: string[]) {
  return [...new Set(values)]
}
