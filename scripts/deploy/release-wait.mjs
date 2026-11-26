#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Deployment wait budget for scripts/deploy/release.sh.
 *
 * The server runs its execution-capability probes before it starts listening:
 * - DSH: 3 attempts x 30 s preflight + 2 x 2 s delay = ~94 s.
 * - execution container: 3 attempts x (image 15 s + toolchain 60 s + Python packages 60 s +
 *   Python modules 60 s + Docker features 15 s + orphan sweep ~30 s + overlay preflight 30 s +
 *   tool discovery up to 120 s) = ~20 minutes.
 * A legitimate cold start can therefore exceed 20 minutes, which is longer than the old 180 s
 * public /health wait and longer than the Nginx container healthcheck window. The web
 * healthcheck is now a static Nginx liveness probe (deploy/nginx/default.conf.template
 * /nginx-health), and this script owns the real budget:
 *
 * 1. Wait for the public /health to answer (server listening again).
 * 2. Assert /health/ready once the core API is up: required capabilities must be available;
 *    only database readiness is retried, because capability state is fixed after startup.
 *
 * Exit codes: 0 ready, 1 timed out / not ready, 2 invalid invocation.
 */

export const RELEASE_HEALTH_BUDGET_SECONDS = 1500
export const RELEASE_HEALTH_POLL_INTERVAL_MS = 2000
export const RELEASE_REQUEST_TIMEOUT_MS = 10_000
export const RELEASE_READINESS_ATTEMPTS = 30
export const REQUIRED_CAPABILITIES = ['dsh', 'executionContainer']
// Transient readiness responses: the endpoint may answer through Nginx before the server/DB has
// finished recovering, so these are retried; capability assertions are never retried.
const RETRYABLE_READINESS_STATUSES = new Set([0, 502, 503, 504])
const HEALTH_PROGRESS_EVERY_ATTEMPTS = 15

function positiveInteger(flag, value) {
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`${flag} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

export function parseOptions(argv) {
  const options = {
    healthUrl: '',
    readyUrl: '',
    caCertPath: '',
    healthBudgetSeconds: RELEASE_HEALTH_BUDGET_SECONDS,
    pollIntervalMs: RELEASE_HEALTH_POLL_INTERVAL_MS,
    requestTimeoutMs: RELEASE_REQUEST_TIMEOUT_MS,
    readinessAttempts: RELEASE_READINESS_ATTEMPTS,
  }
  const flags = {
    '--health-url': ['healthUrl', String],
    '--ready-url': ['readyUrl', String],
    '--ca-cert': ['caCertPath', String],
    '--health-budget-seconds': ['healthBudgetSeconds', value => positiveInteger('--health-budget-seconds', value)],
    '--poll-interval-ms': ['pollIntervalMs', value => positiveInteger('--poll-interval-ms', value)],
    '--request-timeout-ms': ['requestTimeoutMs', value => positiveInteger('--request-timeout-ms', value)],
    '--readiness-attempts': ['readinessAttempts', value => positiveInteger('--readiness-attempts', value)],
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const entry = flags[flag]
    if (!entry) throw new Error(`unknown option: ${flag}`)
    if (argv[index + 1] === undefined) throw new Error(`missing value for ${flag}`)
    options[entry[0]] = entry[1](argv[index + 1])
  }
  if (!options.healthUrl) throw new Error('--health-url is required')
  if (!options.readyUrl) throw new Error('--ready-url is required')
  return options
}

/** One request per call; never rejects: transport errors resolve with statusCode 0. */
export function createRequester({ caCertPath = '', requestTimeoutMs = RELEASE_REQUEST_TIMEOUT_MS } = {}) {
  const ca = caCertPath ? [readFileSync(caCertPath)] : undefined
  return function request(url) {
    return new Promise(resolve => {
      let parsed
      try {
        parsed = new URL(url)
      } catch (error) {
        resolve({ statusCode: 0, body: '', error })
        return
      }
      const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest
      const req = transport(parsed, { ca, timeout: requestTimeoutMs }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }))
      })
      req.on('timeout', () => req.destroy(new Error('request timed out')))
      req.on('error', error => resolve({ statusCode: 0, body: '', error }))
      req.end()
    })
  }
}

export function validateReadiness(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, kind: 'invalid-response' }
  }
  const capabilities = parsed?.executionCapabilities ?? {}
  const missing = REQUIRED_CAPABILITIES.filter(name => capabilities[name]?.status !== 'available')
  if (missing.length) return { ok: false, kind: 'capability', missing }
  return { ok: true, python: capabilities.python?.status ?? 'unknown' }
}

export async function waitForHttpOk({ request, url, budgetMs, intervalMs, now, sleep, onProgress }) {
  const startedAt = now()
  let attempts = 0
  for (;;) {
    attempts += 1
    const response = await request(url)
    if (response.statusCode === 200) return { ok: true, attempts, elapsedMs: now() - startedAt }
    const elapsedMs = now() - startedAt
    if (elapsedMs >= budgetMs) return { ok: false, attempts, elapsedMs }
    if (attempts % HEALTH_PROGRESS_EVERY_ATTEMPTS === 0) onProgress?.(elapsedMs)
    await sleep(intervalMs)
  }
}

export async function waitForReadiness({ request, url, attempts, intervalMs, sleep, onPythonUnavailable }) {
  let lastStatus = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await request(url)
    lastStatus = response.statusCode
    if (response.statusCode === 200) {
      const validation = validateReadiness(response.body)
      if (!validation.ok) return { ok: false, kind: validation.kind, missing: validation.missing ?? [], body: response.body, attempt }
      if (validation.python !== 'available') onPythonUnavailable?.(validation.python)
      return { ok: true, python: validation.python, attempt }
    }
    if (!RETRYABLE_READINESS_STATUSES.has(response.statusCode)) {
      return { ok: false, kind: 'http', status: response.statusCode, body: response.body, attempt }
    }
    if (attempt < attempts) await sleep(intervalMs)
  }
  return {
    ok: false,
    kind: lastStatus === 503 ? 'database' : 'transient',
    status: lastStatus,
    attempt: attempts,
  }
}

export async function runReleaseWait(options, dependencies = {}) {
  const request = dependencies.request ?? createRequester({
    caCertPath: options.caCertPath,
    requestTimeoutMs: options.requestTimeoutMs,
  })
  const now = dependencies.now ?? (() => Date.now())
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds) }))
  const stdout = dependencies.stdout ?? (line => { process.stdout.write(`${line}\n`) })
  const stderr = dependencies.stderr ?? (line => { process.stderr.write(`${line}\n`) })

  const health = await waitForHttpOk({
    request,
    url: options.healthUrl,
    budgetMs: options.healthBudgetSeconds * 1000,
    intervalMs: options.pollIntervalMs,
    now,
    sleep,
    onProgress: elapsedMs => stdout(
      `release health check waiting (${Math.floor(elapsedMs / 1000)}s/${options.healthBudgetSeconds}s): ${options.healthUrl}`,
    ),
  })
  if (!health.ok) {
    stderr(`release health check failed: ${options.healthUrl} (waited ${options.healthBudgetSeconds}s)`)
    return { code: 1, phase: 'health' }
  }
  stdout(`release health check passed after ${Math.ceil(health.elapsedMs / 1000)}s: ${options.healthUrl}`)

  const ready = await waitForReadiness({
    request,
    url: options.readyUrl,
    attempts: options.readinessAttempts,
    intervalMs: options.pollIntervalMs,
    sleep,
    onPythonUnavailable: python => stderr(`python capability unavailable (${python}); python_execute tasks will be refused`),
  })
  if (!ready.ok) {
    if (ready.kind === 'capability') {
      stderr(`release readiness check failed: required execution capabilities unavailable (${options.readyUrl})`)
      stderr(`missing capabilities: ${ready.missing.join(', ')}`)
    } else if (ready.kind === 'database') {
      stderr(`release readiness check failed: database did not become ready (${options.readyUrl})`)
    } else if (ready.kind === 'transient') {
      stderr(`release readiness check failed: readiness endpoint did not become available (${options.readyUrl})`)
    } else if (ready.kind === 'http') {
      stderr(`release readiness check failed: unexpected status ${ready.status || 'no-response'} (${options.readyUrl})`)
    } else {
      stderr(`release readiness check failed: invalid readiness response (${options.readyUrl})`)
    }
    if (ready.body) stderr(ready.body)
    return { code: 1, phase: 'readiness', kind: ready.kind }
  }
  return { code: 0, phase: 'ready', python: ready.python }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseOptions(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  try {
    const result = await runReleaseWait(options)
    return result.code
  } catch (error) {
    process.stderr.write(`release wait failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export function isMainModule(scriptPath = process.argv[1]) {
  if (!scriptPath) return false
  const modulePath = fileURLToPath(import.meta.url)
  try {
    // The watcher runs release.sh through the `current` symlink, so compare resolved paths.
    if (realpathSync(scriptPath) === realpathSync(modulePath)) return true
  } catch {
    // Fall through to the basename check below.
  }
  // Last-resort guard so an unexpected path form can never make the CLI silently no-op.
  return basename(scriptPath) === basename(modulePath)
}

if (isMainModule()) {
  process.exitCode = await main()
}
