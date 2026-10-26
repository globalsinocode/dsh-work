import { createHash } from 'node:crypto'
import { type Stats } from 'node:fs'
import { lstat, readdir, mkdir, rm, chmod, chown, copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RuntimeManifest } from './runtime-types.ts'
import type { ContainerExecutor } from './container-executor.ts'
import { PYTHON_SANDBOX_LIMITS } from './execution-backend.ts'
import { dependencyUnavailable, invalidRequest, RequestError } from '../../domain/request-errors.ts'

const ENTRY_PATTERN = /^(?:scripts\/)?[A-Za-z0-9._/-]+\.py$/
const SANDBOX_USER_PATTERN = /^[1-9]\d{0,9}:[1-9]\d{0,9}$/

export interface PythonSkillRunnerOptions {
  /** Non-root `uid:gid`. Defaults to the service uid when that is non-root, otherwise 65534:65534. */
  user?: string
}

/**
 * Executes declared Python source in a disposable, network-disabled container.
 * Validation, mounts, output quota and artifact collection live here; every
 * container is started through the ContainerExecutor.
 */
export class PythonSkillRunner {
  readonly user: string
  private readonly executor: ContainerExecutor

  constructor(executor: ContainerExecutor, options: PythonSkillRunnerOptions = {}) {
    this.executor = executor
    this.user = resolvePythonSandboxUser(options.user)
  }

  async preflight() {
    await this.executor.preflight()
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
      const result = await this.executor.runPythonSandbox({
        user: this.user,
        skillRoot: skillMount,
        inputRoot: inputMount,
        outputRoot,
        entry,
        args: args as string[],
        shouldStop: async () => outputOverQuota(await measurePythonOutput(outputRoot)),
      }, signal)
      const collected = await listArtifacts(outputRoot)
      const notice = quotaNotice(result.stoppedEarly, collected.dropped)
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

function safeSegment(value: string): string {
  const readable = value.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}
