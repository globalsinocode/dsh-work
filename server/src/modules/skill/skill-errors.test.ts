import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyHttpError } from '../../http/router.ts'
import { skillConflict, skillInternalFailure, skillInvalid, skillNotFound, skillUnavailable } from './skill-errors.ts'
import { runtimeSkillFingerprint } from './skill-test-evidence.ts'
import type { RuntimeSkillConfiguration } from './postgres-skill-service.ts'

for (const [create, status, code] of [
  [skillNotFound, 404, 'skill_not_found'], [skillConflict, 409, 'skill_state_conflict'],
  [skillInvalid, 422, 'skill_input_invalid'], [skillUnavailable, 503, 'skill_service_unavailable'],
] as const) {
  test(`Skill ${status} is independent of message language and regexes`, () => {
    const error = create('opaque fixture condition')
    const response = classifyHttpError(error, '/api/admin/v1/skills/test')
    assert.equal(response.status, status); assert.equal(response.error.code, code)
    assert.ok(response.error.suggestion)
  })
}
test('broken stored invariant is a sanitized 500, not caller validation or exposed internals', () => {
  const response = classifyHttpError(skillInternalFailure('Skill 文件夹索引缺失 /private/data'), '/api/admin/v1/skills/test')
  assert.equal(response.status, 500); assert.equal(response.error.code, 'skill_internal_error')
  assert.doesNotMatch(response.error.message, /索引|private/)
  assert.match(response.error.suggestion, new RegExp(response.error.traceId))
})
test('cyclic test dependency is a typed domain conflict, not an unclassified exception', () => {
  const skill: RuntimeSkillConfiguration = { id: 'skill-cycle', version: '1.0.0', instructions: 'fixture', tools: [] }
  skill.dependencySkills = [skill]
  assert.throws(() => runtimeSkillFingerprint(skill), { status: 409, code: 'skill_dependency_conflict' })
})
