/**
 * 3-T8（TW-08 前端）对抗性评审修复的回归锚点。
 *
 * 这里专门覆盖「异步与越界响应」这一类用例：切换空间后晚到的旧响应、连续重试的乱序
 * 响应、抽屉重试把事件对象当 workspaceId、以及越界响应体导致整页渲染失败。竞态用例
 * 需要**可响应式**地切换路由（`route.params.id`），因此本文件自带一份 reactive 的
 * vue-router mock（`WorkspaceDetailView.test.ts` 用的是普通对象，切不了空间）。
 */
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type {
  Workspace,
  WorkspaceActivityItem,
  WorkspaceActivityPage,
  WorkspaceNotificationState,
  WorkspaceNotificationView,
} from '@/types/domain'
import WorkspaceDetailView from './WorkspaceDetailView.vue'

const holders = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  route: null as unknown as { query: Record<string, unknown>; params: Record<string, unknown> },
}))

vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  holders.route = reactive({ query: {} as Record<string, unknown>, params: { id: 'ws-team-1' } })
  const { defineComponent, h } = await import('vue')
  const RouterLink = defineComponent({
    props: { to: { type: [String, Object], required: true } },
    setup(props, { slots }) {
      return () => h('a', { href: String(props.to) }, slots.default?.())
    },
  })
  const RouterView = defineComponent({ setup: () => () => h('div') })
  return { useRouter: () => holders.router, useRoute: () => holders.route, RouterLink, RouterView }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function ws(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `空间 ${id}`,
    description: 'x',
    type: 'team',
    memberCount: 2,
    sessionCount: 0,
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

function item(id: string, overrides: Partial<WorkspaceActivityItem> = {}): WorkspaceActivityItem {
  return {
    id,
    kind: 'workspace_archived',
    actorUserId: 'u-1',
    actorDisplayName: id,
    objectType: 'workspace',
    objectId: 'obj',
    safeMetadata: {},
    occurredAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  }
}

function page(workspaceId: string, items: WorkspaceActivityItem[], nextCursor: string | null = null): WorkspaceActivityPage {
  return { workspaceId, items, nextCursor }
}

function notif(overrides: Partial<WorkspaceNotificationView> = {}): WorkspaceNotificationView {
  return {
    workspaceId: 'ws-team-1',
    items: [],
    nextCursor: null,
    muted: false,
    mutedAt: null,
    lastReadAt: null,
    unreadCount: 0,
    ...overrides,
  }
}

function state(overrides: Partial<WorkspaceNotificationState> = {}): WorkspaceNotificationState {
  return { workspaceId: 'ws-team-1', muted: false, mutedAt: null, lastReadAt: null, unreadCount: 0, ...overrides }
}

const mounted: Array<{ unmount: () => void }> = []
const renderErrors: unknown[] = []

async function mountWith(
  workspaces: Workspace[],
  routeId?: string,
  options: { refresh?: (store: ReturnType<typeof useContentStore>) => void | Promise<void> } = {},
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, ...workspaces)
  vi.spyOn(contentStore, 'refresh').mockImplementation(async () => {
    await options.refresh?.(contentStore)
  })
  const authStore = useAuthStore(pinia)
  vi.spyOn(authStore, 'user', 'get').mockReturnValue({
    id: 'u-current',
    name: '周航',
    title: '计划经理',
    department: '计划部',
    avatarText: '周',
    role: 'employee',
    dataScopes: ['订单数据'],
  } as never)
  holders.route.params.id = routeId ?? workspaces[0]!.id
  const wrapper = mount(WorkspaceDetailView, {
    global: {
      plugins: [pinia, ElementPlus],
      stubs: { ConversationStarter: true },
      config: { errorHandler: (error: unknown) => { renderErrors.push(error) } },
    },
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, contentStore }
}

const panelRows = (wrapper: { findAll: (selector: string) => Array<{ text: () => string }> }) =>
  wrapper.findAll('[data-testid="panel-activity-row"]').map(node => node.text()).join(' | ')

beforeEach(() => {
  holders.route.params.id = 'ws-team-1'
  holders.route.query = {}
  holders.router.push.mockReset()
  holders.router.replace.mockReset()
  renderErrors.splice(0, renderErrors.length)
  vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
  vi.spyOn(workbenchApi, 'listWorkspaceMembers').mockResolvedValue({ items: [], currentUserRole: 'owner' })
  vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(workbenchApi, 'listWorkspaceActivity').mockResolvedValue(page('ws-team-1', []))
  vi.spyOn(workbenchApi, 'getWorkspaceNotifications').mockResolvedValue(notif())
  vi.spyOn(workbenchApi, 'markWorkspaceNotificationsRead').mockResolvedValue(state())
  vi.spyOn(workbenchApi, 'muteWorkspaceNotifications').mockResolvedValue(state({ muted: true }))
  vi.spyOn(workbenchApi, 'unmuteWorkspaceNotifications').mockResolvedValue(state())
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) {
    try { wrapper.unmount() } catch { /* ignore */ }
  }
  document.body.innerHTML = ''
})

describe('3-T8 竞态：晚到的旧响应不得写进当前空间（评审 P1-2）', () => {
  it('切换空间后，旧空间的摘要响应必须被丢弃', async () => {
    const stale = deferred<WorkspaceActivityPage>()
    vi.mocked(workbenchApi.listWorkspaceActivity).mockImplementation(async (id: string, input: { limit?: number } = {}) => {
      if (id === 'ws-team-1' && input.limit === 3) return stale.promise
      return page(id, [item(`FRESH-${id}`)])
    })
    const { wrapper } = await mountWith([ws('ws-team-1'), ws('ws-team-2')], 'ws-team-1')
    // ws-team-1 的摘要仍在途中，此时切到 ws-team-2。
    holders.route.params.id = 'ws-team-2'
    await flushPromises()
    expect(panelRows(wrapper)).toContain('FRESH-ws-team-2')

    stale.resolve(page('ws-team-1', [item('STALE-ws-team-1')]))
    await flushPromises()
    expect(panelRows(wrapper)).not.toContain('STALE-ws-team-1')
  })

  it('切换空间后，旧空间的未读徽标响应必须被丢弃', async () => {
    const stale = deferred<WorkspaceNotificationView>()
    vi.mocked(workbenchApi.getWorkspaceNotifications).mockImplementation(async (id: string) => {
      if (id === 'ws-team-1') return stale.promise
      return notif({ workspaceId: id, unreadCount: 2 })
    })
    const { wrapper } = await mountWith([ws('ws-team-1'), ws('ws-team-2')], 'ws-team-1')
    holders.route.params.id = 'ws-team-2'
    await flushPromises()
    expect(wrapper.find('[data-testid="panel-activity-unread"]').text()).toContain('2')

    stale.resolve(notif({ workspaceId: 'ws-team-1', unreadCount: 99 }))
    await flushPromises()
    expect(wrapper.find('[data-testid="panel-activity-unread"]').text()).toContain('2')
  })

  it('切换空间后，旧空间的静音响应不得改到新空间的按钮上', async () => {
    const stale = deferred<WorkspaceNotificationState>()
    vi.mocked(workbenchApi.muteWorkspaceNotifications).mockImplementation(async () => stale.promise)
    vi.mocked(workbenchApi.getWorkspaceNotifications).mockImplementation(async (id: string) =>
      notif({ workspaceId: id, unreadCount: 1 }))
    const { wrapper } = await mountWith([ws('ws-team-1'), ws('ws-team-2')], 'ws-team-1')

    await wrapper.find('[data-testid="panel-activity-mute"]').trigger('click')
    holders.route.params.id = 'ws-team-2'
    await flushPromises()
    expect(wrapper.find('[data-testid="panel-activity-mute"]').text()).toContain('关闭提醒')

    stale.resolve(state({ workspaceId: 'ws-team-1', muted: true, mutedAt: '2026-09-10T08:00:00.000Z' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="panel-activity-mute"]').text()).toContain('关闭提醒')
  })

  it('连续重试时，先发出的旧响应不得覆盖后发出的新响应（乱序返回）', async () => {
    const older = deferred<WorkspaceActivityPage>()
    const newer = deferred<WorkspaceActivityPage>()
    let call = 0
    vi.mocked(workbenchApi.listWorkspaceActivity).mockImplementation(async (_id: string, input: { limit?: number } = {}) => {
      if (input.limit !== 3) return page('ws-team-1', [])
      call += 1
      if (call === 1) throw new Error('首次摘要失败')
      return call === 2 ? older.promise : newer.promise
    })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    expect(wrapper.find('[data-testid="panel-activity-error"]').exists()).toBe(true)

    // 错误态保留「重试」，连点两次即产生两个在途请求（第二次更新，先返回）。
    await wrapper.find('[data-testid="panel-activity-retry"]').trigger('click')
    await wrapper.find('[data-testid="panel-activity-retry"]').trigger('click')
    newer.resolve(page('ws-team-1', [item('NEW')]))
    await flushPromises()
    expect(panelRows(wrapper)).toContain('NEW')

    older.resolve(page('ws-team-1', [item('OLD')]))
    await flushPromises()
    expect(panelRows(wrapper)).toContain('NEW')
    expect(panelRows(wrapper)).not.toContain('OLD')
  })

  it('抽屉「重试」必须用空间 id 请求，不能把点击事件当 workspaceId（评审 P1-1）', async () => {
    const listActivity = vi.mocked(workbenchApi.listWorkspaceActivity)
    listActivity.mockImplementation(async (_id: string, input: { limit?: number } = {}) => {
      if (input.limit === 20) throw new Error('抽屉首页失败')
      return page('ws-team-1', [])
    })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    await wrapper.find('[data-testid="panel-activity-view-all"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-drawer-error"]').exists()).toBe(true)

    listActivity.mockImplementation(async (id: string) => page(id, [item('RECOVERED')]))
    await wrapper.find('[data-testid="activity-drawer-error"] button').trigger('click')
    await flushPromises()

    expect(listActivity).toHaveBeenLastCalledWith('ws-team-1', { limit: 20 })
    for (const call of listActivity.mock.calls) {
      expect(typeof call[0]).toBe('string')
      expect(String(call[0])).not.toContain('object')
      expect(String(call[0])).not.toContain('MouseEvent')
    }
    expect(wrapper.findAll('[data-testid="activity-drawer-row"]')).toHaveLength(1)
  })
})

describe('3-T8 挂载期请求去重（规格评审 F1）', () => {
  it('挂载时 refresh 用同 id 的新对象替换 store，不得重复请求摘要与提醒状态', async () => {
    // 真实路径：从空间列表进入详情时 store 已由壳层 load() 填充，本组件的 onMounted
    // 再 refresh 一次会换掉数组里的对象，immediate watcher 因此第二次触发。
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1', {
      refresh: (store) => {
        store.workspaces.splice(0, store.workspaces.length, ws('ws-team-1'))
      },
    })
    expect(wrapper.find('[data-testid="panel-activity-section"]').exists()).toBe(true)

    const summaryCalls = vi.mocked(workbenchApi.listWorkspaceActivity).mock.calls
      .filter(call => (call[1] as { limit?: number } | undefined)?.limit === 3)
    expect(summaryCalls).toHaveLength(1)
    expect(vi.mocked(workbenchApi.getWorkspaceNotifications).mock.calls).toHaveLength(1)
    expect(vi.mocked(workbenchApi.listWorkspaceAgentMembers).mock.calls).toHaveLength(1)
  })

  it('切到另一个空间时仍会加载新空间，且每个流只加载一次', async () => {
    const { wrapper } = await mountWith([ws('ws-team-1'), ws('ws-team-2')], 'ws-team-1')
    expect(wrapper.find('[data-testid="panel-activity-section"]').exists()).toBe(true)
    vi.mocked(workbenchApi.listWorkspaceActivity).mockClear()
    vi.mocked(workbenchApi.getWorkspaceNotifications).mockClear()

    holders.route.params.id = 'ws-team-2'
    await flushPromises()

    const summary = vi.mocked(workbenchApi.listWorkspaceActivity).mock.calls
      .filter(call => (call[1] as { limit?: number } | undefined)?.limit === 3)
    expect(summary.map(call => call[0])).toEqual(['ws-team-2'])
    expect(vi.mocked(workbenchApi.getWorkspaceNotifications).mock.calls.map(call => call[0])).toEqual(['ws-team-2'])
  })
})

describe('3-T8 越界响应与游标滥用', () => {
  it('抽屉首页 items 越界（undefined）时不得抛错，也不得掀翻整个详情页（评审 P2-1）', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue({
      workspaceId: 'ws-team-1',
      items: undefined as unknown as WorkspaceActivityItem[],
      nextCursor: null,
    })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    await wrapper.find('[data-testid="panel-activity-view-all"]').trigger('click')
    await flushPromises()

    expect(renderErrors).toEqual([])
    expect(wrapper.find('[data-testid="activity-drawer"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="activity-drawer-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(true)
  })

  it('摘要 items 越界（非数组）时不得抛错', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue({
      workspaceId: 'ws-team-1',
      items: 'nope' as unknown as WorkspaceActivityItem[],
      nextCursor: null,
    })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    expect(renderErrors).toEqual([])
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="panel-activity-empty"]').exists()).toBe(true)
  })

  it('服务端重复给出同一游标时不得重复渲染，并应视为到底（评审 P2-3）', async () => {
    const listActivity = vi.mocked(workbenchApi.listWorkspaceActivity)
    listActivity.mockImplementation(async (_id: string, input: { cursor?: string; limit?: number } = {}) => {
      if (input.limit === 3) return page('ws-team-1', [])
      if (!input.cursor) return page('ws-team-1', [item('a')], 'cursor-1')
      // 服务端（异常地）重复同一个游标并重复返回同一批条目。
      return page('ws-team-1', [item('a')], 'cursor-1')
    })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    await wrapper.find('[data-testid="panel-activity-view-all"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="activity-drawer-row"]')).toHaveLength(1)

    await wrapper.find('[data-testid="activity-drawer-load-more"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="activity-drawer-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="activity-drawer-load-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="activity-drawer-end"]').exists()).toBe(true)
  })

  it('空首页即使带游标也不进入「空列表 + 可加载更多」的死角（评审 P2-4）', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockImplementation(async (_id: string, input: { limit?: number } = {}) => {
      if (input.limit === 3) return page('ws-team-1', [])
      return page('ws-team-1', [], 'cursor-1')
    })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    await wrapper.find('[data-testid="panel-activity-view-all"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="activity-drawer-load-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="activity-drawer-end"]').exists()).toBe(false)
  })
})

describe('3-T8 通知状态失败与可访问性', () => {
  it('提醒状态加载失败时必须给错误与重试，不得伪装成「没有未读」（评审 P2-5）', async () => {
    vi.mocked(workbenchApi.getWorkspaceNotifications).mockRejectedValue(new Error('提醒状态失败'))
    vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue(page('ws-team-1', [item('一条动态')]))
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    const error = wrapper.find('[data-testid="panel-activity-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('提醒状态加载失败')
    expect(wrapper.find('[data-testid="panel-activity-retry"]').exists()).toBe(true)
    // 动态本身照常渲染，不被提醒状态失败连累。
    expect(wrapper.findAll('[data-testid="panel-activity-row"]')).toHaveLength(1)

    vi.mocked(workbenchApi.getWorkspaceNotifications).mockResolvedValue(notif({ unreadCount: 5 }))
    await wrapper.find('[data-testid="panel-activity-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="panel-activity-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-activity-unread"]').text()).toContain('5')
  })

  it('未读徽标是可播报状态，动态时间是机器可读的 <time datetime>（评审 P2-7/P2-8）', async () => {
    vi.mocked(workbenchApi.listWorkspaceActivity).mockResolvedValue(page('ws-team-1', [
      item('一条动态', { occurredAt: '2026-09-10T08:00:00.000Z' }),
    ]))
    vi.mocked(workbenchApi.getWorkspaceNotifications).mockResolvedValue(notif({ unreadCount: 3 }))
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    const badge = wrapper.find('[data-testid="panel-activity-unread"]')
    expect(badge.attributes('role')).toBe('status')
    const time = wrapper.find('[data-testid="panel-activity-row"] time')
    expect(time.attributes('datetime')).toBe('2026-09-10T08:00:00.000Z')
  })

  it('抽屉有可访问名称（评审 P2-6：with-header=false 会让 aria-labelledby 悬空）', async () => {
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    await wrapper.find('[data-testid="panel-activity-view-all"]').trigger('click')
    await flushPromises()
    // 抽屉内容被 teleport 到 body，`document.querySelector` 在此挂载方式下取不到；
    // 用 VTU 定位到内容节点后沿真实 DOM 向上找 role=dialog。
    const dialog = wrapper.find('[data-testid="activity-drawer"]').element.closest('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-label')).toBe('全部动态')
    // with-header=false 会让 Element Plus 自己写上悬空的 aria-labelledby，必须显式去掉。
    expect(dialog?.getAttribute('aria-labelledby')).toBeNull()
  })
})
