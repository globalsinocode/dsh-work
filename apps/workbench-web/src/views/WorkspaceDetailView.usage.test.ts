/**
 * 4-T2（TW-09 空间用量前端）宿主接线与角色门禁的判别性用例。
 *
 * 角色门禁与「零请求」是本任务的核心红线：普通成员／只读成员、角色未解析（名册失败）
 * 与个人空间都必须**不渲染且不发请求**（AC-23 / AC-30）。竞态用例需要**可响应式**地
 * 切换路由（`route.params.id`），因此本文件自带一份 reactive 的 vue-router mock
 * （`WorkspaceDetailView.test.ts` 用的是普通对象，切不了空间）。
 */
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { TeamMemberRole, Workspace, WorkspaceUsage, WorkspaceUsageDay } from '@/types/domain'
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

function day(overrides: Partial<WorkspaceUsageDay> = {}): WorkspaceUsageDay {
  return { day: '09-06', callCount: 2, successCount: 2, failedCount: 0, inputTokens: 1000, outputTokens: 500, ...overrides }
}

function usage(workspaceId: string, overrides: Partial<WorkspaceUsage> = {}): WorkspaceUsage {
  return {
    workspaceId,
    range: '7d',
    rangeDays: 7,
    totals: {
      callCount: 12,
      successCount: 10,
      failedCount: 2,
      estimatedCount: 3,
      inputTokens: 12345,
      outputTokens: 6789,
      totalTokens: 19134,
    },
    daily: [day()],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const mounted: Array<{ unmount: () => void }> = []

async function mountWith(workspaces: Workspace[], routeId?: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, ...workspaces)
  vi.spyOn(contentStore, 'refresh').mockResolvedValue(undefined)
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
    },
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, contentStore }
}

beforeEach(() => {
  holders.route.params.id = 'ws-team-1'
  holders.route.query = {}
  holders.router.push.mockReset()
  holders.router.replace.mockReset()
  vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
  vi.spyOn(workbenchApi, 'listWorkspaceMembers').mockResolvedValue({ items: [], currentUserRole: 'owner' })
  vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(workbenchApi, 'listWorkspaceActivity').mockResolvedValue({ workspaceId: 'ws-team-1', items: [], nextCursor: null })
  vi.spyOn(workbenchApi, 'getWorkspaceNotifications').mockResolvedValue({
    workspaceId: 'ws-team-1', items: [], nextCursor: null, muted: false, mutedAt: null, lastReadAt: null, unreadCount: 0,
  })
  vi.spyOn(workbenchApi, 'listWorkspaceUsage').mockResolvedValue(usage('ws-team-1'))
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) {
    try { wrapper.unmount() } catch { /* ignore */ }
  }
  document.body.innerHTML = ''
})

describe('4-T2 角色门禁：仅负责人／管理员渲染且零请求给其他角色（AC-30）', () => {
  it('负责人渲染摘要，且只请求一次（range=7d）', async () => {
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(1)
    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledWith('ws-team-1', { range: '7d' })
    const section = wrapper.find('[data-testid="panel-usage-section"]')
    expect(section.exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-usage-summary"]').text()).toBe('近 7 天 12 次调用 · 19134 tokens')
    expect(wrapper.find('[data-testid="panel-usage-estimated"]').text()).toBe('其中 3 次为估算值')
  })

  it('管理员同样渲染摘要并请求用量', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'admin' })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(true)
    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(1)
  })

  it('普通成员与只读成员不渲染且零请求', async () => {
    for (const role of ['member', 'viewer'] as TeamMemberRole[]) {
      vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: role })
      const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

      expect(workbenchApi.listWorkspaceUsage).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('空间用量')
      wrapper.unmount()
    }
  })

  it('角色未解析（服务端 currentUserRole 为 null）时不请求、不渲染', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: null })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    expect(workbenchApi.listWorkspaceUsage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(false)
  })

  it('名册请求失败（角色无法判定）时不请求、不渲染', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockRejectedValue(new Error('名册不可用'))
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    expect(workbenchApi.listWorkspaceUsage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(false)
  })

  it('名册失败且空间负责人姓名与登录者同名时同样不请求（不得回退到姓名推断，评审 P2/N3）', async () => {
    // 判别设计：`currentUserRole` computed 的姓名推断回退会在「负责人姓名 == 当前用户
    // 姓名」时判定为 owner。用量的角色来源必须只认服务端结论，否则同名成员会渲染区块
    // 并发一次注定 403 的请求。登录者姓名固定为「周航」（见 mountWith），因此这里让
    // 夹具的 owner 也是「周航」。
    vi.mocked(workbenchApi.listWorkspaceMembers).mockRejectedValue(new Error('名册不可用'))
    const { wrapper } = await mountWith([ws('ws-team-1', { owner: '周航', members: ['周航'] })], 'ws-team-1')

    expect(workbenchApi.listWorkspaceUsage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(false)
  })

  it('个人空间即使负责人本人也零请求、不渲染（AC-23）', async () => {
    const personal = ws('ws-personal', { type: 'personal', owner: '周航', members: ['周航'], memberCount: 1 })
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'owner' })
    const { wrapper } = await mountWith([personal], 'ws-personal')

    expect(workbenchApi.listWorkspaceUsage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('空间用量')
  })

  it('归档团队空间的负责人/管理员仍可查看用量（读取轨，口径 §1）', async () => {
    const archived = ws('ws-team-1', { status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z' })
    const { wrapper } = await mountWith([archived], 'ws-team-1')

    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-usage-summary"]').exists()).toBe(true)
  })
})

describe('4-T2 加载、失败与空数据', () => {
  it('全零数据渲染零值而不是错误态', async () => {
    vi.mocked(workbenchApi.listWorkspaceUsage).mockResolvedValue(usage('ws-team-1', {
      totals: { callCount: 0, successCount: 0, failedCount: 0, estimatedCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      daily: [],
    }))
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    expect(wrapper.find('[data-testid="panel-usage-summary"]').text()).toBe('近 7 天 0 次调用 · 0 tokens')
    expect(wrapper.find('[data-testid="panel-usage-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-usage-estimated"]').exists()).toBe(false)
  })

  it('加载失败就地显示错误与「重试」，重试真的重新请求且不渲染成零消耗', async () => {
    vi.mocked(workbenchApi.listWorkspaceUsage)
      .mockRejectedValueOnce(new Error('用量接口不可用'))
      .mockResolvedValueOnce(usage('ws-team-1'))
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    const error = wrapper.find('[data-testid="panel-usage-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('用量加载失败')
    expect(wrapper.find('[data-testid="panel-usage-summary"]').exists()).toBe(false)
    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(1)

    await wrapper.find('[data-testid="panel-usage-retry"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="panel-usage-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-usage-summary"]').text()).toContain('19134')
  })

  it('右栏其它区块不受用量失败影响，且动态照常加载', async () => {
    vi.mocked(workbenchApi.listWorkspaceUsage).mockRejectedValue(new Error('用量接口不可用'))
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')

    expect(wrapper.find('[data-testid="panel-usage-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-activity-section"]').exists()).toBe(true)
  })
})

describe('4-T2 世代号：晚到的旧响应不得写进当前空间（3-T8／3-T9 同一口径）', () => {
  it('切换空间后，旧空间的用量响应必须被丢弃', async () => {
    const stale = deferred<WorkspaceUsage>()
    vi.mocked(workbenchApi.listWorkspaceUsage).mockImplementation(async (id: string) => {
      if (id === 'ws-team-1') return stale.promise
      return usage(id, {
        totals: { callCount: 99, successCount: 99, failedCount: 0, estimatedCount: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
    })
    const { wrapper } = await mountWith([ws('ws-team-1'), ws('ws-team-2')], 'ws-team-1')
    // ws-team-1 的用量仍在途中，此时切到 ws-team-2。
    holders.route.params.id = 'ws-team-2'
    await flushPromises()
    expect(wrapper.find('[data-testid="panel-usage-summary"]').text()).toContain('99')

    stale.resolve(usage('ws-team-1', {
      totals: { callCount: 777, successCount: 0, failedCount: 0, estimatedCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }))
    await flushPromises()

    const summary = wrapper.find('[data-testid="panel-usage-summary"]')
    expect(summary.text()).toContain('99')
    expect(summary.text()).not.toContain('777')
    // 新空间恰好请求一次，旧响应不触发任何追加请求。
    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(2)
  })

  it('连续重试时，先发出的旧响应不得覆盖后发出的新响应（乱序返回）', async () => {
    const older = deferred<WorkspaceUsage>()
    const newer = deferred<WorkspaceUsage>()
    let call = 0
    vi.mocked(workbenchApi.listWorkspaceUsage).mockImplementation(async () => {
      call += 1
      if (call === 1) throw new Error('首次用量失败')
      return call === 2 ? older.promise : newer.promise
    })
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    expect(wrapper.find('[data-testid="panel-usage-error"]').exists()).toBe(true)

    await wrapper.find('[data-testid="panel-usage-retry"]').trigger('click')
    await wrapper.find('[data-testid="panel-usage-retry"]').trigger('click')
    newer.resolve(usage('ws-team-1', {
      totals: { callCount: 42, successCount: 1, failedCount: 0, estimatedCount: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }))
    await flushPromises()
    expect(wrapper.find('[data-testid="panel-usage-summary"]').text()).toContain('42')

    older.resolve(usage('ws-team-1', {
      totals: { callCount: 7, successCount: 1, failedCount: 0, estimatedCount: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }))
    await flushPromises()
    expect(wrapper.find('[data-testid="panel-usage-summary"]').text()).toContain('42')
  })
})

describe('4-T2 详情弹窗入口与焦点恢复（design §2.10 / §4）', () => {
  it('点击「查看详情」打开弹窗并按 7d 请求明细，关闭后焦点回到触发按钮', async () => {
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    document.body.appendChild(wrapper.element)

    const trigger = wrapper.find('[data-testid="panel-usage-view-detail"]')
    ;(trigger.element as HTMLElement).focus()
    expect(document.activeElement).toBe(trigger.element)

    await trigger.trigger('click')
    await flushPromises()

    // 打开详情会额外请求一次（弹窗自身的 7d 明细）；摘要仍是 1 次。
    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(2)
    const dialog = wrapper.find('[data-testid="usage-dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('调用次数')

    await wrapper.find('[data-testid="usage-close"]').trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('弹窗的可访问名称包含「空间用量」', async () => {
    const { wrapper } = await mountWith([ws('ws-team-1')], 'ws-team-1')
    await wrapper.find('[data-testid="panel-usage-view-detail"]').trigger('click')
    await flushPromises()

    // 团队分支同时挂着成员/设置/用量三个 el-dialog，必须沿用量弹窗自己的 DOM 向上找，
    // 否则会误取到第一个成员弹窗（3-T9 同一坑）。
    const dialog = wrapper.find('[data-testid="usage-dialog"]').element.closest('[role="dialog"]')
    expect(dialog).not.toBeNull()
    const labelledby = dialog?.getAttribute('aria-labelledby')
    expect(labelledby).toBeTruthy()
    expect(dialog?.querySelector(`[id="${labelledby}"]`)?.textContent).toContain('空间用量')
  })
})
