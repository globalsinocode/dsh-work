import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import {
  WebPushService,
  type StoredPushSubscription,
  type WebPushSendResult,
} from '../modules/workbench/application/web-push-service.ts'
import { buildCollabUnreadPayload } from '../modules/workbench/application/web-push-copy.ts'
import { Router } from './router.ts'
import { registerPushRoutes } from './workbench/push-routes.ts'

const employeeA = 'U00001'
const employeeB = 'U00008'
const testPublicKey = 'BEl62iUYgUih04f67QMezhpYgK8v1j2C6b3QMezhpYgK8v1j2C6b3Q'
const testEndpointA = 'https://push.example.test/device-a'
const testEndpointB = 'https://push.example.test/device-b'

const sent: Array<{ subscription: StoredPushSubscription; payloadJson: string }> = []
let failNextWith410 = false

async function testSend(
  subscription: StoredPushSubscription,
  payloadJson: string,
): Promise<WebPushSendResult> {
  sent.push({ subscription, payloadJson })
  if (failNextWith410) {
    failNextWith410 = false
    return { statusCode: 410 }
  }
  return { statusCode: 201 }
}

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let push: WebPushService
let server: ReturnType<typeof createServer>
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_web_push_test', maxConnections: 5 })
  database = throwaway.client
  push = new WebPushService(database, {
    vapidPublicKey: testPublicKey,
    vapidPrivateKey: 'test-private-key',
    vapidSubject: 'mailto:push-test@example.com',
    send: testSend,
  })
  const router = new Router({ authenticateApi: headerAuthenticator })
  registerPushRoutes(router, push)
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

test('未登录读取 push config 返回 401', async () => {
  const result = await call('GET', '/me/push/config', undefined)
  assert.equal(result.status, 401)
})

test('未配置 VAPID 时 push config 返回 503', async () => {
  const router = new Router({ authenticateApi: headerAuthenticator })
  registerPushRoutes(router, new WebPushService(database, {}))
  const localServer = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    localServer.once('error', reject)
    localServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = localServer.address()
  const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
  const result = await call('GET', '/me/push/config', employeeA, undefined, url)
  assert.equal(result.status, 503)
  assert.match(result.body.error.message, /通知服务暂不可用/)
  await new Promise<void>((resolve, reject) => localServer.close(error => error ? reject(error) : resolve()))
})

test('GET push config 返回公钥', async () => {
  const result = await call('GET', '/me/push/config', employeeA)
  assert.equal(result.status, 200)
  assert.equal(result.body.data.vapidPublicKey, testPublicKey)
})

test('PUT 订阅缺字段 422；同 endpoint 幂等更新', async () => {
  const bad = await call('PUT', '/me/push/subscriptions', employeeA, { endpoint: 'https://x.test' })
  assert.equal(bad.status, 422)

  const body = {
    endpoint: testEndpointA,
    keys: { p256dh: 'key-a', auth: 'auth-a' },
  }
  const saved = await call('PUT', '/me/push/subscriptions', employeeA, body)
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.data, { endpoint: testEndpointA, updated: true })

  const again = await call('PUT', '/me/push/subscriptions', employeeA, {
    ...body,
    keys: { p256dh: 'key-a2', auth: 'auth-a2' },
  })
  assert.equal(again.status, 200)
  const [count] = await database<{ total: number }[]>`
    select count(*)::int as total from push_subscriptions where endpoint = ${testEndpointA}
  `
  assert.equal(count?.total, 1)
})

test('DELETE 只删本人订阅', async () => {
  await call('PUT', '/me/push/subscriptions', employeeA, {
    endpoint: testEndpointA,
    keys: { p256dh: 'key-a', auth: 'auth-a' },
  })
  await call('PUT', '/me/push/subscriptions', employeeB, {
    endpoint: testEndpointB,
    keys: { p256dh: 'key-b', auth: 'auth-b' },
  })

  const deleted = await call('DELETE', '/me/push/subscriptions', employeeA, { endpoint: testEndpointA })
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleted.body.data, { endpoint: testEndpointA, deleted: true })

  const [aRows] = await database<{ total: number }[]>`
    select count(*)::int as total from push_subscriptions where user_id = ${employeeA}
  `
  const [bRows] = await database<{ total: number }[]>`
    select count(*)::int as total from push_subscriptions where user_id = ${employeeB}
  `
  assert.equal(aRows?.total, 0)
  assert.equal(bRows?.total, 1)

  const again = await call('DELETE', '/me/push/subscriptions', employeeA, { endpoint: testEndpointA })
  assert.equal(again.status, 200)
})

test('通知偏好缺省与 PATCH', async () => {
  const read = await call('GET', '/me/notification-preferences', employeeB)
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.data, { collabUnread: true, runFinished: true })

  const patched = await call('PATCH', '/me/notification-preferences', employeeB, { collabUnread: false })
  assert.equal(patched.status, 200)
  assert.deepEqual(patched.body.data, { collabUnread: false, runFinished: true })

  const invalid = await call('PATCH', '/me/notification-preferences', employeeB, { collabUnread: 'no' })
  assert.equal(invalid.status, 422)
  const still = await call('GET', '/me/notification-preferences', employeeB)
  assert.equal(still.body.data.collabUnread, false)
})

test('deliver 尊重偏好；410 删除订阅', async () => {
  sent.length = 0
  await call('PUT', '/me/push/subscriptions', employeeA, {
    endpoint: testEndpointA,
    keys: { p256dh: 'key-a', auth: 'auth-a' },
  })
  await call('PUT', '/me/push/subscriptions', employeeA, {
    endpoint: testEndpointB,
    keys: { p256dh: 'key-b', auth: 'auth-b' },
  })

  const payload = buildCollabUnreadPayload({
    eventId: 'evt-deliver-1',
    targetType: 'agent',
    targetId: 'ag_1',
    sessionId: 'sess_1',
    title: '小周',
    previewText: '你好',
    senderName: '林夏',
    role: 'user',
  })

  await push.deliver(employeeA, 'collab_unread', payload)
  assert.equal(sent.length, 2)

  await call('PATCH', '/me/notification-preferences', employeeA, { collabUnread: false })
  sent.length = 0
  await push.deliver(employeeA, 'collab_unread', payload)
  assert.equal(sent.length, 0)

  await call('PATCH', '/me/notification-preferences', employeeA, { collabUnread: true })
  failNextWith410 = true
  sent.length = 0
  await push.deliver(employeeA, 'collab_unread', payload)
  assert.equal(sent.length, 2)
  const [remaining] = await database<{ total: number }[]>`
    select count(*)::int as total from push_subscriptions where user_id = ${employeeA}
  `
  assert.equal(remaining?.total, 1)
})

async function call(
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  userId: string | undefined,
  body?: unknown,
  origin = baseUrl,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}/api/workbench/v1${path}`, {
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
