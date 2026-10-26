import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { dependencyUnavailable, invalidRequest, stateConflict } from '../../domain/request-errors.ts'
import {
  EXECUTION_CONTAINER_HOME,
  EXECUTION_CONTAINER_LIMITS,
  PYTHON_SANDBOX_LIMITS,
  type ContainerCommand,
  type ContainerCommandResult,
  type ExecutionBackend,
  type ExecutionContainerSpec,
  type PythonSandboxSpec,
  type RunningSandbox,
} from './execution-backend.ts'

export const PYTHON_CONTAINER_NAME_PATTERN = /^dsh-py-[0-9a-f]{16}$/
export const EXECUTION_CONTAINER_NAME_PATTERN = /^dsh-exec-[0-9a-f]{16}$/
const SANDBOX_USER_PATTERN = /^[1-9]\d{0,9}:[1-9]\d{0,9}$/
const SANDBOX_LABEL = 'dsh-work.python-sandbox=1'
const EXECUTION_LABEL = 'dsh-work.execution-container=1'
/** The only environment a command sees besides the image's own ENV; nothing is forwarded from the host or DSH. */
export const EXECUTION_COMMAND_ENV = [
  'LANG=C.UTF-8',
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  `HOME=${EXECUTION_CONTAINER_HOME}`,
  'TMPDIR=/tmp',
] as const
const KILL_GROUP_TIMEOUT_MS = 10_000
const QUIESCE_TIMEOUT_MS = 10_000
const CLIENT_EXIT_WAIT_MS = 2_000
const WATCHDOG_GRACE_SECONDS = 10

/**
 * Wraps one command (POSIX sh, arguments only as positional parameters): the command
 * runs in its own process group whose id is written to /tmp for KILL_GROUP, and an
 * in-container watchdog kills the group after the deadline even if the service died.
 */
const EXEC_WRAPPER = `t="$1"; n="$2"; shift 2
f="/tmp/.dsh-exec-$t"
setsid "$@" </dev/null &
p=$!
echo "$p" > "$f"
setsid sh -c 'sleep "$1"; kill -KILL -"$2" 2>/dev/null' dsh-watchdog "$n" "$p" </dev/null >/dev/null 2>&1 &
w=$!
wait "$p"; s=$?
kill -KILL -"$w" 2>/dev/null
rm -f "$f"
exit "$s"`

/**
 * Quiescence sweep (plan 3.7): SIGKILL every process except PID 1, the keeper and this
 * shell's own children, until one full pass finds none. Zombies hold no code and are
 * skipped; PID 1 (docker-init) reaps them. sh builtins only, so it needs nothing from the image.
 */
const QUIESCE = `keep="$1"
for round in 1 2 3 4 5; do
  found=0
  for d in /proc/[0-9]*; do
    p=\${d#/proc/}
    case "$p" in 1|"$keep"|"$$") continue ;; esac
    read -r stat < "$d/stat" 2>/dev/null || continue
    set -- \${stat##*) }
    case "$1" in Z|X) continue ;; esac
    [ "$2" = "$$" ] && continue
    kill -KILL "$p" 2>/dev/null
    found=$((found + 1))
  done
  [ "$found" -eq 0 ] && { echo clean; exit 0; }
  sleep 0.05
done
echo busy
exit 1`

const KILL_GROUP = `f="/tmp/.dsh-exec-$1"; i=0
while [ ! -s "$f" ] && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
p=$(cat "$f" 2>/dev/null) || exit 0
kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null
rm -f "$f"
exit 0`
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

  async inspectExecutionImage(image: string, user: string) {
    await this.inspectImage(image)
    if (!SANDBOX_USER_PATTERN.test(user)) throw invalidRequest('执行容器用户必须是非 root 的 uid:gid')
    const probe = await runCommand(this.command, [
      'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', user, '--entrypoint', 'rg', image, '--version',
    ], 30_000)
    if (probe.exitCode !== 0) throw dependencyUnavailable(`执行镜像缺少 rg，glob/grep 无法在容器内运行：${brief(probe.stderr) || image}`)
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
      runCommand(this.command, ['ps', '-aq', '--filter', `label=${EXECUTION_LABEL}`, '--format', '{{.Names}}'], 15_000),
      runCommand(this.command, ['ps', '-aq', '--filter', 'name=dsh-exec-', '--format', '{{.Names}}'], 15_000),
    ])
    if (listed.some(result => result.exitCode !== 0)) {
      throw dependencyUnavailable(`未能列出现有沙箱容器：${brief(listed.map(result => result.stderr).join(' ')) || 'docker ps 失败'}`)
    }
    const names = [...new Set(listed.flatMap(result => result.stdout.split('\n')).map(name => name.trim())
      .filter(name => PYTHON_CONTAINER_NAME_PATTERN.test(name) || EXECUTION_CONTAINER_NAME_PATTERN.test(name)))]
    if (!names.length) return
    const removed = await runCommand(this.command, ['rm', '-f', ...names], 15_000)
    if (!removalSucceeded(removed)) throw dependencyUnavailable(`未能清理遗留的沙箱容器：${brief(removed.stderr) || names.join(' ')}`)
    console.warn(`removed ${names.length} orphaned sandbox containers`)
  }

  async startExecutionContainer(spec: ExecutionContainerSpec) {
    const args = buildExecutionContainerArguments(spec, { memorySwap: this.memorySwap, apparmor: this.apparmor })
    const started = await runCommand(this.command, args, 60_000)
    if (started.exitCode === 0) {
      // Right after start PID 1 (docker-init) has exactly one child: the keeper.
      const children = await runCommand(this.command, ['exec', spec.name, 'cat', '/proc/1/task/1/children'], 15_000).catch(() => undefined)
      const keeperPid = Number(children?.stdout.trim().split(/\s+/)[0])
      if (children?.exitCode === 0 && Number.isSafeInteger(keeperPid) && keeperPid > 1) return { keeperPid }
    }
    await runCommand(this.command, ['rm', '-f', spec.name], RM_TIMEOUT_MS).catch(() => undefined)
    throw dependencyUnavailable(`执行容器启动失败：${brief(started.stderr) || spec.name}`)
  }

  async quiesce(name: string, keeperPid: number): Promise<boolean> {
    if (!EXECUTION_CONTAINER_NAME_PATTERN.test(name) || !Number.isSafeInteger(keeperPid) || keeperPid <= 1) return false
    try {
      const swept = await runCommand(this.command, ['exec', name, 'sh', '-c', QUIESCE, 'dsh-quiesce', String(keeperPid)], QUIESCE_TIMEOUT_MS)
      return swept.exitCode === 0 && swept.stdout.trim() === 'clean'
    } catch {
      return false
    }
  }

  async exec(name: string, command: ContainerCommand, signal: AbortSignal): Promise<ContainerCommandResult> {
    if (!EXECUTION_CONTAINER_NAME_PATTERN.test(name)) throw invalidRequest('执行容器名称无效')
    if (!command.argv.length) throw invalidRequest('命令不能为空')
    signal.throwIfAborted()
    const token = randomBytes(12).toString('hex')
    const watchdogSeconds = Math.ceil(command.timeoutMs / 1000) + WATCHDOG_GRACE_SECONDS
    const child = spawn(this.command, [
      'exec', '-w', command.cwd, ...EXECUTION_COMMAND_ENV.flatMap(value => ['-e', value]),
      name, 'sh', '-c', EXEC_WRAPPER, 'dsh-exec', token, String(watchdogSeconds), ...command.argv,
    ], { env: dockerCommandEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = boundedBytes(command.maxOutputBytes)
    const stderr = boundedBytes(command.maxOutputBytes)
    child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk))
    const exited = waitForExit(child)
    void exited.catch(() => undefined)
    let timedOut = false
    let killing: Promise<void> | undefined
    const killGroup = () => {
      killing ??= (async () => {
        await runCommand(this.command, ['exec', name, 'sh', '-c', KILL_GROUP, 'dsh-kill', token], KILL_GROUP_TIMEOUT_MS)
          .catch(() => undefined)
        await Promise.race([exited.then(() => undefined, () => undefined), delay(CLIENT_EXIT_WAIT_MS)])
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL') } catch { /* already exited */ }
        }
      })()
      return killing
    }
    const timer = setTimeout(() => { timedOut = true; void killGroup() }, command.timeoutMs)
    const onAbort = () => { void killGroup() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const exitCode = await exited
      if (killing) await killing
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return {
        exitCode: timedOut ? null : exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated() || stderr.truncated(),
        timedOut,
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
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
      throw stateConflict(`沙箱容器清理失败，容器可能仍在运行：${name}${detail ? `：${detail}` : ''}`)
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

export function buildExecutionContainerArguments(spec: ExecutionContainerSpec, features: { memorySwap: boolean; apparmor: boolean }) {
  if (!EXECUTION_CONTAINER_NAME_PATTERN.test(spec.name)) throw invalidRequest('执行容器名称无效')
  if (!SANDBOX_USER_PATTERN.test(spec.user)) throw invalidRequest('执行容器用户必须是非 root 的 uid:gid')
  const mounts = [spec.workspace, ...(spec.workspaceAliases ?? []).filter(alias => alias !== spec.workspace)]
  if (mounts.some(path => !isAbsolute(path) || path.includes(',') || path.includes('\0'))) throw invalidRequest('执行容器工作区路径无效')
  const [uid, gid] = spec.user.split(':')
  const limits = EXECUTION_CONTAINER_LIMITS
  return [
    'run', '-d', '--name', spec.name, '--label', EXECUTION_LABEL, '--init', '--pull', 'never',
    '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--security-opt', 'seccomp=builtin',
    ...(features.apparmor ? ['--security-opt', 'apparmor=docker-default'] : []),
    '--pids-limit', limits.pidsLimit,
    '--memory', limits.memory,
    ...(features.memorySwap ? ['--memory-swap', limits.memory] : []),
    '--cpus', limits.cpus,
    '--ulimit', `fsize=${limits.maxFileBytes}:${limits.maxFileBytes}`,
    '--user', spec.user,
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${limits.tmpfsSize},mode=1777`,
    '--tmpfs', `${EXECUTION_CONTAINER_HOME}:rw,nosuid,nodev,size=${limits.homeSize},uid=${uid},gid=${gid},mode=0700`,
    // Same absolute path inside and outside, so paths in tool output work in both worlds.
    ...mounts.flatMap(path => ['--mount', `type=bind,src=${path},dst=${path}`]),
    '--workdir', spec.workspace,
    '--entrypoint', 'sleep', spec.image, 'infinity',
  ]
}

/** Keeps at most `maxBytes` raw bytes of a stream and reports whether anything was dropped. */
function boundedBytes(maxBytes: number) {
  const chunks: Buffer[] = []
  let size = 0
  let dropped = false
  return {
    write(chunk: Buffer) {
      if (size >= maxBytes) { dropped = true; return }
      const accepted = chunk.subarray(0, maxBytes - size)
      if (accepted.length < chunk.length) dropped = true
      size += accepted.length
      chunks.push(accepted)
    },
    text: () => Buffer.concat(chunks, size).toString('utf8'),
    truncated: () => dropped,
  }
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
