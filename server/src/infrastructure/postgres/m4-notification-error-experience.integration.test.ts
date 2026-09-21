import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { testAttemptManifest } from './test-attempt-manifest.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let conversations: PostgresConversationRepository
let runs: PostgresRunRepository

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_notification_test', maxConnections: 4 })
  database = throwaway.client
  conversations = new PostgresConversationRepository(database)
  runs = new PostgresRunRepository(database)
})

after(async () => {
  await throwaway.dispose()
})

test('failed Attempts expose persisted error codes as object, reason and next step', async () => {
  const timeoutTask = await createFailedTask('RUN_TIMEOUT')
  assert.equal(timeoutTask.status, 'failed')
  assert.equal(timeoutTask.result.error?.code, 'RUN_TIMEOUT')
  assert.equal(timeoutTask.result.error?.object, `运行 ${timeoutTask.id}`)
  assert.match(timeoutTask.result.error?.reason ?? '', /执行时间|时限/)
  assert.match(timeoutTask.result.error?.suggestion ?? '', /重新执行|运行时/)
  assert.equal(timeoutTask.result.error?.retryable, true)

  const deniedTask = await createFailedTask('TOOL_PERMISSION_DENIED')
  assert.equal(deniedTask.result.error?.code, 'TOOL_PERMISSION_DENIED')
  assert.match(deniedTask.result.error?.reason ?? '', /角色|数据范围|审批策略/)
  assert.match(deniedTask.result.error?.suggestion ?? '', /授权/)
  assert.equal(deniedTask.result.error?.retryable, false)
})

test('unknown Runtime errors remain traceable without inventing a success state', async () => {
  const task = await createFailedTask('ENTERPRISE_CONNECTOR_BROKEN')
  assert.equal(task.status, 'failed')
  assert.equal(task.result.error?.code, 'ENTERPRISE_CONNECTOR_BROKEN')
  assert.match(task.result.error?.reason ?? '', /ENTERPRISE_CONNECTOR_BROKEN/)
  assert.match(task.result.error?.suggestion ?? '', /运行编号|错误码/)
})

async function createFailedTask(errorCode: string) {
  const session = await conversations.createSession({
    userId: 'U00001',
    title: `M4 错误体验 ${errorCode}`,
    workspaceId: 'ws-supply',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: session.id,
    requestedBy: 'U00001',
    idempotencyKey: randomUUID(),
  })
  const attempt = await runs.createAttempt({
    tenantId: run.tenantId,
    runId: run.id,
    runtimeId: 'runtime-local-01',
    manifest: testAttemptManifest(run.taskId, run.id),
    manifestSha256: randomUUID().replaceAll('-', ''),
    modelRouteSnapshot: { providerKey: 'dsh-default', modelKey: 'dsh-default' },
  })
  await runs.transitionAttempt(run.tenantId, attempt.id, 'failed', errorCode)
  await runs.transitionRun(run.tenantId, run.id, 'failed')

  const task = await conversations.getTask(run.id, 'U00001')
  assert.ok(task)
  return task
}
