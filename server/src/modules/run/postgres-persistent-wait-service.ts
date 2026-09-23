import { createHash, randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { isAuthorizationDenial, requestInvalid } from '../authorization/authorization-errors.ts'
import { canonicalJson } from '../runtime/canonical-json.ts'
import { compileRuntimeManifest } from '../runtime/manifest-compiler.ts'
import type { DurablePermissionContext, DurableWaitDecision } from '../runtime/dsh-acp-runtime-adapter.ts'
import type { RuntimeManifest, RuntimeResumeCheckpointContext } from '../runtime/runtime-types.ts'
import type { JsonObject, RunRecord } from './run-types.ts'
import { PostgresRunRepository } from './postgres-run-repository.ts'

const tenantId = 'tenant-dsh-work'

export type ApprovalDecision = 'approved' | 'rejected'
export interface PersistentApprovalRecord {
  id: string
  runId: string
  taskId: string
  sourceAttemptId: string
  checkpointId: string
  checkpointDigest: string
  actionName: string
  parameterDigest: string
  resourceRef: string
  executionIdentity: string
  executorPrincipalId?: string | null
  resolverPrincipalId?: string | null
  dataVersion: string
  riskLevel: 'medium' | 'high'
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  expiresAt: string
  requestedAt: string
  resolvedBy: string | null
  resolvedAt: string | null
  resumedAttemptId: string | null
  actionConsumedAt: string | null
}

type ApprovalStorageStatus = PersistentApprovalRecord['status'] | 'preparing'

interface ApprovalRow extends Omit<PersistentApprovalRecord, 'status' | 'expiresAt' | 'requestedAt' | 'resolvedAt' | 'actionConsumedAt'> {
  status: ApprovalStorageStatus
  expiresAt: Date
  requestedAt: Date
  resolvedAt: Date | null
  runtimeId: string | null
  runtimeVersion: string
  sourceManifestSha256: string
  sourceManifest: JsonObject
  checkpointContext: JsonObject
  checkpointContextSha256: string
  modelRouteSnapshot: JsonObject
  resolutionKey: string | null
  actionConsumedAtDate: Date | null
}

interface PersistentWaitCallbacks {
  reauthorize(manifest: RuntimeManifest): Promise<void>
  enqueue(run: RunRecord, manifest: RuntimeManifest): void
}

export class PostgresPersistentWaitService {
  private readonly database: DatabaseClient
  private readonly runs: PostgresRunRepository
  private readonly callbacks: PersistentWaitCallbacks
  private readonly runtimeVersion: string
  private sweepTimer?: NodeJS.Timeout
  private sweepRunning = false

  constructor(
    database: DatabaseClient,
    runs: PostgresRunRepository,
    callbacks: PersistentWaitCallbacks,
    runtimeVersion = 'unknown',
  ) {
    this.database = database
    this.runs = runs
    this.callbacks = callbacks
    this.runtimeVersion = runtimeVersion
  }

  start(): void {
    if (this.sweepTimer) return
    void this.sweepExpiredApprovals()
    this.sweepTimer = setInterval(() => { void this.sweepExpiredApprovals() }, 30_000)
    this.sweepTimer.unref()
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  async decidePermission(
    manifest: RuntimeManifest,
    context: DurablePermissionContext,
  ): Promise<'allow_once' | DurableWaitDecision> {
    if (manifest.resume && this.matchesApproval(manifest, context)
      && await this.claimApprovedAction(manifest, context)) return 'allow_once'
    const correlationKey = `${manifest.attempt_id}:${context.toolCallId}`
    const checkpointId = `checkpoint-${randomUUID()}`
    const approvalId = `approval-${randomUUID()}`
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const checkpointContextSha256 = createHash('sha256').update(canonicalJson(context.checkpointState)).digest('hex')
    if (createHash('sha256').update(canonicalJson(context.checkpointState.pending_action.arguments)).digest('hex') !== context.parameterDigest) {
      throw requestInvalid('待审批动作参数与参数摘要不一致')
    }
    const checkpointDigest = createHash('sha256').update(canonicalJson({
      strategy: 'new-attempt-context-v1',
      runId: manifest.run_id,
      sourceAttemptId: manifest.attempt_id,
      actionName: context.toolName,
      parameterDigest: context.parameterDigest,
      resourceRef: context.resourceRef,
      dataVersion: context.dataVersion,
      executionIdentity: manifest.user_context.user_id,
      checkpointContextSha256,
      expiresAt: expiresAt.toISOString(),
    })).digest('hex')

    const result = await this.database.begin(async (transaction) => {
      const [run] = await transaction<{ status: string; currentAttemptId: string | null; manifestSha256: string; runtimeId: string | null }[]>`
        select r.status, r.current_attempt_id as "currentAttemptId",
               a.manifest_sha256 as "manifestSha256", a.runtime_id as "runtimeId"
          from runs r
          join run_attempts a on a.tenant_id = r.tenant_id and a.id = r.current_attempt_id
         where r.tenant_id = ${tenantId} and r.id = ${manifest.run_id}
         for update of r, a
      `
      if (!run || run.status !== 'running' || run.currentAttemptId !== manifest.attempt_id) {
        throw requestInvalid('当前 Attempt 已结束或被替代，不能创建审批')
      }
      // A terminal source Attempt may have left a pre-wait checkpoint behind
      // before its run.waiting event was persisted. A retry owns the Run now;
      // retire every older active checkpoint before enforcing one-active-per-Run.
      const staleApprovals = await transaction<{ checkpointId: string }[]>`
        update run_approval_requests
           set status = 'cancelled', resolved_at = now(), resolution_comment = '已被新的 Attempt 取代'
         where tenant_id = ${tenantId} and run_id = ${manifest.run_id}
           and source_attempt_id <> ${manifest.attempt_id} and status in ('preparing', 'pending')
         returning checkpoint_id as "checkpointId"
      `
      if (staleApprovals.length) await transaction`
        update run_checkpoints set status = 'cancelled', resolved_at = now()
         where tenant_id = ${tenantId} and id in ${transaction(staleApprovals.map(row => row.checkpointId))}
           and status = 'active'
      `
      await transaction`
        update run_checkpoints set status = 'cancelled', resolved_at = now()
         where tenant_id = ${tenantId} and run_id = ${manifest.run_id}
           and source_attempt_id <> ${manifest.attempt_id} and status = 'active'
      `
      const [unknown] = await transaction<{ id: string }[]>`
        select id from task_operations
         where tenant_id = ${tenantId} and attempt_id = ${manifest.attempt_id} and status = 'unknown'
         limit 1
      `
      if (unknown) throw Object.assign(new Error('当前 Attempt 存在效果未知的外部动作，核对前不能进入审批恢复'), {
        status: 409, code: 'TASK_OPERATION_EFFECT_UNKNOWN',
      })
      const [existing] = await transaction<{ approvalId: string; checkpointId: string; checkpointDigest: string; expiresAt: Date }[]>`
        select a.id as "approvalId", a.checkpoint_id as "checkpointId",
               c.checkpoint_digest as "checkpointDigest", a.expires_at as "expiresAt"
          from run_approval_requests a
          join run_checkpoints c on c.tenant_id = a.tenant_id and c.id = a.checkpoint_id
         where a.tenant_id = ${tenantId} and a.run_id = ${manifest.run_id}
           and a.correlation_key = ${correlationKey}
      `
      if (existing) return existing
      await transaction`
        insert into run_checkpoints (
          id, tenant_id, run_id, source_attempt_id, strategy, runtime_id, runtime_version,
          source_manifest_sha256, resume_context, resume_context_sha256,
          checkpoint_digest, correlation_key, status, expires_at
        ) values (
          ${checkpointId}, ${tenantId}, ${manifest.run_id}, ${manifest.attempt_id}, 'new-attempt-context-v1',
          ${run.runtimeId}, ${this.runtimeVersion}, ${run.manifestSha256},
          ${transaction.json(context.checkpointState as unknown as JsonObject)}, ${checkpointContextSha256}, ${checkpointDigest},
          ${correlationKey}, 'active', ${expiresAt}
        )
      `
      await transaction`
        insert into run_approval_requests (
          id, tenant_id, run_id, source_attempt_id, checkpoint_id, correlation_key,
          action_name, parameter_digest, resource_ref, execution_identity, executor_principal_id, data_version,
          risk_level, status, expires_at
        ) values (
          ${approvalId}, ${tenantId}, ${manifest.run_id}, ${manifest.attempt_id}, ${checkpointId},
          ${correlationKey}, ${context.toolName}, ${context.parameterDigest}, ${context.resourceRef},
          ${manifest.user_context.user_id},
          (select t.executed_as_principal_id from runs r join tasks t
             on t.tenant_id = r.tenant_id and t.id = r.task_id
            where r.tenant_id = ${tenantId} and r.id = ${manifest.run_id}),
          ${context.dataVersion}, 'high', 'preparing', ${expiresAt}
        )
      `
      return { approvalId, checkpointId, checkpointDigest, expiresAt }
    })
    return {
      decision: 'wait',
      approvalId: result.approvalId,
      checkpointId: result.checkpointId,
      checkpointDigest: result.checkpointDigest,
      expiresAt: result.expiresAt.toISOString(),
    }
  }

  async list(status?: PersistentApprovalRecord['status']): Promise<PersistentApprovalRecord[]> {
    const rows = await this.database<ApprovalRow[]>`
      select a.id, a.run_id as "runId", r.task_id as "taskId", a.source_attempt_id as "sourceAttemptId",
             a.checkpoint_id as "checkpointId", c.checkpoint_digest as "checkpointDigest",
             a.action_name as "actionName", a.parameter_digest as "parameterDigest",
             a.resource_ref as "resourceRef", a.execution_identity as "executionIdentity",
             a.executor_principal_id as "executorPrincipalId", a.resolver_principal_id as "resolverPrincipalId",
             a.data_version as "dataVersion", a.risk_level as "riskLevel", a.status,
             a.expires_at as "expiresAt", a.requested_at as "requestedAt",
             a.resolved_by as "resolvedBy", a.resolved_at as "resolvedAt",
             a.resumed_attempt_id as "resumedAttemptId", a.action_consumed_at as "actionConsumedAtDate",
             c.runtime_id as "runtimeId",
             c.runtime_version as "runtimeVersion", c.source_manifest_sha256 as "sourceManifestSha256",
             c.resume_context as "checkpointContext", c.resume_context_sha256 as "checkpointContextSha256",
             ra.manifest as "sourceManifest", ra.model_route_snapshot as "modelRouteSnapshot"
        from run_approval_requests a
        join run_checkpoints c on c.tenant_id = a.tenant_id and c.id = a.checkpoint_id
        join runs r on r.tenant_id = a.tenant_id and r.id = a.run_id
        join run_attempts ra on ra.tenant_id = a.tenant_id and ra.id = a.source_attempt_id
       where a.tenant_id = ${tenantId} and a.status <> 'preparing'
         ${status ? this.database`and a.status = ${status}` : this.database``}
       order by a.requested_at asc, a.id asc
    `
    return rows.map(toRecord)
  }

  async get(approvalId: string): Promise<PersistentApprovalRecord | null> {
    const row = await this.loadApproval(approvalId)
    return row && row.status !== 'preparing' ? toRecord(row) : null
  }

  /**
   * Makes an approval visible only when its source Attempt and Run enter the
   * durable waiting state in the same transaction. Before this point a fast
   * administrator cannot resolve a request that the Runtime has not released.
   */
  async activateWaiting(input: { approvalId: string; runId: string; attemptId: string }): Promise<boolean> {
    return this.database.begin(async (transaction) => {
      // All PF-04 resolution paths serialize on the Run first. Keep that lock
      // order here before touching Attempt or approval rows to avoid a cycle
      // with reject/expire/cancel and resumed-Attempt creation.
      const [run] = await transaction<{ status: string; currentAttemptId: string | null }[]>`
        select status, current_attempt_id as "currentAttemptId" from runs
         where tenant_id = ${tenantId} and id = ${input.runId} for update
      `
      if (!run || run.currentAttemptId !== input.attemptId) return false
      const [attempt] = await transaction<{ status: string }[]>`
        select status from run_attempts
         where tenant_id = ${tenantId} and run_id = ${input.runId} and id = ${input.attemptId} for update
      `
      const [approval] = await transaction<{ status: ApprovalStorageStatus }[]>`
        select status from run_approval_requests
         where tenant_id = ${tenantId} and id = ${input.approvalId}
           and run_id = ${input.runId} and source_attempt_id = ${input.attemptId} for update
      `
      if (!attempt || !approval) return false
      if (approval.status === 'pending'
        && run.status === 'waiting' && attempt.status === 'waiting') return true
      if (approval.status !== 'preparing'
        || run.status !== 'running' || attempt.status !== 'running') return false
      await transaction`
        update run_attempts set status = 'waiting', ended_at = now(), error_code = null
         where tenant_id = ${tenantId} and id = ${input.attemptId} and status = 'running'
      `
      await transaction`
        update runs set status = 'waiting', updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.runId} and status = 'running'
      `
      await transaction`
        update run_approval_requests set status = 'pending'
         where tenant_id = ${tenantId} and id = ${input.approvalId} and status = 'preparing'
      `
      return true
    })
  }

  /** Retires an approval that never reached run.waiting for its source Attempt. */
  async cancelPreparingForAttempt(input: { runId: string; attemptId: string }): Promise<number> {
    return this.database.begin(async (transaction) => {
      await transaction`select id from runs where tenant_id = ${tenantId} and id = ${input.runId} for update`
      const approvals = await transaction<{ checkpointId: string }[]>`
        update run_approval_requests
           set status = 'cancelled', resolved_at = now(), resolution_comment = '来源 Attempt 已终止'
         where tenant_id = ${tenantId} and run_id = ${input.runId}
           and source_attempt_id = ${input.attemptId} and status = 'preparing'
         returning checkpoint_id as "checkpointId"
      `
      if (approvals.length) await transaction`
        update run_checkpoints set status = 'cancelled', resolved_at = now()
         where tenant_id = ${tenantId} and id in ${transaction(approvals.map(row => row.checkpointId))}
           and status = 'active'
      `
      return approvals.length
    })
  }

  async resolve(input: {
    approvalId: string
    decision: ApprovalDecision
    actor: string
    resolutionKey: string
    comment?: string
  }): Promise<PersistentApprovalRecord> {
    const current = await this.loadApproval(input.approvalId)
    if (!current) throw requestInvalid('审批不存在')
    if (current.status !== 'pending') {
      if (current.status === 'preparing') {
        throw Object.assign(new Error('审批尚未进入可处理状态，请等待 Runtime 释放当前执行'), {
          status: 409, code: 'APPROVAL_NOT_READY',
        })
      }
      if (current.status === 'expired') throw approvalExpired()
      const sameDecision = (input.decision === 'approved' && current.status === 'approved')
        || (input.decision === 'rejected' && current.status === 'rejected')
      if (sameDecision && current.resolutionKey === input.resolutionKey) return toRecord(current)
      throw Object.assign(new Error(`审批已处于 ${current.status}，不能改写决定`), { status: 409, code: 'APPROVAL_CONFLICT' })
    }
    if (current.expiresAt.getTime() <= Date.now()) {
      await this.expireOne(current.id)
      throw approvalExpired()
    }
    if (input.decision === 'rejected') return this.reject(current, input)

    const sourceManifest = current.sourceManifest as unknown as RuntimeManifest
    try {
      await this.callbacks.reauthorize(sourceManifest)
    } catch (error) {
      if (isAuthorizationDenial(error)) await this.cancelRun(current.runId, 'system')
      throw error
    }
    const [unknown] = await this.database<{ id: string }[]>`
      select id from task_operations
       where tenant_id = ${tenantId} and attempt_id = ${current.sourceAttemptId} and status = 'unknown'
       limit 1
    `
    if (unknown) throw Object.assign(new Error('来源 Attempt 存在效果未知的外部动作，请先核对结果'), {
      status: 409, code: 'TASK_OPERATION_EFFECT_UNKNOWN',
    })

    const approvedAt = new Date().toISOString()
    const checkpointContext = current.checkpointContext as unknown as RuntimeResumeCheckpointContext
    const checkpointContextSha256 = createHash('sha256').update(canonicalJson(checkpointContext)).digest('hex')
    if (checkpointContextSha256 !== current.checkpointContextSha256
      || createHash('sha256').update(canonicalJson(checkpointContext.pending_action?.arguments ?? null)).digest('hex') !== current.parameterDigest) {
      throw Object.assign(new Error('持久化检查点内容校验失败，不能恢复执行'), {
        status: 409, code: 'CHECKPOINT_INTEGRITY_FAILED',
      })
    }
    const resumedManifest: RuntimeManifest = {
      ...structuredClone(sourceManifest),
      attempt_id: `attempt-${randomUUID()}`,
      created_at: approvedAt,
      trace_id: `trace-${current.runId}-resume-${current.id}`,
      resume: {
        strategy: 'new-attempt-context-v1', checkpoint_id: current.checkpointId,
        checkpoint_digest: current.checkpointDigest, source_attempt_id: current.sourceAttemptId,
        approval_id: current.id, action_name: current.actionName,
        parameter_digest: current.parameterDigest, resource_ref: current.resourceRef,
        data_version: current.dataVersion, approved_by: input.actor, approved_at: approvedAt,
        checkpoint_context_sha256: checkpointContextSha256,
        checkpoint_context: checkpointContext,
      },
    }
    const compiled = compileRuntimeManifest(resumedManifest)
    try {
      await this.database.begin(async (transaction) => {
        const attempt = await this.runs.createAttemptWithinTransaction(transaction, {
          attemptId: resumedManifest.attempt_id,
          tenantId,
          runId: current.runId,
          runtimeId: current.runtimeId ?? undefined,
          manifest: JSON.parse(compiled.canonicalJson) as JsonObject,
          manifestSha256: compiled.sha256,
          modelRouteSnapshot: current.modelRouteSnapshot,
          memorySources: resumedManifest.memory_context?.map(memory => ({
            memoryVersionId: memory.memoryVersionId,
            relevanceScore: 1,
            excerpt: memory.excerpt,
          })),
        })
        const [approval] = await transaction<{ status: string; checkpointDigest: string; checkpointContextSha256: string; expiresAt: Date }[]>`
          select a.status, a.expires_at as "expiresAt", c.checkpoint_digest as "checkpointDigest",
                 c.resume_context_sha256 as "checkpointContextSha256"
            from run_approval_requests a
            join run_checkpoints c on c.tenant_id = a.tenant_id and c.id = a.checkpoint_id
           where a.tenant_id = ${tenantId} and a.id = ${current.id}
           for update of a, c
        `
        if (!approval || approval.status !== 'pending' || approval.expiresAt.getTime() <= Date.now()
          || approval.checkpointDigest !== current.checkpointDigest
          || approval.checkpointContextSha256 !== checkpointContextSha256) {
          throw Object.assign(new Error('审批已被处理或检查点已变化'), { status: 409, code: 'APPROVAL_CONFLICT' })
        }
        await transaction`
          update run_approval_requests
             set status = 'approved', resolved_by = ${input.actor},
                 resolver_principal_id = (select id from execution_principals
                   where tenant_id = ${tenantId} and kind = 'human' and human_user_id = ${input.actor}),
                 resolved_at = now(),
                 resolution_key = ${input.resolutionKey}, resolution_comment = ${input.comment ?? null},
                 resumed_attempt_id = ${attempt.id}
           where tenant_id = ${tenantId} and id = ${current.id}
        `
        await transaction`
          update run_checkpoints
             set status = 'consumed', consumed_by_attempt_id = ${attempt.id}, resolved_at = now()
           where tenant_id = ${tenantId} and id = ${current.checkpointId} and status = 'active'
        `
      })
    } catch (error) {
      const resolved = await this.loadApproval(current.id)
      if (resolved?.status === 'approved' && resolved.resolutionKey === input.resolutionKey) return toRecord(resolved)
      throw error
    }
    const run = await this.runs.getRun(tenantId, current.runId)
    if (!run) throw new Error('恢复后的 Run 不存在')
    this.callbacks.enqueue(run, resumedManifest)
    return (await this.get(current.id))!
  }

  async cancelRun(runId: string, actor: string): Promise<boolean> {
    const result = await this.database.begin(async (transaction) => {
      const [run] = await transaction<{ status: string; currentAttemptId: string | null }[]>`
        select status, current_attempt_id as "currentAttemptId" from runs
         where tenant_id = ${tenantId} and id = ${runId} for update
      `
      if (!run || run.status !== 'waiting' || !run.currentAttemptId) return null
      await transaction`
        update run_approval_requests set status = 'cancelled', resolved_by = ${actor},
          resolver_principal_id = (select id from execution_principals
            where tenant_id = ${tenantId} and kind = 'human' and human_user_id = ${actor}),
          resolved_at = now()
         where tenant_id = ${tenantId} and run_id = ${runId} and status = 'pending'
      `
      await transaction`
        update run_checkpoints set status = 'cancelled', resolved_at = now()
         where tenant_id = ${tenantId} and run_id = ${runId} and status = 'active'
      `
      await transaction`update runs set status = 'cancelled', updated_at = now() where tenant_id = ${tenantId} and id = ${runId}`
      await this.appendWaitTerminalEventWithinTransaction(
        transaction,
        `cancel-${runId}`,
        runId,
        run.currentAttemptId,
        'run.cancelled',
        '等待中的动作审批已取消',
        { cause: actor === 'system' ? 'authorization_revoked' : 'user', actor },
      )
      return true
    })
    if (!result) return false
    return true
  }

  async expireDue(): Promise<number> {
    const due = await this.database<{ id: string }[]>`
      select id from run_approval_requests
       where tenant_id = ${tenantId} and status in ('preparing', 'pending') and expires_at <= now()
       order by expires_at asc limit 100
    `
    for (const row of due) await this.expireOne(row.id)
    return due.length
  }

  private async sweepExpiredApprovals(): Promise<void> {
    if (this.sweepRunning) return
    this.sweepRunning = true
    try {
      await this.expireDue()
    } catch (error) {
      console.error('persistent approval expiry sweep failed', error)
    } finally {
      this.sweepRunning = false
    }
  }

  async reconcileOrphans(): Promise<number> {
    const rows = await this.database<{ id: string; checkpointId: string; runId: string; sourceAttemptId: string; runStatus: string }[]>`
      update run_approval_requests a
         set status = 'cancelled', resolved_at = now()
        from runs r
       where a.tenant_id = ${tenantId} and r.tenant_id = a.tenant_id and r.id = a.run_id
         and a.status in ('preparing', 'pending') and r.status in ('succeeded', 'failed', 'cancelled')
       returning a.id, a.checkpoint_id as "checkpointId", a.run_id as "runId",
                 a.source_attempt_id as "sourceAttemptId", r.status as "runStatus"
    `
    if (rows.length) await this.database`
      update run_checkpoints set status = 'cancelled', resolved_at = now()
       where tenant_id = ${tenantId} and id in ${this.database(rows.map(row => row.checkpointId))} and status = 'active'
    `
    for (const row of rows) {
      const cancelled = row.runStatus === 'cancelled'
      await this.appendWaitTerminalEvent(
        row.runId,
        row.sourceAttemptId,
        cancelled ? 'run.cancelled' : 'run.failed',
        '等待审批已因 Run 终止而关闭',
        cancelled ? { cause: 'orphan_reconciliation' } : {
          error_code: 'APPROVAL_ORPHANED', reason: 'orphan_reconciliation',
        },
      )
    }
    return rows.length
  }

  private async expireOne(approvalId: string): Promise<void> {
    const [target] = await this.database<{ runId: string }[]>`
      select run_id as "runId" from run_approval_requests
       where tenant_id = ${tenantId} and id = ${approvalId} and status in ('preparing', 'pending')
    `
    if (!target) return
    await this.database.begin(async (transaction) => {
      const [run] = await transaction<{ status: string; currentAttemptId: string | null }[]>`
        select status, current_attempt_id as "currentAttemptId" from runs
         where tenant_id = ${tenantId} and id = ${target.runId} for update
      `
      const [approval] = await transaction<{ runId: string; checkpointId: string; sourceAttemptId: string }[]>`
        select run_id as "runId", checkpoint_id as "checkpointId", source_attempt_id as "sourceAttemptId"
          from run_approval_requests
         where tenant_id = ${tenantId} and id = ${approvalId} and status in ('preparing', 'pending') for update
      `
      if (!approval) return null
      await transaction`update run_approval_requests set status = 'expired', resolved_at = now() where tenant_id = ${tenantId} and id = ${approvalId}`
      await transaction`update run_checkpoints set status = 'expired', resolved_at = now() where tenant_id = ${tenantId} and id = ${approval.checkpointId} and status = 'active'`
      const ownsCurrentAttempt = run?.currentAttemptId === approval.sourceAttemptId
        && (run.status === 'running' || run.status === 'waiting')
      if (!ownsCurrentAttempt) return null
      await transaction`update run_attempts set status = 'failed', ended_at = now(), error_code = 'APPROVAL_EXPIRED' where tenant_id = ${tenantId} and id = ${approval.sourceAttemptId} and status = 'running'`
      await transaction`update runs set status = 'failed', updated_at = now() where tenant_id = ${tenantId} and id = ${approval.runId} and status in ('running', 'waiting')`
      await this.appendWaitTerminalEventWithinTransaction(
        transaction,
        approvalId,
        approval.runId,
        approval.sourceAttemptId,
        'run.failed',
        '动作审批已过期，任务未继续执行',
        { error_code: 'APPROVAL_EXPIRED', approval_id: approvalId },
      )
      return { runId: approval.runId, attemptId: approval.sourceAttemptId }
    })
  }

  private async reject(current: ApprovalRow, input: { actor: string; resolutionKey: string; comment?: string }): Promise<PersistentApprovalRecord> {
    const rejected = await this.database.begin(async (transaction) => {
      await transaction`select id from runs where tenant_id = ${tenantId} and id = ${current.runId} for update`
      const [approval] = await transaction<{ status: string }[]>`
        select status from run_approval_requests where tenant_id = ${tenantId} and id = ${current.id} for update
      `
      if (!approval || approval.status !== 'pending') return false
      await transaction`
        update run_approval_requests set status = 'rejected', resolved_by = ${input.actor},
          resolver_principal_id = (select id from execution_principals
            where tenant_id = ${tenantId} and kind = 'human' and human_user_id = ${input.actor}),
          resolved_at = now(),
          resolution_key = ${input.resolutionKey}, resolution_comment = ${input.comment ?? null}
         where tenant_id = ${tenantId} and id = ${current.id}
      `
      await transaction`update run_checkpoints set status = 'rejected', resolved_at = now() where tenant_id = ${tenantId} and id = ${current.checkpointId} and status = 'active'`
      await transaction`update runs set status = 'failed', updated_at = now() where tenant_id = ${tenantId} and id = ${current.runId} and status = 'waiting'`
      await this.appendWaitTerminalEventWithinTransaction(
        transaction,
        current.id,
        current.runId,
        current.sourceAttemptId,
        'run.failed',
        '动作审批已被拒绝，任务未继续执行',
        { error_code: 'APPROVAL_REJECTED', approval_id: current.id, resolved_by: input.actor },
      )
      return true
    })
    if (rejected) return (await this.get(current.id))!
    const resolved = await this.loadApproval(current.id)
    if (resolved?.status === 'rejected' && resolved.resolutionKey === input.resolutionKey) {
      return toRecord(resolved)
    }
    throw Object.assign(new Error('审批已被其他请求处理，拒绝决定未生效'), {
      status: 409, code: 'APPROVAL_CONFLICT',
    })
  }

  private async appendWaitTerminalEventWithinTransaction(
    transaction: DatabaseTransaction,
    eventKey: string,
    runId: string,
    attemptId: string,
    eventType: 'run.failed' | 'run.cancelled',
    displayMessage: string,
    safeMetadata: JsonObject,
  ): Promise<void> {
    const eventId = `event-system-approval-${eventKey}-${eventType}`
    await transaction`
      insert into run_events (
        id, tenant_id, run_id, attempt_id, sequence, event_type, display_message,
        safe_metadata, trace_id, occurred_at
      )
      select ${eventId}, ${tenantId}, ${runId}, ${attemptId},
             coalesce(max(sequence), 0)::bigint + 1, ${eventType}, ${displayMessage},
             ${transaction.json(safeMetadata)}, ${`trace-${runId}-approval-terminal`}, now()
        from run_events
       where tenant_id = ${tenantId} and attempt_id = ${attemptId}
      on conflict (id) do nothing
    `
  }

  private async appendWaitTerminalEvent(
    runId: string,
    attemptId: string,
    eventType: 'run.failed' | 'run.cancelled',
    displayMessage: string,
    safeMetadata: JsonObject,
  ): Promise<void> {
    await this.runs.appendSystemEvent({
      tenantId,
      runId,
      attemptId,
      eventType,
      displayMessage,
      safeMetadata,
      traceId: `trace-${runId}-approval-terminal`,
    })
  }

  private matchesApproval(manifest: RuntimeManifest, context: DurablePermissionContext): boolean {
    return manifest.resume?.action_name === context.toolName
      && manifest.resume.parameter_digest === context.parameterDigest
      && manifest.resume.resource_ref === context.resourceRef
      && manifest.resume.data_version === context.dataVersion
  }

  private async loadApproval(approvalId: string): Promise<ApprovalRow | null> {
    const [row] = await this.database<ApprovalRow[]>`
      select a.id, a.run_id as "runId", r.task_id as "taskId", a.source_attempt_id as "sourceAttemptId",
             a.checkpoint_id as "checkpointId", c.checkpoint_digest as "checkpointDigest",
             a.action_name as "actionName", a.parameter_digest as "parameterDigest",
             a.resource_ref as "resourceRef", a.execution_identity as "executionIdentity",
             a.executor_principal_id as "executorPrincipalId", a.resolver_principal_id as "resolverPrincipalId",
             a.data_version as "dataVersion", a.risk_level as "riskLevel", a.status,
             a.expires_at as "expiresAt", a.requested_at as "requestedAt", a.resolved_by as "resolvedBy",
             a.resolved_at as "resolvedAt", a.resumed_attempt_id as "resumedAttemptId",
             a.resolution_key as "resolutionKey", c.runtime_id as "runtimeId", c.runtime_version as "runtimeVersion",
             a.action_consumed_at as "actionConsumedAtDate",
             c.source_manifest_sha256 as "sourceManifestSha256", ra.manifest as "sourceManifest",
             c.resume_context as "checkpointContext", c.resume_context_sha256 as "checkpointContextSha256",
             ra.model_route_snapshot as "modelRouteSnapshot"
        from run_approval_requests a
        join run_checkpoints c on c.tenant_id = a.tenant_id and c.id = a.checkpoint_id
        join runs r on r.tenant_id = a.tenant_id and r.id = a.run_id
        join run_attempts ra on ra.tenant_id = a.tenant_id and ra.id = a.source_attempt_id
       where a.tenant_id = ${tenantId} and a.id = ${approvalId}
    `
    return row ?? null
  }

  private async claimApprovedAction(manifest: RuntimeManifest, context: DurablePermissionContext): Promise<boolean> {
    const [claimed] = await this.database<{ id: string }[]>`
      update run_approval_requests
         set action_consumed_at = now(), action_call_id = ${context.toolCallId}
       where tenant_id = ${tenantId} and id = ${manifest.resume!.approval_id}
         and status = 'approved' and resumed_attempt_id = ${manifest.attempt_id}
         and action_name = ${context.toolName} and parameter_digest = ${context.parameterDigest}
         and resource_ref = ${context.resourceRef} and data_version = ${context.dataVersion}
         and execution_identity = ${manifest.user_context.user_id}
         and expires_at > now()
         and action_consumed_at is null
       returning id
    `
    return Boolean(claimed)
  }
}

function approvalExpired() {
  return Object.assign(new Error('审批已过期，不能恢复执行'), { status: 409, code: 'APPROVAL_EXPIRED' })
}

function toRecord(row: ApprovalRow): PersistentApprovalRecord {
  if (row.status === 'preparing') throw new Error('尚未激活的审批不能暴露给管理端')
  return {
    id: row.id, runId: row.runId, taskId: row.taskId, sourceAttemptId: row.sourceAttemptId,
    checkpointId: row.checkpointId, checkpointDigest: row.checkpointDigest,
    actionName: row.actionName, parameterDigest: row.parameterDigest, resourceRef: row.resourceRef,
    executionIdentity: row.executionIdentity, executorPrincipalId: row.executorPrincipalId,
    resolverPrincipalId: row.resolverPrincipalId,
    dataVersion: row.dataVersion, riskLevel: row.riskLevel,
    status: row.status, expiresAt: row.expiresAt.toISOString(), requestedAt: row.requestedAt.toISOString(),
    resolvedBy: row.resolvedBy, resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resumedAttemptId: row.resumedAttemptId,
    actionConsumedAt: row.actionConsumedAtDate?.toISOString() ?? null,
  }
}
