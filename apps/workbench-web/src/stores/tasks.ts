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
    tasks.value = []; loading.value = false; initialized.value = false
  }
  function requireGeneration(value: number) {
    if (value !== generation) throw new Error('账号已切换，请重新操作')
  }

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
    const result = await workbenchApi.postSessionMessage(sessionId, content)
    requireGeneration(current)
    return result
  }

  /** TW-10：按会话加载共享线程（成员可读他人发起的团队会话）。 */
  async function loadSessionThread(sessionId: string) {
    return workbenchApi.getSessionThread(sessionId)
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
        const event = JSON.parse((message as MessageEvent<string>).data) as RuntimeEvent
        void applyEvent(event).catch(() => closeStream(runId))
      })
    }
    stream.onerror = () => {
      if (isTerminal(getTask(runId)?.status)) closeStream(runId)
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
    tasks, loading, initialized, activeTasks, recentTasks, reset, load, getTask, loadTask,
    createTask, sendMessage, postSessionMessage, loadSessionThread, uploadSessionFiles,
    startRunWithSessionFiles, cancelTask, retryTask, deleteConversation, refreshRun,
    upsert, subscribe,
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
