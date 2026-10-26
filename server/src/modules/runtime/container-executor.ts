import { randomBytes } from 'node:crypto'
import { invalidRequest, RequestError } from '../../domain/request-errors.ts'
import { PYTHON_SANDBOX_LIMITS, type ExecutionBackend, type PythonSandboxSpec, type RunningSandbox } from './execution-backend.ts'

const IMAGE_PATTERN = /^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/
const CLI_KILL_WAIT_MS = 2_000
const WATCH_INTERVAL_MS = 100
const REMOVAL_RETRY_INTERVAL_MS = 30_000
const MAX_CONTAINERS_LIMIT = 64
export const DEFAULT_MAX_CONTAINERS = 4

export interface ContainerExecutorOptions {
  /** The only image this executor will run; must be pinned by sha256 digest. */
  pythonImage: string
  /** Containers this service instance may hold at once, including ones whose removal is still pending. */
  maxContainers?: number
}

export interface PythonSandboxRequest {
  /** Non-root `uid:gid`. */
  user: string
  skillRoot: string
  inputRoot: string
  outputRoot: string
  entry: string
  args: string[]
  /** Polled while the container runs; resolving true stops and removes it early. */
  shouldStop?: () => Promise<boolean>
}

export interface SandboxRunResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when `shouldStop` ended the run. */
  stoppedEarly: boolean
}

/**
 * The executor module: the single code path that starts containers. It accepts
 * only fixed request fields, runs only the configured digest-pinned image, and
 * owns lifecycle policy: a global slot per container (held until removal is
 * confirmed), abort and timeout cleanup, and retrying removals that failed.
 */
export class ContainerExecutor {
  readonly pythonImage: string
  private readonly backend: ExecutionBackend
  private readonly slots: ExecutionSlots
  private readonly pendingRemoval = new Map<string, () => void>()
  private retryTimer: NodeJS.Timeout | undefined
  private retrying = false

  constructor(backend: ExecutionBackend, options: ContainerExecutorOptions) {
    if (!IMAGE_PATTERN.test(options.pythonImage)) throw invalidRequest('DSH_WORK_PYTHON_IMAGE 必须使用 sha256 摘要锁定容器镜像')
    this.backend = backend
    this.pythonImage = options.pythonImage
    this.slots = new ExecutionSlots(options.maxContainers ?? DEFAULT_MAX_CONTAINERS)
  }

  get capacity() { return this.slots.capacity }
  get containersInUse() { return this.slots.inUse }
  get pendingRemovals(): string[] { return [...this.pendingRemoval.keys()] }

  /** Image check, feature detection and the startup orphan sweep (single service instance). */
  async preflight() {
    await this.backend.inspectImage(this.pythonImage)
    await this.backend.detectFeatures()
    await this.backend.removeOrphans()
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

  /**
   * Only retries names this process failed to remove. Other containers on the
   * daemon are never touched while running; the full sweep happens at startup.
   */
  async retryRemovals() {
    if (this.retrying) return
    this.retrying = true
    try {
      for (const [name, release] of [...this.pendingRemoval]) {
        try {
          await this.backend.remove(name)
        } catch {
          continue // keep the slot reserved; the next round retries
        }
        this.pendingRemoval.delete(name)
        release()
      }
    } finally {
      this.retrying = false
    }
  }

  /**
   * Waits for a global slot (abortable; the wait counts against the caller's
   * tool budget), runs one sandbox, and settles only after the container is
   * stopped and removed or removal failed loudly.
   */
  async runPythonSandbox(request: PythonSandboxRequest, signal: AbortSignal): Promise<SandboxRunResult> {
    const release = await this.slots.acquire(signal)
    if (signal.aborted) {
      release()
      throw abortError()
    }
    const lifecycle = { removalFailed: false }
    const spec: PythonSandboxSpec = {
      name: createPythonContainerName(),
      image: this.pythonImage,
      user: request.user,
      skillRoot: request.skillRoot,
      inputRoot: request.inputRoot,
      outputRoot: request.outputRoot,
      entry: request.entry,
      args: request.args,
    }
    try {
      return await this.runContainer(spec, request.shouldStop, signal, lifecycle)
    } finally {
      if (lifecycle.removalFailed) {
        this.pendingRemoval.set(spec.name, release)
        console.warn(`sandbox container removal failed; slot held until a retry removes ${spec.name}`)
      } else {
        release()
      }
    }
  }

  private async runContainer(
    spec: PythonSandboxSpec,
    shouldStop: PythonSandboxRequest['shouldStop'],
    signal: AbortSignal,
    lifecycle: { removalFailed: boolean },
  ): Promise<SandboxRunResult> {
    const sandbox = this.backend.startPythonSandbox(spec)
    let stoppedEarly = false
    let watch = true
    let cleanupError: unknown
    let cleanupPromise: Promise<void> | undefined
    const ensureCleanup = (stop: boolean) => {
      if (!cleanupPromise) {
        const operation = stop ? this.stopAndRemove(spec.name, sandbox) : this.backend.remove(spec.name)
        cleanupPromise = operation.then(() => undefined, error => {
          cleanupError = error
          if (isCleanupFailure(error)) lifecycle.removalFailed = true
        })
      }
      return cleanupPromise
    }
    const onAbort = () => { void ensureCleanup(true) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const timer = setInterval(() => {
      if (!watch || !shouldStop) return
      void shouldStop().then(stop => {
        if (!watch || !stop) return
        stoppedEarly = true
        watch = false
        void ensureCleanup(true)
      }).catch(() => undefined)
    }, WATCH_INTERVAL_MS)
    try {
      const exitCode = await sandbox.exited
      watch = false
      clearInterval(timer)
      await ensureCleanup(stoppedEarly || signal.aborted)
      if (cleanupError) throw cleanupError
      if (signal.aborted) throw abortError()
      return { exitCode, stdout: sandbox.stdout(), stderr: sandbox.stderr(), stoppedEarly }
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

  private async stopAndRemove(name: string, sandbox: RunningSandbox): Promise<void> {
    await this.backend.stop(name, PYTHON_SANDBOX_LIMITS.stopGraceSeconds)
    if (sandbox.alive()) sandbox.kill()
    await Promise.race([sandbox.exited.then(() => undefined, () => undefined), delay(CLI_KILL_WAIT_MS)])
    await this.backend.remove(name)
  }
}

/** Counting semaphore with a FIFO, abortable wait. A release hands the slot straight to the next waiter. */
export class ExecutionSlots {
  readonly capacity: number
  private used = 0
  private readonly waiters: Array<() => void> = []

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CONTAINERS_LIMIT) throw invalidRequest(`执行容器并发上限必须是 1–${MAX_CONTAINERS_LIMIT} 的整数`)
    this.capacity = capacity
  }

  get inUse() { return this.used }
  get waiting() { return this.waiters.length }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError())
    if (this.used < this.capacity) {
      this.used += 1
      return Promise.resolve(this.releaser())
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort)
        resolve(this.releaser())
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(grant)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(grant)
    })
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.used -= 1
    }
  }
}

/** `DSH_WORK_EXECUTION_MAX_CONTAINERS`: unset means the default; anything malformed fails closed. */
export function parseMaxContainers(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_MAX_CONTAINERS
  const text = value.trim()
  const parsed = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CONTAINERS_LIMIT) {
    throw invalidRequest(`DSH_WORK_EXECUTION_MAX_CONTAINERS 必须是 1–${MAX_CONTAINERS_LIMIT} 的整数`)
  }
  return parsed
}

export function createPythonContainerName(): string {
  return `dsh-py-${randomBytes(8).toString('hex')}`
}

function isCleanupFailure(error: unknown): boolean {
  return error instanceof RequestError && error.code === 'state_conflict'
}

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
