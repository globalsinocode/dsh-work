import { createHash, randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { PostgresAuthorizationService, RuntimeAuthorizationDecision } from '../authorization/postgres-authorization-service.ts'
import { authorizationDenied, requestInvalid } from '../authorization/authorization-errors.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { RunRepository } from './run-repository.ts'
import type { TaskRepository } from '../task/task-repository.ts'
import type { PostgresTaskQueryService } from '../task/postgres-task-query-service.ts'
import { canonicalJson } from '../runtime/canonical-json.ts'
import type { RunRecord } from './run-types.ts'

const tenantId = 'tenant-dsh-work'
const runtimeId = 'runtime-local-01'
const terminal = new Set(['succeeded', 'failed', 'cancelled'])

export interface DelegatedTaskResult {
  contract: 'task-result/v1'
  delegationId: string
  childTaskId: string
  childRunId: string
  targetAgentVersionId: string
  execution: 'succeeded' | 'failed' | 'cancelled'
  outcome: 'achieved' | 'unverified' | 'not_achieved'
  summary: string
  answer: string | null
  receipts: Array<{ kind: 'artifact' | 'tool'; status: 'completed' | 'accepted' | 'failed' | 'unknown'; ref: string }>
}

interface DelegationRow {
  id: string
  rootTaskId: string
  parentTaskId: string
  parentRunId: string
  parentAttemptId: string
  childTaskId: string
  childRunId: string
  targetAgentVersionId: string
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
  result: DelegatedTaskResult | null
  errorCode: string | null
}

interface DelegationExecutor {
  dispatchChild(input: {
    run: RunRecord
    prompt: string
    context: string
    workspaceId: string
    targetAgentVersionId: string
    userId: string
    authorization: RuntimeAuthorizationDecision
    delegation: NonNullable<RuntimeManifest['delegation_context']>
  }): Promise<void>
  cancelRun(runId: string, reason: string): Promise<void>
}

/** PF-06 durable parent/child coordination. Model reasoning remains inside DSH. */
export class PostgresAgentDelegationService {
  private executor?: DelegationExecutor
  private readonly database: DatabaseClient
  private readonly runs: RunRepository
  private readonly tasks: TaskRepository
  private readonly authorization: PostgresAuthorizationService
  private readonly taskQueries: PostgresTaskQueryService

  constructor(
    database: DatabaseClient,
    runs: RunRepository,
    tasks: TaskRepository,
    authorization: PostgresAuthorizationService,
    taskQueries: PostgresTaskQueryService,
  ) {
    this.database = database
    this.runs = runs
    this.tasks = tasks
    this.authorization = authorization
    this.taskQueries = taskQueries
  }

  setExecutor(executor: DelegationExecutor): void { this.executor = executor }

  async delegate(input: Record<string, unknown>, parent: RuntimeManifest, signal: AbortSignal): Promise<DelegatedTaskResult> {
    const executor = this.executor
    if (!executor) throw unavailable('受控委派执行器尚未就绪')
    const targetAgentVersionId = requiredString(input['targetAgentVersionId'], 'targetAgentVersionId', 128)
    const task = requiredString(input['task'], 'task', 12000)
    const context = optionalString(input['context'], 'context', 4000)
    const policy = parent.delegation_policy
    if (!policy || !policy.allowed_agent_version_ids.includes(targetAgentVersionId)) {
      throw authorizationDenied('目标 Agent Version 不在当前父 Agent 的委派允许范围内')
    }
    const currentDepth = parent.delegation_context?.depth ?? 0
    const inheritedMaxDepth = parent.delegation_context?.max_depth ?? policy.max_depth
    const maxDepth = Math.min(inheritedMaxDepth, policy.max_depth)
    const childDepth = currentDepth + 1
    if (childDepth > maxDepth) throw conflict('DELEGATION_DEPTH_EXCEEDED', `委派深度已达到上限 ${maxDepth}`)
    if (!parent.workspace_id || !parent.agent_version_id) throw requestInvalid('只有工作空间内的已发布 Agent 才能委派子任务')

    const workspaceType = await this.authorization.workspaceTypeOf(parent.workspace_id)
    if (workspaceType === null) throw authorizationDenied('工作空间不存在或已归档')
    const authorizationInput = {
      userId: parent.user_context.user_id,
      workspaceId: parent.workspace_id,
      agentVersionId: targetAgentVersionId,
      scopeCeiling: {
        roleIds: parent.user_context.role_ids,
        dataScopes: parent.data_scopes,
      },
    }
    const authorization = workspaceType === 'team'
      ? await this.authorization.authorizeTeamRunExecution({ ...authorizationInput, requireAgentMember: true })
      : await this.authorization.authorizeRuntime(authorizationInput)
    const requestDigest = createHash('sha256').update(canonicalJson({ targetAgentVersionId, task, context })).digest('hex')
    const delegationId = `delegation-${randomUUID()}`
    const childTaskId = `task-${randomUUID()}`
    let childRun!: RunRecord
    let created = false

    const record = await this.database.begin(async tx => {
      // Match the scheduler's lock order (workspace -> runtime). Holding the
      // workspace row also prevents archive from racing child admission.
      const [workspace] = await tx<{ id: string }[]>`
        select id from workspaces
         where tenant_id = ${tenantId} and id = ${parent.workspace_id} and status = 'active'
         for update
      `
      if (!workspace) throw authorizationDenied('工作空间不存在或已归档')
      const [lockedParent] = await tx<{ status: string; currentAttemptId: string | null }[]>`
        select status, current_attempt_id as "currentAttemptId" from runs
         where tenant_id = ${tenantId} and id = ${parent.run_id} and task_id = ${parent.task_id}
         for update
      `
      if (!lockedParent || lockedParent.status !== 'running' || lockedParent.currentAttemptId !== parent.attempt_id) {
        throw conflict('DELEGATION_PARENT_INACTIVE', '父任务已不在当前运行 Attempt，不能创建新的委派')
      }
      const [existing] = await tx<DelegationRow[]>`
        select id, root_task_id as "rootTaskId", parent_task_id as "parentTaskId",
               parent_run_id as "parentRunId", parent_attempt_id as "parentAttemptId",
               child_task_id as "childTaskId", child_run_id as "childRunId",
               target_agent_version_id as "targetAgentVersionId", status, result, error_code as "errorCode"
          from task_delegations
         where tenant_id = ${tenantId} and parent_attempt_id = ${parent.attempt_id}
           and request_digest = ${requestDigest}
      `
      if (existing) return existing
      const [active] = await tx<{ count: number }[]>`
        select count(*)::integer as count from task_delegations
         where tenant_id = ${tenantId} and parent_task_id = ${parent.task_id}
           and status in ('accepted', 'running')
      `
      if ((active?.count ?? 0) >= policy.max_parallel) {
        throw conflict('DELEGATION_PARALLEL_LIMIT', `当前父任务的并行委派已达到上限 ${policy.max_parallel}`)
      }
      // Serialize delegation admission with Attempt claiming on the Runtime row.
      // A relationship whose child has no Attempt yet or is still queued reserves
      // one Worker, so concurrent parents cannot all occupy Workers and then wait
      // forever for children that have no slot to claim.
      const [capacity] = await tx<{ capacity: number; schedulingStatus: string; active: number; reserved: number }[]>`
        select r.capacity, r.scheduling_status as "schedulingStatus",
               (select count(*)::integer from run_attempts a
                 where a.tenant_id = r.tenant_id and a.runtime_id = r.id
                   and a.status in ('running', 'cancel_requested')) as active,
               (select count(*)::integer from task_delegations d
                 join runs child on child.tenant_id = d.tenant_id and child.id = d.child_run_id
                 left join run_attempts child_attempt
                   on child_attempt.tenant_id = child.tenant_id and child_attempt.id = child.current_attempt_id
                where d.tenant_id = r.tenant_id and d.status in ('accepted', 'running')
                  and (child.current_attempt_id is null or child_attempt.status = 'queued')) as reserved
          from runtimes r
         where tenant_id = ${tenantId} and id = ${runtimeId}
         for update
      `
      if (!capacity || capacity.schedulingStatus !== 'accepting'
        || capacity.capacity < childDepth + 1
        || capacity.active + capacity.reserved >= capacity.capacity) {
        throw unavailable(`Runtime 容量不足以安全执行深度 ${childDepth} 的同步委派`)
      }
      const childTask = await this.tasks.createTask({
        taskId: childTaskId,
        tenantId,
        requestedBy: parent.user_context.user_id,
        sourceType: 'delegation',
        sourceRef: parent.task_id,
        correlationKey: `delegation:${parent.attempt_id}:${requestDigest}`,
        requestDigest,
        budgetScopeTaskId: parent.budget.scope_task_id,
        workspaceId: parent.workspace_id,
        sessionId: null,
      }, tx)
      childRun = await this.runs.createRun({
        tenantId,
        taskId: childTask.id,
        sessionId: null,
        workspaceId: parent.workspace_id,
        requestedBy: parent.user_context.user_id,
        idempotencyKey: `delegation:${parent.attempt_id}:${requestDigest}`,
      }, tx)
      await tx`
        insert into task_delegations (
          id, tenant_id, root_task_id, parent_task_id, parent_run_id, parent_attempt_id,
          child_task_id, child_run_id, target_agent_version_id, request_digest, prompt,
          context, depth, role_ceiling, data_scope_ceiling, status
        ) values (
          ${delegationId}, ${tenantId}, ${parent.budget.scope_task_id}, ${parent.task_id},
          ${parent.run_id}, ${parent.attempt_id}, ${childTask.id}, ${childRun.id},
          ${targetAgentVersionId}, ${requestDigest}, ${task}, ${tx.json({ text: context })},
          ${childDepth}, ${tx.json(parent.user_context.role_ids)}, ${tx.json(parent.data_scopes)}, 'accepted'
        )
      `
      created = true
      return {
        id: delegationId, rootTaskId: parent.budget.scope_task_id, parentTaskId: parent.task_id,
        parentRunId: parent.run_id, parentAttemptId: parent.attempt_id,
        childTaskId: childTask.id, childRunId: childRun.id, targetAgentVersionId,
        status: 'accepted' as const, result: null, errorCode: null,
      }
    })

    if (record.result) return record.result
    if (record.status === 'timed_out') {
      throw conflict('DELEGATION_TIMEOUT', `委派子任务在 ${policy.timeout_seconds} 秒内未完成`)
    }
    if (record.status === 'failed') {
      throw conflict(record.errorCode ?? 'DELEGATION_FAILED', '委派子任务未能开始或已失败')
    }
    childRun = childRun ?? (await this.runs.getRun(tenantId, record.childRunId))!
    if (!childRun) throw conflict('DELEGATION_STATE_CONFLICT', '委派记录缺少子 Run')
    if (created) {
      const delegation = {
        delegation_id: record.id,
        root_task_id: record.rootTaskId,
        parent_task_id: record.parentTaskId,
        parent_run_id: record.parentRunId,
        parent_attempt_id: record.parentAttemptId,
        depth: childDepth,
        max_depth: maxDepth,
        role_ceiling: [...parent.user_context.role_ids],
        data_scope_ceiling: [...parent.data_scopes],
      }
      try {
        await executor.dispatchChild({
          run: childRun, prompt: task, context, workspaceId: parent.workspace_id,
          targetAgentVersionId, userId: parent.user_context.user_id, authorization, delegation,
        })
      } catch (error) {
        await this.failBeforeDispatch(record.id, childRun, error)
        throw error
      }
    }

    const deadline = Date.now() + policy.timeout_seconds * 1000
    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        const run = await this.runs.getRun(tenantId, record.childRunId)
        if (!run) throw conflict('DELEGATION_STATE_CONFLICT', '委派子 Run 不存在')
        if (terminal.has(run.status)) return this.finalize(record.id, run, targetAgentVersionId)
        await abortableDelay(100, signal)
      }
    } catch (error) {
      await executor.cancelRun(record.childRunId, signal.aborted ? '父 Attempt 已结束，取消委派子任务' : '委派等待被中断').catch(() => undefined)
      throw error
    }
    await executor.cancelRun(record.childRunId, '委派执行超过父 Agent 配置的超时上限').catch(() => undefined)
    await this.database`
      update task_delegations set status = 'timed_out', error_code = 'DELEGATION_TIMEOUT', completed_at = now()
       where tenant_id = ${tenantId} and id = ${record.id} and status in ('accepted', 'running')
    `
    throw conflict('DELEGATION_TIMEOUT', `委派子任务在 ${policy.timeout_seconds} 秒内未完成`)
  }

  async assertActiveDelegation(manifest: RuntimeManifest): Promise<void> {
    const context = manifest.delegation_context
    if (!context) return
    const [row] = await this.database<{
      status: string; parentStatus: string; currentAttemptId: string | null
      rootTaskId: string; parentTaskId: string; parentRunId: string; parentAttemptId: string
      childTaskId: string; childRunId: string; targetAgentVersionId: string; depth: number
      roleCeiling: string[]; dataScopeCeiling: string[]
    }[]>`
      select d.status, r.status as "parentStatus", r.current_attempt_id as "currentAttemptId",
             d.root_task_id as "rootTaskId", d.parent_task_id as "parentTaskId",
             d.parent_run_id as "parentRunId", d.parent_attempt_id as "parentAttemptId",
             d.child_task_id as "childTaskId", d.child_run_id as "childRunId",
             d.target_agent_version_id as "targetAgentVersionId", d.depth,
             d.role_ceiling as "roleCeiling", d.data_scope_ceiling as "dataScopeCeiling"
        from task_delegations d
        join runs r on r.tenant_id = d.tenant_id and r.id = d.parent_run_id
       where d.tenant_id = ${tenantId} and d.id = ${context.delegation_id}
         and d.child_task_id = ${manifest.task_id} and d.child_run_id = ${manifest.run_id}
         and d.parent_attempt_id = ${context.parent_attempt_id}
    `
    const sameSet = (left: string[], right: string[]) => left.length === right.length
      && left.every(value => right.includes(value))
    if (!row || !['accepted', 'running'].includes(row.status)
      || row.parentStatus !== 'running' || row.currentAttemptId !== context.parent_attempt_id
      || row.rootTaskId !== context.root_task_id || row.parentTaskId !== context.parent_task_id
      || row.parentRunId !== context.parent_run_id || row.parentAttemptId !== context.parent_attempt_id
      || row.childTaskId !== manifest.task_id || row.childRunId !== manifest.run_id
      || row.targetAgentVersionId !== manifest.agent_version_id || row.depth !== context.depth
      || !sameSet(row.roleCeiling, context.role_ceiling)
      || !sameSet(row.dataScopeCeiling, context.data_scope_ceiling)) {
      throw authorizationDenied('父任务已结束或委派关系失效，子任务不能继续执行')
    }
  }

  async markChildRunning(childRunId: string): Promise<void> {
    await this.database`
      update task_delegations set status = 'running', started_at = coalesce(started_at, now())
       where tenant_id = ${tenantId} and child_run_id = ${childRunId} and status = 'accepted'
    `
  }

  async observeChildTerminal(childRunId: string): Promise<void> {
    const [row] = await this.database<{ id: string; targetAgentVersionId: string }[]>`
      select id, target_agent_version_id as "targetAgentVersionId" from task_delegations
       where tenant_id = ${tenantId} and child_run_id = ${childRunId}
    `
    if (!row) return
    const run = await this.runs.getRun(tenantId, childRunId)
    if (run && terminal.has(run.status)) await this.finalize(row.id, run, row.targetAgentVersionId)
  }

  async reconcileAfterRestart(): Promise<{ cancelled: number; finalized: number }> {
    if (!this.executor) return { cancelled: 0, finalized: 0 }
    const rows = await this.database<{
      id: string; parentAttemptId: string; parentStatus: RunRecord['status']; parentCurrentAttemptId: string | null
      childRunId: string; childStatus: RunRecord['status']; targetAgentVersionId: string
    }[]>`
      select d.id, d.parent_attempt_id as "parentAttemptId", parent.status as "parentStatus",
             parent.current_attempt_id as "parentCurrentAttemptId", d.child_run_id as "childRunId",
             child.status as "childStatus", d.target_agent_version_id as "targetAgentVersionId"
        from task_delegations d
        join runs parent on parent.tenant_id = d.tenant_id and parent.id = d.parent_run_id
        join runs child on child.tenant_id = d.tenant_id and child.id = d.child_run_id
       where d.tenant_id = ${tenantId} and d.status in ('accepted', 'running')
       order by d.created_at asc
    `
    let cancelled = 0
    let finalized = 0
    for (const row of rows) {
      if (terminal.has(row.childStatus)) {
        const child = await this.runs.getRun(tenantId, row.childRunId)
        if (child) {
          await this.finalize(row.id, child, row.targetAgentVersionId)
          finalized += 1
        }
        continue
      }
      if (row.parentStatus !== 'running' || row.parentCurrentAttemptId !== row.parentAttemptId) {
        await this.executor.cancelRun(row.childRunId, '服务恢复时父任务已失效，取消遗留委派子任务')
        cancelled += 1
      }
    }
    return { cancelled, finalized }
  }

  async cancelActiveDescendants(parentTaskId: string, reason: string): Promise<void> {
    if (!this.executor) return
    const rows = await this.database<{ childRunId: string }[]>`
      with recursive descendants as (
        select child_task_id, child_run_id from task_delegations
         where tenant_id = ${tenantId} and parent_task_id = ${parentTaskId}
           and status in ('accepted', 'running')
        union all
        select d.child_task_id, d.child_run_id from task_delegations d
        join descendants p on p.child_task_id = d.parent_task_id
         where d.tenant_id = ${tenantId} and d.status in ('accepted', 'running')
      ) select distinct child_run_id as "childRunId" from descendants
    `
    await Promise.allSettled(rows.map(row => this.executor!.cancelRun(row.childRunId, reason)))
  }

  private async finalize(delegationId: string, run: RunRecord, targetAgentVersionId: string): Promise<DelegatedTaskResult> {
    const execution = await this.taskQueries.get(run.taskId)
    if (!execution) throw conflict('DELEGATION_STATE_CONFLICT', '无法读取委派子任务结果')
    const receipts: DelegatedTaskResult['receipts'] = [
      ...execution.result.artifacts.map(item => ({ kind: 'artifact' as const, status: 'completed' as const, ref: item.versionId })),
      ...execution.result.operations.map(item => ({
        kind: 'tool' as const,
        status: item.status,
        ref: item.id,
      })),
    ]
    const allReceiptsCompleted = receipts.length > 0 && receipts.every(item => item.status === 'completed')
    const hasFailedReceipt = receipts.some(item => item.status === 'failed')
    const hasUnresolvedReceipt = receipts.some(item => item.status === 'accepted' || item.status === 'unknown')
    const outcome = run.status !== 'succeeded' || hasFailedReceipt
      ? 'not_achieved'
      : allReceiptsCompleted
        ? 'achieved'
        : 'unverified'
    const result: DelegatedTaskResult = {
      contract: 'task-result/v1', delegationId, childTaskId: run.taskId, childRunId: run.id,
      targetAgentVersionId, execution: run.status as DelegatedTaskResult['execution'], outcome,
      summary: outcome === 'achieved'
        ? '子任务完成，且存在平台登记的可核验交付证据。'
        : hasFailedReceipt
          ? '子任务存在失败的必要动作回执，目标未达成。'
          : hasUnresolvedReceipt
            ? '子任务执行成功，但仍有受理中或结果未知的必要动作，目标尚未核验完成。'
        : outcome === 'unverified'
          ? '子任务执行成功，但只有文本回答或缺少可核验交付证据。'
          : run.status === 'cancelled' ? '子任务已取消，目标未达成。' : '子任务执行失败，目标未达成。',
      answer: execution.result.answer,
      receipts,
    }
    const status = run.status === 'succeeded' ? 'succeeded' : run.status === 'cancelled' ? 'cancelled' : 'failed'
    await this.database`
      update task_delegations set status = ${status}, result = ${this.database.json(JSON.parse(JSON.stringify(result)))},
             error_code = ${status === 'failed' ? 'DELEGATED_RUN_FAILED' : null}, completed_at = coalesce(completed_at, now())
       where tenant_id = ${tenantId} and id = ${delegationId}
         and status in ('accepted', 'running')
    `
    return result
  }

  private async failBeforeDispatch(delegationId: string, run: RunRecord, error: unknown): Promise<void> {
    await this.runs.convergeUndispatchedRun(tenantId, run.id, 'failed')
    await this.database`
      update task_delegations set status = 'failed', error_code = 'DELEGATION_DISPATCH_FAILED', completed_at = now()
       where tenant_id = ${tenantId} and id = ${delegationId} and status = 'accepted'
    `
    void error
  }
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw requestInvalid(`${name} 必须是 1～${max} 个字符的字符串`)
  return value.trim()
}

function optionalString(value: unknown, name: string, max: number): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > max) throw requestInvalid(`${name} 必须是不超过 ${max} 个字符的字符串`)
  return value.trim()
}

function conflict(code: string, message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 409, code })
}

function unavailable(message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 503, code: 'DELEGATION_UNAVAILABLE' })
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
