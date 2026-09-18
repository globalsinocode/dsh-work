import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { personalWorkbenchFixture } from './personal-workbench-test-fixture.ts'
import { PersonalBrowserRuntime } from './personal-browser-runtime.ts'
let f: Awaited<ReturnType<typeof personalWorkbenchFixture>>
before(async () => { f = await personalWorkbenchFixture('dsh_b3_closure', { runtime: new PersonalBrowserRuntime() }) })
after(async () => { await f?.close() })
async function jsonPost(path: string, data: object) { return f.api(path, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}) }
test('B3/B4/D12 HTTP closure: explicit personal material reaches the existing Run/Attempt lane', async () => {
  const file=await f.api('/files',{method:'POST',headers:{'content-type':'text/plain','x-file-name':'P1-http-material.txt'},body:'synthetic input'})
  assert.equal(file.status,201)
  await f.team()
  const session=await jsonPost('/sessions',{title:'P1 HTTP closure'})
  assert.equal(session.status,201);assert.equal(session.body.data.workspaceId,'ws-personal-U00001')
  const run=await jsonPost(`/sessions/${session.body.data.id}/runs`,{prompt:'读取合成文件',fileIds:[file.body.data.id]})
  assert.equal(run.status,202,JSON.stringify(run.body))
  const deadline=Date.now()+5000
  let latest=run
  while(Date.now()<deadline){latest=await f.api(`/runs/${run.body.data.id}`);if(latest.body.data.status==='succeeded')break;await delay(10)}
  assert.equal(latest.body.data.status,'succeeded',JSON.stringify(latest.body))
  assert.ok(latest.body.data.messages.some((m:{content:string})=>m.content.includes('输入文件 1 个')))
  const history=await f.api('/sessions?query='+encodeURIComponent('P1 HTTP closure'))
  assert.equal(history.body.data.items[0].sessionId,session.body.data.id)
  assert.equal(history.body.data.items[0].runCount,1)
  const [snapshot]=await f.db.client`select ra.manifest, rif.file_id from run_attempts ra join run_input_files rif on rif.attempt_id=ra.id where ra.run_id=${run.body.data.id}`
  assert.equal(snapshot.file_id,file.body.data.id);assert.equal(snapshot.manifest.workspace_id,session.body.data.workspaceId)
})
test('B5 HTTP closure: a removed conversation retains its attachment without allowing the old Session to run',async()=>{
 const session=await jsonPost('/sessions',{title:'P1 removable closure'})
 const file=await f.api(`/sessions/${session.body.data.id}/files`,{method:'POST',headers:{'content-type':'text/plain','x-file-name':'P1-retained.txt'},body:'retained synthetic bytes'})
 assert.equal(file.status,201)
 assert.equal((await f.api(`/sessions/${session.body.data.id}`,{method:'DELETE'})).status,200)
 const files=await f.api('/files?query=P1-retained')
 assert.equal(files.body.data.items[0].source,'attachment');assert.equal(files.body.data.items[0].sourceSessionState,'removed')
 const download=await fetch(`${f.origin}/files/${file.body.data.id}/download`)
 assert.equal(download.status,200);assert.equal(await download.text(),'retained synthetic bytes')
 assert.equal((await jsonPost(`/sessions/${session.body.data.id}/runs`,{prompt:'must fail'})).status,403)
})
