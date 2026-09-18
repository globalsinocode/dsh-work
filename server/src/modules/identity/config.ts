import type {
  ApiAudience,
  IdentityConfiguration,
  OidcAudienceConfiguration,
  OidcIdentityConfiguration,
} from './types.ts'

const defaultScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'ai_hub.identity',
  'platform.me.read',
]

export function loadIdentityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): IdentityConfiguration {
  const production = environment.NODE_ENV === 'production'
  const mode = environment.DSH_WORK_AUTH_MODE ?? (production ? 'oidc' : 'prototype')
  if (mode !== 'prototype' && mode !== 'oidc') {
    throw new Error('DSH_WORK_AUTH_MODE 必须是 prototype 或 oidc')
  }
  if (production && mode !== 'oidc') {
    throw new Error('生产环境必须显式启用 AI Hub OIDC，禁止回退到 Prototype 身份')
  }
  if (mode === 'prototype') return { mode }

  const sessionSecret = required(environment, 'DSH_WORK_SESSION_SECRET')
  if (sessionSecret.length < 32) throw new Error('DSH_WORK_SESSION_SECRET 至少需要 32 个字符')
  if (production && placeholderSecret(sessionSecret)) {
    throw new Error('生产环境的 DSH_WORK_SESSION_SECRET 不能使用占位值')
  }

  const cookieSecure = booleanValue(
    environment.DSH_WORK_COOKIE_SECURE,
    production,
    'DSH_WORK_COOKIE_SECURE',
  )
  if (production && !cookieSecure) throw new Error('生产环境必须启用 Secure Session Cookie')

  const platformUrl = normalizedUrl(
    required(environment, 'AI_HUB_PLATFORM_URL'),
    'AI_HUB_PLATFORM_URL',
    production,
  )
  const workbench = audienceConfiguration(environment, 'workbench', production)
  const admin = audienceConfiguration(environment, 'admin', production)
  if (workbench.applicationId !== admin.applicationId) {
    throw new Error('员工端与管理端必须使用同一个 AI Hub 应用，不能配置独立管理应用')
  }
  if (
    workbench.clientId !== admin.clientId
    || workbench.clientSecret !== admin.clientSecret
    || workbench.issuer !== admin.issuer
  ) {
    throw new Error('员工端与管理端必须共用同一个 AI Hub 应用环境凭据')
  }
  const applicationEnvironment = environment.AI_HUB_ENVIRONMENT?.trim() || 'local'
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(applicationEnvironment)) {
    throw new Error('AI_HUB_ENVIRONMENT 必须是小写字母开头的环境标识')
  }
  const jwksCacheTtlSeconds = positiveInteger(
    environment.DSH_WORK_OIDC_JWKS_CACHE_TTL_SECONDS,
    300,
    'DSH_WORK_OIDC_JWKS_CACHE_TTL_SECONDS',
  )
  const jwksStaleTtlSeconds = positiveInteger(
    environment.DSH_WORK_OIDC_JWKS_STALE_TTL_SECONDS,
    3600,
    'DSH_WORK_OIDC_JWKS_STALE_TTL_SECONDS',
  )
  if (jwksStaleTtlSeconds < jwksCacheTtlSeconds) {
    throw new Error('OIDC JWKS 陈旧窗口不能短于正常缓存时间')
  }
  const directorySyncIntervalSeconds = nonNegativeInteger(
    environment.DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS,
    15 * 60,
    'DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS',
  )
  if (production && directorySyncIntervalSeconds === 0) {
    throw new Error('生产环境不能关闭 AI Hub 员工目录同步')
  }
  return {
    mode,
    platformUrl,
    applicationId: workbench.applicationId,
    adminBootstrapEnabled: booleanValue(environment.DSH_WORK_ADMIN_BOOTSTRAP_ENABLED, false, 'DSH_WORK_ADMIN_BOOTSTRAP_ENABLED'),
    environment: applicationEnvironment,
    sessionSecret,
    sessionTtlSeconds: positiveInteger(
      environment.DSH_WORK_SESSION_TTL_SECONDS,
      8 * 60 * 60,
      'DSH_WORK_SESSION_TTL_SECONDS',
    ),
    transactionTtlSeconds: positiveInteger(
      environment.DSH_WORK_OIDC_TRANSACTION_TTL_SECONDS,
      10 * 60,
      'DSH_WORK_OIDC_TRANSACTION_TTL_SECONDS',
    ),
    cookieSecure,
    directorySyncIntervalSeconds,
    jwksCacheTtlSeconds,
    jwksStaleTtlSeconds,
    audiences: { workbench, admin },
  } satisfies OidcIdentityConfiguration
}

function audienceConfiguration(
  environment: NodeJS.ProcessEnv,
  audience: ApiAudience,
  production: boolean,
): OidcAudienceConfiguration {
  const prefix = audience === 'workbench' ? 'AI_HUB_WORKBENCH' : 'AI_HUB_ADMIN'
  const applicationId = audienceOrShared(environment, prefix, 'APPLICATION_ID')
  const clientId = audienceOrShared(environment, prefix, 'CLIENT_ID')
  const issuerName = environment[`${prefix}_OIDC_ISSUER`]?.trim()
    ? `${prefix}_OIDC_ISSUER`
    : 'AI_HUB_OIDC_ISSUER'
  const issuer = normalizedIssuer(audienceOrShared(environment, prefix, 'OIDC_ISSUER'), issuerName, production)
  const origins = audienceOrigins(environment, audience, prefix, production)
  const clientSecret = audienceOrShared(environment, prefix, 'CLIENT_SECRET')
  if (production && placeholderSecret(clientSecret)) {
    throw new Error(`生产环境的 ${prefix}_CLIENT_SECRET/AI_HUB_CLIENT_SECRET 不能使用占位值`)
  }

  return {
    audience,
    applicationId,
    issuer,
    tokenAudience: environment[`${prefix}_OIDC_AUDIENCE`]?.trim()
      || environment.AI_HUB_OIDC_AUDIENCE?.trim()
      || clientId,
    clientId,
    clientSecret,
    ...origins,
    sessionCookieName: cookieName(
      audience === 'workbench' ? 'dsh_work_session' : 'dsh_work_admin_session',
      production,
    ),
    transactionCookieName: cookieName(
      audience === 'workbench' ? 'dsh_work_oidc_tx' : 'dsh_work_admin_oidc_tx',
      production,
    ),
    loginScopes: [...defaultScopes],
  }
}

function audienceOrigins(
  environment: NodeJS.ProcessEnv,
  audience: ApiAudience,
  prefix: 'AI_HUB_WORKBENCH' | 'AI_HUB_ADMIN',
  production: boolean,
): Pick<OidcAudienceConfiguration, 'allowedOrigins' | 'defaultOrigin' | 'redirectUriByOrigin'> {
  const originsName = audience === 'workbench'
    ? 'DSH_WORK_WORKBENCH_ORIGINS'
    : 'DSH_WORK_ADMIN_ORIGINS'
  const defaultName = audience === 'workbench'
    ? 'DSH_WORK_WORKBENCH_DEFAULT_ORIGIN'
    : 'DSH_WORK_ADMIN_DEFAULT_ORIGIN'
  const callbackPath = `/auth/${audience}/callback`
  const configuredOrigins = environment[originsName]?.trim()
  const legacyPortal = environment[`${prefix}_PORTAL_URL`]?.trim()
  const legacyRedirect = environment[`${prefix}_REDIRECT_URI`]?.trim()

  if (!configuredOrigins) {
    if (!legacyPortal || !legacyRedirect) {
      throw new Error(`${originsName} 未配置，且 ${prefix}_PORTAL_URL/${prefix}_REDIRECT_URI 不完整`)
    }
    const origin = normalizedOrigin(legacyPortal, `${prefix}_PORTAL_URL`, production)
    const redirectUri = normalizedUrl(legacyRedirect, `${prefix}_REDIRECT_URI`, production)
    assertRedirectUri(redirectUri, `${prefix}_REDIRECT_URI`)
    return {
      allowedOrigins: [origin],
      defaultOrigin: origin,
      redirectUriByOrigin: { [origin]: redirectUri },
    }
  }

  const allowedOrigins = originList(configuredOrigins, originsName, production)
  const expectedPort = environment[
    audience === 'workbench' ? 'DSH_WORK_WORKBENCH_PORT' : 'DSH_WORK_ADMIN_PORT'
  ]?.trim() || (audience === 'workbench' ? '4174' : '4180')
  if (!/^\d+$/.test(expectedPort) || Number(expectedPort) < 1 || Number(expectedPort) > 65535) {
    throw new Error(`${audience === 'workbench' ? 'DSH_WORK_WORKBENCH_PORT' : 'DSH_WORK_ADMIN_PORT'} 必须是有效端口`)
  }
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin)
    const actualPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    if (actualPort !== expectedPort) {
      throw new Error(`${originsName} 中的 ${origin} 必须使用端口 ${expectedPort}`)
    }
  }

  const defaultOrigin = environment[defaultName]?.trim()
    ? normalizedOrigin(environment[defaultName]!, defaultName, production)
    : allowedOrigins[0]!
  if (!allowedOrigins.includes(defaultOrigin)) {
    throw new Error(`${defaultName} 必须包含在 ${originsName} 中`)
  }
  const redirectUriByOrigin = Object.fromEntries(
    allowedOrigins.map(origin => [origin, new URL(callbackPath, `${origin}/`).toString()]),
  )

  if (Boolean(legacyPortal) !== Boolean(legacyRedirect)) {
    throw new Error(`${prefix}_PORTAL_URL 与 ${prefix}_REDIRECT_URI 必须同时配置或同时移除`)
  }
  if (legacyPortal && legacyRedirect) {
    const legacyOrigin = normalizedOrigin(legacyPortal, `${prefix}_PORTAL_URL`, production)
    const normalizedLegacyRedirect = normalizedUrl(
      legacyRedirect,
      `${prefix}_REDIRECT_URI`,
      production,
    )
    if (
      !allowedOrigins.includes(legacyOrigin)
      || redirectUriByOrigin[legacyOrigin] !== normalizedLegacyRedirect
    ) {
      throw new Error(`${originsName} 与旧 ${prefix}_PORTAL_URL/${prefix}_REDIRECT_URI 含义不一致`)
    }
  }

  return { allowedOrigins, defaultOrigin, redirectUriByOrigin }
}

function originList(value: string, name: string, production: boolean) {
  if ([...value].some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) throw new Error(`${name} 不能包含控制字符`)
  const values = value.split(',')
  if (values.some(item => !item.trim())) throw new Error(`${name} 不能包含空项`)
  const origins = values.map((item, index) =>
    normalizedOrigin(item.trim(), `${name} 第 ${index + 1} 项`, production),
  )
  if (new Set(origins).size !== origins.length) throw new Error(`${name} 不能包含重复 Origin`)
  return origins
}

function normalizedOrigin(value: string, name: string, production: boolean) {
  if (value !== value.toLowerCase()) throw new Error(`${name} 必须使用小写地址`)
  const normalized = normalizedUrl(value, name, production)
  const parsed = new URL(normalized)
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} 必须是 Origin，不能包含路径、Query 或 Fragment`)
  }
  assertOriginHostname(parsed.hostname, name, production)
  return parsed.origin
}

function assertOriginHostname(hostname: string, name: string, production: boolean) {
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
    if (!isPrivateIpv4(hostname)) throw new Error(`${name} 中的 IP 必须是 RFC1918 私有地址`)
    return
  }
  if (hostname.includes(':')) throw new Error(`${name} 暂不支持 IPv6`)
  if (production && !hostname.includes('.')) throw new Error(`${name} 必须使用完整 DNS 名称`)
  const labels = hostname.split('.')
  if (
    hostname.length > 253
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`${name} 包含无效 DNS 名称`)
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

function assertRedirectUri(value: string, name: string) {
  const parsed = new URL(value)
  if (parsed.hash) throw new Error(`${name} 不能包含 URL Fragment`)
}

function cookieName(name: string, production: boolean) {
  return production ? `__Host-${name}` : name
}

function audienceOrShared(
  environment: NodeJS.ProcessEnv,
  prefix: 'AI_HUB_WORKBENCH' | 'AI_HUB_ADMIN',
  suffix: 'APPLICATION_ID' | 'CLIENT_ID' | 'CLIENT_SECRET' | 'OIDC_ISSUER',
) {
  const audienceName = `${prefix}_${suffix}`
  const sharedName = `AI_HUB_${suffix}`
  const value = environment[audienceName]?.trim() || environment[sharedName]?.trim()
  if (!value) throw new Error(`${audienceName} 或 ${sharedName} 未配置`)
  return value
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} 未配置`)
  return value
}

function normalizedIssuer(value: string, name: string, production: boolean) {
  return `${normalizedUrl(value, name, production).replace(/\/$/, '')}/`
}

function normalizedUrl(value: string, name: string, production: boolean) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} 不是有效 URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} 只允许 http 或 https`)
  if (parsed.username || parsed.password) throw new Error(`${name} 不能包含凭据`)
  if (production && parsed.protocol !== 'https:') throw new Error(`生产环境的 ${name} 必须使用 https`)
  return parsed.toString().replace(/\/$/, '')
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数`)
  return parsed
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} 必须是非负整数`)
  return parsed
}

function booleanValue(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} 必须是 true 或 false`)
}

function placeholderSecret(value: string) {
  const normalized = value.trim().toLowerCase()
  return ['change-me', 'replace-me', 'placeholder'].some((marker) =>
    normalized === marker || normalized.startsWith(`${marker}-`) || normalized.includes(`-${marker}`),
  ) || normalized === 'secret' || normalized.includes('local-only') || normalized.includes('example')
}
