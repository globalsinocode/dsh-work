import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import type { AgentRuntimePort } from '../../modules/runtime/runtime-types.ts'

let db: ThrowawayDatabase
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
async function runRevokedCase(revoke: () => Promise<void>, restore: () => Promise<void>, outage = false) {
  const runs = new ClaimBoundaryRepository(db.client)
  const conversations = new PostgresConversationRepository(db.client)
  let calls = 0
  const runtime: AgentRuntimePort = {
    async execute() { calls++; throw new Error('revoked personal task reached Worker') },
    subscribe() { return () => {} }, async cancel() { return { accepted: false } },
    status() { return undefined }, async close() {},
    async health() { return { status: 'healthy', runtimeId: 'runtime-local-01', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/test-only', transport: 'acp-stdio', message: 'test port' } },
  }
  const auth = new PostgresAuthorizationService(db.client)
  const orchestration = new RunOrchestrationService(runs, conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(db.client)), runtime,
    undefined, undefined, undefined, undefined, auth)
  try {
    const session = await orchestration.createSession({ userId: 'U00001', title: '个人执行前复核' })
    runs.atBoundary = async () => {
      await revoke()
      if (outage) auth.authorizeRuntime = async () => { throw new Error('synthetic database outage') }
    }
    const created = await orchestration.startRun({ userId: 'U00001', sessionId: session.id, prompt: '合成任务', idempotencyKey: randomUUID() })
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
  } finally { await orchestration.close(); await restore() }
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
test('authorization infrastructure failures are not reported as revocation', async () => {
  await runRevokedCase(async () => {}, async () => {}, true)
})
