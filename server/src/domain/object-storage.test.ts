import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { joinObjectKey } from './object-storage.ts'

describe('joinObjectKey', () => {
  it('uses forward slashes regardless of host OS', () => {
    const key = joinObjectKey('artifact-files', 'task-c02b415b-6e4d-481b-920c-03288a9e07e6', 'file-artifact-abc.md')
    assert.equal(key, 'artifact-files/task-c02b415b-6e4d-481b-920c-03288a9e07e6/file-artifact-abc.md')
    assert.doesNotThrow(() => joinObjectKey('extractions', 'file-1', 'm4-basic-v1.txt'))
  })
})
