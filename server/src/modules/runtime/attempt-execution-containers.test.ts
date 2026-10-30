import assert from 'node:assert/strict'
import { test } from 'node:test'
import { removedExecutionSettingWarnings } from './attempt-execution-containers.ts'

test('removed execution settings are reported once each and never re-enable host execution', () => {
  assert.deepEqual(removedExecutionSettingWarnings({ DSH_WORK_EXECUTION_IMAGE: 'image@sha256:abc' }), [])
  const warnings = removedExecutionSettingWarnings({
    DSH_WORK_EXECUTION_CONTAINER: 'off', DSH_WORK_PYTHON_IMAGE: 'x', DSH_WORK_PYTHON_PACKAGES: '', DSH_WORK_PYTHON_USER: '1:1', DSH_WORK_EXECUTION_MAX_CONTAINERS: '4',
  })
  assert.equal(warnings.length, 5)
  assert.match(warnings[0]!, /DSH_WORK_EXECUTION_CONTAINER is removed and ignored.*"off" no longer runs DSH on the host/)
  for (const name of ['DSH_WORK_PYTHON_IMAGE', 'DSH_WORK_PYTHON_PACKAGES', 'DSH_WORK_PYTHON_USER', 'DSH_WORK_EXECUTION_MAX_CONTAINERS']) {
    assert.ok(warnings.some(warning => warning.startsWith(`${name} is removed and ignored`)), name)
  }
})
