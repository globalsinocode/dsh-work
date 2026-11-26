import type { IncomingMessage } from 'node:http'

import type { ApiAudience, LocalAudienceConfiguration } from './types.ts'
import { LOCAL_PERMISSIONS } from './types.ts'
import { hasAdminAudienceAccess, hasModuleAdministrationAccess } from '../../domain/admin-permissions.ts'

/** 独立账号与钉钉免登共用的请求校验、Cookie 与访问控制工具。 */
export class IdentityAccessError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'IdentityAccessError'
    this.status = status
    this.code = code
  }
}

/**
 * 会话层只判断能否进入管理端：读请求需要任一管理端准入权限（模块管理、全模块或审计读取），
 * 写请求需要任一模块管理权限。具体模块与级别由路由对照表判定（功能规则第 13 节）。
 */
export function assertAudienceAccess(audience: ApiAudience, permissions: string[], unsafe: boolean) {
  const granted = new Set(permissions)
  if (audience === 'workbench') {
    if (!granted.has(LOCAL_PERMISSIONS.workbenchUse) && !granted.has(LOCAL_PERMISSIONS.workbenchManage)) {
      throw new IdentityAccessError(403, 'permission_denied', '当前用户没有员工工作台访问权限')
    }
    return
  }
  if (unsafe) {
    if (!hasModuleAdministrationAccess(granted)) {
      throw new IdentityAccessError(403, 'permission_denied', '当前用户没有管理写权限')
    }
    return
  }
  if (!hasAdminAudienceAccess(granted)) {
    throw new IdentityAccessError(403, 'permission_denied', '当前用户没有管理后台访问权限')
  }
}

export function normalizeReturnTo(value: string | null, portalOrigin: string) {
  const portal = new URL(`${portalOrigin.replace(/\/$/, '')}/`)
  if (!value) return portal.toString()
  try {
    const candidate = new URL(value, portal)
    if (candidate.origin !== portal.origin) return portal.toString()
    return candidate.toString()
  } catch {
    return portal.toString()
  }
}

export function validateRequestOrigin(
  request: IncomingMessage,
  settings: Pick<LocalAudienceConfiguration, 'allowedOrigins'>,
) {
  if (!isUnsafeMethod(request.method)) return
  const origin = request.headers.origin
  const requestOrigin = resolveRequestOrigin(request, settings)
  if (!origin || normalizeHeaderOrigin(origin) !== requestOrigin) {
    throw new IdentityAccessError(403, 'csrf_check_failed', '请求来源校验失败')
  }
}

export function resolveRequestOrigin(
  request: IncomingMessage,
  settings: Pick<LocalAudienceConfiguration, 'allowedOrigins'>,
) {
  const origin = requestOrigin(request)
  if (!settings.allowedOrigins.includes(origin)) {
    throw new IdentityAccessError(421, 'unknown_request_origin', '请求入口不在允许列表中')
  }
  return origin
}

function requestOrigin(request: IncomingMessage) {
  const forwardedProtocol = singleForwardedHeader(request.headers['x-forwarded-proto'])
  const forwardedHost = singleForwardedHeader(request.headers['x-forwarded-host'])
  const protocol = forwardedProtocol
    ?? ((request.socket as IncomingMessage['socket'] & { encrypted?: boolean }).encrypted ? 'https' : 'http')
  const host = forwardedHost ?? singleForwardedHeader(request.headers.host)
  if (!host || !['http', 'https'].includes(protocol)) {
    throw new IdentityAccessError(421, 'invalid_request_origin', '请求入口地址无效')
  }
  let origin: string
  try {
    origin = new URL(`${protocol}://${host}`).origin
  } catch {
    throw new IdentityAccessError(421, 'invalid_request_origin', '请求入口地址无效')
  }
  return origin
}

function singleForwardedHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new IdentityAccessError(421, 'invalid_request_origin', '请求入口地址无效')
    return singleForwardedHeader(value[0])
  }
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (normalized.includes(',') || /[\r\n]/.test(normalized)) {
    throw new IdentityAccessError(421, 'invalid_request_origin', '请求入口地址无效')
  }
  return normalized
}

function normalizeHeaderOrigin(value: string) {
  try {
    const parsed = new URL(value)
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * A top-level GET navigation carries no Origin header, so it cannot be checked like a
 * POST. Browsers label it with Sec-Fetch-Site; reject navigations started by another
 * site. Same-origin links, typed URLs and non-browser clients are unaffected.
 */
export function rejectCrossSiteNavigation(request: IncomingMessage) {
  const site = request.headers['sec-fetch-site']
  if ((Array.isArray(site) ? site : [site]).some(value => value?.trim().toLowerCase() === 'cross-site')) {
    throw new IdentityAccessError(403, 'csrf_check_failed', '请求来源校验失败')
  }
}

function isUnsafeMethod(method: string | undefined) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method ?? 'GET')
}

export function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {}
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (!name || !value) continue
    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      continue
    }
  }
  return cookies
}

export function serializeCookie(name: string, value: string, maxAge: number, secure: boolean) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function clearCookie(name: string, secure: boolean) {
  return serializeCookie(name, '', 0, secure)
}
