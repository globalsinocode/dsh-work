import assert from 'node:assert/strict'

import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { DatabaseClient } from './database.ts'

const tenantId = 'tenant-dsh-work'

/**
 * 测试夹具：把草稿直接发布为当前版本（不运行验证）。生命周期/引用类套件借此聚焦
 * 版本与引用机制；验证到发布的完整链路见 agent-release-governance 集成套件。
 * 与正式发布一样先复核能力引用与执行身份授权，版本不固定平台默认工具。
 */
export async function publishDraftWithSealedTrial(
  database: DatabaseClient,
  agents: PostgresAgentService,
  agentId: string,
  actorId: string,
) {
  const [draft] = await database<{ id: string; skills: string[]; tools: string[] }[]>`
    select id, skill_refs as skills, tool_refs as tools
      from agent_versions
     where tenant_id = ${tenantId} and agent_id = ${agentId} and status in ('draft', 'candidate')
     order by created_at desc limit 1
  `
  assert.ok(draft, `Agent ${agentId} 没有可发布的草稿版本`)
  const principal = await agents.getAgentExecutionPrincipal(agentId)
  assert.equal(principal.status, 'active', `Agent ${agentId} 执行身份已停用`)
  await database.begin(async tx => {
    const published = await tx`
      update agent_versions set status = 'published', published_at = now(), published_by = ${actorId}
       where tenant_id = ${tenantId} and id = ${draft.id} and status in ('draft', 'candidate')
      returning id
    `
    assert.equal(published.length, 1)
    await tx`
      update agents a
         set active_version_id = av.id, name = av.name, description = av.description,
             welcome_message = av.welcome_message,
             draft_version_id = case when a.draft_version_id = av.id then null else a.draft_version_id end,
             status = case when a.status = 'disabled' then 'disabled' else 'published' end,
             updated_at = now()
        from agent_versions av
       where a.tenant_id = ${tenantId} and a.id = ${agentId}
         and av.tenant_id = a.tenant_id and av.id = ${draft.id}
    `
  })
}
