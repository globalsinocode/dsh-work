import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { TaskComposer } from '@dsh-work/workbench-components'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { Workspace, WorkspaceFile } from '@/types/domain'
import ConversationStarter from './ConversationStarter.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const apiMocks = vi.hoisted(() => ({ createSession: vi.fn() }))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => ({ query: {} }) }))
vi.mock('@/api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/api/client')>()
  return {
    ...mod,
    workbenchApi: { ...mod.workbenchApi, createSession: apiMocks.createSession },
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
    )
  })

  it('passes the selected team Agent member when starting a conversation (TW-02)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链团队',
        workspaceLocked: true,
        presetAgentMember: { id: 'wam-001', name: '订单分析助手', status: 'available' },
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)

    expect(wrapper.find('[data-testid="preset-agent-member"]').text()).toContain('订单分析助手')

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '分析订单波动',
      files: [],
      workspaceId: 'ws-team',
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '分析订单波动',
      [],
      'ws-team',
      '供应链团队',
      undefined,
      [],
      undefined,
      'wam-001',
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
      '分析订单波动', [], 'ws-team', '供应链团队', undefined, [], undefined, 'wam-1',
    )
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
      props: { presetAgentMember: { id: 'wam-001', name: '订单分析助手', status: 'available' } },
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
      'ws-personal',
      '我的空间',
      undefined,
      [],
      undefined,
      undefined,
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
    const postSessionMessage = vi.spyOn(taskStore, 'postSessionMessage')
      .mockResolvedValue({ messageId: 'msg-1', sessionId: 'session-new' })
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
    expect(apiMocks.createSession).toHaveBeenCalledWith({ title: '帮我看看库存', workspaceId: 'ws-team' })
    expect(postSessionMessage).toHaveBeenCalledWith('session-new', '帮我看看库存')
    expect(createTask).not.toHaveBeenCalled()
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/conversations/session-new')
  })

  it('文本中 @ 的 Agent 成员优先于预选并进入 startRun（TW-10）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链空间',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1', 'wam-9'],
        presetAgentMember: { id: 'wam-1', name: '订单分析助手', status: 'available' },
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
    )
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

  it('团队空间选中可用 Agent 成员后解除阻止并带上关联 ID', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链空间',
        workspaceLocked: true,
        requiresAgentMember: true,
        startableAgentMemberIds: ['wam-1'],
        presetAgentMember: { id: 'wam-1', name: '订单分析助手', status: 'available' },
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)
    await flushPromises()

    expect(wrapper.find('[data-testid="composer-blocked"]').exists()).toBe(false)
    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '帮我看看库存',
      files: [],
      workspaceId: 'ws-team',
    })
    await flushPromises()
    expect(createTask).toHaveBeenCalledWith(
      '帮我看看库存',
      [],
      'ws-team',
      '供应链空间',
      undefined,
      [],
      undefined,
      'wam-1',
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
    expect(offered).toContain('ws-personal')
    expect(offered).toContain('ws-active')
    expect(offered).not.toContain('ws-archived')
  })
})
