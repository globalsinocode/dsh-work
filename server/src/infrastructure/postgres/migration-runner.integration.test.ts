import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createDatabase } from './database.ts'
import { migrationChecksum, runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

let db: ThrowawayDatabase
let directory: string
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'dsh_migration_runner_test', migrate: false })
  directory = await mkdtemp(join(tmpdir(), 'dsh-migrations-'))
  await writeFile(join(directory, '0001_counter.sql'), 'create table counter (n integer not null);\ninsert into counter values (0);\n')
  await writeFile(join(directory, '0002_increment.sql'), 'update counter set n = n + 1;\n')
})
after(async () => {
  await db?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('concurrent starts apply each migration exactly once', async () => {
  // Separate pools stand in for separate service processes.
  const clients = Array.from({ length: 4 }, () => createDatabase({ url: db.url, maxConnections: 2 }))
  try {
    const results = await Promise.all(clients.map(client => runMigrations(client, directory)))
    for (const version of ['0001_counter.sql', '0002_increment.sql']) {
      assert.equal(results.flat().filter(item => item.version === version && item.applied).length, 1, version)
    }
  } finally { await Promise.all(clients.map(client => client.end())) }
  const [counter] = await db.client<{ n: number }[]>`select n from counter`
  assert.equal(counter?.n, 1)
  const rows = await db.client<{ version: string; checksum: string }[]>`select version, checksum from schema_migrations order by version`
  assert.deepEqual(rows.map(row => row.checksum), [
    migrationChecksum('create table counter (n integer not null);\ninsert into counter values (0);\n'),
    migrationChecksum('update counter set n = n + 1;\n'),
  ])
})

test('rows recorded before checksums are backfilled once, and an edited applied migration stops startup', async () => {
  await db.client`update schema_migrations set checksum = null where version = '0002_increment.sql'`
  await runMigrations(db.client, directory)
  const [row] = await db.client<{ checksum: string }[]>`select checksum from schema_migrations where version = '0002_increment.sql'`
  assert.equal(row?.checksum, migrationChecksum('update counter set n = n + 1;\n'))

  // Only line endings differ: not an edit.
  await writeFile(join(directory, '0002_increment.sql'), 'update counter set n = n + 1;\r\n')
  await runMigrations(db.client, directory)

  await writeFile(join(directory, '0002_increment.sql'), 'update counter set n = n + 100;\n')
  await assert.rejects(runMigrations(db.client, directory), /0002_increment\.sql 已执行过，但文件内容已被修改/)
  const [counter] = await db.client<{ n: number }[]>`select n from counter`
  assert.equal(counter?.n, 1, 'the edited text never runs')
})
