import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import type { AgentRuntimePort } from '../../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { DshAcpRuntimeAdapter } from '../../modules/runtime/dsh-acp-runtime-adapter.ts'

let db: ThrowawayDatabase
const mockWorker = join(dirname(fileURLToPath(import.meta.url)), '../../modules/runtime/testing/mock-acp-worker.ts')
before(async () => { db = await createThrowawayDatabase({ namePrefix: 'dsh_work_review_a2', maxConnections: 5 }) })
after(async () => { await db?.dispose() })
class ClaimBoundaryRepository extends PostgresRunRepository {
  atBoundary?: () => Promise<void>
  override async claimAttempt(...args: Parameters<PostgresRunRepository['claimAttempt']>) {
    const claimed = await super.claimAttempt(...args)
    if (claimed && this.atBoundary) { const act = this.atBoundary; this.atBoundary = undefined; await act() }
    return claimed
  }
}
interface BoundaryContext {
  tools: PostgresToolConnectorService
  fileId?: string
}

async function runRevokedCase(
  revoke: (context: BoundaryContext) => Promise<void>,
  restore: (context: BoundaryContext) => Promise<void>,
  outage = false,
  withInputFile = false,
) {
  const runs = new ClaimBoundaryRepository(db.client)
  const conversations = new PostgresConversationRepository(db.client)
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-review-a2-'))
  let calls = 0
  const runtime: AgentRuntimePort = {
    async execute() { calls++; throw new Error('revoked personal task reached Worker') },
    subscribe() { return () => {} }, async cancel() { return { accepted: false } },
    status() { return undefined }, async close() {},
    async health() { return { status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/test-only', transport: 'acp-stdio', message: 'test port' } },
  }
  const auth = new PostgresAuthorizationService(db.client)
  const content = new PostgresContentService(db.client, root, auth)
  const tools = new PostgresToolConnectorService(db.client)
  const agents = new PostgresAgentService(db.client, undefined, undefined, tools)
  const orchestration = new RunOrchestrationService(runs, conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(db.client)), runtime,
    content, undefined, agents, undefined, auth, { toolBindings: tools })
  const context: BoundaryContext = { tools }
  try {
    const session = await orchestration.createSession({ userId: 'U00001', title: '个人执行前复核' })
    if (withInputFile) {
      const file = await content.storeSessionFile(
        session.id,
        '领取后撤销.txt',
        'text/plain',
        Buffer.from('synthetic authorization boundary input'),
        'U00001',
      )
      context.fileId = file.id
    }
    runs.atBoundary = async () => {
      await revoke(context)
      if (outage) auth.authorizeRuntime = async () => { throw new Error('synthetic database outage') }
    }
    const created = await orchestration.startRun({
      userId: 'U00001',
      sessionId: session.id,
      prompt: '合成任务',
      idempotencyKey: randomUUID(),
      ...(context.fileId ? { fileIds: [context.fileId] } : {}),
    })
    assert.ok(created)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const run = await runs.getRun('tenant-dsh-work', created.id)
      if (run && ['failed', 'cancelled', 'succeeded'].includes(run.status)) break
      await delay(10)
    }
    assert.equal(calls, 0)
    const run = await runs.getRun('tenant-dsh-work', created.id)
    assert.equal(run?.status, 'failed')
    const attempt = await runs.getAttempt('tenant-dsh-work', run!.currentAttemptId!)
    assert.equal(attempt?.errorCode, outage ? 'AUTHORIZATION_CHECK_UNAVAILABLE' : 'AUTHORIZATION_REVOKED')
  } finally {
    await orchestration.close()
    try { await restore(context) }
    finally { await rm(root, { recursive: true, force: true }) }
  }
}
test('A2 RED: personal account revoked after claim never reaches Runtime', async () => {
  await runRevokedCase(
    async () => { await db.client`update users set status = 'disabled' where id = 'U00001'` },
    async () => { await db.client`update users set status = 'active' where id = 'U00001'` },
  )
})
test('personal pinned Agent disabled after claim never reaches Runtime', async () => {
  await runRevokedCase(
    async () => { await db.client`update agents set status = 'disabled' where id = 'agent-dsh-work-assistant'` },
    async () => { await db.client`update agents set status = 'published' where id = 'agent-dsh-work-assistant'` },
  )
})
test('personal input file removed after claim never reaches Runtime', async () => {
  await runRevokedCase(
    async ({ fileId }) => { await db.client`update file_objects set removed_at = now() where id = ${fileId!}` },
    async ({ fileId }) => { await db.client`update file_objects set removed_at = null where id = ${fileId!}` },
    false,
    true,
  )
})
test('pinned platform tool binding revoked after claim never reaches Runtime', async () => {
  await runRevokedCase(
    async ({ tools }) => { await tools.setToolStatus({ toolId: 'read', status: 'disabled', actor: 'U00008' }) },
    async ({ tools }) => { await tools.setToolStatus({ toolId: 'read', status: 'available', actor: 'U00008' }) },
  )
})
test('authorization infrastructure failures are not reported as revocation', async () => {
  await runRevokedCase(async () => {}, async () => {}, true)
})

test('input file removed while the DSH Worker is active stops execution without committing completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-review-a2-active-file-'))
  const runs = new PostgresRunRepository(db.client)
  const conversations = new PostgresConversationRepository(db.client)
  const auth = new PostgresAuthorizationService(db.client)
  const content = new PostgresContentService(db.client, join(root, 'storage'), auth)
  const tools = new PostgresToolConnectorService(db.client)
  const agents = new PostgresAgentService(db.client, undefined, undefined, tools)
  const context: { orchestration?: RunOrchestrationService } = {}
  const runtime = new DshAcpRuntimeAdapter({
    runtimeId: 'runtime-local-01',
    runtimeRoot: join(root, 'runtime'),
    dshRepository: process.cwd(),
    process: {
      command: process.execPath,
      args: ['--experimental-strip-types', mockWorker],
      cwd: process.cwd(),
    },
    authorizeExecution: manifest => {
      if (!context.orchestration) throw new Error('测试编排服务尚未就绪')
      return context.orchestration.assertCurrentRunAuthorization(manifest)
    },
  })
  const orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(db.client)),
    runtime,
    content,
    undefined,
    agents,
    undefined,
    auth,
    { toolBindings: tools },
  )
  context.orchestration = orchestration
  let fileId: string | undefined
  try {
    const session = await orchestration.createSession({ userId: 'U00001', title: '活动期文件收权' })
    const file = await content.storeSessionFile(
      session.id,
      '活动期撤销.txt',
      'text/plain',
      Buffer.from('synthetic active execution input'),
      'U00001',
    )
    fileId = file.id
    const created = await orchestration.startRun({
      userId: 'U00001',
      sessionId: session.id,
      prompt: '[hang] 等待活动期授权复核',
      idempotencyKey: randomUUID(),
      fileIds: [file.id],
    })
    assert.ok(created)
    await waitFor(async () => runtime.status(created.id)?.status === 'running', 'DSH Worker 进入活动状态')

    await db.client`update file_objects set removed_at = now() where id = ${file.id}`
    await waitFor(async () => (await runs.getRun('tenant-dsh-work', created.id))?.status === 'failed', '活动期文件收权停止 Run', 8_000)

    const attempt = await runs.getAttempt('tenant-dsh-work', created.currentAttemptId!)
    assert.equal(attempt?.errorCode, 'AUTHORIZATION_REVOKED')
    const events = await runs.readEventsAfterEvent('tenant-dsh-work', created.id)
    assert.equal(events.some(event => event.eventType === 'assistant.completed'), false)
    assert.equal(events.some(event => event.eventType === 'run.completed'), false)
    assert.equal(events.some(event => event.eventType === 'run.failed'
      && event.safeMetadata['error_code'] === 'AUTHORIZATION_REVOKED'), true)
  } finally {
    await orchestration.close()
    if (fileId) await db.client`update file_objects set removed_at = null where id = ${fileId}`
    await rm(root, { recursive: true, force: true })
  }
})

test('team member removed before the artifact transaction cannot publish a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-review-a2-artifact-'))
  const workspaceId = `ws-review-a2-artifact-${randomUUID()}`
  const sessionId = `session-review-a2-artifact-${randomUUID()}`
  const runId = `run-review-a2-artifact-${randomUUID()}`
  const attemptId = `attempt-review-a2-artifact-${randomUUID()}`
  let releaseScan: () => void = () => undefined
  let markScanReached: () => void = () => undefined
  const scanGate = new Promise<void>(resolve => { releaseScan = resolve })
  const scanReached = new Promise<void>(resolve => { markScanReached = resolve })
  const content = new PostgresContentService(
    db.client,
    join(root, 'storage'),
    new PostgresAuthorizationService(db.client),
    {
      async scan() {
        markScanReached()
        await scanGate
        return { clean: true }
      },
    },
  )
  const manifest = {
    manifest_version: '1.0' as const,
    run_id: runId,
    attempt_id: attemptId,
    session_id: sessionId,
    workspace_id: workspaceId,
    agent_version_id: 'agent-version-dsh-work-assistant-1',
    agent_configuration: { system_prompt: '测试成果提交授权。', skill_instructions: [] },
    user_context: { user_id: 'U00001', tenant_id: 'tenant-dsh-work', role_ids: ['role-employee'] },
    permission_policy: { approval_mode: 'risk_based' as const, network_policy: 'deny' as const, write_policy: 'workspace_only' as const },
    skills: [],
    tools: [{ id: 'write', version: '1.0.0' }],
    data_scopes: [],
    knowledge_context: [],
    input: { message: '生成成果', file_mounts: [] },
    limits: { timeout_seconds: 300, max_output_bytes: 65536, max_tool_calls: 20 },
    created_at: new Date().toISOString(),
  }
  try {
    await db.client`
      insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
      values (${workspaceId}, 'tenant-dsh-work', '成果提交收权空间', '', 'team', 'U00008', 'active')
    `
    await db.client`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values
        ('tenant-dsh-work', ${workspaceId}, 'U00008', 'owner', 'U00008'),
        ('tenant-dsh-work', ${workspaceId}, 'U00001', 'member', 'U00008')
    `
    await db.client`
      insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
      values (${sessionId}, 'tenant-dsh-work', ${workspaceId}, 'U00001',
        'agent-version-dsh-work-assistant-1', '成果提交收权', 'active')
    `
    await db.client.begin(async transaction => {
      await transaction`
        insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id)
        values (${runId}, 'tenant-dsh-work', ${sessionId}, 'U00001', ${`idem-${runId}`}, 'running', ${attemptId})
      `
      await transaction`
        insert into run_attempts (
          id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status
        ) values (
          ${attemptId}, 'tenant-dsh-work', ${runId}, 1, 'runtime-local-01',
          ${transaction.json(manifest)}, 'review-a2-artifact', ${transaction.json({})}, 'running'
        )
      `
    })
    const workspaceDirectory = join(root, 'workspace')
    await mkdir(join(workspaceDirectory, 'output'), { recursive: true })
    await writeFile(join(workspaceDirectory, 'output', '授权收权报告.md'), '# 不得提交\n')

    const publishing = content.publishRuntimeArtifacts({ manifest, workspaceDirectory })
    const rejected = assert.rejects(publishing, { code: 'permission_denied' })
    await scanReached
    await db.client`
      delete from workspace_members
       where tenant_id = 'tenant-dsh-work' and workspace_id = ${workspaceId} and user_id = 'U00001'
    `
    releaseScan()
    await rejected

    const [registered] = await db.client<{ count: number }[]>`
      select count(*)::integer as count from artifact_versions
       where tenant_id = 'tenant-dsh-work' and source_run_id = ${runId}
    `
    assert.equal(registered?.count, 0)
  } finally {
    releaseScan()
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(`等待超时：${label}`)
}
