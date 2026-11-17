import assert from 'node:assert/strict'
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

// 迁移 0129：先迁到 0128，再分别验证“没有 AI Hub 用户”与“仍有 AI Hub 用户”两种库。
const migrations = resolve(import.meta.dirname, '../../../migrations')
const tenantId = 'tenant-dsh-work'
const opened: ThrowawayDatabase[] = []
const directories: string[] = []
after(async () => {
  await Promise.all(opened.map(database => database.dispose()))
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
})

async function databaseBefore0129() {
  const baseline = await mkdtemp(join(tmpdir(), 'dsh-0129-baseline-'))
  directories.push(baseline)
  for (const file of await readdir(migrations)) {
    if (file.endsWith('.sql') && file < '0129') await cp(join(migrations, file), join(baseline, file))
  }
  const database = await createThrowawayDatabase({ namePrefix: 'dsh_0129', migrationsDirectory: baseline })
  opened.push(database)
  return database
}

test('0129 removes AI Hub sessions, tables and columns and allows only local accounts', async () => {
  const database = await databaseBefore0129()
  const sql = database.client
  await sql`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, access_token_encrypted, token_expires_at,
      authorization_version, permissions, data_scopes, permissions_expires_at, expires_at)
    values ('legacy-oidc-session', ${tenantId}, 'workbench', 'U00001', 'sealed', now() + interval '1 hour',
      1, '[]'::jsonb, '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour')
  `
  // 生产形态的数据：密码会话与带绑定的钉钉会话，迁移后必须原样保留。
  await sql`
    insert into external_account_bindings (id, tenant_id, channel, user_id, external_user_id, bound_by, status)
    values ('binding-before-0129', ${tenantId}, 'dingtalk', 'U00001', 'ding-before-0129', 'self', 'valid')
  `
  await sql`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider, binding_id,
      authorization_version, permissions, data_scopes, permissions_expires_at, expires_at)
    values
      ('password-before-0129', ${tenantId}, 'workbench', 'U00001', 'local-password', null,
        1, '[]'::jsonb, '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour'),
      ('dingtalk-before-0129', ${tenantId}, 'workbench', 'U00001', 'dingtalk', 'binding-before-0129',
        1, '[]'::jsonb, '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour')
  `
  const userChecks = async () => (await sql<{ name: string; definition: string }[]>`
    select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
     where conrelid = 'users'::regclass and contype = 'c' order by conname
  `).map(row => `${row.name}: ${row.definition}`)
  const checksBefore = await userChecks()
  await runMigrations(sql, migrations)

  // 只替换 identity_provider 的检查，users 上其他 CHECK 约束原样保留。
  assert.deepEqual(
    (await userChecks()).filter(check => !check.startsWith('users_identity_provider_check:')),
    checksBefore.filter(check => !check.includes('identity_provider')),
  )
  assert.equal(checksBefore.filter(check => check.includes('identity_provider')).length, 1)

  const [{ count }] = await sql<{ count: number }[]>`select count(*)::integer as count from authentication_sessions where session_hash = 'legacy-oidc-session'`
  assert.equal(count, 0, '残留的 AI Hub 会话被删除')
  const kept = await sql<{ hash: string; provider: string; binding: string | null }[]>`
    select session_hash as hash, authentication_provider as provider, binding_id as binding from authentication_sessions
     where session_hash in ('password-before-0129', 'dingtalk-before-0129') order by session_hash
  `
  assert.deepEqual(kept.map(row => [row.hash, row.provider, row.binding]), [
    ['dingtalk-before-0129', 'dingtalk', 'binding-before-0129'],
    ['password-before-0129', 'local-password', null],
  ], '密码会话与钉钉会话迁移后原样保留')
  const tables = await sql<{ name: string }[]>`
    select table_name as name from information_schema.tables
     where table_schema = 'public' and table_name in ('oidc_login_transactions', 'application_admin_bootstrap_claims', 'identity_directory_sync_state')
  `
  assert.deepEqual(tables.map(row => row.name), [])
  const columns = await sql<{ name: string }[]>`
    select table_name || '.' || column_name as name from information_schema.columns
     where table_schema = 'public' and (
       (table_name = 'authentication_sessions' and column_name in ('access_token_encrypted', 'refresh_token_encrypted', 'token_expires_at'))
       or (table_name = 'users' and column_name in ('external_user_id', 'identity_updated_at', 'directory_synced_at'))
     )
  `
  assert.deepEqual(columns.map(row => row.name), [])

  await assert.rejects(sql`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values ('ai-hub-after-0129', ${tenantId}, 'ai-hub-after-0129', 'AI Hub', 'active', 'ai-hub', true)
  `, /users_identity_provider_check/)
  await assert.rejects(sql`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider,
      authorization_version, permissions, data_scopes, permissions_expires_at, expires_at)
    values ('oidc-after-0129', ${tenantId}, 'workbench', 'U00001', 'ai-hub-oidc',
      1, '[]'::jsonb, '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour')
  `, /authentication_sessions_provider_check|authentication_session_credentials/)
  await assert.rejects(sql`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider,
      authorization_version, permissions, data_scopes, permissions_expires_at, expires_at)
    values ('provider-required', ${tenantId}, 'workbench', 'U00001', default,
      1, '[]'::jsonb, '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour')
  `, /null value|not-null/, '会话来源不再有默认值，必须由代码写明')
  await sql`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider,
      authorization_version, permissions, data_scopes, permissions_expires_at, expires_at)
    values ('password-after-0129', ${tenantId}, 'workbench', 'U00001', 'local-password',
      1, '[]'::jsonb, '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour')
  `
  await sql`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider, binding_id,
      authorization_version, permissions, data_scopes, permissions_expires_at, expires_at)
    values ('dingtalk-after-0129', ${tenantId}, 'workbench', 'U00001', 'dingtalk', 'binding-before-0129',
      1, '[]'::jsonb, '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour')
  `
  await assert.rejects(sql`
    insert into authentication_sessions (session_hash, tenant_id, audience, user_id, authentication_provider, binding_id,
      authorization_version, permissions, data_scopes, permissions_expires_at, expires_at)
    values ('dingtalk-without-binding', ${tenantId}, 'workbench', 'U00001', 'dingtalk', null,
      1, '[]'::jsonb, '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour')
  `, /authentication_session_credentials/, '钉钉会话仍必须带绑定')
  const [index] = await sql<{ definition: string }[]>`select indexdef as definition from pg_indexes where indexname = 'users_business_directory'`
  assert.match(index!.definition, /WHERE business_user/)
  assert.doesNotMatch(index!.definition, /ai-hub/)
})

test('0129 refuses to run while AI Hub users remain and changes nothing', async () => {
  const database = await databaseBefore0129()
  const sql = database.client
  await sql`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values ('legacy-ai-hub-user', ${tenantId}, 'legacy-ai-hub-subject', '老 AI Hub 员工', 'disabled', 'ai-hub', false)
  `
  await assert.rejects(runMigrations(sql, migrations), /仍有 1 个 AI Hub 用户/)
  const [applied] = await sql<{ count: number }[]>`select count(*)::integer as count from schema_migrations where version like '0129%'`
  assert.equal(applied!.count, 0)
  const [table] = await sql<{ name: string | null }[]>`select to_regclass('public.identity_directory_sync_state')::text as name`
  assert.equal(table!.name, 'identity_directory_sync_state', '迁移整体回滚，表仍在')
})
