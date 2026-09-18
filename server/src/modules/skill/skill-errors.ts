/** Skill failures carry HTTP semantics without depending on Chinese message matching.
 * Unexpected DB/filesystem exceptions are not wrapped: they remain server failures.
 * A 500 here identifies a broken stored invariant, not invalid user input.
 */
export class SkillError extends Error {
  readonly status: 404 | 409 | 422 | 500 | 503
  readonly code: string

  constructor(status: SkillError['status'], code: string, message: string) {
    super(message)
    this.name = 'SkillError'
    this.status = status
    this.code = code
  }
}

export function skillNotFound(message: string, code = 'skill_not_found') { return new SkillError(404, code, message) }
export function skillConflict(message: string, code = 'skill_state_conflict') { return new SkillError(409, code, message) }
export function skillInvalid(message: string, code = 'skill_input_invalid') { return new SkillError(422, code, message) }
export function skillUnavailable(message: string) { return new SkillError(503, 'skill_service_unavailable', message) }
export function skillInternalFailure(message: string) { return new SkillError(500, 'skill_internal_error', message) }
