import { randomUUID } from 'node:crypto'

import type {
  AuditEvent,
  AuditEventListQuery,
  EmployeeModelUsageSummary,
  HealthComponent,
  ListPage,
  ManagedWorkspaceDefinition,
  ModelUsageListQuery,
  ModelUsagePage,
  ModelUsageRecord,
  OperationsSummary,
  RuntimeDefinition,
  SessionDefinition,
  SessionListPage,
  SessionListQuery,
  UpdateRuntimeConfigurationInput,
  UsagePoint,
} from '../../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { RunAttemptRecord, RunRecord } from '../../run/run-types.ts'
import type { AgentRuntimePort } from '../../runtime/runtime-types.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import { authorizationDenied } from '../../authorization/authorization-errors.ts'
import { redactSensitiveText, sanitizeSafeMetadata } from '../../../security/safe-observability.ts'

const tenantId = 'tenant-dsh-work'

export interface RuntimeMutationSnapshot {
  runtimeId: string
  maxConcurrentWorkers: number
  attemptTimeoutMinutes: number
  schedulingStatus: RuntimeDefinition['schedulingStatus']
  revision: number
}

export class PostgresOperationsService {
  private readonly database: DatabaseClient
  private readonly runtime?: AgentRuntimePort
  private readonly authorization?: PostgresAuthorizationService
  private readonly sso: 'mock' | 'ai-hub-oidc'

  constructor(
    database: DatabaseClient,
    runtime?: AgentRuntimePort,
    authorization?: PostgresAuthorizationService,
    sso: 'mock' | 'ai-hub-oidc' = 'mock',
  ) {
    this.database = database
    this.runtime = runtime
    this.authorization = authorization
    this.sso = sso
  }

  async getTaskSummaries() {
    return this.database<{ id: string; status: string }[]>`
      select id, status from runs where tenant_id = ${tenantId} order by created_at desc limit 100
    `
  }

  async getRuntimes(): Promise<RuntimeDefinition[]> {
    const liveHealth = await this.runtime?.health()
    const rows = await this.database<{
      id: string; nodeName: string; runtimeVersion: string; healthStatus: RuntimeDefinition['status'];
      schedulingStatus: RuntimeDefinition['schedulingStatus']; capacity: number; lastHeartbeatAt: Date | null;
      activeWorkers: number; queuedRuns: number; timeoutSeconds: number
    }[]>`
      select r.id, r.node_name as "nodeName", r.runtime_version as "runtimeVersion",
             r.health_status as "healthStatus", r.scheduling_status as "schedulingStatus",
             r.capacity, r.last_heartbeat_at as "lastHeartbeatAt",
             count(a.id) filter (where a.status = 'running')::integer as "activeWorkers",
             count(a.id) filter (where a.status = 'queued')::integer as "queuedRuns",
             coalesce((select timeout_seconds from runtime_configurations c
                        where c.tenant_id = r.tenant_id and c.runtime_id = r.id
                        order by revision desc limit 1), 300)::integer as "timeoutSeconds"
        from runtimes r
        left join run_attempts a on a.tenant_id = r.tenant_id and a.runtime_id = r.id
       where r.tenant_id = ${tenantId}
       group by r.id
       order by r.id
    `
    return rows.map((row) => ({
      id: row.id,
      name: row.nodeName,
      environment: '本地环境',
      mode: 'dsh-worker',
      status: liveHealth?.runtimeId === row.id ? liveHealth.status : row.healthStatus,
      schedulingStatus: row.schedulingStatus,
      version: liveHealth?.runtimeId === row.id && liveHealth.runtimeVersion
        ? liveHealth.runtimeVersion
        : row.runtimeVersion,
      endpoint: 'ACP stdio（本机子进程）',
      maxConcurrentWorkers: row.capacity,
      activeWorkers: row.activeWorkers,
      queuedRuns: row.queuedRuns,
      attemptTimeoutMinutes: Math.ceil(row.timeoutSeconds / 60),
      lastHeartbeat: row.lastHeartbeatAt ? formatDateTime(row.lastHeartbeatAt) : '—',
      checkedAt: '刚刚',
      healthMessage: liveHealth?.runtimeId === row.id
        ? liveHealth.message
        : row.healthStatus === 'healthy'
          ? 'DSH Runtime 已登记，等待实时健康检查。'
          : 'Runtime 当前不可用。',
      capabilities: ['ACP stdio', 'DSH Agent Loop', '取消', '事件流', '工作区沙箱'],
    }))
  }

  async checkRuntime(input: { runtimeId: string; actor: string }) {
    const actor = await this.requirePlatformAdmin(input.actor)
    await this.requireRuntime(input.runtimeId)
    const health = await this.runtime?.health()
    const status = health?.runtimeId === input.runtimeId ? health.status : 'offline'
    await this.database`
      update runtimes set health_status = ${status}, last_heartbeat_at = now(),
                          runtime_version = coalesce(${health?.runtimeVersion ?? null}, runtime_version)
       where tenant_id = ${tenantId} and id = ${input.runtimeId}
    `
    await this.appendAudit(
      actor.id,
      'runtime.health.check',
      input.runtimeId,
      status === 'offline' ? 'failed' : 'success',
      `trace-runtime-${input.runtimeId}`,
      health?.message ?? 'Runtime Adapter 未连接',
    )
    return (await this.getRuntimes()).find((runtime) => runtime.id === input.runtimeId)
  }

  async getRuntimeMutationSnapshot(runtimeId: string): Promise<RuntimeMutationSnapshot> {
    const snapshot = await this.readRuntimeMutationSnapshot(this.database, runtimeId)
    if (!snapshot) throw new Error(`Runtime 不存在：${runtimeId}`)
    return snapshot
  }

  async updateRuntimeConfiguration(input: UpdateRuntimeConfigurationInput, expected?: RuntimeMutationSnapshot) {
    const actor = await this.requirePlatformAdmin(input.actor)
    assertRuntimeConfiguration(input)
    let runtimeConfigurationStarted = false
    try {
      await this.database.begin(async (transaction) => {
        const runtime = await this.readRuntimeMutationSnapshot(transaction, input.runtimeId, true)
        if (!runtime) throw new Error(`Runtime 不存在：${input.runtimeId}`)
        if (expected && !sameRuntimeMutationSnapshot(runtime, expected)) {
          throw new Error('Runtime 状态已变化，请重新生成操作计划')
        }

        if (input.schedulingStatus === 'accepting') {
          const health = await this.runtime?.health()
          if (!health || health.runtimeId !== input.runtimeId || health.status === 'offline') {
            throw new Error('Runtime 当前离线，不能切换为接收任务')
          }
        }

        const [active] = await transaction<{ count: number }[]>`
          select count(*)::integer as count from run_attempts
           where tenant_id = ${tenantId} and runtime_id = ${input.runtimeId} and status = 'running'
        `
        if (input.maxConcurrentWorkers < (active?.count ?? 0)) {
          throw new Error('最大并发数不能小于当前活动 Worker 数')
        }

        await transaction`
          insert into runtime_configurations (
            tenant_id, runtime_id, revision, concurrency_limit, timeout_seconds, sandbox_policy, updated_by
          ) select ${tenantId}, ${input.runtimeId}, coalesce(max(revision), 0) + 1,
                   ${input.maxConcurrentWorkers}, ${input.attemptTimeoutMinutes * 60},
                   '{"network":"deny","write":"workspace_only","approval":"risk_based"}', ${actor.id}
            from runtime_configurations
           where tenant_id = ${tenantId} and runtime_id = ${input.runtimeId}
        `
        const updated = await transaction`
          update runtimes set capacity = ${input.maxConcurrentWorkers},
                              scheduling_status = ${input.schedulingStatus}
           where tenant_id = ${tenantId} and id = ${input.runtimeId}
           returning id
        `
        if (!updated.length) throw new Error(`Runtime 不存在：${input.runtimeId}`)

        // claimAttempt locks the same Runtime row before admitting work. Keep
        // the row lock while mirroring the state so no claim can observe a
        // half-applied scheduling transition.
        runtimeConfigurationStarted = true
        await this.runtime?.configureScheduling?.(input.schedulingStatus)
      })
    } catch (error) {
      if (runtimeConfigurationStarted) {
        await this.reconcileRuntimeScheduling(input.runtimeId).catch(() => undefined)
      }
      throw error
    }
    await this.appendAudit(actor.id, 'runtime.configuration.update', input.runtimeId, 'success', `trace-runtime-${input.runtimeId}`, `${input.schedulingStatus} · 并发 ${input.maxConcurrentWorkers} · 超时 ${input.attemptTimeoutMinutes} 分钟`)
    return (await this.getRuntimes()).find((runtime) => runtime.id === input.runtimeId)
  }

  async getRuntimePolicy(runtimeId: string) {
    const runtime = await this.requireRuntime(runtimeId)
    const [configuration] = await this.database<{
      revision: number
      concurrencyLimit: number
      timeoutSeconds: number
      sandboxPolicy: Record<string, unknown>
    }[]>`
      select revision, concurrency_limit as "concurrencyLimit",
             timeout_seconds as "timeoutSeconds", sandbox_policy as "sandboxPolicy"
        from runtime_configurations
       where tenant_id = ${tenantId} and runtime_id = ${runtimeId}
       order by revision desc limit 1
    `
    return {
      runtimeId,
      schedulingStatus: runtime.schedulingStatus,
      concurrencyLimit: configuration?.concurrencyLimit ?? runtime.capacity,
      timeoutSeconds: configuration?.timeoutSeconds ?? 300,
      revision: configuration?.revision ?? 0,
      sandboxPolicy: configuration?.sandboxPolicy ?? {},
    }
  }

  private async readRuntimeMutationSnapshot(
    database: DatabaseClient | DatabaseTransaction,
    runtimeId: string,
    lock = false,
  ): Promise<RuntimeMutationSnapshot | undefined> {
    const [row] = await database<{
      runtimeId: string
      maxConcurrentWorkers: number
      attemptTimeoutMinutes: number
      schedulingStatus: RuntimeDefinition['schedulingStatus']
      revision: number
    }[]>`
      select r.id as "runtimeId", r.capacity as "maxConcurrentWorkers",
             r.scheduling_status as "schedulingStatus",
             ceil(coalesce(configuration.timeout_seconds, 300) / 60.0)::integer as "attemptTimeoutMinutes",
             coalesce(configuration.revision, 0)::integer as revision
        from runtimes r
        left join lateral (
          select revision, timeout_seconds
            from runtime_configurations
           where tenant_id = r.tenant_id and runtime_id = r.id
           order by revision desc limit 1
        ) configuration on true
       where r.tenant_id = ${tenantId} and r.id = ${runtimeId}
       ${lock ? database`for update of r` : database``}
    `
    return row
  }

  async getSessions(input: SessionListQuery = {}): Promise<SessionListPage> {
    const query = input.query?.trim().slice(0, 100) ?? ''
    const status = sessionStatusFilters.has(input.status ?? '') ? (input.status ?? '') : ''
    const workspace = input.workspace?.trim().slice(0, 100) ?? ''
    const page = clampInteger(input.page, 1, 1_000_000, 1)
    const pageSize = clampInteger(input.pageSize, 1, 500, 10)
    const offset = (page - 1) * pageSize
    const like = `%${query}%`
    return this.database.begin(async (transaction) => {
      const [summary] = await transaction<{
        total: number; active: number; awaitingApproval: number; failed: number
      }[]>`
        select count(*)::integer as total,
               count(*) filter (where coalesce(latest.status, 'queued') in ('queued', 'running'))::integer as active,
               count(*) filter (where coalesce(latest.status, 'queued') = 'awaiting_approval')::integer as "awaitingApproval",
               count(*) filter (where coalesce(latest.status, 'queued') = 'failed')::integer as failed
          from sessions s
          left join lateral (select id, status from runs where tenant_id = s.tenant_id and session_id = s.id order by created_at desc limit 1) latest on true
         where s.tenant_id = ${tenantId}
      `
      const [count] = await transaction<{ total: number }[]>`
        select count(*)::integer as total
          from (
            select s.id
              from sessions s
              join users u on u.tenant_id = s.tenant_id and u.id = s.created_by
              join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
              join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
              left join lateral (select id, status from runs where tenant_id = s.tenant_id and session_id = s.id order by created_at desc limit 1) latest on true
              left join lateral (select trace_id from run_events where tenant_id = s.tenant_id and run_id = latest.id order by stream_position desc limit 1) ev on true
             where s.tenant_id = ${tenantId}
               and (${workspace} = '' or s.workspace_id = ${workspace})
               and (${status} = '' or coalesce(latest.status, 'queued') = ${status})
               and (${query} = '' or s.title ilike ${like} or s.id ilike ${like}
                    or u.display_name ilike ${like} or a.name ilike ${like}
                    or latest.id ilike ${like} or ev.trace_id ilike ${like})
             group by s.id
          ) filtered
      `
      const rows = await transaction<{
        id: string; title: string; user: string; workspaceId: string; workspaceName: string;
        agentId: string; agentName: string; agentVersion: string; runId: string | null; status: SessionDefinition['status'] | null;
        runCount: number; messageCount: number; tokenUsage: number; createdAt: Date; updatedAt: Date;
        traceId: string | null
      }[]>`
        select s.id, s.title, u.display_name as "user", s.workspace_id as "workspaceId",
               w.name as "workspaceName",
               a.id as "agentId", a.name as "agentName", av.version as "agentVersion",
               latest.id as "runId", latest.status, count(distinct r.id)::integer as "runCount",
               count(distinct m.id)::integer as "messageCount",
               coalesce(sum(distinct mu.input_tokens + mu.output_tokens), 0)::integer as "tokenUsage",
               s.created_at as "createdAt", s.last_active_at as "updatedAt", ev.trace_id as "traceId"
          from sessions s
          join users u on u.tenant_id = s.tenant_id and u.id = s.created_by
          join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
          join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
          join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
          left join lateral (select id, status, current_attempt_id from runs where tenant_id = s.tenant_id and session_id = s.id order by created_at desc limit 1) latest on true
          left join runs r on r.tenant_id = s.tenant_id and r.session_id = s.id
          left join messages m on m.tenant_id = s.tenant_id and m.session_id = s.id
          left join model_usage_events mu on mu.tenant_id = s.tenant_id and mu.run_id = r.id
          left join lateral (select trace_id from run_events where tenant_id = s.tenant_id and run_id = latest.id order by stream_position desc limit 1) ev on true
         where s.tenant_id = ${tenantId}
           and (${workspace} = '' or s.workspace_id = ${workspace})
           and (${status} = '' or coalesce(latest.status, 'queued') = ${status})
           and (${query} = '' or s.title ilike ${like} or s.id ilike ${like}
                or u.display_name ilike ${like} or a.name ilike ${like}
                or latest.id ilike ${like} or ev.trace_id ilike ${like})
         group by s.id, u.display_name, w.name, a.id, a.name, av.version, latest.id, latest.status, ev.trace_id
         order by s.last_active_at desc
         limit ${pageSize} offset ${offset}
      `
      const workspaces = await transaction<{ id: string; name: string }[]>`
        select distinct w.id, w.name
          from sessions s
          join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
         where s.tenant_id = ${tenantId}
         order by w.name
      `
      return {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          user: row.user,
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          agentId: row.agentId,
          agentName: row.agentName,
          agentVersion: row.agentVersion,
          runId: row.runId ?? '—',
          status: row.status ?? 'queued',
          runCount: row.runCount,
          messageCount: row.messageCount,
          tokenUsage: row.tokenUsage,
          createdAt: formatDateTime(row.createdAt),
          updatedAt: formatDateTime(row.updatedAt),
          traceId: row.traceId ?? '—',
        })),
        total: count?.total ?? 0,
        page,
        pageSize,
        summary: summary ?? { total: 0, active: 0, awaitingApproval: 0, failed: 0 },
        facets: { workspaces },
      }
    })
  }

  async getManagedWorkspaces(): Promise<ManagedWorkspaceDefinition[]> {
    const rows = await this.database<{
      id: string; name: string; description: string; creator: string; memberCount: number;
      sessionCount: number; artifactCount: number; fileCount: number; createdAt: Date; updatedAt: Date
    }[]>`
      select w.id, w.name, w.description, u.display_name as creator,
             count(distinct wm.user_id)::integer as "memberCount", count(distinct s.id)::integer as "sessionCount",
             count(distinct a.id)::integer as "artifactCount", count(distinct f.id)::integer as "fileCount",
             w.created_at as "createdAt", greatest(w.created_at, coalesce(max(s.last_active_at), w.created_at)) as "updatedAt"
        from workspaces w join users u on u.tenant_id = w.tenant_id and u.id = w.created_by
        left join workspace_members wm on wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
        left join sessions s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
        left join artifacts a on a.tenant_id = w.tenant_id and a.workspace_id = w.id
        left join file_objects f on f.tenant_id = w.tenant_id and f.workspace_id = w.id and f.session_id is null
       where w.tenant_id = ${tenantId} and w.workspace_type = 'team'
       group by w.id, u.display_name order by w.created_at desc
    `
    return rows.map((row) => ({
      id: row.id, name: row.name, description: row.description, type: 'team',
      creator: row.creator, memberCount: row.memberCount,
      sessionCount: row.sessionCount, artifactCount: row.artifactCount, fileCount: row.fileCount,
      createdAt: formatDateTime(row.createdAt), updatedAt: formatDateTime(row.updatedAt),
    }))
  }

  async getAuditEvents(input: AuditEventListQuery = {}): Promise<ListPage<AuditEvent>> {
    return this.readOperationalEvents(input)
  }

  async getRunOperations(runId: string): Promise<AuditEvent[]> {
    const [run] = await this.database<{ id: string }[]>`
      select id from runs where tenant_id = ${tenantId} and id = ${runId}
    `
    if (!run) throw new Error(`Run 不存在：${runId}`)
    return (await this.readOperationalEvents({ runId, pageSize: 500 })).items
  }

  async getOperationsSummary(): Promise<OperationsSummary> {
    const [summary] = await this.database<OperationsSummary[]>`
      select
        (select count(*)::integer from runs
          where tenant_id = ${tenantId} and created_at >= now() - interval '24 hours') as "runs24h",
        (select count(*)::integer from runs
          where tenant_id = ${tenantId} and status = 'succeeded'
            and updated_at >= now() - interval '24 hours') as "successfulRuns24h",
        (select count(*)::integer from runs
          where tenant_id = ${tenantId} and status = 'failed'
            and updated_at >= now() - interval '24 hours') as "failedRuns24h",
        (select coalesce(sum(input_tokens + output_tokens), 0)::integer from model_usage_events
          where tenant_id = ${tenantId} and occurred_at >= now() - interval '24 hours') as "modelTokens24h",
        (select count(*)::integer from tool_audit_logs
          where tenant_id = ${tenantId} and occurred_at >= now() - interval '24 hours') as "toolCalls24h",
        (select count(*)::integer from artifact_versions
          where tenant_id = ${tenantId} and created_at >= now() - interval '24 hours') as "artifacts24h",
        (select count(*)::integer from operational_events
          where tenant_id = ${tenantId} and occurred_at >= now() - interval '24 hours'
            and result in ('failed', 'blocked')) as "attentionEvents24h"
    `
    return summary ?? {
      runs24h: 0, successfulRuns24h: 0, failedRuns24h: 0, modelTokens24h: 0,
      toolCalls24h: 0, artifacts24h: 0, attentionEvents24h: 0,
    }
  }

  private async readOperationalEvents(input: AuditEventListQuery & { runId?: string } = {}): Promise<ListPage<AuditEvent>> {
    const runId = input.runId
    const query = input.query?.trim().slice(0, 100) ?? ''
    const status = auditStatusFilters.has(input.status ?? '') ? (input.status ?? '') : ''
    const category = auditCategoryFilters.has(input.category ?? '') ? (input.category ?? '') : ''
    const page = clampInteger(input.page, 1, 1_000_000, 1)
    const pageSize = clampInteger(input.pageSize, 1, 500, 10)
    const offset = (page - 1) * pageSize
    const like = `%${query}%`
    return this.database.begin(async (transaction) => {
      const [count] = await transaction<{ total: number }[]>`
        select count(*)::integer as total
          from operational_events oe
          left join users u on u.tenant_id = oe.tenant_id and u.id = oe.actor_id
         where oe.tenant_id = ${tenantId}
           and (${runId ?? null}::text is null or oe.run_id = ${runId ?? null})
           and (${status} = '' or oe.result = ${status})
           and (${category} = '' or oe.category = ${category})
           and (${query} = '' or
                (case when oe.actor_id = 'system' then '系统' else coalesce(u.display_name, oe.actor_id) end) ilike ${like}
                or (oe.object_type || ' · ' || oe.object_id) ilike ${like}
                or oe.trace_id ilike ${like}
                or coalesce(oe.run_id, '') ilike ${like}
                or coalesce(oe.attempt_id, '') ilike ${like}
                or oe.safe_context::text ilike ${like})
      `
      const rows = await transaction<{
        id: string; occurredAt: Date; actor: string; category: AuditEvent['category']; action: string;
        objectType: string; objectId: string; result: AuditEvent['status']; traceId: string;
        runId: string | null; attemptId: string | null; safeContext: Record<string, unknown>
      }[]>`
        select oe.id, oe.occurred_at as "occurredAt",
               case when oe.actor_id = 'system' then '系统' else coalesce(u.display_name, oe.actor_id) end as actor,
               oe.category, oe.action, oe.object_type as "objectType", oe.object_id as "objectId", oe.result,
               oe.trace_id as "traceId", oe.run_id as "runId", oe.attempt_id as "attemptId",
               oe.safe_context as "safeContext"
          from operational_events oe
          left join users u on u.tenant_id = oe.tenant_id and u.id = oe.actor_id
         where oe.tenant_id = ${tenantId}
           and (${runId ?? null}::text is null or oe.run_id = ${runId ?? null})
           and (${status} = '' or oe.result = ${status})
           and (${category} = '' or oe.category = ${category})
           and (${query} = '' or
                (case when oe.actor_id = 'system' then '系统' else coalesce(u.display_name, oe.actor_id) end) ilike ${like}
                or (oe.object_type || ' · ' || oe.object_id) ilike ${like}
                or oe.trace_id ilike ${like}
                or coalesce(oe.run_id, '') ilike ${like}
                or coalesce(oe.attempt_id, '') ilike ${like}
                or oe.safe_context::text ilike ${like})
         order by oe.occurred_at desc
         limit ${pageSize} offset ${offset}
      `
      return {
        items: rows.map((row) => ({
          id: row.id, time: formatDateTime(row.occurredAt), actor: row.actor, department: 'dsh-work',
          category: row.category, action: row.action, objectType: row.objectType, objectId: row.objectId,
          object: `${row.objectType} · ${row.objectId}`, status: row.result,
          traceId: row.traceId, runId: row.runId, attemptId: row.attemptId,
          detail: JSON.stringify(sanitizeSafeMetadata(row.safeContext)),
        })),
        total: count?.total ?? 0,
        page,
        pageSize,
      }
    })
  }

  async getHealth(): Promise<HealthComponent[]> {
    const [runtime] = await this.getRuntimes()
    const [quality] = await this.database<{ sampleSize: number; succeeded: number; failed: number }[]>`
      select count(*)::integer as "sampleSize",
             count(*) filter (where status = 'succeeded')::integer as succeeded,
             count(*) filter (where status = 'failed')::integer as failed
        from (
          select status from run_attempts
           where tenant_id = ${tenantId}
             and status in ('succeeded', 'failed')
             and created_at >= now() - interval '24 hours'
           order by created_at desc
           limit 20
        ) recent
    `
    const sampleSize = quality?.sampleSize ?? 0
    const failed = quality?.failed ?? 0
    const runtimeConnected = runtime?.status === 'healthy'
    const runtimeStatus: HealthComponent['status'] = !runtimeConnected
      ? 'offline'
      : failed > 0 ? 'warning' : 'healthy'
    const executionQuality = sampleSize === 0
      ? '尚无最近执行样本'
      : `最近 ${sampleSize} 次完成中 ${quality?.succeeded ?? 0} 次成功、${failed} 次失败`
    return [
      { id: 'server', name: 'dsh-work 服务端', category: 'application', status: 'healthy', detail: '当前可用', message: '服务端响应正常', checkedAt: '刚刚' },
      { id: 'postgres', name: 'PostgreSQL', category: 'dependency', status: 'healthy', detail: '当前可用', message: '数据服务连接正常', checkedAt: '刚刚' },
      {
        id: runtime?.id ?? 'runtime',
        name: 'DSH Runtime',
        category: 'runtime',
        status: runtimeStatus,
        detail: executionQuality,
        message: runtime ? `${runtime.healthMessage}；调度：${runtime.schedulingStatus}` : 'Runtime 未注册',
        checkedAt: '刚刚',
      },
    ]
  }

  async getUsage(): Promise<UsagePoint[]> {
    const rows = await this.database<{ day: string; runs: number; tokens: number }[]>`
      select to_char(days.day, 'MM-DD') as day, count(distinct r.id)::integer as runs,
             coalesce(sum(mu.input_tokens + mu.output_tokens), 0)::integer as tokens
        from generate_series(current_date - interval '6 days', current_date, interval '1 day') days(day)
        left join runs r on r.tenant_id = ${tenantId} and r.created_at::date = days.day::date
        left join model_usage_events mu on mu.tenant_id = r.tenant_id and mu.run_id = r.id
       group by days.day order by days.day
    `
    return rows
  }

  async getModelUsage(input: ModelUsageListQuery = {}): Promise<ModelUsagePage> {
    const query = input.query?.trim().slice(0, 100) ?? ''
    const employee = input.employee?.trim().slice(0, 100) ?? ''
    const provider = input.provider?.trim().slice(0, 100) ?? ''
    const status = auditStatusFilters.has(input.status ?? '') ? (input.status ?? '') : ''
    const page = clampInteger(input.page, 1, 1_000_000, 1)
    const pageSize = clampInteger(input.pageSize, 1, 500, 10)
    const offset = (page - 1) * pageSize
    const like = `%${query}%`
    return this.database.begin(async (transaction) => {
      const [summary] = await transaction<{
        callCount: number; employeeCount: number; totalTokens: number; averageLatencyMs: number | null
      }[]>`
        select count(*)::integer as "callCount",
               count(distinct u.id)::integer as "employeeCount",
               coalesce(sum(mu.input_tokens + mu.output_tokens), 0)::integer as "totalTokens",
               avg(mu.latency_ms) filter (where mu.status = 'success') as "averageLatencyMs"
          from model_usage_events mu
          join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id
          join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
          join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
          join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
          join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
          join run_attempts ra on ra.tenant_id = mu.tenant_id and ra.id = mu.attempt_id
         where mu.tenant_id = ${tenantId}
           and (${status} = '' or mu.status = ${status})
           and (${employee} = '' or u.id = ${employee})
           and (${provider} = '' or mu.provider = ${provider})
           and (${query} = '' or
                u.display_name ilike ${like} or u.id ilike ${like}
                or (case u.department_id when 'supply-chain' then '供应链中心' when 'platform' then '数字化中心' else coalesce(nullif(trim(u.department_id), ''), '未归属部门') end) ilike ${like}
                or mu.provider ilike ${like} or mu.model ilike ${like}
                or coalesce(ra.model_route_snapshot ->> 'routeKey', 'default') ilike ${like}
                or a.id ilike ${like} or mu.run_id ilike ${like} or mu.trace_id ilike ${like})
      `
      const rows = await transaction<{
        id: string; occurredAt: Date; runId: string; provider: string; model: string; status: ModelUsageRecord['status'];
        inputTokens: number; outputTokens: number; latencyMs: number | null; traceId: string;
        employeeId: string; employeeName: string; departmentId: string | null; agentId: string; modelRoute: string
      }[]>`
        select mu.id, mu.occurred_at as "occurredAt", mu.run_id as "runId", mu.provider, mu.model, mu.status,
               mu.input_tokens::integer as "inputTokens", mu.output_tokens::integer as "outputTokens",
               mu.latency_ms as "latencyMs", mu.trace_id as "traceId",
               u.id as "employeeId", u.display_name as "employeeName", u.department_id as "departmentId",
               a.id as "agentId", coalesce(ra.model_route_snapshot ->> 'routeKey', 'default') as "modelRoute"
          from model_usage_events mu
          join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id
          join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
          join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
          join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
          join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
          join run_attempts ra on ra.tenant_id = mu.tenant_id and ra.id = mu.attempt_id
         where mu.tenant_id = ${tenantId}
           and (${status} = '' or mu.status = ${status})
           and (${employee} = '' or u.id = ${employee})
           and (${provider} = '' or mu.provider = ${provider})
           and (${query} = '' or
                u.display_name ilike ${like} or u.id ilike ${like}
                or (case u.department_id when 'supply-chain' then '供应链中心' when 'platform' then '数字化中心' else coalesce(nullif(trim(u.department_id), ''), '未归属部门') end) ilike ${like}
                or mu.provider ilike ${like} or mu.model ilike ${like}
                or coalesce(ra.model_route_snapshot ->> 'routeKey', 'default') ilike ${like}
                or a.id ilike ${like} or mu.run_id ilike ${like} or mu.trace_id ilike ${like})
         order by mu.occurred_at desc
         limit ${pageSize} offset ${offset}
      `
      const providers = await transaction<{ provider: string }[]>`
        select distinct mu.provider from model_usage_events mu
         where mu.tenant_id = ${tenantId}
         order by mu.provider
      `
      const employees = await transaction<{ employeeId: string; employeeName: string; departmentId: string | null }[]>`
        select distinct u.id as "employeeId", u.display_name as "employeeName", u.department_id as "departmentId"
          from model_usage_events mu
          join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id
          join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
         where mu.tenant_id = ${tenantId}
         order by u.display_name
      `
      return {
        items: rows.map((row) => ({
          id: row.id, time: formatDateTime(row.occurredAt), runId: row.runId,
          agentId: row.agentId, employeeId: row.employeeId, employeeName: row.employeeName,
          department: departmentLabel(row.departmentId), provider: row.provider,
          model: row.model, modelRoute: row.modelRoute, status: row.status,
          promptTokens: row.inputTokens, completionTokens: row.outputTokens,
          totalTokens: row.inputTokens + row.outputTokens, latencyMs: row.latencyMs ?? 0,
          traceId: row.traceId,
        })),
        total: summary?.callCount ?? 0,
        page,
        pageSize,
        summary: {
          callCount: summary?.callCount ?? 0,
          employeeCount: summary?.employeeCount ?? 0,
          totalTokens: summary?.totalTokens ?? 0,
          averageLatencyMs: Math.round(summary?.averageLatencyMs ?? 0),
        },
        facets: {
          providers: providers.map((row) => row.provider),
          employees: employees.map((row) => ({
            employeeId: row.employeeId,
            employeeName: row.employeeName,
            department: departmentLabel(row.departmentId),
          })),
        },
      }
    })
  }

  async getModelUsageEmployees(input: ModelUsageListQuery = {}): Promise<ListPage<EmployeeModelUsageSummary>> {
    const query = input.query?.trim().slice(0, 100) ?? ''
    const employee = input.employee?.trim().slice(0, 100) ?? ''
    const provider = input.provider?.trim().slice(0, 100) ?? ''
    const status = auditStatusFilters.has(input.status ?? '') ? (input.status ?? '') : ''
    const page = clampInteger(input.page, 1, 1_000_000, 1)
    const pageSize = clampInteger(input.pageSize, 1, 500, 10)
    const offset = (page - 1) * pageSize
    const like = `%${query}%`
    return this.database.begin(async (transaction) => {
      const [count] = await transaction<{ total: number }[]>`
        select count(*)::integer as total
          from (
            select u.id
              from model_usage_events mu
              join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id
              join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
              join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
              join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
              join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
              join run_attempts ra on ra.tenant_id = mu.tenant_id and ra.id = mu.attempt_id
             where mu.tenant_id = ${tenantId}
               and (${status} = '' or mu.status = ${status})
               and (${employee} = '' or u.id = ${employee})
               and (${provider} = '' or mu.provider = ${provider})
               and (${query} = '' or
                    u.display_name ilike ${like} or u.id ilike ${like}
                    or (case u.department_id when 'supply-chain' then '供应链中心' when 'platform' then '数字化中心' else coalesce(nullif(trim(u.department_id), ''), '未归属部门') end) ilike ${like}
                    or mu.provider ilike ${like} or mu.model ilike ${like}
                    or coalesce(ra.model_route_snapshot ->> 'routeKey', 'default') ilike ${like}
                    or a.id ilike ${like} or mu.run_id ilike ${like} or mu.trace_id ilike ${like})
             group by u.id
          ) filtered
      `
      const rows = await transaction<{
        employeeId: string; employeeName: string; departmentId: string | null;
        callCount: number; successCount: number; failedCount: number; blockedCount: number;
        promptTokens: number; completionTokens: number; totalTokens: number;
        averageLatencyMs: number | null; lastUsedAt: Date
      }[]>`
        select u.id as "employeeId", u.display_name as "employeeName", u.department_id as "departmentId",
               count(*)::integer as "callCount",
               count(*) filter (where mu.status = 'success')::integer as "successCount",
               count(*) filter (where mu.status = 'failed')::integer as "failedCount",
               count(*) filter (where mu.status = 'blocked')::integer as "blockedCount",
               coalesce(sum(mu.input_tokens), 0)::integer as "promptTokens",
               coalesce(sum(mu.output_tokens), 0)::integer as "completionTokens",
               coalesce(sum(mu.input_tokens + mu.output_tokens), 0)::integer as "totalTokens",
               avg(mu.latency_ms) filter (where mu.status = 'success') as "averageLatencyMs",
               max(mu.occurred_at) as "lastUsedAt"
          from model_usage_events mu
          join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id
          join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
          join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
          join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
          join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
          join run_attempts ra on ra.tenant_id = mu.tenant_id and ra.id = mu.attempt_id
         where mu.tenant_id = ${tenantId}
           and (${status} = '' or mu.status = ${status})
           and (${employee} = '' or u.id = ${employee})
           and (${provider} = '' or mu.provider = ${provider})
           and (${query} = '' or
                u.display_name ilike ${like} or u.id ilike ${like}
                or (case u.department_id when 'supply-chain' then '供应链中心' when 'platform' then '数字化中心' else coalesce(nullif(trim(u.department_id), ''), '未归属部门') end) ilike ${like}
                or mu.provider ilike ${like} or mu.model ilike ${like}
                or coalesce(ra.model_route_snapshot ->> 'routeKey', 'default') ilike ${like}
                or a.id ilike ${like} or mu.run_id ilike ${like} or mu.trace_id ilike ${like})
         group by u.id, u.display_name, u.department_id
         order by "totalTokens" desc, u.display_name
         limit ${pageSize} offset ${offset}
      `
      return {
        items: rows.map((row) => ({
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          department: departmentLabel(row.departmentId),
          callCount: row.callCount,
          successCount: row.successCount,
          failedCount: row.failedCount,
          blockedCount: row.blockedCount,
          successRate: row.callCount ? row.successCount / row.callCount : 0,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          averageLatencyMs: Math.round(row.averageLatencyMs ?? 0),
          lastUsedAt: formatDateTime(row.lastUsedAt),
        })),
        total: count?.total ?? 0,
        page,
        pageSize,
      }
    })
  }

  getPlatformStatus() {
    return { architecture: 'node-modular-monolith', persistence: 'postgres', sso: this.sso, dshRuntime: 'connected', database: 'configured', artifactStorage: 'local-mvp' }
  }

  async recordModelUsage(input: {
    run: RunRecord; attempt: RunAttemptRecord; prompt: string; output: string; status: 'success' | 'failed'; traceId: string;
    inputTokens?: number; outputTokens?: number
  }) {
    const route = input.attempt.modelRouteSnapshot
    const started = input.attempt.startedAt ? new Date(input.attempt.startedAt).getTime() : Date.now()
    await this.database`
      insert into model_usage_events (
        id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
        latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
      ) values (
        ${`usage-${input.attempt.id}`}, ${tenantId}, ${input.run.id}, ${input.attempt.id},
        ${String(route['providerKey'] ?? 'dsh-default')}, ${String(route['modelKey'] ?? 'dsh-default')},
        ${input.inputTokens ?? estimateTokens(input.prompt)}, ${input.outputTokens ?? estimateTokens(input.output)}, ${Math.max(0, Date.now() - started)},
        0, 'CNY', ${input.status}, ${input.traceId}, ${input.inputTokens === undefined || input.outputTokens === undefined}, now()
      ) on conflict (id) do nothing
    `
  }

  async recordToolAudit(input: {
    runId: string
    attemptId: string
    traceId: string
    metadata: Record<string, unknown>
    result?: 'success' | 'failed' | 'blocked'
  }) {
    const [run] = await this.database<{ requestedBy: string }[]>`
      select requested_by as "requestedBy" from runs
       where tenant_id = ${tenantId} and id = ${input.runId}
    `
    if (!run) throw new Error(`Run 不存在：${input.runId}`)
    const toolVersionId = await this.resolveToolVersionId(input.runId, input.attemptId, input.metadata)
    await this.database`
      insert into tool_audit_logs (
        id, tenant_id, run_id, attempt_id, tool_version_id, actor_user_id,
        parameter_summary, result, trace_id, occurred_at
      ) values (
        ${`tool-audit-${randomUUID()}`}, ${tenantId}, ${input.runId}, ${input.attemptId},
        ${toolVersionId}, ${run.requestedBy}, ${this.database.json(sanitizeSafeMetadata(input.metadata))},
        ${input.result ?? 'success'}, ${input.traceId}, now()
      )
    `
  }

  private async resolveToolVersionId(
    runId: string,
    attemptId: string,
    metadata: Record<string, unknown>,
  ) {
    const toolName = typeof metadata['tool_name'] === 'string' ? metadata['tool_name'].trim() : ''
    if (!toolName) throw new Error('工具审计缺少 tool_name，无法关联 Tool Version')

    const [attempt] = await this.database<{ manifest: unknown }[]>`
      select manifest from run_attempts
       where tenant_id = ${tenantId} and run_id = ${runId} and id = ${attemptId}
    `
    if (!attempt) throw new Error(`Attempt 不存在：${attemptId}`)
    const manifestTools = readManifestToolReferences(attempt.manifest)
    const normalizedName = toolName.toLowerCase()
    const manifestTool = manifestTools.find(reference =>
      reference.id.toLowerCase() === normalizedName
      || `${reference.id}@${reference.version}`.toLowerCase() === normalizedName,
    )
    if (manifestTool) {
      const [lockedVersion] = await this.database<{ id: string }[]>`
        select id from tool_versions
         where tenant_id = ${tenantId} and tool_id = ${manifestTool.id}
           and version = ${manifestTool.version}
      `
      if (lockedVersion) return lockedVersion.id
    }

    const catalogName = toolName.includes('@') ? toolName.slice(0, toolName.lastIndexOf('@')) : toolName
    const [catalogVersion] = await this.database<{ id: string }[]>`
      select tv.id from tools t
      join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
       where t.tenant_id = ${tenantId} and tv.status = 'published'
         and (
           lower(t.id) = lower(${catalogName})
           or lower(coalesce(t.dsh_tool_name, '')) = lower(${catalogName})
           or lower(t.name) = lower(${catalogName})
         )
       order by tv.created_at desc
       limit 1
    `
    if (!catalogVersion) throw new Error(`工具审计无法解析 Tool Version：${toolName}`)
    return catalogVersion.id
  }

  appendAudit(
    actorId: string,
    action: string,
    objectId: string,
    result: AuditEvent['status'],
    traceId: string,
    detail: string,
    objectType = auditObjectType(action),
  ) {
    return this.database`
      insert into audit_events (
        id, tenant_id, actor_type, actor_id, action, object_type, object_id,
        result, trace_id, safe_context
      ) values (
        ${`audit-${randomUUID()}`}, ${tenantId}, ${actorId === 'system' ? 'system' : 'user'},
        ${actorId}, ${action}, ${objectType}, ${objectId}, ${result}, ${traceId},
        ${this.database.json({ detail: redactSensitiveText(detail) })}
      )
    `.then(() => undefined)
  }

  private async requirePlatformAdmin(userId: string) {
    if (this.authorization) return this.authorization.requirePlatformAdmin(userId)
    const [actor] = await this.database<{ id: string; displayName: string }[]>`
      select u.id, u.display_name as "displayName" from users u
       where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and exists (
           select 1 from user_roles ur
           join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
            where ur.tenant_id = u.tenant_id and ur.user_id = u.id
              and (ur.valid_until is null or ur.valid_until > now())
              and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
         )
    `
    if (!actor) throw authorizationDenied(`操作人不存在、已停用或不是平台管理员：${userId}`)
    return actor
  }

  private async requireRuntime(runtimeId: string) {
    const [runtime] = await this.database<{
      id: string
      capacity: number
      schedulingStatus: 'accepting' | 'draining' | 'disabled'
    }[]>`
      select id, capacity, scheduling_status as "schedulingStatus" from runtimes
       where tenant_id = ${tenantId} and id = ${runtimeId}
    `
    if (!runtime) throw new Error(`Runtime 不存在：${runtimeId}`)
    return runtime
  }

  private async reconcileRuntimeScheduling(runtimeId: string) {
    if (!this.runtime?.configureScheduling) return
    await this.database.begin(async transaction => {
      const [runtime] = await transaction<{ schedulingStatus: 'accepting' | 'draining' | 'disabled' }[]>`
        select scheduling_status as "schedulingStatus" from runtimes
         where tenant_id = ${tenantId} and id = ${runtimeId}
         for update
      `
      if (runtime) await this.runtime?.configureScheduling?.(runtime.schedulingStatus)
    })
  }
}

function sameRuntimeMutationSnapshot(left: RuntimeMutationSnapshot, right: RuntimeMutationSnapshot) {
  return left.runtimeId === right.runtimeId
    && left.maxConcurrentWorkers === right.maxConcurrentWorkers
    && left.attemptTimeoutMinutes === right.attemptTimeoutMinutes
    && left.schedulingStatus === right.schedulingStatus
    && left.revision === right.revision
}

function assertRuntimeConfiguration(input: UpdateRuntimeConfigurationInput) {
  if (!Number.isInteger(input.maxConcurrentWorkers) || input.maxConcurrentWorkers < 1 || input.maxConcurrentWorkers > 128) {
    throw new Error('最大并发 Worker 数必须是 1～128 之间的整数')
  }
  if (!Number.isInteger(input.attemptTimeoutMinutes) || input.attemptTimeoutMinutes < 1 || input.attemptTimeoutMinutes > 60) {
    throw new Error('单次执行超时时间必须是 1～60 分钟之间的整数')
  }
  if (!['accepting', 'draining', 'disabled'].includes(input.schedulingStatus)) {
    throw new Error('Runtime 调度状态无效')
  }
}

function estimateTokens(value: string) { return Math.ceil([...value].length / 2) }
function readManifestToolReferences(manifest: unknown) {
  if (!isRecord(manifest) || !Array.isArray(manifest['tools'])) return []
  return manifest['tools'].flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const id = candidate['id']
    const version = candidate['version']
    return typeof id === 'string' && typeof version === 'string' ? [{ id, version }] : []
  })
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const sessionStatusFilters = new Set(['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'])
const auditStatusFilters = new Set(['success', 'failed', 'blocked'])
const auditCategoryFilters = new Set(['management', 'security', 'run', 'model', 'tool', 'artifact'])

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  if (!Number.isSafeInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value as number))
}

function departmentLabel(departmentId: string | null) {
  if (departmentId === 'supply-chain') return '供应链中心'
  if (departmentId === 'platform') return '数字化中心'
  return departmentId?.trim() || '未归属部门'
}
function auditObjectType(action: string) {
  const prefix = action.split('.')[0]
  if (prefix === 'model_provider' || prefix === 'provider_model' || prefix === 'model_route') return 'model_governance'
  return ['run', 'agent', 'skill', 'tool', 'connector', 'runtime', 'workspace', 'artifact'].includes(prefix)
    ? prefix
    : 'platform'
}
function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}
