import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, after, test } from 'node:test'
import { personalWorkbenchFixture, testTenant } from './personal-workbench-test-fixture.ts'
import { IdentitySessionRepository } from '../../modules/identity/session-repository.ts'
let f: Awaited<ReturnType<typeof personalWorkbenchFixture>>
before(async () => { f=await personalWorkbenchFixture('dsh_b5_lifecycle') })
after(async () => { await f?.close() })
test('B5 RED: lifecycle policy distinguishes history removal, file removal and no physical purge',async()=>{
  const result=await f.api('/content-policy')
  assert.equal(result.status,200)
  assert.equal(result.body.data.physicalDeletion,false)
  assert.equal(result.body.data.retentionDays,null)
  assert.equal(result.body.data.accountDeactivation,'revoke-access-retain-content-no-transfer')
})
test('history removal is idempotent and retains separately managed files with honest source state',async()=>{
  const s=await f.conversations.createSession({userId:'U00001',title:'B5 life'})
  const file=await f.content.storeSessionFile(s.id,'B5-life.txt','text/plain',Buffer.from('retained bytes'),'U00001')
  const runId=await f.run(s.id)
  await f.db.client`insert into messages(id,tenant_id,session_id,run_id,role,content) values(${randomUUID()},${testTenant},${s.id},${runId},'user','retained message')`
  for(let i=0;i<2;i++){
    const result=await f.api(`/sessions/${s.id}`,{method:'DELETE'})
    assert.equal(result.status,200)
    assert.equal(result.body.data.removedFromHistory,true);assert.equal(result.body.data.physicalDeletion,false)
  }
  assert.equal((await f.api(`/sessions/${s.id}`)).status,403)
  const metadata=await f.api(`/files/${file.id}`)
  assert.equal(metadata.body.data.sourceSessionState,'removed')
  assert.equal((await fetch(`${f.origin}/files/${file.id}/download`)).status,200)
  const [count]=await f.db.client`select (select count(*)::int from runs where session_id=${s.id}) as runs,
    (select count(*)::int from messages where session_id=${s.id}) as messages,
    (select count(*)::int from file_objects where session_id=${s.id}) as files`
  assert.deepEqual(count,{runs:1,messages:1,files:1})
})
test('removed team membership cannot be bypassed by archiving an owned team Session',async()=>{
  const team=await f.team(),s=await f.conversations.createSession({userId:'U00001',workspaceId:team,title:'B5 team'})
  await f.db.client`delete from workspace_members where workspace_id=${team} and user_id='U00001'`
  assert.equal((await f.api(`/sessions/${s.id}`,{method:'DELETE'})).status,403)
  const [row]=await f.db.client`select status from sessions where id=${s.id}`;assert.equal(row.status,'active')
})
test('concurrent start/remove serialize without resurrecting a removed Session or deadlocking',async()=>{
  const s=await f.conversations.createSession({userId:'U00001',title:'B5 race'})
  const outcomes=await Promise.allSettled([
    f.conversations.archiveSession(s.id,'U00001'),
    f.runs.createRun({tenantId:testTenant,sessionId:s.id,requestedBy:'U00001',idempotencyKey:randomUUID()}),
  ])
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
  const [row]=await f.db.client`select s.status, (select count(*)::int from runs where session_id=s.id) as runs from sessions s where id=${s.id}`
  assert.ok((row.status==='archived' && row.runs===0)||(row.status==='active'&&row.runs===1))
})
test('directory deactivation revokes auth Sessions and preserves personal content/ownership',async()=>{
  const identities=new IdentitySessionRepository(f.db.client)
  const external={externalUserId:'b5-'+randomUUID(),subject:'b5-subject-'+randomUUID(),displayName:'合成员工',email:'fixture@example.invalid',organizationName:'合成部门',businessUser:true,status:'ACTIVE'}
  const user=await identities.synchronizeIdentity(external)
  await f.db.client`insert into user_roles(tenant_id,user_id,role_id,source_key,granted_by) values(${testTenant},${user.userId},'role-employee','local','U00008')`
  const s=await f.conversations.createSession({userId:user.userId,title:'B5 员工内容'})
  const file=await f.content.storeSessionFile(s.id,'B5-owned.txt','text/plain',Buffer.from('employee fixture'),user.userId)
  await identities.createSession({sessionHash:'b5-session',audience:'workbench',userId:user.userId,
    accessTokenEncrypted:'fixture-only',refreshTokenEncrypted:null,tokenExpiresAt:new Date(Date.now()+60000),authorizationVersion:1,expiresAt:new Date(Date.now()+60000)})
  await identities.synchronizeIdentity({...external,status:'DISABLED'})
  assert.equal(await identities.findSession('b5-session','workbench'),null)
  assert.equal((await f.api('/files',{headers:{'x-test-user-id':user.userId}})).status,403)
  const [ownership]=await f.db.client`select w.created_by,f.uploaded_by from workspaces w join file_objects f on f.workspace_id=w.id where f.id=${file.id}`
  assert.equal(ownership.created_by,user.userId);assert.equal(ownership.uploaded_by,user.userId)
})

test('conversation removal works with a one-connection pool (no out-of-transaction query borrowing)', async () => {
  const { createDatabase } = await import('./database.ts')
  const { PostgresConversationRepository } = await import('../../modules/workbench/application/postgres-conversation-repository.ts')
  const { setTimeout: delay } = await import('node:timers/promises')
  const single = createDatabase({ url: f.db.url, maxConnections: 1 })
  try {
    const repository = new PostgresConversationRepository(single)
    const session = await repository.createSession({ userId: 'U00001', title: 'B5 single connection' })
    const removed = await Promise.race([
      repository.archiveSession(session.id, 'U00001'),
      delay(1500).then(() => { throw new Error('archiveSession borrowed a second connection while holding its transaction') }),
    ])
    assert.equal(removed.archived, true)
  } finally { await single.end({ timeout: 0 }) }
})
