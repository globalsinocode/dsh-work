import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FAILED_WORKSPACE_RETENTION_MS, retireAttemptWorkspace, sweepAttemptWorkspaces } from './attempt-workspace-retention.ts'
import { formatBytes, freeSpace, measureWorkspace, overWorkspaceLimit, WORKSPACE_LIMITS } from './workspace-usage.ts'

async function scratch(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('measures allocated blocks of one workspace, without following links', async t => {
  const root = await scratch(t)
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'work'), { recursive: true })
  await writeFile(join(workspace, 'work', 'data.bin'), Buffer.alloc(1024 * 1024, 1))
  // Outside the workspace: a link to it must not count its size.
  await writeFile(join(root, 'outside.bin'), Buffer.alloc(4 * 1024 * 1024, 1))
  await symlink(join(root, 'outside.bin'), join(workspace, 'link.bin'))
  // A sparse file claims 1 GiB but allocates almost nothing.
  const sparse = await open(join(workspace, 'sparse.bin'), 'w')
  await sparse.truncate(1024 ** 3)
  await sparse.close()

  const usage = await measureWorkspace(workspace)
  assert.equal(usage.truncated, false)
  assert.equal(usage.entries, 4)
  assert.ok(usage.bytes >= 1024 * 1024, `counts the real file (${usage.bytes})`)
  assert.ok(usage.bytes < 3 * 1024 * 1024, `ignores the linked file and the sparse size (${usage.bytes})`)
  assert.deepEqual(await measureWorkspace(join(root, 'missing')), { bytes: 0, entries: 0, truncated: false })
})

test('too many entries counts as over the cap', async t => {
  const root = await scratch(t)
  for (let index = 0; index < 12; index += 1) await writeFile(join(root, `f${index}`), 'x')
  const usage = await measureWorkspace(root, 10)
  assert.equal(usage.truncated, true)
  assert.equal(overWorkspaceLimit(usage), true)
  assert.equal(overWorkspaceLimit({ bytes: WORKSPACE_LIMITS.maxBytes, entries: 1, truncated: false }), false)
  assert.equal(overWorkspaceLimit({ bytes: WORKSPACE_LIMITS.maxBytes + 1, entries: 1, truncated: false }), true)
})

test('reports free space on the data volume and formats sizes', async t => {
  const root = await scratch(t)
  const space = await freeSpace(root)
  assert.ok(space.freeBytes > 0 && space.totalBytes >= space.freeBytes)
  assert.equal(typeof space.low, 'boolean')
  assert.equal(formatBytes(2 * 1024 ** 3), '2 GB')
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB')
  assert.equal(formatBytes(300 * 1024 ** 2), '300 MB')
})

test('an ended Attempt keeps its workspace only when it failed', async t => {
  const root = await scratch(t)
  for (const [name, status] of [['done', 'completed'], ['cancelled', 'cancelled'], ['waiting', 'waiting'], ['failed', 'failed']]) {
    const attempt = join(root, name!)
    await mkdir(join(attempt, 'workspace', 'work'), { recursive: true })
    await writeFile(join(attempt, 'manifest.json'), '{}')
    await retireAttemptWorkspace(attempt, status!, new Date('2026-10-27T00:00:00Z'))
  }
  const exists = async (path: string) => (await open(path, 'r').then(file => file.close().then(() => true), () => false))
  for (const name of ['done', 'cancelled', 'waiting']) {
    assert.equal(await exists(join(root, name, 'workspace')), false, name)
    assert.equal(await exists(join(root, name, 'manifest.json')), true, `${name} keeps its metadata`)
  }
  assert.equal(await exists(join(root, 'failed', 'workspace')), true)
})

test('the sweep removes what the rules no longer keep and skips running Attempts', async t => {
  const root = await scratch(t)
  const now = Date.parse('2026-10-27T12:00:00Z')
  const old = new Date(now - FAILED_WORKSPACE_RETENTION_MS - 60_000)
  const recent = new Date(now - 60_000)
  const attempt = async (name: string, end?: { status: string; at: Date }, touched = recent) => {
    const directory = join(root, 'tenant-a', `run-${name}`, `attempt-${name}`)
    await mkdir(join(directory, 'workspace'), { recursive: true })
    if (end) await writeFile(join(directory, 'attempt-end.json'), JSON.stringify({ status: end.status, endedAt: end.at.toISOString() }))
    await utimes(directory, touched, touched)
    return directory
  }
  const completed = await attempt('completed', { status: 'completed', at: recent })
  const failedRecently = await attempt('failed-recent', { status: 'failed', at: recent })
  const failedLongAgo = await attempt('failed-old', { status: 'failed', at: old })
  const historicOld = await attempt('historic-old', undefined, old)
  const historicRecent = await attempt('historic-recent', undefined, recent)
  const running = await attempt('running', undefined, old)

  const result = await sweepAttemptWorkspaces(root, { now, isActive: directory => directory === running })
  const left = async (directory: string) => (await open(join(directory, 'workspace'), 'r').then(file => file.close().then(() => true), () => false))
  assert.deepEqual({
    completed: await left(completed), failedRecently: await left(failedRecently), failedLongAgo: await left(failedLongAgo),
    historicOld: await left(historicOld), historicRecent: await left(historicRecent), running: await left(running),
  }, { completed: false, failedRecently: true, failedLongAgo: false, historicOld: false, historicRecent: true, running: true })
  assert.deepEqual(result, { inspected: 5, removed: 3 })
})
