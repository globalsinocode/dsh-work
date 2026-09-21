import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { AutomationService } from '../../modules/automation/automation-service.ts'
import { AutomationTriggerSweep } from '../../modules/automation/automation-trigger-sweep.ts'
import { nextSlotUtc } from '../../modules/automation/automation-calendar.ts'
import { PostgresAutomationRepository } from '../../modules/automation/postgres-automation-repository.ts'
import { defaultAutomationConfig } from '../../modules/automation/automation-types.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type {
  AgentRuntimePort,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeHealth,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { testAttemptManifest } from './test-attempt-manifest.ts'

const tenantId = 'tenant-dsh-work'

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let automations: PostgresAutomationRepository
let service: AutomationService
let sweep: AutomationTriggerSweep
let conversations: PostgresConversationRepository
let content: PostgresContentService
let runs: PostgresRunRepository
let authorization: PostgresAuthorizationService
let agents: PostgresAgentService
let orchestration: RunOrchestrationService

/** 永不完成的 Runtime：执行只停在 queued，保证「未终结」重叠窗口确定。 */
class HoldingRuntime implements AgentRuntimePort {
  readonly manifests: RuntimeManifest[] = []

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    this.manifests.push(manifest)
    return {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      acceptedAt: new Date().toISOString(),
      done: new Promise(() => undefined),
    }
  }

  subscribe() { return () => undefined }
  async cancel() { return { accepted: false } }
  status(): RuntimeExecutionSnapshot | undefined { return undefined }
  async health(): Promise<RuntimeHealth> {
    return {
      status: 'healthy', runtimeId: 'runtime-automation-test', activeExecutions: 0,
      acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio', message: 'test',
    }
  }
  async close() {}
}

const runtime = new HoldingRuntime()

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_automation_test', maxConnections: 6 })
  database = throwaway.client
  automations = new PostgresAutomationRepository(database)
  conversations = new PostgresConversationRepository(database)
  runs = new PostgresRunRepository(database)
  authorization = new PostgresAuthorizationService(database)
  agents = new PostgresAgentService(database)
  content = new PostgresContentService(database, `/tmp/dsh-work-automation-test-${randomUUID()}`, authorization)
  orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    undefined,
    undefined,
    agents,
    undefined,
    authorization,
  )
  service = new AutomationService(
    database,
    automations,
    conversations,
    runs,
    orchestration,
    authorization,
    agents,
    content,
    undefined,
    defaultAutomationConfig,
  )
  sweep = new AutomationTriggerSweep(database, automations, service, defaultAutomationConfig)
})

after(async () => {
  await sweep.close()
  await throwaway.dispose()
})

let sequence = 0

/** 种子：目录用户（个人空间由 0013 触发器自动创建）+ 已发布 Agent。 */
async function seedOwner(prefix: string) {
  const userId = `${prefix}-owner-${sequence++}`
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values (${userId}, ${tenantId}, ${`directory:${userId}`}, '自动任务测试用户', 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${userId}, 'role-employee', 'local')
  `
  const [workspace] = await database<{ id: string }[]>`
    select id from workspaces
     where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${userId}
  `
  if (!workspace) throw new Error('个人空间未自动创建')
  const agentId = `${prefix}-agent`
  const versionId = `${prefix}-version`
  await database`
    insert into agents (id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status, active_version_id)
    values (${agentId}, ${tenantId}, '自动任务测试 Agent', '', '', ${userId}, ${userId}, 'published', null)
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, system_prompt,
      visible_role_ids, data_scopes, skill_refs, tool_refs, status, created_by
    ) values (
      ${versionId}, ${tenantId}, ${agentId}, '1.0.0', '自动任务测试 Agent', '', '你是自动任务集成测试 Agent，请准确完成任务输入。',
      ${database.json(['role-employee'])}, ${database.json(['enterprise:authorized'])},
      '[]', '[]', 'published', ${userId}
    )
  `
  await database`
    update agents set active_version_id = ${versionId}
     where tenant_id = ${tenantId} and id = ${agentId}
  `
  return { userId, workspaceId: workspace.id, agentId, versionId }
}

test('创建为草稿并携带 Agent 展示字段；启用后算出下一槽位', async () => {
  const { userId, workspaceId, agentId } = await seedOwner('lifecycle')
  const created = await service.create(userId, {
    name: '每日摘要',
    agentId,
    workspaceId,
    schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '09:00' },
    inputTemplate: { prompt: '生成摘要' },
  })
  assert.equal(created.status, 'draft')
  assert.equal(created.agentId, agentId)
  assert.equal(created.agentName, '自动任务测试 Agent')
  assert.equal(created.agentVersion, '1.0.0')

  const enabled = await service.enable(userId, created.id)
  assert.equal(enabled.status, 'enabled')
  assert.ok(enabled.nextSlotUtc)
  assert.ok(enabled.scopeCeiling.roleIds?.includes('role-employee'))

  const list = await service.listMine(userId)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.name, '每日摘要')
})

test('团队空间自动任务创建/更新时要求 Agent 已加入该空间', async () => {
  const { userId, agentId, versionId } = await seedOwner('team-agent-member')
  const workspaceId = `ws-team-automation-${randomUUID()}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '自动任务团队空间', '', 'team', ${userId}, 'active')
  `
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${workspaceId}, ${userId}, 'owner', ${userId})
  `
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, ${workspaceId}, 'agent', ${versionId})
  `

  await assert.rejects(
    () => service.create(userId, {
      name: '团队任务',
      agentId,
      workspaceId,
      schedule: { kind: 'manual', timezone: 'UTC' },
      inputTemplate: { prompt: '执行' },
    }),
    /Agent 未加入该团队空间/,
  )

  await database`
    insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
    values (${`wam-${randomUUID()}`}, ${tenantId}, ${workspaceId}, ${agentId}, ${versionId}, 'available', ${userId})
  `
  const created = await service.create(userId, {
    name: '团队任务',
    agentId,
    workspaceId,
    schedule: { kind: 'manual', timezone: 'UTC' },
    inputTemplate: { prompt: '执行' },
  })
  assert.equal(created.workspaceId, workspaceId)

  const otherWorkspaceId = `ws-team-automation-other-${randomUUID()}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${otherWorkspaceId}, ${tenantId}, '未加入 Agent 的团队空间', '', 'team', ${userId}, 'active')
  `
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${otherWorkspaceId}, ${userId}, 'owner', ${userId})
  `
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, ${otherWorkspaceId}, 'agent', ${versionId})
  `
  await assert.rejects(
    () => service.update(userId, created.id, { workspaceId: otherWorkspaceId }),
    /Agent 未加入该团队空间/,
  )
})

test('runNow 原子受理：Session/Run/执行记录齐备；同幂等键重放不产生新 Run', async () => {
  const { userId, workspaceId, agentId } = await seedOwner('runnow')
  const created = await service.create(userId, {
    name: '手动任务',
    agentId,
    workspaceId,
    schedule: { kind: 'manual', timezone: 'UTC' },
    inputTemplate: { prompt: '手动执行' },
  })
  await service.enable(userId, created.id)

  const key = randomUUID()
  const first = await service.runNow(userId, created.id, key)
  assert.equal(first.admissionStatus, 'accepted')
  assert.ok(first.sessionId && first.runId)
  assert.equal(first.kind, 'manual')

  const replay = await service.runNow(userId, created.id, key)
  assert.equal(replay.id, first.id)
  assert.equal(replay.runId, first.runId)

  const executions = await service.listExecutions(userId, created.id)
  assert.equal(executions.length, 1)
  // I-06：受理≠执行完成≠业务达成。dispatch 在后台并发推进，读取时 Run
  // 可以仍在 queued，也可以已经 running；两种状态的核验结果都必须是 pending。
  assert.ok(['queued', 'running'].includes(executions[0]!.runStatus ?? ''))
  assert.equal(executions[0]!.resultOutcome, 'pending')
})

test('重叠触发被跳过并记录 overlap 原因', async () => {
  const { userId, workspaceId, agentId } = await seedOwner('overlap')
  const created = await service.create(userId, {
    name: '重叠任务',
    agentId,
    workspaceId,
    schedule: { kind: 'manual', timezone: 'UTC' },
    inputTemplate: { prompt: '执行' },
  })
  await service.enable(userId, created.id)

  const first = await service.runNow(userId, created.id, randomUUID())
  assert.equal(first.admissionStatus, 'accepted')

  // 第一个 Run 停在 queued（HoldingRuntime 不完成）→ 新幂等键触发被判重叠
  const second = await service.runNow(userId, created.id, randomUUID())
  assert.equal(second.admissionStatus, 'skipped')
  assert.equal(second.reasonCode, 'overlap')
  assert.equal(second.runId, null)

  // I-06：未受理（无关联 Run）的执行没有结果核验状态。
  const listed = await service.listExecutions(userId, created.id)
  assert.equal(listed.find(execution => execution.id === second.id)?.resultOutcome, null)
})

test('触发扫描受理到期槽位且推进游标；二次扫描不重复', async () => {
  const { userId, workspaceId, agentId } = await seedOwner('sweep')
  // timeOfDay 取「5 分钟前」的 UTC 墙钟：今天的槽位在迟到容差内 → 正常受理。
  const slotTime = new Date(Date.now() - 5 * 60_000)
  const timeOfDay = slotTime.toISOString().slice(11, 16)
  const created = await service.create(userId, {
    name: '定时任务',
    agentId,
    workspaceId,
    schedule: { kind: 'daily', timezone: 'UTC', timeOfDay },
    inputTemplate: { prompt: '定时执行' },
  })
  await service.enable(userId, created.id)

  // enable 算的下一槽是明天；把游标拨回今天的槽位制造「到期」。
  const dueSlot = new Date(slotTime)
  dueSlot.setUTCSeconds(0, 0)
  await database`
    update agent_automations set next_slot_utc = ${dueSlot.toISOString()}
     where tenant_id = ${tenantId} and id = ${created.id}
  `

  await sweep.tick()
  const executions = await service.listExecutions(userId, created.id)
  assert.equal(executions.length, 1)
  assert.equal(executions[0]!.kind, 'scheduled')
  assert.equal(executions[0]!.admissionStatus, 'accepted')
  assert.ok(executions[0]!.runId)

  const refreshed = await service.getMine(userId, created.id)
  assert.ok(refreshed.nextSlotUtc! > new Date().toISOString())

  await sweep.tick()
  assert.equal((await service.listExecutions(userId, created.id)).length, 1)
})

test('账号停用后触发被跳过且记录授权原因', async () => {
  const { userId, workspaceId, agentId } = await seedOwner('revoked')
  const created = await service.create(userId, {
    name: '撤权任务',
    agentId,
    workspaceId,
    schedule: { kind: 'manual', timezone: 'UTC' },
    inputTemplate: { prompt: '执行' },
  })
  await service.enable(userId, created.id)
  await database`update users set status = 'disabled' where tenant_id = ${tenantId} and id = ${userId}`

  const execution = await service.runNow(userId, created.id, randomUUID())
  assert.equal(execution.admissionStatus, 'skipped')
  // 主体解析（账号停用）在授权决策之前失败 → subject_invalid；
  // authorization_denied 留给角色/范围交集阶段的拒绝。
  assert.equal(execution.reasonCode, 'subject_invalid')
  assert.equal(execution.runId, null)
})

test('受理已提交但 Attempt 未建的执行在启动恢复时收敛为 interrupted', async () => {
  const { userId, workspaceId, agentId, versionId } = await seedOwner('recovery')
  const created = await service.create(userId, {
    name: '恢复任务',
    agentId,
    workspaceId,
    schedule: { kind: 'manual', timezone: 'UTC' },
    inputTemplate: { prompt: '执行' },
  })
  await service.enable(userId, created.id)

  // 手工构造「受理提交后、dispatch 前进程中断」现场：Session+Run+accepted 执行，
  // Run 停在无 Attempt 的 queued。
  const session = await conversations.createSession({
    userId, title: '恢复现场', workspaceId, agentVersionId: versionId,
  })
  const run = await runs.createRun({
    tenantId, sessionId: session.id, requestedBy: userId, idempotencyKey: randomUUID(),
  })
  await database.begin(async (tx) => {
    await automations.insertExecution(tx, {
      automationId: created.id,
      triggerId: `manual|${created.id}|${randomUUID()}`,
      kind: 'manual',
      plannedSlotUtc: new Date().toISOString(),
      taskRevision: 1,
      scheduleRevision: 1,
      sessionId: session.id,
      runId: run.id,
      admissionStatus: 'accepted',
    })
  })

  const recovered = await service.recoverInterruptedPreparations()
  assert.ok(recovered >= 1)
  const executions = await service.listExecutions(userId, created.id)
  const target = executions.find(item => item.runId === run.id)
  assert.equal(target?.admissionStatus, 'interrupted')
  assert.equal(target?.reasonCode, 'dispatch_interrupted')
  const [runRow] = await database<{ status: string }[]>`
    select status from runs where tenant_id = ${tenantId} and id = ${run.id}
  `
  assert.equal(runRow?.status, 'failed')
})

test('暂停后触发跳过；非 owner 不可见', async () => {
  const { userId, workspaceId, agentId } = await seedOwner('pause')
  const created = await service.create(userId, {
    name: '暂停任务',
    agentId,
    workspaceId,
    schedule: { kind: 'manual', timezone: 'UTC' },
    inputTemplate: { prompt: '执行' },
  })
  await service.enable(userId, created.id)
  await service.pause(userId, created.id)

  await assert.rejects(() => service.runNow(userId, created.id, randomUUID()), /未启用/)

  await assert.rejects(() => service.getMine('U-other', created.id))
  assert.equal((await service.listMine('U-other')).length, 0)
})

test('暂停收敛已受理但未开始的执行：queued Run/Attempt 一并取消', async () => {
  const { userId, workspaceId, agentId, versionId } = await seedOwner('pause-converge')
  const created = await service.create(userId, {
    name: '暂停收敛任务',
    agentId,
    workspaceId,
    schedule: { kind: 'manual', timezone: 'UTC' },
    inputTemplate: { prompt: '执行' },
  })
  await service.enable(userId, created.id)

  // 构造「已受理、Attempt 已建、仍 queued 未领取」的执行现场。
  const session = await conversations.createSession({
    userId, title: '暂停收敛现场', workspaceId, agentVersionId: versionId,
  })
  const run = await runs.createRun({
    tenantId, sessionId: session.id, requestedBy: userId, idempotencyKey: randomUUID(),
  })
  const attempt = await runs.createAttempt({
    attemptId: `attempt-${randomUUID()}`,
    tenantId,
    runId: run.id,
    runtimeId: 'runtime-local-01',
    manifest: testAttemptManifest(run.taskId, run.id, { purpose: 'automation' }),
    manifestSha256: 'test-manifest-sha',
    modelRouteSnapshot: {},
  })
  await database.begin(async (tx) => {
    await automations.insertExecution(tx, {
      automationId: created.id,
      triggerId: `manual|${created.id}|${randomUUID()}`,
      kind: 'manual',
      plannedSlotUtc: new Date().toISOString(),
      taskRevision: 1,
      scheduleRevision: 1,
      sessionId: session.id,
      runId: run.id,
      admissionStatus: 'accepted',
    })
  })

  await service.pause(userId, created.id)

  const [runRow] = await database<{ status: string; currentAttemptId: string | null }[]>`
    select status, current_attempt_id as "currentAttemptId"
      from runs where tenant_id = ${tenantId} and id = ${run.id}
  `
  assert.equal(runRow?.status, 'cancelled')
  const [attemptRow] = await database<{ status: string }[]>`
    select status from run_attempts where tenant_id = ${tenantId} and id = ${attempt.id}
  `
  assert.equal(attemptRow?.status, 'cancelled')
  const target = (await service.listExecutions(userId, created.id))
    .find(item => item.runId === run.id)
  assert.equal(target?.admissionStatus, 'interrupted')
  assert.equal(target?.reasonCode, 'task_paused')
})

test('weekly 规则按语义比较：jsonb 键序差异不误增 schedule_revision', async () => {
  const { userId, workspaceId, agentId } = await seedOwner('sched-order')
  const created = await service.create(userId, {
    name: '周更任务',
    agentId,
    workspaceId,
    schedule: { kind: 'weekly', timezone: 'Asia/Shanghai', timeOfDay: '09:30', weekdays: [1, 3, 5] },
    inputTemplate: { prompt: '执行' },
  })
  const before = await service.getMine(userId, created.id)

  // 键序不同的同义规则（模拟 jsonb 读回重排）：不应判定为调度变更。
  const reordered = JSON.parse(
    '{"weekdays":[1,3,5],"timeOfDay":"09:30","timezone":"Asia/Shanghai","kind":"weekly"}',
  )
  const updated = await service.update(userId, created.id, { schedule: reordered })
  assert.equal(updated.scheduleRevision, before.scheduleRevision)

  // 真实调度变更仍会递增 schedule_revision。
  const changed = await service.update(userId, created.id, {
    schedule: { kind: 'weekly', timezone: 'Asia/Shanghai', timeOfDay: '10:00', weekdays: [1, 3, 5] },
  })
  assert.equal(changed.scheduleRevision, before.scheduleRevision + 1)
})

test('授权基础设施错误不落 skipped：异常抛出、游标不动、恢复后重试成功', async () => {
  const { userId, workspaceId, agentId } = await seedOwner('authz-flaky')
  const created = await service.create(userId, {
    name: '授权抖动任务',
    agentId,
    workspaceId,
    schedule: { kind: 'daily', timezone: 'UTC', timeOfDay: '00:00' },
    inputTemplate: { prompt: '执行' },
  })
  await service.enable(userId, created.id)
  const enabled = await service.getMine(userId, created.id)
  const slot = new Date(enabled.nextSlotUtc!)
  const next = nextSlotUtc(enabled.schedule, slot)?.toISOString() ?? null

  // 注入一次非授权类错误（模拟 DB/网络抖动）：不应落成 authorization_denied。
  let injected: Error | null = new Error('simulated connection reset')
  const flakyAuthorization = new Proxy(authorization, {
    get(target, prop, receiver) {
      if (prop === 'authorizeRuntime') {
        return (...args: Parameters<PostgresAuthorizationService['authorizeRuntime']>) => {
          if (injected) {
            const error = injected
            injected = null
            return Promise.reject(error)
          }
          return target.authorizeRuntime(...args)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  const flakyService = new AutomationService(
    database, automations, conversations, runs, orchestration,
    flakyAuthorization, agents, content, undefined, defaultAutomationConfig,
  )

  await assert.rejects(
    () => flakyService.processScheduledSlot(created.id, slot, enabled.nextSlotUtc!, next),
    /connection reset/,
  )
  // 游标未推进、也没有落 skipped 记录——槽位保留给下个 tick 重试。
  const after = await service.getMine(userId, created.id)
  assert.equal(after.nextSlotUtc, enabled.nextSlotUtc)
  assert.equal((await service.listExecutions(userId, created.id)).length, 0)

  // 恢复后同一槽位可正常受理。
  const retried = await service.processScheduledSlot(created.id, slot, enabled.nextSlotUtc!, next)
  assert.equal(retried?.admissionStatus, 'accepted')
})

test('cancelQueuedRun 与领取竞态：Attempt 被先锁走时不取消', async () => {
  const { userId, workspaceId, versionId } = await seedOwner('cancel-race')
  const session = await conversations.createSession({
    userId, title: '竞态现场', workspaceId, agentVersionId: versionId,
  })
  const run = await runs.createRun({
    tenantId, sessionId: session.id, requestedBy: userId, idempotencyKey: randomUUID(),
  })
  const attempt = await runs.createAttempt({
    attemptId: `attempt-${randomUUID()}`,
    tenantId,
    runId: run.id,
    runtimeId: 'runtime-local-01',
    manifest: testAttemptManifest(run.taskId, run.id, { purpose: 'automation' }),
    manifestSha256: 'test-manifest-sha',
    modelRouteSnapshot: {},
  })

  // tx 先持 attempt 行锁并推进到 running（模拟 claimAttempt 成功路径）；
  // cancelQueuedRun 必须阻塞并在锁释放后按新状态判定为「不可取消」，
  // 而不是反过来持 run 锁与 claim 成环死锁。
  let cancelPromise: Promise<boolean> | null = null
  await database.begin(async (tx) => {
    await tx`select id from run_attempts where tenant_id = ${tenantId} and id = ${attempt.id} for update`
    cancelPromise = runs.cancelQueuedRun(tenantId, run.id)
    await tx`update run_attempts set status = 'running' where tenant_id = ${tenantId} and id = ${attempt.id}`
    await tx`update runs set status = 'running' where tenant_id = ${tenantId} and id = ${run.id}`
  })
  assert.equal(await cancelPromise!, false)
  const [runRow] = await database<{ status: string }[]>`
    select status from runs where tenant_id = ${tenantId} and id = ${run.id}
  `
  assert.equal(runRow?.status, 'running')
})

test('sweep close 完整释放 advisory lock（无重入计数残留）', async () => {
  const probe = new AutomationTriggerSweep(database, automations, service, defaultAutomationConfig)
  assert.equal(await probe.start(), true)
  await probe.close()
  // 从池化连接尝试拿锁：若探活曾用 pg_try_advisory_lock 累积重入计数而
  // close 只解一次，这里会返回 false（锁仍挂在被归还的会话上）。
  const [row] = await database<{ ok: boolean }[]>`
    select pg_try_advisory_lock(hashtext('dsh-work-automation-trigger-sweep')) as ok
  `
  assert.equal(row?.ok, true)
  if (row?.ok) {
    await database`select pg_advisory_unlock(hashtext('dsh-work-automation-trigger-sweep'))`
  }
})
