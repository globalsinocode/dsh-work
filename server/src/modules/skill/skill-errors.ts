/** Skill failures carry HTTP semantics without depending on Chinese message matching.
 * Unexpected DB/filesystem exceptions are not wrapped: they remain server failures.
 * A 500 here identifies a broken stored invariant, not invalid user input.
 */
export class SkillError extends Error {
  readonly status: 404 | 409 | 422 | 500 | 503
  readonly code: string
  /** 给出时替代 Router 按状态码给的通用建议。 */
  readonly suggestion?: string

  constructor(status: SkillError['status'], code: string, message: string, suggestion?: string) {
    super(message)
    this.name = 'SkillError'
    this.status = status
    this.code = code
    if (suggestion !== undefined) this.suggestion = suggestion
  }
}

export function skillNotFound(message: string, code = 'skill_not_found') { return new SkillError(404, code, message) }
export function skillConflict(message: string, code = 'skill_state_conflict', suggestion?: string) { return new SkillError(409, code, message, suggestion) }
export function skillInvalid(message: string, code = 'skill_input_invalid') { return new SkillError(422, code, message) }
export function skillUnavailable(message: string) { return new SkillError(503, 'skill_service_unavailable', message) }
export function skillInternalFailure(message: string) { return new SkillError(500, 'skill_internal_error', message) }
