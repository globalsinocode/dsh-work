import { RequestError } from './request-errors.ts'

/**
 * Typed authorization denial (1A-T5).
 *
 * The revocation sweep must cancel in-flight runs ONLY for a real authorization
 * denial, never for an infrastructure failure, and the HTTP layer must answer
 * 403. Both used to depend on matching the Chinese message text, so any new
 * denial message silently stopped cancelling runs (or answered 500).
 *
 * Carrying an explicit `status`/`code` fixes both: the router's typed-error
 * branch maps it to 403 and `isAuthorizationDenial` recognizes it by identity.
 * Prefer this over a bare `Error` for every authorization decision that can
 * deny a request or revoke a run.
 */
export class AuthorizationDeniedError extends RequestError {
  /**
   * An authorization decision is a denial (the revocation sweep cancels runs on it)
   * whatever the HTTP answer. A few configuration checks deny execution but answer
   * the editing request as invalid input or a missing object; they pass `http`.
   */
  constructor(message: string, http: { status: number; code: string; suggestion?: string } = { status: 403, code: 'authorization_denied' }) {
    super(http.status, http.code, message, http.suggestion)
    this.name = 'AuthorizationDeniedError'
  }
}

export function authorizationDenied(message: string, http?: { status: number; code: string; suggestion?: string }): AuthorizationDeniedError {
  return new AuthorizationDeniedError(message, http)
}

/** Stable 403 codes the admin/workbench clients use to refresh identity without replaying requests. */
export const AUTHORIZATION_CHANGE_RESPONSE_CODES = [
  'authorization_denied',
  'permission_revoked',
  'role_disabled',
  'data_scope_revoked',
] as const

export type AuthorizationChangeResponseCode = typeof AUTHORIZATION_CHANGE_RESPONSE_CODES[number]

export function isAuthorizationChangeResponseCode(code: string): code is AuthorizationChangeResponseCode {
  return (AUTHORIZATION_CHANGE_RESPONSE_CODES as readonly string[]).includes(code)
}

/** Maps internal denial codes to the closed client-facing revocation set (403 only). */
export function publicAuthorizationResponseCode(code: string): AuthorizationChangeResponseCode {
  if (isAuthorizationChangeResponseCode(code)) return code
  if (code === 'permission_denied') return 'authorization_denied'
  return 'authorization_denied'
}

/** True only for an explicit authorization denial, recognised by type, never by wording. */
export function isAuthorizationDenial(error: unknown): boolean {
  return error instanceof AuthorizationDeniedError
}

/**
 * Read-access check for a team-workspace object, shared by every 1A/1B read
 * surface (runs, tasks, files, artifacts). Kept in one place because the
 * existence branch is a security decision, not a detail: a missing workspace
 * must fail CLOSED. Duplicating this branch is how file/artifact reads and run
 * reads drift apart.
 *
 * 3-T1 dual track (归档 = 只读保留): the READ track resolves the workspace type
 * with `readableWorkspaceTypeOf` so an ARCHIVED team workspace is still
 * visible, then requires CURRENT membership through `authorizeTeamReadAccess`
 * (which is called here with an explicit `allowArchived: true`; the method's
 * OWN default stays active-only, so a caller that forgets to decide fails closed).
 * A removed member, a nonexistent
 * workspace or an unknown status still denies. Execution stays untouched:
 * `workspaceTypeOf`, `requireTeamRole` and `requireWorkspaceMembership` keep
 * their active-only default and are the only resolvers that write/run paths
 * may use.
 *
 * Personal workspaces keep the caller's existing path (AC-23). Only an
 * explicit authorization denial is translated to `false`; infrastructure
 * failures propagate so they cannot masquerade as a permission decision.
 */
export interface TeamReadAccessChecker {
  /** Status-agnostic: resolves 'team' for an archived workspace as well. */
  readableWorkspaceTypeOf(workspaceId: string | null | undefined): Promise<'personal' | 'team' | null>
  /** Read gate: the caller opts in explicitly, so archived is accepted. */
  authorizeTeamReadAccess(
    workspaceId: string,
    userId: string,
    options: { allowArchived: boolean; ttlMs?: number },
  ): Promise<void>
}

export async function canReadWorkspaceObject(
  authorization: TeamReadAccessChecker,
  workspaceId: string | null | undefined,
  userId: string,
  /**
   * 授权缓存 TTL 覆盖。SSE 逐批门禁需要它来控制「多久重新完整复核一次」；
   * 不传时用授权服务的默认值（≤10s）。漏传会让调用点传入的 TTL 被静默忽略。
   */
  options: { ttlMs?: number } = {},
): Promise<boolean> {
  if (!workspaceId) return true
  const workspaceType = await authorization.readableWorkspaceTypeOf(workspaceId)
  if (workspaceType === 'personal') return true
  if (workspaceType === null) return false
  try {
    await authorization.authorizeTeamReadAccess(workspaceId, userId, { allowArchived: true, ttlMs: options.ttlMs })
    return true
  } catch (error) {
    if (isAuthorizationDenial(error)) return false
    throw error
  }
}

/**
 * Typed request-validation rejection (HTTP 422). `classifyHttpError` recognises some
 * wording by regex, so a validation message whose text changes silently becomes a 500;
 * carrying the status explicitly removes that failure mode, mirroring
 * `authorizationDenied` for 403. Services outside the HTTP layer use this instead of
 * importing `routeValidationFailed` from the router (that would invert the layering).
 */
export class RequestValidationError extends RequestError {
  constructor(message: string) {
    super(422, 'invalid_request', message)
    this.name = 'RequestValidationError'
  }
}

export function requestInvalid(message: string): RequestValidationError {
  return new RequestValidationError(message)
}
