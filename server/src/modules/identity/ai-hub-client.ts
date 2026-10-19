import { identityHttpTimeoutMs } from './identity-http-timeout.ts'
import type {
  AdminBootstrapClaim,
  CurrentPlatformUser,
  DirectoryPage,
} from './types.ts'

export class AiHubApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AiHubApiError'
    this.status = status
    this.code = code
  }
}

export class AiHubClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  me(accessToken: string, applicationId: string) {
    return this.request<CurrentPlatformUser>('/platform-api/v1/me', accessToken, applicationId)
  }

  claimAdminBootstrap(
    accessToken: string,
    applicationId: string,
    environment: string,
  ) {
    return this.request<AdminBootstrapClaim>(
      `/platform-api/v1/applications/${encodeURIComponent(applicationId)}/environments/${encodeURIComponent(environment)}/admin-bootstrap`,
      accessToken,
      applicationId,
      { method: 'POST' },
    )
  }

  directoryUsers(
    accessToken: string,
    applicationId: string,
    input: { cursor?: string | null; limit?: number } = {},
  ) {
    const query = new URLSearchParams({ limit: String(input.limit ?? 100) })
    if (input.cursor) query.set('cursor', input.cursor)
    return this.request<DirectoryPage>(
      `/platform-api/v1/directory/users?${query.toString()}`,
      accessToken,
      applicationId,
    )
  }

  private async request<T>(
    path: string,
    accessToken: string,
    applicationId: string,
    init?: RequestInit,
  ): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Application-ID': applicationId,
          'X-Request-ID': `dsh-work-${crypto.randomUUID()}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
        signal: AbortSignal.timeout(identityHttpTimeoutMs()),
      })
    } catch {
      throw new AiHubApiError(503, 'ai_hub_unavailable', 'AI Hub Platform API 当前不可用')
    }
    const payload = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const errorPayload = payload && typeof payload === 'object'
        ? (payload as { error_code?: unknown; message?: unknown })
        : null
      throw new AiHubApiError(
        response.status,
        typeof errorPayload?.error_code === 'string' ? errorPayload.error_code : 'ai_hub_request_failed',
        typeof errorPayload?.message === 'string' && errorPayload.message
          ? errorPayload.message
          : response.status === 401 || response.status === 403
            ? 'AI Hub 身份校验未通过'
            : 'AI Hub Platform API 请求失败',
      )
    }
    if (!payload || typeof payload !== 'object') {
      throw new AiHubApiError(502, 'invalid_ai_hub_response', 'AI Hub Platform API 响应无效')
    }
    return payload as T
  }
}
