import type {
  ApiAudience,
  IdentityConfiguration,
  LocalAudienceConfiguration,
} from './types.ts'
import { invalidRequest, stateConflict } from '../../domain/request-errors.ts'

/** AI Hub 登录已删除（删除 AI Hub 登录方案 AH3）：这些旧变量不再读取，启动时只记警告。 */
const ignoredLegacyVariable = /^(?:AI_HUB_[A-Z0-9_]+|DSH_WORK_OIDC_[A-Z0-9_]+|DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS|DSH_WORK_ADMIN_BOOTSTRAP_ENABLED)$/

/** 启动配置：账号密码登录始终可用；残留的 AI Hub 变量与旧认证模式只记入 ignoredLegacySettings。 */
export function loadStartupIdentityConfiguration(environment: NodeJS.ProcessEnv = process.env): IdentityConfiguration {
  const configuration = loadIdentityConfiguration(environment)
  const ignored = Object.entries(environment)
    .filter(([key, value]) => ignoredLegacyVariable.test(key) && value?.trim())
    .map(([key]) => key)
  if (environment.DSH_WORK_AUTH_MODE) ignored.push('DSH_WORK_AUTH_MODE')
  return ignored.length ? { ...configuration, ignoredLegacySettings: ignored.sort() } : configuration
}

export function loadIdentityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): IdentityConfiguration {
  const production = environment.NODE_ENV === 'production'
  const legacyMode = environment.DSH_WORK_AUTH_MODE
  if (legacyMode === 'prototype') throw new Error('原型模式已移除：请删除 DSH_WORK_AUTH_MODE=prototype 并配置 PostgreSQL，使用账号密码登录')
  if (legacyMode && legacyMode !== 'local' && legacyMode !== 'oidc') {
    throw invalidRequest('DSH_WORK_AUTH_MODE 无需设置；旧 local/oidc 值会被忽略')
  }

  const sessionSecret = required(environment, 'DSH_WORK_SESSION_SECRET')
  if (sessionSecret.length < 32) throw invalidRequest('DSH_WORK_SESSION_SECRET 至少需要 32 个字符')
  if (production && placeholderSecret(sessionSecret)) {
    throw stateConflict('生产环境的 DSH_WORK_SESSION_SECRET 不能使用占位值')
  }

  const cookieSecure = booleanValue(
    environment.DSH_WORK_COOKIE_SECURE,
    production,
    'DSH_WORK_COOKIE_SECURE',
  )
  if (production && !cookieSecure) throw invalidRequest('生产环境必须启用 Secure Session Cookie')

  return {
    mode: 'local',
    sessionSecret,
    cookieSecure,
    sessionTtlSeconds: positiveInteger(environment.DSH_WORK_SESSION_TTL_SECONDS, 8 * 60 * 60, 'DSH_WORK_SESSION_TTL_SECONDS'),
    audiences: {
      workbench: localAudienceConfiguration(environment, 'workbench', production),
      admin: localAudienceConfiguration(environment, 'admin', production),
    },
  }
}

function localAudienceConfiguration(
  environment: NodeJS.ProcessEnv,
  audience: ApiAudience,
  production: boolean,
): LocalAudienceConfiguration {
  const prefix = audience === 'workbench' ? 'DSH_WORK_WORKBENCH' : 'DSH_WORK_ADMIN'
  const allowedOrigins = originList(required(environment, `${prefix}_ORIGINS`), `${prefix}_ORIGINS`, production)
  const defaultOrigin = environment[`${prefix}_DEFAULT_ORIGIN`]?.trim()
    ? normalizedOrigin(environment[`${prefix}_DEFAULT_ORIGIN`]!, `${prefix}_DEFAULT_ORIGIN`, production)
    : allowedOrigins[0]!
  if (!allowedOrigins.includes(defaultOrigin)) throw invalidRequest(`${prefix}_DEFAULT_ORIGIN 必须包含在 ${prefix}_ORIGINS 中`)
  return {
    audience, applicationId: 'dsh-work', allowedOrigins, defaultOrigin,
    sessionCookieName: cookieName(audience === 'admin' ? 'dsh_work_local_admin_session' : 'dsh_work_local_session', production),
  }
}

function originList(value: string, name: string, production: boolean) {
  if ([...value].some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) throw stateConflict(`${name} 不能包含控制字符`)
  const values = value.split(',')
  if (values.some(item => !item.trim())) throw stateConflict(`${name} 不能包含空项`)
  const origins = values.map((item, index) =>
    normalizedOrigin(item.trim(), `${name} 第 ${index + 1} 项`, production),
  )
  if (new Set(origins).size !== origins.length) throw stateConflict(`${name} 不能包含重复 Origin`)
  return origins
}

function normalizedOrigin(value: string, name: string, production: boolean) {
  if (value !== value.toLowerCase()) throw invalidRequest(`${name} 必须使用小写地址`)
  const normalized = normalizedUrl(value, name, production)
  const parsed = new URL(normalized)
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw stateConflict(`${name} 必须是 Origin，不能包含路径、Query 或 Fragment`)
  }
  assertOriginHostname(parsed.hostname, name, production)
  return parsed.origin
}

function assertOriginHostname(hostname: string, name: string, production: boolean) {
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
    if (!isPrivateIpv4(hostname)) throw invalidRequest(`${name} 中的 IP 必须是 RFC1918 私有地址`)
    return
  }
  if (hostname.includes(':')) throw invalidRequest(`${name} 暂不支持 IPv6`)
  if (production && !hostname.includes('.')) throw invalidRequest(`${name} 必须使用完整 DNS 名称`)
  const labels = hostname.split('.')
  if (
    hostname.length > 253
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw invalidRequest(`${name} 包含无效 DNS 名称`)
  }
}

function isPrivateIpv4(value: string) {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255)) {
    return false
  }
  const [first, second] = parts.map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function cookieName(name: string, production: boolean) {
  return production ? `__Host-${name}` : name
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} 未配置`)
  return value
}

function normalizedUrl(value: string, name: string, production: boolean) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} 不是有效 URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} 只允许 http 或 https`)
  if (parsed.username || parsed.password) throw stateConflict(`${name} 不能包含凭据`)
  if (production && parsed.protocol !== 'https:') throw invalidRequest(`生产环境的 ${name} 必须使用 https`)
  return parsed.toString().replace(/\/$/, '')
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw invalidRequest(`${name} 必须是正整数`)
  return parsed
}

function booleanValue(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw invalidRequest(`${name} 必须是 true 或 false`)
}

function placeholderSecret(value: string) {
  const normalized = value.trim().toLowerCase()
  return ['change-me', 'replace-me', 'placeholder'].some((marker) =>
    normalized === marker || normalized.startsWith(`${marker}-`) || normalized.includes(`-${marker}`),
  ) || normalized === 'secret' || normalized.includes('local-only') || normalized.includes('example')
}
