import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'

const tenant = 'tenant-dsh-work'
let db: ThrowawayDatabase
let conversations: PostgresConversationRepository
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'dsh_review_admin_session' })
  conversations = new PostgresConversationRepository(db.client)
})
after(async () => { await db?.dispose() })
async function adminSession() {
  const id = `admin-session-${randomUUID()}`
  await db.client`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
    values (${id}, ${tenant}, 'U00008', '受众隔离测试', 'active', 'admin', null, null)`
  return id
}
test('admin Session without a workspace remains accessible to its owner', async () => {
  const session = await conversations.requireSession(await adminSession(), 'U00008', 'admin')
  assert.equal(session.workspaceId, null)
  assert.equal(session.agentVersionId, null)
})
test('admin Session cannot be read by a different administrator or workbench audience', async () => {
  const id = await adminSession()
  await assert.rejects(conversations.requireSession(id, 'U00001', 'admin'), /不存在或不可访问/)
  await assert.rejects(conversations.requireSession(id, 'U00008'), /不存在或不可访问/)
})
test('workbench Session cannot be used as an admin Session', async () => {
  const session = await conversations.createSession({ userId: 'U00008', title: '个人工作会话' })
  await assert.rejects(conversations.requireSession(session.id, 'U00008', 'admin'), /不存在或不可访问/)
  assert.equal((await conversations.requireSession(session.id, 'U00008')).workspaceId, 'ws-personal-U00008')
})
test('archived admin Session is inaccessible', async () => {
  const id = await adminSession()
  await db.client`update sessions set status = 'archived' where tenant_id = ${tenant} and id = ${id}`
  await assert.rejects(conversations.requireSession(id, 'U00008', 'admin'), /不存在或不可访问/)
})
test('disabled admin identity cannot resolve an otherwise active admin Session', async () => {
  const id = await adminSession()
  try {
    await db.client`update users set status = 'disabled' where tenant_id = ${tenant} and id = 'U00008'`
    await assert.rejects(conversations.requireSession(id, 'U00008', 'admin'), /不存在或不可访问/)
  } finally { await db.client`update users set status = 'active' where tenant_id = ${tenant} and id = 'U00008'` }
})
test('nonexistent admin Session is denied with the same error', async () => {
  await assert.rejects(conversations.requireSession(randomUUID(), 'U00008', 'admin'), /不存在或不可访问/)
})
