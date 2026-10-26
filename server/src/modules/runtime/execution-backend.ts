/**
 * ExecutionBackend port: the only place a container runtime is driven.
 *
 * Callers describe a sandbox with fixed fields (image, user, mounts, entry,
 * args); the posture (network, read-only root, capabilities, seccomp, limits)
 * belongs to the implementation and cannot be overridden through the spec.
 * Lifecycle policy (slots, abort, cleanup, removal retry) lives in
 * ContainerExecutor, not here.
 */

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

export interface ExecutionBackend {
  /** Fails when the image is not present locally or the runtime is unreachable. */
  inspectImage(image: string): Promise<void>
  /** Detects optional runtime features (swap accounting, AppArmor) used by the fixed posture. */
  detectFeatures(): Promise<void>
  /** Startup only: removes every container this service manages. Assumes a single service instance. */
  removeOrphans(): Promise<void>
  startPythonSandbox(spec: PythonSandboxSpec): RunningSandbox
  /** Best effort: grace period, then the runtime kills the container. */
  stop(name: string, graceSeconds: number): Promise<void>
  /** Throws a `state_conflict` RequestError when the container may still exist. */
  remove(name: string): Promise<void>
}
