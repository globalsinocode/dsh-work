/**
 * ExecutionBackend port: the only place a container runtime is driven.
 *
 * Callers describe a sandbox with fixed fields (image, user, mounts, entry,
 * args); the posture (network, read-only root, capabilities, seccomp, limits)
 * belongs to the implementation and cannot be overridden through the spec.
 * Lifecycle policy (slots, abort, cleanup, removal retry) lives in
 * ContainerExecutor, not here.
 */
import type { ExecutionTool } from './execution-toolchain.ts'

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

export interface PythonSandboxSpec {
  name: string
  image: string
  /** Non-root `uid:gid`. */
  user: string
  skillRoot: string
  inputRoot: string
  outputRoot: string
  entry: string
  args: string[]
}

export interface RunningSandbox {
  /** Exit code of the foreground runtime client; rejects when it cannot be started. */
  readonly exited: Promise<number>
  stdout(): string
  stderr(): string
  /** True while the foreground runtime client is still alive. */
  alive(): boolean
  /** Kills the foreground runtime client only; the container itself is stopped through `stop`. */
  kill(): void
}

/** Posture limits of the per-Attempt execution container (plan 4.2). */
export const EXECUTION_CONTAINER_LIMITS = {
  memory: '1g',
  cpus: '2',
  pidsLimit: '256',
  tmpfsSize: '128m',
  homeSize: '256m',
  /**
   * Largest single file a command may write (`ulimit -f`), workspace included. Well above the
   * 10 MB artifact limit so Office conversions have room; total workspace disk is not bounded.
   */
  maxFileBytes: 256 * 1024 * 1024,
  /** Upper bound for one command; the caller's own timeout is usually shorter. */
  maxCommandMs: 600_000,
  maxOutputBytes: 16 * 1024 * 1024,
} as const

/** HOME inside the execution container: a tmpfs owned by the container user. */
export const EXECUTION_CONTAINER_HOME = '/home/exec'

export interface ExecutionContainerSpec {
  name: string
  image: string
  /** Non-root `uid:gid`. */
  user: string
  /** Host path of the Attempt workspace; mounted at the same path inside the container. */
  workspace: string
  /** Other host paths of the same directory (its resolved path when it differs), each mounted at itself too. */
  workspaceAliases?: string[]
}

export interface ContainerCommand {
  /** argv[0] is an executable name inside the image, never a host path. */
  argv: string[]
  /** Absolute path inside the workspace (identical on host and in the container). */
  cwd: string
  maxOutputBytes: number
  timeoutMs: number
  /**
   * True when the program can leave processes behind (`bash`; Python later). The
   * container must then be verified quiescent before the host touches the workspace again.
   */
  mayLeaveProcesses?: boolean
}

export interface ContainerCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  /** Stopped by the platform: workspace over its cap, or the data volume low on space (plan 4.7). */
  limit?: 'workspace' | 'disk'
}

export interface ExecutionBackend {
  /** Fails when the image is not present locally or the runtime is unreachable. */
  inspectImage(image: string): Promise<void>
  /**
   * Runs the toolchain probe in the execution image and returns what it found; fails unless the
   * required tools are present (bash and `rg` for DSH tools, LibreOffice and poppler for 2b).
   */
  inspectExecutionImage(image: string, user: string): Promise<ExecutionTool[]>
  /** Detects optional runtime features (swap accounting, AppArmor) used by the fixed posture. */
  detectFeatures(): Promise<void>
  /** Startup only: removes every container this service manages. Assumes a single service instance. */
  removeOrphans(): Promise<void>
  startPythonSandbox(spec: PythonSandboxSpec): RunningSandbox
  /**
   * Starts an idle execution container with the fixed posture; commands run through `exec`.
   * Returns the PID (inside the container) of the keeper process that holds it open.
   */
  startExecutionContainer(spec: ExecutionContainerSpec): Promise<{ keeperPid: number }>
  /**
   * Kills every process except PID 1 and the keeper, repeating until a full pass finds
   * none (plan 3.7). Resolves false when that cannot be confirmed (for example the pids
   * limit is exhausted); the caller then removes the container. Never throws for that.
   */
  quiesce(name: string, keeperPid: number): Promise<boolean>
  /**
   * Runs one command in its own process group. Abort or timeout kills the whole
   * group inside the container before this settles (a dropped exec alone would not).
   */
  exec(name: string, command: ContainerCommand, signal: AbortSignal): Promise<ContainerCommandResult>
  /** Best effort: grace period, then the runtime kills the container. */
  stop(name: string, graceSeconds: number): Promise<void>
  /** Throws a `state_conflict` RequestError when the container may still exist. */
  remove(name: string): Promise<void>
}
