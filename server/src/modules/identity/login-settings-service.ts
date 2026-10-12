import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { lockPlatformAdminInvariant } from './administration-service.ts'
import { IdentityAccessError } from './auth-service.ts'
import { loadIdentityConfiguration } from './config.ts'
import type { IdentityConfiguration, RequestIdentity } from './types.ts'

type LoginMode = 'local' | 'oidc'
type Database = DatabaseClient | DatabaseTransaction
const tenantId = 'tenant-dsh-work'
const settingsKey = 'identity.login'

interface SavedSettings {
  mode: LoginMode
  appliedMode: LoginMode
  revision: number
  updatedAt: Date
}

export interface LoginModeOption {
  mode: LoginMode
  available: boolean
  issues: string[]
}

export interface LoginSettings {
  activeMode: IdentityConfiguration['mode']
  savedMode: LoginMode | null
  pendingRestart: boolean
  revision: number
  updatedAt: string | null
  options: LoginModeOption[]
}

export class LoginSettingsService {
  private readonly database: DatabaseClient
  private readonly activeMode: IdentityConfiguration['mode']
  private readonly environment: NodeJS.ProcessEnv

  constructor(
    database: DatabaseClient,
    activeMode: IdentityConfiguration['mode'],
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.database = database
    this.activeMode = activeMode
    this.environment = { ...environment }
  }

  async get(): Promise<LoginSettings> {
    const saved = await readSettings(this.database)
    const options = await Promise.all((['local', 'oidc'] as const).map(mode => modeOption(this.database, this.environment, mode)))
    return {
      activeMode: this.activeMode,
      savedMode: saved?.mode ?? null,
      pendingRestart: Boolean(saved && saved.mode !== this.activeMode),
      revision: saved?.revision ?? 0,
      updatedAt: saved?.updatedAt.toISOString() ?? null,
      options,
    }
  }

  async save(input: { mode?: unknown; expectedRevision?: unknown }, identity: RequestIdentity) {
    if (this.activeMode === 'prototype' || identity.identityProvider === 'prototype-sso') {
      throw new IdentityAccessError(403, 'managed_identity_required', '请使用正式管理员账号配置登录模式')
    }
    if (identity.audience !== 'admin' || !identity.permissions.includes('admin:*')) {
      throw new IdentityAccessError(403, 'permission_denied', '只有平台管理员可以配置登录模式')
    }
    const mode = input.mode
    if (mode !== 'local' && mode !== 'oidc') throw new IdentityAccessError(422, 'invalid_login_mode', '请选择独立账号密码或 AI Hub 统一登录')
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) {
      throw new IdentityAccessError(422, 'invalid_revision', '请刷新登录设置后重新保存')
    }
    await this.database.begin(async transaction => {
      await lockPlatformAdminInvariant(transaction)
      await assertCurrentAdmin(transaction, identity.userId)
      const current = await readSettings(transaction)
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        throw new IdentityAccessError(409, 'login_settings_changed', '登录设置已被修改，请刷新后重新确认')
      }
      const option = await modeOption(transaction, this.environment, mode)
      if (!option.available) throw new IdentityAccessError(409, 'login_mode_unavailable', option.issues.join('；'))
      if (current?.mode === mode) return
      await transaction`
        insert into system_settings (tenant_id, key, value, revision, updated_by)
        values (${tenantId}, ${settingsKey}, ${transaction.json({ mode, appliedMode: this.activeMode })}, 1, ${identity.userId})
        on conflict (tenant_id, key) do update set value = jsonb_set(system_settings.value, '{mode}', excluded.value->'mode'),
          revision = system_settings.revision + 1, updated_by = excluded.updated_by, updated_at = now()
      `
      await settingsAudit(transaction, identity.userId, 'identity.login_mode.save', {
        previousMode: current?.mode ?? this.activeMode, mode, activeMode: this.activeMode,
      })
    })
    return this.get()
  }
}

/** Read-only by default for deployment preflight; activation runs before the HTTP server starts. */
export async function loadStartupIdentityConfiguration(
  database: DatabaseClient | null,
  environment: NodeJS.ProcessEnv = process.env,
  activate = false,
): Promise<IdentityConfiguration> {
  const deploymentMode = environment.DSH_WORK_AUTH_MODE ?? (environment.NODE_ENV === 'production' ? 'oidc' : 'prototype')
  // Explicit development prototypes never consume or mutate real login settings.
  if (!database || deploymentMode === 'prototype') return loadIdentityConfiguration(environment)
  if (deploymentMode !== 'local' && deploymentMode !== 'oidc') return loadIdentityConfiguration(environment)
  const [table] = await database<{ present: boolean }[]>`select to_regclass('public.system_settings') is not null as present`
  if (!table?.present) return loadIdentityConfiguration(environment)
  const resolve = async (connection: Database) => {
    const saved = await readSettings(connection)
    const configuration = loadIdentityConfiguration({ ...environment, DSH_WORK_AUTH_MODE: saved?.mode ?? deploymentMode })
    if (saved) {
      const option = await modeOption(connection, environment, saved.mode)
      if (!option.available) throw new IdentityAccessError(409, 'login_mode_unavailable', option.issues.join('；'))
      if (activate && saved.appliedMode !== saved.mode) {
        await connection`update authentication_sessions set revoked_at = now() where tenant_id = ${tenantId} and revoked_at is null`
        await connection`delete from oidc_login_transactions`
        await connection`update system_settings set value = jsonb_set(value, '{appliedMode}', value->'mode') where tenant_id = ${tenantId} and key = ${settingsKey}`
        await settingsAudit(connection, 'system', 'identity.login_mode.activate', { previousMode: saved.appliedMode, mode: saved.mode })
      }
    }
    return configuration
  }
  if (!activate) return resolve(database)
  return database.begin(async transaction => {
    await lockPlatformAdminInvariant(transaction)
    return resolve(transaction)
  })
}

async function readSettings(database: Database) {
  const [row] = await database<SavedSettings[]>`
    select value->>'mode' as mode, value->>'appliedMode' as "appliedMode", revision, updated_at as "updatedAt"
      from system_settings where tenant_id = ${tenantId} and key = ${settingsKey}
  `
  if (row && (![row.mode, row.appliedMode].every(mode => mode === 'local' || mode === 'oidc') || row.revision < 1)) {
    throw new IdentityAccessError(500, 'login_settings_invalid', '登录设置记录无效，请管理员检查保存的配置')
  }
  return row
}

async function modeOption(database: Database, environment: NodeJS.ProcessEnv, mode: LoginMode): Promise<LoginModeOption> {
  const issues: string[] = []
  try { loadIdentityConfiguration({ ...environment, DSH_WORK_AUTH_MODE: mode }) }
  catch (error) { issues.push(error instanceof Error ? error.message : '登录服务配置不完整') }
  const [admin] = await database<{ available: boolean }[]>`
    select exists (
      select 1 from users u
      join tenants t on t.id = u.tenant_id and t.status = 'active'
      join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.source_key = 'local'
      join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
      where u.tenant_id = ${tenantId} and u.status = 'active' and u.business_user
        and r.id = 'role-platform-admin' and r.status = 'active' and r.permissions ? 'admin:*'
        and ur.valid_until is null
        and (case when ${mode} = 'local' then exists (
          select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id
        ) else u.identity_provider = 'ai-hub' and u.external_user_id is not null end)
    ) as available
  `
  if (!admin?.available) issues.push(mode === 'local'
    ? '至少需要一位已开通独立登录的有效平台管理员，请先完成独立账号初始化或绑定'
    : '至少需要一位已绑定 AI Hub 身份的有效平台管理员，请先完成身份绑定和授权')
  return { mode, available: issues.length === 0, issues }
}

async function assertCurrentAdmin(database: Database, userId: string) {
  const [actor] = await database<{ available: boolean }[]>`
    select exists (
      select 1 from users u join tenants t on t.id = u.tenant_id
      join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
      join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
      where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active' and u.business_user and t.status = 'active'
        and ur.source_key = 'local' and r.status = 'active' and r.permissions ? 'admin:*'
        and (ur.valid_until is null or ur.valid_until > now())
    ) as available
  `
  if (!actor?.available) throw new IdentityAccessError(403, 'permission_denied', '当前账号已无平台管理员权限')
}

async function settingsAudit(database: Database, actorId: string, action: string, context: Record<string, string>) {
  await database`
    insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
    values (${`audit-${randomUUID()}`}, ${tenantId}, ${actorId === 'system' ? 'system' : 'user'}, ${actorId}, ${action},
      'identity_login_settings', ${tenantId}, 'success', ${`trace-identity-${randomUUID()}`}, ${database.json(context)})
  `
}
