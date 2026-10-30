/**
 * 开发辅助：将已同步的 AI Hub 员工转为独立密码登录（identity_provider=local），并写入统一密码。
 * 生产环境拒绝执行；密码通过环境变量或命令行参数提供，不写入仓库。
 */
import { createDatabase } from '../../infrastructure/postgres/database.ts'
import { runMigrations } from '../../infrastructure/postgres/migration-runner.ts'
import { hashPassword, validatePassword } from './password.ts'
import { normalizeLoginAccount } from './login-account.ts'
import { IdentityAccessError } from './auth-service.ts'

const tenantId = 'tenant-dsh-work'

if (process.env.NODE_ENV === 'production') {
  throw new Error('auth:import-ai-hub-local 仅用于非生产环境')
}
if (!process.env.DSH_WORK_DATABASE_URL) throw new Error('DSH_WORK_DATABASE_URL 未配置')

const password = process.env.DSH_WORK_IMPORT_PASSWORD ?? process.argv[2]
if (!password) {
  throw new Error('请设置 DSH_WORK_IMPORT_PASSWORD 或传入密码参数：pnpm --filter @dsh-work/server auth:import-ai-hub-local -- <password>')
}
validatePassword(password)

const database = createDatabase({ url: process.env.DSH_WORK_DATABASE_URL })
try {
  await runMigrations(database)
  const passwordHash = await hashPassword(password)
  const summary = await database.begin(async transaction => {
    const users = await transaction<{ id: string; externalSubject: string; displayName: string }[]>`
      select id, external_subject as "externalSubject", display_name as "displayName"
        from users
       where tenant_id = ${tenantId} and identity_provider = 'ai-hub' and business_user
       order by external_subject
    `
    let imported = 0
    let skipped = 0
    for (const user of users) {
      const username = resolveUsername(user.externalSubject)
      const [existingUsername] = await transaction<{ userId: string }[]>`
        select user_id as "userId" from local_user_credentials
         where tenant_id = ${tenantId} and username = ${username} and user_id <> ${user.id}
         limit 1
      `
      if (existingUsername) {
        throw new IdentityAccessError(409, 'local_account_exists', `登录账号 ${username} 已被其他用户占用，无法导入 ${user.displayName}`)
      }
      const [upserted] = await transaction<{ userId: string }[]>`
        insert into local_user_credentials (tenant_id, user_id, username, password_hash, must_change_password)
        values (${tenantId}, ${user.id}, ${username}, ${passwordHash}, false)
        on conflict (tenant_id, user_id) do update set
          username = excluded.username,
          password_hash = excluded.password_hash,
          must_change_password = false,
          updated_at = now()
        returning user_id as "userId"
      `
      if (!upserted) {
        skipped++
        continue
      }
      await transaction`
        update users
           set identity_provider = 'local',
               email = coalesce(email, ${username.includes('@') ? username : null}),
               updated_at = now()
         where tenant_id = ${tenantId} and id = ${user.id}
      `
      imported++
      console.log(`已导入：${username}（${user.displayName}）`)
    }
    return { imported, skipped, total: users.length }
  })
  console.log(`完成：共 ${summary.total} 名 AI Hub 员工，新导入或更新 ${summary.imported} 名。`)
} finally {
  await database.end()
}

function resolveUsername(externalSubject: string) {
  const trimmed = externalSubject.trim()
  try {
    return normalizeLoginAccount(trimmed)
  } catch {
    const lowered = trimmed.toLowerCase()
    if (/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(lowered)) return lowered
    throw new Error(`无法将 external_subject 转为登录账号：${externalSubject}`)
  }
}
