import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { authorizationDenied } from '../authorization/authorization-errors.ts'
import type { AppendSystemEventInput, RestartRecoveryResult, RunRepository, WorkspaceActiveRun } from './run-repository.ts'
import { assertAttemptTransition, assertRunTransition, isAttemptTerminalState } from './run-state-machine.ts'
import type {
  AttemptState,
  CreateAttemptInput,
  CreateRunInput,
  JsonObject,
  RunAttemptRecord,
  RunRecord,
  RunState,
  StoredRunEvent,
} from './run-types.ts'
import { PostgresTaskRepository, TaskContractConflictError } from '../task/postgres-task-repository.ts'
import { TaskBudgetExceededError } from '../task/task-budget-types.ts'

interface RunRow {
  id: string
  tenantId: string
  taskId: string
  sessionId: string | null
  requestedBy: string
  idempotencyKey: string
  status: RunState
  currentAttemptId: string | null
  createdAt: Date
  updatedAt: Date
}

interface AttemptRow {
  id: string
  tenantId: string
  runId: string
  attemptNo: number
  runtimeId: string | null
  manifest: JsonObject
  manifestSha256: string
  modelRouteSnapshot: JsonObject
  status: AttemptState
  startedAt: Date | null
  endedAt: Date | null
  errorCode: string | null
  createdAt: Date
}

interface EventRow {
  id: string
  tenantId: string
  runId: string
  attemptId: string
  sequence: string | number
  eventType: string
  displayMessage: string | null
  safeMetadata: JsonObject
  traceId: string
  occurredAt: Date
  streamPosition: string | number
}

interface RecoveryRow extends AttemptRow {
  runTaskId: string
  runSessionId: string | null
  runRequestedBy: string
  runIdempotencyKey: string
  runStatus: RunState
  runCurrentAttemptId: string | null
  runCreatedAt: Date
  runUpdatedAt: Date
}

/**
 * The Runtime adapter numbers its own events while server-authored notes
 * allocate `max(sequence)+1`; two concurrent writers can therefore pick the
 * same per-attempt sequence. Writers retry on that unique key instead of
 * failing the event. Bounded so a persistent conflict surfaces as an error.
 */
const SEQUENCE_CONFLICT_RETRIES = 3
const RUN_EVENT_SEQUENCE_CONSTRAINT = 'run_events_tenant_id_attempt_id_sequence_key'
/** Server-authored notes are identifiable by id, so dedupe never matches a runtime event of the same type. */
const SYSTEM_EVENT_ID_PREFIX_LIKE = 'event-system-%'

function isSequenceConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint_name?: unknown }
  return candidate.code === '23505' && candidate.constraint_name === RUN_EVENT_SEQUENCE_CONSTRAINT
}

export class PostgresRunRepository implements RunRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async createRun(input: CreateRunInput, tx?: DatabaseTransaction): Promise<RunRecord> {
    const runId = `run-${randomUUID()}`
    const body = async (transaction: DatabaseTransaction) => {
      // 3-T2 lock order: workspaces -> sessions -> runs. Taking the workspace
      // row lock before the session row is what serializes "start a new run"
      // with archive (which locks the same row first). Any other order would
      // let the two interleave and a queued run could survive an archive.
      // TW-10：仓储层不再校验会话属主——团队会话是共享讨论，任何具备写轨
      // 角色的成员都能在他人发起的会话中创建 Run；授权由调用方
      // （RunOrchestrationService.requireSessionAccess / requireSession）
      // 在受理前完成，这里只校验会话存在且活跃。
      if (input.sessionId) await lockActiveWorkspaceForSession(transaction, input.tenantId, input.sessionId)
      else if (input.workspaceId) await lockActiveWorkspace(transaction, input.tenantId, input.workspaceId)
      const [session] = input.sessionId
        ? await transaction<{ id: string; workspaceId: string | null }[]>`
            select id, workspace_id as "workspaceId" from sessions
             where tenant_id = ${input.tenantId} and id = ${input.sessionId}
               and status = 'active'
             for update
          `
        : []
      if (input.sessionId && !session) throw new Error(`Session 不存在或不可访问：${input.sessionId}`)
      const workspaceId = session?.workspaceId ?? input.workspaceId ?? null
      if (!input.sessionId && !workspaceId) throw new TypeError('无 Session Run 必须提供 workspaceId')
      if (!input.sessionId && !input.taskId && (!input.taskSourceType || input.taskSourceType === 'session')) {
        throw new TypeError('无 Session Run 必须提供非 Session 的 Task 来源')
      }

      const tasks = new PostgresTaskRepository(this.database)
      const task = input.taskId
        ? await tasks.getTask(input.tenantId, input.taskId, transaction)
        : await tasks.createTask({
            tenantId: input.tenantId,
            requestedBy: input.requestedBy,
            sourceType: input.taskSourceType ?? 'session',
            sourceRef: input.taskSourceRef ?? input.sessionId,
            correlationKey: input.taskCorrelationKey
              ?? `${input.sessionId}:${input.requestedBy}:${input.idempotencyKey}`,
            requestDigest: input.taskRequestDigest,
            budget: input.taskBudget,
            workspaceId,
            sessionId: input.sessionId,
          }, transaction)
      if (!task) throw new Error(`Task 不存在：${input.taskId}`)
      if (task.requestedBy !== input.requestedBy
        || (task.sessionId !== null && task.sessionId !== input.sessionId)
        || (task.workspaceId !== null && task.workspaceId !== workspaceId)) {
        throw new TaskContractConflictError('Run 与 Task 的身份、Session 或 Workspace 归属不一致')
      }
      const [taskRun] = await transaction<RunRow[]>`
        select id, tenant_id as "tenantId", task_id as "taskId", session_id as "sessionId",
               requested_by as "requestedBy", idempotency_key as "idempotencyKey", status,
               current_attempt_id as "currentAttemptId", created_at as "createdAt", updated_at as "updatedAt"
          from runs
         where tenant_id = ${input.tenantId} and task_id = ${task.id}
         for update
      `
      if (taskRun) {
        if (taskRun.sessionId !== input.sessionId || taskRun.requestedBy !== input.requestedBy) {
          throw new TaskContractConflictError('Task 已绑定到不同的 Run 执行上下文')
        }
        return mapRun(taskRun)
      }

      const [created] = await transaction<RunRow[]>`
        insert into runs (
          id, tenant_id, task_id, session_id, requested_by, idempotency_key, status
        ) values (
          ${runId}, ${input.tenantId}, ${task.id}, ${input.sessionId}, ${input.requestedBy}, ${input.idempotencyKey}, 'queued'
        )
        on conflict do nothing
        returning id, tenant_id as "tenantId", task_id as "taskId", session_id as "sessionId", requested_by as "requestedBy",
                  idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
                  created_at as "createdAt", updated_at as "updatedAt"
      `
      if (created) return mapRun(created)
      const [concurrentTaskRun] = await transaction<RunRow[]>`
        select id, tenant_id as "tenantId", task_id as "taskId", session_id as "sessionId",
               requested_by as "requestedBy", idempotency_key as "idempotencyKey", status,
               current_attempt_id as "currentAttemptId", created_at as "createdAt", updated_at as "updatedAt"
          from runs
         where tenant_id = ${input.tenantId} and task_id = ${task.id}
      `
      if (concurrentTaskRun) return mapRun(concurrentTaskRun)
      const [existing] = await transaction<RunRow[]>`
        select id, tenant_id as "tenantId", task_id as "taskId", session_id as "sessionId", requested_by as "requestedBy",
               idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
               created_at as "createdAt", updated_at as "updatedAt"
          from runs
         where tenant_id = ${input.tenantId} and session_id = ${input.sessionId}
           and requested_by = ${input.requestedBy} and idempotency_key = ${input.idempotencyKey}
      `
      if (!existing) throw new Error('幂等 Run 查询失败')
      if (existing.taskId !== task.id) throw new TaskContractConflictError('相同 Run 幂等键对应的 Task 不一致')
      return mapRun(existing)
    }
    // AG-03：调用方提供事务时并入受理事务（Session/Run/执行关联原子提交）；
    // 未提供时维持原有自治事务语义。
    return tx ? body(tx) : this.database.begin(body)
  }

  async getRun(tenantId: string, runId: string) {
    const [row] = await this.database<RunRow[]>`
      select id, tenant_id as "tenantId", task_id as "taskId", session_id as "sessionId", requested_by as "requestedBy",
             idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
             created_at as "createdAt", updated_at as "updatedAt"
        from runs where tenant_id = ${tenantId} and id = ${runId}
    `
    return row ? mapRun(row) : null
  }

  async getRunForTask(tenantId: string, taskId: string) {
    const [row] = await this.database<RunRow[]>`
      select id, tenant_id as "tenantId", task_id as "taskId", session_id as "sessionId", requested_by as "requestedBy",
             idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
             created_at as "createdAt", updated_at as "updatedAt"
        from runs where tenant_id = ${tenantId} and task_id = ${taskId}
    `
    return row ? mapRun(row) : null
  }

  async getAttempt(tenantId: string, attemptId: string) {
    const [row] = await this.database<AttemptRow[]>`
      select id, tenant_id as "tenantId", run_id as "runId", attempt_no as "attemptNo",
             runtime_id as "runtimeId", manifest, manifest_sha256 as "manifestSha256",
             model_route_snapshot as "modelRouteSnapshot", status, started_at as "startedAt",
             ended_at as "endedAt", error_code as "errorCode", created_at as "createdAt"
        from run_attempts where tenant_id = ${tenantId} and id = ${attemptId}
    `
    return row ? mapAttempt(row) : null
  }

  async upgradeQueuedAttemptManifest(
    tenantId: string,
    attemptId: string,
    manifest: JsonObject,
    manifestSha256: string,
  ): Promise<void> {
    await this.database`
      update run_attempts
         set manifest = ${this.database.json(manifest)},
             legacy_manifest_sha256 = coalesce(legacy_manifest_sha256, manifest_sha256),
             manifest_sha256 = ${manifestSha256}
       where tenant_id = ${tenantId} and id = ${attemptId} and status = 'queued'
         and not (manifest ? 'budget')
    `
  }

  async createAttempt(input: CreateAttemptInput): Promise<RunAttemptRecord> {
    return this.database.begin(transaction => this.createAttemptWithinTransaction(transaction, input))
  }

  /** PF-04 composes approval consumption and Attempt creation in one transaction. */
  async createAttemptWithinTransaction(
    transaction: DatabaseTransaction,
    input: CreateAttemptInput,
  ): Promise<RunAttemptRecord> {
      // 3-T2: same workspace lock as createRun. Retry/续写 resurrects a
      // failed/cancelled run into a new queued attempt, so it is a real
      // "start a run" path and must not slip past an archive.
      await lockActiveWorkspaceForRun(transaction, input.tenantId, input.runId)
      const [run] = await transaction<{
        status: RunState
        sessionId: string | null
        workspaceId: string | null
        requestedBy: string
        taskId: string
        budgetScopeTaskId: string
      }[]>`
        select r.status, r.session_id as "sessionId", t.workspace_id as "workspaceId",
               r.requested_by as "requestedBy", r.task_id as "taskId",
               t.budget_scope_task_id as "budgetScopeTaskId"
          from runs r
          join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
          left join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        where r.tenant_id = ${input.tenantId} and r.id = ${input.runId}
          and (r.session_id is null or s.status = 'active')
        for update of r
      `
      if (!run) throw new Error(`Run 不存在或所属 Session 已归档：${input.runId}`)
      if (!['queued', 'waiting', 'failed', 'cancelled'].includes(run.status)) {
        throw new Error(`Run 当前状态不能创建 Attempt：${run.status}`)
      }
      // 管理侧与自动任务运行同一 Run 只允许一个活动 Attempt；自动化重放必须
      // 复用已持久化 Attempt（恢复入队），不能在此静默产生第二个（AG-03）。
      const purpose = input.manifest['purpose']
      if (typeof purpose === 'string' && (purpose.startsWith('admin-') || purpose === 'automation')) {
        const [active] = await transaction`select id from run_attempts where tenant_id = ${input.tenantId} and run_id = ${input.runId} and status in ('queued', 'running', 'cancel_requested') limit 1`
        if (active) throw Object.assign(new Error('该请求已有进行中的 Attempt'), { status: 409, code: 'attempt_already_active' })
      }
      const [counter] = await transaction<{ next: number }[]>`
        select coalesce(max(attempt_no), 0)::integer + 1 as next
          from run_attempts where tenant_id = ${input.tenantId} and run_id = ${input.runId}
      `
      const attemptId = input.attemptId ?? `attempt-${randomUUID()}`
      const [created] = await transaction<AttemptRow[]>`
        insert into run_attempts (
          id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256,
          model_route_snapshot, status
        ) values (
          ${attemptId}, ${input.tenantId}, ${input.runId}, ${counter?.next ?? 1}, ${input.runtimeId ?? null},
          ${transaction.json(input.manifest)}, ${input.manifestSha256},
          ${transaction.json(input.modelRouteSnapshot)}, 'queued'
        )
        returning id, tenant_id as "tenantId", run_id as "runId", attempt_no as "attemptNo",
                  runtime_id as "runtimeId", manifest, manifest_sha256 as "manifestSha256",
                  model_route_snapshot as "modelRouteSnapshot", status, started_at as "startedAt",
                  ended_at as "endedAt", error_code as "errorCode", created_at as "createdAt"
      `
      await transaction`
        update runs
           set current_attempt_id = ${attemptId}, status = 'queued', updated_at = now()
         where tenant_id = ${input.tenantId} and id = ${input.runId}
      `
      for (const source of input.knowledgeSources ?? []) {
        await transaction`
          insert into run_knowledge_sources (
            id, tenant_id, run_id, attempt_id, document_id, relevance_score, excerpt
          ) values (
            ${`run-knowledge-${randomUUID()}`}, ${input.tenantId}, ${input.runId}, ${attemptId},
            ${source.documentId}, ${source.relevanceScore}, ${source.excerpt}
          ) on conflict (tenant_id, attempt_id, document_id) do nothing
        `
      }
      for (const file of input.inputFiles ?? []) {
        // TW-10 附件回收序列化：discardSessionFile 只先取同一 file_objects
        // 行锁、再检查 run_input_files 引用；本路径虽有更长的
        // workspaces → sessions/runs → file_objects 顺序，但两条路径唯一
        // 共同互斥点仍是该文件行，不存在反向持锁等待。discard 先提交时这里
        // 看到 removed_at 而失败收敛；本事务先提交时 discard 等待后读到
        // run_input_files 引用而保留文件——两个方向都不会产生「已引用但
        // 已删除」的输入文件。
        // 范围兜底与准入层 prepareRuntimeFiles 同构：文件须满足四者之一——
        // 挂在目标会话下、属于 Run 所在空间（空间共享文件）、其会话属于 Run
        // 所在空间（同空间其它共享会话附件，TW-10）、或挂在 Run 发起人本人
        // 名下的会话（本人跨空间附件，AC-23 既有行为）。workspace_id 为 null
        // 的独立会话只能命中会话分支，跨空间的他人会话附件被排除。成员/角色
        // 等更细裁决仍以准入为准；discardSessionFile 的引用检查按 file_id
        // 全局生效，跨会话引用同样阻止回收。
        const [fileRow] = await transaction<{ removedAt: Date | null }[]>`
          select f.removed_at as "removedAt" from file_objects f
           where f.tenant_id = ${input.tenantId} and f.id = ${file.fileId}
             and (
               f.session_id = ${run.sessionId}
               or f.workspace_id = ${run.workspaceId}
               or exists (
                 select 1 from sessions fs
                  where fs.tenant_id = f.tenant_id and fs.id = f.session_id
                    and fs.workspace_id = ${run.workspaceId}
               )
               or exists (
                 select 1 from sessions own
                  where own.tenant_id = f.tenant_id and own.id = f.session_id
                    and own.created_by = ${run.requestedBy}
               )
             )
           for update
        `
        if (!fileRow || fileRow.removedAt) {
          throw new Error(`Run 输入文件不存在、已被移除或超出该运行的可挂载范围：${file.fileId}`)
        }
        await transaction`
          insert into run_input_files (
            id, tenant_id, run_id, attempt_id, file_id, extraction_id, mount_path
          ) values (
            ${`run-input-${randomUUID()}`}, ${input.tenantId}, ${input.runId}, ${attemptId},
            ${file.fileId}, ${file.extractionId}, ${file.mountPath}
          ) on conflict (tenant_id, attempt_id, file_id) do nothing
        `
      }
      if (!created) throw new Error('Attempt 创建失败')
      await reserveAttemptBudget(transaction, {
        tenantId: input.tenantId,
        budgetScopeTaskId: run.budgetScopeTaskId,
        taskId: run.taskId,
        runId: input.runId,
        attemptId,
        manifest: input.manifest,
      })
      return mapAttempt(created)
  }

  async transitionRun(tenantId: string, runId: string, to: RunState): Promise<RunRecord> {
    return this.database.begin(async (transaction) => {
      const [current] = await transaction<RunRow[]>`
        select id, tenant_id as "tenantId", task_id as "taskId", session_id as "sessionId", requested_by as "requestedBy",
               idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
               created_at as "createdAt", updated_at as "updatedAt"
          from runs where tenant_id = ${tenantId} and id = ${runId} for update
      `
      if (!current) throw new Error(`Run 不存在：${runId}`)
      assertRunTransition(current.status, to)
      if (current.status === to) return mapRun(current)
      const [updated] = await transaction<RunRow[]>`
        update runs set status = ${to}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${runId}
         returning id, tenant_id as "tenantId", task_id as "taskId", session_id as "sessionId", requested_by as "requestedBy",
                   idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
                   created_at as "createdAt", updated_at as "updatedAt"
      `
      if (!updated) throw new Error(`Run 状态更新失败：${runId}`)
      return mapRun(updated)
    })
  }

  async workspaceStatusForAttempt(tenantIdValue: string, attemptId: string): Promise<'active' | 'archived' | null> {
    const [row] = await this.database<{ status: 'active' | 'archived' }[]>`
      select w.status
        from run_attempts a
        join runs r on r.tenant_id = a.tenant_id and r.id = a.run_id
        join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
        join workspaces w on w.tenant_id = t.tenant_id and w.id = t.workspace_id
       where a.tenant_id = ${tenantIdValue} and a.id = ${attemptId}
    `
    return row?.status ?? null
  }

  async claimAttempt(
    tenantId: string,
    attemptId: string,
    runtimeId: string,
    options?: { automationMaxConcurrent?: number },
  ): Promise<boolean> {
    return this.database.begin(async (transaction) => {
      // 3-T2: a queued run must never be claimed (queued -> running) inside an
      // archived workspace. The workspace row lock is taken first, matching
      // createRun/createAttempt, so archive and claim serialize.
      const claimedWorkspace = await lockActiveWorkspaceForAttempt(transaction, tenantId, attemptId)
      if (!claimedWorkspace) return false
      const [runtime] = await transaction<{ capacity: number; schedulingStatus: string }[]>`
        select capacity, scheduling_status as "schedulingStatus"
          from runtimes where tenant_id = ${tenantId} and id = ${runtimeId} for update
      `
      if (!runtime || runtime.schedulingStatus !== 'accepting') return false
      // AC-24：cancel_requested 的 Attempt 尚未释放 Worker，仍计入占用。
      const [usage] = await transaction<{ active: number }[]>`
        select count(*)::integer as active from run_attempts
         where tenant_id = ${tenantId} and runtime_id = ${runtimeId}
           and status in ('running', 'cancel_requested')
      `
      if ((usage?.active ?? 0) >= runtime.capacity) return false
      // AG-03：自动任务并发车道——计数与领取在同一 Runtime 行锁内完成。
      // 有效上限 = min(配置上限, capacity - 1)：始终为交互执行保留一路 Worker；
      // capacity ≤ 1 时车道为 0，超限返回 false 由调度泵区分「车道满跳过」
      // 「容量满停泵」与「容量不足收敛」。
      if (options?.automationMaxConcurrent !== undefined) {
        const [pending] = await transaction<{ purpose: string | null }[]>`
          select manifest->>'purpose' as purpose from run_attempts
           where tenant_id = ${tenantId} and id = ${attemptId} and status = 'queued'
        `
        if (pending?.purpose === 'automation') {
          const laneLimit = Math.max(0, Math.min(options.automationMaxConcurrent, runtime.capacity - 1))
          const [lane] = await transaction<{ active: number }[]>`
            select count(*)::integer as active from run_attempts
             where tenant_id = ${tenantId} and runtime_id = ${runtimeId}
               and status in ('running', 'cancel_requested')
               and manifest->>'purpose' = 'automation'
          `
          if ((lane?.active ?? 0) >= laneLimit) return false
        }
      }
      const [attempt] = await transaction<{ runId: string }[]>`
        update run_attempts set status = 'running', started_at = coalesce(started_at, now())
         where tenant_id = ${tenantId} and id = ${attemptId} and status = 'queued'
         returning run_id as "runId"
      `
      if (!attempt) return false
      await transaction`
        update runs set status = 'running', updated_at = now()
         where tenant_id = ${tenantId} and id = ${attempt.runId} and status = 'queued'
      `
      return true
    })
  }

  /**
   * AG-03 车道占用读数：返回自动任务有效并发上限与当前占用。
   * 有效上限 = min(配置上限, capacity - 1)，为交互执行保留一路；capacity ≤ 1
   * 时 allowed = 0，调用方应把排队自动任务收敛为「容量不足」而非无限空转。
   * Runtime 行不存在（exists=false）或暂停接活（accepting=false）属部署/
   * 运维状态，调用方应按「暂不可调度」留队重排而非收敛。占用计数含
   * cancel_requested（Worker 未释放）。
   */
  async automationLaneUsage(
    tenantId: string,
    runtimeId: string,
    configuredMax: number,
  ): Promise<{ allowed: number; running: number; exists: boolean; accepting: boolean }> {
    const [row] = await this.database<{ capacity: number; schedulingStatus: string; running: number }[]>`
      select r.capacity, r.scheduling_status as "schedulingStatus",
             (select count(*)::integer from run_attempts a
               where a.tenant_id = r.tenant_id and a.runtime_id = r.id
                 and a.status in ('running', 'cancel_requested')
                 and a.manifest->>'purpose' = 'automation') as running
        from runtimes r
       where r.tenant_id = ${tenantId} and r.id = ${runtimeId}
    `
    if (!row) return { allowed: 0, running: 0, exists: false, accepting: false }
    return {
      allowed: Math.max(0, Math.min(configuredMax, row.capacity - 1)),
      running: row.running,
      exists: true,
      accepting: row.schedulingStatus === 'accepting',
    }
  }

  /**
   * AG-03 条件收敛：仅当 Run 仍停在「无 Attempt 的 queued」时落终态——
   * 受理中断（failed）与暂停清理（cancelled）共用。并发下 Attempt 已创建
   * 或 Run 已离开 queued 时不动作，返回是否实际收敛。
   */
  async convergeUndispatchedRun(
    tenantId: string,
    runId: string,
    to: 'failed' | 'cancelled',
  ): Promise<boolean> {
    const updated = await this.database`
      update runs set status = ${to}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${runId}
         and status = 'queued' and current_attempt_id is null
    `
    return updated.count > 0
  }

  /**
   * AG-03 暂停/停用清理：Run 仍在 queued（未开始执行）时原子取消——
   * 有 Attempt 的连同 Attempt 一起取消（同事务）；Attempt 已被领取
   * （running/cancel_requested/终态）或 Run 已离开 queued 时返回 false，
   * 由调用方按「已开始执行」放行。
   */
  async cancelQueuedRun(
    tenantId: string,
    runId: string,
    tx?: DatabaseTransaction,
  ): Promise<boolean> {
    const body = async (transaction: DatabaseTransaction) => {
      // 锁顺序与 claimAttempt 一致（run_attempts → runs）：先无锁读出
      // attempt 指针只作预判，真正的并发判定交给两条 UPDATE 的状态谓词；
      // 若先锁 runs 再锁 run_attempts，会与领取事务（持 attempt 锁等 run
      // 锁）成环造成死锁。
      const [peek] = await transaction<{ status: RunState; currentAttemptId: string | null }[]>`
        select status, current_attempt_id as "currentAttemptId"
          from runs where tenant_id = ${tenantId} and id = ${runId}
      `
      if (!peek || peek.status !== 'queued') return false
      if (peek.currentAttemptId) {
        const attempt = await transaction`
          update run_attempts
             set status = 'cancelled', ended_at = coalesce(ended_at, now())
           where tenant_id = ${tenantId} and id = ${peek.currentAttemptId}
             and status = 'queued'
        `
        if (attempt.count === 0) return false
      }
      const updated = await transaction`
        update runs set status = 'cancelled', updated_at = now()
         where tenant_id = ${tenantId} and id = ${runId} and status = 'queued'
      `
      return updated.count > 0
    }
    return tx ? body(tx) : this.database.begin(body)
  }

  async transitionAttempt(
    tenantId: string,
    attemptId: string,
    to: AttemptState,
    errorCode?: string,
  ): Promise<RunAttemptRecord> {
    return this.database.begin(async (transaction) => {
      const [current] = await transaction<AttemptRow[]>`
        select id, tenant_id as "tenantId", run_id as "runId", attempt_no as "attemptNo",
               runtime_id as "runtimeId", manifest, manifest_sha256 as "manifestSha256",
               model_route_snapshot as "modelRouteSnapshot", status, started_at as "startedAt",
               ended_at as "endedAt", error_code as "errorCode", created_at as "createdAt"
          from run_attempts where tenant_id = ${tenantId} and id = ${attemptId} for update
      `
      if (!current) throw new Error(`Attempt 不存在：${attemptId}`)
      assertAttemptTransition(current.status, to)
      if (current.status === to) return mapAttempt(current)
      const startedAt = to === 'running' && !current.startedAt ? new Date() : current.startedAt
      const endedAt = isAttemptTerminalState(to) ? new Date() : null
      const [updated] = await transaction<AttemptRow[]>`
        update run_attempts
           set status = ${to}, started_at = ${startedAt}, ended_at = ${endedAt},
               error_code = ${errorCode ?? null}
         where tenant_id = ${tenantId} and id = ${attemptId}
         returning id, tenant_id as "tenantId", run_id as "runId", attempt_no as "attemptNo",
                   runtime_id as "runtimeId", manifest, manifest_sha256 as "manifestSha256",
                   model_route_snapshot as "modelRouteSnapshot", status, started_at as "startedAt",
                   ended_at as "endedAt", error_code as "errorCode", created_at as "createdAt"
      `
      if (!updated) throw new Error(`Attempt 状态更新失败：${attemptId}`)
      return mapAttempt(updated)
    })
  }

  async appendEvent(event: StoredRunEvent): Promise<StoredRunEvent> {
    // Runtime adapters number their own events; a server-authored note written
    // at the same moment can take that sequence first. Retry by re-allocating
    // the sequence from the current per-attempt maximum — a fixed sequence would
    // keep colliding, and losing the write would also lose that event's state
    // transition (a dropped run.cancelled/run.completed would strand the run).
    let sequence = event.sequence
    for (let attempt = 0; attempt < SEQUENCE_CONFLICT_RETRIES; attempt += 1) {
      try {
        return await this.insertEvent({ ...event, sequence })
      } catch (error) {
        if (!isSequenceConflict(error) || attempt === SEQUENCE_CONFLICT_RETRIES - 1) throw error
        const current = await this.maxSequenceForAttempt(event.tenantId, event.attemptId)
        sequence = current + 1
      }
    }
    throw new Error('Run Event 写入失败：序列冲突重试耗尽')
  }

  private async maxSequenceForAttempt(tenantId: string, attemptId: string): Promise<number> {
    const [row] = await this.database<{ max: number | null }[]>`
      select max(sequence)::integer as max from run_events
       where tenant_id = ${tenantId} and attempt_id = ${attemptId}
    `
    return Number(row?.max ?? 0)
  }

  private async insertEvent(event: StoredRunEvent): Promise<StoredRunEvent> {
    const [created] = await this.database<EventRow[]>`
      insert into run_events (
        id, tenant_id, run_id, attempt_id, sequence, event_type, display_message,
        safe_metadata, trace_id, occurred_at
      ) values (
        ${event.id}, ${event.tenantId}, ${event.runId}, ${event.attemptId}, ${event.sequence},
        ${event.eventType}, ${event.displayMessage}, ${this.database.json(event.safeMetadata)},
        ${event.traceId}, ${event.occurredAt}
      )
      on conflict (id) do nothing
      returning id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
                sequence, event_type as "eventType", display_message as "displayMessage",
                safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
                stream_position as "streamPosition"
    `
    if (created) return mapEvent(created)
    // The id already exists: this is an idempotent re-delivery of the same
    // event. The stored row wins (its allocated sequence may differ from the
    // freshly computed one).
    const [existing] = await this.database<EventRow[]>`
      select id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
             sequence, event_type as "eventType", display_message as "displayMessage",
             safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
             stream_position as "streamPosition"
        from run_events where tenant_id = ${event.tenantId} and id = ${event.id}
    `
    if (!existing) throw new Error(`Run Event 幂等查询失败：${event.id}`)
    if (existing.runId !== event.runId || existing.attemptId !== event.attemptId) {
      throw new Error(`Run Event 幂等键冲突：${event.id}`)
    }
    return mapEvent(existing)
  }

  /**
   * Server-authored events (system cancel notes, execution-time authorization
   * denials — 1A-T5). The per-attempt sequence is computed inside the insert,
   * and the write retries when a concurrent writer (the Runtime adapter, which
   * numbers its own events) has taken that sequence first.
   *
   * Idempotent per (attempt, event type): converging the same run twice must not
   * duplicate its lifecycle note, so an existing note of that type is returned.
   */
  async appendSystemEvent(input: AppendSystemEventInput): Promise<StoredRunEvent> {
    for (let attempt = 0; attempt < SEQUENCE_CONFLICT_RETRIES; attempt += 1) {
      try {
        return await this.database.begin(async (transaction) => {
          const [existing] = await transaction<EventRow[]>`
            select id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
                   sequence, event_type as "eventType", display_message as "displayMessage",
                   safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
                   stream_position as "streamPosition"
              from run_events
             where tenant_id = ${input.tenantId} and attempt_id = ${input.attemptId}
               and event_type = ${input.eventType}
               and id like ${SYSTEM_EVENT_ID_PREFIX_LIKE}
             limit 1
          `
          if (existing) return mapEvent(existing)

          const id = `event-system-${randomUUID()}`
          const [created] = await transaction<EventRow[]>`
            insert into run_events (
              id, tenant_id, run_id, attempt_id, sequence, event_type, display_message,
              safe_metadata, trace_id, occurred_at
            )
            select ${id}, ${input.tenantId}, ${input.runId}, ${input.attemptId},
                   coalesce(max(sequence), 0)::bigint + 1, ${input.eventType}, ${input.displayMessage},
                   ${transaction.json(input.safeMetadata ?? {})}, ${input.traceId},
                   ${input.occurredAt ?? new Date().toISOString()}
              from run_events
             where tenant_id = ${input.tenantId} and attempt_id = ${input.attemptId}
            returning id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
                      sequence, event_type as "eventType", display_message as "displayMessage",
                      safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
                      stream_position as "streamPosition"
          `
          if (!created) throw new Error('系统事件写入失败')
          return mapEvent(created)
        })
      } catch (error) {
        if (!isSequenceConflict(error) || attempt === SEQUENCE_CONFLICT_RETRIES - 1) throw error
      }
    }
    throw new Error('系统事件写入失败：序列冲突重试耗尽')
  }

  async readEvents(tenantId: string, runId: string, afterSequence = 0) {
    const rows = await this.database<EventRow[]>`
      select id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
             sequence, event_type as "eventType", display_message as "displayMessage",
             safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
             stream_position as "streamPosition"
        from run_events
       where tenant_id = ${tenantId} and run_id = ${runId} and sequence > ${afterSequence}
       order by sequence asc
    `
    return rows.map(mapEvent)
  }

  async readEventsAfterEvent(tenantId: string, runId: string, afterEventId?: string) {
    const rows = await this.database<EventRow[]>`
      with cursor as (
        select stream_position
          from run_events
         where tenant_id = ${tenantId} and run_id = ${runId} and id = ${afterEventId ?? ''}
      )
      select id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
             sequence, event_type as "eventType", display_message as "displayMessage",
             safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
             stream_position as "streamPosition"
        from run_events
       where tenant_id = ${tenantId} and run_id = ${runId}
         and stream_position > coalesce((select stream_position from cursor), 0)
       order by stream_position asc
    `
    return rows.map(mapEvent)
  }

  async recoverAfterRestart(tenantId: string, runtimeId: string): Promise<RestartRecoveryResult> {
    return this.database.begin(async (transaction) => {
      const interrupted = await transaction<RecoveryRow[]>`
        select a.id, a.tenant_id as "tenantId", a.run_id as "runId", a.attempt_no as "attemptNo",
               a.runtime_id as "runtimeId", a.manifest, a.manifest_sha256 as "manifestSha256",
               a.model_route_snapshot as "modelRouteSnapshot", a.status, a.started_at as "startedAt",
               a.ended_at as "endedAt", a.error_code as "errorCode", a.created_at as "createdAt",
               r.task_id as "runTaskId", r.session_id as "runSessionId", r.requested_by as "runRequestedBy",
               r.idempotency_key as "runIdempotencyKey", r.status as "runStatus",
               r.current_attempt_id as "runCurrentAttemptId", r.created_at as "runCreatedAt",
               r.updated_at as "runUpdatedAt"
          from run_attempts a
          join runs r on r.tenant_id = a.tenant_id and r.id = a.run_id
         where a.tenant_id = ${tenantId} and a.runtime_id = ${runtimeId}
           and a.status in ('running', 'cancel_requested')
           and r.current_attempt_id = a.id
         for update of a, r
      `

      const failed: RestartRecoveryResult['failed'] = []
      for (const row of interrupted) {
        const [sequence] = await transaction<{ next: number }[]>`
          select coalesce(max(sequence), 0)::integer + 1 as next
            from run_events
           where tenant_id = ${tenantId} and attempt_id = ${row.id}
        `
        const eventId = `event-recovery-${randomUUID()}`
        const traceId = typeof row.manifest['trace_id'] === 'string'
          ? row.manifest['trace_id']
          : `trace-recovery-${row.runId}`
        await transaction`
          update run_attempts
             set status = 'failed', ended_at = now(), error_code = 'SERVICE_RESTARTED'
           where tenant_id = ${tenantId} and id = ${row.id}
        `
        await transaction`
          update runs set status = 'failed', updated_at = now()
           where tenant_id = ${tenantId} and id = ${row.runId}
        `
        await transaction`
          insert into run_events (
            id, tenant_id, run_id, attempt_id, sequence, event_type,
            display_message, safe_metadata, trace_id, occurred_at
          ) values (
            ${eventId}, ${tenantId}, ${row.runId}, ${row.id}, ${sequence?.next ?? 1}, 'run.failed',
            '服务重启后，上一进程遗留的执行已安全终止',
            ${transaction.json({ error_code: 'SERVICE_RESTARTED', reason: 'orphaned_active_attempt' })},
            ${traceId}, now()
          )
        `
        failed.push({ runId: row.runId, attemptId: row.id })
      }

      const queuedRows = await transaction<RecoveryRow[]>`
        select a.id, a.tenant_id as "tenantId", a.run_id as "runId", a.attempt_no as "attemptNo",
               a.runtime_id as "runtimeId", a.manifest, a.manifest_sha256 as "manifestSha256",
               a.model_route_snapshot as "modelRouteSnapshot", a.status, a.started_at as "startedAt",
               a.ended_at as "endedAt", a.error_code as "errorCode", a.created_at as "createdAt",
               r.task_id as "runTaskId", r.session_id as "runSessionId", r.requested_by as "runRequestedBy",
               r.idempotency_key as "runIdempotencyKey", r.status as "runStatus",
               r.current_attempt_id as "runCurrentAttemptId", r.created_at as "runCreatedAt",
               r.updated_at as "runUpdatedAt"
          from run_attempts a
          join runs r on r.tenant_id = a.tenant_id and r.id = a.run_id
         where a.tenant_id = ${tenantId} and a.runtime_id = ${runtimeId}
           and a.status = 'queued' and r.status = 'queued' and r.current_attempt_id = a.id
         order by a.created_at asc
         for update of a, r
      `
      return {
        failed,
        queued: queuedRows.map(row => ({
          run: mapRun({
            id: row.runId,
            tenantId: row.tenantId,
            taskId: row.runTaskId,
            sessionId: row.runSessionId,
            requestedBy: row.runRequestedBy,
            idempotencyKey: row.runIdempotencyKey,
            status: row.runStatus,
            currentAttemptId: row.runCurrentAttemptId,
            createdAt: row.runCreatedAt,
            updatedAt: row.runUpdatedAt,
          }),
          attempt: mapAttempt(row),
        })),
      }
    })
  }

  async listActiveRunsForWorkspaceUser(tenantId: string, workspaceId: string, userId: string) {
    const rows = await this.database<RunRow[]>`
      select r.id, r.tenant_id as "tenantId", r.task_id as "taskId", r.session_id as "sessionId",
             r.requested_by as "requestedBy", r.idempotency_key as "idempotencyKey",
             r.status, r.current_attempt_id as "currentAttemptId",
             r.created_at as "createdAt", r.updated_at as "updatedAt"
        from runs r
        join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
       where r.tenant_id = ${tenantId}
         and t.workspace_id = ${workspaceId}
         and r.requested_by = ${userId}
         and r.status in ('queued', 'running', 'waiting', 'cancel_requested')
       order by r.created_at asc
    `
    return rows.map(mapRun)
  }

  async listActiveRunsForAgentMember(tenantId: string, workspaceId: string, agentMemberId: string) {
    const rows = await this.database<RunRow[]>`
      select r.id, r.tenant_id as "tenantId", r.task_id as "taskId", r.session_id as "sessionId",
             r.requested_by as "requestedBy", r.idempotency_key as "idempotencyKey",
             r.status, r.current_attempt_id as "currentAttemptId",
             r.created_at as "createdAt", r.updated_at as "updatedAt"
        from runs r
        join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
        left join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
        join workspace_agent_members wam
          on wam.tenant_id = t.tenant_id
         and wam.workspace_id = t.workspace_id
         and wam.id = ${agentMemberId}
        join agent_versions av on av.tenant_id = wam.tenant_id and av.agent_id = wam.agent_id
       where r.tenant_id = ${tenantId}
         and t.workspace_id = ${workspaceId}
         and av.id = coalesce(s.agent_version_id, ra.manifest->>'agent_version_id')
         and r.status in ('queued', 'running', 'waiting', 'cancel_requested')
       order by r.created_at asc
    `
    return rows.map(mapRun)
  }

  async listActiveRunsInWorkspace(tenantId: string, workspaceId: string): Promise<WorkspaceActiveRun[]> {
    const rows = await this.database<(RunRow & { agentVersionId: string })[]>`
      select r.id, r.tenant_id as "tenantId", r.task_id as "taskId", r.session_id as "sessionId",
             r.requested_by as "requestedBy", r.idempotency_key as "idempotencyKey",
             r.status, r.current_attempt_id as "currentAttemptId",
             r.created_at as "createdAt", r.updated_at as "updatedAt",
             coalesce(s.agent_version_id, ra.manifest->>'agent_version_id') as "agentVersionId"
        from runs r
        join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
        left join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
       where r.tenant_id = ${tenantId}
         and t.workspace_id = ${workspaceId}
         and coalesce(s.agent_version_id, ra.manifest->>'agent_version_id') is not null
         and r.status in ('queued', 'running', 'waiting', 'cancel_requested')
       order by r.created_at asc
    `
    return rows.map(row => ({ ...mapRun(row), agentVersionId: row.agentVersionId }))
  }
}

/**
 * Batch 3 / 3-T2 archive-vs-run serialization.
 *
 * Every path that can make a run active (start a new run, create a retry
 * attempt, claim a queued run) takes the workspace row lock FIRST, before any
 * session / run_attempt / run row. Archive takes the exact same lock as its
 * first statement, so the global order is:
 *
 *     workspaces -> sessions | run_attempts | runs | runtimes
 *
 * This is the same workspace lock the member-management paths already use, so
 * there is no second lock and no reversed pair to deadlock on.
 *
 * A missing workspace row is intentionally not an error here: the surrounding
 * query keeps its own not-found behavior, and the pre-0013/standalone shapes
 * (if any survive) stay untouched. Only an explicit non-active status is
 * refused, as a typed 403 matching the execution-track denial for archived
 * workspaces.
 */
function assertWorkspaceActive(workspace: { status: string } | undefined): void {
  if (workspace && workspace.status !== 'active') {
    throw authorizationDenied('工作空间已归档，不能创建或继续执行任务')
  }
}

async function lockActiveWorkspaceForSession(
  transaction: DatabaseTransaction,
  tenantIdValue: string,
  sessionId: string,
): Promise<void> {
  const [workspace] = await transaction<{ status: string }[]>`
    select w.status
      from sessions s
      join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
     where s.tenant_id = ${tenantIdValue} and s.id = ${sessionId}
     for update of w
  `
  assertWorkspaceActive(workspace)
}

async function lockActiveWorkspace(
  transaction: DatabaseTransaction,
  tenantIdValue: string,
  workspaceId: string,
): Promise<void> {
  const [workspace] = await transaction<{ status: string }[]>`
    select status from workspaces
     where tenant_id = ${tenantIdValue} and id = ${workspaceId}
     for update
  `
  assertWorkspaceActive(workspace)
}

async function lockActiveWorkspaceForRun(
  transaction: DatabaseTransaction,
  tenantIdValue: string,
  runId: string,
): Promise<void> {
  const [workspace] = await transaction<{ status: string }[]>`
    select w.status
      from runs r
      join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
      join workspaces w on w.tenant_id = t.tenant_id and w.id = t.workspace_id
     where r.tenant_id = ${tenantIdValue} and r.id = ${runId}
     for update of w
  `
  assertWorkspaceActive(workspace)
}

/** Returns false when the attempt belongs to an archived workspace. */
async function lockActiveWorkspaceForAttempt(
  transaction: DatabaseTransaction,
  tenantIdValue: string,
  attemptId: string,
): Promise<boolean> {
  const [workspace] = await transaction<{ status: string }[]>`
    select w.status
      from run_attempts a
      join runs r on r.tenant_id = a.tenant_id and r.id = a.run_id
      join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
      join workspaces w on w.tenant_id = t.tenant_id and w.id = t.workspace_id
     where a.tenant_id = ${tenantIdValue} and a.id = ${attemptId}
     for update of w
  `
  if (!workspace) return true
  return workspace.status === 'active'
}

async function reserveAttemptBudget(
  transaction: DatabaseTransaction,
  input: {
    tenantId: string
    budgetScopeTaskId: string
    taskId: string
    runId: string
    attemptId: string
    manifest: JsonObject
  },
): Promise<void> {
  const limits = input.manifest['limits']
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('Runtime Manifest 缺少 limits，不能预占 Task 预算')
  }
  const timeoutSeconds = requiredBudgetInteger(limits['timeout_seconds'], 'timeout_seconds')
  const toolCalls = requiredBudgetInteger(limits['max_tool_calls'], 'max_tool_calls')
  const outputBytes = requiredBudgetInteger(limits['max_output_bytes'], 'max_output_bytes')
  const durationMs = timeoutSeconds * 1000
  const budget = input.manifest['budget']
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)
    || budget['scope_task_id'] !== input.budgetScopeTaskId) {
    throw new TypeError('Runtime Manifest 的预算范围与 Task 不一致')
  }
  const reservation = budget['reservation']
  if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)
    || reservation['duration_ms'] !== durationMs
    || reservation['tool_calls'] !== toolCalls
    || reservation['output_bytes'] !== outputBytes) {
    throw new TypeError('Runtime Manifest 的预算预占与 Attempt limits 不一致')
  }
  const [account] = await transaction<{
    maxDurationMs: number | null
    maxToolCalls: number | null
    maxOutputBytes: number | null
  }[]>`
    select max_duration_ms::integer as "maxDurationMs",
           max_tool_calls::integer as "maxToolCalls",
           max_output_bytes::integer as "maxOutputBytes"
      from task_budget_accounts
     where tenant_id = ${input.tenantId} and budget_scope_task_id = ${input.budgetScopeTaskId}
     for update
  `
  if (!account) throw new Error(`Task 预算账户不存在：${input.budgetScopeTaskId}`)
  const cumulative = budget['cumulative_limits']
  if (!cumulative || typeof cumulative !== 'object' || Array.isArray(cumulative)
    || cumulative['max_duration_ms'] !== account.maxDurationMs
    || cumulative['max_tool_calls'] !== account.maxToolCalls
    || cumulative['max_output_bytes'] !== account.maxOutputBytes) {
    throw new TypeError('Runtime Manifest 的累计预算快照与 Task 预算账户不一致')
  }
  const [used] = await transaction<{ durationMs: number; toolCalls: number; outputBytes: number }[]>`
    select coalesce(sum(case when status = 'reserved' then reserved_duration_ms else actual_duration_ms end), 0)::integer as "durationMs",
           coalesce(sum(case when status = 'reserved' then reserved_tool_calls else actual_tool_calls end), 0)::integer as "toolCalls",
           coalesce(sum(case when status = 'reserved' then reserved_output_bytes else actual_output_bytes end), 0)::integer as "outputBytes"
      from attempt_budget_usage
     where tenant_id = ${input.tenantId} and budget_scope_task_id = ${input.budgetScopeTaskId}
  `
  assertBudgetAvailable('durationMs', account.maxDurationMs, used?.durationMs ?? 0, durationMs)
  assertBudgetAvailable('toolCalls', account.maxToolCalls, used?.toolCalls ?? 0, toolCalls)
  assertBudgetAvailable('outputBytes', account.maxOutputBytes, used?.outputBytes ?? 0, outputBytes)
  await transaction`
    insert into attempt_budget_usage (
      id, tenant_id, budget_scope_task_id, task_id, run_id, attempt_id, status,
      reserved_duration_ms, reserved_tool_calls, reserved_output_bytes
    ) values (
      ${`budget-usage-${input.attemptId}`}, ${input.tenantId}, ${input.budgetScopeTaskId},
      ${input.taskId}, ${input.runId}, ${input.attemptId}, 'reserved',
      ${durationMs}, ${toolCalls}, ${outputBytes}
    )
  `
}

function requiredBudgetInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`Runtime Manifest ${name} 必须是非负安全整数`)
  }
  return Number(value)
}

function assertBudgetAvailable(name: string, maximum: number | null, consumed: number, requested: number): void {
  if (maximum !== null && consumed + requested > maximum) {
    throw new TaskBudgetExceededError(`${name} 累计预算不足：上限 ${maximum}，已结算或预占 ${consumed}，本次需要 ${requested}`)
  }
}

function mapRun(row: RunRow): RunRecord {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

function mapAttempt(row: AttemptRow): RunAttemptRecord {
  return {
    ...row,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function mapEvent(row: EventRow): StoredRunEvent {
  return {
    ...row,
    sequence: Number(row.sequence),
    streamPosition: Number(row.streamPosition),
    occurredAt: row.occurredAt.toISOString(),
  }
}
