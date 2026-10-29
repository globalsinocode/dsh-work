import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import { ref } from 'vue'
import type { Artifact, ProjectTask, ProjectTaskEvent, ProjectTaskPage, SessionThread, TaskResult, TaskRun, Workspace } from '@/types/domain'
import { projectTaskDetailKey, type ProjectTaskDetailBridge } from '@/composables/project-task-detail'
import { TaskComposer } from '@dsh-work/workbench-components'
import ConversationView from './ConversationView.vue'

function page(items: ProjectTask[], nextCursor: string | null = null): ProjectTaskPage {
  return { items, nextCursor, total: items.length }
}

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
const route = vi.hoisted(() => ({
  name: undefined as string | undefined,
  params: {} as Record<string, string>,
}))
const api = vi.hoisted(() => ({
  getTasks: vi.fn(),
  getSession: vi.fn(),
  getRun: vi.fn(),
  getSessionThread: vi.fn(),
  postSessionMessage: vi.fn(),
  listWorkspaceAgentMembers: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  markMentionsRead: vi.fn(),
  listProjectTasks: vi.fn(),
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  deleteSession: vi.fn(),
  createSession: vi.fn(),
  uploadSessionFile: vi.fn(),
  deleteSessionFile: vi.fn(),
  runEventsUrl: vi.fn((runId: string) => `/events/${runId}`),
  workspaceSessionEventsUrl: vi.fn((workspaceId: string) => `/session-events/${workspaceId}`),
}))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => route }))
vi.mock('@/api/client', () => ({ workbenchApi: api }))

// 视图 onBeforeUnmount 会释放空间会话流订阅；不自动卸载会让模块级引用计数跨用例泄漏。
enableAutoUnmount(afterEach)

/** 非终态 Run 会触发 SSE 订阅；happy-dom 没有 EventSource，用最小桩替代。 */
class FakeEventSource {
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>()
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void)
  }
  close() {}
}

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    version: 'task-result/v1',
    runId: 'run-001',
    attemptId: 'attempt-001',
    execution: 'failed',
    outcome: 'not_achieved',
    summary: '执行未达成目标：本轮执行失败',
    primaryOutput: null,
    receipts: [],
    pendingItems: [],
    sources: [],
    artifacts: [],
    error: {
      code: 'run_failed',
      message: '本轮执行失败',
      object: '运行 run-001',
      reason: '上游超时',
      suggestion: '可重新执行本轮。',
      retryable: true,
    },
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
    completedAt: '2026-09-10T10:05:00.000Z',
    ...overrides,
  }
}

function task(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-001',
    title: '库存分析',
    prompt: '分析库存',
    status: 'failed',
    attemptId: 'attempt-001',
    workspaceId: 'ws-team',
    workspaceName: '供应链团队',
    workspaceType: 'team',
    workspaceStatus: 'active',
    sessionId: 'session-001',
    agentVersion: 'assistant@1.0.0',
    createdAt: '2026-09-10 10:00',
    updatedAt: '2026-09-10 10:05',
    owner: '林岚',
    requestedBy: 'U00001',
    messages: [],
    steps: [],
    attachments: [],
    currentUserRole: 'member',
    result: result(),
    ...overrides,
  }
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-team',
    name: '供应链团队',
    description: '团队共享的协作空间。',
    type: 'team',
    memberCount: 2,
    sessionCount: 1,
    artifactCount: 0,
    updatedAt: '2026-09-10T00:00:00.000Z',
    owner: '林岚',
    members: ['林岚', '周航'],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

function sessionThread(overrides: Partial<SessionThread> = {}): SessionThread {
  return {
    sessionId: 'session-001',
    title: '供应商讨论',
    workspaceId: 'ws-team',
    workspaceType: 'team',
    workspaceStatus: 'active',
    createdBy: 'U00002',
    creatorName: '周航',
    createdAt: '2026-09-10T09:00:00.000Z',
    lastActiveAt: '2026-09-10T10:00:00.000Z',
    currentUserRole: 'member',
    messages: [],
    runs: [],
    ...overrides,
  }
}

function projectTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: 'ptask-1',
    title: '分析缺货原因',
    description: '',
    createdBy: { userId: 'U00002', displayName: '周航' },
    assignee: { type: 'agent', agentMemberId: 'wam-7', name: '缺货分析助手' },
    status: 'in_progress',
    sessionId: 'session-001',
    latestRunId: 'run-9',
    latestRunStatus: 'succeeded',
    latestRunAt: '2026-09-10T10:00:00.000Z',
    schedule: { kind: 'manual', timezone: 'Asia/Shanghai' },
    scheduleState: 'active',
    scheduleReason: null,
    nextRunAt: null,
    inputFiles: [],
    deliverableFiles: [],
    completionNote: null,
    completedAt: null,
    dueDate: null,
    createdAt: '2026-09-10T09:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    allowedActions: ['edit', 'remove'],
    ...overrides,
  }
}

async function mountView(options: { item?: TaskRun | null; workspace?: Workspace; bridge?: ProjectTaskDetailBridge } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  api.getSession.mockResolvedValue({
    user: {
      id: 'U00001', name: '林岚', title: '', department: '', avatarText: '林',
      role: 'employee', dataScopes: [],
    },
    identityProvider: 'local',
  })
  const authStore = useAuthStore(pinia)
  await authStore.load()
  const taskStore = useTaskStore(pinia)
  const item = options.item === undefined ? task() : options.item
  taskStore.tasks.splice(0, taskStore.tasks.length, ...(item ? [item] : []))
  // B5：详情刷新失败会把条目从缓存移除；Run 存在时详情请求应返回它本身。
  if (item) api.getRun.mockResolvedValue(item)
  vi.spyOn(taskStore, 'load').mockResolvedValue(undefined)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, options.workspace ?? workspace())
  const wrapper = mount(ConversationView, {
    global: {
      plugins: [pinia, ElementPlus],
      stubs: { TaskComposer: true, RunTimeline: true, teleport: true },
      provide: options.bridge ? { [projectTaskDetailKey as symbol]: options.bridge } : {},
    },
  })
  await flushPromises()
  return { wrapper, taskStore, contentStore }
}

describe('ConversationView 归档只读态（design §2.7 / AC-23）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('EventSource', FakeEventSource)
    route.params = { id: 'run-001' }
    api.listWorkspaceAgentMembers.mockResolvedValue([])
    api.listWorkspaceMembers.mockResolvedValue({ items: [], currentUserRole: 'member' })
    api.markMentionsRead.mockResolvedValue({ workspaceId: 'ws-team', sessionId: 'session-001', read: 0 })
    api.listProjectTasks.mockResolvedValue(page([]))
    api.deleteSessionFile.mockResolvedValue({ id: 'file-001', removed: true })
    api.getRun.mockRejectedValue(new Error('not a run'))
    api.getSessionThread.mockRejectedValue(new Error('not found'))
  })

  it('hides the follow-up composer and retry entries for a run in an archived team space', async () => {
    const { wrapper } = await mountView({
      item: task({ workspaceStatus: 'archived' }),
      workspace: workspace({ status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z' }),
    })

    expect(wrapper.find('[data-testid="conversation-archived-notice"]').exists()).toBe(true)
    expect(wrapper.find('task-composer-stub').exists()).toBe(false)
    // 头部与错误区的重试入口都不渲染。
    expect(wrapper.find('button[aria-label="重新执行本轮"]').exists()).toBe(false)
    expect(wrapper.findAll('button').filter(button => button.text() === '重新执行本轮')).toHaveLength(0)
    // 内容本身仍可读：对话正文与来源区保持渲染。
    expect(wrapper.find('.conversation-thread').exists()).toBe(true)
  })

  it('keeps the composer and retry entry on an active team space', async () => {
    const { wrapper } = await mountView()

    expect(wrapper.find('task-composer-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid="conversation-archived-notice"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="重新执行本轮"]').exists()).toBe(true)
  })

  it('shows an unknown external effect and hides both retry entries', async () => {
    const item = task({ result: result({
      pendingItems: [{ kind: 'external_effect_unknown', message: 'MCP 写入效果未知，须先核对权威回执。' }],
    }) })
    const { wrapper } = await mountView({ item })

    expect(wrapper.text()).toContain('MCP 写入效果未知，须先核对权威回执。')
    expect(wrapper.find('button[aria-label="重新执行本轮"]').exists()).toBe(false)
    expect(wrapper.findAll('button').filter(button => button.text().trim() === '重新执行本轮')).toHaveLength(0)
  })

  it('moves the active-run stop action into the composer send control', async () => {
    const item = task({ status: 'running', result: result({ execution: 'running', outcome: 'pending', error: null, completedAt: null }) })
    const { wrapper, taskStore } = await mountView({ item })
    const cancelTask = vi.spyOn(taskStore, 'cancelTask').mockResolvedValue(item)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const composer = wrapper.getComponent(TaskComposer)

    expect(wrapper.find('button[aria-label="停止本轮执行"]').exists()).toBe(false)
    expect(composer.props('running')).toBe(true)

    composer.vm.$emit('stop')
    await flushPromises()

    expect(cancelTask).toHaveBeenCalledWith('run-001')
  })

  it('lists the steps so far and the one running now instead of a quiet-run warning (EX-PROGRESS-01)', async () => {
    const running = { status: 'running' as const, result: result({ execution: 'running', outcome: 'pending', error: null, completedAt: null }) }
    const startedAt = new Date(Date.now() - 40_000).toISOString()
    const { wrapper } = await mountView({ item: task({ ...running, steps: [
      { id: 'event-started', title: 'DSH Worker 开始执行', detail: '开始执行', status: 'running', event: 'run.started', at: startedAt },
      { id: 'tool-call-call-read', title: '正在调用工具', detail: 'read：正在调用', status: 'running', tool: 'read', callId: 'call-read', event: 'tool.started', at: startedAt, startedAt },
    ] }) })
    expect(wrapper.get('[data-testid="current-step"]').text()).toBe('正在读取文件')
    expect(wrapper.get('[data-testid="run-progress-card"]').text()).toMatch(/正在处理 · 已用 4\d 秒/)
    expect(wrapper.text()).not.toContain('没有新的')
  })

  it('lets any writable member retry a shared run, not only the requester (TW-10)', async () => {
    // 服务端 requireWritableRun 的口径是「会话写轨」：团队空间内任一可写成员
    // 都可停止/重试共享会话里的 Run，不限发起人（前端此前误收窄为仅发起人）。
    const item = task({ requestedBy: 'U00002', currentUserRole: 'member', status: 'failed' })
    const { wrapper } = await mountView({ item })

    expect(wrapper.find('button[aria-label="重新执行本轮"]').exists()).toBe(true)
  })

  it('lets a non-requester member stop a running shared run', async () => {
    const item = task({ requestedBy: 'U00002', currentUserRole: 'member', status: 'running', result: result({ execution: 'running', outcome: 'pending', error: null, completedAt: null }) })
    const { wrapper, taskStore } = await mountView({ item })
    const cancelTask = vi.spyOn(taskStore, 'cancelTask').mockResolvedValue(item)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const composer = wrapper.getComponent(TaskComposer)

    expect(composer.props('running')).toBe(true)
    composer.vm.$emit('stop')
    await flushPromises()
    expect(cancelTask).toHaveBeenCalledWith('run-001')
  })

  it('keeps retry requester-only for personal runs', async () => {
    // 个人会话写轨仍是创建者-only（requireSessionAccess 的非团队分支）。
    const item = task({
      requestedBy: 'U00002',
      workspaceId: 'ws-personal',
      workspaceType: 'personal',
      currentUserRole: null,
      status: 'failed',
    })
    const { wrapper } = await mountView({
      item,
      workspace: workspace({ id: 'ws-personal', type: 'personal' }),
    })

    expect(wrapper.find('button[aria-label="重新执行本轮"]').exists()).toBe(false)
  })

  it('never applies the archived gate to a personal workspace (AC-23)', async () => {
    const { wrapper } = await mountView({
      item: task({ workspaceId: 'ws-personal', workspaceName: '我的空间', workspaceType: 'personal' }),
      // 个人空间契约上恒为 active；即便夹具带上归档状态也不得隐藏入口。
      workspace: workspace({ id: 'ws-personal', type: 'personal', status: 'archived' }),
    })

    expect(wrapper.find('task-composer-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid="conversation-archived-notice"]').exists()).toBe(false)
  })

  it('renders assistant Markdown as structured content and keeps user input plain', async () => {
    const { wrapper } = await mountView({
      item: task({
        messages: [
          { id: 'message-user', role: 'user', content: '**不要加粗**', createdAt: '2026-09-10 10:00' },
          {
            id: 'message-assistant',
            role: 'assistant',
            content: ['## 无法安装的原因', '', '**运行时未授权工具**', '', '```text', 'Error: tool is not authorized', '```'].join('\n'),
            createdAt: '2026-09-10 10:01',
          },
        ],
      }),
    })

    expect(wrapper.get('.user-message p').text()).toBe('**不要加粗**')
    expect(wrapper.find('.user-message strong').exists()).toBe(false)
    expect(wrapper.get('.assistant-answer h4').text()).toBe('无法安装的原因')
    expect(wrapper.get('.assistant-answer strong').text()).toBe('运行时未授权工具')
    expect(wrapper.get('.assistant-answer pre code').text()).toBe('Error: tool is not authorized')
    expect(wrapper.get('.assistant-answer').text()).not.toContain('```')
    expect(wrapper.find('button[aria-label="朗读回答"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="复制回答"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="复制对话链接"]').exists()).toBe(true)
  })

  it('does not expose controlled-memory submission from a successful employee run', async () => {
    const { wrapper } = await mountView({
      item: task({
        status: 'succeeded',
        result: result({ execution: 'succeeded', outcome: 'achieved', error: null }),
        messages: [{ id: 'm-current', role: 'assistant', content: '本轮回答不会被自动复制', createdAt: '10:01', runId: 'run-001' }],
      }),
    })

    expect(wrapper.find('button[aria-label="提交受控记忆候选"]').exists()).toBe(false)
    expect(wrapper.find('[role="dialog"][aria-label="提交受控记忆候选"]').exists()).toBe(false)
  })

  it('loads a shared run by id even when it is absent from the requester task list', async () => {
    api.getRun.mockResolvedValue(task({
      requestedBy: 'U00002',
      currentUserRole: 'member',
      messages: [{ id: 'm-run', role: 'assistant', content: '共享 Run 的回答', createdAt: '10:01', runId: 'run-001' }],
    }))
    const { wrapper } = await mountView({ item: null })

    expect(api.getRun).toHaveBeenCalledWith('run-001')
    expect(wrapper.text()).toContain('共享 Run 的回答')
  })

  it('loads a shared session thread without runs and shows sender/Agent attribution (TW-10)', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({
      messages: [
        {
          id: 'm1', role: 'user', content: '这批料谁跟一下？', createdAt: '10:00',
          runId: null, senderId: 'U00002', senderName: '周航',
          runRequesterId: null, runRequesterName: null, agentName: null,
        },
        {
          id: 'm2', role: 'assistant', content: '延期明细已整理', createdAt: '10:01',
          runId: 'run-9', senderId: null, senderName: null,
          runRequesterId: 'U00002', runRequesterName: '周航', agentName: '欠料追踪助手',
        },
      ],
    }))
    const { wrapper } = await mountView({ item: null })

    expect(wrapper.text()).toContain('这批料谁跟一下？')
    expect(wrapper.text()).toContain('周航')
    expect(wrapper.text()).toContain('欠料追踪助手')
    expect(wrapper.text()).toContain('由 周航 发起')
    // 成员可继续发言
    expect(wrapper.find('task-composer-stub').exists()).toBe(true)
  })

  it('marks who stopped a run in the thread run list and the run view (项目空间方案第 5 节)', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({
      runs: [
        { runId: 'run-7', status: 'cancelled', requestedBy: 'U00002', requesterName: '周航', stoppedByName: '林岚', createdAt: '2026-09-10T10:00:00.000Z' },
        { runId: 'run-8', status: 'succeeded', requestedBy: 'U00002', requesterName: '周航', stoppedByName: null, createdAt: '2026-09-10T10:05:00.000Z' },
      ],
    }))
    const { wrapper } = await mountView({ item: null })
    const rows = wrapper.findAll('[data-testid="session-run"]').map(row => row.text().replace(/\s+/g, ' '))
    expect(rows[0]).toContain('周航 发起 · 林岚 停止')
    expect(rows[1]).not.toContain('停止')

    route.params = { id: 'run-001' }
    const stopped = await mountView({ item: task({ status: 'cancelled', stoppedBy: '林岚' }) })
    expect(stopped.wrapper.get('[data-testid="run-stopped-by"]').text()).toBe('本轮执行已由 林岚 停止')
    const failed = await mountView({ item: task({ status: 'failed', stoppedBy: null }) })
    expect(failed.wrapper.find('[data-testid="run-stopped-by"]').exists()).toBe(false)
  })

  it('aligns my user messages to the right and other members/agents to the left', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({
      messages: [
        {
          id: 'm-mine', role: 'user', content: '我来跟', createdAt: '10:00',
          runId: null, senderId: 'U00001', senderName: '林岚',
          runRequesterId: null, runRequesterName: null, agentName: null,
        },
        {
          id: 'm-other', role: 'user', content: '这批料谁跟一下？', createdAt: '10:01',
          runId: null, senderId: 'U00002', senderName: '周航',
          runRequesterId: null, runRequesterName: null, agentName: null,
        },
        {
          id: 'm-agent', role: 'assistant', content: '延期明细已整理', createdAt: '10:02',
          runId: 'run-9', senderId: null, senderName: null,
          runRequesterId: 'U00002', runRequesterName: '周航', agentName: '欠料追踪助手',
        },
      ],
    }))
    const { wrapper } = await mountView({ item: null })

    const articles = wrapper.findAll('article.conversation-message')
    // 本人消息带 --own（CSS 镜像到右侧）；他人与 Agent 消息保持左侧。
    expect(articles[0]!.classes()).toContain('conversation-message--own')
    expect(articles[1]!.classes()).not.toContain('conversation-message--own')
    expect(articles[2]!.classes()).not.toContain('conversation-message--own')
    // 人员消息与 Agent 回复统一身份行 + 卡片结构。
    expect(articles[0]!.find('.assistant-identity strong').text()).toBe('林岚')
    expect(articles[1]!.find('.assistant-identity strong').text()).toBe('周航')
    expect(articles[0]!.find('.user-message p').text()).toBe('我来跟')
  })

  it('posts a discussion message without creating a run when no Agent is mentioned', async () => {
    route.params = { id: 'session-001' }
    const thread = sessionThread()
    api.getSessionThread.mockResolvedValue(thread)
    api.postSessionMessage.mockResolvedValue({ messageId: 'm3', sessionId: 'session-001' })
    const { wrapper } = await mountView({ item: null })

    wrapper.getComponent(TaskComposer).vm.$emit('submit', {
      prompt: '收到，我下午核对', files: [], workspaceId: 'ws-team', mentions: [],
    })
    await flushPromises()

    expect(api.postSessionMessage).toHaveBeenCalledWith('session-001', '收到，我下午核对', expect.any(String), [])
    expect(api.startRun).not.toHaveBeenCalled()
  })

  it('offers colleagues for @ in a shared discussion and only reminds them (D38)', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    api.listWorkspaceMembers.mockResolvedValue({
      items: [
        { userId: 'U00001', displayName: '林岚', role: 'member', joinedAt: '' },
        { userId: 'U00002', displayName: '周航', role: 'owner', joinedAt: '' },
      ],
      currentUserRole: 'member',
    })
    api.postSessionMessage.mockResolvedValue({ messageId: 'm4', sessionId: 'session-001' })
    const { wrapper } = await mountView({ item: null })
    expect(wrapper.getComponent(TaskComposer).props('mentionOptions')).toEqual([
      { id: 'user:U00002', name: '周航', kind: 'member' },
    ])

    wrapper.getComponent(TaskComposer).vm.$emit('submit', {
      prompt: '@周航 看下', files: [], workspaceId: 'ws-team', mentions: ['user:U00002'],
    })
    await flushPromises()
    expect(api.postSessionMessage).toHaveBeenCalledWith('session-001', '@周航 看下', expect.any(String), ['U00002'])
    expect(api.startRun).not.toHaveBeenCalled()
  })

  it('marks the discussion’s @ reminders read when a team discussion or one of its runs is opened (D38)', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    await mountView({ item: null })
    expect(api.markMentionsRead).toHaveBeenCalledWith('ws-team', 'session-001')

    // 执行详情只载入本次执行的消息，讨论里的 @ 不在页面上，同样标为已读。
    api.markMentionsRead.mockClear()
    route.params = { id: 'run-001' }
    await mountView()
    expect(api.markMentionsRead).toHaveBeenCalledWith('ws-team', 'session-001')
  })

  it('does not mark @ reminders for a personal conversation (D38)', async () => {
    await mountView({ item: task({ workspaceId: 'ws-personal', workspaceType: 'personal', workspaceStatus: 'active' }) })
    expect(api.markMentionsRead).not.toHaveBeenCalled()
  })

  it('starts a run via the mentioned Agent member from a shared session', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    api.startRun.mockResolvedValue(task({ id: 'run-new', sessionId: 'session-001' }))
    const { wrapper, taskStore } = await mountView({ item: null })
    vi.spyOn(taskStore, 'subscribe').mockImplementation(() => {})

    wrapper.getComponent(TaskComposer).vm.$emit('submit', {
      prompt: '@欠料追踪助手 查一下延期', files: [], workspaceId: 'ws-team', mentions: ['wam-9'],
    })
    await flushPromises()

    expect(api.startRun).toHaveBeenCalledWith('session-001', expect.objectContaining({
      workspaceAgentMemberId: 'wam-9',
    }))
    expect(api.postSessionMessage).not.toHaveBeenCalled()
    expect(router.replace).toHaveBeenCalledWith('/conversations/run-new')
  })

  it('hides the composer for a viewer reading a shared team session', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({ currentUserRole: 'viewer' }))
    const { wrapper } = await mountView({ item: null })

    expect(wrapper.find('task-composer-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid="conversation-readonly-notice"]').exists()).toBe(true)
  })

  it('hides the composer and retry affordances for a viewer reading a shared run', async () => {
    route.params = { id: 'run-001' }
    const { wrapper } = await mountView({ item: task({ currentUserRole: 'viewer' }) })

    expect(wrapper.find('task-composer-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid="conversation-readonly-notice"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="重新执行本轮"]').exists()).toBe(false)
    expect(wrapper.findAll('button').filter(button => button.text().trim() === '重新执行本轮')).toHaveLength(0)
  })

  it('treats a shared run without role metadata as read-only (fail-closed)', async () => {
    route.params = { id: 'run-001' }
    const { wrapper } = await mountView({ item: task({ currentUserRole: null }) })

    expect(wrapper.find('task-composer-stub').exists()).toBe(false)
    expect(wrapper.find('[aria-label="重新执行本轮"]').exists()).toBe(false)
  })

  it('keeps write affordances on a personal run without role metadata', async () => {
    route.params = { id: 'run-001' }
    const { wrapper } = await mountView({
      item: task({ workspaceId: 'ws-personal', workspaceName: '我的空间', workspaceType: 'personal', currentUserRole: null }),
      workspace: workspace({ id: 'ws-personal', type: 'personal' }),
    })

    expect(wrapper.find('task-composer-stub').exists()).toBe(true)
  })

  it('scopes completion, token metadata and artifacts to the current run in a shared thread', async () => {
    const { wrapper } = await mountView({
      item: task({
        status: 'succeeded',
        tokenUsage: 1234,
        result: result({
          execution: 'succeeded',
          outcome: 'achieved',
          summary: '执行完成：回答与成果均已登记，结果可追溯核验。',
          error: null,
          artifacts: [{
            id: 'artifact-1',
            name: '欠料分析.xlsx',
            type: 'xlsx',
            version: 1,
            size: '12 KB',
            createdAt: '2026-09-10 10:05',
            runId: 'run-001',
            workspaceId: 'ws-team',
            summary: '本轮成果',
          }],
        }),
        messages: [
          { id: 'm-user', role: 'user', content: '查欠料', createdAt: '10:00', runId: 'run-001' },
          { id: 'm-current', role: 'assistant', content: '本轮回答', createdAt: '10:01', runId: 'run-001' },
          { id: 'm-later', role: 'assistant', content: '另一轮回答', createdAt: '10:02', runId: 'run-002' },
        ],
      }),
    })

    const assistants = wrapper.findAll('article.conversation-message--assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]!.text()).toContain('本轮回答')
    expect(assistants[0]!.text()).toContain('目标已达成')
    expect(assistants[0]!.text()).toContain('欠料分析.xlsx')
    expect(assistants[0]!.text()).toContain('1,234 Token')
    expect(assistants[1]!.text()).toContain('另一轮回答')
    expect(assistants[1]!.text()).not.toContain('目标已达成')
    expect(assistants[1]!.text()).not.toContain('欠料分析.xlsx')
    expect(assistants[1]!.find('.assistant-run-meta').exists()).toBe(false)
  })

  it('attaches a referenceable artifact to the next message with “继续修改” (EX-02)', async () => {
    const artifact = (overrides: Record<string, unknown>) => ({
      id: 'artifact-1', name: '周报.md', type: 'markdown' as const, version: 1, size: '2 KB',
      createdAt: '2026-10-15 10:05', runId: 'run-001', workspaceId: 'ws-personal', summary: '本轮成果', ...overrides,
    })
    const { wrapper, taskStore } = await mountView({
      item: task({
        workspaceId: 'ws-personal', workspaceName: '我的空间', workspaceType: 'personal', status: 'succeeded',
        result: result({
          execution: 'succeeded', outcome: 'achieved', summary: '执行完成', error: null,
          artifacts: [
            artifact({ fileId: 'file-artifact-1', canReference: true }),
            artifact({ id: 'artifact-2', name: '旧报表.html', fileId: 'file-artifact-2', canReference: false }),
          ],
        }),
        messages: [
          { id: 'm-user', role: 'user', content: '写周报', createdAt: '10:00', runId: 'run-001' },
          { id: 'm-answer', role: 'assistant', content: '已生成周报.md', createdAt: '10:01', runId: 'run-001' },
        ],
      }),
      workspace: workspace({ id: 'ws-personal', type: 'personal' }),
    })
    const send = vi.spyOn(taskStore, 'sendMessage').mockResolvedValue(task({ id: 'run-002' }))

    expect(wrapper.find('[data-testid="continue-editing-artifact-2"]').exists()).toBe(false)
    const revise = wrapper.get('[data-testid="continue-editing-artifact-1"]')
    await revise.trigger('click')
    expect(wrapper.get('[data-testid="referenced-artifacts"]').text()).toContain('周报.md · V1')
    expect(revise.text()).toContain('已引用')

    wrapper.getComponent(TaskComposer).vm.$emit('submit', {
      prompt: '把第二节改成要点列表', files: [], workspaceId: 'ws-personal', mentions: [],
    })
    await flushPromises()

    expect(send).toHaveBeenCalledWith('run-001', '把第二节改成要点列表', [], undefined, ['file-artifact-1'], [])
    expect(wrapper.find('[data-testid="referenced-artifacts"]').exists()).toBe(false)
  })

  it('asks what a bare “继续” means after a deliverable, and attaches it on “继续修改” (EX-02)', async () => {
    const artifact = {
      id: 'artifact-1', name: '周报.md', type: 'markdown' as const, version: 2, size: '2 KB', fileId: 'file-artifact-1', canReference: true,
      createdAt: '2026-10-15 10:05', runId: 'run-001', workspaceId: 'ws-personal', summary: '本轮成果',
    }
    const succeeded = task({
      workspaceId: 'ws-personal', workspaceName: '我的空间', workspaceType: 'personal', status: 'succeeded',
      result: result({ execution: 'succeeded', outcome: 'achieved', summary: '执行完成', error: null, artifacts: [artifact] }),
    })
    const { wrapper, taskStore } = await mountView({ item: succeeded, workspace: workspace({ id: 'ws-personal', type: 'personal' }) })
    const send = vi.spyOn(taskStore, 'sendMessage').mockResolvedValue(task({ id: 'run-002' }))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValueOnce('confirm' as never)
      .mockRejectedValueOnce('cancel').mockRejectedValueOnce('close')
    const submit = (prompt: string) => {
      wrapper.getComponent(TaskComposer).vm.$emit('submit', { prompt, files: [], workspaceId: 'ws-personal', mentions: [] })
      return flushPromises()
    }

    await submit('继续。')
    expect(confirm.mock.calls[0]?.[2]).toMatchObject({ confirmButtonText: '继续修改《周报.md》', cancelButtonText: '作为新消息发送' })
    expect(send).toHaveBeenLastCalledWith('run-001', '继续。', [], undefined, ['file-artifact-1'], [])

    await submit('继续')
    expect(send).toHaveBeenLastCalledWith('run-001', '继续', [], undefined, [], [])

    await submit('继续')
    expect(send).toHaveBeenCalledTimes(2)

    await submit('把第二节改成要点列表')
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('offers to re-run a failed round when the employee only says “继续” (EX-02)', async () => {
    const { wrapper, taskStore } = await mountView()
    const retry = vi.spyOn(taskStore, 'retryTask').mockResolvedValue(task({ id: 'run-001', status: 'queued' }))
    const send = vi.spyOn(taskStore, 'sendMessage').mockResolvedValue(task({ id: 'run-002' }))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)

    wrapper.getComponent(TaskComposer).vm.$emit('submit', { prompt: '继续', files: [], workspaceId: 'ws-team', mentions: ['agent-member-1'] })
    await flushPromises()

    expect(confirm.mock.calls[0]?.[2]).toMatchObject({ confirmButtonText: '重新执行上一轮' })
    expect(retry).toHaveBeenCalledWith('run-001')
    expect(send).not.toHaveBeenCalled()
  })

  it('does not show an inline verification warning for an unverified result', async () => {
    // 核验状态仍由 I-06 投影保留，但普通问答和外部业务结果均不在消息流中展示警示横幅。
    const { wrapper } = await mountView({
      item: task({
        status: 'succeeded',
        result: result({
          execution: 'succeeded',
          outcome: 'unverified',
          summary: '执行已结束，但业务结果未验证：执行报告生成 2 个成果，实际登记 0 个。',
          error: null,
          pendingItems: [{
            kind: 'artifact_registration_gap',
            message: '执行报告生成 2 个成果，实际登记 0 个；缺失成果不视为已交付。',
          }],
          receipts: [{
            kind: 'artifact',
            status: 'missing',
            ref: null,
            label: '执行声明 2 个成果，实际仅登记 0 个',
          }],
        }),
        messages: [
          { id: 'm-user', role: 'user', content: '生成报告', createdAt: '10:00', runId: 'run-001' },
          { id: 'm-current', role: 'assistant', content: '已生成两份报告', createdAt: '10:01', runId: 'run-001' },
        ],
      }),
    })

    expect(wrapper.find('[data-testid="run-result-unverified"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('缺失成果不视为已交付')
    expect(wrapper.text()).not.toContain('目标已达成')
  })

  it('routes a task-thread reply to the assigned Agent without @ (项目空间 S1)', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    api.listProjectTasks.mockResolvedValue(page([projectTask()]))
    api.startRun.mockResolvedValue(task({ id: 'run-new', sessionId: 'session-001' }))
    const { wrapper, taskStore } = await mountView({ item: null })
    vi.spyOn(taskStore, 'subscribe').mockImplementation(() => {})

    // 按线程精确查找，而不是在列表第一页里找（较早任务不在第一页）。
    expect(api.listProjectTasks).toHaveBeenCalledWith('ws-team', { sessionId: 'session-001', limit: 1 })
    expect(wrapper.get('[data-testid="task-thread-notice"]').text()).toContain('“缺货分析助手”')
    expect(wrapper.get('[data-testid="task-thread-badge"]').text()).toContain('分析缺货原因')
    wrapper.getComponent(TaskComposer).vm.$emit('submit', {
      prompt: '再看看华南', files: [], workspaceId: 'ws-team', mentions: [],
    })
    await flushPromises()

    expect(api.startRun).toHaveBeenCalledWith('session-001', expect.objectContaining({ workspaceAgentMemberId: 'wam-7' }))
    expect(api.postSessionMessage).not.toHaveBeenCalled()
  })

  it('任务线程信息读取失败时阻止发送，避免静默降级为讨论消息（P2-8）', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    api.listProjectTasks.mockRejectedValue(new Error('项目任务读取失败'))
    const { wrapper } = await mountView({ item: null })

    expect(wrapper.get('[data-testid="task-thread-error"]').text()).toContain('项目任务读取失败')
    wrapper.getComponent(TaskComposer).vm.$emit('submit', {
      prompt: '再看看华南', files: [], workspaceId: 'ws-team', mentions: [],
    })
    await flushPromises()

    expect(api.postSessionMessage).not.toHaveBeenCalled()
    expect(api.startRun).not.toHaveBeenCalled()
  })

  it('does not offer turning an Agent-executed shared thread into a task', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({
      runs: [{ runId: 'run-9', status: 'succeeded', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-10T10:00:00.000Z' }],
    }))
    const { wrapper } = await mountView({ item: null })

    // 任务只在成员明确新建时产生：讨论线程不提供“设为任务”。
    expect(wrapper.text()).not.toContain('设为任务')
    expect(wrapper.find('[data-testid="task-thread-notice"]').exists()).toBe(false)
  })

  it('renders session run statuses as links in the shared discussion thread', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({
      runs: [{
        runId: 'run-9',
        status: 'running',
        requestedBy: 'U00002',
        requesterName: '周航',
        createdAt: '2026-09-10T10:00:00.000Z',
      }],
    }))
    const { wrapper } = await mountView({ item: null })

    const runEntry = wrapper.get('[data-testid="session-run"]')
    expect(runEntry.text()).toContain('周航')
    expect(runEntry.text()).toContain('执行中')
    await runEntry.trigger('click')
    expect(router.push).toHaveBeenCalledWith('/conversations/run-9')
  })
})

describe('ConversationView 空间内嵌套视图（TW-10 导航）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.name = undefined
    route.params = { id: 'run-001' }
    api.listWorkspaceAgentMembers.mockResolvedValue([])
    api.getRun.mockRejectedValue(new Error('not a run'))
    api.getSessionThread.mockRejectedValue(new Error('not found'))
  })

  it('redirects a team session opened via the standalone URL into the workspace', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    await mountView({ item: null })
    expect(router.replace).toHaveBeenCalledWith('/workspaces/ws-team/conversations/session-001')
  })

  it('keeps a personal session on the standalone URL without redirect', async () => {
    route.params = { id: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({ workspaceType: 'personal' }))
    await mountView({ item: null })
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('loads the thread by conversationId when embedded and does not redirect', async () => {
    route.name = 'workspace-conversation'
    route.params = { id: 'ws-team', conversationId: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    const { wrapper } = await mountView({ item: null })
    expect(api.getSessionThread).toHaveBeenCalledWith('session-001')
    expect(router.replace).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('供应商讨论')
  })

  it('moves a task thread opened in the 对话 tab into its task detail', async () => {
    route.name = 'workspace-conversation'
    route.params = { id: 'ws-team', conversationId: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    api.listProjectTasks.mockResolvedValue(page([projectTask()]))
    await mountView({ item: null })
    expect(router.replace).toHaveBeenCalledWith('/workspaces/ws-team/tasks/ptask-1/thread/session-001')
  })

  it('keeps task threads in place when already inside the task detail', async () => {
    route.name = 'workspace-task-thread'
    route.params = { id: 'ws-team', taskId: 'ptask-1', conversationId: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    api.listProjectTasks.mockResolvedValue(page([projectTask()]))
    const { wrapper } = await mountView({ item: null })
    expect(router.replace).not.toHaveBeenCalled()
    // 标题、返回与任务标识由外层任务详情提供；输入框上方是发送方式切换。
    expect(wrapper.find('.conversation-header').exists()).toBe(false)
    expect(wrapper.find('[data-testid="task-thread-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="task-thread-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="task-send-agent"]').exists()).toBe(true)
  })

  describe('S3 任务对话', () => {
    function bridge(overrides: Partial<ProjectTaskDetailBridge> & { taskValue?: ProjectTask; eventValues?: ProjectTaskEvent[] } = {}): ProjectTaskDetailBridge {
      const { taskValue, eventValues, ...rest } = overrides
      return {
        task: ref(taskValue ?? projectTask()),
        events: ref(eventValues ?? []),
        can: () => true,
        start: vi.fn().mockResolvedValue(true),
        openComplete: vi.fn(),
        refresh: vi.fn().mockResolvedValue(undefined),
        ...rest,
      }
    }

    beforeEach(() => {
      route.name = 'workspace-task-thread'
      route.params = { id: 'ws-team', taskId: 'ptask-1', conversationId: 'session-001' }
    })

    it('把执行记录放在发起它的消息之后，未交给 Agent 的发言标“评论”，点执行记录进入执行详情', async () => {
      api.getSessionThread.mockResolvedValue(sessionThread({
        messages: [
          { id: 'm1', role: 'user', content: '分析缺货原因', createdAt: '09:00', sentAt: '2026-09-10T09:00:00.000Z', runId: null, senderId: 'U00002', senderName: '周航', runRequesterId: null, runRequesterName: null, agentName: null },
          { id: 'm2', role: 'user', content: '开始吧', createdAt: '09:05', sentAt: '2026-09-10T09:05:00.000Z', runId: 'run-9', senderId: 'U00002', senderName: '周航', runRequesterId: 'U00002', runRequesterName: '周航', agentName: null },
          { id: 'm3', role: 'assistant', content: '前三个原因如下', createdAt: '09:06', sentAt: '2026-09-10T09:06:00.000Z', runId: 'run-9', senderId: null, senderName: null, runRequesterId: 'U00002', runRequesterName: '周航', agentName: '缺货分析助手' },
          { id: 'm4', role: 'user', content: '口径确认一下', createdAt: '09:10', sentAt: '2026-09-10T09:10:00.000Z', runId: null, senderId: 'U00003', senderName: '苏晚', runRequesterId: null, runRequesterName: null, agentName: null },
        ],
        runs: [{ runId: 'run-9', status: 'succeeded', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-10T09:05:00.000Z' }],
      }))
      const { wrapper } = await mountView({ item: null, bridge: bridge() })
      const order = wrapper.findAll('[data-testid="task-conversation-message"], [data-testid="task-conversation-run"]')
        .map(node => node.attributes('data-testid') === 'task-conversation-run' ? 'run'
          : node.text().includes('前三个原因') ? 'reply'
            : node.text().includes('开始吧') ? 'ask'
              : node.text().includes('口径确认') ? 'comment' : 'brief')
      expect(order).toEqual(['brief', 'ask', 'run', 'reply', 'comment'])
      expect(wrapper.findAll('[data-testid="task-conversation-tag"]').map(node => node.text())).toEqual(['评论'])
      expect(wrapper.get('[data-testid="task-conversation-run"]').text()).toContain('周航 交给 缺货分析助手 执行 · 执行完成')
      await wrapper.get('[data-testid="task-conversation-run"]').trigger('click')
      expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/tasks/ptask-1/thread/run-9')
    })

    it('默认交给 Agent，可切到“仅评论”；发送后停留在任务对话', async () => {
      api.getSessionThread.mockResolvedValue(sessionThread({
        runs: [{ runId: 'run-9', status: 'succeeded', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-10T09:05:00.000Z' }],
      }))
      api.startRun.mockResolvedValue(task({ id: 'run-new', sessionId: 'session-001' }))
      api.postSessionMessage.mockResolvedValue({ messageId: 'm9', sessionId: 'session-001' })
      const detail = bridge()
      const { wrapper, taskStore } = await mountView({ item: null, bridge: detail })
      vi.spyOn(taskStore, 'subscribe').mockImplementation(() => {})

      wrapper.getComponent(TaskComposer).vm.$emit('submit', { prompt: '再看看华南', files: [], workspaceId: 'ws-team', mentions: [] })
      await flushPromises()
      expect(api.startRun).toHaveBeenCalledWith('session-001', expect.objectContaining({ workspaceAgentMemberId: 'wam-7' }))
      expect(router.replace).not.toHaveBeenCalled()
      expect(detail.refresh).toHaveBeenCalled()

      await wrapper.get('[data-testid="task-send-comment"]').trigger('click')
      wrapper.getComponent(TaskComposer).vm.$emit('submit', { prompt: '口径要和上周一致', files: [], workspaceId: 'ws-team', mentions: [] })
      await flushPromises()
      expect(api.postSessionMessage).toHaveBeenCalledWith('session-001', '口径要和上周一致', expect.any(String), [])
      expect(api.startRun).toHaveBeenCalledTimes(1)
    })

    it('S4：定时执行以“定时执行”标注，不显示固定提示，“无变化”回复折叠', async () => {
      api.getSessionThread.mockResolvedValue(sessionThread({
        messages: [
          { id: 'm1', role: 'user', content: '分析缺货原因', createdAt: '09:00', sentAt: '2026-09-10T09:00:00.000Z', runId: null, senderId: 'U00002', senderName: '周航', runRequesterId: null, runRequesterName: null, agentName: null },
          { id: 'm2', role: 'user', content: '按任务说明执行本期工作', createdAt: '09:00', sentAt: '2026-09-11T01:00:00.000Z', runId: 'run-s1', senderId: 'U00002', senderName: '周航', runRequesterId: 'U00002', runRequesterName: '周航', agentName: null },
          { id: 'm3', role: 'assistant', content: '无变化：数据与昨日一致', createdAt: '09:01', sentAt: '2026-09-11T01:01:00.000Z', runId: 'run-s1', senderId: null, senderName: null, runRequesterId: 'U00002', runRequesterName: '周航', agentName: '缺货分析助手' },
        ],
        runs: [{ runId: 'run-s1', status: 'succeeded', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-11T01:00:00.000Z' }],
      }))
      const events: ProjectTaskEvent[] = [
        { id: 'e1', kind: 'scheduled_run', sessionId: 'session-001', actor: { userId: 'U00002', displayName: '周航' }, metadata: { runId: 'run-s1', slot: '2026-09-11T01:00:00.000Z' }, createdAt: '2026-09-11T01:00:00.100Z' },
        { id: 'e2', kind: 'schedule_paused', sessionId: 'session-001', actor: { userId: 'U00002', displayName: '周航' }, metadata: { reason: 'consecutive_failures' }, createdAt: '2026-09-12T01:00:00.000Z' },
      ]
      const { wrapper } = await mountView({ item: null, bridge: bridge({ eventValues: events }) })
      expect(wrapper.text()).not.toContain('按任务说明执行本期工作')
      expect(wrapper.get('[data-testid="task-conversation-run"]').text()).toContain('定时执行 · 执行完成')
      expect(wrapper.get('[data-testid="task-conversation-quiet"]').text()).toContain('无变化（展开）')
      expect(wrapper.findAll('[data-testid="task-conversation-event"]').map(node => node.text()).join(' ')).toContain('定时执行已暂停：连续失败 3 次')
    })

    it('S4：已完成的 Agent 任务只能评论；未完成时可在对话中标记完成', async () => {
      api.getSessionThread.mockResolvedValue(sessionThread({
        runs: [{ runId: 'run-9', status: 'succeeded', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-10T09:05:00.000Z' }],
      }))
      const open = await mountView({ item: null, bridge: bridge() })
      expect(open.wrapper.find('[data-testid="task-complete-from-conversation"]').exists()).toBe(true)
      open.wrapper.unmount()
      const done = await mountView({ item: null, bridge: bridge({ taskValue: projectTask({ status: 'done' }) }) })
      expect(done.wrapper.get('[data-testid="task-send-agent"]').attributes('disabled')).toBeDefined()
      expect(done.wrapper.get('[data-testid="task-send-hint"]').text()).toContain('任务已完成')
      expect(done.wrapper.find('[data-testid="task-complete-from-conversation"]').exists()).toBe(false)
    })

    it('D37：协作模式的“标记完成”在任务详情菜单里，任务对话不再重复提供', async () => {
      api.getSessionThread.mockResolvedValue(sessionThread({
        runs: [{ runId: 'run-9', status: 'succeeded', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-10T09:05:00.000Z' }],
      }))
      const { wrapper } = await mountView({ item: null, bridge: bridge({ completeInMenu: true }) })
      expect(wrapper.find('[data-testid="task-send-agent"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="task-complete-from-conversation"]').exists()).toBe(false)
    })

    it('D37：回复下显示该次执行的成果与执行步骤，“继续修改”带着引用交给 Agent', async () => {
      const artifact: Artifact = {
        id: 'art-1', name: '缺货原因.md', type: 'markdown', version: 2, size: '2 KB', createdAt: '09:06', runId: 'run-9',
        workspaceId: 'ws-team', fileId: 'file-art-1', canReference: true, summary: '',
      }
      api.getSessionThread.mockResolvedValue(sessionThread({
        messages: [
          { id: 'm2', role: 'user', content: '开始吧', createdAt: '09:05', sentAt: '2026-09-10T09:05:00.000Z', runId: 'run-9', senderId: 'U00002', senderName: '周航', runRequesterId: 'U00002', runRequesterName: '周航', agentName: null },
          { id: 'm3', role: 'assistant', content: '前三个原因如下', createdAt: '09:06', sentAt: '2026-09-10T09:06:00.000Z', runId: 'run-9', senderId: null, senderName: null, runRequesterId: 'U00002', runRequesterName: '周航', agentName: '缺货分析助手' },
        ],
        runs: [{ runId: 'run-9', status: 'succeeded', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-10T09:05:00.000Z' }],
        artifacts: [artifact, { ...artifact, id: 'art-other', name: '别的执行.md', runId: 'run-other' }],
      }))
      api.listProjectTasks.mockResolvedValue(page([projectTask()]))
      api.startRun.mockResolvedValue(task({ id: 'run-new', sessionId: 'session-001' }))
      const { wrapper, taskStore } = await mountView({ item: null, bridge: bridge() })
      vi.spyOn(taskStore, 'subscribe').mockImplementation(() => {})

      const reply = wrapper.findAll('[data-testid="task-conversation-message"]').find(node => node.text().includes('前三个原因'))!
      expect(reply.find('[data-testid="answer-artifact-art-1"]').text()).toContain('缺货原因.md')
      expect(reply.find('[data-testid="answer-artifact-art-other"]').exists()).toBe(false)
      expect(reply.find('[data-testid="run-steps-disclosure"]').exists()).toBe(true)

      await reply.get('[data-testid="continue-editing-art-1"]').trigger('click')
      expect(wrapper.get('[data-testid="referenced-artifacts"]').text()).toContain('缺货原因.md · V2')
      wrapper.getComponent(TaskComposer).vm.$emit('submit', { prompt: '加上华南', files: [], workspaceId: 'ws-team', mentions: [] })
      await flushPromises()
      expect(api.startRun).toHaveBeenCalledWith('session-001', expect.objectContaining({
        workspaceAgentMemberId: 'wam-7', fileIds: ['file-art-1'],
      }))
      expect(wrapper.find('[data-testid="referenced-artifacts"]').exists()).toBe(false)
    })

    it('执行中只能评论', async () => {
      api.getSessionThread.mockResolvedValue(sessionThread({
        runs: [{ runId: 'run-9', status: 'running', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-10T09:05:00.000Z' }],
      }))
      api.postSessionMessage.mockResolvedValue({ messageId: 'm9', sessionId: 'session-001' })
      const { wrapper } = await mountView({ item: null, bridge: bridge({ taskValue: projectTask({ status: 'in_progress' }) }) })
      expect(wrapper.get('[data-testid="task-send-agent"]').attributes('disabled')).toBeDefined()
      expect(wrapper.get('[data-testid="task-send-hint"]').text()).toContain('执行中，暂时只能评论')
      wrapper.getComponent(TaskComposer).vm.$emit('submit', { prompt: '先别发给供应商', files: [], workspaceId: 'ws-team', mentions: [] })
      await flushPromises()
      expect(api.postSessionMessage).toHaveBeenCalledWith('session-001', '先别发给供应商', expect.any(String), [])
      expect(api.startRun).not.toHaveBeenCalled()
    })

    it('D37：执行中的执行在执行记录下显示与会话页相同的进度卡片', async () => {
      vi.stubGlobal('EventSource', FakeEventSource)
      api.getSessionThread.mockResolvedValue(sessionThread({
        runs: [{ runId: 'run-9', status: 'running', requestedBy: 'U00002', requesterName: '周航', createdAt: '2026-09-10T09:05:00.000Z' }],
      }))
      // 会话 id 不是 Run：只有执行中的 run-9 读得到详情。
      api.getRun.mockImplementation(async (id: string) => {
        if (id === 'run-9') return task({ id: 'run-9', sessionId: 'session-001', status: 'running' })
        throw new Error('not a run')
      })
      const { wrapper } = await mountView({ item: null, bridge: bridge({ taskValue: projectTask({ status: 'in_progress' }) }) })
      expect(api.getRun).toHaveBeenCalledWith('run-9')
      expect(wrapper.find('[data-testid="run-progress-card"]').exists()).toBe(true)
      await wrapper.get('.run-progress__details').trigger('click')
      expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/tasks/ptask-1/thread/run-9')
    })

    it('未开始的 Agent 任务：“交给 Agent”经任务启动并带上补充要求', async () => {
      api.getSessionThread.mockResolvedValue(sessionThread())
      const detail = bridge({ taskValue: projectTask({ status: 'todo', latestRunId: null }) })
      const { wrapper } = await mountView({ item: null, bridge: detail })
      expect(wrapper.find('[data-testid="task-conversation-start"]').exists()).toBe(true)
      wrapper.getComponent(TaskComposer).vm.$emit('submit', { prompt: '先看华东', files: [], workspaceId: 'ws-team', mentions: [] })
      await flushPromises()
      expect(detail.start).toHaveBeenCalledWith('先看华东')
      expect(api.startRun).not.toHaveBeenCalled()
    })

    it('员工任务：只能发言（不触发 Agent），展示状态记录与完成说明，可从输入框旁标记完成', async () => {
      const employeeTask = projectTask({
        assignee: { type: 'employee', userId: 'U00002', displayName: '周航' },
        status: 'in_progress',
        latestRunId: null,
      })
      api.listProjectTasks.mockResolvedValue(page([employeeTask]))
      api.getSessionThread.mockResolvedValue(sessionThread({
        messages: [
          { id: 'm0', role: 'user', content: '核对交付差异', createdAt: '09:00', sentAt: '2026-09-10T09:00:00.000Z', runId: null, senderId: 'U00001', senderName: '林岚', runRequesterId: null, runRequesterName: null, agentName: null },
          { id: 'm1', role: 'user', content: '已核对前 20 个', createdAt: '10:00', sentAt: '2026-09-10T10:00:00.000Z', runId: null, senderId: 'U00002', senderName: '周航', runRequesterId: null, runRequesterName: null, agentName: null },
        ],
      }))
      api.postSessionMessage.mockResolvedValue({ messageId: 'm9', sessionId: 'session-001' })
      const detail = bridge({
        taskValue: employeeTask,
        eventValues: [
          { id: 'e1', kind: 'status_changed', sessionId: 'session-001', actor: { userId: 'U00002', displayName: '周航' }, metadata: { from: 'todo', to: 'in_progress', auto: true }, createdAt: '2026-09-10T10:00:01.000Z' },
          { id: 'e2', kind: 'completed', sessionId: 'session-001', actor: { userId: 'U00002', displayName: '周航' }, metadata: { note: '偏差 4 个 SKU', deliverables: ['差异表.xlsx'] }, createdAt: '2026-09-10T11:00:00.000Z' },
        ],
      })
      const { wrapper } = await mountView({ item: null, bridge: detail })
      expect(wrapper.find('[data-testid="task-send-agent"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="task-conversation-tag"]').text()).toBe('负责人')
      const events = wrapper.findAll('[data-testid="task-conversation-event"]').map(node => node.text())
      expect(events[0]).toContain('周航 更新了进度，任务进入进行中')
      expect(events[1]).toContain('周航 标记完成')
      expect(events[1]).toContain('偏差 4 个 SKU')
      expect(events[1]).toContain('差异表.xlsx')

      wrapper.getComponent(TaskComposer).vm.$emit('submit', { prompt: '明天完成剩余部分', files: [], workspaceId: 'ws-team', mentions: [] })
      await flushPromises()
      expect(api.postSessionMessage).toHaveBeenCalledWith('session-001', '明天完成剩余部分', expect.any(String), [])
      expect(api.startRun).not.toHaveBeenCalled()

      await wrapper.get('[data-testid="task-complete-from-conversation"]').trigger('click')
      expect(detail.openComplete).toHaveBeenCalled()
    })
  })

  it('opens session runs within the workspace URL when embedded', async () => {
    route.name = 'workspace-conversation'
    route.params = { id: 'ws-team', conversationId: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({
      runs: [{
        runId: 'run-9',
        status: 'running',
        requestedBy: 'U00002',
        requesterName: '周航',
        createdAt: '2026-09-10T10:00:00.000Z',
      }],
    }))
    const { wrapper } = await mountView({ item: null })
    await wrapper.get('[data-testid="session-run"]').trigger('click')
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/conversations/run-9')
  })

  it('falls back to the workspace page when going back without history', async () => {
    route.name = 'workspace-conversation'
    route.params = { id: 'ws-team', conversationId: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    const { wrapper } = await mountView({ item: null })
    await wrapper.get('.conversation-header__back').trigger('click')
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team')
  })

  it('re-roots to the owning workspace when the embedded target belongs elsewhere', async () => {
    // 手改 URL/陈旧链接可能把 B 空间的会话挂进 A 空间外壳：归位到其真实空间。
    route.name = 'workspace-conversation'
    route.params = { id: 'ws-other', conversationId: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    await mountView({ item: null })
    expect(router.replace).toHaveBeenCalledWith('/workspaces/ws-team/conversations/session-001')
  })

  it('refreshes the shared thread when the workspace session stream reports new activity', async () => {
    class FakeSessionStream {
      static instances: FakeSessionStream[] = []
      readonly listeners = new Map<string, (event: MessageEvent<string>) => void>()
      closed = false
      constructor(readonly url: string) { FakeSessionStream.instances.push(this) }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.listeners.set(type, listener as (event: MessageEvent<string>) => void)
      }
      close() { this.closed = true }
      emit(type: string, payload: unknown) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
      }
    }
    vi.stubGlobal('EventSource', FakeSessionStream)
    route.name = 'workspace-conversation'
    route.params = { id: 'ws-team', conversationId: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread())
    const { wrapper } = await mountView({ item: null })
    expect(api.getSessionThread).toHaveBeenCalledTimes(1)
    expect(FakeSessionStream.instances[0]?.url).toBe('/session-events/ws-team')

    // 其他成员发表讨论消息 → 服务端推 session.updated → 线程自动重取。
    api.getSessionThread.mockResolvedValue(sessionThread({
      messages: [{
        id: 'message-live-1',
        role: 'user',
        content: '其他成员刚发的讨论',
        createdAt: '刚刚',
        runId: null,
        senderId: 'U00002',
        senderName: '周航',
        runRequesterId: null,
        runRequesterName: null,
        agentName: null,
      }],
    }))
    FakeSessionStream.instances[0]?.emit('session.updated', {
      session_id: 'session-001',
      activity_at: '2026-09-12T08:01:00.000Z',
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    await flushPromises()

    expect(api.getSessionThread).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('其他成员刚发的讨论')
    vi.unstubAllGlobals()
  })

  it('does not subscribe to the workspace stream for personal sessions', async () => {
    class NoopSessionStream {
      static instances: NoopSessionStream[] = []
      constructor(readonly url: string) { NoopSessionStream.instances.push(this) }
      addEventListener() { return undefined }
      close() { return undefined }
    }
    vi.stubGlobal('EventSource', NoopSessionStream)
    route.name = 'workspace-conversation'
    route.params = { id: 'ws-personal', conversationId: 'session-001' }
    api.getSessionThread.mockResolvedValue(sessionThread({
      workspaceId: 'ws-personal',
      workspaceType: 'personal',
      createdBy: 'U00001',
    }))
    await mountView({ item: null })
    expect(NoopSessionStream.instances).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})
