import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'

let db: ThrowawayDatabase
before(async () => { db = await createThrowawayDatabase({ namePrefix: 'dsh_review_c9' }) })
after(async () => { await db?.dispose() })
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port
}
async function startApplication(extra: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-c9-'))
  const port = await freePort()
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: { ...process.env, NODE_ENV: 'development', DSH_WORK_AUTH_MODE: 'prototype',
      DSH_WORK_DATABASE_URL: db.url, DSH_WORK_DATA_ROOT: root,
      DSH_RUNTIME_HOME: join(root, 'missing-dsh'), DSH_WORK_PYTHON_IMAGE: 'invalid-image',
      DSH_WORK_SERVER_PORT: String(port), DSH_WORK_SERVER_HOST: '127.0.0.1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.on('data', chunk => { output += String(chunk) })
  const exited = once(child, 'exit')
  return { root, base: `http://127.0.0.1:${port}`, child, output: () => output,
    async close() { if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    } await rm(root, { recursive: true, force: true }) } }
}
async function ready(app: Awaited<ReturnType<typeof startApplication>>) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (app.child.exitCode !== null) throw new Error(`backend exited before core became ready: ${app.output()}`)
    try { const response = await fetch(`${app.base}/health/live`); if (response.ok) return } catch { /* process is starting */ }
    await delay(30)
  }
  throw new Error(`backend never listened: ${app.output()}`)
}
test('C9 RED: missing DSH and failed Python preflight do not block authenticated history/download or core readiness', async () => {
  const app = await startApplication()
  try {
    await ready(app)
    assert.equal((await fetch(`${app.base}/health/ready`)).status, 200)
    const status = await (await fetch(`${app.base}/health`)).json() as { data: { dshRuntime: { status: string }; executionCapabilities: { python: { status: string } } } }
    assert.equal(status.data.dshRuntime.status, 'offline')
    assert.equal(status.data.executionCapabilities.python.status, 'unavailable')
    assert.equal((await fetch(`${app.base}/api/workbench/v1/tasks`)).status, 200)
    const platform = await (await fetch(`${app.base}/api/admin/v1/platform-status`)).json() as { data: { dshRuntime: string } }
    assert.equal(platform.data.dshRuntime, 'not-connected')
    const content = new PostgresContentService(db.client, join(app.root, 'storage'), new PostgresAuthorizationService(db.client))
    const conversations = new PostgresConversationRepository(db.client)
    const session = await conversations.createSession({ userId: 'U00001', title: '故障时的历史资料' })
    const file = await content.storeSessionFile(session.id, 'fixture.txt', 'text/plain', Buffer.from('synthetic historical file'), 'U00001')
    const download = await fetch(`${app.base}/api/workbench/v1/files/${file.id}/download`)
    assert.equal(download.status, 200); assert.equal(await download.text(), 'synthetic historical file')
    const response = await fetch(`${app.base}/api/workbench/v1/sessions/${session.id}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '合成请求', idempotencyKey: 'review-c9' }),
    })
    assert.equal(response.status, 503)
    const failure = await response.json() as { error: { code: string } }
    assert.equal(failure.error.code, 'RUNTIME_UNAVAILABLE')
    const [count] = await db.client<{ n: number }[]>`select count(*)::integer as n from runs where session_id = ${session.id}`
    assert.equal(count?.n, 0)
  } finally { await app.close() }
})
test('core database and identity configuration failures never expose readiness', async () => {
  for (const extra of [
    { DSH_WORK_DATABASE_URL: 'invalid-database-url' },
    { NODE_ENV: 'production', DSH_WORK_AUTH_MODE: 'prototype' },
  ]) {
    const app = await startApplication(extra)
    try {
      await assert.rejects(ready(app), /backend exited/)
      await assert.rejects(fetch(`${app.base}/health/ready`))
    } finally { await app.close() }
  }
})

test('restored queues fail explicitly when Runtime is unavailable even if scheduling is disabled', async () => {
  const { PostgresRunRepository } = await import('../../modules/run/postgres-run-repository.ts')
  const { RunOrchestrationService } = await import('../../modules/run/run-orchestration-service.ts')
  const { ModelGovernanceService } = await import('../../modules/model/model-governance-service.ts')
  const { PostgresModelGovernanceRepository } = await import('../../modules/model/postgres-model-governance-repository.ts')
  const { UnavailableRuntime } = await import('../../modules/runtime/execution-capabilities.ts')
  const { randomUUID } = await import('node:crypto')
  const conversations = new PostgresConversationRepository(db.client)
  const runs = new PostgresRunRepository(db.client)
  const orchestration = new RunOrchestrationService(runs, conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(db.client)), new UnavailableRuntime('runtime-local-01'))
  const session = await conversations.createSession({ userId: 'U00001', title: '恢复排队任务' })
  const run = await runs.createRun({ tenantId: 'tenant-dsh-work', sessionId: session.id, requestedBy: 'U00001', idempotencyKey: randomUUID() })
  const attemptId = `attempt-${randomUUID()}`
  await runs.createAttempt({ tenantId: 'tenant-dsh-work', runId: run.id, attemptId, runtimeId: 'runtime-local-01',
    manifest: { attempt_id: attemptId, tools: [] }, manifestSha256: 'fixture', modelRouteSnapshot: {} })
  await db.client`update runtimes set scheduling_status = 'disabled' where id = 'runtime-local-01'`
  try {
    await orchestration.recoverAfterServiceRestart()
    const deadline = Date.now() + 3000
    while ((await runs.getRun('tenant-dsh-work', run.id))?.status === 'queued' && Date.now() < deadline) await delay(20)
    assert.equal((await runs.getRun('tenant-dsh-work', run.id))?.status, 'failed')
    assert.equal((await runs.getAttempt('tenant-dsh-work', attemptId))?.errorCode, 'RUNTIME_UNAVAILABLE')
  } finally {
    await orchestration.close()
    await db.client`update runtimes set scheduling_status = 'accepting' where id = 'runtime-local-01'`
  }
})
