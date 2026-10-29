import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { personalWorkbenchFixture, testTenant } from './personal-workbench-test-fixture.ts'

/**
 * 0085 草稿会话回归：前端「建会话（clientIntentId）→ 上传附件 → startRun」的
 * 首次发送里，附件上传必须先于 startRun 发生。此前 storeSessionFile 只接受
 * active 会话，导致新对话带附件全部 403（生产事故：欧红玲 2026-10-29 14:06）。
 * 这里的接口级用例锁定「上传即转正、多人并发上传、他人/归档仍拒绝」。
 */

let f: Awaited<ReturnType<typeof personalWorkbenchFixture>>

before(async () => {
  f = await personalWorkbenchFixture('dsh_work_session_draft_attachment')
})

after(async () => {
  await f?.close()
})

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function fileRequest(name: string, body = 'synthetic attachment'): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) },
    body,
  }
}

async function sessionStatus(sessionId: string) {
  const [row] = await f.db.client<{ status: string }[]>`
    select status from sessions
     where tenant_id = ${testTenant} and id = ${sessionId}
  `
  return row?.status
}

async function sessionFileCount(sessionId: string) {
  const [row] = await f.db.client<{ count: number }[]>`
    select count(*)::integer as count from file_objects
     where tenant_id = ${testTenant} and session_id = ${sessionId}
  `
  return row?.count ?? 0
}

async function createDraft(input: { title: string; workspaceId?: string }) {
  const created = await f.api('/sessions', jsonRequest({
    title: input.title,
    clientIntentId: `intent-draft-attachment-${randomUUID()}`,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  }))
  assert.equal(created.status, 201)
  const sessionId = (created.body.data as { id: string }).id
  assert.equal(await sessionStatus(sessionId), 'draft')
  return sessionId
}

test('新对话首条消息带附件：草稿会话上传即转正', async () => {
  const sessionId = await createDraft({ title: '根据门禁规则排查20261027门禁进出异常' })

  // 前端用 Promise.allSettled 并行上传多个附件：两个都必须成功，且只转正一次。
  const [first, second] = await Promise.all([
    f.api(`/sessions/${sessionId}/files`, fileRequest('门禁进出异常-20261027.txt')),
    f.api(`/sessions/${sessionId}/files`, fileRequest('门禁规则说明.txt')),
  ])
  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.equal(await sessionStatus(sessionId), 'active')
  assert.equal(await sessionFileCount(sessionId), 2)

  // 转正后会话进入历史可见集合（列表按 active 过滤），摘要接口可读。
  const summary = await f.api(`/sessions/${sessionId}/summary`)
  assert.equal(summary.status, 200)
})

test('他人不能向别人的草稿会话上传附件，也不会把会话转正', async () => {
  const sessionId = await createDraft({ title: '他人草稿会话' })
  // 服务层直接以他人身份调用：草稿创建者校验必须先于「不是空间成员」，
  // 且拒绝后会话仍是 draft、没有留下任何附件。
  await assert.rejects(
    f.content.storeSessionFile(sessionId, '越权附件.txt', 'text/plain', Buffer.from('synthetic'), 'U00008'),
    /不存在或不可访问/,
  )
  assert.equal(await sessionStatus(sessionId), 'draft')
  assert.equal(await sessionFileCount(sessionId), 0)
})

test('归档会话仍拒绝上传附件（原 active 校验不回退）', async () => {
  const sessionId = await createDraft({ title: '归档后上传' })
  assert.equal((await f.api(`/sessions/${sessionId}/files`, fileRequest('先上传.txt'))).status, 201)

  const archived = await f.conversations.archiveSession(sessionId, 'U00001')
  assert.equal(archived.archived, true)

  const denied = await f.api(`/sessions/${sessionId}/files`, fileRequest('归档后.txt'))
  assert.equal(denied.status, 403)
  assert.equal(await sessionStatus(sessionId), 'archived')
  assert.equal(await sessionFileCount(sessionId), 1)
})

test('团队空间的草稿会话同样在首条附件上传时转正', async () => {
  const workspaceId = await f.team()
  const sessionId = await createDraft({ title: '团队草稿附件', workspaceId })

  const upload = await f.api(`/sessions/${sessionId}/files`, fileRequest('团队附件.txt'))
  assert.equal(upload.status, 201)
  assert.equal(await sessionStatus(sessionId), 'active')
})
