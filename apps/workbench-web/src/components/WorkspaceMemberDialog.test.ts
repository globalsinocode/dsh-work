import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { ElOption, ElSelect } from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { WorkspaceMember } from '@/types/domain'
import WorkspaceMemberDialog from './WorkspaceMemberDialog.vue'

const employees: WorkspaceMember[] = [
  { userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z', department: '供应链中心' },
  { userId: 'u-owner-2', displayName: '郑野', role: 'owner', joinedAt: '2026-09-01T06:00:00.000Z', department: '供应链中心' },
  { userId: 'u-admin', displayName: '周航', role: 'admin', joinedAt: '2026-09-02T00:00:00.000Z', department: '计划部' },
  { userId: 'u-member', displayName: '陈默', role: 'member', joinedAt: '2026-09-03T00:00:00.000Z', department: '计划部' },
  { userId: 'u-viewer', displayName: '苏晚', role: 'viewer', joinedAt: '2026-09-04T00:00:00.000Z', department: '未分配部门' },
]

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(WorkspaceMemberDialog, {
    props: {
      open: true,
      workspaceId: 'ws-team',
      workspaceName: '供应链团队',
      currentUserRole: 'owner',
      members: employees,
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

/** el-dialog teleports by default; the component opts out so the panel is queryable. */
function panelOf(wrapper: ReturnType<typeof mountDialog>) {
  return wrapper.find('.member-dialog__body')
}

describe('WorkspaceMemberDialog', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'listMemberCandidates').mockResolvedValue({ items: [], nextCursor: null })
  })

  it('renders the employee segment with a close footer', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(wrapper.text()).toContain('管理成员')
    expect(panel.find('[data-testid="member-section-employee"]').exists()).toBe(true)
    // Agent 治理已独立到「管理 Agent」弹窗：此处不再渲染 Agent 区块。
    expect(panel.find('[data-testid="member-section-agent"]').exists()).toBe(false)
    expect(panel.findAll('[data-testid="member-role-select"]')).toHaveLength(5)

    const close = panel.find('[data-testid="member-dialog-close"]')
    expect(close.exists()).toBe(true)
    await close.trigger('click')
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('never renders an "可用能力" entry (plan 3.2 / AC-18)', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.text()).not.toContain('可用能力')
  })

  it('excludes already joined employees from the add-employee search results', async () => {
    vi.mocked(workbenchApi.listMemberCandidates).mockResolvedValue({
      items: [
        { id: 'u-member', displayName: '陈默', department: '计划部' },
        { id: 'u-new', displayName: '何雨', department: '采购部' },
      ],
      nextCursor: null,
    })
    const wrapper = mountDialog()
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-add-employee"]').trigger('click')
    await panelOf(wrapper).find('[data-testid="member-candidate-search"]').setValue('何')
    // 搜索输入有 300ms 防抖：条件等待请求真正发出，替代固定 350ms sleep，减少时序依赖。
    await vi.waitFor(
      () => expect(workbenchApi.listMemberCandidates).toHaveBeenCalledWith('ws-team', { query: '何', limit: 10 }),
      { timeout: 5_000 },
    )
    await flushPromises()

    expect(workbenchApi.listMemberCandidates).toHaveBeenCalledWith('ws-team', { query: '何', limit: 10 })
    const results = panelOf(wrapper).findAll('[data-testid="member-candidate-row"]')
    expect(results.map(row => row.find('.member-dialog__copy').text())).toEqual(['何雨采购部'])
  })

  it('adds a searched employee with the selected role (server-side paging respected)', async () => {
    vi.mocked(workbenchApi.listMemberCandidates).mockResolvedValue({
      items: [{ id: 'u-new', displayName: '何雨', department: '采购部' }],
      nextCursor: null,
    })
    const addMember = vi.spyOn(workbenchApi, 'addWorkspaceMember').mockResolvedValue({
      userId: 'u-new',
      displayName: '何雨',
      role: 'member',
      joinedAt: '2026-09-10T00:00:00.000Z',
    })
    const wrapper = mountDialog()
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-add-employee"]').trigger('click')
    await panelOf(wrapper).find('[data-testid="member-candidate-search"]').setValue('何')
    // 搜索输入有 300ms 防抖：条件等待请求真正发出，替代固定 350ms sleep，减少时序依赖。
    await vi.waitFor(
      () => expect(workbenchApi.listMemberCandidates).toHaveBeenCalledWith('ws-team', { query: '何', limit: 10 }),
      { timeout: 5_000 },
    )
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-candidate-row"] button').trigger('click')
    await flushPromises()

    expect(addMember).toHaveBeenCalledWith('ws-team', { userId: 'u-new', role: 'member' })
    expect(wrapper.emitted('refresh')).toBeTruthy()
  })

  it('keeps a trailing cursor to load more employee candidates', async () => {
    vi.mocked(workbenchApi.listMemberCandidates)
      .mockResolvedValueOnce({
        items: [{ id: 'u-a', displayName: '何雨', department: '采购部' }],
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'u-b', displayName: '何晴', department: '财务部' }],
        nextCursor: null,
      })
    const wrapper = mountDialog()
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-add-employee"]').trigger('click')
    await flushPromises()

    const loadMore = panelOf(wrapper).find('[data-testid="member-candidate-more"]')
    expect(loadMore.exists()).toBe(true)
    await loadMore.trigger('click')
    await flushPromises()

    expect(workbenchApi.listMemberCandidates).toHaveBeenLastCalledWith('ws-team', { cursor: 'cursor-1', limit: 10 })
    const names = panelOf(wrapper)
      .findAll('[data-testid="member-candidate-row"]')
      .map(row => row.find('.member-dialog__copy').text())
    expect(names).toEqual(['何雨采购部', '何晴财务部'])
  })

  it('lets the owner change any role and remove any member', async () => {
    const changeRole = vi.spyOn(workbenchApi, 'updateMemberRole').mockResolvedValue({
      userId: 'u-member',
      displayName: '陈默',
      role: 'admin',
      joinedAt: '2026-09-03T00:00:00.000Z',
    })
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    const memberSelect = panelOf(wrapper).findAllComponents(ElSelect)[3]
    const options = memberSelect.findAllComponents(ElOption)
    expect(options.map((option: { props: (name: string) => unknown }) => option.props('value')))
      .toEqual(['owner', 'admin', 'member', 'viewer'])
    memberSelect.vm.$emit('change', 'admin')
    await flushPromises()
    expect(changeRole).toHaveBeenCalledWith('ws-team', 'u-member', { role: 'admin' })
  })

  it('restricts an admin to member/viewer roles and disables self and other admins', async () => {
    const wrapper = mountDialog({ currentUserRole: 'admin' })
    await flushPromises()
    const selects = panelOf(wrapper).findAllComponents(ElSelect)

    // 两位负责人：管理员不能任免负责人。
    expect(selects[0].props('disabled')).toBe(true)
    expect(selects[1].props('disabled')).toBe(true)
    // 自己所在行。
    expect(selects[2].props('disabled')).toBe(true)
    // 成员/只读成员行：只有「成员/只读成员」可选项，负责人与管理员被禁用。
    expect(selects[3].props('disabled')).toBe(false)
    expect(selects[4].props('disabled')).toBe(false)
    expect(selects[3].findAllComponents(ElOption)
      .filter((option: { props: (name: string) => unknown }) => option.props('disabled') === false)
      .map((option: { props: (name: string) => unknown }) => option.props('value'))).toEqual(['member', 'viewer'])
    // 只能移除「成员/只读成员」：负责人（行 0/1）与自己（行 2）都没有移除入口。
    expect(panelOf(wrapper).findAll('[data-testid="member-remove"]')).toHaveLength(2)
  })

  it('renders a bare read-only employee list for plain members', async () => {
    const wrapper = mountDialog({ currentUserRole: 'member' })
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(panel.findAll('[data-testid="member-role-select"]')).toHaveLength(0)
    expect(panel.findAll('[data-testid="member-remove"]')).toHaveLength(0)
    expect(panel.find('[data-testid="member-add-employee"]').exists()).toBe(false)
    expect(panel.find('[data-testid="member-role-readonly"]').exists()).toBe(true)
  })

  it('marks the only owner as unique and blocks role change and removal', async () => {
    const wrapper = mountDialog({ members: [employees[0]!], currentUserRole: 'owner' })
    await flushPromises()
    const panel = panelOf(wrapper)

    // 最后负责人不渲染角色下拉，也不渲染移除；显示「负责人（唯一）」。
    expect(panel.findAllComponents(ElSelect)).toHaveLength(0)
    expect(panel.find('[data-testid="member-role-unique"]').text()).toContain('负责人（唯一）')
    expect(panel.find('[data-testid="member-remove"]').exists()).toBe(false)
  })

  it('confirms removal before calling the API', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const remove = vi.spyOn(workbenchApi, 'removeWorkspaceMember').mockResolvedValue({ userId: 'u-viewer', removed: true })
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    await panelOf(wrapper).findAll('[data-testid="member-remove"]')[4].trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('ws-team', 'u-viewer')
    expect(wrapper.emitted('refresh')).toBeTruthy()
  })

  it('does not call the API when removal is cancelled', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(new Error('cancel'))
    const remove = vi.spyOn(workbenchApi, 'removeWorkspaceMember')
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    await panelOf(wrapper).findAll('[data-testid="member-remove"]')[4].trigger('click')
    await flushPromises()

    expect(remove).not.toHaveBeenCalled()
  })

  it('renders each employee row as 姓名 · 部门（5-T2）', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const rows = panelOf(wrapper).findAll('[data-testid="member-row"]')
    expect(rows).toHaveLength(5)
    expect(rows[0]?.find('.member-dialog__copy').text()).toContain('林岚')
    expect(rows[0]?.find('.member-dialog__copy').text()).toContain('供应链中心')
    expect(rows[3]?.find('.member-dialog__copy').text()).toContain('计划部')
    // 缺省部门由服务端口径补齐后照常渲染。
    expect(rows[4]?.find('.member-dialog__copy').text()).toContain('未分配部门')
  })

  it('renders the employee empty state', async () => {
    const wrapper = mountDialog({ members: [] })
    await flushPromises()
    expect(panelOf(wrapper).text()).toContain('尚未添加员工')
  })

  it('以归档态打开时隐藏成员写入口，但保留紧急撤权', async () => {
    // design §2.7/§3 + 3-T1 执行轨：归档空间的成员变更会被服务端 403，
    // 渲染出来只会让用户走进死路；但移除成员（紧急收权）必须仍可用。
    const wrapper = mountDialog({ archived: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="member-add-employee"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="member-role-select"]').exists()).toBe(false)
    // 治理例外：撤权入口保留。
    expect(wrapper.findAll('[data-testid="member-remove"]').length).toBeGreaterThan(0)
  })

  it('非归档（默认）仍渲染写入口，避免把归档门禁误加到正常空间', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.find('[data-testid="member-add-employee"]').exists()).toBe(true)
  })
})
