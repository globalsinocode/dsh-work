import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskResult, TaskRun } from '../types/domain'

const api = vi.hoisted(() => ({
  getTasks: vi.fn(),
  createSession: vi.fn(),
  uploadSessionFile: vi.fn(),
  deleteSessionFile: vi.fn(),
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  deleteSession: vi.fn(),
  getRun: vi.fn(),
  runEventsUrl: vi.fn((runId: string) => `/events/${runId}`),
  workspaceSessionEventsUrl: vi.fn((workspaceId: string) => `/session-events/${workspaceId}`),
}))

vi.mock('../api/client', () => ({ workbenchApi: api }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>()
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false
  readyState = FakeEventSource.OPEN

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void)
  }

  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
  }
}

const baseTask: TaskRun = {
  id: 'run-001',
  title: '库存分析',
  prompt: '分析库存',
  status: 'running',
  attemptId: 'attempt-001',
  workspaceId: 'ws-supply',
  workspaceName: '供应链经营分析',
  workspaceType: 'team',
  workspaceStatus: 'active',
  sessionId: 'session-001',
  agentVersion: 'assistant@1.0.0',
  createdAt: '刚刚',
  updatedAt: '刚刚',
  owner: '林岚',
  requestedBy: 'user-1',
  messages: [],
  steps: [],
  attachments: [],
  result: {
    version: 'task-result/v1',
    runId: 'run-001',
    attemptId: 'attempt-001',
    execution: 'running',
    outcome: 'pending',
    summary: '执行进行中，业务结果尚未生成。',
    primaryOutput: null,
    receipts: [],
    pendingItems: [],
    sources: [],
    artifacts: [],
    error: null,
    evidence: {
      stopReason: null,
      toolCalls: null,
      toolResults: null,
      artifactsClaimed: null,
      artifactsRegistered: 0,
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      outputTruncated: false,
      interrupted: null,
    },
    completedAt: null,
  } satisfies TaskResult,
}

describe('task store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    api.getTasks.mockResolvedValue([])
    api.deleteSession.mockResolvedValue({ sessionId: 'session-001', title: '库存分析', archived: true })
    api.deleteSessionFile.mockResolvedValue({ id: 'file-001', removed: true })
  })

  it('creates a server Session and Run, then subscribes to persisted events', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-001' })
    api.startRun.mockResolvedValue(baseTask)
    const store = useTaskStore()

    const created = await store.createTask('分析库存', [], 'ws-supply')

    expect(api.createSession).toHaveBeenCalledWith({
      title: '分析库存',
      workspaceId: 'ws-supply',
    })
    expect(api.startRun).toHaveBeenCalledWith('session-001', expect.objectContaining({
      prompt: '分析库存',
      fileIds: [],
    }))
    expect(created.id).toBe('run-001')
    expect(store.tasks[0]?.id).toBe('run-001')
    expect(FakeEventSource.instances[0]?.url).toBe('/events/run-001')
  })

  it('shows five distinct conversations after loading repeated Runs from the server', async () => {
    const { useTaskStore } = await import('./tasks')
    const latest = { ...baseTask, id: 'run-latest', status: 'succeeded' as const }
    const older = Array.from({ length: 6 }, (_, index) => ({
      ...latest, id: `run-older-${index}`,
    }))
    const others = Array.from({ length: 5 }, (_, index) => ({
      ...latest, id: `run-other-${index}`, sessionId: `session-other-${index}`,
    }))
    api.getTasks.mockResolvedValue([latest, ...older, ...others])
    const store = useTaskStore()
    await store.load()

    expect(store.recentTasks.map(task => task.id)).toEqual([
      'run-latest', 'run-other-0', 'run-other-1', 'run-other-2', 'run-other-3',
    ])
    expect(store.getTask('run-older-0')).toBeDefined()
  })

  it('updates and moves the existing conversation on consecutive messages without adding sidebar entries', async () => {
    const { useTaskStore } = await import('./tasks')
    const initial = { ...baseTask, status: 'succeeded' as const }
    const other = { ...initial, id: 'run-other', sessionId: 'session-other' }
    api.getTasks.mockResolvedValue([other, initial])
    const store = useTaskStore()
    await store.load()

    for (const id of ['run-followup-1', 'run-followup-2']) {
      api.startRun.mockResolvedValue({ ...baseTask, id, status: 'queued', updatedAt: '刚刚' })
      await store.sendMessage(store.recentTasks.find(task => task.sessionId === baseTask.sessionId)!.id, '继续分析', [])
      expect(store.recentTasks.map(task => task.id)).toEqual([id, other.id])
      expect(store.recentTasks[0]).toMatchObject({ status: 'queued', updatedAt: '刚刚' })
    }
    expect(api.createSession).not.toHaveBeenCalled()
    expect(api.startRun).toHaveBeenLastCalledWith(baseTask.sessionId, expect.objectContaining({ prompt: '继续分析' }))

    // A late refresh for an earlier Run must not replace the latest conversation entry.
    api.getRun.mockResolvedValue({ ...initial, updatedAt: '刚刚' })
    await store.refreshRun(initial.id)
    expect(store.recentTasks.map(task => task.id)).toEqual(['run-followup-2', other.id])
    expect(store.getTask(initial.id)).toBeDefined()
  })

  it('discards uploaded session files when Run creation is rejected', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-001' })
    api.uploadSessionFile.mockResolvedValue({ id: 'file-001' })
    api.startRun.mockRejectedValue(new Error('prompt 不能为空'))
    const store = useTaskStore()

    await expect(store.createTask('分析库存', [new File(['x'], 'input.txt')], 'ws-supply'))
      .rejects.toThrow('prompt 不能为空')

    expect(api.deleteSessionFile).toHaveBeenCalledWith('session-001', 'file-001')
  })

  it('discards successfully uploaded session files when another attachment upload fails', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-001' })
    api.uploadSessionFile
      .mockResolvedValueOnce({ id: 'file-001' })
      .mockRejectedValueOnce(new Error('上传失败'))
    const store = useTaskStore()

    await expect(store.createTask('分析库存', [
      new File(['ok'], 'input.txt'),
      new File(['bad'], 'broken.txt'),
    ], 'ws-supply')).rejects.toThrow('文件上传失败')

    expect(api.deleteSessionFile).toHaveBeenCalledWith('session-001', 'file-001')
    expect(api.startRun).not.toHaveBeenCalled()
  })

  it('binds an authorized workspace file id to the immutable Run input', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-001' })
    api.startRun.mockResolvedValue(baseTask)
    const store = useTaskStore()

    await store.createTask('分析共享文件', [], 'ws-supply', '供应链经营分析', undefined, ['file-workspace-001'])

    expect(api.startRun).toHaveBeenCalledWith('session-001', expect.objectContaining({
      fileIds: ['file-workspace-001'],
    }))
  })

  it('binds the team Agent member association when starting a conversation from an Agent row', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-agent-001', workspaceId: 'ws-team' })
    api.startRun.mockResolvedValue({ ...baseTask, sessionId: 'session-agent-001', workspaceId: 'ws-team' })
    const store = useTaskStore()

    await store.createTask(
      '分析订单波动',
      [],
      'ws-team',
      '供应链团队',
      undefined,
      [],
      undefined,
      'wam-001',
    )

    // TW-10：会话保持未绑定的共享讨论形态，成员关联随首条触发消息进入 startRun。
    expect(api.createSession).toHaveBeenCalledWith({
      title: '分析订单波动',
      workspaceId: 'ws-team',
    })
    expect(api.startRun).toHaveBeenCalledWith('session-agent-001', expect.objectContaining({
      workspaceAgentMemberId: 'wam-001',
    }))
  })

  it('omits the team Agent member association for personal conversations (AC-23)', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-personal-002', workspaceId: 'ws-personal-U00001' })
    api.startRun.mockResolvedValue(baseTask)
    const store = useTaskStore()

    await store.createTask('整理个人材料', [], undefined, undefined, undefined, [], undefined, undefined)

    expect(api.createSession).toHaveBeenCalledWith({ title: '整理个人材料' })
  })

  it('binds the selected Skill to the new Session while keeping the DSH run API unchanged', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-skill-001' })
    api.startRun.mockResolvedValue({ ...baseTask, sessionId: 'session-skill-001' })
    const store = useTaskStore()

    await store.createTask('分析本月订单交付风险', [], undefined, undefined, undefined, [], 'order-analysis')

    expect(api.createSession).toHaveBeenCalledWith({
      title: '分析本月订单交付风险',
      skillId: 'order-analysis',
    })
    expect(api.startRun).toHaveBeenCalledWith('session-skill-001', expect.objectContaining({
      prompt: '分析本月订单交付风险',
      fileIds: [],
    }))
  })

  it('lets the server choose the personal workspace when the caller omits a workspace', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-personal-001', workspaceId: 'ws-personal-U00001' })
    api.startRun.mockResolvedValue({
      ...baseTask,
      sessionId: 'session-personal-001',
      workspaceId: 'ws-personal-U00001',
      workspaceName: '我的空间',
    })
    const store = useTaskStore()

    await store.createTask('整理个人材料', [])

    expect(api.createSession).toHaveBeenCalledWith({ title: '整理个人材料' })
  })

  it('projects durable permission requests as administrator approval without employee actions', async () => {
    const { useTaskStore } = await import('./tasks')
    const approvalTask = { ...structuredClone(baseTask), id: 'run-approval-001' }
    api.getTasks.mockResolvedValue([approvalTask])
    const store = useTaskStore()
    await store.load()

    FakeEventSource.instances[0]?.emit('approval.required', {
      event_id: 'event-approval-1',
      run_id: 'run-approval-001',
      attempt_id: 'attempt-001',
      sequence: 1,
      event_type: 'approval.required',
      occurred_at: new Date().toISOString(),
      display_message: '请求 read 权限',
      safe_metadata: { tool_name: 'read', approval_id: 'approval-001', checkpoint_id: 'checkpoint-001' },
      trace_id: 'trace-001',
    })
    await Promise.resolve()

    expect(store.tasks[0]?.status).toBe('awaiting_approval')
    expect(store.tasks[0]?.approval).toMatchObject({
      object: '工具 read',
      toolName: 'read',
      dataScope: '供应链经营分析成员授权范围',
      nextStep: expect.stringContaining('平台管理员'),
    })
    expect(Object.keys(store)).not.toContain('approveTask')
  })

  it('ignores terminal events from an old Attempt after retry and follows the new Attempt', async () => {
    const { useTaskStore } = await import('./tasks')
    const cancelled = { ...structuredClone(baseTask), status: 'cancelled' as const }
    const retrying = {
      ...structuredClone(baseTask),
      status: 'queued' as const,
      attemptId: 'attempt-002',
    }
    const completed = { ...retrying, status: 'succeeded' as const }
    api.getTasks.mockResolvedValue([cancelled])
    api.retryRun.mockResolvedValue(retrying)
    api.getRun.mockResolvedValue(completed)
    const store = useTaskStore()
    await store.load()

    await store.retryTask(baseTask.id)
    const stream = FakeEventSource.instances.at(-1)
    stream?.emit('run.cancelled', {
      event_id: 'event-old-terminal',
      run_id: baseTask.id,
      attempt_id: 'attempt-001',
      sequence: 3,
      event_type: 'run.cancelled',
      occurred_at: new Date().toISOString(),
      display_message: '旧 Attempt 已取消',
      safe_metadata: {},
      trace_id: 'trace-old',
    })
    expect(store.tasks[0]?.status).toBe('queued')

    stream?.emit('run.completed', {
      event_id: 'event-new-terminal',
      run_id: baseTask.id,
      attempt_id: 'attempt-002',
      sequence: 3,
      event_type: 'run.completed',
      occurred_at: new Date().toISOString(),
      display_message: '新 Attempt 已完成',
      safe_metadata: {},
      trace_id: 'trace-new',
    })
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(api.getRun).toHaveBeenCalledWith(baseTask.id)
    expect(store.tasks[0]?.status).toBe('succeeded')
  })

  it('switches a waiting Run to its server-confirmed resumed Attempt before applying events', async () => {
    const { useTaskStore } = await import('./tasks')
    const waiting = {
      ...structuredClone(baseTask),
      status: 'awaiting_approval' as const,
      approval: {
        object: '工具 erp.update', reason: '等待管理员审批', nextStep: '审批后继续',
        toolName: 'erp.update', dataScope: '当前员工个人授权范围',
      },
    }
    const resumed = {
      ...structuredClone(waiting),
      status: 'queued' as const,
      attemptId: 'attempt-resumed-002',
      approval: undefined,
    }
    api.getTasks.mockResolvedValue([waiting])
    api.getRun.mockResolvedValue(resumed)
    const store = useTaskStore()
    await store.load()

    FakeEventSource.instances[0]?.emit('run.started', {
      event_id: 'event-resumed-started',
      run_id: baseTask.id,
      attempt_id: 'attempt-resumed-002',
      sequence: 1,
      event_type: 'run.started',
      occurred_at: new Date().toISOString(),
      display_message: '恢复 Attempt 已开始',
      safe_metadata: {},
      trace_id: 'trace-resumed',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(api.getRun).toHaveBeenCalledWith(baseTask.id)
    expect(store.tasks[0]?.attemptId).toBe('attempt-resumed-002')
    expect(store.tasks[0]?.status).toBe('running')

    FakeEventSource.instances[0]?.emit('run.failed', {
      event_id: 'event-late-old',
      run_id: baseTask.id,
      attempt_id: 'attempt-001',
      sequence: 99,
      event_type: 'run.failed',
      occurred_at: new Date().toISOString(),
      display_message: '旧 Attempt 迟到事件',
      safe_metadata: {},
      trace_id: 'trace-old',
    })
    await Promise.resolve()
    expect(store.tasks[0]?.status).toBe('running')
    store.reset()
  })

  it('serializes the first resumed Attempt events behind one authoritative refresh', async () => {
    const { useTaskStore } = await import('./tasks')
    const waiting = {
      ...structuredClone(baseTask),
      status: 'awaiting_approval' as const,
      approval: {
        object: '工具 erp.update', reason: '等待管理员审批', nextStep: '审批后继续',
        toolName: 'erp.update', dataScope: '当前员工个人授权范围',
      },
    }
    const resumed = {
      ...structuredClone(waiting), status: 'queued' as const,
      attemptId: 'attempt-resumed-003', approval: undefined, messages: [],
    }
    let releaseRefresh!: (task: TaskRun) => void
    api.getTasks.mockResolvedValue([waiting])
    api.getRun.mockImplementation(() => new Promise<TaskRun>(resolve => { releaseRefresh = resolve }))
    const store = useTaskStore()
    await store.load()
    const stream = FakeEventSource.instances[0]

    stream?.emit('run.queued', {
      event_id: 'event-resumed-queued', run_id: baseTask.id, attempt_id: 'attempt-resumed-003',
      sequence: 1, event_type: 'run.queued', occurred_at: new Date().toISOString(),
      display_message: '恢复 Attempt 已排队', safe_metadata: {}, trace_id: 'trace-resumed',
    })
    stream?.emit('assistant.delta', {
      event_id: 'event-resumed-output', run_id: baseTask.id, attempt_id: 'attempt-resumed-003',
      sequence: 2, event_type: 'assistant.delta', occurred_at: new Date().toISOString(),
      display_message: '恢复后的回复', safe_metadata: {}, trace_id: 'trace-resumed',
    })
    stream?.emit('run.started', {
      event_id: 'event-resumed-started-2', run_id: baseTask.id, attempt_id: 'attempt-resumed-003',
      sequence: 3, event_type: 'run.started', occurred_at: new Date().toISOString(),
      display_message: '恢复 Attempt 已开始', safe_metadata: {}, trace_id: 'trace-resumed',
    })

    await vi.waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(1))
    releaseRefresh(resumed)
    await vi.waitFor(() => {
      expect(store.tasks[0]?.status).toBe('running')
      expect(store.tasks[0]?.messages.at(-1)?.content).toBe('恢复后的回复')
    })
    expect(api.getRun).toHaveBeenCalledTimes(1)
    store.reset()
  })

  it('deletes every Run in the archived conversation and closes their event streams', async () => {
    const { useTaskStore } = await import('./tasks')
    const secondRun = { ...structuredClone(baseTask), id: 'run-002', attemptId: 'attempt-002' }
    const otherConversation = {
      ...structuredClone(baseTask),
      id: 'run-003',
      attemptId: 'attempt-003',
      sessionId: 'session-002',
    }
    api.getTasks.mockResolvedValue([structuredClone(baseTask), secondRun, otherConversation])
    const store = useTaskStore()
    await store.load()

    await store.deleteConversation('session-001')

    expect(api.deleteSession).toHaveBeenCalledWith('session-001')
    expect(store.tasks.map(task => task.id)).toEqual(['run-003'])
    expect(FakeEventSource.instances.slice(0, 2).every(stream => stream.closed)).toBe(true)
    expect(FakeEventSource.instances[2]?.closed).toBe(false)
  })

  it('shares one workspace session stream across subscribers and bumps sessionActivity on events', async () => {
    const { useTaskStore } = await import('./tasks')
    const store = useTaskStore()

    store.subscribeWorkspaceSessions('ws-team')
    store.subscribeWorkspaceSessions('ws-team')
    store.subscribeWorkspaceSessions('ws-other')
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[0]?.url).toBe('/session-events/ws-team')

    FakeEventSource.instances[0]?.emit('session.updated', {
      session_id: 's-1',
      activity_at: '2026-09-12T08:01:00.000Z',
    })
    expect(store.sessionActivity['s-1']).toMatch(/^updated:2026-09-12T08:01:00\.000Z:\d+$/)

    // 相同 activity_at 的连续事件也必须产生不同标记，否则视图 watch 不触发。
    FakeEventSource.instances[0]?.emit('session.updated', {
      session_id: 's-1',
      activity_at: '2026-09-12T08:01:00.000Z',
    })
    expect(store.sessionActivity['s-1']).not.toBe('updated:2026-09-12T08:01:00.000Z:1')
    expect(store.sessionActivity['s-1']).toMatch(/^updated:2026-09-12T08:01:00\.000Z:2$/)

    FakeEventSource.instances[0]?.emit('session.archived', { session_id: 's-2' })
    expect(store.sessionActivity['s-2']).toMatch(/^archived:/)

    // 引用计数归零才关闭连接。
    store.unsubscribeWorkspaceSessions('ws-team')
    expect(FakeEventSource.instances[0]?.closed).toBe(false)
    store.unsubscribeWorkspaceSessions('ws-team')
    expect(FakeEventSource.instances[0]?.closed).toBe(true)
    expect(FakeEventSource.instances[1]?.closed).toBe(false)
  })

  it('rebuilds a CLOSED workspace session stream in place instead of stacking refs on a dead connection', async () => {
    const { useTaskStore } = await import('./tasks')
    const store = useTaskStore()

    store.subscribeWorkspaceSessions('ws-team')
    expect(FakeEventSource.instances).toHaveLength(1)

    // 服务端拒绝（成员/读权限撤销）把连接置为 CLOSED 且不再自动重连。
    FakeEventSource.instances[0]!.readyState = FakeEventSource.CLOSED
    FakeEventSource.instances[0]!.onerror?.()
    expect(FakeEventSource.instances[0]?.closed).toBe(true)

    // 新订阅者不得挂在死连接上：同一条目原地重建，引用计数随订阅关系延续。
    store.subscribeWorkspaceSessions('ws-team')
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1]?.url).toBe('/session-events/ws-team')
    expect(FakeEventSource.instances[1]?.readyState).toBe(FakeEventSource.OPEN)

    // 新连接照常投递事件。
    FakeEventSource.instances[1]?.emit('session.updated', {
      session_id: 's-9',
      activity_at: '2026-09-12T08:02:00.000Z',
    })
    expect(store.sessionActivity['s-9']).toMatch(/^updated:/)

    // 两个订阅者各退一次才关闭新连接。
    store.unsubscribeWorkspaceSessions('ws-team')
    expect(FakeEventSource.instances[1]?.closed).toBe(false)
    store.unsubscribeWorkspaceSessions('ws-team')
    expect(FakeEventSource.instances[1]?.closed).toBe(true)
  })
})
