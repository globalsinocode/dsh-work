import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'

import { compileRuntimeManifest } from '../../modules/runtime/manifest-compiler.ts'
import { normalizePersistedRuntimeManifest } from '../../modules/runtime/runtime-manifest-compatibility.ts'
import type { RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const tenantId = 'tenant-dsh-work'
const migrationsDirectory = resolve(import.meta.dirname, '../../../migrations')
const suffix = randomUUID()
const sessionId = `session-pf02-upgrade-${suffix}`
const runId = `run-pf02-upgrade-${suffix}`
const attemptId = `attempt-pf02-upgrade-${suffix}`

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let baselineDirectory = ''
let taskId = ''
let legacyManifest: Omit<RuntimeManifest, 'budget'>

before(async () => {
  baselineDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-pf02-migrations-'))
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (file < '0052_task_cumulative_budgets.sql') {
      await copyFile(resolve(migrationsDirectory, file), resolve(baselineDirectory, file))
    }
  }
  throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_pf02_upgrade_test',
    maxConnections: 4,
    migrate: false,
  })
  database = throwaway.client
  await runMigrations(database, baselineDirectory)
  await database`
    insert into sessions (
      id, tenant_id, workspace_id, created_by, agent_version_id, title, status
    ) values (
      ${sessionId}, ${tenantId}, 'ws-supply', 'U00001',
      'agent-version-dsh-work-assistant-1', 'PF-02 升级排队任务', 'active'
    )
  `
  await database`
    insert into runs (
      id, tenant_id, session_id, requested_by, idempotency_key, status
    ) values (
      ${runId}, ${tenantId}, ${sessionId}, 'U00001', ${randomUUID()}, 'queued'
    )
  `
  const [run] = await database<{ taskId: string }[]>`
    select task_id as "taskId" from runs where tenant_id = ${tenantId} and id = ${runId}
  `
  taskId = run!.taskId
  legacyManifest = {
    manifest_version: '1.0',
    run_id: runId,
    attempt_id: attemptId,
    task_id: taskId,
    session_id: sessionId,
    workspace_id: 'ws-supply',
    agent_version_id: 'agent-version-dsh-work-assistant-1',
    agent_configuration: {
      system_prompt: '这是 PF-02 升级排队任务的严格运行时清单，用于验证旧记录恢复。',
      skill_instructions: [],
    },
    user_context: { user_id: 'U00001', tenant_id: tenantId, role_ids: [] },
    permission_policy: { approval_mode: 'risk_based', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [],
    tools: [],
    data_scopes: [],
    knowledge_context: [],
    model_route_id: 'route-default',
    input: { message: '恢复升级前排队任务', file_mounts: [] },
    limits: { timeout_seconds: 45, max_tool_calls: 7, max_output_bytes: 8192 },
    created_at: new Date().toISOString(),
  }
  await database`
    insert into run_attempts (
      id, tenant_id, run_id, attempt_no, runtime_id, manifest,
      manifest_sha256, model_route_snapshot, status
    ) values (
      ${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01',
      ${database.json(JSON.parse(JSON.stringify(legacyManifest)))}, ${'a'.repeat(64)}, '{}', 'queued'
    )
  `
  await database`update runs set current_attempt_id = ${attemptId} where tenant_id = ${tenantId} and id = ${runId}`
})

after(async () => {
  await throwaway.dispose()
  if (baselineDirectory) await rm(baselineDirectory, { recursive: true, force: true })
})

test('PF-02 upgrade reserves historical queued Attempts and normalizes their persisted Manifest', async () => {
  const results = await runMigrations(database)
  assert.equal(results.find(result => result.version === '0052_task_cumulative_budgets.sql')?.applied, true)

  const [account] = await database<{ scopeTaskId: string; maxToolCalls: number | null }[]>`
    select budget_scope_task_id as "scopeTaskId", max_tool_calls::integer as "maxToolCalls"
      from task_budget_accounts where tenant_id = ${tenantId} and budget_scope_task_id = ${taskId}
  `
  assert.deepEqual(account, { scopeTaskId: taskId, maxToolCalls: null })
  const [usage] = await database<{
    status: string
    durationMs: number
    toolCalls: number
    outputBytes: number
  }[]>`
    select status, reserved_duration_ms::integer as "durationMs",
           reserved_tool_calls::integer as "toolCalls",
           reserved_output_bytes::integer as "outputBytes"
      from attempt_budget_usage where tenant_id = ${tenantId} and attempt_id = ${attemptId}
  `
  assert.deepEqual(usage, {
    status: 'reserved', durationMs: 45_000, toolCalls: 7, outputBytes: 8192,
  })
  assert.doesNotThrow(() => compileRuntimeManifest(normalizePersistedRuntimeManifest(
    legacyManifest as RuntimeManifest,
  )))
})
