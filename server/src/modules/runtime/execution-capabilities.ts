import type { AgentRuntimePort, RuntimeManifest, RuntimeEventListener, RuntimeCancelCause } from './runtime-types.ts'

export class ExecutionCapabilityUnavailableError extends Error {
  readonly status = 503
  readonly code: 'RUNTIME_UNAVAILABLE' | 'PYTHON_UNAVAILABLE'
  constructor(capability: 'dsh' | 'python') {
    super(capability === 'dsh' ? 'DSH 执行能力不可用，请管理员检查配置并重启服务后重试' : 'Python 执行能力不可用，其他不依赖 Python 的任务可继续')
    this.name = 'ExecutionCapabilityUnavailableError'
    this.code = capability === 'dsh' ? 'RUNTIME_UNAVAILABLE' : 'PYTHON_UNAVAILABLE'
  }
}

/** Negative capability only: never creates a Worker, model call, event or answer. */
export class UnavailableRuntime implements AgentRuntimePort {
  private readonly runtimeId: string
  constructor(runtimeId: string) { this.runtimeId = runtimeId }
  async assertAvailable(): Promise<void> { throw new ExecutionCapabilityUnavailableError('dsh') }
  async execute(_manifest: RuntimeManifest): ReturnType<AgentRuntimePort['execute']> { void _manifest; throw new ExecutionCapabilityUnavailableError('dsh') }
  subscribe(_runId: string, _listener: RuntimeEventListener) { void _runId; void _listener; return () => {} }
  async cancel(_runId: string, _requestedBy: string, _cause?: RuntimeCancelCause) { void _runId; void _requestedBy; void _cause; return { accepted: false } }
  status(_runId: string) { void _runId; return undefined }
  async listTools(): Promise<never> { throw new ExecutionCapabilityUnavailableError('dsh') }
  async configureScheduling(_status: 'accepting' | 'draining' | 'disabled') { void _status }
  async close() {}
  async health() { return { status: 'offline' as const, runtimeId: this.runtimeId, activeExecutions: 0,
    acceptingRuns: false, dshRepository: '', transport: 'acp-stdio' as const,
    message: new ExecutionCapabilityUnavailableError('dsh').message } }
}

export interface CapabilityState {
  status: 'available' | 'unavailable' | 'not-configured'
  code?: string
}

/** Only use for optional execution dependencies, NEVER database/identity initialization. */
export async function probeExecutionCapability<T>(
  capability: 'dsh' | 'python',
  initialize: (() => Promise<T>) | null,
): Promise<{ value: T | null; state: CapabilityState }> {
  if (!initialize) return { value: null, state: { status: 'not-configured' } }
  try { return { value: await initialize(), state: { status: 'available' } } }
  catch {
    // Do not expose subprocess stderr, credentials or local paths through health.
    return { value: null, state: { status: 'unavailable', code: new ExecutionCapabilityUnavailableError(capability).code } }
  }
}

/** Capability guard, not an execution engine: every accepted call delegates to the existing DSH adapter. */
export class CapabilityGuardedRuntime implements AgentRuntimePort {
  private readonly delegate: AgentRuntimePort
  private readonly python: CapabilityState
  constructor(delegate: AgentRuntimePort, python: CapabilityState) { this.delegate = delegate; this.python = python }
  async assertAvailable(manifest?: RuntimeManifest) {
    await this.delegate.assertAvailable?.(manifest)
    if (this.python.status !== 'available' && manifest?.tools.some(tool => tool.id === 'python_execute')) {
      throw new ExecutionCapabilityUnavailableError('python')
    }
  }
  async execute(manifest: RuntimeManifest) { await this.assertAvailable(manifest); return this.delegate.execute(manifest) }
  subscribe(runId: string, listener: RuntimeEventListener) { return this.delegate.subscribe(runId, listener) }
  cancel(runId: string, userId: string, cause?: RuntimeCancelCause) { return this.delegate.cancel(runId, userId, cause) }
  status(runId: string) { return this.delegate.status(runId) }
  health() { return this.delegate.health() }
  async listTools() { await this.assertAvailable(); return this.delegate.listTools?.() ?? [] }
  async configureScheduling(status: 'accepting' | 'draining' | 'disabled') { await this.delegate.configureScheduling?.(status) }
  close() { return this.delegate.close() }
}
