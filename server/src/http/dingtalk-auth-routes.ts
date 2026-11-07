import type { IncomingMessage } from 'node:http'

import { IdentityAccessError, type OidcAuthService } from '../modules/identity/auth-service.ts'
import type { DingTalkAuthService } from '../modules/identity/dingtalk/dingtalk-auth-service.ts'
import type { LocalAuthService } from '../modules/identity/local-auth-service.ts'
import { readJsonBody, type Router } from './router.ts'

/** 钉钉容器内免登与登录即绑定（钉钉接入方案 4.2、4.3）。只开放员工端。 */
export function registerDingTalkAuthRoutes(router: Router, dingtalk: DingTalkAuthService, local: LocalAuthService, oidc?: OidcAuthService | null) {
  router.post('/auth/workbench/dingtalk/login', async (request, _context, response) => {
    const input = await readObject<{ authCode?: unknown; returnTo?: unknown }>(request)
    const result = await dingtalk.login(request, input)
    if (result.status === 'binding_required') {
      response.setHeader('Cache-Control', 'no-store')
      return result
    }
    response.setHeader('Set-Cookie', oidc ? [result.sessionCookie, await oidc.revokeSession(request, 'workbench'), oidc.clearTransactionCookie('workbench')] : result.sessionCookie)
    return { status: result.status, location: result.location }
  })
  router.post('/auth/workbench/dingtalk/bind-login', async (request, _context, response) => {
    const input = await readObject<{ username: unknown; password: unknown; bindingToken?: unknown; returnTo?: string }>(request)
    if (typeof input.bindingToken !== 'string' || !input.bindingToken) {
      throw new IdentityAccessError(422, 'invalid_request', '缺少钉钉待绑定凭证')
    }
    const result = await local.login(request, 'workbench', input, { dingtalkTicket: input.bindingToken })
    response.setHeader('Set-Cookie', oidc ? [result.sessionCookie, await oidc.revokeSession(request, 'workbench'), oidc.clearTransactionCookie('workbench')] : result.sessionCookie)
    return { location: result.location, binding: result.dingtalkBinding }
  })
}

async function readObject<T extends object>(request: IncomingMessage): Promise<T> {
  const input = await readJsonBody<unknown>(request)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new IdentityAccessError(422, 'invalid_request', '请求体必须为 JSON 对象')
  }
  return input as T
}
