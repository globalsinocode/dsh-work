import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { FileSystemSkillArtifactStore } from './file-system-skill-artifact-store.ts'
import {
  hash,
  createSkillPackage,
  parseSkillMarkdown,
  skillPackageContentHash,
  type SkillPackage,
  type SkillPackageArtifact,
} from './skill-package.ts'
import {
  externalizeSkillInstallationPlan,
  type PreparedSkillInstallationPlan,
} from './skill-installation-plan.ts'
import { compileRuntimeManifest } from '../runtime/manifest-compiler.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'

interface LegacyVersionRow {
  id: string
  name: string
  description: string
  instructions: string
  version: string
  toolIds: string[]
  manifest: { package?: SkillPackage; artifact?: SkillPackageArtifact; [key: string]: unknown }
}

interface LegacyInstallationRow {
  id: string
  package: SkillPackage | SkillPackageArtifact | null
  plan: PreparedSkillInstallationPlan | null
}

/** Idempotently moves pre-0031 packaged Skill bodies out of PostgreSQL. */
export async function migrateSkillFilesToFileSystem(database: DatabaseClient, store: FileSystemSkillArtifactStore) {
  const versions = await database<LegacyVersionRow[]>`
    select id, name, description, instructions, version, tool_refs as "toolIds", manifest from skill_versions
     where artifact_ref is null
  `
  for (const row of versions) {
    const legacy = row.manifest.package
    const pkg = isInlinePackage(legacy) ? legacy : createSkillPackage({
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      version: row.version,
      toolIds: row.toolIds,
    })
    const artifact = await store.put(pkg)
    const manifest = { ...row.manifest, artifact }
    delete manifest.package
    await database.begin(async transaction => {
      await transaction.unsafe("set local dsh_work.skill_storage_migration = 'on'")
      await transaction`
        update skill_versions
           set instructions = '', manifest = ${transaction.json(JSON.parse(JSON.stringify(manifest)))},
               artifact_ref = ${artifact.artifactRef}, package_sha256 = ${artifact.sha256}
         where id = ${row.id} and artifact_ref is null
      `
    })
  }

  const installations = await database<LegacyInstallationRow[]>`
    select id, package, plan from skill_installations
     where (package is not null and package::text like '%"content"%')
        or (plan is not null and plan::text like '%"content"%')
  `
  for (const row of installations) {
    const inlinePackages = row.plan?.packages.filter(isInlinePackage)
      ?? (isInlinePackage(row.package) ? [row.package] : [])
    if (!inlinePackages.length) continue
    const artifacts: SkillPackageArtifact[] = []
    for (const pkg of inlinePackages) artifacts.push(await store.put(pkg))
    const plan = row.plan ? externalizeSkillInstallationPlan(row.plan, artifacts) : null
    const rootName = plan?.rootName ?? inlinePackages[0]!.name
    const root = artifacts.find(artifact => artifact.name === rootName) ?? artifacts[0]!
    await database`
      update skill_installations
         set package = ${database.json(JSON.parse(JSON.stringify(root)))},
             plan = ${plan ? database.json(JSON.parse(JSON.stringify(plan))) : null},
             plan_sha256 = ${plan?.sha256 ?? null}
       where id = ${row.id}
    `
  }


  const indexedVersions = await database<{ skillId: string; version: string; artifact: SkillPackageArtifact }[]>`
    select skill_id as "skillId", version, manifest->'artifact' as artifact
      from skill_versions where artifact_ref is not null
  `
  const versionArtifacts = new Map(indexedVersions.map(row => [`${row.skillId}@${row.version}`, row.artifact]))
  const attempts = await database<{ id: string; manifest: RuntimeManifest; manifestSha256: string }[]>`
    select id, manifest, manifest_sha256 as "manifestSha256" from run_attempts
     where legacy_manifest_sha256 is null
       and jsonb_array_length(coalesce(manifest #> '{agent_configuration,skill_instructions}', '[]'::jsonb)) > 0
       and manifest::text like '%"instructions"%'
  `
  for (const row of attempts) {
    const manifest = structuredClone(row.manifest)
    let changed = false
    for (const skill of manifest.agent_configuration.skill_instructions) {
      if (skill.artifact_ref || !(skill.instructions ?? '').trim()) continue
      let artifact = versionArtifacts.get(`${skill.id}@${skill.version}`)
      if (!artifact) {
        const inlineFiles = (skill.files ?? []).filter((file): file is { path: string; content: string; sha256: string; size: number } => file.content !== undefined)
        const files = ensureSkillMarkdown(inlineFiles, skill.name ?? skill.id, skill.description ?? '迁移的 Skill 执行说明', skill.instructions!)
        const metadata = parseSkillMarkdown(files.find(file => file.path === 'SKILL.md')!.content)
        const packageSha256 = skillPackageContentHash(files)
        artifact = await store.put({
          name: metadata.name,
          description: metadata.description,
          instructions: metadata.instructions,
          version: skill.version,
          toolIds: [],
          files,
          sha256: packageSha256,
          archiveSha256: packageSha256,
          requirements: [],
          compatibility: { status: 'compatible', issues: [] },
          disableModelInvocation: skill.disable_model_invocation ?? false,
        })
      }
      skill.artifact_ref = artifact.artifactRef
      skill.instructions_sha256 = artifact.instructionsSha256
      skill.files = artifact.files
      delete skill.instructions
      changed = true
    }
    if (!changed) continue
    const compiled = compileRuntimeManifest(manifest)
    await database`
      update run_attempts
         set manifest = ${database.json(JSON.parse(compiled.canonicalJson))},
             manifest_sha256 = ${compiled.sha256}, legacy_manifest_sha256 = ${row.manifestSha256}
       where id = ${row.id} and legacy_manifest_sha256 is null
    `
  }
}

function isInlinePackage(value: unknown): value is SkillPackage {
  if (!value || typeof value !== 'object' || !('files' in value) || !Array.isArray(value.files)) return false
  return value.files.every(file => file && typeof file === 'object' && 'content' in file && typeof file.content === 'string')
}

function ensureSkillMarkdown(
  files: Array<{ path: string; content: string; sha256: string; size: number }>,
  name: string,
  description: string,
  instructions: string,
) {
  if (files.some(file => file.path === 'SKILL.md')) return files
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${instructions.trim()}\n`
  return [{ path: 'SKILL.md', content, size: Buffer.byteLength(content), sha256: hash(content) }, ...files]
}
