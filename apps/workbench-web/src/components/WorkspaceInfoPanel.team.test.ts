import ElementPlus, { ElTooltip } from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { WorkspaceInfoPanel } from '@dsh-work/workbench-components'
import type { WorkspaceAgentMember } from '@/types/domain'

const teamWorkspace = {
  id: 'ws-team',
  name: '供应链团队',
  description: '团队共享的协作空间。',
  type: 'team' as const,
  memberCount: 4,
  owner: '林岚',
  members: ['林岚', '周航', '陈默', '苏晚'],
}

const personalWorkspace = {
  id: 'ws-personal',
  name: '我的空间',
  description: '个人上下文。',
  type: 'personal' as const,
  memberCount: 1,
  owner: '我',
  members: ['我'],
}

const agentMembers: WorkspaceAgentMember[] = [
  {
    id: 'wam-1',
    agentId: 'agent-1',
    name: '订单分析助手',
    description: '分析订单波动。',
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

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(WorkspaceInfoPanel, {
    props: {
      workspace: teamWorkspace,
      dataScopes: ['订单数据'],
      currentUserRole: 'owner',
      agentMembers,
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('WorkspaceInfoPanel 团队分支', () => {
  it('splits employees and Agents with separate counts (AC-18)', () => {
    const wrapper = mountPanel()

    const employeeSection = wrapper.find('[data-testid="panel-employee-section"]')
    expect(employeeSection.exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-employee-count"]').text()).toBe('4 位员工')
    // 员工段保留现有头像 + 姓名串样式。
    expect(employeeSection.findAll('.workspace-member')).toHaveLength(4)
    expect(employeeSection.text()).toContain('林岚、周航、陈默、苏晚')

    const agentSection = wrapper.find('[data-testid="panel-agent-section"]')
    expect(agentSection.exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-agent-count"]').text()).toBe('2 个 Agent')
    // AC-18：Agent 人数不混入员工人数。
    expect(agentSection.text()).not.toContain('位员工')
    expect(agentSection.findAll('[data-testid="panel-agent-row"]')).toHaveLength(2)
    expect(agentSection.findAll('[data-testid="panel-agent-status"]')).toHaveLength(2)
  })

  it('任何成员都能从右栏可用 Agent 条目发起对话，停用条目不可点', async () => {
    // 普通成员没有成员管理弹窗入口，右栏 Agent 条目是其唯一可达的选择入口。
    const wrapper = mountPanel({ currentUserRole: 'member' })
    const starts = wrapper.findAll('[data-testid="panel-agent-start"]')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.text()).toContain('开始对话')
    await starts[0]?.trigger('click')
    expect(wrapper.emitted('start-agent-conversation')).toEqual([['wam-1']])
  })

  it('只读成员看不到开始对话入口（按服务端 allowedActions）', async () => {
    const wrapper = mountPanel({
      currentUserRole: 'viewer',
      agentMembers: agentMembers.map(member => ({ ...member, allowedActions: [] })),
    })
    expect(wrapper.findAll('[data-testid="panel-agent-start"]')).toHaveLength(0)
  })

  it('已预选为新对话成员的 Agent 行显示「使用中」，不再给出「开始对话」链接', async () => {
    const wrapper = mountPanel({ activeAgentMemberId: 'wam-1' })
    const rows = wrapper.findAll('[data-testid="panel-agent-row"]')

    expect(rows[0]?.find('[data-testid="panel-agent-active"]').text()).toBe('使用中')
    expect(rows[0]?.find('[data-testid="panel-agent-start"]').exists()).toBe(false)
    // 不传 activeAgentMemberId 时入口保持原样。
    const fallback = mountPanel()
    expect(fallback.find('[data-testid="panel-agent-active"]').exists()).toBe(false)
    expect(fallback.findAll('[data-testid="panel-agent-start"]')).toHaveLength(1)
  })

  it('预选成员已停用或不可发起时不显示「使用中」', () => {
    // wam-2 为 disabled：即便被标记为预选 id，也不渲染「使用中」。
    const wrapper = mountPanel({ activeAgentMemberId: 'wam-2' })

    expect(wrapper.find('[data-testid="panel-agent-active"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="panel-agent-start"]')).toHaveLength(1)
  })

  it('shows 管理成员 to owners and admins only', async () => {
    for (const role of ['owner', 'admin']) {
      const wrapper = mountPanel({ currentUserRole: role })
      expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(true)
      await wrapper.find('[data-testid="panel-manage-members"]').trigger('click')
      expect(wrapper.emitted('manage-members')).toBeTruthy()
    }

    for (const role of ['member', 'viewer', null]) {
      const wrapper = mountPanel({ currentUserRole: role })
      expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(false)
    }
  })

  it('shows 管理 Agent in the Agent section to the owner only', async () => {
    // Agent 添加/停用/移除是负责人-only 写轨（与服务端 addAgentMember 口径一致），
    // 因此入口收敛在 Agent 区块且仅负责人可见；admin 管理员工但不管 Agent。
    const owner = mountPanel({ currentUserRole: 'owner' })
    const entry = owner.find('[data-testid="panel-manage-agents"]')
    expect(entry.exists()).toBe(true)
    expect(entry.text()).toContain('管理 Agent')
    await entry.trigger('click')
    expect(owner.emitted('manage-agents')).toBeTruthy()

    for (const role of ['admin', 'member', 'viewer', null]) {
      expect(mountPanel({ currentUserRole: role }).find('[data-testid="panel-manage-agents"]').exists()).toBe(false)
    }
  })

  it('shows the 空间设置 entry to the owner only', async () => {
    const owner = mountPanel({ currentUserRole: 'owner' })
    const entry = owner.find('[data-testid="panel-workspace-settings"]')
    expect(entry.exists()).toBe(true)
    await entry.trigger('click')
    expect(owner.emitted('open-settings')).toBeTruthy()

    for (const role of ['admin', 'member', 'viewer', null]) {
      expect(mountPanel({ currentUserRole: role }).find('[data-testid="panel-workspace-settings"]').exists()).toBe(false)
    }
  })

  it('renders the archived tag and read-only footer for archived teams', () => {
    const active = mountPanel()
    expect(active.find('[data-testid="panel-archived-tag"]').exists()).toBe(false)

    const archived = mountPanel({ workspace: { ...teamWorkspace, status: 'archived' } })
    expect(archived.find('[data-testid="panel-archived-tag"]').text()).toContain('已归档')
    expect(archived.find('.workspace-info-panel__footer').text()).toContain('只读')
  })

  it('renders no team member UI for a personal workspace (AC-23)', () => {
    const wrapper = mountPanel({
      workspace: personalWorkspace,
      currentUserRole: 'owner',
      agentMembers,
    })

    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-workspace-settings"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('管理成员')
    expect(wrapper.text()).not.toContain('空间设置')
    // 个人空间原有内容保持：身份卡、三项事实与既有页脚文案。
    expect(wrapper.text()).toContain('个人工作空间')
    expect(wrapper.text()).toContain('系统已为你创建唯一的默认个人空间')
  })

  it('keeps the API call surface empty without an agentMembers prop', () => {
    const wrapper = mountPanel({ agentMembers: undefined })

    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('0 个 Agent')
  })

  it('localizes Agent status dots with an aria-label', () => {
    const wrapper = mountPanel()
    const labels = wrapper.findAll('[data-testid="panel-agent-status"]')
      .map(node => node.attributes('aria-label'))

    expect(labels).toEqual(['Agent 状态：可用', 'Agent 状态：已停用'])
  })

  it('Agent 第三态：可用但有原因时显示红色「不可用」并在 tooltip 展示原因（5-T1）', () => {
    const wrapper = mountPanel({
      agentMembers: [
        agentMembers[0],
        {
          ...agentMembers[1]!,
          status: 'available',
          allowedActions: ['disable', 'upgrade', 'remove'],
          unavailableReason: '版本失效：Agent 版本已下架',
        },
      ],
    })
    const statuses = wrapper.findAll('[data-testid="panel-agent-status"]')

    expect(statuses[0]?.attributes('aria-label')).toBe('Agent 状态：可用')
    expect(statuses[1]?.attributes('aria-label')).toBe('Agent 状态：不可用')
    expect(statuses[1]?.classes()).toContain('workspace-agent__status--danger')
    // 不可用不渲染「开始对话」入口（服务端 allowedActions 已剔除）。
    expect(wrapper.findAll('[data-testid="panel-agent-start"]')).toHaveLength(1)
    const tooltips = wrapper.findAllComponents(ElTooltip)
    expect(tooltips.some(tooltip => String(tooltip.props('content')).includes('版本失效'))).toBe(true)
  })
})
