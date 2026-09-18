/** P1 fixture only. No model/Agent loop, network or production registration. */
import { randomUUID } from 'node:crypto'
import type { AgentRuntimePort, RuntimeEvent, RuntimeEventListener, RuntimeExecutionSnapshot, RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
export class PersonalBrowserRuntime implements AgentRuntimePort {
  private states = new Map<string, { snapshot: RuntimeExecutionSnapshot; events: RuntimeEvent[]; listeners: Set<RuntimeEventListener> }>()
  async execute(manifest: RuntimeManifest) {
    const snapshot: RuntimeExecutionSnapshot = { runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued', acceptedAt: new Date().toISOString(), startedAt: null, endedAt: null, manifestSha256: 'synthetic-p1', attemptDirectory: '/test-only', errorCode: null, errorMessage: null }
    const state = { snapshot, events: [] as RuntimeEvent[], listeners: new Set<RuntimeEventListener>() }
    this.states.set(manifest.run_id, state)
    const emit = (event_type: RuntimeEvent['event_type'], display_message: string) => {
      const event: RuntimeEvent = { event_id: randomUUID(), run_id: manifest.run_id, attempt_id: manifest.attempt_id, sequence: state.events.length + 1, event_type, display_message, safe_metadata: { synthetic: true }, occurred_at: new Date().toISOString(), trace_id: `trace-${manifest.run_id}`, parent_event_id: null }
      state.events.push(event); state.listeners.forEach(listener => listener(event))
    }
    emit('run.queued', 'P1 合成任务排队')
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => {
      // Only yield so the platform can subscribe. Tests wait on observable state, not this delay.
      setImmediate(() => {
        snapshot.status = 'running'; snapshot.startedAt = new Date().toISOString(); emit('run.started', 'P1 受控运行开始')
        emit('assistant.completed', `受控测试运行已完成（非真实模型回答）；输入文件 ${manifest.input.file_mounts.length} 个。`)
        snapshot.status = 'completed'; snapshot.endedAt = new Date().toISOString(); emit('run.completed', 'P1 受控运行完成'); resolve(structuredClone(snapshot))
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
  async cancel() { return { accepted: false } }
  async close() { this.states.clear() }
}
