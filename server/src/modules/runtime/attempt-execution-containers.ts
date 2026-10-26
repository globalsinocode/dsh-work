import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { invalidRequest } from '../../domain/request-errors.ts'
import type { ContainerCommand, ContainerCommandResult, ExecutionBackend } from './execution-backend.ts'

/** A registry digest (`name@sha256:…`) or a local image ID (`sha256:…`); both are immutable. */
const IMAGE_PATTERN = /^(?:[A-Za-z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/
const REMOVAL_RETRY_INTERVAL_MS = 30_000

export interface AttemptExecutionContainersOptions {
  /** The execution image, pinned by digest or local image ID; must contain `rg`. */
  image: string
  /** Non-root `uid:gid` that can write the Attempt workspaces. */
  user: string
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

/** DSH reports resolved paths (macOS /var → /private/var), so the container must see that path too. */
function resolvedPath(path: string) {
  try { return realpathSync(path) } catch { return path }
}

interface AttemptEntry {
  workspace: string
  name: string
  /** Settles once the container is running; shared by concurrent first commands. */
  ready: Promise<void>
}

/**
 * One execution container per Attempt (plan 4.4): created on the first command,
 * removed when the Attempt ends. The count is bounded by the Runtime's own Attempt
 * capacity, so no extra slot is taken. Removal failures are retried for names this
 * process created only; other containers on the daemon are never touched while running.
 */
export class AttemptExecutionContainers {
  readonly image: string
  readonly user: string
  private readonly backend: ExecutionBackend
  private readonly attempts = new Map<string, AttemptEntry>()
  private readonly pendingRemoval = new Set<string>()
  private retryTimer: NodeJS.Timeout | undefined
  private retrying = false

  constructor(backend: ExecutionBackend, options: AttemptExecutionContainersOptions) {
    if (!IMAGE_PATTERN.test(options.image)) throw invalidRequest('DSH_WORK_EXECUTION_IMAGE 必须使用 sha256 摘要锁定容器镜像')
    this.backend = backend
    this.image = options.image
    this.user = options.user
  }

  get activeAttempts(): string[] { return [...this.attempts.keys()] }
  get pendingRemovals(): string[] { return [...this.pendingRemoval] }

  /** Image check (including `rg`), feature detection and the startup orphan sweep (single service instance). */
  async preflight() {
    await this.backend.inspectExecutionImage(this.image, this.user)
    await this.backend.detectFeatures()
    await this.backend.removeOrphans()
  }

  /**
   * Runs one command in the Attempt's container, creating it on first use. Callers
   * stop sending commands before `release` (the Adapter closes the bridge first).
   */
  async exec(attemptId: string, workspace: string, command: ContainerCommand, signal: AbortSignal): Promise<ContainerCommandResult> {
    let entry = this.attempts.get(attemptId)
    if (entry && entry.workspace !== workspace) throw invalidRequest('同一 Attempt 的执行容器只能挂载一个工作区')
    if (!entry) {
      const name = `dsh-exec-${randomBytes(8).toString('hex')}`
      const resolved = resolvedPath(workspace)
      const ready = this.backend.startExecutionContainer({
        name, image: this.image, user: this.user, workspace,
        ...(resolved !== workspace ? { workspaceAliases: [resolved] } : {}),
      })
      entry = { workspace, name, ready }
      this.attempts.set(attemptId, entry)
      void ready.catch(() => undefined)
    }
    await entry.ready
    return this.backend.exec(entry.name, command, signal)
  }

  /** Removes the Attempt's container, if one was created. */
  async release(attemptId: string) {
    const entry = this.attempts.get(attemptId)
    if (!entry) return
    this.attempts.delete(attemptId)
    await entry.ready.catch(() => undefined)
    try {
      await this.backend.remove(entry.name)
    } catch (error) {
      this.pendingRemoval.add(entry.name)
      console.warn(`execution container removal failed; retrying later: ${entry.name}`)
      throw error
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
