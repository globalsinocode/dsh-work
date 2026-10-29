import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, sep } from 'node:path'
import { redactSensitiveText } from '../../security/safe-observability.ts'
import { EXECUTION_CONTAINER_LIMITS, type ContainerCommand, type ContainerCommandResult } from './execution-backend.ts'
import { PlatformToolError } from './platform-tool-contract.ts'

/**
 * DSH bundles ripgrep as a platform-specific npm package (for example
 * `@vscode/ripgrep-darwin-arm64/bin/rg`); inside the container the image's `rg` runs instead.
 */
const RIPGREP_PATH = /\/@vscode\/ripgrep(?:-[a-z0-9-]+)?\/bin\/rg$/
const MAX_ARGS = 4096
const MAX_ARG_BYTES = 32 * 1024
const SUMMARY_CHARS = 240

export interface RemoteSubprocessRequest {
  argv: string[]
  cwd: string
  maxOutputBytes: number
  timeoutMs: number
}

/** Safe for the audit log: no output, the command line redacted and cut short. */
export interface ContainerCommandAudit {
  executable: string
  argc: number
  exitCode: number | null
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  truncated: boolean
  timedOut: boolean
  aborted: boolean
  /** The platform stopped the command: workspace over its cap or the data volume low (plan 4.7). */
  limit?: 'workspace' | 'disk'
  summary: string
}

export interface RemoteSubprocessGatewayOptions {
  /** Host path of the Attempt workspace; commands may only run inside it. */
  workspace: string
  run: (command: ContainerCommand, signal: AbortSignal) => Promise<ContainerCommandResult>
  onCommand?: (audit: ContainerCommandAudit) => void
  now?: () => number
}

/**
 * Platform side of the remote `ctx.subprocess`: validates what DSH asks to run,
 * maps it to an executable inside the image, and records one audit entry per command.
 * Allowed: ripgrep (glob/grep) and, from stage 2, `bash -c <command>` from dsh-bash-local.
 */
export function createRemoteSubprocessGateway(options: RemoteSubprocessGatewayOptions) {
  // DSH reports resolved paths (macOS /var → /private/var); compare resolved against resolved.
  const roots = [...new Set([normalize(options.workspace), resolvedPath(options.workspace)])]
  const now = options.now ?? (() => performance.now())
  return async (body: Record<string, unknown>, signal: AbortSignal): Promise<ContainerCommandResult> => {
    const request = parseRequest(body)
    const executable = mapExecutable(request.argv)
    const cwd = normalize(request.cwd)
    const resolvedCwd = resolvedPath(cwd)
    if (!roots.some(root => isWithin(root, cwd)) || !roots.some(root => isWithin(root, resolvedCwd))) {
      throw denied('命令只能在当前 Run 工作区内执行')
    }
    const command: ContainerCommand = {
      argv: [executable, ...request.argv.slice(1)],
      cwd,
      maxOutputBytes: request.maxOutputBytes,
      timeoutMs: request.timeoutMs,
      // ripgrep only reads and exits; anything else may leave processes behind (plan 3.7).
      mayLeaveProcesses: executable !== 'rg',
    }
    const started = now()
    let result: ContainerCommandResult | undefined
    try {
      result = await options.run(command, signal)
      return result
    } finally {
      options.onCommand?.({
        executable,
        argc: command.argv.length,
        exitCode: result?.exitCode ?? null,
        durationMs: Math.max(0, Math.round(now() - started)),
        stdoutBytes: result ? Buffer.byteLength(result.stdout) : 0,
        stderrBytes: result ? Buffer.byteLength(result.stderr) : 0,
        truncated: result?.truncated ?? false,
        timedOut: result?.timedOut ?? false,
        aborted: signal.aborted,
        ...(result?.limit ? { limit: result.limit } : {}),
        summary: redactSensitiveText(command.argv.join(' ')).slice(0, SUMMARY_CHARS),
      })
    }
  }
}

function isWithin(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

/** Resolves symlinks when the path exists; otherwise the normalized path (the check then fails closed on mismatch). */
function resolvedPath(path: string) {
  try { return realpathSync(path) } catch { return normalize(path) }
}

/**
 * Host executables never run in the container as given: ripgrep maps to the image's `rg`,
 * and the only accepted shell form is dsh-bash-local's `bash -c <command>`, which runs
 * the image's `bash`. Any other program or host path is refused.
 */
export function mapExecutable(argv: readonly string[]): string {
  const argv0 = argv[0] ?? ''
  if (RIPGREP_PATH.test(argv0)) return 'rg'
  if (argv0 === 'bash' && argv.length === 3 && argv[1] === '-c') return 'bash'
  throw denied(`执行容器不允许运行该程序：${argv0.split('/').at(-1) ?? argv0}`)
}

function parseRequest(body: Record<string, unknown>): RemoteSubprocessRequest {
  const { argv, cwd, maxOutputBytes, timeoutMs } = body
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGS
    || argv.some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > MAX_ARG_BYTES)) {
    throw invalid('argv 必须是非空字符串数组')
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw invalid('cwd 必须是绝对路径')
  if (!Number.isSafeInteger(maxOutputBytes) || (maxOutputBytes as number) < 1) throw invalid('maxOutputBytes 必须是正整数')
  const timeout = timeoutMs === undefined ? EXECUTION_CONTAINER_LIMITS.maxCommandMs : timeoutMs
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1) throw invalid('timeoutMs 必须是正整数')
  return {
    argv: argv as string[],
    cwd,
    // DSH tools may ask for more (tool-fs-search does); the platform cap still bounds what comes back.
    maxOutputBytes: Math.min(maxOutputBytes as number, EXECUTION_CONTAINER_LIMITS.maxOutputBytes),
    timeoutMs: Math.min(timeout as number, EXECUTION_CONTAINER_LIMITS.maxCommandMs),
  }
}

function invalid(message: string) {
  return new PlatformToolError({ status: 400, code: 'SUBPROCESS_REQUEST_INVALID', message })
}

function denied(message: string) {
  return new PlatformToolError({ status: 403, code: 'SUBPROCESS_DENIED', message })
}
