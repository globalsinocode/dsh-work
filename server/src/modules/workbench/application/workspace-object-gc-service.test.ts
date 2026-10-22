import assert from 'node:assert/strict'
import test from 'node:test'

import type { ObjectStorage } from '../../../domain/object-storage.ts'
import { WorkspaceObjectGcService } from './workspace-object-gc-service.ts'

function mockStorage() {
  return {
    deleteIfExists: test.mock.fn(async () => true),
  } satisfies Pick<ObjectStorage, 'deleteIfExists'>
}

function mockRepository() {
  return {
    listDue: test.mock.fn(async () => [] as Array<{ storageKey: string; objectSha256: string; attempts: number }>),
    isReferenced: test.mock.fn(async () => false),
    markDeleted: test.mock.fn(async () => {}),
    markRetained: test.mock.fn(async () => {}),
    markFailed: test.mock.fn(async () => {}),
    upsertCandidate: test.mock.fn(async () => {}),
  }
}

test('sweep deletes a due candidate only when no metadata row references the key', async () => {
  const repository = mockRepository()
  const storage = mockStorage()
  repository.listDue.mock.mockImplementation(async () => [{ storageKey: 'workspace-files/a.bin', objectSha256: 'a'.repeat(64), attempts: 0 }])
  repository.isReferenced.mock.mockImplementation(async () => false)
  const service = new WorkspaceObjectGcService({} as never, storage as unknown as ObjectStorage, repository as never)
  await service.sweep(10)
  assert.equal(storage.deleteIfExists.mock.callCount(), 1)
  assert.equal(repository.markDeleted.mock.callCount(), 1)
})

test('sweep retains a candidate that became referenced', async () => {
  const repository = mockRepository()
  const storage = mockStorage()
  repository.listDue.mock.mockImplementation(async () => [{ storageKey: 'workspace-files/a.bin', objectSha256: 'a'.repeat(64), attempts: 0 }])
  repository.isReferenced.mock.mockImplementation(async () => true)
  const service = new WorkspaceObjectGcService({} as never, storage as unknown as ObjectStorage, repository as never)
  await service.sweep(10)
  assert.equal(storage.deleteIfExists.mock.callCount(), 0)
  assert.equal(repository.markRetained.mock.callCount(), 1)
})
