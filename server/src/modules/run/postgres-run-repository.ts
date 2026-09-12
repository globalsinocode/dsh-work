import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { authorizationDenied } from '../authorization/authorization-errors.ts'
import type { AppendSystemEventInput, RestartRecoveryResult, RunRepository, WorkspaceActiveRun } from './run-repository.ts'
import { assertAttemptTransition, assertRunTransition, isTerminalState } from './run-state-machine.ts'
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

interface RunRow {
  id: string
  tenantId: string
  sessionId: string
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
  runSessionId: string
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

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const runId = `run-${randomUUID()}`
    return this.database.begin(async (transaction) => {
      // 3-T2 lock order: workspaces -> sessions -> runs. Taking the workspace
      // row lock before the session row is what serializes "start a new run"
      // with archive (which locks the same row first). Any other order would
      // let the two interleave and a queued run could survive an archive.
      await lockActiveWorkspaceForSession(transaction, input.tenantId, input.sessionId, input.requestedBy)
      const [session] = await transaction<{ id: string }[]>`
        select id from sessions
         where tenant_id = ${input.tenantId} and id = ${input.sessionId}
           and created_by = ${input.requestedBy} and status = 'active'
         for update
      `
      if (!session) throw new Error(`Session 不存在或不可访问：${input.sessionId}`)

      const [created] = await transaction<RunRow[]>`
        insert into runs (
          id, tenant_id, session_id, requested_by, idempotency_key, status
        ) values (
          ${runId}, ${input.tenantId}, ${input.sessionId}, ${input.requestedBy}, ${input.idempotencyKey}, 'queued'
        )
        on conflict (tenant_id, session_id, requested_by, idempotency_key) do nothing
        returning id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
                  idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
                  created_at as "createdAt", updated_at as "updatedAt"
      `
      if (created) return mapRun(created)
      const [existing] = await transaction<RunRow[]>`
        select id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
               idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
               created_at as "createdAt", updated_at as "updatedAt"
          from runs
         where tenant_id = ${input.tenantId} and session_id = ${input.sessionId}
           and requested_by = ${input.requestedBy} and idempotency_key = ${input.idempotencyKey}
      `
      if (!existing) throw new Error('幂等 Run 查询失败')
      return mapRun(existing)
    })
  }

  async getRun(tenantId: string, runId: string) {
    const [row] = await this.database<RunRow[]>`
      select id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
             idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
             created_at as "createdAt", updated_at as "updatedAt"
        from runs where tenant_id = ${tenantId} and id = ${runId}
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

  async createAttempt(input: CreateAttemptInput): Promise<RunAttemptRecord> {
    return this.database.begin(async (transaction) => {
      // 3-T2: same workspace lock as createRun. Retry/续写 resurrects a
      // failed/cancelled run into a new queued attempt, so it is a real
      // "start a run" path and must not slip past an archive.
      await lockActiveWorkspaceForRun(transaction, input.tenantId, input.runId)
      const [run] = await transaction<{ status: RunState }[]>`
        select r.status from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        where r.tenant_id = ${input.tenantId} and r.id = ${input.runId} and s.status = 'active'
        for update of s, r
      `
      if (!run) throw new Error(`Run 不存在或所属 Session 已归档：${input.runId}`)
      if (!['queued', 'failed', 'cancelled'].includes(run.status)) {
        throw new Error(`Run 当前状态不能创建 Attempt：${run.status}`)
      }
      if (input.manifest['purpose'] === 'admin-skill-install' || input.manifest['purpose'] === 'admin-skill-test') {
        const [active] = await transaction`select id from run_attempts where tenant_id = ${input.tenantId} and run_id = ${input.runId} and status in ('queued', 'running', 'cancel_requested') limit 1`
        if (active) throw Object.assign(new Error('该请求已有进行中的 Attempt，请刷新安装状态'), { status: 409, code: 'attempt_already_active' })
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
      return mapAttempt(created)
    })
  }

  async transitionRun(tenantId: string, runId: string, to: RunState): Promise<RunRecord> {
    return this.database.begin(async (transaction) => {
      const [current] = await transaction<RunRow[]>`
        select id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
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
         returning id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
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
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
       where a.tenant_id = ${tenantIdValue} and a.id = ${attemptId}
    `
    return row?.status ?? null
  }

  async claimAttempt(tenantId: string, attemptId: string, runtimeId: string): Promise<boolean> {
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
      const [usage] = await transaction<{ active: number }[]>`
        select count(*)::integer as active from run_attempts
         where tenant_id = ${tenantId} and runtime_id = ${runtimeId} and status = 'running'
      `
      if ((usage?.active ?? 0) >= runtime.capacity) return false
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
      const endedAt = isTerminalState(to) ? new Date() : null
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
               r.session_id as "runSessionId", r.requested_by as "runRequestedBy",
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
               r.session_id as "runSessionId", r.requested_by as "runRequestedBy",
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
      select r.id, r.tenant_id as "tenantId", r.session_id as "sessionId",
             r.requested_by as "requestedBy", r.idempotency_key as "idempotencyKey",
             r.status, r.current_attempt_id as "currentAttemptId",
             r.created_at as "createdAt", r.updated_at as "updatedAt"
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
       where r.tenant_id = ${tenantId}
         and s.workspace_id = ${workspaceId}
         and r.requested_by = ${userId}
         and r.status in ('queued', 'running', 'cancel_requested')
       order by r.created_at asc
    `
    return rows.map(mapRun)
  }

  async listActiveRunsForAgentMember(tenantId: string, workspaceId: string, agentMemberId: string) {
    const rows = await this.database<RunRow[]>`
      select r.id, r.tenant_id as "tenantId", r.session_id as "sessionId",
             r.requested_by as "requestedBy", r.idempotency_key as "idempotencyKey",
             r.status, r.current_attempt_id as "currentAttemptId",
             r.created_at as "createdAt", r.updated_at as "updatedAt"
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join workspace_agent_members wam
          on wam.tenant_id = s.tenant_id
         and wam.workspace_id = s.workspace_id
         and wam.id = ${agentMemberId}
       where r.tenant_id = ${tenantId}
         and s.workspace_id = ${workspaceId}
         and s.agent_version_id = wam.agent_version_id
         and r.status in ('queued', 'running', 'cancel_requested')
       order by r.created_at asc
    `
    return rows.map(mapRun)
  }

  async listActiveRunsInWorkspace(tenantId: string, workspaceId: string): Promise<WorkspaceActiveRun[]> {
    const rows = await this.database<(RunRow & { agentVersionId: string })[]>`
      select r.id, r.tenant_id as "tenantId", r.session_id as "sessionId",
             r.requested_by as "requestedBy", r.idempotency_key as "idempotencyKey",
             r.status, r.current_attempt_id as "currentAttemptId",
             r.created_at as "createdAt", r.updated_at as "updatedAt",
             s.agent_version_id as "agentVersionId"
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
       where r.tenant_id = ${tenantId}
         and s.workspace_id = ${workspaceId}
         and r.status in ('queued', 'running', 'cancel_requested')
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
  requestedBy: string,
): Promise<void> {
  const [workspace] = await transaction<{ status: string }[]>`
    select w.status
      from sessions s
      join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
     where s.tenant_id = ${tenantIdValue} and s.id = ${sessionId}
       and s.created_by = ${requestedBy}
     for update of w
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
      join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
      join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
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
      join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
      join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
     where a.tenant_id = ${tenantIdValue} and a.id = ${attemptId}
     for update of w
  `
  if (!workspace) return true
  return workspace.status === 'active'
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
