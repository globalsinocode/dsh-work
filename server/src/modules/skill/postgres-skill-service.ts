import { authorizationDenied } from '../authorization/authorization-errors.ts'
import { skillNotFound, skillConflict, skillInvalid, skillUnavailable, skillInternalFailure } from './skill-errors.ts'
import { ExecutionCapabilityUnavailableError } from '../runtime/execution-capabilities.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import { normalizeSkillTestScenario, type SkillTestScenario } from '../../domain/skill-test-scenario.ts'
import { assertStartedSkillTest, runtimeSkillFingerprint, SKILL_TEST_EVIDENCE_POLICY, SKILL_TEST_SCENARIO_POLICY, evaluateAttemptEvidence } from './skill-test-evidence.ts'
import { createSkillPackage, type SkillPackageArtifact } from './skill-package.ts'
import { createHash, randomUUID } from 'node:crypto'

import type {
  CreateSkillInput,
  PublishStatus,
  SkillConfiguration,
  SkillDefinition,
  SkillReleaseRecord,
  SkillVersionRecord,
  UpdateSkillInput,
} from '../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import type { PostgresToolConnectorService } from '../tool/postgres-tool-connector-service.ts'
import type { FileSystemSkillArtifactStore } from './file-system-skill-artifact-store.ts'

const tenantId = 'tenant-dsh-work'

interface SkillRow {
  id: string
  name: string
  category: string
  description: string
  instructions: string
  owner: string
  packageSha256?: string
  installationId: string | null
  isInstallationRoot: boolean
  installationRole: 'standalone' | 'root' | 'dependency'
  dependencies: SkillDefinition['dependencies']
  artifact: SkillPackageArtifact | null
  strictTest: boolean
  persistedStatus: PublishStatus
  activeVersionId: string | null
  draftVersionId: string | null
  versionId: string
  version: string
  activeVersion: string | null
  toolIds: string[]
  testPrompt: string
  updatedAt: Date
}

type SkillFingerprintSource = Pick<SkillRow,
  | 'versionId'
  | 'name'
  | 'category'
  | 'description'
  | 'instructions'
  | 'toolIds'
  | 'testPrompt'
  | 'artifact'
>

type LockedSkillDraft = SkillFingerprintSource & { id: string; artifact: SkillPackageArtifact | null }

interface VersionRow {
  id: string
  skillId: string
  version: string
  name: string
  category: string
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
  status: PublishStatus
  createdAt: Date
  createdBy: string
  publishedAt: Date | null
  publishedBy: string | null
  sourceVersion: string | null
  summary: string
  artifact: SkillPackageArtifact | null
}

interface SkillDependencyRow {
  parentVersionId: string
  versionId: string
  id: string
  name: string
  version: string
  status: PublishStatus
}

export interface SkillTestResult {
  id: string
  skillId: string
  version: string
  status: 'passed' | 'failed'
  resultSummary: string
  testedAt: string
}

export interface SkillTestRunProgress {
  runId: string
  skillId: string
  version: string
  status: 'queued' | 'running' | 'cancel_requested' | 'passed' | 'failed' | 'cancelled'
  resultSummary?: string
  testedAt?: string
  steps: Array<{
    id: string
    title: string
    description: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    occurredAt?: string
  }>
}

export interface RuntimeSkillConfiguration {
  testScenario?: SkillTestScenario
  id: string
  name?: string
  description?: string
  version: string
  instructions: string
  tools: string[]
  artifact?: SkillPackageArtifact
  files?: SkillPackageArtifact['files']
  dependencies?: string[]
  dependencySkills?: RuntimeSkillConfiguration[]
  disableModelInvocation?: boolean
}

export interface WorkbenchSkillDefinition {
  id: string
  name: string
  version: string
  category: string
  description: string
  owner: string
  testPrompt: string
  updatedAt: string
}

interface WorkbenchSkillRow extends Omit<WorkbenchSkillDefinition, 'updatedAt'> {
  updatedAt: Date
}

export class PostgresSkillService {
  private publicationAvailabilityChecker?: (references: string[], requiredPackages: string[]) => Promise<void>
  setPublicationAvailabilityChecker(checker: (references: string[], requiredPackages: string[]) => Promise<void>) { this.publicationAvailabilityChecker = checker }
  private packageTester?: (userId: string, skill: RuntimeSkillConfiguration, prompt: string) => Promise<{ passed: boolean; summary: string; runId: string; attemptId?: string; evidencePolicy?: string }>
  private packageTestLifecycle?: {
    start: (userId: string, skill: RuntimeSkillConfiguration, prompt: string) => Promise<{ runId: string; status: string; steps: SkillTestRunProgress['steps'] }>
    progress: (userId: string, skill: RuntimeSkillConfiguration, runId: string) => Promise<{ runId: string; attemptId?: string; status: string; passed?: boolean; summary?: string; evidencePolicy?: string; steps: SkillTestRunProgress['steps'] }>
  }
  setPackageTester(tester: NonNullable<PostgresSkillService['packageTester']>) { this.packageTester = tester }
  setPackageTestLifecycle(lifecycle: NonNullable<PostgresSkillService['packageTestLifecycle']>) { this.packageTestLifecycle = lifecycle }
  private readonly database: DatabaseClient
  private readonly operations?: PostgresOperationsService
  private readonly toolService?: PostgresToolConnectorService
  private readonly artifactStore?: FileSystemSkillArtifactStore

  constructor(
    database: DatabaseClient,
    operations?: PostgresOperationsService,
    toolService?: PostgresToolConnectorService,
    artifactStore?: FileSystemSkillArtifactStore,
  ) {
    this.database = database
    this.operations = operations
    this.toolService = toolService
    this.artifactStore = artifactStore
  }

  async getSkills(): Promise<SkillDefinition[]> {
    return (await this.readSkillRows()).map(toSkillDefinition)
  }

  async listWorkbenchSkills(): Promise<WorkbenchSkillDefinition[]> {
    const rows = await this.database<WorkbenchSkillRow[]>`
      select s.id, sv.name, sv.version, sv.category, sv.description,
             owner.display_name as owner, sv.test_prompt as "testPrompt",
             s.updated_at as "updatedAt"
        from skills s
        join skill_versions sv on sv.tenant_id = s.tenant_id and sv.id = s.active_version_id
        join users owner on owner.tenant_id = s.tenant_id and owner.id = s.owner_user_id
       where s.tenant_id = ${tenantId} and s.status = 'published' and sv.status = 'published'
         and (
           not (sv.manifest ? 'installationId')
           or exists (
             select 1 from skill_installations installation
              where installation.tenant_id = s.tenant_id and installation.skill_id = s.id
                and installation.status = 'installed'
           )
         )
       order by s.updated_at desc, sv.name asc
    `
    return rows.map(row => ({ ...row, updatedAt: formatDateTime(row.updatedAt) }))
  }

  async resolveWorkbenchSkillVersion(skillId: string) {
    assertSkillId(skillId)
    const [row] = await this.database<{ id: string; skillId: string; version: string }[]>`
      select sv.id, sv.skill_id as "skillId", sv.version
        from skills s
        join skill_versions sv on sv.tenant_id = s.tenant_id and sv.id = s.active_version_id
       where s.tenant_id = ${tenantId} and s.id = ${skillId}
         and s.status = 'published' and sv.status = 'published'
         and (
           not (sv.manifest ? 'installationId')
           or exists (
             select 1 from skill_installations installation
              where installation.tenant_id = s.tenant_id and installation.skill_id = s.id
                and installation.status = 'installed'
           )
         )
    `
    if (!row) throw skillNotFound('Skill 不存在、未发布或已停用')
    return { id: row.id, reference: `${row.skillId}@${row.version}` }
  }

  async getSkillVersions(): Promise<SkillVersionRecord[]> {
    const rows = await this.database<VersionRow[]>`
      select sv.id, sv.skill_id as "skillId", sv.version, sv.name, sv.category,
             sv.description, sv.instructions, sv.tool_refs as "toolIds",
             sv.test_prompt as "testPrompt", sv.status, sv.created_at as "createdAt",
             creator.display_name as "createdBy", sv.published_at as "publishedAt",
             publisher.display_name as "publishedBy", sv.source_version as "sourceVersion",
             sv.change_summary as summary, sv.manifest->'artifact' as artifact
        from skill_versions sv
        join users creator on creator.tenant_id = sv.tenant_id and creator.id = sv.created_by
        left join users publisher on publisher.tenant_id = sv.tenant_id and publisher.id = sv.published_by
       where sv.tenant_id = ${tenantId}
       order by sv.created_at desc
    `
    for (const row of rows) if (row.artifact) row.instructions = (await this.requireArtifactStore().read(row.artifact)).instructions
    return rows.map(toVersionRecord)
  }

  async getReleaseRecords(): Promise<SkillReleaseRecord[]> {
    const rows = await this.database<{
      id: string
      skillId: string
      version: string
      action: SkillReleaseRecord['action']
      actor: string
      time: Date
      note: string
    }[]>`
      select srr.id, srr.skill_id as "skillId", sv.version, srr.action,
             u.display_name as actor, srr.created_at as time, srr.note
        from skill_release_records srr
        join skill_versions sv on sv.tenant_id = srr.tenant_id and sv.id = srr.skill_version_id
        join users u on u.tenant_id = srr.tenant_id and u.id = srr.actor_id
       where srr.tenant_id = ${tenantId}
       order by srr.created_at desc
    `
    return rows.map(row => ({ ...row, time: formatDateTime(row.time) }))
  }

  async createSkill(input: CreateSkillInput) {
    const actor = await this.requireActor(input.actor)
    const configuration = normalizeConfiguration({
      id: `skill-${randomUUID().slice(0, 12)}`,
      name: input.name,
      category: input.category,
      description: input.description,
      instructions: input.instructions,
      toolIds: input.toolIds,
      testPrompt: input.testPrompt,
    })
    assertConfiguration(configuration)
    await this.toolService?.assertAvailableReferences(configuration.toolIds)
    const versionId = `skill-version-${randomUUID()}`
    const artifact = await this.requireArtifactStore().put(createSkillPackage({
      name: configuration.name,
      description: configuration.description,
      instructions: configuration.instructions,
      version: '0.1.0',
      toolIds: configuration.toolIds,
    }))

    await this.database.begin(async transaction => {
      await transaction`
        insert into skills (
          id, tenant_id, key, name, category, description, owner_user_id, created_by,
          status, draft_version_id
        ) values (
          ${configuration.id}, ${tenantId}, ${configuration.id}, ${configuration.name},
          ${configuration.category}, ${configuration.description}, ${actor.id}, ${actor.id},
          'draft', null
        )
      `
      await transaction`
        insert into skill_versions (
          id, tenant_id, skill_id, version, name, category, description, instructions,
          manifest, artifact_ref, package_sha256, tool_refs, test_prompt, status, created_by, change_summary
        ) values (
          ${versionId}, ${tenantId}, ${configuration.id}, '0.1.0', ${configuration.name},
          ${configuration.category}, ${configuration.description}, '',
          ${transaction.json(JSON.parse(JSON.stringify({ artifact })))}, ${artifact.artifactRef}, ${artifact.sha256},
          ${transaction.json(configuration.toolIds)}, ${configuration.testPrompt},
          'draft', ${actor.id}, '创建 Skill 初始版本'
        )
      `
      await transaction`
        update skills set draft_version_id = ${versionId}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${configuration.id}
      `
    })
    await this.audit(actor.id, 'skill.create', configuration.id, 'success', '创建 Skill 0.1.0 草稿')
    return this.requireSkillResult(configuration.id, versionId)
  }

  async updateSkill(input: UpdateSkillInput) {
    const actor = await this.requireActor(input.actor)
    assertSkillId(input.skillId)
    const [current] = await this.readSkillRows(input.skillId)
    if (!current) throw skillNotFound(`Skill 不存在：${input.skillId}`)
    const [packaged] = await this.database`select id from skill_versions where tenant_id = ${tenantId} and skill_id = ${input.skillId} and manifest ? 'installationId' limit 1`
    if (packaged) throw skillConflict('安装包版本不可通过文本编辑，请通过新包安装更新', 'skill_package_immutable')
    const configuration = normalizeConfiguration({ id: input.skillId, ...input })
    assertConfiguration(configuration)
    await this.toolService?.assertAvailableReferences(configuration.toolIds)
    let draftVersionId = current.draftVersionId

    await this.database.begin(async transaction => {
      const [locked] = await transaction<{
        activeVersionId: string | null
        draftVersionId: string | null
        activeVersion: string | null
        draftVersion: string | null
      }[]>`
        select s.active_version_id as "activeVersionId", s.draft_version_id as "draftVersionId",
               active.version as "activeVersion", draft.version as "draftVersion"
          from skills s
          left join skill_versions active on active.tenant_id = s.tenant_id and active.id = s.active_version_id
          left join skill_versions draft on draft.tenant_id = s.tenant_id and draft.id = s.draft_version_id
         where s.tenant_id = ${tenantId} and s.id = ${input.skillId}
         for update of s
      `
      if (!locked) throw skillNotFound(`Skill 不存在：${input.skillId}`)
      draftVersionId = locked.draftVersionId
      if (draftVersionId) {
        if (!locked.draftVersion) throw skillInternalFailure('Skill 草稿版本不存在')
        const artifact = await this.requireArtifactStore().put(createSkillPackage({
          name: configuration.name,
          description: configuration.description,
          instructions: configuration.instructions,
          version: locked.draftVersion,
          toolIds: configuration.toolIds,
        }))
        await transaction`
          update skill_versions
             set name = ${configuration.name}, category = ${configuration.category},
                 description = ${configuration.description}, instructions = '',
                 manifest = ${transaction.json(JSON.parse(JSON.stringify({ artifact })))}, artifact_ref = ${artifact.artifactRef},
                 package_sha256 = ${artifact.sha256},
                 tool_refs = ${transaction.json(configuration.toolIds)}, test_prompt = ${configuration.testPrompt},
                 change_summary = ${`更新 ${configuration.name} 配置`}
           where tenant_id = ${tenantId} and id = ${draftVersionId} and status = 'draft'
        `
      } else {
        if (!locked.activeVersionId || !locked.activeVersion) throw skillConflict('Skill 没有可用于创建新版本的已发布版本')
        const [latest] = await transaction<{ version: string }[]>`
          select version from skill_versions
           where tenant_id = ${tenantId} and skill_id = ${input.skillId}
           order by split_part(version, '.', 1)::integer desc,
                    split_part(version, '.', 2)::integer desc,
                    split_part(version, '.', 3)::integer desc
           limit 1
        `
        draftVersionId = `skill-version-${randomUUID()}`
        const version = nextVersion(latest?.version ?? locked.activeVersion)
        const artifact = await this.requireArtifactStore().put(createSkillPackage({
          name: configuration.name,
          description: configuration.description,
          instructions: configuration.instructions,
          version,
          toolIds: configuration.toolIds,
        }))
        await transaction`
          insert into skill_versions (
            id, tenant_id, skill_id, version, name, category, description, instructions,
            manifest, artifact_ref, package_sha256, tool_refs, test_prompt, status, created_by, source_version, change_summary
          ) values (
            ${draftVersionId}, ${tenantId}, ${input.skillId}, ${version},
            ${configuration.name}, ${configuration.category}, ${configuration.description},
            '', ${transaction.json(JSON.parse(JSON.stringify({ artifact })))}, ${artifact.artifactRef}, ${artifact.sha256},
            ${transaction.json(configuration.toolIds)},
            ${configuration.testPrompt}, 'draft', ${actor.id}, ${locked.activeVersion},
            ${`创建 ${configuration.name} 新版本`}
          )
        `
      }
      await transaction`
        update skills set name = ${configuration.name}, category = ${configuration.category},
                          description = ${configuration.description}, draft_version_id = ${draftVersionId},
                          updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.skillId}
      `
    })
    await this.audit(actor.id, 'skill.draft.update', input.skillId, 'success', '保存 Skill 待发布版本')
    if (!draftVersionId) throw skillInternalFailure('Skill 草稿版本创建失败')
    return this.requireSkillResult(input.skillId, draftVersionId)
  }

  async testSkill(input: { skillId: string; prompt?: string; actor: string; scenario?: unknown }): Promise<SkillTestResult> {
    const actor = await this.requireActor(input.actor)
    assertSkillId(input.skillId)
    const [skill] = await this.readSkillRows(input.skillId)
    if (!skill) throw skillNotFound(`Skill 不存在：${input.skillId}`)
    if (!skill.draftVersionId) throw skillConflict('当前 Skill 没有待测试的草稿版本', 'skill_draft_required')
    if (input.scenario !== undefined && !skill.strictTest) throw skillInvalid('场景测试要求真实 DSH 试运行包', 'invalid_test_scenario')
    await this.toolService?.assertAvailableReferences(skill.toolIds)
    const prompt = normalizeTestPrompt(input.prompt, skill.testPrompt)
    const fingerprint = configurationFingerprint(skill)
    let testId = `skill-test-${randomUUID()}`
    let runtimeRunId: string | null = null
    let runtimeAttemptId: string | null = null
    let evidencePolicy = SKILL_TEST_EVIDENCE_POLICY
    let summary = `配置校验通过：执行指令 ${skill.instructions.length} 字符，${skill.toolIds.length} 个工具引用。`
    let status: 'passed' | 'failed' = 'passed'
    if (skill.strictTest) {
      if (!this.packageTester) throw skillUnavailable('DSH Skill 试运行不可用')
      const [version] = await this.database<{ manifest: { artifact?: SkillPackageArtifact; dependencies?: string[] } }[]>`select manifest from skill_versions where tenant_id = ${tenantId} and id = ${skill.draftVersionId}`
      if (!version?.manifest.artifact) throw skillInternalFailure('Skill 文件夹索引缺失')
      const packageContent = await this.requireArtifactStore().read(version.manifest.artifact)
      const dependencySkills = await this.resolveTestRuntimeSkills(version!.manifest.dependencies ?? [])
      await this.toolService?.assertAvailableReferences([...skill.toolIds, ...dependencySkills.flatMap(item => [item, ...flattenRuntimeDependencies(item)]).flatMap(item => item.tools)])
      const runtimeSkill: RuntimeSkillConfiguration = { id: skill.id, name: skill.name, description: skill.description,
        version: skill.version, instructions: packageContent.instructions, tools: skill.toolIds,
        artifact: version.manifest.artifact, files: version.manifest.artifact.files,
        disableModelInvocation: version.manifest.artifact.disableModelInvocation,
        dependencies: version.manifest.dependencies ?? [], dependencySkills }
      if (input.scenario !== undefined) runtimeSkill.testScenario = normalizeSkillTestScenario(input.scenario, [runtimeSkill, ...flattenRuntimeDependencies(runtimeSkill)])
      const runtimeFingerprint = runtimeSkillFingerprint(runtimeSkill)
      const result = await this.packageTester(actor.id, runtimeSkill, prompt)
      evidencePolicy = result.evidencePolicy ?? SKILL_TEST_EVIDENCE_POLICY
      if (result.passed && !result.attemptId) throw skillConflict('严格试运行缺少精确 Attempt 证据，请重新测试', 'skill_test_evidence_required')
      if (result.attemptId) {
        await this.bindStrictTest(result.runId, skill.id, skill.draftVersionId, fingerprint, runtimeFingerprint, prompt, actor.id)
        runtimeRunId = result.runId
        runtimeAttemptId = result.attemptId
        testId = `skill-test-${result.attemptId}`
      }
      status = result.passed ? 'passed' : 'failed'
      summary = `DSH 试运行${result.passed ? '完成' : '失败'}（${result.runId}）：\n${result.summary}`
    }
    const [inserted] = await this.database<{ id: string }[]>`
      insert into skill_test_runs (
        id, tenant_id, skill_id, skill_version_id, configuration_fingerprint,
        test_prompt, status, result_summary, tested_by, runtime_run_id, runtime_attempt_id, evidence_policy
      ) select
        ${testId}, ${tenantId}, ${skill.id}, ${skill.draftVersionId}, ${fingerprint},
        ${prompt}, ${status}, ${summary}, ${actor.id}, ${runtimeRunId}, ${runtimeAttemptId},
        ${runtimeAttemptId ? evidencePolicy : 'legacy'}
      where (${runtimeAttemptId}::text is null or exists (
        select 1 from runs where tenant_id = ${tenantId} and id = ${runtimeRunId} and current_attempt_id = ${runtimeAttemptId}
      ))
      on conflict (id) do nothing returning id
    `
    if (!inserted) {
      const [stored] = await this.database`select id from skill_test_runs where tenant_id = ${tenantId} and id = ${testId}`
      if (!stored) throw skillConflict('试运行 Attempt 已变化，请重新测试', 'skill_test_attempt_changed')
    }
    await this.audit(actor.id, 'skill.test', skill.id, status === 'passed' ? 'success' : 'failed', skill.strictTest ? `DSH Skill 试运行 ${status}` : summary)
    return {
      id: testId,
      skillId: skill.id,
      version: skill.version,
      status,
      resultSummary: summary,
      testedAt: new Date().toISOString(),
    }
  }

  async startSkillTest(input: { skillId: string; prompt?: string; actor: string; scenario?: unknown }): Promise<SkillTestRunProgress> {
    const context = await this.strictTestContext(input)
    if (input.scenario !== undefined) {
      if (!context.skill.strictTest) throw skillInvalid('场景测试要求真实 DSH 试运行包', 'invalid_test_scenario')
      context.runtimeSkill.testScenario = normalizeSkillTestScenario(input.scenario, [context.runtimeSkill, ...flattenRuntimeDependencies(context.runtimeSkill)])
    }
    if (!context.skill.strictTest) {
      const result = await this.testSkill(input)
      return {
        runId: result.id,
        skillId: result.skillId,
        version: result.version,
        status: result.status,
        resultSummary: result.resultSummary,
        testedAt: result.testedAt,
        steps: [{ id: 'configuration', title: '校验 Skill 配置', description: result.resultSummary, status: result.status === 'passed' ? 'completed' : 'failed', occurredAt: result.testedAt }],
      }
    }
    if (!this.packageTestLifecycle) throw skillUnavailable('DSH Skill 试运行进度服务不可用')
    const runtimeFingerprint = runtimeSkillFingerprint(context.runtimeSkill)
    const progress = await this.packageTestLifecycle.start(context.actor.id, context.runtimeSkill, context.prompt)
    await this.bindStrictTest(progress.runId, context.skill.id, context.skill.draftVersionId!, context.fingerprint,
      runtimeFingerprint, context.prompt, context.actor.id)
    if (['succeeded', 'failed', 'cancelled'].includes(progress.status)) {
      return this.getSkillTestProgress({ skillId: context.skill.id, runId: progress.runId, actor: context.actor.id })
    }
    return { runId: progress.runId, skillId: context.skill.id, version: context.skill.version, status: normalizeTestRunStatus(progress.status), steps: progress.steps }
  }

  async getSkillTestProgress(input: { skillId: string; runId: string; actor: string }): Promise<SkillTestRunProgress> {
    const context = await this.strictTestContext({ skillId: input.skillId, actor: input.actor })
    if (!context.skill.strictTest) throw skillConflict('当前 Skill 没有可查询的严格试运行', 'skill_test_state_conflict')
    if (!this.packageTestLifecycle) throw skillUnavailable('DSH Skill 试运行进度服务不可用')
    const [binding] = await this.database<{ versionId: string; fingerprint: string; runtimeFingerprint: string; prompt: string }[]>`
      select skill_version_id as "versionId", configuration_fingerprint as fingerprint,
             runtime_fingerprint as "runtimeFingerprint", test_prompt as prompt
        from skill_test_bindings
       where tenant_id = ${tenantId} and run_id = ${input.runId} and skill_id = ${input.skillId} and created_by = ${context.actor.id}
    `
    assertStartedSkillTest({ versionId: context.skill.draftVersionId!, fingerprint: context.fingerprint,
      runtimeFingerprint: runtimeSkillFingerprint(context.runtimeSkill) }, binding)
    if (!binding) throw skillConflict('试运行启动快照不存在，请重新测试', 'skill_test_snapshot_changed')
    const progress = await this.packageTestLifecycle.progress(context.actor.id, context.runtimeSkill, input.runId)
    if (!progress.attemptId) throw skillConflict('严格试运行缺少精确 Attempt 证据，请重新测试', 'skill_test_evidence_required')
    const status = progress.status === 'succeeded' ? (progress.passed ? 'passed' : 'failed') : normalizeTestRunStatus(progress.status)
    if (!['passed', 'failed'].includes(status)) {
      return { runId: progress.runId, skillId: context.skill.id, version: context.skill.version, status, steps: progress.steps }
    }

    const resultSummary = progress.summary ?? 'DSH 试运行未产生结果'
    const testId = `skill-test-${progress.attemptId}`
    const [inserted] = await this.database<{ createdAt: Date }[]>`
      insert into skill_test_runs (
        id, tenant_id, skill_id, skill_version_id, configuration_fingerprint,
        test_prompt, status, result_summary, tested_by, runtime_run_id, runtime_attempt_id, evidence_policy
      ) select
        ${testId}, ${tenantId}, ${context.skill.id}, ${binding.versionId}, ${binding.fingerprint},
        ${binding.prompt}, ${status}, ${resultSummary}, ${context.actor.id}, ${input.runId}, ${progress.attemptId}, ${progress.evidencePolicy ?? SKILL_TEST_EVIDENCE_POLICY}
      from runs r
      where r.tenant_id = ${tenantId} and r.id = ${input.runId} and r.current_attempt_id = ${progress.attemptId}
      on conflict (id) do nothing returning created_at as "createdAt"
    `
    const [stored] = inserted ? [inserted] : await this.database<{ createdAt: Date }[]>`
      select created_at as "createdAt" from skill_test_runs where tenant_id = ${tenantId} and id = ${testId}
    `
    if (!stored) throw skillConflict('试运行 Attempt 已变化，请刷新进度', 'skill_test_attempt_changed')
    if (inserted) await this.audit(context.actor.id, 'skill.test', context.skill.id, status === 'passed' ? 'success' : 'failed', `DSH Skill 试运行 ${status}`)
    return {
      runId: progress.runId,
      skillId: context.skill.id,
      version: context.skill.version,
      status,
      resultSummary,
      testedAt: (stored?.createdAt ?? new Date()).toISOString(),
      steps: progress.steps,
    }
  }

  private async bindStrictTest(runId: string, skillId: string, versionId: string, fingerprint: string,
    runtimeFingerprint: string, prompt: string, actor: string) {
    // Values were captured BEFORE launch. Failure/crash here leaves an unbound
    // test that cannot publish, rather than attaching it to a later draft.
    await this.database`
      insert into skill_test_bindings (tenant_id, run_id, skill_id, skill_version_id,
        configuration_fingerprint, runtime_fingerprint, test_prompt, created_by)
      select ${tenantId}, r.id, ${skillId}, ${versionId}, ${fingerprint}, ${runtimeFingerprint}, ${prompt}, ${actor}
        from runs r where r.tenant_id = ${tenantId} and r.id = ${runId} and r.requested_by = ${actor}
      on conflict (tenant_id, run_id) do nothing
    `
    const [stored] = await this.database<{ versionId: string; fingerprint: string; runtimeFingerprint: string }[]>`
      select skill_version_id as "versionId", configuration_fingerprint as fingerprint, runtime_fingerprint as "runtimeFingerprint"
        from skill_test_bindings where tenant_id = ${tenantId} and run_id = ${runId} and skill_id = ${skillId} and created_by = ${actor}
    `
    assertStartedSkillTest({ versionId, fingerprint, runtimeFingerprint }, stored)
  }

  private async strictTestContext(input: { skillId: string; prompt?: string; actor: string }) {
    const actor = await this.requireActor(input.actor)
    assertSkillId(input.skillId)
    const [skill] = await this.readSkillRows(input.skillId)
    if (!skill) throw skillNotFound(`Skill 不存在：${input.skillId}`)
    if (!skill.draftVersionId) throw skillConflict('当前 Skill 没有待测试的草稿版本', 'skill_draft_required')
    await this.toolService?.assertAvailableReferences(skill.toolIds)
    const prompt = normalizeTestPrompt(input.prompt, skill.testPrompt)
    const fingerprint = configurationFingerprint(skill)
    let runtimeSkill: RuntimeSkillConfiguration = {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      instructions: skill.instructions,
      tools: skill.toolIds,
    }
    if (skill.strictTest) {
      const [version] = await this.database<{ manifest: { artifact?: SkillPackageArtifact; dependencies?: string[] } }[]>`select manifest from skill_versions where tenant_id = ${tenantId} and id = ${skill.draftVersionId}`
      if (!version?.manifest.artifact) throw skillInternalFailure('Skill 文件夹索引缺失')
      const packageContent = await this.requireArtifactStore().read(version.manifest.artifact)
      const dependencySkills = await this.resolveTestRuntimeSkills(version.manifest.dependencies ?? [])
      await this.toolService?.assertAvailableReferences([...skill.toolIds, ...dependencySkills.flatMap(item => [item, ...flattenRuntimeDependencies(item)]).flatMap(item => item.tools)])
      runtimeSkill = { id: skill.id, name: skill.name, description: skill.description, version: skill.version, instructions: packageContent.instructions, tools: skill.toolIds, artifact: version.manifest.artifact, files: version.manifest.artifact.files, disableModelInvocation: version.manifest.artifact.disableModelInvocation, dependencies: version.manifest.dependencies ?? [], dependencySkills }
    }
    return { actor, skill, prompt, fingerprint, runtimeSkill }
  }

  async setStatus(input: {
    skillId: string
    status: Extract<PublishStatus, 'published' | 'disabled'>
    actor: string
  }) {
    const actor = await this.requireActor(input.actor)
    assertSkillId(input.skillId)
    const [current] = await this.readSkillRows(input.skillId)
    if (!current) throw skillNotFound(`Skill 不存在：${input.skillId}`)

    if (!['published', 'disabled'].includes(input.status)) throw skillInvalid('Skill 状态必须为 published 或 disabled')
    if (input.status === 'disabled') {
      if (current.draftVersionId) throw skillConflict('存在待发布草稿时不能停用 Skill，请先发布或回滚')
      if (!current.activeVersionId) throw skillConflict('尚未发布的 Skill 不能停用')
      const activeVersionId = current.activeVersionId
      const release = await this.database.begin(async transaction => {
        const updated = await transaction`
          update skills set status = 'disabled', updated_at = now()
           where tenant_id = ${tenantId} and id = ${input.skillId}
             and status = 'published' and active_version_id = ${activeVersionId}
             and draft_version_id is null
           returning id
        `
        if (!updated.length) throw skillConflict('Skill 状态已发生变化，请刷新后重试')
        return this.appendRelease(transaction, activeVersionId, input.skillId, 'disabled', actor.id, '停用 Skill；既有 Agent Version 的固定引用不被改写。')
      })
      await this.audit(actor.id, 'skill.disable', input.skillId, 'success', release.note)
      return { skill: await this.requireSkill(input.skillId), release }
    }

    if (current.draftVersionId) return this.publishDraft(current, actor.id)
    if (!current.activeVersionId || current.persistedStatus !== 'disabled') {
      throw skillConflict('当前 Skill 没有可发布草稿，也不处于停用状态')
    }
    const activeVersionId = current.activeVersionId
    const release = await this.database.begin(async transaction => {
      const updated = await transaction`
        update skills set status = 'published', updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.skillId}
           and status = 'disabled' and active_version_id = ${activeVersionId}
         returning id
      `
      if (!updated.length) throw skillConflict('Skill 状态已发生变化，请刷新后重试')
      return this.appendRelease(transaction, activeVersionId, input.skillId, 'enabled', actor.id, '重新启用当前 Skill 版本。')
    })
    await this.audit(actor.id, 'skill.enable', input.skillId, 'success', release.note)
    return { skill: await this.requireSkill(input.skillId), release }
  }

  async rollback(input: { skillId: string; version: string; actor: string }) {
    const actor = await this.requireActor(input.actor)
    if (typeof input.version !== 'string' || !input.version.trim()) throw skillInvalid('Skill 版本必须为非空字符串')
    assertSkillId(input.skillId)
    const [current] = await this.readSkillRows(input.skillId)
    if (!current) throw skillNotFound(`Skill 不存在：${input.skillId}`)
    const [target] = await this.database<VersionRow[]>`
      select sv.id, sv.skill_id as "skillId", sv.version, sv.name, sv.category,
             sv.description, sv.instructions, sv.tool_refs as "toolIds",
             sv.test_prompt as "testPrompt", sv.status, sv.created_at as "createdAt",
             creator.display_name as "createdBy", sv.published_at as "publishedAt",
             publisher.display_name as "publishedBy", sv.source_version as "sourceVersion",
             sv.change_summary as summary
        from skill_versions sv
        join users creator on creator.tenant_id = sv.tenant_id and creator.id = sv.created_by
        left join users publisher on publisher.tenant_id = sv.tenant_id and publisher.id = sv.published_by
       where sv.tenant_id = ${tenantId} and sv.skill_id = ${input.skillId}
         and sv.version = ${input.version} and sv.status = 'published'
    `
    if (!target) throw skillNotFound(`已发布 Skill Version 不存在：${input.skillId}@${input.version}`, 'skill_version_not_found')

    const note = `活动版本由 v${current.activeVersion ?? current.version} 回滚到 v${target.version}。`
    const release = await this.database.begin(async transaction => {
      if (current.draftVersionId) {
        await transaction`update skill_versions set status = 'disabled' where tenant_id = ${tenantId} and id = ${current.draftVersionId} and status = 'draft'`
      }
      await transaction`
        update skills set active_version_id = ${target.id}, draft_version_id = null,
                          status = 'published', name = ${target.name}, category = ${target.category},
                          description = ${target.description}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${input.skillId}
      `
      return this.appendRelease(transaction, target.id, input.skillId, 'rollback', actor.id, note)
    })
    await this.audit(actor.id, 'skill.rollback', input.skillId, 'success', release.note)
    return { skill: await this.requireSkill(input.skillId), release }
  }

  async assertPublishedReferences(references: string[]): Promise<void> {
    for (const reference of unique(references)) {
      const { id, version } = parseReference(reference)
      const [row] = await this.database<{ id: string }[]>`
        select sv.id from skills s
        join skill_versions sv on sv.tenant_id = s.tenant_id and sv.skill_id = s.id
         where s.tenant_id = ${tenantId} and s.id = ${id} and s.status = 'published'
           and sv.version = ${version} and sv.status = 'published'
      `
      if (!row) throw skillConflict(`Agent 引用的 Skill 不存在、未发布或已停用：${reference}`, 'skill_dependency_unavailable')
    }
  }

  async resolveRuntimeSkills(references: string[]): Promise<RuntimeSkillConfiguration[]> {
    const resolved: RuntimeSkillConfiguration[] = []
    const pending = [...unique(references)]
    const seen = new Set<string>()
    while (pending.length) {
      const reference = pending.shift()!
      if (seen.has(reference)) continue
      seen.add(reference)
      const { id, version } = parseReference(reference)
      const [row] = await this.database<{ name: string; description: string; instructions: string; tools: string[]; manifest: { artifact?: SkillPackageArtifact; dependencies?: string[] } }[]>`
        select name, description, instructions, tool_refs as tools, manifest from skill_versions
         where tenant_id = ${tenantId} and skill_id = ${id} and version = ${version}
           and status = 'published'
      `
      if (!row) throw skillConflict(`Runtime 无法解析已锁定的 Skill Version：${reference}`, 'skill_dependency_unavailable')
      const artifactContent = row.manifest.artifact ? await this.requireArtifactStore().read(row.manifest.artifact) : null
      pending.push(...(row.manifest.dependencies ?? []))
      resolved.push({ id, name: row.name, description: row.description, version, instructions: artifactContent?.instructions ?? row.instructions, tools: row.tools,
        ...(row.manifest.artifact ? { artifact: row.manifest.artifact, files: row.manifest.artifact.files, disableModelInvocation: row.manifest.artifact.disableModelInvocation } : {}), ...(row.manifest.dependencies?.length ? { dependencies: row.manifest.dependencies } : {}) })
    }
    return resolved
  }

  private async resolveTestRuntimeSkills(references: string[], sql: DatabaseClient | DatabaseTransaction = this.database): Promise<RuntimeSkillConfiguration[]> {
    const result: RuntimeSkillConfiguration[] = []
    for (const reference of references) {
      const { id, version } = parseReference(reference)
      const [row] = await sql<{ name: string; description: string; instructions: string; tools: string[]; manifest: { artifact?: SkillPackageArtifact; dependencies?: string[] } }[]>`
        select name, description, instructions, tool_refs as tools, manifest from skill_versions
        where tenant_id = ${tenantId} and skill_id = ${id} and version = ${version}
          and status in ('draft', 'published')`
      if (!row) throw skillConflict(`试运行无法解析锁定的依赖 Skill Version：${reference}`, 'skill_dependency_unavailable')
      const artifactContent = row.manifest.artifact ? await this.requireArtifactStore().read(row.manifest.artifact) : null
      result.push({ id, name: row.name, description: row.description, version, instructions: artifactContent?.instructions ?? row.instructions, tools: row.tools,
        artifact: row.manifest.artifact, files: row.manifest.artifact?.files, disableModelInvocation: row.manifest.artifact?.disableModelInvocation, dependencies: row.manifest.dependencies ?? [], dependencySkills: await this.resolveTestRuntimeSkills(row.manifest.dependencies ?? [], sql) })
    }
    return result
  }

  private async readDependencyToolReferences(versionId: string): Promise<string[]> {
    const rows = await this.database<{ tools: string[] }[]>`
      with recursive dependency_graph as (
        select d.dependency_skill_version_id as version_id from skill_version_dependencies d
         where d.tenant_id = ${tenantId} and d.skill_version_id = ${versionId}
        union
        select d.dependency_skill_version_id from skill_version_dependencies d
        join dependency_graph g on g.version_id = d.skill_version_id where d.tenant_id = ${tenantId}
      )
      select sv.tool_refs as tools from dependency_graph g
      join skill_versions sv on sv.tenant_id = ${tenantId} and sv.id = g.version_id`
    return unique(rows.flatMap(row => row.tools))
  }

  private async requireScenarioPublicationCoverage(
    transaction: DatabaseTransaction, current: SkillRow, locked: LockedSkillDraft, fingerprint: string,
  ): Promise<{ id: string; runId: string; attemptId: string }> {
    // Root is already locked by publishDraft. Lock the complete dependency graph
    // before comparing all scenario start snapshots, just as the strict path does.
    await transaction`
      with recursive graph as (
        select dependency_skill_version_id as id from skill_version_dependencies
         where tenant_id = ${tenantId} and skill_version_id = ${locked.versionId}
        union
        select d.dependency_skill_version_id from skill_version_dependencies d
        join graph g on g.id = d.skill_version_id where d.tenant_id = ${tenantId}
      )
      select sv.id from skill_versions sv join graph g on g.id = sv.id
       where sv.tenant_id = ${tenantId} order by sv.id for update of sv
    `
    const [root] = await this.resolveTestRuntimeSkills([`${current.id}@${current.version}`], transaction)
    if (!root) throw skillConflict('测试配置或依赖已变化，请重新测试', 'skill_test_snapshot_changed')
    const expectedFingerprint = runtimeSkillFingerprint(root)
    const rows = await transaction<{
      id: string; runId: string; attemptId: string; testStatus: string; runStatus: string;
      attemptStatus: string; runtimeFingerprint: string; manifest: RuntimeManifest
    }[]>`
      select t.id, r.id as "runId", ra.id as "attemptId", t.status as "testStatus",
             r.status as "runStatus", ra.status as "attemptStatus", b.runtime_fingerprint as "runtimeFingerprint", ra.manifest
        from skill_test_runs t
        join runs r on r.tenant_id = t.tenant_id and r.id = t.runtime_run_id and r.current_attempt_id = t.runtime_attempt_id
        join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id and ra.run_id = r.id
        join skill_test_bindings b on b.tenant_id = r.tenant_id and b.run_id = r.id and b.skill_version_id = t.skill_version_id
       where t.tenant_id = ${tenantId} and t.skill_version_id = ${locked.versionId}
         and t.configuration_fingerprint = ${fingerprint} and b.configuration_fingerprint = ${fingerprint}
         and t.evidence_policy = ${SKILL_TEST_SCENARIO_POLICY}
       order by t.created_at desc, t.id desc for update of r
    `
    const coveredSkills = new Set<string>(), coveredPython = new Set<string>(), seenScenarios = new Set<string>()
    let selected: { id: string; runId: string; attemptId: string } | undefined
    for (const row of rows) {
      if (row.runtimeFingerprint !== expectedFingerprint || !row.manifest.test_scenario) continue
      const scenarioId = row.manifest.test_scenario.id
      // The latest finished evaluation of a named scenario replaces its earlier
      // result. A new failed evaluation cannot silently reuse an older pass.
      if (seenScenarios.has(scenarioId)) continue
      seenScenarios.add(scenarioId)
      if (row.testStatus !== 'passed') continue
      const activations = await transaction<{ attemptId: string; skillId: string; skillVersion: string }[]>`
        select attempt_id as "attemptId", skill_id as "skillId", skill_version as "skillVersion"
          from skill_runtime_activations where tenant_id = ${tenantId} and run_id = ${row.runId} and attempt_id = ${row.attemptId}
      `
      const pythonExecutions = await transaction<{ attemptId: string; skillId: string; entry: string; succeeded: boolean }[]>`
        select attempt_id as "attemptId", skill_id as "skillId", entry_path as entry, succeeded
          from skill_python_executions where tenant_id = ${tenantId} and run_id = ${row.runId} and attempt_id = ${row.attemptId}
      `
      const events = await transaction<{ attemptId: string; eventType: string; displayMessage: string | null }[]>`
        select attempt_id as "attemptId", event_type as "eventType", display_message as "displayMessage"
          from run_events where tenant_id = ${tenantId} and run_id = ${row.runId} and attempt_id = ${row.attemptId}
         order by stream_position, sequence
      `
      const result = evaluateAttemptEvidence({ ...row, activations, pythonExecutions, events })
      if (!result.passed) continue
      result.verifiedSkillReferences.forEach(reference => coveredSkills.add(reference))
      result.verifiedPythonSkillIds.forEach(id => coveredPython.add(id))
      selected ??= row
    }
    const catalog = [root, ...flattenRuntimeDependencies(root)]
    if (!selected || catalog.some(skill => !coveredSkills.has(`${skill.id}@${skill.version}`))
      || catalog.some(skill => skill.files?.some(file => file.path.endsWith('.py')) && !coveredPython.has(skill.id))) {
      throw skillConflict('场景测试覆盖不完整或配置/结果已变化：发布需覆盖全部锁定 Skill 与含 Python 的分支，请补充场景测试', 'skill_test_coverage_incomplete')
    }
    return selected
  }

  private async publishDraft(current: SkillRow, actorId: string) {
    const dependencyTools = current.draftVersionId ? await this.readDependencyToolReferences(current.draftVersionId) : []
    await this.toolService?.assertAvailableReferences([...current.toolIds, ...dependencyTools])
    const release = await this.database.begin(async transaction => {
      const [locked] = await transaction<LockedSkillDraft[]>`
        select s.id, sv.id as "versionId", sv.name, sv.category, sv.description,
               sv.instructions, sv.tool_refs as "toolIds", sv.test_prompt as "testPrompt",
               sv.manifest->'artifact' as artifact
          from skills s
          join skill_versions sv on sv.tenant_id = s.tenant_id and sv.id = s.draft_version_id
         where s.tenant_id = ${tenantId} and s.id = ${current.id} and sv.status = 'draft'
         for update of s, sv
      `
      if (!locked) throw skillConflict('当前 Skill 草稿已发生变化，请重新测试后再发布', 'skill_test_snapshot_changed')
      // Link-origin dependencies can also be published via another root. Do not
      // let a ZIP/assistant parent bypass the draft-only availability gate.
      const publicationGraph = await transaction<{ status: string; linkOrigin: boolean; toolRefs: string[]; requirements: SkillPackageArtifact['requirements'] | null }[]>`
        with recursive graph as (
          select ${locked.versionId}::text as id
          union
          select d.dependency_skill_version_id from skill_version_dependencies d
          join graph g on g.id = d.skill_version_id where d.tenant_id = ${tenantId}
        )
        select sv.status, sv.tool_refs as "toolRefs", sv.manifest->'artifact'->'requirements' as requirements,
          (coalesce(sv.manifest->>'installationChannel', '') = 'link' or exists (
          select 1 from skill_installations i where i.tenant_id = sv.tenant_id and i.version_id = sv.id
            and i.channel = 'link' and i.status = 'installed'
        )) as "linkOrigin"
        from graph g join skill_versions sv on sv.id = g.id and sv.tenant_id = ${tenantId}
      `
      if (publicationGraph.some(row => row.status === 'draft' && row.linkOrigin)) {
        if (!this.publicationAvailabilityChecker) throw new ExecutionCapabilityUnavailableError('dsh')
        await this.publicationAvailabilityChecker(unique(publicationGraph.flatMap(row => row.toolRefs)),
          unique(publicationGraph.flatMap(row => (row.requirements ?? []).filter(r => r.type === 'external' && r.name.startsWith('python-package:'))
            .map(r => r.name.slice('python-package:'.length)))))
      }
      if (locked.artifact) locked.instructions = (await this.requireArtifactStore().read(locked.artifact)).instructions

      const fingerprint = configurationFingerprint(locked)
      let [test] = await transaction<{ id: string; runId: string | null; attemptId: string | null }[]>`
        select t.id, t.runtime_run_id as "runId", t.runtime_attempt_id as "attemptId" from skill_test_runs t
         where t.tenant_id = ${tenantId} and t.skill_version_id = ${locked.versionId}
           and t.configuration_fingerprint = ${fingerprint} and t.status = 'passed'
           and (${!current.strictTest} or (t.evidence_policy = ${SKILL_TEST_EVIDENCE_POLICY} and exists (
             select 1 from runs r join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
              where r.tenant_id = t.tenant_id and r.id = t.runtime_run_id and ra.id = t.runtime_attempt_id
                and ra.run_id = r.id and r.status = 'succeeded' and ra.status = 'succeeded'
           )))
         order by t.created_at desc limit 1
      `
      if (!test && current.strictTest) test = await this.requireScenarioPublicationCoverage(transaction, current, locked, fingerprint)
      if (!test) throw skillConflict('发布前必须使用当前配置完成一次服务端测试', 'skill_test_required')
      if (current.strictTest) {
        const [run] = await transaction`
          select id from runs where tenant_id = ${tenantId} and id = ${test.runId}
            and current_attempt_id = ${test.attemptId} and status = 'succeeded' for update
        `
        if (!run) throw skillConflict('试运行 Attempt 已变化，请重新测试后发布', 'skill_test_attempt_changed')
        await transaction`
          with recursive graph as (
            select dependency_skill_version_id as id from skill_version_dependencies
             where tenant_id = ${tenantId} and skill_version_id = ${locked.versionId}
            union
            select d.dependency_skill_version_id from skill_version_dependencies d
            join graph g on g.id = d.skill_version_id where d.tenant_id = ${tenantId}
          )
          select sv.id from skill_versions sv join graph g on g.id = sv.id
           where sv.tenant_id = ${tenantId} order by sv.id for update of sv
        `
        const [binding] = await transaction<{ versionId: string; fingerprint: string; runtimeFingerprint: string }[]>`
          select skill_version_id as "versionId", configuration_fingerprint as fingerprint,
                 runtime_fingerprint as "runtimeFingerprint" from skill_test_bindings
           where tenant_id = ${tenantId} and run_id = ${test.runId} and skill_id = ${current.id}
        `
        const [runtimeSkill] = await this.resolveTestRuntimeSkills([`${current.id}@${current.version}`], transaction)
        if (!runtimeSkill) throw skillConflict('测试的 Skill 版本已失效', 'skill_test_snapshot_changed')
        assertStartedSkillTest({ versionId: locked.versionId, fingerprint,
          runtimeFingerprint: runtimeSkillFingerprint(runtimeSkill) }, binding)
      }

      const dependencyVersions = await transaction<{ versionId: string; skillId: string }[]>`
        with recursive dependency_graph as (
          select d.dependency_skill_version_id as version_id
            from skill_version_dependencies d
           where d.tenant_id = ${tenantId} and d.skill_version_id = ${locked.versionId}
          union
          select d.dependency_skill_version_id
            from skill_version_dependencies d
            join dependency_graph g on g.version_id = d.skill_version_id
           where d.tenant_id = ${tenantId}
        )
        select sv.id as "versionId", sv.skill_id as "skillId"
          from dependency_graph g
          join skill_versions sv on sv.tenant_id = ${tenantId} and sv.id = g.version_id
         where sv.status = 'draft'
      `
      for (const dependency of dependencyVersions) {
        await transaction`update skill_versions set status = 'published', published_at = now(), published_by = ${actorId}
          where tenant_id = ${tenantId} and id = ${dependency.versionId} and status = 'draft'`
        await transaction`update skills set active_version_id = ${dependency.versionId}, draft_version_id = null, status = 'published', updated_at = now()
          where tenant_id = ${tenantId} and id = ${dependency.skillId} and draft_version_id = ${dependency.versionId}`
      }

      const published = await transaction<{ id: string }[]>`
        update skill_versions set status = 'published', published_at = now(), published_by = ${actorId}
         where tenant_id = ${tenantId} and id = ${locked.versionId} and status = 'draft'
         returning id
      `
      if (!published.length) throw skillConflict('Skill 草稿发布状态已发生变化，请刷新后重试')

      const activated = await transaction<{ id: string }[]>`
        update skills set active_version_id = ${locked.versionId}, draft_version_id = null,
                          status = 'published', updated_at = now()
         where tenant_id = ${tenantId} and id = ${current.id} and draft_version_id = ${locked.versionId}
         returning id
      `
      if (!activated.length) throw skillConflict('Skill 草稿指针已发生变化，请刷新后重试')
      return this.appendRelease(transaction, locked.versionId, current.id, 'published', actorId, '服务端配置测试通过，发布当前 Skill 版本。')
    })
    await this.audit(actorId, 'skill.publish', current.id, 'success', release.note)
    return { skill: await this.requireSkill(current.id), release }
  }

  private async appendRelease(
    transaction: DatabaseTransaction,
    versionId: string,
    skillId: string,
    action: SkillReleaseRecord['action'],
    actorId: string,
    note: string,
  ): Promise<SkillReleaseRecord> {
    const id = `skill-release-${randomUUID()}`
    const [row] = await transaction<{ version: string; actor: string; time: Date }[]>`
      with inserted as (
        insert into skill_release_records (
          id, tenant_id, skill_id, skill_version_id, action, actor_id, note
        ) values (${id}, ${tenantId}, ${skillId}, ${versionId}, ${action}, ${actorId}, ${note})
        returning skill_version_id, actor_id, created_at
      )
      select sv.version, u.display_name as actor, inserted.created_at as time
        from inserted
        join skill_versions sv on sv.tenant_id = ${tenantId} and sv.id = inserted.skill_version_id
        join users u on u.tenant_id = ${tenantId} and u.id = inserted.actor_id
    `
    if (!row) throw skillInternalFailure('Skill 发布记录写入失败')
    return { id, skillId, version: row.version, action, actor: row.actor, time: formatDateTime(row.time), note }
  }

  private async readSkillRows(skillId?: string): Promise<SkillRow[]> {
    const rows = await this.database<SkillRow[]>`
      select s.id, sv.name, sv.category, sv.description, sv.instructions,
             owner.display_name as owner, s.status as "persistedStatus",
             s.active_version_id as "activeVersionId", s.draft_version_id as "draftVersionId",
             sv.id as "versionId", sv.version, active.version as "activeVersion",
             sv.tool_refs as "toolIds", sv.package_sha256 as "packageSha256", sv.manifest->'artifact' as artifact,
             sv.manifest->>'installationId' as "installationId",
             exists (
               select 1 from skill_installations installation
                where installation.tenant_id = s.tenant_id and installation.skill_id = s.id
                  and installation.status = 'installed'
             ) as "isInstallationRoot",
             (sv.manifest ? 'installationId') as "strictTest", sv.test_prompt as "testPrompt", s.updated_at as "updatedAt"
        from skills s
        join users owner on owner.tenant_id = s.tenant_id and owner.id = s.owner_user_id
        join skill_versions sv on sv.tenant_id = s.tenant_id
         and sv.id = coalesce(s.draft_version_id, s.active_version_id)
        left join skill_versions active on active.tenant_id = s.tenant_id and active.id = s.active_version_id
       where s.tenant_id = ${tenantId} ${skillId ? this.database`and s.id = ${skillId}` : this.database``}
       order by s.updated_at desc
    `
    for (const row of rows) if (row.artifact) row.instructions = (await this.requireArtifactStore().read(row.artifact)).instructions
    const dependencyRows = await this.database<SkillDependencyRow[]>`
      select d.skill_version_id as "parentVersionId", dependency.id as "versionId",
             dependency.skill_id as id, dependency.name, dependency.version,
             case when dependency_skill.status = 'disabled' then 'disabled' else dependency.status end as status
        from skill_version_dependencies d
        join skill_versions dependency on dependency.tenant_id = d.tenant_id and dependency.id = d.dependency_skill_version_id
        join skills dependency_skill on dependency_skill.tenant_id = dependency.tenant_id and dependency_skill.id = dependency.skill_id
       where d.tenant_id = ${tenantId}
    `
    const dependenciesByVersion = new Map<string, SkillDependencyRow[]>()
    for (const dependency of dependencyRows) {
      dependenciesByVersion.set(dependency.parentVersionId, [...(dependenciesByVersion.get(dependency.parentVersionId) ?? []), dependency])
    }
    for (const row of rows) {
      row.installationRole = !row.installationId ? 'standalone' : row.isInstallationRoot ? 'root' : 'dependency'
      row.dependencies = flattenDependencySummaries(row.versionId, dependenciesByVersion)
    }
    return rows
  }

  private requireArtifactStore() {
    if (!this.artifactStore) throw skillUnavailable('Skill 文件夹存储未配置')
    return this.artifactStore
  }

  private async requireActor(userId: string) {
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

  private async requireSkill(skillId: string): Promise<SkillDefinition> {
    const [row] = await this.readSkillRows(skillId)
    if (!row) throw skillNotFound(`Skill 不存在：${skillId}`)
    return toSkillDefinition(row)
  }

  private async requireSkillResult(skillId: string, versionId: string) {
    const skill = await this.requireSkill(skillId)
    const version = (await this.getSkillVersions()).find(item => item.id === versionId)
    if (!version) throw skillNotFound(`Skill Version 不存在：${versionId}`, 'skill_version_not_found')
    return { skill, version }
  }

  private audit(actorId: string, action: string, skillId: string, result: 'success' | 'failed', detail: string) {
    return this.operations?.appendAudit(actorId, action, skillId, result, `trace-skill-${randomUUID()}`, detail)
      ?? Promise.resolve()
  }
}

function normalizeConfiguration(input: SkillConfiguration): SkillConfiguration {
  for (const key of ['id', 'name', 'category', 'description', 'instructions', 'testPrompt'] as const) {
    if (typeof input[key] !== 'string') throw skillInvalid(`Skill 字段 ${key} 必须为字符串`)
  }
  if (!Array.isArray(input.toolIds) || input.toolIds.some(id => typeof id !== 'string')) {
    throw skillInvalid('Skill toolIds 必须为字符串数组')
  }
  return {
    id: input.id,
    name: input.name.trim(),
    category: input.category.trim(),
    description: input.description.trim(),
    instructions: input.instructions.trim(),
    toolIds: unique(input.toolIds),
    testPrompt: input.testPrompt.trim(),
  }
}

function normalizeTestRunStatus(status: string): SkillTestRunProgress['status'] {
  if (status === 'queued' || status === 'running' || status === 'cancel_requested' || status === 'failed' || status === 'cancelled') return status
  return 'failed'
}

function assertConfiguration(input: SkillConfiguration) {
  if (!/^skill-[a-z0-9-]{6,48}$/.test(input.id)) throw skillInvalid('Skill 标识格式不正确')
  if (input.name.length < 2 || input.name.length > 40) throw skillInvalid('Skill 名称长度为 2～40 个字符')
  if (!input.category || input.category.length > 40) throw skillInvalid('Skill 分类不能为空且不能超过 40 个字符')
  if (input.description.length < 10 || input.description.length > 200) throw skillInvalid('Skill 说明长度为 10～200 个字符')
  if (input.instructions.length < 20 || input.instructions.length > 10000) throw skillInvalid('执行指令长度为 20～10000 个字符')
  if (input.testPrompt.length < 4 || input.testPrompt.length > 500) throw skillInvalid('典型测试问题长度为 4～500 个字符')
}

function toSkillDefinition(row: SkillRow): SkillDefinition {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    ...(row.activeVersion ? { activeVersion: row.activeVersion } : {}),
    category: row.category,
    owner: row.owner,
    status: row.draftVersionId ? 'draft' : row.persistedStatus,
    description: row.description,
    instructions: row.instructions,
    toolIds: row.toolIds,
    ...(row.packageSha256 ? { packageSha256: row.packageSha256 } : {}),
    installationRole: row.installationRole,
    ...(row.dependencies?.length ? { dependencies: row.dependencies } : {}),
    testPrompt: row.testPrompt,
    updatedAt: formatDateTime(row.updatedAt),
  }
}

function flattenDependencySummaries(
  rootVersionId: string,
  dependenciesByVersion: Map<string, SkillDependencyRow[]>,
) {
  const result: NonNullable<SkillDefinition['dependencies']> = []
  const pending = (dependenciesByVersion.get(rootVersionId) ?? []).map(dependency => ({ dependency, depth: 1 }))
  const seen = new Set<string>([rootVersionId])
  while (pending.length) {
    const { dependency, depth } = pending.shift()!
    if (seen.has(dependency.versionId)) continue
    seen.add(dependency.versionId)
    result.push({ id: dependency.id, name: dependency.name, version: dependency.version, status: dependency.status, depth })
    pending.push(...(dependenciesByVersion.get(dependency.versionId) ?? []).map(child => ({ dependency: child, depth: depth + 1 })))
  }
  return result
}

function toVersionRecord(row: VersionRow): SkillVersionRecord {
  return {
    id: row.id,
    skillId: row.skillId,
    version: row.version,
    name: row.name,
    category: row.category,
    description: row.description,
    instructions: row.instructions,
    toolIds: row.toolIds,
    testPrompt: row.testPrompt,
    status: row.status,
    createdAt: formatDateTime(row.createdAt),
    createdBy: row.createdBy,
    ...(row.publishedAt ? { publishedAt: formatDateTime(row.publishedAt) } : {}),
    ...(row.publishedBy ? { publishedBy: row.publishedBy } : {}),
    ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
    summary: row.summary,
  }
}

function configurationFingerprint(row: SkillFingerprintSource) {
  return createHash('sha256').update(JSON.stringify({
    versionId: row.versionId,
    name: row.name,
    category: row.category,
    description: row.description,
    instructions: row.instructions,
    toolIds: [...row.toolIds].sort(),
    testPrompt: row.testPrompt,
    packageSha256: row.artifact?.sha256 ?? null,
  })).digest('hex')
}

function parseReference(reference: string) {
  const separator = reference.lastIndexOf('@')
  if (separator <= 0 || separator === reference.length - 1) {
    throw skillInvalid(`Skill 引用必须锁定版本：${reference}`)
  }
  return { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
}

function nextVersion(current: string) {
  const [major = 0, minor = 0] = current.split('.').map(Number)
  return `${major}.${minor + 1}.0`
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function flattenRuntimeDependencies(skill: RuntimeSkillConfiguration): RuntimeSkillConfiguration[] {
  return (skill.dependencySkills ?? []).flatMap(item => [item, ...flattenRuntimeDependencies(item)])
}

function formatDateTime(value: Date) {
  return value.toISOString().slice(0, 16).replace('T', ' ')
}

/** HTTP JSON is untrusted even when the TypeScript input type says string. */
function assertSkillId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw skillInvalid('skillId 必须为非空字符串')
}

function normalizeTestPrompt(value: unknown, fallback: string): string {
  const prompt = value === undefined ? fallback : value
  if (typeof prompt !== 'string') throw skillInvalid('测试问题必须为字符串', 'skill_test_prompt_invalid')
  if (prompt.trim().length < 4) throw skillInvalid('测试问题至少需要 4 个字符', 'skill_test_prompt_invalid')
  return prompt.trim()
}
