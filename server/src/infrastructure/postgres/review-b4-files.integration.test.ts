import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { personalWorkbenchFixture, testTenant } from './personal-workbench-test-fixture.ts'
let f: Awaited<ReturnType<typeof personalWorkbenchFixture>>
before(async () => { f = await personalWorkbenchFixture('dsh_b4_files') })
after(async () => { await f?.close() })
async function upload(name: string) {
  return f.api('/files', { method:'POST', headers:{'content-type':'text/plain','x-file-name':encodeURIComponent(name)},body:'synthetic personal material' })
}
test('B4 RED: materials, attachments and artifacts form one deduplicated personal query', async () => {
  const material = await upload('B4-资料.txt'); assert.equal(material.status,201)
  const s = await f.conversations.createSession({userId:'U00001',title:'B4来源'})
  const attachment = await f.content.storeSessionFile(s.id,'B4-附件.txt','text/plain',Buffer.from('attachment fixture'),'U00001')
  // Synthetic artifact relation; no claim that a real DSH produced it.
  const output = await f.content.storeSessionFile(s.id,'B4-成果.txt','text/plain',Buffer.from('artifact fixture'),'U00001')
  const runId = await f.run(s.id), artifactId='artifact-'+randomUUID()
  await f.db.client`insert into artifacts(id,tenant_id,workspace_id,session_id,name,artifact_type,created_by)
    values(${artifactId},${testTenant},${s.workspaceId},${s.id},'B4-成果.txt','text','U00001')`
  await f.db.client`insert into artifact_versions(id,tenant_id,artifact_id,version_no,file_object_id,source_run_id)
    values(${randomUUID()},${testTenant},${artifactId},1,${output.id},${runId})`
  const page = await f.api('/files?query=B4-')
  assert.equal(page.status,200)
  assert.equal(page.body.data.items.length,3)
  const kinds = new Map(page.body.data.items.map((x:{id:string;source:string})=>[x.id,x.source]))
  assert.equal(kinds.get(material.body.data.id),'material');assert.equal(kinds.get(attachment.id),'attachment');assert.equal(kinds.get(output.id),'artifact')
  const only = await f.api('/files?source=artifact&query=B4-')
  assert.deepEqual(only.body.data.items.map((x:{id:string})=>x.id),[output.id])
})
test('name filtering is literal and keyset paging retains every visible object', async()=>{
  for(let i=0;i<4;i++) assert.equal((await upload(`B4-paging-${i}.txt`)).status,201)
  await upload('B4-100%.txt')
  const literal=await f.api('/files?query='+encodeURIComponent('B4-100%'))
  assert.equal(literal.status,200);assert.equal(literal.body.data.items.length,1)
  const first=await f.api('/files?query=B4-paging&limit=2')
  assert.equal(first.status,200);assert.ok(first.body.data.nextCursor)
  const second=await f.api('/files?query=B4-paging&limit=2&cursor='+encodeURIComponent(first.body.data.nextCursor))
  assert.equal(second.body.data.nextCursor,null)
  assert.equal(new Set([...first.body.data.items,...second.body.data.items].map(x=>x.id)).size,4)
})
test('logical removal is idempotent, preserves bytes and references, and blocks download/new mounts',async()=>{
  const uploaded=await upload('B4-remove.txt');assert.equal(uploaded.status,201)
  const id=uploaded.body.data.id, s=await f.conversations.createSession({userId:'U00001',title:'B4 target'})
  assert.equal((await fetch(`${f.origin}/files/${id}/download`)).status,200)
  assert.equal((await f.content.prepareRuntimeFiles({sessionId:s.id,fileIds:[id],userId:'U00001'})).length,1)
  for(let i=0;i<2;i++)assert.equal((await f.api(`/files/${id}`,{method:'DELETE'})).status,200)
  assert.equal((await f.api('/files?query=B4-remove')).body.data.items.length,0)
  assert.equal((await f.api(`/files/${id}`)).status,403)
  assert.equal((await fetch(`${f.origin}/files/${id}/download`)).status,403)
  await assert.rejects(f.content.prepareRuntimeFiles({sessionId:s.id,fileIds:[id],userId:'U00001'}),{code:'permission_denied'})
  const [row]=await f.db.client`select f.removed_at, f.storage_key, fe.id from file_objects f join file_extractions fe on fe.file_id=f.id where f.id=${id}`
  assert.ok(row.removed_at);assert.ok(row.storage_key);assert.ok(row.id)
})
test('personal routes cannot see, remove or implicitly import team/other-user objects',async()=>{
  const team=await f.team(), s=await f.conversations.createSession({userId:'U00001',workspaceId:team,title:'B4 team'})
  const file=await f.content.storeSessionFile(s.id,'B4-team-secret.txt','text/plain',Buffer.from('fixture'),'U00001')
  const other=await f.content.storeWorkspaceFile('ws-personal-U00008','B4-other-secret.txt','text/plain',Buffer.from('fixture'),'U00008')
  for(const id of [file.id,other.id]){
    assert.equal((await f.api(`/files/${id}`)).status,403)
    assert.equal((await f.api(`/files/${id}`,{method:'DELETE'})).status,403)
  }
  const list=await f.api('/files?query=B4-');assert.equal(list.status,200)
  assert.equal(list.body.data.items.some((x:{id:string})=>[file.id,other.id].includes(x.id)),false)
})
test('parse failures remain visible but cannot be quoted; unsafe bytes never downloadable',async()=>{
  const res=await f.api('/files',{method:'POST',headers:{'content-type':'application/pdf','x-file-name':'B4-failed.pdf'},body:'invalid pdf'})
  assert.equal(res.status,422)
  const list=await f.api('/files?query=B4-failed');assert.equal(list.status,200)
  assert.equal(list.body.data.items[0].parseStatus,'failed');assert.equal(list.body.data.items[0].canReference,false)
  assert.equal(list.body.data.items[0].canDownload,true, 'a clean original remains available despite parse failure')
  const id=list.body.data.items[0].id
  await f.db.client`update file_objects set scan_status='blocked' where id=${id}`
  assert.equal((await f.api(`/files/${id}/download`)).status,403)
})
test('invalid file filters and disabled accounts are rejected',async()=>{
  for(const path of ['/files?source=team','/files?limit=0','/files?cursor=bad'])assert.equal((await f.api(path)).status,422)
  await f.db.client`update users set status='disabled' where id='U00001'`
  try {
    assert.equal((await f.api('/files')).status,403)
    assert.equal((await upload('B4-disabled.txt')).status,403)
  }finally{await f.db.client`update users set status='active' where id='U00001'`}
})
