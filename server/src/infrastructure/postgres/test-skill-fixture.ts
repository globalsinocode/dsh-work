import { randomUUID } from 'node:crypto'

import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import type { PostgresSkillService, RuntimeSkillConfiguration } from '../../modules/skill/postgres-skill-service.ts'
import type { SkillArtifactStore } from '../../modules/skill/skill-artifact-store.ts'
import { installationKey } from '../../modules/skill/skill-identity.ts'
import { createSkillPackage } from '../../modules/skill/skill-package.ts'
import type { DatabaseClient } from './database.ts'

const tenantId = 'tenant-dsh-work'

export interface SkillDraftFixtureInput {
  name: string
  category?: string
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
  actor: string
  /** 为已有 Skill 追加草稿版本时传入，须同时给出 version；该 Skill 不能已有草稿。 */
  skillId?: string
  version?: string
  /**
   * 写成已删除的文本创建/更新接口留下的旧草稿：版本 manifest 不带 installationId，也没有安装记录。
   * 这类草稿不能试运行或发布，只用于验证拒绝与旧数据兼容。
   */
  legacy?: boolean
}

/**
 * 测试夹具：直接写入一个 Skill 草稿版本，正文以文件夹制品保存。默认形态与 ZIP 安装一致（版本 manifest
 * 带 installationId，并登记一条已安装的 ZIP 安装记录），走严格试运行；`legacy` 时写成旧文本接口的形态。
 * 不经过安装计划与确认；发布、回滚、引用类套件借此准备数据，安装链路本身见 admin-skill-installation 集成套件。
 * 追加版本只在没有草稿时进行，与安装的规则相同。
 */
export async function insertSkillDraft(
  database: DatabaseClient,
  artifactStore: SkillArtifactStore,
  input: SkillDraftFixtureInput,
): Promise<{ skillId: string; versionId: string; version: string }> {
  if (input.skillId && !input.version) throw new Error('为已有 Skill 追加草稿时须给出 version')
  const skillId = input.skillId ?? `skill-${randomUUID().slice(0, 12)}`
  const version = input.version ?? '0.1.0'
  const versionId = `skill-version-${randomUUID()}`
  const installationId = input.legacy ? null : `skill-installation-${randomUUID()}`
  const category = input.category ?? '测试'
  const artifact = await artifactStore.put(createSkillPackage({
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    version,
    toolIds: input.toolIds,
  }))
  await database.begin(async transaction => {
    let sourceVersion: string | null = null
    if (input.skillId) {
      const [current] = await transaction<{ draftVersionId: string | null; activeVersion: string | null }[]>`
        select s.draft_version_id as "draftVersionId", active.version as "activeVersion"
          from skills s
          left join skill_versions active on active.tenant_id = s.tenant_id and active.id = s.active_version_id
         where s.tenant_id = ${tenantId} and s.id = ${skillId}
           for update of s
      `
      if (!current) throw new Error(`Skill 不存在：${skillId}`)
      if (current.draftVersionId) throw new Error('该 Skill 已有草稿，测试夹具不覆盖它（会留下孤立草稿）')
      sourceVersion = current.activeVersion
    } else {
      await transaction`
        insert into skills (id, tenant_id, key, installation_key, name, category, description, owner_user_id, created_by, status, draft_version_id)
        values (${skillId}, ${tenantId}, ${skillId}, ${installationKey(input.name)}, ${input.name}, ${category}, ${input.description},
                ${input.actor}, ${input.actor}, 'draft', null)
      `
    }
    const manifest = installationId ? { artifact, installationId } : { artifact }
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, artifact_ref, package_sha256, tool_refs, test_prompt, status, created_by, source_version, change_summary
      ) values (
        ${versionId}, ${tenantId}, ${skillId}, ${version}, ${input.name}, ${category}, ${input.description}, '',
        ${transaction.json(JSON.parse(JSON.stringify(manifest)))}, ${artifact.artifactRef}, ${artifact.sha256},
        ${transaction.json(input.toolIds)}, ${input.testPrompt}, 'draft', ${input.actor}, ${sourceVersion}, ${`测试夹具写入 ${version} 草稿`}
      )
    `
    if (installationId) {
      await transaction`
        insert into skill_installations (id, tenant_id, run_id, created_by, source, package, status, skill_id, version_id,
                                         channel, result_type, installed_version, compatibility_status)
        values (${installationId}, ${tenantId}, null, ${input.actor}, ${transaction.json({ kind: 'zip', fileName: 'test-skill-fixture.zip' })},
                ${transaction.json(JSON.parse(JSON.stringify(artifact)))}, 'installed', ${skillId}, ${versionId},
                'zip', ${input.skillId ? 'updated' : 'created'}, ${version}, 'compatible')
      `
    }
    await transaction`
      update skills set name = ${input.name}, category = ${category}, description = ${input.description},
                        draft_version_id = ${versionId}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${skillId}
    `
  })
  return { skillId, versionId, version }
}

/**
 * 测试夹具：为 Skill 服务接入合成的严格试运行证据（不调用模型、不启动 Runtime）。每次试运行写入一个已成功的
 * Run/Attempt、被测 Skill 及其依赖的激活记录与一条回复，由真实的 packageTestProgress 判定，发布仍经现有门禁
 * 核对精确 Attempt。经 DSH 的真实试运行见 admin-skill-installation 集成套件。
 */
export function useSyntheticSkillTrials(database: DatabaseClient, skills: PostgresSkillService) {
  const installation = new AdminSkillInstallationService(database, {} as never, new PostgresAuthorizationService(database))
  const progress = (userId: string, skill: RuntimeSkillConfiguration, runId: string) => installation.packageTestProgress(userId, skill, runId)
  const start = async (userId: string, skill: RuntimeSkillConfiguration, prompt: string) =>
    progress(userId, skill, await seedSyntheticTrial(database, userId, skill, prompt))
  skills.setPackageTestLifecycle({ start, progress })
  skills.setPackageTester(async (userId, skill, prompt) => {
    const result = await start(userId, skill, prompt)
    return { passed: result.passed === true, summary: result.summary ?? '', runId: result.runId, attemptId: result.attemptId, evidencePolicy: result.evidencePolicy }
  })
}

async function seedSyntheticTrial(database: DatabaseClient, userId: string, skill: RuntimeSkillConfiguration, prompt: string) {
  const sessionId = `admin-session-${randomUUID()}`, runId = `run-${randomUUID()}`, attemptId = `attempt-${randomUUID()}`
  const catalog = [skill, ...flatten(skill)]
  await database`insert into sessions (id, tenant_id, created_by, title, status, audience, workspace_id, agent_version_id)
    values (${sessionId}, ${tenantId}, ${userId}, '合成 Skill 试运行', 'active', 'admin', null, null)`
  await database`insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${randomUUID()}, 'queued')`
  const manifest = { purpose: 'admin-skill-test', run_id: runId, session_id: sessionId, attempt_id: attemptId,
    skills: catalog.map(item => ({ id: item.id, version: item.version })), input: { message: prompt, file_mounts: [] },
    agent_configuration: { system_prompt: '合成证据，不是模型运行', skill_instructions: catalog } }
  await database`insert into run_attempts (id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status)
    values (${attemptId}, ${tenantId}, ${runId}, 1, ${database.json(JSON.parse(JSON.stringify(manifest)))}, ${'a'.repeat(64)}, '{}'::jsonb, 'succeeded')`
  await database`update runs set current_attempt_id = ${attemptId}, status = 'succeeded' where tenant_id = ${tenantId} and id = ${runId}`
  for (const item of catalog) {
    await database`insert into skill_runtime_activations (id, tenant_id, run_id, attempt_id, skill_id, skill_version, content_sha256)
      values (${randomUUID()}, ${tenantId}, ${runId}, ${attemptId}, ${item.id}, ${item.version}, ${item.artifact?.sha256 ?? 'a'.repeat(64)})`
    for (const file of (item.files ?? []).filter(entry => entry.path.endsWith('.py'))) {
      await database`insert into skill_python_executions (id, tenant_id, run_id, attempt_id, skill_id, entry_path, succeeded)
        values (${randomUUID()}, ${tenantId}, ${runId}, ${attemptId}, ${item.id}, ${file.path}, true)`
    }
  }
  await new PostgresRunRepository(database).appendEvent({ id: randomUUID(), tenantId, runId, attemptId, sequence: 1,
    eventType: 'assistant.completed', displayMessage: '合成试运行回复。', safeMetadata: { synthetic: true },
    traceId: `trace-${runId}`, occurredAt: new Date().toISOString() })
  return runId
}

function flatten(skill: RuntimeSkillConfiguration): RuntimeSkillConfiguration[] {
  return (skill.dependencySkills ?? []).flatMap(item => [item, ...flatten(item)])
}
