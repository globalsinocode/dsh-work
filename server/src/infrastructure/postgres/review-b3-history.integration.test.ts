import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { personalWorkbenchFixture, testTenant } from './personal-workbench-test-fixture.ts'
let f: Awaited<ReturnType<typeof personalWorkbenchFixture>>
before(async () => { f = await personalWorkbenchFixture('dsh_b3_history') })
after(async () => { await f?.close() })

test('B3 RED: personal history pages Sessions rather than the latest 50 Runs', async () => {
  const prefix = 'B3分页'
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const s = await f.conversations.createSession({ userId: 'U00001', title: `${prefix}${i}` })
    ids.push(s.id)
    await f.db.client`update sessions set last_active_at = ${`2026-09-0${i+1}T00:00:00.000Z`} where id = ${s.id}`
  }
  for (let i = 0; i < 65; i++) await f.run(ids[4]!)
  let cursor: string | null = null
  const seen: Array<{ sessionId: string; runCount: number; latestRun: unknown }> = []
  do {
    const res = await f.api(`/sessions?query=${encodeURIComponent(prefix)}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    assert.equal(res.status, 200)
    seen.push(...res.body.data.items)
    cursor = res.body.data.nextCursor
  } while(cursor)
  assert.deepEqual(seen.map(s => s.sessionId), [...ids].reverse())
  assert.equal(seen[0]!.runCount, 65)
  assert.equal(seen[4]!.latestRun, null, 'zero-Run Sessions are discoverable')
  assert.equal('messages' in seen[0]!, false)
})

test('current membership is filtered before paging, including archived read access', async () => {
  const teamId = await f.team()
  const p = await f.conversations.createSession({ userId: 'U00001', title: 'B3边界个人' })
  const t = await f.conversations.createSession({ userId: 'U00001', title: 'B3边界团队', workspaceId: teamId })
  await f.conversations.createSession({ userId: 'U00008', title: 'B3边界他人' })
  await f.db.client`update workspaces set status = 'archived', archived_at = now() where id = ${teamId}`
  const all = await f.api(`/sessions?scope=all&query=${encodeURIComponent('B3边界')}`)
  assert.equal(all.status, 200)
  assert.deepEqual(new Set(all.body.data.items.map((s: {sessionId:string}) => s.sessionId)), new Set([p.id,t.id]))
  const team = all.body.data.items.find((s:{sessionId:string}) => s.sessionId === t.id)
  assert.equal(team.workspaceType, 'team'); assert.equal(team.canContinue, false)
  await f.db.client`delete from workspace_members where workspace_id = ${teamId} and user_id = 'U00001'`
  const removed = await f.api(`/sessions?scope=all&query=${encodeURIComponent('B3边界')}&limit=1`)
  assert.equal(removed.status, 200)
  assert.equal(removed.body.data.items[0].sessionId, p.id)
  assert.equal(removed.body.data.nextCursor, null, 'no invisible rows after the cursor')
  assert.equal((await f.api(`/sessions/${t.id}`)).status, 403)
})

test('stable Session detail resolves old Run links and empty Sessions without changing workspace', async () => {
  const s = await f.conversations.createSession({ userId: 'U00001', title: 'B3 detail' })
  let response = await f.api(`/sessions/${s.id}`)
  assert.equal(response.status, 200); assert.equal(response.body.data.latestRun, null)
  assert.equal(response.body.data.workspaceId, s.workspaceId)
  const runId = await f.run(s.id)
  response = await f.api(`/sessions/${s.id}`)
  assert.equal(response.body.data.latestRun.id, runId)
  assert.equal((await f.api(`/runs/${runId}`)).status, 200)
  assert.equal((await f.api(`/sessions/${s.id}`, { headers: { 'x-test-user-id': 'U00008' } })).status, 403)
})

test('admin, removed conversations and inactive users never leak into history', async () => {
  const s = await f.conversations.createSession({ userId: 'U00001', title: 'B3已移除' })
  await f.db.client`update sessions set status = 'archived' where id = ${s.id}`
  await f.db.client`insert into sessions (id, tenant_id, created_by, title, audience, status, workspace_id, agent_version_id)
    values ('b3-admin', ${testTenant}, 'U00001', 'B3admin', 'admin', 'active', null, null)`
  assert.equal((await f.api(`/sessions/${s.id}`)).status, 403)
  assert.equal((await f.api('/sessions/b3-admin')).status, 403)
  const result = await f.api(`/sessions?scope=all&query=B3admin`)
  assert.equal(result.status, 200); assert.equal(result.body.data.items.length, 0)
  await f.db.client`update users set status = 'disabled' where id = 'U00001'`
  try { assert.equal((await f.api('/sessions')).status, 403) }
  finally { await f.db.client`update users set status = 'active' where id = 'U00001'` }
})

test('invalid scope, page size and timestamp cursor are typed validation errors', async () => {
  for (const path of ['/sessions?scope=unknown', '/sessions?limit=0', '/sessions?limit=1.5', '/sessions?cursor=bad',
    '/sessions?cursor='+Buffer.from(JSON.stringify({at:'not-a-date',id:'x'})).toString('base64url')]) {
    const res = await f.api(path); assert.equal(res.status, 422, path)
  }
})

test('Session cursor retains PostgreSQL microseconds at one-millisecond page boundaries', async () => {
  const ids: string[] = []
  for (const microsecond of ['123100', '123500', '123900']) {
    const s = await f.conversations.createSession({ userId: 'U00001', title: 'B3微秒' + microsecond })
    ids.push(s.id)
    await f.db.client`update sessions set last_active_at = ${`2026-09-18T10:00:00.${microsecond}Z`}::text::timestamptz where id = ${s.id}`
  }
  const seen: string[] = []
  let cursor: string | null = null
  do {
    const page = await f.api(`/sessions?query=${encodeURIComponent('B3微秒')}&limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`)
    assert.equal(page.status, 200)
    seen.push(...page.body.data.items.map((row: {sessionId: string}) => row.sessionId))
    cursor = page.body.data.nextCursor
  } while(cursor)
  assert.deepEqual(seen, ids.reverse())
})
