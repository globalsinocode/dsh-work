import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertRealWorkspaceDirectory } from './workspace-directory.ts'
import { readCheckpointWorkspaceFiles } from '../../modules/runtime/dsh-acp-runtime-adapter.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import type { RuntimeManifest } from '../../modules/runtime/runtime-types.ts'

async function fixture() {
  // tmpdir() is a symlinked path on macOS (/var → /private/var); the check must cope with that.
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-dir-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'host-documents')
  await mkdir(join(workspace, 'output'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, 'secret.md'), '# host secret\n')
  return { root, workspace, outside, output: join(workspace, 'output') }
}

test('a real output directory passes; a missing one is reported; a replaced one is refused', async () => {
  const { root, workspace, outside, output } = await fixture()
  try {
    assert.equal(await assertRealWorkspaceDirectory(workspace, output), true)
    assert.equal(await assertRealWorkspaceDirectory(await realpath(workspace), join(await realpath(workspace), 'output')), true)
    assert.equal(await assertRealWorkspaceDirectory(workspace, join(workspace, 'missing')), false)
    await rm(output, { recursive: true })
    await symlink(outside, output)
    await assert.rejects(assertRealWorkspaceDirectory(workspace, output), /不是真实目录/)
    await rm(output)
    await writeFile(output, 'not a directory')
    await assert.rejects(assertRealWorkspaceDirectory(workspace, output), /不是真实目录/)
    await assert.rejects(assertRealWorkspaceDirectory(workspace, outside), /不在工作区内/)
    await assert.rejects(assertRealWorkspaceDirectory(workspace, workspace), /不在工作区内/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('checkpoint reading refuses an output directory replaced by a link to the host', async () => {
  const { root, workspace, outside, output } = await fixture()
  try {
    await writeFile(join(output, 'draft.md'), '# draft\n')
    assert.deepEqual((await readCheckpointWorkspaceFiles(output, workspace)).map(file => file.path), ['output/draft.md'])
    await rm(output, { recursive: true })
    await symlink(outside, output)
    await assert.rejects(readCheckpointWorkspaceFiles(output, workspace), /不是真实目录/)
    assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), '# host secret\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact publishing refuses a replaced output directory before touching the database', async () => {
  const { root, workspace, outside, output } = await fixture()
  try {
    await rm(output, { recursive: true })
    await symlink(outside, output)
    const unusedDatabase = new Proxy({}, { get() { throw new Error('the database must not be reached') } })
    const content = new PostgresContentService(unusedDatabase as never, {} as never, {} as never)
    const manifest = { purpose: undefined, workspace_id: 'ws-1', user_context: { user_id: 'U1' } } as unknown as RuntimeManifest
    await assert.rejects(content.publishRuntimeArtifacts({ manifest, workspaceDirectory: workspace }), /不是真实目录/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
