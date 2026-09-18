import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { WorkspaceInfoPanel } from '@dsh-work/workbench-components'
import type { WorkspaceActivityDisplayItem } from '@/utils/workspace-activity'

const teamWorkspace = {
  id: 'ws-team',
  name: '供应链团队',
  description: '团队共享的协作空间。',
  type: 'team' as const,
  memberCount: 2,
  owner: '林岚',
  members: ['林岚', '周航'],
  status: 'active' as const,
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

function activity(overrides: Partial<WorkspaceActivityDisplayItem> = {}): WorkspaceActivityDisplayItem {
  return {
    id: 'act-1',
    kind: 'file_uploaded',
    actorDisplayName: '林岚',
    safeMetadata: {},
    time: '3 小时前',
    occurredAt: '2026-09-12T02:00:00.000Z',
    ...overrides,
  }
}

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(WorkspaceInfoPanel, {
    props: {
      workspace: teamWorkspace,
      dataScopes: ['订单数据'],
      currentUserRole: 'owner',
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('WorkspaceInfoPanel 最近动态摘要（design §2.9 / TW-08）', () => {
  it('只渲染最新 3 条动态', () => {
    const wrapper = mountPanel({
      activityItems: [
        activity({ id: 'a-1', time: '1 分钟前' }),
        activity({ id: 'a-2', time: '2 分钟前' }),
        activity({ id: 'a-3', time: '3 分钟前' }),
        activity({ id: 'a-4', time: '4 分钟前' }),
        activity({ id: 'a-5', time: '5 分钟前' }),
      ],
    })

    const rows = wrapper.findAll('[data-testid="panel-activity-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.text()).toContain('1 分钟前')
    expect(wrapper.text()).not.toContain('4 分钟前')
  })

  it('未读徽标渲染服务端计数，点击标记已读发起事件', async () => {
    const wrapper = mountPanel({ activityItems: [activity()], unreadCount: 4 })

    const badge = wrapper.find('[data-testid="panel-activity-unread"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('4')

    const read = wrapper.find('[data-testid="panel-activity-mark-read"]')
    expect(read.exists()).toBe(true)
    await read.trigger('click')
    expect(wrapper.emitted('mark-activity-read')).toHaveLength(1)
  })

  it('静音后不显示未读徽标，但动态列表仍然渲染全部条目', () => {
    const wrapper = mountPanel({
      activityItems: [activity({ id: 'a-1' }), activity({ id: 'a-2' })],
      unreadCount: 5,
      muted: true,
    })

    expect(wrapper.find('[data-testid="panel-activity-unread"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="panel-activity-mute"]').text()).toContain('恢复提醒')
  })

  it('未读计数越界时不得渲染「-5 条未读」「2.5 条未读」（评审 nit）', () => {
    for (const [count, expected] of [[-5, false], [0, false], [2.5, true], [1e9, true]] as const) {
      const wrapper = mountPanel({ activityItems: [activity()], unreadCount: count })
      const badge = wrapper.find('[data-testid="panel-activity-unread"]')
      expect(badge.exists()).toBe(expected)
      if (badge.exists()) {
        // 计数只做「正整数」规范化：小数向下取整，绝不渲染小数或负号。
        expect(badge.text()).toBe(`${Math.floor(count)} 条未读`)
        expect(badge.text()).not.toContain('-')
        expect(badge.text()).not.toContain('.')
      }
    }
  })

  it('提醒状态加载失败时显示重试，且不被当作「没有未读」', () => {
    const wrapper = mountPanel({ activityItems: [activity()], notificationError: true })

    const error = wrapper.find('[data-testid="panel-activity-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('提醒状态加载失败')
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="panel-activity-empty"]').exists()).toBe(false)
  })

  it('归档空间 Agent 条目仍只读展示，不出现行内操作', () => {
    const agents = [{
      id: 'wam-1',
      name: '订单助手',
      status: 'available' as const,
      allowedActions: ['start_conversation'],
    }]

    const archived = mountPanel({
      workspace: { ...teamWorkspace, status: 'archived' },
      activityItems: [activity()],
      agentMembers: agents,
    })
    // 条目本身仍展示（只读可看）；「开始对话」入口已整体移除，活动态同样不渲染。
    expect(archived.findAll('[data-testid="panel-agent-row"]')).toHaveLength(1)
    const active = mountPanel({ activityItems: [activity()], agentMembers: agents })
    expect(active.find('[data-testid="panel-agent-start"]').exists()).toBe(false)
    expect(archived.find('[data-testid="panel-agent-start"]').exists()).toBe(false)
  })

  it('归档空间仍渲染动态与「标记已读／关闭提醒」入口', () => {
    const wrapper = mountPanel({
      workspace: { ...teamWorkspace, status: 'archived' },
      activityItems: [activity({ id: 'a-1' })],
      unreadCount: 2,
    })

    expect(wrapper.find('[data-testid="panel-activity-section"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="panel-activity-mark-read"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-activity-mute"]').exists()).toBe(true)
  })

  it('解析不到文件名的动态使用中性占位，不暴露 objectId 或缺失名称', () => {
    const wrapper = mountPanel({
      activityItems: [activity({
        kind: 'file_version_added',
        safeMetadata: { versionNo: 3 },
      })],
      unreadCount: 1,
    })

    const text = wrapper.find('[data-testid="panel-activity-row"]').text()
    expect(text).toContain('文件 V3')
    expect(text).not.toContain('wfile-secret-id')
  })

  it('查看全部是真实按钮并发出事件，关闭提醒是真实按钮', async () => {
    const wrapper = mountPanel({ activityItems: [activity()], unreadCount: 1 })

    const viewAll = wrapper.find('[data-testid="panel-activity-view-all"]')
    expect(viewAll.element.tagName).toBe('BUTTON')
    await viewAll.trigger('click')
    expect(wrapper.emitted('view-all-activity')).toHaveLength(1)

    const mute = wrapper.find('[data-testid="panel-activity-mute"]')
    expect(mute.element.tagName).toBe('BUTTON')
    await mute.trigger('click')
    expect(wrapper.emitted('toggle-activity-mute')).toHaveLength(1)
  })

  it('加载失败时就地显示错误与重试入口，其它区块不受影响', async () => {
    const wrapper = mountPanel({
      activityItems: [],
      activityError: true,
      unreadCount: 0,
    })

    expect(wrapper.find('[data-testid="panel-activity-error"]').exists()).toBe(true)
    // 动态失败不得清空右栏其余内容。
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(true)

    await wrapper.find('[data-testid="panel-activity-retry"]').trigger('click')
    expect(wrapper.emitted('retry-activity')).toHaveLength(1)
  })

  it('无动态时显示空态，且个人空间完全不渲染动态区块（AC-23）', () => {
    const empty = mountPanel({ activityItems: [] })
    expect(empty.find('[data-testid="panel-activity-empty"]').exists()).toBe(true)

    const personal = mountPanel({
      workspace: personalWorkspace,
      activityItems: [activity()],
      unreadCount: 3,
    })
    expect(personal.find('[data-testid="panel-activity-section"]').exists()).toBe(false)
    expect(personal.text()).not.toContain('最近动态')
  })
})
