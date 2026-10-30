import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { IdentityAccessError } from './auth-service.ts'
import { loginAccountCandidates } from './login-account.ts'
import { verifyPassword } from './password.ts'

const tenantId = 'tenant-dsh-work'

interface CredentialState {
  userId: string
  passwordHash: string
  identityProvider: string
  active: boolean
}

/** Maps a failed password login to a specific client-facing error (after rate limiting). */
export async function resolveLocalLoginRejection(
  database: DatabaseClient,
  username: string,
  password: unknown,
): Promise<IdentityAccessError> {
  const [credential] = await database<CredentialState[]>`
    select c.user_id as "userId", c.password_hash as "passwordHash", u.identity_provider as "identityProvider",
           (u.status = 'active' and u.business_user and t.status = 'active') as active
      from local_user_credentials c
      join users u on u.tenant_id = c.tenant_id and u.id = c.user_id
      join tenants t on t.id = u.tenant_id
     where c.tenant_id = ${tenantId} and c.username = ${username}
  `
  if (!credential) {
    const candidates = loginAccountCandidates(username)
    const [hub] = await database<{ id: string }[]>`
      select u.id
        from users u
       where u.tenant_id = ${tenantId} and u.identity_provider = 'ai-hub'
         and lower(btrim(u.external_subject)) = any(${candidates}::text[])
       limit 1
    `
    if (hub) {
      return new IdentityAccessError(401, 'login_password_not_configured', '该账号未开通独立密码登录，请联系管理员')
    }
    return new IdentityAccessError(401, 'login_account_not_found', '登录账号不存在')
  }
  if (credential.identityProvider !== 'local') {
    return new IdentityAccessError(401, 'login_password_not_configured', '该账号未开通独立密码登录，请联系管理员')
  }
  if (!credential.active) {
    return new IdentityAccessError(401, 'account_disabled', '账号已停用，请联系管理员')
  }
  const valid = await verifyPassword(password, credential.passwordHash)
  if (!valid) {
    return new IdentityAccessError(401, 'invalid_password', '密码错误')
  }
  return new IdentityAccessError(401, 'invalid_password', '密码错误')
}
