import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { dependencyUnavailable, invalidRequest, stateConflict } from '../../domain/request-errors.ts'
import { PYTHON_SANDBOX_LIMITS, type ExecutionBackend, type PythonSandboxSpec, type RunningSandbox } from './execution-backend.ts'

export const PYTHON_CONTAINER_NAME_PATTERN = /^dsh-py-[0-9a-f]{16}$/
const SANDBOX_USER_PATTERN = /^[1-9]\d{0,9}:[1-9]\d{0,9}$/
const SANDBOX_LABEL = 'dsh-work.python-sandbox=1'
const DOCKER_ENV_KEYS = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'TMPDIR'] as const
const FSIZE_LIMIT = PYTHON_SANDBOX_LIMITS.maxArtifactBytes + 1
const STOP_COMMAND_TIMEOUT_MS = 4_000
const RM_TIMEOUT_MS = 3_000
const MAX_CAPTURE_BYTES = 1024 * 1024

export interface PythonSandboxArgumentOptions {
  name: string
  user: string
  /** Pin swap to the memory limit. Omit when the daemon has no swap accounting. */
  memorySwap: boolean
  /** Add `apparmor=docker-default` only when the daemon reports AppArmor. */
  apparmor: boolean
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Drives the local Docker (or CLI-compatible) daemon through its CLI with a fixed sandbox posture. */
export class DockerExecutionBackend implements ExecutionBackend {
  private readonly command: string
  private memorySwap = false
  private apparmor = false

  constructor(options: { command?: string } = {}) {
    this.command = options.command ?? 'docker'
  }

  async inspectImage(image: string) {
    const inspected = await runCommand(this.command, ['image', 'inspect', image], 15_000)
    if (inspected.exitCode !== 0) throw dependencyUnavailable(`Python Skill 沙箱镜像不可用：${inspected.stderr.trim() || image}`)
  }

  async detectFeatures() {
    const info = await runCommand(this.command, ['info', '--format', '{{.SwapLimit}}\n{{json .SecurityOptions}}'], 15_000)
    if (info.exitCode !== 0) return
    const parsed = parseDockerInfo(info.stdout)
    this.memorySwap = parsed.swapLimit
    this.apparmor = parsed.apparmor
  }

  async removeOrphans() {
    const listed = await Promise.all([
      runCommand(this.command, ['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}`, '--format', '{{.Names}}'], 15_000),
      runCommand(this.command, ['ps', '-aq', '--filter', 'name=dsh-py-', '--format', '{{.Names}}'], 15_000),
    ])
    if (listed.some(result => result.exitCode !== 0)) {
      throw dependencyUnavailable(`未能列出现有 Python 沙箱容器：${brief(listed.map(result => result.stderr).join(' ')) || 'docker ps 失败'}`)
    }
    const names = [...new Set(listed.flatMap(result => result.stdout.split('\n')).map(name => name.trim()).filter(name => PYTHON_CONTAINER_NAME_PATTERN.test(name)))]
    if (!names.length) return
    const removed = await runCommand(this.command, ['rm', '-f', ...names], 15_000)
    if (!removalSucceeded(removed)) throw dependencyUnavailable(`未能清理遗留的 Python 沙箱容器：${brief(removed.stderr) || names.join(' ')}`)
    console.warn(`removed ${names.length} orphaned Python sandbox containers`)
  }

  /**
   * `signal` is intentionally not wired to `spawn`. Node would only SIGTERM the
   * docker CLI, which forwards that signal to Python as PID 1; Python ignores it
   * and the container keeps writing to the bind mount. The executor stops the
   * named container (grace, then SIGKILL) and removes it instead.
   */
  startPythonSandbox(spec: PythonSandboxSpec): RunningSandbox {
    const args = buildPythonSandboxArguments(spec.image, spec.skillRoot, spec.inputRoot, spec.outputRoot, spec.entry, spec.args, {
      name: spec.name,
      user: spec.user,
      memorySwap: this.memorySwap,
      apparmor: this.apparmor,
    })
    const child = spawn(this.command, args, { env: dockerCommandEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = boundedUtf8Collector()
    const stderr = boundedUtf8Collector()
    child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk))
    const exited = waitForExit(child)
    void exited.catch(() => undefined)
    return {
      exited,
      stdout: () => stdout.text(),
      stderr: () => stderr.text(),
      alive: () => child.exitCode === null && child.signalCode === null,
      kill: () => {
        try { child.kill('SIGKILL') } catch { /* process already exited */ }
      },
    }
  }

  async stop(name: string, graceSeconds: number) {
    await runCommand(this.command, ['stop', '-t', String(graceSeconds), name], STOP_COMMAND_TIMEOUT_MS).catch(() => undefined)
  }

  async remove(name: string) {
    const removed = await runCommand(this.command, ['rm', '-f', name], RM_TIMEOUT_MS)
    if (!removalSucceeded(removed)) {
      const detail = brief(removed.stderr)
      throw stateConflict(`Python 沙箱容器清理失败，容器可能仍在运行：${name}${detail ? `：${detail}` : ''}`)
    }
  }
}

export function buildPythonSandboxArguments(
  image: string,
  skillRoot: string,
  inputRoot: string,
  outputRoot: string,
  entry: string,
  args: string[],
  options: PythonSandboxArgumentOptions,
) {
  if (!PYTHON_CONTAINER_NAME_PATTERN.test(options.name)) throw invalidRequest('Python 沙箱容器名称无效')
  if (!SANDBOX_USER_PATTERN.test(options.user)) throw invalidRequest('DSH_WORK_PYTHON_USER 必须是非 root 的 uid:gid，例如 65534:65534')
  for (const mountPath of [skillRoot, inputRoot, outputRoot]) {
    if (mountPath.includes(',') || mountPath.includes('\0')) throw invalidRequest('Python 沙箱挂载路径无效')
  }
  return [
    'run', '--rm', '--name', options.name, '--label', SANDBOX_LABEL, '--init', '--pull', 'never',
    '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--security-opt', 'seccomp=builtin',
    ...(options.apparmor ? ['--security-opt', 'apparmor=docker-default'] : []),
    '--pids-limit', PYTHON_SANDBOX_LIMITS.pidsLimit,
    '--memory', PYTHON_SANDBOX_LIMITS.memory,
    ...(options.memorySwap ? ['--memory-swap', PYTHON_SANDBOX_LIMITS.memory] : []),
    '--shm-size', PYTHON_SANDBOX_LIMITS.shmSize,
    '--cpus', PYTHON_SANDBOX_LIMITS.cpus,
    // One byte above the largest artifact we keep, so a write stopped by the ulimit is discarded.
    '--ulimit', `fsize=${FSIZE_LIMIT}:${FSIZE_LIMIT}`,
    '--user', options.user,
    '--stop-timeout', String(PYTHON_SANDBOX_LIMITS.stopGraceSeconds),
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${PYTHON_SANDBOX_LIMITS.tmpfsSize},mode=1777`,
    '--mount', `type=bind,src=${skillRoot},dst=/skill,readonly`,
    '--mount', `type=bind,src=${inputRoot},dst=/input,readonly`,
    '--mount', `type=bind,src=${outputRoot},dst=/output`,
    '--workdir', '/skill', image, 'python', '-I', '-B', entry, ...args,
  ]
}

/**
 * Keeps at most `maxBytes` of a UTF-8 stream. Characters split across chunks are
 * reassembled, and a character cut by the limit is dropped rather than mangled.
 */
export function boundedUtf8Collector(maxBytes = MAX_CAPTURE_BYTES) {
  const decoder = new StringDecoder('utf8')
  let size = 0, text = ''
  return {
    write(chunk: Buffer) {
      if (size >= maxBytes) return
      const accepted = chunk.subarray(0, maxBytes - size)
      size += accepted.length
      text += decoder.write(accepted)
    },
    text: () => text,
  }
}

function parseDockerInfo(stdout: string): { swapLimit: boolean; apparmor: boolean } {
  const [swapLine = '', securityLine = ''] = stdout.split('\n')
  let apparmor = false
  try {
    const options = JSON.parse(securityLine) as unknown
    apparmor = Array.isArray(options) && options.some(option => typeof option === 'string' && option.toLowerCase().includes('apparmor'))
  } catch { apparmor = false }
  return { swapLimit: swapLine.trim() === 'true', apparmor }
}

function dockerCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of DOCKER_ENV_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  return env
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  const child = spawn(command, args, { env: dockerCommandEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = boundedUtf8Collector()
  const stderr = boundedUtf8Collector()
  child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk))
  const exited = waitForExit(child)
  void exited.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<number>(resolve => {
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      resolve(-1)
    }, timeoutMs)
  })
  try {
    const exitCode = await Promise.race([exited, timedOut])
    if (exitCode === -1) await Promise.race([exited.then(() => undefined, () => undefined), delay(1_000)])
    return { exitCode: child.exitCode ?? exitCode, stdout: stdout.text(), stderr: stderr.text() }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false
    child.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      if (code !== null) resolve(code)
      else resolve(signal ? 128 : -1)
    })
  })
}

function removalSucceeded(result: CommandResult): boolean {
  if (result.exitCode === 0) return true
  return /no such container|already in progress/i.test(`${result.stderr}\n${result.stdout}`)
}

function brief(text: string): string {
  const oneLine = text.replaceAll(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
