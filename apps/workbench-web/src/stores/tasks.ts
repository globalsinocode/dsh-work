import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { RunStatus, TaskRun } from '../types/domain'

interface RuntimeEvent {
  event_id: string
  run_id: string
  attempt_id: string
  sequence: number
  event_type: string
  occurred_at: string
  display_message: string | null
  safe_metadata: Record<string, unknown>
  trace_id: string
}

const streams = new Map<string, EventSource>()
/** 空间级会话活动流按 workspaceId 共享一条连接，多个视图（线程/历史列表）引用计数复用。 */
const sessionStreams = new Map<string, { source: EventSource; refs: number }>()
/** 会话活动标记的单调序号：保证每个事件产生唯一标记字符串。 */
let sessionEventSeq = 0
const runtimeEventTypes = [
  'run.queued', 'run.started', 'assistant.delta', 'assistant.completed',
  'approval.required', 'approval.resolved', 'run.cancel_requested',
  'run.cancelled', 'run.failed', 'run.completed',
]

export const useTaskStore = defineStore('tasks', () => {
  const tasks = ref<TaskRun[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  let generation = 0
  function reset() {
    generation++
    for (const id of streams.keys()) closeStream(id)
    // 空间会话活动流同属本账号的连接：账号切换时必须一并关闭并清标记，
    // 否则旧凭据的 SSE 继续挂着消耗服务端轮询、还会向新账号视图写标记。
    for (const entry of sessionStreams.values()) entry.source.close()
    sessionStreams.clear()
    sessionActivity.value = {}
    tasks.value = []; loading.value = false; initialized.value = false
  }
  function requireGeneration(value: number) {
    if (value !== generation) throw new Error('账号已切换，请重新操作')
  }
  /**
   * TW-10 实时更新：sessionId → 服务端推送的活动标记（`updated:`/`archived:` 前缀）。
   * 视图监听自己关心的 sessionId，标记一变即重新拉取线程/Run/列表。
   */
  const sessionActivity = ref<Record<string, string>>({})

  const activeTasks = computed(() =>
    tasks.value.filter((task) => ['queued', 'running', 'awaiting_approval'].includes(task.status)),
  )
  const recentTasks = computed(() => {
    // Runs arrive newest first. Project one latest Run per product Session
    // before limiting the sidebar, while retaining Run history in the store.
    const sessions = new Set<string>()
    return tasks.value.filter((task) => {
      if (sessions.has(task.sessionId)) return false
      sessions.add(task.sessionId)
      return true
    }).slice(0, 5)
  })

  async function load() {
    if (initialized.value) return
    const current = generation
    loading.value = true
    try {
      const loaded = await workbenchApi.getTasks()
      if (current !== generation) return
      tasks.value = loaded
      initialized.value = true
      for (const task of activeTasks.value) subscribe(task.id)
    } finally {
      if (current === generation) loading.value = false
    }
  }

  function getTask(id: string) {
    return tasks.value.find((task) => task.id === id)
  }

  async function loadTask(id: string) {
    const current = generation
    try {
      const task = await workbenchApi.getRun(id)
      requireGeneration(current)
      upsert(task)
      if (!isTerminal(task.status)) subscribe(task.id)
      return task
    } catch (cause) {
      if (current === generation) {
        tasks.value = tasks.value.filter(item => item.id !== id)
        closeStream(id)
      }
      throw cause
    }
  }

  async function createTask(
    prompt: string,
    attachments: File[],
    workspaceId?: string,
    _workspaceName?: string,
    agentId?: string,
    referencedFileIds: string[] = [],
    skillId?: string,
    workspaceAgentMemberId?: string,
  ) {
    void _workspaceName
    const current = generation
    // TW-10：团队会话保持未绑定的共享讨论形态（agentVersionId 为 null），
    // Agent 成员关联随首条触发消息进入 startRun，而不是固定到会话上。
    const session = await workbenchApi.createSession({
      title: prompt,
      ...(workspaceId ? { workspaceId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(skillId ? { skillId } : {}),
    })
    requireGeneration(current)
    const task = await startRunWithSessionFiles(session.id, {
      prompt,
      attachments,
      referencedFileIds,
      workspaceAgentMemberId,
    })
    requireGeneration(current)
    subscribe(task.id)
    return task
  }

  async function sendMessage(id: string, prompt: string, attachments: File[], workspaceAgentMemberId?: string) {
    const epoch = generation
    const current = getTask(id)
    if (!current) return undefined
    const task = await startRunWithSessionFiles(current.sessionId, {
      prompt,
      attachments,
      workspaceAgentMemberId,
    })
    requireGeneration(epoch)
    subscribe(task.id)
    return task
  }

  /**
   * TW-10 讨论消息：不产生 Run，仅写入共享消息流。返回后由调用方刷新线程。
   */
  async function postSessionMessage(sessionId: string, content: string) {
    const current = generation
    const result = await workbenchApi.postSessionMessage(sessionId, content, crypto.randomUUID())
    requireGeneration(current)
    return result
  }

  /** TW-10：按会话加载共享线程（成员可读他人发起的团队会话）。 */
  async function loadSessionThread(sessionId: string) {
    return workbenchApi.getSessionThread(sessionId)
  }

  /**
   * 加载共享线程更早一页（评审中3）：`before` 传当前已展示的最旧一条消息 id
   * （服务端 `messagesCursor`），返回上一页供调用方前置合并。
   */
  async function loadEarlierThreadMessages(sessionId: string, before: string) {
    return workbenchApi.getSessionThread(sessionId, before)
  }

  async function uploadSessionFiles(sessionId: string, attachments: File[]) {
    const current = generation
    const results = await Promise.allSettled(
      attachments.map(file => workbenchApi.uploadSessionFile(sessionId, file)),
    )
    requireGeneration(current)
    const fileIds: string[] = []
    const failedNames: string[] = []
    results.forEach((result, index) => {
      const id = result.status === 'fulfilled' ? result.value.id : ''
      if (id) fileIds.push(id)
      else failedNames.push(attachments[index]?.name ?? '未知文件')
    })
    if (failedNames.length) {
      const error = new Error(`文件上传失败：${failedNames.join('、')}，请重新发送`) as Error & { uploadedFileIds: string[] }
      error.uploadedFileIds = fileIds
      throw error
    }
    return fileIds
  }

  async function discardSessionFiles(sessionId: string, fileIds: string[]) {
    await Promise.allSettled(fileIds.map(fileId => workbenchApi.deleteSessionFile(sessionId, fileId)))
  }

  async function startRunWithSessionFiles(sessionId: string, input: {
    prompt: string
    attachments: File[]
    referencedFileIds?: string[]
    workspaceAgentMemberId?: string
  }) {
    const current = generation
    let uploadedFileIds: string[] = []
    try {
      uploadedFileIds = await uploadSessionFiles(sessionId, input.attachments)
      requireGeneration(current)
      const task = await workbenchApi.startRun(sessionId, {
        prompt: input.prompt,
        idempotencyKey: crypto.randomUUID(),
        fileIds: [...new Set([...(input.referencedFileIds ?? []), ...uploadedFileIds])],
        ...(input.workspaceAgentMemberId ? { workspaceAgentMemberId: input.workspaceAgentMemberId } : {}),
      })
      if (!task) throw new Error('Run 创建失败')
      requireGeneration(current)
      upsert(task)
      return task
    } catch (error) {
      const partialUploadIds = error instanceof Error && 'uploadedFileIds' in error
        ? (error as Error & { uploadedFileIds?: string[] }).uploadedFileIds ?? []
        : []
      await discardSessionFiles(sessionId, uploadedFileIds.length ? uploadedFileIds : partialUploadIds)
      throw error
    }
  }

  async function cancelTask(id: string) {
    const current = generation
    const task = await workbenchApi.cancelRun(id)
    requireGeneration(current)
    upsert(task)
    return task
  }

  async function retryTask(id: string) {
    const current = generation
    const task = await workbenchApi.retryRun(id)
    requireGeneration(current)
    upsert(task)
    subscribe(task.id, true)
    return task
  }

  async function deleteConversation(sessionId: string) {
    const current = generation
    await workbenchApi.deleteSession(sessionId)
    requireGeneration(current)
    const removed = tasks.value.filter((task) => task.sessionId === sessionId)
    for (const task of removed) closeStream(task.id)
    tasks.value = tasks.value.filter((task) => task.sessionId !== sessionId)
  }

  function subscribe(runId: string, replace = false) {
    if (replace) closeStream(runId)
    if (streams.has(runId)) return
    const current = generation
    const stream = new EventSource(workbenchApi.runEventsUrl(runId), { withCredentials: true })
    streams.set(runId, stream)
    for (const eventType of runtimeEventTypes) {
      stream.addEventListener(eventType, (message) => {
        if (current !== generation) return
        let event: RuntimeEvent
        try {
          event = JSON.parse((message as MessageEvent<string>).data) as RuntimeEvent
        } catch {
          return
        }
        void applyEvent(event).catch(() => closeStream(runId))
      })
    }
    stream.onerror = () => {
      if (isTerminal(getTask(runId)?.status)) closeStream(runId)
    }
  }

  /**
   * TW-10：订阅团队空间的会话活动流。同一空间多个消费者共享一条连接，
   * 引用计数归零才真正关闭。收到事件只更新 sessionActivity 标记，
   * 由各视图决定刷新哪个目标（保持读路径与鉴权逻辑单一）。
   */
  function subscribeWorkspaceSessions(workspaceId: string, since?: string) {
    // 无 SSE 能力的环境（旧浏览器/测试环境）优雅降级为无实时更新，页面仍可手动刷新。
    if (typeof EventSource === 'undefined') return
    const entry = sessionStreams.get(workspaceId)
    // 服务端拒绝（如成员/读权限撤销返回非 2xx）会把连接置为 CLOSED 且不再
    // 自动重连。死连接不能继续加引用——否则新订阅者挂到一条永远收不到事件
    // 的连接上。同一条目上原地重建，原消费者的引用计数随之转移到新连接。
    if (entry && entry.source.readyState !== EventSource.CLOSED) {
      entry.refs += 1
      return
    }
    // since：客户端「会话状态为最新」的水位线（二审残留）。首拉列表到流
    // 建立之间归档的会话，服务端按此水位线补推 session.archived；不传则
    // 归档增量从流起点起算（不补历史）。
    const source = new EventSource(workbenchApi.workspaceSessionEventsUrl(workspaceId, since), { withCredentials: true })
    const bump = (sessionId: string, kind: string) => {
      // 标记必须对每个事件唯一：同一毫秒的连续事件若产生相同字符串，
      // 视图的 watch 不会触发、刷新会被静默丢弃。
      sessionEventSeq += 1
      sessionActivity.value = { ...sessionActivity.value, [sessionId]: `${kind}:${sessionEventSeq}` }
    }
    const parseMarker = (message: Event) => {
      try {
        return JSON.parse((message as MessageEvent<string>).data) as { session_id: string; activity_at?: string }
      } catch {
        return null
      }
    }
    // EventSource 自动重连时服务端首轮只重建基线不补推——断开期间发生的
    // 变更永远不会到达。第二次及以后的 onopen 视为重连，用通配标记让
    // 各订阅视图整体重取一次当前状态。原地重建的死连接同样按重连处理：
    // 旧连接死掉到重新订阅之间的事件无从知晓，必须补一次整体重取。
    let connected = entry !== undefined
    source.onopen = () => {
      if (connected) bump('*', 'resync')
      connected = true
    }
    // 非 2xx（权限撤销等）时 EventSource 置 CLOSED 且不再自动重连；网络
    // 断开则停在 CONNECTING 交给内置重连，重连成功由上面的 onopen 用
    // resync 补缺口。CLOSED 条目留在 map 中，下次订阅按 readyState 重建。
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) source.close()
    }
    source.addEventListener('session.updated', (message) => {
      const event = parseMarker(message)
      if (event?.session_id) bump(event.session_id, `updated:${event.activity_at ?? ''}`)
    })
    source.addEventListener('session.archived', (message) => {
      const event = parseMarker(message)
      if (event?.session_id) bump(event.session_id, 'archived')
    })
    // 服务端显式重同步协议（四审）：基线握手（onopen 不代表服务端已建基线）、
    // 归档查询截断、跟踪集合淘汰都要求客户端作废在途读取整体重取——与重连
    // 同一个通配标记，各视图按自己的 loadToken 丢弃旧响应。
    source.addEventListener('session.resync', () => {
      bump('*', 'resync')
    })
    if (entry) {
      entry.source = source
      entry.refs += 1
    } else {
      sessionStreams.set(workspaceId, { source, refs: 1 })
    }
  }

  function unsubscribeWorkspaceSessions(workspaceId: string) {
    const entry = sessionStreams.get(workspaceId)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs <= 0) {
      entry.source.close()
      sessionStreams.delete(workspaceId)
    }
  }

  async function applyEvent(event: RuntimeEvent) {
    const current = generation
    const task = getTask(event.run_id)
    if (!task) return
    if (task.attemptId !== null && event.attempt_id !== task.attemptId) return
    if (event.event_type === 'run.queued') task.status = 'queued'
    if (event.event_type === 'run.started') task.status = 'running'
    if (event.event_type === 'approval.required') {
      task.status = 'awaiting_approval'
      const toolName = typeof event.safe_metadata['tool_name'] === 'string'
        ? event.safe_metadata['tool_name']
        : '受控工具'
      task.approval = {
        object: `工具 ${toolName}`,
        reason: 'DSH 请求本轮一次性工具权限，服务端正在校验 Agent、角色和数据范围。',
        nextStep: '当前项目采用自动确认策略，无需手动操作；确认结果会自动更新。',
        toolName,
        dataScope: task.workspaceName === '我的空间' ? '当前员工个人授权范围' : `${task.workspaceName}成员授权范围`,
      }
    }
    if (event.event_type === 'approval.resolved') {
      task.status = 'running'
      task.approval = undefined
    }
    if (event.event_type === 'run.cancel_requested') task.status = 'running'
    if (event.event_type === 'run.cancelled') task.status = 'cancelled'
    if (event.event_type === 'run.failed') task.status = 'failed'
    if (event.event_type === 'run.completed') task.status = 'succeeded'
    task.updatedAt = '刚刚'

    if (event.event_type === 'assistant.delta' && event.display_message) {
      const messageId = `${event.attempt_id}-streaming`
      const message = task.messages.find((item) => item.id === messageId)
      if (message) message.content += event.display_message
      else task.messages.push({ id: messageId, role: 'assistant', content: event.display_message, createdAt: '刚刚', runId: event.run_id })
    }
    if (event.event_type === 'assistant.completed' && event.display_message) {
      const messageId = `${event.attempt_id}-streaming`
      const message = task.messages.find((item) => item.id === messageId)
      if (message) {
        message.content = event.display_message
        message.runId = event.run_id
      } else task.messages.push({ id: messageId, role: 'assistant', content: event.display_message, createdAt: '刚刚', runId: event.run_id })
    }

    if (!['assistant.delta', 'assistant.completed'].includes(event.event_type)) {
      const step = task.steps.find((item) => item.id === event.event_id)
      if (!step) {
        task.steps.push({
          id: event.event_id,
          title: eventTitle(event.event_type),
          detail: event.display_message ?? '执行状态已更新。',
          status: eventStepStatus(event.event_type),
        })
      }
    }

    if (isTerminal(task.status)) {
      await wait(100)
      if (current !== generation) return
      await refreshRun(task.id)
      closeStream(task.id)
    }
  }

  async function refreshRun(runId: string) {
    return loadTask(runId)
  }

  function upsert(task: TaskRun | null | undefined) {
    if (!task) return
    const index = tasks.value.findIndex((item) => item.id === task.id)
    if (index >= 0) tasks.value.splice(index, 1, task)
    else tasks.value.unshift(task)
  }

  function closeStream(runId: string) {
    streams.get(runId)?.close()
    streams.delete(runId)
  }

  return {
    tasks, loading, initialized, activeTasks, recentTasks, sessionActivity, reset, load, getTask, loadTask,
    createTask, sendMessage, postSessionMessage, loadSessionThread, loadEarlierThreadMessages, uploadSessionFiles,
    startRunWithSessionFiles, cancelTask, retryTask, deleteConversation, refreshRun,
    upsert, subscribe, subscribeWorkspaceSessions, unsubscribeWorkspaceSessions,
  }
})

function eventTitle(eventType: string) {
  const titles: Record<string, string> = {
    'run.queued': '进入 Runtime 队列',
    'run.started': 'DSH Worker 开始执行',
    'approval.required': '等待权限确认',
    'approval.resolved': '权限确认完成',
    'run.cancel_requested': '正在取消',
    'run.cancelled': '执行已取消',
    'run.failed': '执行失败',
    'run.completed': '执行完成',
  }
  return titles[eventType] ?? '运行事件'
}

function eventStepStatus(eventType: string) {
  if (eventType === 'approval.required') return 'awaiting_approval' as const
  if (['run.failed', 'run.cancelled'].includes(eventType)) return 'failed' as const
  if (eventType === 'run.completed') return 'succeeded' as const
  return 'running' as const
}

function isTerminal(status: RunStatus | undefined) {
  return status !== undefined && ['succeeded', 'failed', 'cancelled'].includes(status)
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}
