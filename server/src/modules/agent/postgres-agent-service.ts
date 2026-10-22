import { assertDraftCopyPlan } from './agent-draft-copy-policy.ts'
import { createHash, randomUUID } from 'node:crypto'

import type {
  AgentDefinition,
  AgentDraftConfiguration,
  AgentMcpScope,
  AgentVersionRecord,
  AgentVersionStatus,
  CreateAgentDraftInput,
  PublishStatus,
  UpdateAgentDraftInput,
} from '../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { AuditTrail } from '../../domain/audit-trail.ts'
import type { PostgresSkillService, RuntimeSkillConfiguration } from '../skill/postgres-skill-service.ts'
import type { McpScopePort } from '../tool/postgres-mcp-connector-service.ts'
import { agentBuiltinToolNames, parseBuiltinToolReference, unavailableSkillTools } from '../runtime/builtin-tools.ts'
import type { McpConnectionSnapshot } from '../runtime/runtime-types.ts'
import { authorizationDenied } from '../../domain/authorization-errors.ts'
import { requirePlatformAdminActor } from '../authorization/platform-admin-actor.ts'
import { agentSpecFromConfiguration, assembleAgentInstructions, assertAgentSpecContent, type AgentSpec } from './agent-spec.ts'
import { normalizeAgentMcpScope } from '../tool/agent-mcp-scope.ts'
import { RequestError, accessDenied, dependencyUnavailable, invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'

const tenantId = 'tenant-dsh-work'

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value))

/**
 * Platform-seeded default assistant (0003 seed). It is the workbench's
 * implicit default: `listWorkbenchAgents` orders it first and new team
 * workspaces auto-join it so a fresh space can start conversations
 * without a manual owner step.
 */
export const DEFAULT_WORKBENCH_AGENT_ID = 'agent-dsh-work-assistant'

interface AgentRow {
  agentSpec: AgentSpec | null
  /** Status of the editable version row: a frozen candidate is no longer edited in place. */
  versionStatus: 'draft' | 'candidate' | 'published' | 'disabled'
  /** Version the current pointer targets; null before the first publication. */
  activeVersion?: string | null
  id: string
  name: string
  description: string
  welcomeMessage: string
  owner: string
  department: string
  persistedStatus: PublishStatus
  activeVersionId: string | null
  draftVersionId: string | null
  versionId: string
  version: string
  systemPrompt: string
  /** Agent-level audience: roles that may ask this Agent for work. */
  roleIds: string[]
  examplePrompts: string[]
  allowWorkspaceJoin: boolean
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  webSearchEnabled: boolean
  mcpScope: AgentMcpScope
  updatedAt: Date
}

export type AgentFingerprintSource = Omit<Pick<AgentRow,
  | 'versionId'
  | 'name'
  | 'description'
  | 'welcomeMessage'
  | 'systemPrompt'
  | 'examplePrompts'
  | 'skills'
  | 'webSearchEnabled'
  | 'mcpScope'
  | 'maxOutputBytes'
  | 'maxToolCalls'
  | 'timeoutSeconds'
>, 'mcpScope'> & { mcpScope?: AgentMcpScope; agentSpec?: AgentSpec | null }

interface VersionRow {
  id: string
  agentId: string
  agentSpec: AgentSpec | null
  version: string
  name: string
  description: string
  status: AgentVersionStatus
  createdAt: Date
  createdBy: string
  publishedAt: Date | null
  publishedBy: string | null
  sourceVersion: string | null
  summary: string
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  webSearchEnabled: boolean
  mcpScope: AgentMcpScope
}

export interface WorkbenchAgentDefinition {
  id: string
  name: string
  description: string
  welcomeMessage: string
  version: string
  examplePrompts: string[]
}

export interface WorkspaceAgentCandidate {
  id: string
  name: string
  description: string
  activeVersion: {
    id: string
    version: string
    status: PublishStatus
  }
}

export interface AgentJoinedWorkspaceRecord {
  workspaceId: string
  workspaceName: string
  workspaceType: 'personal' | 'team'
  workspaceStatus: string
  memberStatus: 'available' | 'disabled'
  version: string
  addedBy: string
  createdAt: string
}

export interface RuntimeAgentSnapshot {
  versionId: string
  /** Identity supplied by the platform directory, never the governance owner. */
  principalId?: string
  principalAuthorizationVersion?: number
  modelRequirements: AgentSpec['model']['requirements']
  systemPrompt: string
  skills: string[]
  skillInstructions: RuntimeSkillConfiguration[]
  /** 本 Agent 装配的内置工具名称（注册表默认工具、开启的联网搜索、Skill 需要的 Python 执行）。 */
  runtimeTools: string[]
  /** PF-03 currently usable tenant MCP Connectors, fixed in the Attempt snapshot. */
  mcpConnections: McpConnectionSnapshot[]
  approvalMode: 'always' | 'risk_based' | 'never'
  /** Agent-level audience; execution roles come from the authorization decision. */
  roleIds: string[]
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
}

export interface AgentPrincipalGovernance {
  principalId: string
  agentId: string
  status: 'active' | 'disabled'
  authorizationVersion: number
  roleIds: string[]
  dataScopes: string[]
}

export interface AgentMutationSnapshot {
  agent: AgentDefinition
  revision: string
}

export class PostgresAgentService {
  private readonly database: DatabaseClient
  private readonly operations?: AuditTrail
  private readonly skillService?: PostgresSkillService
  private readonly mcp?: McpScopePort

  constructor(
    database: DatabaseClient,
    operations?: AuditTrail,
    skillService?: PostgresSkillService,
    mcp?: McpScopePort,
  ) {
    this.database = database
    this.operations = operations
    this.skillService = skillService
    this.mcp = mcp
  }

  async getAgents(): Promise<AgentDefinition[]> {
    const rows = await this.readAgentRows()
    return rows.map(toAgentDefinition)
  }

  async getAgentPrincipal(agentId: string, sql: DatabaseClient | DatabaseTransaction = this.database): Promise<AgentPrincipalGovernance> {
    const [row] = await sql<{
      principalId: string; agentId: string; status: 'active' | 'disabled'; authorizationVersion: number
      roleIds: string[]; dataScopes: string[]
    }[]>`
      select ep.id as "principalId", ep.agent_id as "agentId", ep.status,
             ep.authorization_version as "authorizationVersion",
             coalesce((select jsonb_agg(g.role_id order by g.role_id) from agent_principal_role_grants g
                       where g.tenant_id = ep.tenant_id and g.principal_id = ep.id), '[]'::jsonb) as "roleIds",
             coalesce((select jsonb_agg(g.scope_value order by g.scope_value) from agent_principal_scope_grants g
                       where g.tenant_id = ep.tenant_id and g.principal_id = ep.id), '[]'::jsonb) as "dataScopes"
        from execution_principals ep
       where ep.tenant_id = ${tenantId} and ep.kind = 'agent' and ep.agent_id = ${agentId}
    `
    if (!row) throw notFound(`Agent 执行身份不存在：${agentId}`)
    return row
  }

  /** Runtime and release checks must ignore role grants whose role has since been disabled. */
  async getAgentExecutionPrincipal(agentId: string, sql: DatabaseClient | DatabaseTransaction = this.database): Promise<AgentPrincipalGovernance> {
    const principal = await this.getAgentPrincipal(agentId, sql)
    const activeRoles = await sql<{ id: string }[]>`
      select g.role_id as id from agent_principal_role_grants g
        join roles r on r.tenant_id = g.tenant_id and r.id = g.role_id and r.status = 'active'
       where g.tenant_id = ${tenantId} and g.principal_id = ${principal.principalId}
       order by g.role_id
    `
    return { ...principal, roleIds: activeRoles.map(role => role.id) }
  }

  async getAgentVersions(): Promise<AgentVersionRecord[]> {
    const rows = await this.database<VersionRow[]>`
      select av.id, av.agent_id as "agentId", av.version, av.name, av.description, av.status,
             av.created_at as "createdAt", creator.display_name as "createdBy",
             av.published_at as "publishedAt", publisher.display_name as "publishedBy",
             av.source_version as "sourceVersion", av.change_summary as summary,
             av.welcome_message as "welcomeMessage", av.example_prompts as "examplePrompts",
             av.system_prompt as "systemPrompt", av.max_output_bytes as "maxOutputBytes",
             av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds", av.skill_refs as skills, av.web_search_enabled as "webSearchEnabled",
             av.mcp_scope as "mcpScope",
             av.agent_spec as "agentSpec"
        from agent_versions av
        join users creator on creator.tenant_id = av.tenant_id and creator.id = av.created_by
        left join users publisher on publisher.tenant_id = av.tenant_id and publisher.id = av.published_by
       where av.tenant_id = ${tenantId}
       order by av.created_at desc
    `
    return rows.map(toVersionRecord)
  }

  async createAgent(input: CreateAgentDraftInput) {
    const actor = await this.requireActor(input.actor)
    const configuration = normalizeConfiguration(input, actor.displayName, actor.department)
    assertConfiguration(configuration)
    if (!Array.isArray(input.executionRoleIds ?? []) || !Array.isArray(input.executionDataScopes ?? [])
      || (input.executionRoleIds ?? []).some(role => typeof role !== 'string' || !role.trim())
      || (input.executionDataScopes ?? []).some(scope => typeof scope !== 'string' || !scope.trim() || scope.length > 128)) {
      throw invalidRequest('Agent 执行授权参数无效')
    }
    if (!Array.isArray(input.visibleRoleIds ?? [])
      || (input.visibleRoleIds ?? []).some(role => typeof role !== 'string' || !role.trim())) {
      throw invalidRequest('Agent 可见角色参数无效')
    }
    const visibleRoleIds = unique(input.visibleRoleIds ?? [])
    const executionRoleIds = unique(input.executionRoleIds ?? [])
    const executionDataScopes = unique(input.executionDataScopes ?? [])
    await this.assertInitialAgentGrants(unique([...visibleRoleIds, ...executionRoleIds]))
    await this.assertCapabilityReferences(configuration.skills, configuration.webSearchEnabled)
    await this.assertMcpConnectorSelection(configuration.mcpScope)
    const versionId = `agent-version-${randomUUID()}`
    const version = '0.1.0'
    const spec = agentSpecFromConfiguration(configuration, version)

    await this.database.begin(async transaction => {
      await transaction`
        insert into agents (
          id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
          status, draft_version_id, visible_role_ids
        ) values (
          ${configuration.id}, ${tenantId}, ${configuration.name}, ${configuration.description},
          ${configuration.welcomeMessage}, ${actor.id}, ${actor.id}, 'draft', null,
          ${transaction.json(visibleRoleIds)}
        )
      `
      await transaction`
        insert into agent_versions (
          id, tenant_id, agent_id, version, name, description, welcome_message,
          example_prompts, system_prompt, max_output_bytes,
          max_tool_calls, timeout_seconds, skill_refs, web_search_enabled, mcp_scope, agent_spec, status, created_by, change_summary
        ) values (
          ${versionId}, ${tenantId}, ${configuration.id}, ${version}, ${configuration.name},
          ${configuration.description}, ${configuration.welcomeMessage}, ${transaction.json(configuration.examplePrompts)},
          ${configuration.systemPrompt}, ${configuration.maxOutputBytes},
          ${configuration.maxToolCalls}, ${configuration.timeoutSeconds}, ${transaction.json(configuration.skills)},
          ${configuration.webSearchEnabled}, ${transaction.json(asJson(configuration.mcpScope))},
          ${transaction.json(asJson(spec))}, 'draft', ${actor.id}, ${configuration.changeSummary}
        )
      `
      // Visibility is not execution authorization. Empty grants fail closed;
      // only explicit creation grants or a later access update can enable it.
      for (const roleId of executionRoleIds) await transaction`
        insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
        values (${tenantId}, ${`principal-agent-${configuration.id}`}, ${roleId})
      `
      for (const scope of executionDataScopes) await transaction`
        insert into agent_principal_scope_grants (tenant_id, principal_id, scope_value)
        values (${tenantId}, ${`principal-agent-${configuration.id}`}, ${scope})
      `
      await transaction`
        update agents set draft_version_id = ${versionId}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${configuration.id}
      `
    })
    await this.audit(actor.id, 'agent.create', configuration.id, 'success', `创建 Agent ${version}`)
    return this.requireAgentResult(configuration.id, versionId)
  }

  private async assertInitialAgentGrants(roleIds: string[]) {
    if (roleIds.length === 0) return
    const rows = await this.database<{ id: string }[]>`
      select id from roles where tenant_id = ${tenantId} and status = 'active'
        and id in ${this.database(roleIds)}
    `
    if (rows.length !== roleIds.length) throw invalidRequest('Agent 授权包含无效或停用角色')
  }

  async getMutationSnapshot(agentId: string): Promise<AgentMutationSnapshot> {
    const [row] = await this.readAgentRows(agentId)
    if (!row) throw notFound(`Agent 不存在：${agentId}`)
    return { agent: toAgentDefinition(row), revision: agentMutationRevision(row) }
  }

  async updateAgent(
    input: UpdateAgentDraftInput,
    expectedRevision?: string,
    options: { draftCopyOnly?: boolean } = {},
  ) {
    const actor = await this.requireActor(input.actor)
    const [current] = await this.readAgentRows(input.agentId)
    if (!current) throw notFound(`Agent 不存在：${input.agentId}`)
    // Access (audience, roles, data scopes) is not draft content; it changes only through updateAccess.
    const configuration = normalizeConfiguration(
      { ...input, id: input.agentId, mcpScope: input.mcpScope ?? current.mcpScope, webSearchEnabled: input.webSearchEnabled ?? current.webSearchEnabled },
      current.owner,
      current.department,
    )
    assertConfiguration(configuration)
    await this.assertCapabilityReferences(configuration.skills, configuration.webSearchEnabled)
    await this.assertMcpConnectorSelection(configuration.mcpScope)

    let draftVersionId = current.draftVersionId
    await this.database.begin(async transaction => {
      const locked = await this.lockAgentForMutation(transaction, input.agentId)
      if (!locked) throw notFound(`Agent 不存在：${input.agentId}`)
      assertAgentMutationRevision(locked, expectedRevision)
      await this.requireActor(input.actor, transaction)
      if (options.draftCopyOnly) {
        if (!locked.draftVersionId) throw authorizationDenied('一次确认仅允许修改现有草稿')
        assertDraftCopyPlan(toAgentDefinition(locked), { ...configuration, agentId: input.agentId })
      }
      // A frozen candidate is validated as is (S3); editing it starts a new draft version.
      draftVersionId = locked.draftVersionId && locked.versionStatus === 'draft' ? locked.draftVersionId : null
      if (draftVersionId) {
        await transaction`
          update agent_versions
             set name = ${configuration.name}, description = ${configuration.description},
                 welcome_message = ${configuration.welcomeMessage},
                 example_prompts = ${transaction.json(configuration.examplePrompts)},
                 system_prompt = ${configuration.systemPrompt},
                 max_output_bytes = ${configuration.maxOutputBytes}, max_tool_calls = ${configuration.maxToolCalls},
                 timeout_seconds = ${configuration.timeoutSeconds},
                 skill_refs = ${transaction.json(configuration.skills)}, web_search_enabled = ${configuration.webSearchEnabled},
                 mcp_scope = ${transaction.json(asJson(configuration.mcpScope))},
                 agent_spec = ${transaction.json(asJson(agentSpecFromConfiguration(configuration, locked.version, locked.agentSpec)))},
                 change_summary = ${configuration.changeSummary}
           where tenant_id = ${tenantId} and id = ${draftVersionId} and status = 'draft'
        `
      } else {
        if (!locked.activeVersionId && !locked.draftVersionId) throw stateConflict('Agent 没有可用于创建新版本的版本')
        const [latest] = await transaction<{ version: string }[]>`
          select version from agent_versions
           where tenant_id = ${tenantId} and agent_id = ${input.agentId}
           order by split_part(version, '.', 1)::integer desc,
                    split_part(version, '.', 2)::integer desc,
                    split_part(version, '.', 3)::integer desc
           limit 1
        `
        draftVersionId = `agent-version-${randomUUID()}`
        const newVersion = nextVersion(latest?.version ?? locked.version)
        await transaction`
          insert into agent_versions (
            id, tenant_id, agent_id, version, name, description, welcome_message,
            example_prompts, system_prompt, max_output_bytes,
            max_tool_calls, timeout_seconds, skill_refs, web_search_enabled, mcp_scope, agent_spec, status, created_by, source_version, change_summary
          ) values (
            ${draftVersionId}, ${tenantId}, ${input.agentId}, ${newVersion},
            ${configuration.name}, ${configuration.description}, ${configuration.welcomeMessage},
            ${transaction.json(configuration.examplePrompts)}, ${configuration.systemPrompt},
            ${configuration.maxOutputBytes}, ${configuration.maxToolCalls}, ${configuration.timeoutSeconds},
            ${transaction.json(configuration.skills)}, ${configuration.webSearchEnabled},
            ${transaction.json(asJson(configuration.mcpScope))},
            ${transaction.json(asJson(agentSpecFromConfiguration(configuration, newVersion, locked.agentSpec)))},
            'draft', ${actor.id}, ${locked.version}, ${configuration.changeSummary}
          )
        `
      }
      if (options.draftCopyOnly) {
        // Do not modify published catalog metadata, active version or runtime policy.
        await transaction`update agents set updated_at = now() where tenant_id = ${tenantId} and id = ${input.agentId}`
      } else {
      await transaction`
        update agents set name = ${configuration.name}, description = ${configuration.description},
                          welcome_message = ${configuration.welcomeMessage}, draft_version_id = ${draftVersionId},
                          updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.agentId}
      `
      }
    })
    await this.audit(actor.id, 'agent.draft.update', input.agentId, 'success', '保存 Agent 待发布版本')
    if (!draftVersionId) throw new Error('Agent 草稿版本创建失败')
    return this.requireAgentResult(input.agentId, draftVersionId)
  }

  async setStatus(input: {
    agentId: string
    status: Extract<PublishStatus, 'published' | 'disabled'>
    actor: string
  }, expectedRevision?: string) {
    const actor = await this.requireActor(input.actor)
    const [current] = await this.readAgentRows(input.agentId)
    if (!current) throw notFound(`Agent 不存在：${input.agentId}`)

    if (input.status === 'disabled') {
      const release = await this.database.begin(async transaction => {
        const locked = await this.lockAgentForMutation(transaction, input.agentId)
        if (!locked) throw notFound(`Agent 不存在：${input.agentId}`)
        assertAgentMutationRevision(locked, expectedRevision)
        // 停用是管理状态切换，与待发布草稿独立：草稿保留并可在治理流程中继续推进，
        // 发布只切换活动版本，不隐式重新启用（见 publishDraftWithinTransaction）。
        if (!locked.activeVersionId) throw stateConflict('尚未发布的 Agent 不能停用')
        const activeVersionId = locked.activeVersionId
        const updated = await transaction`
          update agents set status = 'disabled', updated_at = now()
           where tenant_id = ${tenantId} and id = ${input.agentId}
             and status = 'published' and active_version_id = ${activeVersionId}
           returning id
        `
        if (!updated.length) throw stateConflict('仅已发布状态的 Agent 可以停用，或状态已变化请刷新后重试')
        return activeVersionId
      })
      await this.audit(actor.id, 'agent.disable', input.agentId, 'success', `停用当前 Agent（版本 ${release}），不影响已创建的运行。`)
      return { agent: await this.requireAgent(input.agentId) }
    }

    // 重新启用只翻转管理状态：与进行中草稿独立（停用期间草稿可继续编辑）。
    // 非停用状态的 published 写入属于"发布"，必须经验证通过后在验证与发布中完成。
    const reenabling = current.persistedStatus === 'disabled' && Boolean(current.activeVersionId)
    if (!reenabling) {
      if (current.draftVersionId) {
        throw stateConflict('草稿必须验证通过后才能发布，不能走状态直改')
      }
      throw stateConflict('当前 Agent 没有可发布草稿，也不处于停用状态')
    }
    const release = await this.database.begin(async transaction => {
      const locked = await this.lockAgentForMutation(transaction, input.agentId)
      if (!locked) throw notFound(`Agent 不存在：${input.agentId}`)
      assertAgentMutationRevision(locked, expectedRevision)
      if (!locked.activeVersionId || locked.persistedStatus !== 'disabled') {
        throw stateConflict('当前 Agent 没有可发布草稿，也不处于停用状态')
      }
      const activeVersionId = locked.activeVersionId
      const updated = await transaction`
        update agents set status = 'published', updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.agentId}
           and status = 'disabled' and active_version_id = ${activeVersionId}
         returning id
      `
      if (!updated.length) throw stateConflict('Agent 状态已发生变化，请刷新后重试')
      return activeVersionId
    })
    await this.audit(actor.id, 'agent.enable', input.agentId, 'success', `重新启用当前 Agent 版本 ${release}。`)
    return { agent: await this.requireAgent(input.agentId) }
  }

  async rollback(input: { agentId: string; version: string; actor: string }) {
    const actor = await this.requireActor(input.actor)
    const [current] = await this.readAgentRows(input.agentId)
    if (!current) throw notFound(`Agent 不存在：${input.agentId}`)
    const [target] = await this.database<VersionRow[]>`
      select av.id, av.agent_id as "agentId", av.version, av.name, av.description, av.status, av.created_at as "createdAt",
             creator.display_name as "createdBy", av.published_at as "publishedAt",
             publisher.display_name as "publishedBy", av.source_version as "sourceVersion",
             av.change_summary as summary,
             av.welcome_message as "welcomeMessage", av.example_prompts as "examplePrompts",
             av.system_prompt as "systemPrompt", av.max_output_bytes as "maxOutputBytes",
             av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds", av.skill_refs as skills,
             av.web_search_enabled as "webSearchEnabled"
        from agent_versions av
        join users creator on creator.tenant_id = av.tenant_id and creator.id = av.created_by
        left join users publisher on publisher.tenant_id = av.tenant_id and publisher.id = av.published_by
       where av.tenant_id = ${tenantId} and av.agent_id = ${input.agentId}
         and av.version = ${input.version} and av.status = 'published'
    `
    if (!target) throw notFound(`已发布 Agent Version 不存在：${input.agentId}@${input.version}`)
    await this.assertCapabilityReferences(target.skills, target.webSearchEnabled)

    if (!current.activeVersionId) throw stateConflict('尚未发布的 Agent 不能回滚')
    if (current.activeVersionId === target.id) throw stateConflict(`v${target.version} 已是当前活动版本，无需回滚`)
    const [activeBefore] = await this.database<{ version: string }[]>`
      select version from agent_versions where tenant_id = ${tenantId} and id = ${current.activeVersionId}
    `
    const note = `活动版本由 v${activeBefore?.version ?? '—'} 回滚到 v${target.version}；启停状态与进行中的草稿保持不变。`
    // F-03：回滚只移动活动版本指针。行锁 + 比较活动版本防止与并发发布/回滚交错；
    // 不改变 agents.status（停用中的 Agent 回滚后仍停用），也不停用进行中的草稿及其发布候选。
    await this.database.begin(async transaction => {
      const locked = await this.lockAgentForMutation(transaction, input.agentId)
      if (!locked || locked.activeVersionId !== current.activeVersionId) {
        throw stateConflict('Agent 当前版本已发生变化，请刷新后重试')
      }
      const [stillPublished] = await transaction<{ id: string }[]>`
        select id from agent_versions
         where tenant_id = ${tenantId} and id = ${target.id} and status = 'published'
         for share
      `
      if (!stillPublished) throw notFound(`已发布 Agent Version 不存在：${input.agentId}@${input.version}`)
      const moved = await transaction<{ id: string }[]>`
        update agents set active_version_id = ${target.id}, name = ${target.name},
                          description = ${target.description},
                          welcome_message = ${target.welcomeMessage}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.agentId}
           and active_version_id = ${current.activeVersionId}
        returning id
      `
      if (!moved.length) throw stateConflict('Agent 当前版本已发生变化，请刷新后重试')
    })
    await this.audit(actor.id, 'agent.rollback', input.agentId, 'success', note)
    return { agent: await this.requireAgent(input.agentId) }
  }

  /**
   * 平台治理开关（convergence §1）：关闭后该 Agent 不再出现在团队空间「添加 Agent」
   * 候选，也不能被加入团队空间。只改 `agents.allow_workspace_join`，不触碰版本、
   * 既有成员关联或既有授权来源；`updated_at` 保持不变以免影响 Agent 列表排序。
   */
  async setAgentWorkspaceJoin(input: {
    agentId: string
    allowWorkspaceJoin: boolean
    actor: string
  }): Promise<AgentDefinition> {
    const actor = await this.requireActor(input.actor)
    if (typeof input.allowWorkspaceJoin !== 'boolean') {
      throw invalidRequest('allowWorkspaceJoin 必须为布尔值')
    }
    const [current] = await this.readAgentRows(input.agentId)
    if (!current) throw notFound(`Agent 不存在：${input.agentId}`)
    await this.database.begin(async transaction => {
      const [locked] = await transaction<{ id: string }[]>`
        select id from agents
         where tenant_id = ${tenantId} and id = ${input.agentId}
         for update
      `
      if (!locked) throw notFound(`Agent 不存在：${input.agentId}`)
      await transaction`
        update agents set allow_workspace_join = ${input.allowWorkspaceJoin}
         where tenant_id = ${tenantId} and id = ${input.agentId}
      `
    })
    await this.audit(
      actor.id,
      'agent.workspace_join.update',
      input.agentId,
      'success',
      input.allowWorkspaceJoin ? '允许该 Agent 加入团队空间' : '禁止该 Agent 加入团队空间',
    )
    return this.requireAgent(input.agentId)
  }

  /**
   * 只读的「已加入空间」清单（convergence §1，admin Agent 详情页用于评估停用影响）。
   * 已移出的成员不返回；返回的是当前成员关联与固定版本，不返回空间内容。
   */
  async listAgentJoinedWorkspaces(agentId: string): Promise<AgentJoinedWorkspaceRecord[]> {
    const [agent] = await this.database<{ id: string }[]>`
      select id from agents where tenant_id = ${tenantId} and id = ${agentId}
    `
    if (!agent) throw notFound(`Agent 不存在：${agentId}`)
    const rows = await this.database<{
      workspaceId: string
      workspaceName: string
      workspaceType: 'personal' | 'team'
      workspaceStatus: string
      memberStatus: 'available' | 'disabled'
      version: string
      addedBy: string
      createdAt: Date
    }[]>`
      select wam.workspace_id as "workspaceId", w.name as "workspaceName",
             w.workspace_type as "workspaceType", w.status as "workspaceStatus",
             wam.status as "memberStatus", av.version,
             wam.added_by as "addedBy", wam.created_at as "createdAt"
        from workspace_agent_members wam
        join workspaces w on w.tenant_id = wam.tenant_id and w.id = wam.workspace_id
        join agent_versions av on av.tenant_id = wam.tenant_id and av.id = wam.agent_version_id
       where wam.tenant_id = ${tenantId}
         and wam.agent_id = ${agentId}
         and wam.status <> 'removed'
       order by wam.created_at desc, wam.id desc
    `
    return rows.map(row => ({
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspaceType: row.workspaceType,
      workspaceStatus: row.workspaceStatus,
      memberStatus: row.memberStatus,
      version: row.version,
      addedBy: row.addedBy,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async listWorkbenchAgents(userId: string, sessionRoleIds?: string[]): Promise<WorkbenchAgentDefinition[]> {
    const roleIds = sessionRoleIds === undefined
      ? (await this.database<{ roleId: string }[]>`
          select role_id as "roleId" from user_roles
           where tenant_id = ${tenantId} and user_id = ${userId}
             and (valid_until is null or valid_until > now())
        `).map(row => row.roleId)
      : unique(sessionRoleIds)
    if (roleIds.length === 0) return []
    return this.database<WorkbenchAgentDefinition[]>`
      select a.id, av.name, av.description, av.welcome_message as "welcomeMessage",
             av.version, av.example_prompts as "examplePrompts"
        from agents a
        join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
        join execution_principals ep on ep.tenant_id = a.tenant_id and ep.agent_id = a.id
          and ep.kind = 'agent' and ep.status = 'active'
        join users u on u.tenant_id = a.tenant_id and u.id = ${userId} and u.status = 'active'
       where a.tenant_id = ${tenantId} and a.status = 'published'
         and av.status = 'published'
         and exists (
           select 1 from roles r
            where r.tenant_id = a.tenant_id and r.id in ${this.database(roleIds)}
              and a.visible_role_ids ? r.id
         )
       order by case when a.id = ${DEFAULT_WORKBENCH_AGENT_ID} then 0 else 1 end,
                a.updated_at desc, a.id
    `
  }

  async resolveWorkbenchAgentVersion(
    agentId: string | undefined,
    userId: string,
    sessionRoleIds?: string[],
    additionalSkillReferences: string[] = [],
  ): Promise<string> {
    const agents = await this.listWorkbenchAgents(userId, sessionRoleIds)
    const candidates = agentId ? agents.filter(agent => agent.id === agentId) : agents
    if (!candidates.length) throw (agentId ? notFound('Agent 不存在或当前用户不可用') : accessDenied('当前用户没有可用 Agent'))
    for (const candidate of candidates) {
      const [row] = await this.database<{
        activeVersionId: string
        skills: string[]
        webSearchEnabled: boolean
      }[]>`
        select a.active_version_id as "activeVersionId", av.skill_refs as skills,
               av.web_search_enabled as "webSearchEnabled"
          from agents a
          join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
         where a.tenant_id = ${tenantId} and a.id = ${candidate.id}
      `
      if (!row?.activeVersionId) continue
      if (!additionalSkillReferences.length) return row.activeVersionId
      try {
        await this.assertCapabilityReferences(
          mergeSkillReferences(row.skills, additionalSkillReferences),
          row.webSearchEnabled,
        )
        return row.activeVersionId
      } catch (error) {
        if (agentId) throw error
      }
    }
    throw invalidRequest('所选 Skill 需要的工具当前没有 Agent 可以提供（例如未开启联网搜索），请联系管理员配置')
  }

  async listWorkspaceAgentCandidates(
    workspaceId: string,
    requesterUserId: string,
    sessionRoleIds?: string[],
  ): Promise<WorkspaceAgentCandidate[]> {
    const roleIds = sessionRoleIds === undefined
      ? (await this.database<{ roleId: string }[]>`
          select role_id as "roleId" from user_roles
           where tenant_id = ${tenantId} and user_id = ${requesterUserId}
             and (valid_until is null or valid_until > now())
        `).map(row => row.roleId)
      : unique(sessionRoleIds)
    if (roleIds.length === 0) return []
    const rows = await this.database<{
      id: string
      name: string
      description: string
      versionId: string
      version: string
      versionStatus: PublishStatus
    }[]>`
      select a.id, a.name, a.description,
             av.id as "versionId", av.version, av.status as "versionStatus"
        from agents a
        join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
        join execution_principals ep on ep.tenant_id = a.tenant_id and ep.agent_id = a.id
          and ep.kind = 'agent' and ep.status = 'active'
        join users u on u.tenant_id = a.tenant_id and u.id = ${requesterUserId} and u.status = 'active'
       where a.tenant_id = ${tenantId}
         and a.status = 'published'
         and a.allow_workspace_join = true
         and av.status = 'published'
         and exists (
           select 1 from roles r
            where r.tenant_id = a.tenant_id and r.id in ${this.database(roleIds)}
              and a.visible_role_ids ? r.id
         )
         and not exists (
           select 1 from workspace_agent_members wam
            where wam.tenant_id = a.tenant_id and wam.workspace_id = ${workspaceId}
              and wam.agent_id = a.id and wam.status <> 'removed'
         )
       order by a.updated_at desc
    `
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      activeVersion: { id: row.versionId, version: row.version, status: row.versionStatus },
    }))
  }

  async getRuntimeSnapshot(
    versionId: string,
    additionalSkillReferences: string[] = [],
  ): Promise<RuntimeAgentSnapshot> {
    const [row] = await this.database<(Omit<RuntimeAgentSnapshot, 'skillInstructions' | 'runtimeTools' | 'approvalMode' | 'mcpConnections'> & AgentFingerprintSource & {
      agentId: string; agentSpec: AgentSpec | null; versionStatus: AgentVersionStatus
    })[]>`
      select av.id as "versionId", av.agent_id as "agentId", ep.id as "principalId",
             ep.authorization_version as "principalAuthorizationVersion",
             av.name, av.description, av.welcome_message as "welcomeMessage",
             av.example_prompts as "examplePrompts", av.mcp_scope as "mcpScope",
             av.system_prompt as "systemPrompt", av.skill_refs as skills,
             av.web_search_enabled as "webSearchEnabled", a.visible_role_ids as "roleIds",
             av.max_output_bytes as "maxOutputBytes", av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds",
             av.agent_spec as "agentSpec",
             av.status as "versionStatus",
             coalesce(av.agent_spec #> '{model,requirements}', '[]'::jsonb) as "modelRequirements"
        from agent_versions av
        join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
        join execution_principals ep on ep.tenant_id = av.tenant_id and ep.agent_id = av.agent_id
          and ep.kind = 'agent' and ep.status = 'active'
       where av.tenant_id = ${tenantId} and av.id = ${versionId}
    `
    if (!row) throw notFound(`Agent Version 不存在或 Agent 执行身份已停用：${versionId}`)
    const skills = mergeSkillReferences(row.skills, additionalSkillReferences)
    const principal = await this.getAgentExecutionPrincipal(row.agentId)
    if (principal.status !== 'active') throw authorizationDenied('Agent 执行身份已停用')
    await this.assertCapabilityReferences(skills, row.webSearchEnabled)
    const skillInstructions = this.skillService
      ? await this.skillService.resolveRuntimeSkills(skills)
      : []
    // 内置工具按注册表装配：默认工具、Agent 开启的联网搜索、Skill 需要的 Python 执行。
    // Runtime 停用清单在创建 Attempt 时扣除。
    const skillExecutionTools = skillInstructions.flatMap(skill => skill.tools)
      .flatMap(reference => parseBuiltinToolReference(reference)?.name === 'python_execute' ? ['python_execute'] : [])
    const runtimeTools = unique([...agentBuiltinToolNames({ webSearchEnabled: row.webSearchEnabled }), ...skillExecutionTools])
    const approvalMode = 'never' as const
    const mcpConnections = await this.resolveMcpConnections(row.mcpScope)
    const runtimeSkills = this.skillService
      ? skillInstructions.map(skill => `${skill.id}@${skill.version}`)
      : skills
    const systemPrompt = row.agentSpec
      ? assembleAgentInstructions(row.agentSpec)
      : row.systemPrompt
    const { agentId: _agentId, agentSpec: _agentSpec, versionStatus: _versionStatus, ...snapshot } = row
    return { ...snapshot, systemPrompt, skills: runtimeSkills, skillInstructions, runtimeTools, mcpConnections, approvalMode }
  }

  /** Skill 必须已发布；Skill 需要的内置工具必须能由该 Agent 提供（联网搜索须开启）。 */
  private async assertCapabilityReferences(skills: string[], webSearchEnabled: boolean) {
    if (!this.skillService) return
    await this.skillService.assertPublishedReferences(skills)
    const runtimeSkills = await this.skillService.resolveRuntimeSkills(skills)
    const problems = unavailableSkillTools(runtimeSkills.flatMap(skill => skill.tools), { webSearchEnabled })
    if (problems.length) {
      throw authorizationDenied(`所选 Skill 需要的工具不可用：${problems.join('、')}`, { status: 422, code: 'invalid_request', suggestion: '按提示调整输入内容或文件后重新提交。' })
    }
  }

  private async requireActor(userId: string, sql: DatabaseClient | DatabaseTransaction = this.database) {
    return requirePlatformAdminActor(sql, userId)
  }

  private async readAgentRows(agentId?: string): Promise<AgentRow[]> {
    return this.database<AgentRow[]>`
      select a.id, av.name, av.description, av.welcome_message as "welcomeMessage",
             owner.display_name as owner, coalesce(owner.department_id, '未分配部门') as department,
             a.status as "persistedStatus", a.active_version_id as "activeVersionId",
             a.draft_version_id as "draftVersionId", av.id as "versionId", av.version,
             av.status as "versionStatus", active.version as "activeVersion",
             av.system_prompt as "systemPrompt", a.visible_role_ids as "roleIds",
             av.example_prompts as "examplePrompts",
             a.allow_workspace_join as "allowWorkspaceJoin",
             av.max_output_bytes as "maxOutputBytes", av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds",
             av.skill_refs as skills, av.web_search_enabled as "webSearchEnabled", av.mcp_scope as "mcpScope",
             av.agent_spec as "agentSpec", a.updated_at as "updatedAt"
        from agents a
        join users owner on owner.tenant_id = a.tenant_id and owner.id = a.owner_user_id
        join agent_versions av on av.tenant_id = a.tenant_id
         and av.id = coalesce(a.draft_version_id, a.active_version_id)
        left join agent_versions active on active.tenant_id = a.tenant_id and active.id = a.active_version_id
       where a.tenant_id = ${tenantId} ${agentId ? this.database`and a.id = ${agentId}` : this.database``}
       order by a.updated_at desc
    `
  }

  private async lockAgentForMutation(transaction: DatabaseTransaction, agentId: string): Promise<AgentRow | undefined> {
    const [row] = await transaction<AgentRow[]>`
      select a.id, av.name, av.description, av.welcome_message as "welcomeMessage",
             owner.display_name as owner, coalesce(owner.department_id, '未分配部门') as department,
             a.status as "persistedStatus", a.active_version_id as "activeVersionId",
             a.draft_version_id as "draftVersionId", av.id as "versionId", av.version,
             av.status as "versionStatus",
             av.system_prompt as "systemPrompt", a.visible_role_ids as "roleIds",
             av.example_prompts as "examplePrompts",
             a.allow_workspace_join as "allowWorkspaceJoin",
             av.max_output_bytes as "maxOutputBytes", av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds",
             av.skill_refs as skills, av.web_search_enabled as "webSearchEnabled", av.mcp_scope as "mcpScope",
             av.agent_spec as "agentSpec", a.updated_at as "updatedAt"
        from agents a
        join users owner on owner.tenant_id = a.tenant_id and owner.id = a.owner_user_id
        join agent_versions av on av.tenant_id = a.tenant_id
         and av.id = coalesce(a.draft_version_id, a.active_version_id)
       where a.tenant_id = ${tenantId} and a.id = ${agentId}
       for update of a, av
    `
    return row
  }

  private async requireAgent(agentId: string): Promise<AgentDefinition> {
    const [row] = await this.readAgentRows(agentId)
    if (!row) throw notFound(`Agent 不存在：${agentId}`)
    return toAgentDefinition(row)
  }

  private async assertMcpConnectorSelection(scope: AgentMcpScope | undefined): Promise<void> {
    const normalized = normalizeAgentMcpScope(scope)
    if (normalized.mode !== 'selected') return
    if (!this.mcp) throw dependencyUnavailable('MCP Connector 服务未接入')
    await this.mcp.validateSelection(normalized.connectorIds)
  }

  private async resolveMcpConnections(scope: AgentMcpScope | undefined): Promise<McpConnectionSnapshot[]> {
    if (normalizeAgentMcpScope(scope).mode === 'none') return []
    if (!this.mcp) throw dependencyUnavailable('MCP Connector 服务未接入')
    return this.mcp.resolveConnections(scope)
  }

  private async requireAgentResult(agentId: string, versionId: string) {
    const agent = await this.requireAgent(agentId)
    const versions = await this.getAgentVersions()
    const version = versions.find(item => item.id === versionId)
    if (!version) throw notFound(`Agent Version 不存在：${versionId}`)
    return { agent, version }
  }

  private audit(actorId: string, action: string, agentId: string, result: 'success' | 'failed', detail: string) {
    return this.operations?.appendAudit(actorId, action, agentId, result, `trace-agent-${randomUUID()}`, detail)
      ?? Promise.resolve()
  }
}

function normalizeConfiguration(
  input: AgentDraftConfiguration,
  owner: string,
  department: string,
): AgentDraftConfiguration & { webSearchEnabled: boolean } {
  const welcomeMessage = input.welcomeMessage.trim()
    || `你好，我是${input.name.trim() || '企业 Agent'}。${input.description.trim() || '我会协助你完成工作。'}`.slice(0, 120)
  return {
    ...input,
    name: input.name.trim(),
    description: input.description.trim(),
    owner,
    department,
    welcomeMessage,
    examplePrompts: unique(input.examplePrompts),
    systemPrompt: input.systemPrompt.trim(),
    ...(input.workInstructions !== undefined ? { workInstructions: input.workInstructions?.trim() ?? '' } : {}),
    skills: unique(input.skills),
    webSearchEnabled: input.webSearchEnabled === true,
    mcpScope: normalizeAgentMcpScope(input.mcpScope),
    changeSummary: input.changeSummary.trim() || '更新 Agent 配置',
  }
}

function assertConfiguration(input: AgentDraftConfiguration & { webSearchEnabled: boolean }) {
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(input.id)) throw invalidRequest('Agent 标识格式不正确')
  // 定义字段与包入口共用同一规范化校验（AgentSpec 内容边界）。
  assertAgentSpecContent(agentSpecFromConfiguration(input, ''))
  // Drafts may start with no audience or business-data access. The release
  // gate requires an audience before the first trial; an Agent without data
  // grants is a basic Agent without platform business-data access.
  if (!input.examplePrompts.length) throw invalidRequest('必须配置至少一个示例问题')
}

function toAgentDefinition(row: AgentRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner: row.owner,
    department: row.department,
    visibility: audienceLabel(row.roleIds),
    roleIds: row.roleIds,
    allowWorkspaceJoin: row.allowWorkspaceJoin,
    // 管理状态优先于草稿外观：停用中的 Agent 即使有待发布草稿也显示「已停用」，
    // 否则停用被草稿掩盖且无法从列表重新启用。
    status: row.persistedStatus === 'disabled' ? 'disabled' : row.draftVersionId ? 'draft' : row.persistedStatus,
    version: row.version,
    activeVersion: row.activeVersion ?? null,
    welcomeMessage: row.welcomeMessage,
    examplePrompts: row.examplePrompts,
    systemPrompt: row.systemPrompt,
    workInstructions: row.agentSpec?.workProcedures?.body ?? '',
    maxOutputBytes: row.maxOutputBytes,
    maxToolCalls: row.maxToolCalls,
    timeoutSeconds: row.timeoutSeconds,
    skills: row.skills,
    webSearchEnabled: row.webSearchEnabled,
    mcpScope: normalizeAgentMcpScope(row.mcpScope),
    updatedAt: formatDateTime(row.updatedAt),
    revision: agentMutationRevision(row),
  }
}

function audienceLabel(roleIds: string[]) {
  return roleIds.length === 0 ? '未设置' : roleIds.includes('role-employee') ? '全体试点员工' : `指定 ${roleIds.length} 个角色`
}

function toVersionRecord(row: VersionRow): AgentVersionRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    version: row.version,
    status: row.status,
    createdAt: formatDateTime(row.createdAt),
    createdBy: row.createdBy,
    ...(row.publishedAt ? { publishedAt: formatDateTime(row.publishedAt) } : {}),
    ...(row.publishedBy ? { publishedBy: row.publishedBy } : {}),
    ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
    summary: row.summary,
    welcomeMessage: row.welcomeMessage,
    examplePrompts: row.examplePrompts,
    systemPrompt: row.systemPrompt,
    workInstructions: row.agentSpec?.workProcedures?.body ?? '',
    maxOutputBytes: row.maxOutputBytes,
    maxToolCalls: row.maxToolCalls,
    timeoutSeconds: row.timeoutSeconds,
    skills: row.skills,
    webSearchEnabled: row.webSearchEnabled,
    mcpScope: normalizeAgentMcpScope(row.mcpScope),
  }
}

export function configurationFingerprint(row: AgentFingerprintSource) {
  return createHash('sha256').update(JSON.stringify({
    versionId: row.versionId,
    name: row.name,
    description: row.description,
    welcomeMessage: row.welcomeMessage,
    systemPrompt: row.systemPrompt,
    workInstructions: row.agentSpec?.workProcedures?.body ?? '',
    // F-09：员工可见角色是发布属性，不影响 Agent 行为，也不参与试运行，因此不进入定义指纹；
    // 调整可见范围不作废试运行证据，由发布事务复核角色有效性并单独审计。平台数据范围上限仍计入。
    examplePrompts: [...row.examplePrompts],
    skills: [...row.skills].sort(),
    webSearchEnabled: row.webSearchEnabled,
    mcpScope: normalizeAgentMcpScope(row.mcpScope),
    maxOutputBytes: row.maxOutputBytes,
    maxToolCalls: row.maxToolCalls,
    timeoutSeconds: row.timeoutSeconds,
  })).digest('hex')
}

function agentMutationRevision(row: AgentRow) {
  return createHash('sha256').update(JSON.stringify({
    configuration: configurationFingerprint(row),
    persistedStatus: row.persistedStatus,
    activeVersionId: row.activeVersionId,
    draftVersionId: row.draftVersionId,
    owner: row.owner,
    department: row.department,
  })).digest('hex')
}

function assertAgentMutationRevision(row: AgentRow, expectedRevision?: string) {
  if (expectedRevision && agentMutationRevision(row) !== expectedRevision) {
    throw new RequestError(409, 'state_conflict', 'Agent 配置已变化（可能已被其他管理员或流程修改），请刷新后重新编辑')
  }
}

function nextVersion(current: string) {
  const [major = 0, minor = 0] = current.split('.').map(Number)
  return `${major}.${minor + 1}.0`
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function mergeSkillReferences(base: string[], additional: string[]) {
  const references = new Map<string, string>()
  for (const reference of [...base, ...additional]) {
    const normalized = reference.trim()
    const { id } = parseReference(normalized)
    references.set(id, normalized)
  }
  return [...references.values()]
}

function parseReference(reference: string) {
  const separator = reference.lastIndexOf('@')
  if (separator <= 0 || separator === reference.length - 1) {
    throw invalidRequest(`工具引用必须锁定版本：${reference}`)
  }
  return { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
}

function formatDateTime(value: Date) {
  return value.toISOString().slice(0, 16).replace('T', ' ')
}
