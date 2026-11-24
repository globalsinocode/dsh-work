import type { AgentRuntimePort, McpRuntimeConnection, RuntimeManifest, RuntimeEventListener, RuntimeCancelCause } from './runtime-types.ts'

export class ExecutionCapabilityUnavailableError extends Error {
  readonly status = 503
  readonly code: 'RUNTIME_UNAVAILABLE' | 'PYTHON_UNAVAILABLE' | 'MODEL_CAPABILITY_UNAVAILABLE' | 'EXECUTION_CONTAINER_UNAVAILABLE'
  constructor(capability: 'dsh' | 'python' | 'model' | 'execution-container') {
    super({
      dsh: 'DSH 执行能力不可用，请管理员检查配置并重启服务后重试',
      python: 'Python 执行能力不可用，其他不依赖 Python 的任务可继续',
      model: '当前 DSH 链路尚不能保证 Agent 声明的模型能力，请管理员核对 Agent 要求与 Runtime 支持情况',
      'execution-container': '执行容器不可用，Agent 任务暂不能执行，请管理员检查执行镜像与 Docker 后重启服务',
    }[capability])
    this.name = 'ExecutionCapabilityUnavailableError'
    this.code = ({
      dsh: 'RUNTIME_UNAVAILABLE', python: 'PYTHON_UNAVAILABLE', model: 'MODEL_CAPABILITY_UNAVAILABLE', 'execution-container': 'EXECUTION_CONTAINER_UNAVAILABLE',
    } as const)[capability]
  }
}

export async function assertRuntimeModelRequirements(
  runtime: AgentRuntimePort,
  requirements: NonNullable<RuntimeManifest['model_requirements']>,
  target: Parameters<NonNullable<AgentRuntimePort['assertModelRequirements']>>[1],
) {
  if (!requirements.length) return
  if (!runtime.assertModelRequirements) throw new ExecutionCapabilityUnavailableError('model')
  await runtime.assertModelRequirements(requirements, target)
}

/**
 * Negative capability only: never creates a Worker, model call, event or answer.
 * `capability` names what failed: DSH itself, or the execution container that every DSH run requires (plan 4.9).
 */
export class UnavailableRuntime implements AgentRuntimePort {
  private readonly runtimeId: string
  private readonly capability: 'dsh' | 'execution-container'
  constructor(runtimeId: string, capability: 'dsh' | 'execution-container' = 'dsh') { this.runtimeId = runtimeId; this.capability = capability }
  async assertAvailable(): Promise<void> { throw new ExecutionCapabilityUnavailableError(this.capability) }
  async execute(_manifest: RuntimeManifest): ReturnType<AgentRuntimePort['execute']> { void _manifest; throw new ExecutionCapabilityUnavailableError(this.capability) }
  subscribe(_runId: string, _listener: RuntimeEventListener) { void _runId; void _listener; return () => {} }
  async cancel(_runId: string, _requestedBy: string, _cause?: RuntimeCancelCause) { void _runId; void _requestedBy; void _cause; return { accepted: false } }
  status(_runId: string) { void _runId; return undefined }
  async listTools(): Promise<never> { throw new ExecutionCapabilityUnavailableError(this.capability) }
  async configureScheduling(_status: 'accepting' | 'draining' | 'disabled') { void _status }
  async close() {}
  async health() { return { status: 'offline' as const, runtimeId: this.runtimeId, activeExecutions: 0,
    acceptingRuns: false, dshRepository: '', transport: 'acp-stdio' as const,
    message: new ExecutionCapabilityUnavailableError(this.capability).message } }
}

export interface CapabilityState {
  status: 'available' | 'unavailable' | 'not-configured'
  code?: string
}

export interface CapabilityProbeRetry {
  /** Total attempts, including the first. Default 1 (no retry). */
  attempts?: number
  /** Delay between attempts in milliseconds. Default 0. */
  delayMs?: number
  /** Stop retrying once this many milliseconds have passed since the first attempt started. Default Infinity. */
  deadlineMs?: number
  /** Server-log only; called for every failed attempt, before deciding whether to retry. */
  onAttemptFailure?: (error: unknown, attempt: number) => void
}

/** Only use for optional execution dependencies, NEVER database/identity initialization. */
export async function probeExecutionCapability<T>(
  capability: 'dsh' | 'python' | 'execution-container',
  initialize: (() => Promise<T>) | null,
  /** Server-log only; health never carries the reason. */
  onFailure?: (error: unknown) => void,
  retry?: CapabilityProbeRetry,
): Promise<{ value: T | null; state: CapabilityState }> {
  if (!initialize) return { value: null, state: { status: 'not-configured' } }
  const attempts = Math.max(1, Math.trunc(retry?.attempts ?? 1))
  const delayMs = Math.max(0, retry?.delayMs ?? 0)
  const deadlineMs = retry?.deadlineMs ?? Number.POSITIVE_INFINITY
  const startedAt = performance.now()
  // A retry only absorbs startup races (profile rewrite, Docker briefly unavailable). It does not
  // relax fail-closed: after the attempt or deadline budget the capability still reports unavailable.
  for (let attempt = 1; ; attempt += 1) {
    try { return { value: await initialize(), state: { status: 'available' } } }
    catch (error) {
      retry?.onAttemptFailure?.(error, attempt)
      if (attempt >= attempts || performance.now() - startedAt >= deadlineMs) {
        onFailure?.(error)
        // Do not expose subprocess stderr, credentials or local paths through health.
        const code = new ExecutionCapabilityUnavailableError(capability).code
        return { value: null, state: { status: 'unavailable', code } }
      }
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

/** Capability guard, not an execution engine: every accepted call delegates to the existing DSH adapter. */
export class CapabilityGuardedRuntime implements AgentRuntimePort {
  private readonly delegate: AgentRuntimePort
  private readonly python: CapabilityState
  constructor(delegate: AgentRuntimePort, python: CapabilityState) { this.delegate = delegate; this.python = python }
  async assertModelRequirements(...args: Parameters<NonNullable<AgentRuntimePort['assertModelRequirements']>>) {
    await assertRuntimeModelRequirements(this.delegate, ...args)
  }
  async assertAvailable(manifest?: RuntimeManifest) {
    await this.delegate.assertAvailable?.(manifest)
    if (this.python.status !== 'available' && (manifest?.test_scenario ? manifest.test_scenario.requiredPythonEntries.length > 0 : manifest?.tools?.some(tool => tool.id === 'python_execute'))) {
      throw new ExecutionCapabilityUnavailableError('python')
    }
  }
  async execute(manifest: RuntimeManifest) { await this.assertAvailable(manifest); return this.delegate.execute(manifest) }
  subscribe(runId: string, listener: RuntimeEventListener) { return this.delegate.subscribe(runId, listener) }
  cancel(runId: string, userId: string, cause?: RuntimeCancelCause) { return this.delegate.cancel(runId, userId, cause) }
  status(runId: string) { return this.delegate.status(runId) }
  health() { return this.delegate.health() }
  async listTools() { await this.assertAvailable(); return this.delegate.listTools?.() ?? [] }
  async inspectMcpConnection(connection: McpRuntimeConnection) {
    await this.assertAvailable()
    if (!this.delegate.inspectMcpConnection) throw new ExecutionCapabilityUnavailableError('dsh')
    return this.delegate.inspectMcpConnection(connection)
  }
  async configureScheduling(status: 'accepting' | 'draining' | 'disabled') { await this.delegate.configureScheduling?.(status) }
  close() { return this.delegate.close() }
}
