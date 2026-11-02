import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { findPlatformAdminActor } from '../authorization/platform-admin-actor.ts'
import type { PostgresAgentValidationService } from './agent-validation-service.ts'
import type { PostgresAgentService } from './postgres-agent-service.ts'

const tenantId = 'tenant-dsh-work'
/** 0002 引导的平台管理员；与 dsh-work 助手的预置负责人一致，不可用时取任一本地平台管理员。 */
const bootstrapAdminId = 'U00008'

export interface SkillCreatorPreset {
  id: string
  name: string
  description: string
  welcomeMessage: string
  examplePrompts: string[]
  testPrompts: string[]
  systemPrompt: string
}

/** 定义随代码发布（Skill 创建专家方案 5.1、5.2）：`preset.json` 与 `SOUL.md`。 */
export function loadSkillCreatorPreset(root: string): SkillCreatorPreset {
  const directory = join(root, 'skill-creator')
  const preset = JSON.parse(readFileSync(join(directory, 'preset.json'), 'utf8')) as Omit<SkillCreatorPreset, 'systemPrompt'>
  return { ...preset, systemPrompt: readFileSync(join(directory, 'SOUL.md'), 'utf8') }
}

export type SkillCreatorSeedResult =
  | { status: 'created'; agentId: string }
  | { status: 'resumed'; agentId: string }
  | { status: 'skipped'; reason: 'exists' | 'no_admin' }

/**
 * Skill 创建专家方案 5.1（SKC-05）：环境中还没有开启“可创建 Skill”的 Agent 时，预置一个未发布草稿。
 * 可见角色与岗位角色留空（不可验证、员工不可见），由管理员选定后验证并发布；不预置已发布版本。
 * Agent 不能删除，已有任一开启该开关的版本（含停用、未发布）即视为已有专家，重复启动不会再建。
 * 建草稿与写测试问题分两步：上次只建成草稿时，本次为仍未发布、没有测试问题的预置草稿补写。
 */
export async function seedSkillCreatorDraft(
  database: DatabaseClient,
  agents: Pick<PostgresAgentService, 'createAgent'>,
  validation: Pick<PostgresAgentValidationService, 'replaceTestCases'>,
  preset: SkillCreatorPreset,
): Promise<SkillCreatorSeedResult> {
  const [existing] = await database<{ id: string; unpublished: boolean; hasTestCases: boolean }[]>`
    select a.id,
           a.active_version_id is null and exists (
             select 1 from agent_versions d
              where d.tenant_id = a.tenant_id and d.id = a.draft_version_id and d.skill_creation_enabled
           ) as unpublished,
           exists (select 1 from agent_test_cases c where c.tenant_id = a.tenant_id and c.agent_id = a.id) as "hasTestCases"
      from agents a
     where a.tenant_id = ${tenantId}
       and (a.id = ${preset.id} or exists (
         select 1 from agent_versions v
          where v.tenant_id = a.tenant_id and v.agent_id = a.id and v.skill_creation_enabled
       ))
     order by (a.id = ${preset.id}) desc
     limit 1
  `
  const resume = existing?.id === preset.id && existing.unpublished && !existing.hasTestCases
  if (existing && !resume) return { status: 'skipped', reason: 'exists' }
  const admin = await findPlatformAdminActor(database, bootstrapAdminId)
  if (!admin) return { status: 'skipped', reason: 'no_admin' }
  if (!resume) {
    try {
      await agents.createAgent({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        owner: '',
        department: '',
        welcomeMessage: preset.welcomeMessage,
        examplePrompts: preset.examplePrompts,
        systemPrompt: preset.systemPrompt,
        maxOutputBytes: 65536,
        maxToolCalls: 20,
        timeoutSeconds: 300,
        skills: [],
        skillCreationEnabled: true,
        mcpScope: { mode: 'none', connectorIds: [] },
        changeSummary: '平台预置的 Skill 创建专家草稿',
        actor: admin.id,
      })
    } catch (error) {
      // 多实例同时启动：另一实例已建成（agents 主键冲突），本实例按已存在处理。
      if ((error as { code?: unknown } | null)?.code === '23505') return { status: 'skipped', reason: 'exists' }
      throw error
    }
  }
  await validation.replaceTestCases(preset.id, admin.id, preset.testPrompts)
  return { status: resume ? 'resumed' : 'created', agentId: preset.id }
}
