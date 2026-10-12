// P1 fixture: real application and password authentication, disposable database,
// synthetic accounts, no AI Hub, model or DSH process.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createThrowawayDatabase } from '../../server/src/infrastructure/postgres/test-database.ts'
import { loadIdentityConfiguration } from '../../server/src/modules/identity/config.ts'
import { LocalAuthService } from '../../server/src/modules/identity/local-auth-service.ts'
import { IdentityAdministrationService } from '../../server/src/modules/identity/administration-service.ts'
import { IdentitySessionRepository } from '../../server/src/modules/identity/session-repository.ts'

const database = await createThrowawayDatabase({ namePrefix: 'dsh_local_auth_browser' })
const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-local-auth-browser-'))
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  DSH_WORK_AUTH_MODE: 'local',
  DSH_WORK_DATABASE_URL: database.url,
  DSH_WORK_DATA_ROOT: dataRoot,
  DSH_WORK_SERVER_HOST: '127.0.0.1',
  DSH_WORK_SERVER_PORT: process.env.DSH_WORK_LOCAL_AUTH_SERVER_PORT ?? '4690',
  DSH_WORK_WORKBENCH_ORIGINS: `http://localhost:${process.env.DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT ?? '4674'}`,
  DSH_WORK_ADMIN_ORIGINS: `http://localhost:${process.env.DSH_WORK_LOCAL_AUTH_ADMIN_PORT ?? '4680'}`,
  DSH_WORK_SESSION_SECRET: 'local-browser-fixture-secret-not-for-deployment',
  DSH_WORK_COOKIE_SECURE: 'false',
  DSH_RUNTIME_HOME: join(dataRoot, 'runtime-unavailable'),
}
const loginSettingsFixture = process.argv.includes('--login-settings')
if (loginSettingsFixture) Object.assign(environment, {
  AI_HUB_PLATFORM_URL: 'http://localhost:9', AI_HUB_OIDC_ISSUER: 'http://localhost:9/fixture',
  AI_HUB_APPLICATION_ID: 'login-settings-fixture', AI_HUB_CLIENT_ID: 'login-settings-fixture',
  AI_HUB_CLIENT_SECRET: 'login-settings-fixture-only-not-a-real-secret',
  DSH_WORK_ADMIN_PORT: process.env.DSH_WORK_LOCAL_AUTH_ADMIN_PORT ?? '4680',
  DSH_WORK_WORKBENCH_PORT: process.env.DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT ?? '4674',
})
let child: ChildProcess | undefined
let closing = false
async function cleanup(code = 0) {
  if (closing) return
  closing = true
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await new Promise<void>(done => child!.once('exit', () => done()))
  }
  await database.dispose()
  await rm(dataRoot, { recursive: true, force: true })
  process.exit(code)
}
process.once('SIGINT', () => { void cleanup() })
process.once('SIGTERM', () => { void cleanup() })
try {
  const configuration = loadIdentityConfiguration(environment)
  if (configuration.mode !== 'local') throw new Error('Local browser fixture configuration mismatch')
  const authentication = new LocalAuthService(configuration, database.client)
  const admin = await authentication.bootstrap({
    username: 'browser.admin', name: '独立登录验收管理员', password: 'browser-only admin passphrase',
  })
  if (loginSettingsFixture) {
    const directory = new IdentitySessionRepository(database.client)
    const administration = new IdentityAdministrationService(database.client, true)
    const upstream = await directory.synchronizeIdentity({ externalUserId: 'fixture-upstream-admin', subject: 'fixture-upstream-subject', displayName: '配置验收上游管理员', email: null, organizationName: '合成数据', businessUser: true, status: 'ACTIVE' })
    await administration.grantRole({ userId: upstream.userId, roleId: 'role-platform-admin', actorId: admin.userId })
    const reader = await authentication.createAccount({ username: 'browser.reader', name: '配置验收只读管理员', password: 'browser-only reader passphrase' }, admin.userId)
    await administration.grantRole({ userId: reader.userId, roleId: 'role-auditor', actorId: admin.userId })
    await database.client`update local_user_credentials set must_change_password = false where user_id = ${reader.userId}`
  }
  if (!closing) {
    child = spawn(process.execPath, ['--experimental-strip-types', 'server/src/main.ts'], {
      cwd: resolve(import.meta.dirname, '../..'), env: environment, stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('exit', code => { void cleanup(code ?? 1) })
    child.once('error', () => { void cleanup(1) })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local browser fixture startup failed')
  await cleanup(1)
}
