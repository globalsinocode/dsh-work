/** Explicit isolated P1 server; never imported from production main. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactTextExtraction, ArtifactTextExtractorPort } from '../../server/src/modules/workbench/application/container-artifact-text-extractor.ts'
import { minimalDocx, minimalPng, minimalPptx, minimalXlsx } from '../../server/src/testing/office-fixtures.ts'
import { personalWorkbenchFixture, testTenant } from '../../server/src/infrastructure/postgres/personal-workbench-test-fixture.ts'
import { PersonalBrowserRuntime } from '../../server/src/infrastructure/postgres/personal-browser-runtime.ts'
import { envelope } from '../../server/src/http/router.ts'
const runtime = new PersonalBrowserRuntime()
// EX-ARTIFACT-07：解析器测试替身，不启动容器；给出固定的合成解析文本，PDF 按无法读取处理。
const syntheticTexts: Record<string, string> = {
  xlsx: '# XLSX 文件摘要\n工作表：2；数据行：5；单元格：15\n\n## 营收\n区域\t收入（万元）\t同比\n华东\t1200\t12%\n华南\t800\t6%\n合计\t=SUM(B2:B3)\n\n## 明细\n月份\t区域\t收入（万元）\n7月\t华东\t380\n8月\t华东\t390',
  docx: 'P1 合成解析文本（非真实解析）\n华东区收入同比增长 12%。\n区域\t收入（万元）\n华东\t1200',
  pptx: '# PPTX 文件摘要\n幻灯片：2\n\n## 第 1 页\n华东区经营概览\n收入 1200 万元\n备注：P1 合成备注\n\n## 第 2 页\n下季度重点',
}
const artifactTextExtractor: ArtifactTextExtractorPort = {
  async extract(files) {
    return files.map((file): ArtifactTextExtraction => file.type === 'pdf'
      ? { ok: false, detectedType: 'pdf', code: 'PDF_UNREADABLE', message: 'PDF 无法读取' }
      : { ok: true, detectedType: file.type, text: syntheticTexts[file.type]!, pageCount: file.type === 'pptx' ? 2 : null, sheetCount: file.type === 'xlsx' ? 2 : null, rowCount: null })
  },
}
const fixture = await personalWorkbenchFixture('dsh_b3_browser', { port: Number(process.env.DSH_WORK_SERVER_PORT ?? 4390), runtime, browser: true, artifactTextExtractor })
const officePdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1')
// `P1-成果达成` 标记：在 run.completed 前登记真实成果行（含 source_attempt_id），
// 对应真实 Adapter 先 collectArtifacts 再完成 Attempt 的顺序。
runtime.hooks.registerArtifact = async manifest => {
  if (!manifest.session_id) throw new Error('P1 成果登记需要会话内的 Attempt')
  // `P1-办公成果`：经真实成果发布流程（publishRuntimeArtifacts）登记 Office/PDF/图片成果。
  if (manifest.input.message.includes('P1-办公成果')) {
    const workspaceDirectory = await mkdtemp(join(tmpdir(), 'dsh-p1-office-'))
    try {
      await mkdir(join(workspaceDirectory, 'output'))
      const outputs: Record<string, Buffer> = {
        '华东营收.xlsx': minimalXlsx(), '季度经营报告.docx': minimalDocx(), '经营概览.pptx': minimalPptx(),
        '季度经营报告.pdf': officePdf, '营收趋势.png': minimalPng(),
      }
      for (const [name, bytes] of Object.entries(outputs)) await writeFile(join(workspaceDirectory, 'output', name), bytes)
      await fixture.content.publishRuntimeArtifacts({ manifest, workspaceDirectory })
    } finally {
      await rm(workspaceDirectory, { recursive: true, force: true })
    }
    return
  }
  const file = await fixture.content.storeSessionFile(manifest.session_id, 'P1-登记成果.txt', 'text/plain', Buffer.from(`P1 registered artifact, not a real DSH output: ${manifest.input.message}`), manifest.user_context.user_id)
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
// S5c 测试钩子（仅本可丢弃夹具）：把本人与某 AI 同事最近的一段个人会话改为固定在该 AI 同事的
// 一个旧版本上，模拟“会话固定的 Agent 版本已不是当前版本”，验证协作模式发送时自动开启新会话。
fixture.router.post('/api/workbench/v1/test/collab/agents/:agentId/stale-latest-session', async (_request, context) => {
  const agentId = context.params['agentId'] ?? ''
  const [latest] = await fixture.db.client<{ sessionId: string; versionId: string }[]>`
    select s.id as "sessionId", s.agent_version_id as "versionId"
      from sessions s join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
      join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
     where s.tenant_id = ${testTenant} and s.created_by = 'U00001' and s.status = 'active'
       and w.workspace_type = 'personal' and av.agent_id = ${agentId}
     order by s.last_active_at desc, s.id desc limit 1`
  if (!latest) return envelope('workbench', { sessionId: null })
  const staleVersionId = `${latest.versionId}-p1-stale`
  const [current] = await fixture.db.client<Record<string, unknown>[]>`select * from agent_versions where tenant_id = ${testTenant} and id = ${latest.versionId}`
  const columns = Object.keys(current!).filter(column => column !== 'id' && column !== 'version')
    .map(column => `"${column.replaceAll('"', '""')}"`).join(', ')
  await fixture.db.client.unsafe(
    `insert into agent_versions (id, version, ${columns})
     select $1, $2, ${columns} from agent_versions where tenant_id = $3 and id = $4
     on conflict (id) do nothing`,
    [staleVersionId, `0.0.${Date.now()}`, testTenant, latest.versionId],
  )
  await fixture.db.client`update sessions set agent_version_id = ${staleVersionId} where tenant_id = ${testTenant} and id = ${latest.sessionId}`
  return envelope('workbench', { sessionId: latest.sessionId })
})
console.log('P1 personal workbench ready; throwaway PostgreSQL, synthetic Runtime, no OIDC/model.')
let closing = false
async function close() { if (closing) return; closing = true; await fixture.close(); process.exit(0) }
process.on('SIGINT', () => { void close() }); process.on('SIGTERM', () => { void close() })
