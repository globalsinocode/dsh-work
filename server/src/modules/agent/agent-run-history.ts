import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { notFound } from '../../domain/request-errors.ts'

const tenantId = 'tenant-dsh-work'
const MAX_LIMIT = 50

export type AgentRunSource = 'conversation' | 'validation' | 'routine' | 'automation' | 'api' | 'event' | 'system'

export interface AgentRunSummary {
  runId: string
  status: string
  source: AgentRunSource
  /** The Agent version the current Attempt ran; null before the first Attempt starts. */
  version: string | null
  requestedBy: string
  sessionTitle: string | null
  errorCode: string | null
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}

interface Row {
  runId: string
  status: string
  sourceType: string
  purpose: string | null
  version: string | null
  requestedBy: string
  sessionTitle: string | null
  errorCode: string | null
  createdAt: Date
  startedAt: Date | null
  endedAt: Date | null
}

/**
 * Recent Runs executed as an Agent's own principal: employee conversations,
 * routines, automations and validation runs. Read-only; the Run itself stays
 * the authority for detail and events.
 */
export class PostgresAgentRunHistory {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async listRecentRuns(agentId: string, limit = 20): Promise<AgentRunSummary[]> {
    const [principal] = await this.database<{ id: string }[]>`
      select id from execution_principals
       where tenant_id = ${tenantId} and kind = 'agent' and agent_id = ${agentId}
    `
    if (!principal) throw notFound(`Agent 不存在：${agentId}`)
    const size = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_LIMIT) : 20
    const rows = await this.database<Row[]>`
      select r.id as "runId", r.status, t.source_type as "sourceType",
             a.manifest->>'purpose' as purpose, av.version,
             coalesce(u.display_name, r.requested_by) as "requestedBy",
             s.title as "sessionTitle", a.error_code as "errorCode",
             r.created_at as "createdAt", a.started_at as "startedAt", a.ended_at as "endedAt"
        from tasks t
        join runs r on r.tenant_id = t.tenant_id and r.task_id = t.id
        left join run_attempts a on a.tenant_id = r.tenant_id and a.id = r.current_attempt_id
        left join agent_versions av on av.tenant_id = r.tenant_id and av.id = a.manifest->>'agent_version_id'
        left join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        left join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
       where t.tenant_id = ${tenantId} and t.executed_as_principal_id = ${principal.id}
       -- 与 0086 的 tasks(tenant_id, executed_as_principal_id, created_at desc) 索引同序；
       -- 一个 Run 对应一个 Task，按任务创建时间排序与按 Run 创建时间近似等价。
       order by t.created_at desc, r.id desc
       limit ${size}
    `
    return rows.map(row => ({
      runId: row.runId,
      status: row.status,
      source: sourceOf(row),
      version: row.version,
      requestedBy: row.requestedBy,
      sessionTitle: row.sessionTitle,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
    }))
  }
}

function sourceOf(row: Row): AgentRunSource {
  if (row.purpose === 'agent-release-trial') return 'validation'
  switch (row.sourceType) {
    case 'session': return 'conversation'
    case 'agent_routine': return 'routine'
    case 'automation': return 'automation'
    case 'api': return 'api'
    case 'event': return 'event'
    default: return 'system'
  }
}
