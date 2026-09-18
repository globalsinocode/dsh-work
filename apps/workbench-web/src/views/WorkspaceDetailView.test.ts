import ElementPlus, { ElDialog, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { Component } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type {
  Artifact,
  Workspace,
  WorkspaceActivityItem,
  WorkspaceActivityPage,
  WorkspaceAgentMember,
  WorkspaceFile,
  WorkspaceFileVersion,
  WorkspaceFileVersionPage,
  WorkspaceNotificationState,
  WorkspaceNotificationView,
  WorkspaceUsage,
} from '@/types/domain'
import ConversationStarter from '@/components/ConversationStarter.vue'
import WorkspaceMemberDialog from '@/components/WorkspaceMemberDialog.vue'
import WorkspaceDetailView from './WorkspaceDetailView.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const route = vi.hoisted(() => ({
  name: undefined as string | undefined,
  query: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
}))

vi.mock('vue-router', () => ({
  useRouter: () => router,
  useRoute: () => route,
  RouterView: { template: '<div data-testid="router-view" />' },
}))

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

function activityItem(overrides: Partial<WorkspaceActivityItem> = {}): WorkspaceActivityItem {
  return {
    id: 'wact-1',
    kind: 'file_uploaded',
    actorUserId: 'u-1',
    actorDisplayName: '林岚',
    objectType: 'file',
    objectId: 'wfile-secret-id',
    safeMetadata: {},
    occurredAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  }
}

function activityPage(items: WorkspaceActivityItem[], nextCursor: string | null = null): WorkspaceActivityPage {
  return { workspaceId: 'ws-team', items, nextCursor }
}

function notificationView(overrides: Partial<WorkspaceNotificationView> = {}): WorkspaceNotificationView {
  return {
    workspaceId: 'ws-team',
    items: [],
    nextCursor: null,
    muted: false,
    mutedAt: null,
    lastReadAt: null,
    unreadCount: 0,
    ...overrides,
  }
}

function notificationState(overrides: Partial<WorkspaceNotificationState> = {}): WorkspaceNotificationState {
  return { workspaceId: 'ws-team', muted: false, mutedAt: null, lastReadAt: null, unreadCount: 0, ...overrides }
}

function agentMember(overrides: Partial<WorkspaceAgentMember> = {}): WorkspaceAgentMember {
  return {
    id: 'wam-1',
    agentId: 'agent-1',
    name: '订单分析助手',
    description: '分析订单数据',
    status: 'available',
    version: '1.0.0',
    addedBy: 'user-a',
    createdAt: '2026-09-09T10:00:00.000Z',
    allowedActions: ['start_conversation'],
    ...overrides,
  }
}

/** 空间用量摘要（4-T2）：宿主只在团队 + 负责人/管理员时请求，这里给出默认成功响应。 */
function usageFixture(workspaceId = 'ws-team'): WorkspaceUsage {
  return {
    workspaceId,
    range: '7d',
    rangeDays: 7,
    totals: {
      callCount: 12,
      successCount: 10,
      failedCount: 2,
      estimatedCount: 0,
      inputTokens: 12345,
      outputTokens: 6789,
      totalTokens: 19134,
    },
    daily: [],
  }
}

async function mountView(
  item: Workspace,
  options: { ownerName?: string; artifacts?: Artifact[]; stubs?: Record<string, boolean | Component> } = {},
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, item)
  contentStore.artifacts.splice(0, contentStore.artifacts.length, ...(options.artifacts ?? []))
  // 组件 onMounted 会 refresh；测试固定注入的空间对象。
  vi.spyOn(contentStore, 'refresh').mockResolvedValue(undefined)
  const authStore = useAuthStore(pinia)
  vi.spyOn(authStore, 'user', 'get').mockReturnValue({
    id: 'u-current',
    name: options.ownerName ?? '周航',
    title: '计划经理',
    department: '计划部',
    avatarText: '周',
    role: 'employee',
    dataScopes: ['订单数据'],
  })
  const wrapper = mount(WorkspaceDetailView, {
    global: {
      plugins: [pinia, ElementPlus],
      stubs: options.stubs ?? { ConversationStarter: true },
    },
  })
  await flushPromises()
  return { wrapper, contentStore }
}

describe('WorkspaceDetailView 团队分支与个人空间红线', () => {
  beforeEach(() => {
    route.name = undefined
    route.params = { id: 'ws-team' }
    route.query = {}
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listWorkspaceMembers').mockResolvedValue({ items: [], currentUserRole: null })
    vi.spyOn(workbenchApi, 'listMemberCandidates').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceAgentCandidates').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceActivity').mockResolvedValue(activityPage([]))
    vi.spyOn(workbenchApi, 'getWorkspaceNotifications').mockResolvedValue(notificationView())
    vi.spyOn(workbenchApi, 'listWorkspaceUsage').mockResolvedValue(usageFixture())
  })

  it('renders the Agent segment for a team space and loads members via the T4 API', async () => {
    const { wrapper } = await mountView(workspace())

    expect(workbenchApi.listWorkspaceAgentMembers).toHaveBeenCalledWith('ws-team')
    expect(workbenchApi.listWorkspaceMembers).toHaveBeenCalledWith('ws-team')
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(true)
  })

  it('uses the server roster and server-resolved role instead of inferring ownership from the creator name', async () => {
    // 当前登录用户是空间创建者（owner 字段），但服务端说其角色是 member：
    // 负责人已转交给别人，创建者不得再看到写入口。
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [
        { userId: 'u-new-owner', displayName: '周航', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' },
        { userId: 'u-current', displayName: '林岚', role: 'member', joinedAt: '2026-09-01T00:00:00.000Z' },
      ],
      currentUserRole: 'member',
    })
    const { wrapper } = await mountView(workspace(), { ownerName: '林岚' })

    expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-workspace-settings"]').exists()).toBe(false)
  })

  it('treats the server-declared owner as owner even when they are not the workspace creator', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [{ userId: 'u-current', displayName: '周航', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' }],
      currentUserRole: 'owner',
    })
    // 创建者是「林岚」，当前用户是转交后的新负责人「周航」。
    const { wrapper } = await mountView(workspace(), { ownerName: '周航' })

    expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-workspace-settings"]').exists()).toBe(true)
    // 服务端确认 owner：4-T2 的空间用量区块与详情弹窗随之挂载（默认关闭）。
    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(true)
    // 成员、Agent、空间设置与用量详情四个弹窗均默认关闭。
    expect(wrapper.findAllComponents(ElDialog).map(dialog => dialog.props('modelValue'))).toEqual([false, false, false, false])
  })

  it('opens the team management entry only for the resolved owner', async () => {
    const { wrapper } = await mountView(workspace(), { ownerName: '林岚' })

    const entry = wrapper.find('[data-testid="panel-manage-members"]')
    expect(entry.exists()).toBe(true)
    const settingsEntry = wrapper.find('[data-testid="panel-workspace-settings"]')
    expect(settingsEntry.exists()).toBe(true)
    // 本用例的名册返回 currentUserRole: null（角色未由服务端解析），因此 4-T2 的
    // 空间用量区块与弹窗**不挂载**——用量只认服务端确认的 owner/admin，不回退到
    // 「负责人姓名 == 登录者姓名」（评审 P2/N3）。成员/设置入口仍按既有姓名回退渲染。
    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(false)
    const dialogs = wrapper.findAllComponents(ElDialog)
    expect(dialogs.map(dialog => dialog.props('modelValue'))).toEqual([false, false, false])

    // 团队分支才挂载 2.6 成员管理弹窗与 2.7 空间设置弹窗。
    await entry.trigger('click')
    await flushPromises()
    expect(wrapper.findAllComponents(ElDialog).map(dialog => dialog.props('modelValue'))).toEqual([true, false, false])
    expect(wrapper.find('.member-dialog__body').exists()).toBe(true)

    await settingsEntry.trigger('click')
    await flushPromises()
    expect(wrapper.findAllComponents(ElDialog).map(dialog => dialog.props('modelValue'))).toEqual([true, false, true])
    expect(wrapper.find('.settings-dialog__body').exists()).toBe(true)

    // 「管理 Agent」独立入口：右栏 Agent 区块触发第二个弹窗，成员弹窗不再混管 Agent。
    const agentEntry = wrapper.find('[data-testid="panel-manage-agents"]')
    expect(agentEntry.exists()).toBe(true)
    await agentEntry.trigger('click')
    await flushPromises()
    expect(wrapper.findAllComponents(ElDialog).map(dialog => dialog.props('modelValue'))).toEqual([true, true, true])
    expect(wrapper.find('[data-testid="member-section-agent"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="member-section-employee"]').exists()).toBe(true)
  })

  it('renders the 新对话／历史对话 switch for a team space and defaults to the new conversation', async () => {
    const { wrapper } = await mountView(workspace())

    const viewbar = wrapper.find('[data-testid="conversation-view-switch"]')
    expect(viewbar.exists()).toBe(true)
    expect(viewbar.findAll('button').map(button => button.text())).toEqual(['新对话', '历史对话'])
    expect(viewbar.findAll('button')[0]?.classes()).toContain('is-active')
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(false)
    // 默认新对话不拉取历史，避免无谓请求。
    expect(workbenchApi.listWorkspaceSessions).not.toHaveBeenCalled()
  })

  it('writes ?view=history and replaces the starter with the history view', async () => {
    const { wrapper } = await mountView(workspace())

    await wrapper.findAll('[data-testid="conversation-view-switch"] button')[1]?.trigger('click')
    await flushPromises()

    expect(router.replace).toHaveBeenCalledWith({ query: { view: 'history' } })
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(true)
    // 1B 历史视图默认按本人范围拉取。
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })
  })

  it('exits the embedded conversation route when switching workspace tabs (TW-10)', async () => {
    route.name = 'workspace-conversation'
    route.params = { id: 'ws-team', conversationId: 'session-001' }
    const { wrapper } = await mountView(workspace())

    // 线程路由下正文是内嵌 RouterView；切页签必须同时归位路径，
    // 否则旧线程一直占位、文件页签内容可达但 URL 语义错乱。
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    expect(router.replace).toHaveBeenCalledWith({ path: '/workspaces/ws-team', query: { tab: 'files' } })
  })

  it('restores the history view from a ?view=history deep link after the workspace resolves', async () => {
    route.query = { view: 'history' }
    const { wrapper } = await mountView(workspace())

    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(true)
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })
  })

  it('guides a startable member from an empty personal history back to the new conversation', async () => {
    route.query = { view: 'history' }
    // TW-10：可写成员（服务端确认 member）即可发起讨论会话，无需可用 Agent。
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [{ userId: 'u-current', displayName: '周航', role: 'member', joinedAt: '2026-09-01T00:00:00.000Z' }],
      currentUserRole: 'member',
    })
    vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue([{
      id: 'wam-1',
      agentId: 'agent-1',
      name: '订单分析助手',
      description: '分析订单数据',
      status: 'available',
      version: '1.0.0',
      addedBy: 'user-a',
      createdAt: '2026-09-09T10:00:00.000Z',
      allowedActions: ['start_conversation', 'disable', 'upgrade', 'remove'],
    }])
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({ items: [], nextCursor: null })
    const { wrapper } = await mountView(workspace())
    await flushPromises()

    // 本人尚无会话：显示「本人尚无对话」。
    expect(wrapper.find('[data-testid="session-history-empty-own"]').exists()).toBe(true)
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })

    // 可写成员存在：引导回新对话并清掉 ?view=history。
    const back = wrapper.find('[data-testid="session-history-empty-own"] button')
    expect(back.text()).toBe('发起新对话')
    await back.trigger('click')
    await flushPromises()
    expect(router.replace).toHaveBeenCalledWith({ query: {} })
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(false)
  })

  it('把可发起 Agent 成员传给新对话输入区（@ 提及与唯一成员自动预选在 starter 内完成）', async () => {
    vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue([agentMember()])
    const { wrapper } = await mountView(workspace())
    await flushPromises()

    const starter = wrapper.findComponent(ConversationStarter)
    expect(starter.props('requiresAgentMember')).toBe(true)
    expect(starter.props('startableAgentMemberIds')).toEqual(['wam-1'])
    expect(starter.props('mentionOptions')).toEqual([{ id: 'wam-1', name: '订单分析助手' }])
    // 右栏不再提供「开始对话」入口：Agent 选择统一走输入区 @ 提及。
    expect(wrapper.find('[data-testid="panel-agent-start"]').exists()).toBe(false)
  })

  it('可发起成员集合随成员刷新同步到输入区', async () => {
    vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue([agentMember()])
    const { wrapper } = await mountView(workspace())
    await flushPromises()
    expect(wrapper.findComponent(ConversationStarter).props('startableAgentMemberIds')).toEqual(['wam-1'])

    // 负责人随后加入第二个可用 Agent（经成员弹窗 refresh 链路重新加载）。
    vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue([
      agentMember(),
      agentMember({ id: 'wam-2', agentId: 'agent-2', name: '库存助手' }),
    ])
    wrapper.findComponent(WorkspaceMemberDialog).vm.$emit('refresh')
    await flushPromises()

    expect(wrapper.findComponent(ConversationStarter).props('startableAgentMemberIds')).toEqual(['wam-1', 'wam-2'])
  })

  it('renders no team UI and issues no member query for a personal space (AC-23)', async () => {
    route.params = { id: 'ws-personal' }
    const { wrapper } = await mountView(workspace({
      id: 'ws-personal',
      type: 'personal',
      owner: '周航',
      members: ['周航'],
      memberCount: 1,
    }), { ownerName: '周航' })

    // AC-23 红线：个人空间不新增任何成员相关请求，也不渲染团队 UI。
    expect(workbenchApi.listWorkspaceAgentMembers).not.toHaveBeenCalled()
    expect(workbenchApi.listWorkspaceMembers).not.toHaveBeenCalled()
    expect(workbenchApi.listMemberCandidates).not.toHaveBeenCalled()
    // AC-23 红线：个人空间既不渲染「新对话／历史对话」切换，也不请求团队历史会话。
    expect(workbenchApi.listWorkspaceSessions).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="conversation-view-switch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-workspace-settings"]').exists()).toBe(false)
    expect(wrapper.find('.member-dialog__body').exists()).toBe(false)
    expect(wrapper.find('.settings-dialog__body').exists()).toBe(false)
    // 个人空间右栏文案保持现状。
    expect(wrapper.text()).toContain('系统已为你创建唯一的默认个人空间')
  })

  it('ignores a ?view=history deep link on a personal space without any team request (AC-23)', async () => {
    route.params = { id: 'ws-personal' }
    route.query = { view: 'history' }
    const { wrapper } = await mountView(workspace({
      id: 'ws-personal',
      type: 'personal',
      owner: '周航',
      members: ['周航'],
      memberCount: 1,
    }), { ownerName: '周航' })

    expect(workbenchApi.listWorkspaceSessions).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="conversation-view-switch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(false)
    // 新对话仍是唯一内容：个人空间行为与现状一致。
    expect(wrapper.find('conversation-starter-stub').exists()).toBe(true)
  })
})

describe('WorkspaceDetailView 归档只读态（design §2.7 / AC-14 / AC-23）', () => {
  beforeEach(() => {
    route.params = { id: 'ws-team' }
    route.query = {}
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listWorkspaceMembers').mockResolvedValue({ items: [], currentUserRole: null })
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceActivity').mockResolvedValue(activityPage([]))
    vi.spyOn(workbenchApi, 'getWorkspaceNotifications').mockResolvedValue(notificationView())
    vi.spyOn(workbenchApi, 'listWorkspaceUsage').mockResolvedValue(usageFixture())
  })

  const archivedFile = {
    id: 'file-1',
    name: '库存明细.xlsx',
    type: 'XLSX',
    size: '12 KB',
    uploadedBy: '林岚',
    uploadedAt: '2026-09-09 10:00',
  }
  const artifact: Artifact = {
    id: 'artifact-1',
    name: '季度报告.xlsx',
    type: 'xlsx',
    version: 1,
    size: '20 KB',
    createdAt: '2026-09-10 09:00',
    runId: 'run-1',
    workspaceId: 'ws-team',
    summary: '季度经营分析。',
  }

  function archivedWorkspace(overrides: Partial<Workspace> = {}) {
    return workspace({ status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z', ...overrides })
  }

  it('shows the read-only alert, hides the new-conversation entry and keeps history readable', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'owner' })
    const { wrapper } = await mountView(archivedWorkspace())

    const alert = wrapper.find('[data-testid="workspace-archived-alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('该空间已归档，仅保留有权限的只读查看与下载')
    // 归档执行轨：新对话入口（含视图切换）不渲染。
    expect(wrapper.find('conversation-starter-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid="conversation-view-switch"]').exists()).toBe(false)
    // 内容本身不隐藏：历史对话仍可读。
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(true)
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })
  })

  it('uses the archived empty state instead of the add-Agent guidance when the member has no history', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'owner' })
    const { wrapper } = await mountView(archivedWorkspace())

    expect(wrapper.find('[data-testid="session-history-empty-archived"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('请联系负责人添加可用 Agent 成员')
  })

  it('hides upload entries but keeps shared files visible and readable when archived', async () => {
    route.query = { tab: 'files' }
    const { wrapper } = await mountView(archivedWorkspace({ files: [archivedFile] }))

    expect(wrapper.find('[data-testid="workspace-upload"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-upload-empty"]').exists()).toBe(false)
    // 文件内容与下载/查看入口不受影响；只隐藏指向新对话的引用入口。
    expect(wrapper.text()).toContain('库存明细.xlsx')
    expect(wrapper.text()).not.toContain('引用到对话')
  })

  it('keeps artifacts visible in an archived workspace', async () => {
    route.query = { tab: 'artifacts' }
    const { wrapper } = await mountView(archivedWorkspace(), { artifacts: [artifact] })

    expect(wrapper.text()).toContain('季度报告.xlsx')
  })

  it('offers 恢复空间 only to the owner and restores after confirmation', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [{ userId: 'u-current', displayName: '周航', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' }],
      currentUserRole: 'owner',
    })
    const restore = vi.spyOn(workbenchApi, 'restoreWorkspace').mockResolvedValue({
      id: 'ws-team',
      status: 'active',
      archivedAt: null,
    })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const { wrapper } = await mountView(archivedWorkspace(), { ownerName: '周航' })

    const button = wrapper.find('[data-testid="workspace-restore"]')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    await flushPromises()

    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith('ws-team')
  })

  it('keeps the read-only alert but hides 恢复空间 from a non-owner member', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [{ userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' }],
      currentUserRole: 'viewer',
    })
    const { wrapper } = await mountView(archivedWorkspace())

    expect(wrapper.find('[data-testid="workspace-archived-alert"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-restore"]').exists()).toBe(false)
  })

  it('renders no archived alert on an active team space', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'owner' })
    const { wrapper } = await mountView(workspace())

    expect(wrapper.find('[data-testid="workspace-archived-alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-restore"]').exists()).toBe(false)
    expect(wrapper.find('conversation-starter-stub').exists()).toBe(true)
  })

  it('shows no archived alert or restore entry on a personal space even if it carried the status (AC-23)', async () => {
    route.params = { id: 'ws-personal' }
    const { wrapper } = await mountView(workspace({
      id: 'ws-personal',
      type: 'personal',
      owner: '周航',
      members: ['周航'],
      memberCount: 1,
      status: 'archived',
    }), { ownerName: '周航' })

    expect(wrapper.find('[data-testid="workspace-archived-alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-restore"]').exists()).toBe(false)
  })
})

describe('WorkspaceDetailView 团队动态与通知（TW-08 / 3-T8）', () => {
  beforeEach(() => {
    route.params = { id: 'ws-team' }
    route.query = {}
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listWorkspaceMembers').mockResolvedValue({ items: [], currentUserRole: 'owner' })
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceActivity').mockResolvedValue(activityPage([]))
    vi.spyOn(workbenchApi, 'getWorkspaceNotifications').mockResolvedValue(notificationView())
    vi.spyOn(workbenchApi, 'listWorkspaceUsage').mockResolvedValue(usageFixture())
    vi.spyOn(workbenchApi, 'markWorkspaceNotificationsRead').mockResolvedValue(notificationState())
    vi.spyOn(workbenchApi, 'muteWorkspaceNotifications').mockResolvedValue(notificationState({ muted: true, mutedAt: '2026-09-10T08:00:00.000Z' }))
    vi.spyOn(workbenchApi, 'unmuteWorkspaceNotifications').mockResolvedValue(notificationState())
  })

  it('摘要只取 3 条，未读徽标取服务端数字并在标记已读后清零', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue(activityPage([
      activityItem({ id: 'a-1' }),
      activityItem({ id: 'a-2' }),
      activityItem({ id: 'a-3' }),
      activityItem({ id: 'a-4' }),
    ]))
    vi.mocked(workbenchApi.getWorkspaceNotifications).mockResolvedValue(notificationView({ unreadCount: 4 }))
    const { wrapper } = await mountView(workspace())

    expect(workbenchApi.listWorkspaceActivity).toHaveBeenCalledWith('ws-team', { limit: 3 })
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(3)
    expect(wrapper.find('[data-testid="panel-activity-unread"]').text()).toContain('4')

    await wrapper.find('[data-testid="panel-activity-mark-read"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.markWorkspaceNotificationsRead).toHaveBeenCalledWith('ws-team')
    expect(wrapper.find('[data-testid="panel-activity-unread"]').exists()).toBe(false)
  })

  it('静音后徽标消失，但动态列表仍渲染全部条目（服务端 0 也不过滤）', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue(activityPage([
      activityItem({ id: 'a-1' }),
      activityItem({ id: 'a-2' }),
    ]))
    // 服务端在静音时返回 0；即便返回非 0，前端也不得显示徽标。
    vi.mocked(workbenchApi.getWorkspaceNotifications).mockResolvedValue(
      notificationView({ muted: true, mutedAt: '2026-09-10T08:00:00.000Z', unreadCount: 5 }),
    )
    const { wrapper } = await mountView(workspace())

    expect(wrapper.find('[data-testid="panel-activity-unread"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(2)

    await wrapper.find('[data-testid="panel-activity-mute"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.unmuteWorkspaceNotifications).toHaveBeenCalledWith('ws-team')
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(2)
  })

  it('查看全部抽屉以 limit=20 分页，并按 nextCursor 加载更多', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockImplementation(async (_workspaceId, input = {}) => {
      if (input.limit === 3) return activityPage([activityItem({ id: 'a-summary' })])
      if (input.cursor === 'cursor-1') return activityPage([activityItem({ id: 'a-2' }), activityItem({ id: 'a-3' })])
      return activityPage([activityItem({ id: 'a-1' })], 'cursor-1')
    })
    const { wrapper } = await mountView(workspace())

    await wrapper.find('[data-testid="panel-activity-view-all"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceActivity).toHaveBeenCalledWith('ws-team', { limit: 20 })
    expect(wrapper.findAll('[data-testid="activity-drawer-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="activity-drawer-end"]').exists()).toBe(false)

    await wrapper.find('[data-testid="activity-drawer-load-more"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceActivity).toHaveBeenLastCalledWith('ws-team', { cursor: 'cursor-1', limit: 20 })
    expect(wrapper.findAll('[data-testid="activity-drawer-row"]')).toHaveLength(3)
    expect(wrapper.find('[data-testid="activity-drawer-end"]').exists()).toBe(true)
  })

  it('动态加载失败时摘要就地显示重试，重试会重新请求且不清空其它区块', async () => {
    const listActivity = vi.mocked(workbenchApi.listWorkspaceActivity)
    listActivity.mockRejectedValueOnce(new Error('boom'))
    listActivity.mockResolvedValueOnce(activityPage([activityItem({ id: 'a-1' })]))
    const { wrapper } = await mountView(workspace())

    expect(wrapper.find('[data-testid="panel-activity-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(true)
    expect(listActivity).toHaveBeenCalledTimes(1)

    await wrapper.find('[data-testid="panel-activity-retry"]').trigger('click')
    await flushPromises()

    expect(listActivity).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="panel-activity-error"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(1)
  })

  it('归档空间仍渲染动态与「标记已读／关闭提醒」入口', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue(activityPage([
      activityItem({ id: 'a-1', kind: 'workspace_archived', objectType: 'workspace', objectId: 'ws-team' }),
    ]))
    vi.mocked(workbenchApi.getWorkspaceNotifications).mockResolvedValue(notificationView({ unreadCount: 1 }))
    const { wrapper } = await mountView(workspace({ status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z' }))

    expect(wrapper.find('[data-testid="panel-activity-section"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="panel-activity-mark-read"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-activity-mute"]').exists()).toBe(true)
  })

  it('解析不到文件名的动态显示中性占位，绝不把 objectId 当名称渲染', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue(activityPage([
      activityItem({ kind: 'file_uploaded', objectId: 'wfile-secret-id' }),
    ]))
    const { wrapper } = await mountView(workspace())

    const row = wrapper.find('[data-testid="panel-activity-row"]')
    expect(row.text()).toContain('一个文件')
    expect(wrapper.text()).not.toContain('wfile-secret-id')
  })

  it('个人空间不发出任何动态／通知请求（AC-23）', async () => {
    route.params = { id: 'ws-personal' }
    const { wrapper } = await mountView(workspace({
      id: 'ws-personal',
      type: 'personal',
      owner: '周航',
      members: ['周航'],
      memberCount: 1,
    }), { ownerName: '周航' })

    expect(workbenchApi.listWorkspaceActivity).not.toHaveBeenCalled()
    expect(workbenchApi.getWorkspaceNotifications).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="panel-activity-section"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('最近动态')
  })

  it('抽屉关闭按钮有 aria-label，关闭后焦点回到触发的「查看全部」按钮', async () => {
    const { wrapper } = await mountView(workspace())
    // happy-dom 只对已挂到 document 的元素维护 activeElement。
    document.body.appendChild(wrapper.element)
    const trigger = wrapper.find('[data-testid="panel-activity-view-all"]')
    ;(trigger.element as HTMLElement).focus()
    expect(document.activeElement).toBe(trigger.element)
    await trigger.trigger('click')
    await flushPromises()

    const close = wrapper.find('[data-testid="activity-drawer-close"]')
    expect(close.attributes('aria-label')).toBe('关闭全部动态')

    await close.trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })
})

describe('WorkspaceDetailView 文件版本 UI（TW-07 / 3-T9）', () => {
  beforeEach(() => {
    route.params = { id: 'ws-team' }
    route.query = { tab: 'files' }
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listWorkspaceMembers').mockResolvedValue({ items: [], currentUserRole: 'owner' })
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceActivity').mockResolvedValue(activityPage([]))
    vi.spyOn(workbenchApi, 'getWorkspaceNotifications').mockResolvedValue(notificationView())
    vi.spyOn(workbenchApi, 'listWorkspaceUsage').mockResolvedValue(usageFixture())
    vi.spyOn(workbenchApi, 'listWorkspaceFileVersions').mockResolvedValue(versionPage([versionItem()]))
    vi.spyOn(workbenchApi, 'uploadWorkspaceFileVersion').mockResolvedValue({
      id: 'file-4',
      logicalFileId: 'wfile-1',
      versionNo: 4,
      name: '库存明细.xlsx',
      type: 'XLSX',
      size: '13 KB',
      uploadedBy: '林岚',
      uploadedAt: '刚刚',
      extractionStatus: 'succeeded',
    })
    vi.spyOn(workbenchApi, 'downloadWorkspaceFileVersion').mockResolvedValue(new Blob(['x']))
  })

  function teamFile(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
    return {
      id: 'file-3',
      name: '库存明细.xlsx',
      type: 'XLSX',
      size: '12 KB',
      uploadedBy: '林岚',
      uploadedAt: '2026-09-12 09:00',
      logicalFileId: 'wfile-1',
      versionNo: 3,
      versionCount: 3,
      ...overrides,
    }
  }

  function versionItem(overrides: Partial<WorkspaceFileVersion> = {}): WorkspaceFileVersion {
    return {
      versionNo: 3,
      fileId: 'file-3',
      logicalFileId: 'wfile-1',
      name: '库存明细.xlsx',
      type: 'XLSX',
      size: '12 KB',
      note: '补充 9 月数据',
      uploadedBy: '林岚',
      uploadedAt: '2026-09-12 09:00',
      scanStatus: 'clean',
      parseStatus: 'succeeded',
      current: true,
      canDownload: true,
      ...overrides,
    }
  }

  function versionPage(items: WorkspaceFileVersion[]): WorkspaceFileVersionPage {
    return {
      logicalFileId: 'wfile-1',
      name: '库存明细.xlsx',
      status: 'active',
      latestVersionNo: 2,
      versionCount: items.length,
      items,
    }
  }

  it('关闭一个文件再打开另一个文件时不得残留上一个文件的版本（评审 P1）', async () => {
    // 宿主关闭对话框时仍保留逻辑文件 id，组件实例因此被复用：不清空上一份结果就会
    // 把 A 的版本历史渲染在 B 的文件名之下，行内「下载」还会用 A 的版本号请求 B。
    vi.mocked(workbenchApi.listWorkspaceFileVersions).mockImplementation(async (_ws: string, logicalFileId: string) =>
      versionPage(logicalFileId === 'wfile-a'
        ? [versionItem({ logicalFileId: 'wfile-a', versionNo: 7, fileId: 'file-a7', name: 'A.xlsx' })]
        : [versionItem({ logicalFileId: 'wfile-b', versionNo: 2, fileId: 'file-b2', name: 'B.xlsx' })]))
    const { wrapper } = await mountView(workspace({
      files: [
        teamFile({ id: 'file-a', name: 'A.xlsx', logicalFileId: 'wfile-a', versionNo: 7, versionCount: 7 }),
        teamFile({ id: 'file-b', name: 'B.xlsx', logicalFileId: 'wfile-b', versionNo: 2, versionCount: 2 }),
      ],
    }))

    const entries = wrapper.findAll('[data-testid="workspace-file-versions"]')
    expect(entries).toHaveLength(2)
    await entries[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="file-versions-dialog"]').text()).toContain('V7')

    await wrapper.find('[data-testid="file-versions-close"]').trigger('click')
    await flushPromises()

    await entries[1]!.trigger('click')
    await flushPromises()

    const body = wrapper.find('[data-testid="file-versions-dialog"]').text()
    expect(body).toContain('V2')
    expect(body, '不得在 B 的标题下渲染 A 的版本历史').not.toContain('V7')

    const downloads = wrapper.findAll('[data-testid="file-versions-download"]')
    expect(downloads).toHaveLength(1)
    await downloads[0]!.trigger('click')
    await flushPromises()
    expect(workbenchApi.downloadWorkspaceFileVersion).toHaveBeenLastCalledWith('ws-team', 'wfile-b', 2)
  })

  it('名册未就绪（角色未知）时不渲染上传入口，避免注定 403 的假入口（评审 P2）', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockRejectedValue(new Error('名册失败'))
    const { wrapper } = await mountView(workspace({ files: [teamFile()] }))

    expect(wrapper.find('[data-testid="workspace-file-upload-version"]').exists()).toBe(false)
    // 读取轨不受影响：版本入口仍在。
    expect(wrapper.find('[data-testid="workspace-file-versions"]').exists()).toBe(true)
  })

  it('只有 logicalFileId 而没有版本号时不渲染空白徽标（评审 nit）', async () => {
    const { wrapper } = await mountView(workspace({
      files: [teamFile({ versionNo: undefined, versionCount: undefined })],
    }))

    expect(wrapper.find('[data-testid="workspace-file-versions"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-file-version"]').exists()).toBe(false)
  })

  async function selectVersionFile(wrapper: Awaited<ReturnType<typeof mountView>>['wrapper'], file: File) {
    const input = wrapper.find('[data-testid="workspace-file-upload-input"]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await flushPromises()
  }

  it('文件行显示版本号，且只在多于一个版本时补版本总数', async () => {
    const { wrapper } = await mountView(workspace({
      files: [
        teamFile({ versionNo: 2, versionCount: 2 }),
        teamFile({ id: 'file-a', name: '供应商清单.docx', logicalFileId: 'wfile-2', versionNo: 1, versionCount: 1 }),
      ],
    }))

    const labels = wrapper.findAll('[data-testid="workspace-file-version"]')
    expect(labels).toHaveLength(2)
    expect(labels[0]!.text()).toBe('V2 · 共 2 个版本')
    expect(labels[1]!.text()).toBe('V1')
    // 既有名称/大小/类型/上传人布局保持不变。
    expect(wrapper.text()).toContain('库存明细.xlsx')
    expect(wrapper.text()).toContain('12 KB · 林岚上传 · 2026-09-12 09:00')
    expect(wrapper.text()).toContain('XLSX')
  })

  it('「版本」入口打开对话框，并按逻辑文件 id 请求版本列表', async () => {
    const { wrapper } = await mountView(workspace({ files: [teamFile()] }))

    // 未打开对话框前不发版本请求。
    expect(workbenchApi.listWorkspaceFileVersions).not.toHaveBeenCalled()
    await wrapper.find('[data-testid="workspace-file-versions"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceFileVersions).toHaveBeenCalledWith('ws-team', 'wfile-1')
    expect(wrapper.find('[data-testid="file-versions-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-versions-row"]').exists()).toBe(true)
  })

  it('归档空间隐藏上传入口，但保留版本列表与历史下载（引用入口随执行轨隐藏）', async () => {
    const { wrapper } = await mountView(workspace({
      status: 'archived',
      archivedAt: '2026-09-13T00:00:00.000Z',
      files: [teamFile()],
    }))

    expect(wrapper.find('[data-testid="workspace-file-upload-version"]').exists()).toBe(false)
    await wrapper.find('[data-testid="workspace-file-versions"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceFileVersions).toHaveBeenCalledWith('ws-team', 'wfile-1')
    expect(wrapper.find('[data-testid="file-versions-download"]').exists()).toBe(true)
    // 归档执行轨：与「引用到对话」同口径，不提供「引用此版本」。
    expect(wrapper.find('[data-testid="file-versions-reference"]').exists()).toBe(false)
  })

  it('只读成员没有上传入口，但保留可读的版本入口', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'viewer' })
    const { wrapper } = await mountView(workspace({ files: [teamFile()] }))

    expect(wrapper.find('[data-testid="workspace-file-upload-version"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-file-versions"]').exists()).toBe(true)
  })

  it('活跃团队空间的非只读成员可见上传新版本入口', async () => {
    const { wrapper } = await mountView(workspace({ files: [teamFile()] }))

    expect(wrapper.find('[data-testid="workspace-file-upload-version"]').exists()).toBe(true)
  })

  it('上传新版本先询问可选更新说明，成功后刷新文件列表使新版本成为当前', async () => {
    vi.spyOn(ElMessageBox, 'prompt').mockResolvedValue({ value: '补充 10 月数据' } as never)
    const { wrapper, contentStore } = await mountView(workspace({ files: [teamFile({ versionNo: 2, versionCount: 2 })] }))
    const refreshCallsBefore = vi.mocked(contentStore.refresh).mock.calls.length
    // 模拟服务端刷新：新版本成为文件列表展示的当前版本。
    vi.mocked(contentStore.refresh).mockImplementation(async () => {
      contentStore.workspaces.splice(
        0,
        contentStore.workspaces.length,
        workspace({ files: [teamFile({ id: 'file-4', versionNo: 4, versionCount: 4 })] }),
      )
    })
    const file = new File(['库存'], '库存明细 10月.xlsx', { type: 'application/vnd.ms-excel' })

    await wrapper.find('[data-testid="workspace-file-upload-version"]').trigger('click')
    await selectVersionFile(wrapper, file)

    expect(ElMessageBox.prompt).toHaveBeenCalled()
    expect(workbenchApi.uploadWorkspaceFileVersion).toHaveBeenCalledWith('ws-team', 'wfile-1', file, '补充 10 月数据')
    expect(vi.mocked(contentStore.refresh).mock.calls.length).toBeGreaterThan(refreshCallsBefore)
    expect(wrapper.find('[data-testid="workspace-file-version"]').text()).toBe('V4 · 共 4 个版本')
  })

  it('解析失败时行内说明「原版本未受影响」，不刷新列表、当前版本标记不变', async () => {
    vi.spyOn(ElMessageBox, 'prompt').mockResolvedValue({ value: '' } as never)
    vi.mocked(workbenchApi.uploadWorkspaceFileVersion).mockRejectedValue(
      new Error('文件解析失败（m4-basic-v1）：无法读取工作表'),
    )
    const { wrapper, contentStore } = await mountView(workspace({ files: [teamFile({ versionNo: 2, versionCount: 2 })] }))
    const refreshCallsBefore = vi.mocked(contentStore.refresh).mock.calls.length

    await wrapper.find('[data-testid="workspace-file-upload-version"]').trigger('click')
    await selectVersionFile(wrapper, new File(['坏数据'], '库存明细.xlsx', { type: 'application/vnd.ms-excel' }))

    // 空更新说明原样传给客户端，由客户端决定不发送 X-File-Note。
    expect(workbenchApi.uploadWorkspaceFileVersion).toHaveBeenCalledWith('ws-team', 'wfile-1', expect.any(File), '')
    const error = wrapper.find('[data-testid="workspace-file-upload-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('文件解析失败')
    expect(error.text()).toContain('原版本未受影响')
    // 失败不刷新文件列表，行内仍显示原版本。
    expect(vi.mocked(contentStore.refresh).mock.calls.length).toBe(refreshCallsBefore)
    expect(wrapper.find('[data-testid="workspace-file-version"]').text()).toBe('V2 · 共 2 个版本')
  })

  it('取消更新说明弹窗时不发起上传', async () => {
    vi.spyOn(ElMessageBox, 'prompt').mockRejectedValue(new Error('cancel'))
    const { wrapper } = await mountView(workspace({ files: [teamFile()] }))

    await wrapper.find('[data-testid="workspace-file-upload-version"]').trigger('click')
    await selectVersionFile(wrapper, new File(['库存'], '库存明细.xlsx', { type: 'application/vnd.ms-excel' }))

    expect(workbenchApi.uploadWorkspaceFileVersion).not.toHaveBeenCalled()
  })

  it('「引用此版本」把该版本的不可变对象 id 作为引用 id 传给新对话', async () => {
    const referenced: WorkspaceFile[] = []
    const starterStub = defineComponent({
      name: 'ConversationStarter',
      setup(_, { expose }) {
        expose({
          useWorkspaceFile: (file: WorkspaceFile) => {
            referenced.push(file)
          },
        })
        return () => h('div', { 'data-testid': 'starter-stub' })
      },
    })
    vi.mocked(workbenchApi.listWorkspaceFileVersions).mockResolvedValue(versionPage([
      versionItem({ versionNo: 3, fileId: 'file-object-3', current: true, note: null }),
      versionItem({ versionNo: 1, fileId: 'file-object-1', current: false }),
    ]))
    const { wrapper } = await mountView(workspace({ files: [teamFile()] }), {
      stubs: { ConversationStarter: starterStub },
    })

    await wrapper.find('[data-testid="workspace-file-versions"]').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('[data-testid="file-versions-row"]')
    await rows[1]!.find('[data-testid="file-versions-reference"]').trigger('click')
    await flushPromises()

    expect(referenced).toHaveLength(1)
    // 引用的是所选版本的对象 id，而不是逻辑文件 id 或文件列表当前版本。
    expect(referenced[0]!.id).toBe('file-object-1')
    expect(referenced[0]!.logicalFileId).toBe('wfile-1')
    expect(router.replace).toHaveBeenCalled()
  })

  it('个人空间不渲染任何版本 UI，也不发出版本请求（AC-23）', async () => {
    route.params = { id: 'ws-personal' }
    const { wrapper } = await mountView(workspace({
      id: 'ws-personal',
      type: 'personal',
      owner: '周航',
      members: ['周航'],
      memberCount: 1,
      // 即便夹具带上了版本字段，个人空间也不得渲染或请求版本 UI。
      files: [teamFile()],
    }), { ownerName: '周航' })

    expect(workbenchApi.listWorkspaceFileVersions).not.toHaveBeenCalled()
    expect(workbenchApi.uploadWorkspaceFileVersion).not.toHaveBeenCalled()
    expect(workbenchApi.downloadWorkspaceFileVersion).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="workspace-file-versions"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-file-upload-version"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-file-version"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-file-upload-input"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('V3')
  })

  it('版本对话框关闭按钮有 aria-label，关闭后焦点回到「版本」触发按钮', async () => {
    const { wrapper } = await mountView(workspace({ files: [teamFile()] }))
    // happy-dom 只对已挂到 document 的元素维护 activeElement。
    document.body.appendChild(wrapper.element)
    const trigger = wrapper.find('[data-testid="workspace-file-versions"]')
    ;(trigger.element as HTMLElement).focus()
    await trigger.trigger('click')
    await flushPromises()

    const close = wrapper.find('[data-testid="file-versions-close"]')
    expect(close.attributes('aria-label')).toBe('关闭文件版本')
    // 先把焦点移进弹窗再关闭，否则断言可能空转（关闭前 activeElement 一直是触发按钮，
    // 恢复焦点与「从未移动」无法区分——规格评审 F4）。
    ;(close.element as HTMLElement).focus()
    expect(document.activeElement).toBe(close.element)
    await close.trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })
})

