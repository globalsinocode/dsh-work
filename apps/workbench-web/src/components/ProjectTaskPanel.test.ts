import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkbenchApiError, workbenchApi } from '@/api/client'
import type { ProjectTask, ProjectTaskPage, WorkspaceAgentMember, WorkspaceMember } from '@/types/domain'
import ProjectTaskPanel from './ProjectTaskPanel.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const route = vi.hoisted(() => ({ name: 'workspace-detail' as string, params: {} as Record<string, string> }))
vi.mock('vue-router', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    useRouter: () => router,
    useRoute: () => route,
    RouterLink: defineComponent({
      props: { to: { type: [String, Object], required: true } },
      setup(props, { slots, attrs }) {
        return () => h('a', { ...attrs, href: String(props.to) }, slots.default?.())
      },
    }),
    RouterView: defineComponent({
      setup() {
        return () => h('div', { 'data-testid': 'router-view-stub' })
      },
    }),
  }
})

const members: WorkspaceMember[] = [
  { userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' },
  { userId: 'u-viewer', displayName: '苏晚', role: 'viewer', joinedAt: '2026-09-02T00:00:00.000Z' },
]
const agents: WorkspaceAgentMember[] = [{
  id: 'wam-1', agentId: 'agent-1', name: '缺货分析助手', description: '', status: 'available',
  version: 'v1', addedBy: '林岚', createdAt: '2026-09-05T00:00:00.000Z', allowedActions: ['start_conversation'],
}]

function task(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: 'ptask-1',
    title: '分析缺货原因',
    description: '列出前三个原因',
    createdBy: { userId: 'u-owner', displayName: '林岚' },
    assignee: { type: 'agent', agentMemberId: 'wam-1', name: '缺货分析助手' },
    status: 'todo',
    sessionId: null,
    latestRunId: null,
    latestRunStatus: null,
    latestRunAt: null,
    schedule: { kind: 'daily', timezone: 'Asia/Shanghai', timeOfDay: '09:00' },
    scheduleState: 'active',
    scheduleReason: null,
    nextRunAt: null,
    inputFiles: [],
    deliverableFiles: [],
    completionNote: null,
    completedAt: null,
    dueDate: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    allowedActions: ['edit', 'remove', 'start'],
    ...overrides,
  }
}

function page(items: ProjectTask[], nextCursor: string | null = null): ProjectTaskPage {
  return { items, nextCursor, total: items.length }
}

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ProjectTaskPanel, {
    props: {
      workspaceId: 'ws-team',
      workspaceName: '供应链项目',
      canWrite: true,
      members,
      agentMembers: agents,
      files: [],
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('ProjectTaskPanel（项目空间 S1）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    router.push.mockReset()
    router.replace.mockReset()
    route.name = 'workspace-detail'
    route.params = {}
    vi.spyOn(workbenchApi, 'listProjectTaskEvents').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listProjectTasks').mockResolvedValue(page([]))
  })

  it('shows an empty state with a create entry for writers and reports the count', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.text()).toContain('还没有任务')
    expect(wrapper.find('[data-testid="project-task-create"]').exists()).toBe(true)
    expect(wrapper.emitted('count')?.at(-1)).toEqual([0])
  })

  it('hides every write entry for read-only members', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task({ allowedActions: [] })]))
    const wrapper = mountPanel({ canWrite: false })
    await flushPromises()
    expect(wrapper.find('[data-testid="project-task-create"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="project-task-row"] button')).toHaveLength(0)
  })

  it('hides task write actions as soon as the space becomes read-only and reloads the list', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task()]))
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.findAll('[data-testid="project-task-row"] button').map(button => button.text())).toEqual(
      expect.arrayContaining(['编辑', '移除']),
    )

    // 归档后服务端不再给写动作；重新拉取前写入口也不能留在页面上。
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task({ allowedActions: [] })]))
    await wrapper.setProps({ canWrite: false })
    expect(wrapper.findAll('[data-testid="project-task-row"] button')).toHaveLength(0)
    await flushPromises()
    expect(workbenchApi.listProjectTasks).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-testid="project-task-row"] button')).toHaveLength(0)
  })

  it('lists tasks with status labels, assignee and the S4 execution column', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([
      task({ id: 't1', status: 'in_progress', sessionId: 's1', latestRunId: 'r1', latestRunStatus: 'succeeded', latestRunAt: '2026-09-10T01:00:00.000Z', allowedActions: [] }),
      task({
        id: 't2', status: 'in_progress', sessionId: 's2', latestRunId: 'r2', latestRunStatus: 'failed',
        schedule: { kind: 'weekly', timezone: 'Asia/Shanghai', timeOfDay: '09:00', weekdays: [1] },
        scheduleState: 'paused', scheduleReason: 'consecutive_failures', allowedActions: [],
      }),
      task({
        id: 't3', title: '整理供应商名单', status: 'done', completionNote: '已分组',
        assignee: { type: 'employee', userId: 'u-owner', displayName: '林岚' }, schedule: null, scheduleState: null, allowedActions: [],
      }),
    ]))
    const wrapper = mountPanel()
    await flushPromises()
    const statuses = wrapper.findAll('[data-testid="project-task-status"]').map(node => node.text())
    expect(statuses).toEqual(['进行中', '进行中', '已完成'])
    const schedules = wrapper.findAll('[data-testid="project-task-schedule-cell"]').map(node => node.text().replace(/\s+/g, ' '))
    expect(schedules[0]).toContain('每天 09:00')
    expect(schedules[0]).toContain('上次成功')
    expect(schedules[1]).toContain('已暂停')
    expect(schedules[1]).toContain('每周一 09:00')
    expect(schedules[1]).toContain('连续失败 3 次')
    expect(schedules[2]).toBe('—')
    expect(wrapper.text()).toContain('Agent · 缺货分析助手')
    expect(wrapper.get('[data-testid="project-task-note"]').text()).toContain('已分组')
    expect(wrapper.emitted('count')?.at(-1)).toEqual([3])
  })

  it('creates a task for a colleague and offers only non-viewer employees and available Agents', async () => {
    const create = vi.spyOn(workbenchApi, 'createProjectTask').mockResolvedValue(task())
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="project-task-create"]').trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      editor: { assignee: string }
      employeeOptions: Array<{ label: string }>
      agentOptions: Array<{ label: string }>
    }
    expect(vm.employeeOptions.map(option => option.label)).toEqual(['林岚'])
    expect(vm.agentOptions.map(option => option.label)).toEqual(['缺货分析助手'])

    await wrapper.get('input[data-testid="project-task-title"]').setValue('  整理供应商名单  ')
    vm.editor.assignee = 'employee:u-owner'
    await wrapper.get('[data-testid="project-task-save"]').trigger('click')
    await flushPromises()

    expect(create).toHaveBeenCalledWith('ws-team', {
      title: '整理供应商名单',
      description: '',
      assignee: { type: 'employee', id: 'u-owner' },
      inputFileIds: [],
      dueDate: null,
    })
    expect(workbenchApi.listProjectTasks).toHaveBeenCalledTimes(2)
  })

  it('S4：新建 Agent 任务带执行规则，可“保存并立即执行”', async () => {
    const create = vi.spyOn(workbenchApi, 'createProjectTask')
      .mockResolvedValue(task({ status: 'in_progress', sessionId: 'session-3', latestRunId: 'run-3' }))
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="project-task-create"]').trigger('click')
    await flushPromises()
    const vm = wrapper.vm as unknown as { editor: { assignee: string; schedule: { mode: string; timeOfDay: string; weekdays: number[] } } }
    await wrapper.get('input[data-testid="project-task-title"]').setValue('每日缺货汇总')
    vm.editor.assignee = 'agent:wam-1'
    await flushPromises()
    expect(wrapper.find('[data-testid="project-task-schedule-editor"]').exists()).toBe(true)
    expect(vm.editor.schedule).toEqual({ mode: 'daily', timeOfDay: '09:00', weekdays: [1] })
    vm.editor.schedule.mode = 'weekdays'
    vm.editor.schedule.timeOfDay = '18:00'
    await flushPromises()
    await wrapper.get('[data-testid="project-task-save-run"]').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith('ws-team', expect.objectContaining({
      assignee: { type: 'agent', id: 'wam-1' },
      schedule: { kind: 'weekly', timeOfDay: '18:00', weekdays: [1, 2, 3, 4, 5] },
      startNow: true,
    }))
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/tasks/ptask-1/thread/session-3')
  })

  it('S4：暂停的定时执行可恢复', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([
      task({ scheduleState: 'paused', scheduleReason: 'consecutive_failures', allowedActions: ['resume'] }),
    ]))
    const resume = vi.spyOn(workbenchApi, 'resumeProjectTaskSchedule').mockResolvedValue(task())
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '恢复')!.trigger('click')
    await flushPromises()
    expect(resume).toHaveBeenCalledWith('ws-team', 'ptask-1')
  })

  it('starts an Agent task and opens its task thread', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task()]))
    const start = vi.spyOn(workbenchApi, 'startProjectTask')
      .mockResolvedValue(task({ status: 'in_progress', sessionId: 'session-9', latestRunId: 'run-9', allowedActions: [] }))
    const wrapper = mountPanel()
    await flushPromises()
    const startButton = wrapper.findAll('button').find(button => button.text() === '立即执行')
    expect(startButton).toBeTruthy()
    await startButton!.trigger('click')
    await flushPromises()
    // 从表格启动不带补充要求（第 4 个参数只在任务对话里“交给 Agent”时传入）。
    expect(start).toHaveBeenCalledWith('ws-team', 'ptask-1', expect.stringMatching(/^project-task-start-ptask-1-/), undefined)
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/tasks/ptask-1/thread/session-9')
  })

  it('links each task title to its detail inside the 任务 tab', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task()]))
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.get('[data-testid="project-task-open"]').attributes('href')).toBe('/workspaces/ws-team/tasks/ptask-1')
  })

  it('任务详情：两类任务都直接打开任务对话（会话），标题与任务信息分开展示', async () => {
    route.name = 'workspace-task'
    route.params = { id: 'ws-team', taskId: 'ptask-1' }
    const get = vi.spyOn(workbenchApi, 'getProjectTask')
      .mockResolvedValue(task({ status: 'in_progress', sessionId: 'session-9', latestRunId: 'run-9' }))
    const wrapper = mountPanel({ detailTaskId: 'ptask-1' })
    await flushPromises()
    expect(get).toHaveBeenCalledWith('ws-team', 'ptask-1')
    expect(workbenchApi.listProjectTaskEvents).toHaveBeenCalledWith('ws-team', 'ptask-1')
    expect(wrapper.find('[data-testid="project-task-row"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="project-task-detail"]').text()).toContain('分析缺货原因')
    // 右栏不可见（未传传送目标）时任务信息卡片就地显示。
    expect(wrapper.get('[data-testid="project-task-info"]').text()).toContain('缺货分析助手')
    expect(wrapper.get('[data-testid="project-task-detail-status"]').text()).toBe('进行中')
    expect(router.replace).toHaveBeenCalledWith('/workspaces/ws-team/tasks/ptask-1/thread/session-9')
    expect(wrapper.emitted('detail-title')?.at(-1)).toEqual(['分析缺货原因'])

    vi.mocked(workbenchApi.getProjectTask).mockResolvedValue(task({
      id: 'ptask-2', assignee: { type: 'employee', userId: 'u-owner', displayName: '林岚' }, sessionId: 'session-2', allowedActions: [],
    }))
    await wrapper.setProps({ detailTaskId: 'ptask-2' })
    await flushPromises()
    expect(router.replace).toHaveBeenLastCalledWith('/workspaces/ws-team/tasks/ptask-2/thread/session-2')
    expect(wrapper.get('[data-testid="project-task-info"]').text()).toContain('交付文件')
  })

  it('任务详情：“最近执行”进入该次执行详情，执行中的 Agent 任务可停止（D37 去掉“执行详情”按钮）', async () => {
    route.name = 'workspace-task-thread'
    route.params = { id: 'ws-team', taskId: 'ptask-1', conversationId: 'session-9' }
    vi.spyOn(workbenchApi, 'getProjectTask')
      .mockResolvedValue(task({ status: 'in_progress', sessionId: 'session-9', latestRunId: 'run-9', latestRunStatus: 'running' }))
    const cancel = vi.spyOn(workbenchApi, 'cancelRun').mockResolvedValue({} as never)
    const wrapper = mountPanel({ detailTaskId: 'ptask-1' })
    await flushPromises()
    expect(wrapper.find('[data-testid="router-view-stub"]').exists()).toBe(true)
    expect(router.replace).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="project-task-run-detail"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="project-task-latest-run-link"]').attributes('href'))
      .toBe('/workspaces/ws-team/tasks/ptask-1/thread/run-9')
    await wrapper.get('[data-testid="project-task-stop"]').trigger('click')
    await flushPromises()
    expect(cancel).toHaveBeenCalledWith('run-9')
  })

  it('协作模式任务详情（D37）：没有右栏时显示一行摘要，可就地展开；写操作收进菜单，卡片不再有按钮', async () => {
    route.name = 'workspace-task-thread'
    route.params = { id: 'ws-team', taskId: 'ptask-1', conversationId: 'session-9' }
    vi.spyOn(workbenchApi, 'getProjectTask').mockResolvedValue(task({
      status: 'in_progress', sessionId: 'session-9', latestRunId: 'run-9', latestRunStatus: 'succeeded',
      latestRunAt: '2026-09-12T11:16:00.000Z', allowedActions: ['edit', 'remove', 'start', 'complete'],
    }))
    const wrapper = mountPanel({ detailTaskId: 'ptask-1', collab: true })
    await flushPromises()
    const summary = wrapper.get('[data-testid="project-task-summary"]')
    expect(summary.text()).toContain('进行中')
    expect(summary.text()).toContain('缺货分析助手')
    expect(summary.text()).toContain('每天 09:00')
    expect(summary.get('a').attributes('href')).toBe('/workspaces/ws-team/tasks/ptask-1/thread/run-9')
    expect(wrapper.find('[data-testid="project-task-info"]').exists()).toBe(false)

    await wrapper.get('[data-testid="project-task-summary-toggle"]').trigger('click')
    const info = wrapper.get('[data-testid="project-task-info"]')
    expect(info.get('[data-testid="project-task-description"]').text()).toContain('列出前三个原因')
    expect(info.find('.project-task-info__actions').exists()).toBe(false)
    expect(wrapper.find('[data-testid="project-task-more"]').exists()).toBe(true)
  })

  it('协作模式任务详情（D37）：宿主能打开信息栏时，摘要请宿主打开而不是就地展开', async () => {
    route.name = 'workspace-task-thread'
    route.params = { id: 'ws-team', taskId: 'ptask-1', conversationId: 'session-9' }
    vi.spyOn(workbenchApi, 'getProjectTask').mockResolvedValue(task({ status: 'in_progress', sessionId: 'session-9' }))
    const wrapper = mountPanel({ detailTaskId: 'ptask-1', collab: true, canOpenInfo: true })
    await flushPromises()
    await wrapper.get('[data-testid="project-task-summary-toggle"]').trigger('click')
    expect(wrapper.emitted('open-info')).toHaveLength(1)
    expect(wrapper.find('[data-testid="project-task-info"]').exists()).toBe(false)
  })

  it('任务详情：没有任务对话的旧任务给出说明', async () => {
    route.name = 'workspace-task'
    vi.spyOn(workbenchApi, 'getProjectTask').mockResolvedValue(task({ sessionId: null }))
    const wrapper = mountPanel({ detailTaskId: 'ptask-1' })
    await flushPromises()
    expect(wrapper.text()).toContain('这个任务还没有任务对话')
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('任务详情：任务不存在时提示并可重试', async () => {
    route.name = 'workspace-task'
    const get = vi.spyOn(workbenchApi, 'getProjectTask')
      .mockRejectedValue(new WorkbenchApiError({ code: 'project_task_not_found', message: '任务不存在或已移除' }, 404, ''))
    const wrapper = mountPanel({ detailTaskId: 'missing' })
    await flushPromises()
    expect(wrapper.text()).toContain('任务不存在或已被移除')
    expect(wrapper.emitted('detail-title')?.at(-1)).toEqual([''])
    await wrapper.findAll('button').find(button => button.text() === '重试')!.trigger('click')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('任务详情：移除任务后回到任务表格', async () => {
    route.name = 'workspace-task'
    vi.spyOn(workbenchApi, 'getProjectTask').mockResolvedValue(task({ sessionId: null }))
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const remove = vi.spyOn(workbenchApi, 'removeProjectTask').mockResolvedValue({ removed: true })
    const wrapper = mountPanel({ detailTaskId: 'ptask-1' })
    await flushPromises()
    await wrapper.get('[data-testid="project-task-info"]').findAll('button').find(button => button.text() === '移除')!.trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith('ws-team', 'ptask-1')
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team')
  })

  it('completes an employee task with a note', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task({
      assignee: { type: 'employee', userId: 'u-owner', displayName: '林岚' },
      status: 'in_progress',
      allowedActions: ['edit', 'remove', 'set_status', 'complete'],
    })]))
    const setStatus = vi.spyOn(workbenchApi, 'setProjectTaskStatus').mockResolvedValue(task({ status: 'done' }))
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '完成')!.trigger('click')
    await flushPromises()
    await wrapper.get('textarea[data-testid="project-task-completion-note"]').setValue('已按区域分组')
    await wrapper.get('[data-testid="project-task-complete-confirm"]').trigger('click')
    await flushPromises()
    expect(setStatus).toHaveBeenCalledWith('ws-team', 'ptask-1', {
      status: 'done', completionNote: '已按区域分组', deliverableFileIds: [],
    })
  })

  it('confirms before removing a task', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task()]))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    const remove = vi.spyOn(workbenchApi, 'removeProjectTask')
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '移除')!.trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('reloads and asks the host to refresh when a write is denied on a stale page (人工验收 7.2)', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task()]))
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValueOnce('confirm' as never)
    vi.spyOn(workbenchApi, 'removeProjectTask')
      .mockRejectedValueOnce(new WorkbenchApiError({ code: 'authorization_denied', message: '工作空间不存在、已归档或当前用户不是成员' }, 403, ''))
    const wrapper = mountPanel()
    await flushPromises()
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task({ allowedActions: [] })]))
    await wrapper.findAll('button').find(button => button.text() === '移除')!.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('stale')).toHaveLength(1)
    expect(workbenchApi.listProjectTasks).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-testid="project-task-row"] button')).toHaveLength(0)
  })

  it('分页加载：首屏报告 total，按游标追加下一页（P2-15）', async () => {
    vi.mocked(workbenchApi.listProjectTasks)
      .mockResolvedValueOnce({ items: [task()], nextCursor: 'cursor-2', total: 3 })
      .mockResolvedValueOnce({
        items: [task({ id: 't2', title: '第二页任务' }), task({ id: 't3', title: '第三页任务' })],
        nextCursor: null,
        total: 3,
      })
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.emitted('count')?.at(-1)).toEqual([3])
    expect(wrapper.findAll('[data-testid="project-task-row"]')).toHaveLength(1)
    await wrapper.get('[data-testid="project-task-more"]').trigger('click')
    await flushPromises()
    expect(workbenchApi.listProjectTasks).toHaveBeenLastCalledWith('ws-team', { cursor: 'cursor-2' })
    expect(wrapper.findAll('[data-testid="project-task-row"]')).toHaveLength(3)
    expect(wrapper.find('[data-testid="project-task-more"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('还没有任务')
  })

  it('有任务时不显示空状态，无论是否还有下一页（P2-15 回归）', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task()]))
    const lastPage = mountPanel()
    await flushPromises()
    expect(lastPage.findAll('[data-testid="project-task-row"]')).toHaveLength(1)
    expect(lastPage.text()).not.toContain('还没有任务')
    expect(lastPage.findAll('[data-testid="project-task-create"]')).toHaveLength(1)

    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue(page([task()], 'cursor-2'))
    const firstPage = mountPanel()
    await flushPromises()
    expect(firstPage.find('[data-testid="project-task-more"]').exists()).toBe(true)
    expect(firstPage.text()).not.toContain('还没有任务')
  })

  it('加载更多期间切换空间时丢弃旧空间的下一页', async () => {
    let resolveMore!: (value: ProjectTaskPage) => void
    vi.mocked(workbenchApi.listProjectTasks)
      .mockResolvedValueOnce(page([task()], 'cursor-2'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveMore = resolve }))
      .mockResolvedValueOnce(page([task({ id: 'other', title: '另一个空间的任务' })]))
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="project-task-more"]').trigger('click')
    await wrapper.setProps({ workspaceId: 'ws-other' })
    await flushPromises()
    resolveMore(page([task({ id: 'stale', title: '旧空间第二页' })]))
    await flushPromises()
    expect(wrapper.text()).toContain('另一个空间的任务')
    expect(wrapper.text()).not.toContain('旧空间第二页')
  })
})
