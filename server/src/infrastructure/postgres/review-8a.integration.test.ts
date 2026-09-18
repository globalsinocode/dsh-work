import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import type { RuntimeSkillConfiguration } from '../../modules/skill/postgres-skill-service.ts'
import type { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'

const tenant = 'tenant-dsh-work', actor = 'U00008'
let db: ThrowawayDatabase, service: AdminSkillInstallationService, runs: PostgresRunRepository
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'dsh_work_review_8a', maxConnections: 5 })
  runs = new PostgresRunRepository(db.client)
  // This fixture exercises persisted evidence reads, not DSH execution.
  service = new AdminSkillInstallationService(db.client, {} as RunOrchestrationService,
    new PostgresAuthorizationService(db.client), {} as PostgresToolConnectorService)
})
after(async () => { await db?.dispose() })

async function seedRetry() {
  const key = randomUUID(), sessionId = `admin-session-${key}`, runId = `run-${key}`
  const first = `attempt-first-${key}`, second = `attempt-second-${key}`
  const skill: RuntimeSkillConfiguration = { id: 'skill-evidence-fixture', version: '1.0.0',
    instructions: '合成试运行执行说明，不访问真实数据。', tools: [],
    files: [{ path: 'scripts/main.py', sha256: 'a'.repeat(64), size: 1 }] }
  await db.client`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
    values (${sessionId}, ${tenant}, ${actor}, 'Attempt 隔离测试', 'active', 'admin', null, null)`
  await db.client`insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenant}, ${sessionId}, ${actor}, ${key}, 'queued')`
  for (const [attemptId, number, status] of [[first, 1, 'failed'], [second, 2, 'succeeded']] as const) {
    const manifest = { purpose: 'admin-skill-test', run_id: runId, session_id: sessionId, attempt_id: attemptId,
      skills: [{ id: skill.id, version: skill.version }],
      agent_configuration: { system_prompt: '合成测试', skill_instructions: [{ ...skill }] } }
    await db.client`insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
      values (${attemptId}, ${tenant}, ${runId}, ${number}, ${db.client.json(JSON.parse(JSON.stringify(manifest)))}, ${'f'.repeat(64)}, '{}'::jsonb, ${status})`
  }
  await db.client`update runs set current_attempt_id = ${second}, status = 'succeeded' where tenant_id = ${tenant} and id = ${runId}`
  await addEvidence(runId, sessionId, first, skill)
  return { runId, sessionId, first, second, skill }
}
async function addEvidence(runId: string, sessionId: string, attemptId: string, skill: RuntimeSkillConfiguration) {
  await db.client`insert into skill_runtime_activations (id, tenant_id, run_id, attempt_id, skill_id, skill_version, content_sha256)
    values (${randomUUID()}, ${tenant}, ${runId}, ${attemptId}, ${skill.id}, ${skill.version}, ${'a'.repeat(64)})`
  await db.client`insert into skill_python_executions (id, tenant_id, run_id, attempt_id, skill_id, entry_path, succeeded)
    values (${randomUUID()}, ${tenant}, ${runId}, ${attemptId}, ${skill.id}, 'scripts/main.py', true)`
  await db.client`insert into messages (id, tenant_id, session_id, run_id, role, content)
    values (${randomUUID()}, ${tenant}, ${sessionId}, ${runId}, 'assistant', '旧 Attempt 的非空回复')`
  await runs.appendEvent({ id: randomUUID(), tenantId: tenant, runId, attemptId, sequence: 1,
    eventType: 'assistant.completed', displayMessage: '已提交的合成回复', safeMetadata: { committed: true },
    traceId: `trace-${runId}`, occurredAt: new Date().toISOString() })
}
test('8a RED: a retry without its own evidence cannot pass using the previous Attempt', async () => {
  const fixture = await seedRetry()
  const progress = await service.packageTestProgress(actor, fixture.skill, fixture.runId)
  assert.equal(progress.passed, false)
})
test('exact current Attempt evidence permits the unchanged strict trial policy', async () => {
  const fixture = await seedRetry()
  await addEvidence(fixture.runId, fixture.sessionId, fixture.second, fixture.skill)
  const progress = await service.packageTestProgress(actor, fixture.skill, fixture.runId)
  assert.equal(progress.passed, true)
  assert.equal(progress.attemptId, fixture.second)
})
test('current Attempt with wrong Skill version remains unverified', async () => {
  const fixture = await seedRetry()
  await addEvidence(fixture.runId, fixture.sessionId, fixture.second, { ...fixture.skill, version: '0.9.0' })
  assert.equal((await service.packageTestProgress(actor, fixture.skill, fixture.runId)).passed, false)
})
test('start bindings are immutable and legacy test rows are not silently upgraded', async () => {
  const fixture = await seedRetry()
  await db.client`insert into skill_test_bindings (tenant_id, run_id, skill_id, skill_version_id,
    configuration_fingerprint, runtime_fingerprint, test_prompt, created_by)
    values (${tenant}, ${fixture.runId}, 'skill-document', 'skill-version-document-1', 'original', 'graph', '原始问题', ${actor})`
  await assert.rejects(db.client`update skill_test_bindings set configuration_fingerprint = 'changed'
    where tenant_id = ${tenant} and run_id = ${fixture.runId}`, /immutable/)
  const [record] = await db.client<{ fingerprint: string }[]>`select configuration_fingerprint as fingerprint
    from skill_test_bindings where tenant_id = ${tenant} and run_id = ${fixture.runId}`
  assert.equal(record?.fingerprint, 'original')
  const id = `test-${randomUUID()}`
  await db.client`insert into skill_test_runs (id, tenant_id, skill_id, skill_version_id,
    configuration_fingerprint, test_prompt, status, result_summary, tested_by)
    values (${id}, ${tenant}, 'skill-document', 'skill-version-document-1', 'old', '旧问题', 'passed', '旧证据', ${actor})`
  const [legacy] = await db.client<{ policy: string; attemptId: string | null }[]>`select evidence_policy as policy,
    runtime_attempt_id as "attemptId" from skill_test_runs where id = ${id}`
  assert.equal(legacy?.policy, 'legacy')
  assert.equal(legacy?.attemptId, null)
  await assert.rejects(db.client`update skill_test_runs set evidence_policy = 'attempt-v2' where id = ${id}`, /check constraint/)
})
