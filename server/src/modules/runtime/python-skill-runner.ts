import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createHash, randomBytes } from 'node:crypto'
import { type Stats } from 'node:fs'
import { lstat, readdir, mkdir, rm, chmod, chown, copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RuntimeManifest } from './runtime-types.ts'
import { dependencyUnavailable, invalidRequest, RequestError, stateConflict } from '../../domain/request-errors.ts'

const IMAGE_PATTERN = /^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/
const ENTRY_PATTERN = /^(?:scripts\/)?[A-Za-z0-9._/-]+\.py$/
const CONTAINER_NAME_PATTERN = /^dsh-py-[0-9a-f]{16}$/
const SANDBOX_USER_PATTERN = /^[1-9]\d{0,9}:[1-9]\d{0,9}$/
const SANDBOX_LABEL = 'dsh-work.python-sandbox=1'
const DOCKER_ENV_KEYS = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'TMPDIR'] as const

/** Host-side output budget. Per-file ulimit is one byte higher so a truncated write is larger than anything we keep. */
export const PYTHON_SANDBOX_LIMITS = {
  maxArtifactBytes: 10 * 1024 * 1024,
  maxArtifactFiles: 20,
  maxOutputBytes: 20 * 1024 * 1024,
  memory: '256m',
  cpus: '0.5',
  pidsLimit: '64',
  shmSize: '64m',
  tmpfsSize: '32m',
  stopGraceSeconds: 2,
} as const

const FSIZE_LIMIT = PYTHON_SANDBOX_LIMITS.maxArtifactBytes + 1
const STOP_COMMAND_TIMEOUT_MS = 4_000
const CLI_KILL_WAIT_MS = 2_000
const RM_TIMEOUT_MS = 3_000
const MAX_CAPTURE_BYTES = 1024 * 1024

export interface PythonSkillRunnerOptions {
  command?: string
  /** Non-root `uid:gid`. Defaults to the service uid when that is non-root, otherwise 65534:65534. */
  user?: string
}

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

/** Executes declared Python source in a disposable, network-disabled container. */
export class PythonSkillRunner {
  readonly image: string
  readonly user: string
  private readonly command: string
  private memorySwap = false
  private apparmor = false

  constructor(image: string, options: PythonSkillRunnerOptions = {}) {
    if (!IMAGE_PATTERN.test(image)) throw invalidRequest('DSH_WORK_PYTHON_IMAGE 必须使用 sha256 摘要锁定容器镜像')
    this.image = image
    this.command = options.command ?? 'docker'
    this.user = resolvePythonSandboxUser(options.user)
  }

  async preflight() {
    const inspected = await runCommand(this.command, ['image', 'inspect', this.image], 15_000)
    if (inspected.exitCode !== 0) throw dependencyUnavailable(`Python Skill 沙箱镜像不可用：${inspected.stderr.trim() || this.image}`)
    const info = await runCommand(this.command, ['info', '--format', '{{.SwapLimit}}\n{{json .SecurityOptions}}'], 15_000)
    if (info.exitCode === 0) {
      const parsed = parseDockerInfo(info.stdout)
      this.memorySwap = parsed.swapLimit
      this.apparmor = parsed.apparmor
    }
    await sweepPythonSandboxContainers(this.command)
  }

  async execute(input: Record<string, unknown>, manifest: RuntimeManifest, workspaceDirectory: string, signal: AbortSignal) {
    const skillName = typeof input['skill'] === 'string' ? input['skill'].trim() : ''
    const entry = typeof input['entry'] === 'string' ? input['entry'].trim() : ''
    const args = input['args'] === undefined ? [] : input['args']
    if (!skillName || !ENTRY_PATTERN.test(entry) || entry.includes('..')) throw invalidRequest('Python Skill 或入口文件无效')
    if (!Array.isArray(args) || args.length > 32 || args.some(value => typeof value !== 'string' || value.length > 1000 || value.includes('\0'))) throw invalidRequest('Python 参数无效')
    const matches = manifest.agent_configuration.skill_instructions.filter(skill => (skill.name ?? skill.id) === skillName || skill.id === skillName)
    if (matches.length !== 1 || !matches[0]!.files?.some(file => file.path === entry && file.path.endsWith('.py'))) throw new Error('入口文件未在当前 Run 的锁定 Skill 中声明')
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const skillRoot = resolve(workspaceDirectory, 'skills', safeSegment(matches[0]!.id))
    const inputRoot = resolve(workspaceDirectory, 'input')
    const outputRoot = resolve(workspaceDirectory, 'python-output', safeSegment(matches[0]!.id))
    const [uidText, gidText] = this.user.split(':')
    const uid = Number(uidText)
    const gid = Number(gidText)
    const staged: string[] = []
    try {
      await Promise.all([mkdir(inputRoot, { recursive: true }), mkdir(outputRoot, { recursive: true })])
      await prepareOutput(outputRoot, uid, gid)
      const skillMount = await resolveMount(skillRoot, uid, gid, staged)
      const inputMount = await resolveMount(inputRoot, uid, gid, staged)
      const name = createPythonContainerName()
      const dockerArgs = buildPythonSandboxArguments(this.image, skillMount, inputMount, outputRoot, entry, args as string[], {
        name,
        user: this.user,
        memorySwap: this.memorySwap,
        apparmor: this.apparmor,
      })
      const result = await runContainer(this.command, dockerArgs, name, outputRoot, signal)
      const collected = await listArtifacts(outputRoot)
      const notice = quotaNotice(result.quotaHit, collected.dropped)
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: notice ? `${result.stderr}\n${notice}`.trim() : result.stderr,
        artifacts: collected.artifacts,
      }
    } catch (error) {
      await listArtifacts(outputRoot).catch(() => undefined)
      throw error
    } finally {
      await Promise.all(staged.map(path => rm(path, { recursive: true, force: true })))
    }
  }
}

export function resolvePythonSandboxUser(configured?: string): string {
  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  const fallback = uid > 0 && gid > 0 ? `${uid}:${gid}` : '65534:65534'
  const candidate = configured?.trim() ? configured.trim() : fallback
  if (!SANDBOX_USER_PATTERN.test(candidate)) throw invalidRequest('DSH_WORK_PYTHON_USER 必须是非 root 的 uid:gid，例如 65534:65534')
  const [uidText, gidText] = candidate.split(':')
  const parsedUid = Number(uidText)
  const parsedGid = Number(gidText)
  if (!Number.isSafeInteger(parsedUid) || !Number.isSafeInteger(parsedGid) || parsedUid > 4_294_967_294 || parsedGid > 4_294_967_294) {
    throw invalidRequest('DSH_WORK_PYTHON_USER 必须是非 root 的 uid:gid，例如 65534:65534')
  }
  return `${parsedUid}:${parsedGid}`
}

export function createPythonContainerName(): string {
  return `dsh-py-${randomBytes(8).toString('hex')}`
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
  if (!CONTAINER_NAME_PATTERN.test(options.name)) throw invalidRequest('Python 沙箱容器名称无效')
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

export async function listArtifacts(root: string): Promise<{ artifacts: Array<{ name: string; size: number }>; dropped: boolean }> {
  let names: string[]
  try { names = (await readdir(root)).sort() }
  catch { return { artifacts: [], dropped: false } }
  const artifacts: Array<{ name: string; size: number }> = []
  let total = 0
  let dropped = false
  for (const name of names) {
    const path = join(root, name)
    let details: Stats
    try { details = await lstat(path) }
    catch { continue }
    const keep = /^[A-Za-z0-9._-]+$/.test(name)
      && details.isFile()
      && !details.isSymbolicLink()
      && details.nlink === 1
      && details.size <= PYTHON_SANDBOX_LIMITS.maxArtifactBytes
      && artifacts.length < PYTHON_SANDBOX_LIMITS.maxArtifactFiles
      && total + details.size <= PYTHON_SANDBOX_LIMITS.maxOutputBytes
    if (!keep) {
      dropped = true
      await rm(path, { recursive: true, force: true })
      continue
    }
    artifacts.push({ name, size: details.size })
    total += details.size
  }
  return { artifacts, dropped }
}

/** True when every file and directory under `root` is readable by `uid:gid` without following links. */
export async function pythonMountReadable(root: string, uid: number, gid: number): Promise<boolean> {
  const status = await inspectMount(root, uid, gid)
  if (status === 'symlink') throw invalidRequest('Python 沙箱拒绝跟随符号链接')
  return status === 'ok' || status === 'missing'
}

/**
 * `signal` is intentionally not passed to `spawn`. Node would only SIGTERM the
 * docker CLI, which forwards that signal to Python as PID 1; Python ignores it
 * and the container keeps writing to the bind mount. Cleanup stops the named
 * container (grace, then SIGKILL) and removes it before this promise settles.
 */
async function runContainer(
  command: string,
  args: string[],
  name: string,
  outputRoot: string,
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string; quotaHit: boolean }> {
  const child = spawn(command, args, { env: dockerCommandEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = boundedUtf8Collector()
  const stderr = boundedUtf8Collector()
  child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk))
  const exited = waitForExit(child)
  void exited.catch(() => undefined)
  let quotaHit = false
  let watch = true
  let cleanupError: unknown
  let cleanupPromise: Promise<void> | undefined
  const ensureCleanup = (stop: boolean) => {
    if (!cleanupPromise) {
      const operation = stop ? stopAndRemove(command, name, child, exited) : removeContainer(command, name)
      cleanupPromise = operation.then(() => undefined, error => { cleanupError = error })
    }
    return cleanupPromise
  }
  const onAbort = () => { void ensureCleanup(true) }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const timer = setInterval(() => {
    if (!watch) return
    void measurePythonOutput(outputRoot).then(measured => {
      if (!watch || !outputOverQuota(measured)) return
      quotaHit = true
      watch = false
      void ensureCleanup(true)
    }).catch(() => undefined)
  }, 100)
  try {
    const exitCode = await exited
    watch = false
    clearInterval(timer)
    await ensureCleanup(quotaHit || signal.aborted)
    if (cleanupError) throw cleanupError
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return { exitCode, stdout: stdout.text(), stderr: stderr.text(), quotaHit }
  } catch (error) {
    watch = false
    clearInterval(timer)
    await ensureCleanup(true)
    if (cleanupError && !isCleanupFailure(error)) throw cleanupError
    throw error
  } finally {
    watch = false
    clearInterval(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

async function stopAndRemove(command: string, name: string, child: ChildProcess, exited: Promise<number>): Promise<void> {
  await runCommand(command, ['stop', '-t', String(PYTHON_SANDBOX_LIMITS.stopGraceSeconds), name], STOP_COMMAND_TIMEOUT_MS).catch(() => undefined)
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* process already exited */ }
  }
  await Promise.race([exited.then(() => undefined, () => undefined), delay(CLI_KILL_WAIT_MS)])
  await removeContainer(command, name)
}

async function removeContainer(command: string, name: string): Promise<void> {
  const removed = await runCommand(command, ['rm', '-f', name], RM_TIMEOUT_MS)
  if (!removalSucceeded(removed)) {
    const detail = brief(removed.stderr)
    throw stateConflict(`Python 沙箱容器清理失败，容器可能仍在运行：${name}${detail ? `：${detail}` : ''}`)
  }
}

async function sweepPythonSandboxContainers(command: string): Promise<void> {
  const listed = await Promise.all([
    runCommand(command, ['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}`, '--format', '{{.Names}}'], 15_000),
    runCommand(command, ['ps', '-aq', '--filter', 'name=dsh-py-', '--format', '{{.Names}}'], 15_000),
  ])
  if (listed.some(result => result.exitCode !== 0)) {
    throw dependencyUnavailable(`未能列出现有 Python 沙箱容器：${brief(listed.map(result => result.stderr).join(' ')) || 'docker ps 失败'}`)
  }
  const names = [...new Set(listed.flatMap(result => result.stdout.split('\n')).map(name => name.trim()).filter(name => CONTAINER_NAME_PATTERN.test(name)))]
  if (!names.length) return
  const removed = await runCommand(command, ['rm', '-f', ...names], 15_000)
  if (!removalSucceeded(removed)) throw dependencyUnavailable(`未能清理遗留的 Python 沙箱容器：${brief(removed.stderr) || names.join(' ')}`)
  console.warn(`removed ${names.length} orphaned Python sandbox containers`)
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

async function measurePythonOutput(root: string): Promise<{ files: number; bytes: number; unsafe: boolean }> {
  let files = 0
  let bytes = 0
  let unsafe = false
  const stack = [root]
  while (stack.length) {
    const directory = stack.pop()
    if (!directory) break
    let names: string[]
    try { names = await readdir(directory) }
    catch { continue }
    for (const name of names) {
      const path = join(directory, name)
      let details: Stats
      try { details = await lstat(path) }
      catch { continue }
      if (details.isSymbolicLink() || (!details.isFile() && !details.isDirectory())) {
        unsafe = true
        continue
      }
      if (details.isDirectory()) {
        stack.push(path)
        continue
      }
      files += 1
      bytes += details.size
      if (details.size > PYTHON_SANDBOX_LIMITS.maxArtifactBytes) unsafe = true
    }
  }
  return { files, bytes, unsafe }
}

function outputOverQuota(measured: { files: number; bytes: number; unsafe: boolean }): boolean {
  return measured.unsafe
    || measured.files > PYTHON_SANDBOX_LIMITS.maxArtifactFiles
    || measured.bytes > PYTHON_SANDBOX_LIMITS.maxOutputBytes
}

function quotaNotice(quotaHit: boolean, dropped: boolean): string {
  if (quotaHit) return 'Python 沙箱输出超出单文件 10 MB、合计 20 MB、20 个文件或允许的文件类型，执行已停止，未收集或被截断的文件已删除。'
  if (dropped) return 'Python 沙箱已删除未收集、超额或被截断的输出文件。'
  return ''
}

async function prepareOutput(root: string, uid: number, gid: number) {
  await mkdir(root, { recursive: true })
  const euid = process.getuid?.() ?? -1
  if (euid === 0) {
    await chown(root, uid, gid)
    await chmod(root, 0o700)
    for (const name of await readdir(root)) {
      const path = join(root, name)
      const details = await lstat(path)
      if (details.isSymbolicLink()) continue
      await chown(path, uid, gid)
    }
    return
  }
  if (euid === uid) {
    await chmod(root, 0o700)
    return
  }
  throw dependencyUnavailable('Python 沙箱用户与服务进程用户不一致，且当前进程不能修改目录属主。请将 DSH_WORK_PYTHON_USER 设为服务进程的 uid:gid，或让服务以 root 运行以便把输出目录交给沙箱用户。')
}

async function resolveMount(source: string, uid: number, gid: number, staged: string[]): Promise<string> {
  const status = await inspectMount(source, uid, gid)
  if (status === 'missing') return source
  if (status === 'symlink') throw invalidRequest('Python 沙箱拒绝跟随符号链接')
  if (status === 'ok') return source
  if ((process.getuid?.() ?? -1) !== 0) {
    throw dependencyUnavailable('Python 沙箱用户无法读取挂载的 Skill 或输入文件。请将 DSH_WORK_PYTHON_USER 设为服务进程的非 root uid:gid；服务以 root 运行时会为沙箱用户准备只读副本。')
  }
  const stage = await stageReadableTree(source, uid, gid)
  staged.push(stage)
  return stage
}

async function stageReadableTree(source: string, uid: number, gid: number): Promise<string> {
  const stage = await mkdtemp(join(tmpdir(), 'dsh-py-mount-'))
  try {
    await copyOwnedTree(source, stage)
    await chownTree(stage, uid, gid)
    return stage
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    if (error instanceof RequestError) throw error
    throw dependencyUnavailable('无法将 Python 沙箱挂载副本交给指定用户，请确认服务进程具有 chown 权限')
  }
}

async function copyOwnedTree(source: string, target: string): Promise<void> {
  const details = await lstat(source)
  if (details.isSymbolicLink()) throw invalidRequest('Python 沙箱拒绝跟随符号链接')
  if (details.isDirectory()) {
    await mkdir(target, { recursive: true })
    await chmod(target, 0o700)
    for (const name of await readdir(source)) await copyOwnedTree(join(source, name), join(target, name))
    return
  }
  if (!details.isFile()) throw invalidRequest('Python 沙箱挂载只允许普通文件和目录')
  await copyFile(source, target)
  await chmod(target, 0o400)
}

async function chownTree(root: string, uid: number, gid: number): Promise<void> {
  const details = await lstat(root)
  if (details.isSymbolicLink()) throw invalidRequest('Python 沙箱拒绝跟随符号链接')
  await chown(root, uid, gid)
  if (!details.isDirectory()) return
  for (const name of await readdir(root)) await chownTree(join(root, name), uid, gid)
}

async function inspectMount(root: string, uid: number, gid: number): Promise<'ok' | 'unreadable' | 'symlink' | 'missing'> {
  const stack = [root]
  let sawRoot = false
  while (stack.length) {
    const current = stack.pop()
    if (!current) break
    let details: Stats
    try { details = await lstat(current) }
    catch { return sawRoot ? 'unreadable' : 'missing' }
    sawRoot = true
    if (details.isSymbolicLink()) return 'symlink'
    if (!details.isDirectory() && !details.isFile()) return 'unreadable'
    const required = details.isDirectory() ? 0o5 : 0o4
    if (!modeAllows(details.mode, details.uid, details.gid, uid, gid, required)) return 'unreadable'
    if (details.isDirectory()) {
      for (const name of await readdir(current)) stack.push(join(current, name))
    }
  }
  return 'ok'
}

function modeAllows(mode: number, owner: number, group: number, uid: number, gid: number, required: number): boolean {
  if (owner === uid && (mode & (required << 6)) === (required << 6)) return true
  if (group === gid && (mode & (required << 3)) === (required << 3)) return true
  return (mode & required) === required
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

function isCleanupFailure(error: unknown): boolean {
  return error instanceof RequestError && error.code === 'state_conflict'
}

function brief(text: string): string {
  const oneLine = text.replaceAll(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function safeSegment(value: string): string {
  const readable = value.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}
