import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { Workspace } from '@/types/domain'
import WorkspacesView from './WorkspacesView.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const route = vi.hoisted(() => ({ query: {} as Record<string, unknown> }))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => route }))

function ws(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-personal',
    name: '我的空间',
    description: '个人上下文。',
    type: 'personal',
    memberCount: 1,
    sessionCount: 0,
    artifactCount: 0,
    updatedAt: '2026-09-10T00:00:00.000Z',
    owner: '周航',
    members: ['周航'],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

const personal = ws()
const activeTeam = ws({
  id: 'ws-active',
  name: '供应链团队',
  description: '活动团队空间。',
  type: 'team',
  owner: '林岚',
  members: ['林岚', '周航'],
  status: 'active',
})
const archivedTeam = ws({
  id: 'ws-archived',
  name: '九月复盘',
  description: '已归档团队空间。',
  type: 'team',
  owner: '林岚',
  members: ['林岚', '周航'],
  status: 'archived',
  archivedAt: '2026-09-11T00:00:00.000Z',
})

async function mountView(
  seed: Workspace[] = [personal, activeTeam, archivedTeam],
  options: { query?: Record<string, unknown> } = {},
) {
  route.query = options.query ?? {}
  const pinia = createPinia()
  setActivePinia(pinia)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, ...seed)
  // onMounted 会 refresh；测试固定注入的空间对象，避免覆盖为 mock 返回值。
  vi.spyOn(contentStore, 'refresh').mockResolvedValue(undefined)
  const wrapper = mount(WorkspacesView, { global: { plugins: [pinia, ElementPlus] } })
  await flushPromises()
  return { wrapper, contentStore }
}

describe('WorkspacesView 归档筛选与归档卡片（design §2.1 / §6）', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'getWorkspaces').mockResolvedValue([])
  })

  it('defaults to 全部 and renders every accessible workspace from the server list', async () => {
    const { wrapper } = await mountView()

    expect(wrapper.find('[data-testid="workspace-filter-all"]').classes()).toContain('is-active')
    expect(wrapper.find('[data-testid="workspace-filter-active"]').classes()).not.toContain('is-active')
    expect(wrapper.find('[data-testid="workspace-filter-archived"]').classes()).not.toContain('is-active')
    expect(wrapper.text()).toContain('2 个可访问工作空间')
    // 默认「全部」复用已加载的服务端列表，不额外发筛选请求（服务端默认 all）。
    expect(workbenchApi.getWorkspaces).not.toHaveBeenCalled()
  })

  it('shows 已归档 on archived cards and keeps them clickable into the detail', async () => {
    const { wrapper } = await mountView()

    const tag = wrapper.find('[data-testid="workspace-card-archived-tag"]')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe('已归档')
    // 归档卡片仍可点击进入只读详情。
    const cards = wrapper.findAll('button.workspace-card')
    const archivedCard = cards.find(card => card.text().includes('九月复盘'))
    expect(archivedCard).toBeTruthy()
    await archivedCard?.trigger('click')
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-archived')
  })

  it('switching to 已归档 requests ?status=archived, writes the route query and only shows archived team spaces', async () => {
    vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([archivedTeam])
    const { wrapper } = await mountView()

    await wrapper.find('[data-testid="workspace-filter-archived"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.getWorkspaces).toHaveBeenCalledWith('archived')
    expect(router.replace).toHaveBeenCalledWith({ query: { status: 'archived' } })
    expect(wrapper.find('[data-testid="workspace-filter-archived"]').classes()).toContain('is-active')
    expect(wrapper.text()).toContain('1 个可访问工作空间')
    // 服务端在 archived 下不会返回个人空间（AC-23：个人空间不显示归档筛选效果）。
    expect(wrapper.text()).not.toContain('我的空间')
    expect(wrapper.find('[data-testid="workspace-card-archived-tag"]').exists()).toBe(true)
  })

  it('switching to 活动 requests ?status=active but hides the implicit personal workspace', async () => {
    vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([personal, activeTeam])
    const { wrapper } = await mountView()

    await wrapper.find('[data-testid="workspace-filter-active"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.getWorkspaces).toHaveBeenCalledWith('active')
    expect(router.replace).toHaveBeenCalledWith({ query: { status: 'active' } })
    expect(wrapper.text()).not.toContain('我的空间')
    expect(wrapper.text()).not.toContain('九月复盘')
  })

  it('restores the 已归档 filter from a deep link and reloads that server filter', async () => {
    vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([archivedTeam])
    const { wrapper } = await mountView(undefined, { query: { status: 'archived' } })

    expect(workbenchApi.getWorkspaces).toHaveBeenCalledWith('archived')
    expect(wrapper.find('[data-testid="workspace-filter-archived"]').classes()).toContain('is-active')
    expect(wrapper.text()).toContain('九月复盘')
  })

  it('returns to 全部 by clearing the route query', async () => {
    const { wrapper } = await mountView()

    await wrapper.find('[data-testid="workspace-filter-archived"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="workspace-filter-all"]').trigger('click')
    await flushPromises()

    expect(router.replace).toHaveBeenLastCalledWith({ query: {} })
    expect(wrapper.text()).toContain('2 个可访问工作空间')
  })

  it('shows the dedicated archived empty state when no team space is archived', async () => {
    vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([])
    const { wrapper } = await mountView()

    await wrapper.find('[data-testid="workspace-filter-archived"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('暂无已归档的团队空间')
  })

  it('supports keyboard navigation across the archive filter (roving tabindex needs arrow keys)', async () => {
    const { wrapper } = await mountView([])
    await flushPromises()

    const all = wrapper.find('[data-testid="workspace-filter-all"]')
    const active = wrapper.find('[data-testid="workspace-filter-active"]')
    const archived = wrapper.find('[data-testid="workspace-filter-archived"]')

    // roving tabindex：只有选中项可 Tab 进入。
    expect(all.attributes('tabindex')).toBe('0')
    expect(active.attributes('tabindex')).toBe('-1')
    expect(archived.attributes('tabindex')).toBe('-1')

    // 方向键必须能切到非选中项，否则键盘用户无法使用该筛选。
    await all.trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(router.replace).toHaveBeenCalledWith({ query: { status: 'active' } })

    await wrapper.find('[data-testid="workspace-filter-active"]').trigger('keydown', { key: 'End' })
    await flushPromises()
    expect(router.replace).toHaveBeenLastCalledWith({ query: { status: 'archived' } })

    await wrapper.find('[data-testid="workspace-filter-archived"]').trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    // 循环回到第一个（全部），且清掉 query。
    expect(router.replace).toHaveBeenLastCalledWith({ query: {} })
  })

  it('never renders a personal space under the 已归档 filter (server is not trusted blindly)', async () => {
    // 纵深防御（design §2.1）：归档筛选只响应团队空间。若服务端意外返回个人空间，
    // 前端不得把它渲染成「已归档」条目。
    vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([
      ws(),
      ws({ id: 'ws-archived', name: '已归档团队', type: 'team', status: 'archived', archivedAt: '2026-09-01T00:00:00.000Z' }),
    ])
    const { wrapper } = await mountView([])
    await flushPromises()
    router.replace.mockClear()

    await wrapper.find('[data-testid="workspace-filter-archived"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.getWorkspaces).toHaveBeenLastCalledWith('archived')
    expect(wrapper.text()).toContain('已归档团队')
    expect(wrapper.text()).not.toContain('我的空间')
    expect(wrapper.text()).toContain('1 个可访问工作空间')
  })

  it('clears the previous filter results and offers a retry when a filter request fails', async () => {
    // 失败时必须清空上一个筛选的卡片并给出重试入口；否则新页签下会继续显示旧数据，
    // 用户既看不出失败也无法在原页签重试（质量评审 F4）。
    const { wrapper } = await mountView([archivedTeam])
    await flushPromises()
    router.replace.mockClear()

    vi.mocked(workbenchApi.getWorkspaces).mockResolvedValueOnce([archivedTeam])
    await wrapper.find('[data-testid="workspace-filter-archived"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('九月复盘')

    vi.mocked(workbenchApi.getWorkspaces).mockRejectedValueOnce(new Error('网络不可用'))
    await wrapper.find('[data-testid="workspace-filter-active"]').trigger('click')
    await flushPromises()

    // 陈旧的归档卡片必须消失，并出现错误态与重试按钮。
    expect(wrapper.text()).not.toContain('九月复盘')
    expect(wrapper.find('[data-testid="workspace-filter-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('网络不可用')

    // 重试必须真的再发一次请求（失败不写入去重记账）。
    vi.mocked(workbenchApi.getWorkspaces).mockResolvedValueOnce([activeTeam])
    await wrapper.find('[data-testid="workspace-filter-error"] button').trigger('click')
    await flushPromises()
    expect(workbenchApi.getWorkspaces).toHaveBeenLastCalledWith('active')
    expect(wrapper.text()).toContain('供应链团队')
    expect(wrapper.find('[data-testid="workspace-filter-error"]').exists()).toBe(false)
  })
})
