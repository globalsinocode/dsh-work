import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { RuntimeSkillConfiguration } from './postgres-skill-service.ts'
import { assertStartedSkillTest, evaluateAttemptEvidence, runtimeSkillFingerprint } from './skill-test-evidence.ts'

const manifest = { agent_configuration: { skill_instructions: [
  { id: 'skill-one', version: '1.0.0', files: [{ path: 'scripts/main.py', sha256: 'a'.repeat(64), size: 1 }] },
] } } as RuntimeManifest
function evidence() {
  return {
    attemptId: 'attempt-2', runStatus: 'succeeded', attemptStatus: 'succeeded', manifest,
    activations: [{ attemptId: 'attempt-2', skillId: 'skill-one', skillVersion: '1.0.0' }],
    pythonExecutions: [{ attemptId: 'attempt-2', skillId: 'skill-one', entry: 'scripts/main.py', succeeded: true }],
    events: [{ attemptId: 'attempt-2', eventType: 'assistant.completed', displayMessage: '完成' }],
  }
}
test('current successful Attempt with exact evidence passes', () => {
  assert.equal(evaluateAttemptEvidence(evidence()).passed, true)
})
test('old Attempt activation and Python evidence cannot make a retry pass', () => {
  const input = evidence()
  input.activations[0]!.attemptId = 'attempt-1'
  input.pythonExecutions[0]!.attemptId = 'attempt-1'
  assert.equal(evaluateAttemptEvidence(input).passed, false)
})
test('old assistant output is not the current Attempt result', () => {
  const input = evidence(); input.events[0]!.attemptId = 'attempt-1'
  assert.equal(evaluateAttemptEvidence(input).passed, false)
})
test('same Skill id with a different version is not activation evidence', () => {
  const input = evidence(); input.activations[0]!.skillVersion = '0.9.0'
  assert.equal(evaluateAttemptEvidence(input).passed, false)
})
test('undeclared Python entry, failed script and empty reply are insufficient', () => {
  let input = evidence(); input.pythonExecutions[0]!.entry = 'scripts/other.py'
  assert.equal(evaluateAttemptEvidence(input).passed, false)
  input = evidence(); input.pythonExecutions[0]!.succeeded = false
  assert.equal(evaluateAttemptEvidence(input).passed, false)
  input = evidence(); input.events[0]!.displayMessage = '   '
  assert.equal(evaluateAttemptEvidence(input).passed, false)
})
test('Run and Attempt must both be successful', () => {
  assert.equal(evaluateAttemptEvidence({ ...evidence(), runStatus: 'running' }).passed, false)
  assert.equal(evaluateAttemptEvidence({ ...evidence(), attemptStatus: 'failed' }).passed, false)
})
function skill(): RuntimeSkillConfiguration {
  return { id: 'root', version: '1.0.0', instructions: 'root instructions', tools: ['read@1.0.0'],
    dependencies: ['child@1.0.0'], dependencySkills: [{ id: 'child', version: '1.0.0', instructions: 'child instructions', tools: [] }] }
}
test('same-version instructions and transitive dependency changes invalidate the snapshot', () => {
  const original = skill(), changed = skill()
  changed.instructions += ' changed'
  assert.notEqual(runtimeSkillFingerprint(original), runtimeSkillFingerprint(changed))
  const dependencyChanged = skill(); dependencyChanged.dependencySkills![0]!.instructions += ' changed'
  assert.notEqual(runtimeSkillFingerprint(original), runtimeSkillFingerprint(dependencyChanged))
})
test('file, tool and invocation policy changes invalidate the snapshot', () => {
  const original = skill()
  assert.notEqual(runtimeSkillFingerprint(original), runtimeSkillFingerprint({ ...skill(), tools: ['write@1.0.0'] }))
  assert.notEqual(runtimeSkillFingerprint(original), runtimeSkillFingerprint({ ...skill(), disableModelInvocation: true }))
  assert.notEqual(runtimeSkillFingerprint(original), runtimeSkillFingerprint({ ...skill(), files: [{ path: 'data.txt', sha256: 'b'.repeat(64), size: 1 }] }))
})
test('metadata ordering is deterministic and dependency cycles fail closed', () => {
  assert.equal(runtimeSkillFingerprint({ ...skill(), tools: ['b', 'a'] }), runtimeSkillFingerprint({ ...skill(), tools: ['a', 'b'] }))
  const cyclic = skill(); cyclic.dependencySkills = [cyclic]
  assert.throws(() => runtimeSkillFingerprint(cyclic), /循环/)
})
test('absent legacy binding and current-vs-started mismatch require a new test', () => {
  const started = { versionId: 'v1', fingerprint: 'first', runtimeFingerprint: 'original' }
  assert.doesNotThrow(() => assertStartedSkillTest(started, started))
  assert.throws(() => assertStartedSkillTest({ ...started, fingerprint: 'changed' }, started), { code: 'skill_test_snapshot_changed' })
  assert.throws(() => assertStartedSkillTest(started, undefined), { code: 'skill_test_snapshot_changed' })
})
