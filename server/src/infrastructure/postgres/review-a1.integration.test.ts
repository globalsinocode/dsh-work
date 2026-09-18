import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { AgentRuntimePort, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import { prototypeApiAuthenticator } from '../../modules/identity/prototype-authenticator.ts'
import { Router } from '../../http/router.ts'
import { registerConversationRoutes } from '../../http/workbench/conversation-routes.ts'
import { registerContentRoutes } from '../../http/workbench/content-routes.ts'

let db: ThrowawayDatabase, root: string, content: PostgresContentService
let conversations: PostgresConversationRepository, orchestration: RunOrchestrationService
let server: ReturnType<typeof createServer>, origin: string
let calls = 0
const runtime: AgentRuntimePort = {
  async execute() { calls++; throw new Error('unexpected Worker dispatch in denied-input test') },
  subscribe() { return () => {} }, async cancel() { return { accepted: false } },
  status() { return undefined }, async close() {},
  async health() { return { status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0,
    acceptingRuns: true, dshRepository: '/test-only', transport: 'acp-stdio', message: 'test port' } },
}
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'dsh_work_review_a1', maxConnections: 5 })
  root = await mkdtemp(join(tmpdir(), 'dsh-work-review-a1-'))
  const auth = new PostgresAuthorizationService(db.client)
  content = new PostgresContentService(db.client, root, auth)
  conversations = new PostgresConversationRepository(db.client)
  const runs = new PostgresRunRepository(db.client)
  const agents = new PostgresAgentService(db.client)
  orchestration = new RunOrchestrationService(runs, conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(db.client)), runtime,
    content, undefined, agents, undefined, auth)
  const router = new Router({ authenticateApi: prototypeApiAuthenticator })
  registerConversationRoutes(router, conversations, orchestration, runs, agents, auth)
  registerContentRoutes(router, content, auth)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}/api/workbench/v1`
})
after(async () => {
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  await orchestration?.close()
  await db?.dispose()
  if (root) await rm(root, { recursive: true, force: true })
})
async function team() {
  const result = await content.createWorkspace({ name: '回归团队', description: '合成测试资料' }, 'U00008')
  assert.ok(result)
  await db.client`insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values ('tenant-dsh-work', ${result.id}, 'U00001', 'member', 'U00008')`
  return result.id
}

test('A1 RED: removed member cannot send an old team attachment into a personal Run via real HTTP route', async () => {
  const workspaceId = await team()
  const source = await conversations.createSession({ userId: 'U00001', title: '团队附件来源', workspaceId })
  const file = await content.storeSessionFile(source.id, 'restricted.txt', 'text/plain', Buffer.from('synthetic source secret'), 'U00001')
  await db.client`delete from workspace_members where workspace_id = ${workspaceId} and user_id = 'U00001'`
  const target = await conversations.createSession({ userId: 'U00001', title: '个人目标' })
  const download = await fetch(`${origin}/files/${file.id}/download`)
  assert.equal(download.status, 403)
  const before = calls
  const response = await fetch(`${origin}/sessions/${target.id}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '分析附件', fileIds: [file.id], idempotencyKey: randomUUID() }) })
  assert.equal(response.status, 403)
  assert.equal(calls, before)
})
test('same personal workspace supports explicit cross-conversation reuse', async () => {
  const source = await conversations.createSession({ userId: 'U00001', title: '来源' })
  const target = await conversations.createSession({ userId: 'U00001', title: '目标' })
  const file = await content.storeSessionFile(source.id, 'notes.txt', 'text/plain', Buffer.from('synthetic personal notes'), 'U00001')
  const prepared = await content.prepareRuntimeFiles({ sessionId: target.id, fileIds: [file.id], userId: 'U00001' })
  assert.equal(prepared.length, 1)
  assert.match(prepared[0].mount.content, /synthetic personal notes/)
  await assert.rejects(content.prepareRuntimeFiles({ sessionId: target.id, fileIds: [file.id], userId: 'U00008' }), { code: 'permission_denied' })
})
test('current team members can use shared inputs; author identity does not allow cross-workspace transfer', async () => {
  const workspaceId = await team()
  const shared = await content.storeWorkspaceFile(workspaceId, 'shared.txt', 'text/plain', Buffer.from('shared synthetic'), 'U00008')
  const target = await conversations.createSession({ userId: 'U00001', title: '团队目标', workspaceId })
  assert.equal((await content.prepareRuntimeFiles({ sessionId: target.id, fileIds: [shared.id], userId: 'U00001' })).length, 1)
  const ownFile = await content.storeSessionFile(target.id, 'own.txt', 'text/plain', Buffer.from('own synthetic'), 'U00001')
  const personal = await conversations.createSession({ userId: 'U00001', title: '个人目标' })
  await assert.rejects(content.prepareRuntimeFiles({ sessionId: personal.id, fileIds: [ownFile.id], userId: 'U00001' }), { code: 'permission_denied' })
})
test('pinned input recheck detects removal and keeps immutable bytes untouched', async () => {
  const session = await conversations.createSession({ userId: 'U00001', title: '排队资料' })
  const file = await content.storeSessionFile(session.id, 'input.txt', 'text/plain', Buffer.from('stable bytes'), 'U00001')
  const prepared = await content.prepareRuntimeFiles({ sessionId: session.id, fileIds: [file.id], userId: 'U00001' })
  const manifest = { session_id: session.id, user_context: { user_id: 'U00001' }, input: { file_mounts: prepared.map(row => row.mount) } } as RuntimeManifest
  const snapshot = JSON.stringify(manifest)
  await content.recheckRuntimeFiles(manifest)
  await db.client`update file_objects set removed_at = now() where id = ${file.id}`
  await assert.rejects(content.recheckRuntimeFiles(manifest), { code: 'permission_denied' })
  assert.equal(JSON.stringify(manifest), snapshot)
})
test('archived source remains downloadable by current members but cannot be mounted in a new task', async () => {
  const workspaceId = await team()
  const session = await conversations.createSession({ userId: 'U00001', title: '归档空间', workspaceId })
  const file = await content.storeSessionFile(session.id, 'archive.txt', 'text/plain', Buffer.from('archive synthetic'), 'U00001')
  await db.client`update workspaces set status = 'archived', archived_at = now() where id = ${workspaceId}`
  assert.equal((await content.readFile(file.id, 'U00001')).bytes.toString(), 'archive synthetic')
  await assert.rejects(content.prepareRuntimeFiles({ sessionId: session.id, fileIds: [file.id], userId: 'U00001' }), { code: 'permission_denied' })
})
