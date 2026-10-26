import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { authorizationDenied } from '../../../domain/authorization-errors.ts'
import type { PostgresOperationsService } from './postgres-operations-service.ts'
import { invalidRequest, notFound, stateConflict } from '../../../domain/request-errors.ts'

const tenantId = 'tenant-dsh-work'
const maxReconcileBatch = 200

export type ReconciledCapabilityType = 'agent' | 'skill'

export interface InferredOwnerAgent {
  agentId: string
  agentName: string
  versionId: string
  version: string
  agentStatus: string
}

/**
 * 一条待对账的历史授权来源（`source_type='legacy_unresolved'`）。
 * `possibleAgents` 只是推断提示（按 `capability_type='agent'` 匹配 `agent_versions`），
 * 不自动回填为 `agent_member` 来源；运营人员必须显式完成对账（改写为 `manual`）。
 */
export interface GrantSourceReconciliationItem {
  sourceId: string
  workspaceId: string
  workspaceName: string
  capabilityType: ReconciledCapabilityType
  capabilityVersionId: string
  capabilityLabel: string
  createdBy: string
  createdAt: Date
  possibleAgents: InferredOwnerAgent[]
  inferenceNote: string
}

export interface GrantSourceReconciliationView {
  items: GrantSourceReconciliationItem[]
  workspaceSummary: Array<{ workspaceId: string; workspaceName: string; unresolvedCount: number }>
}

export interface ReconcileGrantSourcesResult {
  reconciled: number
  sourceIds: string[]
  workspaceIds: string[]
}

/**
 * 1A-T7 授权来源对账（convergence §2 / plan 6.3）。
 *
 * 存量迁移为每条既有 grant 生成一条 `legacy_unresolved` 来源。运营端列出这些来源及
 * 「可能」归属的 Agent（仅提示），并提供显式的「对账完成」动作：把来源改写为
 * `manual` 并记审计。撤销行（`status='revoked'`）保留，从不物理删除。
 */
export class PostgresGrantReconciliationService {
  private readonly database: DatabaseClient
  private readonly operations?: PostgresOperationsService

  constructor(database: DatabaseClient, operations?: PostgresOperationsService) {
    this.database = database
    this.operations = operations
  }

  async listUnresolvedSources(): Promise<GrantSourceReconciliationView> {
    const rows = await this.database<{
      sourceId: string
      workspaceId: string
      workspaceName: string
      capabilityType: ReconciledCapabilityType
      capabilityVersionId: string
      createdBy: string
      createdAt: Date
      possibleAgentId: string | null
      possibleAgentName: string | null
      possibleVersionId: string | null
      possibleVersion: string | null
      possibleAgentStatus: string | null
      capabilityLabel: string
    }[]>`
      select s.id as "sourceId", s.workspace_id as "workspaceId", w.name as "workspaceName",
             s.capability_type as "capabilityType",
             s.capability_version_id as "capabilityVersionId",
             s.created_by as "createdBy", s.created_at as "createdAt",
             a.id as "possibleAgentId", a.name as "possibleAgentName",
             av.id as "possibleVersionId", av.version as "possibleVersion",
             a.status as "possibleAgentStatus",
             case s.capability_type
               when 'agent' then coalesce(a.name || ' v' || av.version, s.capability_version_id)
               when 'skill' then coalesce(sk.name || ' v' || sv.version, s.capability_version_id)
               else s.capability_version_id
             end as "capabilityLabel"
        from workspace_grant_sources s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join agent_versions av
          on s.capability_type = 'agent'
         and av.tenant_id = s.tenant_id and av.id = s.capability_version_id
        left join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
        left join skill_versions sv
          on s.capability_type = 'skill'
         and sv.tenant_id = s.tenant_id and sv.id = s.capability_version_id
        left join skills sk on sk.tenant_id = sv.tenant_id and sk.id = sv.skill_id
       where s.tenant_id = ${tenantId}
         and s.source_type = 'legacy_unresolved'
         and s.status = 'active'
       order by w.name asc, s.created_at asc, s.id asc
    `

    const items: GrantSourceReconciliationItem[] = rows.map(row => ({
      sourceId: row.sourceId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      capabilityType: row.capabilityType,
      capabilityVersionId: row.capabilityVersionId,
      capabilityLabel: row.capabilityLabel,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      possibleAgents: row.capabilityType === 'agent' && row.possibleAgentId && row.possibleVersionId
        ? [{
            agentId: row.possibleAgentId,
            agentName: row.possibleAgentName ?? '未知 Agent',
            versionId: row.possibleVersionId,
            version: row.possibleVersion ?? '—',
            agentStatus: row.possibleAgentStatus ?? 'unknown',
          }]
        : [],
      inferenceNote: inferenceNote(row.capabilityType),
    }))

    const summary = new Map<string, { workspaceId: string; workspaceName: string; unresolvedCount: number }>()
    for (const item of items) {
      const current = summary.get(item.workspaceId)
      if (current) current.unresolvedCount += 1
      else summary.set(item.workspaceId, {
        workspaceId: item.workspaceId,
        workspaceName: item.workspaceName,
        unresolvedCount: 1,
      })
    }

    return { items, workspaceSummary: [...summary.values()] }
  }

  /**
   * 对账完成：把这些 legacy 来源改写为 `manual` 并记审计。改写只改来源类型，不新增或
   * 删除任何有效授权（`workspace_capability_grants` 不变），也不改 `team_auth_revision`
   * ——有效授权集合没有变化，无需让运行中收权缓存失效。
   */
  async reconcile(input: { sourceIds: string[]; actor: string }): Promise<ReconcileGrantSourcesResult> {
    const sourceIds = normalizeSourceIds(input.sourceIds)
    await this.requirePlatformAdmin(input.actor)

    const reconciled = await this.database.begin(async transaction => {
      // Lock order matters: the member service takes the workspace row lock and
      // then reads/locks the grant-source rows. Reconcile must use the SAME order
      // (workspace -> sources); locking sources first made concurrent
      // reconcile + Agent removal acquire the two locks in opposite order and
      // PostgreSQL aborted one side with a deadlock. Read unlocked, lock the
      // workspaces, then lock the sources.
      const rows = await transaction<{
        id: string
        workspaceId: string
        sourceType: string
        status: string
        capabilityType: string
        capabilityVersionId: string
      }[]>`
        select id, workspace_id as "workspaceId", source_type as "sourceType", status,
               capability_type as "capabilityType",
               capability_version_id as "capabilityVersionId"
          from workspace_grant_sources
         where tenant_id = ${tenantId} and id in ${transaction(sourceIds)}
         order by workspace_id asc, id asc
      `
      if (rows.length !== sourceIds.length) {
        throw notFound('部分授权来源不存在，请刷新对账清单后重试')
      }
      const notLegacy = rows.filter(row => row.sourceType !== 'legacy_unresolved' || row.status !== 'active')
      if (notLegacy.length) {
        throw stateConflict('部分授权来源已完成对账或已撤销，不能重复对账，请刷新对账清单后重试')
      }

      // 与 Agent 移出/停用共用 workspace 行锁，且顺序一致（先 workspace、后来源）。
      const workspaceIds = [...new Set(rows.map(row => row.workspaceId))].sort()
      for (const workspaceId of workspaceIds) {
        await lockWorkspaceRow(transaction, workspaceId)
      }
      // 复核并锁定来源行：等待 workspace 锁期间状态可能已变化。
      const locked = await transaction<{ sourceType: string; status: string }[]>`
        select source_type as "sourceType", status
          from workspace_grant_sources
         where tenant_id = ${tenantId} and id in ${transaction(sourceIds)}
         order by workspace_id asc, id asc
         for update
      `
      const stale = locked.filter(row => row.sourceType !== 'legacy_unresolved' || row.status !== 'active')
      if (stale.length) {
        throw stateConflict('部分授权来源已完成对账或已撤销，不能重复对账，请刷新对账清单后重试')
      }
      await transaction`
        update workspace_grant_sources
           set source_type = 'manual'
         where tenant_id = ${tenantId} and id in ${transaction(sourceIds)}
           and source_type = 'legacy_unresolved' and status = 'active'
      `
      return { rows, workspaceIds }
    })

    for (const workspaceId of reconciled.workspaceIds) {
      const resolved = reconciled.rows.filter(row => row.workspaceId === workspaceId)
      await this.operations?.appendAudit(
        input.actor,
        'workspace.grant_source.reconcile',
        workspaceId,
        'success',
        `trace-grant-reconcile-${workspaceId}`,
        `对账完成 ${resolved.length} 条 legacy_unresolved 来源，改写为 manual：`
        + resolved.map(row => `${row.capabilityType}:${row.capabilityVersionId}`).join('、'),
      )
    }

    return {
      reconciled: reconciled.rows.length,
      sourceIds: reconciled.rows.map(row => row.id),
      workspaceIds: reconciled.workspaceIds,
    }
  }

  private async requirePlatformAdmin(userId: string) {
    const [row] = await this.database<{ id: string }[]>`
      select u.id from users u
       where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and exists (
           select 1 from user_roles ur
           join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
            where ur.tenant_id = u.tenant_id and ur.user_id = u.id
              and ur.source_key = 'local' and r.status = 'active'
              and (ur.valid_until is null or ur.valid_until > now())
              and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
         )
    `
    if (!row) throw authorizationDenied('操作人不存在、已停用或不是平台管理员')
    return row.id
  }
}

function inferenceNote(capabilityType: ReconciledCapabilityType) {
  if (capabilityType === 'agent') {
    return '按 capability_type=agent 匹配 agent_versions 推断的可能归属，仅提示不自动回填；请人工确认后完成对账。'
  }
  return 'Skill/工具来源无法按 Agent 版本唯一推断归属，需人工确认后完成对账。'
}

function normalizeSourceIds(sourceIds: string[]) {
  if (!Array.isArray(sourceIds)) throw invalidRequest('sourceIds 必须为数组')
  const unique = [...new Set(sourceIds.map(id => String(id).trim()).filter(Boolean))]
  if (unique.length === 0) throw invalidRequest('至少需要选择一条待对账的授权来源')
  if (unique.length > maxReconcileBatch) throw invalidRequest(`单次对账最多 ${maxReconcileBatch} 条授权来源`)
  return unique
}

async function lockWorkspaceRow(transaction: DatabaseTransaction, workspaceId: string) {
  await transaction`
    select id from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
     for update
  `
}
