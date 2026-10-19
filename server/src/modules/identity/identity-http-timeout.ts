const defaultIdentityHttpTimeoutMs = 5_000

/** OIDC discovery/token/JWKS and AI Hub Platform API fetch timeout. */
export function identityHttpTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.DSH_WORK_IDENTITY_HTTP_TIMEOUT_MS
  if (!raw?.trim()) return defaultIdentityHttpTimeoutMs
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > 120_000) {
    return defaultIdentityHttpTimeoutMs
  }
  return Math.trunc(parsed)
}
