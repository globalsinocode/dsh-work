import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { compileRuntimeManifest } from '../modules/runtime/manifest-compiler.ts'
import { canonicalJson } from '../modules/runtime/canonical-json.ts'
import type { RuntimeManifest } from '../modules/runtime/runtime-types.ts'
import type { JsonObject } from '../modules/run/run-types.ts'
import { PostgresPersistentWaitService } from '../modules/run/postgres-persistent-wait-service.ts'
import { PostgresRunRepository } from '../modules/run/postgres-run-repository.ts'
import { PostgresTaskRepository } from '../modules/task/postgres-task-repository.ts'
import { Router } from './router.ts'
import { registerRunApprovalRoutes } from './workbench/run-approval-routes.ts'

const tenantId = 'tenant-dsh-work'
const employeeA = 'U00001'
const employeeB = 'U00008'

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let runs: PostgresRunRepository
let tasks: PostgresTaskRepository
let persistentWait: PostgresPersistentWaitService
let server: ReturnType<typeof createServer>
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_run_approval_api', maxConnections: 6 })
  database = throwaway.client
  runs = new PostgresRunRepository(database)
  tasks = new PostgresTaskRepository(database)
  persistentWait = new PostgresPersistentWaitService(database, runs, {
    reauthorize: async () => undefined,
    enqueue: () => undefined,
  })
  const router = new Router({ authenticateApi: headerAuthenticator })
  registerRunApprovalRoutes(router, database, runs, persistentWait, 'postgres')
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
})

test('未登录决议审批返回 401', async () => {
  const result = await call('POST', '/runs/run-x/approval', undefined, { decision: 'approved' })
  assert.equal(result.status, 401)
})

test('非发起人决议返回 403 且审批仍为 pending', async () => {
  const fixture = await pendingApprovalFixture('forbidden')
  const result = await call('POST', `/runs/${fixture.run.id}/approval`, employeeB, { decision: 'approved' })
  assert.equal(result.status, 403)
  const [row] = await database<{ status: string }[]>`
    select status from run_approval_requests where tenant_id = ${tenantId} and id = ${fixture.approvalId}
  `
  assert.equal(row?.status, 'pending')
})

test('发起人 approved 200', async () => {
  const fixture = await pendingApprovalFixture('approve')
  const first = await call('POST', `/runs/${fixture.run.id}/approval`, employeeA, { decision: 'approved' })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.data, { runId: fixture.run.id, decision: 'approved' })
})

test('发起人 rejected 200 且 Run 进入 failed', async () => {
  const fixture = await pendingApprovalFixture('reject')
  const result = await call('POST', `/runs/${fixture.run.id}/approval`, employeeA, { decision: 'rejected' })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.data, { runId: fixture.run.id, decision: 'rejected' })
  assert.equal((await runs.getRun(tenantId, fixture.run.id))?.status, 'failed')
})

test('没有 pending 审批返回 409', async () => {
  const fixture = await runningFixture('no-pending')
  const result = await call('POST', `/runs/${fixture.run.id}/approval`, employeeA, { decision: 'approved' })
  assert.equal(result.status, 409)
  assert.match(result.body.error.message, /当前没有待决的审批/)
})

async function pendingApprovalFixture(label: string) {
  const fixture = await runningFixture(label)
  const wait = await persistentWait.decidePermission(fixture.manifest, permission('erp.update', label))
  if (typeof wait === 'string') throw new Error('expected durable wait')
  await persistentWait.activateWaiting({
    approvalId: wait.approvalId,
    runId: fixture.run.id,
    attemptId: fixture.manifest.attempt_id,
  })
  return { run: fixture.run, approvalId: wait.approvalId }
}

async function runningFixture(label: string) {
  const unique = `${label}-${randomUUID()}`
  const task = await tasks.createTask({
    tenantId, requestedBy: employeeA, sourceType: 'api', correlationKey: unique,
    workspaceId: 'ws-personal-U00001',
  })
  const run = await runs.createRun({
    tenantId, taskId: task.id, sessionId: null, workspaceId: task.workspaceId,
    requestedBy: task.requestedBy, idempotencyKey: unique,
  })
  const manifest: RuntimeManifest = {
    manifest_version: '1.0', run_id: run.id, attempt_id: `attempt-${randomUUID()}`,
    task_id: task.id, session_id: null, workspace_id: task.workspaceId!,
    agent_version_id: 'agent-version-dsh-work-assistant-1',
    agent_configuration: { system_prompt: 'You are a controlled test agent for durable waiting.', skill_instructions: [] },
    user_context: { user_id: task.requestedBy, tenant_id: tenantId, role_ids: ['employee'] },
    permission_policy: { approval_mode: 'always', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [], tools: [{ id: 'erp.update', version: '1.0.0' }], data_scopes: [], knowledge_context: [],
    input: { message: 'Perform the approved action safely.', file_mounts: [] },
    budget: {
      scope_task_id: task.id,
      cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
      reservation: { duration_ms: 30_000, tool_calls: 2, output_bytes: 4096 },
      enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
    },
    limits: { timeout_seconds: 30, max_tool_calls: 2, max_output_bytes: 4096 },
    created_at: new Date().toISOString(), trace_id: `trace-${unique}`,
  }
  const compiled = compileRuntimeManifest(manifest)
  await runs.createAttempt({
    attemptId: manifest.attempt_id, tenantId, runId: run.id, runtimeId: 'runtime-local-01',
    manifest: JSON.parse(compiled.canonicalJson) as JsonObject, manifestSha256: compiled.sha256,
    modelRouteSnapshot: {},
  })
  await runs.transitionAttempt(tenantId, manifest.attempt_id, 'running')
  await runs.transitionRun(tenantId, run.id, 'running')
  return { run, manifest }
}

function permission(toolName: string, marker: string) {
  const actionArguments = { orderId: '42', marker }
  const parameterDigest = createHash('sha256').update(canonicalJson(actionArguments)).digest('hex')
  return {
    toolName, toolCallId: `call-${randomUUID()}`, parameterDigest,
    resourceRef: 'erp://orders/42', dataVersion: 'etag-v1',
    checkpointState: {
      pending_action: { arguments: actionArguments },
      completed_tool_results: [],
      workspace_files: [],
      assistant_output: '等待审批。',
    },
  }
}

async function call(
  method: 'POST',
  path: string,
  userId: string | undefined,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/workbench/v1${path}`, {
    method,
    headers: {
      ...(userId ? { 'x-test-user-id': userId } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

function headerAuthenticator(request: IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    return Promise.reject(error)
  }
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId,
      name: userId,
      title: '员工',
      department: '测试部门',
      avatarText: '测',
      role: 'employee',
      dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}
