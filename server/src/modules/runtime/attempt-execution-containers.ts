import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dependencyUnavailable, invalidRequest, stateConflict } from '../../domain/request-errors.ts'
import { builtinTools } from './builtin-tools.ts'
import type { ContainerCommand, ContainerCommandResult, ExecutionBackend } from './execution-backend.ts'
import type { ExecutionTool } from './execution-toolchain.ts'
import { PlatformToolError } from './platform-tool-contract.ts'
import type { RuntimeToolDescriptor } from './runtime-types.ts'
import {
  formatBytes, freeSpace, measureWorkspace, overWorkspaceLimit, WORKSPACE_LIMITS,
  type FreeSpace, type WorkspaceUsage,
} from './workspace-usage.ts'

/** A registry digest (`name@sha256:…`) or a local image ID (`sha256:…`); both are immutable. */
const IMAGE_PATTERN = /^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/
const REMOVAL_RETRY_INTERVAL_MS = 30_000

export interface AttemptExecutionContainersOptions {
  /** The execution image, pinned by digest or local image ID; must contain `rg`. */
  image: string
  /** Non-root `uid:gid` that can write the Attempt workspaces. */
  user: string
  /** Workspace and free-space measurement (plan 4.7); tests replace it. */
  usage?: {
    measure(workspace: string): Promise<WorkspaceUsage>
    freeSpace(workspace: string): Promise<FreeSpace>
    pollMs?: number
  }
}

/**
 * The container runs as the service account so it can write the Attempt workspace
 * it bind-mounts; a root service has no safe non-root identity for that, so the
 * mode is unavailable.
 */
export function resolveExecutionContainerUser(): string {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (!uid || !gid) throw invalidRequest('执行容器模式要求服务以非 root 账号运行')
  return `${uid}:${gid}`
}

/**
 * Settings removed when the execution container became mandatory (plan 4.9). They are ignored; the warning
 * keeps an operator from expecting `DSH_WORK_EXECUTION_CONTAINER=off` to fall back to host execution.
 */
export function removedExecutionSettingWarnings(env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = []
  if (env.DSH_WORK_EXECUTION_CONTAINER !== undefined) {
    warnings.push('DSH_WORK_EXECUTION_CONTAINER is removed and ignored: the execution container is always required, and "off" no longer runs DSH on the host')
  }
  for (const name of ['DSH_WORK_PYTHON_IMAGE', 'DSH_WORK_PYTHON_PACKAGES', 'DSH_WORK_PYTHON_USER', 'DSH_WORK_EXECUTION_MAX_CONTAINERS']) {
    if (env[name] !== undefined) warnings.push(`${name} is removed and ignored: python_execute runs in the execution container`)
  }
  return warnings
}

/** DSH reports resolved paths (macOS /var → /private/var), so the container must see that path too. */
function resolvedPath(path: string) {
  try { return realpathSync(path) } catch { return path }
}

interface AttemptContainer {
  name: string
  /** Settles once the container is running; shared by concurrent first commands. */
  ready: Promise<{ keeperPid: number }>
}

interface AttemptState {
  workspace: string
  container?: AttemptContainer
  /** Commands still running or still being followed by a quiescence check. */
  inflight: Set<Promise<unknown>>
  /** Quiescence could not be restored and the container could not be removed: no further commands. */
  failed: boolean
  /** Why the Attempt can run no further commands: quiescence, or the workspace far over its cap (plan 4.7). */
  failureReason?: 'quiescence' | 'workspace_limit'
}

export type ExecutionContainerIdleState = 'idle' | 'busy' | 'failed'

/**
 * One execution container per Attempt (plan 4.4): created on the first command,
 * removed when the Attempt ends. The count is bounded by the Runtime's own Attempt
 * capacity, so no extra slot is taken. Removal failures are retried for names this
 * process created only; other containers on the daemon are never touched while running.
 *
 * Quiescence (plan 3.7, 4.1): after a command that may leave processes behind, or
 * that failed, timed out or was cancelled, the container is swept; if it cannot be
 * confirmed clean it is removed and recreated on the next command. Until that has
 * finished the Attempt is busy (`waitUntilIdle`), so the host never touches the
 * workspace while container code may still run. If even removal fails the Attempt
 * is marked failed and every later command or idle wait reports it.
 */
export class AttemptExecutionContainers {
  readonly image: string
  readonly user: string
  /** Programs the startup check found in the image; listed in the Runtime instructions. Empty before preflight. */
  toolchain: readonly ExecutionTool[] = []
  /** Python distributions installed in the image (normalized names); Skill dependencies are checked against them (plan 4.8). */
  pythonPackages: readonly string[] = []
  private readonly backend: ExecutionBackend
  private readonly attempts = new Map<string, AttemptState>()
  private readonly pendingRemoval = new Set<string>()
  private retryTimer: NodeJS.Timeout | undefined
  private retrying = false
  private readonly usage: Required<NonNullable<AttemptExecutionContainersOptions['usage']>>

  constructor(backend: ExecutionBackend, options: AttemptExecutionContainersOptions) {
    if (!IMAGE_PATTERN.test(options.image)) throw invalidRequest('DSH_WORK_EXECUTION_IMAGE 必须使用 sha256 摘要锁定容器镜像')
    this.backend = backend
    this.image = options.image
    this.user = options.user
    this.usage = {
      measure: options.usage?.measure ?? (workspace => measureWorkspace(workspace)),
      freeSpace: options.usage?.freeSpace ?? freeSpace,
      pollMs: options.usage?.pollMs ?? WORKSPACE_LIMITS.pollMs,
    }
  }

  /** Why the Attempt was failed, if it was; the Adapter reports it. */
  failureReason(attemptId: string): AttemptState['failureReason'] {
    return this.attempts.get(attemptId)?.failureReason
  }

  get activeAttempts(): string[] { return [...this.attempts.entries()].filter(([, state]) => state.container).map(([id]) => id) }
  get pendingRemovals(): string[] { return [...this.pendingRemoval] }

  /** Image and toolchain check, feature detection and the startup orphan sweep (single service instance). */
  async preflight() {
    this.toolchain = await this.backend.inspectExecutionImage(this.image, this.user)
    if (this.toolchain.some(tool => tool.id === 'python3')) this.pythonPackages = await this.backend.inspectPythonPackages(this.image, this.user)
    await this.backend.detectFeatures()
    await this.backend.removeOrphans()
  }

  /**
   * Runs one command in the Attempt's container, creating it on first use. The
   * returned promise settles only after any required quiescence work, even when the
   * caller's signal aborts the command. Callers stop sending commands before
   * `release` (the Adapter closes the bridge first).
   */
  async exec(attemptId: string, workspace: string, command: ContainerCommand, signal: AbortSignal): Promise<ContainerCommandResult> {
    let state = this.attempts.get(attemptId)
    if (state && state.workspace !== workspace) throw invalidRequest('同一 Attempt 的执行容器只能挂载一个工作区')
    if (!state) {
      state = { workspace, inflight: new Set(), failed: false }
      this.attempts.set(attemptId, state)
    }
    if (state.failed) {
      throw stateConflict(state.failureReason === 'workspace_limit'
        ? `工作区超出 ${formatBytes(WORKSPACE_LIMITS.failBytes)}，本 Attempt 不能再执行命令`
        : '执行容器无法恢复静止，本 Attempt 不能再执行命令')
    }
    const work = this.runAndSettle(state, command, signal)
    state.inflight.add(work)
    void work.then(() => undefined, () => undefined).finally(() => state!.inflight.delete(work))
    return work
  }

  /**
   * Resolves once no command of the Attempt is running or settling: `idle`, or
   * `failed` when quiescence could not be restored; `busy` when `timeoutMs` passed first.
   */
  async waitUntilIdle(attemptId: string, timeoutMs: number): Promise<ExecutionContainerIdleState> {
    const state = this.attempts.get(attemptId)
    if (!state) return 'idle'
    const deadline = Date.now() + timeoutMs
    while (state.inflight.size) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return state.failed ? 'failed' : 'busy'
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled([...state.inflight]),
        new Promise(resolve => { timer = setTimeout(resolve, remaining) }),
      ])
      if (timer) clearTimeout(timer)
    }
    return state.failed ? 'failed' : 'idle'
  }

  /** Removes the Attempt's container, if one was created. */
  async release(attemptId: string) {
    const state = this.attempts.get(attemptId)
    if (!state) return
    this.attempts.delete(attemptId)
    await Promise.allSettled([...state.inflight])
    const container = state.container
    if (!container) return
    await container.ready.catch(() => undefined)
    try {
      await this.backend.remove(container.name)
    } catch (error) {
      this.pendingRemoval.add(container.name)
      console.warn(`execution container removal failed; retrying later: ${container.name}`)
      throw error
    }
  }

  /**
   * Plan 4.7: no command starts while the data volume is low on space. While it runs, the workspace
   * is measured every `pollMs`; growing past the cap, or the volume running low, stops the command
   * the way a timeout does and tells the model why. Commands that only shrink an over-cap workspace
   * (deleting files) are not stopped. Far over the cap after a command, the Attempt is failed.
   */
  private async runAndSettle(state: AttemptState, command: ContainerCommand, signal: AbortSignal): Promise<ContainerCommandResult> {
    // A failed check does not block commands: the guard protects the volume, it is not an access control.
    const lowOnSpace = async () => (await this.usage.freeSpace(state.workspace).catch(() => null))?.low === true
    if (await lowOnSpace()) throw diskLowError()
    const before = await this.usage.measure(state.workspace).catch((): WorkspaceUsage => ({ bytes: 0, entries: 0, truncated: false }))
    const container = this.containerFor(state)
    const { keeperPid } = await container.ready
    const limiter = new AbortController()
    let limit: 'workspace' | 'disk' | undefined
    let measured: WorkspaceUsage = before
    let measuring = false
    const watch = setInterval(() => {
      if (measuring || limit) return
      measuring = true
      void (async () => {
        measured = await this.usage.measure(state.workspace)
        if (overWorkspaceLimit(measured) && (measured.bytes > before.bytes || measured.entries > before.entries)) limit = 'workspace'
        else if (await lowOnSpace()) limit = 'disk'
        if (limit) limiter.abort()
      })().catch(() => undefined).finally(() => { measuring = false })
    }, this.usage.pollMs)
    let result: ContainerCommandResult | undefined
    let failure: unknown
    try {
      result = await this.backend.exec(container.name, command, AbortSignal.any([signal, limiter.signal]))
    } catch (error) {
      failure = error
    } finally {
      clearInterval(watch)
    }
    if (command.mayLeaveProcesses || failure !== undefined || result?.timedOut || limit) {
      await this.restoreQuiescence(state, container, keeperPid)
    }
    if (limit && !signal.aborted) {
      // Stopped by the platform, not by the caller: report it as the command's outcome.
      failure = undefined
      result = { exitCode: null, stdout: result?.stdout ?? '', stderr: limitNotice(limit, measured), truncated: result?.truncated ?? false, timedOut: false, limit }
    }
    if (!state.failed) {
      const after = await this.usage.measure(state.workspace).catch(() => null)
      if (after && (after.truncated || after.bytes > WORKSPACE_LIMITS.failBytes)) await this.failForWorkspace(state)
    }
    if (failure !== undefined) throw failure
    return result!
  }

  /** Far over the cap: no further commands, and the container is removed (plan 4.7, decision 3). */
  private async failForWorkspace(state: AttemptState) {
    state.failed = true
    state.failureReason = 'workspace_limit'
    const container = state.container
    state.container = undefined
    if (!container) return
    await this.backend.remove(container.name).catch(() => {
      this.pendingRemoval.add(container.name)
      console.warn(`execution container removal failed; retrying later: ${container.name}`)
    })
  }

  private containerFor(state: AttemptState): AttemptContainer {
    if (state.container) return state.container
    const name = `dsh-exec-${randomBytes(8).toString('hex')}`
    const resolved = resolvedPath(state.workspace)
    const ready = this.backend.startExecutionContainer({
      name, image: this.image, user: this.user, workspace: state.workspace,
      ...(resolved !== state.workspace ? { workspaceAliases: [resolved] } : {}),
    })
    const container = { name, ready }
    state.container = container
    // A failed start is not retried within the Attempt (plan 4.4): later commands see the same failure.
    void ready.catch(() => undefined)
    return container
  }

  /** Sweep; if not confirmed clean, remove the container (the next command recreates it). */
  private async restoreQuiescence(state: AttemptState, container: AttemptContainer, keeperPid: number) {
    if (await this.backend.quiesce(container.name, keeperPid)) return
    if (state.container === container) state.container = undefined
    try {
      await this.backend.remove(container.name)
    } catch {
      state.failed = true
      state.failureReason ??= 'quiescence'
      this.pendingRemoval.add(container.name)
      console.warn(`execution container could not be made quiescent or removed: ${container.name}`)
    }
  }

  /** Starts retrying failed removals. Call after a successful preflight; `close` stops it. */
  startMaintenance(intervalMs = REMOVAL_RETRY_INTERVAL_MS) {
    if (this.retryTimer) return
    this.retryTimer = setInterval(() => { void this.retryRemovals() }, intervalMs)
    this.retryTimer.unref()
  }

  close() {
    if (this.retryTimer) clearInterval(this.retryTimer)
    this.retryTimer = undefined
  }

  async retryRemovals() {
    if (this.retrying) return
    this.retrying = true
    try {
      for (const name of [...this.pendingRemoval]) {
        try {
          await this.backend.remove(name)
          this.pendingRemoval.delete(name)
        } catch {
          // keep it; the next round retries
        }
      }
    } finally {
      this.retrying = false
    }
  }
}

function diskLowError() {
  return new PlatformToolError({
    status: 503, code: 'EXECUTION_DISK_LOW',
    message: '服务器磁盘剩余空间不足，暂时不能运行命令；请稍后重试或联系管理员',
  })
}

/** What the model reads when the platform stopped a command (plan 4.7). */
function limitNotice(limit: 'workspace' | 'disk', usage: WorkspaceUsage) {
  if (limit === 'disk') return '命令已终止：服务器磁盘剩余空间不足。请停止写入大文件，并联系管理员。'
  const used = usage.truncated ? `超过 ${WORKSPACE_LIMITS.maxEntries} 个文件和目录` : `已用 ${formatBytes(usage.bytes)}`
  return `命令已终止：工作区${used}，超过上限 ${formatBytes(WORKSPACE_LIMITS.maxBytes)}。请删除不需要的中间文件（例如 rm -rf work/临时目录）后再继续；删除文件的命令不受影响。`
}

/** The only registry tools DSH may run alongside others (plan 3.7, 4.1): they read but never start container code. */
const PARALLEL_ALLOWED = new Set(['read', 'read_image', 'web_search'])

/**
 * Admission check for the quiescence guarantee (plan 3.7): in the DSH composition this
 * service runs, `bash` and every dsh-work registry tool other than plain reads must be
 * scheduled exclusively, so no tool touches the workspace while container code runs.
 * Fails closed when DSH did not report a scheduling mode for such a tool.
 */
export function assertExclusiveToolScheduling(
  tools: ReadonlyArray<Pick<RuntimeToolDescriptor, 'id' | 'dshScheduling'>>,
  registryNames: Iterable<string> = builtinTools.map(tool => tool.name),
) {
  const relevant = new Set([...registryNames, 'bash'])
  const violations = tools
    .filter(tool => relevant.has(tool.id))
    .filter(tool => tool.dshScheduling !== 'exclusive' && !(tool.dshScheduling === 'parallel' && PARALLEL_ALLOWED.has(tool.id)))
    .map(tool => `${tool.id}（${tool.dshScheduling ?? '未报告'}）`)
  if (violations.length) throw dependencyUnavailable(`DSH 工具调度不满足执行容器的静止保证：${violations.join('、')}`)
}
