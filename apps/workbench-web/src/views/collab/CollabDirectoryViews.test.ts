import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import CollabAgentsView from './CollabAgentsView.vue'
import CollabGroupsView from './CollabGroupsView.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getAgents: vi.fn(),
    getWorkspaces: vi.fn(),
    getProjectBrief: vi.fn(),
    listWorkspaceMembers: vi.fn(),
    listWorkspaceAgentMembers: vi.fn(),
    listProjectTasks: vi.fn(),
    listWorkspaceActivity: vi.fn(),
  },
}))

const agents = [
  { id: 'a1', name: '库存助手', description: '盘点库存', welcomeMessage: '你好', version: '2', examplePrompts: ['查库存'] },
  { id: 'a2', name: '报表助手', description: '生成报表', welcomeMessage: '嗨', version: '1', examplePrompts: [] },
]
function ws(id: string, name: string, status: 'active' | 'archived' = 'active', type: 'team' | 'personal' = 'team') {
  return { id, name, description: '', type, status, memberCount: 3, members: ['林岚', '王五', '赵六'], files: [] }
}

function makeRouter() {
  const page = { template: '<div />' }
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/c/agents', name: 'collab-agents', component: page },
      { path: '/c/agents/:agentId', name: 'collab-agent', component: page },
      { path: '/c/groups', name: 'collab-groups', component: page },
      { path: '/c/groups/:id', name: 'collab-group', component: page },
      { path: '/c/chats/agent/:agentId', name: 'collab-agent-chat', component: page },
      { path: '/c/chats/group/:id', name: 'collab-group-chat', component: page },
    ],
  })
}

async function mountView(component: object, path: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = makeRouter()
  await router.push(path)
  await router.isReady()
  const push = vi.spyOn(router, 'push')
  const wrapper = mount(component, {
    global: {
      plugins: [pinia, router, ElementPlus],
      stubs: { ElDialog: true },
    },
  })
  await flushPromises()
  return { wrapper, router, push }
}

beforeEach(() => {
  vi.mocked(workbenchApi.getAgents).mockResolvedValue(agents as never)
  vi.mocked(workbenchApi.getWorkspaces).mockImplementation((async (status: string) =>
    status === 'archived'
      ? [ws('g3', '旧项目', 'archived')]
      : [ws('g1', '采购群'), ws('g2', '财务群'), ws('p1', '个人', 'active', 'personal')]) as never)
  vi.mocked(workbenchApi.getProjectBrief).mockResolvedValue({ content: '本季度采购目标' } as never)
  vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [{ displayName: '林岚' }], currentUserRole: 'owner' } as never)
  vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue([{ name: '库存助手' }] as never)
  vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue({
    items: [{ status: 'in_progress' }, { status: 'todo' }, { status: 'in_progress' }], nextCursor: null, total: 3,
  } as never)
  vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue({ workspaceId: 'g1', items: [], nextCursor: null } as never)
})
afterEach(() => vi.clearAllMocks())

describe('CollabAgentsView', () => {
  it('渲染目录行，未选中时显示空态，发消息进入单聊', async () => {
    const { wrapper, router, push } = await mountView(CollabAgentsView, '/c/agents')
    const rows = wrapper.findAll('ul[aria-label="AI 同事"] button')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('库存助手')
    expect(rows[0]!.text()).toContain('盘点库存')
    expect(wrapper.text()).toContain('选择左侧的一项查看详情')
    expect(wrapper.find('h1').text()).toBe('AI 同事')

    await rows[0]!.trigger('click')
    await flushPromises()
    expect(push).toHaveBeenCalledWith({ name: 'collab-agent', params: { agentId: 'a1' } })
    expect(router.currentRoute.value.name).toBe('collab-agent')
    // 原型的居中详情：名称、说明与信息卡片（版本、可用状态、开场提示、可以这样问）。
    expect(wrapper.get('.collab-profile h2').text()).toBe('库存助手')
    expect(wrapper.get('.collab-profile dl').text()).toMatch(/版本\s*v2/)
    expect(wrapper.get('.collab-profile dl').text()).toMatch(/可以这样问\s*查库存/)
    const send = wrapper.findAll('button').find(b => b.text() === '发消息')!
    await send.trigger('click')
    expect(push).toHaveBeenLastCalledWith({ name: 'collab-agent-chat', params: { agentId: 'a1' } })
  })
})

describe('CollabGroupsView', () => {
  it('默认列出全部团队群组，筛选重新加载，详情按原型显示状态、任务、成员，管理群组打开群信息', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [{ userId: 'u1', displayName: '林岚', role: 'owner' }, { userId: 'u2', displayName: '赵六', role: 'viewer' }],
      currentUserRole: 'owner',
    } as never)
    const { wrapper, push } = await mountView(CollabGroupsView, '/c/groups/g1')
    expect(workbenchApi.getWorkspaces).toHaveBeenCalledWith('all')
    expect(wrapper.findAll('ul[aria-label="群组"] button')).toHaveLength(2)
    const detail = wrapper.get('.group-detail')
    expect(detail.get('h2').text()).toBe('采购群')
    expect(detail.text()).toContain('2 位员工 · 1 个 Agent')
    expect(detail.text()).toContain('本季度采购目标')
    expect(detail.get('dl').text()).toMatch(/状态\s*活动/)
    expect(detail.get('dl').text()).toMatch(/任务\s*2 个进行中 · 1 个待办/)
    expect(detail.get('dl').text()).toMatch(/最近活动\s*暂无活动/)
    const chips = detail.findAll('[aria-label="成员"] li').map(chip => chip.text())
    expect(chips).toEqual(['林岚（负责人）', '赵六（只读）', '库存助手'])
    expect(detail.findAll('[aria-label="成员"] li')[2]!.classes()).toContain('is-agent')
    expect(wrapper.text()).toContain('新建群组')

    await wrapper.findAll('button').find(b => b.text() === '管理群组')!.trigger('click')
    expect(push).toHaveBeenLastCalledWith({ name: 'collab-group-chat', params: { id: 'g1' }, query: { info: '1' } })

    const archived = wrapper.get('[aria-label="群组筛选"]').findAll('button').find(b => b.text() === '已归档')!
    await archived.trigger('click')
    await flushPromises()
    expect(archived.attributes('aria-pressed')).toBe('true')
    expect(workbenchApi.getWorkspaces).toHaveBeenLastCalledWith('archived')
    const rows = wrapper.findAll('ul[aria-label="群组"] button')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('旧项目')
    expect(rows[0]!.text()).toContain('已归档')
    expect(wrapper.text()).toContain('新建群组')
  })

  it('选中项切换后忽略迟到的详情响应', async () => {
    let releaseSlow!: (value: unknown) => void
    vi.mocked(workbenchApi.listProjectTasks).mockImplementation(((id: string) =>
      id === 'g1'
        ? new Promise(resolve => { releaseSlow = resolve })
        : Promise.resolve({ items: [{ status: 'in_progress' }], nextCursor: null, total: 1 })) as never)
    const { wrapper, router } = await mountView(CollabGroupsView, '/c/groups/g1')
    await router.push('/c/groups/g2')
    await flushPromises()
    expect(wrapper.get('.group-detail').text()).toMatch(/财务群/)
    expect(wrapper.get('.group-detail dl').text()).toMatch(/任务\s*1 个进行中/)
    releaseSlow({ items: [{ status: 'in_progress' }, { status: 'in_progress' }, { status: 'in_progress' }], nextCursor: null, total: 3 })
    await flushPromises()
    expect(wrapper.get('.group-detail dl').text()).toMatch(/任务\s*1 个进行中/)
  })
})
