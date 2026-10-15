/**
 * Errors that decide an HTTP response. The router maps `status`/`code` directly;
 * it never infers a status from message wording. Throw one of the factories below
 * whenever a failure is the caller's input, permissions, a missing or conflicting
 * object, or an unavailable dependency. A plain `Error` always becomes a 500 with
 * a trace ID, so an unexpected fault can never masquerade as a user mistake.
 */
export type RequestErrorCode =
  | 'invalid_request'
  | 'permission_denied'
  | 'resource_not_found'
  | 'state_conflict'
  | 'dependency_unavailable'
  | 'dependency_timeout'

export class RequestError extends Error {
  readonly status: number
  readonly code: string
  /** Next step shown to the user; the router falls back to a per-status default. */
  readonly suggestion?: string

  constructor(status: number, code: string, message: string, suggestion?: string) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
    if (suggestion !== undefined) this.suggestion = suggestion
  }
}

const suggestions: Record<RequestErrorCode, string> = {
  invalid_request: '按提示调整输入内容或文件后重新提交。',
  permission_denied: '确认当前账号、工作空间成员关系和数据范围；需要时联系管理员授权。',
  resource_not_found: '返回列表确认对象仍存在，然后重新选择。',
  state_conflict: '刷新对象状态后，按页面允许的操作继续。',
  dependency_unavailable: '请管理员检查运行时或连接器状态，恢复后再重试。',
  dependency_timeout: '稍后重试；若持续发生，请管理员检查运行时或连接器健康状态。',
}

const statuses: Record<RequestErrorCode, number> = {
  invalid_request: 422,
  permission_denied: 403,
  resource_not_found: 404,
  state_conflict: 409,
  dependency_unavailable: 503,
  dependency_timeout: 504,
}

function requestError(code: RequestErrorCode, message: string) {
  return new RequestError(statuses[code], code, message, suggestions[code])
}

/** 422: the request content is invalid; the user can fix it and resubmit. */
export const invalidRequest = (message: string) => requestError('invalid_request', message)
/**
 * 403 for an access check that is not an authorization decision of the run
 * revocation model. Use `authorizationDenied` for those (it also cancels runs).
 */
export const accessDenied = (message: string) => requestError('permission_denied', message)
/** 404: the object does not exist (or is hidden from this caller). */
export const notFound = (message: string) => requestError('resource_not_found', message)
/** 409: the object exists but its current state does not allow the operation. */
export const stateConflict = (message: string) => requestError('state_conflict', message)
/** 503: a dependency (Runtime, connector, sandbox, identity provider) is unavailable. */
export const dependencyUnavailable = (message: string) => requestError('dependency_unavailable', message)
/** 504: a dependency did not answer in time. The response names the affected object. */
export const dependencyTimeout = (message: string) => requestError('dependency_timeout', message)
