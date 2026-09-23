import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { SessionThread, TaskResult, TaskRun, Workspace } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import ConversationView from './ConversationView.vue'

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
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  deleteSession: vi.fn(),
  createSession: vi.fn(),
  uploadSessionFile: vi.fn(),
  deleteSessionFile: vi.fn(),
  submitMemoryCandidate: vi.fn(),
  listMemoryProposals: vi.fn(),
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

async function mountView(options: { item?: TaskRun | null; workspace?: Workspace } = {}) {
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
    api.listMemoryProposals.mockResolvedValue([])
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

  it('requires explicit employee content and retention before submitting a controlled-memory candidate', async () => {
    api.submitMemoryCandidate.mockResolvedValue({ id: 'memory-candidate-1', status: 'pending' })
    const { wrapper } = await mountView({
      item: task({
        status: 'succeeded',
        result: result({ execution: 'succeeded', outcome: 'achieved', error: null }),
        messages: [{ id: 'm-current', role: 'assistant', content: '本轮回答不会被自动复制', createdAt: '10:01', runId: 'run-001' }],
      }),
    })

    await wrapper.get('button[aria-label="提交受控记忆候选"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('管理员审核通过前不会被使用')

    const title = wrapper.get('input[placeholder="例如：分析报告展示偏好"]')
    const content = wrapper.get('textarea[placeholder="请用自己的话写明可在后续任务中复用的偏好或经验"]')
    await title.setValue('分析报告展示偏好')
    await content.setValue('生成分析报告时优先使用简洁表格，并明确列出仍待确认的数据。')
    await wrapper.get('input[value="private"]').setValue(true)
    await wrapper.get('input[value="30"]').setValue(true)
    await wrapper.findAll('button').find(button => button.text() === '提交审核')!.trigger('click')
    await flushPromises()

    expect(api.submitMemoryCandidate).toHaveBeenCalledWith({
      attemptId: 'attempt-001', kind: 'preference', title: '分析报告展示偏好',
      content: '生成分析报告时优先使用简洁表格，并明确列出仍待确认的数据。',
      visibility: 'private', retentionDays: 30,
    }, expect.stringContaining('memory:attempt-001:'))
  })

  it('requires employee scope and retention even when selecting an Agent memory proposal', async () => {
    api.listMemoryProposals.mockResolvedValue([{
      id: 'memory-proposal-11111111-1111-4111-8111-111111111111', attemptId: 'attempt-001',
      kind: 'experience', title: '来源核对经验',
      content: '整理资料时，先核对来源与日期，再区分已验证事实和尚待确认的假设。',
      status: 'proposed', createdAt: '2026-09-10T10:00:00Z', expiresAt: '2026-09-17T10:00:00Z',
    }])
    api.submitMemoryCandidate.mockResolvedValue({ id: 'memory-candidate-2', status: 'pending' })
    const { wrapper } = await mountView({
      item: task({
        status: 'succeeded', result: result({ execution: 'succeeded', outcome: 'achieved', error: null }),
        messages: [{ id: 'm-current', role: 'assistant', content: '已整理资料', createdAt: '10:01', runId: 'run-001' }],
      }),
    })
    await wrapper.get('button[aria-label="提交受控记忆候选"]').trigger('click')
    await flushPromises()
    await wrapper.get('input[value="memory-proposal-11111111-1111-4111-8111-111111111111"]').setValue(true)
    await flushPromises()
    expect((wrapper.get('input[placeholder="例如：分析报告展示偏好"]').element as HTMLInputElement).readOnly).toBe(true)
    await wrapper.findAll('button').find(button => button.text() === '提交审核')!.trigger('click')
    expect(api.submitMemoryCandidate).not.toHaveBeenCalled()
    await wrapper.get('input[value="private"]').setValue(true)
    await wrapper.findAll('button').find(button => button.text() === '提交审核')!.trigger('click')
    expect(api.submitMemoryCandidate).not.toHaveBeenCalled()
    await wrapper.get('input[value="30"]').setValue(true)
    await wrapper.findAll('button').find(button => button.text() === '提交审核')!.trigger('click')
    await flushPromises()
    expect(api.submitMemoryCandidate).toHaveBeenCalledWith(expect.objectContaining({
      proposalId: 'memory-proposal-11111111-1111-4111-8111-111111111111',
      kind: 'experience', title: '来源核对经验', visibility: 'private', retentionDays: 30,
    }), expect.stringContaining('memory:attempt-001:'))
  })

  it('does not offer controlled-memory submission for another member\'s shared run', async () => {
    const { wrapper } = await mountView({
      item: task({
        requestedBy: 'U00002',
        currentUserRole: 'member',
        status: 'succeeded',
        result: result({ execution: 'succeeded', outcome: 'achieved', error: null }),
        messages: [{ id: 'm-current', role: 'assistant', content: '其他成员发起的回答', createdAt: '10:01', runId: 'run-001' }],
      }),
    })

    expect(wrapper.find('button[aria-label="提交受控记忆候选"]').exists()).toBe(false)
    expect(api.submitMemoryCandidate).not.toHaveBeenCalled()
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

    expect(api.postSessionMessage).toHaveBeenCalledWith('session-001', '收到，我下午核对', expect.any(String))
    expect(api.startRun).not.toHaveBeenCalled()
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

  it('does not present a succeeded run with missing deliverables as goal achieved (I-06)', async () => {
    // 执行终态 succeeded ≠ 业务达成：登记缺口时展示「结果待核验」与缺口明细。
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

    const notice = wrapper.get('[data-testid="run-result-unverified"]')
    expect(notice.text()).toContain('结果待核验')
    expect(notice.text()).toContain('缺失成果不视为已交付')
    expect(wrapper.text()).not.toContain('目标已达成')
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
