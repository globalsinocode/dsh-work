import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { configurationFingerprint, type PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { DatabaseClient } from './database.ts'

const tenantId = 'tenant-dsh-work'

/**
 * 测试夹具：为草稿版本种"封存试运行通过"的治理证据，并调用与发布治理相同的
 * 事务内发布入口。生命周期/引用类套件借此聚焦版本与引用机制；真实 DSH 试运行
 * 到发布的端到端覆盖见 agent-release-governance 集成套件。
 */
export async function publishDraftWithSealedTrial(
  database: DatabaseClient,
  agents: PostgresAgentService,
  agentId: string,
  actorId: string,
) {
  const [draft] = await database<{
    id: string; name: string; description: string; welcomeMessage: string
    systemPrompt: string; roleIds: string[]; dataScopes: string[]; examplePrompts: string[]
    skills: string[]; tools: string[]; maxTokens: number; timeoutSeconds: number
  }[]>`
    select id, name, description, welcome_message as "welcomeMessage",
           system_prompt as "systemPrompt", visible_role_ids as "roleIds",
           data_scopes as "dataScopes", example_prompts as "examplePrompts",
           skill_refs as skills, tool_refs as tools,
           max_tokens as "maxTokens", timeout_seconds as "timeoutSeconds"
      from agent_versions
     where tenant_id = ${tenantId} and agent_id = ${agentId} and status = 'draft'
  `
  assert.ok(draft, `Agent ${agentId} 没有可发布的草稿版本`)
  await database.begin(async tx => {
    // 单活跃候选约束：收尾上一轮的进行中提交再种新证据
    await tx`
      update agent_release_submissions set status = 'published', updated_at = now()
       where tenant_id = ${tenantId} and agent_id = ${agentId}
         and status in ('draft', 'submitted', 'changes_requested')
    `
    const submissionId = `submission-${randomUUID()}`
    await tx`
      insert into agent_release_submissions (
        id, tenant_id, agent_id, agent_version_id, bound_fingerprint, revision,
        status, source, sealed_revision, sealed_at, created_by
      ) values (
        ${submissionId}, ${tenantId}, ${agentId}, ${draft.id},
        ${configurationFingerprint({ versionId: draft.id, ...draft })}, 1,
        'submitted', 'config', 1, now(), ${actorId}
      )
    `
    await tx`
      insert into agent_trial_runs (id, tenant_id, submission_id, agent_id, submission_revision, status, finished_at, created_by)
      values (${`trial-${randomUUID()}`}, ${tenantId}, ${submissionId}, ${agentId}, 1, 'passed', now(), ${actorId})
    `
    await agents.publishDraftWithinTransaction(tx, agentId, { id: actorId })
  })
}
