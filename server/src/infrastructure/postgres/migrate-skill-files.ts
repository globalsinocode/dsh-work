import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { FileSystemSkillArtifactStore } from '../../modules/skill/file-system-skill-artifact-store.ts'
import { migrateSkillFilesToFileSystem } from '../../modules/skill/skill-file-storage-migration.ts'
import { createDatabase } from './database.ts'
import { runMigrations } from './migration-runner.ts'

const databaseUrl = process.env.DSH_WORK_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_DATABASE_URL 未配置')

const projectRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const dataRoot = resolve(projectRoot, process.env.DSH_WORK_DATA_ROOT ?? '.runtime')
const store = new FileSystemSkillArtifactStore(resolve(dataRoot, 'skills'))
const database = createDatabase({ url: databaseUrl, maxConnections: 1 })

try {
  await runMigrations(database)
  const [before] = await database<{ versions: number; installations: number; attempts: number }[]>`
    select
      (select count(*)::int from skill_versions where artifact_ref is null) as versions,
      (select count(*)::int from skill_installations where (package is not null and package::text like '%"content"%') or (plan is not null and plan::text like '%"content"%')) as installations,
      (select count(*)::int from run_attempts where legacy_manifest_sha256 is null and manifest::text like '%"instructions"%') as attempts
  `
  await migrateSkillFilesToFileSystem(database, store)
  const [after] = await database<{ versions: number; installations: number; attempts: number }[]>`
    select
      (select count(*)::int from skill_versions where artifact_ref is null or instructions <> '' or manifest::text like '%"content"%') as versions,
      (select count(*)::int from skill_installations where (package is not null and package::text like '%"content"%') or (plan is not null and plan::text like '%"content"%')) as installations,
      (select count(*)::int from run_attempts where manifest::text like '%"instructions"%') as attempts
  `
  if (!after || after.versions || after.installations || after.attempts) {
    throw new Error(`Skill 文件迁移后仍有数据库正文：${JSON.stringify(after)}`)
  }
  console.log(JSON.stringify({ migrated: before, remaining: after, skillRoot: store.root }))
} finally {
  await database.end()
}
