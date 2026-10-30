import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { AgentRecommendationView } from '../../domain/types.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import { toolPreconditionFailed } from '../runtime/platform-tool-contract.ts'
import { isAuthorizationDenial } from '../../domain/authorization-errors.ts'
import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import type { PostgresAgentService, WorkbenchAgentDefinition } from './postgres-agent-service.ts'

const tenantId = 'tenant-dsh-work'
const MAX_COLLEAGUES = 50
const MAX_REASON_LENGTH = 120

export type { AgentRecommendationView }

/**
 * dsh-work 助手推荐 AI 同事（docs/design/agent-recommendation-plan.md）。
 *
 * 可见性与运行授权的执行前复核同一口径：发起员工在平台中的当前角色（authorizeWorkbench，
 * 无会话角色时读 user_roles），再按 Agent 已发布、执行身份启用、可见角色求交
 * （listWorkbenchAgents）。不使用 Manifest 中已与当前 Agent 授权求交的 role_ids。
 */
export class AgentRecommendationService {
  private readonly database: DatabaseClient
  private readonly agents: Pick<PostgresAgentService, 'listWorkbenchAgents'>
  private readonly authorization: Pick<PostgresAuthorizationService, 'authorizeWorkbench'>

  constructor(
    database: DatabaseClient,
    agents: Pick<PostgresAgentService, 'listWorkbenchAgents'>,
    authorization: Pick<PostgresAuthorizationService, 'authorizeWorkbench'>,
  ) {
    this.database = database
    this.agents = agents
    this.authorization = authorization
  }

  /** `list_colleague_agents`：发起员工当前可用、且不是本 Agent 的 AI 同事。 */
  async listColleagues(manifest: RuntimeManifest) {
    const colleagues = await this.colleaguesFor(manifest)
    return {
      agents: colleagues.slice(0, MAX_COLLEAGUES).map(agent => ({
        agentId: agent.id,
        name: agent.name,
        description: agent.description,
        examplePrompts: agent.examplePrompts.slice(0, 3),
      })),
    }
  }

  /** `recommend_agents`：校验后记录 1～3 位推荐；同一 Attempt 再次调用替换上一组。 */
  async recommend(manifest: RuntimeManifest, input: Record<string, unknown>) {
    const items = Array.isArray(input['recommendations']) ? input['recommendations'] as Array<Record<string, unknown>> : []
    if (items.length < 1 || items.length > 3) throw toolPreconditionFailed('每次推荐 1～3 位 AI 同事')
    const colleagues = new Map((await this.colleaguesFor(manifest)).map(agent => [agent.id, agent]))
    const seen = new Set<string>()
    const recommendations = items.map(item => {
      const agentId = typeof item['agentId'] === 'string' ? item['agentId'].trim() : ''
      const reason = typeof item['reason'] === 'string' ? item['reason'].trim() : ''
      const agent = colleagues.get(agentId)
      if (!agent) throw toolPreconditionFailed(`不能推荐这位 AI 同事：${agentId || '未提供'}。只能推荐 list_colleague_agents 返回的同事`)
      if (seen.has(agentId)) throw toolPreconditionFailed(`同一次推荐中重复出现：${agent.name}`)
      if (!reason || reason.length > MAX_REASON_LENGTH) throw toolPreconditionFailed(`推荐理由须为 1～${MAX_REASON_LENGTH} 个字`)
      seen.add(agentId)
      return { agent, reason }
    })
    const userId = manifest.user_context.user_id
    await this.database.begin(async transaction => {
      await transaction`delete from agent_recommendations where tenant_id = ${tenantId} and attempt_id = ${manifest.attempt_id}`
      for (const [index, { agent, reason }] of recommendations.entries()) {
        await transaction`
          insert into agent_recommendations (
            id, tenant_id, run_id, attempt_id, session_id, recommended_for_user_id,
            source_agent_version_id, agent_id, reason, position
          ) values (
            ${`agent-recommendation-${randomUUID()}`}, ${tenantId}, ${manifest.run_id}, ${manifest.attempt_id},
            ${manifest.session_id}, ${userId}, ${manifest.agent_version_id}, ${agent.id}, ${reason}, ${index + 1}
          )
        `
      }
    })
    return {
      recommended: recommendations.map(({ agent }) => ({ agentId: agent.id, name: agent.name })),
      note: '推荐已作为卡片显示在你的回复下方；员工点击后会与该同事开始新对话，对话不会转交。',
    }
  }

  /**
   * 会话详情的推荐卡片：只取各 Run 当前 Attempt 的记录（重试不重复出现旧卡片），
   * 按查看者当前可用的同事重新计算 available。
   */
  async loadForRuns(runIds: string[], viewerUserId: string): Promise<AgentRecommendationView[]> {
    if (!runIds.length) return []
    const rows = await this.database<Array<{ id: string; runId: string; agentId: string; reason: string; name: string | null; description: string | null }>>`
      select rec.id, rec.run_id as "runId", rec.agent_id as "agentId", rec.reason,
             av.name, av.description
        from agent_recommendations rec
        join runs r on r.tenant_id = rec.tenant_id and r.id = rec.run_id and r.current_attempt_id = rec.attempt_id
        join agents a on a.tenant_id = rec.tenant_id and a.id = rec.agent_id
        left join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
       where rec.tenant_id = ${tenantId} and rec.run_id = any(${runIds})
         and rec.recommended_for_user_id = ${viewerUserId}
       order by r.created_at, rec.position
    `
    if (!rows.length) return []
    const usable = await this.usableAgentIds(viewerUserId)
    return rows.map(row => ({
      id: row.id,
      runId: row.runId,
      agentId: row.agentId,
      name: row.name ?? 'AI 同事',
      description: row.description ?? '',
      reason: row.reason,
      available: usable.has(row.agentId),
    }))
  }

  private async colleaguesFor(manifest: RuntimeManifest): Promise<WorkbenchAgentDefinition[]> {
    if (manifest.purpose) throw toolPreconditionFailed('推荐 AI 同事只用于员工个人对话')
    const userId = manifest.user_context.user_id
    const context = await this.authorization.authorizeWorkbench({ userId })
    const [current] = manifest.agent_version_id
      ? await this.database<{ agentId: string }[]>`
          select agent_id as "agentId" from agent_versions
           where tenant_id = ${tenantId} and id = ${manifest.agent_version_id}
        `
      : []
    const agents = await this.agents.listWorkbenchAgents(userId, context.roleIds)
    return agents.filter(agent => agent.id !== current?.agentId)
  }

  private async usableAgentIds(userId: string): Promise<Set<string>> {
    try {
      const context = await this.authorization.authorizeWorkbench({ userId })
      return new Set((await this.agents.listWorkbenchAgents(userId, context.roleIds)).map(agent => agent.id))
    } catch (error) {
      // 查看者已失去工作台权限：卡片一律不可用；基础设施故障照常抛出，不伪装成不可用。
      if (isAuthorizationDenial(error)) return new Set()
      throw error
    }
  }
}
