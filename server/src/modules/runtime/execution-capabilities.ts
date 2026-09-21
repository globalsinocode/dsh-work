import type { AgentRuntimePort, McpRuntimeConnection, RuntimeManifest, RuntimeEventListener, RuntimeCancelCause } from './runtime-types.ts'

export class ExecutionCapabilityUnavailableError extends Error {
  readonly status = 503
  readonly code: 'RUNTIME_UNAVAILABLE' | 'PYTHON_UNAVAILABLE' | 'MODEL_CAPABILITY_UNAVAILABLE'
  constructor(capability: 'dsh' | 'python' | 'model') {
    super(capability === 'dsh' ? 'DSH 执行能力不可用，请管理员检查配置并重启服务后重试' : capability === 'python' ? 'Python 执行能力不可用，其他不依赖 Python 的任务可继续' : '当前 DSH 链路尚不能保证 Agent 声明的模型能力，请管理员核对 Agent 要求与 Runtime 支持情况')
    this.name = 'ExecutionCapabilityUnavailableError'
    this.code = capability === 'dsh' ? 'RUNTIME_UNAVAILABLE' : capability === 'python' ? 'PYTHON_UNAVAILABLE' : 'MODEL_CAPABILITY_UNAVAILABLE'
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
