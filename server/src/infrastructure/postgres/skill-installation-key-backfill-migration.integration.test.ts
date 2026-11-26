import assert from 'node:assert/strict'
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

// 迁移 0130：先迁到 0129，写入没有安装名称的旧数据，再执行 0130。
const migrations = resolve(import.meta.dirname, '../../../migrations')
const tenantId = 'tenant-dsh-work', actor = 'U00008'
let database: ThrowawayDatabase | undefined
let baseline: string | undefined
after(async () => {
  await database?.dispose()
  if (baseline) await rm(baseline, { recursive: true, force: true })
})

test('0130 backfills installation_key for legacy Skills without taking submission or occupied names', async () => {
  baseline = await mkdtemp(join(tmpdir(), 'dsh-0130-baseline-'))
  for (const file of await readdir(migrations)) {
    if (file.endsWith('.sql') && file < '0130') await cp(join(migrations, file), join(baseline, file))
  }
  database = await createThrowawayDatabase({ namePrefix: 'dsh_0130', migrationsDirectory: baseline })
  const sql = database.client
  const skill = async (id: string, name: string, status: 'draft' | 'disabled', installationKey: string | null = null) => {
    await sql`
      insert into skills (id, tenant_id, key, installation_key, name, category, description, owner_user_id, created_by, status)
      values (${id}, ${tenantId}, ${id}, ${installationKey}, ${name}, '测试', '迁移 0130 的合成数据。', ${actor}, ${actor}, ${status})
    `
  }
  const version = async (skillId: string, createdAt: string) => {
    await sql`
      insert into skill_versions (id, tenant_id, skill_id, version, name, category, description, instructions, manifest,
                                  tool_refs, test_prompt, status, created_by, change_summary, created_at)
      values (${`${skillId}-v1`}, ${tenantId}, ${skillId}, '0.1.0', ${skillId}, '测试', '迁移 0130 的合成数据。', '旧文本正文',
              '{}'::jsonb, '[]'::jsonb, '验证迁移 0130。', 'draft', ${actor}, '迁移 0130 合成数据', ${createdAt})
    `
  }
  // 同名的旧文本 Skill：停用的那行版本更早，仍应选未停用的；名称比较忽略首尾空白与大小写。
  await skill('skill-legacy-disabled', 'Legacy Report', 'disabled'); await version('skill-legacy-disabled', '2026-01-01T00:00:00Z')
  await skill('skill-legacy-later', ' legacy report ', 'draft'); await version('skill-legacy-later', '2026-03-01T00:00:00Z')
  await skill('skill-legacy-live', 'LEGACY REPORT', 'draft'); await version('skill-legacy-live', '2026-02-01T00:00:00Z')
  // 名称已被安装来源的 Skill 占用。
  await skill('skill-installed', 'Installed Thing', 'draft', 'installed thing')
  await skill('skill-installed-copy', 'installed thing', 'draft')
  // 员工提交审核中存下的 Skill：通过审核前不占用名称。
  await skill('skill-submission', 'Employee Draft', 'draft')
  await sql`
    insert into skill_submissions (id, tenant_id, submitter_user_id, source, name, skill_id, status)
    values ('submission-0130', ${tenantId}, 'U00001', 'zip', 'Employee Draft', 'skill-submission', 'pending')
  `

  await runMigrations(sql, migrations)

  const keys = Object.fromEntries((await sql<{ id: string; key: string | null }[]>`
    select id, installation_key as key from skills where tenant_id = ${tenantId} order by id
  `).map(row => [row.id, row.key]))
  assert.deepEqual(keys, {
    'skill-document': '文档处理',
    'skill-installed': 'installed thing',
    'skill-installed-copy': null,
    'skill-legacy-disabled': null,
    'skill-legacy-later': null,
    'skill-legacy-live': 'legacy report',
    'skill-submission': null,
  })
})
