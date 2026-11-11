/** 与 server `normalizeOAuthDiscoveryEndpoint` 对齐：本地 data-hub 文档路径自动补 `/api`。 */

export function normalizeOAuthDiscoveryEndpoint(raw: string, role: 'authorize' | 'token'): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  let url: URL
  try { url = new URL(trimmed) }
  catch { return trimmed }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (!isLocal) return trimmed
  const legacy = role === 'authorize' ? '/oauth/authorize' : '/oauth/token'
  const prefixed = role === 'authorize' ? '/api/oauth/authorize' : '/api/oauth/token'
  const path = url.pathname.replace(/\/$/, '') || '/'
  if (path === legacy) {
    url.pathname = prefixed
    return url.toString()
  }
  return trimmed
}

export function normalizeMcpOAuthFormEndpoints(form: {
  authorizationEndpoint: string
  tokenEndpoint: string
}): void {
  if (form.authorizationEndpoint.trim()) {
    form.authorizationEndpoint = normalizeOAuthDiscoveryEndpoint(form.authorizationEndpoint, 'authorize')
  }
  if (form.tokenEndpoint.trim()) {
    form.tokenEndpoint = normalizeOAuthDiscoveryEndpoint(form.tokenEndpoint, 'token')
  }
}
