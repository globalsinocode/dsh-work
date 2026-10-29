export interface WeknoraConfig {
  baseUrl: string
  integrationSecret: string
}

export function loadWeknoraConfig(env: NodeJS.ProcessEnv = process.env): WeknoraConfig | null {
  const baseUrl = (env.WEKNORA_BASE_URL ?? '').trim().replace(/\/$/, '')
  const integrationSecret = (env.WEKNORA_INTEGRATION_SECRET ?? '').trim()
  if (!baseUrl || !integrationSecret) return null
  return { baseUrl, integrationSecret }
}

export function isWeknoraConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadWeknoraConfig(env) !== null
}
