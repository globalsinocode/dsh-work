import { assertRuntimeModelRequirements, ExecutionCapabilityUnavailableError } from '../../runtime/execution-capabilities.ts'
import { backgroundLaneMaxConcurrent, isBackgroundLanePurpose, isBackgroundPurpose, type BackgroundLanePurpose } from '../../../domain/background-lanes.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import { AuthorizationCheckUnavailableError } from '../current-execution-authorization.ts'
import type { RunRepository } from '../run-repository.ts'
import type { RunRecord } from '../run-types.ts'
import type { ExecutionAuthorizationGate } from './execution-authorization-gate.ts'
import type { RunEventRecorder } from './run-event-recorder.ts'
import { tenantId, runtimeId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/** 后台车道容量不足以保留交互余量时的失败说明；摘要与档案在下一次触发时重试，验证案例可重跑。 */
const backgroundCapacityMessage: Record<BackgroundLanePurpose, string> = {
  'session-summary': 'Runtime 容量不足以在保留交互余量的同时生成摘要',
  'agent-release-trial': 'Runtime 容量不足以在保留交互余量的同时运行验证案例',
  'project-archive': 'Runtime 容量不足以在保留交互余量的同时整理项目档案',
}

/**
 * In-process scheduler: claims persisted Attempts within Runtime capacity (keeping one
 * Worker for interactive work while automation runs), rechecks authorization, starts the
 * Runtime and streams its events to the recorder. Single-node only; see overview.md.
 */
export class AttemptScheduler {
  private readonly pendingExecutions: Array<{ run: RunRecord; manifest: RuntimeManifest }> = []
  private schedulerTimer?: NodeJS.Timeout
  private pumping = false
  private closing = false
  private readonly deps: OrchestrationDependencies
  private readonly gate: ExecutionAuthorizationGate
  private readonly events: RunEventRecorder

  constructor(deps: OrchestrationDependencies, gate: ExecutionAuthorizationGate, events: RunEventRecorder) {
    this.deps = deps
    this.gate = gate
    this.events = events
  }

  /** Queues a persisted Attempt for execution and wakes the scheduler. */
  enqueue(run: RunRecord, manifest: RuntimeManifest): void {
    this.pendingExecutions.push({ run, manifest })
    this.triggerPump()
  }

  /** Stops scheduling, closes the Runtime and waits for pending event writes. */
  async close(): Promise<void> {
    this.closing = true
    if (this.schedulerTimer) clearTimeout(this.schedulerTimer)
    this.schedulerTimer = undefined
    await this.deps.runtime.close()
    await this.events.drain()
  }

  private async pumpScheduler() {
    if (this.pumping || this.closing) return
    this.pumping = true
    try {
      // AG-03：索引扫描而非纯队首消费——自动任务车道满时留队跳过本项，
      // 继续寻找可领取的交互任务，避免自动化排队阻塞交互执行。
      let index = 0
      let automationLane: Awaited<ReturnType<RunRepository['automationLaneUsage']>> | null = null
      while (index < this.pendingExecutions.length) {
        const next = this.pendingExecutions[index]
        if (!next) break
        // 3-T2 加固：历史/外部数据的 `manifest` 列可能是 `{}`（没有 attempt_id）。
        // 直接把 undefined 绑进 SQL 会抛 UNDEFINED_VALUE，异常经 triggerPump 的
        // catch 记录并重排。这里回退到 run 的权威指针，两者都没有就跳过并告警，
        // 绝不把 undefined 传给 Runtime。
        const attemptId = next.manifest.attempt_id ?? next.run.currentAttemptId
        if (!attemptId) {
          console.error('scheduler skipped a pending execution without an attempt id', next.run.id)
          this.pendingExecutions.splice(index, 1)
          continue
        }
        // Restored queues must not spin forever behind an unavailable capability,
        // even when persisted scheduling is disabled/draining.
        try {
          if (next.manifest.model_requirements?.length) {
            const attempt = await this.deps.runs.getAttempt(tenantId, attemptId)
            const target = attempt?.modelRouteSnapshot
            if (!target || typeof target.providerKey !== 'string' || typeof target.modelKey !== 'string' || typeof target.baseUrl !== 'string') {
              throw new ExecutionCapabilityUnavailableError('model')
            }
            await assertRuntimeModelRequirements(this.deps.runtime, next.manifest.model_requirements, {
              providerKey: target.providerKey, modelKey: target.modelKey, baseUrl: target.baseUrl,
            })
          }
          await this.deps.runtime.assertAvailable?.(next.manifest)
        } catch (error) {
          if (!(error instanceof ExecutionCapabilityUnavailableError)) throw error
          this.pendingExecutions.splice(index, 1)
          await this.failRunForUnavailableCapability(next.run, attemptId, error)
          continue
        }
        const claimed = await this.deps.runs.claimAttempt(tenantId, attemptId, runtimeId, {
          automationMaxConcurrent: this.deps.automationMaxConcurrent,
        })
        if (!claimed) {
          const attempt = await this.deps.runs.getAttempt(tenantId, attemptId)
          if (attempt && attempt.status !== 'queued') {
            this.pendingExecutions.splice(index, 1)
            continue
          }
          if (!attempt) {
            // attempt 行已不存在（被清理/历史数据）：无法收敛，移除以免空转。
            this.pendingExecutions.splice(index, 1)
            continue
          }
          // 3-T2：归档收敛必须先于车道判断——排在前面保证归档空间里的自动化
          // Attempt 拿到准确的「空间已归档」终态，而不是在车道满时被留队跳过、
          // 或在车道为零时被误标为容量耗尽。
          // 空间在排队后被归档（历史/迁移数据或外部写入）时，claimAttempt 会
          // 一直返回 false；若无条件重排，调度器会每 500ms 空转且永不收敛（评审实测
          // 2.6s 内重试 6 次、run 永远 queued）。这里收敛为终态并落说明事件。
          if (await this.isWorkspaceArchivedForAttempt(attemptId)) {
            this.pendingExecutions.splice(index, 1)
            await this.gate.failRunForRevokedAuthorization(
              next.run,
              next.manifest,
              '工作空间已归档，任务未执行',
            )
            continue
          }
          // AG-03：自动任务并发车道——有效上限 = min(配置, capacity-1)。
          // 车道为 0（容量不足以保留交互余量）时收敛为「容量不足」而非空转；
          // 车道满（含后台车道合计已占 capacity-1）则该项留队，继续扫描后续任务，不阻塞交互执行。
          // Runtime 行缺失或暂停接活只是「暂不可调度」——落到下方统一的
          // schedulePump+break 重排路径，不得误收敛为容量失败。
          if (next.manifest.purpose === 'automation') {
            automationLane ??= await this.deps.runs.automationLaneUsage(tenantId, runtimeId, this.deps.automationMaxConcurrent)
            const lane = automationLane
            if (lane.exists && lane.accepting && lane.allowed <= 0) {
              this.pendingExecutions.splice(index, 1)
              await this.failAutomationRunForCapacity(next.run, next.manifest)
              continue
            }
            if (lane.exists && lane.accepting && (lane.running >= lane.allowed || lane.backgroundFull)) {
              index += 1
              continue
            }
          }
          // EX-02 摘要与 S3 验证案例车道同理——容量不足以保留交互余量时直接失败
          // （摘要下一轮退回裁剪，验证案例可重跑），车道满则留队，继续扫描交互任务。
          if (isBackgroundLanePurpose(next.manifest.purpose)) {
            const purpose = next.manifest.purpose
            const lane = await this.deps.runs.backgroundLaneUsage(tenantId, runtimeId, purpose, backgroundLaneMaxConcurrent[purpose])
            if (lane.exists && lane.accepting && lane.allowed <= 0) {
              this.pendingExecutions.splice(index, 1)
              await this.gate.failRunForRevokedAuthorization(next.run, next.manifest, backgroundCapacityMessage[purpose])
              continue
            }
            if (lane.exists && lane.accepting && (lane.running >= lane.allowed || lane.backgroundFull)) {
              index += 1
              continue
            }
          }
          this.schedulePump()
          break
        }
        this.pendingExecutions.splice(index, 1)
        // 后台任务领取成功即占一路车道（及后台合计），缓存读数失效，下一个 automation 项重查。
        if (isBackgroundPurpose(next.manifest.purpose)) automationLane = null
        void this.executeClaimed(next.run, next.manifest)
      }
      // 车道满等原因留队的项：补一次延迟重排兜底。运行中的 Attempt 结束时
      // executeClaimed 的 finally 也会触发重排，这里覆盖「无完成事件」的残留
      // 场景，避免留队项依赖外部触发才恢复。
      if (this.pendingExecutions.length > 0) this.schedulePump()
    } finally {
      this.pumping = false
    }
  }

  private async failRunForUnavailableCapability(run: RunRecord, attemptId: string, error: ExecutionCapabilityUnavailableError) {
    const current = await this.deps.runs.getRun(tenantId, run.id)
    const attempt = await this.deps.runs.getAttempt(tenantId, attemptId)
    if (!current || current.currentAttemptId !== attemptId || !attempt
      || !['queued', 'running'].includes(current.status) || !['queued', 'running'].includes(attempt.status)) return
    await this.deps.runs.transitionAttempt(tenantId, attemptId, 'failed', error.code)
    await this.deps.runs.transitionRun(tenantId, run.id, 'failed')
    await this.deps.runs.appendSystemEvent({ tenantId, runId: run.id, attemptId, eventType: 'run.failed',
      displayMessage: error.message, safeMetadata: { error_code: error.code }, traceId: `trace-${run.id}` })
  }

  private async executeClaimed(run: RunRecord, manifest: RuntimeManifest) {
    try {
      // 调用 Runtime 前复核当前身份、固定能力和输入；团队额外检查成员关系。
      // 只决定是否执行，绝不改写 Manifest；个人空间不再豁免。
      const recheck = await this.gate.recheckExecutionAuthorization(run, manifest)
      if (recheck.denied) {
        await this.gate.failRunForRevokedAuthorization(run, manifest, recheck.reason)
        return
      }
      // 撤权清扫可能在「领取 → 复核」之间已经把这个 run 收敛为终态（系统取消）。
      // 复核只回答「还有没有授权」，不回答「这个 run 是否还该执行」；这里再确认
      // 一次当前状态，避免对被取消的 run 仍然调用 Runtime（AC-09 取消与完成竞态）。
      // 收敛方已负责 attempt 与 run 的共同收敛，这里只跳过执行、不重复改写终态。
      const current = await this.deps.runs.getRun(tenantId, run.id)
      if (!current || current.currentAttemptId !== manifest.attempt_id || !['queued', 'running'].includes(current.status)) return
      const handle = await this.deps.runtime.execute(manifest)
      const unsubscribe = this.deps.runtime.subscribe(run.id, (event) => this.events.record(run, event))
      try {
        await handle.done
        await this.events.flush(run.id)
      } finally {
        // 事件回调必须在 Attempt 生命周期内摘除：handle.done 拒绝或事件写
        // 链抛错时漏摘会让订阅挂在 Runtime 上，后续事件继续改写已终态的
        // Run，并在长进程里泄漏回调。unsubscribe 自身抛错只能记录，不能
        // 让 finally 覆盖 handle.done 已抛出的原始失败原因。
        try {
          unsubscribe()
        } catch (error) {
          console.error('runtime unsubscribe failed', error)
        }
      }
    } catch (error) {
      const attempt = await this.deps.runs.getAttempt(tenantId, manifest.attempt_id)
      const currentRun = await this.deps.runs.getRun(tenantId, run.id)
      if (attempt && !['failed', 'cancelled', 'succeeded'].includes(attempt.status)) {
        await this.deps.runs.transitionAttempt(tenantId, attempt.id, 'failed', error instanceof AuthorizationCheckUnavailableError ? 'AUTHORIZATION_CHECK_UNAVAILABLE' : 'RUNTIME_DISPATCH_FAILED')
      }
      if (currentRun && !['failed', 'cancelled', 'succeeded'].includes(currentRun.status)) {
        await this.deps.runs.transitionRun(tenantId, run.id, 'failed')
      }
      await this.deps.persistentWait?.cancelPreparingForAttempt({ runId: run.id, attemptId: manifest.attempt_id })
      if (error instanceof AuthorizationCheckUnavailableError && attempt) {
        await this.deps.runs.appendSystemEvent({ tenantId, runId: run.id, attemptId: attempt.id,
          eventType: 'run.failed', displayMessage: '授权检查暂不可用，任务未执行',
          safeMetadata: { error_code: error.code }, traceId: `trace-${run.id}` })
      }
      console.error('runtime dispatch failed', error)
    } finally {
      // 事件链 settle 后清掉本 Attempt 的内存痕迹（assistantOutputs / eventWrites），
      // 否则失败/取消/异常路径在长跑进程里无界增长。
      await this.events.release(run.id, manifest.attempt_id)
      if (!this.closing) this.triggerPump()
    }
  }

  /**
   * AG-03 车道为 0（Runtime 容量不足以在保留交互余量的前提下运行自动
   * 任务）时把排队 Attempt 收敛为明确的容量失败，不让其在队列里空转。
   */
  private async failAutomationRunForCapacity(run: RunRecord, manifest: RuntimeManifest) {
    const attempt = await this.deps.runs.getAttempt(tenantId, manifest.attempt_id)
    const currentRun = await this.deps.runs.getRun(tenantId, run.id)
    const attemptId = attempt?.id ?? manifest.attempt_id
    let converged = false
    if (attempt && !['failed', 'cancelled', 'succeeded'].includes(attempt.status)) {
      await this.deps.runs.transitionAttempt(tenantId, attemptId, 'failed', 'AUTOMATION_CAPACITY_EXHAUSTED')
      converged = true
    }
    if (currentRun && !['failed', 'cancelled', 'succeeded'].includes(currentRun.status)) {
      await this.deps.runs.transitionRun(tenantId, run.id, 'failed')
      converged = true
    }
    // 两者均已终态（并发取消等）时不补写 run.failed——终态 Run 上追加失败
    // 事件会污染时间线并误导归因。
    if (!converged) return
    await this.deps.runs.appendSystemEvent({
      tenantId,
      runId: run.id,
      attemptId,
      eventType: 'run.failed',
      displayMessage: '自动任务容量不足：需为交互执行保留至少一路 Worker',
      safeMetadata: { error_code: 'AUTOMATION_CAPACITY_EXHAUSTED' },
      traceId: `trace-${run.id}`,
    })
  }

  /**
   * 3-T2：排队期间空间被归档时用于收敛，避免调度器无限重排。
   * 空间取自 attempt→run→session 的关联，而不是 manifest：历史/夹具里的
   * `manifest` 列可能是 `{}`（没有 workspace_id），那样判断会静默失效。
   */
  private async isWorkspaceArchivedForAttempt(attemptId: string): Promise<boolean> {
    const status = await this.deps.runs.workspaceStatusForAttempt(tenantId, attemptId)
    return status === 'archived'
  }

  /**
   * 触发一次调度泵。pumpScheduler 内的瞬时错误（DB 抖动、行锁竞争等）不能
   * 成为未处理 rejection（Node 默认 unhandled-rejections=throw，进程级致命），
   * 也不能让留队项就此停滞：记录日志后安排延迟重排。
   */
  private triggerPump() {
    void this.pumpScheduler().catch((error: unknown) => {
      console.error('scheduler pump failed; retained items will be retried', error)
      this.schedulePump()
    })
  }

  private schedulePump() {
    if (this.schedulerTimer || this.closing) return
    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = undefined
      this.triggerPump()
    }, 500)
    this.schedulerTimer.unref()
  }
}
