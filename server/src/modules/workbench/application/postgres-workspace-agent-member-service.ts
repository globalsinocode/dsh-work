import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type {
  PostgresAgentService,
  WorkspaceAgentCandidate,
} from '../../agent/postgres-agent-service.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import { authorizationDenied } from '../../authorization/authorization-errors.ts'
import { PostgresWorkspaceGrantSourceService } from '../../authorization/postgres-workspace-grant-source-service.ts'
import {
  currentTeamAuthRevision,
  recordWorkspaceActivity,
} from './workspace-activity-writer.ts'

const tenantId = 'tenant-dsh-work'

/**
 * 不可用原因的判定（5-T1）：单条查询内联三个条件，按「版本失效 → 平台未授权 →
 * Runtime 不可用」优先级取第一个成立者，避免逐成员 N+1。只引用列与常量，不含
 * 外部输入，可安全作为静态片段复用。status 非 available（已停用/已移出）恒为 null。
 */
const unavailableReasonSql = `
  case
    when wam.status <> 'available' then null
    when av.status <> 'published' or a.status <> 'published'
      then '版本失效：Agent 版本已下架'
    when not exists (
      select 1 from workspace_grant_sources g
       where g.tenant_id = wam.tenant_id
         and g.workspace_id = wam.workspace_id
         and g.source_type = 'agent_member'
         and g.source_ref_id = wam.id
         and g.status = 'active'
    ) then '平台未授权：能力授权已被撤销'
    when not exists (
      select 1 from runtimes r
       where r.tenant_id = wam.tenant_id
         and r.health_status = 'healthy'
         and r.scheduling_status = 'accepting'
    ) then 'Runtime 不可用：暂无可接单的运行节点'
    else null
  end
`

export type AgentMemberStatus = 'available' | 'disabled'
export type AgentMemberPatchAction = 'disable' | 'enable' | 'upgrade'
export type AgentMemberAction = 'start_conversation' | 'disable' | 'enable' | 'upgrade' | 'remove'

export interface AgentCandidateSummary {
  agentId: string
  name: string
  description: string
  activeVersionId: string
  activeVersion: string
  status: string
}

export interface AgentCandidatePage {
  items: AgentCandidateSummary[]
  nextCursor: string | null
}

export interface AgentMemberRecord {
  id: string
  agentId: string
  name: string
  description: string
  status: AgentMemberStatus
  version: string
  addedBy: string
  createdAt: string
  /**
   * 「不可用」第三态的具体原因（5-T1）：状态仍为 available，但平台未授权／版本失效／
   * Runtime 不可用时给出，供行内 tooltip 展示；status 为 disabled 时恒为 null
   * （灰色「已停用」已足够）。
   */
  unavailableReason: string | null
  allowedActions: AgentMemberAction[]
}

interface MemberStateRow {
  id: string
  agentId: string
  agentVersionId: string
  status: 'available' | 'disabled' | 'removed'
}

/**
 * Team-workspace agent member management (1A-T4). Agents join a team space as
 * members pinned to an exact published version; the join transaction records
 * the membership together with the capability grant sources (agent, skills,
 * tools) so a failed join never leaves partial grants behind (AC-03).
 * Personal workspace behavior is untouched: every public method re-asserts
 * the team-only boundary and routes additionally reject personal workspaces
 * before any role check.
 */
export class PostgresWorkspaceAgentMemberService {
  private readonly database: DatabaseClient
  private readonly authorization: PostgresAuthorizationService
  private readonly agents: PostgresAgentService
  private readonly grantSources: PostgresWorkspaceGrantSourceService

  constructor(
    database: DatabaseClient,
    authorization: PostgresAuthorizationService,
    agents: PostgresAgentService,
    grantSources: PostgresWorkspaceGrantSourceService = new PostgresWorkspaceGrantSourceService(),
  ) {
    this.database = database
    this.authorization = authorization
    this.agents = agents
    this.grantSources = grantSources
  }

  /**
   * Joinable agent picker (TW-02): delegates to the T2 candidate query and
   * wraps the full result with server-side cursor pagination plus an optional
   * name/description keyword filter. Returns minimal summary fields only.
   */
  async listAgentCandidates(
    workspaceId: string,
    requesterUserId: string,
    sessionRoleIds: string[] | undefined,
    input: { query?: string; cursor?: string; limit?: number },
  ): Promise<AgentCandidatePage> {
    await this.assertTeamWorkspace(workspaceId)
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const candidates = await this.agents.listWorkspaceAgentCandidates(
      workspaceId,
      requesterUserId,
      sessionRoleIds,
    )
    const pattern = input.query?.trim() ?? ''
    const filtered = pattern
      ? candidates.filter(candidate => matchesKeyword(candidate, pattern))
      : candidates
    const startIndex = input.cursor ? decodeCursorIndex(filtered, input.cursor) : 0
    const page = filtered.slice(startIndex, startIndex + limit + 1)
    const hasMore = page.length > limit
    const items = page.slice(0, limit).map(toCandidateSummary)
    const last = items[items.length - 1]
    return {
      items,
      nextCursor: hasMore && last ? encodeCandidateCursor(last.agentId) : null,
    }
  }

  /**
   * Lists non-removed agent members with the allowed actions for the current
   * actor: owners see manage actions, admins and members see 开始对话 while
   * the member is available, viewers see none. Employee role semantics never
   * apply to agents (TW-02).
   */
  async listAgentMembers(workspaceId: string, actorUserId: string): Promise<AgentMemberRecord[]> {
    // Agent 名册属读取轨（3-T1）：归档空间详情仍需展示 Agent 成员；加入/停用/升级/移出保持执行轨。
    await this.assertTeamWorkspace(workspaceId, { allowArchived: true })
    const actorRole = await this.memberRoleOf(workspaceId, actorUserId)
    if (!actorRole) throw authorizationDenied('当前用户不是该空间的成员')
    const rows = await this.database<{
      id: string
      agentId: string
      name: string
      description: string
      status: 'available' | 'disabled'
      version: string
      addedBy: string
      createdAt: Date
      unavailableReason: string | null
    }[]>`
      select wam.id, wam.agent_id as "agentId", a.name, a.description,
             wam.status, av.version, wam.added_by as "addedBy", wam.created_at as "createdAt",
             ${this.database.unsafe(unavailableReasonSql)} as "unavailableReason"
        from workspace_agent_members wam
        join agents a on a.tenant_id = wam.tenant_id and a.id = wam.agent_id
        join agent_versions av on av.tenant_id = wam.tenant_id and av.id = wam.agent_version_id
       where wam.tenant_id = ${tenantId}
         and wam.workspace_id = ${workspaceId}
         and wam.status <> 'removed'
       order by wam.created_at asc, wam.id asc
    `
    return rows.map(row => ({
      id: row.id,
      agentId: row.agentId,
      name: row.name,
      description: row.description,
      status: row.status,
      version: row.version,
      addedBy: row.addedBy,
      createdAt: row.createdAt.toISOString(),
      unavailableReason: row.unavailableReason,
      allowedActions: allowedActionsFor(actorRole, row.status, row.unavailableReason),
    }))
  }

  /**
   * Joins an agent into the team space pinned to its current active published
   * version. All-or-nothing transaction (AC-03): resolves the joinable
   * version, validates the dependency closure, writes the membership row and
   * the capability grant sources together — any failure rolls everything
   * back. Re-adding a previously removed agent reactivates the same row;
   * joining an already active/disabled member is a clear conflict.
   */
  async addAgentMember(
    workspaceId: string,
    agentId: string,
    actorUserId: string,
    actorRoleIds: string[] = [],
  ): Promise<AgentMemberRecord> {
    await this.assertTeamWorkspace(workspaceId)
    await this.requireActorRole(workspaceId, actorUserId, ['owner'])
    const active = await this.requireActivePublishedVersion(agentId, true)
    const { agent, skillVersions } = await this.authorization.assertAgentDependencyClosure(active.versionId)
    // P2-1：候选列表按 visible_role_ids 过滤只是展示；直接提交 ID 也必须按添加人
    // 当前有效角色复核允许范围，不能依赖候选查询承担鉴权。
    await this.authorization.assertAgentVersionVisibleToRoles(active.versionId, actorRoleIds, '所选 Agent')
    const toolVersions = await this.authorization.resolveToolVersions(agent.toolReferences)

    let memberId = ''
    await this.database.begin(async transaction => {
      await lockWorkspaceRow(transaction, workspaceId)
      // P1-4：角色前置检查在事务外，拿到空间锁后必须复核当前角色——
      // 负责人转交若发生在前置检查与加锁之间，旧负责人不得再改成员与授权。
      await this.requireActorRole(workspaceId, actorUserId, ['owner'], transaction)
      const [existing] = await transaction<MemberStateRow[]>`
        select id, agent_id as "agentId", agent_version_id as "agentVersionId", status
          from workspace_agent_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and agent_id = ${agentId}
         for update
      `
      if (existing && existing.status !== 'removed') {
        throw new Error('该 Agent 已是空间成员，不能重复加入')
      }
      memberId = existing?.id ?? `wam-${randomUUID()}`
      if (existing) {
        await transaction`
          update workspace_agent_members
             set agent_version_id = ${active.versionId}, status = 'available',
                 added_by = ${actorUserId}, updated_at = now()
           where tenant_id = ${tenantId} and id = ${existing.id}
        `
      } else {
        await transaction`
          insert into workspace_agent_members (
            id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by
          ) values (
            ${memberId}, ${tenantId}, ${workspaceId}, ${agentId}, ${active.versionId},
            'available', ${actorUserId}
          )
        `
      }
      await this.grantSources.addGrantSources(transaction, [
        { capabilityType: 'agent', capabilityVersionId: active.versionId, sourceType: 'agent_member', sourceRefId: memberId, createdBy: actorUserId },
        ...skillVersions.map(skill => ({ capabilityType: 'skill' as const, capabilityVersionId: skill.versionId, sourceType: 'agent_member' as const, sourceRefId: memberId, createdBy: actorUserId })),
        ...toolVersions.map(tool => ({ capabilityType: 'tool' as const, capabilityVersionId: tool.versionId, sourceType: 'agent_member' as const, sourceRefId: memberId, createdBy: actorUserId })),
      ], workspaceId)
      // addGrantSources bumps the workspace auth revision; the post-bump value
      // separates a later re-add of the same (row-reusing) membership from this
      // join, while a racing duplicate join already throws above.
      const revision = await currentTeamAuthRevision(transaction, workspaceId)
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'agent_member_added',
        actorUserId,
        objectType: 'agent_member',
        objectId: memberId,
        dedupeKey: `agent_member_added:${memberId}:${revision}`,
        metadata: { agentMemberId: memberId, agentId },
      })
    })
    return this.requireAgentMemberRecord(workspaceId, memberId, actorUserId)
  }

  async updateAgentMember(
    workspaceId: string,
    memberId: string,
    action: AgentMemberPatchAction,
    actorUserId: string,
  ): Promise<AgentMemberRecord> {
    await this.assertTeamWorkspace(workspaceId)
    await this.requireActorRole(workspaceId, actorUserId, ['owner'])
    if (action === 'disable') return this.disableAgentMember(workspaceId, memberId, actorUserId)
    if (action === 'enable') return this.enableAgentMember(workspaceId, memberId, actorUserId)
    return this.upgradeAgentMember(workspaceId, memberId, actorUserId)
  }

  /**
   * Removes the agent membership: the row keeps the audit trail, grant
   * sources are revoked and a durable revocation event is written. History
   * (runs, messages, artifacts) is untouched; re-adding later reuses the row.
   */
  async removeAgentMember(
    workspaceId: string,
    memberId: string,
    actorUserId: string,
  ): Promise<{ id: string; removed: true }> {
    await this.assertTeamWorkspace(workspaceId)
    await this.requireActorRole(workspaceId, actorUserId, ['owner'])
    const member = await this.requireMemberState(workspaceId, memberId)
    if (member.status === 'removed') throw new Error('Agent 成员已移出，不能重复移除')

    await this.database.begin(async transaction => {
      await lockWorkspaceRow(transaction, workspaceId)
      // P1-4：角色前置检查在事务外，拿到空间锁后必须复核当前角色——
      // 负责人转交若发生在前置检查与加锁之间，旧负责人不得再改成员与授权。
      await this.requireActorRole(workspaceId, actorUserId, ['owner'], transaction)
      // 方案 6.3 门禁：对账完成前，涉及 legacy 歧义来源的破坏性调整必须被拒绝。
      await this.grantSources.assertNoUnresolvedLegacySources(transaction, workspaceId, '移除 Agent 成员')
      const [locked] = await transaction<MemberStateRow[]>`
        select id, agent_id as "agentId", agent_version_id as "agentVersionId", status
          from workspace_agent_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${memberId}
         for update
      `
      if (!locked) throw new Error('Agent 成员不存在')
      if (locked.status === 'removed') throw new Error('Agent 成员已移出，不能重复移除')
      await transaction`
        update workspace_agent_members
           set status = 'removed', updated_at = now()
         where tenant_id = ${tenantId} and id = ${memberId}
      `
      await this.grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberId)
      // payload_hash 必须只由「被撤销对象」决定：把操作人（actor）写进 payload 会让
      // 停用→启用→停用（或不同操作人）产生多行事件，违反「重复生命周期事件只产生
      // 一条」的去重语义。actor 已由审计链路记录，这里不再参与去重键。
      await this.writeRevocationEvent(transaction, workspaceId, memberId, 'agent_removed', {
        agentMemberId: memberId,
        agentId: locked.agentId,
      })
      // revokeGrantSourcesByRef bumps the revision; the post-bump value makes a
      // later remove-after-re-add distinct while a duplicate remove already
      // throws above.
      const revision = await currentTeamAuthRevision(transaction, workspaceId)
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'agent_member_removed',
        actorUserId,
        objectType: 'agent_member',
        objectId: memberId,
        dedupeKey: `agent_member_removed:${memberId}:${revision}`,
        metadata: { agentMemberId: memberId, agentId: locked.agentId },
      })
    })
    return { id: memberId, removed: true }
  }

  /**
   * Team session start resolution (TW-02 发起对话): the session must be
   * started through the agent member association, so the pinned version is
   * used instead of the platform's current active version. Disabled/removed
   * members block new sessions with a specific reason.
   */
  async requireAvailableAgentMemberVersion(
    workspaceId: string,
    workspaceAgentMemberId: string,
  ): Promise<{ agentId: string; agentVersionId: string }> {
    const [row] = await this.database<{
      agentId: string
      agentVersionId: string
      status: 'available' | 'disabled' | 'removed'
    }[]>`
      select agent_id as "agentId", agent_version_id as "agentVersionId", status
        from workspace_agent_members
       where tenant_id = ${tenantId}
         and workspace_id = ${workspaceId}
         and id = ${workspaceAgentMemberId}
    `
    if (!row) throw authorizationDenied('Agent 成员不存在或不属于该团队空间')
    if (row.status !== 'available') throw authorizationDenied('Agent 成员已停用或已移出，不能发起新对话')
    return { agentId: row.agentId, agentVersionId: row.agentVersionId }
  }

  // -------------------------------------------------------------------------
  // PATCH sub-flows
  // -------------------------------------------------------------------------

  private async disableAgentMember(
    workspaceId: string,
    memberId: string,
    actorUserId: string,
  ): Promise<AgentMemberRecord> {
    const member = await this.requireMemberState(workspaceId, memberId)
    if (member.status === 'removed') throw new Error('Agent 成员已移出，不能停用')
    if (member.status === 'disabled') return this.requireAgentMemberRecord(workspaceId, memberId, actorUserId)

    await this.database.begin(async transaction => {
      await lockWorkspaceRow(transaction, workspaceId)
      // P1-4：角色前置检查在事务外，拿到空间锁后必须复核当前角色——
      // 负责人转交若发生在前置检查与加锁之间，旧负责人不得再改成员与授权。
      await this.requireActorRole(workspaceId, actorUserId, ['owner'], transaction)
      // 同移除：停用也会撤销该成员的 agent_member 来源，必须先排除歧义 legacy 来源。
      await this.grantSources.assertNoUnresolvedLegacySources(transaction, workspaceId, '停用 Agent 成员')
      const [locked] = await transaction<MemberStateRow[]>`
        select id, agent_id as "agentId", agent_version_id as "agentVersionId", status
          from workspace_agent_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${memberId}
         for update
      `
      if (!locked) throw new Error('Agent 成员不存在')
      if (locked.status === 'removed') throw new Error('Agent 成员已移出，不能停用')
      if (locked.status === 'disabled') return
      await transaction`
        update workspace_agent_members
           set status = 'disabled', updated_at = now()
         where tenant_id = ${tenantId} and id = ${memberId}
      `
      await this.grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberId)
      // 同 agent_removed：去重键只由被停用的 Agent 成员决定，不含操作人。
      await this.writeRevocationEvent(transaction, workspaceId, memberId, 'agent_disabled', {
        agentMemberId: memberId,
        agentId: locked.agentId,
      })
    })
    return this.requireAgentMemberRecord(workspaceId, memberId, actorUserId)
  }

  /**
   * Re-enables a disabled member with its current pinned version: re-validates
   * the version's dependency closure and re-adds its grant sources (the
   * revoked provenance rows are reactivated). Removed members must go through
   * the join endpoint again.
   */
  private async enableAgentMember(
    workspaceId: string,
    memberId: string,
    actorUserId: string,
  ): Promise<AgentMemberRecord> {
    const member = await this.requireMemberState(workspaceId, memberId)
    if (member.status === 'removed') throw new Error('Agent 成员已移出，不能重新启用，请重新添加')
    if (member.status === 'available') throw new Error('Agent 成员当前已是可用状态，不能重复启用')

    const { agent, skillVersions } = await this.authorization.assertAgentDependencyClosure(member.agentVersionId)
    const toolVersions = await this.authorization.resolveToolVersions(agent.toolReferences)

    await this.database.begin(async transaction => {
      await lockWorkspaceRow(transaction, workspaceId)
      // P1-4：角色前置检查在事务外，拿到空间锁后必须复核当前角色——
      // 负责人转交若发生在前置检查与加锁之间，旧负责人不得再改成员与授权。
      await this.requireActorRole(workspaceId, actorUserId, ['owner'], transaction)
      const [locked] = await transaction<MemberStateRow[]>`
        select id, agent_id as "agentId", agent_version_id as "agentVersionId", status
          from workspace_agent_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${memberId}
         for update
      `
      if (!locked) throw new Error('Agent 成员不存在')
      if (locked.status === 'removed') throw new Error('Agent 成员已移出，不能重新启用，请重新添加')
      if (locked.status === 'available') throw new Error('Agent 成员当前已是可用状态，不能重复启用')
      await transaction`
        update workspace_agent_members
           set status = 'available', updated_at = now()
         where tenant_id = ${tenantId} and id = ${memberId}
      `
      await this.grantSources.addGrantSources(transaction, [
        { capabilityType: 'agent', capabilityVersionId: member.agentVersionId, sourceType: 'agent_member', sourceRefId: memberId, createdBy: actorUserId },
        ...skillVersions.map(skill => ({ capabilityType: 'skill' as const, capabilityVersionId: skill.versionId, sourceType: 'agent_member' as const, sourceRefId: memberId, createdBy: actorUserId })),
        ...toolVersions.map(tool => ({ capabilityType: 'tool' as const, capabilityVersionId: tool.versionId, sourceType: 'agent_member' as const, sourceRefId: memberId, createdBy: actorUserId })),
      ], workspaceId)
    })
    return this.requireAgentMemberRecord(workspaceId, memberId, actorUserId)
  }

  /**
   * Pins the member to the agent's current active published version. Old
   * version sources stay active so existing sessions keep executing
   * (TW-02 版本升级); no revocation event is written because no access is
   * lost. Upgrading to the already pinned version is a no-op.
   */
  private async upgradeAgentMember(
    workspaceId: string,
    memberId: string,
    actorUserId: string,
  ): Promise<AgentMemberRecord> {
    const member = await this.requireMemberState(workspaceId, memberId)
    if (member.status === 'removed') throw new Error('Agent 成员已移出，不能升级，请重新添加')
    if (member.status === 'disabled') throw new Error('Agent 成员已停用，不能升级，请先启用后再升级')

    const active = await this.requireActivePublishedVersion(member.agentId, false)
    if (active.versionId === member.agentVersionId) {
      return this.requireAgentMemberRecord(workspaceId, memberId, actorUserId)
    }
    const { agent, skillVersions } = await this.authorization.assertAgentDependencyClosure(active.versionId)
    const toolVersions = await this.authorization.resolveToolVersions(agent.toolReferences)

    await this.database.begin(async transaction => {
      await lockWorkspaceRow(transaction, workspaceId)
      // P1-4：角色前置检查在事务外，拿到空间锁后必须复核当前角色——
      // 负责人转交若发生在前置检查与加锁之间，旧负责人不得再改成员与授权。
      await this.requireActorRole(workspaceId, actorUserId, ['owner'], transaction)
      const [locked] = await transaction<MemberStateRow[]>`
        select id, agent_id as "agentId", agent_version_id as "agentVersionId", status
          from workspace_agent_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${memberId}
         for update
      `
      if (!locked) throw new Error('Agent 成员不存在')
      if (locked.status === 'removed') throw new Error('Agent 成员已移出，不能升级，请重新添加')
      if (locked.status === 'disabled') throw new Error('Agent 成员已停用，不能升级，请先启用后再升级')
      await transaction`
        update workspace_agent_members
           set agent_version_id = ${active.versionId}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${memberId}
      `
      await this.grantSources.addGrantSources(transaction, [
        { capabilityType: 'agent', capabilityVersionId: active.versionId, sourceType: 'agent_member', sourceRefId: memberId, createdBy: actorUserId },
        ...skillVersions.map(skill => ({ capabilityType: 'skill' as const, capabilityVersionId: skill.versionId, sourceType: 'agent_member' as const, sourceRefId: memberId, createdBy: actorUserId })),
        ...toolVersions.map(tool => ({ capabilityType: 'tool' as const, capabilityVersionId: tool.versionId, sourceType: 'agent_member' as const, sourceRefId: memberId, createdBy: actorUserId })),
      ], workspaceId)
    })
    return this.requireAgentMemberRecord(workspaceId, memberId, actorUserId)
  }

  // -------------------------------------------------------------------------
  // Shared checks
  // -------------------------------------------------------------------------

  private async assertTeamWorkspace(workspaceId: string, options: { allowArchived?: boolean } = {}) {
    const allowArchived = options.allowArchived === true
    const [workspace] = await this.database<{ type: 'personal' | 'team' }[]>`
      select workspace_type as type from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId}
         and ${allowArchived
           ? this.database.unsafe(`status in ('active', 'archived')`)
           : this.database.unsafe(`status = 'active'`)}
    `
    // 与成员服务同口径：用「不可访问」避免用状态码区分归档与不存在。
    if (!workspace) throw authorizationDenied('工作空间不存在或不可访问')
    if (workspace.type !== 'team') throw new Error('仅支持团队工作空间进行成员管理')
  }

  /**
   * Resolves the agent's current active published version. For joins the
   * platform-level allow_workspace_join switch must be on; upgrades of an
   * existing membership are not governed by the join switch.
   */
  private async requireActivePublishedVersion(agentId: string, requireAllowJoin: boolean) {
    const [agentRow] = await this.database<{
      agentStatus: 'published' | 'draft' | 'disabled'
      allowJoin: boolean
      activeVersionId: string | null
    }[]>`
      select a.status as "agentStatus", a.allow_workspace_join as "allowJoin",
             a.active_version_id as "activeVersionId"
        from agents a
       where a.tenant_id = ${tenantId} and a.id = ${agentId}
    `
    if (!agentRow) throw new Error(`Agent 不存在：${agentId}`)
    if (agentRow.agentStatus !== 'published') throw new Error('Agent 未发布，不能用于团队空间')
    if (requireAllowJoin && !agentRow.allowJoin) throw new Error('Agent 未开放加入团队空间，不能添加为成员')
    if (!agentRow.activeVersionId) throw new Error('Agent 没有已发布的活动版本，不能用于团队空间')
    const [versionRow] = await this.database<{ id: string; version: string }[]>`
      select av.id, av.version from agent_versions av
       where av.tenant_id = ${tenantId} and av.id = ${agentRow.activeVersionId}
         and av.status = 'published'
    `
    if (!versionRow) throw new Error('Agent 活动版本未发布，不能用于团队空间')
    return { agentId, versionId: versionRow.id, version: versionRow.version }
  }

  private async memberRoleOf(
    workspaceId: string,
    userId: string,
    executor: DatabaseClient | DatabaseTransaction = this.database,
  ) {
    const [member] = await executor<{ role: 'owner' | 'admin' | 'member' | 'viewer' }[]>`
      select member_role as role from workspace_members
       where tenant_id = ${tenantId}
         and workspace_id = ${workspaceId}
         and user_id = ${userId}
    `
    return member?.role ?? null
  }

  /**
   * Service-level re-verification of the actor's current role. Route guards
   * run before this read, so a demotion racing in between (TOCTOU) must be
   * caught here. Pass the transaction to re-check while holding the workspace
   * lock: a负责人转交 committed between the pre-check and the lock would
   * otherwise let the previous owner still mutate members and grants.
   */
  private async requireActorRole(
    workspaceId: string,
    actorUserId: string,
    allowedRoles: Array<'owner' | 'admin' | 'member' | 'viewer'>,
    executor: DatabaseClient | DatabaseTransaction = this.database,
  ) {
    const role = await this.memberRoleOf(workspaceId, actorUserId, executor)
    if (!role) throw authorizationDenied('当前用户不是该空间的成员')
    if (!allowedRoles.includes(role)) throw new Error('当前用户角色没有权限执行此操作')
    return role
  }

  private async requireMemberState(workspaceId: string, memberId: string): Promise<MemberStateRow> {
    const [member] = await this.database<MemberStateRow[]>`
      select id, agent_id as "agentId", agent_version_id as "agentVersionId", status
        from workspace_agent_members
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and id = ${memberId}
    `
    if (!member) throw new Error('Agent 成员不存在')
    return member
  }

  private async requireAgentMemberRecord(
    workspaceId: string,
    memberId: string,
    actorUserId: string,
  ): Promise<AgentMemberRecord> {
    const actorRole = await this.memberRoleOf(workspaceId, actorUserId)
    if (!actorRole) throw authorizationDenied('当前用户不是该空间的成员')
    const [row] = await this.database<{
      id: string
      agentId: string
      name: string
      description: string
      status: 'available' | 'disabled'
      version: string
      addedBy: string
      createdAt: Date
      unavailableReason: string | null
    }[]>`
      select wam.id, wam.agent_id as "agentId", a.name, a.description,
             wam.status, av.version, wam.added_by as "addedBy", wam.created_at as "createdAt",
             ${this.database.unsafe(unavailableReasonSql)} as "unavailableReason"
        from workspace_agent_members wam
        join agents a on a.tenant_id = wam.tenant_id and a.id = wam.agent_id
        join agent_versions av on av.tenant_id = wam.tenant_id and av.id = wam.agent_version_id
       where wam.tenant_id = ${tenantId}
         and wam.workspace_id = ${workspaceId}
         and wam.id = ${memberId}
    `
    if (!row) throw new Error('Agent 成员不存在')
    return {
      id: row.id,
      agentId: row.agentId,
      name: row.name,
      description: row.description,
      status: row.status,
      version: row.version,
      addedBy: row.addedBy,
      createdAt: row.createdAt.toISOString(),
      unavailableReason: row.unavailableReason,
      allowedActions: allowedActionsFor(actorRole, row.status, row.unavailableReason),
    }
  }

  private async writeRevocationEvent(
    transaction: DatabaseTransaction,
    workspaceId: string,
    userId: string,
    kind: 'agent_disabled' | 'agent_removed',
    payload: Record<string, string>,
  ) {
    // payload_hash is md5(payload::text) computed by the database so replays
    // with logically identical payloads always produce the same hash and hit
    // the workspace_revocation_events_dedupe unique key.
    await transaction`
      insert into workspace_revocation_events (
        id, tenant_id, workspace_id, user_id, kind, payload, payload_hash
      ) values (
        ${`wrev-${randomUUID()}`}, ${tenantId}, ${workspaceId}, ${userId}, ${kind},
        ${transaction.json(payload)}, md5(${transaction.json(payload)}::text)
      )
      on conflict do nothing
    `
  }
}

/**
 * Locks the workspace row so all agent member mutations serialize per
 * workspace; grant source add/revoke sweeps rely on the same lock, so
 * concurrent joins, disables and removes cannot interleave into a grant
 * with zero active sources.
 */
async function lockWorkspaceRow(transaction: DatabaseTransaction, workspaceId: string) {
  await transaction`
    select id from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
     for update
  `
}

function allowedActionsFor(
  role: 'owner' | 'admin' | 'member' | 'viewer',
  status: AgentMemberStatus,
  unavailableReason: string | null,
): AgentMemberAction[] {
  // 不可用（available + 原因）时不得给出 start_conversation：入口可点却必然失败。
  const canStart = status === 'available' && unavailableReason === null
  if (role === 'owner') {
    if (status !== 'available') return ['enable', 'remove']
    return canStart
      ? ['start_conversation', 'disable', 'upgrade', 'remove']
      : ['disable', 'upgrade', 'remove']
  }
  if ((role === 'admin' || role === 'member') && canStart) {
    return ['start_conversation']
  }
  return []
}

function matchesKeyword(candidate: WorkspaceAgentCandidate, keyword: string) {
  const pattern = keyword.toLowerCase()
  return candidate.name.toLowerCase().includes(pattern)
    || candidate.description.toLowerCase().includes(pattern)
}

function toCandidateSummary(candidate: WorkspaceAgentCandidate): AgentCandidateSummary {
  return {
    agentId: candidate.id,
    name: candidate.name,
    description: candidate.description,
    activeVersionId: candidate.activeVersion.id,
    activeVersion: candidate.activeVersion.version,
    status: candidate.activeVersion.status,
  }
}

function encodeCandidateCursor(agentId: string) {
  return Buffer.from(JSON.stringify({ i: agentId }), 'utf8').toString('base64url')
}

function decodeCursorIndex(candidates: WorkspaceAgentCandidate[], cursor: string) {
  let parsed: { i?: unknown }
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { i?: unknown }
  } catch {
    throw new Error('分页游标无效')
  }
  if (typeof parsed.i !== 'string') throw new Error('分页游标无效')
  const index = candidates.findIndex(candidate => candidate.id === parsed.i)
  if (index < 0) throw new Error('分页游标无效')
  return index + 1
}
