import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { personalWorkbenchFixture, testTenant } from './personal-workbench-test-fixture.ts'

// EX-STATE-01（e2e/catalog/workbench.md）：个人多轮详情带回各轮执行状态，停止或失败、
// 没有回复的历史轮次才能在其问题下标出结果，不随新一轮消失。
let f: Awaited<ReturnType<typeof personalWorkbenchFixture>>
before(async () => { f = await personalWorkbenchFixture('dsh_conv_states') })
after(async () => { await f?.close() })

async function message(sessionId: string, runId: string, role: 'user' | 'assistant', content: string, at: string) {
  await f.db.client`insert into messages (id, tenant_id, session_id, run_id, role, content, created_at)
    values (${randomUUID()}, ${testTenant}, ${sessionId}, ${runId}, ${role}, ${content}, ${at})`
}

test('personal run detail lists each round with its status and who stopped it', async () => {
  const session = await f.conversations.createSession({ userId: 'U00001', title: '多轮状态' })
  const answered = await f.run(session.id, 'succeeded')
  const stopped = await f.run(session.id, 'cancelled')
  const failed = await f.run(session.id, 'failed')
  await f.db.client`update runs set cancel_requested_by = 'U00001' where id = ${stopped}`
  await f.db.client`update runs set created_at = ${'2026-11-01T01:00:00.000Z'} where id = ${answered}`
  await f.db.client`update runs set created_at = ${'2026-11-01T02:00:00.000Z'} where id = ${stopped}`
  await f.db.client`update runs set created_at = ${'2026-11-01T03:00:00.000Z'} where id = ${failed}`
  await message(session.id, answered, 'user', '第一轮', '2026-11-01T01:00:00.000Z')
  await message(session.id, answered, 'assistant', '第一轮回复', '2026-11-01T01:00:05.000Z')
  await message(session.id, stopped, 'user', '第二轮（停止）', '2026-11-01T02:00:00.000Z')
  await message(session.id, failed, 'user', '第三轮（失败）', '2026-11-01T03:00:00.000Z')
  const [stopper] = await f.db.client<{ name: string }[]>`select display_name as name from users where tenant_id = ${testTenant} and id = 'U00001'`

  const response = await f.api(`/runs/${failed}`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.data.threadRuns, [
    { runId: answered, status: 'succeeded', stoppedBy: null },
    { runId: stopped, status: 'cancelled', stoppedBy: stopper!.name },
    { runId: failed, status: 'failed', stoppedBy: null },
  ])
})

test('a single-round personal conversation omits threadRuns', async () => {
  const session = await f.conversations.createSession({ userId: 'U00001', title: '单轮' })
  const runId = await f.run(session.id, 'succeeded')
  await message(session.id, runId, 'user', '只有一轮', '2026-11-01T04:00:00.000Z')
  const response = await f.api(`/runs/${runId}`)
  assert.equal(response.status, 200)
  assert.equal('threadRuns' in response.body.data, false)
})
