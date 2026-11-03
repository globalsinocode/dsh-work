import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresAgentService } from '../modules/agent/postgres-agent-service.ts'
import { PostgresConversationTargetService } from '../modules/workbench/application/postgres-conversation-target-service.ts'
import { PostgresDirectConversationService } from '../modules/workbench/application/postgres-direct-conversation-service.ts'
import { bindWebPushDispatch, WebPushDispatchService } from '../modules/workbench/application/web-push-dispatch.ts'
import { WebPushService, type StoredPushSubscription, type WebPushSendResult } from '../modules/workbench/application/web-push-service.ts'
import { WorkspaceNotificationRecipientService } from '../modules/workbench/application/workspace-notification-recipient-service.ts'
import { Router } from './router.ts'
import { registerConversationTargetRoutes } from './workbench/conversation-target-routes.ts'
import { registerDirectConversationRoutes } from './workbench/direct-conversation-routes.ts'

const tenantId = 'tenant-dsh-work'
const employeeA = 'dm-employee-a'
const employeeB = 'dm-employee-b'
const employeeC = 'dm-employee-c'

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let server: ReturnType<typeof createServer>
let baseUrl = ''
let unbindPush: (() => void) | undefined
const sent: Array<{ userEndpoint: string; payload: Record<string, unknown> }> = []

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_direct_conversations_test', maxConnections: 5 })
  database = throwaway.client
  await seedUser(employeeA, '林岚')
  await seedUser(employeeB, '周航')
  await seedUser(employeeC, '陈静')
  const push = new WebPushService(database, {
    vapidPublicKey: 'test-public',
    vapidPrivateKey: 'test-private',
    vapidSubject: 'mailto:direct@example.com',
    send: async (subscription: StoredPushSubscription, payloadJson: string): Promise<WebPushSendResult> => {
      sent.push({ userEndpoint: subscription.endpoint, payload: JSON.parse(payloadJson) as Record<string, unknown> })
      return { statusCode: 201 }
    },
  })
  unbindPush = bindWebPushDispatch(new WebPushDispatchService(database, push, new WorkspaceNotificationRecipientService(database, {} as never, {} as never)))
  await database`
    insert into push_subscriptions (endpoint, tenant_id, user_id, p256dh, auth)
    values ('https://push.example.test/dm-b', ${tenantId}, ${employeeB}, 'key-b', 'auth-b')
  `
  const router = new Router({ authenticateApi: headerAuthenticator })
  registerDirectConversationRoutes(router, new PostgresDirectConversationService(database))
  registerConversationTargetRoutes(router, new PostgresConversationTargetService(database, new PostgresAgentService(database)))
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

after(async () => {
  unbindPush?.()
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway?.dispose()
})

test('第一条消息创建唯一私聊，双方列表可见，且不写入会话或 Run', async () => {
  const beforeCounts = await counts()
  const empty = await get(employeeA, `/direct-conversations/with/${employeeB}`)
  assert.equal(empty.status, 200)
  assert.equal(empty.body.data.conversationId, null)
  assert.equal(empty.body.data.canSend, true)

  sent.length = 0
  const [first, second] = await Promise.all([
    post(employeeA, `/direct-conversations/with/${employeeB}/messages`, { content: '  秘密一句  ' }),
    post(employeeB, `/direct-conversations/with/${employeeA}/messages`, { content: '同时回复' }),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(first.body.data.conversationId, second.body.data.conversationId)
  assert.equal(first.body.data.content, '秘密一句')

  const [conversationCount] = await database<{ total: number }[]>`
    select count(*)::int as total from direct_conversations
  `
  assert.equal(conversationCount?.total, 1)
  const afterCounts = await counts()
  assert.deepEqual(afterCounts, beforeCounts)

  const listed = await get(employeeA, '/me/direct-conversations')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.data.items.length, 1)
  assert.equal(listed.body.data.items[0].type, 'peer')
  assert.equal(listed.body.data.items[0].id, employeeB)
  assert.equal(listed.body.data.items[0].name, '周航')
  assert.equal(listed.body.data.items[0].unreadCount, 1)
  const forB = await get(employeeB, '/me/direct-conversations')
  assert.equal(forB.body.data.items[0].id, employeeA)
  assert.equal(forB.body.data.items[0].unreadCount, 1)

  const targets = await get(employeeA, '/me/conversation-targets')
  assert.ok((targets.body.data.items as Array<{ type: string }>).every(item => item.type === 'agent' || item.type === 'group'))

  await waitForPush()
  assert.equal(sent.length, 1)
  const item = sent[0]!
  assert.equal(item.userEndpoint, 'https://push.example.test/dm-b')
  assert.equal(item.payload.type, 'collab_unread')
  assert.equal(item.payload.targetType, 'peer')
  assert.equal(item.payload.targetId, employeeA)
  assert.equal(item.payload.tag, `collab:peer:${employeeA}`)
  assert.equal(item.payload.url, `/c/chats/peer/${employeeA}`)
  assert.equal(item.payload.sessionId, first.body.data.conversationId)
})

test('已读只进不退，本人消息不计未读；第三人读不到正文', async () => {
  const conversationId = (await get(employeeA, `/direct-conversations/with/${employeeB}`)).body.data.conversationId as string
  const history = await get(employeeA, `/direct-conversations/${conversationId}/messages`)
  assert.equal(history.status, 200)
  assert.ok((history.body.data.items as Array<{ content: string }>).some(item => item.content === '秘密一句'))

  const outsider = await get(employeeC, `/direct-conversations/${conversationId}/messages`)
  assert.equal(outsider.status, 404)
  assert.equal(JSON.stringify(outsider.body).includes('秘密'), false)

  const read = await post(employeeA, `/direct-conversations/with/${employeeB}/read`, {})
  assert.equal(read.status, 200)
  assert.equal(read.body.data.userId, employeeB)
  const again = await post(employeeA, `/direct-conversations/with/${employeeB}/read`, { upTo: '2000-01-01T00:00:00.000Z' })
  assert.equal(again.status, 200)
  assert.ok(again.body.data.lastReadAt >= read.body.data.lastReadAt)
  const afterRead = await get(employeeA, '/me/direct-conversations')
  assert.equal(afterRead.body.data.items[0].unreadCount, 0)

  const missing = await post(employeeA, `/direct-conversations/with/${employeeC}/read`, {})
  assert.equal(missing.status, 404)
  const self = await post(employeeA, `/direct-conversations/with/${employeeA}/messages`, { content: '自己' })
  assert.equal(self.status, 422)
  const blank = await post(employeeA, `/direct-conversations/with/${employeeB}/messages`, { content: '   ' })
  assert.equal(blank.status, 422)
})

test('隐藏只影响自己，对方再发言后历史仍在', async () => {
  const conversationId = (await get(employeeA, `/direct-conversations/with/${employeeB}`)).body.data.conversationId as string
  const hidden = await post(employeeA, `/direct-conversations/${conversationId}/hide`, {})
  assert.equal(hidden.status, 200)
  assert.deepEqual(hidden.body.data, { id: conversationId, hidden: true })
  assert.equal((await get(employeeA, '/me/direct-conversations')).body.data.items.length, 0)
  assert.equal((await get(employeeB, '/me/direct-conversations')).body.data.items.length, 1)

  const reply = await post(employeeB, `/direct-conversations/with/${employeeA}/messages`, { content: '还在' })
  assert.equal(reply.status, 200)
  const restored = await get(employeeA, '/me/direct-conversations')
  assert.equal(restored.body.data.items.length, 1)
  const messages = await get(employeeA, `/direct-conversations/${conversationId}/messages`)
  const contents = (messages.body.data.items as Array<{ content: string }>).map(item => item.content)
  assert.ok(contents.includes('秘密一句'))
  assert.ok(contents.includes('还在'))
  const [hiddenAt] = await database<{ hiddenAt: Date | null }[]>`
    select hidden_at as "hiddenAt" from direct_conversation_participants
     where tenant_id = ${tenantId} and conversation_id = ${conversationId} and user_id = ${employeeA}
  `
  assert.equal(hiddenAt?.hiddenAt, null)
})

test('对方停用后仍可阅读，不能再发送', async () => {
  await database`update users set status = 'disabled' where tenant_id = ${tenantId} and id = ${employeeB}`
  const lookup = await get(employeeA, `/direct-conversations/with/${employeeB}`)
  assert.equal(lookup.status, 200)
  assert.equal(lookup.body.data.canSend, false)
  const denied = await post(employeeA, `/direct-conversations/with/${employeeB}/messages`, { content: '还在吗' })
  assert.equal(denied.status, 422)
  assert.match(denied.body.error.message as string, /停用/)
  const stranger = await get(employeeA, '/direct-conversations/with/does-not-exist')
  assert.equal(stranger.status, 404)
})

async function waitForPush() {
  for (let attempt = 0; attempt < 20 && sent.length < 1; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function counts() {
  const [row] = await database<{ sessions: number; messages: number; runs: number }[]>`
    select (select count(*)::int from sessions) as sessions,
           (select count(*)::int from messages) as messages,
           (select count(*)::int from runs) as runs
  `
  return row
}

async function seedUser(userId: string, name: string) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values (${userId}, ${tenantId}, ${`local:${userId}`}, ${name}, 'active', 'local', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${userId}, 'role-employee', 'local')
  `
}

async function get(userId: string, path: string) {
  const response = await fetch(`${baseUrl}/api/workbench/v1${path}`, { headers: { 'x-test-user-id': userId } })
  return { status: response.status, body: await response.json() }
}

async function post(userId: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/workbench/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user-id': userId },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

function headerAuthenticator(request: IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) return Promise.reject(Object.assign(new Error('请先登录'), { status: 401, code: 'authentication_required' }))
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `local:${userId}`,
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
    identityProvider: 'local-password',
  })
}
