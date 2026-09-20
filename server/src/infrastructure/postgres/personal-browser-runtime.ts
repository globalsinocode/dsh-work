/** P1 fixture only. No model/Agent loop, network or production registration. */
import { randomUUID } from 'node:crypto'
import type { AgentRuntimePort, RuntimeEvent, RuntimeEventListener, RuntimeExecutionSnapshot, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'

export interface PersonalBrowserRuntimeHooks {
  /**
   * `P1-成果达成` 标记 prompt 的登记回调：由启动脚本写入真实的
   * artifacts/artifact_versions（含 source_attempt_id），对应真实 Adapter
   * 在 run.completed 前 collectArtifacts 的顺序。未提供时按无成果处理。
   */
  registerArtifact?: (manifest: RuntimeManifest) => Promise<void>
}

interface PersonalBrowserRuntimeState {
  snapshot: RuntimeExecutionSnapshot
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  release?: () => void
  settle?: (snapshot: RuntimeExecutionSnapshot) => void
}

export class PersonalBrowserRuntime implements AgentRuntimePort {
  private states = new Map<string, PersonalBrowserRuntimeState>()
  readonly hooks: PersonalBrowserRuntimeHooks
  constructor(hooks: PersonalBrowserRuntimeHooks = {}) {
    this.hooks = hooks
  }
  async execute(manifest: RuntimeManifest) {
    const snapshot: RuntimeExecutionSnapshot = { runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued', acceptedAt: new Date().toISOString(), startedAt: null, endedAt: null, manifestSha256: 'synthetic-p1', attemptDirectory: '/test-only', errorCode: null, errorMessage: null }
    const state: PersonalBrowserRuntimeState = { snapshot, events: [], listeners: new Set() }
    this.states.set(manifest.run_id, state)
    const emit = (event_type: RuntimeEvent['event_type'], display_message: string, safe_metadata: Record<string, unknown> = {}) => {
      const event: RuntimeEvent = { event_id: randomUUID(), run_id: manifest.run_id, attempt_id: manifest.attempt_id, sequence: state.events.length + 1, event_type, display_message, safe_metadata: { synthetic: true, ...safe_metadata }, occurred_at: new Date().toISOString(), trace_id: `trace-${manifest.run_id}`, parent_event_id: null }
      state.events.push(event); state.listeners.forEach(listener => listener(event))
    }
    emit('run.queued', 'P1 合成任务排队')
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => {
      state.settle = resolve
      // Only yield so the platform can subscribe. Tests wait on observable state, not this delay.
      setImmediate(() => {
        void (async () => {
          if (this.states.get(manifest.run_id)?.snapshot.status === 'cancelled') return
          snapshot.status = 'running'; snapshot.startedAt = new Date().toISOString(); emit('run.started', 'P1 受控运行开始')
          // B-05/AC-20/22/24 夹具：保持一个真实 running Attempt，用于观察
          // 重叠跳过、暂停后新触发拒绝及交互车道保留。
          if (manifest.input.message.includes('P1-保持运行')) {
            await new Promise<void>(release => { state.release = release })
            if (this.states.get(manifest.run_id)?.snapshot.status === 'cancelled') {
              resolve(structuredClone(snapshot))
              return
            }
          }
          // B-05/AC-21 夹具：确定性失败，用于证明失败不会自动重试。
          if (manifest.input.message.includes('P1-执行失败')) {
            snapshot.status = 'failed'; snapshot.endedAt = new Date().toISOString(); snapshot.errorCode = 'RUNTIME_EXECUTION_FAILED'
            emit('run.failed', 'P1 受控运行失败', { error_code: 'RUNTIME_EXECUTION_FAILED' })
            resolve(structuredClone(snapshot))
            return
          }
          // I-06 反例夹具：自述已生成成果但终态声明数多于平台登记数 → unverified。
          if (manifest.input.message.includes('P1-成果缺口')) {
            emit('assistant.completed', '受控运行已完成：已生成两份报告（成果登记缺口夹具）。')
            snapshot.status = 'completed'; snapshot.endedAt = new Date().toISOString()
            emit('run.completed', 'P1 受控运行完成', { artifact_count: 2 })
            resolve(structuredClone(snapshot))
            return
          }
          // I-06 正例夹具：登记一个真实成果（含 source_attempt_id）后完成，
          // 与真实 Adapter 先 collectArtifacts 再 run.completed 的顺序一致。
          if (manifest.input.message.includes('P1-成果达成')) {
            await this.hooks.registerArtifact?.(manifest)
            emit('assistant.completed', '受控测试运行已完成（非真实模型回答）；成果已登记。')
            snapshot.status = 'completed'; snapshot.endedAt = new Date().toISOString()
            emit('run.completed', 'P1 受控运行完成', { artifact_count: 1 })
            resolve(structuredClone(snapshot))
            return
          }
          emit('assistant.completed', `受控测试运行已完成（非真实模型回答）；输入文件 ${manifest.input.file_mounts.length} 个。`)
          snapshot.status = 'completed'; snapshot.endedAt = new Date().toISOString(); emit('run.completed', 'P1 受控运行完成'); resolve(structuredClone(snapshot))
        })().catch(() => {
          snapshot.status = 'failed'; snapshot.endedAt = new Date().toISOString(); snapshot.errorCode = 'RUNTIME_EXECUTION_FAILED'
          emit('run.failed', 'P1 夹具执行失败', { error_code: 'RUNTIME_EXECUTION_FAILED' })
          resolve(structuredClone(snapshot))
        })
      })
    })
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: snapshot.acceptedAt, done }
  }
  subscribe(runId: string, listener: RuntimeEventListener) {
    const state = this.states.get(runId)
    if (!state) throw new Error('P1 run missing')
    state.events.forEach(listener); state.listeners.add(listener)
    return () => state.listeners.delete(listener)
  }
  status(runId: string) { return this.states.get(runId)?.snapshot }
  async health() { return { status: 'healthy' as const, runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true, dshRepository: 'test-only', transport: 'acp-stdio' as const, message: 'Synthetic P1 fixture, no DSH/model' } }
  async cancel(runId: string) {
    const state = this.states.get(runId)
    if (!state || !['queued', 'running'].includes(state.snapshot.status)) return { accepted: false }
    state.snapshot.status = 'cancelled'
    state.snapshot.endedAt = new Date().toISOString()
    const event: RuntimeEvent = {
      event_id: randomUUID(), run_id: state.snapshot.runId, attempt_id: state.snapshot.attemptId,
      sequence: state.events.length + 1, event_type: 'run.cancelled', display_message: 'P1 受控运行已取消',
      safe_metadata: { synthetic: true, cause: 'user' }, occurred_at: new Date().toISOString(),
      trace_id: `trace-${runId}`, parent_event_id: null,
    }
    state.events.push(event); state.listeners.forEach(listener => listener(event))
    state.settle?.(structuredClone(state.snapshot)); state.release?.()
    return { accepted: true }
  }
  async close() {
    for (const state of this.states.values()) state.release?.()
    this.states.clear()
  }
}
