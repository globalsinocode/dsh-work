import { assertDraftCopyPlan } from './agent-draft-copy-policy.ts'
import { createHash, randomUUID } from 'node:crypto'

import type {
  AgentDefinition,
  AgentDraftConfiguration,
  AgentReleaseRecord,
  AgentVersionRecord,
  CreateAgentDraftInput,
  PublishStatus,
  UpdateAgentDraftInput,
} from '../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import type { PostgresSkillService, RuntimeSkillConfiguration } from '../skill/postgres-skill-service.ts'
import type { PostgresToolConnectorService } from '../tool/postgres-tool-connector-service.ts'
import type { ManifestToolBinding, ResolvedToolBinding } from '../../domain/tool-binding.ts'
import { DSH_WORK_EXECUTION_TOOL_REFS } from '../../domain/tool-category.ts'
import type { McpConnectionSnapshot } from '../runtime/runtime-types.ts'
import { authorizationDenied } from '../authorization/authorization-errors.ts'
import { agentSpecFromConfiguration, assertAgentSpecContent, type AgentSpec } from './agent-spec.ts'

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
  roleIds: string[]
  dataScopes: string[]
  examplePrompts: string[]
  allowWorkspaceJoin: boolean
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
  updatedAt: Date
}

export type AgentFingerprintSource = Pick<AgentRow,
  | 'versionId'
  | 'name'
  | 'description'
  | 'welcomeMessage'
  | 'systemPrompt'
  | 'roleIds'
  | 'dataScopes'
  | 'examplePrompts'
  | 'skills'
  | 'tools'
  | 'maxOutputBytes'
  | 'maxToolCalls'
  | 'timeoutSeconds'
>

interface VersionRow {
  id: string
  agentId: string
  version: string
  bindingRefs?: ManifestToolBinding[]
  name: string
  description: string
  status: PublishStatus
  createdAt: Date
  createdBy: string
  publishedAt: Date | null
  publishedBy: string | null
  sourceVersion: string | null
  summary: string
  roleIds: string[]
  dataScopes: string[]
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
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
  modelRequirements: AgentSpec['model']['requirements']
  systemPrompt: string
  skills: string[]
  skillInstructions: RuntimeSkillConfiguration[]
  tools: string[]
  runtimeTools: string[]
  /** B-03/I-04：发布版本固定绑定 + 当前语义解析出的 active 工具绑定修订。 */
  toolBindings: ResolvedToolBinding[]
  /** PF-03 currently usable tenant MCP Connectors, fixed in the Attempt snapshot. */
  mcpConnections: McpConnectionSnapshot[]
  approvalMode: 'always' | 'risk_based' | 'never'
  roleIds: string[]
  dataScopes: string[]
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
}

export interface AgentMutationSnapshot {
  agent: AgentDefinition
  revision: string
}

export class PostgresAgentService {
  private readonly database: DatabaseClient
  private readonly operations?: PostgresOperationsService
  private readonly skillService?: PostgresSkillService
  private readonly toolService?: PostgresToolConnectorService

  constructor(
    database: DatabaseClient,
    operations?: PostgresOperationsService,
    skillService?: PostgresSkillService,
    toolService?: PostgresToolConnectorService,
  ) {
    this.database = database
    this.operations = operations
    this.skillService = skillService
    this.toolService = toolService
  }

  async getAgents(): Promise<AgentDefinition[]> {
    const rows = await this.readAgentRows()
    return rows.map(toAgentDefinition)
  }

  async getAgentVersions(): Promise<AgentVersionRecord[]> {
    const rows = await this.database<VersionRow[]>`
      select av.id, av.agent_id as "agentId", av.version, av.name, av.description, av.status,
             av.created_at as "createdAt", creator.display_name as "createdBy",
             av.published_at as "publishedAt", publisher.display_name as "publishedBy",
             av.source_version as "sourceVersion", av.change_summary as summary,
             av.visible_role_ids as "roleIds", av.data_scopes as "dataScopes",
             av.welcome_message as "welcomeMessage", av.example_prompts as "examplePrompts",
             av.system_prompt as "systemPrompt", av.max_output_bytes as "maxOutputBytes",
             av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds", av.skill_refs as skills, av.tool_refs as tools,
             av.binding_refs as "bindingRefs"
        from agent_versions av
        join users creator on creator.tenant_id = av.tenant_id and creator.id = av.created_by
        left join users publisher on publisher.tenant_id = av.tenant_id and publisher.id = av.published_by
       where av.tenant_id = ${tenantId}
       order by av.created_at desc
    `
    return rows.map(toVersionRecord)
  }

  async getReleaseRecords(): Promise<AgentReleaseRecord[]> {
    const rows = await this.database<{
      id: string; agentId: string; version: string; action: AgentReleaseRecord['action'];
      actor: string; time: Date; note: string
    }[]>`
      select arr.id, arr.agent_id as "agentId", av.version, arr.action,
             u.display_name as actor, arr.created_at as time, arr.note
        from agent_release_records arr
        join agent_versions av on av.tenant_id = arr.tenant_id and av.id = arr.agent_version_id
        join users u on u.tenant_id = arr.tenant_id and u.id = arr.actor_id
       where arr.tenant_id = ${tenantId}
       order by arr.created_at desc
    `
    return rows.map(row => ({ ...row, time: formatDateTime(row.time) }))
  }

  async createAgent(input: CreateAgentDraftInput) {
    const actor = await this.requireActor(input.actor)
    const configuration = normalizeConfiguration(input, actor.displayName, actor.department)
    assertConfiguration(configuration)
    await this.assertCapabilityReferences(configuration.skills, configuration.tools, configuration.roleIds, configuration.dataScopes)
    const versionId = `agent-version-${randomUUID()}`
    const version = '0.1.0'
    const spec = agentSpecFromConfiguration(configuration, version)

    await this.database.begin(async transaction => {
      await transaction`
        insert into agents (
          id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
          status, draft_version_id
        ) values (
          ${configuration.id}, ${tenantId}, ${configuration.name}, ${configuration.description},
          ${configuration.welcomeMessage}, ${actor.id}, ${actor.id}, 'draft', null
        )
      `
      await transaction`
        insert into agent_versions (
          id, tenant_id, agent_id, version, name, description, welcome_message,
          example_prompts, system_prompt, visible_role_ids, data_scopes, max_output_bytes,
          max_tool_calls, timeout_seconds, skill_refs, tool_refs, agent_spec, status, created_by, change_summary
        ) values (
          ${versionId}, ${tenantId}, ${configuration.id}, ${version}, ${configuration.name},
          ${configuration.description}, ${configuration.welcomeMessage}, ${transaction.json(configuration.examplePrompts)},
          ${configuration.systemPrompt}, ${transaction.json(configuration.roleIds)},
          ${transaction.json(configuration.dataScopes)}, ${configuration.maxOutputBytes},
          ${configuration.maxToolCalls}, ${configuration.timeoutSeconds}, ${transaction.json(configuration.skills)},
          ${transaction.json(configuration.tools)}, ${transaction.json(asJson(spec))}, 'draft', ${actor.id}, ${configuration.changeSummary}
        )
      `
      await transaction`
        update agents set draft_version_id = ${versionId}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${configuration.id}
      `
    })
    await this.audit(actor.id, 'agent.create', configuration.id, 'success', `创建 Agent ${version}`)
    return this.requireAgentResult(configuration.id, versionId)
  }

  async getMutationSnapshot(agentId: string): Promise<AgentMutationSnapshot> {
    const [row] = await this.readAgentRows(agentId)
    if (!row) throw new Error(`Agent 不存在：${agentId}`)
    return { agent: toAgentDefinition(row), revision: agentMutationRevision(row) }
  }

  async updateAgent(input: UpdateAgentDraftInput, expectedRevision?: string, options: { draftCopyOnly?: boolean } = {}) {
    const actor = await this.requireActor(input.actor)
    const [current] = await this.readAgentRows(input.agentId)
    if (!current) throw new Error(`Agent 不存在：${input.agentId}`)
    const configuration = normalizeConfiguration(
      { ...input, id: input.agentId },
      current.owner,
      current.department,
    )
    assertConfiguration(configuration)
    await this.assertCapabilityReferences(configuration.skills, configuration.tools, configuration.roleIds, configuration.dataScopes)

    let draftVersionId = current.draftVersionId
    await this.database.begin(async transaction => {
      const locked = await this.lockAgentForMutation(transaction, input.agentId)
      if (!locked) throw new Error(`Agent 不存在：${input.agentId}`)
      assertAgentMutationRevision(locked, expectedRevision)
      await this.requireActor(input.actor, transaction)
      if (options.draftCopyOnly) {
        if (!locked.draftVersionId) throw authorizationDenied('一次确认仅允许修改现有草稿')
        assertDraftCopyPlan(toAgentDefinition(locked), { ...configuration, agentId: input.agentId })
      }
      draftVersionId = locked.draftVersionId
      if (draftVersionId) {
        await transaction`
          update agent_versions
             set name = ${configuration.name}, description = ${configuration.description},
                 welcome_message = ${configuration.welcomeMessage},
                 example_prompts = ${transaction.json(configuration.examplePrompts)},
                 system_prompt = ${configuration.systemPrompt},
                 visible_role_ids = ${transaction.json(configuration.roleIds)},
                 data_scopes = ${transaction.json(configuration.dataScopes)},
                 max_output_bytes = ${configuration.maxOutputBytes}, max_tool_calls = ${configuration.maxToolCalls},
                 timeout_seconds = ${configuration.timeoutSeconds},
                 skill_refs = ${transaction.json(configuration.skills)}, tool_refs = ${transaction.json(configuration.tools)},
                 agent_spec = ${transaction.json(asJson(agentSpecFromConfiguration(configuration, locked.version, locked.agentSpec)))},
                 change_summary = ${configuration.changeSummary}
           where tenant_id = ${tenantId} and id = ${draftVersionId} and status = 'draft'
        `
      } else {
        if (!locked.activeVersionId) throw new Error('Agent 没有可用于创建新版本的已发布版本')
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
            example_prompts, system_prompt, visible_role_ids, data_scopes, max_output_bytes,
            max_tool_calls, timeout_seconds, skill_refs, tool_refs, agent_spec, status, created_by, source_version, change_summary
          ) values (
            ${draftVersionId}, ${tenantId}, ${input.agentId}, ${newVersion},
            ${configuration.name}, ${configuration.description}, ${configuration.welcomeMessage},
            ${transaction.json(configuration.examplePrompts)}, ${configuration.systemPrompt},
            ${transaction.json(configuration.roleIds)}, ${transaction.json(configuration.dataScopes)},
            ${configuration.maxOutputBytes}, ${configuration.maxToolCalls}, ${configuration.timeoutSeconds},
            ${transaction.json(configuration.skills)}, ${transaction.json(configuration.tools)},
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
    if (!current) throw new Error(`Agent 不存在：${input.agentId}`)

    if (input.status === 'disabled') {
      const release = await this.database.begin(async transaction => {
        const locked = await this.lockAgentForMutation(transaction, input.agentId)
        if (!locked) throw new Error(`Agent 不存在：${input.agentId}`)
        assertAgentMutationRevision(locked, expectedRevision)
        // 停用是管理状态切换，与待发布草稿独立：草稿保留并可在治理流程中继续推进，
        // 发布只切换活动版本，不隐式重新启用（见 publishDraftWithinTransaction）。
        if (!locked.activeVersionId) throw new Error('尚未发布的 Agent 不能停用')
        const activeVersionId = locked.activeVersionId
        const updated = await transaction`
          update agents set status = 'disabled', updated_at = now()
           where tenant_id = ${tenantId} and id = ${input.agentId}
             and status = 'published' and active_version_id = ${activeVersionId}
           returning id
        `
        if (!updated.length) throw new Error('仅已发布状态的 Agent 可以停用，或状态已变化请刷新后重试')
        return this.appendRelease(transaction, activeVersionId, input.agentId, 'disabled', actor.id, '停用当前 Agent，不影响已创建的运行。')
      })
      await this.audit(actor.id, 'agent.disable', input.agentId, 'success', release.note)
      return { agent: await this.requireAgent(input.agentId), release }
    }

    // 重新启用只翻转管理状态：与进行中草稿独立（停用期间草稿可继续编辑）。
    // 非停用状态的 published 写入属于"发布草稿"，必须走发布工作台封存试运行链路。
    const reenabling = current.persistedStatus === 'disabled' && Boolean(current.activeVersionId)
    if (!reenabling) {
      if (current.draftVersionId) {
        throw new Error('草稿发布必须通过发布工作台完成封存试运行后发起，不能走状态直改')
      }
      throw new Error('当前 Agent 没有可发布草稿，也不处于停用状态')
    }
    const release = await this.database.begin(async transaction => {
      const locked = await this.lockAgentForMutation(transaction, input.agentId)
      if (!locked) throw new Error(`Agent 不存在：${input.agentId}`)
      assertAgentMutationRevision(locked, expectedRevision)
      if (!locked.activeVersionId || locked.persistedStatus !== 'disabled') {
        throw new Error('当前 Agent 没有可发布草稿，也不处于停用状态')
      }
      const activeVersionId = locked.activeVersionId
      const updated = await transaction`
        update agents set status = 'published', updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.agentId}
           and status = 'disabled' and active_version_id = ${activeVersionId}
         returning id
      `
      if (!updated.length) throw new Error('Agent 状态已发生变化，请刷新后重试')
      return this.appendRelease(transaction, activeVersionId, input.agentId, 'enabled', actor.id, '重新启用当前 Agent 版本。')
    })
    await this.audit(actor.id, 'agent.enable', input.agentId, 'success', release.note)
    return { agent: await this.requireAgent(input.agentId), release }
  }

  async rollback(input: { agentId: string; version: string; actor: string }) {
    const actor = await this.requireActor(input.actor)
    const [current] = await this.readAgentRows(input.agentId)
    if (!current) throw new Error(`Agent 不存在：${input.agentId}`)
    const [target] = await this.database<VersionRow[]>`
      select av.id, av.agent_id as "agentId", av.version, av.name, av.description, av.status, av.created_at as "createdAt",
             creator.display_name as "createdBy", av.published_at as "publishedAt",
             publisher.display_name as "publishedBy", av.source_version as "sourceVersion",
             av.change_summary as summary, av.visible_role_ids as "roleIds", av.data_scopes as "dataScopes",
             av.welcome_message as "welcomeMessage", av.example_prompts as "examplePrompts",
             av.system_prompt as "systemPrompt", av.max_output_bytes as "maxOutputBytes",
             av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds", av.skill_refs as skills, av.tool_refs as tools,
             av.binding_refs as "bindingRefs"
        from agent_versions av
        join users creator on creator.tenant_id = av.tenant_id and creator.id = av.created_by
        left join users publisher on publisher.tenant_id = av.tenant_id and publisher.id = av.published_by
       where av.tenant_id = ${tenantId} and av.agent_id = ${input.agentId}
         and av.version = ${input.version} and av.status = 'published'
    `
    if (!target) throw new Error(`已发布 Agent Version 不存在：${input.agentId}@${input.version}`)
    await this.assertCapabilityReferences(target.skills, target.tools, target.roleIds, target.dataScopes)

    const note = `活动版本由 v${current.version} 回滚到 v${target.version}。`
    const release = await this.database.begin(async transaction => {
      if (current.draftVersionId) {
        await transaction`update agent_versions set status = 'disabled' where tenant_id = ${tenantId} and id = ${current.draftVersionId} and status = 'draft'`
      }
      await transaction`
        update agents set active_version_id = ${target.id}, draft_version_id = null,
                          status = 'published', name = ${target.name},
                          description = ${target.description},
                          welcome_message = ${target.welcomeMessage}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.agentId}
      `
      return this.appendRelease(transaction, target.id, input.agentId, 'rollback', actor.id, note)
    })
    await this.audit(actor.id, 'agent.rollback', input.agentId, 'success', release.note)
    return { agent: await this.requireAgent(input.agentId), release }
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
      throw new Error('allowWorkspaceJoin 必须为布尔值')
    }
    const [current] = await this.readAgentRows(input.agentId)
    if (!current) throw new Error(`Agent 不存在：${input.agentId}`)
    await this.database.begin(async transaction => {
      const [locked] = await transaction<{ id: string }[]>`
        select id from agents
         where tenant_id = ${tenantId} and id = ${input.agentId}
         for update
      `
      if (!locked) throw new Error(`Agent 不存在：${input.agentId}`)
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
    if (!agent) throw new Error(`Agent 不存在：${agentId}`)
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
        join users u on u.tenant_id = a.tenant_id and u.id = ${userId} and u.status = 'active'
       where a.tenant_id = ${tenantId} and a.status = 'published'
         and av.status = 'published'
         and exists (
           select 1 from roles r
            where r.tenant_id = a.tenant_id and r.id in ${this.database(roleIds)}
              and av.visible_role_ids ? r.id
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
    if (!candidates.length) throw new Error(agentId ? 'Agent 不存在或当前用户不可用' : '当前用户没有可用 Agent')
    for (const candidate of candidates) {
      const [row] = await this.database<{
        activeVersionId: string
        skills: string[]
        tools: string[]
        roleIds: string[]
        dataScopes: string[]
      }[]>`
        select a.active_version_id as "activeVersionId", av.skill_refs as skills,
               av.tool_refs as tools, av.visible_role_ids as "roleIds", av.data_scopes as "dataScopes"
          from agents a
          join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
         where a.tenant_id = ${tenantId} and a.id = ${candidate.id}
      `
      if (!row?.activeVersionId) continue
      if (!additionalSkillReferences.length) return row.activeVersionId
      try {
        await this.assertCapabilityReferences(
          mergeSkillReferences(row.skills, additionalSkillReferences),
          row.tools,
          row.roleIds,
          row.dataScopes,
        )
        return row.activeVersionId
      } catch (error) {
        if (agentId) throw error
      }
    }
    throw new Error('所选 Skill 必须由已配置所需工具的 Agent 运行；当前没有兼容 Agent，请联系管理员配置')
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
        join users u on u.tenant_id = a.tenant_id and u.id = ${requesterUserId} and u.status = 'active'
       where a.tenant_id = ${tenantId}
         and a.status = 'published'
         and a.allow_workspace_join = true
         and av.status = 'published'
         and exists (
           select 1 from roles r
            where r.tenant_id = a.tenant_id and r.id in ${this.database(roleIds)}
              and av.visible_role_ids ? r.id
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

  async getRuntimeSnapshot(versionId: string, additionalSkillReferences: string[] = []): Promise<RuntimeAgentSnapshot> {
    const [row] = await this.database<Omit<RuntimeAgentSnapshot, 'skillInstructions' | 'runtimeTools' | 'approvalMode' | 'mcpConnections'>[]>`
      select id as "versionId", system_prompt as "systemPrompt", skill_refs as skills,
             tool_refs as tools, visible_role_ids as "roleIds", data_scopes as "dataScopes",
             max_output_bytes as "maxOutputBytes", max_tool_calls as "maxToolCalls",
             timeout_seconds as "timeoutSeconds",
             coalesce(agent_spec #> '{model,requirements}', '[]'::jsonb) as "modelRequirements"
        from agent_versions where tenant_id = ${tenantId} and id = ${versionId}
    `
    if (!row) throw new Error(`Agent Version 不存在：${versionId}`)
    const skills = mergeSkillReferences(row.skills, additionalSkillReferences)
    await this.assertCapabilityReferences(skills, row.tools, row.roleIds, row.dataScopes)
    const skillInstructions = this.skillService
      ? await this.skillService.resolveRuntimeSkills(skills)
      : []
    const tools = unique([...row.tools, ...skillInstructions.flatMap(skill => skill.tools).filter(reference => DSH_WORK_EXECUTION_TOOL_REFS.has(reference))])
    const runtimeToolNames = this.toolService
      ? await this.toolService.resolveRuntimeToolNames(tools)
      : tools.map(reference => parseReference(reference).id)
    const runtimeTools = tools.map((reference, index) => {
      const { version } = parseReference(reference)
      return `${runtimeToolNames[index]}@${version}`
    })
    const approvalMode = this.toolService
      ? await this.toolService.resolveRuntimeApprovalMode(tools)
      : 'risk_based'
    // B-03/I-04：按当前真实配置解析每个平台工具的 active 绑定修订（首次解析
    // 或语义漂移时物化新修订）；内置运行时工具不在绑定表内。
    const toolBindings = this.toolService
      ? await this.toolService.resolveToolBindings(tools)
      : []
    const mcpConnections = this.toolService
      ? await this.toolService.resolveMcpConnectionsForAgentVersion(versionId)
      : []
    const runtimeSkills = this.skillService
      ? skillInstructions.map(skill => `${skill.id}@${skill.version}`)
      : skills
    return { ...row, skills: runtimeSkills, tools, skillInstructions, runtimeTools, toolBindings, mcpConnections, approvalMode }
  }

  /**
   * 草稿发布的事务内实现：发布治理借此把版本发布、提交状态与证据写入放进同一事务。
   * 锁行、修订断言、能力校验与测试/试运行证据门禁均在事务内完成。
   */
  async publishDraftWithinTransaction(
    transaction: DatabaseTransaction,
    agentId: string,
    actor: { id: string },
    expectedRevision?: string,
    /** B-03/I-04：封存的平台绑定依据随版本发布一并固化；与 status 翻转同一条 UPDATE，不触碰已发布版本的不变约束。 */
    bindingRefs?: ManifestToolBinding[],
  ): Promise<AgentReleaseRecord> {
    const locked = await this.lockAgentForMutation(transaction, agentId)
    if (!locked || !locked.draftVersionId || locked.versionId !== locked.draftVersionId) throw new Error('当前 Agent 草稿已发生变化，请重新测试后再发布')
    assertAgentMutationRevision(locked, expectedRevision)
    await this.assertCapabilityReferences(locked.skills, locked.tools, locked.roleIds, locked.dataScopes)

    const fingerprint = configurationFingerprint(locked)
    // 发布门禁只认封存试运行：agent_trial_runs 的案例经 Run/Attempt → Runtime Adapter
    // → DSH 真实执行且 bound_fingerprint/sealed_revision 与当前配置一致。交互式
    // agent_test_runs 是结构校验，不能作为发布证据（避免绕过发布治理流程）。
    const [trial] = await transaction<{ id: string }[]>`
      select t.id from agent_trial_runs t
        join agent_release_submissions s
          on s.tenant_id = t.tenant_id and s.id = t.submission_id
       where t.tenant_id = ${tenantId} and t.status = 'passed'
         and s.agent_version_id = ${locked.versionId}
         and s.bound_fingerprint = ${fingerprint}
         and s.sealed_revision is not null and s.sealed_revision = s.revision
         and t.submission_revision = s.sealed_revision
       limit 1
    `
    if (!trial) throw new Error('发布前必须在发布工作台完成与当前配置一致的封存试运行')

    const published = await transaction<{ id: string }[]>`
      update agent_versions set status = 'published', published_at = now(), published_by = ${actor.id},
             binding_refs = ${transaction.json(asJson(bindingRefs ?? []))}
       where tenant_id = ${tenantId} and id = ${locked.versionId} and status = 'draft'
       returning id
    `
    if (!published.length) throw new Error('Agent 草稿发布状态已发生变化，请刷新后重试')

    // 发布只切换活动版本与草稿指针，不隐式重新启用：停用中的 Agent 发布后仍保持
    // disabled，重新启用必须走独立的状态变更操作与确认流程。
    const activated = await transaction<{ id: string }[]>`
      update agents set active_version_id = ${locked.versionId}, draft_version_id = null,
                        status = case when status = 'disabled' then 'disabled' else 'published' end,
                        updated_at = now()
       where tenant_id = ${tenantId} and id = ${agentId} and draft_version_id = ${locked.versionId}
       returning id
    `
    if (!activated.length) throw new Error('Agent 草稿指针已发生变化，请刷新后重试')
    return this.appendRelease(transaction, locked.versionId, agentId, 'published', actor.id, '封存试运行通过，发布当前 Agent 版本。')
  }

  private async assertCapabilityReferences(
    skills: string[],
    tools: string[],
    roleIds?: string[],
    dataScopes?: string[],
  ) {
    await this.skillService?.assertPublishedReferences(skills)
    await this.toolService?.assertAvailableReferences(tools)
    if (roleIds && dataScopes) {
      await this.toolService?.assertAuthorizationCompatibility(tools, roleIds, dataScopes)
    }
    if (!this.skillService) return
    const runtimeSkills = await this.skillService.resolveRuntimeSkills(skills)
    const selectedTools = new Set(unique(tools))
    const missingTools = unique(runtimeSkills.flatMap(skill => skill.tools))
      .filter(reference => !['activate_skill@1.0.0', 'python_execute@1.0.0'].includes(reference) && !selectedTools.has(reference))
    if (missingTools.length) {
      throw new Error(`Agent 必须显式授权所选 Skill 依赖的工具：${missingTools.join('、')}`)
    }
  }

  private async appendRelease(
    transaction: DatabaseTransaction,
    versionId: string,
    agentId: string,
    action: AgentReleaseRecord['action'],
    actorId: string,
    note: string,
  ): Promise<AgentReleaseRecord> {
    const id = `agent-release-${randomUUID()}`
    const [row] = await transaction<{ version: string; actor: string; time: Date }[]>`
      with inserted as (
        insert into agent_release_records (
          id, tenant_id, agent_id, agent_version_id, action, actor_id, note
        ) values (${id}, ${tenantId}, ${agentId}, ${versionId}, ${action}, ${actorId}, ${note})
        returning agent_version_id, actor_id, created_at
      )
      select av.version, u.display_name as actor, inserted.created_at as time
        from inserted
        join agent_versions av on av.tenant_id = ${tenantId} and av.id = inserted.agent_version_id
        join users u on u.tenant_id = ${tenantId} and u.id = inserted.actor_id
    `
    if (!row) throw new Error('Agent 发布记录写入失败')
    return { id, agentId, version: row.version, action, actor: row.actor, time: formatDateTime(row.time), note }
  }

  private async requireActor(userId: string, sql: DatabaseClient | DatabaseTransaction = this.database) {
    const [actor] = await sql<{ id: string; displayName: string; department: string }[]>`
      select u.id, u.display_name as "displayName", coalesce(u.department_id, '未分配部门') as department
        from users u where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
         and exists (
           select 1 from user_roles ur
           join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
            where ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.source_key = 'local' and r.status = 'active'
              and (ur.valid_until is null or ur.valid_until > now())
              and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
         )
    `
    if (!actor) throw authorizationDenied(`操作人不存在、已停用或不是平台管理员：${userId}`)
    return actor
  }

  private async readAgentRows(agentId?: string): Promise<AgentRow[]> {
    return this.database<AgentRow[]>`
      select a.id, av.name, av.description, av.welcome_message as "welcomeMessage",
             owner.display_name as owner, coalesce(owner.department_id, '未分配部门') as department,
             a.status as "persistedStatus", a.active_version_id as "activeVersionId",
             a.draft_version_id as "draftVersionId", av.id as "versionId", av.version,
             av.system_prompt as "systemPrompt", av.visible_role_ids as "roleIds",
             av.data_scopes as "dataScopes", av.example_prompts as "examplePrompts",
             a.allow_workspace_join as "allowWorkspaceJoin",
             av.max_output_bytes as "maxOutputBytes", av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds",
             av.skill_refs as skills, av.tool_refs as tools, av.agent_spec as "agentSpec", a.updated_at as "updatedAt"
        from agents a
        join users owner on owner.tenant_id = a.tenant_id and owner.id = a.owner_user_id
        join agent_versions av on av.tenant_id = a.tenant_id
         and av.id = coalesce(a.draft_version_id, a.active_version_id)
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
             av.system_prompt as "systemPrompt", av.visible_role_ids as "roleIds",
             av.data_scopes as "dataScopes", av.example_prompts as "examplePrompts",
             a.allow_workspace_join as "allowWorkspaceJoin",
             av.max_output_bytes as "maxOutputBytes", av.max_tool_calls as "maxToolCalls",
             av.timeout_seconds as "timeoutSeconds",
             av.skill_refs as skills, av.tool_refs as tools, av.agent_spec as "agentSpec", a.updated_at as "updatedAt"
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
    if (!row) throw new Error(`Agent 不存在：${agentId}`)
    return toAgentDefinition(row)
  }

  private async requireAgentResult(agentId: string, versionId: string) {
    const agent = await this.requireAgent(agentId)
    const versions = await this.getAgentVersions()
    const version = versions.find(item => item.id === versionId)
    if (!version) throw new Error(`Agent Version 不存在：${versionId}`)
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
): AgentDraftConfiguration {
  const welcomeMessage = input.welcomeMessage.trim()
    || `你好，我是${input.name.trim() || '企业 Agent'}。${input.description.trim() || '我会协助你完成工作。'}`.slice(0, 120)
  return {
    ...input,
    name: input.name.trim(),
    description: input.description.trim(),
    owner,
    department,
    visibility: input.visibility.trim() || '指定角色',
    roleIds: unique(input.roleIds),
    dataScopes: unique(input.dataScopes),
    welcomeMessage,
    examplePrompts: unique(input.examplePrompts),
    systemPrompt: input.systemPrompt.trim(),
    skills: unique(input.skills),
    tools: unique(input.tools),
    changeSummary: input.changeSummary.trim() || '更新 Agent 配置',
  }
}

function assertConfiguration(input: AgentDraftConfiguration) {
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(input.id)) throw new Error('Agent 标识格式不正确')
  // 定义字段与包入口共用同一规范化校验（AgentSpec 内容边界）。
  assertAgentSpecContent(agentSpecFromConfiguration(input, ''))
  if (!input.roleIds.length || !input.dataScopes.length) throw new Error('必须配置可见角色和数据范围')
  if (!input.examplePrompts.length) throw new Error('必须配置至少一个示例问题')
  if (!input.skills.length || !input.tools.length) throw new Error('必须配置至少一个 Skill 和工具')
}

function toAgentDefinition(row: AgentRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner: row.owner,
    department: row.department,
    visibility: row.roleIds.includes('role-employee') ? '全体试点员工' : `指定 ${row.roleIds.length} 个角色`,
    roleIds: row.roleIds,
    dataScopes: row.dataScopes,
    allowWorkspaceJoin: row.allowWorkspaceJoin,
    // 管理状态优先于草稿外观：停用中的 Agent 即使有待发布草稿也显示「已停用」，
    // 否则停用被草稿掩盖且无法从列表重新启用。
    status: row.persistedStatus === 'disabled' ? 'disabled' : row.draftVersionId ? 'draft' : row.persistedStatus,
    version: row.version,
    welcomeMessage: row.welcomeMessage,
    examplePrompts: row.examplePrompts,
    systemPrompt: row.systemPrompt,
    maxOutputBytes: row.maxOutputBytes,
    maxToolCalls: row.maxToolCalls,
    timeoutSeconds: row.timeoutSeconds,
    skills: row.skills,
    tools: row.tools,
    updatedAt: formatDateTime(row.updatedAt),
  }
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
    visibility: row.roleIds.includes('role-employee') ? '全体试点员工' : `指定 ${row.roleIds.length} 个角色`,
    roleIds: row.roleIds,
    dataScopes: row.dataScopes,
    welcomeMessage: row.welcomeMessage,
    examplePrompts: row.examplePrompts,
    systemPrompt: row.systemPrompt,
    maxOutputBytes: row.maxOutputBytes,
    maxToolCalls: row.maxToolCalls,
    timeoutSeconds: row.timeoutSeconds,
    skills: row.skills,
    tools: row.tools,
    ...(row.bindingRefs?.length ? { bindingRefs: row.bindingRefs } : {}),
  }
}

export function configurationFingerprint(row: AgentFingerprintSource) {
  return createHash('sha256').update(JSON.stringify({
    versionId: row.versionId,
    name: row.name,
    description: row.description,
    welcomeMessage: row.welcomeMessage,
    systemPrompt: row.systemPrompt,
    roleIds: [...row.roleIds].sort(),
    dataScopes: [...row.dataScopes].sort(),
    examplePrompts: [...row.examplePrompts],
    skills: [...row.skills].sort(),
    tools: [...row.tools].sort(),
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
    throw new Error('Agent 配置已变化，请重新生成操作计划')
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
    throw new Error(`工具引用必须锁定版本：${reference}`)
  }
  return { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
}

function formatDateTime(value: Date) {
  return value.toISOString().slice(0, 16).replace('T', ' ')
}
