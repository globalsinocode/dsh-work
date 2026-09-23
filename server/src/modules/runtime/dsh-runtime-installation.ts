import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import { AcpJsonRpcClient } from './acp-json-rpc-client.ts'
import {
  createManagedDshAcpProcessConfiguration,
  type DshAcpAdapter,
} from './dsh-acp-process-configuration.ts'
import type { AcpProcessConfiguration } from './acp-json-rpc-client.ts'

interface RuntimeIdentity {
  version: string
  commit: string
  protocolVersion: number
}

interface RuntimeTarget extends RuntimeIdentity {
  adapter: DshAcpAdapter
}

interface CompatibilityRuntimeTarget extends RuntimeTarget {
  scope: 'development'
}

interface RuntimeLock extends RuntimeTarget {
  compatibility?: Record<string, CompatibilityRuntimeTarget>
}

interface RuntimeMetadata extends RuntimeIdentity {
  name?: string
  acpConfig?: string
}

export interface DshRuntimeInstallation {
  home: string
  version: string
  commit: string
  protocolVersion: number
  launchMode: 'source-checkout' | 'managed-distribution'
  adapter: DshAcpAdapter
  compatibilityMode: string | null
  process: AcpProcessConfiguration
}

export interface ResolveDshRuntimeInstallationOptions {
  projectRoot: string
  env?: NodeJS.ProcessEnv
}

/** Resolve and verify the immutable DSH runtime selected for this deployment. */
export async function resolveDshRuntimeInstallation(
  options: ResolveDshRuntimeInstallationOptions,
): Promise<DshRuntimeInstallation> {
  const env = options.env ?? process.env
  const lock = await readJson<RuntimeLock>(resolve(
    options.projectRoot,
    'server/config/dsh/runtime-lock.json',
  ))
  assertRuntimeLock(lock)
  const { target, compatibilityMode } = selectRuntimeTarget(lock, env)
  assertExpectedRuntimeLockEnvironment(env, target)

  const home = resolve(env['DSH_RUNTIME_HOME'] ?? env['DSH_REPOSITORY'] ?? resolve(
    options.projectRoot,
    '../deepseek-harness',
  ))
  const configuredCommand = env['DSH_RUNTIME_COMMAND']
  const launchMode = configuredCommand ? 'managed-distribution' : 'source-checkout'

  await access(home, constants.R_OK)
  const metadata = launchMode === 'managed-distribution'
    ? await readJson<RuntimeMetadata>(resolve(home, 'dsh-runtime.json'))
    : await readSourceMetadata(home, target.protocolVersion)

  if (metadata.version !== target.version) {
    throw new Error(`DSH runtime version mismatch: expected ${target.version}, received ${metadata.version}`)
  }
  if (metadata.commit !== target.commit) {
    throw new Error(`DSH runtime commit mismatch: expected ${target.commit}, received ${metadata.commit}`)
  }
  if (metadata.protocolVersion !== target.protocolVersion) {
    throw new Error(`DSH ACP protocol mismatch: expected ${target.protocolVersion}, received ${metadata.protocolVersion}`)
  }

  const deploymentConfigFilename = target.adapter === 'legacy-acp-demo'
    ? 'acp-managed-credentials.legacy.cordis.yml'
    : 'acp-managed-credentials.cordis.yml'
  const deploymentConfigTemplate = resolve(
    options.projectRoot,
    `server/config/dsh/${deploymentConfigFilename}`,
  )
  await access(deploymentConfigTemplate, constants.R_OK)
  const acpBaseConfig = target.adapter === 'legacy-acp-demo'
    ? resolve(home, metadata.acpConfig ?? 'examples/acp-agent/cordis.yml')
    : undefined
  if (acpBaseConfig) await access(acpBaseConfig, constants.R_OK)
  const dataRoot = resolve(options.projectRoot, env['DSH_WORK_DATA_ROOT'] ?? '.runtime')
  const dshSessionsRoot = resolve(
    options.projectRoot,
    env['DSH_WORK_DSH_SESSIONS_ROOT'] ?? resolve(dataRoot, 'dsh-sessions'),
  )
  const deploymentConfig = await writeDeploymentOverlay(
    dataRoot,
    deploymentConfigTemplate,
    acpBaseConfig,
  )

  let command: string | undefined
  let args: string[] | undefined
  if (configuredCommand) {
    command = isAbsolute(configuredCommand) ? configuredCommand : resolve(options.projectRoot, configuredCommand)
    await access(command, constants.X_OK)
    args = target.adapter === 'legacy-acp-demo'
      ? [...parseStringArray(env['DSH_RUNTIME_ARGS_JSON']), '--config', deploymentConfig]
      : [
          ...parseStringArray(env['DSH_RUNTIME_ARGS_JSON']),
          '--profile',
          'acp',
          '--patch',
          deploymentConfig,
        ]
  } else if (target.adapter === 'legacy-acp-demo') {
    await access(resolve(home, 'packages/examples/acp-demo/src/bin.ts'), constants.R_OK)
  } else {
    await access(resolve(home, 'apps/cli/src/bin.ts'), constants.R_OK)
    await access(resolve(home, 'packages/bundle/acp-app/cordis.patch.yml'), constants.R_OK)
  }

  return {
    home,
    version: metadata.version,
    commit: metadata.commit,
    protocolVersion: metadata.protocolVersion,
    launchMode,
    adapter: target.adapter,
    compatibilityMode,
    process: createManagedDshAcpProcessConfiguration({
      runtimeHome: home,
      projectRoot: options.projectRoot,
      command,
      args,
      deploymentConfig,
      adapter: target.adapter,
      acpBaseConfig,
      env: {
        DSH_WORK_DSH_SESSIONS_ROOT: dshSessionsRoot,
      },
    }),
  }
}

function selectRuntimeTarget(
  lock: RuntimeLock,
  env: NodeJS.ProcessEnv,
): { target: RuntimeTarget; compatibilityMode: string | null } {
  const compatibilityMode = env['DSH_RUNTIME_COMPATIBILITY']
  if (!compatibilityMode) return { target: lock, compatibilityMode: null }
  if (env['NODE_ENV'] === 'production') {
    throw new Error('DSH_RUNTIME_COMPATIBILITY is development-only and forbidden in production')
  }
  const target = lock.compatibility?.[compatibilityMode]
  if (!target) {
    throw new Error(`Unsupported DSH_RUNTIME_COMPATIBILITY mode: ${compatibilityMode}`)
  }
  return { target, compatibilityMode }
}

function assertExpectedRuntimeLockEnvironment(env: NodeJS.ProcessEnv, target: RuntimeTarget) {
  const expectedVersion = env['DSH_EXPECTED_VERSION']
  if (expectedVersion !== undefined && expectedVersion !== target.version) {
    throw new Error(`DSH_EXPECTED_VERSION must match selected runtime ${target.version}, received ${expectedVersion}`)
  }
  const expectedCommit = env['DSH_EXPECTED_COMMIT']
  if (expectedCommit !== undefined && expectedCommit !== target.commit) {
    throw new Error(`DSH_EXPECTED_COMMIT must match selected runtime ${target.commit}, received ${expectedCommit}`)
  }
}

async function writeDeploymentOverlay(
  dataRoot: string,
  templatePath: string,
  acpBaseConfig?: string,
): Promise<string> {
  let rendered = await readFile(templatePath, 'utf8')
  if (acpBaseConfig) {
    if (!rendered.includes('__DSH_ACP_BASE_CONFIG__')) {
      throw new Error(`DSH legacy deployment overlay has no base config placeholder: ${templatePath}`)
    }
    rendered = rendered.replace('__DSH_ACP_BASE_CONFIG__', JSON.stringify(acpBaseConfig))
  }
  const toolPolicySource = resolve(dirname(templatePath), 'dsh-work-tool-policy.js')
  await access(toolPolicySource, constants.R_OK)
  const withToolPolicy = rendered.replace(
    '__DSH_WORK_TOOL_POLICY_MODULE__',
    JSON.stringify(toolPolicySource),
  )
  if (withToolPolicy === rendered) {
    throw new Error(`DSH deployment overlay template has no tool policy placeholder: ${templatePath}`)
  }
  const directory = resolve(dataRoot, 'dsh-config')
  const target = resolve(directory, basename(templatePath))
  await mkdir(directory, { recursive: true })
  await writeFile(target, withToolPolicy, { mode: 0o600 })
  return target
}

/** Start a short-lived ACP process and fail unless negotiation and Session creation both work. */
export async function preflightDshRuntime(
  installation: DshRuntimeInstallation,
  timeoutMs = 30_000,
): Promise<void> {
  const preflightRoot = await mkdtemp(resolve(tmpdir(), 'dsh-work-dsh-preflight-'))
  const workspace = resolve(preflightRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  const diagnostics: string[] = []
  const client = AcpJsonRpcClient.launch({
    ...installation.process,
    env: {
      ...installation.process.env,
      DSH_SNAPSHOT: 'record',
      DSH_SNAPSHOT_SESSIONS_ROOT: resolve(preflightRoot, 'sessions'),
    },
  }, {
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    onDiagnostic: message => { diagnostics.push(message) },
  })
  let timeout: NodeJS.Timeout | undefined
  try {
    try {
      await Promise.race([
        (async () => {
          await client.initialize()
          await client.newSession(workspace)
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error(`DSH ACP preflight timed out after ${timeoutMs} ms`)) }, timeoutMs)
        }),
      ])
    } catch (error) {
      const detail = diagnostics.join('\n').slice(-4000)
      throw new Error(`DSH ACP preflight failed: ${asError(error).message}${detail ? `\n${detail}` : ''}`)
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    await client.close().catch(() => undefined)
    await rm(preflightRoot, { recursive: true, force: true })
  }
}

async function readSourceMetadata(home: string, protocolVersion: number): Promise<RuntimeMetadata> {
  const packageJson = await readJson<{ version?: string }>(resolve(home, 'package.json'))
  if (!packageJson.version) throw new Error(`DSH package.json has no version: ${home}`)
  return {
    version: packageJson.version,
    commit: await gitHead(home),
    protocolVersion,
  }
}

function gitHead(cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd }, (error, stdout) => {
      if (error) reject(new Error(`Unable to resolve DSH source commit at ${cwd}: ${error.message}`))
      else resolvePromise(stdout.trim())
    })
  })
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    throw new Error(`Unable to read DSH runtime metadata ${path}: ${asError(error).message}`)
  }
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`DSH_RUNTIME_ARGS_JSON must be a JSON string array: ${asError(error).message}`)
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('DSH_RUNTIME_ARGS_JSON must be a JSON string array')
  }
  return parsed
}

function assertRuntimeLock(value: RuntimeLock): void {
  assertRuntimeTarget(value, 'primary')
  for (const [mode, target] of Object.entries(value.compatibility ?? {})) {
    assertRuntimeTarget(target, `compatibility.${mode}`)
    if (target.scope !== 'development') throw new Error(`DSH runtime lock ${mode} must be development-only`)
  }
}

function assertRuntimeTarget(value: RuntimeTarget, label: string): void {
  if (!value.version || !/^[0-9a-f]{40}$/.test(value.commit) || value.protocolVersion !== 1
    || !['official-acp-profile', 'legacy-acp-demo'].includes(value.adapter)) {
    throw new Error(`DSH runtime lock is invalid: ${label}`)
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
