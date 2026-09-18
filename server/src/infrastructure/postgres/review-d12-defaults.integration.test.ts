import assert from 'node:assert/strict'
import { before,after,test } from 'node:test'
import { personalWorkbenchFixture } from './personal-workbench-test-fixture.ts'
import { PostgresWorkspaceService } from '../../modules/workbench/application/postgres-workspace-service.ts'
let f:Awaited<ReturnType<typeof personalWorkbenchFixture>>
before(async()=>{f=await personalWorkbenchFixture('dsh_d12_defaults')})
after(async()=>{await f?.close()})
async function create(body:object){return f.api('/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'D12默认',...body})})}
test('default Session ownership is resolved server-side, never the first team',async()=>{
 await f.team()
 const result=await create({});assert.equal(result.status,201)
 assert.equal(result.body.data.workspaceId,'ws-personal-U00001')
 for(const workspaceId of ['ws-personal-U00008','not-a-team'])assert.equal((await create({workspaceId})).status,403)
})
test('legacy explicit personal ID and standalone sentinel remain compatible',async()=>{
 for(const workspaceId of ['ws-personal-U00001','standalone']){const r=await create({workspaceId});assert.equal(r.status,201);assert.equal(r.body.data.workspaceId,'ws-personal-U00001')}
})
test('D12 RED: existing personal workspace cannot make a disabled actor resolve as active',async()=>{
 await f.db.client`update users set status='disabled' where id='U00001'`
 try{await assert.rejects(new PostgresWorkspaceService(f.db.client).ensurePersonalWorkspace('U00001'),{code:'permission_denied'})}
 finally{await f.db.client`update users set status='active' where id='U00001'`}
})
test('concurrent default provisioning retains one immutable personal workspace',async()=>{
 const service=new PostgresWorkspaceService(f.db.client)
 const values=await Promise.all(Array.from({length:6},()=>service.ensurePersonalWorkspace('U00001')))
 assert.equal(new Set(values.map(w=>w.id)).size,1)
 const [count]=await f.db.client`select count(*)::int as n from workspaces where created_by='U00001' and workspace_type='personal'`
 assert.equal(count.n,1)
})
