import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { RuntimeScopeCeiling } from '../authorization/postgres-authorization-service.ts'
import type { JsonObject } from '../run/run-types.ts'
import type {
  AutomationAdmissionStatus,
  AutomationExecutionKind,
  AutomationExecutionRecord,
  AutomationInputTemplate,
  AutomationRecord,
  AutomationSchedule,
  AutomationStatus,
  FrozenExecutionConfig,
} from './automation-types.ts'

const tenantId = 'tenant-dsh-work'
const NON_TERMINAL_RUN_STATES = ['queued', 'running', 'cancel_requested']

interface AutomationRow {
  id: string
  tenantId: string
  ownerUserId: string
  name: string
  agentVersionId: string
  agentId?: string | null
  agentName?: string | null
  agentVersion?: string | null
  workspaceId: string
  schedule: AutomationSchedule
  scheduleRevision: number
  nextSlotUtc: Date | null
  inputTemplate: AutomationInputTemplate
  scopeCeiling: RuntimeScopeCeiling
  confirmedConfigRevision: string
  revision: number
  status: AutomationStatus
  createdAt: Date
  updatedAt: Date
}

interface ExecutionRow {
  id: string
  tenantId: string
  automationId: string
  triggerId: string
  kind: AutomationExecutionKind
  plannedSlotUtc: Date | null
  missedFromUtc: Date | null
  missedToUtc: Date | null
  taskRevision: number
  scheduleRevision: number
  requestFingerprint: string | null
  executionConfig: JsonObject | null
  sessionId: string | null
  runId: string | null
  admissionStatus: AutomationAdmissionStatus
  reasonCode: string | null
  createdAt: Date
  updatedAt: Date
  runStatus?: string | null
}

const AUTOMATION_COLUMNS = `
  agent_automations.id, agent_automations.tenant_id as "tenantId",
  agent_automations.owner_user_id as "ownerUserId", agent_automations.name,
  agent_automations.agent_version_id as "agentVersionId",
  agent_automations.workspace_id as "workspaceId",
  agent_automations.schedule, agent_automations.schedule_revision as "scheduleRevision",
  agent_automations.next_slot_utc as "nextSlotUtc", agent_automations.input_template as "inputTemplate",
  agent_automations.scope_ceiling as "scopeCeiling",
  agent_automations.confirmed_config_revision as "confirmedConfigRevision",
  agent_automations.revision, agent_automations.status,
  agent_automations.created_at as "createdAt", agent_automations.updated_at as "updatedAt"
`

/** 展示列：经 agent_versions 回联 agents 取业务 Agent ID / 名称 / 版本号（左联：Agent 删除后为 null）。 */
const AUTOMATION_DISPLAY_COLUMNS = `${AUTOMATION_COLUMNS},
  av.agent_id as "agentId", ag.name as "agentName", av.version as "agentVersion"`

const AUTOMATION_AGENT_JOIN = `
  left join agent_versions av
    on av.tenant_id = agent_automations.tenant_id and av.id = agent_automations.agent_version_id
  left join agents ag
    on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
`

const EXECUTION_BASE_COLUMNS = `
  id, tenant_id as "tenantId", automation_id as "automationId",
  trigger_id as "triggerId", kind,
  planned_slot_utc as "plannedSlotUtc",
  missed_from_utc as "missedFromUtc", missed_to_utc as "missedToUtc",
  task_revision as "taskRevision", schedule_revision as "scheduleRevision",
  request_fingerprint as "requestFingerprint",
  execution_config as "executionConfig",
  session_id as "sessionId", run_id as "runId",
  admission_status as "admissionStatus", reason_code as "reasonCode",
  created_at as "createdAt", updated_at as "updatedAt"
`

const EXECUTION_COLUMNS = `
  e.id, e.tenant_id as "tenantId", e.automation_id as "automationId",
  e.trigger_id as "triggerId", e.kind,
  e.planned_slot_utc as "plannedSlotUtc",
  e.missed_from_utc as "missedFromUtc", e.missed_to_utc as "missedToUtc",
  e.task_revision as "taskRevision", e.schedule_revision as "scheduleRevision",
  e.request_fingerprint as "requestFingerprint",
  e.execution_config as "executionConfig",
  e.session_id as "sessionId", e.run_id as "runId",
  e.admission_status as "admissionStatus", e.reason_code as "reasonCode",
  e.created_at as "createdAt", e.updated_at as "updatedAt"
`

function mapAutomation(row: AutomationRow): AutomationRecord {
  return {
    ...row,
    agentId: row.agentId ?? null,
    agentName: row.agentName ?? null,
    agentVersion: row.agentVersion ?? null,
    nextSlotUtc: row.nextSlotUtc ? row.nextSlotUtc.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 调度规则等值比较：逐字段比对，不依赖 JSON 键序——jsonb 不保留键序，
 * JSON.stringify 直接比较会把 weekly 等规则误判为变更（无谓 bump
 * schedule_revision 并清空已确认配置摘要）。
 */
function sameSchedule(a: AutomationSchedule, b: AutomationSchedule): boolean {
  if (a.kind !== b.kind || a.timezone !== b.timezone) return false
  if ((a.timeOfDay ?? '') !== (b.timeOfDay ?? '')) return false
  const daysA = [...(a.weekdays ?? [])].sort((x, y) => x - y)
  const daysB = [...(b.weekdays ?? [])].sort((x, y) => x - y)
  return JSON.stringify(daysA) === JSON.stringify(daysB)
}

function mapExecution(row: ExecutionRow): AutomationExecutionRecord {
  return {
    ...row,
    executionConfig: (row.executionConfig ?? null) as FrozenExecutionConfig | null,
    plannedSlotUtc: row.plannedSlotUtc ? row.plannedSlotUtc.toISOString() : null,
    missedFromUtc: row.missedFromUtc ? row.missedFromUtc.toISOString() : null,
    missedToUtc: row.missedToUtc ? row.missedToUtc.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export class PostgresAutomationRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async create(input: {
    ownerUserId: string
    name: string
    agentVersionId: string
    workspaceId: string
    schedule: AutomationSchedule
    nextSlotUtc: string | null
    inputTemplate: AutomationInputTemplate
  }): Promise<AutomationRecord> {
    const [row] = await this.database<AutomationRow[]>`
      insert into agent_automations (
        id, tenant_id, owner_user_id, name, agent_version_id, workspace_id,
        schedule, next_slot_utc, input_template
      ) values (
        ${`automation-${randomUUID()}`}, ${tenantId}, ${input.ownerUserId}, ${input.name},
        ${input.agentVersionId}, ${input.workspaceId},
        ${this.database.json(input.schedule as unknown as JsonObject)},
        ${input.nextSlotUtc}, ${this.database.json(input.inputTemplate as unknown as JsonObject)}
      )
      returning agent_automations.id
    `
    if (!row) throw new Error('自动任务创建失败')
    const created = await this.getById(row.id)
    if (!created) throw new Error('自动任务创建失败')
    return created
  }

  async getById(id: string): Promise<AutomationRecord | null> {
    const [row] = await this.database<AutomationRow[]>`
      select ${this.database.unsafe(AUTOMATION_DISPLAY_COLUMNS)}
        from agent_automations
        ${this.database.unsafe(AUTOMATION_AGENT_JOIN)}
       where agent_automations.tenant_id = ${tenantId} and agent_automations.id = ${id}
    `
    return row ? mapAutomation(row) : null
  }

  async getByIdForOwner(id: string, ownerUserId: string): Promise<AutomationRecord | null> {
    const [row] = await this.database<AutomationRow[]>`
      select ${this.database.unsafe(AUTOMATION_DISPLAY_COLUMNS)}
        from agent_automations
        ${this.database.unsafe(AUTOMATION_AGENT_JOIN)}
       where agent_automations.tenant_id = ${tenantId} and agent_automations.id = ${id}
         and agent_automations.owner_user_id = ${ownerUserId}
    `
    return row ? mapAutomation(row) : null
  }

  async listByOwner(ownerUserId: string): Promise<AutomationRecord[]> {
    const rows = await this.database<AutomationRow[]>`
      select ${this.database.unsafe(AUTOMATION_DISPLAY_COLUMNS)}
        from agent_automations
        ${this.database.unsafe(AUTOMATION_AGENT_JOIN)}
       where agent_automations.tenant_id = ${tenantId}
         and agent_automations.owner_user_id = ${ownerUserId}
         and agent_automations.status <> 'disabled'
       order by agent_automations.created_at desc
    `
    return rows.map(mapAutomation)
  }

  /** 到期任务：enabled 且下一未处理槽位已到（扫描入口）。 */
  async listDue(nowUtc: Date, limit = 256): Promise<AutomationRecord[]> {
    const rows = await this.database<AutomationRow[]>`
      select ${this.database.unsafe(AUTOMATION_DISPLAY_COLUMNS)}
        from agent_automations
        ${this.database.unsafe(AUTOMATION_AGENT_JOIN)}
       where agent_automations.tenant_id = ${tenantId} and agent_automations.status = 'enabled'
         and agent_automations.next_slot_utc is not null and agent_automations.next_slot_utc <= ${nowUtc}
       order by agent_automations.next_slot_utc asc
       limit ${limit}
    `
    return rows.map(mapAutomation)
  }

  /** 受理事务内锁定任务行：串行化触发、暂停与规则修改。 */
  async lockForUpdate(tx: DatabaseTransaction, id: string): Promise<AutomationRecord | null> {
    const [row] = await tx<AutomationRow[]>`
      select ${tx.unsafe(AUTOMATION_DISPLAY_COLUMNS)}
        from agent_automations
        ${tx.unsafe(AUTOMATION_AGENT_JOIN)}
       where agent_automations.tenant_id = ${tenantId} and agent_automations.id = ${id}
       for update of agent_automations
    `
    return row ? mapAutomation(row) : null
  }

  /** 草稿/暂停态编辑；修订字段变更 bump revision，调度字段变更 bump scheduleRevision。 */
  async updateEditable(
    id: string,
    patch: {
      name?: string
      agentVersionId?: string
      workspaceId?: string
      inputTemplate?: AutomationInputTemplate
      schedule?: AutomationSchedule
      nextSlotUtc?: string | null
    },
  ): Promise<AutomationRecord | null> {
    const current = await this.getById(id)
    if (!current || !['draft', 'paused'].includes(current.status)) return null
    const scheduleChanged = patch.schedule !== undefined
      && !sameSchedule(patch.schedule, current.schedule)
    const configChanged = patch.agentVersionId !== undefined
      || patch.workspaceId !== undefined
      || patch.inputTemplate !== undefined
    const [row] = await this.database<AutomationRow[]>`
      update agent_automations set
        name = ${patch.name ?? current.name},
        agent_version_id = ${patch.agentVersionId ?? current.agentVersionId},
        workspace_id = ${patch.workspaceId ?? current.workspaceId},
        input_template = ${this.database.json((patch.inputTemplate ?? current.inputTemplate) as unknown as JsonObject)},
        schedule = ${this.database.json((patch.schedule ?? current.schedule) as unknown as JsonObject)},
        schedule_revision = schedule_revision + ${scheduleChanged ? 1 : 0},
        next_slot_utc = ${patch.nextSlotUtc !== undefined ? patch.nextSlotUtc : current.nextSlotUtc},
        revision = revision + ${configChanged ? 1 : 0},
        confirmed_config_revision = ${configChanged || scheduleChanged ? '' : current.confirmedConfigRevision},
        updated_at = now()
      where tenant_id = ${tenantId} and id = ${id} and status in ('draft', 'paused')
      returning id
    `
    return row ? this.getById(row.id) : null
  }

  /** 启用/暂停/停用的条件状态迁移；附带字段在迁移成功时一并写入。 */
  async transitionStatus(
    id: string,
    expected: AutomationStatus[],
    next: AutomationStatus,
    fields?: {
      scopeCeiling?: RuntimeScopeCeiling
      confirmedConfigRevision?: string
      nextSlotUtc?: string | null
    },
  ): Promise<AutomationRecord | null> {
    const [row] = await this.database<AutomationRow[]>`
      update agent_automations set
        status = ${next},
        scope_ceiling = case
          when ${fields?.scopeCeiling !== undefined}
          then ${this.database.json((fields?.scopeCeiling ?? {}) as unknown as JsonObject)}
          else scope_ceiling end,
        confirmed_config_revision = case
          when ${fields?.confirmedConfigRevision !== undefined}
          then ${fields?.confirmedConfigRevision ?? ''}
          else confirmed_config_revision end,
        next_slot_utc = case
          when ${fields?.nextSlotUtc !== undefined}
          then ${fields?.nextSlotUtc ?? null}
          else next_slot_utc end,
        updated_at = now()
      where tenant_id = ${tenantId} and id = ${id} and status in ${this.database(expected)}
      returning id
    `
    return row ? this.getById(row.id) : null
  }

  async findExecutionByTrigger(
    tx: DatabaseTransaction,
    automationId: string,
    triggerId: string,
  ): Promise<AutomationExecutionRecord | null> {
    const [row] = await tx<ExecutionRow[]>`
      select ${tx.unsafe(EXECUTION_COLUMNS)}
        from automation_executions e
       where e.tenant_id = ${tenantId} and e.automation_id = ${automationId}
         and e.trigger_id = ${triggerId}
    `
    return row ? mapExecution(row) : null
  }

  /** 重叠判定：任务锁内查「已受理且 Run 未终结」的执行（含无 Attempt 的 queued）。 */
  async findActiveExecution(
    tx: DatabaseTransaction,
    automationId: string,
  ): Promise<AutomationExecutionRecord | null> {
    const [row] = await tx<ExecutionRow[]>`
      select ${tx.unsafe(EXECUTION_COLUMNS)}, r.status as "runStatus"
        from automation_executions e
        join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
       where e.tenant_id = ${tenantId} and e.automation_id = ${automationId}
         and e.admission_status = 'accepted'
         and r.status in ${tx(NON_TERMINAL_RUN_STATES)}
       order by e.created_at desc
       limit 1
    `
    return row ? mapExecution(row) : null
  }

  async countUserPending(tx: DatabaseTransaction, ownerUserId: string): Promise<number> {
    const [row] = await tx<{ count: number }[]>`
      select count(*)::integer as count
        from automation_executions e
        join agent_automations a on a.tenant_id = e.tenant_id and a.id = e.automation_id
        join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
       where e.tenant_id = ${tenantId} and a.owner_user_id = ${ownerUserId}
         and e.admission_status = 'accepted' and r.status in ${tx(NON_TERMINAL_RUN_STATES)}
    `
    return row?.count ?? 0
  }

  async countGlobalPending(tx: DatabaseTransaction): Promise<number> {
    const [row] = await tx<{ count: number }[]>`
      select count(*)::integer as count
        from automation_executions e
        join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
       where e.tenant_id = ${tenantId}
         and e.admission_status = 'accepted' and r.status in ${tx(NON_TERMINAL_RUN_STATES)}
    `
    return row?.count ?? 0
  }

  async insertExecution(
    tx: DatabaseTransaction,
    input: {
      automationId: string
      triggerId: string
      kind: AutomationExecutionKind
      plannedSlotUtc: string | null
      missedFromUtc?: string | null
      missedToUtc?: string | null
      taskRevision: number
      scheduleRevision: number
      requestFingerprint?: string | null
      executionConfig?: JsonObject | null
      sessionId?: string | null
      runId?: string | null
      admissionStatus: AutomationAdmissionStatus
      reasonCode?: string | null
    },
  ): Promise<AutomationExecutionRecord | null> {
    const [row] = await tx<ExecutionRow[]>`
      insert into automation_executions (
        id, tenant_id, automation_id, trigger_id, kind,
        planned_slot_utc, missed_from_utc, missed_to_utc,
        task_revision, schedule_revision, request_fingerprint,
        execution_config, session_id, run_id, admission_status, reason_code
      ) values (
        ${`autexec-${randomUUID()}`}, ${tenantId}, ${input.automationId}, ${input.triggerId}, ${input.kind},
        ${input.plannedSlotUtc}, ${input.missedFromUtc ?? null}, ${input.missedToUtc ?? null},
        ${input.taskRevision}, ${input.scheduleRevision}, ${input.requestFingerprint ?? null},
        ${tx.json((input.executionConfig ?? {}) as JsonObject)},
        ${input.sessionId ?? null}, ${input.runId ?? null},
        ${input.admissionStatus}, ${input.reasonCode ?? null}
      )
      on conflict (tenant_id, automation_id, trigger_id) do nothing
      returning ${tx.unsafe(EXECUTION_BASE_COLUMNS)}
    `
    return row ? mapExecution(row) : null
  }

  /** 游标推进：条件更新防止并发处理器重复登记同一区间。 */
  async advanceSlotCursor(
    tx: DatabaseTransaction,
    automationId: string,
    expectedNextSlotUtc: string | null,
    newNextSlotUtc: string | null,
  ): Promise<boolean> {
    const updated = await tx`
      update agent_automations
         set next_slot_utc = ${newNextSlotUtc}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${automationId}
         and next_slot_utc is not distinct from ${expectedNextSlotUtc}
    `
    return updated.count > 0
  }

  async markAdmission(
    executionId: string,
    status: AutomationAdmissionStatus,
    reasonCode?: string,
    tx?: DatabaseTransaction,
  ): Promise<void> {
    const executor = tx ?? this.database
    await executor`
      update automation_executions
         set admission_status = ${status}, reason_code = ${reasonCode ?? null}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${executionId}
    `
  }

  async listExecutions(automationId: string, limit = 50): Promise<AutomationExecutionRecord[]> {
    const rows = await this.database<ExecutionRow[]>`
      select ${this.database.unsafe(EXECUTION_COLUMNS)}, r.status as "runStatus"
        from automation_executions e
        left join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
       where e.tenant_id = ${tenantId} and e.automation_id = ${automationId}
       order by e.created_at desc
       limit ${limit}
    `
    return rows.map(mapExecution)
  }

  async getExecution(automationId: string, executionId: string): Promise<AutomationExecutionRecord | null> {
    const [row] = await this.database<ExecutionRow[]>`
      select ${this.database.unsafe(EXECUTION_COLUMNS)}, r.status as "runStatus"
        from automation_executions e
        left join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
       where e.tenant_id = ${tenantId} and e.automation_id = ${automationId}
         and e.id = ${executionId}
    `
    return row ? mapExecution(row) : null
  }

  /**
   * 暂停/停用清理目标：已受理但 Run 仍 queued（未开始执行）的执行记录。
   * running/cancel_requested 的已开始执行不在此列（由「取消当前」或撤权处理）。
   */
  async listQueuedAcceptedExecutions(automationId: string): Promise<AutomationExecutionRecord[]> {
    const rows = await this.database<ExecutionRow[]>`
      select ${this.database.unsafe(EXECUTION_COLUMNS)}, r.status as "runStatus"
        from automation_executions e
        join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
       where e.tenant_id = ${tenantId} and e.automation_id = ${automationId}
         and e.admission_status = 'accepted' and r.status = 'queued'
       order by e.created_at asc
    `
    return rows.map(mapExecution)
  }

  /**
   * 执行前复核兜底：按 run_id 反查所属自动任务当前状态与该执行是否为
   * 试运行受理（AG-03）。无关联执行或任务被删除时返回 null。
   */
  async automationStatusForRun(runId: string): Promise<{ status: string; trial: boolean } | null> {
    const [row] = await this.database<{ status: string; trial: boolean | null }[]>`
      select a.status,
             coalesce((e.execution_config->>'trial')::boolean, false) as trial
        from automation_executions e
        join agent_automations a on a.tenant_id = e.tenant_id and a.id = e.automation_id
       where e.tenant_id = ${tenantId} and e.run_id = ${runId}
       limit 1
    `
    return row ? { status: row.status, trial: row.trial === true } : null
  }

  /**
   * 启动恢复候选：已受理但 Run 停在「无 Attempt 的 queued」——受理事务提交后、
   * dispatch 前进程中断。此类执行必须显式收敛为 interrupted，不能静默重放。
   */
  async listInterruptedPreparations(): Promise<AutomationExecutionRecord[]> {
    const rows = await this.database<ExecutionRow[]>`
      select ${this.database.unsafe(EXECUTION_COLUMNS)}, r.status as "runStatus"
        from automation_executions e
        join runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
       where e.tenant_id = ${tenantId} and e.admission_status = 'accepted'
         and r.status = 'queued' and r.current_attempt_id is null
    `
    return rows.map(mapExecution)
  }
}
