import { createHash, randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { PostgresAuthorizationService, RuntimeAuthorizationDecision } from '../authorization/postgres-authorization-service.ts'
import { authorizationDenied, isAuthorizationDenial, requestInvalid } from '../authorization/authorization-errors.ts'
import type { PostgresRunRepository } from '../run/postgres-run-repository.ts'
import type { RunOrchestrationService } from '../run/run-orchestration-service.ts'
import type { PostgresConversationRepository } from '../workbench/application/postgres-conversation-repository.ts'
import type { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import type { JsonObject } from '../run/run-types.ts'
import { nextSlotUtc, normalizeSchedule, slotsBetween } from './automation-calendar.ts'
import type { AutomationBudget, AutomationSchedule } from './automation-types.ts'

const tenantId = 'tenant-dsh-work'
const maxPromptLength = 20_000
const maxPendingPerAgent = 10
const maxPendingGlobal = 200
const maxLatenessMs = 10 * 60_000

export type AgentRoutineSchedule = AutomationSchedule | { kind: 'event'; eventType: string; timezone: string }

export interface AgentRoutine {
  id: string; agentId: string; agentVersionId: string; workspaceId: string; recipientUserId: string
  name: string; schedule: AgentRoutineSchedule; scheduleRevision: number; nextSlotUtc: string | null
  inputTemplate: { prompt: string; budget: AutomationBudget }
  approvedRoleIds: string[]; approvedDataScopes: string[]; confirmedConfigRevision: string
  revision: number; status: 'draft' | 'enabled' | 'paused' | 'disabled'
  lastAdmissionStatus?: 'accepted' | 'skipped' | 'interrupted' | null
  lastReasonCode?: string | null
  createdBy: string; approvedBy: string | null; approvedAt: string | null
  createdAt: string; updatedAt: string
}

export interface AgentRoutineExecution {
  id: string; routineId: string; triggerId: string; kind: 'scheduled' | 'manual' | 'event' | 'missed'
  plannedSlotUtc: string | null; missedFromUtc: string | null; missedToUtc: string | null
  routineRevision: number; scheduleRevision: number; taskId: string | null; runId: string | null
  admissionStatus: 'accepted' | 'skipped' | 'interrupted'; reasonCode: string | null
  triggerEvidence: { actorUserId?: string; eventType?: string; source?: string; eventId?: string }
  runStatus?: string | null; resultOutcome?: string | null; createdAt: string
}

export interface AgentRoutineRecipientResult {
  executionId: string; routineName: string; agentName: string; workspaceId: string
  runId: string; runStatus: string; resultOutcome: string | null
  answer: string | null; createdAt: string
}

type RoutineRow = Omit<AgentRoutine, 'nextSlotUtc' | 'approvedAt' | 'createdAt' | 'updatedAt'> & {
  nextSlotUtc: Date | null; approvedAt: Date | null; createdAt: Date; updatedAt: Date
}
type ExecutionRow = Omit<AgentRoutineExecution, 'plannedSlotUtc' | 'missedFromUtc' | 'missedToUtc' | 'createdAt'> & {
  plannedSlotUtc: Date | null; missedFromUtc: Date | null; missedToUtc: Date | null; createdAt: Date
}

const routineColumns = `id, agent_id as "agentId", agent_version_id as "agentVersionId",
  workspace_id as "workspaceId", recipient_user_id as "recipientUserId", name,
  schedule, schedule_revision as "scheduleRevision", next_slot_utc as "nextSlotUtc",
  input_template as "inputTemplate", approved_role_ids as "approvedRoleIds",
  approved_data_scopes as "approvedDataScopes", confirmed_config_revision as "confirmedConfigRevision",
  revision, status, created_by as "createdBy", approved_by as "approvedBy",
  approved_at as "approvedAt", created_at as "createdAt", updated_at as "updatedAt"`
const executionColumns = `e.id, e.routine_id as "routineId", e.trigger_id as "triggerId",
  e.kind, e.planned_slot_utc as "plannedSlotUtc", e.missed_from_utc as "missedFromUtc",
  e.missed_to_utc as "missedToUtc", e.routine_revision as "routineRevision",
  e.schedule_revision as "scheduleRevision", e.task_id as "taskId", e.run_id as "runId",
  e.admission_status as "admissionStatus", e.reason_code as "reasonCode",
  e.trigger_evidence as "triggerEvidence", e.created_at as "createdAt"`

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function conflict(message: string): Error { return Object.assign(new Error(message), { status: 409, code: 'state_conflict' }) }
function missing(): Error { return Object.assign(new Error('Agent 主动任务不存在'), { status: 404, code: 'not_found' }) }
function mapRoutine(row: RoutineRow): AgentRoutine {
  return { ...row, nextSlotUtc: row.nextSlotUtc?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}
function mapExecution(row: ExecutionRow): AgentRoutineExecution {
  return { ...row, plannedSlotUtc: row.plannedSlotUtc?.toISOString() ?? null,
    missedFromUtc: row.missedFromUtc?.toISOString() ?? null,
    missedToUtc: row.missedToUtc?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }
}
function normalizeName(name: string): string {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!value || value.length > 120) throw requestInvalid('任务名称长度必须为 1～120 个字符')
  return value
}
function normalizeInput(input: { prompt: string; budget?: AutomationBudget; fileIds?: string[] }): AgentRoutine['inputTemplate'] {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > maxPromptLength) {
    throw requestInvalid('输入模板必须包含不超过 20000 字符的任务提示')
  }
  if (input.fileIds?.length) throw requestInvalid('Agent 主动任务暂不接受员工文件输入')
  const budget = input.budget ?? {}
  for (const key of ['timeoutSeconds', 'maxToolCalls', 'maxOutputBytes'] as const) {
    const value = budget[key]
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw requestInvalid(`预算 ${key} 必须是正整数`)
  }
  return { prompt: input.prompt, budget }
}
function normalizeRoutineSchedule(input: AgentRoutineSchedule): AgentRoutineSchedule {
  if (input?.kind === 'event') {
    if (typeof input.eventType !== 'string' || !/^[a-z][a-z0-9_.:-]{2,79}$/.test(input.eventType)) {
      throw requestInvalid('事件类型必须是 3～80 字符的受控标识')
    }
    const timezone = normalizeSchedule({ kind: 'manual', timezone: input.timezone }).timezone
    return { kind: 'event', eventType: input.eventType, timezone }
  }
  return normalizeSchedule(input)
}
function sameRoutineSchedule(left: AgentRoutineSchedule, right: AgentRoutineSchedule): boolean {
  if (left.kind !== right.kind || left.timezone !== right.timezone) return false
  if (left.kind === 'event' || right.kind === 'event') {
    return left.kind === 'event' && right.kind === 'event' && left.eventType === right.eventType
  }
  if ((left.timeOfDay ?? '') !== (right.timeOfDay ?? '')) return false
  const daysLeft = [...(left.weekdays ?? [])].sort((a, b) => a - b)
  const daysRight = [...(right.weekdays ?? [])].sort((a, b) => a - b)
  return JSON.stringify(daysLeft) === JSON.stringify(daysRight)
}

export class AgentRoutineService {
  private readonly database: DatabaseClient
  private readonly authorization: PostgresAuthorizationService
  private readonly runs: PostgresRunRepository
  private readonly orchestration: RunOrchestrationService
  private readonly conversations: PostgresConversationRepository
  private readonly operations?: PostgresOperationsService

  constructor(
    database: DatabaseClient,
    authorization: PostgresAuthorizationService,
    runs: PostgresRunRepository,
    orchestration: RunOrchestrationService,
    conversations: PostgresConversationRepository,
    operations?: PostgresOperationsService,
  ) {
    this.database = database
    this.authorization = authorization
    this.runs = runs
    this.orchestration = orchestration
    this.conversations = conversations
    this.operations = operations
  }

  private async get(id: string, tx: DatabaseTransaction | DatabaseClient = this.database): Promise<AgentRoutine> {
    const [row] = await tx<RoutineRow[]>`
      select ${tx.unsafe(routineColumns)} from agent_routines
       where tenant_id = ${tenantId} and id = ${id}
    `
    if (!row) throw missing()
    return mapRoutine(row)
  }

  async list(agentId: string, actorUserId: string): Promise<AgentRoutine[]> {
    await this.authorization.requirePlatformAdmin(actorUserId)
    const rows = await this.database<RoutineRow[]>`
      select ${this.database.unsafe(routineColumns)}, latest.admission_status as "lastAdmissionStatus",
             latest.reason_code as "lastReasonCode"
        from agent_routines
        left join lateral (
          select admission_status, reason_code from agent_routine_executions e
           where e.tenant_id = agent_routines.tenant_id and e.routine_id = agent_routines.id
           order by e.created_at desc, e.id desc limit 1
        ) latest on true
       where tenant_id = ${tenantId} and agent_id = ${agentId}
       order by created_at desc
    `
    return rows.map(mapRoutine)
  }

  async create(actorUserId: string, input: {
    agentId: string; agentVersionId: string; workspaceId: string; recipientUserId: string
    name: string; schedule: AgentRoutineSchedule; inputTemplate: { prompt: string; budget?: AutomationBudget; fileIds?: string[] }
  }): Promise<AgentRoutine> {
    await this.authorization.requirePlatformAdmin(actorUserId)
    const schedule = normalizeRoutineSchedule(input.schedule)
    const template = normalizeInput(input.inputTemplate)
    const [version] = await this.database<{ id: string }[]>`
      select av.id from agent_versions av join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
       where av.tenant_id = ${tenantId} and av.id = ${input.agentVersionId} and av.agent_id = ${input.agentId}
         and av.status = 'published' and a.status = 'published'
    `
    if (!version) throw authorizationDenied('只能为已发布的 Agent Version 创建主动任务')
    const id = `agent-routine-${randomUUID()}`
    await this.database`
      insert into agent_routines (id, tenant_id, agent_id, agent_version_id, workspace_id,
        recipient_user_id, name, schedule, input_template, created_by)
      values (${id}, ${tenantId}, ${input.agentId}, ${input.agentVersionId}, ${input.workspaceId},
        ${input.recipientUserId}, ${normalizeName(input.name)},
        ${this.database.json(schedule as unknown as JsonObject)}, ${this.database.json(template as unknown as JsonObject)}, ${actorUserId})
    `
    await this.operations?.appendAudit(actorUserId, 'agent.routine.create', id, 'success', `trace-${id}`, '创建 Agent 主动任务草稿')
    return this.get(id)
  }

  async update(actorUserId: string, agentId: string, id: string, patch: {
    expectedRevision: number; name?: string; agentVersionId?: string; workspaceId?: string
    recipientUserId?: string; schedule?: AgentRoutineSchedule
    inputTemplate?: { prompt: string; budget?: AutomationBudget; fileIds?: string[] }
  }): Promise<AgentRoutine> {
    await this.authorization.requirePlatformAdmin(actorUserId)
    const current = await this.get(id)
    if (current.agentId !== agentId) throw missing()
    if (!['draft', 'paused'].includes(current.status) || current.revision !== patch.expectedRevision) throw conflict('任务修订或状态已变化')
    const versionId = patch.agentVersionId ?? current.agentVersionId
    const [version] = await this.database<{ id: string }[]>`
      select av.id from agent_versions av join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
       where av.tenant_id = ${tenantId} and av.id = ${versionId} and av.agent_id = ${agentId}
         and av.status = 'published' and a.status = 'published'
    `
    if (!version) throw authorizationDenied('Agent Version 不存在或不可用')
    const schedule = patch.schedule ? normalizeRoutineSchedule(patch.schedule) : current.schedule
    const template = patch.inputTemplate ? normalizeInput(patch.inputTemplate) : current.inputTemplate
    const scheduleChanged = !sameRoutineSchedule(schedule, current.schedule)
    const [row] = await this.database<{ id: string }[]>`
      update agent_routines set name = ${patch.name === undefined ? current.name : normalizeName(patch.name)},
        agent_version_id = ${versionId}, workspace_id = ${patch.workspaceId ?? current.workspaceId},
        recipient_user_id = ${patch.recipientUserId ?? current.recipientUserId},
        schedule = ${this.database.json(schedule as unknown as JsonObject)}, input_template = ${this.database.json(template as unknown as JsonObject)},
        schedule_revision = schedule_revision + ${scheduleChanged ? 1 : 0},
        next_slot_utc = null, confirmed_config_revision = '',
        revision = revision + 1, updated_at = now()
       where tenant_id = ${tenantId} and id = ${id} and agent_id = ${agentId}
         and revision = ${patch.expectedRevision} and status in ('draft', 'paused')
       returning id
    `
    if (!row) throw conflict('任务修订或状态已变化')
    return this.get(id)
  }

  async enable(actorUserId: string, agentId: string, id: string,
    approved: { roleIds: string[]; dataScopes: string[]; expectedRevision: number }): Promise<AgentRoutine> {
    await this.authorization.requirePlatformAdmin(actorUserId)
    const routine = await this.get(id)
    if (routine.agentId !== agentId) throw missing()
    if (!['draft', 'paused'].includes(routine.status) || routine.revision !== approved.expectedRevision) {
      throw conflict('任务修订或状态已变化')
    }
    if (!Array.isArray(approved.roleIds) || !approved.roleIds.length || !Array.isArray(approved.dataScopes)) {
      throw requestInvalid('启用时必须明确批准角色与数据范围上限')
    }
    const roleIds = [...new Set(approved.roleIds)].sort()
    const dataScopes = [...new Set(approved.dataScopes)].sort()
    const decision = await this.authorization.authorizeAgentRoutine({
      agentVersionId: routine.agentVersionId, workspaceId: routine.workspaceId,
      recipientUserId: routine.recipientUserId, scopeCeiling: { roleIds, dataScopes },
    })
    if (decision.roleIds.length !== roleIds.length || decision.dataScopes.length !== dataScopes.length) {
      throw authorizationDenied('批准上限包含 Agent 当前未获授权的角色或数据范围')
    }
    const configRevision = digest(JSON.stringify({ agentVersionId: routine.agentVersionId,
      workspaceId: routine.workspaceId, recipientUserId: routine.recipientUserId,
      inputTemplate: routine.inputTemplate, schedule: routine.schedule, roleIds, dataScopes }))
    const next = routine.schedule.kind === 'manual' || routine.schedule.kind === 'event'
      ? null : nextSlotUtc(routine.schedule, new Date())?.toISOString() ?? null
    const [row] = await this.database<{ id: string }[]>`
      update agent_routines set status = 'enabled', approved_role_ids = ${roleIds}::text[],
        approved_data_scopes = ${dataScopes}::text[], confirmed_config_revision = ${configRevision},
        next_slot_utc = ${next}, approved_by = ${actorUserId}, approved_at = now(), updated_at = now()
       where tenant_id = ${tenantId} and id = ${id} and agent_id = ${agentId}
         and revision = ${approved.expectedRevision} and status in ('draft', 'paused')
       returning id
    `
    if (!row) throw conflict('任务修订或状态已变化')
    await this.operations?.appendAudit(actorUserId, 'agent.routine.enable', id, 'success', `trace-${id}`, '批准并启用 Agent 主动任务')
    return this.get(id)
  }

  async setStatus(actorUserId: string, agentId: string, id: string, next: 'paused' | 'disabled'): Promise<AgentRoutine> {
    await this.authorization.requirePlatformAdmin(actorUserId)
    const current = await this.get(id)
    if (current.agentId !== agentId) throw missing()
    const [row] = await this.database<{ id: string }[]>`
      update agent_routines set status = ${next}, next_slot_utc = null, updated_at = now()
       where tenant_id = ${tenantId} and id = ${id} and agent_id = ${agentId}
         and status in ${this.database(next === 'paused' ? ['enabled'] : ['draft', 'enabled', 'paused'])}
       returning id
    `
    if (!row) throw conflict('任务状态已变化')
    // Both queued and active Attempts are blocked by the shared live authorization gate.
    await this.operations?.appendAudit(actorUserId, `agent.routine.${next}`, id, 'success', `trace-${id}`, 'Agent 主动任务状态变更')
    return this.get(id)
  }

  async executions(actorUserId: string, agentId: string, id: string): Promise<AgentRoutineExecution[]> {
    await this.authorization.requirePlatformAdmin(actorUserId)
    const routine = await this.get(id)
    if (routine.agentId !== agentId) throw missing()
    const rows = await this.database<ExecutionRow[]>`
      select ${this.database.unsafe(executionColumns)}, run.status as "runStatus"
        from agent_routine_executions e left join runs run on run.tenant_id = e.tenant_id and run.id = e.run_id
       where e.tenant_id = ${tenantId} and e.routine_id = ${id}
       order by e.created_at desc limit 100
    `
    const outcomes = await this.conversations.getTaskResultOutcomes(rows.map(row => row.runId).filter((v): v is string => !!v))
    return rows.map(row => ({ ...mapExecution(row), resultOutcome: row.runId ? outcomes.get(row.runId) ?? null : null }))
  }

  async recipientResults(userId: string): Promise<AgentRoutineRecipientResult[]> {
    type RecipientRow = Omit<AgentRoutineRecipientResult, 'createdAt' | 'resultOutcome'> & {
      createdAt: Date; dataScopes: string[] | null
    }
    const rows = await this.database<RecipientRow[]>`
      select execution.id as "executionId", routine.name as "routineName", agent.name as "agentName",
             task.workspace_id as "workspaceId", run.id as "runId", run.status as "runStatus",
             answer.display_message as answer, execution.created_at as "createdAt",
             execution.execution_config->'dataScopes' as "dataScopes"
        from agent_routine_executions execution
        join agent_routines routine on routine.tenant_id = execution.tenant_id and routine.id = execution.routine_id
        join agents agent on agent.tenant_id = routine.tenant_id and agent.id = routine.agent_id
        join runs run on run.tenant_id = execution.tenant_id and run.id = execution.run_id
        join tasks task on task.tenant_id = run.tenant_id and task.id = run.task_id
        left join lateral (
          select event.display_message from run_events event
           where event.tenant_id = run.tenant_id and event.attempt_id = run.current_attempt_id
             and event.event_type = 'assistant.completed'
           order by event.sequence desc limit 1
        ) answer on true
       where execution.tenant_id = ${tenantId} and task.requested_by = ${userId}
         and task.source_type = 'agent_routine' and task.source_ref = execution.routine_id
         and execution.admission_status = 'accepted'
       order by execution.created_at desc limit 100
    `
    const visible: RecipientRow[] = []
    for (const row of rows) {
      try {
        const recipient = await this.authorization.authorizeWorkbench({ userId, workspaceId: row.workspaceId })
        if (!Array.isArray(row.dataScopes) || !row.dataScopes.every(scope => recipient.dataScopes.includes(scope))) continue
        visible.push(row)
      }
      catch (error) { if (!isAuthorizationDenial(error)) throw error }
    }
    const outcomes = await this.conversations.getTaskResultOutcomes(visible.map(row => row.runId))
    return visible.map(row => ({ executionId: row.executionId, routineName: row.routineName,
      agentName: row.agentName, workspaceId: row.workspaceId, runId: row.runId,
      runStatus: row.runStatus, answer: row.answer ?? null,
      resultOutcome: outcomes.get(row.runId) ?? null, createdAt: row.createdAt.toISOString() }))
  }

  async runNow(actorUserId: string, agentId: string, id: string, idempotencyKey: string): Promise<AgentRoutineExecution> {
    await this.authorization.requirePlatformAdmin(actorUserId)
    const routine = await this.get(id)
    if (routine.agentId !== agentId) throw missing()
    if (routine.status !== 'enabled') throw conflict('Agent 主动任务未启用')
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
      throw requestInvalid('idempotencyKey 必须是 1～128 字符')
    }
    const triggerId = digest(`manual|${id}|${idempotencyKey}`)
    return this.admit(id, triggerId, 'manual', new Date().toISOString(), null, { actorUserId })
  }

  /** Trusted event intake: source and event ID form a lifetime deduplication key. */
  async triggerEvent(actorUserId: string, agentId: string, id: string, input: {
    eventType: string; source: string; eventId: string
  }): Promise<AgentRoutineExecution> {
    await this.authorization.requirePlatformAdmin(actorUserId)
    const routine = await this.get(id)
    if (routine.agentId !== agentId) throw missing()
    if (routine.status !== 'enabled') throw conflict('Agent 主动任务未启用')
    if (routine.schedule.kind !== 'event' || routine.schedule.eventType !== input.eventType) {
      throw requestInvalid('事件类型与已批准规则不匹配')
    }
    for (const value of [input.source, input.eventId]) {
      if (typeof value !== 'string' || !value.trim() || value.length > 128) {
        throw requestInvalid('事件来源和事件 ID 必须为 1～128 字符')
      }
    }
    const triggerId = digest(JSON.stringify(['event', id, input.eventType, input.source, input.eventId]))
    return this.admit(id, triggerId, 'event', new Date().toISOString(), null, {
      actorUserId, eventType: input.eventType, source: input.source, eventId: input.eventId,
    })
  }

  async processDue(now = new Date()): Promise<void> {
    const due = await this.database<{ id: string }[]>`
      select id from agent_routines where tenant_id = ${tenantId} and status = 'enabled'
        and next_slot_utc <= ${now} order by next_slot_utc asc limit 100
    `
    for (const item of due) {
      try { await this.processRoutine(item.id, now) }
      catch (error) { console.error(`agent routine ${item.id} sweep failed`, error) }
    }
  }

  private async processRoutine(id: string, now: Date): Promise<void> {
    const routine = await this.get(id)
    if (routine.status !== 'enabled' || !routine.nextSlotUtc || routine.schedule.kind === 'event') return
    const slots = slotsBetween(routine.schedule, new Date(new Date(routine.nextSlotUtc).getTime() - 1), now, 32)
    if (!slots.length) return
    let cursor = routine.nextSlotUtc
    const missed = slots.filter(slot => now.getTime() - slot.getTime() > maxLatenessMs)
    if (missed.length) {
      const after = nextSlotUtc(routine.schedule, missed.at(-1)!)?.toISOString() ?? null
      await this.recordMissed(routine, missed[0]!, missed.at(-1)!, cursor, after)
      cursor = after ?? ''
    }
    for (const slot of slots.filter(item => now.getTime() - item.getTime() <= maxLatenessMs)) {
      const next = nextSlotUtc(routine.schedule, slot)?.toISOString() ?? null
      await this.admit(id, digest(`scheduled|${id}|${routine.scheduleRevision}|${slot.toISOString()}`),
        'scheduled', slot.toISOString(), { expectedCursor: cursor, nextCursor: next, scheduleRevision: routine.scheduleRevision })
      cursor = next ?? ''
    }
  }

  private async recordMissed(routine: AgentRoutine, from: Date, to: Date,
    expectedCursor: string, nextCursor: string | null): Promise<void> {
    await this.database.begin(async tx => {
      const [locked] = await tx<RoutineRow[]>`
        select ${tx.unsafe(routineColumns)} from agent_routines
         where tenant_id = ${tenantId} and id = ${routine.id} for update
      `
      if (!locked || locked.status !== 'enabled' || locked.nextSlotUtc?.toISOString() !== expectedCursor
        || locked.scheduleRevision !== routine.scheduleRevision) return
      const trigger = digest(`missed|${routine.id}|${routine.scheduleRevision}|${from.toISOString()}|${to.toISOString()}`)
      await tx`
        insert into agent_routine_executions (id, tenant_id, routine_id, trigger_id, kind,
          missed_from_utc, missed_to_utc, routine_revision, schedule_revision, admission_status, reason_code)
        values (${`agent-routine-exec-${randomUUID()}`}, ${tenantId}, ${routine.id}, ${trigger}, 'missed',
          ${from}, ${to}, ${routine.revision}, ${routine.scheduleRevision}, 'skipped', 'slot_expired')
        on conflict (tenant_id, routine_id, trigger_id) do nothing
      `
      await tx`update agent_routines set next_slot_utc = ${nextCursor}, updated_at = now()
        where tenant_id = ${tenantId} and id = ${routine.id}`
    })
  }

  private async admit(id: string, triggerId: string, kind: 'scheduled' | 'manual' | 'event', slot: string,
    cursor: { expectedCursor: string; nextCursor: string | null; scheduleRevision: number } | null,
    triggerEvidence: AgentRoutineExecution['triggerEvidence'] = {},
  ): Promise<AgentRoutineExecution> {
    const result = await this.database.begin(async tx => {
      const [locked] = await tx<RoutineRow[]>`
        select ${tx.unsafe(routineColumns)} from agent_routines where tenant_id = ${tenantId} and id = ${id} for update
      `
      if (!locked) throw missing()
      const routine = mapRoutine(locked)
      const [existing] = await tx<ExecutionRow[]>`
        select ${tx.unsafe(executionColumns)} from agent_routine_executions e
         where e.tenant_id = ${tenantId} and e.routine_id = ${id} and e.trigger_id = ${triggerId}
      `
      if (existing) return { execution: mapExecution(existing), run: null, decision: null, frozen: null }
      if (cursor && (routine.nextSlotUtc !== cursor.expectedCursor || routine.scheduleRevision !== cursor.scheduleRevision)) {
        throw conflict('调度游标已变化')
      }
      const insert = async (reason: string | null, run?: Awaited<ReturnType<PostgresRunRepository['createRun']>>,
        decision?: RuntimeAuthorizationDecision) => {
        const executionId = `agent-routine-exec-${randomUUID()}`
        const [row] = await tx<ExecutionRow[]>`
          insert into agent_routine_executions (id, tenant_id, routine_id, trigger_id, kind, planned_slot_utc,
            routine_revision, schedule_revision, request_fingerprint, trigger_evidence, execution_config, task_id, run_id,
            admission_status, reason_code)
          values (${executionId}, ${tenantId}, ${id}, ${triggerId}, ${kind}, ${slot},
            ${routine.revision}, ${routine.scheduleRevision}, ${kind === 'manual' ? digest('run-now') : kind === 'event' ? digest('event') : null},
            ${tx.json(triggerEvidence as JsonObject)},
            ${tx.json(run ? { configRevision: routine.confirmedConfigRevision,
              roleIds: decision?.roleIds, dataScopes: decision?.dataScopes } : {})},
            ${run?.taskId ?? null}, ${run?.id ?? null}, ${run ? 'accepted' : 'skipped'}, ${reason})
          returning ${tx.unsafe(executionColumns.replaceAll('e.', ''))}
        `
        if (cursor) await tx`update agent_routines set next_slot_utc = ${cursor.nextCursor}, updated_at = now()
          where tenant_id = ${tenantId} and id = ${id}`
        return { execution: mapExecution(row!), run: run ?? null, decision: decision ?? null,
          frozen: run ? { prompt: routine.inputTemplate.prompt, workspaceId: routine.workspaceId,
            agentVersionId: routine.agentVersionId, recipientUserId: routine.recipientUserId,
            budget: routine.inputTemplate.budget } : null }
      }
      if (routine.status !== 'enabled') return insert('routine_inactive')
      const [overlap] = await tx<{ id: string }[]>`
        select e.id from agent_routine_executions e join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
         where e.tenant_id = ${tenantId} and e.routine_id = ${id} and e.admission_status = 'accepted'
           and r.status in ('queued', 'running', 'waiting', 'cancel_requested') limit 1
      `
      if (overlap) return insert('overlap')
      // Share one admission lock with employee automations so the combined
      // global pending quota cannot be oversubscribed by concurrent triggers.
      await tx`select pg_advisory_xact_lock(hashtext('dsh-work-automation-global-admission'))`
      const [pending] = await tx<{ agent: number; global: number }[]>`
        select
          (select count(*)::integer from agent_routine_executions e join agent_routines routine
            on routine.tenant_id = e.tenant_id and routine.id = e.routine_id
            join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
            where e.tenant_id = ${tenantId} and routine.agent_id = ${routine.agentId} and e.admission_status = 'accepted'
              and r.status in ('queued', 'running', 'waiting', 'cancel_requested')) as agent,
          ((select count(*) from agent_routine_executions e join runs r
            on r.tenant_id = e.tenant_id and r.id = e.run_id
            where e.tenant_id = ${tenantId} and e.admission_status = 'accepted'
              and r.status in ('queued', 'running', 'waiting', 'cancel_requested'))
           + (select count(*) from automation_executions e join runs r
            on r.tenant_id = e.tenant_id and r.id = e.run_id
            where e.tenant_id = ${tenantId} and e.admission_status = 'accepted'
              and r.status in ('queued', 'running', 'waiting', 'cancel_requested')))::integer as global
      `
      if ((pending?.agent ?? 0) >= maxPendingPerAgent) return insert('agent_pending_limit')
      if ((pending?.global ?? 0) >= maxPendingGlobal) return insert('global_pending_limit')
      let decision: RuntimeAuthorizationDecision
      try {
        decision = await this.authorization.authorizeAgentRoutine({
          agentVersionId: routine.agentVersionId, workspaceId: routine.workspaceId,
          recipientUserId: routine.recipientUserId,
          scopeCeiling: { roleIds: routine.approvedRoleIds, dataScopes: routine.approvedDataScopes },
        })
      } catch (error) {
        if (!isAuthorizationDenial(error)) throw error
        return insert('authorization_denied')
      }
      const budget = routine.inputTemplate.budget
      const run = await this.runs.createRun({ tenantId, sessionId: null,
        workspaceId: routine.workspaceId, requestedBy: routine.recipientUserId,
        idempotencyKey: `agent-routine-${triggerId}`, taskSourceType: 'agent_routine',
        taskSourceRef: id, taskCorrelationKey: triggerId,
        taskBudget: {
          ...(budget.timeoutSeconds === undefined ? {} : { maxDurationMs: budget.timeoutSeconds * 1000 }),
          ...(budget.maxToolCalls === undefined ? {} : { maxToolCalls: budget.maxToolCalls }),
          ...(budget.maxOutputBytes === undefined ? {} : { maxOutputBytes: budget.maxOutputBytes }),
        },
      }, tx)
      return insert(null, run, decision)
    })
    if (result.run && result.decision && result.frozen) {
      try {
        await this.orchestration.dispatchAgentRoutine(result.run, {
          prompt: result.frozen.prompt, workspaceId: result.frozen.workspaceId,
          agentVersionId: result.frozen.agentVersionId, recipientUserId: result.frozen.recipientUserId,
          attemptId: `attempt-${result.execution.id}`, authorization: result.decision,
          budget: result.frozen.budget,
        })
      } catch (error) {
        await this.orchestration.convergeInterruptedAutomationRun(result.run.id, 'Agent 主动任务派发中断')
        const current = await this.runs.getRun(tenantId, result.run.id)
        if (!current?.currentAttemptId) await this.database`
          update agent_routine_executions set admission_status = 'interrupted',
            reason_code = 'dispatch_interrupted', updated_at = now()
           where tenant_id = ${tenantId} and id = ${result.execution.id}
        `
        throw error
      }
    }
    return result.execution
  }

  async recoverInterruptedPreparations(): Promise<number> {
    const rows = await this.database<{ id: string; runId: string }[]>`
      select e.id, e.run_id as "runId" from agent_routine_executions e
        join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
       where e.tenant_id = ${tenantId} and e.admission_status = 'accepted'
         and r.status = 'queued' and r.current_attempt_id is null
    `
    let recovered = 0
    for (const row of rows) {
      if (!await this.orchestration.convergeInterruptedAutomationRun(row.runId, 'Agent 主动任务准备中断')) continue
      await this.database`update agent_routine_executions set admission_status = 'interrupted',
        reason_code = 'dispatch_interrupted', updated_at = now()
        where tenant_id = ${tenantId} and id = ${row.id}`
      recovered += 1
    }
    return recovered
  }
}
