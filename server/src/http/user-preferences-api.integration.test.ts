import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresUserPreferenceService } from '../modules/workbench/application/postgres-user-preference-service.ts'
import { Router } from './router.ts'
import { registerUserPreferenceRoutes } from './workbench/preference-routes.ts'

// MODE-API-01（e2e/TEST-CATALOG.md）：员工端界面模式按账号保存在服务端，缺省为工作模式。
// U00001 与 U00008 来自种子迁移，分别代表员工 A 与员工 B。

const employeeA = 'U00001'
const employeeB = 'U00008'

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let server: ReturnType<typeof createServer>
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_user_preferences_test', maxConnections: 5 })
  database = throwaway.client
  const router = new Router({ authenticateApi: headerAuthenticator })
  registerUserPreferenceRoutes(router, new PostgresUserPreferenceService(database))
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
})

test('迁移 0094：user_preferences 只允许 work / collab，缺省 work', async () => {
  const columns = await database<{ name: string; defaultValue: string | null }[]>`
    select column_name as name, column_default as "defaultValue"
      from information_schema.columns
     where table_schema = 'public' and table_name = 'user_preferences'
     order by ordinal_position
  `
  assert.deepEqual(columns.map(column => column.name), ['tenant_id', 'user_id', 'ui_mode', 'updated_at'])
  assert.match(columns.find(column => column.name === 'ui_mode')?.defaultValue ?? '', /'work'/)
  await assert.rejects(
    database`insert into user_preferences (tenant_id, user_id, ui_mode) values ('tenant-dsh-work', ${employeeA}, 'dark')`,
    /user_preferences_ui_mode_check/,
  )
})

test('从未保存过偏好的员工读取到缺省的工作模式', async () => {
  const result = await call('GET', employeeB)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.data, { uiMode: 'work', updatedAt: null })
  assert.equal(result.body.meta.adapter, 'postgres')
})

test('保存协作模式后再读取一致，重复保存同值幂等', async () => {
  const saved = await call('PUT', employeeA, { uiMode: 'collab' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.data.uiMode, 'collab')
  assert.ok(!Number.isNaN(Date.parse(saved.body.data.updatedAt)))

  const read = await call('GET', employeeA)
  assert.deepEqual(read.body.data, saved.body.data)

  const again = await call('PUT', employeeA, { uiMode: 'collab' })
  assert.equal(again.status, 200)
  assert.equal(again.body.data.uiMode, 'collab')
  const [count] = await database<{ total: number }[]>`
    select count(*)::int as total from user_preferences where user_id = ${employeeA}
  `
  assert.equal(count?.total, 1)

  const back = await call('PUT', employeeA, { uiMode: 'work' })
  assert.equal(back.body.data.uiMode, 'work')
  await call('PUT', employeeA, { uiMode: 'collab' })
})

test('非法请求体返回 422，原偏好不变', async () => {
  await call('PUT', employeeA, { uiMode: 'collab' })
  for (const body of [{}, { uiMode: 'dark' }, { uiMode: 1 }, { uiMode: 'work', theme: 'dark' }, ['work'], 'work']) {
    const result = await call('PUT', employeeA, body)
    assert.equal(result.status, 422, JSON.stringify(body))
    assert.equal(result.body.error.code, 'invalid_request', JSON.stringify(body))
  }
  const read = await call('GET', employeeA)
  assert.equal(read.body.data.uiMode, 'collab')
})

test('偏好按账号隔离；未登录请求被拒绝', async () => {
  await call('PUT', employeeA, { uiMode: 'collab' })
  const other = await call('GET', employeeB)
  assert.equal(other.body.data.uiMode, 'work')

  const anonymous = await call('GET', undefined)
  assert.equal(anonymous.status, 401)
  const anonymousWrite = await call('PUT', undefined, { uiMode: 'collab' })
  assert.equal(anonymousWrite.status, 401)
  assert.equal((await call('GET', employeeB)).body.data.uiMode, 'work')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function call(method: 'GET' | 'PUT', userId: string | undefined, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/workbench/v1/me/preferences`, {
    method,
    headers: {
      ...(userId ? { 'x-test-user-id': userId } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

function headerAuthenticator(request: IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    return Promise.reject(error)
  }
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId,
      name: userId,
      title: '员工',
      department: '测试部门',
      avatarText: '测',
      role: 'employee',
      dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}
