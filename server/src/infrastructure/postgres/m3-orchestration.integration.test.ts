import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import type { PostgresAgentService, RuntimeAgentSnapshot } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { compileRuntimeManifest } from '../../modules/runtime/manifest-compiler.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let runtime: DeterministicRuntime
let runs: PostgresRunRepository
let conversations: PostgresConversationRepository
let content: PostgresContentService
let orchestration: RunOrchestrationService
let operations: PostgresOperationsService

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m3_orchestration_test', maxConnections: 6 })
  database = throwaway.client
  runtime = new DeterministicRuntime()
  runs = new PostgresRunRepository(database)
  conversations = new PostgresConversationRepository(database)
  content = new PostgresContentService(database, `/tmp/dsh-work-m3-test-${randomUUID()}`, new PostgresAuthorizationService(database))
  operations = new PostgresOperationsService(database)
  orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    content,
    operations,
  )
})

after(async () => {
  await orchestration.close()
  await throwaway.dispose()
})

test('real PostgreSQL orchestration persists the assistant result without publishing an Artifact', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 自动化闭环' })
  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '生成 M3 自动化回答', idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  const task = await waitForTask(created.id, 'succeeded')
  assert.match(task.messages.at(-1)?.content ?? '', /真实回答/)
  assert.equal(task.result.artifacts.length, 0)

  // I-06：版本化结果投影——执行终态与业务核验状态独立。回答登记只证明
  // 内容落库：没有已登记成果等可核验交付物时保持 unverified（评审修复）。
  assert.equal(task.result.version, 'task-result/v1')
  assert.equal(task.result.execution, 'succeeded')
  assert.equal(task.result.outcome, 'unverified')
  assert.equal(
    task.result.pendingItems.some(item => item.kind === 'no_verified_deliverable'),
    true,
  )
  assert.equal(task.result.primaryOutput?.messageId, task.messages.at(-1)?.id)
  assert.equal(
    task.result.receipts.some(receipt => receipt.kind === 'answer' && receipt.status === 'completed'),
    true,
  )

  // 读时投影幂等：重复读取得到同一结果，不重复登记。
  const reread = await conversations.getTaskResult(created.id, 'U00001')
  assert.deepEqual(reread?.result, task.result)
  // 未授权用户看不到正文/成果：行定位即拒绝（无权限成员读轨）。
  assert.equal(await conversations.getTaskResult(created.id, 'U99999'), null)

  const events = await runs.readEventsAfterEvent('tenant-dsh-work', created.id)
  assert.deepEqual(events.map((event) => event.eventType), [
    'run.queued', 'run.started', 'assistant.delta', 'assistant.completed', 'run.completed',
  ])
  const resumed = await runs.readEventsAfterEvent('tenant-dsh-work', created.id, events.at(-2)?.id)
  assert.deepEqual(resumed.map((event) => event.eventType), ['run.completed'])

  const usage = await new PostgresOperationsService(database).getModelUsage()
  const usageRecord = usage.items.find((record) => record.runId === created.id)
  assert.ok(usageRecord && usageRecord.totalTokens > 0)
  assert.equal(usageRecord.employeeId, 'U00001')
  assert.equal(usageRecord.employeeName, '林岚')
  assert.equal(usageRecord.department, '供应链中心')
})

test('validated Runtime output is published once as a downloadable Artifact', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '生成 Markdown 成果' })
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'dsh-work-artifact-publish-'))
  await mkdir(join(workspaceDirectory, 'output'))
  await writeFile(join(workspaceDirectory, 'output', '生产欠料管理PRD.md'), '# 生产欠料管理 PRD\n')

  // 成果发布属于「成功执行」的一部分：只能在 Run 仍 running 时追加——即 Adapter
  // 在执行期调用 collectArtifacts 所处的状态窗口；succeeded 后只允许核对既有版本。
  let releaseCompletion: () => void = () => undefined
  runtime.completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve })
  try {
    const created = await orchestration.startRun({
      userId: 'U00001', sessionId: session.id, prompt: '生成生产欠料管理 PRD', idempotencyKey: randomUUID(),
    })
    assert.ok(created)
    await waitForTask(created.id, 'running')
    const attempt = await runs.getAttempt('tenant-dsh-work', created.currentAttemptId!)
    const manifest = attempt!.manifest as unknown as RuntimeManifest

    const first = await content.publishRuntimeArtifacts({ manifest, workspaceDirectory })
    const repeated = await content.publishRuntimeArtifacts({ manifest, workspaceDirectory })
    assert.deepEqual(first, [{ name: '生产欠料管理PRD.md', size: Buffer.byteLength('# 生产欠料管理 PRD\n') }])
    assert.deepEqual(repeated, first)
    releaseCompletion()
    await waitForTask(created.id, 'succeeded')

    // succeeded 后同一成果集只能幂等核对；新增文件不得追加进既有成果集。
    const verified = await content.publishRuntimeArtifacts({ manifest, workspaceDirectory })
    assert.deepEqual(verified, first)
    await writeFile(join(workspaceDirectory, 'output', '补充说明.md'), '# 补充\n')
    await assert.rejects(
      content.publishRuntimeArtifacts({ manifest, workspaceDirectory }),
      /不能追加新成果/,
    )

    const task = await conversations.getTask(created.id, 'U00001')
    assert.equal(task?.result.artifacts.length, 1)
    assert.equal(task?.result.artifacts[0]?.name, '生产欠料管理PRD.md')
    assert.equal(task?.result.artifacts[0]?.type, 'markdown')
    // I-06：当前 Attempt 已登记成果构成可核验业务交付物 → achieved。
    assert.equal(task?.result.outcome, 'achieved')
    const artifactReceipt = task?.result.receipts.find(receipt => receipt.kind === 'artifact')
    const [storedVersion] = await database<{ id: string }[]>`
      select id from artifact_versions
       where tenant_id = 'tenant-dsh-work' and source_run_id = ${created.id}
    `
    // 回执固定到不可变 artifact_version，而不是会随版本推进的逻辑 artifact。
    assert.equal(artifactReceipt?.ref, storedVersion?.id)
    const fileId = await content.artifactFileId(task!.result.artifacts[0]!.id, 1, 'U00001')
    const downloaded = await content.readFile(fileId, 'U00001')
    assert.equal(downloaded.name, '生产欠料管理PRD.md')
    assert.equal(downloaded.bytes.toString('utf8'), '# 生产欠料管理 PRD\n')
    assert.equal((await readFile(join(workspaceDirectory, 'output', '生产欠料管理PRD.md'), 'utf8')), '# 生产欠料管理 PRD\n')
  } finally {
    releaseCompletion()
  }
})

test('HTML Runtime output is published as a previewable html Artifact', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '生成 HTML 成果' })
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'dsh-work-artifact-html-'))
  await mkdir(join(workspaceDirectory, 'output'))
  const markup = '<!DOCTYPE html><html><body><h1>风险看板</h1></body></html>'
  await writeFile(join(workspaceDirectory, 'output', '华东区风险看板.html'), markup)

  let releaseCompletion: () => void = () => undefined
  runtime.completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve })
  try {
    const created = await orchestration.startRun({
      userId: 'U00001', sessionId: session.id, prompt: '生成交互式风险看板', idempotencyKey: randomUUID(),
    })
    assert.ok(created)
    await waitForTask(created.id, 'running')
    const attempt = await runs.getAttempt('tenant-dsh-work', created.currentAttemptId!)
    const manifest = attempt!.manifest as unknown as RuntimeManifest

    const published = await content.publishRuntimeArtifacts({ manifest, workspaceDirectory })
    assert.deepEqual(published, [{ name: '华东区风险看板.html', size: Buffer.byteLength(markup) }])
    releaseCompletion()
    await waitForTask(created.id, 'succeeded')

    const task = await conversations.getTask(created.id, 'U00001')
    assert.equal(task?.result.artifacts.length, 1)
    assert.equal(task?.result.artifacts[0]?.type, 'html')
    const fileId = await content.artifactFileId(task!.result.artifacts[0]!.id, 1, 'U00001')
    const downloaded = await content.readFile(fileId, 'U00001')
    assert.equal(downloaded.mimeType, 'text/html; charset=utf-8')
    assert.equal(downloaded.bytes.toString('utf8'), markup)
  } finally {
    releaseCompletion()
  }
})

test('a succeeded Run claiming unregistered artifacts projects unverified, not achieved (I-06)', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '成果登记缺口' })
  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '声明成果但未登记', idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  const task = await waitForTask(created.id, 'succeeded')

  // 执行终态仍是 succeeded；业务核验状态独立为 unverified。
  assert.equal(task.status, 'succeeded')
  assert.equal(task.result.execution, 'succeeded')
  assert.equal(task.result.outcome, 'unverified')
  assert.equal(task.result.evidence.artifactsClaimed, 2)
  assert.equal(task.result.evidence.artifactsRegistered, 0)
  assert.equal(
    task.result.pendingItems.some(item => item.kind === 'artifact_registration_gap'),
    true,
  )
  assert.equal(
    task.result.receipts.some(receipt => receipt.kind === 'artifact' && receipt.status === 'missing'),
    true,
  )
  assert.match(task.result.summary, /未验证/)

  const projected = await conversations.getTaskResult(created.id, 'U00001')
  assert.equal(projected?.result.outcome, 'unverified')
  assert.equal(projected?.workspaceId, task.workspaceId)
})

test('artifacts registered by a failed Attempt do not leak into the retried Attempt result (I-06)', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '历史 Attempt 成果隔离' })
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'dsh-work-artifact-attempt-'))
  await mkdir(join(workspaceDirectory, 'output'))
  await writeFile(join(workspaceDirectory, 'output', '旧Attempt成果.md'), '# 旧 Attempt 成果\n')

  // 第一次 Attempt 在 running 窗口登记成果后失败；重试的当前 Attempt 没有
  // 任何交付物，历史 Attempt 登记的成果不得计入本次交付核验。
  let failAttempt: () => void = () => undefined
  runtime.completionGate = new Promise<void>((resolve) => { failAttempt = resolve })
  try {
    const created = await orchestration.startRun({
      userId: 'U00001', sessionId: session.id, prompt: '登记成果后失败', idempotencyKey: randomUUID(),
    })
    assert.ok(created)
    await waitForTask(created.id, 'running')
    const firstAttemptId = created.currentAttemptId!
    const attempt = await runs.getAttempt('tenant-dsh-work', firstAttemptId)
    const manifest = attempt!.manifest as unknown as RuntimeManifest
    await content.publishRuntimeArtifacts({ manifest, workspaceDirectory })

    failAttempt()
    await waitForTask(created.id, 'failed')

    // 失败 Attempt 的成果版本仍在库（同一 source_run_id），归属 Attempt 1。
    const versions = await database<{ sourceAttemptId: string | null }[]>`
      select source_attempt_id as "sourceAttemptId" from artifact_versions
       where tenant_id = 'tenant-dsh-work' and source_run_id = ${created.id}
    `
    assert.deepEqual(versions.map(row => row.sourceAttemptId), [firstAttemptId])

    await orchestration.retry(created.id, 'U00001')
    const retried = await waitForTask(created.id, 'succeeded')

    assert.notEqual(retried.result.attemptId, firstAttemptId)
    assert.equal(retried.result.execution, 'succeeded')
    assert.equal(retried.result.outcome, 'unverified')
    assert.equal(retried.result.artifacts.length, 0)
    assert.equal(retried.result.evidence.artifactsRegistered, 0)
    assert.equal(
      retried.result.pendingItems.some(item => item.kind === 'no_verified_deliverable'),
      true,
    )

    const projected = await conversations.getTaskResult(created.id, 'U00001')
    assert.equal(projected?.result.outcome, 'unverified')
    assert.equal(projected?.result.artifacts.length, 0)
  } finally {
    failAttempt()
  }
})

test('a follow-up Run snapshots only the preceding messages from its product Session', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 连续对话上下文' })
  const first = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '先提出需要确认的问题', idempotencyKey: randomUUID(),
  })
  assert.ok(first)
  await waitForTask(first.id, 'succeeded')

  const followUp = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '按序号列出刚才的问题', idempotencyKey: randomUUID(),
  })
  assert.ok(followUp)
  await waitForTask(followUp.id, 'succeeded')
  const attempt = await runs.getAttempt('tenant-dsh-work', followUp.currentAttemptId!)
  const manifest = attempt!.manifest as unknown as RuntimeManifest

  assert.deepEqual(manifest.input.conversation_history, [
    { role: 'user', content: '先提出需要确认的问题' },
    { role: 'assistant', content: 'M3 真实回答' },
  ])
  assert.equal(manifest.input.message, '按序号列出刚才的问题')

  const isolatedSession = await orchestration.createSession({ userId: 'U00001', title: 'M3 上下文隔离' })
  const isolated = await orchestration.startRun({
    userId: 'U00001', sessionId: isolatedSession.id, prompt: '新会话第一条消息', idempotencyKey: randomUUID(),
  })
  assert.ok(isolated)
  await waitForTask(isolated.id, 'succeeded')
  const isolatedAttempt = await runs.getAttempt('tenant-dsh-work', isolated.currentAttemptId!)
  assert.equal((isolatedAttempt!.manifest as unknown as RuntimeManifest).input.conversation_history, undefined)
})

test('conversation history keeps the newest messages within the Manifest limits', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 历史容量限制' })
  const previous = await runs.createRun({
    tenantId: 'tenant-dsh-work', sessionId: session.id, requestedBy: 'U00001', idempotencyKey: randomUUID(),
  })
  for (let index = 0; index < 13; index++) {
    await conversations.appendMessage({
      sessionId: session.id,
      runId: previous.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `消息-${index}`,
    })
  }
  const target = await runs.createRun({
    tenantId: 'tenant-dsh-work', sessionId: session.id, requestedBy: 'U00001', idempotencyKey: randomUUID(),
  })
  const messageBounded = await conversations.getConversationHistory(session.id, target.id)
  assert.equal(messageBounded.length, 12)
  assert.equal(messageBounded[0]?.content, '消息-1')
  assert.equal(messageBounded.at(-1)?.content, '消息-12')

  await database`delete from messages where tenant_id = 'tenant-dsh-work' and session_id = ${session.id}`
  for (let index = 0; index < 6; index++) {
    await conversations.appendMessage({
      sessionId: session.id,
      runId: previous.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${'x'.repeat(4_990)}消息-${index}`,
    })
  }
  const characterTarget = await runs.createRun({
    tenantId: 'tenant-dsh-work', sessionId: session.id, requestedBy: 'U00001', idempotencyKey: randomUUID(),
  })
  const characterBounded = await conversations.getConversationHistory(session.id, characterTarget.id)
  assert.equal(characterBounded.reduce((total, message) => total + message.content.length, 0), 24_000)
  assert.equal(characterBounded.at(-1)?.content.endsWith('消息-5'), true)
})

test('compilation failure converges the Run instead of leaving it queued without an Attempt', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '启动失败收敛' })
  assert.ok(session.agentVersionId)
  const models = new ModelGovernanceService(new PostgresModelGovernanceRepository(database))
  const resource = (content: string) => ({ path: 'reference.txt', content, size: content.length, sha256: createHash('sha256').update(content).digest('hex') })
  const snapshot: RuntimeAgentSnapshot = {
    modelRequirements: [],
    versionId: session.agentVersionId, systemPrompt: 'Read the selected Skill resources and answer the employee faithfully.',
    skills: ['first@1.0.0', 'second@1.0.0'],
    skillInstructions: ['first', 'second'].map(id => ({ id, version: '1.0.0', instructions: 'Read the packaged resources and summarize their contents.', tools: [], files: [resource('x'.repeat(600 * 1024))] })),
    tools: [], runtimeTools: [], toolBindings: [], approvalMode: 'risk_based', roleIds: [], dataScopes: [], maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
  }
  snapshot.skillInstructions[0]!.files = [resource('x'.repeat(1024 * 1024 + 1))]
  const failing = new RunOrchestrationService(runs, conversations, models, runtime, undefined, undefined, {
    getRuntimeSnapshot: async () => snapshot,
  } as unknown as PostgresAgentService)
  const request = { userId: 'U00001', sessionId: session.id, prompt: '编译前置策略无效', idempotencyKey: randomUUID() }
  await assert.rejects(failing.startRun(request), /单个 Skill 资源合计超过 1 MB/)
  const [run] = await database<{ id: string; status: string; attempt: string | null }[]>`
    select id, status, current_attempt_id as attempt from runs where session_id = ${session.id}
  `
  assert.equal(run?.status, 'failed')
  assert.equal(run?.attempt, null)
  assert.equal((await failing.startRun(request))?.id, run?.id)
  assert.equal((await failing.startRun(request))?.status, 'failed')
  snapshot.skillInstructions[0]!.files = [resource('x'.repeat(600 * 1024))]
  const combined = await failing.startRun({ ...request, idempotencyKey: randomUUID() })
  assert.ok(combined)
  await waitForTask(combined.id, 'succeeded')
  const attempt = await runs.getAttempt('tenant-dsh-work', combined.currentAttemptId!)
  const manifest = attempt!.manifest as unknown as RuntimeManifest
  assert.equal(manifest.agent_configuration.skill_instructions.length, 2)
  assert.equal(manifest.agent_configuration.skill_instructions.reduce((total, skill) => total + skill.files![0]!.content!.length, 0), 1200 * 1024)
})

test('model admission rejects employee, automation and release trial preparation without ghost Attempts', async t => {
  const models = new ModelGovernanceService(new PostgresModelGovernanceRepository(database))
  const route = await models.resolveRoute('default')
  try {
    for (const stage of ['model', 'runtime'] as const) {
      await database`update provider_models set capabilities = ${database.json(stage === 'model' ? [] : ['structured-output'])}
        where tenant_id = 'tenant-dsh-work' and id = ${route.modelId}`
      for (const purpose of ['employee', 'automation', 'trial'] as const) {
        await t.test(`${purpose}: ${stage} mismatch`, async () => {
          const session = await orchestration.createSession({ userId: 'U00001', title: `模型准入 ${purpose} ${stage}` })
          assert.ok(session.agentVersionId)
          const snapshot: RuntimeAgentSnapshot = {
            versionId: session.agentVersionId, modelRequirements: ['structured-output'],
            systemPrompt: '请根据当前授权范围内的信息回答用户问题，并标注结论依据。',
            skills: [], skillInstructions: [], tools: [], runtimeTools: [], toolBindings: [],
            approvalMode: 'risk_based', roleIds: [], dataScopes: [],
            maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
          }
          const service = new RunOrchestrationService(runs, conversations, models, runtime, undefined, undefined, {
            getRuntimeSnapshot: async () => snapshot,
          } as unknown as PostgresAgentService)
          const submit = async () => {
            if (purpose === 'trial') return service.runReleaseTrialCase({ userId: 'U00001', sessionId: session.id, draftVersionId: session.agentVersionId!, message: '测试能力准入', idempotencyKey: randomUUID() })
            if (purpose === 'employee') return service.startRun({ userId: 'U00001', sessionId: session.id, prompt: '测试能力准入', idempotencyKey: randomUUID() })
            const run = await runs.createRun({ tenantId: 'tenant-dsh-work', sessionId: session.id, requestedBy: 'U00001', idempotencyKey: randomUUID() })
            return service.dispatchAutomation(run, { userId: 'U00001', workspaceId: session.workspaceId, agentVersionId: session.agentVersionId!, prompt: '测试能力准入', fileIds: [], attemptId: `attempt-${randomUUID()}` })
          }
          await assert.rejects(submit(), { code: stage === 'model' ? 'MODEL_CAPABILITY_MISMATCH' : 'MODEL_CAPABILITY_UNAVAILABLE' })
          const [run] = await database<{ status: string; attempt: string | null; count: number }[]>`
            select r.status, r.current_attempt_id as attempt, (select count(*)::integer from run_attempts a where a.run_id = r.id) as count
              from runs r where r.session_id = ${session.id}
          `
          assert.equal(run?.status, 'failed')
          assert.equal(run?.attempt, null)
          assert.equal(run?.count, 0)
        })
      }
    }
  } finally {
    await database`update provider_models set capabilities = ${database.json(route.modelCapabilities)} where tenant_id = 'tenant-dsh-work' and id = ${route.modelId}`
  }
})

test('restart recovery rejects pinned model requirements when the current Runtime cannot verify them', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '恢复模型能力校验' })
  const [source] = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts where tenant_id = 'tenant-dsh-work' and status = 'succeeded' order by created_at limit 1
  `
  assert.ok(source)
  const run = await runs.createRun({ tenantId: 'tenant-dsh-work', sessionId: session.id, requestedBy: 'U00001', idempotencyKey: randomUUID() })
  const attemptId = `attempt-${randomUUID()}`
  const manifest = { ...source.manifest, run_id: run.id, attempt_id: attemptId, session_id: session.id, model_requirements: ['long-context'] } as RuntimeManifest
  const compiled = compileRuntimeManifest(manifest)
  const route = await new ModelGovernanceService(new PostgresModelGovernanceRepository(database)).resolveRoute()
  await runs.createAttempt({ tenantId: 'tenant-dsh-work', runId: run.id, attemptId, runtimeId: 'runtime-local-01',
    manifest: JSON.parse(compiled.canonicalJson), manifestSha256: compiled.sha256,
    modelRouteSnapshot: JSON.parse(JSON.stringify({ ...route, modelCapabilities: ['long-context'] })),
  })
  await orchestration.recoverAfterServiceRestart()
  await waitForTask(run.id, 'failed')
  const attempt = await runs.getAttempt('tenant-dsh-work', attemptId)
  assert.equal(attempt?.status, 'failed')
  assert.equal(attempt?.errorCode, 'MODEL_CAPABILITY_UNAVAILABLE')
  assert.equal(runtime.status(run.id), undefined, '不可恢复的能力不得启动 Worker')
})

test('cancel and retry keep one Run and create a new immutable Attempt', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 取消重试' })
  const contextRun = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '重试前的上下文', idempotencyKey: randomUUID(),
  })
  assert.ok(contextRun)
  await waitForTask(contextRun.id, 'succeeded')
  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '等待取消', idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  await waitForTask(created.id, 'running')
  await orchestration.cancel(created.id, 'U00001')
  await waitForTask(created.id, 'cancelled')
  await orchestration.retry(created.id, 'U00001')
  await waitForTask(created.id, 'succeeded')
  const [count] = await database<{ count: number }[]>`
    select count(*)::integer as count from run_attempts
     where tenant_id = 'tenant-dsh-work' and run_id = ${created.id}
  `
  assert.equal(count?.count, 2)
  const attempts = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts
     where tenant_id = 'tenant-dsh-work' and run_id = ${created.id}
     order by attempt_no
  `
  const expectedHistory = [
    { role: 'user', content: '重试前的上下文' },
    { role: 'assistant', content: 'M3 真实回答' },
  ]
  assert.deepEqual(attempts[0]?.manifest.input.conversation_history, expectedHistory)
  assert.deepEqual(attempts[1]?.manifest.input.conversation_history, expectedHistory)
})

test('a retry continues from the partial output preserved by a timed-out Attempt', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 超时续跑' })
  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '超时中断保留部分回答', idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  await waitForTask(created.id, 'failed')
  const failedTask = await conversations.getTask(created.id, 'U00001')
  assert.match(failedTask?.messages.at(-1)?.content ?? '', /中断前的部分回答/)
  assert.match(failedTask?.messages.at(-1)?.content ?? '', /执行超时中断/)
  assert.equal(failedTask?.result.error?.code, 'RUN_TIMEOUT')
  // I-06：失败执行的核验状态为 not_achieved，结构化错误收敛在结果外层。
  assert.equal(failedTask?.result.outcome, 'not_achieved')
  assert.equal(failedTask?.result.execution, 'failed')

  await orchestration.retry(created.id, 'U00001')
  await waitForTask(created.id, 'succeeded')
  const attempts = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts
     where tenant_id = 'tenant-dsh-work' and run_id = ${created.id}
     order by attempt_no
  `
  assert.equal(attempts.length, 2)
  const retriedHistory = attempts[1]?.manifest.input.conversation_history ?? []
  // 顺序：原始用户问题 → 已提交的部分回答 → 续写指令作为 manifest message
  assert.equal(retriedHistory.at(-2)?.role, 'user')
  assert.match(retriedHistory.at(-2)?.content ?? '', /超时中断保留部分回答/)
  assert.equal(retriedHistory.at(-1)?.role, 'assistant')
  assert.match(retriedHistory.at(-1)?.content ?? '', /中断前的部分回答/)
  assert.match(attempts[1]?.manifest.input.message ?? '', /从已有内容的断点处继续/)
  assert.equal(attempts[0]?.manifest.input.message, '超时中断保留部分回答')
})

test('deleting a conversation archives it only after active Runs stop', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 删除对话' })
  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '等待取消', idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  await waitForTask(created.id, 'running')

  await assert.rejects(
    conversations.archiveSession(session.id, 'U00001'),
    /请先停止当前运行/,
  )

  await orchestration.cancel(created.id, 'U00001')
  await waitForTask(created.id, 'cancelled')
  const archived = await conversations.archiveSession(session.id, 'U00001')

  assert.deepEqual(archived, { sessionId: session.id, title: 'M3 删除对话', archived: true, removedFromHistory: true, physicalDeletion: false })
  assert.equal(await conversations.getTask(created.id, 'U00001'), null)
  assert.equal((await conversations.listTasks('U00001')).some(task => task.sessionId === session.id), false)
  await assert.rejects(conversations.requireSession(session.id, 'U00001'), /不存在或不可访问/)
})

test('archiving a conversation and creating a Run are serialized by the Session lock', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 删除并发保护' })
  const archive = beginSessionArchive(session.id)

  await archive.checkedActiveRuns
  const rejectedCreation = assert.rejects(
    runs.createRun({
      tenantId: 'tenant-dsh-work',
      sessionId: session.id,
      requestedBy: 'U00001',
      idempotencyKey: randomUUID(),
    }),
    /Session 不存在或不可访问/,
  )
  archive.continueArchive()
  await archive.done
  await rejectedCreation

  const [persisted] = await database<{ count: number }[]>`
    select count(*)::integer as count from runs
     where tenant_id = 'tenant-dsh-work' and session_id = ${session.id}
  `
  assert.equal(persisted?.count, 0)
})

test('archiving a conversation and retrying a Run are serialized by the Session lock', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 重试并发保护' })
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: session.id,
    requestedBy: 'U00001',
    idempotencyKey: randomUUID(),
  })
  await runs.transitionRun(run.tenantId, run.id, 'cancelled')
  const archive = beginSessionArchive(session.id)

  await archive.checkedActiveRuns
  const rejectedAttempt = assert.rejects(
    runs.createAttempt({
      tenantId: run.tenantId,
      runId: run.id,
      manifest: { runId: run.id },
      manifestSha256: 'c'.repeat(64),
      modelRouteSnapshot: {},
    }),
    /所属 Session 已归档/,
  )
  archive.continueArchive()
  await archive.done
  await rejectedAttempt

  assert.equal((await runs.getRun(run.tenantId, run.id))?.status, 'cancelled')
  const [persisted] = await database<{ count: number }[]>`
    select count(*)::integer as count from run_attempts
     where tenant_id = 'tenant-dsh-work' and run_id = ${run.id}
  `
  assert.equal(persisted?.count, 0)
})

test('file safety gate blocks executable signatures and Tool audit is persisted', async () => {
  await assert.rejects(
    content.storeWorkspaceFile('ws-supply', '伪装文档.md', 'text/markdown', Buffer.from('MZ unsafe executable'), 'U00001'),
    /安全检查未通过/,
  )
  const run = await database<{ runId: string; attemptId: string }[]>`
    select r.id as "runId", a.id as "attemptId" from runs r
    join run_attempts a on a.tenant_id = r.tenant_id and a.run_id = r.id
    where r.tenant_id = 'tenant-dsh-work' and r.status = 'succeeded'
    order by r.created_at desc limit 1
  `
  const target = run[0]
  assert.ok(target)
  await operations.recordToolAudit({
    runId: target.runId,
    attemptId: target.attemptId,
    traceId: `trace-${target.runId}`,
    metadata: { tool_name: 'read', data_scope: 'workspace' },
  })
  const [count] = await database<{ count: number }[]>`
    select count(*)::integer as count from tool_audit_logs
     where tenant_id = 'tenant-dsh-work' and run_id = ${target.runId}
  `
  assert.ok((count?.count ?? 0) >= 1)
})

async function waitForTask(runId: string, expected: 'running' | 'succeeded' | 'cancelled' | 'failed') {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, 'U00001')
    if (task?.status === expected) return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待 Run 状态超时：${expected}`)
}

function beginSessionArchive(sessionId: string) {
  let notifyChecked: () => void = () => undefined
  let continueArchive: () => void = () => undefined
  const checkedActiveRuns = new Promise<void>((resolve) => { notifyChecked = resolve })
  const continueSignal = new Promise<void>((resolve) => { continueArchive = resolve })
  const done = database.begin(async (transaction) => {
    await transaction`
      select id from sessions
       where tenant_id = 'tenant-dsh-work' and id = ${sessionId}
       for update
    `
    const [activeRun] = await transaction<{ id: string }[]>`
      select id from runs
       where tenant_id = 'tenant-dsh-work' and session_id = ${sessionId}
         and status in ('queued', 'running', 'cancel_requested')
       limit 1
    `
    if (activeRun) throw new Error(`测试前置条件失败，仍有活动 Run：${activeRun.id}`)
    notifyChecked()
    await continueSignal
    await transaction`
      update sessions set status = 'archived', last_active_at = now()
       where tenant_id = 'tenant-dsh-work' and id = ${sessionId}
    `
  })
  return { checkedActiveRuns, continueArchive, done }
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  resolve: (snapshot: RuntimeExecutionSnapshot) => void
  done: Promise<RuntimeExecutionSnapshot>
  completionGate: Promise<void> | null
}

class DeterministicRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, Execution>()
  private readonly attemptCounts = new Map<string, number>()
  /** 测试闸门：设置后由下一次 execute 消费（随执行记录走并置空），该执行停在 running 直到放行。 */
  completionGate: Promise<void> | null = null

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>((resolve) => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued', acceptedAt: now,
      startedAt: null, endedAt: null, manifestSha256: 'test', attemptDirectory: '/tmp/test',
      errorCode: null, errorMessage: null,
    }
    const execution: Execution = { manifest, events: [], listeners: new Set(), snapshot, resolve: resolveDone, done, completionGate: this.completionGate }
    this.completionGate = null
    this.executions.set(manifest.run_id, execution)
    const count = (this.attemptCounts.get(manifest.run_id) ?? 0) + 1
    this.attemptCounts.set(manifest.run_id, count)
    this.emit(execution, 'run.queued', '已排队')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '已启动')
      if (manifest.input.message === '等待取消' && count === 1) return
      if (manifest.input.message === '超时中断保留部分回答' && count === 1) {
        this.emit(execution, 'assistant.delta', '中断前的部分回答')
        this.emit(execution, 'assistant.completed', '中断前的部分回答\n\n---\n*本轮回答因执行超时中断，以上为已生成内容。*')
        execution.snapshot.status = 'failed'
        execution.snapshot.errorCode = 'RUN_TIMEOUT'
        this.emit(execution, 'run.failed', '任务执行失败', { error_code: 'RUN_TIMEOUT' })
        this.finish(execution)
        return
      }
      if (manifest.input.message === '登记成果后失败' && count === 1) {
        // I-06 跨 Attempt 夹具：保持在 running 等测试在窗口内登记成果，
        // 闸门释放后失败——重试的新 Attempt 不得继承本次登记的成果。
        const fail = async () => {
          await execution.completionGate
          if (execution.snapshot.status !== 'running') return
          execution.snapshot.status = 'failed'
          execution.snapshot.errorCode = 'RUNTIME_EXECUTION_FAILED'
          this.emit(execution, 'run.failed', '任务执行失败', { error_code: 'RUNTIME_EXECUTION_FAILED' })
          this.finish(execution)
        }
        void fail()
        return
      }
      if (manifest.input.message === '声明成果但未登记' && count === 1) {
        // I-06 反例夹具：Runtime 自述生成 2 个成果但平台登记为 0——
        // 执行成功不能显示为业务目标达成。
        this.emit(execution, 'assistant.delta', '已生成两份报告')
        this.emit(execution, 'assistant.completed', '已生成两份报告')
        execution.snapshot.status = 'completed'
        this.emit(execution, 'run.completed', '已完成', { artifact_count: 2 })
        this.finish(execution)
        return
      }
      this.emit(execution, 'assistant.delta', 'M3 真实回答')
      const complete = async () => {
        await execution.completionGate
        if (execution.snapshot.status !== 'running') return
        this.emit(execution, 'assistant.completed', 'M3 真实回答')
        execution.snapshot.status = 'completed'
        this.emit(execution, 'run.completed', '已完成')
        this.finish(execution)
      }
      void complete()
    }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('Run not found')
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => execution.listeners.delete(listener)
  }

  async cancel(runId: string) {
    const execution = this.executions.get(runId)
    if (!execution || ['completed', 'cancelled', 'failed'].includes(execution.snapshot.status)) return { accepted: false }
    this.emit(execution, 'run.cancel_requested', '正在取消')
    execution.snapshot.status = 'cancelled'
    this.emit(execution, 'run.cancelled', '已取消')
    this.finish(execution)
    return { accepted: true }
  }

  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() { return { status: 'healthy' as const, runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio' as const, message: 'test' } }
  async close() { return undefined }

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], display: string, safeMetadata: Record<string, unknown> = {}) {
    const event: RuntimeEvent = {
      event_id: randomUUID(), run_id: execution.manifest.run_id, attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1, event_type: eventType, occurred_at: new Date().toISOString(),
      display_message: display, safe_metadata: safeMetadata, trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach((listener) => listener(event))
  }

  private finish(execution: Execution) {
    execution.snapshot.endedAt = new Date().toISOString()
    execution.resolve(structuredClone(execution.snapshot))
  }
}
