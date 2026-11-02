import ElementPlus, { ElMessage } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { TaskComposer } from '@dsh-work/workbench-components'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { Workspace, WorkspaceFile } from '@/types/domain'
import ConversationStarter from './ConversationStarter.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const routeState = vi.hoisted(() => ({ query: {} as Record<string, string> }))
const apiMocks = vi.hoisted(() => ({ createSession: vi.fn(), postSessionMessage: vi.fn(), getAgentMcpAccess: vi.fn() }))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => ({ query: routeState.query }) }))
vi.mock('@/api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/api/client')>()
  return {
    ...mod,
    workbenchApi: {
      ...mod.workbenchApi,
      createSession: apiMocks.createSession,
      postSessionMessage: apiMocks.postSessionMessage,
      getAgentMcpAccess: apiMocks.getAgentMcpAccess,
    },
  }
})

/** 完整 Workspace 夹具（`status` 已为必填字段，3-T3 收紧）。 */
function wsFixture(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: '空间',
    description: '',
    type: 'team',
    memberCount: 1,
    sessionCount: 0,
    artifactCount: 0,
    updatedAt: '2026-09-10T00:00:00.000Z',
    owner: '林岚',
    members: ['林岚'],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

describe('ConversationStarter', () => {
  it('keeps uploaded attachments when selecting a common task preset in team workspace', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链团队',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1'],
        mentionOptions: [{ id: 'wam-1', name: '订单分析助手' }],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    await flushPromises()

    const composer = wrapper.find('[data-testid="team-space-composer-stage"]')
    const fileInput = composer.get<HTMLInputElement>('input[type="file"]')
    const file = new File(['材料'], '团队材料.pdf', { type: 'application/pdf' })
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    expect(composer.text()).toContain('团队材料.pdf')

    const organizeTask = wrapper.findAll<HTMLButtonElement>('.capability-chip')
      .find(button => button.text().includes('整理文档'))
    await organizeTask?.trigger('click')
    await flushPromises()

    expect(composer.text()).toContain('团队材料.pdf')
    expect(composer.get<HTMLTextAreaElement>('[aria-label="对话输入"]').element.value)
      .toContain('请整理我接下来提供的业务材料')
  })

  it('keeps uploaded attachments when selecting a common task preset', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {},
      global: { plugins: [pinia, ElementPlus] },
    })
    const contentStore = useContentStore(pinia)
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    contentStore.initialized = true
    await flushPromises()

    const composer = wrapper.findComponent(TaskComposer)
    const fileInput = composer.get<HTMLInputElement>('input[type="file"]')
    const file = new File(['材料'], '业务材料.pdf', { type: 'application/pdf' })
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    expect(composer.text()).toContain('业务材料.pdf')

    const organizeTask = wrapper.findAll<HTMLButtonElement>('.capability-chip')
      .find(button => button.text().includes('整理文档'))
    await organizeTask?.trigger('click')
    await flushPromises()

    expect(composer.text()).toContain('业务材料.pdf')
    expect(composer.get<HTMLTextAreaElement>('[aria-label="对话输入"]').element.value)
      .toContain('请整理我接下来提供的业务材料')
  })

  it('does not submit a previously referenced workspace file after switching tasks', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-supply',
        workspaceName: '供应链空间',
        workspaceLocked: true,
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)
    const file: WorkspaceFile = {
      id: 'file-sensitive',
      name: '敏感库存.xlsx',
      type: 'XLSX',
      size: '12 KB',
      uploadedBy: '林岚',
      uploadedAt: '刚刚',
    }

    const exposed = wrapper.vm as unknown as { useWorkspaceFile: (value: WorkspaceFile) => void }
    exposed.useWorkspaceFile(file)
    await flushPromises()
    const reportTask = wrapper.findAll<HTMLButtonElement>('.capability-chip')
      .find(button => button.text().includes('生成报告'))
    expect(reportTask).toBeDefined()
    await reportTask?.trigger('click')
    await flushPromises()

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '生成经营报告',
      files: [],
      workspaceId: 'ws-supply',
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '生成经营报告',
      [],
      'ws-supply',
      '供应链空间',
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    )
  })

  it('passes the @-mentioned team Agent member when starting a conversation (TW-10)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链团队',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-001', 'wam-2'],
        mentionOptions: [
          { id: 'wam-001', name: '订单分析助手' },
          { id: 'wam-2', name: '库存助手' },
        ],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '@订单分析助手 分析订单波动',
      files: [],
      workspaceId: 'ws-team',
      mentions: ['wam-001'],
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '@订单分析助手 分析订单波动',
      [],
      'ws-team',
      '供应链团队',
      undefined,
      [],
      undefined,
      'wam-001',
      undefined,
      undefined,
      [],
    )
  })

  it('auto-selects the only startable Agent member even when the parent passes no preset', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链团队',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1'],
        mentionOptions: [{ id: 'wam-1', name: '订单分析助手' }],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)

    expect(wrapper.find('[data-testid="preset-agent-member"]').text()).toContain('订单分析助手')
    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '分析订单波动', files: [], workspaceId: 'ws-team', mentions: [],
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '分析订单波动', [], 'ws-team', '供应链团队', undefined, [], undefined, 'wam-1', undefined, undefined,
      [],
    )
  })

  it('starts a discussion instead of using the preselected Agent when only colleagues are mentioned (D38)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链团队',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1'],
        mentionOptions: [{ id: 'wam-1', name: '订单分析助手' }],
        colleagueOptions: [{ id: 'user:U2', name: '周航', kind: 'member' }],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask')
    // 讨论发送由 store.startTeamDiscussion 内部走 API（带幂等键），断言 API 层。
    apiMocks.postSessionMessage.mockResolvedValue({ messageId: 'msg-1', sessionId: 'session-new' })
    apiMocks.createSession.mockResolvedValue({
      id: 'session-new', workspaceId: 'ws-team', agentVersionId: null, title: '@周航 看下', createdAt: '2026-09-18T00:00:00.000Z',
    })

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '@周航 看下', files: [], workspaceId: 'ws-team', mentions: ['user:U2'],
    })
    await flushPromises()

    expect(apiMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: '@周航 看下',
      workspaceId: 'ws-team',
    }))
    expect(apiMocks.postSessionMessage).toHaveBeenCalledWith('session-new', '@周航 看下', expect.any(String), ['U2'])
    expect(createTask).not.toHaveBeenCalled()
  })

  it('does not auto-select when multiple startable Agent members are available', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链团队',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1', 'wam-2'],
        mentionOptions: [
          { id: 'wam-1', name: '订单分析助手' },
          { id: 'wam-2', name: '库存助手' },
        ],
      },
      global: { plugins: [pinia, ElementPlus] },
    })

    expect(wrapper.find('[data-testid="preset-agent-member"]').exists()).toBe(false)
  })

  it('does not send a team Agent member id for personal conversations (AC-23)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {},
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)
    // 个人空间未锁定，需等内容 Store 完成加载后才渲染输入区。
    const contentStore = useContentStore(pinia)
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    contentStore.initialized = true

    await flushPromises()
    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '整理个人材料',
      files: [],
      workspaceId: 'ws-personal',
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '整理个人材料',
      [],
      undefined,
      '',
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    )
  })

  it('团队空间无 @ 且未预选 Agent 时创建讨论会话，不产生 Run（TW-10）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链空间',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1'],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask')
    // 讨论发送现在由 store.startTeamDiscussion 内部走 API（带幂等键），
    // 因此断言 API 层而不是 store 方法。
    apiMocks.postSessionMessage.mockResolvedValue({ messageId: 'msg-1', sessionId: 'session-new' })
    apiMocks.createSession.mockResolvedValue({
      id: 'session-new',
      workspaceId: 'ws-team',
      agentVersionId: null,
      title: '帮我看看库存',
      createdAt: '2026-09-18T00:00:00.000Z',
    })
    await flushPromises()

    // 可写成员不再被「必须先选 Agent」挡住：直接发言即开启共享讨论。
    expect(wrapper.find('[data-testid="composer-blocked"]').exists()).toBe(false)

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '帮我看看库存',
      files: [],
      workspaceId: 'ws-team',
      mentions: [],
    })
    await flushPromises()
    // 讨论会话带幂等意图 id，并登记 @ 同事。
    expect(apiMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: '帮我看看库存',
      workspaceId: 'ws-team',
    }))
    expect(apiMocks.postSessionMessage).toHaveBeenCalledWith(
      'session-new',
      '帮我看看库存',
      expect.any(String),
      [],
    )
    expect(createTask).not.toHaveBeenCalled()
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/conversations/session-new')
  })

  it('文本中 @ 的 Agent 成员进入 startRun（TW-10）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链空间',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1', 'wam-9'],
        mentionOptions: [
          { id: 'wam-1', name: '订单分析助手' },
          { id: 'wam-9', name: '欠料追踪助手' },
        ],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)
    await flushPromises()

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '@欠料追踪助手 查一下延期',
      files: [],
      workspaceId: 'ws-team',
      mentions: ['wam-9'],
    })
    await flushPromises()
    expect(createTask).toHaveBeenCalledWith(
      '@欠料追踪助手 查一下延期',
      [],
      'ws-team',
      '供应链空间',
      undefined,
      [],
      undefined,
      'wam-9',
      undefined,
      undefined,
      [],
    )
  })

  it('名册加载中不展示只读误报（角色未知 ≠ viewer）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链空间',
        workspaceLocked: true,
        requiresAgentMember: true,
        canDiscuss: false,
        teamRolePending: true,
        startableAgentMemberIds: ['wam-1'],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="composer-blocked"]').exists()).toBe(false)
    expect(wrapper.find('.composer__send').attributes('disabled')).toBeDefined()
  })

  it('只读成员在团队空间不能发言或发起执行（TW-10 只读口径）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链空间',
        workspaceLocked: true,
        requiresAgentMember: true,
        canDiscuss: false,
        startableAgentMemberIds: ['wam-1'],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask')
    await flushPromises()

    expect(wrapper.find('[data-testid="composer-blocked"]').text()).toContain('只读')
    expect(wrapper.find('.composer__send').attributes('disabled')).toBeDefined()

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '帮我看看库存',
      files: [],
      workspaceId: 'ws-team',
      mentions: [],
    })
    await flushPromises()
    expect(createTask).not.toHaveBeenCalled()
    expect(apiMocks.createSession).not.toHaveBeenCalled()
  })

  it('@ 的 Agent 不在可发起集合时回落到自动预选成员（TW-10 兜底）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链空间',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1'],
        mentionOptions: [{ id: 'wam-1', name: '订单分析助手' }],
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)
    await flushPromises()

    // 提及候选只来自 startable 集合；若因竞态（成员刚被停用）提交了非 startable
    // 的提及，按「无效提及」处理并回落到唯一成员的自动预选，而不是把执行意图
    // 静默降级为讨论消息。
    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '@库存助手 帮我看看库存',
      files: [],
      workspaceId: 'ws-team',
      mentions: ['wam-9'],
    })
    await flushPromises()
    expect(createTask).toHaveBeenCalledWith(
      '@库存助手 帮我看看库存',
      [],
      'ws-team',
      '供应链空间',
      undefined,
      [],
      undefined,
      'wam-1',
      undefined,
      undefined,
      [],
    )
  })

  it('does not offer archived team workspaces for a new conversation (3-T3 执行轨)', async () => {
    // 全局新对话的空间选择器不得列出归档团队空间：服务端会拒绝开跑，列出来只会让
    // 用户走进死路（design §2.7/§3）。个人空间与活动团队空间仍须可选。
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {},
      global: { plugins: [pinia, ElementPlus] },
    })
    const contentStore = useContentStore(pinia)
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    contentStore.initialized = true
    contentStore.workspaces.splice(0, contentStore.workspaces.length,
      wsFixture({ id: 'ws-personal', name: '我的空间', type: 'personal', status: 'active' }),
      wsFixture({ id: 'ws-active', name: '供应链团队', type: 'team', status: 'active' }),
      wsFixture({ id: 'ws-archived', name: '九月复盘', type: 'team', status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z' }),
    )
    await flushPromises()

    const composer = wrapper.findComponent(TaskComposer)
    const offered = (composer.props('workspaces') as Array<{ id: string }>).map(item => item.id)
    expect(offered).toEqual([])
    expect(composer.props('showWorkspaceContext')).toBe(false)
    expect(offered).not.toContain('ws-archived')
  })

  it('explains a disabled MCP connector in the composer instead of sending the user to role settings', async () => {
    routeState.query = { agent: 'agent-webkora', agentVersion: 'agent-version-webkora' }
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore(pinia)
    contentStore.initialized = true
    contentStore.agents = [{
      id: 'agent-webkora',
      versionId: 'agent-version-webkora',
      versionReference: 'agent-webkora@0.1.0',
      name: 'WebKora-知识库智能体',
      description: '基于 WK 知识库回答问题。',
      welcomeMessage: '',
      version: '0.1.0',
      publishedAt: '2026-10-23T00:00:00.000Z',
      examplePrompts: [],
    }]
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    apiMocks.getAgentMcpAccess.mockRejectedValueOnce(Object.assign(
      new Error('已选 MCP Connector 不可用或已变化：WK知识库-开发知识库（connector-mcp-d79be18a）'),
      { suggestion: '请联系管理员恢复该 AI 同事依赖的 MCP Connector（检查启用状态、端点与凭据）；恢复前请改用不依赖该连接器的 AI 同事。' },
    ))

    const wrapper = mount(ConversationStarter, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()

    const blocked = wrapper.find('[data-testid="composer-blocked"]')
    expect(blocked.exists()).toBe(true)
    expect(blocked.text()).toContain('WK知识库-开发知识库')
    expect(blocked.text()).toContain('恢复该 AI 同事依赖的 MCP Connector')
    expect(blocked.text()).not.toContain('配置角色与数据范围')
  })

  it('clears a selected agent as soon as a catalog refresh removes it', async () => {
    routeState.query = { agent: 'agent-1', agentVersion: 'agent-version-v1' }
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore(pinia)
    contentStore.initialized = true
    contentStore.agents = [{
      id: 'agent-1',
      versionId: 'agent-version-v1',
      versionReference: 'agent-1@1.0.0',
      name: '库存同事',
      description: '',
      welcomeMessage: '',
      version: '1.0.0',
      publishedAt: '2026-09-23T00:00:00.000Z',
      examplePrompts: [],
    }]
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    const warn = vi.spyOn(ElMessage, 'warning').mockReturnValue({} as never)

    const wrapper = mount(ConversationStarter, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    expect(wrapper.findComponent(TaskComposer).props('selectedAgentName')).toBe('库存同事')

    // 管理端停用后，壳层的目录复核把它从列表移除。
    contentStore.agents = []
    await flushPromises()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('已停用'))
    expect(wrapper.findComponent(TaskComposer).props('selectedAgentName')).toBe('')
    expect(router.replace).toHaveBeenCalledWith({ query: {} })
  })

  it('turns an action-time agent rejection into a cleared selection instead of a dead-end retry', async () => {
    routeState.query = { agent: 'agent-1', agentVersion: 'agent-version-v1' }
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore(pinia)
    contentStore.initialized = true
    contentStore.agents = [{
      id: 'agent-1',
      versionId: 'agent-version-v1',
      versionReference: 'agent-1@1.0.0',
      name: '库存同事',
      description: '',
      welcomeMessage: '',
      version: '1.0.0',
      publishedAt: '2026-09-23T00:00:00.000Z',
      examplePrompts: [],
    }]
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    vi.spyOn(contentStore, 'refreshAgents').mockResolvedValue([])
    const warn = vi.spyOn(ElMessage, 'warning').mockReturnValue({} as never)
    const taskStore = useTaskStore(pinia)
    vi.spyOn(taskStore, 'createTask').mockRejectedValue(new Error('Agent 不存在或当前用户不可用'))

    const wrapper = mount(ConversationStarter, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '帮我看一下库存', files: [], workspaceId: '', mentions: [],
    })
    await flushPromises()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('已停用'))
    expect(wrapper.findComponent(TaskComposer).props('selectedAgentName')).toBe('')
    expect(contentStore.refreshAgents).toHaveBeenCalled()
  })
})
