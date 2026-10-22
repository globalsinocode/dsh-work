import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertObjectKey, ObjectNotFoundError } from '../../domain/object-storage.ts'
import { LocalObjectStorage } from './local-object-storage.ts'

async function storage(t: test.TestContext, options?: { fileMode?: number }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-storage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, store: new LocalObjectStorage(root, options) }
}

test('objects are written once and read back', async t => {
  const { root, store } = await storage(t, { fileMode: 0o400 })
  await store.putIfAbsent('session-files/s1/f1.txt', Buffer.from('first'))
  await store.putIfAbsent('session-files/s1/f1.txt', Buffer.from('second'))
  assert.equal((await store.get('session-files/s1/f1.txt')).toString(), 'first')
  assert.equal((await stat(join(root, 'session-files/s1/f1.txt'))).mode & 0o777, 0o400)
  assert.deepEqual(await readdir(join(root, 'session-files/s1')), ['f1.txt'])
})

test('concurrent writers of one key leave exactly one complete object', async t => {
  const { store } = await storage(t)
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.putIfAbsent('a/b', Buffer.from(`v${index}`.repeat(1000)))))
  assert.match((await store.get('a/b')).toString(), /^(v\d){1000}$/)
})

test('deleteIfExists removes only the exact validated object key', async t => {
  const { store } = await storage(t)
  await store.putIfAbsent('workspace-files/a/object.bin', Buffer.from('x'))
  assert.equal(await store.deleteIfExists('workspace-files/a/object.bin'), true)
  assert.equal(await store.deleteIfExists('workspace-files/a/object.bin'), false)
  await assert.rejects(store.deleteIfExists('../outside'), /非法存储键/)
})

test('missing objects, unsafe keys and symlinks are rejected', async t => {
  const { root, store } = await storage(t)
  await assert.rejects(store.get('missing/key'), ObjectNotFoundError)
  for (const key of ['', '/abs', '../escape', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\0b']) {
    assert.throws(() => assertObjectKey(key), /非法存储键/, key)
    await assert.rejects(store.putIfAbsent(key, Buffer.from('x')), /非法存储键/)
  }
  await writeFile(join(root, 'real'), 'secret')
  await symlink(join(root, 'real'), join(root, 'link'))
  await assert.rejects(store.get('link'), { code: 'ELOOP' })
})
