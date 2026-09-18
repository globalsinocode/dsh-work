import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { SessionThread, TaskRun, Workspace } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import ConversationView from './ConversationView.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
const route = vi.hoisted(() => ({ params: { id: 'run-001' } }))
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
  runEventsUrl: vi.fn((runId: string) => `/events/${runId}`),
}))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => route }))
vi.mock('@/api/client', () => ({ workbenchApi: api }))

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
    sources: [],
    artifacts: [],
    attachments: [],
    currentUserRole: 'member',
    error: {
      code: 'run_failed',
      message: '本轮执行失败',
      object: '运行 run-001',
      reason: '上游超时',
      suggestion: '可重新执行本轮。',
      retryable: true,
    },
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
  vi.spyOn(taskStore, 'load').mockResolvedValue(undefined)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, options.workspace ?? workspace())
  const wrapper = mount(ConversationView, {
    global: {
      plugins: [pinia, ElementPlus],
      stubs: { TaskComposer: true, RunTimeline: true },
    },
  })
  await flushPromises()
  return { wrapper, taskStore, contentStore }
}

describe('ConversationView 归档只读态（design §2.7 / AC-23）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.params = { id: 'run-001' }
    api.listWorkspaceAgentMembers.mockResolvedValue([])
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
    const item = task({ status: 'running', error: undefined })
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

    expect(api.postSessionMessage).toHaveBeenCalledWith('session-001', '收到，我下午核对')
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
        error: undefined,
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
    expect(assistants[0]!.text()).toContain('已完成')
    expect(assistants[0]!.text()).toContain('欠料分析.xlsx')
    expect(assistants[0]!.text()).toContain('1,234 Token')
    expect(assistants[1]!.text()).toContain('另一轮回答')
    expect(assistants[1]!.text()).not.toContain('已完成')
    expect(assistants[1]!.text()).not.toContain('欠料分析.xlsx')
    expect(assistants[1]!.find('.assistant-run-meta').exists()).toBe(false)
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
