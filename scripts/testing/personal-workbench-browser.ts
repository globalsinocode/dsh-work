/** Explicit isolated P1 server; never imported from production main. */
import { randomUUID } from 'node:crypto'
import { personalWorkbenchFixture, testTenant } from '../../server/src/infrastructure/postgres/personal-workbench-test-fixture.ts'
import { PersonalBrowserRuntime } from '../../server/src/infrastructure/postgres/personal-browser-runtime.ts'
import { envelope } from '../../server/src/http/router.ts'
const runtime = new PersonalBrowserRuntime()
const fixture = await personalWorkbenchFixture('dsh_b3_browser', { port: Number(process.env.DSH_WORK_SERVER_PORT ?? 4390), runtime, browser: true })
// `P1-成果达成` 标记：在 run.completed 前登记真实成果行（含 source_attempt_id），
// 对应真实 Adapter 先 collectArtifacts 再完成 Attempt 的顺序。
runtime.hooks.registerArtifact = async manifest => {
  const file = await fixture.content.storeSessionFile(manifest.session_id, 'P1-登记成果.txt', 'text/plain', Buffer.from('P1 registered artifact, not a real DSH output'), manifest.user_context.user_id)
  const artifact = `artifact-${randomUUID()}`
  await fixture.db.client`insert into artifacts(id,tenant_id,workspace_id,session_id,name,artifact_type,created_by)
    values(${artifact},${testTenant},${manifest.workspace_id},${manifest.session_id},'P1-登记成果.txt','text',${manifest.user_context.user_id})`
  await fixture.db.client`insert into artifact_versions(id,tenant_id,artifact_id,version_no,file_object_id,source_run_id,source_attempt_id)
    values(${randomUUID()},${testTenant},${artifact},1,${file.id},${manifest.run_id},${manifest.attempt_id})`
}
const old = await fixture.conversations.createSession({ userId: 'U00001', title: 'P1-旧对话-需要恢复' })
const empty = await fixture.conversations.createSession({ userId: 'U00001', title: 'P1-空对话-继续原会话' })
const team = await fixture.team()
// More than fifty newer Runs make the old conversation unreachable through /tasks alone.
const busy = await fixture.conversations.createSession({ userId: 'U00001', title: 'P1-多轮对话' })
await fixture.run(old.id)
for (let n = 0; n < 60; n++) await fixture.run(busy.id)
const attachment = await fixture.content.storeSessionFile(old.id, 'P1-会话附件.txt', 'text/plain', Buffer.from('P1 fixture attachment'), 'U00001')
const generated = await fixture.content.storeSessionFile(old.id, 'P1-合成成果.txt', 'text/plain', Buffer.from('P1 synthetic artifact, not a real DSH output'), 'U00001')
const artifact = `artifact-${randomUUID()}`, runId = await fixture.run(old.id)
await fixture.db.client`insert into artifacts(id,tenant_id,workspace_id,session_id,name,artifact_type,created_by)
 values(${artifact},${testTenant},${old.workspaceId},${old.id},'P1-合成成果.txt','text','U00001')`
await fixture.db.client`insert into artifact_versions(id,tenant_id,artifact_id,version_no,file_object_id,source_run_id)
 values(${randomUUID()},${testTenant},${artifact},1,${generated.id},${runId})`
await fixture.db.client`update runs set created_at = '2026-08-01T00:00:00Z' where session_id = ${old.id}`
fixture.router.get('/api/workbench/v1/test/fixtures', () => envelope('workbench', { oldSessionId: old.id, emptySessionId: empty.id, personalId: old.workspaceId, teamId: team, attachmentId: attachment.id, artifactFileId: generated.id, synthetic: true }))
console.log('P1 personal workbench ready; throwaway PostgreSQL, synthetic Runtime, no OIDC/model.')
let closing = false
async function close() { if (closing) return; closing = true; await fixture.close(); process.exit(0) }
process.on('SIGINT', () => { void close() }); process.on('SIGTERM', () => { void close() })
