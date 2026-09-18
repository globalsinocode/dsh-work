import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { WorkspaceSessionPage, WorkspaceSessionSummary } from '@/types/domain'
import WorkspaceSessionHistory from './WorkspaceSessionHistory.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('vue-router', () => ({ useRouter: () => router }))

function session(overrides: Partial<WorkspaceSessionSummary> = {}): WorkspaceSessionSummary {
  return {
    sessionId: 'session-1',
    title: '季度复盘',
    creatorId: 'u-other',
    creatorName: '林岚',
    lastActiveAt: '2026-09-10T08:00:00.000Z',
    runCount: 3,
    latestRun: { id: 'run-1', status: 'succeeded' },
    ...overrides,
  }
}

function page(items: WorkspaceSessionSummary[], nextCursor: string | null = null): WorkspaceSessionPage {
  return { items, nextCursor }
}

/** 服务端固定返回本人历史（无 scope 参数），因此 mock 只按调用顺序给分页。 */
function mockSessionPages(handler: () => WorkspaceSessionPage) {
  vi.mocked(workbenchApi.listWorkspaceSessions).mockImplementation(async () => handler())
}

function mountHistory(options: {
  props?: Record<string, unknown>
} = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(WorkspaceSessionHistory, {
    props: {
      workspaceId: 'ws-team',
      workspaceName: '供应链团队',
      ...options.props,
    },
    global: { plugins: [pinia, ElementPlus] },
  })
  return wrapper
}

describe('WorkspaceSessionHistory 团队历史对话视图', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue(page([]))
  })

  it('loads the first page and renders one row per Session', async () => {
    mockSessionPages(() => page([
      session({ sessionId: 's-1', title: '季度复盘', latestRun: { id: 'run-1', status: 'running' } }),
      session({ sessionId: 's-2', title: '库存异常排查', creatorId: 'u-current', creatorName: '周航', latestRun: { id: 'run-2', status: 'succeeded' } }),
    ]))
    const wrapper = mountHistory()
    await flushPromises()

    // 列表固定返回本人历史（1A 收权口径，2A 放弃后不再有 scope 维度）。
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })
    const rows = wrapper.findAll('[data-testid="session-history-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('季度复盘')
    expect(rows[0]?.text()).toContain('林岚')
    expect(rows[1]?.text()).toContain('库存异常排查')
    expect(rows[1]?.text()).toContain('周航')

    // 状态点沿用侧栏五色点语义并带 aria-label（design §4）。
    const dots = wrapper.findAll('[data-testid="session-history-dot"]')
    expect(dots[0]?.classes()).toContain('session-history-row__dot--running')
    expect(dots[0]?.attributes('aria-label')).toBe('运行中')
    expect(dots[1]?.classes()).toContain('session-history-row__dot--succeeded')
    expect(dots[1]?.attributes('aria-label')).toBe('已完成')

    // 最新运行状态用 StatusTag 呈现。
    expect(rows[0]?.find('.status-tag').text()).toBe('执行中')
    expect(rows[1]?.find('.status-tag').text()).toBe('已完成')
  })

  it('navigates to the latest Run of the row on click', async () => {
    mockSessionPages(() => page([session({ latestRun: { id: 'run/9', status: 'failed' } })]))
    const wrapper = mountHistory()
    await flushPromises()

    await wrapper.find('[data-testid="session-history-row"]').trigger('click')
    // 服务端兼容 Run ID 链接并解析回 Session。
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/conversations/run/9')
  })

  it('falls back to the Session identity when a session has no Run yet', async () => {
    mockSessionPages(() => page([session({ sessionId: 'session-empty', latestRun: null })]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.find('[data-testid="session-history-row"] .status-tag').text()).toBe('暂无运行')
    await wrapper.find('[data-testid="session-history-row"]').trigger('click')
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/conversations/session-empty')
  })

  it('appends the next cursor page and shows the end marker once exhausted', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions)
      .mockResolvedValueOnce(page([session({ sessionId: 's-1' })], 'cursor-1'))
      .mockResolvedValueOnce(page([session({ sessionId: 's-2', title: '库存异常排查' })]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="session-history-end"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="session-history-page-info"]').text()).toContain('还有更多')

    await wrapper.find('[data-testid="session-history-load-more"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { cursor: 'cursor-1', limit: 20 })
    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="session-history-load-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="session-history-end"]').text()).toBe('已加载全部')
  })

  it('searches by title through the server and clears the filter back to the first page', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions)
      .mockResolvedValueOnce(page([session({ sessionId: 's-1' })]))
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([session({ sessionId: 's-1' })]))
    const wrapper = mountHistory()
    await flushPromises()

    const input = wrapper.find('.session-history__search input')
    await input.setValue('巡检')
    await input.trigger('keyup.enter')
    await flushPromises()

    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { query: '巡检', limit: 20 })
    const empty = wrapper.find('[data-testid="session-history-empty-filter"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('没有找到标题包含“巡检”的对话')

    await empty.find('button').trigger('click')
    await flushPromises()
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { limit: 20 })
    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(1)
  })

  it('shows the caller empty history with a start-new entry when startable', async () => {
    mockSessionPages(() => page([]))
    const wrapper = mountHistory({ props: { canStartConversation: true } })
    await flushPromises()

    const empty = wrapper.find('[data-testid="session-history-empty-own"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('本工作空间还没有对话')
    await empty.find('button').trigger('click')
    expect(wrapper.emitted('start-new')).toHaveLength(1)
  })

  it('tells non-startable members to ask the owner instead of offering a start entry', async () => {
    mockSessionPages(() => page([]))
    const wrapper = mountHistory({ props: { canStartConversation: false } })
    await flushPromises()

    const empty = wrapper.find('[data-testid="session-history-empty-own"]')
    expect(empty.text()).toContain('当前角色不能发起对话')
    expect(empty.find('button').exists()).toBe(false)
  })

  it('does not distinguish a space-level empty state any more (2A dropped)', async () => {
    mockSessionPages(() => page([]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.find('[data-testid="session-history-empty-workspace"]').exists()).toBe(false)
  })

  it('renders neither a 团队共享 filter nor a creator filter (2A dropped)', async () => {
    mockSessionPages(() => page([session()]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.text()).not.toContain('团队共享')
    expect(wrapper.text()).not.toContain('我的对话')
    expect(wrapper.find('.session-history__toolbar select').exists()).toBe(false)
  })

  it('silently reloads the list when the workspace session stream reports new activity', async () => {
    class FakeSessionStream {
      static instances: FakeSessionStream[] = []
      readonly listeners = new Map<string, (event: MessageEvent<string>) => void>()
      closed = false
      constructor(readonly url: string) { FakeSessionStream.instances.push(this) }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.listeners.set(type, listener as (event: MessageEvent<string>) => void)
      }
      close() { this.closed = true }
      emit(type: string, payload: unknown) {
        this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
      }
    }
    vi.stubGlobal('EventSource', FakeSessionStream)
    vi.mocked(workbenchApi.listWorkspaceSessions)
      .mockResolvedValueOnce(page([session({ sessionId: 's-1' })]))
      .mockResolvedValueOnce(page([
        session({ sessionId: 's-2', title: '新发起的讨论' }),
        session({ sessionId: 's-1' }),
      ]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(1)
    expect(FakeSessionStream.instances[0]?.url).toContain('/workspaces/ws-team/session-events')

    // 其他成员发消息/新建会话 → 服务端推 session.updated → 列表防抖后静默重取。
    FakeSessionStream.instances[0]?.emit('session.updated', {
      session_id: 's-2',
      activity_at: '2026-09-12T08:01:00.000Z',
    })
    await new Promise(resolve => setTimeout(resolve, 400))
    await flushPromises()

    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledTimes(2)
    const rows = wrapper.findAll('[data-testid="session-history-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('新发起的讨论')
    vi.unstubAllGlobals()
  })

  it('keeps a short time beside the full time so ≤520px can drop to the short format', async () => {
    mockSessionPages(() => page([session({ lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.find('[data-testid="session-history-time"]').text().length).toBeGreaterThan(0)
    const short = wrapper.find('.session-history-row__time-short')
    expect(short.exists()).toBe(true)
    expect(short.text()).toMatch(/^(\d{2}:\d{2}|\d{2}-\d{2}|\d{4}-\d{2}-\d{2})$/)
    // 发起人字段保留在行内，由 ≤520px 的样式隐藏（design §2.2）。
    expect(wrapper.find('[data-testid="session-history-creator"]').exists()).toBe(true)
  })
})
