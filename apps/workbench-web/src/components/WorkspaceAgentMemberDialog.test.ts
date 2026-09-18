import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { ElTooltip } from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { WorkspaceAgentMember } from '@/types/domain'
import WorkspaceAgentMemberDialog from './WorkspaceAgentMemberDialog.vue'

const agents: WorkspaceAgentMember[] = [
  {
    id: 'wam-1',
    agentId: 'agent-1',
    name: '订单分析助手',
    description: '分析订单波动与异常。',
    status: 'available',
    version: 'v2',
    addedBy: '林岚',
    createdAt: '2026-09-05T00:00:00.000Z',
    allowedActions: ['start_conversation', 'disable', 'upgrade', 'remove'],
  },
  {
    id: 'wam-2',
    agentId: 'agent-2',
    name: '库存巡检助手',
    description: '巡检库存水位。',
    status: 'disabled',
    version: 'v1',
    addedBy: '林岚',
    createdAt: '2026-09-06T00:00:00.000Z',
    allowedActions: ['enable', 'remove'],
  },
]

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(WorkspaceAgentMemberDialog, {
    props: {
      open: true,
      workspaceId: 'ws-team',
      workspaceName: '供应链团队',
      currentUserRole: 'owner',
      agentMembers: agents,
      // 默认直接用 props 驱动渲染；单独的用例验证 `open` 时的服务端加载。
      loadAgentMembers: false,
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

/** el-dialog teleports by default; the component opts out so the panel is queryable. */
function panelOf(wrapper: ReturnType<typeof mountDialog>) {
  return wrapper.find('.member-dialog__body')
}

describe('WorkspaceAgentMemberDialog', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listWorkspaceAgentCandidates').mockResolvedValue({ items: [], nextCursor: null })
  })

  it('loads Agent members from the API when the dialog opens', async () => {
    vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue(agents)
    const wrapper = mountDialog({ agentMembers: [], loadAgentMembers: true })
    await flushPromises()

    expect(workbenchApi.listWorkspaceAgentMembers).toHaveBeenCalledWith('ws-team')
    expect(panelOf(wrapper).findAll('[data-testid="agent-member-row"]')).toHaveLength(2)
  })

  it('renders only server-allowed Agent actions', async () => {
    // 服务端按操作人角色裁剪 allowedActions：成员没有管理动作；start_conversation
    // 仍由服务端返回供输入区 @ 提及判定，但弹窗不再渲染「开始对话」行内入口。
    const wrapper = mountDialog({
      currentUserRole: 'member',
      agentMembers: [
        { ...agents[0]!, allowedActions: ['start_conversation'] },
        { ...agents[1]!, allowedActions: ['enable'] },
      ],
    })
    await flushPromises()
    const rows = panelOf(wrapper).findAll('[data-testid="agent-member-row"]')

    expect(rows[0]?.find('[data-testid="agent-start-conversation"]').exists()).toBe(false)
    expect(rows[0]?.find('[data-testid="agent-action-disable"]').exists()).toBe(false)
    expect(rows[0]?.find('[data-testid="agent-action-remove"]').exists()).toBe(false)
    expect(rows[1]?.find('[data-testid="agent-start-conversation"]').exists()).toBe(false)
    expect(rows[1]?.find('[data-testid="agent-action-enable"]').exists()).toBe(true)
    expect(wrapper.emitted('start-conversation')).toBeUndefined()
  })

  it('confirms Agent lifecycle actions with the in-flight convergence warning', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const update = vi.spyOn(workbenchApi, 'updateWorkspaceAgentMember').mockResolvedValue(agents[0]!)
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="agent-action-disable"]').trigger('click')
    await flushPromises()

    expect(confirm.mock.calls[0]?.[0]).toContain('在途运行')
    expect(update).toHaveBeenCalledWith('ws-team', 'wam-1', { action: 'disable' })
    expect(wrapper.emitted('refresh')).toBeTruthy()

    const remove = vi.spyOn(workbenchApi, 'removeWorkspaceAgentMember').mockResolvedValue({ id: 'wam-2', removed: true })
    await panelOf(wrapper).findAll('[data-testid="agent-action-remove"]')[1].trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith('ws-team', 'wam-2')
  })

  it('shows the unavailable reason inline when the service reports one', async () => {
    const wrapper = mountDialog({
      agentMembers: [
        {
          ...agents[0]!,
          status: 'available',
          allowedActions: ['disable', 'upgrade', 'remove'],
          unavailableReason: 'Runtime 不可用：暂无可接单的运行节点',
        },
        { ...agents[1]!, unavailableReason: null },
      ],
    })
    await flushPromises()
    const panel = panelOf(wrapper)
    const statuses = panel.findAll('[data-testid="agent-status-tooltip"]')
    expect(statuses).toHaveLength(2)

    // 第三态：status 仍是 available，但服务端给出原因 ⇒ 红色「不可用」+ 原因 tooltip。
    expect(statuses[0]?.attributes('aria-label')).toBe('Agent 状态：不可用')
    expect(statuses[0]?.classes()).toContain('member-dialog__status--danger')
    // 已停用仍是灰色 neutral「已停用」，不展示原因。
    expect(statuses[1]?.attributes('aria-label')).toBe('Agent 状态：已停用')
    expect(statuses[1]?.classes()).not.toContain('member-dialog__status--danger')

    const tooltipContents = wrapper.findAllComponents(ElTooltip).map(tooltip => String(tooltip.props('content')))
    expect(tooltipContents).toContain('Runtime 不可用：暂无可接单的运行节点')
    // 「开始对话」入口已整体移除，任何成员行都不再渲染。
    expect(panel.findAll('[data-testid="agent-start-conversation"]')).toHaveLength(0)
    expect(panel.findAll('[data-testid="agent-action-disable"]')).toHaveLength(1)
  })

  it('renders empty states with role-aware guidance', async () => {
    const ownerView = mountDialog({ agentMembers: [], currentUserRole: 'owner' })
    await flushPromises()
    expect(panelOf(ownerView).text()).toContain('尚未加入 Agent')
    expect(panelOf(ownerView).find('[data-testid="member-add-agent"]').exists()).toBe(true)

    const memberView = mountDialog({ agentMembers: [], currentUserRole: 'member' })
    await flushPromises()
    expect(panelOf(memberView).text()).toContain('请联系负责人')
    expect(panelOf(memberView).find('[data-testid="member-add-agent"]').exists()).toBe(false)
  })

  it('runs the add-Agent confirmation flow with detail before joining', async () => {
    vi.mocked(workbenchApi.listWorkspaceAgentCandidates).mockResolvedValue({
      items: [{
        agentId: 'agent-9',
        name: '排产助手',
        description: '生成排产建议。',
        activeVersionId: 'av-9',
        activeVersion: 'v1',
        status: 'published',
      }],
      nextCursor: null,
    })
    const addAgent = vi.spyOn(workbenchApi, 'addWorkspaceAgentMember').mockResolvedValue(agents[0]!)
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-add-agent"]').trigger('click')
    await panelOf(wrapper).find('[data-testid="member-agent-search"]').setValue('排产')
    // Agent 搜索同样有 300ms 防抖：条件等待请求真正发出，替代固定 350ms sleep。
    await vi.waitFor(
      () => expect(workbenchApi.listWorkspaceAgentCandidates).toHaveBeenCalledWith('ws-team', { query: '排产', limit: 10 }),
      { timeout: 5_000 },
    )
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="agent-candidate-row"] button').trigger('click')
    await flushPromises()

    const detail = panelOf(wrapper).find('[data-testid="agent-candidate-detail"]')
    expect(detail.exists()).toBe(true)
    expect(detail.text()).toContain('职责')
    expect(detail.text()).toContain('关联技能')
    expect(detail.text()).toContain('所需工具')
    expect(detail.text()).toContain('数据范围')
    expect(addAgent).not.toHaveBeenCalled()

    await detail.find('[data-testid="agent-candidate-confirm"]').trigger('click')
    await flushPromises()
    expect(addAgent).toHaveBeenCalledWith('ws-team', { agentId: 'agent-9' })
    expect(wrapper.emitted('refresh')).toBeTruthy()
  })

  it('does not query the API while the dialog is closed', async () => {
    const load = vi.mocked(workbenchApi.listWorkspaceAgentMembers)
    const wrapper = mountDialog({ open: false, loadAgentMembers: true })
    await flushPromises()

    expect(load).not.toHaveBeenCalled()

    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(load).toHaveBeenCalledWith('ws-team')
  })

  it('以归档态打开时隐藏所有 Agent 写入口', async () => {
    // design §2.7/§3 + 3-T1 执行轨：归档空间的 Agent 变更会被服务端 403，
    // 渲染出来只会让用户走进死路（成员紧急撤权例外只发生在员工弹窗）。
    const wrapper = mountDialog({ archived: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="member-add-agent"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-action-disable"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-action-upgrade"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-action-remove"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="agent-start-conversation"]').exists()).toBe(false)
  })

  it('非归档（默认）仍渲染写入口，避免把归档门禁误加到正常空间', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.find('[data-testid="member-add-agent"]').exists()).toBe(true)
  })
})
